<script setup lang="ts">
/**
 * ECharts 复用封装：把「挂载 / 尺寸自适应 / 选项更新 / 卸载释放」收敛到这层，
 * 业务组件只关心怎么把数据算成 option。运行时组件都是随会话布局缩放/移动的，
 * 尺寸必须由 ResizeObserver 跟随容器，而不是 ECharts 内部的 window resize。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps<{
  option: echarts.EChartsOption;
}>();

const host = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

function apply() {
  if (!chart) return;
  chart.setOption(props.option, { notMerge: true });
}

onMounted(() => {
  if (!host.value) return;
  chart = echarts.init(host.value, undefined, { renderer: 'canvas' });
  apply();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(host.value);
});

watch(() => props.option, apply, { deep: true });

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="host" class="e-chart"></div>
</template>

<style scoped>
.e-chart {
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
</style>