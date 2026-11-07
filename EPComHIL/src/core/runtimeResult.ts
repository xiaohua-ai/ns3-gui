// RUNTIME 运行结果文件（.runtime.json）的序列化契约。
// 捕捉一次运行结束时刻「监视画布 + 会话头 + 事件 + 运行日志」的整份快照，
// 供日后「打开历史结果文件」原样还原当时的 Runtime 工程查看。
// 纯结构定义，不带任何渲染依赖——主进程也只当文本读写，格式唯一归宿在这里。
import type { RuntimeHeader, RuntimeEvent, RuntimeLayoutItem } from './runtimeModel';
import type { SimMode, SyncMode } from './types';
import type { RunLogLine } from './runLog';

export interface RuntimeResultFile {
  kind: 'EPComHIL-runtime';
  version: 1;
  meta: {
    savedAt: string;
    projectName: string;
    mode: SimMode | null;
    /** 保存时相位（idle/done/error…），宽字符串，仅供展示 */
    phase: string;
    exitCode: number | null;
    duration: string;
    stopSeconds: number | null;
    syncMode?: SyncMode;
    eventCount: number;
  };
  header: RuntimeHeader | null;
  /** 监视画布布局（含对象绑定）——打开结果时据此还原当时的监视工程 */
  items: RuntimeLayoutItem[];
  events: RuntimeEvent[];
  simLog: RunLogLine[];
}

export interface BuildRuntimeResultOpts {
  header: RuntimeHeader | null;
  items: RuntimeLayoutItem[];
  events: RuntimeEvent[];
  simLog: RunLogLine[];
  mode: SimMode | null;
  phase: string;
  exitCode: number | null;
  duration: string;
  projectName: string;
  stopSeconds: number | null;
  syncMode?: SyncMode;
}

export function buildRuntimeResult(opts: BuildRuntimeResultOpts): RuntimeResultFile {
  return {
    kind: 'EPComHIL-runtime',
    version: 1,
    meta: {
      savedAt: new Date().toISOString(),
      projectName: opts.projectName,
      mode: opts.mode,
      phase: opts.phase,
      exitCode: opts.exitCode,
      duration: opts.duration,
      stopSeconds: opts.stopSeconds,
      syncMode: opts.syncMode,
      eventCount: opts.events.length,
    },
    header: opts.header,
    items: opts.items,
    events: opts.events,
    simLog: opts.simLog,
  };
}

/** 运行结果文件的结构校验：防脏文件/类型错位进入后被打散成乱布局 */
export function isRuntimeResultFile(x: unknown): x is RuntimeResultFile {
  if (!x || typeof x !== 'object') return false;
  const r = x as RuntimeResultFile;
  return (
    r.kind === 'EPComHIL-runtime' &&
    r.version === 1 &&
    r.meta != null &&
    Array.isArray(r.items) &&
    Array.isArray(r.events) &&
    Array.isArray(r.simLog)
  );
}