// 运行遥测协议（生成器侧）：把产物 stdout 变成平台 Runtime 监视台可消费的事件流。
//
// —— 为什么要有这一层 ——
// 平台 Runtime 监视台（5 类组件）此前只有 mock 数据源，真实链路从没接上。产物原来只打
// 「逐包 Rx 行 + 末尾一段 FlowMonitor 汇总」，据此只能凑出通信曲线的零星点，其余组件全空。
// 本模块给产物补一段**自描述的遥测发射**：每个事件一行、固定前缀、空格分隔 key=value，
// 运行期即产出；解析器（src/core/simOutput.ts）逐行还原成 RuntimeEvent。
//
// —— 单一来源纪律 ——
// 前缀与字段名在此定义，解析器与之逐字对应。改任何一侧都必须同步改另一侧以及
// test/simOutput.test.ts、test/ns3-products.test.ts。**不对称不会报错、不会崩溃**，
// 只会让 Runtime 组件「永远空着」—— 这是最难排查的一类故障，务必成对修改。

import { cppLiteral } from '../core/cppText';
// 前缀的**单一来源在 core/simOutput.ts**：解析器从中取，这里把它拼进产物。
// 于是「改一处两边同步」是编译期成立的，而不是靠注释提醒人改两遍。
import { EPC_PREFIX } from '../core/simOutput';

export { EPC_PREFIX };

/**
 * 遥测发射周期（**仿真时间** ms）。
 *
 * 与产物头部「采集：precise / rough」同源：precise 逐点输出（密）、rough 抽稀输出（疏）——
 * 让这个用户可见的开关真正落到数据密度上，而不是只写在注释里。
 *
 * 注意单位是**仿真时间**，这决定了两种查看体验：
 *   - OFFLINE：仿真全速推进，20 帧遥测在零点几秒墙钟内一次吐完 → Runtime 曲线**一次性铺满**；
 *   - HIL：RealtimeSimulatorImpl 按墙钟推进，遥测**逐拍到达** → Runtime 曲线**随仿真实时滚动**。
 * 同一套通道、同一个解析器，差别只在投递节奏。
 */
export function telemetryPeriodMs(precise: boolean): number {
  return precise ? 200 : 1000;
}

/** C++ 字符串字面量转义（单一来源见 core/cppText.ts，供本模块拼遥测消息用） */
export { cppLiteral } from '../core/cppText';

/**
 * 遥测发射函数定义段（插在 `using namespace ns3;` 之后、`main` 之前）。
 *
 * @param hasTap 是否需要半实物通道计数（TapBridge 段存在时才发射，避免无用静态函数告警）
 * @param hasLink 是否需要链路级计数（工程里有链路时才发射，同理避免未使用告警）
 */
export function buildTelemetryDecls(hasTap: boolean, hasLink = false): string {
  const L: string[] = [];
  L.push('// ================= EPComHIL 运行遥测发射 =================');
  L.push('// 平台 Runtime 监视台的数据源。每事件一行、前缀 [EPC-xxx]、空格分隔 key=value。');
  L.push('// 解析器见 src/core/simOutput.ts —— 改这里的字段名/前缀必须同步改解析器与其回归测试，');
  L.push('// 否则 Runtime 组件会「不报错、永远空着」，是最难排查的一类故障。');
  L.push('// t 一律为仿真时间(μs)；取整数必须用 GetMicroSeconds()（Time::As 返回 TimeWithUnit，拿不到数字）。');
  L.push('static void EpcLog(const char* level, const char* src, const std::string& msg) {');
  L.push(`  std::cout << "${EPC_PREFIX.op}t=" << Simulator::Now().GetMicroSeconds()`);
  L.push('            << " level=" << level << " src=" << src << " msg=" << msg << std::endl;');
  L.push('}');
  L.push('');
  L.push('// 周期 KPI 快照：逐流读 FlowMonitor 的累计量（tx/rx/lost/PDR/时延/抖动）。');
  L.push('// 自调度成「周期泵」—— 顶部调用一次即持续发射，无需再管。');
  L.push('// 为什么不用产物末尾那段汇总：那是**终态一次性**输出，画不出随时间变化的曲线。');
  L.push('//');
  L.push('// src/dst/proto 是**给平台认对象用的**：flow=<n> 是 ns-3 按首包先后自己发的号，');
  L.push('// 与工程里的业务流顺序没有契约；只有五元组能把这条曲线确定地绑回"哪台机 → 哪台机"。');
  L.push('// FindFlow 的安全性依据（别随意改成"先查再调"，没有那个接口）：');
  L.push('//   FlowMonitor 的 stats 键与本 classifier 的 m_flowMap 由同一次 Classify() 一并插入');
  L.push('//   （见 src/flow-monitor/model/ipv4-flow-probe.cc），故 stats 里的每个 flowId');
  L.push('//   必然已在 m_flowMap 中 —— 这正是 FindFlow 内部 NS_FATAL_ERROR 分支不会走到的前提。');
  L.push('static void EpcKpiTick(Ptr<FlowMonitor> monitor, Ptr<Ipv4FlowClassifier> cls, uint32_t periodMs) {');
  L.push('  monitor->CheckForLostPackets();');
  L.push('  FlowMonitor::FlowStatsContainer stats = monitor->GetFlowStats();');
  L.push('  for (FlowMonitor::FlowStatsContainer::const_iterator it = stats.begin(); it != stats.end(); ++it) {');
  L.push('    const FlowMonitor::FlowStats& st = it->second;');
  L.push('    const double pdr = st.txPackets ? static_cast<double>(st.rxPackets) / st.txPackets : 0.0;');
  L.push('    const int64_t delayUs = st.rxPackets ? st.delaySum.GetMicroSeconds() / st.rxPackets : 0;');
  L.push('    const int64_t jitterUs = st.rxPackets > 1 ? st.jitterSum.GetMicroSeconds() / (st.rxPackets - 1) : 0;');
  L.push(`    std::cout << "${EPC_PREFIX.kpi}t=" << Simulator::Now().GetMicroSeconds()`);
  L.push('              << " flow=" << it->first;');
  L.push('    // cls 为空（未装 IPv4 探针）时不发端点：平台据"无端点"退回按序回映，而不是瞎绑');
  L.push('    if (cls) {');
  L.push('      Ipv4FlowClassifier::FiveTuple ft = cls->FindFlow(it->first);');
  L.push('      std::cout << " src=" << ft.sourceAddress << ":" << ft.sourcePort');
  L.push('                << " dst=" << ft.destinationAddress << ":" << ft.destinationPort');
  L.push('                << " proto=" << static_cast<uint32_t>(ft.protocol);');
  L.push('    }');
  L.push('    std::cout << " tx=" << st.txPackets << " rx=" << st.rxPackets << " lost=" << st.lostPackets');
  L.push('              << " pdr=" << pdr << " delay=" << delayUs << " jitter=" << jitterUs << std::endl;');
  L.push('  }');
  L.push('  Simulator::Schedule(MilliSeconds(periodMs), &EpcKpiTick, monitor, cls, periodMs);');
  L.push('}');
  if (hasTap) {
    L.push('');
    L.push('// [EPC-TAP] 半实物通道遥测：周期报出桥接设备的二层收发计数。');
    L.push('// 计数挂点（见 src/csma/model/csma-net-device.cc，两者都是 TracedCallback<Ptr<const Packet>> 单参）：');
    L.push('//   MacTx ← CsmaNetDevice::SendFrom  → 实物流【入】模型（TapBridge 从 tap 读到帧后 SendFrom 注入）');
    L.push('//   MacRx ← CsmaNetDevice::Receive   → 模型流【出】实物（该设备收到后由 TapBridge 抢走写进 tap）');
    L.push('// 注意 trace 名与语义是反的：叫 MacTx 的那支对应「模型收到」，别按字面套。');
    L.push('struct EpcTapCounter {');
    L.push('  std::string tap;');
    L.push('  uint64_t rx = 0;  // 实物流入模型（挂 MacTx）');
    L.push('  uint64_t tx = 0;  // 模型流出实物（挂 MacRx）');
    L.push('};');
    // 用裸指针而非 Ptr<>：计数器不是 ns-3 Object（没有 TypeId，也不该被引用计数管），
    // 实例以「函数内 static」定义在装载段里 —— 静态存储期保证 trace 回调持有的地址始终有效。
    L.push('static void EpcTapRx(EpcTapCounter* c, Ptr<const Packet>) { ++c->rx; }');
    L.push('static void EpcTapTx(EpcTapCounter* c, Ptr<const Packet>) { ++c->tx; }');
    L.push('static void EpcTapTick(EpcTapCounter* c, uint32_t periodMs) {');
    L.push(`  std::cout << "${EPC_PREFIX.tap}t=" << Simulator::Now().GetMicroSeconds()`);
    L.push('            << " tap=" << c->tap << " rx=" << c->rx << " tx=" << c->tx << std::endl;');
    L.push('  Simulator::Schedule(MilliSeconds(periodMs), &EpcTapTick, c, periodMs);');
    L.push('}');
  }
  if (hasLink) {
    L.push('');
    L.push('// 链路级二层计数（发射 [EPC-LINK] 行）：周期报出该链路两端的收/发/丢帧数。');
    L.push('// 与 [EPC-KPI] 是**两套独立测量**，不是 KPI 的细分：KPI 来自 FlowMonitor，按端到端五元组');
    L.push('// 聚合，天生不知道流量走了哪条链路（产物里也没有 flow→链路 的映射）；链路计数只能挂在');
    L.push('// NetDevice 的 MAC 层 trace 上。两类设备的挂点均已核对 ns-3.38 源码，签名统一为单参 Ptr<const Packet>：');
    L.push('//   PointToPointNetDevice: MacTx←Send()、MacRx←Receive() 成功交付、PhyRxDrop←Receive() 误码/超长');
    L.push('//   CsmaNetDevice:         MacTx←SendFrom()、MacRx←Receive() 成功交付、MacTxDrop←SendFrom() 队列满/禁用');
    L.push('// 两端设备各自计数后求和，故：');
    L.push('//   p2p（两端一通道）：一次 MacTx 对应一次 MacRx，rx/tx 即链路投递率；');
    L.push('//   csma（共享总线）：一次 MacTx 会被除发送者外的每个端点各收一次，rx 是 tx 的 (N-1) 倍，');
    L.push('//     **rx/tx 会大于 1**，所以链路投递率一律按 drop 口径算（平台解析侧 1-drop/tx），别用 rx/tx。');
    L.push('// 时延/抖动设备层拿不到（要靠时间戳配对，跨两端时钟对齐），故本行**不发** delay/jitter。');
    L.push('struct EpcLinkCounter {');
    L.push('  std::string link;');
    L.push('  uint64_t tx = 0;    // MacTx：送入/发出该链路的帧数（两端求和）');
    L.push('  uint64_t rx = 0;    // MacRx：从该链路收到并交付上层的帧数（两端求和）');
    L.push('  uint64_t drop = 0;  // MacTxDrop + PhyRxDrop：在该链路上丢掉的帧数');
    L.push('};');
    // 与 EpcTapCounter 同理：裸指针 + 函数内 static，静态存储期保证 trace 回调持有的地址不悬垂。
    L.push('static void EpcLinkTx(EpcLinkCounter* c, Ptr<const Packet>) { ++c->tx; }');
    L.push('static void EpcLinkRx(EpcLinkCounter* c, Ptr<const Packet>) { ++c->rx; }');
    L.push('static void EpcLinkDrop(EpcLinkCounter* c, Ptr<const Packet>) { ++c->drop; }');
    L.push('static void EpcLinkTick(EpcLinkCounter* c, uint32_t periodMs) {');
    L.push(`  std::cout << "${EPC_PREFIX.link}t=" << Simulator::Now().GetMicroSeconds()`);
    L.push('            << " link=" << c->link << " tx=" << c->tx << " rx=" << c->rx');
    L.push('            << " drop=" << c->drop << std::endl;');
    L.push('  Simulator::Schedule(MilliSeconds(periodMs), &EpcLinkTick, c, periodMs);');
    L.push('}');
  }
  return L.join('\n');
}

/** 产物启动打点（t=0，紧接 Time::SetResolution 之后） */
export function startupLogLine(scenarioName: string, mode: string, clockSource: string): string {
  const msg = cppLiteral(`产物启动 mode=${mode} 场景=${scenarioName} 时钟源=${clockSource}`);
  return `  EpcLog("info", "generator", "${msg}");`;
}

/** 遥测通道就绪打点 + 启动 KPI 周期泵 */
export function kpiPumpLines(precise: boolean): string[] {
  const period = telemetryPeriodMs(precise);
  return [
    `  EpcLog("info", "runtime", "遥测通道就绪 周期=${period}ms");`,
    `  EpcKpiTick(monitor, flowCls, ${period});`,
  ];
}
