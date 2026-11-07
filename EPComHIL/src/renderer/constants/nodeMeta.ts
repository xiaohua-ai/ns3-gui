// 节点类型元数据：拓扑页与配置页共用，避免两处各写一份标签表而漂移。
// 注意：生成器侧的正式全称见 core/model/NodeElement.ts（如 pv → 光伏逆变器），
// 那是写进代码注释的，这里是给人看的短标签，两者有意不同。
import type { NodeKind } from '@core/types';

/** 组件库按钮 / 表格里显示的短标签 */
export const KIND_LABEL: Record<NodeKind, string> = {
  switch: '交换机',
  router: '路由器',
  host: '主机',
  ied: 'IED',
  rtu: 'RTU',
  pv: '光伏',
  ess: '储能',
  load: '负荷',
};

/** 组件库展示顺序（对象 key 顺序不可靠，单独固定一份） */
export const KIND_ORDER: NodeKind[] = ['switch', 'router', 'host', 'ied', 'rtu', 'pv', 'ess', 'load'];

/** 画布节点配色 */
export const CANVAS_COLOR: Record<NodeKind, string> = {
  switch: '#2f81f7',
  router: '#1b5fc4',
  host: '#64748b',
  ied: '#34c07e',
  rtu: '#e0a445',
  pv: '#f2c94c',
  ess: '#7c5cff',
  load: '#e06c75',
};

/**
 * 组件库图标（线稿风格）：每项是一组 <path> 的 d，统一 viewBox 0 0 24 24。
 * 只描边不填充（fill/stroke-width 由使用处的 CSS 统一给），描边色取 CANVAS_COLOR[kind]。
 */
export const KIND_ICON: Record<NodeKind, string[]> = {
  // 交换机：矩形框 + 内部一对反向箭头
  switch: ['M3 5.5h18v13H3z', 'M8 15.5V8.5m-2.8 2.8L8 8.5l2.8 2.8', 'M16 8.5v7m-2.8-2.8L16 15.5l2.8-2.8'],
  // 路由器：圆 + 四向箭头
  router: [
    'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
    'M12 6.5v11M6.5 12h11',
    'M9.5 9 12 6.5l2.5 2.5',
    'M9.5 15 12 17.5l2.5-2.5',
    'M9 9.5 6.5 12l2.5 2.5',
    'M15 9.5 17.5 12l-2.5 2.5',
  ],
  // 主机：显示器 + 支架
  host: ['M3 5h18v11H3z', 'M12 16v3', 'M8 19h8'],
  // IED：芯片（本体 + 内核 + 八引脚）
  ied: ['M6 6h12v12H6z', 'M10 10h4v4h-4z', 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3'],
  // RTU：信号塔（桅杆 + 底座 + 两道电波）
  rtu: ['M12 20.5V12', 'M8.5 20.5h7', 'M9.5 10.5a4 4 0 0 1 5 0', 'M7 8a7 7 0 0 1 10 0'],
  // 光伏：太阳（圆 + 八向光线）
  pv: [
    'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10',
    'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2',
    'M5.2 5.2l1.4 1.4M18.8 5.2l-1.4 1.4M5.2 18.8l1.4-1.4M18.8 18.8l-1.4-1.4',
  ],
  // 储能：电池（外壳 + 正极 + 电量线）
  ess: ['M3 8h15v8H3z', 'M18 10.5h2.5v3', 'M7 11v2M10.5 11v2'],
  // 负荷：灯泡（泡体 + 灯座）
  load: ['M7 12A5 5 0 0 1 17 12L15.5 14.5H8.5z', 'M10 16.5h4', 'M10.5 18.5h3'],
};

/** 自动生成的默认名形如 "IED_1" / "交换机_2" */
export const AUTO_NAME_RE = new RegExp(`^(${KIND_ORDER.map((k) => KIND_LABEL[k]).join('|')})_\\d+$`);

/**
 * 画布节点用的图标 data URI。
 * X6 的 image 元素只吃 URL，所以把 KIND_ICON 拼成内联 SVG 再整体 URL 编码
 * （编码后颜色里的 `#` 会变成 `%23`，否则会被当成 URL fragment 截断）。
 *
 * strokeWidth 是**相对 24×24 viewBox** 的值，实际线宽 = strokeWidth × 渲染尺寸 / 24。
 * 所以同一个图标渲染得越大，越要调小这个值，否则线条会跟着变粗。
 * 默认 1.8 供组件库的 16px 缩略图用（实际 ≈1.2px）；画布上放大到 36px 时传 1.2（实际 ≈1.8px）。
 */
export function nodeIconDataUri(kind: NodeKind, strokeWidth = 1.8): string {
  const body = KIND_ICON[kind].map((d) => `<path d="${d}"/>`).join('');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"' +
    ` stroke="${CANVAS_COLOR[kind]}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">` +
    `${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
