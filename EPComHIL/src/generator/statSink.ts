// 统计输出段生成：当任一组件（节点/链路）勾选了 stats 时，落地 FlowMonitor 运行统计。
// 生成的代码保证可编译可运行：Run 前安装 FlowMonitor，Run 后按所选输出列打印各数据流指标。
import type { StatKey } from '../core/statOutput';
import { STAT_KEYS, unionStats } from '../core/statOutput';

/** 各统计项 → ns-3 FlowMonitor 流统计取值表达式（按输出列渲染） */
const STAT_COL_EXPR: Record<StatKey, string> = {
  tx_packets: '"TxPkts=" << st.txPackets',
  rx_packets: '"RxPkts=" << st.rxPackets',
  tx_bytes: '"TxBytes=" << st.txBytes',
  rx_bytes: '"RxBytes=" << st.rxBytes',
  lost_packets: '"Lost=" << st.lostPackets',
  pdr: '"PDR%=" << (st.txPackets ? (100.0 * st.rxPackets / st.txPackets) : 0.0)',
  delay_mean: '"MeanDelay_s=" << (st.rxPackets ? (st.delaySum.GetSeconds() / static_cast<double>(st.rxPackets)) : 0.0)',
  delay_jitter: '"Jitter_s=" << (st.rxPackets ? (st.jitterSum.GetSeconds() / static_cast<double>(st.rxPackets)) : 0.0)',
};

/** 汇总所有节点/链路勾选的统计项（并集，按目录顺序求列） */
export function collectStatUnion(cat: { nodes: { stats?: string[] }[]; links: { stats?: string[] }[] }): StatKey[] {
  const arrays: (string[] | undefined)[] = [
    ...cat.nodes.map((n) => n.stats),
    ...cat.links.map((l) => l.stats),
  ];
  return unionStats(arrays);
}

/** 是否启用统计输出 */
export function hasStats(cat: { nodes: { stats?: string[] }[]; links: { stats?: string[] }[] }): boolean {
  return collectStatUnion(cat).length > 0;
}

/** Run 之后、Destroy 之前的统计打印段 */
export function buildStatsPrint(keys: StatKey[]): string[] {
  const cols = keys.length ? keys.map((k) => STAT_COL_EXPR[k]).join('\n              << ') : '';
  return [
    '// =============== 统计输出 ===============',
    'monitor->CheckForLostPackets();',
    // 这里**不要**再 DynamicCast 取 classifier：本段只打印计数，五元组由遥测段负责
    // （见 generator/telemetry.ts 的 EpcKpiTick）。留着会变成"声明了却没人用"的死变量。
    'FlowMonitor::FlowStatsContainer flowStats = monitor->GetFlowStats();',
    'std::cout << "=== EPComHIL 统计输出 ===" << std::endl;',
    'for (FlowMonitor::FlowStatsContainer::const_iterator it = flowStats.begin(); it != flowStats.end(); ++it) {',
    '  FlowMonitor::FlowStats st = it->second;',
    '  std::cout << "Flow " << it->first',
    `              << ${cols}`,
    '              << std::endl;',
    '}',
  ];
}

export { STAT_KEYS as _STAT_KEYS };