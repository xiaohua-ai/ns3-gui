// 故障元素：ns-3 ErrorModel / DelayModel 注入（架构 4.3 ~ 故障注入引擎）
import type { IGenElement, GenerationContext } from '../IGenElement';
import type { FaultConfig, ElementKind, ValidationIssue } from '../types';

const FAULT_LABEL: Record<string, string> = {
  'error-model': 'ErrorModel(误码)',
  'delay-model': 'DelayModel(时延)',
  drop: 'Drop(丢包)',
};

export class FaultElement implements IGenElement<FaultConfig> {
  readonly kind: ElementKind = 'fault';
  constructor(public config: FaultConfig) {}
  get id() {
    return this.config.id;
  }
  get label() {
    return `${FAULT_LABEL[this.config.kind] ?? this.config.kind} @ ${this.config.linkId ?? this.config.nodeId}`;
  }

  validate(ctx: GenerationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (this.config.endTime <= this.config.startTime) {
      issues.push({ severity: 'error', elementId: this.id, field: 'endTime', message: `故障结束时间需晚于开始时间` });
    }
    if (!this.config.linkId && !this.config.nodeId) {
      issues.push({ severity: 'error', elementId: this.id, field: 'target', message: '故障需绑定链路或节点' });
    }
    if (this.config.linkId && !ctx.linkVar(this.config.linkId)) {
      issues.push({ severity: 'warning', elementId: this.id, field: 'linkId', message: `目标链路不存在: ${this.config.linkId}（警告，未绑定生效）` });
    }
    return issues;
  }

  toCode(ctx: GenerationContext): string {
    void ctx;
    const lines: string[] = [];
    lines.push(`  // [故障/${FAULT_LABEL[this.config.kind]}] ${this.desc()} (${this.config.startTime}s → ${this.config.endTime}s)`);
    lines.push(`  //   经 ns-3 ErrorModel/DelayModel 插件化注入，可由插件扩展更多故障/攻击模式。`);
    return lines.join('\n');
  }

  private desc(): string {
    if (this.config.linkId) return `链路 ${this.config.linkId}`;
    return `节点 ${this.config.nodeId}`;
  }

  forSettings() {
    return { ...this.config };
  }
}