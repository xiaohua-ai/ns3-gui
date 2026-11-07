// 仿真器实跑计时的"持久锚点"。
// 起点与终点都来源**产物遥测标记**（[EPC-OP] src=runtime），而非 phase 事件：
//   "遥测通道就绪"（Simulator::Run() 之前）→ 起表（清零）
//   "仿真结束"（Simulator::Run() 之后）→ 停表并保读数
// 这使计时器精确测量仿真引擎实际执行时间，不计入进程启动/关闭的 ~360ms 开销。
// 视图经 <router-view> 挂载（无 KeepAlive）：离开再回来整组件卸载重挂。若起表基准放组件内
// （<script setup> 每次挂载重建），重挂后读数就从 0 重新起跳（"跑着跑着计时归零"的根因）。
// 因此基准放**模块级**：重挂时若仍在运行，只续走不清零；新会话真正开始才清零。
import { ref } from 'vue';

/** 展示用当前读数(ms)，共享引用：视图重挂仍指向同一份，读数不丢 */
export const tickMs = ref(0);

let tickBase = 0; // 本段 performance.now() 起点（0 = 尚未有一段）
let tickCarry = 0; // 本段之前已累计的读数(ms)，停表时收进来以便下次续走
let tickTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 仿真开始（"遥测通道就绪"标记到达）：清零并起表。
 * 走模块级锚点：重挂时若仍在运行，只续走不清零；新会话真正开始才清零。
 */
export function startSimTicker(reset = false) {
  if (reset || !tickBase) {
    tickCarry = 0;
    tickBase = performance.now();
    tickMs.value = 0;
  }
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      tickMs.value = tickCarry + (performance.now() - tickBase);
    }, 20);
  }
}

/** 仿真结束（"仿真结束"标记到达 / 手动停 / 出错）：停表并把读数并入 carry 保住结束读数 */
export function stopSimTicker() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (tickBase) tickCarry = tickMs.value;
}