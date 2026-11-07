// 工程文件（*.tc）的序列化与解析：纯函数，不碰 IO。内容为 JSON 文本，仅扩展名使用工程化后缀 .tc。
// 落盘/读盘由 electron 主进程（原生对话框）或浏览器 Blob/File 适配层负责，
// 见 src/renderer/utils/projectStorage.ts —— 与 generator/exportPlan.ts 同样的分层理由：
// 渲染进程一旦 import node:fs 就构建失败，所以内容逻辑必须与 IO 分离。
import type {
  ProjectConfig,
  NodeConfig,
  LinkConfig,
  ProtocolConfig,
  FlowConfig,
  FaultConfig,
  HalfPhysicalConfig,
  HilConfig,
  RunConfig,
  NodeKind,
  AppRole,
  NodeAppConfig,
  LinkKind,
  ProtocolType,
  ProtocolLayer,
  FlowType,
  SimMode,
  SyncMode,
  ClockSource,
  RandomDistribution,
  NodeGroupConfig,
  DecorConfig,
  DecorKind,
} from './types';
import { DEFAULT_RUN } from './types';
import { sanitizeStats } from './statOutput';

/** 工程文件格式版本：解析时用于兼容判断（不匹配只告警，不阻断） */
export const PROJECT_FILE_VERSION = '0.1.0';

export const PROJECT_FILE_EXT = '.tc';

export type ProjectParseResult =
  | { ok: true; project: ProjectConfig; warnings: string[] }
  | { ok: false; errors: string[] };

const NODE_KINDS: NodeKind[] = ['switch', 'router', 'host', 'ied', 'rtu', 'pv', 'ess', 'load'];
const LINK_KINDS: LinkKind[] = ['p2p', 'csma'];
const PROTO_TYPES: ProtocolType[] = ['MMS', 'GOOSE', 'MODBUS_TCP', 'MODBUS_RTU', 'CUSTOM'];
const PROTO_LAYERS: ProtocolLayer[] = ['L3', 'L2'];
const FLOW_TYPES: FlowType[] = ['CBR', 'ONOFF', 'PERIODIC', 'EVENT', 'CONTROL'];
const FAULT_KINDS: FaultConfig['kind'][] = ['error-model', 'delay-model', 'drop'];
// 三值都要列全：此前漏了 REALTIME，于是存成实时模式的工程重开后会被 pickEnum 判为非法
// 而**静默回落成 OFFLINE** —— 界面显示"实时"、实际按离线跑，正是最难查的那类不一致。
const SIM_MODES: SimMode[] = ['OFFLINE', 'REALTIME', 'HIL'];
const CLOCK_SOURCES: ClockSource[] = ['PTP', 'INTERNAL'];
const SYNC_MODES: SyncMode[] = ['HARD_LIMIT', 'BEST_EFFORT'];
const APP_ROLES: AppRole[] = ['SERVER', 'CLIENT'];

// ---------- 取值助手：只接受"真的有值"的输入，避免把 null/NaN/空串带进模型 ----------
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function pickEnum<T extends string>(v: unknown, allowed: T[]): T | undefined {
  const s = str(v);
  return s && (allowed as string[]).includes(s) ? (s as T) : undefined;
}

// ---------- 逐元素解析 ----------
function parseNodeApps(raw: unknown, errors: string[]): NodeAppConfig[] | undefined {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) errors.push('node.apps 必须是数组');
    return undefined;
  }
  const apps: NodeAppConfig[] = [];
  raw.forEach((r, i) => {
    if (!isRecord(r)) return errors.push(`node.apps[${i}] 不是对象`);
    const id = str(r.id);
    const role = pickEnum<AppRole>(r.role, APP_ROLES);
    const protocol = pickEnum<ProtocolType>(r.protocol, PROTO_TYPES);
    if (!id || !role || !protocol) return errors.push(`node.apps[${i}] 缺少 id / role / protocol`);
    const app: NodeAppConfig = { id, role, protocol };
    const port = num(r.port);
    if (port !== undefined) app.port = port;
    const peer = str(r.peer);
    if (peer) app.peer = peer;
    const payloadSize = num(r.payloadSize);
    if (payloadSize !== undefined) app.payloadSize = payloadSize;
    const interval = num(r.interval);
    if (interval !== undefined) app.interval = interval;
    const transport = pickEnum<'UDP' | 'TCP'>(r.transport, ['UDP', 'TCP']);
    if (transport) app.transport = transport;
    apps.push(app);
  });
  return apps.length ? apps : undefined;
}

function parseNode(raw: unknown, at: string, errors: string[]): NodeConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  const kind = pickEnum<NodeKind>(raw.kind, NODE_KINDS);
  if (!kind) return errors.push(`节点 ${id} 的类型非法: ${String(raw.kind)}`), null;

  const node: NodeConfig = { id, name: str(raw.name) ?? id, kind };
  const apps = parseNodeApps(raw.apps, errors);
  if (apps) node.apps = apps;
  const stats = sanitizeStats(raw.stats);
  if (stats) node.stats = stats;
  const mac = str(raw.mac);
  if (mac) node.mac = mac;
  const ip = str(raw.ip);
  if (ip) node.ip = ip;
  if (isRecord(raw.power)) node.power = raw.power;
  const physical = raw.physical === true;
  if (physical) node.physical = true;
  const physicalId = str(raw.physicalId);
  if (physicalId) node.physicalId = physicalId;
  const x = num(raw.x);
  if (x !== undefined) node.x = x;
  const y = num(raw.y);
  if (y !== undefined) node.y = y;
  const angle = num(raw.angle);
  if (angle !== undefined && angle % 90 === 0 && angle % 360 !== 0) node.angle = angle;
  if (raw.flipX === true) node.flipX = true;
  return node;
}

function parseLink(raw: unknown, at: string, errors: string[]): LinkConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  const kind = pickEnum<LinkKind>(raw.kind, LINK_KINDS);
  if (!kind) return errors.push(`链路 ${id} 的类型非法: ${String(raw.kind)}（仅支持 p2p / csma）`), null;
  const nodeA = str(raw.nodeA);
  const nodeB = str(raw.nodeB);
  if (!nodeA || !nodeB) return errors.push(`链路 ${id} 缺少端点 nodeA / nodeB`), null;

  const link: LinkConfig = { id, kind, nodeA, nodeB };
  const dataRate = str(raw.dataRate);
  if (dataRate) link.dataRate = dataRate;
  const delay = str(raw.delay);
  if (delay) link.delay = delay;
  const jitter = str(raw.jitter);
  if (jitter) link.jitter = jitter;
  const errorRate = num(raw.errorRate);
  if (errorRate !== undefined) link.errorRate = errorRate;
  const stats = sanitizeStats(raw.stats);
  if (stats) link.stats = stats;
  return link;
}

function parseProtocol(raw: unknown, at: string, errors: string[]): ProtocolConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  const type = pickEnum<ProtocolType>(raw.type, PROTO_TYPES);
  if (!type) return errors.push(`协议 ${id} 的类型非法: ${String(raw.type)}`), null;
  const layer = pickEnum<ProtocolLayer>(raw.layer, PROTO_LAYERS);
  if (!layer) return errors.push(`协议 ${id} 的承载层非法: ${String(raw.layer)}`), null;
  const nodeId = str(raw.nodeId);
  if (!nodeId) return errors.push(`协议 ${id} 缺少归属节点 nodeId`), null;

  const p: ProtocolConfig = { id, type, layer, nodeId };
  const appId = num(raw.appId);
  if (appId !== undefined) p.appId = appId;
  const vlanId = num(raw.vlanId);
  if (vlanId !== undefined) p.vlanId = vlanId;
  const localPort = num(raw.localPort);
  if (localPort !== undefined) p.localPort = localPort;
  const remotePort = num(raw.remotePort);
  if (remotePort !== undefined) p.remotePort = remotePort;
  return p;
}

function parseInterval(v: unknown): number | RandomDistribution | undefined {
  const n = num(v);
  if (n !== undefined) return n;
  if (isRecord(v)) return v as unknown as RandomDistribution;
  return undefined;
}

function parseFlow(raw: unknown, at: string, errors: string[]): FlowConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  const type = pickEnum<FlowType>(raw.type, FLOW_TYPES);
  if (!type) return errors.push(`业务流 ${id} 的类型非法: ${String(raw.type)}`), null;
  const src = str(raw.src);
  const dst = str(raw.dst);
  if (!src || !dst) return errors.push(`业务流 ${id} 缺少端点 src / dst`), null;

  const f: FlowConfig = { id, type, src, dst };
  const payloadSize = num(raw.payloadSize);
  if (payloadSize !== undefined) f.payloadSize = payloadSize;
  const interval = parseInterval(raw.interval);
  if (interval !== undefined) f.interval = interval;
  const protocolRef = str(raw.protocolRef);
  if (protocolRef) f.protocolRef = protocolRef;
  const transport = pickEnum<'UDP' | 'TCP'>(raw.transport, ['UDP', 'TCP']);
  if (transport) f.transport = transport;
  return f;
}

function parseFault(raw: unknown, at: string, errors: string[]): FaultConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  if (!str(raw.linkId) && !str(raw.nodeId)) return errors.push(`故障 ${id} 必须至少指定 linkId 或 nodeId 之一`), null;
  const startTime = num(raw.startTime);
  const endTime = num(raw.endTime);
  if (startTime === undefined || endTime === undefined) return errors.push(`故障 ${id} 缺少 startTime / endTime`), null;
  const kind = pickEnum<FaultConfig['kind']>(raw.kind, FAULT_KINDS);
  if (!kind) return errors.push(`故障 ${id} 的类型非法: ${String(raw.kind)}`), null;

  const f: FaultConfig = { id, startTime, endTime, kind };
  const linkId = str(raw.linkId);
  if (linkId) f.linkId = linkId;
  const nodeId = str(raw.nodeId);
  if (nodeId) f.nodeId = nodeId;
  const rate = num(raw.rate);
  if (rate !== undefined) f.rate = rate;
  return f;
}

function parseHalfPhysical(raw: unknown, errors: string[]): HalfPhysicalConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    errors.push('halfPhysical 不是对象');
    return undefined;
  }
  const taps: HalfPhysicalConfig['taps'] = [];
  const rawTaps = Array.isArray(raw.taps) ? raw.taps : [];
  rawTaps.forEach((t, i) => {
    if (!isRecord(t)) return errors.push(`halfPhysical.taps[${i}] 不是对象`);
    const tapName = str(t.tapName);
    const nodeId = str(t.nodeId);
    if (!tapName || !nodeId) return errors.push(`halfPhysical.taps[${i}] 缺少 tapName / nodeId`);
    taps.push({ tapName, nodeId, mac: str(t.mac) ?? '' });
  });
  const cfg: HalfPhysicalConfig = { taps, physicalNic: str(raw.physicalNic) ?? '' };
  const vlanId = num(raw.vlanId);
  if (vlanId !== undefined) cfg.vlanId = vlanId;
  return cfg;
}

/**
 * HIL 引擎参数解析。只读 HIL 专属字段 —— mode / clockSource 已并入运行设置，
 * 由 parseRun 统一读（若这里也读一份，就又是两个真相）。
 */
function parseHil(raw: unknown, errors: string[]): HilConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    errors.push('hil 不是对象');
    return undefined;
  }
  const hil: HilConfig = {};
  const addr = str(raw.simulatorAddr);
  if (addr) hil.simulatorAddr = addr;
  const timestepUs = num(raw.timestepUs);
  if (timestepUs !== undefined) hil.timestepUs = timestepUs;
  return Object.keys(hil).length ? hil : undefined;
}

/**
 * 运行设置解析 —— **模式的唯一读取入口**。
 *
 * 旧文件迁移：早期格式把 mode / clockSource 塞在 `hil` 段里（仓库里 scenarios/*.tc 与
 * samples/*.json 都是那个形态）。没有 `run` 段时就从 hil 段迁过来，保证"看到的模式"
 * 与"跑的模式"是同一个；迁移只发生在读取侧，落盘一律写新结构。
 */
function parseRun(raw: unknown, legacyHil: unknown): RunConfig {
  const run: RunConfig = { ...DEFAULT_RUN };
  const src = isRecord(raw) ? raw : undefined;
  if (src) {
    const mode = pickEnum<SimMode>(src.mode, SIM_MODES);
    if (mode) run.mode = mode;
    const cs = pickEnum<ClockSource>(src.clockSource, CLOCK_SOURCES);
    if (cs) run.clockSource = cs;
    if (typeof src.precise === 'boolean') run.precise = src.precise;
    const stop = num(src.stopSeconds);
    if (stop !== undefined && stop > 0) run.stopSeconds = stop;
    const sync = pickEnum<SyncMode>(src.syncMode, SYNC_MODES);
    if (sync) run.syncMode = sync;
    return run;
  }
  if (isRecord(legacyHil)) {
    const mode = pickEnum<SimMode>(legacyHil.mode, SIM_MODES);
    if (mode) run.mode = mode;
    const cs = pickEnum<ClockSource>(legacyHil.clockSource, CLOCK_SOURCES);
    if (cs) run.clockSource = cs;
  }
  return run;
}

/** 画布装饰对象解析：文本 / 细线（纯绘图层，坏条目剔除不阻断整份工程） */
function parseDecor(raw: unknown, at: string, errors: string[]): DecorConfig | null {
  if (!isRecord(raw)) return errors.push(`${at} 不是对象`), null;
  const id = str(raw.id);
  if (!id) return errors.push(`${at} 缺少 id`), null;
  const kind = pickEnum<DecorKind>(raw.kind, ['text', 'line']);
  if (!kind) return errors.push(`${at} 的装饰类型非法: ${String(raw.kind)}`), null;
  if (kind === 'text') {
    const x = num(raw.x);
    const y = num(raw.y);
    if (x === undefined || y === undefined) return errors.push(`${at} 缺少 x / y`), null;
    const d: DecorConfig = { id, kind, x, y };
    const text = str(raw.text);
    if (text !== undefined) d.text = text;
    const fontSize = num(raw.fontSize);
    if (fontSize !== undefined) d.fontSize = fontSize;
    const color = str(raw.color);
    if (color) d.color = color;
    if (raw.bold === true) d.bold = true;
    return d;
  }
  const x1 = num(raw.x1);
  const y1 = num(raw.y1);
  const x2 = num(raw.x2);
  const y2 = num(raw.y2);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined)
    return errors.push(`${at} 缺少端点坐标`), null;
  const d: DecorConfig = { id, kind, x1, y1, x2, y2 };
  const lineWidth = num(raw.lineWidth);
  if (lineWidth !== undefined) d.lineWidth = lineWidth;
  const color = str(raw.color);
  if (color) d.color = color;
  const dash = pickEnum<'solid' | 'dash' | 'dot' | 'dashdot'>(raw.dash, ['solid', 'dash', 'dot', 'dashdot']);
  if (dash) d.dash = dash;
  return d;
}

/** 解析一段工程 JSON 文本。结构性错误（枚举非法 / 缺必需字段）直接拒绝整份文件，不做"猜"。 */
export function parseProject(text: string): ProjectParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败：${(e as Error).message}`] };
  }
  if (!isRecord(raw)) return { ok: false, errors: ['工程文件根节点必须是对象'] };

  const errors: string[] = [];
  const warnings: string[] = [];

  const listOf = (key: string): unknown[] => {
    const v = raw[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      errors.push(`${key} 必须是数组`);
      return [];
    }
    return v;
  };

  const nodes = listOf('nodes')
    .map((r, i) => parseNode(r, `nodes[${i}]`, errors))
    .filter((n): n is NodeConfig => n !== null);
  const links = listOf('links')
    .map((r, i) => parseLink(r, `links[${i}]`, errors))
    .filter((l): l is LinkConfig => l !== null);
  const protocols = listOf('protocols')
    .map((r, i) => parseProtocol(r, `protocols[${i}]`, errors))
    .filter((p): p is ProtocolConfig => p !== null);
  const flows = listOf('flows')
    .map((r, i) => parseFlow(r, `flows[${i}]`, errors))
    .filter((f): f is FlowConfig => f !== null);
  const faults = listOf('faults')
    .map((r, i) => parseFault(r, `faults[${i}]`, errors))
    .filter((f): f is FaultConfig => f !== null);

  const halfPhysical = parseHalfPhysical(raw.halfPhysical, errors);
  const hil = parseHil(raw.hil, errors);
  // 运行设置（模式的唯一来源）：新结构读 run 段；老结构从 hil 段迁移
  const run = parseRun(raw.run, raw.hil);

  // 画布装饰对象：纯绘图层，坏条目剔除即可，不阻断整份工程
  const decors = listOf('decors')
    .map((r, i) => parseDecor(r, `decors[${i}]`, errors))
    .filter((d): d is DecorConfig => d !== null);

  // 分组解析：id 缺失/成员少于 2/成员引用不存在 → warning 并剔除（分组是显示层关系，不能让坏条目毁掉整份工程）
  const nodeIds = new Set(nodes.map((n) => n.id));
  const groupsRaw = listOf('groups');
  const groups: NodeGroupConfig[] = [];
  groupsRaw.forEach((r, i) => {
    if (!isRecord(r)) return errors.push(`groups[${i}] 不是对象`);
    const gid = str(r.id);
    if (!gid) return errors.push(`groups[${i}] 缺少 id`);
    if (!Array.isArray(r.members)) return errors.push(`groups[${i}].members 必须是数组`);
    const members = [...new Set(r.members.map((m) => str(m)).filter((m): m is string => Boolean(m)))];
    const known = members.filter((m) => nodeIds.has(m));
    if (known.length !== members.length) warnings.push(`分组 ${gid} 引用了不存在的节点，已剔除这些成员`);
    if (known.length >= 2) groups.push({ id: gid, members: known });
    else warnings.push(`分组 ${gid} 有效成员不足 2 个，已丢弃`);
  });

  if (errors.length > 0) return { ok: false, errors };

  const version = str(raw.version) ?? PROJECT_FILE_VERSION;
  if (version !== PROJECT_FILE_VERSION) {
    warnings.push(`工程文件版本 ${version} 与当前 ${PROJECT_FILE_VERSION} 不一致，已按当前结构读取`);
  }

  return {
    ok: true,
    warnings,
    project: {
      projectName: str(raw.projectName) ?? 'untitled',
      version: PROJECT_FILE_VERSION,
      createdAt: str(raw.createdAt) ?? new Date().toISOString(),
      nodes,
      links,
      protocols,
      flows,
      faults,
      halfPhysical,
      hil,
      run,
      // 与 normalize 对称：空数组不落字段，保证「写出去的和读回来的」逐字段同构
      ...(groups.length ? { groups } : {}),
      ...(decors.length ? { decors } : {}),
    },
  };
}

function collapseNodeApps(apps?: NodeAppConfig[]): NodeAppConfig[] | undefined {
  if (!apps || apps.length === 0) return undefined;
  return apps.map((x) => {
    const app: NodeAppConfig = { id: x.id, role: x.role, protocol: x.protocol };
    if (x.port !== undefined) app.port = x.port;
    if (x.peer) app.peer = x.peer;
    if (x.payloadSize !== undefined) app.payloadSize = x.payloadSize;
    if (x.interval !== undefined) app.interval = x.interval;
    if (x.transport === 'UDP' || x.transport === 'TCP') app.transport = x.transport;
    return app;
  });
}

/**
 * 规范化为落盘形态：字段顺序固定、可选字段折叠、undefined 不落盘。
 * 序列化与解析共用同一套结构规则，避免"写出去的和读回来的不一样"。
 */
export function normalizeProject(p: ProjectConfig): ProjectConfig {
  const out: ProjectConfig = {
    projectName: p.projectName || 'untitled',
    version: PROJECT_FILE_VERSION,
    createdAt: p.createdAt || new Date().toISOString(),
    // 运行设置（模式的唯一来源）：补齐默认值后落盘，文件里的 run 永远是完整的五项
    run: { ...DEFAULT_RUN, ...p.run },
    nodes: p.nodes.map((n) => {
      const node: NodeConfig = { id: n.id, name: n.name || n.id, kind: n.kind };
      const apps = collapseNodeApps(n.apps);
      if (apps) node.apps = apps;
      const stats = sanitizeStats(n.stats);
      if (stats) node.stats = stats;
      if (n.mac) node.mac = n.mac;
      if (n.ip) node.ip = n.ip;
      if (n.power && Object.keys(n.power).length > 0) node.power = n.power;
      if (n.physical) node.physical = true;
      if (n.physicalId) node.physicalId = n.physicalId;
      if (typeof n.x === 'number') node.x = Math.round(n.x);
      if (typeof n.y === 'number') node.y = Math.round(n.y);
      if (typeof n.angle === 'number' && n.angle % 360 !== 0) node.angle = n.angle;
      if (n.flipX) node.flipX = true;
      return node;
    }),
    links: p.links.map((l) => {
      const link: LinkConfig = { id: l.id, kind: l.kind, nodeA: l.nodeA, nodeB: l.nodeB };
      if (l.dataRate) link.dataRate = l.dataRate;
      if (l.delay) link.delay = l.delay;
      if (l.jitter) link.jitter = l.jitter;
      if (l.errorRate !== undefined) link.errorRate = l.errorRate;
      const stats = sanitizeStats(l.stats);
      if (stats) link.stats = stats;
      return link;
    }),
    protocols: p.protocols.map((x) => {
      const proto: ProtocolConfig = { id: x.id, type: x.type, layer: x.layer, nodeId: x.nodeId };
      if (x.appId !== undefined) proto.appId = x.appId;
      if (x.vlanId !== undefined) proto.vlanId = x.vlanId;
      if (x.localPort !== undefined) proto.localPort = x.localPort;
      if (x.remotePort !== undefined) proto.remotePort = x.remotePort;
      return proto;
    }),
    flows: p.flows.map((f) => {
      const flow: FlowConfig = { id: f.id, type: f.type, src: f.src, dst: f.dst };
      if (f.payloadSize !== undefined) flow.payloadSize = f.payloadSize;
      if (f.interval !== undefined) flow.interval = f.interval;
      if (f.protocolRef) flow.protocolRef = f.protocolRef;
      if (f.transport === 'UDP' || f.transport === 'TCP') flow.transport = f.transport;
      return flow;
    }),
    faults: (p.faults ?? []).map((f) => {
      const fault: FaultConfig = { id: f.id, startTime: f.startTime, endTime: f.endTime, kind: f.kind };
      if (f.linkId) fault.linkId = f.linkId;
      if (f.nodeId) fault.nodeId = f.nodeId;
      if (f.rate !== undefined) fault.rate = f.rate;
      return fault;
    }),
  };
  if (p.halfPhysical) {
    out.halfPhysical = {
      taps: p.halfPhysical.taps.map((t) => ({ tapName: t.tapName, nodeId: t.nodeId, mac: t.mac ?? '' })),
      physicalNic: p.halfPhysical.physicalNic ?? '',
      ...(p.halfPhysical.vlanId !== undefined ? { vlanId: p.halfPhysical.vlanId } : {}),
    };
  }
  // HIL 段只剩引擎参数：mode / clockSource 已归运行设置（见 types.ts 的 RunConfig 说明），
  // 两个字段都空时整段不落盘
  if (p.hil) {
    const hilOut: HilConfig = {
      ...(p.hil.simulatorAddr ? { simulatorAddr: p.hil.simulatorAddr } : {}),
      ...(p.hil.timestepUs !== undefined ? { timestepUs: p.hil.timestepUs } : {}),
    };
    if (Object.keys(hilOut).length) out.hil = hilOut;
  }
  // 分组落盘：只落成员 ≥2 且成员都真实存在的组；成员去重
  const nodeIds = new Set(p.nodes.map((n) => n.id));
  const groups = (p.groups ?? [])
    .map((g) => ({ id: g.id, members: [...new Set(g.members)].filter((m) => nodeIds.has(m)) }))
    .filter((g) => g.members.length >= 2);
  if (groups.length) out.groups = groups;
  // 画布装饰对象：字段折叠，undefined 不落盘
  if ((p.decors ?? []).length) {
    out.decors = (p.decors ?? []).map((d) => {
      if (d.kind === 'text') {
        const t: NonNullable<ProjectConfig['decors']>[number] & { kind: 'text' } = { id: d.id, kind: 'text', x: Math.round(d.x), y: Math.round(d.y) };
        if (d.text) t.text = d.text;
        if (d.fontSize !== undefined) t.fontSize = d.fontSize;
        if (d.color) t.color = d.color;
        if (d.bold) t.bold = true;
        return t;
      }
      const l: NonNullable<ProjectConfig['decors']>[number] & { kind: 'line' } = {
        id: d.id,
        kind: 'line',
        x1: Math.round(d.x1),
        y1: Math.round(d.y1),
        x2: Math.round(d.x2),
        y2: Math.round(d.y2),
      };
      if (d.kind === 'line' && d.lineWidth !== undefined) l.lineWidth = d.lineWidth;
      if (d.kind === 'line' && d.color) l.color = d.color;
      if (d.kind === 'line' && d.dash) l.dash = d.dash;
      return l;
    });
  }
  return out;
}

/** 序列化为落盘文本（带缩进、末尾换行，便于人工 diff） */
export function serializeProject(p: ProjectConfig): string {
  return `${JSON.stringify(normalizeProject(p), null, 2)}\n`;
}

/** 由工程名推导建议文件名，剔除不合法字符 */
export function suggestFileName(projectName: string): string {
  const base = (projectName || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'untitled';
  return `${base}${PROJECT_FILE_EXT}`;
}
