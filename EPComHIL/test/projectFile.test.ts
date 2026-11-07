// 工程文件读写与载入回归。
// 重点验证两件事：
//   1. 落盘的工程能否原样读回来（序列化 ↔ 解析同构，避免"写出去的和读回来的不一样"）；
//   2. 载入后的工程能否直接喂给生成器，且发号器不撞号。
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import {
  parseProject,
  serializeProject,
  suggestFileName,
  normalizeProject,
  PROJECT_FILE_VERSION,
  PROJECT_FILE_EXT,
} from '../src/core/projectFile';
import { DEFAULT_RUN } from '../src/core/types';
import type { ProjectConfig } from '../src/core/types';
import { generate } from '../src/generator/generator';
import { useWorkbench } from '../src/renderer/stores/workbench';

const sampleText = () => readFileSync(join(process.cwd(), 'samples/demo_scenario.json'), 'utf8');

function richConfig(): ProjectConfig {
  return {
    projectName: 'round_trip',
    version: '0.0.0',
    createdAt: '2026-09-17T00:00:00.000Z',
    nodes: [
      {
        id: '1',
        name: 'IED_1',
        kind: 'ied',
        x: 60.4,
        y: 60.6,
        apps: [
          { id: 'a1', role: 'SERVER', protocol: 'MMS', port: 502 },
          { id: 'a2', role: 'CLIENT', protocol: 'MMS', port: 502, peer: '2', interval: 1, payloadSize: 256 },
        ],
      },
      { id: '2', name: '', kind: 'switch', physical: true, physicalId: 'dev:sw-01', mac: '00:aa:bb:cc:dd:ee' },
    ],
    links: [{ id: 'l1', kind: 'csma', nodeA: '1', nodeB: '2', dataRate: '100Mbps' }],
    protocols: [
      { id: 'p1', type: 'GOOSE', layer: 'L2', nodeId: '1', appId: 4097, vlanId: 2 },
      { id: 'p2', type: 'MMS', layer: 'L3', nodeId: '2', localPort: 102 },
    ],
    flows: [{ id: 'f1', type: 'PERIODIC', src: '1', dst: '2', interval: 2, payloadSize: 256 }],
    faults: [{ id: 'fa1', linkId: 'l1', startTime: 3, endTime: 6, kind: 'error-model', rate: 0.01 }],
    halfPhysical: { taps: [{ tapName: 'tap0', nodeId: '2', mac: '00:11:22:33:44:55' }], physicalNic: 'eth0' },
    // 运行设置（模式唯一来源）与 HIL 引擎参数分家：mode/clockSource 归 run，hil 只留引擎参数
    run: { ...DEFAULT_RUN, mode: 'HIL', clockSource: 'PTP' },
    hil: { timestepUs: 50 },
  };
}

describe('工程文件：序列化与解析', () => {
  it('序列化 → 解析 往返同构（字段顺序固定、可选字段折叠、坐标取整）', () => {
    const cfg = richConfig();
    const round = parseProject(serializeProject(cfg));
    expect(round.ok).toBe(true);
    if (!round.ok) return;

    expect(round.project).toEqual(normalizeProject(cfg));
    // 版本一律写当前版本；坐标取整；空 name 回落成 id
    expect(round.project.version).toBe(PROJECT_FILE_VERSION);
    expect(round.project.nodes[0]).toMatchObject({ x: 60, y: 61 });
    expect(round.project.nodes[1].name).toBe('2');
    // 二次序列化必须与一次完全一致（幂等，便于人工 diff）
    expect(serializeProject(round.project)).toBe(serializeProject(cfg));
  });

  it('真实示例工况 samples/demo_scenario.json 可解析，且解析结果能直接喂给生成器', () => {
    const r = parseProject(sampleText());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.project.nodes).toHaveLength(4);
    expect(r.project.links).toHaveLength(3);
    expect(r.project.protocols).toHaveLength(2);
    expect(r.project.flows).toHaveLength(2);
    expect(r.project.faults).toHaveLength(1);

    // 这是关键：读回来的工程必须能原样进入生成链路
    const g = generate(r.project);
    expect(g.ok).toBe(true);
    expect(g.cpp).toContain('Ptr<Node> n_ied1');
    expect(g.cpp).toContain('Names::Add("RTU_1", n_rtu1);');
  });

  it('缺省字段被补齐：无 name 用 id、缺失数组补空、无 hil/halfPhysical 保持 undefined', () => {
    const r = parseProject(JSON.stringify({ projectName: 'bare', nodes: [{ id: '1', kind: 'ied' }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.nodes[0].name).toBe('1');
    expect(r.project.links).toEqual([]);
    expect(r.project.protocols).toEqual([]);
    expect(r.project.flows).toEqual([]);
    expect(r.project.faults).toEqual([]);
    expect(r.project.halfPhysical).toBeUndefined();
    expect(r.project.hil).toBeUndefined();
  });

  it('运行设置是模式的唯一来源：缺 run 段补出厂默认，旧格式的 hil.mode 会被迁移过来', () => {
    // 新工程：没有 run 段 → 出厂默认
    const bare = parseProject(JSON.stringify({ projectName: 'bare', nodes: [{ id: '1', kind: 'ied' }] }));
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.project.run).toEqual(DEFAULT_RUN);

    // 旧工程（仓库里的 scenarios/*.tc 与 samples/*.json 都是这个形态）：
    // 模式/时钟源存在 hil 段里 —— 必须迁到 run，否则"看到的模式"与"跑的模式"会是两个
    const legacy = parseProject(JSON.stringify({
      projectName: 'legacy',
      nodes: [{ id: '1', kind: 'ied' }],
      hil: { mode: 'REALTIME', clockSource: 'PTP', timestepUs: 20 },
    }));
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacy.project.run.mode).toBe('REALTIME');
    expect(legacy.project.run.clockSource).toBe('PTP');
    // hil 段只剩引擎参数（不再重复存一份 mode/clockSource）
    expect(legacy.project.hil).toEqual({ timestepUs: 20 });
  });

  it('三值模式都能原样存回：REALTIME 不得被静默吞掉（曾因白名单漏了它而回落成 OFFLINE）', () => {
    for (const mode of ['OFFLINE', 'REALTIME', 'HIL'] as const) {
      const back = parseProject(serializeProject({ ...richConfig(), run: { ...DEFAULT_RUN, mode } }));
      expect(back.ok, mode).toBe(true);
      if (!back.ok) return;
      expect(back.project.run.mode, mode).toBe(mode);
    }
  });

  it('结构性错误逐条上报并整体拒绝，不做"猜"', () => {
    const bad = JSON.stringify({
      nodes: [
        { id: 'a', kind: 'not-a-kind' },
        { kind: 'ied' },
        { id: 'c', kind: 'ied' },
      ],
      links: [{ id: 'l1', kind: 'wifi', nodeA: 'a', nodeB: 'c' }],
      protocols: [{ id: 'p1', type: 'MMS', layer: 'L9', nodeId: 'c' }],
      flows: [{ id: 'f1', type: 'PERIODIC', src: 'a' }],
      faults: [{ id: 'fa1', startTime: 1, endTime: 2, kind: 'drop' }],
      halfPhysical: 'oops',
    });
    const r = parseProject(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;

    const joined = r.errors.join('\n');
    expect(joined).toContain('类型非法: not-a-kind');
    expect(joined).toContain('nodes[1] 缺少 id');
    expect(joined).toContain('仅支持 p2p / csma');
    expect(joined).toContain('承载层非法: L9');
    expect(joined).toContain('缺少端点 src / dst');
    expect(joined).toContain('必须至少指定 linkId 或 nodeId');
    expect(joined).toContain('halfPhysical 不是对象');
    // 合法的那条节点仍被解析出来，但整体因错误被拒绝
    expect(r.errors.length).toBeGreaterThanOrEqual(7);
  });

  it('非法 JSON 与非对象根节点被拒绝', () => {
    expect(parseProject('{ not json').ok).toBe(false);
    const arr = parseProject('[1,2,3]');
    expect(arr.ok).toBe(false);
    if (!arr.ok) expect(arr.errors[0]).toContain('根节点必须是对象');
  });

  it('版本不一致只告警不阻断', () => {
    const r = parseProject(JSON.stringify({ projectName: 'x', version: '9.9.9', nodes: [] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('9.9.9'))).toBe(true);
  });

  it('suggestFileName 剔除路径非法字符并带上扩展名', () => {
    expect(suggestFileName('demo_scenario')).toBe(`demo_scenario${PROJECT_FILE_EXT}`);
    expect(suggestFileName('a/b:c*d?e"f<g>h|i')).toBe(`a_b_c_d_e_f_g_h_i${PROJECT_FILE_EXT}`);
    expect(suggestFileName('')).toBe(`untitled${PROJECT_FILE_EXT}`);
    expect(suggestFileName('带 空格 的名字')).toBe(`带_空格_的名字${PROJECT_FILE_EXT}`);
  });
});

describe('载入工程后的发号行为', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('载入示例工况后新建节点不撞号，链路/协议序号从 1 重排并跳过已占用', () => {
    const store = useWorkbench();
    const r = parseProject(sampleText());
    if (!r.ok) throw new Error('示例工况解析失败');
    store.loadProject(r.project);

    // 示例工况用的是 ied1/switch1 这种老式 id，没有纯数字 id → 下一个节点号从 1 开始
    expect(store.nextNodeId()).toBe('1');
    // 链路计数归零后仍要跳过已占用的 l1/l2/l3
    expect(store.nextId('l')).toBe('l4');
    // 协议同理：p1/p2 已占用
    expect(store.nextId('p')).toBe('p3');
    // 业务流是 f1/f2 → f3
    expect(store.nextId('f')).toBe('f3');

    // 默认名按同类型已有名字续号：示例里有 RTU_1，下一个应是 RTU_2
    expect(store.nextNodeName('rtu')).toBe('RTU_2');
    // 示例里 pv 的名字是「光伏逆变器_1」，与短标签「光伏_1」不同型，故仍是 1 号
    expect(store.nextNodeName('pv')).toBe('光伏_1');
  });

  it('载入后新建节点+链路+协议，工程内 id 全局唯一（不再与文件里旧的撞）', () => {
    const store = useWorkbench();
    const r = parseProject(sampleText());
    if (!r.ok) throw new Error('示例工况解析失败');
    store.loadProject(r.project);

    const nid = store.nextNodeId();
    store.addNode({ id: nid, name: store.nextNodeName('ied'), kind: 'ied' });
    const lid = store.nextId('l');
    store.addLink({ id: lid, kind: 'p2p', nodeA: nid, nodeB: 'switch1' });
    const pid = store.nextId('p');
    store.addProtocol({ id: pid, type: 'MMS', layer: 'L3', nodeId: nid, localPort: 2000 });

    const all = [
      ...store.project.nodes.map((n) => n.id),
      ...store.project.links.map((l) => l.id),
      ...store.project.protocols.map((p) => p.id),
      ...store.project.flows.map((f) => f.id),
      ...store.project.faults.map((f) => f.id),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('newProject 清空工程并重置发号', () => {
    const store = useWorkbench();
    store.addNode({ id: '1', name: 'IED_1', kind: 'ied' });
    store.addLink({ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '1' });
    store.newProject('fresh');

    expect(store.project.projectName).toBe('fresh');
    expect(store.project.nodes).toEqual([]);
    expect(store.nextNodeId()).toBe('1');
    expect(store.nextId('l')).toBe('l1');
  });
});
