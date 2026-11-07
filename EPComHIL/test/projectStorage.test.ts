// 工程目录记忆（utils/projectStorage）回归：运行结果要写进「工程所在文件夹」，
// 而工程文件夹由「另存为 / 打开」确立，在「新建 / 载入案例库 / 载入用户案例」时清空。
// 这里锁住 setProjectDirFromPath / getCurrentProjectDir / clearProjectDir 的状态机，
// 防止将来某处忘了同步导致结果被写进错误的（上一个工程的）目录。
import { describe, it, expect, afterEach } from 'vitest';
import {
  setProjectDirFromPath,
  getCurrentProjectDir,
  clearProjectDir,
  saveProjectText,
  openProjectText,
} from '@/utils/projectStorage';

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  clearProjectDir();
});

describe('工程目录记忆', () => {
  it('Windows 与 Posix 路径都能正确提取目录', () => {
    setProjectDirFromPath('C:\\Users\\me\\proj\\a.tc');
    expect(getCurrentProjectDir()).toBe('C:\\Users\\me\\proj');
    setProjectDirFromPath('/home/me/proj/a.tc');
    expect(getCurrentProjectDir()).toBe('/home/me/proj');
  });

  it('clearProjectDir 后目录回到空串（= 工程尚未保存到本地）', () => {
    setProjectDirFromPath('/x/y/a.tc');
    expect(getCurrentProjectDir()).toBe('/x/y');
    clearProjectDir();
    expect(getCurrentProjectDir()).toBe('');
  });

  it('保存成功后记录目录（Electron 通道）', async () => {
    (globalThis as any).window = {
      epcomhil: {
        saveProjectFile: async (p: { content: string; suggestedName: string }) => ({
          ok: true,
          path: '/x/y/saved.tc',
        }),
      },
    };
    const r = await saveProjectText('{"a":1}', 'saved.tc');
    expect(r.ok).toBe(true);
    expect(getCurrentProjectDir()).toBe('/x/y');
  });

  it('打开成功后记录目录（Electron 通道）', async () => {
    (globalThis as any).window = {
      epcomhil: {
        openProjectFile: async () => ({ ok: true, path: '/x/y/opened.tc', content: '{}' }),
      },
    };
    const r = await openProjectText();
    expect(r.ok).toBe(true);
    expect(getCurrentProjectDir()).toBe('/x/y');
  });

  it('浏览器降级通道不改变目录记忆', async () => {
    // 浏览器无 epcomhil：保存走下载、打开走文件选择，都不应误设目录
    const created: any[] = [];
    (globalThis as any).window = {};
    (globalThis as any).document = {
      body: { appendChild: () => {} },
      createElement: (tag: string) => {
        const el: any = {
          tagName: tag,
          style: {},
          _l: {},
          addEventListener(t: string, cb: any) {
            (el._l[t] ||= []).push(cb);
          },
          remove() {},
          click() {
            el.clicked = true;
          },
          async dispatch(t: string) {
            for (const cb of el._l[t] ?? []) await cb();
          },
        };
        created.push(el);
        return el;
      },
    };
    const urls: string[] = [];
    (globalThis as any).URL = {
      createObjectURL: () => {
        urls.push('blob:mock');
        return 'blob:mock';
      },
      revokeObjectURL: () => {},
    };
    await saveProjectText('{}', 'x.tc');
    expect(getCurrentProjectDir()).toBe('');
    const p = openProjectText();
    const input = created.find((e) => e.tagName === 'input');
    input.files = [{ name: 'x.tc', text: async () => '{}' }];
    await input.dispatch('change');
    await p;
    expect(getCurrentProjectDir()).toBe('');
  });
});
