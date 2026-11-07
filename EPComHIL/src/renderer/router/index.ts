import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    component: () => import('@/layout/MainLayout.vue'),
    children: [
      { path: '', redirect: '/welcome' },
      { path: 'welcome', name: 'welcome', component: () => import('@/views/WelcomeView.vue'), meta: { title: '欢迎', step: 0 } },
      { path: 'scenario', name: 'scenario', component: () => import('@/views/ScenarioView.vue'), meta: { title: '场景与工况', step: 1 } },
      { path: 'topology', name: 'topology', component: () => import('@/views/TopologyView.vue'), meta: { title: '拓扑建模', step: 2 } },
      { path: 'runtime', name: 'runtime', component: () => import('@/views/RuntimeView.vue'), meta: { title: 'Runtime', step: 3 } },
      { path: 'config', name: 'config', component: () => import('@/views/ConfigView.vue'), meta: { title: '配置', step: 4 } },
      { path: 'export', name: 'export', component: () => import('@/views/ExportView.vue'), meta: { title: '导出', step: 5 } },
    ],
  },
];

export default createRouter({
  history: createWebHashHistory(),
  routes,
});