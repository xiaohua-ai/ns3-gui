// 运行日志的行模型回归：打戳、过滤、裁剪，以及**最要紧的那条契约** ——
// 这份日志能不能自己回答「[running] 到 [done] 究竟隔了多久」。
//
// 由来：此前日志行是裸字符串，聚合耗时（"11.9s"）把连接/上传/构建/运行揉成一个数，
// 要判断一次运行是否真的按墙钟跑满，只能先在仿真机上摸清构建基线再反推
// （见 IMPLEMENTATION_PLAN §6.7 的那套读法）。逐行打戳之后，答案应当直接躺在日志里。
import { describe, it, expect } from 'vitest';
import {
  appendRunLog,
  formatRelTime,
  formatClockTime,
  formatClockStamp,
  RUN_LOG_MAX,
  RUN_LOG_NOISE,
  type RunLogLine,
} from '@core/runLog';
import { EPC_PREFIX } from '@core/simOutput';

function stamp(cur: RunLogLine[], incoming: string | string[], atMs: number, epochMs = 0, cap?: number) {
  return appendRunLog(cur, incoming, { atMs, epochMs, cap });
}

describe('runLog：时间标签格式', () => {
  it('相对标签单位与精度恒定（单位统一才好竖排比对、才好 grep）', () => {
    expect(formatRelTime(0)).toBe('+0.00s');
    expect(formatRelTime(6034)).toBe('+6.03s');
    expect(formatRelTime(12700)).toBe('+12.70s');
    expect(formatRelTime(59999)).toBe('+60.00s');
    expect(formatRelTime(612_340)).toBe('+612.34s');
  });

  it('负数/NaN/Infinity 一律按 0 处理（标签乱掉比没有更糟，会让人怀疑日志本身）', () => {
    expect(formatRelTime(-1)).toBe('+0.00s');
    expect(formatRelTime(Number.NaN)).toBe('+0.00s');
    expect(formatRelTime(Number.POSITIVE_INFINITY)).toBe('+0.00s');
  });

  it('正文标签是绝对时刻 时:分:秒（用本地时刻构造，故与时区无关）', () => {
    const t = new Date(2026, 8, 20, 16, 12, 12, 500).getTime();
    expect(formatClockTime(t)).toBe('16:12:12');
    // 恒 8 字符：个位数必须补零，否则竖排时数字位错开、比不出量级
    expect(formatClockTime(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });

  it('秒取"所处的秒"而非四舍五入（否则末尾会凭空跳出一秒，与完整戳的毫秒对不上）', () => {
    const at = (ms: number) => new Date(2026, 8, 20, 16, 12, 12, ms).getTime();
    expect(formatClockTime(at(0))).toBe('16:12:12');
    expect(formatClockTime(at(999))).toBe('16:12:12');
  });

  it('正文标签对非法值回落到同一基准（标签乱掉比没有更糟，会让人怀疑日志本身）', () => {
    expect(formatClockTime(Number.NaN)).toBe(formatClockTime(0));
    expect(formatClockTime(Number.NEGATIVE_INFINITY)).toBe(formatClockTime(0));
  });

  it('完整戳带日期与毫秒 —— 正文那两个值跨天会一模一样，只有它给得出唯一坐标', () => {
    const t = new Date(2026, 8, 20, 15, 40, 26, 318).getTime();
    expect(formatClockStamp(t)).toBe('2026-09-20 15:40:26.318');
    expect(formatClockStamp(new Date(2026, 0, 1, 0, 0, 0, 7).getTime())).toBe('2026-01-01 00:00:00.007');
    // 同一天同一秒的两个不同毫秒：正文相同、完整戳不同（这正是它存在的理由）
    const a = new Date(2026, 8, 20, 16, 12, 12, 100).getTime();
    const b = new Date(2026, 8, 20, 16, 12, 12, 900).getTime();
    expect(formatClockTime(a)).toBe(formatClockTime(b));
    expect(formatClockStamp(a)).not.toBe(formatClockStamp(b));
  });
});

describe('runLog：并入与打戳', () => {
  it('空行与纯空白行丢弃', () => {
    expect(stamp([], ['', '   ', '\t', 'real'], 0).map((l) => l.text)).toEqual(['real']);
  });

  it('原样保留缩进（构建输出的对齐有意义，不做 trim）', () => {
    expect(stamp([], ['  [1/2] Building CXX object'], 0)[0].text).toBe('  [1/2] Building CXX object');
  });

  it('同一块输出共享一个到达时刻 —— 分辨率上限，不假装逐行精确', () => {
    const out = stamp([], ['a', 'b', 'c'], 5000, 4000);
    expect(out.map((l) => l.tMs)).toEqual([1000, 1000, 1000]);
    expect(out.map((l) => l.atMs)).toEqual([5000, 5000, 5000]);
  });

  it('tMs 相对时间原点；时钟回拨/行早于原点也不产生负标签', () => {
    expect(stamp([], ['x'], 3600_000)[0].tMs).toBe(3600_000);
    expect(stamp([], ['x'], 900, 1000)[0].tMs).toBe(0);
  });

  it('无有效行时返回原引用（不触发一轮无关渲染）', () => {
    const cur = stamp([], ['x'], 0);
    expect(stamp(cur, ['', '  '], 10)).toBe(cur);
  });

  it('返回新数组，不改入参（store 靠重新赋值触发响应）', () => {
    const cur = stamp([], ['a'], 0);
    const snapshot = cur.slice();
    const next = stamp(cur, ['b'], 10);
    expect(next).not.toBe(cur);
    expect(cur).toEqual(snapshot);
  });

  it('cap 裁尾并保留 seq 不回退（裁掉头部后仍可直接作列表 key）', () => {
    let log: RunLogLine[] = [];
    for (let i = 0; i < 10; i++) log = stamp(log, [`L${i}`], i, 0, 3);
    expect(log.map((l) => l.text)).toEqual(['L7', 'L8', 'L9']);
    expect(log.map((l) => l.seq)).toEqual([7, 8, 9]);
  });

  it('默认上限即 RUN_LOG_MAX', () => {
    let log: RunLogLine[] = [];
    for (let i = 0; i < RUN_LOG_MAX + 5; i++) log = stamp(log, [`L${i}`], i);
    expect(log).toHaveLength(RUN_LOG_MAX);
    expect(log[log.length - 1].text).toBe(`L${RUN_LOG_MAX + 4}`);
  });
});

describe('runLog：噪声过滤', () => {
  it('遥测/逐包行不进日志（否则真正的编译错误会被刷屏淹没）', () => {
    const out = stamp([], ['[EPC-KPI] t=1 flow=1', '◆Rx 帧 1', 'x.cc:1:1 error: boom'], 0);
    expect(out.map((l) => l.text)).toEqual(['x.cc:1:1 error: boom']);
  });

  it('与遥测协议前缀**同源**：前缀改名后过滤不会静默失效', () => {
    for (const p of Object.values(EPC_PREFIX)) {
      expect(RUN_LOG_NOISE.test(`${p}t=0`)).toBe(true);
    }
  });

  it('产物统计输出必须留下（那是用户要看的 Flow 结果，不是噪声）', () => {
    const stat = ['=== EPComHIL 统计输出 ===', 'Flow 1TxPkts=16RxPkts=16'];
    expect(stamp([], stat, 0).map((l) => l.text)).toEqual(stat);
  });

  it('drop=null 可关闭过滤（需要全量日志的场合）', () => {
    const out = appendRunLog([], ['[EPC-OP] t=0'], { atMs: 0, epochMs: 0, drop: null });
    expect(out).toHaveLength(1);
  });
});

describe('runLog：诊断契约（日志自己回答"跑满 10s 没有"）', () => {
  // 原点取一个固定的本地时刻，好让正文那一列（绝对时刻）也能直接断言
  const epoch = new Date(2026, 8, 20, 16, 12, 2, 0).getTime();

  it('[running] 与 [done] 相隔 10.3s 时，两种标签指向同一个差值', () => {
    let log = stamp([], ['▶ 开始运行：___CSMA__ · REALTIME'], epoch, epoch);
    log = stamp(log, ['[running] ___CSMA__ · REALTIME'], epoch + 2400, epoch);
    log = stamp(log, ['[done] 退出码 0 · 12.7s'], epoch + 12700, epoch);

    expect(log[0].tMs).toBe(0);
    expect(formatRelTime(log[1].tMs)).toBe('+2.40s');
    expect(formatRelTime(log[2].tMs)).toBe('+12.70s');
    // 关键：不需要任何外部基线，减法就是运行阶段的实际墙钟耗时
    expect(log[2].tMs - log[1].tMs).toBe(10300);
    // 正文那一列（绝对时刻，秒级）同样答得了这个问题：16:12:04 → 16:12:14
    expect(formatClockTime(log[1].atMs)).toBe('16:12:04');
    expect(formatClockTime(log[2].atMs)).toBe('16:12:14');
  });

  it('反之全速跑完的 OFFLINE 会话，两行几乎重合（差值 ≈ 0）', () => {
    let log = stamp([], ['[running] demo · OFFLINE'], epoch, epoch);
    log = stamp(log, ['[done] 退出码 0 · 2.0s'], epoch + 380, epoch);
    expect(log[1].tMs - log[0].tMs).toBe(380);
  });
});
