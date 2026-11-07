// EPComHIL 路由切换冒烟测试：用 Electron 加载 Vite 页面，实际点击左侧菜单，
// 对比点击前后 hash / active / 主内容是否切换，并收集 console 报错，用于定位“切换需刷新才生效”。
const { app, BrowserWindow } = require('electron');

const URL = process.env.SMOKE_URL || 'http://localhost:5173';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const read = (win) =>
  win.webContents.executeJavaScript(`(()=>{
    const active=document.querySelector('.step.active');
    const main=document.querySelector('.main');
    return {
      hash: location.hash,
      active: active? active.textContent.trim() : '',
      main: main? main.innerText.slice(0,80).replace(/\\s+/g,' ') : ''
    };
  })()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  const msgs = [];
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    msgs.push(`[console:${level}] ${message} @${(sourceId||'').split('/').pop()}:${line}`);
  });
  win.webContents.on('render-process-gone', (e, d) => msgs.push(`RENDER-GONE: ${d.reason}`));

  const steps = ['欢迎', '场景与工况', '拓扑建模', '配置', '导出'];
  const log = (...a) => console.log('[SMOKE]', ...a);

  await win.loadURL(`${URL}/#/welcome`);
  await wait(1500);
  const w0 = await read(win);
  log('初始 welcome   ', JSON.stringify(w0));

  let outcome = [];
  for (let i = 1; i <= 4; i++) {
    // 切换到某个菜单再切回，如实反映“随意切换”
    const target = i === 4 ? 3 : i; // 4→配置(3)以测重复切换
    await win.webContents.executeJavaScript(`document.querySelectorAll('.step')[${target}].click()`);
    await wait(700);
    const s = await read(win);
    log(`点击「${steps[target]}」 `, JSON.stringify(s));
    outcome.push({ target, active: s.active, main: s.main });
  }

  // 再验证从任意项连续两次点击同一项
  await win.webContents.executeJavaScript(`document.querySelectorAll('.step')[2].click()`);
  await wait(500);
  await win.webContents.executeJavaScript(`document.querySelectorAll('.step')[2].click()`);
  await wait(500);
  log('连点拓扑×2    ', JSON.stringify(await read(win)));

  // 诊断判定
  // 注意：steps 里是无 emoji 的裸标签（'场景与工况'），而 DOM 文本带 emoji（'📁场景与工况'），
  // 所以只能做包含判断；原先用全等比较，导致「失败项」恒非空、把正常的路由切换误报成坏掉。
  const violated = [];
  for (const o of outcome) {
    if (!o.active.includes(steps[o.target])) violated.push(`点击${steps[o.target]}后 active=${o.active}`);
  }
  log('--- 切换诊断 ---');
  log('失败项: ' + (violated.length ? violated.join(' | ') : '无（active/内容均随点击切换）'));
  log(`main 是否始终同一: ${new Set(outcome.map(o=>o.main)).size <= 1 ? '未变化(疑似不切换)' : '每次不同(正常切换)'}`);
  log('--- console ---');
  (msgs.length ? msgs : ['（无 console 输出）']).forEach((m) => log(m));
  app.exit(0);
});