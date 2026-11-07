// 多工程会话（顶部标签）：切换/打开/关闭/隔离 的 store 层行为。
// 背景：`project/undoStack/redoStack/dirty/seq` 是「活动会话」的镜像，各标签彼此隔离，
// 关闭到只剩一个标签自动补 Untitled。这里锁住镜像搬移正确性，避免切换时状态串号/串历史。
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkbench } from '@/stores/workbench';

function addNode(store: ReturnType<typeof useWorkbench>, kind = 'switch' as const) {
  const id = store.nextNodeId();
  store.addNode({ id, name: store.nextNodeName(kind), kind });
  return id;
}

describe('workbench store：多工程会话', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('默认启动即有一条 Untitled 活动会话', () => {
    const store = useWorkbench();
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].title).toBe('Untitled');
    expect(store.activeId).toBe(store.sessions[0].id);
    expect(store.project.projectName).toBe('Untitled');
  });

  it('openNewUntitled：开出新标签并激活，内容独立互不影响', () => {
    const store = useWorkbench();
    const a = addNode(store);
    store.openNewUntitled();
    expect(store.activeId).not.toBe(store.sessions[0].id);
    expect(store.sessions).toHaveLength(2);
    expect(store.project.nodes).toHaveLength(0); // 新标签是空的
    addNode(store);
    // 切回第一个标签：它的内容还在
    store.switchSession(store.sessions[0].id);
    expect(store.project.nodes).toHaveLength(1);
    expect(store.project.nodes[0].id).toBe(a);
  });

  it('标签间撤销/重做与脏标记彼此隔离', () => {
    const store = useWorkbench();
    addNode(store);
    addNode(store);
    store.openNewUntitled();
    addNode(store);
    expect(store.canUndo).toBe(true);
    store.undo(); // 只回退当前标签
    expect(store.project.nodes).toHaveLength(0);
    // 切到第一个标签：它仍有两个节点，历史也在
    store.switchSession(store.sessions[0].id);
    expect(store.project.nodes).toHaveLength(2);
    expect(store.canUndo).toBe(true);
    expect(store.dirty).toBe(true);
  });

  it('openInTab：caseKey 命中已打开标签则去重并刷新内容', () => {
    const store = useWorkbench();
    const a = addNode(store);
    store.openInTab('案例A', { ...store.project, nodes: [] }, 'caseA');
    expect(store.sessions).toHaveLength(2);
    expect(store.project.nodes).toHaveLength(0);
    // 再次打开同 caseKey → 切到已有标签，不再新增
    const id = store.openInTab('案例A', { ...store.project, nodes: [] }, 'caseA');
    expect(store.sessions).toHaveLength(2);
    expect(store.activeId).toBe(id);
    // 第一个标签内容不受影响
    store.switchSession(store.sessions[0].id);
    expect(store.project.nodes).toHaveLength(1);
    expect(store.project.nodes[0].id).toBe(a);
  });

  it('closeSession：关闭活动标签切到相邻，关光补一条 Untitled', () => {
    const store = useWorkbench();
    const boot = store.activeId;
    store.openNewUntitled();
    const second = store.activeId;
    store.closeSession(second);
    expect(store.sessions).toHaveLength(1);
    expect(store.activeId).toBe(boot);
    store.closeSession(boot);
    // 关光后自动补一条 Untitled
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].title).toBe('Untitled');
    expect(store.activeId).toBe(store.sessions[0].id);
  });

  it('loadProject/newProject 作用在当前活动标签，且切走不丢', () => {
    const store = useWorkbench();
    addNode(store);
    store.openNewUntitled();
    store.loadProject({ ...store.project, projectName: 'fromFile' } as ReturnType<typeof useWorkbench>['project']);
    expect(store.project.projectName).toBe('fromFile');
    store.switchSession(store.sessions[0].id);
    expect(store.project.nodes).toHaveLength(1);
    store.switchSession(store.sessions[1].id);
    expect(store.project.projectName).toBe('fromFile');
  });
});