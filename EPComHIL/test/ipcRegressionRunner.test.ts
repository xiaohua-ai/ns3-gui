import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// IPC 处理器（electron/main.cjs）依赖 electron 原生模块，无法在 vitest 内用 vi.mock 拦截
// （electron 被 externalize，inline 也无效）。这里用子进程跑纯 node 回归脚本（scripts/test-ipc-regression.cjs），
// 它覆盖 Module._load 注入假 electron，验证「运行结果写入工程文件夹」的处理器逻辑，
// 重点守住曾出现的变量遮蔽 bug（project:saveDirect 里 const { path } 覆盖了模块级 path，导致 path.dirname 报错）。
describe('main.cjs IPC 回归（子进程 node，注入假 electron）', () => {
  it('运行结果写入工程文件夹的 IPC 处理器全部通过', () => {
    const script = path.join(__dirname, '..', 'scripts', 'test-ipc-regression.cjs');
    expect(fs.existsSync(script)).toBe(true);
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(out).toContain('IPC 回归全部通过');
  });
});
