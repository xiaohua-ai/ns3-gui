// 绘制合成层越界修复的回归测试
// 背景：点击「P2P 连线」时，铅笔 data-URI 光标被一并套到 X6 的绝对定位大 SVG 层
// （.canvas-draw .x6-graph / .canvas-draw svg），切换时该层被抬成全屏合成层，
// 盖住了左侧「自带/用户案例库」。修复 = ① 光标只作用在画布容器 .canvas-draw；
// ② .canvas 补上 position:relative，把图层定位上下文锁进 overflow:hidden 裁剪边界。
// 本测试对源码不变式做断言，防止修复被后续改动绕过。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const viewPath = fileURLToPath(
  new URL('../src/renderer/views/TopologyView.vue', import.meta.url),
);
const source = readFileSync(viewPath, 'utf8');

// 截取 <style> 块：取最后一个 <style…开标签 到对应 </style> 之间的内容
const styleStart = source.lastIndexOf('<style');
const openClose = source.indexOf('>', styleStart);
const styleEnd = source.indexOf('</style>', styleStart);
const style = styleStart >= 0 && openClose > styleStart && styleEnd > openClose
  ? source.slice(openClose + 1, styleEnd)
  : '';

// 光标 data-URI：铅笔图标中出现的独特子串，用于精确定位 cursor 规则
const PENCIL_TIP = '9,6 23,20';

describe('TopologyView 合成层越界修复不变式', () => {
  it('画布容器 .canvas 带 position:relative，锁定图层定位上下文', () => {
    const block = /\.canvas\s*\{[^}]*\}/.exec(style)?.[0] ?? '';
    expect(block, '未找到 .canvas 规则').toContain('.canvas');
    expect(block, '.canvas 必须锚定定位上下文以免越界').toMatch(/position\s*:\s*relative/);
  });

  it('画布容器带 overflow:hidden，配合裁剪不越界', () => {
    const block = /\.canvas\s*\{[^}]*\}/.exec(style)?.[0] ?? '';
    expect(block).toMatch(/overflow\s*:\s*hidden/);
  });

  it('铅笔光标只作用在 .canvas-draw 容器，不扩散到 X6 内层 SVG 层', () => {
    // 精确匹配 .canvas-draw 开头的规则块（含铅笔光标）
    const m = new RegExp(`(\\.canvas-draw[^{]*?)\\{[^{}]*${PENCIL_TIP}[^}]*\\}`).exec(style);
    const selector = m?.[1]?.trim();
    expect(selector, '应存在一条持有铅笔光标的 .canvas-draw 规则').toBeTruthy();
    expect(selector, '光标选择器应为 .canvas-draw 容器').toBe('.canvas-draw');
    expect(selector, '不得将光标套到 X6 的 .x6-graph 层').not.toContain('.x6-graph');
    expect(selector, '不得将光标套到直接 svg 层').not.toMatch(/svg\b/);
  });

  it('铅笔光标规则不再出现 .canvas-draw .x6-graph / svg 多级选择器', () => {
    expect(style).not.toContain('.canvas-draw .x6-graph');
    expect(style).not.toMatch(/\.canvas-draw\s+svg/);
  });
});