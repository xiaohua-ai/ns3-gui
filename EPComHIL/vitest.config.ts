import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// vitest 独立配置：与 vite.config（root=src/renderer）解耦，测试扫描放在项目根 test/ 下。
// 需保留与 vite.config 一致的别名，否则测试引用 store/视图时会解析不到 @core、@gen。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@gen': fileURLToPath(new URL('./src/generator', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    cacheDir: 'node_modules/.vitest',
  },
});
