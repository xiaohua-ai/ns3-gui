<script setup lang="ts">
/** GOOSE —— L2(0x88B8)发布时序：显示最新发布周期与帧大小，下方按时间画发布周期折线。
 * GOOSE 为全局对象，事件经 whole 绑定天然全量命中。 */
import { computed } from 'vue';
import type { GooseEvent, RuntimeEvent } from '@core/runtimeModel';
import EChartBase from './EChartBase.vue';
import type { EChartsOption } from 'echarts';

const props = defineProps<{ events: RuntimeEvent[] }>();

const goose = computed<GooseEvent[]>(() =>
  props.events.filter((e): e is GooseEvent => e.kind === 'goose').reverse(),
);

const latest = computed(() => goose.value[0]);

const option = computed<EChartsOption>(() => {
  const s = goose.value.slice().reverse(); // 转时间正序
  const xs = s.map((_, i) => String(i));
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 14, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: xs, boundaryGap: false, axisLabel: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(127,145,178,0.15)' } }, axisLabel: { color: '#5a6a80', fontSize: 10 } },
    series: [
      {
        name: '周期(μs)', type: 'line', smooth: true, showSymbol: false,
        data: s.map((e) => e.prevGapUs), lineStyle: { color: '#e0a03a', width: 2 },
        itemStyle: { color: '#e0a03a' }, areaStyle: { opacity: 0.08 },
      },
    ],
  };
});
</script>

<template>
  <div class="goose">
    <div class="head">
      <span class="ph"><i class="lbl">来源</i><b>{{ latest?.senderId ?? '—' }}</b></span>
      <span class="ph"><i class="lbl">AppID</i><b>0x{{ (latest?.appId ?? 0).toString(16).toUpperCase() }}</b></span>
      <span class="ph"><i class="lbl">帧长</i><b>{{ latest?.sizeBytes ?? '—' }} B</b></span>
      <span class="ph"><i class="lbl">周期</i><b>{{ latest ? (latest.prevGapUs / 1000).toFixed(2) + ' ms' : '—' }}</b></span>
    </div>
    <div class="body">
      <EChartBase v-if="goose.length" :option="option" />
      <div v-else class="none">暂无 GOOSE 发布</div>
    </div>
  </div>
</template>

<style scoped>
.goose { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head { display: flex; gap: 14px; padding-bottom: 6px; flex: none; flex-wrap: wrap; }
.ph { display: flex; align-items: baseline; gap: 6px; }
.ph .lbl { font-size: 11px; color: var(--ech-fg-dim); }
.ph b { font-size: 13px; color: var(--ech-fg); }
.body { flex: 1; min-height: 0; }
.none { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ech-fg-dim); font-size: 12px; }
</style>