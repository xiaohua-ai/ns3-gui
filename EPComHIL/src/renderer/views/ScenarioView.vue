<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useWorkbench } from '@/stores/workbench';

const router = useRouter();
const store = useWorkbench();

const rows = [
  { key: '项目名', value: store.project.projectName },
  { key: '节点', value: `${store.project.nodes.length}` },
  { key: '链路', value: `${store.project.links.length}` },
  { key: '协议', value: `${store.project.protocols.length}` },
  { key: '业务流', value: `${store.project.flows.length}` },
  { key: '仿真模式', value: store.project.run.mode },
];
</script>

<template>
  <div class="scenario-page panel">
    <div class="head">
      <h2>场景与工况</h2>
      <p class="sub">当前工程概览。先行版以内置样例工况驱动，后续接入工况库（Simple/Complex）与管理。</p>
    </div>
    <div class="stats">
      <div v-for="r in rows" :key="r.key" class="stat">
        <div class="stat-key">{{ r.key }}</div>
        <div class="stat-val">{{ r.value }}</div>
      </div>
    </div>
    <div class="actions">
      <el-button type="primary" @click="router.push({ name: 'topology' })">去拓扑建模</el-button>
      <el-button @click="router.push({ name: 'config' })">去配置</el-button>
      <el-button @click="router.push({ name: 'export' })">去导出</el-button>
    </div>
  </div>
</template>

<style scoped>
.scenario-page {
  max-width: 760px;
  margin: 0 auto;
}
.head h2 {
  color: #eef2f6;
  margin: 0 0 8px;
}
.sub {
  color: var(--ech-fg-dim);
  font-size: 13px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 22px 0;
}
.stat {
  background: var(--ech-bg-panel);
  border: 1px solid var(--ech-border);
  border-radius: 10px;
  padding: 14px;
}
.stat-key {
  font-size: 12px;
  color: var(--ech-fg-dim);
}
.stat-val {
  font-size: 20px;
  font-weight: 600;
  color: #eef2f6;
  margin-top: 4px;
}
.actions {
  display: flex;
  gap: 10px;
}
</style>