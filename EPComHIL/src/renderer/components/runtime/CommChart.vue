<script setup lang="ts">
/** 通信指标：入参为已按绑定过滤的事件（任意种类混合，本组件只取 comm，且按口径取舍，见 keepEndToEndComm）。
 * 顶部一行当前 KPI（PDR / 平均时延），下方按时间卷动的收发包曲线。
 * 事件到达序为「新→旧」，曲线需在组件内部转成时间正序再喂给 ECharts。 */
import { computed } from 'vue';
import type { CommEvent, RuntimeEvent } from '@core/runtimeModel';
import { keepEndToEndComm } from '@core/runtimeModel';
import EChartBase from './EChartBase.vue';
import type { EChartsOption } from 'echarts';

const props = defineProps<{ events: RuntimeEvent[] }>();

const comm = computed<CommEvent[]>(() =>
  keepEndToEndComm(props.events)
    .filter((e): e is CommEvent => e.kind === 'comm')
    .slice()
    .sort((a, b) => a.timestampUs - b.timestampUs),
);

const kpi = computed(() => {
  const last = comm.value[comm.value.length - 1];
  if (!last) return null;
  return {
    pdr: last.pdr != null ? (last.pdr * 100).toFixed(1) + '%' : '—',
    delay: last.delayMeanUs != null ? (last.delayMeanUs / 1000).toFixed(2) + ' ms' : '—',
    lost: last.lostPackets ?? 0,
  };
});

// 时间轴用相对基准(μs→ms)便于同一画布下不同时序刻度对齐
const option = computed<EChartsOption>(() => {
  const xs = comm.value.map((e) => ((e.timestampUs - (comm.value[0]?.timestampUs ?? 0)) / 1000).toFixed(0));
  return {
    animation: false,
    grid: { left: 8, right: 8, top: 18, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: xs, boundaryGap: false, axisLabel: { color: '#5a6a80', fontSize: 10 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(127,145,178,0.15)' } }, axisLabel: { color: '#5a6a80', fontSize: 10 } },
    legend: { top: 0, right: 0, textStyle: { color: '#8a93a6', fontSize: 10 }, itemWidth: 12, itemHeight: 2 },
    series: [
      { name: 'RX', type: 'line', smooth: true, showSymbol: false, data: comm.value.map((e) => e.rxPackets ?? 0), lineStyle: { width: 2, color: '#2f9e6e' }, itemStyle: { color: '#2f9e6e' }, areaStyle: { opacity: 0.08 } },
      { name: 'TX', type: 'line', smooth: true, showSymbol: false, data: comm.value.map((e) => e.txPackets ?? 0), lineStyle: { width: 2, color: '#3fb0ff' }, itemStyle: { color: '#3fb0ff' } },
    ],
  };
});
</script>

<template>
  <div class="comm">
    <div class="stat-row">
      <span class="stat"><i class="lbl">PDR</i><b>{{ kpi?.pdr ?? '—' }}</b></span>
      <span class="stat"><i class="lbl">时延</i><b>{{ kpi?.delay ?? '—' }}</b></span>
      <span class="stat"><i class="lbl">丢包</i><b>{{ kpi?.lost ?? '—' }}</b></span>
    </div>
    <div class="body">
      <EChartBase v-if="option" :option="option" />
      <div v-else class="none">暂无通信事件</div>
    </div>
  </div>
</template>

<style scoped>
.comm { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.stat-row { display: flex; gap: 14px; padding-bottom: 6px; flex: none; }
.stat { display: flex; align-items: baseline; gap: 6px; }
.stat .lbl { font-size: 11px; color: var(--ech-fg-dim); }
.stat b { font-size: 15px; color: var(--ech-fg); }
.body { flex: 1; min-height: 0; }
.none { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ech-fg-dim); font-size: 12px; }
</style>