<script setup lang="ts">
/** 硬件在环注入：按 TapBridge 通道聚合收发帧计数，最近事件明细列表。
 * 入参事件已按 binding 过滤，这里只取 hil-inject 并按 tapId 归类。 */
import { computed } from 'vue';
import type { HilInjectEvent, RuntimeEvent } from '@core/runtimeModel';

const props = defineProps<{ events: RuntimeEvent[] }>();

const injects = computed<HilInjectEvent[]>(() =>
  props.events.filter((e): e is HilInjectEvent => e.kind === 'hil-inject'),
);

/** 按 tapId 聚合最新收发 */
const byTap = computed(() => {
  const m = new Map<string, HilInjectEvent>();
  for (const e of injects.value) m.set(e.tapId, e);
  return [...m.values()];
});

const recent = computed(() => injects.value.slice().reverse().slice(0, 5));
</script>

<template>
  <div class="inj">
    <div v-if="byTap.length" class="taps">
      <div v-for="t in byTap" :key="t.tapId" class="tap">
        <span class="tid">{{ t.tapId }}</span>
        <span class="dir">收 <b>{{ t.rx }}</b></span>
        <span class="dir">发 <b>{{ t.tx }}</b></span>
      </div>
    </div>
    <div v-else class="none">暂无硬件在环注入</div>
    <ul v-if="recent.length" class="list">
      <li v-for="e in recent" :key="e.id">
        <span class="ts">{{ (e.timestampUs / 1000).toFixed(0) }}</span>
        <span class="di">[{{ e.kind }}]</span>
        <span>{{ e.tapId }} +{{ e.rx }}/{{ e.tx }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.inj { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 6px; }
.taps { display: flex; gap: 8px; flex-wrap: wrap; flex: none; }
.tap { display: flex; align-items: baseline; gap: 8px; background: rgba(154,123,216,0.12); border: 1px solid rgba(154,123,216,0.35); border-radius: 6px; padding: 4px 8px; }
.tid { color: #b69ff0; font-size: 12px; font-weight: 600; }
.dir { font-size: 11px; color: var(--ech-fg-dim); }
.dir b { color: var(--ech-fg); font-size: 13px; }
.list { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; min-height: 0; }
.list li { display: flex; gap: 8px; font-size: 11px; color: var(--ech-fg-dim); padding: 2px 0; }
.ts { color: #5a6a80; }
.di { color: #9a7bd8; }
.none { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ech-fg-dim); font-size: 12px; }
</style>