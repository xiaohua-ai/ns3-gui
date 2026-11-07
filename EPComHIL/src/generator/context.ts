// 生成上下文实现：节点/链路变量表 + IP 规划 + include 收集 + 语义端点解析
import type { GenerationContext } from '../core/IGenElement';
import type { LinkElement } from '../core/model/LinkElement';
import type { LinkConfig, NodeConfig, FlowConfig, ValidationIssue } from '../core/types';
import type { FlowIndex } from '../core/runtimeModel';
import { DEFAULT_SERVER_PORT, type NodeElement, resolveTransport } from '../core/model/NodeElement';
import { formatIpv4, hostOffsetOf, isAssignableHost, makeIpv4, parseIpv4, subnetBaseOf } from '../core/ip';
// cppLiteral 同时供本文件内使用（nodeName）与对外转出，故既 import 又 re-export
import { cppLiteral } from '../core/cppText';

export interface Catalog {
  /** 需要读节点上的 apps（供 serverPort 解析），故取元素本身而非仅 id */
  nodes: NodeElement[];
  links: LinkElement[];
}

export interface IpPlanEntry {
  linkId: string;
  /**
   * 该链路所在 /30 网段的基址（按掩码对齐）。
   * Ipv4AddressHelper::SetBase 里有 `NS_ASSERT((m_network & ~m_mask) == 0)`，
   * 传非对齐的地址会直接 assert 崩，故这里只暴露对齐后的网络号。
   */
  base: string;
  /** 端点有序地址，顺序与链路 (nodeA, nodeB) 一致 */
  ips: [string, string];
  /**
   * 设备容器里端点的 Add 顺序。
   *
   * Assign 是按 NewAddress() 的**升序**依次吐 base+1、base+2 的（/30 下 m_max=2），
   * 且 Ipv4InterfaceContainer 并没有 SetAddress 这种「先分配再改写」的接口，
   * 所以「哪一端拿到哪个地址」只能靠调换 Add 顺序实现，不能靠指定地址。
   */
  deviceOrder: [string, string];
  /** 网段由某端节点的自定义 IP 推导而来（而非 10.<n>.0.0 自动递增） */
  custom: boolean;
}

/**
 * 第 k 个自动规划网段基址（k 从 1 起）：10.<k>.0.0/30。
 * k 超过 254 时进位到第三段，避免拼出 10.256.0.0 这种非法地址。
 */
function autoSubnetBase(k: number): number {
  if (k <= 254) return makeIpv4(10, k, 0, 0);
  const a = Math.floor((k - 255) / 254) + 1;
  const b = ((k - 255) % 254) + 1;
  return makeIpv4(10, a, b, 0);
}

/**
 * 链路 IP 规划。
 *
 * 默认每条链路独占一个 /30 网段（10.<n>.0.0），网段号自 1 递增。
 * 若节点在其「首条链路」上声明了 ip（见 NodeConfig.ip），则以该地址所在 /30 为网段，
 * 并把两端按各自的目标主机偏移落位——未指定的一端取该网段里剩下的那个偏移。
 *
 * 返回 issues 而非在内部静默兜底：地址类错误在 ns-3 侧要么 assert 崩溃、要么网段不通，
 * 必须在导出前拦住，而这些问题只有算完规划才看得出来。
 */
export function buildIpPlan(
  nodes: NodeConfig[],
  links: LinkConfig[],
): { plan: IpPlanEntry[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const plan: IpPlanEntry[] = [];

  const customIpOf = new Map<string, string>();
  for (const n of nodes) {
    const raw = n.ip?.trim();
    if (raw) customIpOf.set(n.id, raw);
  }

  // 节点的自定义 IP 只作用于它参与的第一条链路：节点属性弹窗只有一个 IP 字段，
  // 而一个节点挂 N 条链路就有 N 个接口地址，多出来的接口仍走自动规划。
  const firstLinkIndex = new Map<string, number>();
  links.forEach((l, i) => {
    for (const id of [l.nodeA, l.nodeB]) if (!firstLinkIndex.has(id)) firstLinkIndex.set(id, i);
  });

  // ---- 第一遍：解析各链路端点上声明的自定义地址 ----
  // 先全部解析完再分配网段，自动规划才能避开被自定义地址占用的网段。
  const declared: { a: number | null; b: number | null }[] = links.map((l, i) => {
    const pick = (nodeId: string): number | null => {
      if (firstLinkIndex.get(nodeId) !== i) return null; // 非该节点的首条链路 → 不认领
      const raw = customIpOf.get(nodeId);
      if (raw === undefined) return null;
      // 格式错误由 NodeElement.validate 统一上报（它对每个节点无条件生效，才不会漏掉没挂链路的节点），
      // 这里只按「未指定」处理，让规划仍能算出一套自洽的地址供预览。
      return parseIpv4(raw);
    };
    return { a: pick(l.nodeA), b: pick(l.nodeB) };
  });

  const takenBases = new Map<number, string>(); // 网段基址 → 占用它的链路 id
  for (let i = 0; i < links.length; i++) {
    const { a, b } = declared[i];
    for (const v of [a, b]) if (v !== null) takenBases.set(subnetBaseOf(v), links[i].id);
  }

  // ---- 第二遍：定量（网段 + 两端地址 + 设备顺序） ----
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const { a, b } = declared[i];
    const anyCustom = a !== null || b !== null;

    let base: number;
    if (anyCustom) {
      base = subnetBaseOf((a ?? b) as number);
    } else {
      // 以「链路序号」为起点找空网段，而不是从头顺序发号：
      // 这样改某条链路的 IP 不会让其余未自定义的链路整体重编号（第 2 条仍拿 10.2.0.0）。
      let k = i + 1;
      let candidate = autoSubnetBase(k);
      while (takenBases.has(candidate)) {
        k += 1;
        candidate = autoSubnetBase(k);
      }
      base = candidate;
    }

    const owner = takenBases.get(base);
    if (owner !== undefined && owner !== l.id) {
      issues.push({
        severity: 'error',
        elementId: l.id,
        field: 'nodeA',
        message: `链路 ${l.id} 与链路 ${owner} 落在同一 /30 网段 ${formatIpv4(base)}，一个 /30 只够一条点对点链路的两端使用`,
      });
    }
    takenBases.set(base, l.id);

    // 两端各自声明的目标偏移；落在网络号/广播号上的视为无效（由下面报错，此处按未指定处理）
    const offA = a === null ? null : hostOffsetOf(a);
    const offB = b === null ? null : hostOffsetOf(b);
    const okA = a === null ? false : isAssignableHost(a);
    const okB = b === null ? false : isAssignableHost(b);

    const complainBadOffset = (nodeId: string, v: number, raw: string) => {
      issues.push({
        severity: 'error',
        elementId: nodeId,
        field: 'ip',
        message:
          `节点 ${nodeId} 的 IP ${raw} 是 ${formatIpv4(base)}/30 的` +
          `${hostOffsetOf(v) === 0 ? '网络号' : '广播号'}，不能分配给接口；` +
          `可用地址是 ${formatIpv4(base + 1)} 或 ${formatIpv4(base + 2)}`,
      });
    };
    if (a !== null && !okA) complainBadOffset(l.nodeA, a, customIpOf.get(l.nodeA) as string);
    if (b !== null && !okB) complainBadOffset(l.nodeB, b, customIpOf.get(l.nodeB) as string);

    if (a !== null && b !== null && subnetBaseOf(a) !== subnetBaseOf(b)) {
      issues.push({
        severity: 'error',
        elementId: l.id,
        field: 'nodeB',
        message: `链路 ${l.id} 两端 IP 不在同一 /30 网段（${formatIpv4(a)} / ${formatIpv4(b)}），二层虽通但三层无法互通`,
      });
    }

    const okBoth = okA && okB && subnetBaseOf(a as number) === subnetBaseOf(b as number);
    let useA: number;
    let useB: number;
    if (okBoth && offA !== offB) {
      useA = offA as number;
      useB = offB as number;
    } else if (okBoth) {
      // 两端指定了同一偏移：/30 里不可能都给，第二个退到剩下的那个（上面会报错阻断导出）
      issues.push({
        severity: 'error',
        elementId: l.id,
        field: 'nodeB',
        message: `链路 ${l.id} 两端 IP 相同偏移（${formatIpv4(a as number)} / ${formatIpv4(b as number)}），同一 /30 内地址必须互异`,
      });
      useA = offA as number;
      useB = useA === 1 ? 2 : 1;
    } else if (okA) {
      useA = offA as number;
      useB = useA === 1 ? 2 : 1;
    } else if (okB) {
      useB = offB as number;
      useA = useB === 1 ? 2 : 1;
    } else {
      useA = 1;
      useB = 2;
    }

    plan.push({
      linkId: l.id,
      base: formatIpv4(base),
      ips: [formatIpv4(base + useA), formatIpv4(base + useB)],
      // Assign 只能升序分配，故偏移小的必须排在设备容器前面
      deviceOrder: useA < useB ? [l.nodeA, l.nodeB] : [l.nodeB, l.nodeA],
      custom: anyCustom,
    });
  }

  return { plan, issues };
}

/**
 * 节点 → 首个可达 IPv4。顺序与 buildIpPlan 的「认领首条链路」一致，
 * 保证 ctx.nodeIpv4 报出的地址与产物里实际分配的地址是同一个。
 */
export function buildNodeIpMap(links: LinkConfig[], plan: IpPlanEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of plan) {
    const link = links.find((l) => l.id === entry.linkId);
    if (!link) continue;
    const pairs: [string, string][] = [
      [link.nodeA, entry.ips[0]],
      [link.nodeB, entry.ips[1]],
    ];
    for (const [nodeId, ip] of pairs) if (!map.has(nodeId)) map.set(nodeId, ip);
  }
  return map;
}

/**
 * 便捷查询：某节点在其首条链路上被规划到的地址。
 * 传入 nodesWithoutCustom 可算出「若该节点不指定 IP 会拿到什么」，供 UI 做占位提示。
 */
export function plannedNodeIps(nodes: NodeConfig[], links: LinkConfig[]): Map<string, string> {
  const { plan } = buildIpPlan(nodes, links);
  return buildNodeIpMap(links, plan);
}

/**
 * 节点 → 该节点首个 SERVER 应用监听的端口。
 * 与 NodeElement.singleAppCode 同源（共用 DEFAULT_SERVER_PORT），业务流据此取目标端口，
 * 避免「服务端听 502、客户端发 9」这类两处各写一套默认值造成的不一致。
 */
export function buildServerPortMap(nodes: NodeElement[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of nodes) {
    const srv = (n.config.apps ?? []).find((a) => a.role === 'SERVER');
    if (srv) map.set(n.id, srv.port ?? DEFAULT_SERVER_PORT);
  }
  return map;
}

/** 节点 → 首个 SERVER 应用的传输承载（UDP / TCP）。与 buildServerPortMap 取同一个 SERVER，保证服务端/客户端承载随动 */
export function buildServerTransportMap(nodes: NodeElement[]): Map<string, 'UDP' | 'TCP'> {
  const map = new Map<string, 'UDP' | 'TCP'>();
  for (const n of nodes) {
    const srv = (n.config.apps ?? []).find((a) => a.role === 'SERVER');
    if (srv) map.set(n.id, resolveTransport(srv.transport, srv.protocol) ?? 'UDP');
  }
  return map;
}

/**
 * 流端点索引：给平台侧解析器用（见 core/flowIndex.ts）。
 *
 * **与生成产物时用的是同一份 IP 规划**（buildIpPlan），
 * 所以"10.1.0.2 是哪台机"不是猜的，而是与产物里 Ipv4AddressHelper 实际分配的那个地址同源。
 * 一旦这里换算法而 buildIpPlan 不换，平台就会把曲线绑到错误的节点上 —— 且不会报错。
 *
 * 必须取**每条链路两端**的地址，而不是每节点只取一个（plannedNodeIps 那种）：
 * 一个节点挂 N 条链路就有 N 个接口地址，对端访问它时用的是**那条链路上的**地址。
 * 例如 h2 同时在 l1、l2 上，h3 经 l2 发往 h2 时目的地址是 l2 那侧 —— 只记 l1 的地址就认不出来，
 * 表现是"从 h3 到 h2 的曲线绑不上 h2"。
 */
export function buildFlowIndex(project: {
  nodes: NodeConfig[];
  links: LinkConfig[];
  flows: FlowConfig[];
}): FlowIndex {
  const nodes = project.nodes ?? [];
  const links = project.links ?? [];
  const { plan } = buildIpPlan(nodes, links);
  const nodeByIp: Record<string, string> = {};
  for (const entry of plan) {
    const link = links.find((l) => l.id === entry.linkId);
    if (!link) continue;
    // entry.ips 的顺序与链路 (nodeA, nodeB) 一致（见 IpPlanEntry.ips 的说明）
    nodeByIp[entry.ips[0]] = link.nodeA;
    nodeByIp[entry.ips[1]] = link.nodeB;
  }
  return {
    nodeByIp,
    flows: (project.flows ?? []).map((f) => ({ id: f.id, src: f.src, dst: f.dst })),
  };
}

/**
 * C++ 字符串字面量转义（**单一来源**在 core/cppText.ts）。
 *
 * 这里只做转出，不再自行实现：产物里节点名、tap 名、遥测消息都要拼进 C++ 字面量，
 * 各写一份必然分叉。理由与规则见 core/cppText.ts。
 */
export { cppLiteral } from '../core/cppText';

/**
 * 节点 → `Names::Add` 用的注册名（**工程内唯一**）。
 *
 * ns-3 的 `Names::Add` 对重名走 `NS_ABORT_MSG_UNLESS(result, "Names::Add(): Error adding name …")`，
 * 即**直接终止进程**；而 UI 只保证节点 id 唯一、不保证 name 唯一。
 * 若两个节点同名，产物会「编译通过、运行时刚建完节点就崩」——比编译错误更难排查。
 * 故在此统一去重：同名者的第 2 个起加 `#2`、`#3`…，保证「一个名字只注册一次」。
 */
export function buildNodeNameMap(nodes: NodeConfig[]): Map<string, string> {
  const used = new Map<string, number>();
  const names = new Map<string, string>();
  for (const n of nodes) {
    const base = n.name?.trim() || n.id;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    names.set(n.id, seen === 1 ? base : `${base}#${seen}`);
  }
  return names;
}

/** 由 Builder 在进程启动时登记一套变量表，元素 toCode 经此获取宿主变量名 */
export function makeContext(
  catalog: Catalog,
  opts: { hilEnabled?: boolean; stopSeconds?: number; telemetryPeriodMs?: number } = {},
): { ctx: GenerationContext; includes: Set<string>; ipPlan: IpPlanEntry[]; ipIssues: ValidationIssue[] } {
  const nodeVars = new Map<string, string>();
  for (const n of catalog.nodes) nodeVars.set(n.id, `n_${n.id}`);
  const linkVars = new Map<string, string>();
  for (const l of catalog.links) linkVars.set(l.id, `link_${l.id}`);
  // 节点显示名（工程内唯一 + 已转义）。与 nodeVars 同层登记：元素只管取用，不自行拼名字。
  const nodeNames = buildNodeNameMap(catalog.nodes.map((n) => n.config));

  const { plan: ipPlan, issues: ipIssues } = buildIpPlan(
    catalog.nodes.map((n) => n.config),
    catalog.links.map((l) => l.config),
  );
  const nodeIp = buildNodeIpMap(
    catalog.links.map((l) => l.config),
    ipPlan,
  );
  const serverPorts = buildServerPortMap(catalog.nodes);
  const serverTransports = buildServerTransportMap(catalog.nodes);
  const linkOrders = new Map<string, [string, string]>();
  for (const e of ipPlan) linkOrders.set(e.linkId, e.deviceOrder);

  // 节点 → 可被 TapBridge 桥接的设备引用。只认 CSMA：ns-3.38 里 CsmaNetDevice::SupportsSendFrom()
  // 返回 true，PointToPointNetDevice 返回 false，桥 p2p 设备会在装载期 NS_FATAL_ERROR 直接 abort。
  // 用「设备容器 + 下标」精确定位（p2p/csma 都是一次 Install 产出的单容器，下标即 Add 顺序），
  // 避免 Node::GetDevice(0) 取到与链路类型无关的"先装那块"。节点挂多条 CSMA 链路时取首条。
  const bridgeDevices = new Map<string, string>();
  for (const l of catalog.links) {
    if (l.config.kind !== 'csma') continue;
    const order = linkOrders.get(l.config.id) ?? [l.config.nodeA, l.config.nodeB];
    for (const nodeId of [l.config.nodeA, l.config.nodeB]) {
      if (bridgeDevices.has(nodeId)) continue;
      const idx = order.indexOf(nodeId);
      if (idx < 0) continue;
      bridgeDevices.set(nodeId, `dev_${l.config.id}.Get(${idx})`);
    }
  }

  const includes = new Set<string>();
  const ctx: GenerationContext = {
    nodeVar: (id) => nodeVars.get(id) ?? `n_${id}`,
    nodeName: (id) => cppLiteral(nodeNames.get(id) ?? id),
    linkVar: (id) => linkVars.get(id) ?? null,
    addInclude: (h) => {
      includes.add(h);
    },
    resolveEndpoint: (endpoint) => (nodeVars.has(endpoint) ? endpoint : ''),
    nodeIpv4: (id) => nodeIp.get(id) ?? null,
    linkNodeOrder: (id) => linkOrders.get(id) ?? null,
    bridgeDeviceRef: (id) => bridgeDevices.get(id) ?? null,
    links: () => catalog.links.map((l) => ({ nodeA: l.config.nodeA, nodeB: l.config.nodeB })),
    serverPort: (id) => serverPorts.get(id) ?? null,
    serverTransport: (id) => serverTransports.get(id) ?? 'UDP',
    stopSeconds: opts.stopSeconds ?? 10,
    hilEnabled: Boolean(opts.hilEnabled),
    telemetryPeriodMs: opts.telemetryPeriodMs ?? 1000,
  };
  return { ctx, includes, ipPlan, ipIssues };
}
