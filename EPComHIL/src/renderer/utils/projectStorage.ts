// 工程文件存取的环境适配层。
// Electron：走主进程原生保存/打开对话框（preload 暴露的 window.epcomhil）。
// 浏览器（vite dev 预览）：降级为 Blob 下载 / <input type=file>，使同一套界面两端都可用。
// 内容格式逻辑一律不在这里 —— 序列化/解析见 core/projectFile.ts。

export interface ProjectSaveResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

export interface ProjectOpenResult {
  ok: boolean;
  path?: string;
  content?: string;
  reason?: string;
}

/** 是否运行在 Electron 壳里（决定走原生对话框还是浏览器降级） */
export function isElectronShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.epcomhil);
}

/** 上次保存的工程路径（Electron 壳内有效）：「保存」直接覆写它，「另存为」后才更新 */
let lastSavedPath = '';

/** 当前工程的磁盘目录：由「另存为 / 打开」确立，运行结果文件（.runtime.json）写入这里。*/
let currentProjectDir = '';

/** 从完整文件路径中提取目录（渲染进程无 node:path，手动切分，跨平台） */
export function setProjectDirFromPath(filePath: string) {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  currentProjectDir = i > 0 ? filePath.slice(0, i) : '';
}

/** 当前工程目录（空串 = 工程尚未保存到本地） */
export function getCurrentProjectDir(): string {
  return currentProjectDir;
}

/** 清空工程目录记忆（新建空白工程 / 从案例库或用户案例载入等非磁盘来源时调用） */
export function clearProjectDir() {
  currentProjectDir = '';
}

/** 载入/新建工程后调用：路径记忆作废，下一次「保存」重新弹对话框，并把工程目录记忆一并清空 */
export function forgetProjectPath() {
  lastSavedPath = '';
  currentProjectDir = '';
}

/** 保存工程文本。Electron 壳内：forceDialog=false 且有路径记忆时静默覆写，否则弹原生保存对话框 */
export async function saveProjectText(
  content: string,
  suggestedName: string,
  opts: { forceDialog?: boolean } = {},
): Promise<ProjectSaveResult> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.saveProjectFile) {
    if (!opts.forceDialog && lastSavedPath && api.saveProjectFileDirect) {
      const direct = await api.saveProjectFileDirect({ path: lastSavedPath, content });
      if (direct.ok) return { ok: true, path: lastSavedPath };
      // 静默覆写失败（文件被挪走等）→ 退回对话框，别让用户丢数据
    }
    const res = await api.saveProjectFile({ content, suggestedName });
    if (res.ok && res.path) {
      lastSavedPath = res.path;
      setProjectDirFromPath(res.path);
    }
    return res;
  }

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
    return { ok: true, path: suggestedName };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e) };
  }
}

/**
 * 读取工程文本。
 * 浏览器降级下用户取消选择不会触发 change，Promise 会一直挂起 —— 这是 <input type=file> 的固有行为，
 * 不阻塞界面，只是该次调用不再有下文。
 */
export function openProjectText(): Promise<ProjectOpenResult> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (api?.openProjectFile) {
    return api.openProjectFile().then((res) => {
      if (res.ok && res.path) setProjectDirFromPath(res.path);
      return res;
    });
  }

  return new Promise<ProjectOpenResult>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tc,.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve({ ok: false, reason: 'cancelled' });
        return;
      }
      try {
        resolve({ ok: true, path: file.name, content: await file.text() });
      } catch (e) {
        resolve({ ok: false, reason: String((e as Error)?.message || e) });
      }
    });
    document.body.appendChild(input);
    input.click();
  });
}
