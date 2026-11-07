<script setup lang="ts">
/** 操作日志：仅展示 op 事件，按到达序滚动显示级别着色（图表的日志从最新倒序排顶部）。 */
import { computed } from 'vue';
import type { OpLogEvent, RuntimeEvent } from '@core/runtimeModel';

const props = defineProps<{ events: RuntimeEvent[] }>();

const logs = computed<OpLogEvent[]>(() =>
  props.events.filter((e): e is OpLogEvent => e.kind === 'op').slice().reverse(),
);

function lv(v: OpLogEvent['level']) {
  return { info: 'info', warn: 'warn', error: 'error' }[v];
}
</script>

<template>
  <div class="op">
    <ul v-if="logs.length" class="list">
      <li v-for="e in logs" :key="e.id">
        <span class="ts">{{ (e.timestampUs / 1000).toFixed(0) }} ms</span>
        <span class="lv" :class="lv(e.level)">{{ e.level }}</span>
        <span class="src">{{ e.source }}</span>
        <span class="msg">{{ e.message }}</span>
      </li>
    </ul>
    <div v-else class="none">暂无操作日志</div>
  </div>
</template>

<style scoped>
.op { height: 100%; min-height: 0; }
.list { list-style: none; margin: 0; padding: 0; height: 100%; overflow: auto; }
.list li { display: flex; gap: 8px; align-items: baseline; font-size: 11px; padding: 3px 0; border-bottom: 1px dashed rgba(127,145,178,0.12); }
.ts { color: #5a6a80; flex: none; }
.lv { flex: none; font-size: 10px; text-transform: uppercase; border-radius: 3px; padding: 0 5px; line-height: 1.7; }
.lv.info { color: #3fb0ff; background: rgba(63,176,255,0.15); }
.lv.warn { color: #e0a03a; background: rgba(224,160,58,0.15); }
.lv.error { color: #e06060; background: rgba(224,96,96,0.18); }
.src { color: var(--ech-fg-dim); flex: none; }
.msg { color: var(--ech-fg); }
.none { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ech-fg-dim); font-size: 12px; }
</style>