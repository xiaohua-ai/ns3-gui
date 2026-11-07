<script setup lang="ts">
// W8 导出：生成预览 + 四层中间输出（中间JSON/校验报告/生成日志/.cc）+ 点击导出落盘（架构 5.5/7.7）
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkbench } from '@/stores/workbench';
import { generate } from '@gen/generator';
import { samplingDoc } from '@gen/injectSwitcher';
import { planExport } from '@gen/exportPlan';
import type { BuildOptions } from '@gen/builder';
import type { ValidationResult } from '@core/Validator';

const store = useWorkbench();
const tab = ref('cpp');

// 运行设置就在当前工程里（project.run），是模式的唯一来源 —— 导出、运行、拓扑页设置面板
// 读到的都是同一份，且随工程保存。这里因此**不需要**本地副本，也不需要任何同步动作。
const result = ref<{ ok: boolean; cpp: string; validation: ValidationResult; options: BuildOptions } | null>(null);
const exporting = ref(false);
const lastExport = ref('');

function build() {
  // 运行设置已经长在工程里，直接生成。以前这里要先把 store.run 抄进 project.hil ——
  // 那一步正是第二个副本的源头：任何一条路径漏抄，产物就按陈旧模式生成。
  // syncMode 的"仅 REALTIME 生效、HIL 恒硬极限"规整已收进生成器，调用方不再各写一份。
  const project = JSON.parse(JSON.stringify(store.project));
  const r = generate(project);
  result.value = r;
  if (r.ok) ElMessage.success('校验通过，已生成 ns-3 代码');
  else ElMessage.error(`校验失败：${r.validation.errors.length} 处错误`);
}

function genLog(): string {
  if (!result.value) return '';
  const o = result.value.options;
  return [
    `# EPComHIL 生成日志`,
    `- 场景: ${store.project.projectName}`,
    `- 模式: ${o.mode}${o.mode === 'REALTIME' ? `( ${o.syncMode} )` : ''} · 时钟源: ${o.clockSource} · 采样: ${o.precise ? 'precise' : 'rough'} · 停止: ${o.stopSeconds}s`,
    `- 元素: 节点${store.project.nodes.length} 链路${store.project.links.length} 协议${store.project.protocols.length} 业务流${store.project.flows.length} 故障${store.project.faults.length}`,
    `- 校验: ${result.value.ok ? '通过' : `错误 ${result.value.validation.errors.length}`}`,
    '',
    samplingDoc(o.precise),
  ].join('\n');
}

async function doExport() {
  // 未生成或校验未过时先重新生成一次，避免用户点两次
  if (!result.value || !result.value.ok) {
    build();
    if (!result.value || !result.value.ok) return;
  }
  if (!window.epcomhil) return ElMessage.warning('未处于 Electron 环境，无法写盘（可在浏览器中预览生成结果）');
  exporting.value = true;
  // 导出清单由 outputWriter.planExport 统一生成，主进程仅按清单落盘（与单测同源）
  const plan = planExport(JSON.parse(JSON.stringify(store.project)), result.value.cpp, result.value.validation);
  const res = await window.epcomhil.exportProject(plan);
  exporting.value = false;
  if (res.ok && res.root) {
    lastExport.value = res.root;
    ElMessage.success('已导出：' + res.root);
  } else {
    ElMessage.warning(res.reason === 'cancelled' ? '已取消选择目录' : `导出失败：${res.reason ?? ''}`);
  }
}
</script>

<template>
  <div class="export-page panel">
    <div class="ex-toolbar">
      <div class="ex-actions">
        <el-button type="primary" @click="build">生成预览</el-button>
        <el-button type="success" :loading="exporting" @click="doExport">导出 ns-3 项目代码</el-button>
      </div>
    </div>

    <div v-if="lastExport" class="ex-last">已导出目录：{{ lastExport }}</div>

    <div v-if="result" class="ex-body">
      <el-alert
        :type="result.ok ? 'success' : 'error'"
        :title="result.ok ? '校验通过，可导出' : `校验失败：${result.validation.errors.length} 处错误、${result.validation.warnings.length} 处警告，需修复后导出`"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
      />
      <el-tabs v-model="tab">
        <el-tab-pane label="生成的 .cc" name="cpp">
          <pre class="code">{{ result.cpp }}</pre>
        </el-tab-pane>
        <el-tab-pane label="校验报告" name="validation">
          <div class="issue" v-if="result.validation.errors.length">
            <div class="issue-title error">错误（{{ result.validation.errors.length }}）</div>
            <div v-for="(e, i) in result.validation.errors" :key="i" class="issue-item">{{ e.elementId }} :: {{ e.field }} — {{ e.message }}</div>
          </div>
          <div class="issue" v-if="result.validation.warnings.length">
            <div class="issue-title warn">警告（{{ result.validation.warnings.length }}）</div>
            <div v-for="(w, i) in result.validation.warnings" :key="i" class="issue-item">{{ w.elementId }} :: {{ w.field }} — {{ w.message }}</div>
          </div>
          <div v-if="!result.validation.errors.length && !result.validation.warnings.length" class="issue-item">无问题</div>
        </el-tab-pane>
        <el-tab-pane label="生成日志" name="log">
          <pre class="code">{{ genLog() }}</pre>
        </el-tab-pane>
        <el-tab-pane label="中间 JSON (附录C)" name="json">
          <pre class="code">{{ JSON.stringify(store.project, null, 2) }}</pre>
        </el-tab-pane>
      </el-tabs>
    </div>

    <div v-else class="ex-empty">配置完成后点击「生成预览」，此处将显示四层中间输出（中间JSON / 校验报告 / 生成日志 / .cc）。</div>
  </div>
</template>

<style scoped>
.export-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - 40px);
}
.ex-toolbar {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 12px 14px;
  flex-shrink: 0;
}
.ex-actions {
  margin-left: auto;
}
.ex-last {
  font-size: 12px;
  color: var(--ech-accent-2);
  background: rgba(52, 192, 126, 0.1);
  border: 1px solid rgba(52, 192, 126, 0.3);
  border-radius: 8px;
  padding: 8px 12px;
}
.el-tabs :deep(.el-tabs__item) {
  color: var(--ech-fg);
}
.el-tabs :deep(.el-tabs__item):not(.is-active):hover {
  color: var(--ech-accent-strong);
}
.el-tabs :deep(.el-tabs__item.is-active) {
  color: var(--ech-accent);
  font-weight: 600;
}
/* 校验状态条统一为深色协调风格（深底 + 语义色文字/图标），与整体 dark 主题及
   校验通过 ElMessage 深色 toast 一致，不再随任何选择出现浅绿/浅色分歧。
   width:100% + flex-none 保证无论成功/失败文案长短、处于哪个标签，条宽始终占满一致 */
.ex-body :deep(.el-alert) {
  width: 100%;
  flex: none;
  background: var(--ech-bg-float);
  border: 1px solid var(--ech-border-strong);
  border-radius: 8px;
  color: var(--ech-fg);
}
.ex-body :deep(.el-alert__content) {
  color: var(--ech-fg);
}
.ex-body :deep(.el-alert--success .el-alert__icon),
.ex-body :deep(.el-alert--success .el-alert__title) {
  color: var(--ech-ok);
}
.ex-body :deep(.el-alert--error .el-alert__icon),
.ex-body :deep(.el-alert--error .el-alert__title) {
  color: var(--ech-danger);
}
.ex-body {
  flex: 1;
  min-height: 0;
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}
.code {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #0e1116;
  border: 1px solid var(--ech-border);
  border-radius: 8px;
  padding: 14px;
  color: #c9d4e0;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.issue-title {
  font-weight: 600;
  margin: 10px 0 6px;
}
.issue-title.error {
  color: #f56c6c;
}
.issue-title.warn {
  color: #e6a23c;
}
.issue-item {
  font-size: 12px;
  color: var(--ech-fg);
  padding: 3px 0;
  border-bottom: 1px dashed var(--ech-border);
}
.ex-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--ech-fg-dim);
  font-size: 13px;
}
</style>