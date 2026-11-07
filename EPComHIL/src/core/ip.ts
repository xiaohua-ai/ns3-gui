// IPv4 地址原子操作（core 层，模型校验与生成器共用，避免两处各写一套解析）
//
// 本项目的链路地址模型是「每条链路独占一个 /30 网段，两端各占一个主机地址」。
// /30 里可用主机地址只有 2 个（偏移 1 与 2），正好容纳点对点两端；
// 偏移 0 是网络号、偏移 3 是广播号，都不能分配给接口。
// 因此这里只提供 /30 相关的原子操作，不做通用子网计算。

/** 链路网段掩码（/30） */
export const LINK_MASK = '255.255.255.252';

/** /30 内可分配给接口的主机偏移（0=网络号、3=广播号，均不可用） */
export const HOST_OFFSETS: readonly number[] = [1, 2];

/** 解析点分十进制 IPv4 → 32 位无符号整数；非法返回 null */
export function parseIpv4(input: string | undefined | null): number | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    // 拒绝前导 0：部分解析器把 010 当八进制，会出现「所见非所得」
    if (p.length > 1 && p.startsWith('0')) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** 32 位无符号整数 → 点分十进制 */
export function formatIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** 四个八位组 → 32 位无符号整数（避开字符串回环，也不需要做合法性检查） */
export function makeIpv4(a: number, b: number, c: number, d: number): number {
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/** 该地址所在 /30 网段的基址（网络号） */
export function subnetBaseOf(value: number): number {
  return value & ~3;
}

/** 该地址在所属 /30 内的主机偏移：0=网络号、1/2=可用、3=广播号 */
export function hostOffsetOf(value: number): number {
  return value & 3;
}

/** 该地址是否可作为接口地址分配（偏移落在 1 或 2） */
export function isAssignableHost(value: number): boolean {
  return HOST_OFFSETS.includes(hostOffsetOf(value));
}
