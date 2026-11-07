// EPComHIL 核心基础类型定义
// 对应架构 7.2 对象模型与附录 C JSON 中间态

/** 设备/节点类型：通信设备 + 电力终端 */
export type NodeKind =
  | 'switch' // 交换机
  | 'router' // 路由器
  | 'host' // 通用主机/终端
  | 'ied' // 智能电子设备（保护/测控）
  | 'rtu' // 远方终端单元
  | 'pv' // 光伏逆变器
  | 'ess' // 储能
  | 'load'; // 负荷

/** 画布装饰对象类型：文本标注 / 细线。纯绘图层，不参与通信拓扑与 ns-3 生成语义 */
export type DecorKind = 'text' | 'line';

/** 文本装饰：左上角 (x,y)，字号/颜色/加粗可调 */
export interface TextDecorConfig {
  id: string;
  kind: 'text';
  x: number;
  y: number;
  text?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
}

/** 细线装饰：两端绝对坐标 (x1,y1)-(x2,y2)，线宽/虚实/颜色可调（参考 Visio） */
export interface LineDecorConfig {
  id: string;
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineWidth?: number;
  color?: string;
  dash?: 'solid' | 'dash' | 'dot' | 'dashdot';
}

export type DecorConfig = TextDecorConfig | LineDecorConfig;

/** 链路类型 */
export type LinkKind = 'p2p' | 'csma';

/** 协议承载层：L3 走 IP Socket，L2 走二层以太网帧（GOOSE） */
export type ProtocolLayer = 'L3' | 'L2';

/** 电力/工业协议 */
export type ProtocolType = 'MMS' | 'GOOSE' | 'MODBUS_TCP' | 'MODBUS_RTU' | 'CUSTOM';

/** 业务流类型 */
export type FlowType = 'CBR' | 'ONOFF' | 'PERIODIC' | 'EVENT' | 'CONTROL';

/** 随机分布（用于业务流 OnTime/OffTime） */
export type RandomDistribution =
  | { type: 'constant'; value: number }
  | { type: 'exponential'; mean: number }
  | { type: 'uniform'; min: number; max: number }
  | { type: 'gaussian'; mean: number; variance: number };

/** 元素大类，用于 UI 与生成器层面统一收敛 */
export type ElementKind =
  | 'node'
  | 'link'
  | 'protocol'
  | 'flow'
  | 'fault'
  | 'halfphysical';

/** 校验问题级别 */
export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  elementId: string;
  field: string;
  message: string;
}

/** 时钟源 */
export type ClockSource = 'PTP' | 'INTERNAL';

/** 仿真模式：OFFLINE 全速离线 / REALTIME 挂钟实时（纯软件）/ HIL 硬件在环 */
export type SimMode = 'OFFLINE' | 'REALTIME' | 'HIL';

/** 实时同步模式：HARD_LIMIT 硬墙钟极限(仿真净时绝不超过墙钟，10s=10s) / BEST_EFFORT 尽力追赶墙钟(强机可能提前跑完) */
export type SyncMode = 'HARD_LIMIT' | 'BEST_EFFORT';

/** 节点上安装的应用角色：Server 监听收包 / Client 定向发包 */
export type AppRole = 'SERVER' | 'CLIENT';

/** 节点级应用（映射 ns-3 UdpServer / UdpClient，承载于 UDP Socket） */
export interface NodeAppConfig {
  id: string;
  role: AppRole;
  protocol: ProtocolType;
  /** SERVER 监听端口；CLIENT 对端端口 */
    port?: number;
    /** 仅 CLIENT：目标节点 id（生成时解析成对端 IP） */
    peer?: string;
    /** 传输承载：显式则按所选生成 UDP/TCP socket 应用；缺省按协议推断（Modbus/TCP→TCP，其余→UDP） */
    transport?: 'UDP' | 'TCP';
    /** 发包载荷，默认 512B */
    payloadSize?: number;
  /** CLIENT 发包间隔（秒），默认 1s */
  interval?: number;
}

// ---------- 节点配置 ----------
export interface NodeConfig {
  id: string;
  name: string;
  kind: NodeKind;
  /** L2 地址（先行版可选填） */
  mac?: string;
  /**
   * 手动指定的接口 IP，留空则按链路自动规划。
   *
   * 项目默认每条链路独占一个 /30 网段、两端各占一个主机地址；填了本字段后，
   * 该地址所在的 /30 会成为这条链路的网段，未指定 IP 的另一端取同网段剩下的那个地址。
   * 因此地址必须落在所在 /30 的第 1 或第 2 个主机位置——网络号与广播号分配不了。
   *
   * 注意只作用于该节点参与的**第一条**链路：一个节点挂 N 条链路就有 N 个接口地址，
   * 而节点属性弹窗只有一个 IP 字段，其余接口仍走自动规划。
   */
  ip?: string;
  /** 节点级应用（Server/Client + 协议），由拓扑属性弹窗维护 */
  apps?: NodeAppConfig[];
  /** 该节点的统计输出项（StatKey 列表），右键菜单「统计输出」勾选 */
  stats?: string[];
  /** 电力终端业务参数（交由节点模板/后端语义） */
  power?: Record<string, unknown>;
  /** 半实物映射（当节点为实物模式时） */
  physical?: boolean;
  /** 物理模式指向的实体终端 id（W8/W3 配置） */
  physicalId?: string;
  x?: number;
  y?: number;
  /** 画布显示角度（顺时针 90° 的整数倍），仅影响画布渲染、不影响生成器语义 */
  angle?: number;
  /** 画布图标水平镜像，同上仅显示层语义 */
  flipX?: boolean;
}

// ---------- 链路配置 ----------
export interface LinkConfig {
  id: string;
  kind: LinkKind;
  /** 连接的节点 id 或 {node,port} */
  nodeA: string;
  nodeB: string;
  /** 链路带宽，如 "100Mbps" / "10Gbps"（→ ns-3 DataRate） */
  dataRate?: string;
  /** 链路时延，如 "100us"（→ ns-3 Channel Delay） */
  delay?: string;
  /**
   * 时延抖动，如 "10ms"。ns-3 有线 P2P/CSMA 无链路级抖动属性，均值由 delay 表达；
   * 本字段落地为报文级抖动提示（在业务/应用层以发送时间随机化体现），不生成非法链路属性。
   */
  jitter?: string;
  /** 链路误包率 0~1（→ ns-3 RateErrorModel，ErrorUnit 锁 PACKET；链路级信道恶化） */
  errorRate?: number;
  /** 该链路的统计输出项（StatKey 列表），右键菜单「统计输出」勾选 */
  stats?: string[];
}

// ---------- 协议配置 ----------
export interface ProtocolConfig {
  id: string;
  type: ProtocolType;
  layer: ProtocolLayer;
  /** 归属节点 id（协议挂在节点上） */
  nodeId: string;
  /** L2 GOOSE 相关 */
  appId?: number;
  vlanId?: number;
  /** L3 相关 */
  localPort?: number;
  remotePort?: number;
}

// ---------- 业务流配置 ----------
export interface FlowConfig {
  id: string;
  type: FlowType;
  /** 语义端点（IED_1 / 光伏_2），生成时解析成节点 id */
  src: string;
  dst: string;
  payloadSize?: number;
    interval?: number | RandomDistribution;
    /** 传输承载：显式则按所选生成 UDP/TCP socket 应用；缺省跟随目标 SERVER 承载（其默认再按协议推断） */
    transport?: 'UDP' | 'TCP';
    protocolRef?: string;
}

// ---------- 故障配置 ----------
export interface FaultConfig {
  id: string;
  linkId?: string;
  nodeId?: string;
  startTime: number;
  endTime: number;
  kind: 'error-model' | 'delay-model' | 'drop';
  rate?: number;
}

// ---------- 半实物接入配置 ----------
export interface HalfPhysicalConfig {
  /** 虚拟网卡 → 仿真模型内节点 的一一映射 */
  taps: { tapName: string; nodeId: string; mac: string }[];
  /** Linux 侧单一物理网口汇聚 */
  physicalNic: string;
  vlanId?: number;
}

// ---------- 运行设置 ----------
/**
 * 运行设置：**"这份工程怎么跑"** —— 全项目的唯一来源。
 *
 * 产物生成、仿真机运行、导出、界面展示（拓扑页设置面板 / 运行按钮 / 场景页 / 配置页）
 * 全部读它，随工程一起保存与载入。
 *
 * 为什么要单独立这一个类型（而不是散在 HilConfig 与 store 里各一份）：
 * 曾经"模式"有两个副本 —— 工程里的 `hil.mode` 与 renderer store 里的内存 `run.mode`，
 * 靠导出/运行前"把 run 覆盖到 hil 上"来维持一致。任何一条路径忘了那步同步就会读到陈旧值，
 * 症状是同一块界面里两个模式名打架（首行写 REALTIME、阶段行写 OFFLINE），
 * 而用户无从分辨哪个是真的。**两个副本 + 一个同步约定 = 迟早漂移**，所以只留一个。
 */
export interface RunConfig {
  /** 仿真模式：OFFLINE 全速离线 / REALTIME 挂钟实时 / HIL 硬件在环 */
  mode: SimMode;
  /** 采样：precise 精确 / rough 精简（决定遥测周期与节点 trace 密度） */
  precise: boolean;
  /** 时钟源：PTP 外部同步 / INTERNAL 内置墙钟（仅实时类模式有意义） */
  clockSource: ClockSource;
  /** 仿真停止时刻（秒） */
  stopSeconds: number;
  /** 实时同步策略（仅 REALTIME 有意义） */
  syncMode: SyncMode;
}

/** 运行设置的出厂默认值（新建工程 / 旧文件缺 run 段时用） */
export const DEFAULT_RUN: RunConfig = {
  mode: 'OFFLINE',
  precise: false,
  clockSource: 'INTERNAL',
  stopSeconds: 10,
  syncMode: 'HARD_LIMIT',
};

// ---------- HIL 配置 ----------
/**
 * HIL 引擎参数。
 *
 * **刻意不含 `mode` 与 `clockSource`** —— 那两个字段回答的是"怎么跑"，属于 RunConfig；
 * 在 HIL 段里再存一份就会出现两个真相。这里只放 HIL 引擎独有的东西。
 */
export interface HilConfig {
  simulatorAddr?: string;
  timestepUs?: number;
}

// ---------- 工程（整份中间态 JSON） ----------
/** 节点持久分组（组合 Ctrl+G 产物）：拖动/选中联动的关系来源，成员是节点 id */
export interface NodeGroupConfig {
  id: string;
  members: string[];
}

export interface ProjectConfig {
  projectName: string;
  version: string;
  createdAt: string;
  nodes: NodeConfig[];
  links: LinkConfig[];
  protocols: ProtocolConfig[];
  flows: FlowConfig[];
  faults: FaultConfig[];
  halfPhysical?: HalfPhysicalConfig;
  hil?: HilConfig;
  /**
   * 运行设置：这份工程怎么跑 —— 模式的**唯一来源**，随工程一起保存/载入。
   *
   * 设为**必需**字段是有意的：编译器会因此盯住每一个构造工程的地方（内置案例工厂、
   * 文件解析、测试夹具…），谁也别想再"另开一个默认值"绕开统一来源。
   */
  run: RunConfig;
  groups?: NodeGroupConfig[];
  /** 画布装饰对象：文本 / 细线（纯绘图层，不进入 ns-3 生成语义） */
  decors?: DecorConfig[];
}