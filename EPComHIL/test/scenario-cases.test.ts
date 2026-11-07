// 自带案例库健全性：每个内置用例的 case.tc 必须可解析；批1 落地的 CSMA 案例必须能生成「真实 UDP 流 + FlowMonitor 统计」。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject } from '../src/core/projectFile';
import { generate } from '../src/generator/generator';

const ALL_CASES = [
  'P2P主从UDP',
  'P2P串行接入',
  'CSMA三节点',
  'CSMA广播',
  'CSMA组播',
  'CSMA单子网',
  'GOOSE组播变电站',
  '微电网分布式能源通信',
  '变电站半实物接入',
  '实时响应与时钟同步',
];

/** 批1 范畴：app/flow 必须落地真实 UdpClient 载荷，且勾选的 stats 要生成 FlowMonitor 统计 */
const CSMA_REAL_CASES = ['CSMA广播', 'CSMA组播', 'CSMA单子网'];

function loadChecked(folder: string) {
  const text = readFileSync(join(process.cwd(), 'scenarios', folder, 'case.tc'), 'utf8');
  const parsed = parseProject(text);
  if (!parsed.ok) throw new Error(`${folder} 解析失败: ${parsed.errors.join('; ')}`);
  return parsed.project;
}

describe('内置用例可解析', () => {
  for (const folder of ALL_CASES) {
    it(`${folder} 的 case.tc 可解析`, () => {
      const p = loadChecked(folder);
      expect(p.projectName.length).toBeGreaterThan(0);
    });
  }
});

describe('批1 CSMA 案例生成真实流量与统计', () => {
  for (const folder of CSMA_REAL_CASES) {
    const p = loadChecked(folder);
    const r = generate(p, {
      mode: p.run.mode,
      clockSource: p.run.clockSource,
      precise: false,
      stopSeconds: 10,
    });
    it(`${folder}: 校验通过`, () => {
      expect(r.ok).toBe(true);
    });
    it(`${folder}: 业务流落地真实 UdpClientHelper`, () => {
      const clients = (p.flows ?? []).length;
      expect(clients).toBeGreaterThan(0);
      expect(r.cpp).toContain('UdpClientHelper');
      // 每个流都生成一笔 Install（不复用注释占位）
      expect(r.cpp.match(/UdpClientHelper/g)?.length).toBeGreaterThanOrEqual(clients);
    });
    it(`${folder}: 勾选的 stats 生成 FlowMonitor 统计段`, () => {
      const hasAnyStats = [...p.nodes, ...p.links].some((x) => (x.stats ?? []).length > 0);
      expect(hasAnyStats).toBe(true);
      expect(r.cpp).toContain('FlowMonitorHelper');
    });
  }
});

describe('补 SERVER 的 3 案例：目标节点可真实接收', () => {
  for (const folder of ['GOOSE组播变电站', '微电网分布式能源通信', '变电站半实物接入']) {
    const p = loadChecked(folder);
    const r = generate(p, { mode: p.run.mode, clockSource: p.run.clockSource, precise: false, stopSeconds: 10 });
    it(`${folder}: 生成 SERVER 应用接收段（UDP 走 ServerRxLog / TCP 走 PacketSink）`, () => {
      // Modbus/TCP 承载的物理网（微电网：全 SERVER 为 MODBUS_TCP）生成 TCP 服务端 PacketSink，
      // 不生成 ServerRxLog（TCP 是字节流、无 UDP 式来源地址）；其余走 UDP 的应用生成 ServerRxLog。
      const expectTcp = folder === '微电网分布式能源通信';
      if (expectTcp) {
        expect(r.cpp).toContain('PacketSinkHelper');
        expect(r.cpp).not.toContain('static void ServerRxLog');
      } else {
        expect(r.cpp).toContain('static void ServerRxLog');
      }
    });
    it(`${folder}: 业务流端口非占位兜底（命中 SERVER 端口，无 FALLBACK 端口 9 裸用）`, () => {
      // 每个目标节点都有 SERVER，则 FlowElement 会解析到真实端口（非占位端口 9）
      const dsts = new Set(p.flows.map((f: { dst: string }) => f.dst));
      const servers = p.nodes.filter((n: { id: string }) => dsts.has(n.id) && (n.apps ?? []).some((a: { role: string }) => a.role === 'SERVER'));
      expect(servers.length).toBe(dsts.size);
      // 承载按协议分：UDP 标 UdpServer:port，TCP 标 TcpServer:port —— 都不裸挥占位端口 9
      expect(r.cpp).toContain(folder === '微电网分布式能源通信' ? 'TcpServer:502' : 'UdpServer:');
    });
    it(`${folder}: 每个业务流目标都有对应 SERVER 应用`, () => {
      for (const f of p.flows) {
        const target = p.nodes.find((n: { id: string }) => n.id === f.dst);
        expect(target, `${folder} 业务流目标 ${f.dst} 存在`).toBeDefined();
        expect((target.apps ?? []).some((a: { role: string }) => a.role === 'SERVER'), `${f.dst} 有 SERVER`).toBe(true);
      }
    });
  }
});

describe('全案例生成不崩溃', () => {
  for (const folder of ALL_CASES) {
    const p = loadChecked(folder);
    it(`${folder}: generate 产出脚本`, () => {
      const r = generate(p, { mode: p.run.mode, clockSource: p.run.clockSource, precise: false, stopSeconds: 10 });
      expect(typeof r.cpp).toBe('string');
      expect(r.cpp.length).toBeGreaterThan(0);
    });
  }
});