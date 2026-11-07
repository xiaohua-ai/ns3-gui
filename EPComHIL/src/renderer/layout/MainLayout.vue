<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const steps = [
  { name: 'welcome', label: '欢迎', icon: 'M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-5v-7h-4v7H5a2 2 0 0 1-2-2z' },
  { name: 'scenario', label: '场景与工况', icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { name: 'topology', label: '拓扑建模', icon: 'M9 12h6 M12 9v6 M9 7a3 3 0 1 0-6 0 3 3 0 0 0 6 0z M21 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M9 17a3 3 0 1 0 6 0 3 3 0 0 0-6 0z' },
  { name: 'runtime', label: 'Runtime', icon: 'M3 12h4l2-7 4 14 2-7h6' },
  { name: 'config', label: '配置', icon: 'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4 M6 15v4' },
  { name: 'export', label: '导出', icon: 'M12 3v12 M7 8l5-5 5 5 M4 21h16' },
];

const currentStep = computed(() => (route.meta.step as number | undefined) ?? 0);

function go(name: string) {
  router.push({ name });
}
</script>

<template>
  <div class="layout">
    <!-- 左侧流程导航 -->
    <aside class="side-nav">
      <div class="brand">
        <div class="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M5 3l6 9-6 9M19 3l-6 9 6 9" stroke-linecap="round" />
          </svg>
        </div>
        <div class="brand-text">
          <div class="brand-title">EPComHIL</div>
          <div class="brand-sub">电力通信融合 HIL 仿真</div>
        </div>
      </div>
      <nav class="steps">
        <div
          v-for="(s, i) in steps"
          :key="s.name"
          class="step"
          :class="{ active: currentStep === i, done: currentStep > i }"
          @click="go(s.name)"
        >
          <svg class="step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path :d="s.icon" />
          </svg>
          <span class="step-label">{{ s.label }}</span>
        </div>
      </nav>
      <div class="nav-footer">
        <span class="led ok"></span>
        <span class="foot-text">系统就绪 · 先行版</span>
      </div>
    </aside>

    <!-- 主内容 -->
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100vh;
  background: var(--ech-bg);
}
.side-nav {
  width: 212px;
  flex-shrink: 0;
  /* 毛玻璃：让下层透过来（欢迎页那张插画铺满整个视口），再用模糊把它化开。
     blur 从 8px 提到 20px、saturate 提到 1.6 —— 8px 只是「雾」，
     插画里的建筑轮廓、发光点仍然看得出形状，读起来像「一张被调暗的图」而不是「玻璃」；
     20px 之后细节被彻底抹平，只剩色块与光晕，这才是毛玻璃。
     底色 0.26 + 一层很淡的 brightness：玻璃得有一层「奶」，纯透明只会显脏。
     saturate 只给 1.3 —— 给到 1.6 时那片蓝会艳成「果冻」，
     毛玻璃的质感来自「去色 + 提亮」，不是加饱和。
     （想更透就把 blur 降回 14px、底色降到 0.2；想更稳就加到 0.32。） */
  background: rgba(10, 22, 42, 0.26);
  -webkit-backdrop-filter: blur(20px) saturate(1.3) brightness(1.02);
  backdrop-filter: blur(20px) saturate(1.3) brightness(1.02);
  /* 去框线：不再画 border-right，也删掉原来右侧那条 1px 蓝色高光轨 ——
     在深色插画上，这两样都会被眼睛读成「一道框」。玻璃的边界交给模糊本身去表达。 */
  border-right: none;
  /* 右缘羽化：backdrop-filter 的生效范围是硬边的，模糊会在这里戛然而止，
     留下一道能看出「切边」的竖线。用 mask 让整层（含玻璃）在最后 2.5% 淡出，
     边缘就化进内容里了。起点 97.5% = 206.7px，仍在步骤卡右缘（204px）之外，不会削到文字。 */
  -webkit-mask-image: linear-gradient(90deg, #000 97.5%, transparent 100%);
  mask-image: linear-gradient(90deg, #000 97.5%, transparent 100%);
  display: flex;
  flex-direction: column;
  position: relative;
  /* 必须高于欢迎页那几层 fixed 背景/蒙层（最高到 z-index: 2），否则会被插画盖住 */
  z-index: 3;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px;
  position: relative;
}
/* 品牌区分隔：不再是 border-bottom 的满宽实线（那是一条「框」），
   改成两端渐隐的发丝光 —— 中间最亮也只有 8% 白，左右收进透明里。 */
.brand::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.08) 35%,
    rgba(255, 255, 255, 0.08) 65%,
    transparent
  );
  pointer-events: none;
}
.logo {
  width: 38px;
  height: 38px;
  border-radius: 6px;
  background:
    linear-gradient(135deg, var(--ech-accent), #1258b0),
    var(--ech-accent);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.25),
    0 0 10px var(--ech-glow);
}
.logo svg {
  width: 20px;
  height: 20px;
}
.brand-title {
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.02em;
}
.brand-sub {
  font-size: 11px;
  color: var(--ech-fg-dim);
}
.steps {
  flex: 1;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.step {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: 5px;
  color: var(--ech-fg-dim);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.16s;
  overflow: hidden;
}
.step:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--ech-fg);
}
.step-icon {
  width: 16px;
  height: 16px;
  flex: none;
  color: currentColor;
}
.step.active {
  background: var(--ech-accent-soft);
  color: var(--ech-accent-strong);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px rgba(46, 163, 255, 0.25);
}
/* 激活态左轨 */
.step.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 2px;
  border-radius: 2px;
  background: var(--ech-accent);
  box-shadow: 0 0 8px var(--ech-glow);
}
/* 激活态顶部扫描亮扫 */
.step.active::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--ech-accent), transparent);
  opacity: 0.8;
}
.step.done {
  color: var(--ech-accent-2);
}
.step-label {
  flex: 1;
}
.nav-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  font-size: 11px;
  color: var(--ech-fg-faint);
  position: relative;
}
/* 底部区同上：渐隐发丝光替代 border-top 实线 */
.nav-footer::before {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  top: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.08) 35%,
    rgba(255, 255, 255, 0.08) 65%,
    transparent
  );
  pointer-events: none;
}
.foot-text {
  letter-spacing: 0.02em;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 20px;
}
</style>