// 运行时(runtime)状态：维护运行结果会话头与事件环形缓冲，供运行监视工作台消费。
// —— 数据接入约定（RuntimeBridge）——
// 真实通道只做一件事：把收到的每批事件打包成 RuntimeEvent[]，调用 store.ingest(batch) 推入；
// UI 与 mock 完全经同一入口，换数据源不碰组件。
//
// 现已接上**两条**真实/模拟通道（共用同一个 ingest，故组件侧无感）：
//   1) 仿真机实跑：runSim() → 主进程 SSH 流式回推 → simOutput 解析 → ingest（本文件下半部分）
//   2) 示例数据：startMock() → nextMockBatch() → ingest（用于没连机器时预览布局）
import { defineStore } from 'pinia';
import type { ProjectConfig, SimMode } from '@core/types';
import type { RuntimeEvent, RuntimeHeader, RuntimeBinding, RawLogEvent } from '@core/runtimeModel';
import { matchesBinding, pushEventsCapped, RUNTIME_MAX_EVENTS, runtimeHeaderFrom } from '@core/runtimeModel';
import { createSimParser, type SimParser } from '@core/simOutput';
import { appendRunLog, type RunLogLine } from '@core/runLog';
import type { RuntimeResultFile } from '@core/runtimeResult';
import { useWorkbench } from './workbench';
import { generate } from '@gen/generator';
import { buildFlowIndex } from '@gen/context';
import { safeScenarioName } from '@gen/exportPlan';

/** mock 时钟起点(μs)：默认从当前墙钟毫秒展开，便于曲线有可见刻度 */
function mockStartUs(): number {
  return typeof performance !== 'undefined' ? performance.now() * 1000 : 0;
}

/**
 * 生成一次仿真节拍的 mock 事件（纯函数，输入决定的确定性输出，便于测试）。
 * 造了几组虚构展示对象：节点 ied-1/rtu-1、GOOSE 发布、HIL 同步、操作日志。
 * rate='precise' 节拍密集（每对象各一条），'rough' 精简（聚合 + 全局）。
 */
export function nextMockBatch(
  seq: number,
  startUs: number,
  tickUs: number,
  rate: 'precise' | 'rough' = 'precise',
): RuntimeEvent[] {
  const t = startUs + (seq + 1) * tickUs;
  const id = (x: number) => seq * 100 + x;
  const n1 = 20 + Math.round(6 * Math.sin(seq * 0.7));
  const degraded = seq % 5 === 0;
  const ev: RuntimeEvent[] = [
    {
      kind: 'comm',
      id: id(0),
      timestampUs: t,
      target: { nodeId: 'ied-1' },
      txPackets: n1,
      rxPackets: n1,
      lostPackets: seq % 7 === 0 ? 1 : 0,
      pdr: 0.98,
      delayMeanUs: 1200,
      delayJitterUs: 80,
    },
    {
      kind: 'goose',
      id: id(2),
      timestampUs: t,
      senderId: 'ied-1',
      appId: 4096,
      sizeBytes: 120,
      prevGapUs: tickUs,
    },
    {
      kind: 'hil-sync',
      id: id(3),
      timestampUs: t,
      clockSource: 'PTP',
      stepUs: 100,
      jitterUs: degraded ? 400 : 120,
      degraded,
      message: degraded ? '步进偏差超限，降级节拍' : '正常',
    },
    {
      kind: 'hil-inject',
      id: id(5),
      timestampUs: t,
      tapId: seq % 2 === 0 ? 'tap-pri' : 'tap-bak',
      rx: 8 + (seq % 5),
      tx: 6 + (seq % 4),
    },
  ];
  if (rate === 'precise') {
    ev.push({
      kind: 'comm',
      id: id(1),
      timestampUs: t,
      target: { nodeId: 'rtu-1' },
      txPackets: 30 + Math.round(5 * Math.cos(seq * 0.4)),
      rxPackets: 30,
      lostPackets: 0,
      pdr: 1,
      delayMeanUs: 900,
      delayJitterUs: 60,
    });
    ev.push({
      kind: 'op',
      id: id(4),
      timestampUs: t,
      level: 'info',
      source: 'mock',
      message: `第 ${seq} 个仿真节拍 @${t}us`,
    });
  }
  return ev;
}

// 模块级非响应式 mock 句柄（同 workbench.historyBatchDepth 的做法：不进响应式，避免渲染无关更新）
let mockTimer: ReturnType<typeof setInterval> | null = null;
let mockSeq = 0;
let mockEpochUs = 0;

// ---------- 仿真机实跑通道（SSH 流式）----------
// 解析器与解绑函数**刻意不进响应式**：它们是 IO 侧句柄，包进 reactive 只会产生无意义的深层代理。
let simParser: SimParser | null = null;
let simUnlisten: (() => void) | null = null;
/** 运行日志上限与噪声过滤：都在 core/runLog.ts（单一来源，纯函数侧可单测） */

/**
 * 运行日志的**时间原点**：本次运行开始（用户按下「运行」）那一刻的墙钟毫秒。
 *
 * 与解析器句柄同样**刻意不进响应式**：UI 不展示原点本身，只展示由它算出的每行 tMs，
 * 放进 state 只会让每次运行多触发一轮无关渲染。
 */
let simLogEpochMs: number | null = null;

/** 仿真机实跑的阶段机（与 electron/serverMonitor.cjs 发出的 phase 事件一一对应） */
export type SimPhase =
  | 'idle'
  | 'connecting'
  | 'uploading'
  | 'building'
  | 'precheck'
  | 'running'
  | 'done'
  | 'error';

const ACTIVE_PHASES: SimPhase[] = ['connecting', 'uploading', 'building', 'precheck', 'running'];

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    /** 当前(或最近一次)运行会话头；null 表示尚未运行 */
    header: null as RuntimeHeader | null,
    /** 事件环形缓冲，按到达顺序追加、超上限裁最旧 */
    events: [] as RuntimeEvent[],
    /** mock 是否正在周期推数 */
    started: false,
    /** 仿真机实跑：当前阶段（idle = 本次会话还没跑过） */
    simPhase: 'idle' as SimPhase,
    /** 本次运行的模式与产物模式同源（OFFLINE / HIL） */
    simMode: null as SimMode | null,
    simExitCode: null as number | null,
    simError: null as string | null,
    /** true = 只构建不运行（拓扑页「编译」按钮） */
    simBuildOnly: false,
    /**
     * 仿真器实际运行状态：由产物遥测标记（[EPC-OP] src=runtime）驱动，而非 phase 事件。
     * 起点 = "遥测通道就绪"（Simulator::Run() 之前），终点 = "仿真结束"（Simulator::Run() 之后）。
     * 用于控制计时器，使其精确测量仿真引擎实际执行时间，而非包含进程启动/关闭开销。
     */
    simTickerActive: false,
    /**
     * 运行日志：构建输出 + 平台侧提示（遥测/逐包行不进，见 core/runLog 的 RUN_LOG_NOISE）。
     * 每行自带时间刻度（tMs 距本次运行开始 / atMs 绝对墙钟），故这里存的是行记录而非裸字符串。
     */
    simLog: [] as RunLogLine[],
    /** 主进程回的耗时字符串（如 "1.8s"） */
    simDuration: '' as string,
    /** 全局原始日志过滤设置：控制 sim-log 组件默认显示哪些行类型 */
    rawLogFilter: {
      'epc-op': true,
      'epc-kpi': true,
      'epc-hil': true,
      'epc-tap': true,
      'epc-link': true,
      'rx-packet': true,
      'build': true,
      'other': true,
    } as Record<RawLogEvent['tag'], boolean>,
    /** 当前显示的历史结果来源（打开的 .rtc/.runtime.json 文件名）；null = 当前实况 */
    historySource: null as string | null,
  }),
  getters: {
    eventCount: (s) => s.events.length,
    /** 是否正在跑 —— 用于按钮禁用与「同一时刻只允许一个仿真」的互斥 */
    simRunning: (s) => ACTIVE_PHASES.includes(s.simPhase),
    /** 按绑定过滤后的最近事件序列（新→旧，便于渲染组件的滚动窗口） */
    eventsByBinding:
      (s) =>
      (b: RuntimeBinding): RuntimeEvent[] =>
        s.events.filter((e) => matchesBinding(e, b)).slice().reverse(),
  },
  actions: {
    setHeader(h: RuntimeHeader | null) {
      this.header = h;
    },
    clear() {
      this.stopMock();
      this.header = null;
      this.events = [];
    },
    /** 唯一数据入口：任何来源(RuntimeBridge/mock)的批量事件都经此推入并裁剪 */
    ingest(batch: RuntimeEvent[]) {
      if (!batch.length) return;
      this.events = pushEventsCapped(this.events, batch, RUNTIME_MAX_EVENTS);
    },

    /**
     * 计时边界，按模式分两种驱动（同一判据：仿真启动起表、仿真结果停表，但信号源不同）：
     *
     * 实时类（REALTIME/HIL）：由产物遥测标记精确夹住仿真执行窗口——
     *   "遥测通道就绪"（Simulator::Run() 之前）→ 起表；
     *   "仿真结束"（Simulator::Run() 之后）→ 停表。
     * 墙钟 ≈ 仿真时钟，测的是仿真引擎真实执行时长。
     *
     * OFFLINE：由**运行生命周期**（phase）驱动。离线全速快进、全部输出一次性批量到达，
     * 遥测标记在墙上几乎同刻、且 true→false 在同一次同步批里被 Vue 合并成终值，
     * 计时器根本起不来（"离线不动"的根因）。故离线改在进入 running（仿真启动）起表、
     * 离开到 done/error（仿真结果）停表 —— 计的是离线执行这一段真实墙钟，计时器随之走动。
     * 因此离线会忽略遥测标记（下面 `!== 'OFFLINE'` 的闸门），只信 run phase。
     *
     * 为什么解析收口在这里：**流式 chunks 与末段 flush 都可能携带遥测标记**（SSH 按字节分包，
     * 边界标记落在哪一块不受控制），此前只有流式路径在检测、flush 尾漏检 → simTickerActive
     * 残留 true 跨连跑串扰。统一收口后两条路径共用，标记永远被处理。
     */
    ingestParsed(events: RuntimeEvent[]) {
      if (!events.length) return;
      // 离线不做标记驱动（见上，两个相位由 applyRunLifecycleTick 负责），其余模式用标记
      if (this.simMode !== 'OFFLINE') {
        for (const ev of events) {
          if (ev.kind === 'op' && ev.source === 'runtime') {
            if (ev.message.startsWith('遥测通道就绪')) this.simTickerActive = true;
            else if (ev.message === '仿真结束') this.simTickerActive = false;
          }
        }
      }
      this.ingest(events);
    },

    /**
     * 离线模式的计时生命周期闸：进入 running（仿真启动）起表，离开到 done/error（仿真结果）停表。
     * 仅离线模式生效；实时类由遥测标记接管（见 ingestParsed），此处直接返回。
     * run phase 由主进程经 handleSimEvent 逐条到达，天然按运行的真实墙钟展开，故能驱动计时器走动。
     */
    applyRunLifecycleTick(phase: SimPhase) {
      if (this.simMode !== 'OFFLINE') return;
      if (phase === 'running') this.simTickerActive = true;
      else if (phase === 'done' || phase === 'error') this.simTickerActive = false;
    },
    /** 启动周期 mock：立即推一帧，之后按 tickMs 推进；已运行则幂等忽略 */
    startMock({ tickMs = 400, precise = true, startUs = mockStartUs() }: { tickMs?: number; precise?: boolean; startUs?: number } = {}) {
      if (mockTimer) return;
      mockEpochUs = startUs;
      mockSeq = 0;
      const tickUs = tickMs * 1000;
      const rate = precise ? 'precise' : 'rough';
      const push = () => {
        this.ingest(nextMockBatch(mockSeq, mockEpochUs, tickUs, rate));
        mockSeq++;
      };
      push();
      this.started = true;
      mockTimer = setInterval(push, tickMs);
    },
    stopMock() {
      if (mockTimer) {
        clearInterval(mockTimer);
        mockTimer = null;
      }
      this.started = false;
    },

    /** 切换全局原始日志过滤设置 */
    toggleRawLogFilter(tag: RawLogEvent['tag']) {
      this.rawLogFilter[tag] = !this.rawLogFilter[tag];
    },
    /** 设置全局原始日志过滤设置（批量） */
    setRawLogFilter(filter: Record<RawLogEvent['tag'], boolean>) {
      this.rawLogFilter = { ...filter };
    },

    // ==================== 仿真机实跑（真实数据通道） ====================

    /**
     * 开启一次运行会话：清空上一轮的日志与事件，并把**日志时间原点**钉在此刻。
     *
     * 原点必须在这里显式钉住，不靠首行惰性兜底 —— 否则「校验没过」这种只有一行日志的会话
     * 与「上次运行的残留日志」会共用一条基线，时间标签整个失去意义。
     */
    beginRunSession(mode: SimMode, buildOnly = false) {
      this.stopMock();
      this.events = [];
      this.simPhase = 'connecting';
      this.simMode = mode;
      this.simBuildOnly = buildOnly;
      this.simError = null;
      this.simExitCode = null;
      this.simDuration = '';
      this.simLog = [];
      this.simTickerActive = false;
      this.historySource = null; // 开新 run 即退出历史查看态
      simLogEpochMs = Date.now();
    },

    /**
     * 载入一份历史运行结果（打开 .runtime.json）：把 header、事件、运行日志、模式、
     * 耗时与退出码还原成当时的快照。画布布局(items)由调用方借 useWorkbench.setRuntimeItems 还原。
     * 进入非运行态：simPhase 置 idle 以便「保存结果」之外的主按钮可再发起新一轮。
     */
    loadResult(r: RuntimeResultFile, sourceName: string) {
      this.stopMock();
      this.header = r.header;
      this.events = r.events.slice();
      this.simLog = r.simLog.slice();
      this.simMode = r.meta.mode;
      this.simPhase = 'idle';
      this.simExitCode = r.meta.exitCode;
      this.simDuration = r.meta.duration;
      this.simError = null;
      this.historySource = sourceName;
    },

    /**
     * 追加运行日志行（打上时间戳、过滤噪声、按上限裁尾）。
     *
     * 这是运行日志的**唯一写入口** —— 四个来源（阶段行 / 产物 stdout / 产物 stderr /
     * 平台侧提示）都走这里，因此"每行都有时间标签"是结构上成立的，而不是靠各处自觉拼接。
     */
    pushLog(lines: string | string[]) {
      const atMs = Date.now();
      // 兜底：极端情况下（有人在会话之外调 pushLog）把原点锚在首行，保证不变量"每行都有 tMs"。
      // 正常路径由 beginRunSession 钉住，不会走到这里。
      if (simLogEpochMs === null) simLogEpochMs = atMs;
      this.simLog = appendRunLog(this.simLog, lines, { atMs, epochMs: simLogEpochMs });
    },

    /** 把一段原始输出喂给解析器，并把可读行收进运行日志 */
    ingestSimChunk(text: string, stream: 'out' | 'err') {
      // 日志展示：先按行拆（含未完成行也能显示，日志是给人看的，不必等换行）
      this.pushLog(text.split('\n'));
      // 事件解析：必须走**有状态**解析器，它自己处理跨块断行
      if (simParser) {
        const events = simParser.feed(text, stream);
        if (events.length) {
          // 走统一入口：边界标记（遥测通道就绪/仿真结束）在此校验，驱动计时器起停
          this.ingestParsed(events);
        }
      }
    },

    /** 主进程推送的运行事件入口（由 preload 的 onSimEvent 转发） */
    handleSimEvent(evt: { type: string; phase?: string; detail?: string; code?: number; text?: string; stream?: 'out' | 'err' }) {
      if (evt.type === 'phase') {
        const phase = (evt.phase as SimPhase) ?? this.simPhase;
        this.simPhase = phase;
        // 离线模式按 run phase 驱动计时（进 running 起表 / 到 done·error 停表）
        this.applyRunLifecycleTick(phase);
        // 阶段行文案**原样采用通道给的内容**。分工是明确的：
        //   通道只说"到了哪个阶段"以及它独有的信息（主机地址、远程路径、场景名）；
        //   模式不提 —— 那是"本次会话"的属性，唯一来源是 project.run.mode，会话首行已写过。
        // 让通道也复述一遍模式名，就是又造一个副本：它跑在独立进程里、加载的是源码的
        // 进程内缓存副本（改了必须重启才生效），一旦缓存落后就会与首行打架。
        if (evt.detail) this.pushLog(`[${evt.phase}] ${evt.detail}`);
        return;
      }
      if (evt.type === 'line') {
        this.ingestSimChunk(evt.text ?? '', evt.stream === 'err' ? 'err' : 'out');
        return;
      }
      if (evt.type === 'exit') {
        this.simExitCode = typeof evt.code === 'number' ? evt.code : null;
      }
    },

    /** 订阅主进程事件（幂等：多次调用只订阅一次） */
    attachSimBridge() {
      if (simUnlisten) return;
      // Electron：经 preload 的 IPC 事件通道；浏览器：经 vite dev 的 SSE 事件流。
      // 两种来源的事件对象结构完全一致（phase/line/exit），都喂给 handleSimEvent，
      // 因此组件侧与数据接入方式无关。
      if (typeof window === 'undefined') return;
      if (window.epcomhil?.onSimEvent) {
        simUnlisten = window.epcomhil.onSimEvent((evt) => this.handleSimEvent(evt as never));
        return;
      }
      // 浏览器回退：SSE 长连接订阅 vite dev server 广播的仿真事件
      try {
        const es = new EventSource('/__epcomhil_sim_events');
        es.onmessage = (m) => {
          try { this.handleSimEvent(JSON.parse(m.data) as never); } catch (_) { /* ignore */ }
        };
        es.onerror = () => { /* 掉线不告警：短连接失败是常态，下一轮 runSim 会重建 */ };
        simUnlisten = () => es.close();
      } catch (_) {
        // EventSource 不可用时（极少），退化为仍能 run 但无实时事件——由 runSim 最终结果兜底
      }
    },

    /**
     * 生成产物 → 送到仿真机 → 构建 → 运行，全过程流式回灌本 store。
     *
     * 这是「运行后的结果在本平台查看」的唯一入口：数据从产物 stdout 出发，
     * 经主进程 SSH 通道、simOutput 解析器，最终落到与 mock 完全相同的 ingest —— 组件侧无感。
     *
     * 三种模式的差别只在这一个入参 `mode`：
     *   OFFLINE  → ns-3 全速推进，遥测瞬间到齐 → 曲线一次铺满（适合回看、截图、比对）
     *   REALTIME → RealtimeSimulatorImpl 按墙钟推进，纯软件实时 → 曲线随墙钟滚动
     *   HIL      → RealtimeSimulatorImpl + 保守步进 + TapBridge 半实物闭环 → 硬件在环实时
     */
    async runSim(opts: { buildOnly?: boolean } = {}) {
      if (this.simRunning) return { ok: false, error: '已有仿真在运行，请先停止' };

      const wb = useWorkbench();
      // 模式取自**工程自己的运行设置**（project.run，唯一来源，随工程保存与切换）。
      // 不再是另一份 store 级 run，也不再需要"开跑前把 run 抄进 project.hil"那一步——
      // 那一步只要有一条路径忘了做，产物就会按陈旧模式生成（标 REALTIME、跑成 OFFLINE）。
      const project = JSON.parse(JSON.stringify(wb.project)) as ProjectConfig;
      const run = project.run;
      const mode = run.mode;

      // 会话开端：清空上一轮日志/事件，并把时间原点钉在"用户按下运行"这一刻。
      // 「开始运行」这一行因此成为新会话的第一行（相对标签 ≈ +0.00s，绝对时刻即原点），
      // 后面每一行都以它为基准，整条时间轴自洽。
      const scenario = safeScenarioName(project);
      this.beginRunSession(mode, Boolean(opts.buildOnly));
      this.pushLog(`▶ 开始${opts.buildOnly ? '构建' : '运行'}：${scenario} · ${mode}`);
      // 会话头终于有了真实来源（此前只被 mock 路径间接使用）
      this.setHeader(
        runtimeHeaderFrom({
          projectName: project.projectName,
          version: project.version,
          mode,
          clockSource: run.clockSource,
          precise: run.precise,
          stopSeconds: run.stopSeconds,
          syncMode: run.syncMode,
        }),
      );

      // 运行设置已经长在工程里（project.run），生成器直接读它 ——
      // 不必再传一份 overrides 把同样的值抄一遍（抄就是第二个副本的起点）。
      const r = generate(project);
      if (!r.ok) {
        // 校验未过就发车，只会在仿真机上浪费一次构建 + 一次 abort。
        // 注意这里**只追加错误行、不再清空日志**：上面那行「开始运行」要留着，
        // 否则一次失败的会话看起来像"凭空冒出来一段报错"，读者不知道那是在跑什么。
        const msg = `工程校验未通过（${r.validation.errors.length} 处错误），已阻断运行`;
        this.simPhase = 'error';
        this.applyRunLifecycleTick('error');
        this.simError = msg;
        this.pushLog([msg, ...r.validation.errors.slice(0, 5).map((e) => `· ${e.message}`)]);
        return { ok: false, error: msg };
      }

      // 绑定解析表：产物在 KPI 行里报出每条流的五元组（IP:port），这里用**与生成器同一份
      // IP 规划**把这些地址还原成节点/业务流 —— 不依赖 ns-3 的流号分配顺序。
      // 没有它，工程不显式定义 flows 时（内置案例「P2P主从UDP」正是如此）KPI 会没有绑定对象，
      // 表现为「跑完了、日志也在刷，但 Runtime 组件全空」—— 不报错，最难发现。
      simParser = createSimParser({
        flowIndex: buildFlowIndex(project),
        // 退路：产物没发端点时（二层流无端口 / classifier 转换失败）才按流号顺序回映
        flowIds: (wb.project.flows ?? []).map((f) => f.id),
        // 启用原始日志行捕获（用于 sim-log 组件）
        rawLog: true,
      });
      this.attachSimBridge();

      const taps = ((project.halfPhysical && project.halfPhysical.taps) || [])
        .map((t: { tapName?: string }) => t.tapName)
        .filter(Boolean) as string[];

      const payload = {
        scenarioName: safeScenarioName(project),
        cpp: r.cpp,
        mode,
        taps,
        buildOnly: Boolean(opts.buildOnly),
      };

      let res: SimRunResult;
      // Electron：主进程 IPC；浏览器：vite dev server HTTP 端点（SSE 事件已由 attachSimBridge 订阅）
      try {
        if (window.epcomhil?.runSim) {
          res = await window.epcomhil.runSim(payload);
        } else {
          const resp = await fetch('/__epcomhil_sim_run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          res = (await resp.json()) as SimRunResult;
        }
      } catch (e) {
        res = { ok: false, error: String((e as Error)?.message || e) };
      }

      // 收尾：把缓冲区里最后一行（无换行结尾）也解析掉，否则末尾数据会丢。
      // 必须经 ingestParsed 而非裸 ingest：流式路径与末段同源，边界标记（仿真结束）走同一收口，
      // 否则恰落在 flush 尾的"仿真结束"不会驱动计时器停表（跨连跑计时不一致的隐性断点）。
      if (simParser) {
        const tail = simParser.flush();
        if (tail.length) this.ingestParsed(tail);
      }
      this.simDuration = res.duration ?? '';
      if (!res.ok) {
        this.simPhase = 'error';
        this.applyRunLifecycleTick('error');
        this.simError = res.error ?? '运行失败';
        this.pushLog(`✗ ${this.simError}`);
      } else {
        // 成功收尾：若阶段还停在某个「进行中」态（phase 事件偶发丢失时可能如此）就补一个终态，
        // 否则按钮会永远处于禁用态，用户以为卡死了。
        // 用 includes 而非字面量比较：TS 会按上面的赋值把类型收窄，直接比较会被判为无意义。
        if (ACTIVE_PHASES.includes(this.simPhase)) {
          this.simPhase = 'done';
          this.applyRunLifecycleTick('done');
        }
        this.pushLog(`✓ ${opts.buildOnly ? '构建' : '运行'}完成${res.duration ? ` · ${res.duration}` : ''}`);
      }
      return res;
    },

    /** 停止当前仿真（主进程走「信号 + 兜底 kill」两条路） */
    async stopSim() {
      let res: { ok: boolean; error?: string; scenario?: string };
      try {
        if (window.epcomhil?.stopSim) {
          res = await window.epcomhil.stopSim();
        } else {
          const resp = await fetch('/__epcomhil_sim_stop', { method: 'POST' });
          res = (await resp.json()) as { ok: boolean; error?: string; scenario?: string };
        }
      } catch (e) {
        res = { ok: false, error: String((e as Error)?.message || e) };
      }
      this.pushLog(res.ok ? '已请求停止仿真' : `停止失败：${res.error ?? ''}`);
      return res;
    },
  },
});