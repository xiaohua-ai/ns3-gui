// W3 工作台状态：维护当前工程 ProjectConfig，UI 各视图共享且与生成器数据模型同源
import { defineStore } from 'pinia';
import type { ProjectConfig, NodeConfig, NodeKind, LinkConfig, ProtocolConfig, FlowConfig, FaultConfig, HalfPhysicalConfig, HilConfig, NodeGroupConfig, DecorConfig, RunConfig, SimMode, ClockSource, SyncMode } from '@core/types';
import { DEFAULT_RUN } from '@core/types';
import type { RuntimeComponentMeta, RuntimeLayout, RuntimeLayoutItem } from '@core/runtimeModel';
import { makeLayoutItem } from '@core/runtimeModel';
import { serializeProject } from '@core/projectFile';
import { KIND_LABEL } from '@/constants/nodeMeta';

// 撤销/重做的批量合并计数（模块级非响应式即可——只影响 pushHistory 是否入栈）
// 用途：一次用户动作触发的多条 mutation（组拖回写 N 个节点、一次删除 N 个节点、粘贴一批）
// 只在动作开始时记一个快照，undo 一步回到动作前，而不是逐个节点退。
let historyBatchDepth = 0;
const UNDO_LIMIT = 100;

function blankProject(name: string): ProjectConfig {
  return {
    projectName: name,
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    nodes: [],
    links: [],
    protocols: [],
    flows: [],
    faults: [],
    // HIL 段只剩引擎参数（模式/时钟源归运行设置，见 types.ts 的 RunConfig）
    hil: { timestepUs: 100 },
    halfPhysical: { taps: [], physicalNic: '' },
    // 运行设置随工程走：新工程取出厂默认。**不写 `as ProjectConfig`** ——
    // 让编译器实实在在盯着"每个构造工程的地方都给了 run"，这是统一来源的保证。
    run: { ...DEFAULT_RUN },
    groups: [],
    decors: [],
  };
}

// 多工程会话：顶部每个标签对应一条会话，各自持有独立的工程、撤销历史、脏标记、发号器。
export interface WorkbenchSession {
  id: string;
  title: string;
  /** 绑定到的用户案例名（Ctrl+S 静默更新用） */
  caseKey?: string;
  project: ProjectConfig;
  /** 运行监视台布局：独立于工程、随会话隔离（不进 .tc 工程语义） */
  runtime: RuntimeLayout;
  undoStack: string[];
  redoStack: string[];
  dirty: boolean;
  seq: Record<string, number>;
}

let sessionSeq = 0;
function makeSession(title: string, project?: ProjectConfig): WorkbenchSession {
  sessionSeq += 1;
  const prj = project ?? blankProject(title);
  return {
    id: `s${sessionSeq}`,
    title,
    project: prj,
    runtime: { items: [] },
    undoStack: [],
    redoStack: [],
    dirty: false,
    seq: { l: 1, p: 1, f: 1, g: 1, d: 1 },
  };
}

export const useWorkbench = defineStore('workbench', {
  state: () => {
    // 启动即备好一条「Untitled」会话：多工程标签工作台默认至少一个空白工程标签
    const boot = makeSession('Untitled');
    return {
      /** 打开的工程会话（标签），至少一条 */
      sessions: [boot] as WorkbenchSession[],
      /** 当前活动会话 id：project/seq/undoStack/redoStack/dirty 都是它的镜像 */
      activeId: boot.id,
      // ---- 活动会话镜像：以下字段始终与 activeId 所指会话保持一致 ----
      project: boot.project,
      /**
       * 带前缀实体的发号计数器，按前缀各自独立递增（链路 l / 协议 p / 业务流 f）。
       * 共用一个计数器会让序号串号（建完协议再建链路 → 第一个链路叫 l3），
       * 所以这里分桶计数；拓扑页与配置页共用同一份，避免各页自增导致撞号。
       */
      seq: boot.seq,
      // 运行设置**刻意不在这里**：它已归入 project.run（随工程保存与切换），是模式的唯一来源。
      // 曾有第二份 store 级 run 与之并存，靠"导出/运行前覆盖同步"维持一致 —— 两个副本加一条
      // 同步约定，迟早漂移。读写一律走 this.project.run 或 setRun()。
      // ---- 撤销/重做（store 级 project 快照栈）----
      // 为什么不用 @antv/x6-plugin-history：它只跟踪 X6 cell 变更，而本项目删除走 store.removeNode
      // （Pinia 是唯一事实源，X6 只是渲染镜像），插件根本看不到。快照用落盘同款序列化，恢复即整文档回滚。
      undoStack: boot.undoStack,
      redoStack: boot.redoStack,
      /** 自上次保存/载入后有改动（保存、退出拦截用） */
      dirty: boot.dirty,
      /** 内部剪贴板（剪切/复制/粘贴）；跨工程粘贴不做——粘贴时一律重发号 id */
      clipboard: null as { nodes: NodeConfig[]; links: LinkConfig[] } | null,
    };
  },
  getters: {
    nodeMap: (s) => new Map(s.project.nodes.map((n) => [n.id, n])),
    canUndo: (s) => s.undoStack.length > 0,
    canRedo: (s) => s.redoStack.length > 0,
    /** 当前活动会话（标签） */
    currentSession: (s) => s.sessions.find((x) => x.id === s.activeId) ?? s.sessions[0],
    /** 画布装饰对象索引：id → TextDecorConfig | LineDecorConfig */
    decorMap: (s) => new Map((s.project.decors ?? []).map((d) => [d.id, d])),
    /** 工程内所有已占用 id（节点/链路/协议/业务流/故障/分组/装饰） */
    usedIds: (s) =>
      new Set<string>([
        ...s.project.nodes.map((x) => x.id),
        ...s.project.links.map((x) => x.id),
        ...s.project.protocols.map((x) => x.id),
        ...s.project.flows.map((x) => x.id),
        ...s.project.faults.map((x) => x.id),
        ...(s.project.groups ?? []).map((x) => x.id),
        ...(s.project.decors ?? []).map((x) => x.id),
      ]),
  },
  actions: {
    // ---- 撤销/重做基座 ----
    /** 快照入栈（pushHistory 与 batch 共用的核心，不改 batch 状态） */
    _snapshot() {
      this.undoStack.push(serializeProject(this.project));
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
    },
    /** 变更前记快照（落盘同款序列化）；批量动作中不重复入栈。setProjectName 不记——逐键快照太碎 */
    pushHistory() {
      if (historyBatchDepth > 0) return;
      this._snapshot();
    },
    /** 批量动作：开始时压一次快照作回滚点，fn 内所有 pushHistory 跳过（嵌套 batch 不重复压） */
    batch<T>(fn: () => T): T {
      if (historyBatchDepth === 0) {
        historyBatchDepth += 1;
        try {
          this._snapshot();
        } finally {
          historyBatchDepth -= 1;
        }
      }
      historyBatchDepth += 1;
      try {
        return fn();
      } finally {
        historyBatchDepth -= 1;
      }
    },
    undo(): boolean {
      if (!this.undoStack.length) return false;
      this.redoStack.push(serializeProject(this.project));
      this.project = JSON.parse(this.undoStack.pop()!);
      return true;
    },
    redo(): boolean {
      if (!this.redoStack.length) return false;
      this.undoStack.push(serializeProject(this.project));
      this.project = JSON.parse(this.redoStack.pop()!);
      return true;
    },
    markClean() {
      this.dirty = false;
    },

    // ---- 多工程会话（顶部标签页）----
    /** 把活动镜像（project/历史/脏标记/发号器）写回所在会话。切换/关闭前必须调用，会话才持有真实状态 */
    _writeBack() {
      const s = this.sessions.find((x) => x.id === this.activeId);
      if (!s) return;
      s.project = this.project;
      s.undoStack = this.undoStack;
      s.redoStack = this.redoStack;
      s.dirty = this.dirty;
      s.seq = this.seq;
    },
    /** 从指定会话加载活动镜像并激活它 */
    _loadFrom(s: WorkbenchSession) {
      this.activeId = s.id;
      this.project = s.project;
      this.undoStack = s.undoStack;
      this.redoStack = s.redoStack;
      this.dirty = s.dirty;
      this.seq = s.seq;
    },
    /** 切换到指定标签（不做脏防护——确认由视图负责） */
    switchSession(id: string) {
      if (id === this.activeId) return;
      const target = this.sessions.find((x) => x.id === id);
      if (!target) return;
      this._writeBack();
      this._loadFrom(target);
    },
    /**
     * 在专用标签打开工程。caseKey 命中已打开标签时切到该标签并刷新其内容（去重）；
     * 否则新开标签并激活。project 缺省即空白。返回会话 id。
     */
    openInTab(title: string, project?: ProjectConfig, caseKey?: string): string {
      this._writeBack();
      if (caseKey) {
        const hit = this.sessions.find((x) => x.caseKey === caseKey);
        if (hit) {
          if (project) {
            hit.project = JSON.parse(JSON.stringify(project)) as ProjectConfig;
            hit.seq = { l: 1, p: 1, f: 1, g: 1 };
            hit.undoStack = [];
            hit.redoStack = [];
            hit.dirty = false;
          }
          hit.title = title;
          this._loadFrom(hit);
          return hit.id;
        }
      }
      const s = makeSession(title, project);
      s.caseKey = caseKey;
      this.sessions.push(s);
      this._loadFrom(s);
      return s.id;
    },
    /** 新建一个空白「Untitled」标签并激活 */
    openNewUntitled(): string {
      return this.openInTab('Untitled');
    },
    /**
     * 关闭标签。至少保留一条会话（关光会补一条 Untitled）；关闭活动标签后切到相邻标签。
     * 脏确认由视图负责。
     */
    closeSession(id: string) {
      const idx = this.sessions.findIndex((x) => x.id === id);
      if (idx < 0) return;
      this._writeBack();
      this.sessions.splice(idx, 1);
      if (!this.sessions.length) {
        const s = makeSession('Untitled');
        this.sessions.push(s);
        this._loadFrom(s);
        return;
      }
      if (this.activeId === id) {
        this._loadFrom(this.sessions[Math.min(idx, this.sessions.length - 1)]);
      }
    },
    /** 给活动会话绑定/解绑用户案例名（Ctrl+S 静默更新用） */
    setActiveCaseKey(key?: string) {
      const s = this.sessions.find((x) => x.id === this.activeId);
      if (s) s.caseKey = key;
    },

    /** 发一个带前缀的工程内唯一 id（链路 l1 / 协议 p1 / 业务流 f1）；同前缀内独立递增 */
    nextId(prefix: string): string {
      let n = this.seq[prefix] ?? 1;
      let id = '';
      do {
        id = `${prefix}${n++}`;
      } while (this.usedIds.has(id));
      this.seq[prefix] = n;
      return id;
    },
    /**
     * 节点 id：纯数字短号（1、2、3…），取当前未被占用的最小正整数。
     * 不用递增计数器，是为了删掉 3 号后新建能补回 3，id 始终紧凑。
     * 生成侧 nodeVar 会拼成 n_1 / n_2，仍是合法 C++ 标识符。
     */
    nextNodeId(): string {
      let n = 1;
      while (this.usedIds.has(String(n))) n += 1;
      return String(n);
    },
    /** 一次领取 k 个互不冲突的节点 id。nextNodeId 是无状态现算，连续调用（粘贴多副本、
     *  新节点尚未 push 时）会返回同一个 id 导致 X6 同 id add 失败 —— 批量场景必须用这个 */
    takeNodeIds(k: number): string[] {
      const used = new Set([
        ...this.project.nodes.map((x) => String(x.id)),
        ...this.project.links.map((x) => x.id),
      ]);
      const out: string[] = [];
      for (let i = 0; i < k; i += 1) {
        let n = 1;
        while (used.has(String(n))) n += 1;
        used.add(String(n));
        out.push(String(n));
      }
      return out;
    },
    /** 节点默认名：类型_序号（IED_1、交换机_2），序号在同类型节点内独立递增，不与其他类型串号 */
    nextNodeName(kind: NodeKind): string {
      const label = KIND_LABEL[kind] ?? kind;
      const re = new RegExp(`^${label}_(\\d+)$`);
      let max = 0;
      for (const n of this.project.nodes) {
        const m = re.exec(n.name ?? '');
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `${label}_${max + 1}`;
    },
    setProjectName(name: string) {
      this.project.projectName = name;
    },
    /**
     * 载入工程到「当前活动标签」（来自文件 / 示例工况）：整体替换活动会话内容。
     * `nextNodeId` 是无状态的（按 usedIds 现算），不必重置；
     * `nextId` 是分桶计数，必须归零，否则载入新工程后新建的链路会从上一工程的序号接着排。
     * 要在新标签打开请用 openInTab / openNewUntitled。
     */
    loadProject(cfg: ProjectConfig) {
      this.project = cfg;
      this.seq = { l: 1, p: 1, f: 1, g: 1, d: 1 };
      // 换了文档上下文，撤销历史作废（与桌面软件习惯一致）
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this._writeBack(); // 同步活动会话的项目引用，避免切走后丢内容
    },
    /** 在当前活动标签内新建空白工程（与桌面软件「新建」覆盖当前文档一致）；开新标签用 openNewUntitled */
    newProject(name = 'untitled') {
      this.project = blankProject(name);
      this.seq = { l: 1, p: 1, f: 1, g: 1, d: 1 };
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this._writeBack();
    },
    // ---- 节点 ----
    addNode(n: NodeConfig) {
      this.pushHistory();
      this.project.nodes.push(n);
    },
    updateNode(id: string, patch: Partial<NodeConfig>) {
      this.pushHistory();
      const n = this.project.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    },
    removeNode(id: string) {
      this.pushHistory();
      this.project.nodes = this.project.nodes.filter((n) => n.id !== id);
      this.project.links = this.project.links.filter((l) => l.nodeA !== id && l.nodeB !== id);
      this.project.protocols = this.project.protocols.filter((p) => p.nodeId !== id);
      this.project.flows = this.project.flows.filter((f) => f.src !== id && f.dst !== id);
      // 故障与半实物映射：清掉指向该节点的引用；两个目标都失效的故障条目直接移除
      this.project.faults = this.project.faults
        .map((f) => (f.nodeId === id ? { ...f, nodeId: undefined } : f))
        .filter((f) => Boolean(f.linkId || f.nodeId));
      if (this.project.halfPhysical) {
        this.project.halfPhysical.taps = this.project.halfPhysical.taps.filter((t) => t.nodeId !== id);
      }
      // 分组级联：成员被删则从组里剔除，剩不足 2 个的组直接散掉
      if (this.project.groups?.length) {
        this.project.groups = this.project.groups
          .map((g) => ({ ...g, members: g.members.filter((m) => m !== id) }))
          .filter((g) => g.members.length >= 2);
      }
    },
    // ---- 画布装饰对象（文本 / 细线）----
    /** 增设装饰对象；id 由调用方用 nextId('d') 生成 */
    addDecor(d: DecorConfig) {
      this.pushHistory();
      (this.project.decors ??= []).push(d);
    },
    /** 按 id 更新装饰对象（文本字号/文字、线条端点/粗细/虚实等） */
    updateDecor(id: string, patch: Partial<DecorConfig>) {
      this.pushHistory();
      const d = (this.project.decors ?? []).find((x) => x.id === id);
      if (d) Object.assign(d, patch);
    },
    /** 删除装饰对象 */
    removeDecor(id: string) {
      this.pushHistory();
      this.project.decors = (this.project.decors ?? []).filter((x) => x.id !== id);
    },
    // ---- 分组（组合/解组）----
    /** 组合：把成员合成一个新组（成员去重；一人一组的关系不做——一个节点只进最新的组，先进出的让位） */
    groupNodes(members: string[]): string | null {
      const ids = [...new Set(members)].filter((m) => this.nodeMap.has(m));
      if (ids.length < 2) return null;
      this.pushHistory();
      // 同节点已在别的组里：从旧组移除（旧组不足 2 人则散），保证「一个节点最多属于一个组」
      this.pruneGroups((g) => g.members.some((m) => ids.includes(m)), (g) => g.members.filter((m) => !ids.includes(m)));
      if (!this.project.groups) this.project.groups = [];
      const id = this.nextId('g');
      this.project.groups?.push({ id, members: ids });
      return id;
    },
    /** 解组：散掉所有「含任一给定成员」的组 */
    ungroupNodes(memberIds: string[]) {
      if (!this.project.groups?.length) return;
      this.pushHistory();
      this.pruneGroups((g) => g.members.some((m) => memberIds.includes(m)));
    },
    /** 组清理工具：hit 判定命中的组按 fix 修正后保留（fix 缺省 = 整组移除），不负责快照/脏标记 */
    pruneGroups(hit: (g: NodeGroupConfig) => boolean, fix?: (g: NodeGroupConfig) => string[]) {
      if (!this.project.groups?.length) return;
      const kept: NodeGroupConfig[] = [];
      for (const g of this.project.groups) {
        if (!hit(g)) {
          kept.push(g);
          continue;
        }
        if (fix) {
          const members = fix(g);
          if (members.length >= 2) kept.push({ ...g, members });
        }
      }
      this.project.groups = kept;
    },
    // ---- 链路 ----
    addLink(l: LinkConfig) {
      this.pushHistory();
      this.project.links.push(l);
    },
    updateLink(id: string, patch: Partial<LinkConfig>) {
      this.pushHistory();
      const l = this.project.links.find((x) => x.id === id);
      if (l) Object.assign(l, patch);
    },
    removeLink(id: string) {
      this.pushHistory();
      this.project.links = this.project.links.filter((l) => l.id !== id);
      this.project.faults = this.project.faults
        .map((f) => (f.linkId === id ? { ...f, linkId: undefined } : f))
        .filter((f) => Boolean(f.linkId || f.nodeId));
    },
    // ---- 协议 / 业务流 / 故障 ----
    addProtocol(p: ProtocolConfig) {
      this.pushHistory();
      this.project.protocols.push(p);
    },
    removeProtocol(id: string) {
      this.pushHistory();
      this.project.protocols = this.project.protocols.filter((p) => p.id !== id);
      // 业务流的协议引用随之失效，清掉引用位（避免遗留悬空 protocolRef）
      this.project.flows = this.project.flows.map((f) => (f.protocolRef === id ? { ...f, protocolRef: undefined } : f));
    },
    addFlow(f: FlowConfig) {
      this.pushHistory();
      this.project.flows.push(f);
    },
    removeFlow(id: string) {
      this.pushHistory();
      this.project.flows = this.project.flows.filter((f) => f.id !== id);
    },
    addFault(f: FaultConfig) {
      this.pushHistory();
      this.project.faults.push(f);
    },
    removeFault(id: string) {
      this.pushHistory();
      this.project.faults = this.project.faults.filter((f) => f.id !== id);
    },
    // ---- 半实物 / HIL ----
    setHalfPhysical(h: HalfPhysicalConfig) {
      this.pushHistory();
      this.project.halfPhysical = h;
    },
    setHil(h: HilConfig) {
      this.pushHistory();
      this.project.hil = h;
    },
    // ---- 运行设置：**唯一的写入点**（拓扑页设置面板、运行监视台的运行按钮都走它） ----
    /**
     * 改运行设置（含模式）。改的是 `project.run` —— 随工程保存、随工程切换。
     *
     * 为什么**不进撤销栈**：撤销栈记录的是"工程结构怎么变"；把"把时长从 10s 改成 20s"
     * 也记进去，Ctrl+Z 就会在拓扑与设置之间来回跳，反而没人敢用。
     */
    setRun(patch: Partial<RunConfig>) {
      this.project.run = { ...this.project.run, ...patch };
    },
    // ---- 运行监视台布局：会话隔离、独立于工程；属运行时偏好，不进工程撤销栈 ----
    /** 从组件元数据追加一个组件并返回它；id 基于现有 items 独立发号（不依赖会被重置的 seq） */
    addRuntimeItem(meta: RuntimeComponentMeta): RuntimeLayoutItem {
      const s = this.currentSession;
      const used = new Set(s.runtime.items.map((x) => x.id));
      let n = 1;
      let id = `rt${n}`;
      while (used.has(id)) id = `rt${++n}`;
      const item = makeLayoutItem(meta, id);
      s.runtime.items.push(item);
      return item;
    },
    updateRuntimeItem(id: string, patch: Partial<RuntimeLayoutItem>) {
      const it = this.currentSession.runtime.items.find((x) => x.id === id);
      if (it) Object.assign(it, patch);
    },
    removeRuntimeItem(id: string) {
      const s = this.currentSession;
      s.runtime.items = s.runtime.items.filter((x) => x.id !== id);
    },
    /** 整体替换（画布内拖拽重排：先 moveLayoutItem 纯函数再存回） */
    setRuntimeItems(items: RuntimeLayoutItem[]) {
      this.currentSession.runtime.items = items;
    },
    resetRuntimeLayout() {
      this.currentSession.runtime = { items: [] };
    },
  },
});
