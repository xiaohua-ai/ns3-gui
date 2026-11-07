// 回归防线：拓扑页拖拽落点的 id 稳定性。
//
// 背景：@antv/x6-plugin-dnd 的默认实现是
//   getDragNode: (sourceNode) => sourceNode.clone()
//   getDropNode: (draggingNode) => draggingNode.clone()
// 而 X6 的 Cell.clone() 在不传 keepId 时会 delete data.id 并重新生成 uuid
// （node_modules/@antv/x6/src/model/cell.ts:1383）。
// 于是拓扑页 startLibDrag 里预置的短号（1、2、3…）会在拖拽途中被顶掉，
// 落到 store 里变成 c608690c-a466-… 这种串，生成侧再拼成非法 C++ 变量名。
// 这里锁住"必须 keepId"这个契约。
import { describe, it, expect } from 'vitest';
import { Node } from '@antv/x6';

function makeSourceNode() {
  return Node.create({
    id: '7',
    x: 0,
    y: 0,
    width: 88,
    height: 46,
    data: { kind: 'ied', name: 'IED_1' },
    attrs: { label: { text: 'IED_1' } },
  });
}

describe('X6 clone / Dnd 落点契约', () => {
  it('裸 clone() 会重新生成 uuid —— 拖拽落点丢号就是这么来的', () => {
    const dropped = makeSourceNode().clone();
    expect(dropped.id).not.toBe('7');
    expect(dropped.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('clone({ keepId: true }) 连续两次仍保留 id，data 与 attrs.label.text 一并带过', () => {
    // Dnd 实际上会 clone 两次：getDragNode 一次、getDropNode 再一次
    const kept = makeSourceNode().clone({ keepId: true }).clone({ keepId: true });
    expect(kept.id).toBe('7');
    expect(kept.getData()).toEqual({ kind: 'ied', name: 'IED_1' });
    expect(kept.attr('label/text')).toBe('IED_1');
  });
});
