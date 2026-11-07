// 流端点索引：把产物报出的「IP:port」还原成工程对象（节点 / 业务流）。
//
// —— 为什么不能靠流号 ——
// 产物里的 `flow=<n>` 是 ns-3 的 FlowMonitor 自己发的：从 1 起、按**首包被探到的先后**递增。
// 它与工程里的 flows 数组顺序没有契约关系，而工程（含内置案例「P2P主从UDP」）常常
// flows 恒为空 —— 此时按序号回映必然落空，KPI 便没有绑定对象，Runtime 组件全空。
// 空数据不报错、不崩溃，只是"什么都没有"，是最难排查的一类故障。
//
// —— 靠什么 ——
// 产物在 KPI 行里附上该流的五元组来源与目的（`src=10.1.0.1:49153 dst=10.1.0.2:502`），
// 由 Ipv4FlowClassifier::FindFlow 取得（见 src/generator/telemetry.ts）。
// 平台这边把 IP 还原成节点：**IP 规划与生成器同源**（buildIpPlan / buildNodeIpMap），
// 因此"哪台机是 10.1.0.2"不是猜的，而是同一份规划算出来的。
//
// 本模块纯函数、不碰 IO，可单测。
import type { FlowIndex } from './runtimeModel';

/** 解析 `10.1.0.2:502` 形式的端点；畸形返回 null（宁可不绑定，也不绑错对象） */
export function parseEndpoint(s: string | undefined): { ip: string; port: number } | null {
  if (!s) return null;
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const ip = s.slice(0, i);
  const rawPort = s.slice(i + 1);
  // 空端口（`10.1.0.2:`）不是"端口 0"而是畸形：Number('') === 0 会把它悄悄当成合法端口放过去
  if (rawPort === '') return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return null;
  }
  return { ip, port };
}

/**
 * 端点 → 绑定对象。
 *
 * 规则（先准后宽）：
 *   1. 业务流：工程显式定义的流里 src/dst 恰好对上两端节点，且**只有一条**时才绑流。
 *      同一对节点间有多条流时无法区分（五元组里只有"哪台机到哪台机"，
 *      而 FlowConfig 不带端口），此时**不绑流**，只绑节点 —— 宁可不绑，也不绑错。
 *   2. 节点：对得上的端点逐个填进 nodeId / peerNodeId。
 *
 * 两端 IP 都不认识时返回 null —— 调用方据此**不打 target**（组件不会把陌生流量画到自己头上）。
 */
export function resolveFlowTarget(
  index: FlowIndex | undefined,
  src: string | undefined,
  dst: string | undefined,
): { nodeId?: string; peerNodeId?: string; flowId?: string } | null {
  if (!index) return null;
  const a = parseEndpoint(src);
  const b = parseEndpoint(dst);
  const nodeA = a ? index.nodeByIp[a.ip] : undefined;
  const nodeB = b ? index.nodeByIp[b.ip] : undefined;
  if (!nodeA && !nodeB) return null;

  const out: { nodeId?: string; peerNodeId?: string; flowId?: string } = {};
  // 源侧：有地址就给 nodeId；只有目的侧认识时，把它当作 nodeId 的"对端"放 peerNodeId
  if (nodeA) out.nodeId = nodeA;
  if (nodeB) out.peerNodeId = nodeB;

  if (nodeA && nodeB) {
    const cands = index.flows.filter((f) => f.src === nodeA && f.dst === nodeB);
    if (cands.length === 1) out.flowId = cands[0].id;
  }
  return out;
}
