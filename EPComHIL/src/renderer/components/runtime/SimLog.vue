<script setup lang="ts">
/**
 * 仿真原始日志：展示完整仿真输出，支持全局过滤和组件独立过滤。
 * 时间戳格式：HH:MM:SS.mmm（仿真器时间）
 */
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import type { RuntimeEvent, RawLogEvent } from '@core/runtimeModel';
import { useRuntimeStore } from '@/stores/runtime';

const props = defineProps<{ events: RuntimeEvent[] }>();

const store = useRuntimeStore();

/** 组件独立过滤覆盖：null 表示使用全局设置 */
const localFilterOverride = ref<Record<RawLogEvent['tag'], boolean> | null>(null);
/** 是否显示过滤面板 */
const showFilterPanel = ref(false);
/** 自动滚动开关 */
const autoScroll = ref(true);
/** 日志容器引用 */
const listRef = ref<HTMLDivElement | null>(null);

/** 当前生效的过滤设置（组件独立 > 全局） */
const activeFilter = computed<Record<RawLogEvent['tag'], boolean>>(() => {
  return localFilterOverride.value ?? store.rawLogFilter;
});

/** 过滤后的原始日志事件 */
const logs = computed<RawLogEvent[]>(() => {
  const filter = activeFilter.value;
  return props.events
    .filter((e): e is RawLogEvent => e.kind === 'raw-log' && filter[e.tag])
    .slice()
    .reverse();
});

/** 标签颜色映射 */
const TAG_COLORS: Record<RawLogEvent['tag'], string> = {
  'epc-op': '#3fb0ff',
  'epc-kpi': '#2f9e6e',
  'epc-hil': '#3a9bc9',
  'epc-tap': '#9a7bd8',
  'epc-link': '#d87b9a',
  'rx-packet': '#e0a03a',
  'build': '#8a93a6',
  'other': '#566070',
};

/** 标签显示名称 */
const TAG_NAMES: Record<RawLogEvent['tag'], string> = {
  'epc-op': 'EPC-OP',
  'epc-kpi': 'EPC-KPI',
  'epc-hil': 'EPC-HIL',
  'epc-tap': 'EPC-TAP',
  'epc-link': 'EPC-LINK',
  'rx-packet': 'Rx',
  'build': 'Build',
  'other': 'Other',
};

/** 将仿真时间戳转换为 HH:MM:SS.mmm 格式 */
function formatTimestamp(us: number): string {
  const totalMs = us / 1000;
  const ms = Math.floor(totalMs % 1000);
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 切换组件独立过滤的某个标签 */
function toggleLocalTag(tag: RawLogEvent['tag']) {
  if (localFilterOverride.value === null) {
    // 首次修改时，从全局设置复制一份
    localFilterOverride.value = { ...store.rawLogFilter };
  }
  localFilterOverride.value[tag] = !localFilterOverride.value[tag];
}

/** 重置为使用全局设置 */
function resetToGlobal() {
  localFilterOverride.value = null;
}

/** 切换全局过滤的某个标签 */
function toggleGlobalTag(tag: RawLogEvent['tag']) {
  store.toggleRawLogFilter(tag);
  // 如果组件有独立覆盖，同步更新
  if (localFilterOverride.value !== null) {
    localFilterOverride.value[tag] = store.rawLogFilter[tag];
  }
}

/** 自动滚动到底部 */
function scrollToBottom() {
  if (autoScroll.value && listRef.value) {
    listRef.value.scrollTop = 0;
  }
}

// 当新事件到达时自动滚动
watch(
  () => logs.value.length,
  () => {
    nextTick(scrollToBottom);
  },
);

onMounted(() => {
  scrollToBottom();
});
</script>

<template>
  <div class="sim-log">
    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="count">{{ logs.length }} 行</span>
        <span v-if="localFilterOverride !== null" class="custom-badge">自定义</span>
      </div>
      <div class="toolbar-right">
        <label class="auto-scroll">
          <input type="checkbox" v-model="autoScroll" />
          <span>自动滚动</span>
        </label>
        <button class="btn-filter" @click="showFilterPanel = !showFilterPanel">
          {{ showFilterPanel ? '隐藏过滤' : '过滤' }}
        </button>
      </div>
    </div>

    <!-- 过滤面板 -->
    <div v-if="showFilterPanel" class="filter-panel">
      <div class="filter-header">
        <span class="filter-title">{{ localFilterOverride !== null ? '组件独立过滤' : '全局过滤' }}</span>
        <button v-if="localFilterOverride !== null" class="btn-reset" @click="resetToGlobal">重置为全局</button>
      </div>
      <div class="filter-tags">
        <div v-for="(name, tag) in TAG_NAMES" :key="tag" class="filter-tag">
          <label class="tag-toggle">
            <input
              type="checkbox"
              :checked="activeFilter[tag]"
              @change="localFilterOverride !== null ? toggleLocalTag(tag) : toggleGlobalTag(tag)"
            />
            <span class="tag-dot" :style="{ background: TAG_COLORS[tag] }"></span>
            <span class="tag-name">{{ name }}</span>
          </label>
        </div>
      </div>
    </div>

    <!-- 日志列表 -->
    <div ref="listRef" class="list">
      <div v-if="logs.length === 0" class="none">暂无仿真日志</div>
      <div v-for="e in logs" :key="e.id" class="log-line">
        <span class="ts">{{ formatTimestamp(e.timestampUs) }}</span>
        <span class="tag" :style="{ color: TAG_COLORS[e.tag], background: TAG_COLORS[e.tag] + '20' }">{{ TAG_NAMES[e.tag] }}</span>
        <span class="stream" :class="e.stream">{{ e.stream === 'err' ? 'STDERR' : 'STDOUT' }}</span>
        <span class="text">{{ e.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sim-log { height: 100%; min-height: 0; display: flex; flex-direction: column; }

/* 工具栏 */
.toolbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 8px; border-bottom: 1px solid rgba(127,145,178,0.12);
  background: rgba(127,145,178,0.05); flex-shrink: 0;
}
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.toolbar-right { display: flex; align-items: center; gap: 12px; }
.count { font-size: 11px; color: var(--ech-fg-dim); }
.custom-badge {
  font-size: 10px; color: #e0a03a; background: rgba(224,160,58,0.15);
  padding: 0 5px; border-radius: 3px;
}
.auto-scroll { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ech-fg-dim); cursor: pointer; }
.auto-scroll input { margin: 0; }
.btn-filter {
  font-size: 11px; padding: 2px 8px; border-radius: 3px;
  background: rgba(127,145,178,0.15); color: var(--ech-fg-dim);
  border: none; cursor: pointer;
}
.btn-filter:hover { background: rgba(127,145,178,0.25); }

/* 过滤面板 */
.filter-panel {
  padding: 6px 8px; border-bottom: 1px solid rgba(127,145,178,0.12);
  background: rgba(127,145,178,0.08); flex-shrink: 0;
}
.filter-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.filter-title { font-size: 11px; color: var(--ech-fg-dim); }
.btn-reset {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: rgba(224,160,58,0.15); color: #e0a03a;
  border: none; cursor: pointer;
}
.btn-reset:hover { background: rgba(224,160,58,0.25); }
.filter-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.filter-tag { display: flex; align-items: center; }
.tag-toggle {
  display: flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 11px; color: var(--ech-fg-dim);
}
.tag-toggle input { margin: 0; }
.tag-dot { width: 8px; height: 8px; border-radius: 50%; }
.tag-name { font-size: 11px; }

/* 日志列表 */
.list { flex: 1; min-height: 0; overflow: auto; }
.log-line {
  display: flex; gap: 8px; align-items: baseline; font-size: 11px;
  padding: 2px 8px; border-bottom: 1px solid rgba(127,145,178,0.08);
  font-family: 'Consolas', 'Monaco', monospace;
}
.log-line:hover { background: rgba(127,145,178,0.08); }
.ts { color: #5a6a80; flex: none; width: 100px; }
.tag {
  flex: none; font-size: 10px; padding: 0 4px; border-radius: 2px;
  font-weight: 500;
}
.stream {
  flex: none; font-size: 9px; text-transform: uppercase;
  padding: 0 3px; border-radius: 2px;
}
.stream.out { color: #2f9e6e; background: rgba(47,158,110,0.15); }
.stream.err { color: #e06060; background: rgba(224,96,96,0.18); }
.text { color: var(--ech-fg); white-space: pre-wrap; word-break: break-all; }
.none {
  height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--ech-fg-dim); font-size: 12px;
}
</style>
