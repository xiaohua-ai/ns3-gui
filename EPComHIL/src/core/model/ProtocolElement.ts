// 协议元素：L3（MMS/Modbus TCP 走 Socket）与 L2（GOOSE 走二层帧）两套生成路径（架构 7.4）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { ProtocolConfig, ElementKind, ValidationIssue } from '../types';

const L3_PROTO: Record<string, string> = { MMS: 'MMS', MODBUS_TCP: 'Modbus/TCP' };

export class ProtocolElement implements IGenElement<ProtocolConfig> {
  readonly kind: ElementKind = 'protocol';
  constructor(public config: ProtocolConfig) {}
  get id() {
    return this.config.id;
  }
  get label() {
    return `${this.config.type} @ ${this.config.nodeId}`;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!ctx.resolveEndpoint(this.config.nodeId)) {
      issues.push({ severity: 'error', elementId: this.id, field: 'nodeId', message: `协议归属节点不存在: ${this.config.nodeId}` });
    }
    if (this.config.layer === 'L2') {
      if (this.config.type !== 'GOOSE') issues.push({ severity: 'warning', elementId: this.id, field: 'type', message: 'L2 层通常承载 GOOSE，当前类型非 GOOSE' });
      if (this.config.appId === undefined) issues.push({ severity: 'error', elementId: this.id, field: 'appId', message: 'GOOSE 需要 appId' });
    } else if (this.config.layer === 'L3') {
      if (!L3_PROTO[this.config.type] && this.config.type !== 'CUSTOM') {
        issues.push({ severity: 'warning', elementId: this.id, field: 'type', message: '该 L3 协议未内置生成模板，将输出占位段' });
      }
    } else {
      issues.push({ severity: 'error', elementId: this.id, field: 'layer', message: 'layer 必须为 L3 或 L2' });
    }
    return issues;
  }

  toCode(ctx: GenerationContext): string {
    const nodeVar = ctx.nodeVar(this.config.nodeId);
    if (this.config.layer === 'L2') {
      // GOOSE：二层帧（EtherType 0x88B8），不进入 IP/端口。
      const lines: string[] = [];
      lines.push(`  // [L2/GOOSE] 节点 ${this.config.nodeId} 周期性发布 GOOSE`);
      lines.push(`  //   appId=${this.config.appId ?? '-'} vlanId=${this.config.vlanId ?? '-'}`);
      lines.push(`  //   在自定义 Intel774 之上构造 Ethernet 帧（EtherType 0x88B8），不分配 IP 与端口；`);
      lines.push(`  //   由后续电力协议插件/二层生成路径落地（当前为占位段）。`);
      void nodeVar;
      return lines.join('\n');
    }
    // L3：MMS / Modbus TCP / CUSTOM —— 挂 Socket，端口分配。
    const protoName = L3_PROTO[this.config.type] ?? this.config.type;
    const port = this.config.localPort ?? 102;
    const lines: string[] = [];
    lines.push(`  // [L3/${protoName}] 节点 ${this.config.nodeId} 本地端口 ${port}`);
    lines.push(`  //   通过 ${nodeVar} 上的 Udp/Tcp Socket 承载业务流（见业务流生成段）。`);
    return lines.join('\n');
  }

  forSettings() {
    return { ...this.config };
  }
}