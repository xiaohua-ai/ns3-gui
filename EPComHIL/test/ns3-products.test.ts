// 全分支产物契约回归：确保生成器对每条代表分支都产出「可直接上 ns-3.38 编译」的产物。
//
// 由来：曾只对「P2P + UDP」一条路径做过实机验证，其余分支（TCP 承载 / 多链路 / CSMA 误码 /
// 半实物 / HIL / 重名）从未上过编译器，结果漏掉了 3 个「编译通过、跑起来才错」的缺陷
// （TapBridge 桥 p2p 设备 → 装载期 abort；ErrorUnit 默认 BYTE 使 1% 误包率实为 27.5% PDR；
//  HIL 步进判据把「两次 tick 间隔」当算力消耗 → 从第 3 步必然误报超预算）。
// 本用例把 10 条分支固化为断言，任一条发射逻辑退化都会红。
// 第 10 条（REALTIME）是后补的：`SimMode` 三个取值里它此前从没被单列验证过，
// 而它恰是 Runtime 页「实时运行」按钮在工程模式为 OFFLINE 时的默认去处。
//
// 实机验证记录（ns-3.38 @ Linux 仿真机，root→runuser 降权）：
//   - 9/9 分支编译通过、零告警；
//   - 实跑：p2p_udp / multi_link / dual_flow / csma_error_goose（OFFLINE，stderr 0 行、退出码 0）、
//     hil_mode（HIL，stderr 2 行＝PTP 回退告警 + 引擎就绪，属预期）、
//     hil_half_physical（HIL，本机无 tap0 → 在「运行前置检查」快速失败并给出确切命令，退出码 3）。
//   - KPI 行实测带端点，例：`[EPC-KPI] t=3000000 flow=1 src=10.1.0.1:49153 dst=10.1.0.2:502 proto=17 …`
//   - HIL 实测逐拍到达：`[EPC-HIL]` 十条 tick 墙钟间隔精确 1000ms、`step=1000000` 恒定、`degraded=0`。
//
// 需在 Linux 端复验时，设 EPCOMHIL_EMIT_NS3=1 把产物落盘
// （目录可用 EPCOMHIL_NS3_OUT 覆盖，默认 C:/tmp/ns3-run/products），默认只断言不写盘。
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_RUN } from '../src/core/types';
import type { ProjectConfig } from '../src/core/types';
import { generate } from '../src/generator/generator';

const OUT = process.env.EPCOMHIL_NS3_OUT ?? 'C:/tmp/ns3-run/products';
const EMIT = process.env.EPCOMHIL_EMIT_NS3 === '1';

function base(name: string): ProjectConfig {
  return {
    projectName: name,
    version: '0.1.0',
    createdAt: '2026-09-20T00:00:00.000Z',
    nodes: [],
    links: [],
    protocols: [],
    flows: [],
    faults: [],
    // 运行设置（模式的唯一来源）：每条分支在各 case 里显式给出自己的模式
    run: { ...DEFAULT_RUN },
  };
}

const cases: { name: string; cfg: ProjectConfig; over?: Record<string, unknown> }[] = [
  // 1) 用户原始场景：P2P + UDP Client/Server
  {
    name: 'p2p_udp',
    cfg: {
      ...base('p2p_udp'),
      nodes: [
        { id: 'h1', name: '主机_1', kind: 'host', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h2', port: 502, interval: 1, payloadSize: 512 }] },
        { id: 'h2', name: '主机_2', kind: 'host', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
      ],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2', dataRate: '100Mbps', delay: '100us' }],
    },
  },
  // 2) TCP 承载（Modbus/TCP → PacketSink / OnOff）
  {
    name: 'tcp_modbus',
    cfg: {
      ...base('tcp_modbus'),
      nodes: [
        { id: 'mgcc', name: 'MGCC', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'MODBUS_TCP', peer: 'slave', port: 502, interval: 0.5, payloadSize: 96 }] },
        { id: 'slave', name: 'SLAVE', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'MODBUS_TCP', port: 502 }] },
      ],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'mgcc', nodeB: 'slave' }],
      flows: [{ id: 'f1', type: 'PERIODIC', src: 'mgcc', dst: 'slave', interval: 0.5, payloadSize: 96 }],
    },
  },
  // 3) 多链路 → 触发 Ipv4GlobalRoutingHelper；含自定义 IP
  {
    name: 'multi_link',
    cfg: {
      ...base('multi_link'),
      nodes: [
        { id: 'a', name: 'A', kind: 'ied', ip: '10.9.0.2', apps: [{ id: 's1', role: 'SERVER', protocol: 'MMS', port: 102 }] },
        { id: 'b', name: 'B', kind: 'switch' },
        { id: 'c', name: 'C', kind: 'rtu', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'MMS', peer: 'a', port: 102, interval: 1 }] },
      ],
      links: [
        { id: 'l1', kind: 'p2p', nodeA: 'a', nodeB: 'b' },
        { id: 'l2', kind: 'p2p', nodeA: 'b', nodeB: 'c' },
      ],
    },
  },
  // 4) CSMA + 链路误码 + GOOSE L2 —— 误码单位必须显式锁成 PACKET（库默认是 BYTE）
  {
    name: 'csma_error_goose',
    cfg: {
      ...base('csma_error_goose'),
      nodes: [
        { id: 'ied1', name: 'IED_1', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 102 }] },
        { id: 'ied2', name: 'IED_2', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'ied1', port: 102, interval: 0.2, payloadSize: 128 }] },
      ],
      links: [{ id: 'l1', kind: 'csma', nodeA: 'ied1', nodeB: 'ied2', dataRate: '10Mbps', errorRate: 0.01 }],
      protocols: [{ id: 'p1', type: 'GOOSE', layer: 'L2', nodeId: 'ied1', appId: 0x1001, vlanId: 2 }],
    },
  },
  // 5) 半实物 TapBridge 接入（OFFLINE：半实物段只应是注释）
  {
    name: 'half_physical',
    cfg: {
      ...base('half_physical'),
      nodes: [
        { id: 'ied1', name: 'IED_1', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 102 }] },
        { id: 'rtu1', name: 'RTU_1', kind: 'rtu', physical: true, physicalId: 'dev:rtu-01' },
      ],
      links: [{ id: 'l1', kind: 'csma', nodeA: 'ied1', nodeB: 'rtu1', dataRate: '100Mbps' }],
      halfPhysical: { taps: [{ tapName: 'tap0', nodeId: 'rtu1', mac: '00:11:22:33:44:55' }], physicalNic: 'eth0' },
    },
  },
  // 6) HIL 模式（步进注入段 + 实时仿真器绑定）
  {
    name: 'hil_mode',
    cfg: {
      ...base('hil_mode'),
      nodes: [
        { id: 'h1', name: 'H1', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
        { id: 'h2', name: 'H2', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h1', port: 502, interval: 1, payloadSize: 256 }] },
      ],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' }],
      run: { ...DEFAULT_RUN, mode: 'HIL', clockSource: 'PTP' },
    },
    over: { mode: 'HIL', clockSource: 'PTP', stepMs: 1000, stepBudgetRatio: 0.8, stepDegradeAfter: 3 },
  },
  // 7) 重名 / 引号 / 反斜杠 / 空名 节点（命名去重与 C++ 字面量转义）
  {
    name: 'dup_names',
    cfg: {
      ...base('dup_names'),
      nodes: [
        { id: 'a', name: 'IED', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
        { id: 'b', name: 'IED', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'a', port: 502, interval: 1 }] },
        { id: 'c', name: 'A"B\\C', kind: 'switch' },
        { id: 'd', name: '', kind: 'host' },
      ],
      links: [
        { id: 'l1', kind: 'p2p', nodeA: 'a', nodeB: 'b' },
        { id: 'l2', kind: 'p2p', nodeA: 'b', nodeB: 'c' },
        { id: 'l3', kind: 'p2p', nodeA: 'c', nodeB: 'd' },
      ],
    },
  },
  // 8) HIL + 半实物：TapBridge 的可执行装载段只在 HIL 下落地，这条组合必须单列
  {
    name: 'hil_half_physical',
    cfg: {
      ...base('hil_half_physical'),
      nodes: [
        { id: 'ied1', name: 'IED_1', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 102 }] },
        { id: 'rtu1', name: 'RTU_1', kind: 'rtu', physical: true, physicalId: 'dev:rtu-01', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'ied1', port: 102, interval: 1, payloadSize: 256 }] },
      ],
      links: [{ id: 'l1', kind: 'csma', nodeA: 'ied1', nodeB: 'rtu1', dataRate: '100Mbps' }],
      halfPhysical: { taps: [{ tapName: 'tap0', nodeId: 'rtu1', mac: '00:11:22:33:44:55' }], physicalNic: 'eth0' },
      run: { ...DEFAULT_RUN, mode: 'HIL', clockSource: 'INTERNAL' },
    },
    over: { mode: 'HIL', clockSource: 'INTERNAL', stepMs: 1000, stepBudgetRatio: 0.8, stepDegradeAfter: 3 },
  },
  // 9) 多流 + 多接口节点：h2 同时挂在两条链路上，h1/h3 各自向它发流。
  //    这条单列的理由是「节点有多个 IP」——对端经哪条链路来，目的地址就是那侧的地址；
  //    平台若只记节点的首个链路地址，就会认不出经第二条链路来的流（曲线绑不上接收端）。
  {
    name: 'dual_flow',
    cfg: {
      ...base('dual_flow'),
      nodes: [
        { id: 'h1', name: '主机_1', kind: 'host', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h2', port: 502, interval: 1, payloadSize: 512 }] },
        { id: 'h2', name: '主机_2', kind: 'host', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
        { id: 'h3', name: '主机_3', kind: 'host', apps: [{ id: 'c2', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h2', port: 502, interval: 1, payloadSize: 512 }] },
      ],
      links: [
        { id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2', dataRate: '100Mbps', delay: '100us' },
        { id: 'l2', kind: 'p2p', nodeA: 'h3', nodeB: 'h2', dataRate: '100Mbps', delay: '100us' },
      ],
    },
  },
  // 10) REALTIME 模式（挂钟实时，纯软件）。
  //     单列的理由：`SimMode` 有三个取值，而此前只验过 OFFLINE 与 HIL —— REALTIME 恰恰是
  //     Runtime 页运行按钮在工程运行模式为 REALTIME 时走的那条（按钮与工程模式同源，
  //     见 RuntimeView.runMode），却从没上过编译器。
  //     它与 OFFLINE 的唯一结构差异是那句**无条件**的实时实现绑定；
  //     与 HIL 的差异是「不带保守步进引擎、不消费 --hil、不发 [EPC-HIL] 遥测」。
  {
    name: 'realtime_mode',
    cfg: {
      ...base('realtime_mode'),
      nodes: [
        { id: 'h1', name: 'H1', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
        { id: 'h2', name: 'H2', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'CUSTOM', peer: 'h1', port: 502, interval: 1, payloadSize: 256 }] },
      ],
      links: [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' }],
      run: { ...DEFAULT_RUN, mode: 'REALTIME', clockSource: 'INTERNAL' },
    },
    over: { mode: 'REALTIME', clockSource: 'INTERNAL' },
  },
];

const emitted = new Map<string, string>();
for (const c of cases) {
  const r = generate(c.cfg, c.over as never);
  emitted.set(c.name, r.cpp);
  if (EMIT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/${c.name}.cc`, r.cpp, 'utf8');
  }
}

describe('ns-3 全分支产物契约', () => {
  it('10 条代表分支均产出无错误无告警的产物', () => {
    for (const c of cases) {
      const r = generate(c.cfg, c.over as never);
      expect(r.validation.errors, `${c.name} errors`).toHaveLength(0);
      expect(r.validation.warnings, `${c.name} warnings`).toHaveLength(0);
      expect(r.ok, `${c.name} ok`).toBe(true);
    }
  });

  it('全产物禁用已知会崩/编不过的 API（实机踩出来的漏网区）', () => {
    for (const [name, cpp] of emitted) {
      // ns-3 的 Node 从来没有 SetName（跨版本），命名必须走 Names::Add
      expect(cpp, `${name} 不得出现 ->SetName(`).not.toContain('->SetName(');
      expect(cpp, `${name} 应以 Names::Add 命名节点`).toContain('Names::Add(');
      // Time::As(Unit) 返回 TimeWithUnit（自带单位、无取值接口），取整数须 GetMicroSeconds()
      expect(cpp, `${name} 不得出现 Time::As(`).not.toContain('Time::As(');
      // GetDevice(0) 取的是"先装那块"、与链路类型无关，半实物桥接会桥到 p2p 设备上
      expect(cpp, `${name} 不得出现 GetDevice(0)`).not.toContain('GetDevice(0)');
    }
  });

  it('UDP 逐包打点：RxWithAddresses 三参回调 + GetMicroSeconds()', () => {
    for (const name of ['p2p_udp', 'csma_error_goose', 'half_physical', 'hil_half_physical']) {
      const cpp = emitted.get(name)!;
      expect(cpp, `${name} 应挂 RxWithAddresses`).toContain('TraceConnectWithoutContext("RxWithAddresses"');
      expect(cpp, `${name} 不得挂单参 "Rx"`).not.toContain('TraceConnectWithoutContext("Rx"');
      // 三参 trace：必须收下第三个 to 地址参数，否则 NS_FATAL_ERROR
      expect(cpp, `${name} ServerRxLog 应为三参`).toContain('const Address &from, const Address &to');
      expect(cpp).toContain('Simulator::Now().GetMicroSeconds()');
    }
  });

  it('链路误码：显式锁 ErrorUnit=PACKET（库默认 BYTE 会让 1% 变成每字节 1%）', () => {
    const cpp = emitted.get('csma_error_goose')!;
    expect(cpp).toContain('EnumValue(RateErrorModel::ERROR_UNIT_PACKET)');
    expect(cpp).toContain('dev_l1.Get(1)->SetAttribute("ReceiveErrorModel"');
  });

  it('半实物：TapBridge 只桥 CSMA 设备（带 SupportsSendFrom 兜底），且只在 HIL 下落为可执行', () => {
    const hil = emitted.get('hil_half_physical')!;
    // 用「设备容器 + 下标」精确定位到 CSMA 设备，而非 GetDevice(0)
    expect(hil).toContain('dev_l1.Get(1)');
    expect(hil).toContain('SupportsSendFrom()');
    expect(hil).toContain('"UseBridge"');
    expect(hil).toContain('#include "ns3/tap-bridge-module.h"');
    // 装载段整段收在 if (hil) 内
    expect(hil).toContain('if (hil) {');
    // OFFLINE 不得出现可执行的 TapBridge 装配，只允许注释说明
    const offline = emitted.get('half_physical')!;
    expect(offline).not.toContain('TapBridgeHelper');
    expect(offline).not.toContain('tap-bridge-module.h');
  });

  it('节点命名：工程内去重 + C++ 字面量转义 + 空名回退', () => {
    const cpp = emitted.get('dup_names')!;
    expect(cpp).toContain('Names::Add("IED", n_a)');
    expect(cpp).toContain('Names::Add("IED#2", n_b)');
    expect(cpp).toContain('Names::Add("A\\"B\\\\C", n_c)');
    expect(cpp).toContain('Names::Add("d", n_d)'); // 空名回退 id
  });

  it('HIL 步进判据按「滞后」而非「两 tick 间隔」（否则从第 3 步必然误报超预算）', () => {
    const cpp = emitted.get('hil_mode')!;
    // 判据必须是「墙钟已走 wallNow 减去 第 k 步应到达的 dueMs=k×stepMs」；
    // 旧写法拿「两次 tick 的墙钟间隔」当消耗、恒等于 stepMs > budget=stepMs×0.8，从第 3 步必然误报。
    expect(cpp).toContain('const double dueMs = static_cast<double>(m_steps) * m_stepMs;');
    expect(cpp).toContain('m_latestDriftMs = wallNow - dueMs;');
    expect(cpp, '不得残留旧的 m_lastWallMs 判据').not.toContain('m_lastWallMs');
  });

  it('HIL 实时实现绑定必须早于任何 Simulator:: 触碰（否则懒加载单例已固化为全速实现）', () => {
    const cpp = emitted.get('hil_mode')!;
    const bindIdx = cpp.indexOf('GlobalValue::Bind("SimulatorImplementationType"');
    const startupIdx = cpp.indexOf('EpcLog("info", "generator"');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(startupIdx).toBeGreaterThan(-1);
    // ns-3 `Simulator::GetImpl()` 是懒加载单例：首次触碰（启动遥测内部就是 Simulator::Now()）
    // 即按当时的 GlobalValue 建对象并缓存；绑定若排在它后面，缓存下来的就是
    // DefaultSimulatorImpl —— HIL 名义上在跑、实际全速，仿真时间不再随墙钟推进。
    expect(bindIdx, '绑定须早于启动遥测').toBeLessThan(startupIdx);
    // 顺带钉住反方向：OFFLINE 产物不得出现实时实现
    expect(emitted.get('p2p_udp')!).not.toContain('RealtimeSimulatorImpl');
  });

  it('REALTIME 产物：无条件绑定实时实现、且不得带 HIL 的步进引擎与 --hil 消费', () => {
    // REALTIME 是「实时运行」按钮的默认去处（工程模式为 OFFLINE 时），此前从未上过编译器。
    const rt = emitted.get('realtime_mode')!;

    // ① 绑定必须存在且**无条件**：REALTIME 没有 hil 开关可依赖，写成 if (hil) 会永不生效。
    const bindIdx = rt.indexOf('GlobalValue::Bind("SimulatorImplementationType"');
    expect(bindIdx, 'REALTIME 必须绑定实时实现').toBeGreaterThan(-1);
    // 取绑定行往前 200 字符看上下文，不得被 if (hil) 包住
    const before = rt.slice(Math.max(0, bindIdx - 200), bindIdx);
    expect(before, 'REALTIME 的绑定不得被 if (hil) 包住').not.toMatch(/if \(hil\) \{\s*[^\n]*$/);

    // ② 同步模式必须是 HardLimit：默认 BestEffort 会"尽力追赶"墙钟，`Simulator::Stop(10s)`
    //    里的 10s 是仿真时间，强机上 4s 墙钟就跑完 —— 曲线不再随墙钟滚动，"实时"名存实亡。
    expect(rt, 'REALTIME 必须设 HardLimit 硬墙钟同步').toContain(
      'Config::SetDefault("ns3::RealtimeSimulatorImpl::SynchronizationMode", StringValue("HardLimit"))',
    );
    //    且必须紧跟绑定之后（同为最早期执行的路径）
    const hardIdx = rt.indexOf('SynchronizationMode');
    expect(hardIdx, 'REALTIME HardLimit 须在绑定之后').toBeGreaterThan(bindIdx);

    // ③ 同样要早于启动遥测（懒加载单例的纪律对 REALTIME 一样成立）
    const startupIdx = rt.indexOf('EpcLog("info", "generator"');
    expect(startupIdx).toBeGreaterThan(-1);
    expect(bindIdx, 'REALTIME 绑定须早于启动遥测').toBeLessThan(startupIdx);

    // ④ 不得混入 HIL 专属件：步进引擎类、[EPC-HIL] 遥测、半实物 TapBridge
    expect(rt, 'REALTIME 不得带 HIL 步进引擎').not.toContain('HilStepGuardian');
    expect(rt, 'REALTIME 不得发 [EPC-HIL] 遥测').not.toContain('"[EPC-HIL] ');
    expect(rt, 'REALTIME 不得带 TapBridge').not.toContain('TapBridgeHelper');

    // ⑤ 但它和非 HIL 产物一样要显式拒绝 --hil（否则用户以为在跑半实物闭环）
    expect(rt).toContain('本产物为 REALTIME 模式，--hil 不生效');
    expect(rt).toContain('bool hil = false;');

    // ⑥ 反方向：OFFLINE 与 REALTIME 的唯一差异就是这句绑定
    const off = emitted.get('p2p_udp')!;
    expect(off).not.toContain('RealtimeSimulatorImpl');
    expect(rt).toContain('RealtimeSimulatorImpl');
  });

  it('REALTIME 同步模式可配：默认 HardLimit，选 BEST_EFFORT 才退化为尽力追赶；HIL 恒为 HardLimit', () => {
    const cfg = cases.find((c) => c.name === 'realtime_mode')!.cfg;
    // 默认(不传 syncMode) → HardLimit（10s 仿真 ≈ 10s 墙钟）
    const def = generate(cfg, { mode: 'REALTIME', clockSource: 'INTERNAL' }).cpp;
    expect(def).toContain('StringValue("HardLimit")');
    // 显式 BEST_EFFORT → 尽力追赶，允许仿真超前墙钟
    const eff = generate(cfg, { mode: 'REALTIME', clockSource: 'INTERNAL', syncMode: 'BEST_EFFORT' }).cpp;
    expect(eff).toContain('StringValue("BestEffort")');
    expect(eff).not.toContain('StringValue("HardLimit")');
    // HIL 由保守步进接管，即使误传 BEST_EFFORT 也恒为 HardLimit
    const hil = generate(cfg, { mode: 'HIL', clockSource: 'INTERNAL', syncMode: 'BEST_EFFORT' }).cpp;
    expect(hil).toContain('StringValue("HardLimit")');
  });

  it('运行遥测协议：产物发出的前缀必须是平台解析器认得的（两侧成对，断了只会「静默无数据」）', () => {
    // 与 src/core/simOutput.ts 成对：协议断开时产物照跑、页面照开，只是 Runtime 组件永远空着 ——
    // 看起来像"没数据"，实际是耦合断了，故产物侧也必须钉死。
    for (const [name, cpp] of emitted) {
      expect(cpp, `${name} 应发操作日志遥测`).toContain('"[EPC-OP] ');
      expect(cpp, `${name} 应发通信 KPI 遥测`).toContain('"[EPC-KPI] ');
      // 周期泵必须启动，否则只有函数定义、一行都不会发
      expect(cpp, `${name} 应启动 KPI 周期泵`).toContain('EpcKpiTick(monitor,');
      // 时间戳一律取整数微秒（Time::As 拿不到数字）
      expect(cpp, `${name} 遥测时间戳应取整数微秒`).toContain('GetMicroSeconds()');
    }

    // HIL 同步遥测只在 HIL 产物里发
    expect(emitted.get('hil_mode')!).toContain('"[EPC-HIL] ');
    expect(emitted.get('p2p_udp')!).not.toContain('"[EPC-HIL] ');

    // 半实物通道计数：HIL + 有 tap 时才发射（挂桥接设备的 MacTx/MacRx）
    const hilTap = emitted.get('hil_half_physical')!;
    expect(hilTap).toContain('"[EPC-TAP] ');
    expect(hilTap).toContain('TraceConnectWithoutContext("MacTx"');
    expect(hilTap).toContain('TraceConnectWithoutContext("MacRx"');
    expect(hilTap).toContain('MakeBoundCallback(&EpcTapRx');
    // 计数器必须是「函数内 static」——普通局部量会悬垂，trace 回调读到野内存
    expect(hilTap).toContain('static EpcTapCounter epcTap0;');

    // OFFLINE 半实物：那段本就只有注释，不得发射 TAP 遥测（否则会引用未定义的 EpcTapCounter）
    const offline = emitted.get('half_physical')!;
    expect(offline).not.toContain('[EPC-TAP]');
    expect(offline).not.toContain('EpcTapCounter');
  });

  it('运行遥测协议：每条链路都发 [EPC-LINK]（链路维度的 KPI 只有这一条来源）', () => {
    // 由来：FlowMonitor 按端到端五元组聚合，天生没有链路维度；产物不发 link= 的行，
    // 平台 matchesBinding 里 scope:'link' 的分支就永远匹配不到任何事件 ——
    // 「通信指标」组件绑定链路时全空白，且**不报错**。故链路计数必须与链路一一对应地钉死。
    for (const [name, cpp] of emitted) {
      // 10 条分支每条都至少声明了 l1
      expect(cpp, `${name} 应发链路级遥测`).toContain('"[EPC-LINK] ');
      expect(cpp, `${name} 应定义链路计数器类型`).toContain('struct EpcLinkCounter {');
      // 类型定义只能有一份（多链路时靠 hasLink 只注入一次 decl 段）
      expect(cpp.match(/struct EpcLinkCounter \{/g), `${name} 计数器类型应只声明一次}`).toHaveLength(1);
      expect(cpp, `${name} 应挂 l1 的计数器`).toContain('static EpcLinkCounter epcLink_l1;');
      // 周期泵必须启动，否则只有函数定义、一行都不会发
      expect(cpp, `${name} 应启动链路遥测周期泵`).toContain('EpcLinkTick(&epcLink_l1,');
      // 链路计数挂在链路自己的设备容器上（不得回到 GetDevice(0) 之类的猜测）
      expect(cpp, `${name} 应计数两端设备`).toContain('dev_l1.Get(0)->TraceConnectWithoutContext("MacTx"');
      expect(cpp, `${name} 应计数两端设备`).toContain('dev_l1.Get(1)->TraceConnectWithoutContext("MacRx"');
      // 丢帧取两支之和：误码丢在 PhyRxDrop，队列满丢在 MacTxDrop
      expect(cpp, `${name} 应统计接收侧误码丢弃`).toContain('dev_l1.Get(1)->TraceConnectWithoutContext("PhyRxDrop"');
      expect(cpp, `${name} 应统计发送侧队列丢弃`).toContain('dev_l1.Get(0)->TraceConnectWithoutContext("MacTxDrop"');
    }

    // 多链路：每条链路各自一个计数器，不能共用（共用会把两条链路的帧数加在一起）
    const multi = emitted.get('multi_link')!;
    expect(multi).toContain('static EpcLinkCounter epcLink_l2;');
    expect(multi).toContain('.link = "l2";');
    expect(multi).toContain('dev_l2.Get(1)->TraceConnectWithoutContext("MacRx"');

    // 与 TAP 遥测相反：链路计数与模式无关，OFFLINE 也必须在跑（否则离线跑完链路空白）
    expect(emitted.get('p2p_udp')).toContain('EpcLinkTick(&epcLink_l1,');

    // 反向：无链路的工程不得注入 decl（引用未定义符号是编译期炸，但空段更干净）
    const noLinks = generate({
      ...base('no_links'),
      nodes: [
        { id: 'x1', name: 'X1', kind: 'host', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
      ],
    }).cpp;
    expect(noLinks).not.toContain('[EPC-LINK]');
    expect(noLinks).not.toContain('EpcLinkCounter');
  });

  it('运行遥测协议：KPI 行必须带流端点（否则「绑定到某台机/某条流」永远匹配不上）', () => {
    // 由来：flow=<n> 是 ns-3 按首包先后自己发的号，与工程 flows 顺序无契约；
    // 而工程常常 flows 为空（内置案例「P2P主从UDP」正是）。平台只能靠端点（IP:port）
    // 把曲线还原到"哪台机 → 哪台机"。这条链断掉的表现是：默认全局视图有数据，
    // 一绑定具体对象就空白 —— 不报错、不崩溃，靠人眼盯不出来。
    for (const [name, cpp] of emitted) {
      expect(cpp, `${name} 应从 classifier 取五元组`).toContain('Ipv4FlowClassifier::FiveTuple');
      expect(cpp, `${name} 应调用 FindFlow`).toContain('FindFlow(it->first)');
      expect(cpp, `${name} 应发源的地址:端口`).toContain('" src=" << ft.sourceAddress << ":" << ft.sourcePort');
      expect(cpp, `${name} 应发目的地址:端口`).toContain('" dst=" << ft.destinationAddress << ":" << ft.destinationPort');
      // classifier 必须经 DynamicCast 取（类型随 IPv4/IPv6 开关变），且取不到时空 Ptr 要能安全跳过。
      // 钉死整行而不只是 DynamicCast：避免再出现"另声明一个 classifier 却没人用"的死变量。
      expect(cpp, `${name} 应 DynamicCast 取 classifier`).toContain(
        'Ptr<Ipv4FlowClassifier> flowCls = DynamicCast<Ipv4FlowClassifier>(flowHelper.GetClassifier());',
      );
      expect(cpp, `${name} 不得有未被使用的第二个 classifier 声明`).not.toContain('> classifier = DynamicCast<');
      expect(cpp, `${name} classifier 为时空 Ptr 应跳过端点`).toContain('if (cls) {');
      // 显式引入五元组头：不依赖模块聚合头的包含范围（随版本变动）
      expect(cpp, `${name} 应显式引入五元组头`).toContain('#include "ns3/ipv4-flow-classifier.h"');
    }
  });
});
