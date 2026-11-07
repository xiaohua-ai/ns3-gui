// 链路元素：p2p / csma 通道生成（在此只产出 Device/Channel 语句，IP 统一由 Internet section 分配）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { LinkConfig, ElementKind, ValidationIssue } from '../types';

const LINK_KIND: Record<string, string> = { p2p: 'PointToPoint', csma: 'Csma' };

export class LinkElement implements IGenElement<LinkConfig> {
  readonly kind: ElementKind = 'link';
  constructor(public config: LinkConfig) {}
  get id() {
    return this.config.id;
  }
  get label() {
    return `${this.config.nodeA} ↔ ${this.config.nodeB}`;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!ctx.resolveEndpoint(this.config.nodeA)) {
      issues.push({ severity: 'error', elementId: this.id, field: 'nodeA', message: `链路端点节点不存在: ${this.config.nodeA}` });
    }
    if (!ctx.resolveEndpoint(this.config.nodeB)) {
      issues.push({ severity: 'error', elementId: this.id, field: 'nodeB', message: `链路端点节点不存在: ${this.config.nodeB}` });
    }
    if (this.config.nodeA === this.config.nodeB) {
      issues.push({ severity: 'error', elementId: this.id, field: 'nodeA', message: '链路两端不能为同一节点' });
    }
    if (!LINK_KIND[this.config.kind]) {
      issues.push({ severity: 'error', elementId: this.id, field: 'kind', message: `未知链路类型: ${this.config.kind}` });
    }
    return issues;
  }

  /** 该链路的 ns-3 变量名 */
  varName(): string {
    return `link_${this.config.id}`;
  }

  /**
   * 该链路的设备 container 变量名：p2p 与 csma 统一为一次 Install 产出单一设备容器，
   * Internet 段直接对该容器进行 IP 分配（p2p 两端同通道、csma 同冲突域）。
   */
  deviceVars(): { a: string; b: string; shared: boolean } {
    return { a: `dev_${this.config.id}`, b: `dev_${this.config.id}`, shared: true };
  }

  /** 返回创建 Helper / Channel / 安装设备 的语句。设备变量由 Internet section 引用链接。 */
  toCode(ctx: GenerationContext): string {
    const h = LINK_KIND[this.config.kind] ?? 'PointToPoint';
    const v = this.varName();
    const lines: string[] = [];
    const rate = this.config.dataRate ?? '5Mbps';
    const delay = this.config.delay ?? '2ms';
    // 端点顺序取自 IP 规划：Assign 只能按 base+1/base+2 升序发地址，
    // 若用户给某端点指定了较大的那个地址，就必须把它排在设备容器后面。
    const order = ctx.linkNodeOrder(this.config.id) ?? [this.config.nodeA, this.config.nodeB];
    if (this.config.kind === 'p2p') {
      lines.push(`  ${h}Helper ${v};`);
      lines.push(`  ${v}.SetDeviceAttribute("DataRate", StringValue("${rate}"));`);
      lines.push(`  ${v}.SetChannelAttribute("Delay", StringValue("${delay}"));`);
      const nodes = `linkNodes_${this.config.id}`;
      lines.push(`  NodeContainer ${nodes};`);
      lines.push(`  ${nodes}.Add(${ctx.nodeVar(order[0])});`);
      lines.push(`  ${nodes}.Add(${ctx.nodeVar(order[1])});`);
      const dc = `dev_${this.config.id}`;
      lines.push(`  NetDeviceContainer ${dc} = ${v}.Install(${nodes});`);
      lines.push(`  (void)${dc};`);
    } else {
      // CSMA：两端节点必须落在同一冲突域。CsmaHelper::Install 只接受 Ptr<Node> / NodeContainer
      // （不存在 Install(NetDeviceContainer, NetDeviceContainer) 重载），故先把端点并入 NodeContainer 再一次性安装。
      lines.push(`  CsmaHelper ${v};`);
      lines.push(`  ${v}.SetChannelAttribute("DataRate", StringValue("${rate}"));`);
      const nodes = `csmaNodes_${this.config.id}`;
      lines.push(`  NodeContainer ${nodes};`);
      lines.push(`  ${nodes}.Add(${ctx.nodeVar(order[0])});`);
      lines.push(`  ${nodes}.Add(${ctx.nodeVar(order[1])});`);
      const dc = `dev_${this.config.id}`;
      lines.push(`  NetDeviceContainer ${dc} = ${v}.Install(${nodes});`);
      lines.push(`  (void)${dc};`);
    }
    // 链路质量：误码率(链路级恶化) / 抖动(报文级提示)
    const qDev = `dev_${this.config.id}`;
    if (this.config.errorRate != null && this.config.errorRate > 0) {
      ctx.addInclude('ns3/error-model.h');
      lines.push(`  // [链路恶化] ${this.config.id}: 误包率 ${this.config.errorRate}（ErrorUnit 已显式锁定 PACKET）`);
      // ns-3 的 RateErrorModel `ErrorUnit` 属性**默认是 ERROR_UNIT_BYTE**（每字节掷一次骰子）：
      // 不显式锁定的话，界面上填的 1% 会变成「每字节 1%」——128B 报文被毁概率 1-0.99^128 ≈ 72%，
      // 与用户看到的滑块语义（1% 丢包）差两个数量级，且这是库隐式默认值决定的、产物里看不出来。
      lines.push(`  Ptr<RateErrorModel> em_${this.config.id} = CreateObject<RateErrorModel>();`);
      lines.push(`  em_${this.config.id}->SetAttribute("ErrorUnit", EnumValue(RateErrorModel::ERROR_UNIT_PACKET));`);
      lines.push(`  em_${this.config.id}->SetAttribute("ErrorRate", DoubleValue(${this.config.errorRate}));`);
      lines.push(`  ${qDev}.Get(0)->SetAttribute("ReceiveErrorModel", PointerValue(em_${this.config.id}));`);
      lines.push(`  ${qDev}.Get(1)->SetAttribute("ReceiveErrorModel", PointerValue(em_${this.config.id}));`);
    }
    if (this.config.jitter) {
      lines.push(`  // [链路抖动] ${this.config.id}: ${this.config.jitter} — ns-3 有线 P2P/CSMA 无链路级抖动属性，`);
      lines.push(`  //   均值时延见上端 Channel Delay；报文级时延抖动请在业务/应用层以发送时间随机化体现。`);
    }
    // [EPC-LINK] 链路级二层计数：Runtime「通信指标」的**链路**绑定唯一数据源。
    // FlowMonitor 的 KPI 按端到端五元组聚合、天生不含链路维度，只能在此挂 NetDevice 的 MAC trace。
    // 三个 trace 名在 PointToPointNetDevice 与 CsmaNetDevice 上均存在、且都是单参 Ptr<const Packet>
    // （已核对 ns-3.38 源码；挂不存在的名会在 TraceConnectWithoutContext 处 NS_FATAL 终止）。
    // 计数器必须 `static`：trace 回调持有其地址，静态存储期才不悬垂（同 EpcTapCounter）。
    const lc = `epcLink_${this.config.id}`;
    lines.push(`  // [EPC-LINK] 链路级计数 ${this.config.id}：两端设备求和，字段语义与 p2p/csma 差异见 generator/telemetry.ts`);
    lines.push(`  static EpcLinkCounter ${lc};`);
    lines.push(`  ${lc}.link = "${this.config.id}";`);
    for (const end of [0, 1]) {
      lines.push(`  ${qDev}.Get(${end})->TraceConnectWithoutContext("MacTx", MakeBoundCallback(&EpcLinkTx, &${lc}));`);
      lines.push(`  ${qDev}.Get(${end})->TraceConnectWithoutContext("MacRx", MakeBoundCallback(&EpcLinkRx, &${lc}));`);
      // 丢弃取两支之和：MacTxDrop = 发送侧队列满/禁用，PhyRxDrop = 接收侧误码/超长（误包率走这支）
      lines.push(`  ${qDev}.Get(${end})->TraceConnectWithoutContext("MacTxDrop", MakeBoundCallback(&EpcLinkDrop, &${lc}));`);
      lines.push(`  ${qDev}.Get(${end})->TraceConnectWithoutContext("PhyRxDrop", MakeBoundCallback(&EpcLinkDrop, &${lc}));`);
    }
    lines.push(`  EpcLinkTick(&${lc}, ${ctx.telemetryPeriodMs});`);
    return lines.join('\n');
  }

  /** 供 Internet section 迭代分配 IP，返回参与节点的有序列表 */
  endpointIds(): string[] {
    return [this.config.nodeA, this.config.nodeB];
  }

  forSettings() {
    return { ...this.config };
  }
}