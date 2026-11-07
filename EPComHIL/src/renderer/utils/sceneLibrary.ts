// 自带案例库的场景存取环境适配层。
// Electron 壳：走主进程 IPC（真实磁盘 scenarios 目录，文件操作落盘）。
// 浏览器/预览（vite dev）：没有文件系统，用 localStorage 虚拟示例库兜底——
//   首次以 BUILTIN_SCENES 种子初始化，之后重命名/删除/属性全部作用在虚拟库上，
//   使右键「重命名/删除/复制路径/属性」在网页同样可用（「打开所在位置」退化为复制虚拟路径）。
import { BUILTIN_SCENES } from '@/scenarios/builtinScenes';

export type SceneFileItem = { name: string; rel: string; content?: string };
export type SceneFolderItem = { name: string; files: SceneFileItem[] };

interface VaultFolder {
  name: string;
  files: { name: string; content: string }[];
}

const VAULT_KEY = 'epcomhil.sceneVault.v1';

/** 是否运行在 Electron 壳内（决定「打开所在位置」能否直接定位本地磁盘） */
export function isElectronSceneShell(): boolean {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  return Boolean(api?.listScenes);
}

// ---------- 浏览器虚拟示例库 ----------
let vaultCache: VaultFolder[] | null = null;
function readVault(): VaultFolder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(VAULT_KEY) || '[]') as VaultFolder[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function seedVault(): VaultFolder[] {
  const map = new Map<string, string[]>();
  for (const s of BUILTIN_SCENES) map.set(s.folder, [...(map.get(s.folder) ?? []), s.content]);
  const folders = [...map.entries()].map(([name, contents]) => ({
    name,
    files: contents.map((c) => ({ name: 'case.tc', content: c })),
  }));
  localStorage.setItem(VAULT_KEY, JSON.stringify(folders));
  return folders;
}
function getVault(): VaultFolder[] {
  if (vaultCache) return vaultCache;
  let v = readVault();
  if (!v.length && BUILTIN_SCENES.length) v = seedVault();
  vaultCache = v;
  return v;
}
function persistVault(v: VaultFolder[]) {
  vaultCache = v;
  try {
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  } catch {
    /* 容量超出时静默失败，本次更改不落盘 */
  }
}
function webFolder(relParts: string[]): VaultFolder | undefined {
  return relParts.length ? getVault().find((f) => f.name === relParts[0]) : undefined;
}

// ---------- 统一接口 ----------
/**
 * 列出用例文件夹。
 * @param fresh 强制重新读取（跳过网页虚拟库的内存缓存）——「刷新」按钮用它，
 *              否则 web 预览下模块级 cache 会让刷新变成空动作（Electron 走 IPC 本就读盘，不受影响）。
 */
export async function listSceneFolders(fresh = false): Promise<SceneFolderItem[]> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.listScenes) {
    const r = await api.listScenes();
    return (r.ok ? r.folders : []) as SceneFolderItem[];
  }
  if (fresh) vaultCache = null;
  return getVault().map((f) => ({
    name: f.name,
    files: f.files.map((x) => ({ name: x.name, rel: `${f.name}/${x.name}` })),
  }));
}

export async function loadSceneText(rel: string): Promise<{ ok: boolean; content?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.loadScene) return api.loadScene(rel);
  const parts = String(rel || '').split('/');
  const folder = webFolder(parts);
  const file = folder?.files.find((x) => x.name === parts[1]);
  return file ? { ok: true, content: file.content } : { ok: false, reason: 'web 虚拟库中不存在该工程' };
}

/** 属性：桌面返回真实磁盘绝对路径与字节大小；网页返回项目内真实相对路径（scenarios/<名>）与字符数 */
export async function statSceneFolderX(name: string): Promise<{ ok: boolean; name?: string; abs?: string; files?: number; size?: number; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.statSceneFolder) return api.statSceneFolder(name);
  const f = getVault().find((x) => x.name === name);
  if (!f) return { ok: false, reason: '未找到该文件夹' };
  return {
    ok: true,
    name: f.name,
    abs: `scenarios/${name}`,
    files: f.files.length,
    size: f.files.reduce((n, x) => n + x.content.length, 0),
  };
}

/** 重命名：桌面落盘；网页改虚拟库并持久化 */
export async function renameSceneFolderX(oldName: string, newName: string): Promise<{ ok: boolean; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.renameSceneFolder) return api.renameSceneFolder(oldName, newName);
  const v = getVault();
  if (!v.some((f) => f.name === oldName)) return { ok: false, reason: '未找到该文件夹' };
  if (v.some((f) => f.name === newName)) return { ok: false, reason: '同名文件夹已存在' };
  for (const f of v) if (f.name === oldName) f.name = newName;
  persistVault(v);
  return { ok: true };
}

/** 删除：桌面落盘；网页从虚拟库移除 */
export async function deleteSceneFolderX(name: string): Promise<{ ok: boolean; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.deleteSceneFolder) return api.deleteSceneFolder(name);
  const next = getVault().filter((f) => f.name !== name);
  if (next.length === getVault().length) return { ok: false, reason: '未找到该文件夹' };
  persistVault(next);
  return { ok: true };
}

/** 复制路径：桌面取磁盘绝对路径；网页取项目内真实相对路径（scenarios/<名>） */
export async function copyScenePathX(name: string): Promise<{ ok: boolean; abs?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.copyScenePath) return api.copyScenePath(name);
  return { ok: true, abs: `scenarios/${name}` };
}

/**
 * 打开所在位置：桌面走 IPC 用系统文件管理器定位磁盘目录；
 * 浏览器下调用本机 vite 的 `/__epcomh_scene_reveal` 端点，由本机 Node 进程唤起系统文件管理器定位到 scenarios/<folder>。
 */
export async function revealSceneFolderX(name: string): Promise<{ ok: boolean; abs?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.revealSceneFolder) return api.revealSceneFolder(name);
  const rel = `scenarios/${name}`;
  try {
    const res = await fetch(`/__epcomh_scene_reveal?folder=${encodeURIComponent(name)}`);
    if (res.ok) return { ok: true, abs: rel };
    return { ok: false, reason: res.status === 404 ? 'not-found' : 'failed', abs: rel };
  } catch {
    return { ok: false, reason: 'web', abs: rel };
  }
}

// ---------- 场景内的具体工程文件操作（属性 / 重命名 / 删除 / 打开所在位置 / 复制路径）----------
// 与文件夹级一一对应；桌面落盘，网页作用在 localStorage 虚拟库上。folder 取自有菜单的文件项的所属文件夹。
function webFolderOf(folder: string): VaultFolder | undefined {
  return getVault().find((f) => f.name === folder);
}
function webFileOf(folder: string, name: string): { name: string; content: string } | undefined {
  return webFolderOf(folder)?.files.find((x) => x.name === name);
}

/** 文件属性：桌面返回真实磁盘绝对路径、字节大小与修改时间；网页返回相对路径与字符数 */
export async function statSceneFileX(
  folder: string,
  name: string,
): Promise<{ ok: boolean; name?: string; abs?: string; size?: number; mtime?: number; ext?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.statSceneFile) return api.statSceneFile(folder, name);
  const f = webFileOf(folder, name);
  if (!f) return { ok: false, reason: '未找到该文件' };
  return { ok: true, name: f.name, abs: `scenarios/${folder}/${f.name}`, size: f.content.length, ext: f.name.includes('.') ? '.' + f.name.split('.').pop() : '' };
}

/** 重命名：桌面落盘；网页改虚拟库（新名无扩展名时自动补回原扩展名，弹窗内做） */
export async function renameSceneFileX(
  folder: string,
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.renameSceneFile) return api.renameSceneFile(folder, oldName, newName);
  const vf = webFolderOf(folder);
  let toName = newName.trim();
  if (!toName) return { ok: false, reason: '文件名为空' };
  if (!/\.\w+$/.test(toName)) toName += oldName.includes('.') ? '.' + oldName.split('.').pop() : '';
  if (!vf) return { ok: false, reason: '未找到该文件夹' };
  const target = vf.files.find((x) => x.name === oldName);
  if (!target) return { ok: false, reason: '未找到该文件' };
  if (vf.files.some((x) => x.name === toName)) return { ok: false, reason: '同名文件已存在' };
  target.name = toName;
  persistVault(getVault());
  return { ok: true };
}

/** 删除：桌面落盘；网页从虚拟库移除 */
export async function deleteSceneFileX(folder: string, name: string): Promise<{ ok: boolean; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.deleteSceneFile) return api.deleteSceneFile(folder, name);
  const vf = webFolderOf(folder);
  if (!vf) return { ok: false, reason: '未找到该文件夹' };
  const before = vf.files.length;
  vf.files = vf.files.filter((x) => x.name !== name);
  if (vf.files.length === before) return { ok: false, reason: '未找到该文件' };
  persistVault(getVault());
  return { ok: true };
}

/** 复制路径：桌面取磁盘绝对路径；网页取项目内真实相对路径（scenarios/<folder>/<file>） */
export async function copySceneFilePathX(folder: string, name: string): Promise<{ ok: boolean; abs?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.copySceneFilePath) return api.copySceneFilePath(folder, name);
  if (!webFileOf(folder, name)) return { ok: false, reason: '未找到该文件' };
  return { ok: true, abs: `scenarios/${folder}/${name}` };
}

/** 打开所在位置：桌面走 IPC 定位磁盘文件；浏览器下经本机 vite 端点定位到其所在文件夹 */
export async function revealSceneFileX(folder: string, name: string): Promise<{ ok: boolean; abs?: string; reason?: string }> {
  const api = typeof window !== 'undefined' ? window.epcomhil : undefined;
  if (isElectronSceneShell() && api?.revealSceneFile) return api.revealSceneFile(folder, name);
  const rel = `scenarios/${folder}/${name}`;
  try {
    const res = await fetch(`/__epcomh_scene_reveal?folder=${encodeURIComponent(folder)}`);
    if (res.ok) return { ok: true, abs: rel };
    return { ok: false, reason: res.status === 404 ? 'not-found' : 'failed', abs: rel };
  } catch {
    return { ok: false, reason: 'web', abs: rel };
  }
}