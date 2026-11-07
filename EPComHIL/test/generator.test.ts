// W9 生成器单元测试：契约、校验拒绝用例、稳定产出（关键片段比对）+ 反例
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DEFAULT_RUN } from '../src/core/types';
import type { ProjectConfig } from '../src/core/types';
import { generate } from '../src/generator/generator';
import { planExport, writeExport, NS3_TARGET_VERSION } from '../src/generator/outputWriter';
import { serializeProject, parseProject } from '../src/core/projectFile';
import { useWorkbench } from '../src/renderer/stores/workbench';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function demoConfig(): ProjectConfig {
  return {
    projectName: 'demo_scenario',
    version: '0.1.0',
    createdAt: '2026-09-17T00:00:00.000Z',
    nodes: [
      { id: 'ied1', name: 'IED_A', kind: 'ied' },
      { id: 'switch1', name: 'SW_1', kind: 'switch' },
      { id: 'rtu1', name: 'RTU_1', kind: 'rtu', physical: true, physicalId: 'dev:rtu-01' },
    ],
    links: [
      { id: 'l1', kind: 'p2p', nodeA: 'ied1', nodeB: 'switch1', dataRate: '100Mbps', delay: '100us' },
      // rtu1 走 CSMA：半实物接入要求被桥接设备 SupportsSendFrom()，ns-3.38 里只有 CSMA 满足
      { id: 'l2', kind: 'csma', nodeA: 'switch1', nodeB: 'rtu1' },
    ],
    protocols: [{ id: 'p1', type: 'GOOSE', layer: 'L2', nodeId: 'ied1', appId: 0x1001, vlanId: 2 }],
    flows: [{ id: 'f1', type: 'PERIODIC', src: 'ied1', dst: 'rtu1', interval: 1 }],
    halfPhysical: { taps: [{ tapName: 'tap0', nodeId: 'rtu1', mac: '00:11:22:33:44:55' }], physicalNic: 'eth0' },
    // 运行设置（模式的唯一来源，工程必需字段）：这份夹具默认 OFFLINE；
    // 要测 HIL/REALTIME 的用例一律用 `generate(cfg, { mode: … })` 显式覆盖。
    run: { ...DEFAULT_RUN },
  };
}

describe('generate', () => {
  it('对合法工况：校验通过并产出 ns-3 脚本关键段', () => {
    const r = generate(demoConfig());
    expect(r.ok).toBe(true);
    expect(r.validation.errors).toHaveLength(0);
    expect(r.cpp).toContain('#include "ns3/core-module.h"');
    expect(r.cpp).toContain('Ptr<Node> n_ied1');
    // ns-3 的 Node 没有 SetName：命名走 config-store 的 Names::Add(name, node)
    expect(r.cpp).toContain('Names::Add("RTU_1", n_rtu1);');
    expect(r.cpp).toContain('GOOSE');
    expect(r.cpp).toContain('EtherType 0x88B8');
    expect(r.cpp).toContain('10.1.0.0');
    expect(r.cpp).toContain('半实物');
    // 生成产物缩进一致性：元素注释块（// [xxx]）必须随主体缩进，不得顶格
    expect(r.cpp.split('\n').filter((l) => l.startsWith('// ['))).toEqual([]);
  });

  it('HIL 模式生成包含保守步进注入段', () => {
    const r = generate(demoConfig(), { mode: 'HIL', clockSource: 'PTP' });
    expect(r.cpp).toContain('保守步进闭环');
    expect(r.cpp).toContain('时钟源 PTP');
  });

  it('L2 保守步进同步引擎：类定义/实时绑定/头文件齐备，OFFLINE 不产生', () => {
    const hil = generate(demoConfig(), { mode: 'HIL', clockSource: 'PTP', stepMs: 1000, stepBudgetRatio: 0.8, stepDegradeAfter: 3 });
    expect(hil.ok).toBe(true);
    // 类定义（顶层，main 之前）
    const clsIdx = hil.cpp.indexOf('class HilStepGuardian {');
    const mainIdx = hil.cpp.indexOf('int main(');
    expect(clsIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(clsIdx);
    // 吞步数/漂移/降级/源 的成员
    expect(hil.cpp).toContain('bool Step()');
    expect(hil.cpp).toContain('uint64_t Steps() const');
    expect(hil.cpp).toContain('double DriftMs() const');
    expect(hil.cpp).toContain('bool Degraded() const');
    expect(hil.cpp).toContain('ClockSource Source() const');
    // PTP 不可用 → 回退内置墙钟并告警
    expect(hil.cpp).toContain('PTP 时钟不可用');
    expect(hil.cpp).toContain('回退内置墙钟');
    // 实时仿真器绑定：须在主函数内、且早于节点创建（保证先于 Simulator 操作）
    const BIND = 'GlobalValue::Bind("SimulatorImplementationType", StringValue("ns3::RealtimeSimulatorImpl"))';
    const bindIdx = hil.cpp.indexOf(BIND);
    expect(bindIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(mainIdx);
    expect(bindIdx).toBeLessThan(hil.cpp.indexOf('// ---------------- 节点创建'));
    // 「绑定必须早于一切 Simulator:: 触碰」是硬约束，不是排版偏好：
    // Simulator::GetImpl() 是懒加载单例 —— 首次触碰（启动遥测里的 Simulator::Now()）
    // 就按当时的 GlobalValue 缓存 DefaultSimulatorImpl，之后再 Bind 只改默认值、
    // 换不掉已缓存实例 → HIL 静默退化成全速仿真（实测 10s 仿真 1ms 跑完、曲线不滚动）。
    const startupIdx = hil.cpp.indexOf('EpcLog("info", "generator"');
    expect(startupIdx, '启动遥测应存在').toBeGreaterThan(-1);
    expect(bindIdx, '绑定须早于启动遥测（其内部调 Simulator::Now）').toBeLessThan(startupIdx);
    expect(bindIdx, '绑定须早于 Time::SetResolution').toBeLessThan(
      hil.cpp.indexOf('Time::SetResolution(Time::NS);'),
    );
    // std::chrono 头仅 HIL 引入
    expect(hil.cpp).toContain('#include <chrono>');
    // 引擎装配：预算/步长/初始校时，且结尾是 C++ 块关闭符而非悬挂逗号。
    // **必须是函数内 static**：周期 tick 把 &sync 存进 ns-3 事件队列，会活到本 if 块之外；
    // 普通块内局部量在块尾即结束生命周期，之后每个 tick 都在读已失效内存 ——
    // 实测症状：第一步读数正常，第二步起 step/预算被邻居栈槽改写、降级位从第 3 步起永久为 1。
    // 与半实物 EpcTapCounter 同一条纪律（见 telemetry.ts）。
    expect(hil.cpp).toContain('static HilStepGuardian sync(');
    expect(hil.cpp).toContain('HilStepGuardian::PTP');
    // 装配处**不得**抢先调一次 sync.Step()：那会把步数提前 +1，使调度器首个 tick（t=0）
    // 的 due 变成 1×stepMs、滞后恒为 -stepMs —— Runtime「HIL 同步」组件会凭空出现一个
    // ~1s 的抖动尖峰。步数应严格等于已发生的 tick 数，故此处只装配、不预先步进。
    expect(hil.cpp).not.toContain('sync.Step();');
    // 周期保守步进校验闭环：类字段访问器 + 校时回调 + 以步长自续调度
    expect(hil.cpp).toContain('double StepMs() const');
    expect(hil.cpp).toContain('static void HilStepGuardianTick(');
    expect(hil.cpp).toContain('HilStepGuardianTick(&sync, 1000.0);');
    expect(hil.cpp).toContain('Simulator::Schedule(MilliSeconds(periodMs), &HilStepGuardianTick, g, periodMs);');
    // 时钟源一致性：PTP 缺省装配，内置墙钟源对称成立且不引 PTP 断言
    expect(hil.cpp).toContain('HilStepGuardian::PTP');
    const internal = generate(demoConfig(), { mode: 'HIL', clockSource: 'INTERNAL', stepMs: 1000 });
    expect(internal.ok).toBe(true);
    expect(internal.cpp).toContain('HilStepGuardian::INTERNAL');
    // 仅断言装配处构造实参非 PTP（类枚举与就绪日志三元表达式里 PTP 字样仍属合法）
    expect(internal.cpp).toContain('      HilStepGuardian::INTERNAL,');
    expect(internal.cpp).not.toContain('      HilStepGuardian::PTP,');
    expect(internal.cpp).toContain('HilStepGuardianTick(&sync, 1000.0);');
    // 时钟源对话：PTP 无网卡/未同步时回退内置墙钟并告警
    expect(hil.cpp).toContain('PTP 时钟不可用');
    expect(hil.cpp).toContain('回退内置墙钟');
    const block = hil.cpp.match(/if \(hil\) \{[\s\S]*?HilStepGuardianTick[\s\S]*?\n\s*\}/);
    expect(block).not.toBeNull();
    expect(/}\s*,?\s*$/.test(block![0])).toBe(true); // 以 if 块 {..} 收尾，无悬挂逗号
    expect(hil.cpp).not.toMatch(/\{[\s\S]*?\n\s*\},\n/); // 无 "}," 悬挂
    // 装配段注释须缩进于 main 体内，不得顶格（与元素注释块同一约束）
    const injLine = hil.cpp.split('\n').find((l) => l.includes('// [HIL 注入]'));
    expect(injLine).toBeDefined();
    expect(/^\s+/.test(injLine!)).toBe(true);
    // OFFLINE 不产生任何同步引擎与实时绑定
    const off = generate(demoConfig(), { mode: 'OFFLINE', clockSource: 'INTERNAL' });
    expect(off.cpp).not.toContain('HilStepGuardian');
    expect(off.cpp).not.toContain('RealtimeSimulatorImpl');
    expect(off.cpp).not.toContain('#include <chrono>');
    expect(off.cpp).not.toContain('同步引擎');
  });

  it('HIL 模式：半实物生成可执行 TapBridge 装载段（UseBridge），OFFLINE 仅注释', () => {
    const cfg = demoConfig(); // rtu1 挂在 CSMA 链路 l2 上，且配了 tap tap0
    const hil = generate(cfg, { mode: 'HIL', clockSource: 'PTP' });
    expect(hil.ok).toBe(true);
    expect(hil.cpp).toContain('#include "ns3/tap-bridge-module.h"');
    expect(hil.cpp).toContain('TapBridgeHelper tapBridge0');
    expect(hil.cpp).toContain('"UseBridge"');
    expect(hil.cpp).toContain('tap0');
    // 桥接设备取 CSMA 设备容器里的那一块（rtu1 在 l2 的设备容器里是第 1 个）
    expect(hil.cpp).toContain('Install(n_rtu1, dev_l2.Get(1))');
    // 回归点：Node::GetDevice(0) 取的是「先装那块」，与链路类型无关；一旦取到 p2p 设备，
    // TapBridge 装载期 NS_FATAL_ERROR 直接 abort（编译期完全查不出来），故产物必须不出现它
    expect(hil.cpp).not.toContain('GetDevice(0)');
    // 兜底断言指名到节点，把「一行无主日志的 abort」换成可读报错
    expect(hil.cpp).toContain('NS_ABORT_MSG_UNLESS(dev_l2.Get(1)->SupportsSendFrom()');
    // 整段收在 if (hil) 内（与 HIL 注入段同一开关），故 TapBridgeHelper 缩进 6 空格
    expect(hil.cpp).toContain('      TapBridgeHelper tapBridge0;');
    // OFFLINE 产物不得出现可执行装载段（只允许注释说明）
    const offline = generate(cfg, { mode: 'OFFLINE', clockSource: 'INTERNAL' });
    expect(offline.ok).toBe(true);
    expect(offline.cpp).not.toContain('TapBridgeHelper');
    expect(offline.cpp).not.toContain('tap-bridge-module.h');
    expect(offline.cpp).toContain('以 HIL 模式导出时，此处将落地');
  });

  it('HIL 模式：半实物节点无可桥接设备时报错（TapBridge 只桥 SupportsSendFrom 的 CSMA 设备）', () => {
    const cfg = demoConfig();
    cfg.halfPhysical = { taps: [{ tapName: 'tap9', nodeId: 'ied1', mac: '00:00:00:00:00:09' }], physicalNic: 'eth0' };
    // ied1 只挂在 l1，把它从 l1 摘掉使其无链路
    cfg.links = [{ id: 'l2', kind: 'p2p', nodeA: 'switch1', nodeB: 'rtu1' }];
    const r = generate(cfg, { mode: 'HIL', clockSource: 'PTP' });
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.message.includes('SupportsSendFrom'))).toBe(true);
  });

  it('csma 链路：以 NodeContainer 装配同一冲突域，IP 分配不重复拼接设备容器', () => {
    const cfg = demoConfig();
    cfg.links = [{ id: 'l1', kind: 'csma', nodeA: 'ied1', nodeB: 'switch1', dataRate: '100Mbps' }];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('CsmaHelper link_l1;');
    expect(r.cpp).toContain('NodeContainer csmaNodes_l1;');
    expect(r.cpp).toContain('NetDeviceContainer dev_l1 = link_l1.Install(csmaNodes_l1);');
    // 回归点：CsmaHelper 只有 Ptr<Node>/NodeContainer 重载，产物中不得再出现设备容器的双重嵌套
    expect(r.cpp).not.toContain('Install(NetDeviceContainer(');
    expect(r.cpp).toContain('ipv4.Assign(dev_l1)');
  });

  it('链路误包率：显式锁定 ErrorUnit=PACKET（库默认 BYTE 会把 1% 放大成 72% 丢包）', () => {
    const cfg = demoConfig();
    cfg.links = [{ id: 'l1', kind: 'csma', nodeA: 'ied1', nodeB: 'switch1', dataRate: '10Mbps', errorRate: 0.01 }];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    // RateErrorModel::ErrorUnit 的默认值是 ERROR_UNIT_BYTE（每字节判定），不显式覆盖就与界面语义不符：
    // 128B 报文按「每字节 1%」算，被毁概率 1-0.99^128 ≈ 72%，实测亦如此。
    expect(r.cpp).toContain('SetAttribute("ErrorUnit", EnumValue(RateErrorModel::ERROR_UNIT_PACKET))');
    expect(r.cpp).toContain('SetAttribute("ErrorRate", DoubleValue(0.01))');
  });

  it('半实物节点只挂 p2p 链路时校验报错（编译能过但装载期必 abort）', () => {
    const cfg = demoConfig();
    cfg.links = [{ id: 'l2', kind: 'p2p', nodeA: 'switch1', nodeB: 'rtu1' }];
    const r = generate(cfg, { mode: 'HIL', clockSource: 'PTP' });
    expect(r.ok).toBe(false);
    // PointToPointNetDevice::SupportsSendFrom() 恒为 false，桥上即 NS_FATAL_ERROR
    expect(r.validation.errors.some((e) => e.message.includes('SupportsSendFrom'))).toBe(true);
  });

  it('存在 SERVER 应用时生成逐包 Rx 日志（对齐官方 udp-client-server 打点）', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'a', name: 'IED_A', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'CUSTOM', port: 502 }] },
      { id: 'b', name: 'SW_1', kind: 'switch' },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: 'a', nodeB: 'b' }];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('static void ServerRxLog');
    // UdpServer 的 "RxWithAddresses" 是**三参** trace（packet / from / to，见 src/applications/model/udp-server.h），
    // 回调的参数个数必须严格对齐：个数不符时 TraceConnectWithoutContext 内 cb.Assign() 失败 →
    // NS_FATAL_ERROR_NO_MSG() 抛空 what() 的 runtime_error 直接终止，且崩在 Simulator::Run() 之前，
    // 日志里没有任何业务输出 —— 外部看像「程序启动即退」，极易被误判成环境问题。
    expect(r.cpp).toContain(
      'static void ServerRxLog(Ptr<const Packet> p, const Address &from, const Address &to) {',
    );
    expect(r.cpp).toContain('TraceConnectWithoutContext("RxWithAddresses", MakeCallback(&ServerRxLog))');
    expect(r.cpp).not.toContain('TraceConnectWithoutContext("Rx"');
    expect(r.cpp).toContain('InetSocketAddress::ConvertFrom(from)');
    // 时间戳取整数微秒只能走 GetMicroSeconds()：Time::As(Unit) 返回的是 TimeWithUnit
    //（自带单位后缀、成员全 private、无任何取值接口），流输出会打成 "+2.00014e+06us"，
    // 再拼上手写的 " us " 就成了单位重复。
    expect(r.cpp).toContain('Simulator::Now().GetMicroSeconds()');
    expect(r.cpp).not.toContain('Time::As(');
  });

  it('节点命名走 Names::Add 且工程内唯一：重名加后缀、字面量已转义', () => {
    // ns-3 的 Node 没有 SetName（node.h 里根本没有命名 API），命名只能 Names::Add；
    // 而 Names::Add 遇重名走 NS_ABORT_MSG_UNLESS **直接终止进程** —— 故同名节点必须由生成器去重，
    // 否则产物「编得过、跑起来刚建完节点就崩」，比编译错误更难排查。
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'a', name: 'IED', kind: 'ied' },
      { id: 'b', name: 'IED', kind: 'ied' },
      { id: 'c', name: 'A"B', kind: 'ied' },
      { id: 'd', name: 'A\\B', kind: 'ied' },
    ];
    cfg.links = [
      { id: 'l1', kind: 'p2p', nodeA: 'a', nodeB: 'b' },
      { id: 'l2', kind: 'p2p', nodeA: 'a', nodeB: 'c' },
    ];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    // 不再出现凭直觉臆造出来的成员函数
    expect(r.cpp).not.toContain('->SetName(');
    // 首个用原名，重名的第 2 个起加 #2 —— 保证「一个名字只注册一次」
    expect(r.cpp).toContain('Names::Add("IED", n_a);');
    expect(r.cpp).toContain('Names::Add("IED#2", n_b);');
    // 引号不转义会提前闭合字面量、产物直接编译失败；反斜杠不转义会静默改变语义
    expect(r.cpp).toContain(String.raw`Names::Add("A\"B", n_c);`);
    expect(r.cpp).toContain(String.raw`Names::Add("A\\B", n_d);`);
    // 每个节点恰好注册一次
    expect(r.cpp.split('\n').filter((l) => l.includes('Names::Add('))).toHaveLength(4);
  });

  it('无 SERVER 应用时不生成逐包日志回调（避免未使用函数告警）', () => {
    const cfg = minimalConfig();
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).not.toContain('ServerRxLog');
  });

  it('Modbus/TCP 承载：Server 生成 PacketSink/OnOff 的 TCP 段而非 UDP，且纯 TCP 工程不带 ServerRxLog', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'mgcc', name: 'MGCC', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'MODBUS_TCP', peer: 'slave', port: 502, interval: 0.5, payloadSize: 96 }] },
      { id: 'slave', name: 'SLAVE', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'MODBUS_TCP', port: 502 }] },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: 'mgcc', nodeB: 'slave' }];
    cfg.protocols = [];
    cfg.flows = [{ id: 'f1', type: 'PERIODIC', src: 'mgcc', dst: 'slave', interval: 0.5, payloadSize: 96 }];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    // Server 端走 TCP 承载：PacketSinkHelper(TcpSocketFactory)，不再生成 UDP Server
    expect(r.cpp).toContain('PacketSinkHelper sink_s1("ns3::TcpSocketFactory", InetSocketAddress(Ipv4Address::GetAny(), 502));');
    expect(r.cpp).not.toContain('UdpServerHelper app_s1');
    // 应用级 CLIENT 与业务流均以 OnOff(TcpSocketFactory) 生成，而非 UdpClientHelper
    expect(r.cpp).toContain('OnOffHelper onoff_c1("ns3::TcpSocketFactory"');
    expect(r.cpp).toContain('OnOffHelper cbr_f1("ns3::TcpSocketFactory"');
    expect(r.cpp).not.toContain('UdpClientHelper');
    expect(r.cpp).not.toContain('UdpServerHelper');
    // 目标端口描述为 TcpServer
    expect(r.cpp).toContain('TcpServer:502');
    // 纯 TCP 工程无 UDP Server → 不生成 ServerRxLog（避免未用函数告警）
    expect(r.cpp).not.toContain('ServerRxLog');
  });

  it('显式 transport=UDP 可把 Modbus/TCP 的默认 TCP 覆盖为 UDP', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'mgcc', name: 'MGCC', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'MODBUS_TCP', transport: 'UDP', peer: 'slave', port: 502, interval: 0.5, payloadSize: 96 }] },
      { id: 'slave', name: 'SLAVE', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'MODBUS_TCP', transport: 'UDP', port: 502 }] },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: 'mgcc', nodeB: 'slave' }];
    cfg.protocols = [];
    cfg.flows = [{ id: 'f1', type: 'PERIODIC', src: 'mgcc', dst: 'slave', transport: 'UDP' }];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('UdpServerHelper app_s1;'); // 显式 UDP 覆盖协议默认 TCP
    expect(r.cpp).toContain('UdpClientHelper cbr_f1(');
    expect(r.cpp).toContain('TraceConnectWithoutContext("RxWithAddresses", MakeCallback(&ServerRxLog));'); // 含 UDP Server→ServerRxLog
    expect(r.cpp).not.toContain('PacketSinkHelper');
    expect(r.cpp).not.toContain('OnOffHelper');
  });

  it('显式 transport=TCP 可把普通协议的默认 UDP 覆盖为 TCP', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'h1', name: 'H1', kind: 'ied', apps: [{ id: 'c1', role: 'CLIENT', protocol: 'MMS', transport: 'TCP', peer: 'h2', port: 102 }] },
      { id: 'h2', name: 'H2', kind: 'ied', apps: [{ id: 's1', role: 'SERVER', protocol: 'MMS', transport: 'TCP', port: 102 }] },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: 'h1', nodeB: 'h2' }];
    cfg.protocols = [];
    cfg.flows = [{ id: 'f1', type: 'PERIODIC', src: 'h1', dst: 'h2', transport: 'TCP' }];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('PacketSinkHelper sink_s1("ns3::TcpSocketFactory"');
    expect(r.cpp).toContain('OnOffHelper onoff_c1("ns3::TcpSocketFactory"');
    expect(r.cpp).toContain('OnOffHelper cbr_f1("ns3::TcpSocketFactory"');
    expect(r.cpp).not.toContain('UdpServerHelper');
    expect(r.cpp).not.toContain('UdpClientHelper');
    expect(r.cpp).not.toContain('ServerRxLog'); // 纯 TCP 工程
  });

  it('transport 在 .tc 落盘往返中保留（节点应用与业务流）', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: 'n1', name: 'N1', kind: 'ied', apps: [{ id: 'a1', role: 'CLIENT', protocol: 'CUSTOM', transport: 'TCP', peer: 'n2', port: 3000 }] },
      { id: 'n2', name: 'N2', kind: 'switch' },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: 'n1', nodeB: 'n2' }];
    cfg.protocols = [];
    cfg.flows = [{ id: 'f1', type: 'PERIODIC', src: 'n1', dst: 'n2', transport: 'TCP' }];
    cfg.halfPhysical = undefined;
    const back = parseProject(serializeProject(cfg)).project;
    expect(back.nodes[0].apps?.[0].transport).toBe('TCP');
    expect(back.flows[0].transport).toBe('TCP');
  });

  it('未勾选统计项时仍默认输出基础统计（与 ns-3 官方示例一致）', () => {
    const cfg = demoConfig();
    // 清空所有 stats，模拟用户未勾选任一输出项
    cfg.nodes = cfg.nodes.map((n) => ({ ...n, stats: undefined }));
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    // 恒安装 FlowMonitor，与 Run 之后必打印兜底基础列
    expect(r.cpp).toContain('FlowMonitorHelper flowHelper;');
    expect(r.cpp).toContain('monitor->CheckForLostPackets();');
    expect(r.cpp).toContain('"TxPkts=" << st.txPackets');
    expect(r.cpp).toContain('"PDR%="');
  });

  it('CBR 业务流目标地址取自统一 IP 规划（而非硬编码网段）', () => {
    const cfg = demoConfig();
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'rtu1' }];
    const r = generate(cfg);
    // l1: ied1(10.1.0.1) ↔ switch1(10.1.0.2)；l2: switch1(10.2.0.1) ↔ rtu1(10.2.0.2)
    expect(r.cpp).toContain('Ipv4Address("10.2.0.2")');
    expect(r.cpp).not.toContain('10.1.1.0');
  });

  it('纯数字节点 id 生成合法 C++ 标识符（n_1 / n_2）', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: '1', name: 'IED_1', kind: 'ied' },
      { id: '2', name: '交换机_1', kind: 'switch' },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '2' }];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('Ptr<Node> n_1 = CreateObject<Node>();');
    expect(r.cpp).toContain('Names::Add("IED_1", n_1);');
    expect(r.cpp).toContain('NetDeviceContainer dev_l1 = link_l1.Install(linkNodes_l1);');
    expect(r.cpp).toContain('ipv4.Assign(dev_l1);');
    // 标识符不得以数字开头
    expect(r.cpp).not.toMatch(/\bPtr<Node> \d/);
  });

  it('勾选统计输出：生成 FlowMonitor 统计段并按所选列输出，未勾选则不生成', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: '1', name: 'IED_1', kind: 'ied', stats: ['tx_packets', 'pdr'] },
      { id: '2', name: 'SW_1', kind: 'switch' },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '2', stats: ['lost_packets', 'delay_mean'] }];
    cfg.protocols = [];
    cfg.flows = [];
    cfg.halfPhysical = undefined;
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('#include "ns3/flow-monitor-module.h"');
    expect(r.cpp).toContain('FlowMonitorHelper flowHelper;');
    expect(r.cpp).toContain('Ptr<FlowMonitor> monitor = flowHelper.InstallAll();');
    expect(r.cpp).toContain('monitor->CheckForLostPackets();');
    expect(r.cpp).toContain('"TxPkts=" << st.txPackets');
    expect(r.cpp).toContain('"PDR%="');
    expect(r.cpp).toContain('"Lost=" << st.lostPackets');
    expect(r.cpp).toContain('"MeanDelay_s="');
    // 未勾选项不出现在输出列
    expect(r.cpp).not.toContain('st.rxBytes');

    const cfgNo = demoConfig();
    cfgNo.nodes = [
      { id: '1', name: 'IED_1', kind: 'ied' },
      { id: '2', name: 'SW_1', kind: 'switch' },
    ];
    cfgNo.links = [{ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '2' }];
    cfgNo.protocols = [];
    cfgNo.flows = [];
    cfgNo.halfPhysical = undefined;
    const rNo = generate(cfgNo);
    expect(rNo.ok).toBe(true);
    // 契约：统计输出为平台默认能力，未勾选也恒生成（兜底基础列），与 ns-3 官方示例"运行必有输出"一致
    expect(rNo.cpp).toContain('FlowMonitorHelper flowHelper;');
    expect(rNo.cpp).toContain('#include "ns3/flow-monitor-module.h"');
    expect(rNo.cpp).toContain('"TxPkts=" << st.txPackets');
    expect(rNo.cpp).toContain('"PDR%="');
  });

  it('统计项经序列化/解析往返保持一致，非法 key 被清洗', () => {
    const cfg = demoConfig();
    cfg.nodes = [
      { id: '1', name: 'IED_1', kind: 'ied', stats: ['tx_packets', 'bogus_key', 'tx_packets'] },
      { id: '2', name: 'SW_1', kind: 'switch', stats: ['delay_jitter'] },
    ];
    cfg.links = [{ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '2', stats: ['pdr'] }];
    const text = serializeProject(cfg);
    const pr = parseProject(text);
    expect(pr.ok).toBe(true);
    expect(pr.project.nodes[0].stats).toEqual(['tx_packets']);
    expect(pr.project.nodes[1].stats).toEqual(['delay_jitter']);
    expect(pr.project.links[0].stats).toEqual(['pdr']);
  });

  it('校验：同一节点上 L3 端口冲突报 error 并阻断导出', () => {
    const cfg = demoConfig();
    cfg.protocols = [
      { id: 'p1', type: 'MMS', layer: 'L3', nodeId: 'ied1', localPort: 102 },
      { id: 'p2', type: 'MODBUS_TCP', layer: 'L3', nodeId: 'ied1', localPort: 102 },
    ];
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'localPort' && e.message.includes('102'))).toBe(true);
  });

  it('校验：业务流 protocolRef 悬空报 error', () => {
    const cfg = demoConfig();
    cfg.flows = [{ id: 'f1', type: 'PERIODIC', src: 'ied1', dst: 'rtu1', protocolRef: 'nope' }];
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'protocolRef')).toBe(true);
  });

  it('校验：实物节点缺少 tap 映射只给警告，不阻断导出', () => {
    const cfg = demoConfig();
    cfg.halfPhysical = { taps: [], physicalNic: 'eth0' };
    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.validation.warnings.some((w) => w.elementId === 'rtu1' && w.field === 'physical')).toBe(true);
  });

  it('节点级应用：Server/Client 生成 UdpServer/UdpClient 装载段与 include', () => {
    const cfg = demoConfig();
    cfg.protocols = [];
    // switch1 装 Server(MMS@502)，ied1 装 Client 指向 switch1(l1: ied1=10.1.0.1, switch1=10.1.0.2)
    const sw = cfg.nodes.find((n) => n.id === 'switch1')!;
    sw.apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 502 }];
    const ied = cfg.nodes.find((n) => n.id === 'ied1')!;
    ied.apps = [{ id: 'a2', role: 'CLIENT', protocol: 'MMS', port: 502, peer: 'switch1', interval: 1, payloadSize: 512 }];

    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.validation.errors).toHaveLength(0);
    expect(r.cpp).toContain('UdpServerHelper app_a1;');
    expect(r.cpp).toContain('app_a1.SetAttribute("Port", UintegerValue(502));');
    expect(r.cpp).toContain('ApplicationContainer appC_a1 = app_a1.Install(n_switch1);');
    expect(r.cpp).toContain('UdpClientHelper app_a2(Ipv4Address("10.1.0.2"), 502);');
    expect(r.cpp).toContain('app_a2.SetAttribute("Interval", TimeValue(Seconds(1)));');
    expect(r.cpp).toContain('ApplicationContainer appC_a2 = app_a2.Install(n_ied1);');
    // UdpServerHelper / UdpClientHelper 同属 udp-client-server-helper.h
    expect(r.cpp).toContain('#include "ns3/udp-client-server-helper.h"');
    expect(r.cpp).toContain('应用装载 (Server/Client UDP)');
  });

  it('校验：CLIENT 对端节点未挂链路（无 IP）报 error 并阻断导出', () => {
    const cfg = demoConfig();
    cfg.protocols = [];
    // 只保留 l1，rtu1 虽在 nodes 但已无链路 → peer 无 IP
    cfg.links = [cfg.links[0]];
    const sw = cfg.nodes.find((n) => n.id === 'switch1')!;
    sw.apps = [{ id: 'a1', role: 'CLIENT', protocol: 'MMS', port: 502, peer: 'rtu1' }];
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'peer')).toBe(true);
  });

  it('校验：CLIENT 缺少 peer 报 error，SERVER 无需 peer 可导出', () => {
    const cfg = demoConfig();
    cfg.protocols = [];
    const sw = cfg.nodes.find((n) => n.id === 'switch1')!;
    sw.apps = [{ id: 'a1', role: 'CLIENT', protocol: 'MMS', port: 502 }]; // 缺 peer
    let r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'peer')).toBe(true);

    // 同节点只装 SERVER 则合法
    sw.apps = [{ id: 'a2', role: 'SERVER', protocol: 'MMS', port: 502 }];
    r = generate(cfg);
    expect(r.ok).toBe(true);
  });
});

describe('outputWriter', () => {
  it('导出 Designed_<ts> 工程目录并写入 .cc / project.json / validation.json / README', () => {
    const base = mkdtempSync(join(tmpdir(), 'ech-export-'));
    const r = generate(demoConfig());
    const out = writeExport(demoConfig(), r.cpp, r.validation, base);
    expect(existsSync(out.mainCpp)).toBe(true);
    expect(existsSync(join(out.root, 'project.json'))).toBe(true);
    expect(existsSync(join(out.root, 'validation.json'))).toBe(true);
    expect(existsSync(join(out.root, 'README.md'))).toBe(true);
    expect(readFileSync(out.mainCpp, 'utf8')).toContain('int main');
    expect(out.root).toContain('Designed_');
  });

  it('planExport 与 writeExport 同源：落盘内容必须等于清单内容（防两套实现漂移）', () => {
    const base = mkdtempSync(join(tmpdir(), 'ech-plan-'));
    const cfg = demoConfig();
    const r = generate(cfg);
    const at = new Date('2026-09-17T00:00:00.000Z');
    const plan = planExport(cfg, r.cpp, r.validation, at);
    const out = writeExport(cfg, r.cpp, r.validation, base, at);

    expect(out.root).toBe(join(base, plan.rootName));
    expect(plan.files.map((f) => f.relPath)).toEqual([
      'simulation/demo_scenario.cc',
      'project.json',
      'validation.json',
      'build/CMakeLists.txt',
      'README.md',
    ]);
    for (const f of plan.files) {
      const abs = join(out.root, f.relPath);
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toBe(f.content);
    }
    // 主进程只按清单落盘，故 CMakeLists 内容必须在这里就具备可编译装配信息
    expect(plan.files.find((f) => f.relPath === 'build/CMakeLists.txt')!.content).toContain('target_sources');
  });

  it('导出说明面向 ns-3.38：版本取自单一来源，全清单无旧版本残留', () => {
    const cfg = demoConfig();
    const r = generate(cfg);
    const plan = planExport(cfg, r.cpp, r.validation, new Date('2026-09-17T00:00:00.000Z'));

    const cmake = plan.files.find((f) => f.relPath === 'build/CMakeLists.txt')!.content;
    const readme = plan.files.find((f) => f.relPath === 'README.md')!.content;

    // 先用**字面量**断言：期望值不能从常量推导，否则常量本身写错时测试会跟着一起错，
    // 变成"测试镜像 bug"（本轮真实踩过：常量已是 3.38，文案里又写了一遍 "ns-3." → ns-3.3.38）
    expect(cmake, 'CMakeLists 未声明目标 ns-3 版本').toContain('ns-3.38 scratch/');
    expect(readme, 'README 未声明目标 ns-3 版本').toContain('放入 ns-3.38 环境');
    // 再钉住常量本身：改这里 = 有意换目标平台，应当是显式决定而非顺手改
    expect(NS3_TARGET_VERSION).toBe('3.38');
    // 版本前缀不得重复
    for (const [name, text] of [['CMakeLists', cmake], ['README', readme]] as const) {
      expect(text, `${name} 版本前缀重复`).not.toContain('ns-3.3.');
    }

    // 全清单扫一遍：任何产物都不允许残留旧版本串（半更新在审查里很容易滑过）
    for (const f of plan.files) {
      expect(f.content, `${f.relPath} 残留旧 ns-3 版本串`).not.toContain('3.46');
    }

    // ./ns3 以 root 运行会被直接拒绝——这条限制必须写在说明里，否则照抄命令必然失败
    expect(readme).toContain('Refusing to run as root');
  });
});

describe('workbench 发号与引用清理', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('节点 id 为纯数字短号，取当前最小未占用号（删除后补空）', () => {
    const store = useWorkbench();
    expect(store.nextNodeId()).toBe('1');
    store.addNode({ id: '1', name: 'IED_1', kind: 'ied' });
    expect(store.nextNodeId()).toBe('2');
    store.addNode({ id: '2', name: '交换机_1', kind: 'switch' });
    store.addNode({ id: '3', name: 'RTU_1', kind: 'rtu' });
    expect(store.nextNodeId()).toBe('4');
    store.removeNode('2');
    expect(store.nextNodeId()).toBe('2');
  });

  it('默认名按类型独立计数：同类型递增，不与其他类型串号', () => {
    const store = useWorkbench();
    expect(store.nextNodeName('ied')).toBe('IED_1');
    expect(store.nextNodeName('switch')).toBe('交换机_1');
    store.addNode({ id: '1', name: 'IED_1', kind: 'ied' });
    expect(store.nextNodeName('ied')).toBe('IED_2');
    // 建过 IED 不应该让第一个交换机变成「交换机_2」
    expect(store.nextNodeName('switch')).toBe('交换机_1');
    // 用户自定名的节点不参与自动编号
    store.addNode({ id: '2', name: '主变测控', kind: 'ied' });
    expect(store.nextNodeName('ied')).toBe('IED_2');
  });

  it('带前缀实体按前缀独立发号，且不与数字节点 id 撞号', () => {
    const store = useWorkbench();
    store.addNode({ id: store.nextNodeId(), name: 'IED_1', kind: 'ied' });
    expect(store.usedIds.has('1')).toBe(true);
    // 各前缀独立从 1 起，不因别的类型发过号而跳号
    expect(store.nextId('l')).toBe('l1');
    expect(store.nextId('p')).toBe('p1');
    expect(store.nextId('l')).toBe('l2');
    expect(store.nextId('f')).toBe('f1');
    expect(store.usedIds.has('l1')).toBe(false);
  });

  it('UI 发号直连生成器：数字节点 id + l 链路 id 产出合法 C++ 变量名', () => {
    const store = useWorkbench();
    const a = store.nextNodeId();
    store.addNode({ id: a, name: store.nextNodeName('ied'), kind: 'ied' });
    const b = store.nextNodeId();
    store.addNode({ id: b, name: store.nextNodeName('switch'), kind: 'switch' });
    store.addLink({ id: store.nextId('l'), kind: 'p2p', nodeA: a, nodeB: b, dataRate: '100Mbps', delay: '100us' });

    const r = generate({ ...store.project, protocols: [], flows: [], faults: [], halfPhysical: undefined });
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('Ptr<Node> n_1 = CreateObject<Node>();');
    expect(r.cpp).toContain('Ptr<Node> n_2 = CreateObject<Node>();');
    expect(r.cpp).toContain('NetDeviceContainer dev_l1 = link_l1.Install(linkNodes_l1);');
    expect(r.cpp).toContain('ipv4.Assign(dev_l1);');
    expect(r.cpp).toContain('Names::Add("IED_1", n_1);');
    expect(r.cpp).toContain('Names::Add("交换机_1", n_2);');
  });

  it('删除节点/链路会清理故障与半实物映射里的悬空引用', () => {
    const store = useWorkbench();
    store.addNode({ id: 'ied1', name: 'A', kind: 'ied' });
    store.addNode({ id: 'rtu1', name: 'B', kind: 'rtu', physical: true });
    store.addLink({ id: 'l1', kind: 'p2p', nodeA: 'ied1', nodeB: 'rtu1' });
    store.addFault({ id: 'fa1', nodeId: 'rtu1', startTime: 1, endTime: 2, kind: 'drop' });
    store.addFault({ id: 'fa2', linkId: 'l1', startTime: 1, endTime: 2, kind: 'drop' });
    store.setHalfPhysical({ taps: [{ tapName: 'tap0', nodeId: 'rtu1', mac: 'm' }], physicalNic: 'eth0' });

    store.removeNode('rtu1');
    expect(store.project.faults.map((f) => f.id)).toEqual(['fa2']);
    expect(store.project.halfPhysical!.taps).toHaveLength(0);

    store.removeLink('l1');
    expect(store.project.faults).toHaveLength(0);
  });

  it('删除协议会清掉业务流上指向它的引用', () => {
    const store = useWorkbench();
    store.addNode({ id: 'ied1', name: 'A', kind: 'ied' });
    store.addProtocol({ id: 'p1', type: 'MMS', layer: 'L3', nodeId: 'ied1', localPort: 102 });
    store.addFlow({ id: 'f1', type: 'PERIODIC', src: 'ied1', dst: 'ied1', protocolRef: 'p1' });
    store.removeProtocol('p1');
    expect(store.project.flows[0].protocolRef).toBeUndefined();
  });
});

/**
 * 产物允许引用的 ns-3 头文件白名单 —— 每一项都对着上游仓库核实过真实存在。
 *
 * 踩过的坑：曾按类名臆造出 ns3/udp-server-helper.h / ns3/udp-client-helper.h，
 * 而 ns-3 源码树里根本没有这两个文件（UdpServerHelper / UdpClientHelper 同在
 * src/applications/helper/udp-client-server-helper.h），产物一编译就 No such file or directory。
 * 新增头文件前先去上游核实文件名，再补进这里。
 */
const VERIFIED_NS3_HEADERS = new Set([
  'core-module.h',
  'network-module.h',
  'internet-module.h',
  'point-to-point-module.h',
  'csma-module.h',
  'applications-module.h',
  'flow-monitor-module.h',
  'udp-client-server-helper.h',
  // 遥测要报出流的五元组，直接用 Ipv4FlowClassifier::FiveTuple / FindFlow。
  // 已核对：src/flow-monitor/model/ipv4-flow-classifier.h 在 ns-3.38 源码树中确实存在
  // （实机 `ls` 验证，见 C:/tmp/ns3-run/jobs41-out.txt 的 FindFlow 签名）。
  'ipv4-flow-classifier.h',
]);

/** 抽出产物里所有 ns3 头文件名（剥掉 `#include "ns3/` 前缀与收尾引号） */
function ns3Includes(cpp: string): string[] {
  return cpp
    .split('\n')
    .filter((l) => l.startsWith('#include "ns3/'))
    .map((l) => l.replace(/^#include "ns3\//, '').replace(/"\s*$/, ''));
}

/** 花括号净值：产物是 C++，少一个右括号必然编不过，且这类硬伤肉眼很难发现 */
function braceDelta(cpp: string): number {
  return (cpp.match(/\{/g) ?? []).length - (cpp.match(/\}/g) ?? []).length;
}

/** 极简工程：两个节点一条链路，其余全空，用于测"没配的东西不得进产物" */
function minimalConfig(): ProjectConfig {
  return {
    projectName: 'minimal',
    version: '0.1.0',
    createdAt: '2026-09-17T00:00:00.000Z',
    nodes: [
      { id: '1', name: 'IED_1', kind: 'ied' },
      { id: '2', name: '交换机_1', kind: 'switch' },
    ],
    links: [{ id: 'l1', kind: 'p2p', nodeA: '1', nodeB: '2' }],
    protocols: [],
    flows: [],
    run: { ...DEFAULT_RUN },
  };
}

describe('产物可编译性回归', () => {
  it('产物只引用核实过存在的 ns-3 头文件（防按类名臆造）', () => {
    const cfg = demoConfig();
    // 让所有会产生 addInclude 的路径都跑到：节点应用 + 业务流
    cfg.nodes[1].apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 502 }];
    cfg.nodes[0].apps = [{ id: 'a2', role: 'CLIENT', protocol: 'MMS', port: 502, peer: 'switch1' }];
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'switch1', interval: 1, payloadSize: 512 }];

    const r = generate(cfg);
    const inc = ns3Includes(r.cpp);
    expect(inc.length).toBeGreaterThan(0);
    for (const h of inc) {
      expect(VERIFIED_NS3_HEADERS.has(h), `产物引用了未核实的 ns-3 头文件: ns3/${h}`).toBe(true);
    }
    // 显式反例：这两个文件在 ns-3 源码树里不存在
    expect(r.cpp).not.toContain('udp-server-helper.h');
    expect(r.cpp).not.toContain('udp-client-helper.h');
  });

  it('各典型工况下花括号配平（编不过的头号硬伤）', () => {
    const withFlow = minimalConfig();
    withFlow.nodes[0].apps = [{ id: 'a1', role: 'CLIENT', protocol: 'MMS', port: 502, peer: '2' }];
    withFlow.flows = [{ id: 'f1', type: 'CBR', src: '1', dst: '2', interval: 1, payloadSize: 512 }];

    const cases: ProjectConfig[] = [demoConfig(), minimalConfig(), withFlow];

    for (const c of cases) {
      expect(braceDelta(generate(c).cpp), `工程 ${c.projectName} 产物括号不配平`).toBe(0);
    }
    // HIL 模式的注入段同样是插进 main 里的块，一并核
    expect(braceDelta(generate(demoConfig(), { mode: 'HIL', clockSource: 'PTP' }).cpp)).toBe(0);
  });
});

describe('CBR 业务流：从空壳改为真实装载', () => {
  it('真正 Install 到源节点，端口与目标节点 SERVER 同源，且不被 MaxPackets 默认值 100 截断', () => {
    const cfg = demoConfig();
    cfg.nodes[1].apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 502 }]; // switch1
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'switch1', interval: 0.5, payloadSize: 256 }];

    const r = generate(cfg);
    expect(r.ok).toBe(true);
    // l1: ied1 = 10.1.0.1 ↔ switch1 = 10.1.0.2
    expect(r.cpp).toContain('UdpClientHelper cbr_f1(Ipv4Address("10.1.0.2"), 502);');
    expect(r.cpp).toContain('cbr_f1.SetAttribute("MaxPackets", UintegerValue(0));');
    expect(r.cpp).toContain('cbr_f1.SetAttribute("Interval", TimeValue(Seconds(0.5)));');
    expect(r.cpp).toContain('cbr_f1.SetAttribute("PacketSize", UintegerValue(256));');
    expect(r.cpp).toContain('ApplicationContainer appC_f1 = cbr_f1.Install(n_ied1);');
    // Stop 必须与运行段同一仿真时长，否则客户端跑出仿真区间
    expect(r.cpp).toContain('appC_f1.Stop(Seconds(10));');
    // 反例：不得再退回「构造完即析构、从不 Install」的空壳写法
    expect(r.cpp).not.toContain('UdpEchoClientHelper');
    expect(r.cpp).not.toContain('(void)echoClient;');
  });

  it('目标节点无 SERVER 时退到占位端口，只告警不阻断导出', () => {
    const cfg = demoConfig();
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'rtu1', interval: 1 }];

    const r = generate(cfg);
    expect(r.ok).toBe(true); // 仅 warning
    expect(r.validation.warnings.some((w) => w.elementId === 'f1' && w.field === 'dst')).toBe(true);
    // l2: switch1 = 10.2.0.1 ↔ rtu1 = 10.2.0.2，rtu1 无 SERVER → 占位端口 9
    expect(r.cpp).toContain('UdpClientHelper cbr_f1(Ipv4Address("10.2.0.2"), 9);');
    expect(r.cpp).toContain('占位端口');
  });

  it('校验：CBR 间隔非正 / 载荷小于 12B 报 error（前者空转、后者 NS_ABORT）', () => {
    const cfg = demoConfig();
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'rtu1', interval: 0, payloadSize: 8 }];

    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.elementId === 'f1' && e.field === 'interval')).toBe(true);
    expect(r.validation.errors.some((e) => e.elementId === 'f1' && e.field === 'payloadSize')).toBe(true);
  });

  it('校验：载荷上限 65507B（ns-3 的 MakeUintegerChecker(12, 65507)），边界值合法', () => {
    const cfg = demoConfig();
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'rtu1', interval: 1, payloadSize: 65508 }];
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'payloadSize')).toBe(true);

    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'rtu1', interval: 1, payloadSize: 65507 }];
    expect(generate(cfg).ok).toBe(true);
  });

  it('校验：节点应用端口 0 或越界报 error（0 由系统随机分配，对端无从预知）', () => {
    const cfg = demoConfig();
    cfg.protocols = [];
    const sw = cfg.nodes.find((n) => n.id === 'switch1')!;

    sw.apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 0 }];
    expect(generate(cfg).validation.errors.some((e) => e.field === 'port')).toBe(true);

    sw.apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 70000 }];
    expect(generate(cfg).validation.errors.some((e) => e.field === 'port')).toBe(true);

    // uint16 上界合法
    sw.apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 65535 }];
    expect(generate(cfg).ok).toBe(true);
  });
});

describe('多链路可达性与运行参数', () => {
  it('多链路（各自独立 /30 网段）必须填充全局路由表；单链路不得输出该调用', () => {
    const multi = generate(demoConfig());
    expect(multi.ok).toBe(true);
    // 无路由表时，ied1 → rtu1 跨网段报文会被静默丢弃
    expect(multi.cpp).toContain('Ipv4GlobalRoutingHelper::PopulateRoutingTables();');

    const single = demoConfig();
    single.links = [single.links[0]];
    single.flows = [];
    single.halfPhysical = undefined;
    const r = generate(single);
    expect(r.ok).toBe(true);
    expect(r.cpp).not.toContain('PopulateRoutingTables');
  });

  it('OFFLINE 产物显式拒绝 --hil 并返回 2；HIL 产物不得带该拒绝段', () => {
    const offline = generate(demoConfig(), { mode: 'OFFLINE' });
    expect(offline.cpp).toContain('--hil 不生效');
    expect(offline.cpp).toContain('return 2;');

    const hil = generate(demoConfig(), { mode: 'HIL', clockSource: 'PTP' });
    expect(hil.cpp).not.toContain('--hil 不生效');
    expect(hil.cpp).toContain('保守步进闭环');
  });

  it('--precise 不再是死开关：头部注释随采样开关切换', () => {
    expect(generate(demoConfig()).cpp).toContain('采集：rough');
    expect(generate(demoConfig(), { precise: true }).cpp).toContain('采集：precise');
  });
});

describe('节点自定义 IP', () => {
  it('默认（不填 IP）：维持 10.<链路序号>.0.0/30，两端按 nodeA/nodeB 顺序拿 .1/.2', () => {
    const r = generate(demoConfig());
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.1.0.0"), Ipv4Mask("255.255.255.252"));');
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.2.0.0"), Ipv4Mask("255.255.255.252"));');
    // 设备顺序即 nodeA、nodeB
    expect(r.cpp.indexOf('linkNodes_l1.Add(n_ied1);')).toBeLessThan(r.cpp.indexOf('linkNodes_l1.Add(n_switch1);'));
  });

  it('节点填了 IP：网段跟着该地址走，未填的另一端取同网段剩下的地址', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.1';
    const r = generate(cfg);

    expect(r.ok).toBe(true);
    expect(r.validation.errors).toHaveLength(0);
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.9.0.0"), Ipv4Mask("255.255.255.252"));');
    // 自动分配出的地址不会以字面量形式出现，靠规划注释体现：另一端落到同网段的另一个可分配地址
    expect(r.cpp).toContain('n_ied1 = 10.9.0.1, n_switch1 = 10.9.0.2');
    // 另一条未自定义的链路保持原网段（以链路序号为起点找空位，不因别人改 IP 而整体重编号）
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.2.0.0"), Ipv4Mask("255.255.255.252"));');
  });

  it('填的是该网段较大的那个地址（.2）时，调换设备 Add 顺序，让 Assign 的升序分配正好对上', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.2';
    const r = generate(cfg);

    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.9.0.0"), Ipv4Mask("255.255.255.252"));');
    // Assign 只能按 base+1、base+2 升序发地址，故拿 .2 的 ied1 必须排在 switch1 之后
    expect(r.cpp.indexOf('linkNodes_l1.Add(n_switch1);')).toBeLessThan(r.cpp.indexOf('linkNodes_l1.Add(n_ied1);'));
    // 设备顺序与规划注释必须一致：switch1 先拿 .1，ied1 后拿 .2
    expect(r.cpp).toContain('// 按设备顺序分配: n_switch1 = 10.9.0.1, n_ied1 = 10.9.0.2');
  });

  it('节点应用与业务流的目标地址跟着自定义 IP 变（单一来源，不各算一套）', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'switch1')!.ip = '192.168.7.1';
    cfg.protocols = [];
    cfg.nodes.find((n) => n.id === 'switch1')!.apps = [{ id: 'a1', role: 'SERVER', protocol: 'MMS', port: 502 }];
    cfg.nodes.find((n) => n.id === 'ied1')!.apps = [
      { id: 'a2', role: 'CLIENT', protocol: 'MMS', port: 502, peer: 'switch1' },
    ];
    cfg.flows = [{ id: 'f1', type: 'CBR', src: 'ied1', dst: 'switch1', interval: 1, payloadSize: 512 }];

    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("192.168.7.0"), Ipv4Mask("255.255.255.252"));');
    // 客户端与 CBR 都发往 switch1 → 必须是 192.168.7.1
    expect(r.cpp).toContain('UdpClientHelper app_a2(Ipv4Address("192.168.7.1"), 502);');
    expect(r.cpp).toContain('UdpClientHelper cbr_f1(Ipv4Address("192.168.7.1"), 502);');
    expect(r.cpp).not.toContain('10.1.0.2');
  });

  it('校验：IP 格式非法报 error', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.256';
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.elementId === 'ied1' && e.field === 'ip')).toBe(true);
  });

  it('校验：IP 落在 /30 的网络号或广播号上报 error（这两种地址分配不了）', () => {
    const cfg = demoConfig();
    // 10.9.0.0 是网段基址本身
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.0';
    let r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'ip' && e.message.includes('网络号'))).toBe(true);

    // 10.9.0.3 是 /30 的广播号
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.3';
    r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.field === 'ip' && e.message.includes('广播号'))).toBe(true);
  });

  it('校验：同链路两端 IP 不在同一 /30 报 error（二层通但三层不通）', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.1';
    cfg.nodes.find((n) => n.id === 'switch1')!.ip = '10.7.0.1';
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.message.includes('不在同一 /30 网段'))).toBe(true);
  });

  it('校验：同链路两端填了同一个地址报 error', () => {
    const cfg = demoConfig();
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.1';
    cfg.nodes.find((n) => n.id === 'switch1')!.ip = '10.9.0.1';
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.message.includes('同一 /30 内地址必须互异'))).toBe(true);
  });

  it('校验：两条链路撞同一 /30 报 error（一个 /30 只够一条点对点链路的两端）', () => {
    const cfg = demoConfig();
    // l1: ied1↔switch1 与 l2: switch1↔rtu1 都落到 10.9.0.0/30
    cfg.nodes.find((n) => n.id === 'ied1')!.ip = '10.9.0.1';
    cfg.nodes.find((n) => n.id === 'rtu1')!.ip = '10.9.0.1';
    const r = generate(cfg);
    expect(r.ok).toBe(false);
    expect(r.validation.errors.some((e) => e.message.includes('落在同一 /30 网段'))).toBe(true);
  });

  it('节点挂多条链路时，IP 只作用于它参与的第一条链路', () => {
    const cfg = demoConfig();
    // ied1 只在 l1 上；switch1 同时在 l1、l2 上，它的 ip 应只影响 l1
    cfg.nodes.find((n) => n.id === 'switch1')!.ip = '10.9.0.1';
    const r = generate(cfg);

    expect(r.ok).toBe(true);
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.9.0.0"), Ipv4Mask("255.255.255.252"));');
    // l2 仍按自动规划：switch1 在 l2 上的接口拿 10.2.0.1（不是 10.9.0.1），rtu1 拿 10.2.0.2
    expect(r.cpp).toContain('ipv4.SetBase(Ipv4Address("10.2.0.0"), Ipv4Mask("255.255.255.252"));');
    expect(r.cpp).toContain('n_switch1 = 10.2.0.1, n_rtu1 = 10.2.0.2');
  });
});

describe('半实物段按需装配', () => {
  it('未配 taps 也无物理网口时：不输出空半实物段、不报网口告警', () => {
    const cfg = demoConfig();
    cfg.halfPhysical = { taps: [], physicalNic: '' };

    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.cpp).not.toContain('半实物接入');
    expect(r.validation.warnings.some((w) => w.field === 'physicalNic')).toBe(false);
  });

  it('但节点标了 physical 却无 tap 映射时仍要告警（该检查不得被半实物段守卫连带关掉）', () => {
    const cfg = demoConfig();
    cfg.halfPhysical = undefined; // 用户压根没打开半实物配置

    const r = generate(cfg);
    expect(r.ok).toBe(true);
    expect(r.validation.warnings.some((w) => w.elementId === 'rtu1' && w.field === 'physical')).toBe(true);
  });
});
