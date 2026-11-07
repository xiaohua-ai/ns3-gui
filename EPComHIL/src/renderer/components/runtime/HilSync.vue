<script setup lang="ts">
/** HIL 保守步进同步：显示时钟源 / 步进 / 抖动的实时取值与降级告警，下方按时间画抖动折线。
 * 命中则给出降级徽标——对齐 L2 保守步进引擎的降级语义。 */
import { computed } from 'vue';
import type { HilSyncEvent, RuntimeEvent } from '@core/runtimeModel';
import EChartBase from './EChartBase.vue';
import type { EChartsOption } from 'echarts';

const props = defineProps<{ events: RuntimeEvent[] }>();

const syncs = computed<HilSyncEvent[]>(() =>
  props.events.filter((e): e is HilSyncEvent => e.kind === 'hil-sync').reverse(),
);
const latest = computed(() => syncs.value[0]);

const option = computed<EChartsOption>(() => {
  const s = syncs.value.slice().reverse();
  const xs = s.map(() => '');
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 14, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: xs, axisLabel: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(127,145,178,0.15)' } }, axisLabel: { color: '#5a6a80', fontSize: 10 } },
    series: [
      {
        name: '抖动(μs)', type: 'line', smooth: true, showSymbol: false,
        data: s.map((e) => e.jitterUs), lineStyle: { color: '#3a9bc9', width: 2 },
        itemStyle: { color: '#3a9bc9' }, areaStyle: { opacity: 0.08 },
      },
    ],
  };
});
</script>

<template>
  <div class="hil">
    <div class="head">
      <span class="ph"><i class="lbl">时钟源</i><b>{{ latest?.clockSource ?? '—' }}</b></span>
      <span class="ph"><i class="lbl">步进</i><b>{{ latest?.stepUs ?? '—' }} μs</b></span>
      <span class="ph"><i class="lbl">抖动</i><b>{{ latest?.jitterUs ?? '—' }} μs</b></span>
      <span v-if="latest?.degraded" class="deg">降级</span>
    </div>
    <div class="msg" v-if="latest?.message">{{ latest.message }}</div>
    <div class="body">
      <EChartBase v-if="syncs.length" :option="option" />
      <div v-else class="none">暂无 HIL 同步事件</div>
    </div>
  </div>
</template>

<style scoped>
.hil { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; gap: 12px; padding-bottom: 4px; flex: none; flex-wrap: wrap; align-items: baseline; }
.ph { display: flex; align-items: baseline; gap: 6px; }
.ph .lbl { font-size: 11px; color: var(--ech-fg-dim); }
.ph b { font-size: 13px; color: var(--ech-fg); }
.deg {
  font-size: 11px; color: #fff; background: #e06060;
  border-radius: 4px; padding: 1px 6px; line-height: 1.6;
}
.msg { font-size: 11px; color: #e0a03a; padding-bottom: 4px; flex: none; }
.body { flex: 1; min-height: 0; }
.none { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ech-fg-dim); font-size: 12px; }
</style>