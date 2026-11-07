// W7 分节编排器：按 Header→参数→节点→链路→Internet→协议→业务流→故障→半实物→运行 顺序组装 .cc
import type { ElementCatalog } from './catalog';
import type { GenerationContext } from '../core/IGenElement';
import type { IpPlanEntry } from './context';
import { collectStatUnion, buildStatsPrint } from './statSink';
import type { StatKey } from '../core/statOutput';
import { buildRealtimeBind, buildHilSyncClass, samplingDoc } from './injectSwitcher';
import { buildTelemetryDecls, kpiPumpLines, startupLogLine } from './telemetry';
import { LINK_MASK } from '../core/ip';
import type { SyncMode } from '../core/types';
import { resolveTransport } from '../core/model/NodeElement';

export interface BuildOptions {
  mode: 'OFFLINE' | 'REALTIME' | 'HIL';
  precise: boolean;
  clockSource: string;
  stopSeconds: number;
  /**
   * 实时同步模式（仅 REALTIME 有效，HIL 由 L2 保守步进接管恒为 HARD_LIMIT）：
   *   HARD_LIMIT  —— 硬墙钟极限，仿真净时绝不超过墙钟，Simulator::Stop(10s)=10s 墙钟；
   *   BEST_EFFORT —— 尽力追赶墙钟，强机上 10s 仿真可能 4s 墙钟就跑完（曲线不随墙钟滚动）。
   */
  syncMode: SyncMode;
  scenarioName: string;
  /** L2 保守步进：步长(ms)，默认 1000（仅 HIL 模式有效） */
  stepMs?: number;
  /** L2 保守步进：算力预算 = 步长 × 预算比，默认 0.8（仅 HIL 模式有效） */
  stepBudgetRatio?: number;
  /** L2 保守步进：连续超预算达该次数触发降级回退，默认 3（仅 HIL 模式有效） */
  stepDegradeAfter?: number;
  /** 由 InjectSwitcher 提供的 HIL 注入段（插入运行段前，仅 HIL 模式有效） */
  hilBlock?: string;
}

// 标准库头用 '<...>' 形式（见下方 include 拼装的分支）；ns3 头统一走聚合模块头
const BASE_INCLUDES = [
  '<iostream>',
  '<string>',
  'ns3/core-module.h',
  'ns3/network-module.h',
  'ns3/internet-module.h',
  'ns3/point-to-point-module.h',
  'ns3/csma-module.h',
  'ns3/applications-module.h',
];

function indent(block: string, pad = '') {
  return block
    .split('\n')
    .map((l) => (l.trim() === '' ? l : pad + l))
    .join('\n');
}

export function buildSource(
  cat: ElementCatalog,
  ctx: GenerationContext,
  opts: BuildOptions,
  ipPlan: IpPlanEntry[] = [],
  includes: Set<string> = new Set<string>(),
): string {
  // ---- 第一遍：渲染各段 ----
  // 元素 toCode 过程中会经 ctx.addInclude 声明所需头文件，故 include 区必须等所有段渲染完再拼装。
  const nodeSec: string[] = [];
  for (const n of cat.nodes) nodeSec.push(indent(n.toCode(ctx)));
  nodeSec.push(indent(`  NodeContainer allNodes;`));
  for (const n of cat.nodes) nodeSec.push(indent(`  allNodes.Add(${ctx.nodeVar(n.id)});`));

  const linkSec: string[] = [];
  for (const l of cat.links) linkSec.push(indent(l.toCode(ctx)));

  const internetSec: string[] = [];
  internetSec.push(indent(`  InternetStackHelper stack;`));
  internetSec.push(indent(`  stack.Install(allNodes);`));
  for (const l of cat.links) {
    const entry = ipPlan.find((p) => p.linkId === l.id);
    // 网段基址一律取自 IP 规划（用户可在节点属性里改 IP，规划会把网段推成该地址所在的 /30）。
    // 缺规划时退到首个网段，保证产物仍自洽。
    const base = entry?.base ?? '10.1.0.0';
    const dv = l.deviceVars();
    // p2p 与 csma 均为一次 Install 产出的单设备容器，直接对其 Assign（p2p 自动 /30）
    const devices = dv.a;
    internetSec.push(indent(`  {`));
    internetSec.push(indent(`    Ipv4AddressHelper ipv4;`));
    internetSec.push(indent(`    ipv4.SetBase(Ipv4Address("${base}"), Ipv4Mask("${LINK_MASK}"));`));
    internetSec.push(indent(`    Ipv4InterfaceContainer ifc_${l.id} = ipv4.Assign(${devices});`));
    // Assign 按设备顺序静默发号，产物里不落任何地址字面量 —— 把规划结果写成注释，
    // 否则用户从脚本里根本看不出哪个节点拿到了哪个 IP。
    if (entry) {
      const ipByNode = new Map<string, string>([
        [l.config.nodeA, entry.ips[0]],
        [l.config.nodeB, entry.ips[1]],
      ]);
      const assigned = entry.deviceOrder.map((id) => `${ctx.nodeVar(id)} = ${ipByNode.get(id)}`).join(', ');
      internetSec.push(indent(`    // 按设备顺序分配: ${assigned}`));
    }
    internetSec.push(indent(`    (void)ifc_${l.id};`));
    internetSec.push(indent(`  }`));
  }
  if (cat.links.length > 1) {
    // 每条链路独占一个 /30 网段，各节点只有自己直连网段的路由。
    // 不填充全局路由表，跨网段（非邻接）报文会因无路由被静默丢弃，链路看着建好却不通。
    internetSec.push(indent(`  Ipv4GlobalRoutingHelper::PopulateRoutingTables();`));
  }

  const appSec: string[] = [];
  for (const n of cat.nodes) {
    const apps = n.appsCode(ctx);
    if (apps) appSec.push(apps);
  }

  const protoSec: string[] = [];
  for (const p of cat.protocols) protoSec.push(indent(p.toCode(ctx)));

  const flowSec: string[] = [];
  for (const f of cat.flows) flowSec.push(indent(f.toCode(ctx)));

  const faultSec: string[] = [];
  for (const fa of cat.faults) faultSec.push(indent(fa.toCode(ctx)));

  const halfSec: string[] = [];
  for (const h of cat.halfPhysical) halfSec.push(indent(h.toCode(ctx)));

  // ---- 第二遍：拼装 ----
  const L: string[] = [];
  // 统计输出为平台默认能力：即便用户未在组件上勾选统计项，也保证按基础指标出数，
  // 与 ns-3 官方示例（udp-client-server、flowmon 等）"运行必然有输出"的行为一致。
  // 勾选过任意 stats 时按所选列输出；未勾选时兜底基础列（发送/接收/丢包/PDR）。
  const statKeys = collectStatUnion({
    nodes: cat.nodes.map((n) => n.config),
    links: cat.links.map((l) => l.config),
  });
  const FALLBACK_STATS: StatKey[] = ['tx_packets', 'rx_packets', 'lost_packets', 'pdr'];
  const outStatKeys = statKeys.length ? statKeys : FALLBACK_STATS;

  L.push(`// ==================================================================`);
  L.push(`// EPComHIL 自动生成 · 场景: ${opts.scenarioName}`);
  L.push(`// 生成器: 架构第七章 代码生成模块 · 模式: ${opts.mode} · 时钟源: ${opts.clockSource}`);
  L.push(`// 说明: 本文件为自包含 ns-3 脚本（先行版产物），供 Linux 端消费。`);
  L.push(samplingDoc(opts.precise));
  L.push(`// ==================================================================`);
  L.push('');
  const allIncludes = [...BASE_INCLUDES];
  if (outStatKeys.length) allIncludes.push('ns3/flow-monitor-module.h');
  // 遥测要报出「流 → 五元组」，需直接使用 Ipv4FlowClassifier::FiveTuple / FindFlow：
  // 显式引入（模块聚合头里也有，但不依赖它——聚合头的包含范围随版本变动）。
  allIncludes.push('ns3/ipv4-flow-classifier.h');
  // HIL 同步引擎类使用 std::chrono 墙钟，需显式引入
  if (opts.mode === 'HIL') allIncludes.push('<chrono>');
  for (const h of includes) if (!allIncludes.includes(h)) allIncludes.push(h);
  // '<xxx>' 为标准库头，'xxx' 为 ns3 头（走 build/include/ns3 搜索路径）
  for (const h of allIncludes) L.push(h.startsWith('<') ? `#include ${h}` : `#include "${h}"`);
  L.push('');
  L.push('using namespace ns3;');
  L.push('');

  // 运行遥测发射段：平台 Runtime 监视台的数据源（协议与发射函数见 generator/telemetry.ts）。
  // 遥测是「产物 → 平台」的唯一回传通道，与运行模式无关（OFFLINE / HIL 都发），
  // 区别只在投递节奏：OFFLINE 全速吐完、HIL 按墙钟逐拍到达。
  const hasTapTelemetry =
    opts.mode === 'HIL' && cat.halfPhysical.some((h) => ((h.config && h.config.taps) || []).length > 0);
  // 链路计数：只要有链路就发射 —— 链路绑定是用户可见档位，不能靠模式或应用类型兜圈子。
  L.push(buildTelemetryDecls(hasTapTelemetry, cat.links.length > 0));
  L.push('');

  // 逐包日志回调：挂在每个 Server 应用的 "RxWithAddresses" trace 源上，每收一包打一行时间戳+来源。
  // ns-3.38 的 UdpServer trace 分两种（见 src/applications/model/udp-server.h）：
  //   - "Rx"              → TracedCallback<Ptr<const Packet>>                                    （一参）
  //   - "RxWithAddresses" → TracedCallback<Ptr<const Packet>, const Address&, const Address&>    （**三参** packet/from/to）
  // 要打印来源 IP/端口就得挂带地址那支，且回调的**参数个数必须严格对应**（光名字对上不够）：
  // 个数不符时 TraceConnectWithoutContext 内 cb.Assign() 失败 → NS_FATAL_ERROR_NO_MSG() 抛空 what()
  // 的 std::runtime_error 直接终止，且崩在 Simulator::Run() 之前 —— 日志里没有任何业务输出，
  // 外部看像「程序启动即退」，极易被误判成环境问题。改这里务必与头文件逐个参数对齐。
  // 仅当工程存在 **UDP 承载** 的 SERVER 应用时才插入：ServerRxLog 专挂 UdpServer 的 "RxWithAddresses"。
  // TCP(Socket factory) Server 走 PacketSink、不挂它，故纯 TCP 工程不生成，
  // 避免编译时出现未使用的静态函数告警。
  const anyUdpServer = cat.nodes.some((n) =>
    (n.config.apps ?? []).some((a) => a.role === 'SERVER' && resolveTransport(a.transport, a.protocol) !== 'TCP'),
  );
  if (anyUdpServer) {
    L.push('// 逐包接收日志（UdpServer "RxWithAddresses" trace，三参 packet/from/to）：时间戳 + 来源 IP/端口 + 字节数');
    L.push('static void ServerRxLog(Ptr<const Packet> p, const Address &from, const Address &to) {');
    L.push('  (void)to;  // 本行只打印来源；第三参用于与 trace 源签名严格对齐，少一个参数会 NS_FATAL_ERROR 终止');
    // 取整数微秒必须用 GetMicroSeconds()：Time::As(Unit) 返回的是 TimeWithUnit（自带单位后缀、
    // 成员全 private、没有任何取值接口），拿不到数字 —— 直接流输出会打成 "+2.00014e+06us" 这种带单位的串。
    L.push('  std::cout << Simulator::Now().GetMicroSeconds() << " us ◆Rx " << p->GetSize()');
    L.push('            << "B from " << InetSocketAddress::ConvertFrom(from).GetIpv4()');
    L.push('            << ":" << InetSocketAddress::ConvertFrom(from).GetPort() << std::endl;');
    L.push('}');
  }
  L.push('');

  // L2 保守步进同步引擎定义（仅 HIL 模式：供运行段装配使用）
  if (opts.mode === 'HIL') {
    L.push('');
    const syncClass = buildHilSyncClass(opts);
    if (syncClass) L.push(syncClass);
    L.push('');
  }

  L.push('int main(int argc, char* argv[]) {');
  L.push(`  CommandLine cmd;`);
  L.push(`  bool hil = ${opts.mode === 'HIL' ? 'true' : 'false'};`);
  L.push(`  bool precise = ${opts.precise ? 'true' : 'false'};`);
  // --hil 三种产物都注册：只在 HIL 产物里注册会导致它在 OFF/REAL 产物里被 CommandLine
  // 当成未知参数 → 只打告警不赋值，hil 永远是默认 false，后面的拒绝分支就成了死代码
  //（用户传 --hil 反而不会被识别，防御失效）。统一注册，让拒绝分支能真正拦到误用。
  L.push(`  cmd.AddValue("hil", "Enable HIL mode", hil);`);
  // precise 的取值只在导出时生效（决定头部采集说明注释）；采样节流本身由 HIL 引擎落地，
  // 先行版产物里没有可被它开关的代码，故参数串里写明「占位」，避免看起来像个能用的开关。
  L.push(`  cmd.AddValue("precise", "Precise sampling (占位: 采样节流由 HIL 引擎落地，当前无运行时消费方)", precise);`);
  L.push(`  cmd.Parse(argc, argv);`);
  if (opts.mode !== 'HIL') {
    // OFFLINE / REALTIME 产物都不消费 hil。与其静默忽略（用户以为在跑半实物闭环，
    // 实际跑的是别的场景），不如明确拒绝并说明，避免误导。
    const shown = opts.mode === 'REALTIME' ? 'REALTIME' : 'OFFLINE';
    L.push('');
    L.push('  if (hil) {');
    L.push(`    std::cerr << "[EPComHIL] 本产物为 ${shown} 模式，--hil 不生效；请以 HIL 模式重新导出。" << std::endl;`);
    L.push('    return 2;');
    L.push('  }');
  }
  L.push('');

  // 挂钟实时时间基准：必须**最先**绑定实时仿真器实现 —— 早于 `Time::SetResolution`、
  // 更要早于下面那条启动遥测。这不是风格问题：`Simulator::GetImpl()` 是懒加载单例，
  // 首次触碰（哪怕只是遥测里的 `Simulator::Now()`）就会按当时的 GlobalValue 创建并缓存
  // `DefaultSimulatorImpl`，此后 `GlobalValue::Bind` 只改默认值、换不掉已缓存实例 ——
  // 结果是实时模式名义上在跑，实际是全速仿真，曲线不再随墙钟滚动（实测 10s 仿真 1ms 跑完）。
  // 详见 buildRealtimeBind 的注释。
  const realtimeBind = buildRealtimeBind(opts);
  if (realtimeBind) {
    for (const rl of realtimeBind.split('\n')) L.push(indent(rl));
    L.push('');
  }

  L.push('  Time::SetResolution(Time::NS);');
  // 遥测首行（t=0）：让 Runtime 的「操作日志」组件从第一帧就有内容，
  // 也让运行日志能一眼看出跑的是哪份产物、什么模式 —— 排查时最需要的就是这条。
  L.push(startupLogLine(opts.scenarioName, opts.mode, opts.clockSource));

  if (nodeSec.length) {
    L.push('');
    L.push('  // ---------------- 节点创建 ----------------');
    L.push(...nodeSec);
  }

  if (linkSec.length) {
    L.push('');
    L.push('  // ---------------- 链路与通道 ----------------');
    L.push(...linkSec);
  }

  if (internetSec.length) {
    L.push('');
    L.push('  // ---------------- Internet 装配与 IP 分配 ----------------');
    L.push(...internetSec);
  }

  if (appSec.length) {
    L.push('');
    L.push('  // ---------------- 应用装载 (Server/Client UDP) ----------------');
    L.push(...appSec);
  }

  if (protoSec.length) {
    L.push('');
    L.push('  // ---------------- 协议装载 ----------------');
    L.push(...protoSec);
  }

  if (flowSec.length) {
    L.push('');
    L.push('  // ---------------- 业务流 ----------------');
    L.push(...flowSec);
  }

  if (faultSec.length) {
    L.push('');
    L.push('  // ---------------- 故障注入 ----------------');
    L.push(...faultSec);
  }

  if (halfSec.length) {
    L.push('');
    L.push('  // ---------------- 半实物接入 ----------------');
    L.push(...halfSec);
  }

  if (opts.hilBlock) {
    L.push('');
    L.push('  // ---------------- HIL / 运行注入 ----------------');
    for (const hl of opts.hilBlock.split('\n')) L.push(indent(hl, '  '));
  }

  L.push('');
  // 统计输出总是启用：基础指标至少 1 项（未选中时已兜底 FALLBACK_STATS），因此恒安装 FlowMonitor
  L.push('  // ---------------- 统计输出（FlowMonitor） ----------------');
  L.push('  FlowMonitorHelper flowHelper;');
  L.push('  Ptr<FlowMonitor> monitor = flowHelper.InstallAll();');
  // 流的五元组（IP:port）取数器：遥测用它把每条曲线确定地绑回"哪台机 → 哪台机"。
  // 用 DynamicCast 而非假定类型：helper 的 classifier 类型随 IPv4/IPv6 开关而变，
  // 转不成就拿到空 Ptr，遥测按"无端点"处理（平台退回按序回映），不会崩。
  L.push('  Ptr<Ipv4FlowClassifier> flowCls = DynamicCast<Ipv4FlowClassifier>(flowHelper.GetClassifier());');
  // 遥测周期泵：顶部启动一次即持续发射 KPI 快照（Runtime「通信指标」曲线与 KPI 的数据源）。
  for (const kl of kpiPumpLines(opts.precise)) L.push(kl);
  L.push('');
  L.push(`  Simulator::Stop(Seconds(${opts.stopSeconds}));`);
  L.push('  Simulator::Run();');
  // 仿真结束标记必须紧贴 Run() 返回后、且在统计打印之前：Runtime 计时以此收表，
  // 只纳入真仿真的墙钟——严格实时(REALTIME/HIL)下 ≈ Stop 时长，统计打印的墙钟不计入。
  L.push('  EpcLog("info", "runtime", "仿真结束");');
  L.push('');
  for (const s of buildStatsPrint(outStatKeys)) L.push(indent(s));
  L.push('');
  L.push('  Simulator::Destroy();');
  L.push('  return 0;');
  L.push('}');
  L.push('');

  return L.join('\n');
}
