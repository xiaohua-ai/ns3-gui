// 半实物接入元素：虚拟网卡 → 模型内节点 一一映射，Linux 单一物理网口汇聚（架构 4.3）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { HalfPhysicalConfig, ElementKind, ValidationIssue } from '../types';
import { cppLiteral } from '../cppText';

export class HalfPhysicalElement implements IGenElement<HalfPhysicalConfig> {
  readonly kind: ElementKind = 'halfphysical';
  constructor(public config: HalfPhysicalConfig) {}
  get id() {
    return 'halfphysical';
  }
  get label() {
    return `半实物接入 · ${(this.config.taps ?? []).length} 终端 · 单网口 ${this.config.physicalNic || '-'}`;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const t of this.config.taps ?? []) {
      if (!ctx.resolveEndpoint(t.nodeId)) {
        issues.push({ severity: 'error', elementId: this.id, field: 'taps', message: `半实物映射到不存在的模型内节点: ${t.nodeId}` });
        continue;
      }
      if (!t.tapName || t.tapName.trim() === '') {
        issues.push({ severity: 'error', elementId: this.id, field: 'taps', message: 'tap 虚拟网卡名不能为空' });
      }
      // 被桥接的设备必须 SupportsSendFrom()——TapBridge 在 UseBridge 模式下的硬前置条件
      // （ns-3.38 tap-bridge.cc:953 `if (m_mode == USE_BRIDGE && !bridgedDevice->SupportsSendFrom())
      //   NS_FATAL_ERROR(...)`）。全树里只有 CsmaNetDevice 返回 true，PointToPointNetDevice 恒 false。
      // 注意这与"能不能编译"无关：桥 p2p 设备编译完全通过，崩在 TapBridgeHelper::Install
      // （装载期，远早于 Simulator::Run），日志只有一行且不指名是哪个节点，故必须在此拦住。
      // 档位随导出模式走（只校验会发射的东西）：OFFLINE 产物里这一段只有注释、不装配 TapBridge，
      // 故只提示不阻断；HIL 导出会真的落地 TapBridgeHelper::Install，必须在导出前就拦住。
      if (!ctx.bridgeDeviceRef(t.nodeId)) {
        issues.push({
          severity: ctx.hilEnabled ? 'error' : 'warning',
          elementId: this.id,
          field: 'taps',
          message:
            `半实物节点 ${t.nodeId} 上没有可桥接的网络设备：TapBridge（UseBridge）要求设备 SupportsSendFrom()，` +
            `ns-3.38 里只有 CSMA 设备满足（点对点 PointToPoint 恒为 false，桥它会在装载期直接 abort）。` +
            (ctx.hilEnabled ? '请为该节点增挂一条 CSMA 链路。' : 'HIL 导出前请为该节点增挂一条 CSMA 链路。'),
        });
      }
    }
    if (!this.config.physicalNic) {
      issues.push({ severity: 'warning', elementId: this.id, field: 'physicalNic', message: '未配置 Linux 物理网口，建议指定单一汇聚网口' });
    }
    return issues;
  }

  toCode(ctx: GenerationContext): string {
    const lines: string[] = [];
    const taps = this.config.taps ?? [];
    if (ctx.hilEnabled && taps.length) {
      // HIL 半实物装载段：每个真实终端经 TapBridge 桥入其所在的一级网络设备（UseBridge）。
      // TapBridge 把仿真侧设备与 Linux 侧 tap 虚拟网卡在二层桥接，真实设备流量经 tap 进出 ns-3。
      // 整段收在 if (hil) 内：与 HIL 注入段共用同一开关（HIL 导出时 hil 缺省为 true，可用 --hil=0
      // 关掉半实物做纯离线冒烟）。UseBridge 要求 Linux 侧 tap 已存在（tap-creator 以 TUNSETIFF
      // 绑定该名字，未建则新建但**不**配置 IP/UP），故实际链路需外部先建好 tap 并汇入物理网口。
      ctx.addInclude('ns3/tap-bridge-module.h');
      const physNic = this.config.physicalNic || '(未指定)';
      lines.push(`  if (hil) {`);
      lines.push(`    // [半实物接入] ${taps.length} 个真实终端经 TapBridge 桥接 · Linux 单物理网口 ${physNic} 汇聚`);
      taps.forEach((t, i) => {
        const node = ctx.nodeVar(t.nodeId);
        // 桥接设备由上下文从 CSMA 链路里取，并用「设备容器 + 下标」精确定位。
        // 不能用 node->GetDevice(0)：它拿的是"先装的那块"，与链路类型无关 —— 一旦第 0 号是 p2p
        // 设备，TapBridgeHelper::Install 会在装载期 NS_FATAL_ERROR 直接 abort（编译期查不出来）。
        const dev = ctx.bridgeDeviceRef(t.nodeId);
        if (!dev) {
          // 校验已把这种工程判为 error；此处不静默桥错设备，也不产出不可编译的语句。
          lines.push(`    // TODO 节点 ${t.nodeId} 无支持 SendFrom 的可桥接设备（需 CSMA 链路），TapBridge 未装配`);
          lines.push(`    std::cerr << "[半实物] 节点 ${t.nodeId} 无支持 SendFrom 的可桥接设备，跳过 tap ${t.tapName}。" << std::endl;`);
          return;
        }
        lines.push(`    {`);
        lines.push(`      TapBridgeHelper tapBridge${i};`);
        lines.push(`      tapBridge${i}.SetAttribute("Mode", StringValue("UseBridge"));`);
        lines.push(`      tapBridge${i}.SetAttribute("DeviceName", StringValue("${t.tapName}"));`);
        // 兜底断言：把「装载期一行无主日志的 abort」换成指名到节点的可读报错（手工改产物时也有用）
        lines.push(`      NS_ABORT_MSG_UNLESS(${dev}->SupportsSendFrom(), "半实物节点 ${t.nodeId} 的桥接设备不支持 SendFrom：UseBridge 要求 CSMA 类设备");`);
        lines.push(`      tapBridge${i}.Install(${node}, ${dev});`);
        // [EPC-TAP] 通道遥测：把桥接设备的二层收发计数接进 Runtime 监视台。
        // 计数器为「函数内 static」——静态存储期保证 trace 回调持有的地址在块退出后依然有效
        // （普通局部量会悬垂，运行期读到的就是野内存）。计数挂点与语义见 telemetry.ts 的说明。
        lines.push(`      static EpcTapCounter epcTap${i};`);
        lines.push(`      epcTap${i}.tap = "${cppLiteral(t.tapName)}";`);
        lines.push(`      ${dev}->TraceConnectWithoutContext("MacTx", MakeBoundCallback(&EpcTapRx, &epcTap${i}));`);
        lines.push(`      ${dev}->TraceConnectWithoutContext("MacRx", MakeBoundCallback(&EpcTapTx, &epcTap${i}));`);
        lines.push(`      EpcTapTick(&epcTap${i}, ${ctx.telemetryPeriodMs});`);
        lines.push(`    }`);
      });
      lines.push(`    //   实物流：tap/${taps.map((t) => t.tapName).join(',')} ↔ 模型内节点（二层桥，独立于 IP 规划）`);
      lines.push(`    //   运行前置（缺一不可，否则运行期直接 abort）：`);
      lines.push(`    //     1) Linux 端先建好 tap 并【置 UP】：ip tuntap add dev <tap名> mode tap && ip link set <tap名> up`);
      lines.push(`    //        UseBridge 下 tap-creator 只做 TUNSETIFF 绑定，既不配 IP 也不 UP；`);
      lines.push(`    //        往 DOWN 的 tap 写会 ENETDOWN → TapBridge::ReceiveFromBridgedDevice 写失败 → NS_ABORT。`);
      lines.push(`    //     2) 这些 tap 需汇入同一 Linux 网桥并接上物理网口 ${physNic}（带 MAC 过滤 + VLAN 划分），网口进混杂模式。`);
      lines.push(`    //   语义：被桥接设备的入向报文不再进 ns-3 的 IP 栈（普通接收被丢弃、混杂接收转写 tap），`);
      lines.push(`    //        由 ns-3 之外的【真实终端】接管 —— 这正是"半实物"的定义，故该节点上再挂仿真应用是自相矛盾的。`);
      lines.push(`  }`);
    } else {
      lines.push(`  // [半实物接入] 共 ${taps.length} 个真实终端经单一物理网口 ${this.config.physicalNic || '-'} 汇聚`);
      for (const t of taps) {
        lines.push(`  //   tap=${t.tapName} → 模型内节点 ${t.nodeId} (MAC ${t.mac ?? '-'})`);
      }
      lines.push(`  //   虚拟网卡分配与节点一一映射由上位机侧配置下发（见 4.3 半实物接入机制）。`);
      lines.push(`  //   以 HIL 模式导出时，此处将落地为可执行的 TapBridge（UseBridge）装载段。`);
    }
    return lines.join('\n');
  }

  forSettings() {
    return { ...this.config };
  }
}
