// 回归防线：拓扑页组合/解组的 store 层行为。
//
// 背景：分组是持久关系（落盘、撤销、拖动联动都依赖它），边界行为集中在
// workbench store 的 groupNodes / ungroupNodes / removeNode 级联里。
// 这里锁住：建组条件、一节点一组、解组、删成员级联、撤销恢复、落盘往返。
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkbench } from '@/stores/workbench';
import { serializeProject, parseProject } from '@core/projectFile';
import type { NodeKind } from '@core/types';

function addTwoNodes(store: ReturnType<typeof useWorkbench>, kinds: NodeKind[] = ['switch', 'router']) {
  const ids = kinds.map((kind) => {
    const id = store.nextNodeId();
    store.addNode({ id, name: store.nextNodeName(kind), kind });
    return id;
  });
  return ids;
}

describe('workbench store：组合/解组', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('groupNodes：两个节点建组，返回组 id；单个节点不建组', () => {
    const store = useWorkbench();
    const [a, b] = addTwoNodes(store);
    const gid = store.groupNodes([a, b]);
    expect(gid).toBe('g1');
    expect(store.project.groups).toEqual([{ id: 'g1', members: [a, b] }]);

    const [c] = addTwoNodes(store, ['host']);
    expect(store.groupNodes([c])).toBeNull();
    expect(store.project.groups).toHaveLength(1);
  });

  it('一节点只属一组：重新组合会从旧组让位，旧组不足 2 人自动散', () => {
    const store = useWorkbench();
    const [a, b, c] = addTwoNodes(store, ['switch', 'router', 'host']);
    store.groupNodes([a, b]);
    const g2 = store.groupNodes([b, c]);
    expect(g2).toBe('g2');
    // g1 只剩 a（1 人）应被散掉，g2 = [b, c]
    expect(store.project.groups).toEqual([{ id: 'g2', members: [b, c] }]);
  });

  it('ungroupNodes：散掉包含任一给定成员的组', () => {
    const store = useWorkbench();
    const [a, b, c] = addTwoNodes(store, ['switch', 'router', 'host']);
    store.groupNodes([a, b]);
    store.groupNodes([c, ...addTwoNodes(store, ['ied', 'rtu']).slice(0, 1)]);
    const before = store.project.groups.length;
    store.ungroupNodes([a]);
    expect(store.project.groups.length).toBe(before - 1);
    expect(store.project.groups.some((g) => g.members.includes(a))).toBe(false);
  });

  it('removeNode 级联：删成员先出组，剩不足 2 人散组', () => {
    const store = useWorkbench();
    const [a, b] = addTwoNodes(store);
    store.groupNodes([a, b]);
    store.removeNode(a);
    expect(store.project.groups).toEqual([]);
    // 存活的 b 还在，工程不受伤
    expect(store.nodeMap.has(b)).toBe(true);
  });

  it('撤销组合 → 组散；重做 → 组回（快照往返）', () => {
    const store = useWorkbench();
    const [a, b] = addTwoNodes(store);
    const gid = store.groupNodes([a, b])!;
    store.undo();
    expect(store.project.groups ?? []).toEqual([]);
    store.redo();
    expect(store.project.groups).toEqual([{ id: gid, members: [a, b] }]);
  });

  it('组合置 dirty；建组 id 不与节点/链路冲突', () => {
    const store = useWorkbench();
    const [a, b] = addTwoNodes(store);
    store.markClean();
    store.groupNodes([a, b]);
    expect(store.dirty).toBe(true);
    const gid = store.project.groups![0].id;
    expect(gid).not.toBe(a);
    expect(gid).not.toBe(b);
  });

  it('落盘往返：serialize → parse 保留分组，坏条目（成员不足/引用不存在）被剔除', () => {
    const store = useWorkbench();
    const [a, b] = addTwoNodes(store);
    store.groupNodes([a, b]);
    const text = serializeProject(store.project);
    const parsed = parseProject(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.project.groups).toEqual([{ id: 'g1', members: [a, b] }]);

    // 手工构造坏分组：引用不存在的节点、单成员 → 全部丢弃
    const bad = JSON.parse(text);
    bad.groups = [
      { id: 'g9', members: [a, 'ghost'] },
      { id: 'g10', members: [b] },
    ];
    const parsed2 = parseProject(JSON.stringify(bad));
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) {
      // g9 的 ghost 成员被剔除后只剩 1 人、g10 只有 1 人 → 都不落
      expect(parsed2.project.groups ?? []).toEqual([]);
    }
  });
});
