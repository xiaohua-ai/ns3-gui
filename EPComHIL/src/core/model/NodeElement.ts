// 节点元素：建节点 + 电力终端模板语义 + 节点级应用（Server/Client）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { NodeConfig, ElementKind, ValidationIssue, NodeAppConfig } from '../types';
import { parseIpv4 } from '../ip';

const KIND_LABEL: Record<string, string> = {
  switch: '交换机',
  router: '路由器',
  host: '主机',
  ied: 'IED',
  rtu: 'RTU',
  pv: '光伏逆变器',
  ess: '储能',
  load: '负荷',
};

/** 网络承载型 L3 协议清单（GOOSE 走 L2、RTU 走串口，不入 UDP Socket） */
const APP_PROTO_CODES: Record<string, string> = { MMS: 'MMS', MODBUS_TCP: 'Modbus/TCP', CUSTOM: 'CUSTOM' };

/**
 * 以 TCP 承载的 L3 协议。真实电力规约里 Modbus/TCP 走 TCP 502；而 UdpServer/UdpClient 是 UDP，
 * 若把 Modbus/TCP 数据退化用 UDP 报文承载，虽能产生流量但与协议语义不符（Modbus/TCP 是面向连接的 TCP 应用）。
 * 该集合内的协议：服务端生成 PacketSinkHelper(ns3::TcpSocketFactory)、客户端/业务流生成 OnOffHelper(TcpSocketFactory)。
 */
export const TCP_BEARER_PROTOCOLS: ReadonlySet<string> = new Set(['MODBUS_TCP']);

/** 协议名 → 是否 TCP 承载 */
export function isTcpBearer(protocol: string | undefined): boolean {
  return protocol != null && TCP_BEARER_PROTOCOLS.has(protocol);
}

/** 决策传输承载：显式值优先 → 其次按协议推断（Modbus/TCP→TCP，其余→UDP）→ 无法决定返 null */
export function resolveTransport(explicit: string | undefined, protocol: string | undefined): 'UDP' | 'TCP' | null {
  if (explicit === 'UDP' || explicit === 'TCP') return explicit;
  if (protocol != null) return isTcpBearer(protocol) ? 'TCP' : 'UDP';
  return null;
}

/**
 * UdpServer / UdpClient 所在头文件（ns-3 里两者同属 udp-client-server-helper.h）。
 * 注意：**不存在** ns3/udp-server-helper.h 或 ns3/udp-client-helper.h —— 那些名字是按类名臆造的，
 * 写进产物会直接编译失败（No such file or directory）。改名前请先对上游仓库核实。
 * 该头文件本已被 BASE_INCLUDES 里的 applications-module.h 聚合，此处显式声明是为表达依赖。
 */
const UDP_CLIENT_SERVER_HEADER = 'ns3/udp-client-server-helper.h';

/** SERVER 未显式指定端口时的默认监听端口（业务流解析目标端口时同源引用） */
export const DEFAULT_SERVER_PORT = 102;

/**
 * UdpClient / UdpServer 上 PacketSize 的有效区间，取自上游 udp-client.cc：
 *   MakeUintegerChecker<uint32_t>(12, 65507)
 * 下限 12B 是 SeqTsHeader 的长度（Send() 里 `NS_ABORT_IF(m_size < seqTs.GetSerializedSize())`），
 * 越界会在运行期直接报错而非降级，故生成前必须拦住。载荷校验（节点应用与业务流）共用本组常量。
 */
export const MIN_UDP_PAYLOAD_BYTES = 12;
export const MAX_UDP_PAYLOAD_BYTES = 65507;

export class NodeElement implements IGenElement<NodeConfig> {
  readonly kind: ElementKind = 'node';
  constructor(public config: NodeConfig) {}
  get id() {
    return this.config.id;
  }
  get label() {
    return this.config.name || this.config.id;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!this.config.id || this.config.id.trim() === '') {
      issues.push({ severity: 'error', elementId: this.id, field: 'id', message: '节点 id 不能为空' });
    }
    if (!KIND_LABEL[this.config.kind]) {
      issues.push({ severity: 'error', elementId: this.id, field: 'kind', message: `未知节点类型: ${this.config.kind}` });
    }
    // 手动指定的 IP：格式在这里统一查（含没挂链路的节点）。
    // 「落在网络号/广播号上」「与同链路另一端不同网段」这类要算完整个工程才看得出，在 IP 规划里报。
    const rawIp = this.config.ip?.trim();
    if (rawIp && parseIpv4(rawIp) === null) {
      issues.push({
        severity: 'error',
        elementId: this.id,
        field: 'ip',
        message: `IP 地址格式非法: ${rawIp}（应为点分十进制 IPv4，如 10.1.0.2）`,
      });
    }
    for (const app of this.config.apps ?? []) {
      const at = `节点 ${this.id} / 应用 ${app.id}`;
      if (app.protocol === 'GOOSE' || app.protocol === 'MODBUS_RTU') {
        issues.push({ severity: 'warning', elementId: this.id, field: 'protocol', message: `${at}: ${app.protocol} 不走网络 Socket（GOOSE=二层帧 / RTU=串口），应用段以 UDP 占位体现` });
      }
      // 端口与载荷都会原样写进 UdpServer/UdpClient 的 SetAttribute，
      // 越界在 ns-3 侧是运行期报错（uint16 端口；PacketSize 见 MIN/MAX_UDP_PAYLOAD_BYTES），故生成前先拦。
      if (app.port !== undefined && (app.port < 1 || app.port > 65535)) {
        issues.push({
          severity: 'error',
          elementId: this.id,
          field: 'port',
          message: `${at}: 端口 ${app.port} 越界（uint16 有效范围 1–65535；0 会由系统随机分配，对端无从预知）`,
        });
      }
      if (
        app.payloadSize !== undefined &&
        (app.payloadSize < MIN_UDP_PAYLOAD_BYTES || app.payloadSize > MAX_UDP_PAYLOAD_BYTES)
      ) {
        issues.push({
          severity: 'error',
          elementId: this.id,
          field: 'payloadSize',
          message: `${at}: 载荷 ${app.payloadSize}B 越界（ns-3 允许 ${MIN_UDP_PAYLOAD_BYTES}–${MAX_UDP_PAYLOAD_BYTES}B）`,
        });
      }
      if (app.role === 'CLIENT') {
        if (!app.peer) {
          issues.push({ severity: 'error', elementId: this.id, field: 'peer', message: `${at}: CLIENT 必须指定对端节点 peer` });
        } else if (!ctx.resolveEndpoint(app.peer)) {
          issues.push({ severity: 'error', elementId: this.id, field: 'peer', message: `${at}: CLIENT 对端节点不存在 ${app.peer}` });
        } else if (!ctx.nodeIpv4(app.peer)) {
          issues.push({ severity: 'error', elementId: this.id, field: 'peer', message: `${at}: CLIENT 对端节点 ${app.peer} 未挂链路，无法解析目标 IP` });
        }
      }
    }
    return issues;
  }

  toCode(ctx: GenerationContext): string {
    const v = ctx.nodeVar(this.id);
    const lines: string[] = [];
    lines.push(`  Ptr<Node> ${v} = CreateObject<Node>();`);
    // 给节点命名只能走 config-store：ns-3 的 Node **没有 SetName 成员**（node.h 里根本没有命名 API），
    // 命名/取名的入口是自由的 Names::Add(name, node) / Names::Find<T>(name)（src/core/model/names.h）。
    // 名字一律取自 ctx.nodeName —— 它保证「工程内唯一」（Names::Add 遇重名会 NS_ABORT 直接终止进程）
    // 并已做 C++ 字面量转义；此处不可自行拼 this.config.name，否则重名/带引号的名字会把产物打废。
    // Names 属 core 模块，随 BASE_INCLUDES 的 core-module.h 一并引入（core-module.h 内含 names.h）。
    lines.push(`  Names::Add("${ctx.nodeName(this.id)}", ${v});  // ${KIND_LABEL[this.config.kind] ?? this.config.kind}`);
    if (this.config.physical) {
      lines.push(`  // [半实物] 节点 ${this.id} 为实物模式，映射物理终端: ${this.config.physicalId ?? '-'}`);
      lines.push(`  // 运行时由半实物配置经 TapBridge 接入到 ${v}`);
    }
    return lines.join('\n');
  }

  forSettings() {
    return { ...this.config };
  }

  /** 节点级应用段：Server(UdpServer)/Client(UdpClient) 真实装载。仅当本节点挂了 apps 才输出。 */
  appsCode(ctx: GenerationContext): string {
    const apps = this.config.apps ?? [];
    if (apps.length === 0) return '';
    const nodeVar = ctx.nodeVar(this.id);
    const lines: string[] = [];
    for (const app of apps) {
      const code = this.singleAppCode(app, nodeVar, ctx);
      if (code) lines.push(code);
    }
    return lines.join('\n');
  }

  private singleAppCode(app: NodeAppConfig, nodeVar: string, ctx: GenerationContext): string {
    const port = app.port ?? DEFAULT_SERVER_PORT;
    const proto = APP_PROTO_CODES[app.protocol] ?? app.protocol;
    if (app.role === 'SERVER') {
      // 承载由显式 transport 决定，缺省按协议推断（Modbus/TCP→TCP，其余→UDP）
      if (resolveTransport(app.transport, app.protocol) === 'TCP') {
        // TCP 承载：面向连接，接收用 PacketSinkHelper(ns3::TcpSocketFactory)。
        // TCP 是字节流、无 UDP 式的「每包 + 来源地址」，故不挂 ServerRxLog
        //（那个回调按 RxWithAddresses 的三参签名 void(Ptr<const Packet>, const Address&, const Address&) 写）。
        return [
          `  // [Server/${proto}] 节点 ${this.config.id} 监听 TCP ${port}（Modbus/TCP 承载）`,
          `  PacketSinkHelper sink_${app.id}("ns3::TcpSocketFactory", InetSocketAddress(Ipv4Address::GetAny(), ${port}));`,
          `  ApplicationContainer appC_${app.id} = sink_${app.id}.Install(${nodeVar});`,
          `  appC_${app.id}.Start(Seconds(1.0));`,
        ].join('\n');
      }
      ctx.addInclude(UDP_CLIENT_SERVER_HEADER);
      ctx.addInclude('<iostream>');
      return [
        `  // [Server/${proto}] 节点 ${this.config.id} 监听 UDP ${port}`,
        `  UdpServerHelper app_${app.id};`,
        `  app_${app.id}.SetAttribute("Port", UintegerValue(${port}));`,
        `  ApplicationContainer appC_${app.id} = app_${app.id}.Install(${nodeVar});`,
        `  // 逐包接收打点：每收一包由 ServerRxLog 打印一行时间戳+来源（挂 UdpServer "RxWithAddresses" 以取到来源地址；该 trace 是三参 packet/from/to）`,
        `  appC_${app.id}.Get(0)->TraceConnectWithoutContext("RxWithAddresses", MakeCallback(&ServerRxLog));`,
        `  appC_${app.id}.Start(Seconds(1.0));`,
      ].join('\n');
    }
    const peerIp = app.peer ? ctx.nodeIpv4(app.peer) : null;
    if (!peerIp) return '';
    const interval = app.interval ?? 1;
    const payload = app.payloadSize ?? 512;
    if (resolveTransport(app.transport, app.protocol) === 'TCP') {
      // TCP 承载：用 OnOff(TcpSocketFactory) 以 interval 为 on 节拍发送，DataRate 按包长×8/interval 折算
      const rateBps = Math.max(1, Math.round((payload * 8) / interval));
      return [
        `  // [Client/${proto}] 节点 ${this.config.id} → ${app.peer}(${peerIp}):${port} 周期 ${interval}s 包 ${payload}B（TCP 承载）`,
        `  OnOffHelper onoff_${app.id}("ns3::TcpSocketFactory", InetSocketAddress(Ipv4Address("${peerIp}"), ${port}));`,
        `  onoff_${app.id}.SetAttribute("OnTime", StringValue("ns3::ConstantRandomVariable[Constant=${interval}]"));`,
        `  onoff_${app.id}.SetAttribute("OffTime", StringValue("ns3::ConstantRandomVariable[Constant=0.0]"));`,
        `  onoff_${app.id}.SetConstantRate(DataRate(${rateBps}), ${payload});`,
        `  ApplicationContainer appC_${app.id} = onoff_${app.id}.Install(${nodeVar});`,
        `  appC_${app.id}.Start(Seconds(2.0));`,
        `  appC_${app.id}.Stop(Seconds(${ctx.stopSeconds}));`,
      ].join('\n');
    }
    ctx.addInclude(UDP_CLIENT_SERVER_HEADER);
    return [
      `  // [Client/${proto}] 节点 ${this.config.id} → ${app.peer}(${peerIp}):${port} 周期 ${interval}s 包 ${payload}B`,
      `  UdpClientHelper app_${app.id}(Ipv4Address("${peerIp}"), ${port});`,
      // MaxPackets 的 ns-3 默认值是 100；周期上报语义要求跑满整个仿真区间，故显式置 0（0 = 不限包数）
      `  app_${app.id}.SetAttribute("MaxPackets", UintegerValue(0));`,
      `  app_${app.id}.SetAttribute("Interval", TimeValue(Seconds(${interval})));`,
      `  app_${app.id}.SetAttribute("PacketSize", UintegerValue(${payload}));`,
      `  ApplicationContainer appC_${app.id} = app_${app.id}.Install(${nodeVar});`,
      `  appC_${app.id}.Start(Seconds(2.0));`,
    ].join('\n');
  }
}