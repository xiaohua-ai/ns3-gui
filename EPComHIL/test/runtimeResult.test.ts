// Runtime 运行结果文件的序列化契约回归：build → JSON.stringify → parse → is 校验须对称，
// 保证「保存结果」写出的文件能被「历史结果」原样读回。
import { describe, expect, it } from 'vitest';
import { buildRuntimeResult, isRuntimeResultFile } from '../src/core/runtimeResult';
import type { RuntimeHeader } from '../src/core/runtimeModel';

const head: RuntimeHeader = {
  projectName: '工程A',
  version: '0.1.0',
  mode: 'REALTIME',
  clockSource: 'INTERNAL',
  precise: true,
  stopSeconds: 10,
  syncMode: 'HARD_LIMIT',
  step: 'US',
  timestepUs: 1000,
};

describe('runtimeResult 结果文件序列化', () => {
  it('build → JSON → parse → is 校验成真（round-trip 对称）', () => {
    const f = buildRuntimeResult({
      header: head,
      items: [],
      events: [],
      simLog: [],
      mode: 'REALTIME',
      phase: 'done',
      exitCode: 0,
      duration: '10.0s',
      projectName: '工程A',
      stopSeconds: 10,
      syncMode: 'HARD_LIMIT',
    });
    const parsed = JSON.parse(JSON.stringify(f)) as unknown;
    expect(isRuntimeResultFile(parsed)).toBe(true);
    const r = parsed as ReturnType<typeof buildRuntimeResult>;
    expect(r.meta.kind).toBe(undefined); // kind 在顶层
    expect(r.meta.mode).toBe('REALTIME');
    expect(r.header?.syncMode).toBe('HARD_LIMIT');
    expect(r.meta.eventCount).toBe(0);
  });

  it('缺必需数组字段 / 非对象应判为非法', () => {
    expect(isRuntimeResultFile({ kind: 'EPComHIL-runtime', version: 1, meta: {}, items: [] })).toBe(false);
    expect(isRuntimeResultFile(null)).toBe(false);
    expect(isRuntimeResultFile('x')).toBe(false);
  });
});