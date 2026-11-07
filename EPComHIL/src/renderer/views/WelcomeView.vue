<script setup lang="ts">
import { useRouter } from 'vue-router';
import CodeRain from '@/components/CodeRain.vue';

const router = useRouter();
</script>

<template>
  <div class="welcome">
    <!-- 背景图（静态） -->
    <div class="bg-image"></div>
    <!-- 下半部提亮层：同一张背景图的副本 + brightness 滤镜，靠纵向 mask 控制「提亮多少」——
         顶部 mask=0（原图，深蓝天幕保持不动），往下渐入到 mask=1（提亮后的图）。
         因为是同一张图叠自己，过渡处不会出现接缝或色相断层。 -->
    <div class="bg-lift"></div>
    <!-- 二进制数字雨：只铺在上半屏（height="50%"），压在渐变蒙层「之下」，
         于是左侧文字区的蒙层自然把它压暗、右侧渐亮处保留清晰观感 —— 文字可读性不用另加遮罩。
         底部用 mask 渐隐，避免雨被半屏边界「一刀切」出横向断线。 -->
    <CodeRain class="rain" height="50%" />
    <!-- 深色渐变蒙层，保证文字可读 -->
    <div class="bg-overlay"></div>

    <div class="hero">
      <div class="hero-badge">Windows 上位机先行版</div>
      <h1>电力通信融合硬件在环仿真平台</h1>
      <p class="hero-sub">
        面向源网荷储、配电网场景的电力通信融合 HIL 仿真。本先行版实现
        <b>拓扑建模 → 配置 → 校验 → 代码生成 → 导出 ns-3 项目代码</b>的完整链路。
      </p>
      <div class="actions">
        <el-button type="primary" size="large" @click="router.push({ name: 'scenario' })">
          开始建工程
        </el-button>
        <el-button size="large" @click="router.push({ name: 'topology' })">快速建模</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  position: relative;
  min-height: calc(100vh - 40px);
  max-width: none;
  margin: 0 -20px;
  padding: 60px 40px;
  overflow: hidden;
}

/* 背景图 —— 用 fixed 铺满整个视口（而不是只铺内容区）。
   这是「左侧导航栏透明」能成立的前提：插画必须先伸到导航栏底下，
   导航栏把底色去掉后才能透出东西来（否则透出来的只是 .layout 的纯色底，等于没改）。
   注意 cover 的适配容器随之从「内容区」变成「视口」，构图会略有不同（横向少裁一些）。 */
.bg-image {
  position: fixed;
  inset: 0;
  background-image: url('../assets/welcome-bg.png');
  background-size: cover;
  background-position: center;
  z-index: 0;
}

/* 下半部提亮层：与背景图同源同尺寸，唯一区别是挂了一个 brightness 滤镜；
   纵向 mask 决定「哪一段用提亮版」——
     顶部 1/4（深蓝天幕）mask 全透明 → 完全用原图，天空保持原有暗调；
     26%~78% 渐入 → 提亮比例平滑爬升，不会出现横向分界；
     78% 以下 mask 不透明 → 城市/建筑/地面整段吃满提亮。
   之所以用「同图叠自己」而不是直接给背景图加滤镜：那样整幅（含天空）都会变亮，
   也没法只对下半部生效。 */
.bg-lift {
  position: fixed;
  inset: 0;
  background-image: url('../assets/welcome-bg.png');
  background-size: cover;
  background-position: center;
  filter: brightness(1.55) saturate(1.16) contrast(1.03);
  -webkit-mask-image: linear-gradient(
    180deg,
    transparent 0%,
    transparent 26%,
    rgba(0, 0, 0, 0.45) 45%,
    rgba(0, 0, 0, 0.85) 62%,
    #000 78%,
    #000 100%
  );
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    transparent 26%,
    rgba(0, 0, 0, 0.45) 45%,
    rgba(0, 0, 0, 0.85) 62%,
    #000 78%,
    #000 100%
  );
  z-index: 0;
  pointer-events: none;
}

/* 数字雨层：位于背景图之上、渐变蒙层之下（层级见上方注释）。
   mask 让雨在下半屏入口处自然消散，不会出现横向硬边。 */
.rain {
  z-index: 1;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 58%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 58%, transparent 100%);
}

/* 深色渐变蒙层：横向「左深右淡」，保证文字可读。
   它同时是数字雨的「可读性保护」——内容区左缘 0.9 的不透明度把雨压到几乎看不见，
   越往右越透，雨越清晰。
   纵向那条的**底部由 0.6 降到 0.3**：文字都在上半部，底部本来不需要压这么狠，
   压着反而把上面 .bg-lift 的提亮效果吃掉一半。

   本次改动：蒙层跟着背景一起铺满视口，但**左侧 212px（导航栏那一段）单独降暗度**。
   原来 0% 处就是 0.9，直接让它盖到导航栏上，导航栏底下就只剩 10% 可见度，
   「透明」做了等于没做。现在 0~196px 统一 0.5（插画透得出来），
   再把回落到 0.9 的过渡带从 16px 拉宽到 34px（196 → 230px）：
   玻璃右缘只羽化 5px，若蒙层在紧贴边缘处突然变暗，那道「亮度台阶」还是会被读成边。
   拉宽后台阶落在 34px 里，配合玻璃羽化就化开了。文字起点在 x=260，护字效果不受影响。 */
.bg-overlay {
  position: fixed;
  inset: 0;
  background:
    linear-gradient(
      90deg,
      rgba(2, 6, 23, 0.5) 0,
      rgba(2, 6, 23, 0.5) 196px,
      rgba(2, 6, 23, 0.86) 230px,
      rgba(2, 6, 23, 0.68) 45%,
      rgba(2, 6, 23, 0.28) 100%
    ),
    linear-gradient(180deg, rgba(2, 6, 23, 0.4) 0%, transparent 30%, rgba(2, 6, 23, 0.3) 100%);
  z-index: 2;
}

/* 前景内容层级 */
.hero {
  position: relative;
  z-index: 10;
  padding: 40px 8px 8px;
}
.hero-badge {
  display: inline-block;
  font-size: 12px;
  color: var(--ech-accent);
  border: 1px solid rgba(46, 163, 255, 0.4);
  border-radius: 999px;
  padding: 4px 12px;
  margin-bottom: 14px;
  background: rgba(46, 163, 255, 0.08);
  backdrop-filter: blur(4px);
}
h1 {
  font-size: 32px;
  margin: 0 0 12px;
  color: #ffffff;
  text-shadow: 0 2px 16px rgba(0, 0, 0, 0.5);
  letter-spacing: 0.02em;
}
.hero-sub {
  color: #cdd4de;
  line-height: 1.7;
  max-width: 640px;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.4);
}
.hero-sub b {
  color: var(--ech-accent-2);
}
.actions {
  margin-top: 24px;
  display: flex;
  gap: 12px;
}
</style>
