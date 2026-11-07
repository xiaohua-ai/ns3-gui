// 运行遥测解析器：把 ns-3 产物的 stdout / stderr 逐行还原为 RuntimeEvent。
//
// —— 与谁配对 ——
// 前缀与字段名在 src/generator/telemetry.ts 定义，本文件与之**逐字对应**。
// 两侧不对称不会报错、不会崩溃，只会让 Runtime 组件「永远空着」——最难排查的一类故障，
// 故这里有配套回归（test/simOutput.test.ts）。
//
// —— 两种运行模式共用同一条通道 ——
//   OFFLINE：仿真全速推进，所有遥测行几乎在同一瞬间到达 → 一次性 ingest → 曲线一次铺满；
//   HIL    ：RealtimeSimulatorImpl 按墙钟推进，行逐拍到达 → 分批 ingest → 曲线随仿真实时滚动。
// 差别只在**投递节奏**，解析与渲染完全同源 —— 这正是「离线运行后如何查看 / 实时运行时如何查看」
// 的答案：同一个 Runtime 页、同一批组件，看的是同一份数据，只是到达的时间分布不同。
//
// 纯函数风格：不碰 IO、不依赖 DOM，输入字符串 → 输出事件数组，可单测。
import type {
  RuntimeEvent,
  CommEvent,
  FlowIndex,
  HilInjectEvent,
  HilSyncEvent,
  OpLogEvent,
  RawLogEvent,
} from './runtimeModel';
import { resolveFlowTarget } from './flowIndex';

/**
 * 遥测行前缀 —— **单一来源**。
 *
 * 产物端（src/generator/telemetry.ts 生成 C++ 字面量）与本解析器都引用这一个常量，
 * 因此「改一处、两边同步」是**编译期成立**的，而不是靠注释提醒人去改两遍。
 * 带尾随空格：字段一律紧跟其后（`[EPC-KPI] t=…`），带空格可避免 `[EPC-KPI]` 误命中 `[EPC-KPIX]`。
 *
 * 注意它必须待在 core（而非 generator）：解析器在 core，让 core 反向依赖 generator 会把
 * 分层倒过来，且会把整条生成管线拖进解析器的依赖图。
 */
export const EPC_PREFIX = {
  op: '[EPC-OP] ',
  kpi: '[EPC-KPI] ',
  hil: '[EPC-HIL] ',
  tap: '[EPC-TAP] ',
  link: '[EPC-LINK] ',
} as const;

export interface SimParseOptions {
  /**
   * 流端点索引（推荐）：按产物报出的 `src=`/`dst=` 地址把 KPI 绑回工程对象。
   *
   * 这是**主路径**：产物在 KPI 行里带上该流的五元组（IP:port），平台用「IP → 节点」
   * 映射还原绑定，完全不依赖 ns-3 的流号分配顺序（那个顺序对工程不可见、也无契约）。
   * 见 core/flowIndex.ts 与 generator/context.ts 的 buildFlowIndex。
   */
  flowIndex?: FlowIndex;
  /**
   * 工程业务流 id（按工程内顺序）—— **仅在 KPI 行没有端点字段时**的退路。
   *
   * 产物里 FlowMonitor 的流号（`flow=`）是 ns-3 自己从 1 起、按**首包先后**分配的整数，
   * 与工程业务流顺序并无契约。故这条退路有先天缺陷，只在拿不到端点（如二层流无端口、
   * 或 classifier 转换失败）时启用；能拿到端点时一律以端点为准。
   */
  flowIds?: string[];
  /**
   * 是否输出原始日志行事件（用于 sim-log 组件）。
   * 默认 false：现有组件不需要原始行，开启会增加事件量。
   */
  rawLog?: boolean;
}

/** 产物里一次「统计汇总」块的标题行（终态一次性输出，非周期遥测） */
const STATS_BANNER = '=== EPComHIL 统计输出 ===';

/** 终态汇总行：字段是紧贴的（`Flow 1TxPkts=8RxPkts=8Lost=0PDR%=100`），故不能用空格切分 */
const STATS_ROW = /^Flow\s+(\d+)\s*TxPkts=(\d+)\s*RxPkts=(\d+)\s*Lost=(\d+)\s*PDR%=([\d.]+)$/;

/** 明显是出错的行（stderr 侧）——只在没有结构化遥测可解析时才用得上 */
const ERR_HINT = /(error:|Error:|NS_FATAL|NS_ABORT|terminate called|Assertion|Aborted|core dumped|TraceConnect|assert)/;

/** 取 `k=v` 形式的字段（v 到行尾或下一个空格），值为字符串 */
function field(line: string, key: string): string | undefined {
  const m = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  return m ? m[1] : undefined;
}

/** 取 `k=<剩余全部>` 形式的字段（消息类字段含空格，必须吃到行尾） */
function fieldRest(line: string, key: string): string | undefined {
  const i = line.indexOf(`${key}=`);
  return i >= 0 ? line.slice(i + key.length + 1).trimEnd() : undefined;
}

/** 检测行类型标签 */
function detectTag(line: string): RawLogEvent['tag'] {
  if (line.includes(EPC_PREFIX.op)) return 'epc-op';
  if (line.includes(EPC_PREFIX.kpi)) return 'epc-kpi';
  if (line.includes(EPC_PREFIX.hil)) return 'epc-hil';
  if (line.includes(EPC_PREFIX.tap)) return 'epc-tap';
  if (line.includes(EPC_PREFIX.link)) return 'epc-link';
  if (line.includes('◆Rx')) return 'rx-packet';
  if (line.includes('[building]') || line.includes('[compiling]') || line.includes('error:')) return 'build';
  return 'other';
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface SimParser {
  /** 喂入一段（可能是不完整行的）输出，返回本次能解析出的事件 */
  feed(chunk: string, stream?: 'out' | 'err'): RuntimeEvent[];
  /** 收尾：把缓冲区里最后一行（无换行结尾）也解析掉 */
  flush(): RuntimeEvent[];
}

/**
 * 创建有状态解析器。
 *
 * 有状态是必须的：SSH 流按字节到达，一行可能被切成两段（`[EPC-KPI] t=10` + `00 ...`）。
 * 无状态逐块解析会把跨块的字节流打碎，表现为「偶发丢数据」——比稳定失败更难查。
 */
export function createSimParser(opts: SimParseOptions = {}): SimParser {
  const flowIds = opts.flowIds ?? [];
  // stdout / stderr 必须是**两个独立缓冲**：SSH 的两条流按字节各来各的，
  // 共用一个残行缓冲会把「stdout 的半行」和「stderr 的半行」拼成一行 —— 偶发错乱，极难复现。
  const bufs: Record<'out' | 'err', string> = { out: '', err: '' };
  let nextId = 1;
  /** 最近一次见到的仿真时间，供没有 `t=` 字段的行（如终态汇总）落时间戳 */
  let lastT = 0;

  const allocId = () => nextId++;

  function mkOp(level: OpLogEvent['level'], source: string, message: string, t = lastT): OpLogEvent {
    return { kind: 'op', id: allocId(), timestampUs: t, level, source, message };
  }

  function parseLine(raw: string, stream: 'out' | 'err'): RuntimeEvent[] {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return [];

    const result: RuntimeEvent[] = [];

    // 提取时间戳（供后续解析复用）
    const t = num(field(line, 't'));
    if (t !== undefined) lastT = t;

    // rawLog 模式：生成原始日志行事件
    if (opts.rawLog) {
      const tag = detectTag(line);
      const streamType = stream === 'err' ? 'err' : 'out';
      result.push({
        kind: 'raw-log',
        id: allocId(),
        timestampUs: t ?? lastT,
        text: raw,
        stream: streamType,
        tag,
      });
    }

    // 终态汇总块：标题行只当分隔，不产生结构化事件（否则日志里全是噪声）
    if (line.trim() === STATS_BANNER) return result;

    const mStats = line.trim().match(STATS_ROW);
    if (mStats) {
      const [, f, tx, rx, lost, pdr] = mStats;
      result.push(mkOp('info', 'stats', `流 ${f} 汇总：发 ${tx} 收 ${rx} 丢 ${lost} PDR ${pdr}%`));
      return result;
    }

    // [EPC-OP] t=… level=… src=… msg=<剩余>
    if (line.includes(EPC_PREFIX.op)) {
      const level = (field(line, 'level') ?? 'info') as OpLogEvent['level'];
      const ok: OpLogEvent['level'][] = ['info', 'warn', 'error'];
      result.push(mkOp(
        ok.includes(level) ? level : 'info',
        field(line, 'src') ?? 'sim',
        fieldRest(line, 'msg') ?? '',
        t,
      ));
      return result;
    }

    // [EPC-KPI] t=… flow=… src=…:… dst=…:… proto=… tx=… rx=… lost=… pdr=… delay=… jitter=…
    if (line.includes(EPC_PREFIX.kpi)) {
      const ev: CommEvent = {
        kind: 'comm',
        id: allocId(),
        timestampUs: t ?? lastT,
        txPackets: num(field(line, 'tx')),
        rxPackets: num(field(line, 'rx')),
        lostPackets: num(field(line, 'lost')),
        pdr: num(field(line, 'pdr')),
        delayMeanUs: num(field(line, 'delay')),
        delayJitterUs: num(field(line, 'jitter')),
      };
      // 主路径：按端点还原绑定对象（不依赖流号顺序）
      const byEndpoint = resolveFlowTarget(opts.flowIndex, field(line, 'src'), field(line, 'dst'));
      if (byEndpoint) {
        ev.target = byEndpoint;
      } else {
        // 退路：端点缺失/不认识时按流号顺序回映；越界则不打 target
        //（宁可只落 whole 绑定，也不绑错对象 —— 绑错比不绑更难发现）
        const ns3Flow = num(field(line, 'flow'));
        const projId = ns3Flow !== undefined && ns3Flow >= 1 ? flowIds[ns3Flow - 1] : undefined;
        if (projId) ev.target = { flowId: projId };
      }
      result.push(ev);
      return result;
    }

    // [EPC-LINK] t=… link=l1 tx=… rx=… drop=…
    // 链路级 MAC 计数，与上面的 KPI 是两套独立测量（KPI 按端到端五元组，不知道走了哪条链路）。
    // 落到同一个 CommEvent 上、只填 target.linkId，好让 Runtime「通信指标」的链路绑定直接复用既有过滤与绘图。
    if (line.includes(EPC_PREFIX.link)) {
      const tx = num(field(line, 'tx'));
      const rx = num(field(line, 'rx'));
      const drop = num(field(line, 'drop')) ?? 0;
      const link = field(line, 'link');
      const ev: CommEvent = {
        kind: 'comm',
        id: allocId(),
        timestampUs: t ?? lastT,
        target: link ? { linkId: link } : undefined,
        txPackets: tx,
        rxPackets: rx,
        lostPackets: drop,
        // 投递率按 **drop 口径**而不是 rx/tx：csma 是共享总线，一帧会被除发送方外每个端点各收一次，
        // rx 天然是 tx 的 (N-1) 倍，rx/tx 会打出 200% 这种荒谬值。p2p 下两式等价（rx = tx - drop）。
        // 无流量（tx 缺省或 0）时给 undefined 而非 0 —— 组件显示「—」，不会被读成「全丢」。
        pdr: tx && tx > 0 ? Math.min(1, Math.max(0, 1 - drop / tx)) : undefined,
      };
      result.push(ev);
      return result;
    }

    // [EPC-HIL] t=… src=… step=… jitter=… degraded=0|1
    if (line.includes(EPC_PREFIX.hil)) {
      const src = field(line, 'src');
      const ev: HilSyncEvent = {
        kind: 'hil-sync',
        id: allocId(),
        timestampUs: t ?? lastT,
        clockSource: (src === 'PTP' ? 'PTP' : 'INTERNAL') as HilSyncEvent['clockSource'],
        stepUs: num(field(line, 'step')) ?? 0,
        jitterUs: num(field(line, 'jitter')) ?? 0,
        degraded: field(line, 'degraded') === '1',
      };
      result.push(ev);
      return result;
    }

    // [EPC-TAP] t=… tap=… rx=… tx=…
    if (line.includes(EPC_PREFIX.tap)) {
      const ev: HilInjectEvent = {
        kind: 'hil-inject',
        id: allocId(),
        timestampUs: t ?? lastT,
        tapId: field(line, 'tap') ?? 'tap',
        rx: num(field(line, 'rx')) ?? 0,
        tx: num(field(line, 'tx')) ?? 0,
      };
      result.push(ev);
      return result;
    }

    // 逐包 Rx 行（`… us ◆Rx 512B from …`）：**有意不解析**。
    // 它没有发送计数，画不出 TX 曲线；且 KPI 快照已提供同一事实的聚合视图。
    // 解析它只会把「操作日志」灌满逐包噪声，淹没真正的告警。
    if (line.includes('◆Rx')) return result;

    // 其余 stderr 行：编译/运行错误的实际载体（产物自身正常输出都在 stdout）。
    if (stream === 'err') {
      result.push(mkOp(ERR_HINT.test(line) ? 'error' : 'warn', 'ns-3', line.trim()));
    }
    return result;
  }

  function feed(chunk: string, stream: 'out' | 'err' = 'out'): RuntimeEvent[] {
    let buf = bufs[stream] + chunk;
    const out: RuntimeEvent[] = [];
    // 只处理完整行（以 \n 结尾的部分），残行留在**本流自己的**缓冲区等下一块 ——
    // 跨块断行不做保留就会丢数据，且丢的是随机位置，表现为「偶发少几个点」。
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const events = parseLine(line, stream);
      out.push(...events);
      nl = buf.indexOf('\n');
    }
    bufs[stream] = buf;
    return out;
  }

  function flush(): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    for (const stream of ['out', 'err'] as const) {
      const rest = bufs[stream];
      bufs[stream] = '';
      if (!rest) continue;
      const events = parseLine(rest, stream);
      out.push(...events);
    }
    return out;
  }

  return { feed, flush };
}

/** 一次性解析（离线整段输出、单测用）：等价于 feed 全部 + flush */
export function parseSimOutput(text: string, opts: SimParseOptions = {}): RuntimeEvent[] {
  const p = createSimParser(opts);
  return [...p.feed(text), ...p.flush()];
}
