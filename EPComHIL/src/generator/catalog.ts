// 从工程配置构建元素实例集合（对象模型装配）
import type { ProjectConfig } from '../core/types';
import { NodeElement } from '../core/model/NodeElement';
import { LinkElement } from '../core/model/LinkElement';
import { ProtocolElement } from '../core/model/ProtocolElement';
import { FlowElement } from '../core/model/FlowElement';
import { FaultElement } from '../core/model/FaultElement';
import { HalfPhysicalElement } from '../core/model/HalfPhysicalElement';

export interface ElementCatalog {
  nodes: NodeElement[];
  links: LinkElement[];
  protocols: ProtocolElement[];
  flows: FlowElement[];
  faults: FaultElement[];
  halfPhysical: HalfPhysicalElement[];
}

export function buildCatalog(config: ProjectConfig): ElementCatalog {
  return {
    nodes: (config.nodes ?? []).map((n) => new NodeElement(n)),
    links: (config.links ?? []).map((l) => new LinkElement(l)),
    protocols: (config.protocols ?? []).map((p) => new ProtocolElement(p)),
    flows: (config.flows ?? []).map((f) => new FlowElement(f)),
    faults: (config.faults ?? []).map((f) => new FaultElement(f)),
    halfPhysical: hasHalfPhysicalConfig(config.halfPhysical) ? [new HalfPhysicalElement(config.halfPhysical!)] : [],
  };
}

/**
 * 半实物段只在「确实配了点什么」时才装配。
 * blankProject 恒写 { taps: [], physicalNic: '' }，若无条件装配，
 * 每个工程产物都会带一段"共 0 个真实终端"的空注释，并恒产生一条「未配置物理网口」告警。
 */
function hasHalfPhysicalConfig(cfg: ProjectConfig['halfPhysical']): boolean {
  if (!cfg) return false;
  return (cfg.taps?.length ?? 0) > 0 || Boolean(cfg.physicalNic && cfg.physicalNic.trim() !== '');
}