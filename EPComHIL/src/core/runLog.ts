// 运行日志的行模型：一行一记录，**自带时间刻度**。
//
// —— 为什么把时间做进数据模型，而不是在组件里给每行拼个前缀 ——
// 判断一次运行"是否真的按墙钟跑满"（REALTIME / HIL）唯一可靠的线索，就是阶段行之间的间隔。
// 聚合耗时（"11.9s"）把连接/上传/构建/运行揉成一个数，要拆开就得先摸清同机构建基线再反推
// （见 IMPLEMENTATION_PLAN §6.7）—— 那是**读数技巧**，不是日志该有的样子。
// 逐行打戳之后，`[running] +2.40s` 到 `[done] +12.70s` 直接就是答案：日志自己说话。
//
// —— 两个刻度，各有用途，不要合并 ——
//   atMs —— 该行到达的墙钟时刻(epoch ms)。**正文展示的是它**：`16:12:12`（formatClockTime）。
//           日志要回答的第一个问题是"这次运行是什么时候发生的"，只有绝对时刻答得了；
//           相对值出了这一次会话就没有参照系了。
//   tMs  —— 距本次运行开始（用户按下「运行」那一刻）的毫秒数。降级为 title 悬停里的
//           `运行后 +12.01s`：同一次会话内部看阶段间隔更直观，但它无法跨会话比对。
//
//   正文用**秒级**（`HH:MM:SS`）是有意的：实时与否看的是阶段行**之间**的差
//   （`16:12:02` → `16:12:12` 就是 10s），秒级足够，且恒定宽度便于竖排对齐；
//   亚秒精度不丢，留在 title 的完整戳（formatClockStamp，含日期与毫秒）与 tMs 字段上。
//
// —— 分辨率上限（诚实声明）——
// tMs 量的是**到达时刻**，不是"该行被产生出来的时刻"：cmake / ns-3 逐块吐输出，
// 一块可能含多行，同一块内的行共享同一个到达时刻。不去假装精确到行。
// 之所以可用到达时刻近似产生时刻：这条 SSH 流式通道**不会攒批**——HIL 实测十条节拍
// 每条间隔精确 1000ms 地到达（见 IMPLEMENTATION_PLAN §6.6），说明通道是逐块透传的；
// 反之若真发生整段缓冲，UI 早就肉眼可见地卡死了，不会静默偏掉。
// 用**单一时间原点 + 单一时钟**（而不是让主进程各自打戳）是有意的：混用两个原点后，
// 不同来源的行之间不再可比 —— 而"行与行之间的差"恰恰是这套刻度唯一要回答的问题。
//
// 纯函数风格：不碰 IO、不依赖 DOM，可单测。

/**
 * 运行日志的一行。
 */
export interface RunLogLine {
  /**
   * 稳定序号（append-only 单调递增；裁掉头部也不回退）。
   * 直接用作列表渲染的 key：日志是"尾部追加 + 头部裁剪"的结构，
   * 用数组下标做 key 会在裁剪时让 DOM 节点与内容错位。
   */
  seq: number;
  /** 距本次运行开始的毫秒数（展示用） */
  tMs: number;
  /** 该行到达的墙钟时刻（epoch ms，悬停查看绝对时间用） */
  atMs: number;
  /** 原始文本，**原样保留**（构建输出里的缩进有意义，不做 trim） */
  text: string;
}

/** 运行日志裁剪上限：构建输出可能很长，只留尾部（1000 万行的日志没人看得完，还会拖慢渲染） */
export const RUN_LOG_MAX = 500;

/**
 * 不进运行日志的行：遥测行与逐包行已经在组件里可视化了，
 * 再往日志里灌一遍只会把真正的编译错误淹掉 —— 日志的价值在于"出问题时能一眼看到原因"。
 * 前缀与本仓遥测协议同源，见 src/core/simOutput.ts 的 EPC_PREFIX。
 */
export const RUN_LOG_NOISE = /\[EPC-|◆Rx/;

/**
 * 相对时间标签，如 `+6.03s`。
 *
 * 单位与精度**恒定**：只用秒、固定两位小数，不做 `mm:ss` 混排、也不按时长切换精度。
 * 理由：竖排日志里小数点对齐才能一眼比出量级、才好 grep"哪一段吃掉了时间"；
 * 一旦按时长切换小数位，59.99s 与 60.0s 这类边界会突然少一位，反而更难扫。
 * 负数/非有限值一律按 0 处理 —— 时间标签乱掉比没有更糟（会让人开始怀疑日志本身）。
 */
export function formatRelTime(tMs: number): string {
  const ms = Number.isFinite(tMs) && tMs > 0 ? tMs : 0;
  return `+${(ms / 1000).toFixed(2)}s`;
}

/**
 * 正文时间标签，如 `16:12:12`（本地时区的 `时:分:秒`）。
 *
 * 取的是"该时刻所处的秒"（`getSeconds()` 天然向下截断，不做四舍五入）——
 * 例如 `16:12:12.999` 显示为 `16:12:12`。若改成四舍五入，末尾会凭空跳出一秒，
 * 与 title 里带毫秒的完整戳对不上，反而让人怀疑日志。
 *
 * 单位与宽度恒定（恒 8 字符）：竖排时数字位对齐，一眼比得出量级，
 * 也才好 grep"哪一段吃掉了时间"。非法值一律按 epoch 0 处理 ——
 * 时间标签乱掉比没有更糟（会让人开始怀疑日志本身）。
 */
export function formatClockTime(atMs: number): string {
  const d = new Date(Number.isFinite(atMs) ? atMs : 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 完整时间戳，如 `2026-09-20 16:12:12.318`（本地时区）。
 * 供 title 悬停：带上**日期**与毫秒，跨天/跨机对照日志时才有唯一坐标
 * （正文的 `HH:MM:SS` 没有日期，两条不同天的日志看起来会长得一样）。
 */
export function formatClockStamp(atMs: number): string {
  const d = new Date(Number.isFinite(atMs) ? atMs : 0);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${ymd} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export interface AppendRunLogOptions {
  /** 这一批输出**到达**的时刻 */
  atMs: number;
  /** 本次运行的时间原点（用户按下「运行」那一刻） */
  epochMs: number;
  /** 上限，默认 RUN_LOG_MAX */
  cap?: number;
  /** 噪声过滤；传 null 关闭（需要全量日志的场合） */
  drop?: RegExp | null;
}

/**
 * 把一段原始输出并入运行日志：按行拆 → 过滤 → 打戳 → 追加 → 裁剪尾部。
 *
 * 返回**新数组**（store 靠重新赋值触发响应）；无有效行时原样返回同一个引用，
 * 避免空更新触发一轮无关渲染。
 */
export function appendRunLog(
  current: RunLogLine[],
  incoming: string | string[],
  opts: AppendRunLogOptions,
): RunLogLine[] {
  const { atMs, epochMs, cap = RUN_LOG_MAX, drop = RUN_LOG_NOISE } = opts;
  const raw = Array.isArray(incoming) ? incoming : [incoming];
  const keep = raw.filter((l) => (typeof l === 'string' ? l.trim() : l) && !(drop && drop.test(l)));
  if (!keep.length) return current;

  const tMs = Math.max(0, atMs - epochMs);
  let seq = current.length ? current[current.length - 1].seq + 1 : 0;
  const added: RunLogLine[] = keep.map((text) => ({ seq: seq++, tMs, atMs, text }));
  const next = current.concat(added);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
