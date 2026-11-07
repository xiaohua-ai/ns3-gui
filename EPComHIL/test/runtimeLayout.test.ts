// 运行监视台布局回归防线：元件库元数据 / 布局纯函数 / 会话隔离。
// 背景：S2 让 RuntimeView 从元件库拖组件进 Grid 画布，布局独立于工程、随工作台标签隔离。
// DOM 拖拽交互不写单测，这里锁住可测的纯函数与 store 层会话隔离。
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  RUNTIME_COMPONENTS,
  runtimeComponentByKey,
  makeLayoutItem,
  moveLayoutItem,
  bindingOptions,
  BINDING_WHOLE,
  type RuntimeLayoutItem,
} from '@core/runtimeModel';
import { useWorkbench } from '@/stores/workbench';

function mk(id: string): RuntimeLayoutItem {
  return { id, key: 'comm', title: id, binding: BINDING_WHOLE, colSpan: 1, rowSpan: 1 };
}

describe('runtimeModel：元件库元数据', () => {
  it('库含 7 类组件，comm 可绑定且整页可寻', () => {
    expect(RUNTIME_COMPONENTS).toHaveLength(7);
    const comm = runtimeComponentByKey('comm');
    expect(comm?.bindable).toBe(true);
    expect(runtimeComponentByKey('note')?.kind).toBe('note');
    expect(runtimeComponentByKey('sim-log')?.kind).toBe('raw-log');
    expect(runtimeComponentByKey('不存在')).toBeUndefined();
  });

  it('makeLayoutItem 用 meta 造默认实例（whole + 最小占格）', () => {
    const it = makeLayoutItem(runtimeComponentByKey('comm')!, 'rt1');
    expect(it).toEqual({ key: 'comm', id: 'rt1', title: '通信指标', binding: { scope: 'whole' }, colSpan: 3, rowSpan: 3 });
  });
});

describe('runtimeModel：布局纯函数', () => {
  it('moveLayoutItem 前移/后移', () => {
    const items = [mk('a'), mk('b'), mk('c')];
    expect(moveLayoutItem(items, 2, 0).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(moveLayoutItem(items, 0, 3).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('moveLayoutItem 同址或越界原样返回原数组', () => {
    const items = [mk('a'), mk('b')];
    expect(moveLayoutItem(items, 1, 1)).toBe(items);
    expect(moveLayoutItem(items, -1, 1)).toBe(items);
    expect(moveLayoutItem(items, 0, 5)).toBe(items);
  });

  it('bindingOptions 折叠节点/链路/业务演进名称，缺名回落 id', () => {
    const p = {
      nodes: [{ id: 'n1', name: 'IED 主站' }, { id: 'n2' }],
      links: [{ id: 'l1', name: '   ' }],
      flows: [{ id: 'f1', name: '遥测流' }],
    };
    expect(bindingOptions(p)).toEqual({
      nodes: [{ id: 'n1', label: 'IED 主站' }, { id: 'n2', label: 'n2' }],
      links: [{ id: 'l1', label: 'l1' }],
      flows: [{ id: 'f1', label: '遥测流' }],
    });
  });
});

describe('workbench：布局动作与会话隔离', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('addRuntimeItem 追加且 id/尺寸正确', () => {
    const s = useWorkbench();
    const a = s.addRuntimeItem(runtimeComponentByKey('comm')!);
    const b = s.addRuntimeItem(runtimeComponentByKey('op')!);
    expect(s.currentSession.runtime.items).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    expect(a.colSpan).toBe(3);
    expect(b.colSpan).toBe(3);
  });

  it('update / remove / reset 生效', () => {
    const s = useWorkbench();
    const a = s.addRuntimeItem(runtimeComponentByKey('comm')!);
    s.updateRuntimeItem(a.id, { colSpan: 4, binding: { scope: 'node', target: 'n1' } });
    expect(s.currentSession.runtime.items[0].colSpan).toBe(4);
    s.removeRuntimeItem(a.id);
    expect(s.currentSession.runtime.items).toHaveLength(0);
    s.addRuntimeItem(runtimeComponentByKey('goose')!);
    s.resetRuntimeLayout();
    expect(s.currentSession.runtime.items).toHaveLength(0);
  });

  it('多标签各自持有独立布局，切换互不影响', () => {
    const s = useWorkbench();
    const idA = s.currentSession.id;
    s.addRuntimeItem(runtimeComponentByKey('comm')!); // → rt1
    const idB = s.openNewUntitled();
    expect(idB).not.toBe(idA);
    expect(s.currentSession.runtime.items).toHaveLength(0); // 新会话没有上一个的布局
    s.addRuntimeItem(runtimeComponentByKey('op')!); // 新会话也自 rt1 起
    s.switchSession(idA);
    expect(s.currentSession.runtime.items.map((i) => i.id)).toEqual(['rt1']);
    s.switchSession(idB);
    expect(s.currentSession.runtime.items.map((i) => i.id)).toEqual(['rt1']);
    expect(s.currentSession.runtime.items[0].key).toBe('op');
  });
});