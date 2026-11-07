<script setup lang="ts">
import { RouterView, useRoute } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import type { ConfigProviderProps } from 'element-plus';
const route = useRoute();

// 一次成型：Element Plus 全局 Message 统一默认 0.8s 消失（默认 3s 太拖沓）。
// 通过官方 el-config-provider 的 message.duration 集中配置，覆盖所有 ElMessage 调用，
// 后续新增提示无需逐处补 duration。显式传入 duration 的调用仍以调用方为准。
const configProvider: Partial<ConfigProviderProps> = {
  locale: zhCn,
  message: {
    duration: 800,
    grouping: true,
  },
};
</script>

<template>
  <el-config-provider :locale="configProvider.locale" :message="configProvider.message">
    <div class="app-shell">
      <!-- key 绑定路由名：菜单切换时强制重建视图，确保立即生效，不残留旧实例 -->
      <RouterView :key="route.name" />
    </div>
  </el-config-provider>
</template>

<style>
/* ============ 主题中枢：工业化 · 科技感设计 token ============ */
:root {
  /* 深色背景三级层次 */
  --ech-bg: #0d1117;
  --ech-bg-panel: #161b22;
  --ech-bg-float: #1c2129;
  --ech-bg-inset: #0a0d12;
  /* 边框/分隔 */
  --ech-border: #262d38;
  --ech-border-strong: #38404d;
  /* 前景 */
  --ech-fg: #e4eaf1;
  --ech-fg-dim: #9aa7b4;
  --ech-fg-faint: #7d8a99;
  /* 强调（磷光科技青蓝） */
  --ech-accent: #2ea3ff;
  --ech-accent-soft: rgba(46, 163, 255, 0.14);
  --ech-accent-strong: #57b8ff;
  --ech-glow: rgba(46, 163, 255, 0.32);
  /* 副强调（荧光青，副轴/第二强调） */
  --ech-accent-2: #2dd4bf;
  --ech-accent-2-soft: rgba(45, 212, 191, 0.14);
  /* 状态语义色 */
  --ech-ok: #37d67b;
  --ech-ok-soft: rgba(55, 214, 123, 0.16);
  --ech-warn: #ffb454;
  --ech-warn-soft: rgba(255, 180, 84, 0.16);
  --ech-danger: #ff5c5c;
  --ech-danger-soft: rgba(255, 92, 92, 0.16);
  --ech-off: #5d6a78;
  /* 材质/字体 */
  --ech-panel-grad: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0) 38px);
  --ech-panel-hi: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  --ech-shadow: 0 6px 24px rgba(0, 0, 0, 0.38);
  --ech-mono: 'Cascadia Code', 'JetBrains Mono', 'Consolas', ui-monospace, monospace;
}

/* ============ Element Plus 深色套件覆盖到同一工业体系 ============ */
html.dark {
  --el-color-primary: #2ea3ff;
  --el-color-primary-light-3: #57b8ff;
  --el-color-primary-light-5: #80ccff;
  --el-color-primary-light-7: #aadfff;
  --el-color-primary-light-8: #c0e8ff;
  --el-color-primary-light-9: #d6f1ff;
  --el-color-primary-dark-2: #2191e6;

  --el-color-success: #37d67b;
  --el-color-success-light-3: #5cdea0;
  --el-color-success-light-5: #80e6bf;
  --el-color-success-light-7: #abefd6;
  --el-color-success-light-8: #c0f3e2;
  --el-color-success-light-9: #d6f8ee;
  --el-color-success-dark-2: #2bb870;

  --el-color-warning: #ffb454;
  --el-color-warning-light-3: #ffc477;
  --el-color-warning-light-5: #ffd499;
  --el-color-warning-light-7: #ffe4c0;
  --el-color-warning-light-8: #ffeadd;
  --el-color-warning-light-9: #fff4e9;
  --el-color-warning-dark-2: #e0a04a;

  --el-color-danger: #ff5c5c;
  --el-color-danger-light-3: #ff807c;
  --el-color-danger-light-5: #ffa09c;
  --el-color-danger-light-7: #ffc3c0;
  --el-color-danger-light-8: #ffd5d3;
  --el-color-danger-light-9: #ffe9e7;
  --el-color-danger-dark-2: #e05050;
  --el-color-error: #ff5c5c;
  --el-color-error-light-3: #ff807c;
  --el-color-error-light-5: #ffa09c;
  --el-color-error-light-7: #ffc3c0;
  --el-color-error-light-8: #ffd5d3;
  --el-color-error-light-9: #ffe9e7;
  --el-color-error-dark-2: #e05050;

  --el-bg-color: #161b22;
  --el-bg-color-page: #0d1117;
  --el-bg-color-overlay: #1c2129;
  --el-border-color: #262d38;
  --el-border-color-light: #222a34;
  --el-border-color-lighter: #1f2830;
  --el-border-color-extra-light: #1b232c;
  --el-text-color-primary: #e4eaf1;
  --el-text-color-regular: #cdd4de;
  --el-text-color-secondary: #a3afbc;
  --el-text-color-placeholder: #8592a1;
  --el-fill-color: #20262f;
  --el-fill-color-light: #1b222b;
  --el-fill-color-lighter: #161d25;
  --el-fill-color-blank: #161b22;
  --el-mask-color: rgba(10, 13, 18, 0.72);
  --el-border-radius-base: 4px;
  --el-border-radius-small: 3px;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  background: var(--ech-bg);
  color: var(--ech-fg);
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
}
* {
  box-sizing: border-box;
}

/* ---------- 工业质感：面板 ---------- */
.panel {
  background: var(--ech-bg-panel);
  background-image: var(--ech-panel-grad);
  border: 1px solid var(--ech-border);
  border-radius: 6px;
  box-shadow: var(--ech-panel-hi), var(--ech-shadow);
}
.panel--flat {
  box-shadow: var(--ech-panel-hi);
}
/* 面板顶部高光线：附着在 panel 上缘 */
.panel::before {
  content: '';
  display: block;
  height: 1px;
  margin: 0;
  background: linear-gradient(90deg, transparent, var(--ech-accent-strong), transparent);
  opacity: 0.55;
  border-radius: 6px 6px 0 0;
}

/* ---------- 状态灯 ---------- */
.led {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ech-off);
  box-shadow: 0 0 4px 1px rgba(0, 0, 0, 0.5), inset 0 0 2px rgba(0, 0, 0, 0.5);
  /* 金属灯孔 */
  box-shadow:
    inset 0 0 2px rgba(0, 0, 0, 0.6),
    0 0 0 1px var(--ech-border-strong),
    0 0 4px 0 rgba(0, 0, 0, 0.5);
  flex: none;
}
.led.ok {
  background: var(--ech-ok);
  box-shadow:
    inset 0 0 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px var(--ech-border-strong),
    0 0 6px 1px var(--ech-ok);
}
.led.warn {
  background: var(--ech-warn);
  box-shadow:
    inset 0 0 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px var(--ech-border-strong),
    0 0 6px 1px var(--ech-warn);
}
.led.danger {
  background: var(--ech-danger);
  box-shadow:
    inset 0 0 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px var(--ech-border-strong),
    0 0 8px 1px var(--ech-danger);
}
.led.acc {
  background: var(--ech-accent);
  box-shadow:
    inset 0 0 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px var(--ech-border-strong),
    0 0 6px 1px var(--ech-glow);
}

/* ---------- 工程数值等宽体 ---------- */
.mono {
  font-family: var(--ech-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}

/* ---------- 氛围：隐约扫描线 / 微网格（用于空白画布背景层） ---------- */
.tech-grid {
  background-image:
    linear-gradient(rgba(46, 163, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(46, 163, 255, 0.05) 1px, transparent 1px);
  background-size: 26px 26px;
}

/* ---------- 全局质感微效 ---------- */
::selection {
  background: var(--ech-accent-soft);
  color: var(--ech-accent-strong);
}
* {
  scrollbar-width: thin;
  scrollbar-color: var(--ech-border-strong) transparent;
}
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-thumb {
  background: var(--ech-border-strong);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--ech-accent);
  background-clip: padding-box;
  border: 2px solid transparent;
}
*::-webkit-scrollbar-track {
  background: transparent;
}

/* Element Plus 控件质感统一：按钮/输入框聚焦发光 */
html.dark .el-button {
  border-radius: 4px;
}
html.dark .el-button:not(.el-button--text):not(.is-link):hover {
  border-color: var(--ech-accent);
  color: var(--ech-accent-strong);
  box-shadow: 0 0 0 1px var(--ech-accent-soft);
}
html.dark .el-input__wrapper,
html.dark .el-textarea__inner,
html.dark .el-select__wrapper {
  box-shadow: 0 0 0 1px var(--ech-border) inset;
}
html.dark .el-input__wrapper.is-focus,
html.dark .el-select__wrapper.is-focused {
  box-shadow: 0 0 0 1px var(--ech-accent) inset, 0 0 0 3px var(--ech-accent-soft);
}

/* 卡片/消息统一细描边 */
html.dark .el-card,
html.dark .el-dialog,
html.dark .el-message-box {
  background-color: var(--ech-bg-float);
  border-color: var(--ech-border);
}
</style>