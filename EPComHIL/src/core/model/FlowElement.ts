// 业务流元素：CBR / OnOff / PERIODIC / EVENT / CONTROL（借鉴 WiFiViz Flows 建模，架构 7.4）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { FlowConfig, ElementKind, ValidationIssue } from '../types';
import { MAX_UDP_PAYLOAD_BYTES, MIN_UDP_PAYLOAD_BYTES, resolveTransport } from './NodeElement';

const FLOW_LABEL: Record<string, string> = {
  CBR: 'CBR(定速率)',
  ONOFF: 'OnOff(突发)',
  PERIODIC: 'Periodic(周期遥测)',
  EVENT: 'Event(偶发遥信)',
  CONTROL: 'Control(控制下发)',
};

/** 目标节点没有 SERVER 应用时的占位端口（9 = discard，保证流量仍能产生，同时在校验里告警） */
const FALLBACK_DST_PORT = 9;

export class FlowElement implements IGenElement<FlowConfig> {
  readonly kind: ElementKind = 'flow';
  constructor(public config: FlowConfig) {}
  get id() {
    return this.config.id;
  }
  get label() {
    return `${this.config.type} ${this.config.src}→${this.config.dst}`;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!ctx.resolveEndpoint(this.config.src)) {
      issues.push({ severity: 'error', elementId: this.id, field: 'src', message: `流源端点不存在: ${this.config.src}` });
    }
    if (!ctx.resolveEndpoint(this.config.dst)) {
      issues.push({ severity: 'error', elementId: this.id, field: 'dst', message: `流目的端点不存在: ${this.config.dst}` });
    }
    if (this.config.src === this.config.dst) {
      issues.push({ severity: 'error', elementId: this.id, field: 'dst', message: '流两端不能相同' });
    }
    if (!FLOW_LABEL[this.config.type]) {
      issues.push({ severity: 'error', elementId: this.id, field: 'type', message: `未知流类型: ${this.config.type}` });
    }
    // CBR 是当前唯一真正装载应用的流型，下面几条都是「会让仿真静默空转或直接中断」的坑
    if (this.config.type === 'CBR') {
      const iv = this.config.interval;
      if (typeof iv === 'number' && !(iv > 0)) {
        issues.push({ severity: 'error', elementId: this.id, field: 'interval', message: 'CBR 发包间隔必须大于 0' });
      }
      // 载荷区间与节点应用段共用同一组常量（见 NodeElement 的 MIN/MAX_UDP_PAYLOAD_BYTES）
      if (
        this.config.payloadSize !== undefined &&
        (this.config.payloadSize < MIN_UDP_PAYLOAD_BYTES || this.config.payloadSize > MAX_UDP_PAYLOAD_BYTES)
      ) {
        issues.push({
          severity: 'error',
          elementId: this.id,
          field: 'payloadSize',
          message: `载荷 ${this.config.payloadSize}B 越界（ns-3 UdpClient 允许 ${MIN_UDP_PAYLOAD_BYTES}–${MAX_UDP_PAYLOAD_BYTES}B，下限为 SeqTsHeader 长度）`,
        });
      }
      if (ctx.resolveEndpoint(this.config.dst) && !ctx.serverPort(this.config.dst)) {
        issues.push({
          severity: 'warning',
          elementId: this.id,
          field: 'dst',
          message: `目标节点 ${this.config.dst} 未装 SERVER 应用，CBR 将发往占位端口 ${FALLBACK_DST_PORT}，无人接收`,
        });
      }
    }
    return issues;
  }

  /** OnTime/OffTime 分布说明（constant 精确，其余注明分布类型） */
  private distComment(): string {
    const d = this.config.interval;
    if (typeof d === 'number') return `interval=${d}s`;
    if (d && typeof d === 'object') return `interval~${(d as { type: string }).type}`;
    return '';
  }

  toCode(ctx: GenerationContext): string {
    const srcVar = ctx.nodeVar(this.config.src);
    const dstVar = ctx.nodeVar(this.config.dst);
    // 目标地址取自统一 IP 规划（与 Internet 段 SetBase 同源），不再硬编码网段
    const dstIp = ctx.nodeIpv4(this.config.dst);
    const payload = this.config.payloadSize ?? 512;
    const lines: string[] = [];
    const tag = `  // [业务流/${this.config.type}] ${this.config.src} → ${this.config.dst} (${FLOW_LABEL[this.config.type]}) ${this.distComment()} payload=${payload}B`;
    const dstDesc = dstIp ? `${dstVar} (${dstIp})` : `${dstVar}（未挂链路，无 IP）`;

    // 目标节点没有 SERVER 应用时的占位端口（同 FALLBACK_DST_PORT，保证流量仍能产生）
    const srvPort = ctx.serverPort(this.config.dst);
    const port = srvPort ?? FALLBACK_DST_PORT;
    const interval =
      (typeof this.config.interval === 'number' && this.config.interval > 0 ? this.config.interval : 1) as number;

    // 统一装载真实 UDP 流（UdpClient 周期性发包），由 FlowMonitor 统计，保证脚本可编译可运行、有实际流量。
    // 各类型差异用语义注释区分；CBR 为定速率，其余类型按各自上报/下发节奏每 interval 发一包。
    if (!dstIp) {
      lines.push(tag);
      lines.push(`  // ${dstDesc}，暂不生成业务流装载段：请先为目标节点建立链路。`);
      return lines.join('\n');
    }

    const transport = resolveTransport(this.config.transport, undefined) ?? ctx.serverTransport(this.config.dst);
    const portNote = srvPort
      ? `${transport === 'TCP' ? 'TcpServer' : 'UdpServer'}:${port}`
      : `:${port}（目标节点无 SERVER 监听，占位端口）`;
    lines.push(tag);
    if (this.config.type === 'CBR') {
      lines.push(`  // ${srcVar} 定速率下发 ${dstDesc} ${portNote}，每 ${interval}s 一包`);
    } else if (this.config.type === 'ONOFF') {
      lines.push(`  // ${srcVar} 突发下发 ${dstDesc} ${portNote}，on/off 周期均为 ${interval}s`);
    } else if (this.config.type === 'PERIODIC') {
      lines.push(`  // ${srcVar} 周期遥测上报 ${dstDesc} ${portNote}，间隔 ${interval}s`);
    } else if (this.config.type === 'EVENT') {
      lines.push(`  // ${srcVar} 偶发遥信上报 ${dstDesc} ${portNote}，触发节拍 ${interval}s`);
    } else if (this.config.type === 'CONTROL') {
      lines.push(`  // ${srcVar} 控制下发 → ${dstDesc} ${portNote}，下发节拍 ${interval}s`);
    }
    if (transport === 'TCP') {
      // Modbus/TCP 承载：TCP 面向连接，用 OnOff(TcpSocketFactory) 以 interval 为 on 节拍发送
      const rateBps = Math.max(1, Math.round((payload * 8) / interval));
      lines.push(`  OnOffHelper cbr_${this.config.id}("ns3::TcpSocketFactory", InetSocketAddress(Ipv4Address("${dstIp}"), ${port}));`);
      lines.push(`  cbr_${this.config.id}.SetAttribute("OnTime", StringValue("ns3::ConstantRandomVariable[Constant=${interval}]"));`);
      lines.push(`  cbr_${this.config.id}.SetAttribute("OffTime", StringValue("ns3::ConstantRandomVariable[Constant=0.0]"));`);
      lines.push(`  cbr_${this.config.id}.SetConstantRate(DataRate(${rateBps}), ${payload});`);
      lines.push(`  ApplicationContainer appC_${this.config.id} = cbr_${this.config.id}.Install(${srcVar});`);
      lines.push(`  appC_${this.config.id}.Start(Seconds(2.0));`);
      lines.push(`  appC_${this.config.id}.Stop(Seconds(${ctx.stopSeconds}));`);
      return lines.join('\n');
    }
    lines.push(`  UdpClientHelper cbr_${this.config.id}(Ipv4Address("${dstIp}"), ${port});`);
    // MaxPackets 的 ns-3 默认值是 100，会在 100 包后静默停发；0 = 不限包数（udp-client.cc 的 m_count == 0 分支）
    lines.push(`  cbr_${this.config.id}.SetAttribute("MaxPackets", UintegerValue(0));`);
    lines.push(`  cbr_${this.config.id}.SetAttribute("Interval", TimeValue(Seconds(${interval})));`);
    lines.push(`  cbr_${this.config.id}.SetAttribute("PacketSize", UintegerValue(${payload}));`);
    lines.push(`  ApplicationContainer appC_${this.config.id} = cbr_${this.config.id}.Install(${srcVar});`);
    lines.push(`  appC_${this.config.id}.Start(Seconds(2.0));`);
    lines.push(`  appC_${this.config.id}.Stop(Seconds(${ctx.stopSeconds}));`);
    return lines.join('\n');
  }

  forSettings() {
    return { ...this.config };
  }
}