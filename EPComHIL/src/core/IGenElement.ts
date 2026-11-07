// EPComHIL 对象模型统一契约 IGenElement
// 借鉴 NS3-GUI-HELPER 的 toCode() 多态分派：生成器只遍历调用，新增类型不改主流程（架构 7.2）
import type { ElementKind, ValidationIssue } from './types';

/** 生成上下文：为每个元素提供一致的宿主信息（节点命名、include 收集等） */
export interface GenerationContext {
  /** 节点 id → 生成的 C++ 变量名 的映射（由 Builder 预登记） */
  nodeVar: (nodeId: string) => string;
  /**
   * 节点 id → 可直接写进 `Names::Add("…")` 的**工程内唯一**显示名（已做 C++ 字面量转义）。
   *
   * 为什么必须由上下文统一给：ns-3 的 `Node` 类**没有 SetName**，给节点命名只能走 config-store 的
   * `Names::Add(name, node)`（`src/core/model/names.h`）；而 `Names::Add` 遇到重名是
   * `NS_ABORT_MSG_UNLESS(result, …)` —— **直接终止进程**。UI 只校验节点 id 唯一、不校验 name，
   * 所以两个同名节点会让产物「编得过、跑起来就崩」。重名的第 2 个起在此自动加 `#2`、`#3` 后缀。
   */
  nodeName: (nodeId: string) => string;
  /** 链路 id → 生成的链路变量名；不存在返回 null */
  linkVar: (linkId: string) => string | null;
  /** 收集需要包含的头文件 */
  addInclude: (header: string) => void;
  /** 语义端点解析：IED_1 / 光伏_2 → 节点 id */
  resolveEndpoint: (endpoint: string) => string;
  /** 节点 id → 先行版 IP 规划中的 IPv4 地址；该节点未挂任何链路时返回 null */
  nodeIpv4: (nodeId: string) => string | null;
  /**
   * 链路 id → 该链路两端在设备容器里的 Add 顺序；链路不存在时返回 null。
   *
   * 为什么需要它：Ipv4AddressHelper::Assign 是按 base+1、base+2 **升序**依次发地址的
   * （/30 下最多两个），而 Ipv4InterfaceContainer 没有 SetAddress 之类的改写接口，
   * 所以「哪个端点拿到哪个地址」只能靠调整 Add 顺序实现。
   */
  linkNodeOrder: (linkId: string) => [string, string] | null;
  /**
   * 节点 id → 该节点上**可被 TapBridge 桥接**的网络设备引用（C++ 表达式，如 `dev_l1.Get(1)`）；
   * 该节点没有可桥接设备时返回 null。
   *
   * 为什么必须由上下文来裁决：TapBridge 只在 UseBridge 模式下硬校验桥接设备
   * `SupportsSendFrom()`（`src/tap-bridge/model/tap-bridge.cc` 里 `NS_FATAL_ERROR`），
   * 而 ns-3.38 全树只有 `CsmaNetDevice` 返回 true（`PointToPointNetDevice` 恒 false）。
   * 又因为 `Node::GetDevice(0)` 拿到的是"先装的那块"、与链路类型无关，一旦第 0 号是 p2p 设备，
   * 产物会**编译通过**却在装载期（远早于 `Simulator::Run`）直接 abort，日志只有一行且不指名节点。
   * 故此处只从 CSMA 链路取设备，并以「设备容器 + 下标」精确定位，彻底避开 `GetDevice(0)`。
   */
  bridgeDeviceRef: (nodeId: string) => string | null;
  /** 全部链路的 nodeA/nodeB 端点（供跨元素一致性校验，如半实物节点是否有可用设备） */
  links: () => { nodeA: string; nodeB: string }[];
  /**
   * 节点 id → 该节点上 SERVER 应用监听的端口；节点未声明 SERVER 时返回 null。
   * 业务流据此把客户端发往真正有人接收的端口，避免出现「服务端 502、客户端发 9」这类错配。
   */
  serverPort: (nodeId: string) => number | null;
  /**
   * 节点 id → 该节点 SERVER 应用的传输承载（UDP / TCP）。
   * 与 serverPort 取同一个 SERVER 应用：Modbus/TCP 等走 TCP（PacketSink/OnOff），其余走 UDP（UdpServer/UdpClient）。
   * 业务流据此决定生成 UDP 客户端还是 TCP 客户端，避免「服务端听 TCP、客户端发 UDP」的错配。
   */
  serverTransport: (nodeId: string) => 'UDP' | 'TCP';
  /** 仿真时长（秒）。元素生成 Start/Stop 时须与运行段一致，避免客户端跑出仿真区间 */
  stopSeconds: number;
  /** 是否启用 HIL 注入 */
  hilEnabled: boolean;
  /**
   * 运行遥测发射周期（**仿真时间** ms）。
   *
   * 元素若自行发射周期遥测（如半实物段的 TapBridge 通道计数），必须取这里的值，
   * 不能各自写死 —— 它与头部「采集：precise / rough」同源，是那个用户可见开关的唯一落地点。
   */
  telemetryPeriodMs: number;
}

// /** 具体配置的泛型绑定 */
export interface IGenElement<TConfig = unknown> {
  /** 元素唯一 id（工程内） */
  readonly id: string;
  /** 元素大类 */
  readonly kind: ElementKind;
  /** 展示名 */
  label: string;
  /** 内部配置（原始中间态） */
  config: TConfig;
  /** 校验（含跨元素一致性），返回问题列表，error 阻断导出 */
  validate(ctx: GenerationContext): ValidationIssue[];
  /** 生成 ns-3 C++ 代码片段（自包含，不含 include 管理） */
  toCode(ctx: GenerationContext): string;
  /** 序列化为 JSON 中间态片段（用于导出/持久化） */
  forSettings(): Record<string, unknown>;
}