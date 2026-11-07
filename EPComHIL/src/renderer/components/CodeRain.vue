<script setup lang="ts">
/**
 * 二进制数字雨（0/1 字符下落）
 *
 * 设计要点：
 * 1. **字符不存储、不闪烁**：第 col 列第 row 行的字符由 `hash(col,row)` 的奇偶决定，
 *    是纯函数。字符随雨头滚动而稳定，不需要每列维护字符数组。
 * 2. **字形预渲染成贴图**：整屏最多同时有上千个字形，逐帧 `fillText` 太重；
 *    预先把 0/1 两种字形（含发光）画进离屏 canvas，逐帧只做 `drawImage` + `globalAlpha`。
 * 3. **不用「半透明黑矩形反复叠」的经典淡出法**：那种做法画布不透明，没法叠在背景图上。
 *    这里每帧 clearRect 后按「离雨头的距离」给每个字单独定 alpha。
 * 4. 列有 `wait`：雨头落出屏幕后随机歇一会儿再重来，于是画面自然出现疏密不匀的空档。
 *
 * 可访问性：`prefers-reduced-motion: reduce` 时只画一帧静帧，不起动画循环。
 * 性能：`document.hidden` 时暂停；DPR 上限 1.5；整层 `pointer-events:none`。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    fontSize?: number;  // 字号（CSS px），同时决定列宽
    speed?: number;     // 雨头下落速度（行/秒），各列会在此基准上随机浮动
    density?: number;   // 0~1，雨头离开后「立刻重来」的概率，越低空档越多
    trail?: number;     // 拖尾字数
    opacity?: number;   // 整层不透明度
    fps?: number;       // 限帧
    height?: string;    // 雨区高度（CSS 长度）：默认撑满容器；传 '50%' 之类可把雨限制在上半屏
  }>(),
  { fontSize: 15, speed: 11, density: 0.5, trail: 14, opacity: 0.9, fps: 30, height: '100%' },
);

const el = ref<HTMLCanvasElement | null>(null);
const host = ref<HTMLDivElement | null>(null);

const MONO = "'Cascadia Code', 'JetBrains Mono', 'Consolas', ui-monospace, monospace";
const TAIL_COLORS = ['#3fb0ff', '#2dd4bf']; // 拖尾：主强调青蓝 / 副强调荧光青
const HEAD_COLOR = '#e8faff';               // 雨头：近白，带同色辉光

interface Col {
  y: number;    // 雨头所在行（浮点，行单位）
  v: number;    // 速度（行/秒）
  a: number;    // 该列整体亮度
  tone: number; // 取色索引
  wait: number; // 剩余等待秒数，>0 时不画
}

type TileSet = { tail: HTMLCanvasElement[]; head: HTMLCanvasElement[] };

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let W = 0, H = 0;            // CSS 像素尺寸
let dpr = 1;
let cellW = 0, cellH = 0, pad = 0;
let rowsTotal = 0;
let cols: Col[] = [];
let tiles: TileSet[] = [];
let lastDraw = 0;
let running = false;
let reduceMotion = false;

/* ---------------- 字形贴图 ---------------- */
function makeTile(ch: string, color: string, glow: number): HTMLCanvasElement {
  const w = cellW + pad * 2;
  const h = cellH + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = `${props.fontSize}px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  if (glow > 0) {
    g.shadowColor = color;
    g.shadowBlur = glow;
  }
  g.fillText(ch, w / 2, h / 2);
  return c;
}

function buildTiles() {
  tiles = TAIL_COLORS.map((color) => ({
    tail: ['0', '1'].map((ch) => makeTile(ch, color, 0)),
    head: ['0', '1'].map((ch) => makeTile(ch, color, props.fontSize * 0.75)),
  }));
}

/* ---------------- 列状态 ---------------- */
function newCol(): Col {
  return { y: 0, v: 0, a: 1, tone: 0, wait: 0 };
}

/**
 * @param spread true = 首帧 / 新增列：把相位铺满**整个周期**（含屏幕上方那段回落区）。
 *   若只铺在屏内或屏上方，会出现两种难看的状态：要么一开始全挤在顶端、要等好几秒才落进来
 *   （整片空窗），要么密度明显高于稳态、再慢慢衰减。铺满周期才是「一上来就是稳态的雨」。
 *   false = 雨头出屏后的常规重来。
 */
function reset(c: Col, spread: boolean) {
  c.v = props.speed * (0.55 + Math.random() * 0.9);
  c.a = 0.55 + Math.random() * 0.45;
  c.tone = Math.random() < 0.18 ? 1 : 0;
  // 各列相位必须逐列独立随机：一旦按 i%k 分桶错开，列就挤成 k 组同起同落，
  // 整片雨出现「一波一波」的密度脉动（实测亮度在 63~10521 之间来回摆），很假。
  if (spread) {
    c.y = Math.random() * (rowsTotal + props.trail + 24) - (props.trail + 24);
    // 这里必须给 0：相位已经铺满整个周期，不需要再等。
    // 给非零 wait 会让「只画一帧」的静帧模式（prefers-reduced-motion）画布全空
    // —— dt=0 时 wait 永远减不到 0，第一帧就被整个跳过。
    c.wait = 0;
  } else {
    c.y = -(props.trail + Math.random() * 16);
    // density 决定「马上接着下」还是「歇一会儿」，于是出现疏密自然的空档
    c.wait = Math.random() < props.density ? 0 : Math.random() * 2.4;
  }
}

/* 字符由 (列, 行) 的哈希奇偶决定 —— 纯函数，滚动中稳定，不会逐帧乱跳 */
function glyphAt(col: number, row: number): number {
  let h = (col * 73856093) ^ (row * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return h & 1;
}

/* ---------------- 尺寸 ---------------- */
/**
 * @param reinit true 只在首次挂载时用。
 *   尺寸变化时**必须保留已有列**（列宽由 fontSize 决定、行单位不受画布尺寸影响），
 *   只按新的列数增删。踩过的坑：一开始 resize 就整组重建，结果浏览器启动后
 *   落定窗口尺寸那一次 resize 把画布清零，之后要 4~5 秒才「长回来」——
 *   表现为整片雨一波一波地忽明忽暗；真人拖拽窗口时同样会出现。
 */
function layout(reinit = false) {
  const cv = el.value;
  const box = host.value;
  if (!cv || !box) return;
  // 量的是外层雨区容器（而非 canvas 自身）：canvas 的宽高是被本函数写成显式 px 的，
  // 量它只会读到上次写死的旧值，容器高度改变（如 height:'50%'）就再也跟不上。
  const rect = box.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = Math.max(1, rect.width);
  H = Math.max(1, rect.height);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const geoChanged = cellW !== props.fontSize;
  cellW = props.fontSize;
  cellH = Math.round(props.fontSize * 1.2);
  pad = Math.ceil(props.fontSize * 0.9);
  rowsTotal = Math.ceil(H / cellH) + props.trail;
  buildTiles();

  const n = Math.ceil(W / cellW);
  if (reinit || geoChanged) cols = [];
  while (cols.length > n) cols.pop();
  while (cols.length < n) {
    const c = newCol();
    reset(c, true);
    cols.push(c);
  }
}

/* ---------------- 逐帧 ---------------- */
function draw(dt: number) {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const headTileW = cellW + pad * 2;
  const headTileH = cellH + pad * 2;

  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.wait > 0) {
      c.wait -= dt;
      continue;
    }
    c.y += c.v * dt;
    const headRow = Math.floor(c.y);
    if (headRow - props.trail > rowsTotal) {
      reset(c, false);
      continue;
    }
    const set = tiles[c.tone];
    if (!set) continue;

    for (let k = 0; k < props.trail; k++) {
      const row = headRow - k;
      if (row < 0) break;
      const y = row * cellH;
      if (y > H + pad) break;
      // 雨头最亮；拖尾按距离衰减（1.3 次方：近头亮得久一点，尾巴收得快）
      const a = (k === 0 ? 1 : Math.pow(1 - k / props.trail, 1.3) * 0.85) * c.a;
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(
        k === 0 ? set.head[glyphAt(i, row)] : set.tail[glyphAt(i, row)],
        i * cellW - pad,
        y - pad,
        headTileW,
        headTileH,
      );
    }
  }
  ctx.globalAlpha = 1;
}

function frame(ts: number) {
  raf = requestAnimationFrame(frame);
  if (!running) {
    lastDraw = 0;
    return;
  }
  if (lastDraw && ts - lastDraw < 1000 / props.fps - 0.5) return; // 限帧
  const dt = lastDraw ? Math.min((ts - lastDraw) / 1000, 0.12) : 1 / props.fps;
  lastDraw = ts;
  draw(dt);
}

function onResize() {
  layout(false); // 保留列，只增减数量
  draw(0);       // 立刻重画一帧，别等下一帧出现空窗
}

function onVisibility() {
  running = !document.hidden;
  lastDraw = 0;
}

onMounted(() => {
  reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  layout(true); // 首帧：相位铺满整个周期，一上来就是稳态的雨
  if (reduceMotion) {
    draw(0); // 尊重「减少动态效果」：只给一张静帧
    return;
  }
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  running = true;
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<template>
  <!-- 外层只负责「占位与高度」，canvas 自身铺满它并承接绘制 -->
  <div ref="host" class="code-rain" :style="{ opacity: props.opacity, height: props.height }">
    <canvas ref="el" aria-hidden="true"></canvas>
  </div>
</template>

<style scoped>
.code-rain {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: block;
  pointer-events: none;
}
.code-rain > canvas {
  position: absolute;
  inset: 0;
  display: block;
}
</style>
