// Runtime 运行结果文件（.runtime.json）存取的环境适配层。
// Electron：走主进程原生保存/打开对话框（preload 暴露的 window.epcomhil）。
// 浏览器（vite dev 预览 / 内置预览面板）：降级为 Blob 下载 / <input type=file>，使同一套界面两端都可用。
// 内容格式逻辑一律不在这里 —— 序列化/解析见 core/runtimeResult.ts（与 projectStorage.ts 同构）。

/** 保存走的通道：electron=原生对话框落盘；download=浏览器下载 */
export type RuntimeResultSaveVia = 'electron' | 'download';
/** 打开走的通道：electron=原生对话框；file=<input type=file> */
export type RuntimeResultOpenVia = 'electron' | 'file';

export interface RuntimeResultSaveResult {
  ok: boolean;
  path?: string;
  via: RuntimeResultSaveVia;
  reason?: string;
}

export interface RuntimeResultOpenResult {
  ok: boolean;
  path?: string;
  fileName?: string;
  content?: string;
  via: RuntimeResultOpenVia;
  reason?: string;
}

/** 是否运行在 Electron 壳里（决定走原生对话框还是浏览器降级） */
export function isElectronShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.epcomhil);
}

/**
 * 运行结果文件列表项（工程文件夹内），按修改时间倒序由主进程给出。
 */
export interface RuntimeResultListItem {
  name: string;
  mtime: number;
  size: number;
}

/**
 * 把运行结果写入「工程所在文件夹」（主进程记忆的 currentProjectDir）：无声对话框、直接落盘、文件名自动补 .runtime.json。
 * 主进程侧尚无工程文件夹（工程没存到本地）时返回 `needsProjectDir: true`，由视图先引导用户把工程落盘。
 * 浏览器（无 Electron 壳）降级为下载该 JSON 文件。
 */
export async function saveRuntimeResultToProject(
  content: string,
  baseName: string,
): Promise<{ ok: boolean; path?: string; fileName?: string; via: 'project' | 'download'; reason?: string; needsProjectDir?: boolean }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.saveRuntimeResultInProject) {
    const res = await api.saveRuntimeResultInProject({ content, baseName });
    return {
      ok: res.ok,
      path: res.path,
      fileName: res.fileName,
      via: 'project',
      reason: res.reason,
      needsProjectDir: res.reason === 'no-project-dir',
    };
  }
  if (typeof document === 'undefined') return { ok: false, via: 'download', reason: '当前环境不支持保存' };
  try {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, fileName: baseName, via: 'download' };
  } catch (e) {
    return { ok: false, via: 'download', reason: String((e as Error)?.message || e) };
  }
}

/**
 * 列出工程文件夹内的运行结果文件。无工程文件夹（浏览器环境 / 工程未保存）时返回 `dir: ''` 与空列表。
 */
export async function listRuntimeResults(): Promise<{ ok: boolean; dir: string; files: RuntimeResultListItem[]; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.listRuntimeResults) {
    const res = await api.listRuntimeResults();
    return { ok: res.ok, dir: res.dir || '', files: res.files || [], reason: res.reason };
  }
  return { ok: true, dir: '', files: [] };
}

/**
 * 按文件名读取工程文件夹内的某个运行结果。浏览器降级为单文件选择（openRuntimeResultText）。
 */
export async function readRuntimeResultByName(name: string): Promise<{ ok: boolean; content?: string; fileName?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.readRuntimeResult) {
    const res = await api.readRuntimeResult({ name });
    return { ok: res.ok, content: res.content, fileName: res.fileName, reason: res.reason };
  }
  const pick = await openRuntimeResultText();
  return { ok: pick.ok, content: pick.content, fileName: pick.fileName, reason: pick.reason };
}

/**
 * 运行结果文件的建议文件名：`<工程名>_<YYYYMMDDHHMMSS>.runtime.json`。
 * 时间戳**只取数字**（`toISOString()` 里毫秒前有个点，若按字符位置截会把它带进来，产生 `..runtime.json`）。
 * 工程名里的 Windows 非法字符统一替换成下划线。
 */
export function suggestRuntimeResultName(projectName: string, now: Date = new Date()): string {
  const safe = (projectName || 'run-result').replace(/[\\/:*?"<>|\s]+/g, '_');
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return `${safe}_${stamp}.runtime.json`;
}

/** 保存运行结果文本。Electron 弹原生保存对话框；浏览器降级为下载该 JSON 文件。 */
export async function saveRuntimeResultText(
  content: string,
  suggestedName: string,
): Promise<RuntimeResultSaveResult> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.saveRuntimeResult) {
    const res = await api.saveRuntimeResult({ content, suggestedName });
    return { ok: res.ok, path: res.path, reason: res.reason, via: 'electron' };
  }
  if (typeof document === 'undefined') return { ok: false, via: 'download', reason: '当前环境不支持保存' };
  try {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { ok: true, path: suggestedName, via: 'download' };
  } catch (e) {
    return { ok: false, via: 'download', reason: String((e as Error)?.message || e) };
  }
}

/**
 * 读取运行结果文本。
 * 浏览器降级下用户取消选择不会触发 change，Promise 会一直挂起 —— 这是 <input type=file> 的固有行为，
 * 不阻塞界面，只是该次调用不再有下文（与 openProjectText 一致）。
 */
export function openRuntimeResultText(): Promise<RuntimeResultOpenResult> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.openRuntimeResult) {
    return api.openRuntimeResult().then((res) => ({
      ok: res.ok,
      path: res.path,
      fileName: res.fileName,
      content: res.content,
      reason: res.reason,
      via: 'electron' as const,
    }));
  }
  return new Promise<RuntimeResultOpenResult>((resolve) => {
    if (typeof document === 'undefined') {
      resolve({ ok: false, via: 'file', reason: '当前环境不支持打开文件' });
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve({ ok: false, via: 'file', reason: 'cancelled' });
        return;
      }
      try {
        resolve({ ok: true, via: 'file', path: file.name, fileName: file.name, content: await file.text() });
      } catch (e) {
        resolve({ ok: false, via: 'file', reason: String((e as Error)?.message || e) });
      }
    });
    document.body.appendChild(input);
    input.click();
  });
}
