// 运行时(runtime)数据模型：定义运行监视工作台的事件结构、会话头、绑定与纯函数。
// 与后端 Linux 端 OutputOrchestrator 的五类运行结果对齐；本模块纯数据/纯函数，不碰 IO。
// 真实事件通过 RuntimeBridge 从 gRPC stream / WebSocket 以 RuntimeEvent[] 形式 push 进来，
// 现阶段无真实通道时由 store 内 mock 周期生成同构数据跑通框架。
import type { SimMode, ClockSource, SyncMode } from './types';

/** 五类运行结果统一携带的基础字段 */
interface RuntimeEventBase {
  id: number;
  timestampUs: number;
}

/** 通信指标：按绑定对象(节点/链路/业务流)聚合的流量与质量 KPI，对应 ns-3 FlowMonitor 与 STAT_OUTPUTS */
export interface CommEvent extends RuntimeEventBase {
  kind: 'comm';
  /**
   * 所属对象；缺省视为全局聚合。
   *
   * nodeId / peerNodeId 是**同一条流的收发两端**（来自产物报出的五元组）：
   * KPI（tx/rx/PDR/时延）是端到端的量，归到哪一端都成立，故绑定任一节点都命中。
   * 若只有一端能对上工程（另一端地址不认识），只填得上的一端 —— 或只有 peerNodeId，
   * 此时组件绑定该对端节点同样可见，不会因为"谁是 src"而漏看。
   */
  target?: { nodeId?: string; peerNodeId?: string; linkId?: string; flowId?: string };
  txPackets?: number;
  rxPackets?: number;
  txBytes?: number;
  rxBytes?: number;
  lostPackets?: number;
  /** 投递率 PDR，0..1 */
  pdr?: number;
  delayMeanUs?: number;
  delayJitterUs?: number;
}

/** GOOSE —— L2 二层帧(0x88B8)发布时序打点 */
export interface GooseEvent extends RuntimeEventBase {
  kind: 'goose';
  senderId: string;
  appId: number;
  sizeBytes: number;
  /** 距上一帧间隔(μs)，即 GOOSE 发布周期 */
  prevGapUs: number;
}

/** HIL 保守步进同步事件：时钟源、步进偏差、降级告警 */
export interface HilSyncEvent extends RuntimeEventBase {
  kind: 'hil-sync';
  clockSource: ClockSource;
  stepUs: number;
  jitterUs: number;
  degraded: boolean;
  message?: string;
}

/** 硬件在环注入：TapBridge 通道收发计数 */
export interface HilInjectEvent extends RuntimeEventBase {
  kind: 'hil-inject';
  tapId: string;
  rx: number;
  tx: number;
}

/** 操作日志：运行期操作 / 告警 */
export interface OpLogEvent extends RuntimeEventBase {
  kind: 'op';
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

/** 原始仿真输出行：完整保留产物 stdout/stderr 的每一行 */
export interface RawLogEvent extends RuntimeEventBase {
  kind: 'raw-log';
  /** 原始文本内容（原样保留，不做 trim） */
  text: string;
  /** 行来源：stdout 或 stderr */
  stream: 'out' | 'err';
  /** 行类型标签（用于过滤） */
  tag: 'epc-op' | 'epc-kpi' | 'epc-hil' | 'epc-tap' | 'epc-link' | 'rx-packet' | 'build' | 'other';
}

export type RuntimeEvent = CommEvent | GooseEvent | HilSyncEvent | HilInjectEvent | OpLogEvent | RawLogEvent;
export type RuntimeEventKind = RuntimeEvent['kind'];

/** 运行会话头：对应 OutputOrchestrator 两阶段 JSON 的 Header 段 */
export interface RuntimeHeader {
  projectName: string;
  version: string;
  mode: SimMode;
  clockSource: ClockSource;
  precise: boolean;
  stopSeconds: number;
  /** 实时同步模式（仅 REALTIME 有意义，用于展示与排查） */
  syncMode?: SyncMode;
  /** 播放步进粒度：Step / MS / US / NS */
  step: 'Step' | 'MS' | 'US' | 'NS';
  timestepUs?: number;
}

/** 从工程+运行设置构造会话头（纯函数，供导出页/空白右键共用同一来源） */
export function runtimeHeaderFrom(p: {
  projectName?: string;
  version?: string;
  mode: SimMode;
  clockSource: ClockSource;
  precise?: boolean;
  stopSeconds?: number;
  syncMode?: SyncMode;
  timestepUs?: number;
}): RuntimeHeader {
  return {
    projectName: p.projectName ?? 'untitled',
    version: p.version ?? '0.0.0',
    mode: p.mode,
    clockSource: p.clockSource,
    precise: !!p.precise,
    stopSeconds: p.stopSeconds ?? 10,
    syncMode: p.syncMode,
    step: 'MS',
    timestepUs: p.timestepUs,
  };
}

// ---------- 组件绑定 ----------

export type BindingScope = 'whole' | 'node' | 'link' | 'flow';

export interface RuntimeBinding {
  scope: BindingScope;
  target?: string;
}

export const BINDING_WHOLE: RuntimeBinding = { scope: 'whole' };

/**
 * 流端点索引：产物报出的 IP 与端口 → 工程对象（节点 / 业务流）。
 *
 * 定义在 core（消费侧）而非 generator（生产侧）是有意的：解析器在 core，
 * 让 core 反向依赖 generator 会把分层倒过来；这里只约定"平台需要知道什么"，
 * 由 generator/context.ts 的 buildFlowIndex 按同一份 IP 规划填出来。
 */
export interface FlowIndex {
  /** 节点地址 → 节点 id（与产物里 Ipv4AddressHelper 实际分配的那个地址同源） */
  nodeByIp: Record<string, string>;
  /** 工程显式定义的业务流（含 src/dst 节点 id），用于把一条流绑到「业务流」对象 */
  flows: { id: string; src: string; dst: string }[];
}

/**
 * 判断事件是否落在某绑定下。
 * - whole：命中所用事件（全局态）；GOOSE/HIL 同步/注入/操作日志为全局对象，仅 whole 命中。
 * - node：**两端任一命中**。KPI 是同一条流的端到端量（tx/rx/PDR/时延），
 *   归到收发任一端都成立；若只认 src，绑定到接收端（服务端）的组件就会恒空 ——
 *   而"服务端收得怎么样"恰恰是最常看的那个视图。
 * - link/flow：仅通信指标事件按对应对象 id 精准匹配。
 */
export function matchesBinding(e: RuntimeEvent, b: RuntimeBinding): boolean {
  if (b.scope === 'whole') return true;
  if (e.kind !== 'comm' || !e.target) return false;
  const t = e.target;
  if (b.scope === 'node') {
    return (t.nodeId !== undefined && t.nodeId === b.target) || (t.peerNodeId !== undefined && t.peerNodeId === b.target);
  }
  const hit = b.scope === 'link' ? t.linkId : t.flowId;
  return hit !== undefined && hit === b.target;
}

/** 是否链路段口径（[EPC-LINK] 的 MAC 帧计数），区别于端到端流口径（[EPC-KPI] 的 FlowMonitor 包计数） */
export function isLinkScopeComm(e: CommEvent): boolean {
  return e.target?.linkId !== undefined;
}

/**
 * 两种通信口径同时出现时只留端到端流口径。
 *
 * 全局/节点视图下两者会一起命中（链路事件带 target，whole 一律放行），而它们是**不同的量**：
 * 链路数的是"段上跑过多少帧"，流数的是"端到端递了多少包"；一笔画在同一曲线上会成锯齿，
 * 多跳拓扑还会把同一个包按跳数重复计数。链路自己的绑定视图里只有链路事件，
 * 此时原样返回 —— 曲线照画，只是时延恒为「—」（设备层拿不到时延）。
 */
export function keepEndToEndComm(events: RuntimeEvent[]): RuntimeEvent[] {
  const comms = events.filter((e): e is CommEvent => e.kind === 'comm');
  const hasFlowScope = comms.some((e) => !isLinkScopeComm(e));
  if (!hasFlowScope) return events;
  return events.filter((e) => e.kind !== 'comm' || !isLinkScopeComm(e as CommEvent));
}

// ---------- 环形缓冲裁剪 ----------

/** 事件环形缓冲上限：超限丢弃最旧，保证内存/渲染上界 */
export const RUNTIME_MAX_EVENTS = 4000;

/** 追加一批事件并按上限裁剪（纯函数；返回新的不可变快照不可行时可直接原地裁剪，这里返回裁剪后数组便于测试） */
export function pushEventsCapped(current: RuntimeEvent[], batch: RuntimeEvent[], cap: number = RUNTIME_MAX_EVENTS): RuntimeEvent[] {
  const next = current.concat(batch);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

// ---------- 监视台组件库与布局 ----------

/** 运行监视台可拖拽组件：kind=note 表示纯文本备注，不消费事件 */
export interface RuntimeComponentMeta {
  key: string;
  label: string;
  /** 对应事件种类；'note' 为纯标注 */
  kind: RuntimeEventKind | 'note';
  /** 最小占格（宽×高，Grid 单位） */
  minCol: number;
  minRow: number;
  /** 是否允许绑定对象（note 不允许） */
  bindable: boolean;
}

export const RUNTIME_COMPONENTS: RuntimeComponentMeta[] = [
  { key: 'comm', label: '通信指标', kind: 'comm', minCol: 3, minRow: 3, bindable: true },
  { key: 'goose', label: 'GOOSE 时序', kind: 'goose', minCol: 3, minRow: 3, bindable: false },
  { key: 'hil-sync', label: 'HIL 同步', kind: 'hil-sync', minCol: 2, minRow: 2, bindable: false },
  { key: 'hil-inject', label: '硬件在环', kind: 'hil-inject', minCol: 2, minRow: 2, bindable: false },
  { key: 'op', label: '操作日志', kind: 'op', minCol: 3, minRow: 3, bindable: false },
  { key: 'sim-log', label: '仿真原始日志', kind: 'raw-log', minCol: 4, minRow: 3, bindable: false },
  { key: 'note', label: '文本备注', kind: 'note', minCol: 2, minRow: 1, bindable: false },
];

export function runtimeComponentByKey(key: string): RuntimeComponentMeta | undefined {
  return RUNTIME_COMPONENTS.find((c) => c.key === key);
}

/** 已放置的一个组件实例 */
export interface RuntimeLayoutItem {
  /** 组件类目 key（对应 RUNTIME_COMPONENTS） */
  key: string;
  /** 实例 id（会话内唯一，用于删除/定位；由 workbench.nextId('rt') 签发） */
  id: string;
  title: string;
  binding: RuntimeBinding;
  colSpan: number;
  rowSpan: number;
}

/** 该会话的完整布局；items 顺序即 Grid 的放置顺序 */
export interface RuntimeLayout {
  items: RuntimeLayoutItem[];
}

/** 从组件元数据造一个默认实例（whole 绑定 + 最小占格；id 调用方签发） */
export function makeLayoutItem(meta: RuntimeComponentMeta, id: string): RuntimeLayoutItem {
  return {
    key: meta.key,
    id,
    title: meta.label,
    binding: BINDING_WHOLE,
    colSpan: meta.minCol,
    rowSpan: meta.minRow,
  };
}

/** 把 items[from] 移到 to 之前（画布内拖拽重排；纯函数返回新数组） */
export function moveLayoutItem(items: RuntimeLayoutItem[], from: number, to: number): RuntimeLayoutItem[] {
  const n = items.length;
  if (from < 0 || from >= n || to < 0 || to > n || from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 从工程取绑定可选项：整个工程 + 节点/链路/业务流的「名称→id」清单（供绑定下拉） */
export interface BindingOptions {
  nodes: { id: string; label: string }[];
  links: { id: string; label: string }[];
  flows: { id: string; label: string }[];
}
export function bindingOptions(project: {
  nodes: { id: string; name?: string }[];
  links: { id: string; name?: string }[];
  flows: { id: string; name?: string }[];
}): BindingOptions {
  const label = (x: { id: string; name?: string }) => ({ id: x.id, label: x.name && x.name.trim() ? x.name : x.id });
  return {
    nodes: project.nodes.map(label),
    links: project.links.map(label),
    flows: project.flows.map(label),
  };
}