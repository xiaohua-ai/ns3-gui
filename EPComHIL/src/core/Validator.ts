// W6 校验器：整体一致性校验 + 逐元素校验，error 级阻断导出（架构 7.6）
import type { IGenElement } from './IGenElement';
import type { GenerationContext } from './IGenElement';
import type {
  ValidationIssue,
  NodeConfig,
  ProtocolConfig,
  FlowConfig,
  HalfPhysicalConfig,
} from './types';

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * 把另一处算出来的问题并入校验结果。
 * IP 规划这类问题只有把整个工程的地址都算完才看得出来，无法在单元素 validate 里产出，
 * 所以由 generate() 统一并入，保证「预览/导出阻断」的判据只有一个来源。
 */
export function mergeIssues(result: ValidationResult, extra: ValidationIssue[]): ValidationResult {
  if (extra.length === 0) return result;
  const errors = [...result.errors, ...extra.filter((i) => i.severity === 'error')];
  const warnings = [...result.warnings, ...extra.filter((i) => i.severity === 'warning')];
  return { ok: errors.length === 0, errors, warnings };
}

/** 节点 id 唯一性、链路端点存在性 等整体校验 + 逐元素校验 */
export function validateProject(elements: IGenElement[], ctx: GenerationContext): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 节点 id 唯一性
  const nodes = elements.filter((e): e is IGenElement<NodeConfig> => e.kind === 'node');
  const nodeIds = nodes.map((e) => e.id);
  const seen = new Set<string>();
  for (const nid of nodeIds) {
    if (seen.has(nid)) errors.push({ severity: 'error', elementId: nid, field: 'id', message: `节点 id 重复: ${nid}` });
    seen.add(nid);
  }

  // 链路 id 唯一性 + 端点引用
  const links = elements.filter((e) => e.kind === 'link');
  const linkIds = new Set<string>();
  for (const l of links) {
    if (linkIds.has(l.id)) errors.push({ severity: 'error', elementId: l.id, field: 'id', message: `链路 id 重复: ${l.id}` });
    linkIds.add(l.id);
  }

  // ---- 协议：跨元素冲突检查（单个元素内看不到其他协议）----
  const protocols = elements.filter((e): e is IGenElement<ProtocolConfig> => e.kind === 'protocol');
  const portOwner = new Map<string, string>(); // nodeId|port → 协议 id
  const appIdOwner = new Map<string, string>(); // nodeId|appId → 协议 id
  const loadOwner = new Map<string, string>(); // nodeId|layer|type → 协议 id
  for (const p of protocols) {
    const c = p.config;
    if (!c.nodeId) continue;

    const loadKey = `${c.nodeId}|${c.layer}|${c.type}`;
    const loadPrev = loadOwner.get(loadKey);
    if (loadPrev) {
      warnings.push({
        severity: 'warning',
        elementId: p.id,
        field: 'type',
        message: `节点 ${c.nodeId} 上重复装载 ${c.layer}/${c.type}（与 ${loadPrev} 重复）`,
      });
    } else {
      loadOwner.set(loadKey, p.id);
    }

    if (c.layer === 'L3') {
      const port = c.localPort ?? 102;
      const key = `${c.nodeId}|${port}`;
      const prev = portOwner.get(key);
      if (prev) {
        errors.push({
          severity: 'error',
          elementId: p.id,
          field: 'localPort',
          message: `节点 ${c.nodeId} 本地端口 ${port} 已被协议 ${prev} 占用`,
        });
      } else {
        portOwner.set(key, p.id);
      }
    } else if (c.layer === 'L2' && c.appId !== undefined) {
      const key = `${c.nodeId}|${c.appId}`;
      const prev = appIdOwner.get(key);
      if (prev) {
        warnings.push({
          severity: 'warning',
          elementId: p.id,
          field: 'appId',
          message: `节点 ${c.nodeId} 上 GOOSE appId ${c.appId} 与协议 ${prev} 重复`,
        });
      } else {
        appIdOwner.set(key, p.id);
      }
    }
  }

  // ---- 业务流：protocolRef 引用有效性 + 承载关系合理性 ----
  const protoIds = new Map(protocols.map((p) => [p.id, p.config]));
  const flows = elements.filter((e): e is IGenElement<FlowConfig> => e.kind === 'flow');
  for (const f of flows) {
    const ref = f.config.protocolRef;
    if (!ref) continue;
    const bound = protoIds.get(ref);
    if (!bound) {
      errors.push({
        severity: 'error',
        elementId: f.id,
        field: 'protocolRef',
        message: `业务流引用的协议不存在: ${ref}`,
      });
      continue;
    }
    if (bound.nodeId !== f.config.src && bound.nodeId !== f.config.dst) {
      warnings.push({
        severity: 'warning',
        elementId: f.id,
        field: 'protocolRef',
        message: `引用的协议 ${ref} 未挂在业务流两端节点（${f.config.src} / ${f.config.dst}）上`,
      });
    }
  }

  // ---- 半实物：节点实物标记 ↔ tap 映射 一致性 ----
  // 注意：本检查**不**依赖半实物元素是否存在 —— catalog 只在确实配了 taps/物理网口时才装配该元素，
  // 若把检查放进 `if (half)`，一个标了 physical 却从没打开半实物配置的工程会一声不吭地通过校验。
  const half = elements.find((e): e is IGenElement<HalfPhysicalConfig> => e.kind === 'halfphysical');
  const mapped = new Set((half?.config.taps ?? []).map((t) => t.nodeId));
  for (const n of nodes) {
    if (n.config.physical && !mapped.has(n.id)) {
      warnings.push({
        severity: 'warning',
        elementId: n.id,
        field: 'physical',
        message: '节点标记为实物模式，但半实物接入中未提供对应 tap 映射',
      });
    }
  }

  // 逐元素校验
  for (const e of elements) {
    for (const issue of e.validate(ctx)) {
      (issue.severity === 'error' ? errors : warnings).push(issue);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
