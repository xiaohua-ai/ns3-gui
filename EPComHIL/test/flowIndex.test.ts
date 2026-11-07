// 流端点索引回归：守的是「KPI 曲线能不能确定地绑回工程对象」。
//
// 由来（实机踩出来的）：产物里 `flow=<n>` 是 ns-3 FlowMonitor 按**首包先后**自己发的号，
// 与工程 flows 数组顺序没有契约；而工程（内置案例「P2P主从UDP」就是）常常 flows 恒为空。
// 于是「把组件绑定到某台机/某条流」时永远匹配不上 —— 默认 whole 绑定看着有数据，
// 一旦想按对象看就空白，且不报错。修法：产物报出流的五元组，平台按 IP 还原节点。
import { describe, expect, it } from 'vitest';
import { parseEndpoint, resolveFlowTarget } from '../src/core/flowIndex';
import type { FlowIndex, CommEvent, RuntimeBinding } from '../src/core/runtimeModel';
import { matchesBinding } from '../src/core/runtimeModel';
import { parseSimOutput } from '../src/core/simOutput';
import { buildFlowIndex } from '../src/generator/context';

/** 内置案例「P2P主从UDP」的形状：两台主机 + 一条 p2p，flows 为空 */
const CASE_INDEX: FlowIndex = {
  nodeByIp: { '10.1.0.1': '1', '10.1.0.2': '2' },
  flows: [],
};

/** 工程显式定义了 flows 的形状 */
const FLOW_INDEX: FlowIndex = {
  nodeByIp: { '10.1.0.1': 'h1', '10.1.0.2': 'h2' },
  flows: [{ id: 'f1', src: 'h1', dst: 'h2' }],
};

describe('端点解析', () => {
  it('解析 IP:port；畸形输入一律返回 null（宁可不绑定也不绑错）', () => {
    expect(parseEndpoint('10.1.0.2:502')).toEqual({ ip: '10.1.0.2', port: 502 });
    expect(parseEndpoint('0.0.0.0:0')).toEqual({ ip: '0.0.0.0', port: 0 });
    for (const bad of ['', undefined, '10.1.0.2', ':502', '10.1.0.2:', 'abc:1', '10.1.0.2:x', '10.1.0.300:1']) {
      expect(parseEndpoint(bad)).toBeNull();
    }
  });
});

describe('端点 → 绑定对象', () => {
  it('两端都认识时给出收发节点；工程无 flows 也能绑到节点（内置案例的情形）', () => {
    const t = resolveFlowTarget(CASE_INDEX, '10.1.0.1:49153', '10.1.0.2:502');
    expect(t).toEqual({ nodeId: '1', peerNodeId: '2', flowId: undefined });
  });

  it('工程显式定义了 flows 时额外绑到业务流（否则「按流查看」永远没得选）', () => {
    expect(resolveFlowTarget(FLOW_INDEX, '10.1.0.1:49153', '10.1.0.2:502')).toEqual({
      nodeId: 'h1',
      peerNodeId: 'h2',
      flowId: 'f1',
    });
  });

  it('只认得目的端时，仍把它报成 peerNodeId（服务端视图不能恒空）', () => {
    expect(resolveFlowTarget(CASE_INDEX, '192.168.9.9:1234', '10.1.0.2:502')).toEqual({
      peerNodeId: '2',
    });
  });

  it('两端 IP 都不认识时返回 null → 调用方不打 target（陌生流量不画到自己头上）', () => {
    expect(resolveFlowTarget(CASE_INDEX, '192.168.9.9:1234', '192.168.9.10:80')).toBeNull();
  });

  it('没有索引（未传）时返回 null，不猜', () => {
    expect(resolveFlowTarget(undefined, '10.1.0.1:1', '10.1.0.2:2')).toBeNull();
  });

  it('同一对节点间有多条流时**不绑流**，只绑节点（五元组里没有端口，分不清是哪条）', () => {
    // FlowConfig 不带端口，而同一对节点间的流目的端口必然相同 → 用端口消歧是假解法。
    // 按本项目一贯的取舍：宁可不绑，也不绑错（绑错比不绑更难发现）。
    const multi: FlowIndex = {
      nodeByIp: { '10.1.0.1': 'h1', '10.1.0.2': 'h2' },
      flows: [
        { id: 'fa', src: 'h1', dst: 'h2' },
        { id: 'fb', src: 'h1', dst: 'h2' },
      ],
    };
    expect(resolveFlowTarget(multi, '10.1.0.1:49999', '10.1.0.2:102')).toEqual({
      nodeId: 'h1',
      peerNodeId: 'h2',
      flowId: undefined,
    });
  });

  it('反向的流不误配：只有 src→dst 方向对上才算', () => {
    const reverse: FlowIndex = {
      nodeByIp: { '10.1.0.1': 'h1', '10.1.0.2': 'h2' },
      flows: [{ id: 'fb', src: 'h2', dst: 'h1' }],
    };
    // 产物报的是 h1→h2，工程里只有 h2→h1 那条 → 不该绑（方向相反是另一条流）
    expect(resolveFlowTarget(reverse, '10.1.0.1:49999', '10.1.0.2:102')?.flowId).toBeUndefined();
  });
});

describe('节点绑定命中流的任一端', () => {
  const ev = (target: CommEvent['target']): CommEvent => ({
    kind: 'comm',
    id: 1,
    timestampUs: 1000,
    target,
  });

  it('绑源端命中、绑目的端也命中（KPI 是端到端量，两端视图都该看得到）', () => {
    const e = ev({ nodeId: '1', peerNodeId: '2' });
    const b = (target: string): RuntimeBinding => ({ scope: 'node', target });
    expect(matchesBinding(e, b('1'))).toBe(true);
    expect(matchesBinding(e, b('2'))).toBe(true);
    expect(matchesBinding(e, b('3'))).toBe(false);
  });

  it('只有 peerNodeId 时，绑该端同样命中', () => {
    expect(matchesBinding(ev({ peerNodeId: '2' }), { scope: 'node', target: '2' })).toBe(true);
  });
});

describe('解析器接上端点索引（端到端）', () => {
  it('KPI 行带端点时按端点绑定，不再依赖流号顺序', () => {
    const line =
      '[EPC-KPI] t=3000000 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 tx=1 rx=1 lost=0 pdr=1 delay=143 jitter=0';
    const [e] = parseSimOutput(line, { flowIndex: CASE_INDEX }) as CommEvent[];
    expect(e.target).toEqual({ nodeId: '1', peerNodeId: '2', flowId: undefined });
    expect(e.txPackets).toBe(1);
    expect(e.delayMeanUs).toBe(143);

    // 故意把工程业务流顺序打乱：按序回映会得到 f2，按端点必须是 f1（正确）
    const [fromEndpoint] = parseSimOutput(line, {
      flowIndex: FLOW_INDEX,
      flowIds: ['fx', 'fy'],
    }) as CommEvent[];
    expect(fromEndpoint.target?.flowId).toBe('f1');
  });

  it('KPI 行无端点字段时退回按流号回映（二层流 / classifier 不可用）', () => {
    const line = '[EPC-KPI] t=1000 flow=1 tx=1 rx=1 lost=0 pdr=1 delay=100 jitter=0';
    const [e] = parseSimOutput(line, { flowIndex: CASE_INDEX, flowIds: ['f1'] }) as CommEvent[];
    expect(e.target).toEqual({ flowId: 'f1' });
  });
});

// 索引由 buildFlowIndex 从 IP 规划算出来；这里守的是「它与产物分配到的地址同源」。
// 不同源不会报错，只会把曲线画到别的机器上 —— 必须用规划本身去核。
describe('buildFlowIndex 与产物 IP 规划同源', () => {
  const node = (id: string, ip?: string) => ({ id, name: id, kind: 'host' as const, ...(ip ? { ip } : {}) });

  it('多接口节点：每条链路的地址都进索引（经第二条链路来的流也认得出接收端）', () => {
    const idx = buildFlowIndex({
      nodes: [node('h1'), node('h2'), node('h3')],
      links: [
        { id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' },
        { id: 'l2', kind: 'p2p', nodeA: 'h3', nodeB: 'h2' },
      ],
      flows: [],
    });
    // l1 → [10.1.0.1(h1), 10.1.0.2(h2)]；l2 → [10.2.0.1(h3), 10.2.0.2(h2)]
    expect(idx.nodeByIp).toMatchObject({
      '10.1.0.1': 'h1',
      '10.1.0.2': 'h2',
      '10.2.0.1': 'h3',
      '10.2.0.2': 'h2', // h2 的第二个接口地址 —— 只记首个链路地址就会漏掉它
    });
    // 经第二条链路来的流：目的端仍认得出来
    expect(resolveFlowTarget(idx, '10.2.0.1:49153', '10.2.0.2:502')).toEqual({
      nodeId: 'h3',
      peerNodeId: 'h2',
      flowId: undefined,
    });
  });

  it('节点自定义 IP 被采纳（与 buildIpPlan 同一份规划）', () => {
    const idx = buildFlowIndex({
      nodes: [node('a', '10.9.0.2'), node('c')],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'a', nodeB: 'c' }],
      flows: [],
    });
    // 自定义端占偏移 2 → a=10.9.0.2，另一端自动落偏移 1 → c=10.9.0.1
    expect(idx.nodeByIp).toMatchObject({ '10.9.0.2': 'a', '10.9.0.1': 'c' });
  });

  it('工程显式定义的流带进索引，可绑到「业务流」对象', () => {
    const idx = buildFlowIndex({
      nodes: [node('h1'), node('h2')],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' }],
      flows: [{ id: 'f1', type: 'CBR', src: 'h1', dst: 'h2', interval: 1, payloadSize: 512 }],
    });
    expect(resolveFlowTarget(idx, '10.1.0.1:49153', '10.1.0.2:502')?.flowId).toBe('f1');
  });
});
