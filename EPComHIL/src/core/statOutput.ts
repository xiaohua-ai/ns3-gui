// 统计输出项：建模组件（节点/链路）可选配的 ns-3 运行统计指标。
// 配置经工程文件序列化（nodes[*].stats / links[*].stats），导出时由生成器据此落地统计输出段。

/** 可选择的统计输出项 key */
export type StatKey =
  | 'tx_packets' // 发送包数
  | 'rx_packets' // 接收包数
  | 'tx_bytes' // 发送字节数
  | 'rx_bytes' // 接收字节数
  | 'lost_packets' // 丢包数
  | 'pdr' // 投递率 PDR(%)
  | 'delay_mean' // 平均时延(s)
  | 'delay_jitter'; // 时延抖动(s)

export interface StatOutputSpec {
  key: StatKey;
  label: string;
}

/** 供 UI 目录渲染的完整输出项（节点/链路通用） */
export const STAT_OUTPUTS: StatOutputSpec[] = [
  { key: 'tx_packets', label: '发送包数' },
  { key: 'rx_packets', label: '接收包数' },
  { key: 'tx_bytes', label: '发送字节数' },
  { key: 'rx_bytes', label: '接收字节数' },
  { key: 'lost_packets', label: '丢包数' },
  { key: 'pdr', label: '投递率 PDR(%)' },
  { key: 'delay_mean', label: '平均时延(s)' },
  { key: 'delay_jitter', label: '时延抖动(s)' },
];

export const STAT_KEYS: readonly StatKey[] = STAT_OUTPUTS.map((s) => s.key);

/** 判断是否为合法统计项 key */
export function isStatKey(v: unknown): v is StatKey {
  return typeof v === 'string' && (STAT_KEYS as readonly string[]).includes(v as StatKey);
}

/** 清洗原始 stats 值：仅保留合法 key、去重，返回 sanitize 后的数组；无有效项返回 undefined */
export function sanitizeStats(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const k of raw) if (isStatKey(k) && !out.includes(k)) out.push(k);
  return out.length ? out : undefined;
}

/** 将多组 stats 并集，固定按 STAT_KEYS 目录顺序返回（供生成器确定输出列） */
export function unionStats(arrays: (string[] | undefined)[]): StatKey[] {
  const set = new Set<StatKey>();
  for (const arr of arrays) if (arr) for (const k of arr) if (isStatKey(k)) set.add(k);
  return STAT_KEYS.filter((k) => set.has(k));
}