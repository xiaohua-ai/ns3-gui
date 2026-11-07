// 运行遥测解析器回归：守的是「产物发什么」与「平台认什么」这对最容易静默分叉的耦合。
//
// 为什么这类 bug 特别危险：前缀或字段名两侧对不上时**不报错、不崩溃**，
// 产物照跑、页面照开，只是 Runtime 组件永远空着 —— 看起来像"没数据"，
// 实际是协议断了。故这里既测解析器本身，也在 ns3-products.test.ts 里对产物反查同一批前缀。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSimParser, parseSimOutput } from '../src/core/simOutput';
import type { CommEvent, GooseEvent, HilInjectEvent, HilSyncEvent, OpLogEvent, RawLogEvent } from '../src/core/runtimeModel';
import { matchesBinding } from '../src/core/runtimeModel';
import { DEFAULT_RUN } from '../src/core/types';
import { generate } from '../src/generator/generator';

/** 真实产物会打出的行（逐字取自生成器发射的格式，见 src/generator/telemetry.ts） */
const SAMPLE = [
  '[EPC-OP] t=0 level=info src=generator msg=产物启动 mode=OFFLINE 场景=p2p_udp 时钟源=INTERNAL',
  '[EPC-OP] t=0 level=info src=runtime msg=遥测通道就绪 周期=1000ms',
  '[EPC-KPI] t=0 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 tx=0 rx=0 lost=0 pdr=0 delay=0 jitter=0',
  '2000143 us ◆Rx 512B from 10.1.0.1:49153',
  '[EPC-KPI] t=2000000 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 tx=1 rx=1 lost=0 pdr=1 delay=143 jitter=0',
  '=== EPComHIL 统计输出 ===',
  'Flow 1TxPkts=8RxPkts=8Lost=0PDR%=100',
  '[EPC-OP] t=10000000 level=info src=runtime msg=仿真结束',
].join('\n');

describe('运行遥测解析器', () => {
  it('四类遥测各归其类，字段逐项还原', () => {
    const events = parseSimOutput(SAMPLE);
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'op').length).toBe(4); // 启动 / 就绪 / 汇总 / 结束
    expect(kinds.filter((k) => k === 'comm').length).toBe(2);

    const op = events.find((e) => e.kind === 'op') as OpLogEvent;
    expect(op.level).toBe('info');
    expect(op.source).toBe('generator');
    // msg 含空格，必须整段吃到行尾（截断会丢掉最关键的场景/模式信息）
    expect(op.message).toBe('产物启动 mode=OFFLINE 场景=p2p_udp 时钟源=INTERNAL');

    const kpi = events.filter((e) => e.kind === 'comm') as CommEvent[];
    expect(kpi[1].timestampUs).toBe(2000000);
    expect(kpi[1].txPackets).toBe(1);
    expect(kpi[1].rxPackets).toBe(1);
    expect(kpi[1].lostPackets).toBe(0);
    expect(kpi[1].pdr).toBe(1);
    expect(kpi[1].delayMeanUs).toBe(143);
    expect(kpi[1].delayJitterUs).toBe(0);
  });

  it('终态汇总行落成一条信息日志（与周期 KPI 区分开）', () => {
    const events = parseSimOutput(SAMPLE);
    const sum = events.find((e) => e.kind === 'op' && e.source === 'stats') as OpLogEvent;
    expect(sum).toBeTruthy();
    expect(sum.message).toBe('流 1 汇总：发 8 收 8 丢 0 PDR 100%');
  });

  it('HIL / TAP 事件还原（时钟源、降级位、tap 收发）', () => {
    const events = parseSimOutput(
      [
        '[EPC-OP] t=0 level=info src=hil msg=保守步进引擎就绪 时钟源=PTP 步长=1000ms',
        '[EPC-HIL] t=1000000 src=INTERNAL step=1000000 jitter=250 degraded=0',
        '[EPC-HIL] t=2000000 src=INTERNAL step=1000000 jitter=900 degraded=1',
        '[EPC-TAP] t=1000000 tap=tap0 rx=5 tx=3',
      ].join('\n'),
    );
    const hil = events.filter((e) => e.kind === 'hil-sync') as HilSyncEvent[];
    expect(hil).toHaveLength(2);
    expect(hil[0].clockSource).toBe('INTERNAL');
    expect(hil[0].stepUs).toBe(1000000);
    expect(hil[0].jitterUs).toBe(250);
    expect(hil[0].degraded).toBe(false);
    expect(hil[1].degraded).toBe(true);

    const tap = events.find((e) => e.kind === 'hil-inject') as HilInjectEvent;
    expect(tap.tapId).toBe('tap0');
    expect(tap.rx).toBe(5);
    expect(tap.tx).toBe(3);
  });

  it('KPI 退路：无端点字段时按 ns-3 流号回映；越界时不绑（宁可不绑也不绑错）', () => {
    // 主路径是"按端点绑定"（见 flowIndex.test.ts）；这里守的是拿不到端点时的退路，
    // 例如二层流没有端口、或产物里 classifier 转换失败（flowCls 为空）。
    const line = '[EPC-KPI] t=1000 flow=2 tx=1 rx=1 lost=0 pdr=1 delay=100 jitter=0';
    const mapped = parseSimOutput(line, { flowIds: ['f1', 'f2'] });
    expect((mapped[0] as CommEvent).target).toEqual({ flowId: 'f2' });

    const outOfRange = parseSimOutput('[EPC-KPI] t=1000 flow=9 tx=1 rx=1 lost=0 pdr=1 delay=100 jitter=0', {
      flowIds: ['f1'],
    });
    expect((outOfRange[0] as CommEvent).target).toBeUndefined();
  });

  it('逐包 ◆Rx 行有意不解析（无发送计数，且会灌满操作日志）', () => {
    const events = parseSimOutput('2000143 us ◆Rx 512B from 10.1.0.1:49153\n');
    expect(events).toHaveLength(0);
  });

  it('跨块断行不丢数据（SSH 流按字节到达，一行常被切成两段）', () => {
    const p = createSimParser({ flowIds: ['f1'] });
    const full = '[EPC-KPI] t=2000000 flow=1 tx=3 rx=2 lost=1 pdr=0.666667 delay=143 jitter=7\n';
    const cut = 17;
    const a = p.feed(full.slice(0, cut));
    const b = p.feed(full.slice(cut));
    expect(a).toHaveLength(0); // 半行不产出，也不丢弃
    expect(b).toHaveLength(1);
    const ev = b[0] as CommEvent;
    expect(ev.timestampUs).toBe(2000000);
    expect(ev.txPackets).toBe(3);
    expect(ev.rxPackets).toBe(2);
    expect(ev.lostPackets).toBe(1);
    expect(ev.pdr).toBeCloseTo(0.666667, 5);
  });

  it('stdout / stderr 残行缓冲相互隔离（否则两条流会被拼成一行）', () => {
    const p = createSimParser();
    // stdout 半边 + stderr 半边 —— 若共用缓冲就会拼出一行错乱内容
    p.feed('2000143 us ◆Rx 512', 'out');
    const fromErr = p.feed('compile error: expected ;\n', 'err');
    expect(fromErr).toHaveLength(1);
    expect((fromErr[0] as OpLogEvent).level).toBe('error');
    expect((fromErr[0] as OpLogEvent).message).toBe('compile error: expected ;');
    // 余下的 stdout 半行此时才补齐，仍应被识别为逐包行而忽略
    expect(p.feed('B from 10.1.0.1:49153\n', 'out')).toHaveLength(0);
  });

  it('stderr 非错误行降为 warn，不冒充错误', () => {
    const events = parseSimOutput('[HIL] 保守步进引擎就绪: 时钟源=内置墙钟\n', {});
    // 这是 stdout 行且非 EPC 前缀 → 忽略；用 err 通道再试
    expect(events).toHaveLength(0);
    const p = createSimParser();
    const errEvents = p.feed('[HIL] 保守步进引擎就绪: 时钟源=内置墙钟\n', 'err');
    expect((errEvents[0] as OpLogEvent).level).toBe('warn');
  });

  it('flush 吐出结尾无换行的最后一行', () => {
    const p = createSimParser();
    p.feed('[EPC-TAP] t=500 tap=tap1 rx=2 tx=1');
    expect(p.flush()).toHaveLength(1);
    expect(p.flush()).toHaveLength(0); // 幂等
  });

  it('事件 id 全局唯一递增（组件用 id 作 :key，重复会引发渲染错乱）', () => {
    const events = parseSimOutput(SAMPLE);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('GOOSE 暂无可解析来源（产物端为占位注释，不发二层帧）', () => {
    // 这条是**故意**的现状记录：GOOSE 组件在真实运行下会显示"暂无事件"，
    // 因为生成器的 L2 段目前只发注释（ProtocolElement.toCode）。等 L2 帧生成落地时，
    // 这里应改为解析新的遥测前缀，而不是让组件继续空着。
    const events = parseSimOutput(SAMPLE);
    const goose = events.filter((e): e is GooseEvent => e.kind === 'goose');
    expect(goose).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------------
// 真实运行夹具：test/fixtures/ns3-run-p2p-udp.log 是仿真机（172.24.4.10 / ns-3.38）
// 上真跑一次 P2P+UDP 产物后捕获的 stdout 遥测段，**未经任何修饰**。
//
// 为什么值得单独固化成夹具：合成样本只能证明"解析器符合我自己的预期"，
// 而只有真跑过的输出才能证明**产物实际发出的字节**能被解析器还原 ——
// 这条耦合一旦断裂是不报错、不崩溃的（组件永远空着），必须靠真实数据兜住。
// 夹具同时含 ◆Rx 逐包行与终态汇总块，正好覆盖"该忽略的"与"该转义的"两类边界。
//
// 对应工程：内置案例「P2P主从UDP」—— 主机_1(10.1.0.1) 每 1s 向 主机_2(10.1.0.2):502 发 512B。
// ----------------------------------------------------------------------------------
describe('真实运行夹具（仿真机实跑捕获）', () => {
  const fixture = readFileSync(new URL('./fixtures/ns3-run-p2p-udp.log', import.meta.url), 'utf8');
  /** 与 buildFlowIndex 同源：节点地址 → 节点 id（案例里 flows 为空，只有节点可绑） */
  const index = { nodeByIp: { '10.1.0.1': '1', '10.1.0.2': '2' }, flows: [] };

  it('把仿真机真实输出还原为 7 个 KPI + 4 条操作日志', () => {
    const events = parseSimOutput(fixture, { flowIndex: index });
    const comm = events.filter((e): e is CommEvent => e.kind === 'comm');
    const op = events.filter((e): e is OpLogEvent => e.kind === 'op');

    // 7 个 KPI 采样：t=3s..9s（t=0/1s/2s 时首包尚未发出，FlowMonitor 里还没有流，
    // 故产物那一拍不发 KPI —— 这是真实行为，不是丢数据）
    expect(comm).toHaveLength(7);
    expect(comm.map((c) => c.timestampUs)).toEqual([3000000, 4000000, 5000000, 6000000, 7000000, 8000000, 9000000]);
    expect(comm.map((c) => c.txPackets)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(comm.map((c) => c.rxPackets)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(comm.every((c) => c.lostPackets === 0)).toBe(true);
    expect(comm.every((c) => c.pdr === 1)).toBe(true);
    // 143us = 100us 链路时延 + 43.2us 串行化（540B ÷ 100Mbps），说明链路真在跑
    expect(comm.every((c) => c.delayMeanUs === 143)).toBe(true);

    // 操作日志：产物启动 / 遥测就绪 / 终态汇总 / 仿真结束（逐包 ◆Rx 行有意不入日志）
    expect(op.map((o) => o.source)).toEqual(['generator', 'runtime', 'stats', 'runtime']);
    expect(op[0].message).toContain('mode=OFFLINE');
    expect(op[2].message).toBe('流 1 汇总：发 8 收 8 丢 0 PDR 100%');
    expect(op[3].message).toBe('仿真结束');
  });

  it('真实输出里的 KPI 能按端点绑回节点（「绑定对象」不再是恒空的功能）', () => {
    const comm = parseSimOutput(fixture, { flowIndex: index }).filter((e): e is CommEvent => e.kind === 'comm');
    // 产物报的是 src=10.1.0.1:49153 dst=10.1.0.2:502 → 主机_1 → 主机_2
    expect(comm.every((c) => c.target?.nodeId === '1' && c.target?.peerNodeId === '2')).toBe(true);
    // 工程未定义 flows（内置案例如此）→ 不绑流，但两端节点视图都能看到数据
    expect(comm.every((c) => c.target?.flowId === undefined)).toBe(true);
    expect(comm.every((c) => matchesBinding(c, { scope: 'node', target: '2' }))).toBe(true);
  });

  it('◆Rx 行与汇总标题行不产生事件', () => {
    const events = parseSimOutput(fixture, { flowIndex: index });
    // 22 行输入（含 8 行 ◆Rx + 1 行标题）→ 11 个事件，其余全被有意忽略
    expect(events).toHaveLength(11);
  });

  it('夹具同时覆盖退路：不传索引时按流号回映（拿不到端点的场景）', () => {
    const comm = parseSimOutput(fixture, { flowIds: ['f1'] }).filter((e): e is CommEvent => e.kind === 'comm');
    expect(comm.every((c) => c.target && c.target.flowId === 'f1')).toBe(true);
  });
});

// ----------------------------------------------------------------------------------
// 链路维度遥测：[EPC-LINK] 是「通信指标」绑定链路时唯一的数据来源。
//
// 为什么单独一层闭环测：绑定链路却空白这个缺陷，三层各自看都"是对的" ——
// matchesBinding 会读 target.linkId、解析器有 link 分支、生成器也发了行；
// 断点在于**没有任何生产者真的填过 linkId**，而单测里那条 linkId 事件是手搓的。
// 所以这里必须从**生成器真正打印的字节**出发，一路走到 matchesBinding。
// ----------------------------------------------------------------------------------
describe('链路遥测 [EPC-LINK]', () => {
  /** 从产物里取 EpcLinkTick 的 std::cout 语句，还原成它在运行期会打印的那一行 */
  function lineFromProduct(cpp: string, values: string[]): string {
    const from = cpp.indexOf('std::cout << "[EPC-LINK]');
    expect(from, '产物里应能找到链路遥测发射语句').toBeGreaterThan(-1);
    const stmt = cpp.slice(from, cpp.indexOf('std::endl', from));
    const lits = [...stmt.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    // 字面量与取值必须一一对应：生成器加字段而测试没跟上时，这里先红
    expect(lits, '发射段的字面量数量应与取值数量一致').toHaveLength(values.length);
    return lits.map((s, i) => s + values[i]).join('');
  }

  const product = generate({
    projectName: 'link_telemetry',
    version: '0.1.0',
    createdAt: '2026-09-20T00:00:00.000Z',
    nodes: [
      { id: 'h1', name: 'H1', kind: 'host', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
      { id: 'h2', name: 'H2', kind: 'host', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h1', port: 502, interval: 1, payloadSize: 512 }] },
    ],
    links: [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' }],
    protocols: [],
    flows: [],
    faults: [],
    run: { ...DEFAULT_RUN },
  }).cpp;

  it('产物打印的字节能被解析成绑定 l1 的通信事件（生成→解析→绑定 闭环）', () => {
    const line = lineFromProduct(product, ['1000000', 'l1', '8', '6', '2']);
    const events = parseSimOutput(line + '\n');
    expect(events).toHaveLength(1);
    const ev = events[0] as CommEvent;
    expect(ev.kind).toBe('comm');
    expect(ev.target).toEqual({ linkId: 'l1' });
    expect(ev.txPackets).toBe(8);
    expect(ev.rxPackets).toBe(6);
    expect(ev.lostPackets).toBe(2);
    // 链路视图只看这一条绑定：节点/业务流绑定不得误命中（否则链路数据会串到别的组件上）
    expect(matchesBinding(ev, { scope: 'link', target: 'l1' })).toBe(true);
    expect(matchesBinding(ev, { scope: 'link', target: 'l2' })).toBe(false);
    expect(matchesBinding(ev, { scope: 'node', target: 'h1' })).toBe(false);
    expect(matchesBinding(ev, { scope: 'flow', target: 'f1' })).toBe(false);
    expect(matchesBinding(ev, { scope: 'whole' })).toBe(true);
  });

  it('链路 pdr 按 drop 口径算（csma 共享总线的 rx 是 tx 的数倍，rx/tx 会大于 1）', () => {
    const pdr = (tx: string, drop: string) =>
      (parseSimOutput(`[EPC-LINK] t=1000 link=l1 tx=${tx} rx=99 drop=${drop}\n`)[0] as CommEvent).pdr;
    expect(pdr('8', '2')).toBeCloseTo(0.75, 6);
    // rx 远大于 tx（csma 扇出）不影响 pdr —— 这正是不能用 rx/tx 的原因
    expect(pdr('8', '0')).toBe(1);
    // 丢弃数超过发送数（两端求和的边角）：钳在 0，不能报负值
    expect(pdr('5', '9')).toBe(0);
    // 首拍还没发过包：0/0 无定义，宁可不报也不报 1 或 NaN
    expect(pdr('0', '0')).toBeUndefined();
  });

  it('链路事件不带时延/抖动（设备层拿不到），字段须为 undefined 而非 0', () => {
    // 0 会被组件画成"时延 0μs"的完美曲线；undefined 才让它显示"—"
    const ev = parseSimOutput('[EPC-LINK] t=1000 link=l1 tx=8 rx=6 drop=2\n')[0] as CommEvent;
    expect(ev.delayMeanUs).toBeUndefined();
    expect(ev.delayJitterUs).toBeUndefined();
  });

  it('link= 缺失时不绑（宁落 whole 也不绑到不存在的链路）', () => {
    const ev = parseSimOutput('[EPC-LINK] t=1000 tx=1 rx=1 drop=0\n')[0] as CommEvent;
    expect(ev.target).toBeUndefined();
    expect(matchesBinding(ev, { scope: 'link', target: 'l1' })).toBe(false);
  });

  it('rawLog 模式下归入 epc-link 标签（运行日志过滤面板按它分色）', () => {
    const events = parseSimOutput('[EPC-LINK] t=1000 link=l1 tx=1 rx=1 drop=0\n', { rawLog: true });
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect((events[0] as RawLogEvent).tag).toBe('epc-link');
  });

  it('跨块断行不丢链路数据（与其它遥测同一条 SSH 字节流）', () => {
    const p = createSimParser();
    const full = '[EPC-LINK] t=2000000 link=l1 tx=3 rx=3 drop=0\n';
    expect(p.feed(full.slice(0, 20))).toHaveLength(0);
    const ev = p.feed(full.slice(20))[0] as CommEvent;
    expect(ev.target).toEqual({ linkId: 'l1' });
    expect(ev.txPackets).toBe(3);
  });
});

// ----------------------------------------------------------------------------------
// 双模式测试：rawLog: true 时同时生成 RawLogEvent 和结构化事件
// ----------------------------------------------------------------------------------
describe('双模式（rawLog + 结构化事件）', () => {
  it('EPC-KPI 行同时生成 RawLogEvent 和 CommEvent', () => {
    const events = parseSimOutput(
      '[EPC-KPI] t=2000000 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 tx=1 rx=1 lost=0 pdr=1 delay=143 jitter=0\n',
      { rawLog: true },
    );
    // 应有 2 个事件：1 个 RawLogEvent + 1 个 CommEvent
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect(events[1].kind).toBe('comm');
    // CommEvent 字段正确还原
    const comm = events[1] as CommEvent;
    expect(comm.txPackets).toBe(1);
    expect(comm.rxPackets).toBe(1);
    expect(comm.pdr).toBe(1);
    expect(comm.delayMeanUs).toBe(143);
  });

  it('EPC-OP 行同时生成 RawLogEvent 和 OpLogEvent', () => {
    const events = parseSimOutput(
      '[EPC-OP] t=0 level=info src=generator msg=产物启动\n',
      { rawLog: true },
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect(events[1].kind).toBe('op');
    const op = events[1] as OpLogEvent;
    expect(op.level).toBe('info');
    expect(op.source).toBe('generator');
    expect(op.message).toBe('产物启动');
  });

  it('EPC-HIL 行同时生成 RawLogEvent 和 HilSyncEvent', () => {
    const events = parseSimOutput(
      '[EPC-HIL] t=1000000 src=PTP step=100 jitter=5 degraded=0\n',
      { rawLog: true },
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect(events[1].kind).toBe('hil-sync');
    const hil = events[1] as HilSyncEvent;
    expect(hil.clockSource).toBe('PTP');
    expect(hil.stepUs).toBe(100);
  });

  it('EPC-TAP 行同时生成 RawLogEvent 和 HilInjectEvent', () => {
    const events = parseSimOutput(
      '[EPC-TAP] t=500000 tap=tap1 rx=10 tx=5\n',
      { rawLog: true },
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect(events[1].kind).toBe('hil-inject');
    const tap = events[1] as HilInjectEvent;
    expect(tap.tapId).toBe('tap1');
    expect(tap.rx).toBe(10);
    expect(tap.tx).toBe(5);
  });

  it('终态汇总行生成 RawLogEvent + OpLogEvent', () => {
    const events = parseSimOutput(
      'Flow 1TxPkts=8RxPkts=8Lost=0PDR%=100\n',
      { rawLog: true },
    );
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('raw-log');
    expect(events[1].kind).toBe('op');
    const op = events[1] as OpLogEvent;
    expect(op.source).toBe('stats');
    expect(op.message).toContain('PDR 100%');
  });

  it('rawLog: false 时只生成结构化事件（旧行为不变）', () => {
    const events = parseSimOutput(
      '[EPC-KPI] t=2000000 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 tx=1 rx=1 lost=0 pdr=1 delay=143 jitter=0\n',
      { rawLog: false },
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('comm');
  });

  it('完整 SAMPLE 在 rawLog 模式下事件数量翻倍（每行 2 个事件）', () => {
    const normalEvents = parseSimOutput(SAMPLE);
    const dualEvents = parseSimOutput(SAMPLE, { rawLog: true });
    // 双模式下每行至少 1 个 RawLogEvent + 原有结构化事件
    // SAMPLE 有 8 行，每行 2 个事件 = 16 个事件（逐包行只有 RawLogEvent）
    expect(dualEvents.length).toBeGreaterThan(normalEvents.length);
    // 至少有 8 个 RawLogEvent（每行一个）
    expect(dualEvents.filter((e) => e.kind === 'raw-log').length).toBe(8);
  });
});

