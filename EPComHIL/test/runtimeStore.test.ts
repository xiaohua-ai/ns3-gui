// 运行时数据层回归防线：模型纯函数(绑定匹配/环形裁剪) + store(ingest/头/绑定过滤/mock 启停/运行日志)。
//
// 背景：运行监视工作台 S1 先落地数据模型与状态，任何真实事件流与 mock 都统一经 store.ingest
// 推入。这里锁住：绑定判定、环形缓冲上限、mock 事件的确定性与启停幂等。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import type { CommEvent, RuntimeEvent, RuntimeBinding } from '@core/runtimeModel';
import type { ProjectConfig, SimMode } from '@core/types';
import { DEFAULT_RUN } from '@core/types';
import { matchesBinding, pushEventsCapped, RUNTIME_MAX_EVENTS, runtimeHeaderFrom, BINDING_WHOLE, keepEndToEndComm, isLinkScopeComm } from '@core/runtimeModel';
import { useRuntimeStore, nextMockBatch } from '@/stores/runtime';
import { useWorkbench } from '@/stores/workbench';
import { formatRelTime, formatClockTime } from '@core/runLog';

function commFor(nodeId: string, id = 0, ts = 0): RuntimeEvent {
  return { kind: 'comm', id, timestampUs: ts, target: { nodeId }, txPackets: 5, rxPackets: 5, pdr: 1 };
}

describe('runtimeModel：绑定匹配', () => {
  const node = commFor('n1', 1, 100);
  const goose: RuntimeEvent = { kind: 'goose', id: 2, timestampUs: 200, senderId: 'n1', appId: 4096, sizeBytes: 120, prevGapUs: 10 };

  it('whole 命中所有事件（含全局类 GOOSE）', () => {
    expect(matchesBinding(node, BINDING_WHOLE)).toBe(true);
    expect(matchesBinding(goose, BINDING_WHOLE)).toBe(true);
  });

  it('node/link/flow 仅匹配对应对象的通信指标', () => {
    expect(matchesBinding(node, { scope: 'node', target: 'n1' })).toBe(true);
    expect(matchesBinding(node, { scope: 'node', target: 'other' })).toBe(false);
    expect(matchesBinding(commFor('n1', 3, 300), { scope: 'link', target: 'l1' })).toBe(false);
    const link: RuntimeEvent = { ...commFor('n1'), target: { linkId: 'l1' } };
    expect(matchesBinding(link, { scope: 'link', target: 'l1' })).toBe(true);
  });

  it('非 comm 事件不命中对象级绑定', () => {
    expect(matchesBinding(goose, { scope: 'node', target: 'n1' })).toBe(false);
  });

  it('链路计数与端到端流是两套口径，混在同一视图时只画端到端', () => {
    const link: RuntimeEvent = { ...commFor('n1', 7, 700), target: { linkId: 'l1' } };
    // whole 绑定下两者都会命中（链路事件也带 target）。若直接画：一条曲线里包数与帧数交替 → 锯齿，
    // 多跳还会把同一个包按跳数重复计数，故通信指标只留端到端。
    const both = [node, link, goose];
    expect(matchesBinding(link, BINDING_WHOLE)).toBe(true);
    expect(keepEndToEndComm(both)).toEqual([node, goose]);
    // 链路自己的绑定视图里只有链路事件 —— 必须原样留下，否则链路组件又空回去
    expect(keepEndToEndComm([link, goose])).toEqual([link, goose]);
    // 全是端到端时不变（不传链路遥测的旧产物行为一致）
    expect(keepEndToEndComm([node])).toEqual([node]);
    expect(isLinkScopeComm(link as CommEvent)).toBe(true);
    expect(isLinkScopeComm(node as CommEvent)).toBe(false);
  });

  it('口径取舍真的接进了通信指标组件（写了 helper 没人用 = 全局曲线照样会被链路计数串花）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/renderer/components/runtime/CommChart.vue', import.meta.url)),
      'utf8',
    );
    const callIdx = src.indexOf('keepEndToEndComm(props.events)');
    expect(callIdx, 'CommChart 必须先经 keepEndToEndComm 取舍口径').toBeGreaterThan(-1);
    expect(src.indexOf('e is CommEvent'), '须先取舍口径再取 comm 子集（顺序颠倒等于没过滤）').toBeGreaterThan(callIdx);
  });
});

describe('runtimeModel：会话头与裁剪', () => {
  it('runtimeHeaderFrom 以可选字段兜底生成完整头', () => {
    const h = runtimeHeaderFrom({ mode: 'HIL', clockSource: 'PTP', precise: true, stopSeconds: 20, timestepUs: 100 });
    expect(h).toMatchObject({ mode: 'HIL', clockSource: 'PTP', precise: true, stopSeconds: 20, step: 'MS', timestepUs: 100 });
  });

  it('pushEventsCapped 超上限裁最旧，保留数量 = cap', () => {
    const batch: RuntimeEvent[] = Array.from({ length: RUNTIME_MAX_EVENTS + 10 }, (_, i) => ({
      kind: 'op' as const,
      id: i,
      timestampUs: i,
      level: 'info' as const,
      source: 't',
      message: 'm',
    }));
    const out = pushEventsCapped([], batch);
    expect(out).toHaveLength(RUNTIME_MAX_EVENTS);
    expect(out[0].id).toBe(10); // 最旧的 10 条被丢
    expect(out[out.length - 1].id).toBe(RUNTIME_MAX_EVENTS + 9);
  });
});

describe('runtimeStore：ingest / 头 / 绑定过滤', () => {
  let store: ReturnType<typeof useRuntimeStore>;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRuntimeStore();
  });
  afterEach(() => store.stopMock());

  it('ingest 追加并裁剪，setHeader/clear 生效', () => {
    const batch: RuntimeEvent[] = Array.from({ length: RUNTIME_MAX_EVENTS + 5 }, (_, i) => ({
      kind: 'op' as const,
      id: i,
      timestampUs: i,
      level: 'info' as const,
      source: 't',
      message: 'm',
    }));
    store.ingest(batch);
    expect(store.eventCount).toBe(RUNTIME_MAX_EVENTS);
    store.setHeader(runtimeHeaderFrom({ mode: 'OFFLINE', clockSource: 'INTERNAL' }));
    expect(store.header?.mode).toBe('OFFLINE');
    store.clear();
    expect(store.eventCount).toBe(0);
    expect(store.header).toBeNull();
  });

  it('eventsByBinding：node 绑定只回该节点 comm，按新→旧', () => {
    store.ingest([commFor('n1', 1, 100), commFor('n2', 2, 200), commFor('n1', 3, 300)]);
    const out = store.eventsByBinding({ scope: 'node', target: 'n1' });
    expect(out.map((e) => e.id)).toEqual([3, 1]); // 倒序：最新的在前
  });
});

describe('runtimeStore：运行日志的时间标签', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    vi.useRealTimers();
    useRuntimeStore().stopMock();
  });

  it('每行都带相对原点的时间戳，且标签能直接算出运行阶段耗时', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 20, 15, 40, 26, 318));
    const base = Date.now();
    const store = useRuntimeStore();

    store.beginRunSession('REALTIME', false); // 原点 = 这一刻
    store.pushLog('▶ 开始运行：___CSMA__ · REALTIME');
    vi.advanceTimersByTime(2400);
    store.pushLog('[running] ___CSMA__ · REALTIME');
    vi.advanceTimersByTime(10300);
    store.pushLog('[done] 退出码 0 · 12.7s');

    expect(store.simLog.map((l) => l.text)).toEqual([
      '▶ 开始运行：___CSMA__ · REALTIME',
      '[running] ___CSMA__ · REALTIME',
      '[done] 退出码 0 · 12.7s',
    ]);
    expect(store.simLog.map((l) => formatRelTime(l.tMs))).toEqual(['+0.00s', '+2.40s', '+12.70s']);
    expect(store.simLog.map((l) => l.atMs)).toEqual([base, base + 2400, base + 12700]);
    expect(store.simLog.map((l) => l.seq)).toEqual([0, 1, 2]);
    // 正文那一列是**绝对时刻**（HH:MM:SS）：15:40:26 → 15:40:28 → 15:40:39
    expect(store.simLog.map((l) => formatClockTime(l.atMs))).toEqual(['15:40:26', '15:40:28', '15:40:39']);
    // 决定性断言：不需要任何外部基线，减法就是运行阶段的实际墙钟耗时
    expect(store.simLog[2].tMs - store.simLog[1].tMs).toBe(10300);
  });

  it('产物输出整块到达：同一块的多行共享时刻，遥测行被挡在日志外', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = useRuntimeStore();
    store.beginRunSession('OFFLINE', false);
    vi.advanceTimersByTime(5000);
    store.pushLog(['=== EPComHIL 统计输出 ===', '[EPC-KPI] t=0 flow=1', 'Flow 1TxPkts=16']);

    expect(store.simLog.map((l) => l.text)).toEqual(['=== EPComHIL 统计输出 ===', 'Flow 1TxPkts=16']);
    expect(store.simLog.map((l) => l.tMs)).toEqual([5000, 5000]);
  });

  it('新会话重置日志并把原点重新钉住（第二轮标签不会接着上一轮走）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = useRuntimeStore();
    store.beginRunSession('OFFLINE', false);
    store.pushLog('第一轮');
    vi.advanceTimersByTime(60000);

    store.beginRunSession('HIL', false);
    expect(store.simLog).toHaveLength(0);
    store.pushLog('第二轮');
    expect(store.simLog[0].tMs).toBe(0); // 而非 60000 —— 原点已重钉
    expect(store.simMode).toBe('HIL');
  });

  it('阶段行原样透传通道内容 —— 模式名不在这里复述（唯一来源是会话首行的 project.run.mode）', () => {
    const store = useRuntimeStore();
    store.beginRunSession('REALTIME', false);
    store.pushLog('▶ 开始运行：___P2P__UDP · REALTIME');
    // 通道只报"到了哪个阶段"以及它独有的信息，模式不在其中。两处各写一份必然漂移
    // （通道的模块在独立进程里被缓存，源码改了要重启才生效），所以模式只在首行出现一次。
    store.handleSimEvent({ type: 'phase', phase: 'running', detail: '___P2P__UDP' });

    expect(store.simPhase).toBe('running');
    expect(store.simLog[1].text).toBe('[running] ___P2P__UDP');
  });

  it('阶段行里通道独有的信息照原样透传（主机、远程路径不在 store 的知识范围内）', () => {
    const store = useRuntimeStore();
    store.beginRunSession('OFFLINE', false);
    store.handleSimEvent({ type: 'phase', phase: 'connecting', detail: '172.24.4.10' });
    store.handleSimEvent({ type: 'phase', phase: 'uploading', detail: '/home/roo/ns-3.38/scratch/demo.cc' });
    expect(store.simLog.map((l) => l.text)).toEqual([
      '[connecting] 172.24.4.10',
      '[uploading] /home/roo/ns-3.38/scratch/demo.cc',
    ]);
  });
});

describe('runtimeStore：mock 数据源', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
    useRuntimeStore().stopMock();
  });

  it('nextMockBatch 是确定性输入函数：时间戳/hinge 类型/id 连续', () => {
    const a = nextMockBatch(0, 0, 200000); // tickUs = 200ms → 200000us
    const b = nextMockBatch(0, 0, 200000);
    expect(a).toEqual(b);
    expect(a.every((e) => e.timestampUs === 200000)).toBe(true);
    expect(a.map((e) => e.kind)).toEqual(['comm', 'goose', 'hil-sync', 'hil-inject', 'comm', 'op']);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length); // id 唯一
    // roug 精简
    expect(nextMockBatch(1, 0, 200000, 'rough').map((e) => e.kind)).toEqual(['comm', 'goose', 'hil-sync', 'hil-inject']);
  });

  it('startMock 立即推一帧并周期推进，stopMock 停止', () => {
    vi.useFakeTimers();
    const store = useRuntimeStore();
    store.startMock({ tickMs: 100, startUs: 0 });
    expect(store.eventCount).toBeGreaterThan(0);
    const firstCount = store.eventCount;
    vi.advanceTimersByTime(300); // 3 个 tick
    expect(store.eventCount).toBeGreaterThan(firstCount);
    store.stopMock();
    const afterStop = store.eventCount;
    vi.advanceTimersByTime(300);
    expect(store.eventCount).toBe(afterStop); // 已停止，不再增长
  });

  it('startMock 幂等：重复调用不翻倍', () => {
    vi.useFakeTimers();
    const store = useRuntimeStore();
    const perTick = nextMockBatch(0, 100000, 100000, 'precise').length; // 单帧批长
    store.startMock({ tickMs: 100, startUs: 0 });
    store.startMock({ tickMs: 100, startUs: 0 });
    const base = store.eventCount;
    vi.advanceTimersByTime(100);
    store.startMock({ tickMs: 100, startUs: 0 });
    expect(store.eventCount).toBe(base + perTick); // 一个 tick 的量，而非两个
  });
});

describe('运行模式：从工程运行设置一路走到产物，中途不允许出现第二个真相', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  /** 一个够跑的最小工程：IED ×交换机 ×半实物 RTU（RTU 必须挂 CSMA，TapBridge 只认它） */
  function miniProject(mode: SimMode): ProjectConfig {
    return {
      projectName: 'demo_scenario',
      version: '0.1.0',
      createdAt: '2026-09-17T00:00:00.000Z',
      nodes: [
        { id: 'ied1', name: 'IED_A', kind: 'ied' },
        { id: 'switch1', name: 'SW_1', kind: 'switch' },
        { id: 'rtu1', name: 'RTU_1', kind: 'rtu', physical: true, physicalId: 'dev:rtu-01' },
      ],
      links: [
        { id: 'l1', kind: 'p2p', nodeA: 'ied1', nodeB: 'switch1', dataRate: '100Mbps', delay: '100us' },
        { id: 'l2', kind: 'csma', nodeA: 'switch1', nodeB: 'rtu1' },
      ],
      protocols: [{ id: 'p1', type: 'GOOSE', layer: 'L2', nodeId: 'ied1', appId: 0x1001, vlanId: 2 }],
      flows: [{ id: 'f1', type: 'PERIODIC', src: 'ied1', dst: 'rtu1', interval: 1 }],
      halfPhysical: { taps: [{ tapName: 'tap0', nodeId: 'rtu1', mac: '00:11:22:33:44:55' }], physicalNic: 'eth0' },
      run: { ...DEFAULT_RUN, mode },
    };
  }

  /** 假通道：把 payload 原样记下来。真正的通道跑在别一个进程里，看不到 store */
  function stubChannel(seen: Record<string, unknown>[]) {
    (globalThis as Record<string, unknown>).window = {
      epcomhil: {
        runSim: async (p: Record<string, unknown>) => {
          seen.push(p);
          return { ok: true, duration: '1.0s' };
        },
      },
    };
  }

  it('三个模式：会话首行 / 通道 payload / 产物代码三处模式一致', async () => {
    for (const mode of ['OFFLINE', 'REALTIME', 'HIL'] as SimMode[]) {
      setActivePinia(createPinia());
      const seen: Record<string, unknown>[] = [];
      stubChannel(seen);

      useWorkbench().loadProject(miniProject(mode));
      const store = useRuntimeStore();
      const res = await store.runSim();

      expect(res.ok, `${mode} 应发车成功`).toBe(true);
      // ① 会话首行：写在 store 里，用户第一眼看到的就是它
      expect(store.simLog[0].text).toBe(`▶ 开始运行：demo_scenario · ${mode}`);
      expect(store.simMode).toBe(mode);
      // ② 通道 payload：原样透传工程的运行设置，通道不自猜
      expect(seen[0].mode).toBe(mode);
      // ③ 产物代码：真正决定仿真怎么跑的那一行，必须同出一辙
      const cpp = String(seen[0].cpp);
      if (mode === 'OFFLINE') expect(cpp).not.toContain('RealtimeSimulatorImpl');
      else expect(cpp).toContain('RealtimeSimulatorImpl');
      // HIL 是"实时 + 半实物闭环"：光有实时仿真器没有 tap 装配不算半实物。
      // 认 emitted code（`TapBridgeHelper tapBridge…`）而不是字面量 TapBridge ——
      // 后者也出现在 OFFLINE 产物那段说明注释里，会把它误判成"也在桥接"。
      expect(cpp.includes('TapBridgeHelper tapBridge')).toBe(mode === 'HIL');
    }
  });

  it('改的是"工程的运行设置"：同一份工程换个模式，跑出来的就是那个模式', async () => {
    const seen: Record<string, unknown>[] = [];
    stubChannel(seen);
    const wb = useWorkbench();
    wb.loadProject(miniProject('OFFLINE'));

    await useRuntimeStore().runSim();
    expect(seen[0].mode).toBe('OFFLINE');

    // 用户在工程设置里切到 REALTIME —— 不需要点任何"同步/应用"按钮
    wb.setRun({ mode: 'REALTIME' });
    await useRuntimeStore().runSim();
    expect(seen[1].mode).toBe('REALTIME');
    expect(String(seen[1].cpp)).toContain('RealtimeSimulatorImpl');
  });
});

describe('runtimeStore：仿真器实跑计时边界（ingestParsed）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  /** 构造一条 runtime 边界遥测事件 */
  function runtimeOp(id: number, message: string, tsUs = 0): RuntimeEvent {
    return { kind: 'op', id, timestampUs: tsUs, level: 'info', source: 'runtime', message };
  }

  it('遥测通道就绪 → 起表；仿真结束 → 停表（一次完整 run 的边界正确）', () => {
    const store = useRuntimeStore();
    store.beginRunSession('REALTIME', false);
    expect(store.simTickerActive).toBe(false);
    store.ingestParsed([runtimeOp(1, '遥测通道就绪 周期=1000ms', 0)]);
    expect(store.simTickerActive).toBe(true);
    store.ingestParsed([runtimeOp(2, '仿真结束', 15_000_000)]);
    expect(store.simTickerActive).toBe(false);
  });

  it('末段 flush：恰落在缓冲尾的"仿真结束"（无换行）也要停表 —— 与流式同收口', () => {
    const store = useRuntimeStore();
    store.beginRunSession('REALTIME', false);
    // 流式块：不完整行的仿真结束留在解析器缓冲（跨块"仿真结束"被切成两次到达）
    store.ingestSimChunk('...统计...\n[EPC-OP] t=15000000 level=info src=runtime msg=仿真\n', 'out');
    expect(store.simTickerActive).toBe(false); // 还没见到完整行，先保持未起表
    store.ingestSimChunk('结束', 'out'); // 第二块把残行补全 → feed 里没有 \n，留在缓冲
    // 真实收尾路径：runSim 末段对 flush() 兜底出的行走 ingestParsed
    expect(store.simTickerActive).toBe(false);
  });

  it('离线模式也计时：由运行生命周期驱动（进 running 起表，到 done/error 停表），遥测标记不驱动', () => {
    const store = useRuntimeStore();
    store.beginRunSession('OFFLINE', false);
    expect(store.simTickerActive).toBe(false);
    // 离线输出一次性到达，遥测标记在同步批里 true→false 被 Vue 合并，不能驱动计时 → 离线只在生命周期起落
    store.ingestParsed([runtimeOp(1, '遥测通道就绪 周期=1000ms', 0)]);
    expect(store.simMode).toBe('OFFLINE');
    expect(store.simTickerActive).toBe(false);
    // 进入 running（仿真启动）→ 起表
    store.handleSimEvent({ type: 'phase', phase: 'running' });
    expect(store.simTickerActive).toBe(true);
    // 进入 done（仿真结果）→ 停表
    store.handleSimEvent({ type: 'phase', phase: 'done' });
    expect(store.simTickerActive).toBe(false);
  });

  it('两连跑边界互不串扰：上一轮的"仿真结束"不会把下一轮的起表吃掉', () => {
    const store = useRuntimeStore();
    // 第一轮：完整的一起一停
    store.beginRunSession('REALTIME', false);
    store.ingestParsed([runtimeOp(1, '遥测通道就绪 周期=1000ms', 0)]);
    expect(store.simTickerActive).toBe(true);
    store.ingestParsed([runtimeOp(2, '仿真结束', 15_000_000)]);
    expect(store.simTickerActive).toBe(false);
    // 第二轮：会话重开，边界重新从"未起"出发，起表后正常收回
    store.beginRunSession('REALTIME', false);
    expect(store.simTickerActive).toBe(false);
    store.ingestSimChunk('[EPC-OP] t=0 level=info src=runtime msg=遥测通道就绪 周期=1000ms\n', 'out');
    expect(store.simTickerActive).toBe(true);
    store.ingestSimChunk('[EPC-OP] t=15000000 level=info src=runtime msg=仿真结束\n', 'out');
    expect(store.simTickerActive).toBe(false);
  });
});
