// 运行结果存取的环境适配层回归：同一套界面在 Electron 壳与纯浏览器下都必须可用。
//
// 背景：RuntimeView 的「保存结果 / 历史结果」原先裸判 window.epcomhil，浏览器下直接弹
// 「未处于 Electron 环境」——而工程存取 / 案例库都有 utils 适配层降级，唯独这条漏了。
// 这里锁住两条通道的行为，防止将来又退回「只有 Electron 能用」。
import { describe, it, expect, afterEach } from 'vitest';
import {
  isElectronShell,
  saveRuntimeResultText,
  openRuntimeResultText,
  saveRuntimeResultToProject,
  listRuntimeResults,
  readRuntimeResultByName,
  suggestRuntimeResultName,
} from '@/utils/runtimeResultStorage';

const ORIG_URL = (globalThis as any).URL;

interface FakeEl {
  tagName: string;
  type?: string;
  href?: string;
  download?: string;
  style: Record<string, unknown>;
  files?: { name: string; text: () => Promise<string> }[];
  clicked?: boolean;
  _l: Record<string, ((e?: unknown) => unknown)[]>;
  addEventListener: (t: string, cb: (e?: unknown) => unknown) => void;
  remove: () => void;
  click: () => void;
  dispatch: (t: string) => Promise<void>;
}

/** 极简 DOM 打桩：只满足适配层用到的 createElement/appendChild/click/addEventListener */
function stubDom(): FakeEl[] {
  const created: FakeEl[] = [];
  const make = (tag: string): FakeEl => {
    const el: FakeEl = {
      tagName: tag,
      style: {},
      _l: {},
      addEventListener(t, cb) {
        (el._l[t] ||= []).push(cb);
      },
      remove() {},
      click() {
        el.clicked = true;
      },
      async dispatch(t) {
        for (const cb of el._l[t] ?? []) await cb();
      },
    };
    created.push(el);
    return el;
  };
  (globalThis as any).document = {
    body: { appendChild: () => {} },
    createElement: (tag: string) => make(tag),
  };
  return created;
}

function stubBrowserEnv(): FakeEl[] {
  (globalThis as any).window = {}; // 浏览器：无 epcomhil
  const created = stubDom();
  const urls: string[] = [];
  (globalThis as any).URL = {
    createObjectURL: () => {
      urls.push('blob:mock');
      return 'blob:mock';
    },
    revokeObjectURL: () => {},
  };
  return created;
}

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  (globalThis as any).URL = ORIG_URL;
});

describe('runtimeResultStorage：Electron 壳内走原生通道', () => {
  it('保存 / 打开都走 window.epcomhil，via=electron', async () => {
    const saved: { content: string; suggestedName?: string }[] = [];
    (globalThis as any).window = {
      epcomhil: {
        saveRuntimeResult: async (p: { content: string; suggestedName?: string }) => {
          saved.push(p);
          return { ok: true, path: 'C:/out/' + p.suggestedName };
        },
        openRuntimeResult: async () => ({
          ok: true,
          path: 'C:/hist/a.runtime.json',
          fileName: 'a.runtime.json',
          content: '{"kind":"EPComHIL-runtime"}',
        }),
      },
    };
    expect(isElectronShell()).toBe(true);

    const s = await saveRuntimeResultText('{"a":1}', 'a.runtime.json');
    expect(s).toMatchObject({ ok: true, via: 'electron' });
    expect(s.path).toBe('C:/out/a.runtime.json');
    expect(saved[0]).toEqual({ content: '{"a":1}', suggestedName: 'a.runtime.json' });

    const o = await openRuntimeResultText();
    expect(o).toMatchObject({ ok: true, via: 'electron', fileName: 'a.runtime.json' });
    expect(o.content).toContain('EPComHIL-runtime');
  });
});

describe('runtimeResultStorage：纯浏览器降级（不再弹「未处于 Electron 环境」）', () => {
  it('没有 epcomhil 时 isElectronShell=false', () => {
    (globalThis as any).window = {};
    expect(isElectronShell()).toBe(false);
  });

  it('保存降级为 Blob 下载，文件名用 suggestedName', async () => {
    const created = stubBrowserEnv();
    const r = await saveRuntimeResultText('{"b":2}', 'proj_20260921.runtime.json');
    expect(r).toMatchObject({ ok: true, via: 'download', path: 'proj_20260921.runtime.json' });
    const a = created.find((e) => e.tagName === 'a');
    expect(a?.download).toBe('proj_20260921.runtime.json');
    expect(a?.clicked).toBe(true); // 真的触发了下载点击
  });

  it('打开降级为 <input type=file>，选中文件后回传内容', async () => {
    const created = stubBrowserEnv();
    const p = openRuntimeResultText();
    const input = created.find((e) => e.tagName === 'input');
    expect(input?.type).toBe('file');
    expect(input?.clicked).toBe(true);
    input!.files = [{ name: 'hist.runtime.json', text: async () => '{"kind":"EPComHIL-runtime"}' }];
    await input!.dispatch('change');
    const r = await p;
    expect(r).toMatchObject({ ok: true, via: 'file', fileName: 'hist.runtime.json' });
    expect(r.content).toContain('EPComHIL-runtime');
  });

  it('打开时用户取消（未选文件）→ cancelled，不抛错', async () => {
    const created = stubBrowserEnv();
    const p = openRuntimeResultText();
    const input = created.find((e) => e.tagName === 'input');
    input!.files = [];
    await input!.dispatch('change');
    expect(await p).toMatchObject({ ok: false, via: 'file', reason: 'cancelled' });
  });
});

describe('运行结果文件名：时间戳只取数字（曾经出现 `..runtime.json` 双点）', () => {
  const T = new Date('2026-09-21T07:57:30.123Z');

  it('毫秒前的点不会被截进文件名', () => {
    const name = suggestRuntimeResultName('Untitled', T);
    expect(name).toBe('Untitled_20260921075730.runtime.json');
    expect(name).not.toContain('..');
  });

  it('工程名里的 Windows 非法字符被替换成下划线', () => {
    const name = suggestRuntimeResultName('a/b c:*?', T);
    expect(name.endsWith('_20260921075730.runtime.json')).toBe(true);
    expect(/[\\/:*?"<>|\s]/.test(name.replace(/\.runtime\.json$/, ''))).toBe(false);
  });

  it('工程名为空时退回 run-result', () => {
    expect(suggestRuntimeResultName('', T)).toBe('run-result_20260921075730.runtime.json');
  });
});

describe('运行结果写入「工程所在文件夹」（saveRuntimeResultToProject）', () => {
  it('Electron：走 saveRuntimeResultInProject，文件名原样传入', async () => {
    const calls: { content: string; baseName: string }[] = [];
    (globalThis as any).window = {
      epcomhil: {
        saveRuntimeResultInProject: async (p: { content: string; baseName: string }) => {
          calls.push(p);
          return { ok: true, path: 'C:/proj/' + p.baseName, fileName: p.baseName };
        },
      },
    };
    const r = await saveRuntimeResultToProject('{"kind":"EPComHIL-runtime"}', 'proj_20260921.runtime.json');
    expect(r).toMatchObject({ ok: true, via: 'project', fileName: 'proj_20260921.runtime.json' });
    expect(calls[0]).toEqual({ content: '{"kind":"EPComHIL-runtime"}', baseName: 'proj_20260921.runtime.json' });
  });

  it('Electron：主进程尚无工程文件夹时 needsProjectDir=true（视图据此先引导落盘）', async () => {
    (globalThis as any).window = {
      epcomhil: {
        saveRuntimeResultInProject: async () => ({ ok: false, reason: 'no-project-dir' }),
      },
    };
    const r = await saveRuntimeResultToProject('x', 'y.runtime.json');
    expect(r.ok).toBe(false);
    expect(r.needsProjectDir).toBe(true);
  });

  it('浏览器（无 epcomhil）：降级为下载，文件名用 baseName', async () => {
    const created = stubBrowserEnv();
    const r = await saveRuntimeResultToProject('{"kind":"EPComHIL-runtime"}', 'proj_20260921.runtime.json');
    // 浏览器无工程文件夹 → via 必须是 download（视图据此显示「已下载」而非「已保存到工程文件夹」）
    expect(r).toMatchObject({ ok: true, via: 'download', fileName: 'proj_20260921.runtime.json' });
    const a = created.find((e) => e.tagName === 'a');
    expect(a?.download).toBe('proj_20260921.runtime.json');
    expect(a?.clicked).toBe(true);
  });
});

describe('历史结果列表（listRuntimeResults / readRuntimeResultByName）', () => {
  it('Electron：listRuntimeResults 透传主进程返回的 dir 与文件', async () => {
    (globalThis as any).window = {
      epcomhil: {
        listRuntimeResults: async () => ({
          ok: true,
          dir: 'C:/proj',
          files: [{ name: 'a.runtime.json', mtime: 1000, size: 2048 }],
        }),
      },
    };
    const r = await listRuntimeResults();
    expect(r).toMatchObject({ ok: true, dir: 'C:/proj', files: [{ name: 'a.runtime.json', size: 2048 }] });
  });

  it('Electron：readRuntimeResultByName 透传内容', async () => {
    (globalThis as any).window = {
      epcomhil: {
        readRuntimeResult: async (p: { name: string }) => ({
          ok: true,
          path: 'C:/proj/a.runtime.json',
          fileName: p.name,
          content: '{"kind":"EPComHIL-runtime"}',
        }),
      },
    };
    const r = await readRuntimeResultByName('a.runtime.json');
    expect(r).toMatchObject({ ok: true, content: '{"kind":"EPComHIL-runtime"}', fileName: 'a.runtime.json' });
  });

  it('浏览器（无 epcomhil）：listRuntimeResults 返回空列表；readRuntimeResultByName 退回文件选择', async () => {
    const created = stubBrowserEnv();
    const list = await listRuntimeResults();
    expect(list).toMatchObject({ ok: true, dir: '', files: [] });

    const p = readRuntimeResultByName('a.runtime.json');
    const input = created.find((e) => e.tagName === 'input');
    expect(input?.type).toBe('file');
    input!.files = [{ name: 'a.runtime.json', text: async () => '{"kind":"EPComHIL-runtime"}' }];
    await input!.dispatch('change');
    const r = await p;
    expect(r).toMatchObject({ ok: true, content: '{"kind":"EPComHIL-runtime"}' });
  });
});
