<script setup lang="ts">
// W3 拓扑建模：X6 画布 + 电力/通信节点库 + 拖拽/连线/属性编辑（架构 5.1/5.2）
import { onMounted, onBeforeUnmount, computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { VideoPlay, VideoPause } from '@element-plus/icons-vue';
import { Graph } from '@antv/x6';
import { Dnd } from '@antv/x6-plugin-dnd';
import { useWorkbench } from '@/stores/workbench';
import { useRuntimeStore } from '@/stores/runtime';
import ProjectTabs from '@/layout/ProjectTabs.vue';
import { CANVAS_COLOR, KIND_ICON, KIND_LABEL, KIND_ORDER, nodeIconDataUri } from '@/constants/nodeMeta';
import { parseProject, serializeProject, suggestFileName } from '@core/projectFile';
import { openProjectText, saveProjectText, setProjectDirFromPath, clearProjectDir } from '@/utils/projectStorage';
import { plannedNodeIps } from '@gen/context';
import { STAT_OUTPUTS } from '@core/statOutput';
import { listSceneFolders, loadSceneText, statSceneFolderX, renameSceneFolderX, deleteSceneFolderX, copyScenePathX, revealSceneFolderX, statSceneFileX, renameSceneFileX, deleteSceneFileX, copySceneFilePathX, revealSceneFileX } from '@/utils/sceneLibrary';
import type { NodeKind, NodeConfig, LinkConfig, NodeAppConfig, ProjectConfig, DecorKind, DecorConfig, TextDecorConfig, LineDecorConfig } from '@core/types';

const store = useWorkbench();
/** Electron「保存并关闭」监听解绑（onMounted 里注册，onBeforeUnmount 解绑） */
let unlistenSaveAndClose: (() => void) | null = null;

// 右侧组件库（点击向画布添加）
const library: { kind: NodeKind; label: string }[] = KIND_ORDER.map((k) => ({ kind: k, label: KIND_LABEL[k] }));

// ================== 案例库 ==================
// 自带案例库：scenarios/<用例文件夹>/case.json —— 每例一个文件夹；经 Electron IPC 或编译期内置数据浏览
type SceneFileItem = { name: string; rel: string; content?: string };
type SceneFolderItem = { name: string; files: SceneFileItem[] };
const caseTab = ref<'builtin' | 'user'>('builtin');
// 只保留两级：folders（用例文件夹列表，即 tab 的默认内容）/ files（某个用例里的工程）
// —— 原来还有一层 root（「自带案例库」外层文件夹占位卡），已按需求去掉
const builtinView = ref<'folders' | 'files'>('folders');
const sceneFolders = ref<SceneFolderItem[]>([]);
const currentFolder = ref<SceneFolderItem | null>(null);
const sceneError = ref('');

async function refreshScenes(fresh = false) {
  sceneError.value = '';
  try {
    sceneFolders.value = await listSceneFolders(fresh);
  } catch {
    sceneError.value = '自带案例库读取失败';
  }
}
function openFolder(f: SceneFolderItem) {
  currentFolder.value = f;
  builtinView.value = 'files';
}
async function openScene(item: SceneFileItem) {
  let text: string;
  try {
    if (item.content !== undefined) {
      text = item.content;
    } else {
      const r = await loadSceneText(item.rel);
      if (!r.ok || r.content === undefined) {
        ElMessage.error(r?.reason || '读取案例失败');
        return;
      }
      text = r.content;
    }
  } catch {
    ElMessage.error('读取案例失败');
    return;
  }
  const pr = parseProject(text);
  if (!pr.ok) {
    ElMessage.error(`案例解析失败：${pr.errors.join('；')}`);
    return;
  }
  await openCase(pr.project, item.name, 'builtin:' + item.rel);
}

// 自带案例库右键菜单：作用于「用例文件夹」或「文件夹内具体工程文件」两种目标，共用同一套菜单 UI 与操作。
type SceneMenuTarget =
  | { kind: 'folder'; folder: SceneFolderItem }
  | { kind: 'file'; folder: SceneFolderItem; file: SceneFileItem };
const sceneMenu = ref<{ x: number; y: number; target: SceneMenuTarget | null }>({ x: 0, y: 0, target: null });
/** 文件菜单的目标标题（删除/重命名弹窗、属性都用它做落点前缀） */
function sceneTargetTitle(t: SceneMenuTarget): string {
  return t.kind === 'folder' ? t.folder.name : `${t.folder.name}/${t.file.name}`;
}
function openFolderMenu(f: SceneFolderItem, e: MouseEvent) {
  sceneMenu.value = { x: e.clientX, y: e.clientY, target: { kind: 'folder', folder: f } };
}
function openFileMenu(folder: SceneFolderItem | null, file: SceneFileItem, e: MouseEvent) {
  if (!folder) return;
  sceneMenu.value = { x: e.clientX, y: e.clientY, target: { kind: 'file', folder, file } };
}
function closeSceneMenu() {
  sceneMenu.value = { x: 0, y: 0, target: null };
}
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + ' KB';
  return n + ' B';
}
async function refreshCurrentFiles() {
  const cur = currentFolder.value?.name;
  if (!cur) return;
  sceneFolders.value = await listSceneFolders(true);
  currentFolder.value = sceneFolders.value.find((f) => f.name === cur) ?? null;
}
async function sceneRename() {
  const t = sceneMenu.value.target;
  if (!t) return;
  closeSceneMenu();
  const isFolder = t.kind === 'folder';
  const { value } = await ElMessageBox.prompt(
    isFolder ? '输入新的文件夹名：' : '输入新的文件名（不填扩展名时自动保留原扩展名）：',
    isFolder ? '重命名文件夹' : '重命名工程',
    {
      inputValue: isFolder ? t.folder.name : t.file.name,
      inputPlaceholder: isFolder ? '新名称' : '新文件名',
      inputValidator: (v: string) => {
        const x = v?.trim() ?? '';
        if (!x) return '名称不能为空';
        if (/[/\\]/.test(x)) return '不能包含路径分隔符';
        return true;
      },
    },
  ).catch(() => ({ value: '' }));
  const name = (value as string)?.trim();
  if (!name) return;
  const r = isFolder
    ? await renameSceneFolderX(t.folder.name, name)
    : await renameSceneFileX(t.folder.name, t.file.name, name);
  if (!r.ok) return ElMessage.error(r.reason || '重命名失败');
  if (name === (isFolder ? t.folder.name : t.file.name)) return;
  ElMessage.success(`已重命名为 ${name}`);
  if (isFolder) await refreshScenes();
  else await refreshCurrentFiles();
}
async function sceneReveal() {
  const t = sceneMenu.value.target;
  if (!t) return;
  closeSceneMenu();
  const r = t.kind === 'folder' ? await revealSceneFolderX(t.folder.name) : await revealSceneFileX(t.folder.name, t.file.name);
  if (r.reason === 'web') return ElMessage.error('无法唤起系统文件管理器（需在本机 vite dev 或桌面应用中）');
  if (r.reason === 'not-found') return ElMessage.warning('本地未找到' + (t.kind === 'folder' ? '该场景文件夹' : '该文件'));
  if (r.ok) return ElMessage.success('已在系统文件管理器中打开');
  ElMessage.error('打开失败');
}
async function sceneCopyPath() {
  const t = sceneMenu.value.target;
  if (!t) return;
  closeSceneMenu();
  const r = t.kind === 'folder' ? await copyScenePathX(t.folder.name) : await copySceneFilePathX(t.folder.name, t.file.name);
  if (!r.ok) return ElMessage.error(r.reason || '复制路径失败');
  try {
    if (r.abs) await navigator.clipboard.writeText(r.abs);
  } catch {
    /* 剪贴板写入失败可忽略，仍显示路径 */
  }
  ElMessage.success(`已复制路径：${r.abs}`);
}
async function sceneDelete() {
  const t = sceneMenu.value.target;
  if (!t) return;
  closeSceneMenu();
  const title = sceneTargetTitle(t);
  const msg = t.kind === 'folder'
    ? `确定删除文件夹「${title}」及其全部工程？此操作不可撤销。`
    : `确定删除工程文件「${title}」？此操作不可撤销。`;
  try {
    await ElMessageBox.confirm(msg, t.kind === 'folder' ? '删除文件夹' : '删除工程文件', {
      type: 'warning',
      confirmButtonText: '删除',
      confirmButtonClass: 'el-button--danger',
    });
  } catch {
    return;
  }
  const r = t.kind === 'folder' ? await deleteSceneFolderX(t.folder.name) : await deleteSceneFileX(t.folder.name, t.file.name);
  if (!r.ok) return ElMessage.error(r.reason || '删除失败');
  ElMessage.success(`已删除 ${title}`);
  if (t.kind === 'folder') await refreshScenes();
  else await refreshCurrentFiles();
}
async function sceneProps() {
  const t = sceneMenu.value.target;
  if (!t) return;
  closeSceneMenu();
  if (t.kind === 'folder') {
    const r = await statSceneFolderX(t.folder.name);
    if (!r.ok) return ElMessage.error(r.reason || '读取属性失败');
    ElMessageBox.alert(
      `<div style="font-size:12.5px;line-height:1.9">
       <div><b>名称</b>　${r.name}</div>
       <div><b>类型</b>　文件夹</div>
       <div><b>路径</b>　<span style="word-break:break-all">${r.abs ?? '(不可用)'}</span></div>
       <div><b>工程文件</b>　${r.files} 个</div>
       <div><b>大小</b>　${fmtBytes(r.size ?? 0)}</div>
     </div>`,
      '文件夹属性',
      { dangerouslyUseHTMLString: true, confirmButtonText: '确定' },
    );
    return;
  }
  const r = await statSceneFileX(t.folder.name, t.file.name);
  if (!r.ok) return ElMessage.error(r.reason || '读取属性失败');
  const mtimeStr = r.mtime ? new Date(r.mtime).toLocaleString() : '(不可用)';
  ElMessageBox.alert(
    `<div style="font-size:12.5px;line-height:1.9">
       <div><b>名称</b>　${r.name}</div>
       <div><b>类型</b>　工程文件（${r.ext ?? ''}）</div>
       <div><b>路径</b>　<span style="word-break:break-all">${r.abs ?? '(不可用)'}</span></div>
       <div><b>大小</b>　${fmtBytes(r.size ?? 0)}</div>
       <div><b>修改时间</b>　${mtimeStr}</div>
     </div>`,
    '文件属性',
    { dangerouslyUseHTMLString: true, confirmButtonText: '确定' },
  );
}

// 右键菜单的全局关闭：点击非菜单区域 / Esc
function onDocPointerDown(e: PointerEvent) {
  if (!sceneMenu.value.target) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('.folder-menu')) return;
  closeSceneMenu();
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeSceneMenu();
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown);
  window.addEventListener('keydown', onDocKeyDown);
  // 用例文件夹列表现在就是 tab 的首屏内容（没有外层文件夹可点来触发加载了），进场即扫
  void refreshScenes();
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('keydown', onDocKeyDown);
});

// 用户案例：localStorage 持久化（另存为用户案例）
type UserCase = { id: string; name: string; savedAt: string; project: ProjectConfig };
const CASE_KEY = 'epcomhil.userCases.v1';
function readUserCases(): UserCase[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CASE_KEY) || '[]') as UserCase[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
const userCases = ref<UserCase[]>(readUserCases());
function persistUserCases() {
  localStorage.setItem(CASE_KEY, JSON.stringify(userCases.value));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
/** 在独立标签打开一个案例工程（caseKey 去重：重复打开同一案例切到已有标签） */
function openCase(proj: ProjectConfig, title: string, caseKey?: string) {
  clearProjectDir(); // 来自内置案例库（非磁盘工程），清空工程文件夹记忆
  store.openInTab(title, clone(proj), caseKey);
  ElMessage.success(`已打开：${title}`);
}
async function saveAsCase() {
  const name = store.project.projectName || 'untitled';
  if (!store.project.nodes.length) {
    ElMessage.warning('当前工程为空，无可保存内容');
    return;
  }
  const { value } = await ElMessageBox.prompt('为此案例命名：', '另存为用户案例', {
    inputValue: name,
    inputPlaceholder: '案例名称',
    inputValidator: (v: string) => (v && v.trim() ? true : '案例名不能为空'),
  }).catch(() => ({ value: '' }));
  if (!value) return;
  const t = new Date().toISOString();
  const exist = userCases.value.find((c) => c.name === value.trim());
  if (exist) {
    exist.savedAt = t;
    exist.project = clone(store.project);
    ElMessage.success('已更新用户案例');
  } else {
    userCases.value.push({ id: `${Date.now()}`, name: value.trim(), savedAt: t, project: clone(store.project) });
    ElMessage.success('已保存为用户案例');
  }
  persistUserCases();
  store.setActiveCaseKey(value.trim()); // 绑定到当前会话：Ctrl+S 从此静默更新该案例
}

// Ctrl+S「保存案例状态」= 应用内持久化到用户案例库（localStorage），不做浏览器文件下载。
// 每个标签会话各自记忆绑定的用户案例名（caseKey）：命中则静默更新，否则弹命名后入库。
/** 保存案例状态：命中当前会话 caseKey 则静默更新该用户案例；否则弹命名后入用户案例库。返回是否保存成功 */
async function saveCaseState(): Promise<boolean> {
  if (!store.project.nodes.length && !store.project.links.length) {
    ElMessage.warning('当前工程为空，无可保存的案例状态');
    return false;
  }
  const caseKey = store.currentSession?.caseKey;
  const existing = caseKey ? userCases.value.find((c) => c.name === caseKey) : undefined;
  if (existing) {
    existing.savedAt = new Date().toISOString();
    existing.project = clone(store.project);
    persistUserCases();
    store.markClean();
    ElMessage.success(`案例状态已保存：${existing.name}`);
    return true;
  }
  const { value } = await ElMessageBox.prompt('保存案例状态到用户案例库：', '保存案例状态', {
    inputValue: store.project.projectName || 'untitled',
    inputPlaceholder: '案例名称',
    inputValidator: (v: string) => (v && v.trim() ? true : '案例名不能为空'),
  }).catch(() => ({ value: '' }));
  const name = value.trim();
  if (!name) return false;
  const t = new Date().toISOString();
  const dup = userCases.value.find((c) => c.name === name);
  if (dup) {
    dup.savedAt = t;
    dup.project = clone(store.project);
  } else {
    userCases.value.push({ id: `${Date.now()}`, name, savedAt: t, project: clone(store.project) });
  }
  persistUserCases();
  store.setActiveCaseKey(name);
  store.markClean();
  ElMessage.success(`案例状态已保存：${name}`);
  return true;
}

function loadUser(c: UserCase) {
  clearProjectDir(); // 来自用户案例库（localStorage，非磁盘工程），清空工程文件夹记忆
  store.openInTab(c.name, clone(c.project), c.name);
  ElMessage.success(`已打开用户案例：${c.name}`);
}
async function removeCase(id: string) {
  const ok = await ElMessageBox.confirm('删除该用户案例？', '删除案例', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!ok) return;
  userCases.value = userCases.value.filter((c) => c.id !== id);
  persistUserCases();
  ElMessage.success('已删除');
}
function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
      d.getHours(),
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

const canvasRef = ref<HTMLDivElement>();
let graph: Graph;
let dndRef: Dnd;

// ---------- 画布设置（绘图工作区 / 网格） ----------
// 工作区尺寸参考 Simulink 默认 3000×2000，长宽可分别独立设置（不锁定比例）。
const WS_DEFAULT = { width: 3000, height: 2000 };
const settings = reactive({
  width: WS_DEFAULT.width,
  height: WS_DEFAULT.height,
  gridSize: 18, // 点阵间距 px
  gridGray: 80, // 点色深浅：灰阶百分比（越低越深、白底越清晰）
});
const gridColor = () => `hsl(0, 0%, ${settings.gridGray}%)`;
const showGridCfg = ref(false);

// 将工作区渲染为「白底 + 点阵」背景图，画布底灰，网格仅出现在工作区范围内（Simulink 风格）
let wsBg: string | null = null;
function renderWorkspace() {
  const w = settings.width;
  const h = settings.height;
  const g = settings.gridSize;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = gridColor();
  for (let yy = g / 2; yy < h; yy += g) {
    for (let xx = g / 2; xx < w; xx += g) {
      x.beginPath();
      x.arc(xx, yy, 1.4, 0, 7);
      x.fill();
    }
  }
  wsBg = c.toDataURL('image/png');
  graph.drawBackground({ image: wsBg, size: { width: w, height: h }, position: { x: 0, y: 0 }, repeat: 'no-repeat' });
}
// 长宽独立设置：改宽只更新宽、改高只更新高，互不联动（不锁定 3:2）
function onWidthChange() {
  renderWorkspace();
}
function onHeightChange() {
  renderWorkspace();
}

const connectMode = ref(false);
const pendingSrc = ref<string | null>(null);
/** Visio 式画线模式：开启后空白处按下=起点拖到终点=定线（细线任意方向） */
const lineMode = ref(false);
/** 画线拖拽中的预览状态：{id 起点坐标 预览node} */
const lineDrawing = ref<{ id: string; sx: number; sy: number; node: import('@antv/x6').Node } | null>(null);
/** 画布当前选中的节点 id 集合（支持多选：框选、Shift/Ctrl 加选） */
const selectedIds = ref<string[]>([]);
/** 画布当前选中的链路 id 集合（与节点分开存：链路没有位置，拖动逻辑只认节点） */
const selectedEdgeIds = ref<string[]>([]);

const dialog = reactive({ show: false, node: null as NodeConfig | null });
const linkDlg = reactive({ show: false, link: null as LinkConfig | null });
// 右键上下文菜单（右键节点/链路后在菜单里点“属性/删除”）
const ctxMenu = reactive({ show: false, x: 0, y: 0, kind: 'node' as 'node' | 'link' | 'blank' | 'decor', id: '' });

// ---------- 画布生命周期 ----------
onMounted(() => {
  graph = new Graph({
    container: canvasRef.value!,
    // 左键拖空白改为框选（见下方 startRubber），所以平移只留给「滚轮」和「中键拖」。
    // 右键不能用来平移：空白/节点/链路的右键都被上下文菜单占着。
    panning: { enabled: true, eventTypes: ['mouseWheel', 'mouseWheelDown'] },
    mousewheel: { enabled: true, modifiers: ['ctrl', 'meta'] },
    autoResize: true,
    connecting: { allowBlank: false },
  });
  renderWorkspace();

  // Dnd 默认实现是 getDragNode: sourceNode.clone() / getDropNode: draggingNode.clone()，
  // 而 X6 的 Cell.clone() 默认会 delete data.id 并重新生成 uuid
  // （见 @antv/x6/src/model/cell.ts:1383）——拖拽途中 id 被顶掉，落到 store 就成了
  // c608690c-a466-… 这种串，生成侧再拼成非法 C++ 变量名。必须 keepId 一路带到落点。
  dndRef = new Dnd({
    target: graph,
    getDragNode: (sourceNode) => sourceNode.clone({ keepId: true }),
    getDropNode: (draggingNode) => draggingNode.clone({ keepId: true }),
  });

  graph.on('node:moved', ({ node }) => {
    const cfg = store.nodeMap.get(node.id);
    const dec = store.decorMap.get(node.id);
    // 组拖 = anchor + N 个 peer 一起回写 —— 包进 batch，一次拖动只算一步撤销
    store.batch(() => {
      if (cfg) store.updateNode(cfg.id, { x: Math.round(node.getPosition().x), y: Math.round(node.getPosition().y) });
      else if (dec) {
        const pos = node.getPosition();
        if (dec.kind === 'text') {
          store.updateDecor(dec.id, { x: Math.round(pos.x), y: Math.round(pos.y) });
        } else {
          // 细线：bbox 左上角即两端点外接矩形最小点，端点随整体平移量(rel)搬移
          const rel = (node.getData() as { rel?: { x1: number; y1: number; x2: number; y2: number } } | undefined)?.rel ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
          store.updateDecor(dec.id, {
            x1: Math.round(pos.x + rel.x1),
            y1: Math.round(pos.y + rel.y1),
            x2: Math.round(pos.x + rel.x2),
            y2: Math.round(pos.y + rel.y2),
          });
        }
      }
      // 整体拖动：跟随的节点是我们程序化移动的，它们不会各自触发 node:moved，
      // 必须在这里一起回写 store —— 否则画布上整组挪走了、存盘里还是旧坐标，重开工程就散架。
      if (groupDrag && groupDrag.anchor === node.id) {
        for (const p of groupDrag.peers) {
          const n = graph.getCellById(p.id) as import('@antv/x6').Node | undefined;
          if (!n) continue;
          const pos = n.getPosition();
          store.updateNode(p.id, { x: Math.round(pos.x), y: Math.round(pos.y) });
        }
        // 拖动结束后浏览器照样派发 click，放过去会把刚选好的一组缩成被拖的那一个
        groupDragMovedAt = Date.now();
        groupDrag = null;
      }
    });
  });
  // 多选整体拖动：按下时录基准，拖 anchor 时把同组其他节点按相同位移挪走
  graph.on('node:mousedown', ({ node, e }) => {
    // 按住「未被选中」的节点：先把选区切到它。否则会出现危险错觉 ——
    // 拖走的是这个节点，屏幕上另一组却还高亮着，此时按 Delete 删的是那一组。
    // 带修饰键时不动（Shift/Ctrl 加选逻辑在 node:click 里，这里动会让「加选」变成「减选」）；
    // 按的若是已选中的节点也不动 —— 那正是「整体移动」的入口。
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !selectedIds.value.includes(node.id)) setSelected([node.id]);
    beginGroupDrag(node.id);
  });
  graph.on('node:change:position', ({ node }) => syncGroupDrag(node.id));
  // Shift/Ctrl 点击 = 在已有选中上增删，普通点击 = 单选
  graph.on('node:click', ({ node, e }) => onNodeClick(node.id, !!(e.shiftKey || e.ctrlKey || e.metaKey)));
  graph.on('edge:click', ({ edge, e }) => onEdgeClick(edge.id, !!(e.shiftKey || e.ctrlKey || e.metaKey)));
  // 空白处左键按下 → 框选（X6 核心没有框选，官方 selection 插件自带选框渲染会与本页线图选中样式打架）
  graph.on('blank:mousedown', ({ e }) => {
    if (lineMode.value) {
      startLineDraw(e as { clientX: number; clientY: number });
      return;
    }
    startRubber(e as unknown as MouseEvent);
  });
  // 右键弹自定义上下文菜单（“属性”/“删除”），要点菜单项才进属性
  graph.on('node:contextmenu', ({ node, e }) =>
    showCtx((node.getData() as { decor?: boolean })?.decor ? 'decor' : 'node', node.id, e),
  );
  graph.on('edge:contextmenu', ({ edge, e }) => showCtx('link', edge.id, e));
  graph.on('blank:contextmenu', ({ e }) => {
    e.preventDefault();
    ctxMenu.kind = 'blank';
    ctxMenu.id = '';
    ctxMenu.x = e.clientX;
    ctxMenu.y = e.clientY;
    ctxMenu.show = true;
  });
  graph.on('node:added', ({ node }) => {
    const id = node.id;
    const data = (node.getData() ?? {}) as { kind?: string; decor?: boolean; name?: string; drawing?: boolean };
    if (data.drawing) return; // 画线拖拽中的预览节点：由 mouseup 决定是否落库
    if (data.decor) {
      // 装饰对象（文本 / 细线）落到画布 → 进 store.decors，不污染节点/生成器语义
      if (!store.decorMap.has(id)) {
        const pos = node.getPosition();
        if (data.kind === 'line') {
          store.addDecor({ id, kind: 'line', x1: Math.round(pos.x), y1: Math.round(pos.y), x2: Math.round(pos.x) + 120, y2: Math.round(pos.y), lineWidth: 2, dash: 'solid' });
        } else {
          store.addDecor({ id, kind: 'text', x: Math.round(pos.x), y: Math.round(pos.y), text: '文本', fontSize: 16 });
        }
      }
    } else if (!store.nodeMap.has(id)) {
      if (data.kind) {
        const pos = node.getPosition();
        // 名称以 data.name 为准（建节点时显式带过来，不经 X6 的 label 隐式映射），
        // 退路才读 attrs.label.text，最后兜底用 id。
        const name = data.name || String(node.attr('label/text') ?? '') || id;
        store.addNode({ id, name, kind: data.kind as NodeKind, x: Math.round(pos.x), y: Math.round(pos.y) });
      }
    }
    // 拖拽/点击落地：仅选中新对象，不再自动弹出属性
    if (!connectMode.value) setSelected([id]);
  });

  syncGraph();
  watch(() => store.project, syncGraph, { deep: true });
  window.addEventListener('resize', fitCanvas);
  document.addEventListener('click', hideCtx);
  document.addEventListener('keydown', onDocKey);
  document.addEventListener('keydown', onMenuKey);

  // 网格间距 / 点色深浅变化 → 重绘工作区背景
  watch([() => settings.gridSize, () => settings.gridGray], renderWorkspace);

  // 缩放条：ctrl+滚轮 / 视图操作引起的缩放也要同步到输入框
  graph.on('scale', syncZoomPct);
  syncZoomPct();
  document.addEventListener('click', closeZoomMenus);
  document.addEventListener('click', closeMenus); // 点菜单栏以外任意处关闭下拉（顶级项自身 @click.stop）
  canvasRef.value?.addEventListener('click', onCanvasClick, true);

  // Electron 关窗防护：dirty 实时上报主进程；「保存并关闭」由这里接管存盘
  const shell = window.epcomhil;
  if (shell?.setDirty) {
    watch(
      () => store.dirty,
      (v) => shell.setDirty!(v),
      { immediate: true },
    );
  }
  if (shell?.onSaveAndClose) {
    unlistenSaveAndClose = shell.onSaveAndClose(async () => {
      const ok = await saveCaseState();
      // 存盘成功才真正关窗；用户在保存对话框取消/存盘失败则留在应用
      if (ok) await shell.confirmClose!();
    });
  }
});
onBeforeUnmount(() => {
  rubberDetach?.(); // 正在框选时被卸载，别把 document 监听留在外面
  unlistenSaveAndClose?.();
  dndRef?.dispose();
  graph?.dispose();
  window.removeEventListener('resize', fitCanvas);
  canvasRef.value?.removeEventListener('click', onCanvasClick, true);
  document.removeEventListener('click', hideCtx);
  document.removeEventListener('click', closeZoomMenus);
  document.removeEventListener('click', closeMenus);
  document.removeEventListener('keydown', onDocKey);
  document.removeEventListener('keydown', onMenuKey);
  document.removeEventListener('click', closeMenus);
});
function fitCanvas() {
  graph?.centerContent();
}

// ---------- 画布缩放条（工具栏「居中」位置） ----------
// 版式参考截图：｜放大镜− ｜放大镜+ ｜百分比输入+预设▾ ｜适应画布+视图▾
const ZOOM_MIN = 20; // 20%
const ZOOM_MAX = 400; // 400%
const ZOOM_STEP = 10; // 点一次 ±10%
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];

const zoomPct = ref(100); // 当前缩放百分比
const zoomText = ref('100'); // 输入框文本（聚焦编辑时不跟手回写）
const zoomEditing = ref(false);
const zoomMenuOpen = ref(false); // 百分比预设下拉
const viewMenuOpen = ref(false); // 视图操作下拉

/** 读 X6 当前缩放 → 回写输入框；用户正在输入时不覆盖 */
function syncZoomPct() {
  if (!graph) return;
  const pct = Math.round((graph.scale()?.sx ?? 1) * 100);
  zoomPct.value = pct;
  if (!zoomEditing.value) zoomText.value = String(pct);
}
/** 按百分比缩放（越界夹紧），并立即回写输入框 */
function setZoomPct(pct: number) {
  if (!graph) return;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(pct)));
  graph.zoomTo(next / 100);
  zoomPct.value = next;
  zoomText.value = String(next);
}
function zoomBy(delta: number) {
  zoomMenuOpen.value = false;
  setZoomPct(zoomPct.value + delta);
}
/** 实际大小 100%：先精确缩放到 1:1，再把工作区画布（settings 定义的宽高）几何中心
    对准视口中心，使白色画布四周留白均匀对称（保留大量空白看整体，而非顶到一角）。 */
function actualSize() {
  if (!graph) return;
  graph.zoomTo(1);
  graph.centerPoint(settings.width / 2, settings.height / 2);
  zoomPct.value = 100;
  zoomText.value = '100';
}
/** 输入框提交：非法值回退到当前缩放 */
function commitZoomText() {
  zoomEditing.value = false;
  const n = Number.parseFloat(zoomText.value.replace(/[^0-9.]/g, ''));
  if (Number.isFinite(n) && n > 0) setZoomPct(n);
  else zoomText.value = String(zoomPct.value);
}
function pickZoomPreset(p: number) {
  zoomMenuOpen.value = false;
  setZoomPct(p);
}
/** 适应画布：把整张工作区画布（settings 宽高）缩放到铺满并居中视口，白色画布四周只留
    少量灰边。不按节点适配——节点变细不会让大画布被顶向一角、留出大片空白。
    空画布同样适用（仍是整张工作区）。 */
function fitZoom() {
  viewMenuOpen.value = false;
  if (!graph) return;
  graph.zoomToRect(
    {
      x: 0,
      y: 0,
      width: settings.width,
      height: settings.height,
    },
    { padding: 0, minScale: ZOOM_MIN / 100, maxScale: 1 },
  );
  syncZoomPct();
}
function closeZoomMenus() {
  zoomMenuOpen.value = false;
  viewMenuOpen.value = false;
}

// ---------- 点击画布 → 工具栏右侧显示工作区宽高 ----------
// 用捕获阶段监听：X6 自己在节点/链路事件里可能拦住冒泡，捕获能保证不漏。
// 只置位不重置 —— 点过一次后就常驻，宽高改了会跟着刷新（settings 是响应式的）。
const showWsInfo = ref(false);
function onCanvasClick() {
  showWsInfo.value = true;
}

// ---------- 画布节点样式（线图） ----------
// 节点与左侧组件库统一走「白底 + 主题色描边 + 线稿图标 + 名称」。
// 图标要落到节点上只能用 image 元素，而 X6 默认 markup 只有 rect + text，所以必须自定义 markup。
// 节点本体不画外框，只有「线稿图标 + 下方名称」，与左侧组件库保持一致。
// rect 仍然保留但不描边、填充透明——它只承担两件事：点击/拖拽的命中区、选中时的浅蓝底。
const NODE_W = 40;
const NODE_H = 36;
const ICON_SIZE = 36; // 与节点同高：图标本身就是节点，不再缩小塞进框里
const NODE_FILL = 'transparent';
const SELECT_FILL = 'rgba(47, 129, 247, 0.12)';
const LABEL_DY = 30; // 相对节点中心下移量 → 落在节点下缘外侧、居中于图标下方
const LABEL_FONT = 12;
/** 未选中态的本体属性：无描边、透明，只作为命中区 */
const NODE_BODY = { fill: NODE_FILL, stroke: 'none', strokeWidth: 0, rx: 4, ry: 4, pointerEvents: 'all' as const };
const NODE_MARKUP = [
  { tagName: 'rect', selector: 'body' },
  { tagName: 'image', selector: 'icon' },
  { tagName: 'text', selector: 'label' },
];
// 链路线的常态/选中态：选中靠「变亮 + 加粗」双通道，缩放到 20% 时也还看得见
const EDGE_LINE = { stroke: '#3a6ea5', strokeWidth: 2 };
const EDGE_HIT = { stroke: '#3a6ea5', strokeWidth: 14, strokeOpacity: 0.01, pointerEvents: 'all' };
const EDGE_LINE_SEL = { stroke: '#2f81f7', strokeWidth: 4 };
// 链路两端不绘制箭头（纯线）。必须同时清掉三层：
//  - X6 Shape.Edge 默认的 `line`（自带 targetMarker:'classic' 默认箭头）与 `wrap` 层
//  - 本项目自绘的 `connection` 双层（命中带 + 可视线）
// 缺一不可：默认 line 的箭头一直存在，是「箭头清不掉」的根因。对已存在旧边也幂等补写，
// 保证 HMR/热更新与整页重载下都是纯线。
function applyEdgePlain(e: import('@antv/x6').Edge) {
  // 可见线本体是 X6 默认 `line`（connection 数组按行映射，connection/1 ≡ line）。
  // 默认给它挂了 targetMarker:'classic'——这就是「清不掉的箭头」根因。
  // 正确做法：保留 line 画线，只显式清掉它的 source/target 箭头。
  e.attr('line/stroke', EDGE_LINE.stroke);
  e.attr('line/strokeWidth', EDGE_LINE.strokeWidth);
  e.attr('line/sourceMarker', null);
  e.attr('line/targetMarker', null);
  // 顺带清掉默认命中层与前面迭代可能残留的自绘层箭头，杜绝遗漏
  e.attr('wrap/sourceMarker', null);
  e.attr('wrap/targetMarker', null);
  e.attr('connection/0/sourceMarker', null);
  e.attr('connection/0/targetMarker', null);
  e.attr('connection/1/sourceMarker', null);
  e.attr('connection/1/targetMarker', null);
}

/** 新建节点 / 拖拽预览节点的完整属性（两者必须同源，否则拖拽途中和落地后长得不一样） */
function nodeIconAttrs(kind: NodeKind) {
  return {
    'xlink:href': nodeIconDataUri(kind, 1.2),
    x: (NODE_W - ICON_SIZE) / 2,
    y: (NODE_H - ICON_SIZE) / 2,
    width: ICON_SIZE,
    height: ICON_SIZE,
  };
}
/** 图标水平镜像：只翻图标不翻文字（Visio 习惯）。icon 水平居中，绕自身中心翻 = translate(W,0) scale(-1,1) */
const ICON_FLIP_TRANSFORM = `translate(${NODE_W},0) scale(-1,1)`;
function applyIconFlip(cell: import('@antv/x6').Cell, flip: boolean) {
  // 注意 X6 的 attr 是深合并：flip→false 时必须显式置 null 移除 transform，否则残留
  cell.attr('icon/transform', flip ? ICON_FLIP_TRANSFORM : null);
}
function readIconFlip(cell: import('@antv/x6').Cell): boolean {
  return Boolean(cell.attr('icon/transform'));
}
function nodeAttrs(kind: NodeKind, name: string) {
  return {
    body: { ...NODE_BODY },
    icon: nodeIconAttrs(kind),
    label: {
      text: name,
      // 注意：X6 会给 text 元素生成 `transform=translate(refX*W, refY*H)`，
      // 因此这里的 x/y 是**相对节点中心**的偏移，不是左上角坐标。
      // 写成左上角坐标（如 x:44,y:34）会连中心的 translate 一起叠加，文字被推出节点外。
      refX: '50%',
      refY: '50%',
      x: 0,
      y: LABEL_DY,
      textAnchor: 'middle',
      textVerticalAnchor: 'middle',
      fill: '#0e1116',
      fontSize: LABEL_FONT,
      fontWeight: 600,
    },
  };
}

// ---------- 画布装饰对象（文本 / 细线）----------
// 纯绘图层：复用 X6 Node 渲染与选中/拖动/右键交互，但独立存于 store.project.decors，
// 不进 NodeConfig/生成器语义（不参与 IP 规划与 ns-3 代码生成）。
const DECOR_TEXT_W = 200;
const DECOR_LINE_HIT = 10; // 细线命中带：线很细，加一条透明加宽带才好点选
const DECOR_DASH: Record<NonNullable<LineDecorConfig['dash']>, string | null> = {
  solid: null,
  dash: '6 4',
  dot: '2 3',
  dashdot: '10 4 2 3',
};
function textLabelAttr(d: TextDecorConfig) {
  const font = d.fontSize ?? 16;
  return {
    text: d.text ?? '文本',
    refX: '2%',
    refY: '2%',
    x: 0,
    y: 0,
    textAnchor: 'start' as const,
    textVerticalAnchor: 'top' as const,
    fill: d.color ?? '#0e1116',
    fontSize: font,
    fontWeight: d.bold ? 700 : 400,
  };
}
/** 装饰对象规格的具体返回类型：字段全部必填，落到 X6 时仍与 Node.Metadata 结构兼容 */
interface DecorCellSpec {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  markup: Array<{ tagName: string; selector: string }>;
  data: { decor: true; kind: 'text' | 'line'; rel?: { x1: number; y1: number; x2: number; y2: number } };
  attrs: Record<string, any>;
}
/** 装饰对象的 X6 node 规格（新建预览与落盘渲染同一份，保证拖拽途中和落地后一致） */
function decorCellSpec(d: DecorConfig): DecorCellSpec {
  if (d.kind === 'text') {
    return {
      id: d.id,
      x: d.x,
      y: d.y,
      width: DECOR_TEXT_W,
      height: Math.max((d.fontSize ?? 16) * 1.6, 26),
      markup: [
        { tagName: 'rect', selector: 'body' },
        { tagName: 'text', selector: 'label' },
      ],
      data: { decor: true, kind: 'text' as const },
      attrs: {
        body: { fill: 'transparent', stroke: 'none', strokeWidth: 0, rx: 3, ry: 3, pointerEvents: 'all' as const },
        label: textLabelAttr(d),
      },
    };
  }
  const minX = Math.min(d.x1, d.x2);
  const minY = Math.min(d.y1, d.y2);
  const rel = { x1: d.x1 - minX, y1: d.y1 - minY, x2: d.x2 - minX, y2: d.y2 - minY };
  const lw = d.lineWidth ?? 2;
  const hit = Math.max(lw, DECOR_LINE_HIT);
  return {
    id: d.id,
    x: minX,
    y: minY,
    width: Math.max(1, Math.abs(d.x2 - d.x1)),
    height: Math.max(1, Math.abs(d.y2 - d.y1)),
    markup: [
      { tagName: 'rect', selector: 'body' },
      { tagName: 'path', selector: 'hitline' },
      { tagName: 'path', selector: 'line' },
    ],
    data: { decor: true, kind: 'line' as const, rel },
    attrs: {
      body: { fill: 'transparent', stroke: 'none', strokeWidth: 0, rx: 2, ry: 2, pointerEvents: 'all' as const },
      hitline: {
        d: `M ${rel.x1} ${rel.y1} L ${rel.x2} ${rel.y2}`,
        stroke: 'rgba(47,129,247,0)',
        strokeWidth: hit,
        fill: 'none',
        pointerEvents: 'all' as const,
      },
      line: {
        d: `M ${rel.x1} ${rel.y1} L ${rel.x2} ${rel.y2}`,
        stroke: d.color ?? '#3a6ea5',
        strokeWidth: lw,
        fill: 'none',
        strokeLinecap: 'round' as const,
        strokeDasharray: DECOR_DASH[d.dash ?? 'solid'] ?? undefined,
      },
    },
  };
}
/** 数据 ↔ 画布 reconcile：装饰对象（文本/细线） */
function renderDecors() {
  if (!graph) return;
  for (const d of store.project.decors ?? []) {
    const cell = graph.getCellById(d.id) as import('@antv/x6').Node | undefined;
    const spec = decorCellSpec(d);
    if (!cell) {
      graph.addNode(spec);
      continue;
    }
    const pos = cell.getPosition();
    if (Math.round(pos.x) !== Math.round(spec.x) || Math.round(pos.y) !== Math.round(spec.y)) cell.setPosition(spec.x, spec.y);
    const sz = cell.size();
    if (sz.width !== spec.width || sz.height !== spec.height) cell.resize(spec.width, spec.height);
    if (d.kind === 'text') {
      cell.attr('label', { ...spec.attrs.label });
    } else {
      const rel = spec.data.rel!;
      cell.attr('hitline', { ...spec.attrs.hitline });
      cell.attr('line', { ...spec.attrs.line });
      cell.setData({ decor: true, kind: 'line', rel });
    }
  }
  const liveDecor = new Set((store.project.decors ?? []).map((x) => x.id));
  for (const n of graph.getNodes()) {
    const nd = n.getData() as { decor?: boolean } | undefined;
    if (nd?.decor && !liveDecor.has(n.id)) graph.removeCell(n.id);
  }
}
function makeDecor(kind: DecorKind, pos?: { x: number; y: number }): DecorConfig {
  const id = store.nextId('d');
  if (kind === 'line') {
    const x = pos?.x ?? 160;
    const y = pos?.y ?? 160;
    return { id, kind, x1: x, y1: y, x2: x + 120, y2: y, lineWidth: 2, dash: 'solid' };
  }
  return { id, kind, x: pos?.x ?? 160, y: pos?.y ?? 160, text: '文本', fontSize: 16 };
}

// ---------- 数据 ↔ 画布 reconcile ----------
function syncGraph() {
  if (!graph) return;
  let upgraded = false;
  const ids = new Set(graph.getNodes().map((n) => n.id));
  for (const n of store.project.nodes) {
    const cell = graph.getCellById(n.id) as import('@antv/x6').Node | undefined;
    if (!cell) {
      graph.addNode({
        id: n.id,
        x: n.x ?? 40,
        y: n.y ?? 40,
        width: NODE_W,
        height: NODE_H,
        markup: NODE_MARKUP,
        angle: n.angle ?? 0,
        data: { kind: n.kind, name: n.name },
        attrs: nodeAttrs(n.kind, n.name || n.id),
      });
      if (n.flipX) applyIconFlip(graph.getCellById(n.id)!, true);
    } else {
      // 升级判据三选一：缺 icon（老 markup）、还画着外框（线图之前的样式）、图标尺寸不是当前尺寸。
      // 判据不用颜色——颜色会被选中态改掉，拿它当判据会把选中样式顶回去。
      const markup = cell.getMarkup();
      const hasIcon = Array.isArray(markup) && markup.some((m) => (m as { selector?: string }).selector === 'icon');
      const bodyAttr = (cell.attr('body') ?? {}) as { stroke?: string };
      const iconAttr = (cell.attr('icon') ?? {}) as { width?: number };
      const framed = !!bodyAttr.stroke && bodyAttr.stroke !== 'none';
      const staleIcon = (iconAttr.width ?? 0) !== ICON_SIZE;
      if (!hasIcon || framed || staleIcon) {
        cell.setMarkup(NODE_MARKUP);
        cell.attr('body', { ...NODE_BODY });
        cell.attr('icon', nodeIconAttrs(n.kind));
        cell.attr('label', { y: LABEL_DY, fontSize: LABEL_FONT });
        cell.size(NODE_W, NODE_H);
        upgraded = true;
      }
      if ((cell.attr('label') as { text?: string }).text !== (n.name || n.id)) {
        cell.attr('label', { text: n.name || n.id });
      }
      // 位置 reconcile：撤销/重做会把 store 整体回滚，而已存在的 X6 cell 只有
      // 节点自己拖动才会改位置（syncGraph 原本不回写坐标）——补上「store 说了算」的一侧。
      // 拖动正常路径无冲突：node:moved 先写 store，快照后两者一致，这里即 no-op。
      if (n.x != null && n.y != null) {
        const pos = cell.getPosition();
        if (Math.round(pos.x) !== n.x || Math.round(pos.y) !== n.y) cell.setPosition(n.x, n.y);
      }
      // 角度 / 镜像 reconcile：同一套「store 说了算」逻辑（撤销回滚、载入案例都会走这里）
      if ((cell.getAngle?.() ?? 0) !== (n.angle ?? 0)) cell.rotate(n.angle ?? 0, { absolute: true });
      if (readIconFlip(cell) !== Boolean(n.flipX)) applyIconFlip(cell, Boolean(n.flipX));
    }
  }
  if (upgraded) setSelected([...selectedIds.value], [...selectedEdgeIds.value]); // 升级会把 body 打回未选中态，重放一次当前选中
  for (const id of ids) {
    const c = graph.getCellById(id) as import('@antv/x6').Node | undefined;
    if (c && (c.getData() as { decor?: boolean })?.decor) continue; // 装饰对象由 renderDecors 管理
    if (!store.nodeMap.has(id)) graph.removeCell(id);
  }

  const eIds = new Set(graph.getEdges().map((e) => e.id));
  for (const l of store.project.links) {
    if (!eIds.has(l.id))
      graph.addEdge({
        id: l.id,
        source: l.nodeA,
        target: l.nodeB,
        label: { text: `${l.dataRate ?? ''}${l.delay ? '/' + l.delay : ''}`, attrs: { text: { fill: '#4a5a6b', fontSize: 10 } }, position: 0.5 },
        // 双层连接：上层可视细线 + 下层不可见加宽命中带。2px 细线极难点中，
        // 加 14px 的透明命中带后，在线两侧约 7px 范围内都能点选/框选到链路。
        // 链路为纯线，两端不设 marker 箭头。
        attrs: {
          connection: [
            { ...EDGE_HIT, sourceMarker: null, targetMarker: null },
            { ...EDGE_LINE, sourceMarker: null, targetMarker: null },
          ],
        },
      });
  }
  // 对已存在链路也统一清除箭头 marker：HMR/热更新不会重建已有边，只有整页重载才会重新
  // addEdge。这里幂等补写，保证「无箭头」在运行中即时生效、不依赖刷新与旧渲染状态。
  for (const e of graph.getEdges()) applyEdgePlain(e);
  for (const id of eIds) if (!store.project.links.some((l) => l.id === id)) graph.removeCell(id);

  renderDecors();

  // 选区修剪：删节点会级联删掉挂在它上面的链路，载入案例又会整批换掉 cell，
  // 不修剪的话选区里留着幽灵 id —— Shift 加选时会带着它们一起算，越用越脏。
  const liveNodes = new Set(graph.getNodes().map((n) => n.id));
  const liveEdges = new Set(graph.getEdges().map((e) => e.id));
  if (selectedIds.value.some((id) => !liveNodes.has(id)))
    selectedIds.value = selectedIds.value.filter((id) => liveNodes.has(id));
  if (selectedEdgeIds.value.some((id) => !liveEdges.has(id)))
    selectedEdgeIds.value = selectedEdgeIds.value.filter((id) => liveEdges.has(id));
}

// ---------- 交互：添加 / 连线 / 编辑 ----------
// id 一律走 store.nextNodeId：纯数字短号（1、2、3…），既避免各页各自自增而撞号，
// 也保证生成侧拼出的 n_1 是合法 C++ 标识符（X6 自动 uuid 含短横线，会产出非法变量名）。
function makeNode(kind: NodeKind, pos?: { x: number; y: number }): NodeConfig {
  return { id: store.nextNodeId(), name: store.nextNodeName(kind), kind, ...(pos ?? {}) };
}

function addFromLibrary(kind: NodeKind) {
  const n = makeNode(kind);
  store.addNode(n);
  openNode(n);
}

// 拖拽建模：X6 官方 Dnd 插件，组件库项 mousedown 启动，拖到画布 drop 即建节点
// 预览节点必须显式带上 id / data.name / attrs.label.text：
// Dnd 落点时会 clone 一次，只有写进 cell 数据里的东西才会被带过去。
function startLibDrag(kind: NodeKind, ev: MouseEvent) {
  ev.preventDefault();
  const n = makeNode(kind);
  const node = graph.createNode({
    id: n.id,
    x: 0,
    y: 0,
    width: NODE_W,
    height: NODE_H,
    markup: NODE_MARKUP,
    data: { kind, name: n.name },
    attrs: nodeAttrs(kind, n.name),
  });
  dndRef.start(node, ev as any);
}

// ---- 画布装饰对象（文本 / 细线）交互 ----
/** 点击加入：画布中心放置一个默认装饰并打开属性编辑 */
function addDecorFromLibrary(kind: DecorKind) {
  // 以画布可见区域中心作为落点（把容器中心转换到画布本地坐标），无画布时回退到 (200,200)
  let c = { x: 200, y: 200 };
  if (graph) {
    const el = graph.container;
    const r = el.getBoundingClientRect();
    c = graph.clientToLocal(r.left + r.width / 2, r.top + r.height / 2);
  }
  const d = makeDecor(kind, c);
  store.addDecor(d);
  openDecorDlg(d.id);
}
/** 拖拽加入：预览对象用 decorCellSpec 同源规格，落点由 node:added 判决写入 store.decors */
function startDecorDrag(kind: DecorKind, ev: MouseEvent) {
  ev.preventDefault();
  const d = makeDecor(kind);
  const node = graph.createNode(decorCellSpec(d));
  dndRef.start(node, ev as any);
}

// ---- 细线通用：用两端绝对坐标刷新一条细线节点的外框/路径（画线预览共用） ----
// 只取用到的这几个方法，避免 X6 顶层 Node/Cell 类型与 graph.addNode 实际返回类型不一致的问题
interface WritableCell {
  setPosition(x: number, y: number, options?: unknown): unknown;
  size(width?: number, height?: number): unknown;
  setData(data: unknown): unknown;
  attr(selector: string, patch: unknown): unknown;
}
function applyLineNode(node: WritableCell, x1: number, y1: number, x2: number, y2: number) {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const rel = { x1: x1 - minX, y1: y1 - minY, x2: x2 - minX, y2: y2 - minY };
  node.setPosition(minX, minY);
  node.size(Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1)));
  node.setData({ decor: true, kind: 'line', rel });
  const path = `M ${rel.x1} ${rel.y1} L ${rel.x2} ${rel.y2}`;
  node.attr('hitline', { d: path });
  node.attr('line', { d: path });
}

// ---- Visio 式画线：开启后空白处按住左键拖拽即定一条任意方向细线 ----
function toggleLineMode() {
  if (lineMode.value) exitLineMode();
  else {
    lineMode.value = true;
    ElMessage.info('画线模式：在画布上按住左键拖出细线，再次点击本按钮或按 Esc 退出');
  }
}
function exitLineMode() {
  if (!lineMode.value) return;
  lineMode.value = false;
  cancelLineDrawing();
}
/** 取消/丢弃正在拖的画线预览 */
function cancelLineDrawing() {
  const ln = lineDrawing.value;
  lineDrawing.value = null;
  if (ln && !(ln.node as unknown as { isDisposed?: () => boolean }).isDisposed?.()) graph.removeCell(ln.id);
}
/** 空白处按下：标记起点并建立一个预览细线，随鼠标拖拽实时伸向终点 */
function startLineDraw(e: { clientX: number; clientY: number }) {
  if (lineDrawing.value) cancelLineDrawing(); // 防御：上一根未松手
  const start = graph.clientToLocal(e.clientX, e.clientY);
  const id = store.nextId('d');
  const spec = decorCellSpec({ id, kind: 'line', x1: start.x, y1: start.y, x2: start.x, y2: start.y });
  const node = graph.addNode({ ...spec, data: { decor: true, kind: 'line', drawing: true, rel: spec.data.rel } } as never);
  lineDrawing.value = { id, sx: start.x, sy: start.y, node };
  const DROP_MIN = 6; // 拖得不足这个像素当误触，不建线
  const onMove = (ev: MouseEvent) => {
    const ln = lineDrawing.value;
    if (!ln) return;
    const pt = graph.clientToLocal(ev.clientX, ev.clientY);
    applyLineNode(ln.node, ln.sx, ln.sy, pt.x, pt.y);
  };
  const onUp = (ev: MouseEvent) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const ln = lineDrawing.value;
    lineDrawing.value = null;
    if (!ln) return;
    const pt = graph.clientToLocal(ev.clientX, ev.clientY);
    if (Math.hypot(pt.x - ln.sx, pt.y - ln.sy) < DROP_MIN) {
      graph.removeCell(ln.id); // 误触：丢弃预览，不落库
      return;
    }
    // 成功：预览节点几何已是最终形状，保留它，落库后由 renderDecors 收尾（含 data 去 drawing 标记）
    store.addDecor({
      id: ln.id,
      kind: 'line',
      x1: Math.round(ln.sx),
      y1: Math.round(ln.sy),
      x2: Math.round(pt.x),
      y2: Math.round(pt.y),
      lineWidth: 2,
      dash: 'solid',
    });
    setSelected([ln.id]);
    // 画完留在画线模式：可连续再画（Visio 的画线工具习惯），Esc/再点按钮退出
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function onNodeClick(id: string, additive = false) {
  // 整体拖动结束后浏览器仍会派发 click（X6 的 onClick 只做转发，没有「拖动过就跳过」的判定），
  // 放过去会把刚拖完的一组缩成被拖的那一个。用时间窗吞掉这一次。
  if (Date.now() - groupDragMovedAt < 300) return;
  if (connectMode.value) {
    if (!pendingSrc.value) {
      pendingSrc.value = id;
      ElMessage.info(`已选源节点 ${id}，请选择目标节点`);
      return;
    }
    if (pendingSrc.value === id) return;
    createLink(pendingSrc.value, id);
    pendingSrc.value = null;
    connectMode.value = false;
    return;
  }
  if (additive) {
    // Shift/Ctrl 点击：已选中的移出选区，未选中的并入选区（链路选区原样保留）
    setSelected(
      selectedIds.value.includes(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id],
      selectedEdgeIds.value,
    );
  } else {
    // 普通点击：节点属于持久分组时选整组 —— 拖动联动（beginGroupDrag 跟着选区走）由此免费获得
    const g = groupOf(id);
    setSelected(g ? [...g.members] : [id]);
  }
}

/** 单击链路：与节点对称，支持 Shift/Ctrl 加减选 */
function onEdgeClick(id: string, additive = false) {
  if (connectMode.value) return; // 连线模式下的点击留给选端点，别被链路吞掉
  if (additive) {
    setSelected(
      selectedIds.value,
      selectedEdgeIds.value.includes(id)
        ? selectedEdgeIds.value.filter((x) => x !== id)
        : [...selectedEdgeIds.value, id],
    );
  } else {
    setSelected([], [id]);
  }
}

// 选中高亮（节点 + 链路都支持多选）+ Delete/Backspace 删除选中的节点与链路
function setSelected(ids: string[], edgeIds: string[] = []) {
  selectedIds.value = ids;
  selectedEdgeIds.value = edgeIds;
  if (!graph) return;
  const picked = new Set(ids);
  for (const n of graph.getNodes()) {
    const sel = picked.has(n.id);
    const nd = n.getData() as { kind?: NodeKind; decor?: boolean } | undefined;
    if (nd?.decor) {
      // 装饰对象（文本 / 细线）：选中只给轻量描边 + 淡灰底，不给整框涂色
      n.attr('body/stroke', sel ? '#64748b' : 'none');
      n.attr('body/strokeWidth', sel ? 1 : 0);
      n.attr('body/fill', sel ? 'rgba(100,116,139,0.08)' : 'transparent');
      continue;
    }
    const kind = nd?.kind;
    // 节点平时不画外框（框会盖过线图）。选中时才把框显出来：类型色描边 + 浅蓝底，
    // 既有明确的选中反馈，又不去改图标自身的颜色。
    const stroke = kind ? CANVAS_COLOR[kind] : '#64748b';
    n.attr('body/stroke', sel ? stroke : 'none');
    n.attr('body/strokeWidth', sel ? 1.6 : 0);
    n.attr('body/fill', sel ? SELECT_FILL : NODE_FILL);
  }
  const pickedEdges = new Set(edgeIds);
  for (const e of graph.getEdges()) {
    const sel = pickedEdges.has(e.id);
    // 可见线本体是 X6 默认 `line` 层；选中时加亮 + 加粗。
    // connection 数组实为按行映射到 wrap/line（connection/1 ≡ line），同步写一份保险。
    e.attr('line/stroke', sel ? EDGE_LINE_SEL.stroke : EDGE_LINE.stroke);
    e.attr('line/strokeWidth', sel ? EDGE_LINE_SEL.strokeWidth : EDGE_LINE.strokeWidth);
    e.attr('connection/1/stroke', sel ? EDGE_LINE_SEL.stroke : EDGE_LINE.stroke);
    e.attr('connection/1/strokeWidth', sel ? EDGE_LINE_SEL.strokeWidth : EDGE_LINE.strokeWidth);
  }
}
/** 删除当前选中（节点 + 链路 + 装饰对象）：Delete/Backspace 键与编辑菜单共用这一份 */
function deleteSelected() {
  const nodeIds = [...selectedIds.value].filter((id) => !store.decorMap.has(id));
  const decorIds = [...selectedIds.value].filter((id) => store.decorMap.has(id));
  const edgeIds = [...selectedEdgeIds.value];
  if (!nodeIds.length && !decorIds.length && !edgeIds.length) return;
  // 一次删除（N 节点 + 级联链路 + M 装饰）算一步撤销
  store.batch(() => {
    nodeIds.forEach((id) => store.removeNode(id));
    decorIds.forEach((id) => store.removeDecor(id));
    // 删节点会级联删掉挂它的链路 —— 那些已经在 store 里没了，跳过，免得重复删、也别算进条数
    let removedEdge = 0;
    edgeIds.forEach((id) => {
      if (store.project.links.some((l) => l.id === id)) {
        store.removeLink(id);
        removedEdge += 1;
      }
    });
  });
  setSelected([], []);
  const parts: string[] = [];
  if (nodeIds.length) parts.push(`${nodeIds.length} 个节点`);
  if (edgeIds.length) parts.push(`${edgeIds.length} 条链路`);
  if (decorIds.length) parts.push(`${decorIds.length} 个绘图对象`);
  if (parts.length) ElMessage.info(`已删除选中：${parts.join(' · ')}`);
}
function onDocKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'Escape' && lineMode.value) {
    exitLineMode();
    return;
  }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  e.preventDefault();
  deleteSelected();
}

// ---------- 多选整体拖动 ----------
// X6 原生拖动只搬一个 cell（view/node.js: dragNode → node.setPosition，单节点）。
// 官方 selection 插件之所以能整组搬，是 notifyNodeMove 里会把事件广播给所有选中的 cell；
// 而那个插件已被排除（自带外框渲染，与线图选中样式打架）。所以这里自己同步：
// 拖动中节点走的是 node.setPosition(pos, { deep: true, ui: true })，会发 change:position，
// 拿 anchor 当前位移去改同组其他节点即可。
// 基准必须在「按下」时刻录 —— 不能用 change:position 的 previous，那是逐帧的上一帧、不是拖动起点。
interface GroupDragPeer {
  id: string;
  base: { x: number; y: number };
}
let groupDrag: { anchor: string; base: { x: number; y: number }; peers: GroupDragPeer[] } | null = null;
/** 整体拖动真正发生过的时刻；拖动结束后浏览器照样发 click，不拦就会把选区缩成一个 */
let groupDragMovedAt = 0;

function beginGroupDrag(anchorId: string) {
  groupDrag = null; // 每次按下都重建，别让上一次的残留在后面误伤
  if (!graph || selectedIds.value.length < 2) return;
  if (!selectedIds.value.includes(anchorId)) return; // 拖未选中的节点，不该带走上一次的选区
  const anchor = graph.getCellById(anchorId) as import('@antv/x6').Node | undefined;
  if (!anchor) return;
  const peers: GroupDragPeer[] = [];
  for (const id of selectedIds.value) {
    if (id === anchorId) continue;
    const n = graph.getCellById(id) as import('@antv/x6').Node | undefined;
    if (n) peers.push({ id, base: { ...n.getPosition() } });
  }
  if (!peers.length) return;
  groupDrag = { anchor: anchorId, base: { ...anchor.getPosition() }, peers };
}

function syncGroupDrag(movedId: string) {
  if (!graph || !groupDrag || groupDrag.anchor !== movedId) return;
  const anchor = graph.getCellById(movedId) as import('@antv/x6').Node | undefined;
  if (!anchor) return;
  const pos = anchor.getPosition();
  const dx = pos.x - groupDrag.base.x;
  const dy = pos.y - groupDrag.base.y;
  if (!dx && !dy) return;
  // 改 peers 的位置同样会发 change:position，但那时事件里的 node 是 peer、不是 anchor，
  // 会在上面第一行被挡掉 —— 所以不需要额外的「同步中」标志位。
  // 用「位移量平移」而不是「重新吸附网格」：保持组内相对位置原样，也不引入二次吸入。
  for (const p of groupDrag.peers) {
    const n = graph.getCellById(p.id) as import('@antv/x6').Node | undefined;
    n?.position(p.base.x + dx, p.base.y + dy);
  }
}

// ---------- 框选（rubber-band） ----------
// 为什么不用 @antv/x6-plugin-selection：它自带 selection box 渲染（就是上一版明确去掉的那种「外框」），
// 而且它维护自己的一套选中态，会和这里的线图选中样式（类型色描边 + 浅蓝底）打架。
// 我们只需要「拖出矩形 → 拿到落进来的节点 id」，X6 核心的 clientToLocal + getNodesInArea 已经够用，零依赖。
// 坐标分两套：DOM 选框用「相对画布容器的 CSS 像素」，命中判定用「client 坐标 → 画布局部坐标」。
const rubber = reactive({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 });
const rubberBox = computed(() => ({
  left: `${Math.min(rubber.x1, rubber.x2)}px`,
  top: `${Math.min(rubber.y1, rubber.y2)}px`,
  width: `${Math.abs(rubber.x2 - rubber.x1)}px`,
  height: `${Math.abs(rubber.y2 - rubber.y1)}px`,
}));

// 拖动过程中挂在 document 上的监听；组件卸载时要能摘掉
let rubberDetach: (() => void) | null = null;

// 框选链路用的几何判据（Edge 上没有「按比例取点」的 API，取折线再判线段相交更准）
type Pt = { x: number; y: number };
/** 两线段是否相交（标准叉积判据；框选遇不到共线退化的情形） */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
/** 线段是否穿过轴对齐矩形（含任一端点落在矩形内的情形） */
function segmentHitsRect(p: Pt, q: Pt, r: { x: number; y: number; w: number; h: number }) {
  if (Math.max(p.x, q.x) < r.x || Math.min(p.x, q.x) > r.x + r.w) return false;
  if (Math.max(p.y, q.y) < r.y || Math.min(p.y, q.y) > r.y + r.h) return false;
  const inside = (a: Pt) => a.x >= r.x && a.x <= r.x + r.w && a.y >= r.y && a.y <= r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const corners: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i += 1) if (segmentsCross(p, q, corners[i], corners[(i + 1) % 4])) return true;
  return false;
}

function startRubber(e: MouseEvent) {
  if (e.button !== 0 || connectMode.value) return; // 只认左键；连线模式下左键要用来依次点两个节点
  const el = canvasRef.value;
  const box = el?.getBoundingClientRect();
  if (!el || !box) return;
  // 选框 DOM 挂在 .canvas-wrap 上（它才是 position:relative 的容器），要换算成相对它的偏移
  const offX = el.offsetLeft;
  const offY = el.offsetTop;
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const origin = { x: e.clientX, y: e.clientY };

  rubber.active = true;
  rubber.x1 = rubber.x2 = e.clientX - box.left + offX;
  rubber.y1 = rubber.y2 = e.clientY - box.top + offY;

  const onMove = (ev: MouseEvent) => {
    rubber.x2 = ev.clientX - box.left + offX;
    rubber.y2 = ev.clientY - box.top + offY;
  };
  const detach = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    rubberDetach = null;
  };
  const onUp = (ev: MouseEvent) => {
    detach();
    rubber.active = false;
    finishRubber(origin, ev, additive);
  };
  rubberDetach = detach;
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function finishRubber(origin: { x: number; y: number }, end: MouseEvent, additive: boolean) {
  if (!graph) return;
  // 位移过小＝点空白而不是框选：按「点空白清空选中」处理
  if (Math.abs(end.clientX - origin.x) < 3 && Math.abs(end.clientY - origin.y) < 3) {
    setSelected([], []);
    return;
  }
  const p1 = graph.clientToLocal(origin.x, origin.y);
  const p2 = graph.clientToLocal(end.clientX, end.clientY);
  const ax = Math.min(p1.x, p2.x);
  const ay = Math.min(p1.y, p2.y);
  const aw = Math.abs(p2.x - p1.x);
  const ah = Math.abs(p2.y - p1.y);
  // 默认（非 strict）语义是「与矩形相交即命中」，与主流组态软件一致。
  // 链路不能走 graph.model.getEdgesInArea：它拿边的 bbox 判相交，一条斜边的 bbox
  // 能铺满半个画布，框一小块就会顺带选上一堆根本没碰到的链路。改用两条明确的判据：
  //   ① 两端节点都被框进来 → 这条链路属于框选范围（批量选片区的常规预期）
  //   ② 边的折线真的穿过矩形 → 单独框住一条链路的中段也能选中
  const hitNodes = graph.getNodesInArea(ax, ay, aw, ah).map((n) => n.id);
  const hitSet = new Set(hitNodes);
  const rect = { x: ax, y: ay, w: aw, h: ah };
  const hitEdges = graph
    .getEdges()
    .filter((e) => {
      const s = e.getSourceCellId();
      const t = e.getTargetCellId();
      if (s && t && hitSet.has(s) && hitSet.has(t)) return true;
      const pts: Pt[] = [e.getSourcePoint(), ...(e.getVertices() as Pt[]), e.getTargetPoint()];
      for (let i = 0; i + 1 < pts.length; i += 1) {
        if (segmentHitsRect(pts[i], pts[i + 1], rect)) return true;
      }
      return false;
    })
    .map((e) => e.id);
  setSelected(
    additive ? [...new Set([...selectedIds.value, ...hitNodes])] : hitNodes,
    additive ? [...new Set([...selectedEdgeIds.value, ...hitEdges])] : hitEdges,
  );
}

function createLink(a: string, b: string) {
  const c: LinkConfig = {
    // 链路 id 用 l 前缀：生成侧拼成 link_l1 / dev_l1_a，短且不与数字节点 id 撞号
    id: store.nextId('l'),
    kind: 'p2p',
    nodeA: a,
    nodeB: b,
    dataRate: '100Mbps',
    delay: '100us',
  };
  store.addLink(c);
  ElMessage.success(`已建立链路 ${a} ↔ ${b}`);
}

// ---------- 链路属性编辑（带宽 / 时延 / 抖动 / 误码率） ----------
function openLink(id: string) {
  const l = store.project.links.find((x) => x.id === id);
  if (!l) return;
  linkDlg.link = JSON.parse(JSON.stringify(l));
  linkDlg.show = true;
}
function linkLabel(id?: string) {
  return store.project.nodes.find((n) => n.id === id)?.name ?? id ?? '';
}
function saveLink() {
  const l = linkDlg.link!;
  store.updateLink(l.id, l);
  linkDlg.show = false;
}
function removeLinkSel() {
  const l = linkDlg.link!;
  store.removeLink(l.id);
  linkDlg.show = false;
}

// ---------- 右键上下文菜单 ----------
function showCtx(kind: 'node' | 'link' | 'decor', id: string, e: { preventDefault(): void; clientX: number; clientY: number }) {
  e.preventDefault();
  // 右键也顺带把目标选上（与左键一致），右键链路时节点选区清空
  setSelected(kind !== 'link' ? [id] : [], kind === 'link' ? [id] : []);
  ctxMenu.kind = kind;
  ctxMenu.id = id;
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.show = true;
}
function hideCtx() {
  if (!ctxMenu.show) return;
  ctxMenu.show = false;
}
function ctxLabel() {
  if (!ctxMenu.id) return ctxMenu.kind === 'blank' ? '运行设置' : '';
  if (ctxMenu.kind === 'node') return store.nodeMap.get(ctxMenu.id)?.name ?? ctxMenu.id;
  if (ctxMenu.kind === 'decor') return '绘图对象';
  return '链路';
}
function ctxAction(action: 'prop' | 'del' | 'stats') {
  const { kind, id } = ctxMenu;
  hideCtx();
  if (action === 'stats') {
    if (kind !== 'blank' && kind !== 'decor') openStatsDlg(kind, id);
    return;
  }
  if (action === 'prop') {
    if (kind === 'node') {
      const cfg = store.nodeMap.get(id);
      if (cfg) openNode(cfg);
    } else if (kind === 'decor') {
      openDecorDlg(id);
    } else {
      openLink(id);
    }
  } else {
    if (dialog.show) dialog.show = false;
    if (linkDlg.show) linkDlg.show = false;
    if (decorDlg.show) decorDlg.show = false;
    if (kind === 'node') store.removeNode(id);
    else if (kind === 'decor') store.removeDecor(id);
    else store.removeLink(id);
  }
}

// ---------- 统计输出（节点/链路右键 → 选择需输出的统计项） ----------
const statsDlg = reactive({ show: false, kind: 'node' as 'node' | 'link', id: '', selected: [] as string[] });
function statsTargetName() {
  if (statsDlg.kind === 'node') return store.nodeMap.get(statsDlg.id)?.name ?? statsDlg.id;
  return '链路';
}
function openStatsDlg(kind: 'node' | 'link', id: string) {
  const cur =
    kind === 'node' ? store.nodeMap.get(id)?.stats : store.project.links.find((l) => l.id === id)?.stats;
  statsDlg.kind = kind;
  statsDlg.id = id;
  statsDlg.selected = cur ? [...cur] : [];
  statsDlg.show = true;
}
function saveStats() {
  const stats = statsDlg.selected.length ? [...statsDlg.selected] : undefined;
  if (statsDlg.kind === 'node') store.updateNode(statsDlg.id, { stats });
  else store.updateLink(statsDlg.id, { stats });
  statsDlg.show = false;
}

// 空白右键「网格设置…」→ 关闭菜单并打开网格设置对话框
function openGridSettings() {
  hideCtx();
  showGridCfg.value = true;
}

// ---------- 节点属性编辑 ----------
// 节点级应用（Server/Client）可承载的 L3 网口协议；GOOSE/RTU 走 L2/串口，不入 UDP Socket
const APP_PROTO = ['MMS', 'MODBUS_TCP', 'CUSTOM'];
// 对端候选：除自身外的画布节点（供 CLIENT 指定上报目标）
const peerCandidates = () => (dialog.node ? store.project.nodes.filter((n) => n.id !== dialog.node!.id) : []);

function openNode(n: NodeConfig) {
  const copy = JSON.parse(JSON.stringify(n)) as NodeConfig;
  if (!copy.apps) copy.apps = [];
  dialog.node = copy;
  dialog.show = true;
}

// ---------- 画布装饰对象属性编辑（文本 / 细线）----------
const decorDlg = reactive({
  show: false,
  id: '',
  kind: 'text' as DecorKind,
  data: {} as Record<string, unknown>,
});
const DECOR_DASH_OPTIONS = [
  { value: 'solid', label: '实线' },
  { value: 'dash', label: '虚线' },
  { value: 'dot', label: '点线' },
  { value: 'dashdot', label: '点划线' },
];
function openDecorDlg(id: string) {
  const d = store.decorMap.get(id);
  if (!d) return;
  const copy: Record<string, unknown> = {};
  (Object.keys(d) as (keyof DecorConfig)[]).forEach((k) => {
    copy[k as string] = (d[k] as unknown) !== undefined ? JSON.parse(JSON.stringify(d[k])) : undefined;
  });
  decorDlg.kind = d.kind;
  decorDlg.id = d.id;
  decorDlg.data = copy;
  decorDlg.show = true;
}
/** 保存装饰属性：一次写入一个快照（撤销=1 步） */
function applyDecor() {
  const data = decorDlg.data;
  if (!data || decorDlg.id === '') return;
  if (decorDlg.kind === 'text') {
    const patch: Partial<TextDecorConfig> = {};
    if (typeof data.text === 'string') patch.text = data.text.trim() || undefined;
    if (typeof data.fontSize === 'number') patch.fontSize = data.fontSize;
    if (typeof data.color === 'string') patch.color = data.color || undefined;
    patch.bold = Boolean(data.bold);
    store.updateDecor(decorDlg.id, patch);
  } else {
    const patch: Partial<LineDecorConfig> = {};
    ['x1', 'y1', 'x2', 'y2'].forEach((k) => {
      if (typeof data[k] === 'number') patch[k as 'x1'] = Math.round(data[k] as number);
    });
    if (typeof data.lineWidth === 'number') patch.lineWidth = Math.round(data.lineWidth);
    if (typeof data.color === 'string') patch.color = data.color || undefined;
    patch.dash = (data.dash as LineDecorConfig['dash']) ?? 'solid';
    store.updateDecor(decorDlg.id, patch);
  }
  decorDlg.show = false;
}
function deleteSelectedDecor() {
  store.removeDecor(decorDlg.id);
  decorDlg.show = false;
}

// ---------- 节点 IP 提示 ----------
// 节点属性里的 IP 只作用于该节点参与的**第一条**链路（挂 N 条链路就有 N 个接口地址）。
// 占位符直接把「清空后会拿到什么」算出来给用户看，且复用生成器同一份 IP 规划——
// 不在 UI 里另算一套地址，否则两边迟早对不上。
function nodeLinkCount(nodeId: string): number {
  return store.project.links.filter((l) => l.nodeA === nodeId || l.nodeB === nodeId).length;
}
/** 该节点不指定 IP 时会拿到的地址（把它的 ip 摘掉重算一次规划） */
function autoIpOf(nodeId: string): string {
  const nodes = store.project.nodes.map((n) => (n.id === nodeId ? { ...n, ip: undefined } : n));
  return plannedNodeIps(nodes, store.project.links).get(nodeId) ?? '';
}
function autoIpHint(nodeId: string): string {
  const ip = autoIpOf(nodeId);
  return ip ? `自动规划：${ip}` : '留空即自动规划';
}
function ipHintExtra(nodeId: string): string {
  const n = nodeLinkCount(nodeId);
  if (n === 0) return '该节点尚未挂链路，暂无接口地址';
  if (n > 1) return `该节点还挂在 ${n} 条链路上，其余接口仍按自动规划分配`;
  return '';
}
function addApp(role: 'SERVER' | 'CLIENT') {
  const node = dialog.node!;
  node.apps = node.apps ?? [];
  const app: NodeAppConfig = { id: store.nextId('a'), role, protocol: 'MMS', port: 502 };
  if (role === 'CLIENT') {
    app.interval = 1;
    app.payloadSize = 512;
  }
  node.apps.push(app);
}
function removeApp(i: number) {
  const node = dialog.node!;
  node.apps = (node.apps ?? []).filter((_, k) => k !== i);
}
function saveNode() {
  const d = dialog.node!;
  if (!d.name) return ElMessage.warning('节点名称不能为空');
  // 清空输入框会留下空串，这里删掉字段本身，避免 project.json 里出现 ip: ""
  if (!d.ip?.trim()) delete d.ip;
  store.updateNode(d.id, d);
  dialog.show = false;
}
function removeSelected() {
  if (!dialog.node) return;
  store.removeNode(dialog.node.id);
  dialog.show = false;
}

// ---------- 工程存取 ----------
// 内容序列化/解析走 @core/projectFile（纯函数），读盘/落盘走 utils/projectStorage（分环境）。
// 视图这一层只负责编排与提示。
function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

async function openProject() {
  // 「打开」走新标签，不覆盖当前工程 → 无需 dirty 防护
  const res = await openProjectText();
  if (!res.ok) {
    if (res.reason !== 'cancelled') ElMessage.error(`打开失败：${res.reason ?? '未知原因'}`);
    return;
  }
  const parsed = parseProject(res.content ?? '');
  if (!parsed.ok) {
    const shown = parsed.errors.slice(0, 8).map(escapeHtml).join('<br>');
    const more = parsed.errors.length > 8 ? `<br>…共 ${parsed.errors.length} 条` : '';
    ElMessageBox.alert(shown + more, '工程文件解析失败', { type: 'error', dangerouslyUseHTMLString: true });
    return;
  }
  store.openInTab(parsed.project.projectName || 'Untitled', parsed.project);
  if (res.path) setProjectDirFromPath(res.path); // 从磁盘打开工程，确立工程文件夹
  else clearProjectDir(); // 其它来源（理论上走此分支前已 res.path 存在）
  if (parsed.warnings.length) ElMessage.warning(parsed.warnings.join('；'));
  ElMessage.success(`已在新标签打开 ${parsed.project.projectName}（节点 ${parsed.project.nodes.length} · 链路 ${parsed.project.links.length}）`);
}

function newProject() {
  // 「新建」= 新增一条空白 Untitled 标签（不覆盖当前工程，无需清空确认）
  clearProjectDir(); // 空白工程尚未落到本地，清空工程文件夹记忆
  store.openNewUntitled();
  store.markClean();
  ElMessage.success('已新建空白工程标签');
}

/** 另存为：强制弹保存对话框（「保存」有路径记忆会静默覆写，这里绕开它） */
async function saveProjectAs() {
  const content = serializeProject(store.project);
  const res = await saveProjectText(content, suggestFileName(store.project.projectName), { forceDialog: true });
  if (res.ok) {
    store.markClean();
    if (res.path) setProjectDirFromPath(res.path); // 另存为确立工程文件夹
    ElMessage.success(`工程已另存为${res.path ? '：' + res.path : ''}`);
  } else if (res.reason !== 'cancelled') ElMessage.error(`另存为失败：${res.reason ?? '未知原因'}`);
}

/** 退出应用：有未保存更改时多一层拦截；Electron 壳内走 IPC，浏览器降级下 window.close() 多半无效 */
async function quitApp() {
  const msg = store.dirty ? '当前工程有未保存的更改，退出后将丢失。确定退出？' : '确定退出 EPComHIL？';
  try {
    await ElMessageBox.confirm(msg, '退出', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      dangerouslyUseHTMLString: false,
    });
  } catch {
    return; // 用户取消
  }
  const api = window.epcomhil;
  if (api?.quitApp) await api.quitApp();
  else window.close();
}

// ---------- 菜单栏（工具栏上方：文件 / 编辑 / 视图 / 帮助） ----------
// 自绘轻量实现：Element Plus 没有 Office 风格 menubar（el-menu 是导航组件），
// Electron 原生菜单又在窗口标题栏（autoHideMenuBar），都与「栏目上方一页内菜单」的版式不符。
// 交互：点击展开/收起；展开状态下滑过其他顶级项直接切换；点外部/Esc/执行菜单项后关闭。
type MenuKey = 'file' | 'edit' | 'view' | 'sim' | 'help';
interface MenuItemDef {
  label?: string;
  shortcut?: string;
  action?: () => void;
  disabled?: () => boolean;
  divider?: boolean;
}
const openMenu = ref<MenuKey | ''>('');
function toggleMenu(k: MenuKey) {
  openMenu.value = openMenu.value === k ? '' : k;
}
function hoverMenu(k: MenuKey) {
  if (openMenu.value && openMenu.value !== k) openMenu.value = k; // Office 风格：开着时滑过即切换
}
function closeMenus() {
  openMenu.value = '';
}
function runItem(it: MenuItemDef) {
  if (it.disabled?.()) return;
  closeMenus();
  it.action?.();
}

const hasSelection = () => selectedIds.value.length > 0 || selectedEdgeIds.value.length > 0;
const canAlign = () => selectedIds.value.length >= 2;
const canDistribute = () => selectedIds.value.length >= 3;

function showShortcuts() {
  ElMessageBox.alert(
    [
      '<div style="line-height:2.1;font-size:13px">',
      '<b>文件</b>：新建 Ctrl+N · 打开 Ctrl+O · 保存 Ctrl+S · 另存为 Ctrl+Shift+S<br>',
      '<b>编辑</b>：全选 Ctrl+A · 删除 Delete<br>',
      '<b>视图</b>：放大 Ctrl+= · 缩小 Ctrl+- · 实际大小 Ctrl+0 · 适应画布 Ctrl+Shift+W<br>',
      '<b>编译/运行</b>：编译 Ctrl+B · 运行 Ctrl+F5<br>',
      '<b>画布</b>：Ctrl+滚轮 缩放 · 框选空白拖拽 · Delete 删除选中',
      '</div>',
    ].join(''),
    '快捷键说明',
    { dangerouslyUseHTMLString: true },
  );
}
function showAbout() {
  ElMessageBox.alert('EPComHIL — 主配微电网信息-物理融合安全检测与硬件在环验证平台<br>拓扑建模 · 仿真配置 · 代码生成', '关于', {
    dangerouslyUseHTMLString: true,
  });
}

const menuDefs: { key: MenuKey; label: string; items: MenuItemDef[] }[] = [
  {
    key: 'file',
    label: '文件',
    items: [
      { label: '新建', shortcut: 'Ctrl+N', action: newProject },
      { label: '打开', shortcut: 'Ctrl+O', action: openProject },
      { label: '保存案例状态', shortcut: 'Ctrl+S', action: saveCaseState },
      { label: '另存为', shortcut: 'Ctrl+Shift+S', action: saveProjectAs },
      { divider: true },
      { label: '退出', action: quitApp },
    ],
  },
  {
    key: 'edit',
    label: '编辑',
    items: [
      { label: '撤销', shortcut: 'Ctrl+Z', action: () => doUndo(), disabled: () => !store.canUndo },
      { label: '重做', shortcut: 'Ctrl+Y', action: () => doRedo(), disabled: () => !store.canRedo },
      { divider: true },
      { label: '剪切', shortcut: 'Ctrl+X', action: () => copySelection(true), disabled: () => !selectedIds.value.length },
      { label: '复制', shortcut: 'Ctrl+C', action: () => copySelection(false), disabled: () => !selectedIds.value.length },
      { label: '粘贴', shortcut: 'Ctrl+V', action: () => pasteClipboard(), disabled: () => !store.clipboard?.nodes.length },
      { label: '删除', shortcut: 'Delete', action: deleteSelected, disabled: () => !hasSelection() },
      { divider: true },
      { label: '组合', shortcut: 'Ctrl+G', action: groupSelected, disabled: () => selectedIds.value.length < 2 },
      { label: '解组', shortcut: 'Ctrl+Shift+G', action: ungroupSelected, disabled: () => !selectedIds.value.some((id) => groupOf(id)) },
      { label: '旋转 90°', shortcut: 'R', action: rotateSelected, disabled: () => !selectedIds.value.length },
      { label: '水平镜像', shortcut: 'I', action: mirrorSelected, disabled: () => !selectedIds.value.length },
      { divider: true },
      { label: '全选', shortcut: 'Ctrl+A', action: selectAll, disabled: () => store.project.nodes.length + store.project.links.length === 0 },
      { label: '查找', shortcut: 'Ctrl+F', action: findNodes, disabled: () => store.project.nodes.length === 0 },
    ],
  },
  {
    key: 'view',
    label: '视图',
    items: [
      { label: '放大', shortcut: 'Ctrl+=', action: () => zoomBy(ZOOM_STEP), disabled: () => zoomPct.value >= ZOOM_MAX },
      { label: '缩小', shortcut: 'Ctrl+-', action: () => zoomBy(-ZOOM_STEP), disabled: () => zoomPct.value <= ZOOM_MIN },
      { label: '适应画布', shortcut: 'Ctrl+Shift+W', action: fitZoom },
      { label: '实际大小 100%', shortcut: 'Ctrl+0', action: actualSize },
      { label: '居中显示', action: () => graph?.centerContent() },
      { divider: true },
      { label: '左对齐', action: () => alignSelected('left'), disabled: () => !canAlign() },
      { label: '水平居中对齐', action: () => alignSelected('hcenter'), disabled: () => !canAlign() },
      { label: '右对齐', action: () => alignSelected('right'), disabled: () => !canAlign() },
      { label: '顶对齐', action: () => alignSelected('top'), disabled: () => !canAlign() },
      { label: '垂直居中对齐', action: () => alignSelected('vcenter'), disabled: () => !canAlign() },
      { label: '底对齐', action: () => alignSelected('bottom'), disabled: () => !canAlign() },
      { divider: true },
      { label: '横向等间距', action: () => distributeSelected('h'), disabled: () => !canDistribute() },
      { label: '纵向等间距', action: () => distributeSelected('v'), disabled: () => !canDistribute() },
      { divider: true },
      { label: '网格设置…', action: () => { showGridCfg.value = true; } },
    ],
  },
  {
    key: 'sim',
    label: '编译/运行',
    items: [
      { label: '编译', shortcut: 'Ctrl+B', action: onSimCompile, disabled: () => simRunning.value || simCompiling.value },
      { label: '运行', shortcut: 'Ctrl+F5', action: onSimRun, disabled: () => !simReady.value || simRunning.value },
      { divider: true },
      { label: '暂停', action: onSimStop, disabled: () => !simRunning.value || simStopping.value },
    ],
  },
  {
    key: 'help',
    label: '帮助',
    items: [
      { label: '快捷键说明', action: showShortcuts },
      { label: '关于 EPComHIL', action: showAbout },
    ],
  },
];

// ---------- 仿真操作：编译（只构建） / 运行（构建并运行） / 停止 ----------
// 统一走 runtime store 的流式引擎：与 Runtime 页共用同一条 SSH 通道、同一份状态，
// 于是「在拓扑页点运行 → 切到 Runtime 页看曲线」是连续的，不需要两套状态互相追。
const rt = useRuntimeStore();
const simStopping = ref(false);
/** 只构建不运行的那一轮 */
const simCompiling = computed(() => rt.simRunning && rt.simBuildOnly);
/** 真正在跑仿真的那一轮 */
const simRunning = computed(() => rt.simRunning && !rt.simBuildOnly);
/** 构建成功后才「就绪」—— 沿用原来的两步操作习惯（先编译、再运行） */
const simReady = computed(() => rt.simPhase === 'done');

async function onSimCompile() {
  if (rt.simRunning) return;
  const res = await rt.runSim({ buildOnly: true });
  if (res.ok) ElMessage.success(`构建成功${res.duration ? `（${res.duration}）` : ''}，可点击运行`);
  else ElMessage.error(res.error || '构建失败');
}

async function onSimRun() {
  if (rt.simRunning) return;
  const res = await rt.runSim({});
  if (res.ok) ElMessage.success('仿真完成，可切到 Runtime 页查看结果');
  else ElMessage.error(res.error || '运行失败');
}

async function onSimStop() {
  if (!rt.simRunning || simStopping.value) return;
  simStopping.value = true;
  try {
    const res = await rt.stopSim();
    if (res && res.ok) ElMessage.success('已请求停止仿真');
    else ElMessage.error((res && res.error) || '停止失败');
  } finally {
    simStopping.value = false;
  }
}

// ---------- 菜单命令：全选 / 对齐 / 等间距 / 剪切复制粘贴 ----------
/** 节点所属的组（最多一个：groupNodes 保证一节点只进一组） */
function groupOf(nodeId: string) {
  return store.project.groups?.find((g) => g.members.includes(nodeId)) ?? null;
}

/** 组合选中节点：持久分组，单击任一成员选中整组、拖动整组跟随、落盘保留 */
function groupSelected() {
  const ids = selectedIds.value.filter((id) => store.nodeMap.has(id));
  if (ids.length < 2) return;
  const gid = store.groupNodes(ids);
  if (gid) ElMessage.info(`已组合 ${ids.length} 个节点（组 ${gid}）`);
}

/** 解组：散掉选区命中的所有组 */
function ungroupSelected() {
  const hitIds = selectedIds.value.filter((id) => groupOf(id));
  if (!hitIds.length) return;
  store.ungroupNodes(hitIds);
  ElMessage.info('已解组');
}

function selectAll() {
  // setSelected 会给节点和链路同时上选中态，直接全量喂进去
  setSelected(
    store.project.nodes.map((n) => n.id),
    store.project.links.map((l) => l.id),
  );
}

/** 顺时针旋转选中节点 90°（角度存 store.angle，撤销/落盘都跟着走） */
function rotateSelected() {
  if (!graph || !selectedIds.value.length) return;
  store.batch(() => {
    for (const id of selectedIds.value) {
      const cell = graph!.getCellById(id) as import('@antv/x6').Node | undefined;
      if (!cell) continue;
      const next = (Math.round(cell.getAngle?.() ?? 0) + 90) % 360;
      cell.rotate(next, { absolute: true });
      store.updateNode(id, { angle: next });
    }
  });
  ElMessage.info(`已旋转 ${selectedIds.value.length} 个节点 90°`);
}

/** 水平镜像选中节点（只翻图标不翻文字） */
function mirrorSelected() {
  if (!graph || !selectedIds.value.length) return;
  store.batch(() => {
    for (const id of selectedIds.value) {
      const cell = graph!.getCellById(id);
      if (!cell) continue;
      const next = !readIconFlip(cell);
      applyIconFlip(cell, next);
      store.updateNode(id, { flipX: next || undefined });
    }
  });
  ElMessage.info(`已镜像 ${selectedIds.value.length} 个节点`);
}

/** 按名称关键字查找：全部匹配项进选区，画布定位到第一个 */
async function findNodes() {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt('输入节点名称关键字（模糊匹配，不区分大小写）', '查找节点', {
      confirmButtonText: '查找',
      cancelButtonText: '取消',
      inputPlaceholder: '关键字',
    }));
  } catch {
    return; // 用户取消
  }
  const kw = (value || '').trim().toLowerCase();
  if (!kw) return;
  const hits = store.project.nodes.filter((n) => (n.name || n.id).toLowerCase().includes(kw));
  if (!hits.length) {
    ElMessage.warning(`没有名称包含「${value}」的节点`);
    return;
  }
  setSelected(
    hits.map((n) => n.id),
    [],
  );
  const first = graph?.getCellById(hits[0].id);
  if (first) graph?.centerCell(first);
  ElMessage.info(hits.length === 1 ? `找到 1 个节点：${hits[0].name || hits[0].id}` : `找到 ${hits.length} 个节点，已定位到第一个`);
}

/** 复制/剪切选中节点（连带两端都在选区内的链路）；剪贴板存快照，粘贴时重发号 */
function copySelection(cut = false) {
  const nodes = store.project.nodes.filter((n) => selectedIds.value.includes(n.id));
  if (!nodes.length) return;
  const idSet = new Set(nodes.map((n) => n.id));
  const links = store.project.links.filter((l) => idSet.has(l.nodeA) && idSet.has(l.nodeB));
  store.clipboard = {
    nodes: JSON.parse(JSON.stringify(nodes)),
    links: JSON.parse(JSON.stringify(links)),
  };
  if (cut) deleteSelected();
  ElMessage.info(`已${cut ? '剪切' : '复制'} ${nodes.length} 个节点${links.length ? `（含 ${links.length} 条内部链路）` : ''}`);
}

/** 粘贴：新节点 id / 名称按同类型重新发号，位置整体 +20 偏移；内部链路按映射重接 */
function pasteClipboard() {
  const clip = store.clipboard;
  if (!clip?.nodes.length) return;
  // 批量发号：nextNodeId 无状态现算，循环里连调会重复拿到同一 id（新副本还没 push 进 store）
  const freshIds = store.takeNodeIds(clip.nodes.length);
  const idMap = new Map<string, string>();
  const newNodes = clip.nodes.map((n, i) => {
    const id = freshIds[i];
    idMap.set(n.id, id);
    // 深拷贝：剪贴板里的嵌套字段（apps/stats…）不能与工程内的粘贴品共享引用
    const clone = JSON.parse(JSON.stringify(n)) as NodeConfig;
    return { ...clone, id, name: store.nextNodeName(n.kind), x: (n.x ?? 40) + 20, y: (n.y ?? 40) + 20 };
  });
  store.batch(() => {
    newNodes.forEach((n) => store.addNode(n));
    clip.links.forEach((l) => {
      const a = idMap.get(l.nodeA);
      const b = idMap.get(l.nodeB);
      if (a && b) store.addLink({ ...l, id: store.nextId('l'), nodeA: a, nodeB: b });
    });
  });
  setSelected(newNodes.map((n) => n.id), []);
  ElMessage.success(`已粘贴 ${newNodes.length} 个节点`);
}

/**
 * 对齐选中节点（≥2 个）。必须同时改 X6 cell 和 store：
 * syncGraph 只做增删/样式 reconcile，不会把 store 的 x/y 回写到已存在的 cell（只信节点自己拖出来的 change:position）。
 */
function alignSelected(mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  if (!graph) return;
  const cells = selectedIds.value
    .map((id) => graph!.getCellById(id))
    .filter((c): c is import('@antv/x6').Node => Boolean(c));
  if (cells.length < 2) return;
  const boxes = cells.map((c) => ({ c, b: c.getBBox() }));
  const minL = Math.min(...boxes.map((o) => o.b.x));
  const maxR = Math.max(...boxes.map((o) => o.b.x + o.b.width));
  const minT = Math.min(...boxes.map((o) => o.b.y));
  const maxB = Math.max(...boxes.map((o) => o.b.y + o.b.height));
  store.batch(() => {
    for (const { c, b } of boxes) {
      let x = b.x;
      let y = b.y;
      if (mode === 'left') x = minL;
      else if (mode === 'right') x = maxR - b.width;
      else if (mode === 'hcenter') x = (minL + maxR) / 2 - b.width / 2;
      else if (mode === 'top') y = minT;
      else if (mode === 'bottom') y = maxB - b.height;
      else y = (minT + maxB) / 2 - b.height / 2;
      x = Math.round(x);
      y = Math.round(y);
      if (x === b.x && y === b.y) continue;
      c.setPosition(x, y);
      store.updateNode(c.id, { x, y });
    }
  });
}

/** 等间距分布（≥3 个）：按包围盒首尾均匀排，轴向上间隙相等 */
function distributeSelected(axis: 'h' | 'v') {
  if (!graph) return;
  const cells = selectedIds.value
    .map((id) => graph!.getCellById(id))
    .filter((c): c is import('@antv/x6').Node => Boolean(c));
  if (cells.length < 3) return;
  const key = axis === 'h' ? 'x' as const : 'y' as const;
  const sizeKey = axis === 'h' ? 'width' as const : 'height' as const;
  const boxes = cells.map((c) => ({ c, b: c.getBBox() })).sort((p, q) => p.b[key] - q.b[key]);
  const first = boxes[0].b;
  const last = boxes[boxes.length - 1].b;
  const span = last[key] + last[sizeKey] - first[key];
  const totalSizes = boxes.reduce((s, o) => s + o.b[sizeKey], 0);
  const gap = (span - totalSizes) / (boxes.length - 1);
  let cursor = first[key];
  store.batch(() => {
    for (const { c, b } of boxes) {
      const x = axis === 'h' ? Math.round(cursor) : b.x;
      const y = axis === 'v' ? Math.round(cursor) : b.y;
      cursor += b[sizeKey] + gap;
      if (x === b.x && y === b.y) continue;
      c.setPosition(x, y);
      store.updateNode(c.id, { x, y });
    }
  });
}

function doUndo() {
  if (store.undo()) ElMessage.info('已撤销');
}
function doRedo() {
  if (store.redo()) ElMessage.info('已重做');
}

// ---------- 菜单快捷键（与 onDocKey 并列；输入框焦点保护同款） ----------
function onMenuKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (openMenu.value) closeMenus();
    return;
  }
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    // 无修饰键单键：R 旋转 / I 镜像（Visio 习惯）
    const k0 = e.key.toLowerCase();
    if (k0 === 'r') { e.preventDefault(); rotateSelected(); }
    else if (k0 === 'i') { e.preventDefault(); mirrorSelected(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); onSimCompile(); }
  else if (k === 'f5') { e.preventDefault(); onSimRun(); }
  else if (k === 'n') { e.preventDefault(); newProject(); }
  else if (k === 'o') { e.preventDefault(); openProject(); }
  else if (k === 's') { e.preventDefault(); if (e.shiftKey) saveProjectAs(); else saveCaseState(); }
  else if (k === 'a') { e.preventDefault(); selectAll(); }
  else if (k === 'f') { e.preventDefault(); findNodes(); }
  else if (k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
  else if (k === 'y') { e.preventDefault(); doRedo(); }
  else if (k === 'x') { e.preventDefault(); copySelection(true); }
  else if (k === 'c') { e.preventDefault(); copySelection(false); }
  else if (k === 'v') { e.preventDefault(); pasteClipboard(); }
  else if (k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); }
  else if (k === '=' || k === '+') { e.preventDefault(); zoomBy(ZOOM_STEP); }
  else if (k === '-') { e.preventDefault(); zoomBy(-ZOOM_STEP); }
  else if (k === '0') { e.preventDefault(); actualSize(); }
  else if (k === 'w' && e.shiftKey) { e.preventDefault(); fitZoom(); }
}
</script>

<template>
  <div class="topology-page">
    <!-- 菜单栏：文件 / 编辑 / 视图 / 帮助（点击展开，展开状态滑过切换，点外部/Esc 关闭） -->
    <nav class="menubar">
      <div
        v-for="m in menuDefs"
        :key="m.key"
        class="mb-top"
        :class="{ open: openMenu === m.key }"
        @click.stop="toggleMenu(m.key)"
        @mouseenter="hoverMenu(m.key)"
      >
        {{ m.label }}
        <div v-if="openMenu === m.key" class="mb-drop" @click.stop>
          <template v-for="(it, i) in m.items" :key="i">
            <div v-if="it.divider" class="mb-sep"></div>
            <button v-else class="mb-entry" :disabled="it.disabled?.()" @click="runItem(it)">
              <span class="mb-lbl">{{ it.label }}</span>
              <span v-if="it.shortcut" class="mb-sc">{{ it.shortcut }}</span>
            </button>
          </template>
        </div>
      </div>

      <!-- 仿真操作：编译 / 运行 / 暂停（菜单栏中间位置） -->
      <div class="sim-actions">
        <button
          class="sim-btn"
          :class="{ active: simCompiling, disabled: simRunning }"
          :disabled="simCompiling || simRunning"
          title="编译（下载到仿真器）"
          @click="onSimCompile"
        >
          <svg v-if="simCompiling" class="sim-ico loading" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="40 60" stroke-linecap="round"/>
          </svg>
          <svg v-else class="sim-ico hammer" viewBox="0 0 24 24" fill="currentColor">
            <!-- 铁锤：宽锤头 + U形弯柄，22px 下最清晰的工具意象 -->
            <rect x="3" y="3" width="18" height="8" rx="2"/>
            <path d="M9.5 11h5v4a2.75 2.75 0 0 1-2.75 2.75 2.75 2.75 0 0 1-2.75-2.75v-.7a7 7 0 0 1 1.05-3.3" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
          </svg>
        </button>
        <button
          class="sim-btn"
          :class="{ active: simRunning, disabled: !simReady }"
          :disabled="!simReady || simRunning"
          title="运行仿真"
          @click="onSimRun"
        >
          <svg class="sim-ico play" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="7,5 20,12 7,19" />
          </svg>
        </button>
        <button
          class="sim-btn"
          :class="{ disabled: !simRunning }"
          :disabled="!simRunning"
          title="暂停/停止仿真"
          @click="onSimStop"
        >
          <svg class="sim-ico pause" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1"/>
            <rect x="14" y="5" width="4" height="14" rx="1"/>
          </svg>
        </button>
      </div>

      <!-- 工具条并入菜单栏同一行：工程名 + 连线 + 缩放 -->
      <div class="toolbar">
      <div class="tb-group">
        <span class="tb-label">工程名</span>
        <el-input :model-value="store.project.projectName" size="small" style="width: 160px" @update:model-value="store.setProjectName($event as string)" />
        <!-- 未保存标记：有改动时亮起，保存/载入后熄灭 -->
        <span v-if="store.dirty" class="tb-dirty" title="有未保存的更改（Ctrl+S 保存）">● 未保存</span>
      </div>
      <div class="tb-group">
        <el-button
          size="small"
          :type="connectMode ? 'success' : 'default'"
          :title="connectMode ? '连线中：依次点选两个节点建立 P2P 链路' : 'P2P 连线'"
          @click="connectMode = !connectMode"
        >
          <svg class="ico link-tool" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <line class="link-line" x1="5" y1="19" x2="19" y2="5" />
            <circle class="link-dot" cx="5" cy="19" r="2.4" />
            <circle class="link-dot" cx="19" cy="5" r="2.4" />
          </svg>
        </el-button>
        <!-- 缩放条：版式对齐参考截图（｜放大镜− ｜放大镜+ ｜百分比+预设▾ ｜适应画布+视图▾） -->
        <div class="zoom-bar" @click.stop>
          <span class="zb-sep"></span>
          <button class="zb-btn" title="缩小" @click="zoomBy(-ZOOM_STEP)">
            <svg class="zb-ico" viewBox="0 0 20 20" aria-hidden="true">
              <line class="zb-handle" x1="12.7" y1="12.1" x2="17" y2="16.4" />
              <circle class="zb-glass" cx="8.6" cy="8" r="5.6" />
              <line class="zb-sign" x1="5.7" y1="8" x2="11.5" y2="8" />
            </svg>
          </button>
          <button class="zb-btn" title="放大" @click="zoomBy(ZOOM_STEP)">
            <svg class="zb-ico" viewBox="0 0 20 20" aria-hidden="true">
              <line class="zb-handle" x1="12.7" y1="12.1" x2="17" y2="16.4" />
              <circle class="zb-glass" cx="8.6" cy="8" r="5.6" />
              <line class="zb-sign" x1="5.7" y1="8" x2="11.5" y2="8" />
              <line class="zb-sign" x1="8.6" y1="5.1" x2="8.6" y2="10.9" />
            </svg>
          </button>
          <div class="zb-combo">
            <input
              v-model="zoomText"
              class="zb-input"
              title="输入缩放百分比，回车确认（范围 20 ~ 400）"
              @focus="zoomEditing = true"
              @keydown.enter="commitZoomText"
              @blur="commitZoomText"
            />
            <button
              class="zb-caret"
              :class="{ open: zoomMenuOpen }"
              title="预设比例"
              @click="
                zoomMenuOpen = !zoomMenuOpen;
                viewMenuOpen = false;
              "
            >
              <span class="zb-tri"></span>
            </button>
            <div v-if="zoomMenuOpen" class="zb-menu">
              <div v-for="p in ZOOM_PRESETS" :key="p" class="zb-menu-item" :class="{ on: p === zoomPct }" @click="pickZoomPreset(p)">
                {{ p }}%
              </div>
            </div>
          </div>
          <div class="zb-combo">
            <button class="zb-btn zb-fit" title="适应画布" @click="fitZoom">
              <svg class="zb-ico" viewBox="0 0 20 20" aria-hidden="true">
                <g class="zb-expand">
                  <path d="M3.4 7.4V3.4h4M3.4 3.4l4.6 4.6" />
                  <path d="M16.6 7.4V3.4h-4M16.6 3.4l-4.6 4.6" />
                  <path d="M3.4 12.6v4h4M3.4 16.6l4.6-4.6" />
                  <path d="M16.6 12.6v4h-4M16.6 16.6l-4.6-4.6" />
                </g>
              </svg>
            </button>
            <button
              class="zb-caret"
              :class="{ open: viewMenuOpen }"
              title="工作区尺寸"
              @click="
                viewMenuOpen = !viewMenuOpen;
                zoomMenuOpen = false;
              "
            >
              <span class="zb-tri"></span>
            </button>
            <div v-if="viewMenuOpen" class="zb-menu right dim">
              <div class="zb-dim-title">工作区尺寸</div>
              <div class="zb-dim-row">
                <span class="zb-dim-label">长 (px)</span>
                <el-input-number
                  v-model="settings.width"
                  :min="400"
                  :max="20000"
                  :step="200"
                  controls-position="right"
                  size="small"
                  @change="onWidthChange"
                />
              </div>
              <div class="zb-dim-row">
                <span class="zb-dim-label">宽 (px)</span>
                <el-input-number
                  v-model="settings.height"
                  :min="300"
                  :max="20000"
                  :step="200"
                  controls-position="right"
                  size="small"
                  @change="onHeightChange"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="tb-stats">
        <span v-if="showWsInfo" class="tb-ws" title="工作区尺寸（缩放栏下拉菜单可改）">工作区 {{ settings.width }} × {{ settings.height }} px</span>
        节点 {{ store.project.nodes.length }} · 链路 {{ store.project.links.length }}
      </div>
      </div>
    </nav>

    <div class="canvas-wrap">
      <!-- 左侧：案例库（自带 + 用户） -->
      <aside class="caselib">
        <el-tabs v-model="caseTab" class="case-tabs">
          <el-tab-pane label="自带案例库" name="builtin">
            <template v-if="builtinView === 'folders'">
              <div class="case-head">
                <span class="case-head-t">案例目录</span>
                <span class="case-head-n">{{ sceneFolders.length }} 个用例</span>
                <button class="case-refresh" title="重新扫描 scenarios 目录" @click="refreshScenes(true)">刷新</button>
              </div>
              <div v-if="sceneError" class="case-empty">{{ sceneError }}</div>
              <div v-else-if="!sceneFolders.length" class="case-empty">暂无案例文件夹</div>
              <div v-for="f in sceneFolders" :key="f.name" class="case-folder" title="进入该用例（右键可管理：重命名/打开位置/复制路径/删除/属性）" @click="openFolder(f)" @contextmenu.prevent.stop="openFolderMenu(f, $event)">
                <span class="folder-ico">📂</span>
                <div class="folder-text">
                  <div class="folder-name">{{ f.name }}</div>
                  <div class="folder-sub">{{ f.files.length }} 个工程</div>
                </div>
                <span class="folder-arrow">›</span>
              </div>
            </template>
            <template v-else>
              <div class="case-head">
                <button class="case-back" @click="builtinView = 'folders'">‹ 返回</button>
                <span class="case-head-t">{{ currentFolder?.name }}</span>
              </div>
              <div v-if="!currentFolder?.files?.length" class="case-empty">该文件夹暂无工程</div>
              <div v-for="s in currentFolder?.files" :key="s.rel" class="case-item" title="左键载入到画布（右键可管理：属性/重命名/打开所在位置/复制路径/删除）" @click="openScene(s)" @contextmenu.prevent.stop="openFileMenu(currentFolder, s, $event)">
                <span class="case-file">📄</span>
                <div class="case-info">
                  <div class="case-name">{{ s.name }}</div>
                  <div class="case-desc">点击载入到画布</div>
                </div>
              </div>
            </template>
          </el-tab-pane>
          <el-tab-pane label="用户案例库" name="user">
            <div class="lib-title-row">
              <span class="lib-title">保存的工程</span>
              <el-button size="small" text type="primary" @click="saveAsCase">另存为</el-button>
            </div>
            <div v-if="!userCases.length" class="case-empty">暂无用户案例，点「另存为」保存当前工程</div>
            <div v-for="c in userCases" :key="c.id" class="case-item user-item">
              <div class="case-info" title="载入该案例" @click="loadUser(c)">
                <div class="case-name">{{ c.name }}</div>
                <div class="case-desc">{{ fmtTime(c.savedAt) }}</div>
              </div>
              <el-button size="small" text type="danger" title="删除" @click="removeCase(c.id)">✕</el-button>
            </div>
          </el-tab-pane>
        </el-tabs>
        <!-- 自带案例库右键菜单（作用于用例文件夹或其内具体工程文件） -->
        <div
          v-if="sceneMenu.target"
          class="folder-menu"
          :style="{ left: sceneMenu.x + 'px', top: sceneMenu.y + 'px' }"
          @click.stop
        >
          <button class="fm-item" @click="sceneProps">属性</button>
          <button class="fm-item" @click="sceneRename">重命名</button>
          <div class="fm-sep"></div>
          <button class="fm-item" :title="sceneMenu.target.kind === 'file' ? '在系统文件管理器中定位到该工程文件' : '在系统文件管理器中打开该场景文件夹'" @click="sceneReveal">打开所在位置</button>
          <button class="fm-item" @click="sceneCopyPath">复制路径</button>
          <div class="fm-sep"></div>
          <button class="fm-item fm-danger" @click="sceneDelete">删除</button>
        </div>
      </aside>

      <!-- 中央：多工程标签栏 + 绘图画布（标签栏只占中央画布宽度，贴画布上缘） -->
      <div class="canvas-col">
        <ProjectTabs />
        <div ref="canvasRef" class="canvas" :class="connectMode || lineMode ? 'canvas-draw' : ''"></div>
      </div>

      <!-- 右侧：组件库 -->
      <aside class="library">
        <div class="lib-title">组件库</div>
        <button v-for="c in library" :key="c.kind" class="lib-item" @mousedown="startLibDrag(c.kind, $event)" @click="addFromLibrary(c.kind)">
          <svg class="ico" viewBox="0 0 24 24" :stroke="CANVAS_COLOR[c.kind]" aria-hidden="true">
            <path v-for="(d, i) in KIND_ICON[c.kind]" :key="i" :d="d" />
          </svg>
          {{ c.label }}
        </button>
        <div class="lib-divider">绘图</div>
        <button class="lib-item" @mousedown="startDecorDrag('text', $event)" @click="addDecorFromLibrary('text')">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#3a6ea5" aria-hidden="true">
            <path d="M5 7h14M12 7v12" stroke-width="2" stroke-linecap="round" />
          </svg>
          文本
        </button>
        <button class="lib-item" :class="{ active: lineMode }" @click="toggleLineMode" :title="lineMode ? '画线模式：画布按住左键拖出细线 · 点击退出' : 'Visio 式画线：点击开启，在画布按住左键拖拽画任意方向细线'">
          <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#3a6ea5" aria-hidden="true">
            <path d="M4 6 L20 18" stroke-width="2" stroke-linecap="round" />
          </svg>
          细线
        </button>
      </aside>

      <!-- 框选矩形：绝对定位于 .canvas-wrap（它是 position:relative），pointer-events:none 保证不抢画布事件 -->
      <div v-if="rubber.active" class="rubber" :style="rubberBox"></div>
    </div>

    <el-dialog v-model="dialog.show" title="节点属性" width="620px">
      <el-form v-if="dialog.node" label-width="96px" label-position="left">
        <el-form-item label="ID">
          <el-input :model-value="dialog.node.id" disabled />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="dialog.node.name" />
        </el-form-item>
        <el-form-item label="类型">
          <el-input :model-value="KIND_LABEL[dialog.node.kind]" disabled />
        </el-form-item>
        <el-form-item label="IP 地址">
          <div class="ip-field">
            <el-input v-model="dialog.node.ip" :placeholder="autoIpHint(dialog.node.id)" clearable style="max-width: 220px" />
            <span class="ip-hint">{{ ipHintExtra(dialog.node.id) }}</span>
          </div>
        </el-form-item>
        <el-form-item label="实物模式">
          <el-switch v-model="dialog.node.physical" />
        </el-form-item>
        <el-form-item v-if="dialog.node.physical" label="物理终端">
          <el-input v-model="dialog.node.physicalId" placeholder="如 dev:rtu-01" />
        </el-form-item>

        <el-divider content-position="left">节点应用 · Server / Client（UDP）</el-divider>
        <div v-for="(app, i) in dialog.node.apps" :key="app.id" class="app-card">
          <div class="app-row">
            <el-tag size="small" :type="app.role === 'SERVER' ? 'success' : 'warning'" class="app-role">
              {{ app.role === 'SERVER' ? 'SERVER 监听' : 'CLIENT 上报' }}
            </el-tag>
            <span class="f-label" v-if="app.role === 'CLIENT'">本机IP</span>
            <span class="ip-sock" :title="app.role === 'SERVER' ? '监听地址' : '本地源地址'">{{ autoIpOf(dialog.node.id) || '(未规划)' }}:</span>
          </div>
          <div class="app-row">
            <span class="f-label">协议</span>
            <el-select v-model="app.protocol" size="small" style="width: 118px">
              <el-option v-for="p in APP_PROTO" :key="p" :label="p" :value="p" />
            </el-select>
            <span class="f-label">承载</span>
            <el-select size="small" style="width: 96px"
              :model-value="app.transport ?? 'AUTO'"
              @update:model-value="(v: string) => (app.transport = v === 'AUTO' ? undefined : (v as 'UDP' | 'TCP'))">
              <el-option value="AUTO">自动</el-option>
              <el-option value="UDP">UDP</el-option>
              <el-option value="TCP">TCP</el-option>
            </el-select>
            <span class="f-label">{{ app.role === 'SERVER' ? '监听端口' : '目的端口' }}</span>
            <el-input-number v-model="app.port" size="small" :min="1" :max="65535" controls-position="right" style="width: 96px" placeholder="端口" />
            <template v-if="app.role === 'CLIENT'">
              <span class="f-label">对端节点</span>
              <el-select v-model="app.peer" size="small" placeholder="对端节点" style="width: 104px">
                <el-option v-for="c in peerCandidates()" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
            </template>
            <el-button size="small" text type="danger" @click="removeApp(i)">✕</el-button>
          </div>
          <div class="app-row" v-if="app.role === 'CLIENT'">
            <span class="f-label">发包间隔(s)</span>
            <el-input-number v-model="app.interval" size="small" :min="0.001" :step="0.1" controls-position="right" style="width: 96px" placeholder="间隔s" />
            <span class="f-label">载荷(B)</span>
            <el-input-number v-model="app.payloadSize" size="small" :min="1" :max="65535" controls-position="right" style="width: 96px" placeholder="载荷B" />
          </div>
        </div>
        <div class="app-add">
          <el-button size="small" type="success" plain @click="addApp('SERVER')">+ Server（协议监听）</el-button>
          <el-button size="small" type="warning" plain @click="addApp('CLIENT')">+ Client（对端上报）</el-button>
        </div>
      </el-form>
      <template #footer>
        <el-button type="danger" plain @click="removeSelected">删除</el-button>
        <el-button @click="dialog.show = false">取消</el-button>
        <el-button type="primary" @click="saveNode">保存</el-button>
      </template>
    </el-dialog>

    <!-- 画布装饰对象属性：文本 / 细线 -->
    <el-dialog v-model="decorDlg.show" :title="decorDlg.kind === 'text' ? '文本属性' : '细线属性'" width="460px" append-to-body>
      <el-form v-if="decorDlg.kind === 'text'" label-width="72px" label-position="left">
        <el-form-item label="内容">
          <el-input v-model="decorDlg.data.text" type="textarea" :rows="2" placeholder="输入文字" />
        </el-form-item>
        <el-form-item label="字号">
          <el-input-number v-model="decorDlg.data.fontSize" :min="8" :max="96" controls-position="right" style="width: 120px" />
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="decorDlg.data.color" />
          <span class="f-label" style="margin-left: 12px">加粗</span>
          <el-switch v-model="decorDlg.data.bold" style="margin-left: 6px" />
        </el-form-item>
      </el-form>
      <el-form v-else label-width="72px" label-position="left">
        <el-form-item label="起点">
          <el-input-number v-model="decorDlg.data.x1" class="decor-num" :min="0" controls-position="right" />
          <el-input-number v-model="decorDlg.data.y1" class="decor-num" :min="0" controls-position="right" />
        </el-form-item>
        <el-form-item label="终点">
          <el-input-number v-model="decorDlg.data.x2" class="decor-num" :min="0" controls-position="right" />
          <el-input-number v-model="decorDlg.data.y2" class="decor-num" :min="0" controls-position="right" />
        </el-form-item>
        <el-form-item label="线宽">
          <el-slider v-model="decorDlg.data.lineWidth" :min="1" :max="8" style="width: 220px" />
          <el-input-number v-model="decorDlg.data.lineWidth" :min="1" :max="8" style="width: 80px; margin-left: 12px" controls-position="right" />
        </el-form-item>
        <el-form-item label="样式">
          <el-select v-model="decorDlg.data.dash" style="width: 140px">
            <el-option v-for="o in DECOR_DASH_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="decorDlg.data.color" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="danger" plain @click="deleteSelectedDecor">删除</el-button>
        <el-button @click="decorDlg.show = false">取消</el-button>
        <el-button type="primary" @click="applyDecor">保存</el-button>
      </template>
    </el-dialog>

    <!-- 右键上下文菜单 -->
    <transition name="ctx">
      <div v-if="ctxMenu.show" class="ctx-menu" :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }" @click.stop>
        <template v-if="ctxMenu.kind !== 'blank'">
        <div class="ctx-title">{{ ctxLabel() }}</div>
        <div class="ctx-item" @click="ctxAction('prop')">属性</div>
        <div class="ctx-item" v-if="ctxMenu.kind === 'node'" @click="ctxAction('stats')">统计输出</div>
        <div class="ctx-item danger" @click="ctxAction('del')">删除</div>
      </template>
      <template v-else>
        <div class="ctx-title">运行设置</div>
        <div class="bs-row">
          <span class="bs-label">模式</span>
          <!-- 三个模式必须齐全：少一个，工程里那个值就成了"界面上无处可见的真相"
               （radio 组会因为匹配不上而一个都不选，看着像没设） -->
          <el-radio-group v-model="store.project.run.mode" size="small">
            <el-radio-button value="OFFLINE">离线</el-radio-button>
            <el-radio-button value="REALTIME">实时</el-radio-button>
            <el-radio-button value="HIL">HIL</el-radio-button>
          </el-radio-group>
        </div>
        <!-- 实时专属：同步模式（硬墙钟 / 尽力追赶）。HIL 由保守步进接管，不在此列 -->
        <div class="bs-row" v-if="store.project.run.mode === 'REALTIME'">
          <span class="bs-label">同步</span>
          <el-radio-group v-model="store.project.run.syncMode" size="small">
            <el-radio-button value="HARD_LIMIT">HardLimit</el-radio-button>
            <el-radio-button value="BEST_EFFORT">BestEffort</el-radio-button>
          </el-radio-group>
        </div>
        <div class="bs-row">
          <span class="bs-label">时钟源</span>
          <el-radio-group v-model="store.project.run.clockSource" size="small">
            <el-radio-button value="INTERNAL">内置</el-radio-button>
            <el-radio-button value="PTP">PTP</el-radio-button>
          </el-radio-group>
        </div>
        <div class="bs-row">
          <span class="bs-label">步长(μs)</span>
          <el-input-number :model-value="store.project.hil?.timestepUs ?? 100" :min="1" size="small" style="width: 110px"
            @update:model-value="store.setHil({ ...store.project.hil!, timestepUs: $event })" />
        </div>
        <div class="bs-row">
          <span class="bs-label">采样</span>
          <el-switch v-model="store.project.run.precise" active-text="precise" inactive-text="rough" size="small" />
        </div>
        <div class="bs-row">
          <span class="bs-label">停止(s)</span>
          <el-input-number v-model="store.project.run.stopSeconds" :min="1" size="small" style="width: 110px" />
        </div>
        <div class="bs-divider"></div>
        <div class="ctx-item" @click="openGridSettings">网格设置…</div>
      </template>
      </div>
    </transition>

    <!-- 统计输出选择 -->
    <el-dialog v-model="statsDlg.show" title="统计输出" width="440px" append-to-body>
      <div class="stats-desc">
        为{{ statsDlg.kind === 'node' ? '节点「' + statsTargetName() + '」' : '该链路' }}勾选需输出的统计项，导出后生成 ns-3 统计输出段。
      </div>
      <el-checkbox-group v-model="statsDlg.selected" class="stats-group">
        <el-checkbox v-for="s in STAT_OUTPUTS" :key="s.key" :value="s.key">{{ s.label }}</el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="statsDlg.show = false">取消</el-button>
        <el-button type="primary" @click="saveStats">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="linkDlg.show" title="链路属性" width="520px">
      <el-form v-if="linkDlg.link" label-width="110px" label-position="left">
        <el-form-item label="ID">
          <el-input :model-value="linkDlg.link.id" disabled />
        </el-form-item>
        <el-form-item label="类型">
          <el-input :model-value="linkDlg.link.kind === 'csma' ? 'CSMA 共享总线' : 'P2P 点对点'" disabled />
        </el-form-item>
        <el-form-item label="连接">
          <el-input :model-value="`${linkLabel(linkDlg.link.nodeA)} ↔ ${linkLabel(linkDlg.link.nodeB)}`" disabled />
        </el-form-item>
        <el-divider content-position="left">传输参数</el-divider>
        <el-form-item label="带宽">
          <el-input v-model="linkDlg.link.dataRate" placeholder="如 100Mbps / 10Gbps" />
        </el-form-item>
        <el-form-item label="时延">
          <el-input v-model="linkDlg.link.delay" placeholder="如 100us / 2ms" />
        </el-form-item>
        <el-form-item label="抖动">
          <el-input v-model="linkDlg.link.jitter" placeholder="如 10ms（报文级抖动提示）" />
        </el-form-item>
        <el-form-item label="误包率">
          <el-input-number v-model="linkDlg.link.errorRate" :min="0" :max="1" :step="0.0001" :precision="4" controls-position="right" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="danger" plain @click="removeLinkSel">删除链路</el-button>
        <el-button @click="linkDlg.show = false">取消</el-button>
        <el-button type="primary" @click="saveLink">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showGridCfg" title="网格设置" width="360px">
      <el-form label-width="110px" label-position="left">
        <el-form-item label="点阵间距 (px)">
          <el-input-number v-model="settings.gridSize" :min="8" :max="60" :step="2" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="点色深浅">
          <div class="cfg-gray">
            <el-slider v-model="settings.gridGray" :min="40" :max="95" />
            <span class="tb-val">{{ settings.gridGray }}%</span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="showGridCfg = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.topology-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 40px);
  gap: 12px;
}
/* ---------- 工具条并入菜单栏同一行 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  margin-left: auto;
  gap: 14px;
  flex-wrap: nowrap;
  flex-shrink: 0;
  padding: 0 4px 0 12px;
  border-left: 1px solid var(--ech-border);
  background: none;
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
}
/* ---------- 仿真操作按钮组（菜单栏中间，圆形图标按钮） ---------- */
.sim-actions {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 3;
}
.sim-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--ech-border-strong);
  background: linear-gradient(180deg, #242b36, #1a2028);
  color: #c7d5e4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.18s ease;
  padding: 0;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 3px 8px rgba(0, 0, 0, 0.3);
  position: relative;
}
.sim-btn:hover:not(:disabled) {
  color: var(--ech-accent-strong);
  border-color: rgba(46, 163, 255, 0.65);
  box-shadow: 0 0 0 2px rgba(46, 163, 255, 0.18), 0 0 12px rgba(46, 163, 255, 0.25);
  transform: translateY(-1px);
}
/* 编译锤：专属磷光青，明确可点击的操作引导 */
.sim-ico.hammer { color: #58c1ff; filter: drop-shadow(0 0 3px rgba(46, 163, 255, 0.55)); }
/* 运行播放：高亮翠绿，active 时亮起 */
.sim-btn:not(:disabled) .sim-ico.play { color: #3af08e; filter: drop-shadow(0 0 4px rgba(58, 240, 142, 0.5)); }
/* 暂停：亮琥珀 */
.sim-btn:not(:disabled) .sim-ico.pause { color: #ffc046; filter: drop-shadow(0 0 4px rgba(255, 192, 70, 0.5)); }
.sim-btn.active {
  color: #3af08e;
  border-color: rgba(58, 240, 142, 0.6);
  box-shadow: 0 0 0 2px rgba(58, 240, 142, 0.2), 0 0 14px rgba(58, 240, 142, 0.35);
}
.sim-btn:disabled,
.sim-btn.disabled {
  opacity: 0.38;
  cursor: not-allowed;
  filter: saturate(0.2);
}
.sim-ico {
  width: 22px;
  height: 22px;
}
.sim-ico.loading {
  animation: spin 0.8s linear infinite;
  color: #58c1ff;
  filter: drop-shadow(0 0 4px rgba(46, 163, 255, 0.5));
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ---------- 菜单栏（文件/编辑/视图/帮助） ---------- */
.menubar {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 0 6px;
  min-height: 34px;
  flex-shrink: 0;
  user-select: none;
}
.mb-top {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 13px;
  color: var(--ech-fg);
  cursor: pointer;
  border-radius: 6px;
  margin: 3px 0;
}
.mb-top:hover,
.mb-top.open {
  background: var(--ech-border);
  color: #fff;
}
.mb-drop {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 300;
  min-width: 210px;
  display: flex;
  flex-direction: column;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  padding: 5px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
}
.mb-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ech-fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mb-entry:hover:not(:disabled) {
  background: var(--ech-accent);
  color: #fff;
}
.mb-entry:disabled {
  color: var(--ech-fg-dim);
  opacity: 0.55;
  cursor: default;
}
.mb-lbl {
  flex: 1;
}
.mb-sc {
  font-size: 12px;
  color: var(--ech-fg-dim);
}
.mb-entry:hover:not(:disabled) .mb-sc {
  color: rgba(255, 255, 255, 0.85);
}
.mb-sep {
  height: 1px;
  background: var(--ech-border);
  margin: 5px 8px;
}
.tb-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tb-label {
  font-size: 12px;
  color: var(--ech-fg-dim);
}
.tb-dirty {
  font-size: 12px;
  color: var(--ech-accent);
}
.tb-stats {
  margin-left: auto;
  font-size: 12px;
  color: var(--ech-accent-2);
}
/* 点击画布后才出现的工作区尺寸，与右侧节点/链路统计用竖线隔开 */
.tb-ws {
  margin-right: 14px;
  padding-right: 12px;
  border-right: 1px solid var(--ech-border);
  color: var(--ech-fg-dim);
}
.tb-val {
  font-size: 12px;
  color: var(--ech-accent-2);
  min-width: 34px;
  text-align: right;
}
/* ---------- 画布缩放条（｜放大镜− ｜放大镜+ ｜百分比+▾ ｜适应画布+▾） ---------- */
/* 版式对齐参考截图：一组各自独立的窄控件，不套统一外框 */
.zoom-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  padding: 0;
}
.zb-sep {
  width: 1px;
  height: 18px;
  background: #cfd5de;
  margin: 0 3px 0 1px;
}
.zb-btn {
  width: 28px;
  height: 24px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border: 1px solid #c9cfd8;
  border-radius: 3px;
  cursor: pointer;
}
.zb-btn:hover {
  background: #eef4fd;
  border-color: #8ab4e8;
}
.zb-btn:active {
  background: #dde9fa;
}
.zb-ico {
  width: 18px;
  height: 18px;
}
.zb-glass {
  fill: #cfe3f8;
  stroke: #2f6fb5;
  stroke-width: 1.2;
}
.zb-handle {
  stroke: #2f6fb5;
  stroke-width: 2;
  stroke-linecap: round;
}
.zb-sign {
  stroke: #1f4e79;
  stroke-width: 1.7;
  stroke-linecap: round;
}
.zb-expand {
  fill: none;
  stroke: #2f6fb5;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.zb-combo {
  position: relative;
  display: flex;
  align-items: stretch;
}
.zb-input {
  width: 56px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 6px;
  font-size: 12px;
  font-family: inherit;
  text-align: center;
  color: #253040;
  background: #fff;
  border: 1px solid #c9cfd8;
  border-right: none;
  border-radius: 3px 0 0 3px;
  outline: none;
}
.zb-input:focus {
  background: #f7faff;
  border-color: #8ab4e8;
}
.zb-caret {
  width: 17px;
  height: 24px;
  padding: 0;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f2f4f7;
  border: 1px solid #c9cfd8;
  border-radius: 0 3px 3px 0;
  cursor: pointer;
}
.zb-caret:hover,
.zb-caret.open {
  background: #dde9fa;
}
.zb-tri {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid #4b5768;
}
.zb-fit {
  border-right: none;
  border-radius: 3px 0 0 3px;
}
.zb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 3000;
  min-width: 88px;
  padding: 3px;
  background: #fff;
  border: 1px solid var(--ech-border);
  border-radius: 4px;
  box-shadow: 0 4px 14px rgba(20, 40, 70, 0.14);
}
.zb-menu.right {
  left: auto;
  right: 0;
}
.zb-menu-item {
  padding: 4px 10px;
  font-size: 12px;
  color: #253040;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.zb-menu-item:hover {
  background: #eef4fd;
  color: #1f6fd0;
}
.zb-menu-item.on {
  color: #1f6fd0;
  font-weight: 600;
}
/* 尺寸面板（替换原视图菜单：长/宽两个输入框，样式同画布设置） */
.zb-menu.dim {
  width: 176px;
  padding: 8px;
}
.zb-dim-title {
  font-size: 11px;
  color: #66738a;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid #e6ebf2;
}
.zb-dim-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.zb-dim-label {
  font-size: 12px;
  color: #253040;
  width: 52px;
  flex-shrink: 0;
}
.zb-menu.dim .el-input-number {
  flex: 1;
  width: 100%;
}
.canvas-wrap {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 12px;
  margin-top: -8px; /* 收回 .topology-page gap:12px，压缩工具栏与标签栏之间的空白 */
  position: relative; /* 框选矩形的定位上下文 */
}
/* 框选矩形（rubber-band），运行时由 rubber 状态驱动 */
.rubber {
  position: absolute;
  z-index: 20;
  pointer-events: none;
  border: 1px dashed var(--el-color-primary, #2f81f7);
  border-radius: 2px;
  background: rgba(47, 129, 247, 0.12);
}
/* 中央画布列：标签栏在上、画布在下；flex:1 横向占满三大栏之间，画布纵向填满 */
.canvas-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.library {
  width: 130px;
  flex-shrink: 0;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}
.caselib {
  width: 236px;
  flex-shrink: 0;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 10px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.caselib-sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lib-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--ech-border);
  padding-bottom: 6px;
}
.case-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--ech-border);
  border-radius: 7px;
  padding: 8px 10px;
  cursor: pointer;
  transition: all 0.15s;
  background: rgba(255, 255, 255, 0.03);
}
.case-item .case-info {
  flex: 1;
  min-width: 0;
}
.case-item:hover {
  border-color: var(--ech-accent);
  background: rgba(47, 129, 247, 0.1);
}
.case-name {
  font-size: 13px;
  color: var(--ech-fg);
  font-weight: 600;
}
.case-desc {
  font-size: 11px;
  color: #566070;
  margin-top: 3px;
  line-height: 1.4;
}
.case-empty {
  font-size: 12px;
  color: #566070;
  text-align: center;
  padding: 12px 4px;
  border: 1px dashed var(--ech-border);
  border-radius: 7px;
  line-height: 1.6;
}
.case-tabs :deep(.el-tabs__header) {
  margin-bottom: 10px;
}
.case-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: var(--ech-border);
}
.case-tabs :deep(.el-tabs__item) {
  color: var(--ech-fg-dim);
  font-size: 13px;
  height: 34px;
  line-height: 34px;
}
.case-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ech-accent);
}
.case-folder {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.15s;
  background: rgba(255, 255, 255, 0.03);
}
.case-folder:hover {
  border-color: var(--ech-accent);
  background: rgba(47, 129, 247, 0.1);
}
.folder-ico {
  font-size: 22px;
}
.folder-text {
  flex: 1;
  min-width: 0;
}
.folder-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ech-fg);
}
.folder-sub {
  font-size: 11px;
  color: #566070;
  margin-top: 3px;
}
.folder-arrow {
  color: #8a94a3;
  font-size: 18px;
}
/* ---------- 自带案例库文件夹右键菜单 ---------- */
.folder-menu {
  position: fixed;
  z-index: 2000;
  min-width: 150px;
  background: #232830;
  border: 1px solid #39404a;
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  user-select: none;
}
.fm-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--ech-fg);
  font-size: 12.5px;
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.fm-item:hover {
  background: rgba(47, 129, 247, 0.18);
  color: #fff;
}
.fm-item.fm-danger:hover {
  background: rgba(224, 78, 78, 0.18);
  color: #ff6b6b;
}
.fm-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.fm-item:disabled:hover {
  background: none;
  color: var(--ech-fg);
}
.fm-sep {
  height: 1px;
  background: #39404a;
  margin: 4px 6px;
}
.case-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ech-border);
  margin-bottom: 8px;
}
.case-back,
.case-refresh {
  background: none;
  border: 1px solid var(--ech-border);
  color: var(--ech-fg-dim);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.case-back:hover,
.case-refresh:hover {
  border-color: var(--ech-accent);
  color: var(--ech-accent);
}
/* 文件夹列表页的「刷新」靠右，标题与计数靠左 */
.case-refresh {
  margin-left: auto;
}
.case-head-n {
  font-size: 11px;
  color: #566070;
}
.case-head-t {
  font-size: 13px;
  color: var(--ech-fg);
  font-weight: 600;
}
.case-file {
  margin-right: 8px;
}
.user-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.user-item .case-info {
  min-width: 0;
}
.user-item .case-name {
  font-size: 12px;
  font-weight: 500;
}
.user-item .case-desc {
  font-size: 10px;
  margin-top: 2px;
}
.lib-title {
  font-size: 12px;
  color: var(--ech-fg-dim);
  font-weight: 600;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ech-border);
}
.lib-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--ech-border);
  border-radius: 6px;
  color: var(--ech-fg);
  padding: 8px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.lib-item:hover {
  border-color: var(--ech-accent);
  background: rgba(47, 129, 247, 0.12);
}
.lib-item.active {
  border-color: var(--ech-accent);
  background: rgba(47, 129, 247, 0.22);
  box-shadow: 0 0 0 1px var(--ech-accent) inset;
}
.ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.canvas {
  flex: 1;
  min-width: 0;
  position: relative; /* X6 内部绝对定位图层以此容器为定位上下文，配合 overflow 裁剪，避免越界形成全屏合成层 */
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  overflow: hidden;
  background: #dfe2e6; /* 工作区(白色点阵背景图)之外的画布底色 */
}
/* 连线模式下画布光标变为铅笔（热区在笔尖）。只设在容器上，避免把自定义光标套到
   X6 的绝对定位大 SVG 层（切成全屏合成层会盖住左侧案例库，见合成层伪影问题） */
.canvas-draw {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='none'/%3E%3Cpolygon points='2,2 9,6 23,20 20,23 6,9' fill='%231d232b' stroke='%23ffffff' stroke-width='1.4' stroke-linejoin='round'/%3E%3Ccircle cx='2' cy='2' r='1.6' fill='%231d232b'/%3E%3C/svg%3E")
    2 2,
    crosshair;
}
/* P2P 连线按钮：铅笔连线图标（对角线段 + 两端锚点），随按钮状态着色 */
.link-tool {
  width: 15px;
  height: 15px;
  display: block;
}
.link-tool .link-line {
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.link-tool .link-dot {
  fill: currentColor;
}
.cfg-gray {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.cfg-gray .el-slider {
  flex: 1;
}
.ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 128px;
  background: #f7f8fa;
  border: 1px solid #d5dae1;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(31, 42, 58, 0.18);
  padding: 4px;
  font-size: 13px;
}
.ctx-title {
  padding: 5px 10px;
  color: #8a94a3;
  font-size: 11px;
  border-bottom: 1px solid #eceef2;
  margin-bottom: 2px;
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-item {
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
  color: #1f2a3a;
}
.ctx-item:hover {
  background: #e6ecf5;
  color: #2f81f7;
}
.ctx-item.danger {
  color: #e06c75;
}
.ctx-item.danger:hover {
  background: #fdf0f0;
  color: #d6454f;
}
.stats-desc {
  color: #5b6778;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 12px;
}
.stats-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow: auto;
  padding: 2px;
}
.stats-group .el-checkbox {
  margin-right: 0;
  margin-left: 0;
  height: 32px;
}
.bs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  font-size: 13px;
  min-width: 240px;
}
.bs-label {
  color: #5b6778;
  flex-shrink: 0;
}
.bs-divider {
  height: 1px;
  background: #eceef2;
  margin: 4px 0;
}
.app-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.app-card {
  border: 1px solid var(--ech-border, #e1e6ee);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 8px;
  background: transparent;
}
.f-label {
  flex: none;
  font-size: 12px;
  color: var(--ech-fg-dim, #6b7684);
  white-space: nowrap;
  min-width: 22px;
}
.app-role {
  flex: none;
  margin-right: 2px;
}
.ip-sock {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  color: #2f81f7;
  background: #eaf1fc;
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}
.app-add {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
.ip-field {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ip-hint {
  font-size: 12px;
  line-height: 1.4;
  /* 用 Element Plus 自己的次级文字色：弹窗是浅色面，借 App 的深色主题变量对比度不足 */
  color: var(--el-text-color-secondary, #909399);
}
</style>