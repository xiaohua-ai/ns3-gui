<script setup lang="ts">
// Runtime 运行监视工作台：
// 左侧元件库 → 拖到右侧 CSS Grid 画布，组件实例随会话隔离（store.currentSession.runtime），
// 独立于工程文件。支持拖入 / 重排 / 右下角缩放 / 删除 / 绑定对象。
//
// 数据来源有两条，且**共用同一个 ingest**（组件侧完全无感）：
//   1) 仿真机实跑：顶部运行按钮（模式取工程运行设置 OFFLINE / REALTIME / HIL）→ 生成产物 → SSH 流式回传 → 解析 → ingest
//   2) 示例数据：顶部「示例数据」→ 周期 mock（没连机器时用来预览布局）
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkbench } from '@/stores/workbench';
import { useRuntimeStore } from '@/stores/runtime';
import {
  RUNTIME_COMPONENTS,
  runtimeComponentByKey,
  moveLayoutItem,
  bindingOptions,
  type RuntimeComponentMeta,
  type RuntimeBinding,
  type RuntimeLayoutItem,
} from '@core/runtimeModel';
import { formatRelTime, formatClockTime, formatClockStamp } from '@core/runLog';
import { buildRuntimeResult, isRuntimeResultFile } from '@core/runtimeResult';
import {
  saveRuntimeResultToProject,
  openRuntimeResultText,
  listRuntimeResults,
  readRuntimeResultByName,
  suggestRuntimeResultName,
  type RuntimeResultListItem,
} from '@/utils/runtimeResultStorage';
import { serializeProject } from '@core/projectFile';
import { saveProjectText, getCurrentProjectDir, setProjectDirFromPath } from '@/utils/projectStorage';
import { tickMs, startSimTicker, stopSimTicker } from './runtimeTicker';
import CommChart from '@/components/runtime/CommChart.vue';
import GooseTiming from '@/components/runtime/GooseTiming.vue';
import HilSync from '@/components/runtime/HilSync.vue';
import HilInject from '@/components/runtime/HilInject.vue';
import OpLog from '@/components/runtime/OpLog.vue';
import SimLog from '@/components/runtime/SimLog.vue';

const store = useWorkbench();
const rt = useRuntimeStore();

/**
 * 运行设置（含模式 OFFLINE / REALTIME / HIL）——**唯一来源是当前工程的 project.run**。
 * 导出页、拓扑页设置面板、模式徽标读到的都是它，随工程一起保存与载入。
 *
 * 用 computed 而**不**写成 `const run = store.project.run`：后者在 setup 时把当前工程的
 * 对象引用缓存住，切换工程后仍指着旧工程（界面显示上一个工程的模式）。computed 每次访问
 * 重新取，天然跟着工程走。
 */
const run = computed(() => store.project.run);

/** 一键布局：五种监视组件各一个（首次运行前若画布为空会自动调用） */
const DEFAULT_LAYOUT = ['comm', 'goose', 'hil-sync', 'hil-inject', 'op', 'sim-log'];

/**
 * 运行日志只渲染尾部这么多行（store 侧缓冲上限是 500，见 core/runLog 的 RUN_LOG_MAX）。
 *
 * 定得比"看一眼最近几行"宽：这个面板的用法是**纵向比对阶段行之间的间隔**
 * （`[running]` 到 `[done]` 隔了多少），窗口太窄时一段带告警的构建输出
 * 就能把 `[running]` 挤出可视区 —— 恰好把要对比的那半截弄丢。
 */
const LOG_TAIL = 80;

/** 左侧元件库宽度：可拖右缘手柄左右调节 */
const LIB_MIN_W = 180;
const LIB_MAX_W = 460;
const libWidth = ref(240);

function onLibResizeDown(ev: MouseEvent) {
  ev.preventDefault();
  const startX = ev.clientX;
  const baseW = libWidth.value;
  document.body.style.userSelect = 'none';
  const onMove = (me: MouseEvent) => {
    libWidth.value = Math.min(LIB_MAX_W, Math.max(LIB_MIN_W, baseW + me.clientX - startX));
  };
  const onUp = () => {
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function seedLayout() {
  for (const key of DEFAULT_LAYOUT) {
    const meta = runtimeComponentByKey(key);
    if (meta) store.addRuntimeItem(meta);
  }
}

function seedLayoutIfEmpty() {
  if (!layoutItems.value.length) seedLayout();
}

/** 把本次运行结束时的整份监视快照存成结果文件，写入「工程所在文件夹」 */
async function onSaveResult() {
  const f = buildRuntimeResult({
    header: rt.header,
    items: store.currentSession.runtime.items,
    events: rt.events,
    simLog: rt.simLog,
    mode: rt.simMode,
    phase: rt.simPhase,
    exitCode: rt.simExitCode,
    duration: rt.simDuration,
    projectName: store.project.projectName,
    stopSeconds: rt.header?.stopSeconds ?? null,
    syncMode: rt.header?.syncMode,
  });
  const content = JSON.stringify(f, null, 2);
  const name = suggestRuntimeResultName(store.project.projectName);
  let res = await saveRuntimeResultToProject(content, name);
  // 主进程尚无工程文件夹（工程没存到本地）→ 先引导用户把工程落盘，再重试
  if (res.needsProjectDir) {
    const ok = await ensureProjectDir();
    if (!ok) return;
    res = await saveRuntimeResultToProject(content, name);
  }
  if (res.ok) {
    ElMessage.success(
      res.via === 'download'
        ? '运行结果已下载（浏览器环境无工程文件夹，见下载目录）'
        : `运行结果已保存到工程文件夹：${res.fileName ?? name}`,
    );
  } else if (res.reason === 'cancelled') ElMessage.info('已取消保存');
  else ElMessage.error(`保存失败：${res.reason ?? '未知错误'}`);
}

/** 确保工程已落到本地（有工程文件夹），否则弹确认框让用户先把工程存盘。返回是否有工程文件夹 */
async function ensureProjectDir(): Promise<boolean> {
  if (getCurrentProjectDir()) return true;
  const go = await ElMessageBox.confirm(
    '运行结果需保存到「工程所在文件夹」。当前工程尚未保存到本地，是否先保存工程以建立工程文件夹？',
    '请先保存工程',
    { confirmButtonText: '保存工程', cancelButtonText: '取消', type: 'info' },
  ).catch(() => false);
  if (!go) return false;
  const content = serializeProject(store.project);
  const res = await saveProjectText(content, `${(store.project.projectName || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '_')}.tc`, {
    forceDialog: true,
  });
  if (res.ok && res.path) {
    setProjectDirFromPath(res.path);
    store.markClean();
    ElMessage.success('工程已保存，运行结果将存入该文件夹');
    return true;
  }
  if (res.reason !== 'cancelled') ElMessage.error(`工程保存失败：${res.reason ?? '未知错误'}`);
  return false;
}

/** 历史结果：优先列出工程文件夹内的结果文件；无文件夹（浏览器/工程未存）则退回单文件选择 */
const historyVisible = ref(false);
const historyFiles = ref<RuntimeResultListItem[]>([]);
const historyDir = ref('');

async function onOpenResult() {
  const list = await listRuntimeResults();
  if (list.ok && list.dir && list.files.length) {
    historyFiles.value = list.files;
    historyDir.value = list.dir;
    historyVisible.value = true;
    return;
  }
  if (list.ok && !list.dir) {
    ElMessage.info('当前工程尚未保存到本地，无法列出历史结果；请先在「拓扑」页保存工程，或手动选择结果文件');
  } else if (list.ok && list.dir && !list.files.length) {
    ElMessage.info('该工程文件夹下暂无运行结果文件');
    return;
  } else if (!list.ok) {
    ElMessage.error(`列出历史结果失败：${list.reason ?? '未知错误'}`);
    return;
  }
  await openResultViaPicker();
}

/** 退回单文件选择（无工程文件夹 / 浏览器环境） */
async function openResultViaPicker() {
  const res = await openRuntimeResultText();
  if (!res?.ok) {
    if (res?.reason !== 'cancelled') ElMessage.error(res?.reason ?? '打开失败');
    return;
  }
  loadResultContent(res.content ?? '', res.fileName || '历史结果');
}

/** 从历史列表里挑一个读取并还原 */
async function pickHistory(name: string) {
  const res = await readRuntimeResultByName(name);
  historyVisible.value = false;
  if (!res.ok) {
    ElMessage.error(`读取失败：${res.reason ?? '未知错误'}`);
    return;
  }
  loadResultContent(res.content ?? '', res.fileName || name);
}

/** 解析结果文件内容并还原到 Runtime 监视台 */
function loadResultContent(content: string, fileName: string) {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRuntimeResultFile(parsed)) {
      ElMessage.error('所选文件不是有效的运行结果文件');
      return;
    }
    store.setRuntimeItems(parsed.items ?? []); // 还原画布布局（含对象绑定），曲线绑定即可对上当时数据
    rt.loadResult(parsed, fileName);
    ElMessage.success(`已载入历史结果：${fileName}`);
  } catch (e) {
    ElMessage.error(`结果文件解析失败：${String((e as Error)?.message ?? e)}`);
  }
}

/** Runtime 界面 Ctrl+S = 保存运行结果到工程文件夹（覆盖浏览器默认的「保存网页」） */
function onRuntimeKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void onSaveResult();
  }
}

/** 阶段徽标的文案（把主进程的机器态阶段翻成人话） */
const PHASE_LABEL: Record<string, string> = {
  idle: '未运行',
  connecting: '连接仿真机',
  uploading: '上传产物',
  building: '构建中',
  precheck: '运行前置检查',
  running: '运行中',
  done: '已完成',
  error: '失败',
};
const simPhaseLabel = computed(() => PHASE_LABEL[rt.simPhase] ?? rt.simPhase);

/**
 * 运行：三种模式走的是**同一条通道**，差别只在产物模式。
 *   OFFLINE  —— ns-3 全速推进，遥测瞬间到齐 → 曲线一次铺满（回看、截图、比对用）
 *   REALTIME —— RealtimeSimulatorImpl 按墙钟推进，纯软件实时 → 曲线逐拍滚动
 *   HIL      —— RealtimeSimulatorImpl + 保守步进 + TapBridge 半实物闭环 → 硬件在环实时
 */
async function onRun(mode: 'OFFLINE' | 'REALTIME' | 'HIL') {
  if (rt.simRunning) return;
  seedLayoutIfEmpty();
  // 按钮点击即**写运行设置**（而不是另开一个"本次运行的模式"）：这样"界面上显示的模式"
  // 与"产物按什么模式生成"永远是同一个字段，并且随工程保存，下次打开还是它。
  store.setRun({ mode });
  const res = await rt.runSim({});
  const label = mode === 'OFFLINE' ? '离线' : mode === 'REALTIME' ? '实时' : 'HIL';
  if (res.ok) ElMessage.success(`${label}运行完成`);
  else ElMessage.error(res.error ?? '运行失败');
}

/** 运行按钮：一个键，跑当前运行设置里的模式 */
const runMode = computed<'OFFLINE' | 'REALTIME' | 'HIL'>(() => run.value.mode);

async function onRunBtn() {
  await onRun(runMode.value);
}

/** 离线设置下按钮是"离线运行"，实时类设置下跟随具体实时模式（REALTIME / HIL） */
const runBtnLabel = computed<string>(() =>
  runMode.value === 'OFFLINE' ? '离线运行' : runMode.value === 'HIL' ? 'HIL 运行' : '实时运行'
);

const runBtnTitle = computed<string>(() =>
  runMode.value === 'OFFLINE'
    ? '生成 OFFLINE 产物并送到仿真机跑完，结果一次性铺满'
    : runMode.value === 'HIL'
      ? '生成 HIL 产物（实时仿真器 + 半实物），曲线随仿真实时滚动'
      : '生成 REALTIME 产物（挂钟实时仿真器，纯软件），曲线随墙钟滚动'
);

// ---- 工具栏三键：编译 / 运行 / 暂停（与拓扑页顶部「仿真操作」同动作、同视觉）----
const simCompiling = ref(false);
const simStopping = ref(false);
/** 构建 / 运行提交后才「就绪」，与拓扑页一致：先编译后运行 */
const simReady = computed(() => rt.simPhase === 'done');
async function onSimCompile() {
  if (rt.simRunning) return;
  simCompiling.value = true;
  try {
    const res = await rt.runSim({ buildOnly: true });
    if (res.ok) ElMessage.success(`构建成功${res.duration ? `（${res.duration}）` : ''}，可点击运行`);
    else ElMessage.error(res.error || '构建失败');
  } finally {
    simCompiling.value = false;
  }
}
async function onSimRun() {
  if (rt.simRunning) return;
  const res = await rt.runSim({});
  if (res.ok) ElMessage.success('仿真完成');
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

// ---- 仿真器实跑计时：起止都绑定仿真器实际相位，而非按钮/编译阶段 ----
// 起点 = 服务端 phase 进入 `running`（仿真器进程真正运行）→ 清零+起表；
// 仿真器实跑计时：起点/终点由产物遥测标记驱动，而非 phase 事件。
// 起点 = [EPC-OP] "遥测通道就绪"（Simulator::Run() 之前），终点 = [EPC-OP] "仿真结束"（之后）。
// 使计时器精确测量仿真引擎实际执行时间，不计入进程启动/关闭的 ~360ms 开销。
const tickerPhaseWatch = watch(
  () => rt.simTickerActive,
  (active, prev) => {
    if (active) {
      // false → true = 新会话的仿真开始，清零起表；remount 时 prev=undefined 只续走
      startSimTicker(prev === false);
    } else {
      stopSimTicker();
    }
  },
  { immediate: true },
);

// 运行日志自动吸底：以"最新一行的 seq"为信号（appendRunLog 里 seq 单调递增，缓冲满后仍变化）。
// 不用 simLog.length：缓冲封顶 RUN_LOG_MAX(500) 后 length 恒定，新日志到达时 length watch 不触发，
// 自动吸底会静默失效——那是隐性补丁。seq 变化即"来了新日志"，此时把容器滚到最底即可。
const rlListEl = ref<HTMLElement | null>(null);
watch(
  () => rt.simLog[rt.simLog.length - 1]?.seq,
  () => {
    const el = rlListEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
  { flush: 'post', immediate: true },
);

// 计时器状态色：跟随当前仿真模式。实时(REALTIME/HIL)走表用绿、离线用淡青(对齐「离线运行」)、
// 不运行灰。running 期间 rt.simMode 已在 runSim 入口置位，可直接用。
const timerCls = computed<'idle' | 'offline' | 'live'>(() => {
  if (!rt.simRunning) return 'idle';
  return rt.simMode === 'OFFLINE' ? 'offline' : 'live';
});
onMounted(() => {
  window.addEventListener('keydown', onRuntimeKey);
});
onUnmounted(() => {
  if (tickerPhaseWatch) tickerPhaseWatch();
  stopSimTicker();
  window.removeEventListener('keydown', onRuntimeKey);
});
function fmtElapsed(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  const msPart = `.${pad(cs)}`;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}${msPart}` : `${pad(m)}:${pad(s)}${msPart}`;
}

// ---- 布局只读视图：始终跟随当前活动标签（currentSession 随 activeId 响应式切换） ----
const layoutItems = computed(() => store.currentSession.runtime.items);
const bindingOpts = computed(() => bindingOptions(store.project));
// 运行工程名：优先取运行时 snapshot（header.projectName），未运行（或运行前）回落到当前活动工程名
const runProjectName = computed(() => rt.header?.projectName || store.project.projectName);
const canvasRef = ref<HTMLElement | null>(null);

// ---- 每个组件实例的事件源：按各自绑定过滤；组件内部再按自身 kind 取子集 ----
function itemEvents(item: RuntimeLayoutItem) {
  return rt.eventsByBinding(item.binding);
}

const GRID_COLS = 6;
const MAX_ROW = 6;

// ---- 画布内重排来源索引（HTML5 DnD dataTransfer 跨事件不可靠，用引用暂存） ----
const dragFrom = ref<number | null>(null);

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------- 元件库 → 画布 ----------
function onLibDragStart(ev: DragEvent, meta: RuntimeComponentMeta) {
  dragFrom.value = null; // 库项不是画布内移动
  if (ev.dataTransfer) {
    ev.dataTransfer.setData('text/runtime-meta', meta.key);
    ev.dataTransfer.effectAllowed = 'copy';
  }
}

function addFromLibrary(key: string | null) {
  if (!key) return;
  const meta = runtimeComponentByKey(key);
  if (meta) store.addRuntimeItem(meta);
}

// ---------- 画布落点：库添加 / 画布内重排 ----------
function onCanvasDragOver(ev: DragEvent) {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = dragFrom.value != null ? 'move' : 'copy';
}

function onCanvasDrop(ev: DragEvent) {
  ev.preventDefault();
  const from = dragFrom.value;
  if (from != null) {
    // 画布内移动 → 放到末尾
    const items = layoutItems.value;
    store.setRuntimeItems(moveLayoutItem(items, from, items.length));
    dragFrom.value = null;
    return;
  }
  addFromLibrary(ev.dataTransfer?.getData('text/runtime-meta') ?? null);
}

function onItemDragStart(ev: DragEvent, index: number) {
  dragFrom.value = index;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(index));
  }
}

function onItemDragOver(ev: DragEvent) {
  ev.preventDefault(); // 允许在卡片上落下
}

/** 落到某张卡片上：把被拖的移到该卡片之前 */
function onItemDrop(ev: DragEvent, toIndex: number) {
  ev.preventDefault();
  ev.stopPropagation();
  const from = dragFrom.value;
  if (from == null) return;
  const items = layoutItems.value;
  store.setRuntimeItems(moveLayoutItem(items, from, toIndex));
  dragFrom.value = null;
}

// ---------- 尺寸：右下角把手拖动 ⇒ span 变化 ----------
function onResizeDown(ev: MouseEvent, itemId: string, meta: RuntimeComponentMeta | undefined) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!meta || !canvasRef.value) return;
  const gridRect = canvasRef.value.getBoundingClientRect();
  const cellW = gridRect.width / GRID_COLS;
  const item = layoutItems.value.find((x) => x.id === itemId);
  if (!item) return;
  const startX = ev.clientX;
  const startY = ev.clientY;
  const baseCol = item.colSpan;
  const baseRow = item.rowSpan;
  const onMove = (me: MouseEvent) => {
    const dx = me.clientX - startX;
    const dy = me.clientY - startY;
    const col = clamp(baseCol + Math.round(dx / cellW), meta.minCol, GRID_COLS);
    const row = clamp(baseRow + Math.round(dy / Math.max(cellW * 0.75, 24)), meta.minRow, MAX_ROW);
    store.updateRuntimeItem(itemId, { colSpan: col, rowSpan: row });
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------- 绑定 ----------
function scopeOptions(bindable: boolean): Array<{ value: RuntimeBinding['scope']; label: string }> {
  if (!bindable) return [];
  return [
    { value: 'whole', label: '整个工程' },
    { value: 'node', label: '节点' },
    { value: 'link', label: '链路' },
    { value: 'flow', label: '业务流' },
  ];
}
function targetOptions(scope: RuntimeBinding['scope']) {
  const o = bindingOpts.value;
  return scope === 'node' ? o.nodes : scope === 'link' ? o.links : scope === 'flow' ? o.flows : [];
}
function patchBinding(itemId: string, scope: RuntimeBinding['scope']) {
  const item = layoutItems.value.find((x) => x.id === itemId);
  if (!item) return;
  const target = item.binding.scope === scope ? item.binding.target : scope === 'whole' ? undefined : item.binding.target;
  store.updateRuntimeItem(itemId, { binding: { scope, target } });
}
function patchBindingTarget(itemId: string, target: string) {
  const item = layoutItems.value.find((x) => x.id === itemId);
  if (!item) return;
  store.updateRuntimeItem(itemId, { binding: { ...item.binding, target } });
}
</script>

<template>
  <div class="runtime-page">
    <!-- 左侧元件库 -->
    <aside class="lib" :style="{ width: libWidth + 'px' }">
      <div class="lib-title">监视组件</div>
      <button
        v-for="c in RUNTIME_COMPONENTS"
        :key="c.key"
        class="lib-item"
        draggable="true"
        @dragstart="onLibDragStart($event, c)"
        @click="addFromLibrary(c.key)"
      >
        <span class="lib-dot" :class="'kind-' + c.kind"></span>
        <span class="lib-label">{{ c.label }}</span>
        <span class="lib-size">{{ c.minCol }}×{{ c.minRow }}</span>
      </button>

      <!-- 运行日志：常驻在左侧元件库下方，竖向长条，自动填满剩余高度（无日志时也占位） -->
      <div class="runlog">
        <div class="rl-head">
          <span class="rl-title">运行日志</span>
          <span v-if="rt.simDuration" class="rl-meta">耗时 {{ rt.simDuration }}</span>
          <span v-if="rt.simExitCode !== null" class="rl-meta" :class="{ bad: rt.simExitCode !== 0 }">
            退出码 {{ rt.simExitCode }}
          </span>
        </div>
        <div v-if="!rt.simLog.length" class="rl-empty">暂无日志，运行仿真后在此显示构建输出与运行提示</div>
        <ul v-else ref="rlListEl" class="rl-list">
          <li
            v-for="l in rt.simLog.slice(-LOG_TAIL)"
            :key="l.seq"
            :title="`${formatClockStamp(l.atMs)} · 运行后 ${formatRelTime(l.tMs)}`"
          >
            <span class="rl-t">{{ formatClockTime(l.atMs) }}</span>
            <span class="rl-x">{{ l.text }}</span>
          </li>
        </ul>
      </div>
      <div class="lib-resize-handle" @mousedown="onLibResizeDown" title="拖动调整面板宽度"></div>
    </aside>

    <!-- 右侧画布 -->
    <div class="stage">
      <div class="toolbar">
        <span class="t-name">Runtime 监视台</span>
        <span class="t-project" title="运行工程">{{ runProjectName }}</span>
        <span class="t-count">{{ rt.eventCount }} 条事件</span>
        <span v-if="rt.simMode" class="t-badge">{{ rt.simMode }}</span>
        <span v-if="rt.simMode === 'REALTIME' && rt.header?.syncMode" class="t-badge sync">{{ rt.header.syncMode }}</span>
        <span v-if="rt.header" class="t-count">时长 {{ rt.header.stopSeconds }}s</span>
        <span class="t-timer" :class="timerCls">{{ fmtElapsed(tickMs) }}</span>
        <span class="spacer"></span>
        <!-- 仿真三键居中：左右各一个弹性 spacer 均分剩余空间，位于信息区与右侧操作按钮群之间 -->
        <div class="rf-sim-actions">
          <button class="sim-btn" :class="{ active: simCompiling, disabled: rt.simRunning }" :disabled="simCompiling || rt.simRunning" title="编译（下载到仿真器）" @click="onSimCompile">
            <svg v-if="simCompiling" class="sim-ico loading" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" stroke-dasharray="40 60" stroke-linecap="round"/>
            </svg>
            <svg v-else class="sim-ico hammer" viewBox="0 0 24 24" fill="currentColor">
              <rect x="3" y="3" width="18" height="8" rx="2"/>
              <path d="M9.5 11h5v4a2.75 2.75 0 0 1-2.75 2.75 2.75 2.75 0 0 1-2.75-2.75v-.7a7 7 0 0 1 1.05-3.3" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="sim-btn" :class="{ active: rt.simRunning, disabled: !simReady }" :disabled="!simReady || rt.simRunning" title="运行仿真" @click="onSimRun">
            <svg class="sim-ico play" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="7,5 20,12 7,19" />
            </svg>
          </button>
          <button class="sim-btn" :class="{ active: simStopping, disabled: !rt.simRunning }" :disabled="!rt.simRunning" title="暂停/停止仿真" @click="onSimStop">
            <svg class="sim-ico pause" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1"/>
              <rect x="14" y="5" width="4" height="14" rx="1"/>
            </svg>
          </button>
        </div>
        <span class="spacer"></span>
        <span v-if="rt.historySource" class="t-badge hist" :title="rt.historySource">历史查看</span>
        <span class="phase" :class="'ph-' + rt.simPhase">{{ simPhaseLabel }}</span>
        <button class="btn primary" :class="{ active: rt.simRunning && rt.simMode === runMode }" :disabled="rt.simRunning" @click="onRunBtn" :title="runBtnTitle">
          {{ runBtnLabel }}
        </button>
        <button class="btn danger" :disabled="!rt.simRunning" @click="rt.stopSim()">停止</button>
        <button class="btn" :class="{ on: rt.started }" @click="rt.started ? rt.stopMock() : rt.startMock()" title="没连仿真机时用它预览布局">
          示例数据
        </button>
        <button class="btn" @click="seedLayout" title="放入五种监视组件">一键布局</button>
        <button
          class="btn"
          :disabled="!layoutItems.length"
          @click="store.resetRuntimeLayout()"
          title="清空当前标签的监视台布局"
        >
          清空布局
        </button>
        <button class="btn" :disabled="!rt.header" @click="onSaveResult" title="把本次运行结果写入「工程所在文件夹」(.runtime.json)；也可以按 Ctrl+S 保存">保存结果</button>
        <button class="btn" @click="onOpenResult" title="打开历史运行结果（列出工程文件夹内已保存的结果，或手动选择文件）">历史结果</button>
      </div>

      <div
        ref="canvasRef"
        class="grid"
        @dragover="onCanvasDragOver"
        @drop="onCanvasDrop"
        :class="{ empty: !layoutItems.length }"
      >
        <div v-if="!layoutItems.length" class="empty-tip">
          <div class="empty-dash">从左侧拖入组件，编排运行结果监视台</div>
        </div>

        <div
          v-for="(item, index) in layoutItems"
          :key="item.id"
          class="cell"
          :style="{ gridColumn: 'span ' + item.colSpan, gridRow: 'span ' + item.rowSpan }"
          draggable="true"
          @dragstart="onItemDragStart($event, index)"
          @dragover="onItemDragOver"
          @drop="onItemDrop($event, index)"
        >
          <div class="cell-head">
            <span class="cell-title">{{ item.title }}</span>
            <button class="x" @click="store.removeRuntimeItem(item.id)" title="删除">×</button>
          </div>

          <!-- 绑定区：仅可绑定的组件（comm） -->
          <div v-if="scopeOptions(runtimeComponentByKey(item.key)?.bindable ?? false).length" class="bind">
            <select class="inp" :value="item.binding.scope" @change="patchBinding(item.id, ($event.target as HTMLSelectElement).value as any)">
              <option v-for="o in scopeOptions(true)" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <select
              v-if="item.binding.scope !== 'whole'"
              class="inp"
              :value="item.binding.target"
              @change="patchBindingTarget(item.id, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in targetOptions(item.binding.scope)" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </div>

          <!-- S3：真实组件渲染（含文本备注） -->
          <div v-if="item.key === 'comm'" class="comp"><CommChart :events="itemEvents(item)" /></div>
          <div v-else-if="item.key === 'goose'" class="comp"><GooseTiming :events="itemEvents(item)" /></div>
          <div v-else-if="item.key === 'hil-sync'" class="comp"><HilSync :events="itemEvents(item)" /></div>
          <div v-else-if="item.key === 'hil-inject'" class="comp"><HilInject :events="itemEvents(item)" /></div>
          <div v-else-if="item.key === 'op'" class="comp"><OpLog :events="itemEvents(item)" /></div>
          <div v-else-if="item.key === 'sim-log'" class="comp"><SimLog :events="itemEvents(item)" /></div>
          <input v-else v-model="item.title" class="note" placeholder="输入备注文字…" />

          <div class="resize-handle" @mousedown="onResizeDown($event, item.id, runtimeComponentByKey(item.key))" title="拖动调整大小"></div>
        </div>
      </div>
    </div>

    <!-- 历史结果：列出工程文件夹内已保存的运行结果，点击载入 -->
    <el-dialog v-model="historyVisible" title="历史运行结果" width="520px" append-to-body>
      <div class="hist-dir" v-if="historyDir">工程文件夹：{{ historyDir }}</div>
      <ul class="hist-list">
        <li v-for="f in historyFiles" :key="f.name" class="hist-item" @click="pickHistory(f.name)">
          <span class="hist-name">{{ f.name }}</span>
          <span class="hist-meta">{{ formatClockStamp(f.mtime) }} · {{ (f.size / 1024).toFixed(1) }} KB</span>
        </li>
      </ul>
      <template #footer>
        <el-button @click="historyVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.runtime-page {
  display: flex;
  gap: 14px;
  height: 100%;
  min-height: 0;
  padding: 14px;
  box-sizing: border-box;
}
/* 元件库 */
.lib {
  position: relative;
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
/* 右缘拖拽手柄：调节元件库宽度 */
.lib-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -7px;
  width: 14px;
  cursor: col-resize;
  border-radius: 4px;
  z-index: 5;
}
.lib-resize-handle::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 6px;
  width: 2px;
  height: 34px;
  margin-top: -17px;
  border-radius: 2px;
  background: var(--ech-border);
}
.lib-resize-handle:hover::after,
.lib-resize-handle:active::after {
  background: var(--ech-accent);
}
.lib-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ech-fg-dim);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ech-border);
}
.lib-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  cursor: grab;
  text-align: left;
  color: var(--ech-fg);
  font-size: 13px;
}
.lib-item:hover {
  border-color: var(--ech-accent);
  background: rgba(47, 129, 247, 0.12);
}
.lib-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.kind-comm { background: #2f9e6e; }
.kind-goose { background: #e0a03a; }
.kind-hil-sync { background: #3a9bc9; }
.kind-hil-inject { background: #9a7bd8; }
.kind-op { background: #c96a6a; }
.kind-raw-log { background: #6a9fc9; }
.kind-note { background: #8a93a6; }
.lib-label { flex: 1; }
.lib-size { font-size: 11px; color: var(--ech-fg-dim); }

/* 画布 */
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 8px;
}
/* 仿真三键：编译 / 运行 / 暂停（与拓扑页顶部「仿真操作」完全同款） */
.rf-sim-actions { display: flex; align-items: center; gap: 8px; margin-right: 2px; }
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
.sim-ico.hammer { color: #58c1ff; filter: drop-shadow(0 0 3px rgba(46, 163, 255, 0.55)); }
.sim-btn:not(:disabled) .sim-ico.play { color: #3af08e; filter: drop-shadow(0 0 4px rgba(58, 240, 142, 0.5)); }
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
.sim-ico { width: 22px; height: 22px; }
.sim-ico.loading {
  animation: spin 0.8s linear infinite;
  color: #58c1ff;
  filter: drop-shadow(0 0 4px rgba(46, 163, 255, 0.5));
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.t-name { font-weight: 600; font-size: 13px; }
.t-project {
  font-size: 12px;
  font-weight: 600;
  color: #9be8ff;
  border: 1px solid rgba(64, 156, 219, 0.4);
  background: rgba(38, 96, 148, 0.28);
  border-radius: 4px;
  padding: 1px 7px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-count { font-size: 12px; color: var(--ech-fg-dim); }
.spacer { flex: 1; }
.t-timer {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--ech-fg-dim);
  padding: 1px 8px;
  border: 1px solid var(--ech-border);
  border-radius: 6px;
  transition: all 0.2s ease;
}
.t-timer.live {
  color: #3af08e;
  border-color: rgba(58, 240, 142, 0.45);
  box-shadow: 0 0 0 1px rgba(58, 240, 142, 0.12);
}
.t-timer.offline {
  color: #4dd0e1;
  border-color: rgba(77, 208, 225, 0.45);
  box-shadow: 0 0 0 1px rgba(77, 208, 225, 0.12);
}
.btn {
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  color: var(--ech-fg);
  border: 1px solid var(--ech-border);
  border-radius: 6px;
  cursor: pointer;
}
.btn:hover { border-color: var(--ech-accent); }
.btn.on { color: #2f9e6e; border-color: #2f9e6e; }
.btn:disabled { opacity: 0.4; cursor: default; }
.btn.primary { color: #7fc7ff; border-color: rgba(63, 176, 255, 0.45); }
.btn.primary:hover:not(:disabled) { border-color: #3fb0ff; background: rgba(63, 176, 255, 0.12); }
/* 正在以该模式运行：亮青绿渐变实底 + 纯白亮字 + 内外光晕——暗底上须一眼可见、明显发亮 */
.btn.primary.active {
  color: #ffffff;
  font-weight: 700;
  text-shadow: 0 0 6px rgba(235, 255, 248, 0.95);
  border-color: #7dffd0;
  background: linear-gradient(180deg, rgba(130, 255, 213, 0.8), rgba(64, 245, 186, 0.4));
  box-shadow:
    0 0 0 1px rgba(130, 255, 213, 0.85),
    0 0 14px rgba(125, 255, 208, 0.9),
    0 0 30px rgba(82, 255, 200, 0.6),
    inset 0 0 12px rgba(200, 255, 235, 0.5);
}
.btn.danger { color: #e09090; border-color: rgba(224, 96, 96, 0.4); }
.btn.danger:hover:not(:disabled) { border-color: #e06060; background: rgba(224, 96, 96, 0.12); }

.t-badge {
  font-size: 11px;
  color: #7fc7ff;
  border: 1px solid rgba(63, 176, 255, 0.35);
  border-radius: 4px;
  padding: 0 6px;
  line-height: 1.7;
}
/* 实时同步模式徽标：与模式徽标区分，用暖色（硬墙钟绿 / 尽力追赶橙）一眼可辨 */
.t-badge.sync { color: #7cf0b8; border-color: rgba(60, 214, 148, 0.4); }
.t-badge.hist { color: #ffcf8a; border-color: rgba(230, 160, 60, 0.45); }

/* 阶段徽标：颜色编码「未运行 / 进行中 / 完成 / 失败」，一眼看出当前状态 */
.phase {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 8px;
  line-height: 1.7;
  color: var(--ech-fg-dim);
  background: rgba(127, 145, 178, 0.12);
  flex: none;
}
.phase.ph-connecting,
.phase.ph-uploading,
.phase.ph-building,
.phase.ph-precheck,
.phase.ph-running { color: #3fb0ff; background: rgba(63, 176, 255, 0.15); }
.phase.ph-done { color: #2f9e6e; background: rgba(47, 158, 110, 0.16); }
.phase.ph-error { color: #e06060; background: rgba(224, 96, 96, 0.18); }

/* 运行日志：左侧元件库下方常驻，竖向长条，填满剩余高度 */
.runlog {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  padding: 6px 8px;
  overflow: hidden;
  box-sizing: border-box;
}
.rl-head { display: flex; align-items: baseline; gap: 8px; flex: none; padding-bottom: 4px; flex-wrap: wrap; }
.rl-title { font-size: 12px; font-weight: 600; color: var(--ech-fg-dim); }
.rl-meta { font-size: 11px; color: var(--ech-fg-dim); }
.rl-meta.bad { color: #e06060; }
.rl-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #566070;
  text-align: center;
  padding: 8px 4px;
  line-height: 1.6;
}
.rl-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: #8a93a6;
  word-break: break-all;
}
.rl-list li { white-space: pre-wrap; display: flex; gap: 6px; }
/* 时间列：定宽 + 等宽数字 + 不换行。不定宽的话正文左边缘会参差不齐，竖着扫阶段行时反而更难比对
   —— 而这正是加时间列要解决的问题。宽度按 `HH:MM:SS`（8 字符）留足，长于它的取值不会出现。 */
.rl-t {
  flex: none;
  min-width: 60px;
  white-space: nowrap;
  color: #566070;
  font-variant-numeric: tabular-nums;
}
.rl-x { flex: 1; min-width: 0; }

.grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-auto-rows: minmax(96px, auto);
  grid-auto-flow: dense;
  gap: 10px;
  padding: 12px;
  box-sizing: border-box;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
}
.grid.empty { display: block; }
.empty-tip {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
}
.empty-dash {
  color: var(--ech-fg-dim);
  font-size: 13px;
  padding: 24px 36px;
  border: 1px dashed var(--ech-border);
  border-radius: 10px;
}

.cell {
  position: relative;
  display: flex;
  flex-direction: column;
  background: rgba(127, 145, 178, 0.06);
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  padding: 8px;
  box-sizing: border-box;
  min-height: 60px;
  cursor: move;
}
.cell:hover { border-color: var(--ech-accent); }
.cell-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cell-title {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.x {
  border: none;
  background: transparent;
  color: var(--ech-fg-dim);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.x:hover { color: #e06060; }

.bind {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.inp {
  min-width: 0;
  flex: 1;
  background: rgba(0, 0, 0, 0.18);
  color: var(--ech-fg);
  border: 1px solid var(--ech-border);
  border-radius: 5px;
  padding: 3px 6px;
  font-size: 12px;
}
.inp option { color: #123; }

.note {
  margin-top: 8px;
  flex: 1;
  background: transparent;
  border: 1px dashed transparent;
  color: var(--ech-fg);
  font-size: 13px;
  padding: 4px;
  resize: none;
}
.note:hover, .note:focus { border-color: var(--ech-border); outline: none; }

.comp {
  margin-top: 8px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
}
.resize-handle::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--ech-fg-dim);
  border-bottom: 2px solid var(--ech-fg-dim);
}
</style>
<style>
/* 历史结果列表（el-dialog 经 append-to-body 挂到 body，scoped 不生效，故用全局块） */
.hist-dir {
  font-size: 12px;
  color: var(--ech-fg-dim, #8b97a7);
  word-break: break-all;
  margin-bottom: 8px;
}
.hist-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 360px;
  overflow: auto;
}
.hist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.hist-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.hist-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  color: var(--ech-fg, #e6edf3);
  word-break: break-all;
}
.hist-meta {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ech-fg-dim, #8b97a7);
}
</style>
