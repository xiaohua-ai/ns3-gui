// 回归测试（纯 node，不依赖 vitest 的 electron mock 能力）：
// 覆盖 Module._load，向 main.cjs 注入假的 electron，验证「运行结果写入工程文件夹」的 IPC 处理器逻辑，
// 重点守住曾出现的变量遮蔽 bug（project:saveDirect 里 const { path } 覆盖了模块级 path，导致 path.dirname 报错）。
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const handlers = {};
const fakeElectron = {
  ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on: () => {} },
  app: { whenReady: () => new Promise(() => {}), on: () => {} }, // 不 resolve，避免 createWindow 起窗口
  BrowserWindow: class { constructor() {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

// 加载真实主进程（注册全部 ipcMain.handle）
require('../electron/main.cjs');

const tmpProj = path.join(os.tmpdir(), `epcomhil-ipc-${Date.now()}`);
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓', name); }
  else { console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); failures++; }
}

(async () => {
  fs.rmSync(tmpProj, { recursive: true, force: true });
  fs.mkdirSync(tmpProj, { recursive: true });

  // 1) project:saveDirect 确立工程文件夹（修复变量遮蔽）
  const sd = await handlers['project:saveDirect'](null, { path: path.join(tmpProj, 'demo.tc'), content: '{}' });
  check('project:saveDirect 成功且写盘', sd.ok === true && fs.existsSync(path.join(tmpProj, 'demo.tc')), sd);

  // 2) runtime:saveResultInProject 静默写入工程文件夹
  const wr = await handlers['runtime:saveResultInProject'](null, { content: '{"k":1}', baseName: 'r_20260921080009.runtime.json' });
  check('runtime:saveResultInProject 写入工程文件夹', wr.ok === true && fs.existsSync(path.join(tmpProj, 'r_20260921080009.runtime.json')), wr);

  // 3) 路径穿越防护
  const tg = await handlers['runtime:saveResultInProject'](null, { content: 'x', baseName: '../evil.runtime.json' });
  check('runtime:saveResultInProject 拦截 ../ 穿越', tg.ok === false && tg.reason === 'bad name', tg);

  // 4) listResults 列出
  const ls = await handlers['runtime:listResults']();
  check('runtime:listResults 列出工程文件夹且含该文件', ls.ok === true && ls.dir === tmpProj && ls.files.some((f) => f.name === 'r_20260921080009.runtime.json'), ls);

  // 5) readResult 读回
  const rd = await handlers['runtime:readResult'](null, { name: 'r_20260921080009.runtime.json' });
  check('runtime:readResult 读回内容', rd.ok === true && rd.content === '{"k":1}', rd);

  // 6) readResult 越界名受控
  const rb = await handlers['runtime:readResult'](null, { name: '../x.runtime.json' });
  check('runtime:readResult 拦截 ../ 越界', rb.ok === false && rb.reason === 'bad name', rb);

  fs.rmSync(tmpProj, { recursive: true, force: true });
  if (failures) { console.error(`\nIPC 回归失败：${failures} 项`); process.exit(1); }
  console.log('\nIPC 回归全部通过');
})().catch((e) => { console.error('IPC 回归异常', e); process.exit(2); });
