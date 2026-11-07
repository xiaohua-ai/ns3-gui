import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
// vite 配置本身是 ESM(由 esbuild 处理)，但 electron/serverMonitor.cjs 是 CommonJS；
// 用 createRequire 安全加载，避免 ESM ↔ CJS 互操作坑。
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

// 浏览器「打开所在位置」：浏览器无权限直接拉起本机文件管理器，
// 但 vite dev server 运行在用户本机（Node 进程），可代它以系统命令打开资源管理器定位到 scenarios/<folder>。
// 仅 serve 阶段生效；生产由 Electron 壳走 IPC（见 electron/main.cjs scenes:revealFolder）。
function sceneRevealPlugin(): Plugin {
  return {
    name: 'epcomhil-scene-reveal',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/__epcomh_scene_reveal')) return next();
        const folder = new URL(req.url, 'http://localhost').searchParams.get('folder') || '';
        const root = path.resolve(process.cwd(), 'scenarios');
        const abs = path.resolve(root, folder);
        if (!folder || abs !== path.join(root, folder) || !abs.startsWith(root + path.sep)) {
          res.statusCode = 400;
          res.end('illegal');
          return;
        }
        if (!fs.existsSync(abs)) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const [cmd, args] =
          process.platform === 'win32'
            ? ['explorer.exe', [abs]]
            : process.platform === 'darwin'
              ? ['open', [abs]]
              : ['xdg-open', [abs]];
        const proc = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
        proc.unref();
        res.end('ok');
      });
    },
  };
}

// 浏览器/开发模式下的 SSH 服务器桥：渲染端若检测到不在 Electron 环境
// （window.epcomhil 未注入，比如用户直接用浏览器打开 localhost:5173），就回退到
// 这套 HTTP + SSE 接口，与 Electron 主进程 IPC（electron/main.cjs）语义一一对应。
//   GET  /__epcomhil_server_status            → 拉取状态
//   POST /__epcomhil_server_config (JSON)     → 设置连接参数
//   GET  /__epcomhil_sim_events  (SSE 长连接) → 订阅仿真事件流（phase/line/exit）
//   POST /__epcomhil_sim_run      (JSON)      → 发起编译/运行，阻塞到结束返回最终结果
//   POST /__epcomhil_sim_stop                  → 停止当前仿真
// 说明：serverMonitor.cjs 的 runScenario 用的是**模块级单例**（activeRun + 常驻连接），
// 因此这里必须保持"启动时 require 一次、常驻同一实例"，绝不能像状态查询那样清缓存重载，
// 否则事件流/停止会找不到正在运行的那条 SSH 通道。
function serverStatusPlugin(): Plugin {
  return {
    name: 'epcomhil-server-status',
    apply: 'serve',
    configureServer(server) {
      const modPath = path.resolve(process.cwd(), 'electron/serverMonitor.cjs');

      // 工作区里 electron/serverMonitor.cjs 是一次性 Module：Node 进程内的单例
      // （runScenario 需要靠它在各请求之间维持 activeRun 常驻状态）。开发时改了它要重启。
      const mod: any = _require(modPath);

      // 收集 POST body 的小工具
      function readJsonBody(req: any): Promise<any> {
        return new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (e) { reject(e); }
          });
          req.on('error', reject);
        });
      }

      // ---- 浏览器仿真桥：SSE 事件广播（一个长连接订阅全部事件）----
      // runScenario 的 onEvent 回调会把事件实时投递给这里保存的活跃 SSE 响应。
      // 浏览器端先 GET 建立连接，再 POST run；事件边到边喂回 runtime store。
      let sseRes: any = null;
      function sseWrite(obj: unknown) {
        if (!sseRes || sseRes.destroyed) return;
        try { sseRes.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) { /* ignore */ }
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();

        // SSE 长连接：订阅仿真事件流
        if (req.url.startsWith('/__epcomhil_sim_events')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(`data: ${JSON.stringify({ type: 'phase', phase: 'connecting', detail: '已订阅浏览器事件流' })}\n\n`);
          sseRes = res;
          req.on('close', () => { if (sseRes === res) sseRes = null; });
          return;
        }

        if (req.url.startsWith('/__epcomhil_server_config') && req.method === 'POST') {
          try {
            const body = await readJsonBody(req);
            const allowed = ['host', 'port', 'username', 'password', 'readyTimeout'];
            const clean: any = {};
            for (const k of allowed) if (k in body) clean[k] = body[k];
            const config = mod.setConfig(clean);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, config }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, reason: String((e as Error)?.message || e) }));
          }
          return;
        }

        // 发起编译/运行：阻塞到结束返回最终结果（Electron 的 runSim 同样如此语义），
        // 期间的 phase/line/exit 事件经上面的 SSE 实时推送。
        if (req.url.startsWith('/__epcomhil_sim_run') && req.method === 'POST') {
          try {
            const body = await readJsonBody(req);
            const allowed = ['scenarioName', 'cpp', 'mode', 'taps', 'buildOnly'];
            const clean: any = {};
            for (const k of allowed) if (k in body) clean[k] = body[k];
            // 事件同时写 SSE（供实时 UI）；最终结果作为 POST 响应返回（供 runSim 收尾）
            let result: any;
            try {
              result = await mod.runScenario(clean, (evt: any) => sseWrite(evt));
            } catch (e) {
              result = { ok: false, error: String((e as Error)?.message || e) };
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }));
          }
          return;
        }

        if (req.url.startsWith('/__epcomhil_sim_stop') && req.method === 'POST') {
          try {
            const result = await mod.stopRun();
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }));
          }
          return;
        }

        if (!req.url.startsWith('/__epcomhil_server_status')) return next();
        try {
          const status = await mod.fetchServerStatus();
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(status));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message || e), fetchedAt: new Date().toISOString(), hostIp: '' }));
        }
      });
    },
  };
}

// 渲染进程构建：root 指向 src/renderer，产物输出到外层 dist-renderer 供 Electron 加载
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [vue(), sceneRevealPlugin(), serverStatusPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@gen': fileURLToPath(new URL('./src/generator', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
  },
});