// EPComHIL Electron 主进程（CommonJS）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { fetchServerStatus, setConfig, getConfig, runScenario, stopRun, isRunning, cfg } = require('./serverMonitor.cjs');

const isDev = Boolean(process.env.ELECTRON_START_URL);

// 关窗防护状态：渲染进程实时上报 dirty；allowClose 表示本轮 close 已获用户许可
let rendererDirty = false;
let allowClose = false;
let mainWindow = null;

// 当前工程的磁盘目录：由 project:save / project:saveDirect / project:open 确立。
// 运行结果文件（.runtime.json）写入此目录，使「保存结果」落到工程文件夹而非弹对话框或下载。
// 渲染进程侧有镜像（utils/projectStorage 的 currentProjectDir）用于 UI 文案判断；两处均在
// 上述三个落盘/打开入口同步，保证「工程文件夹」单一来源。
let currentProjectDir = '';

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#15181c',
    autoHideMenuBar: true,
    title: 'EPComHIL',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // dirty 时拦下点 X / Alt+F4：原生三选框（保存并关闭 / 不保存 / 取消）
  win.on('close', (e) => {
    if (allowClose || !rendererDirty) return;
    e.preventDefault();
    const { dialog } = require('electron');
    dialog
      .showMessageBox(win, {
        type: 'warning',
        title: '未保存的更改',
        message: '当前工程有未保存的更改，关闭前要保存吗？',
        buttons: ['保存并关闭', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 2 || win.isDestroyed()) return; // 取消：留在应用
        if (response === 1) {
          allowClose = true;
          win.close();
          return;
        }
        // 保存并关闭：渲染进程存盘，成功后回调 app:confirm-close 真正关窗；
        // 保存被取消或失败则留在应用，用户可重试或再选不保存
        win.webContents.send('app:save-and-close');
      });
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_START_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist-renderer/index.html'));
  }
  mainWindow = win;
  return win;
}

// W8 导出写盘：渲染进程产出导出清单（planExport），主进程只负责按清单落盘。
// 内容生成逻辑（.cc / CMakeLists / README / JSON）全部由 src/generator/outputWriter.ts 单一来源提供，
// 主进程不再自带任何生成逻辑，避免与单测覆盖的实现漂移。
ipcMain.handle('export:write', async (_evt, payload) => {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { rootName, files } = payload || {};
  if (typeof rootName !== 'string' || !rootName || !Array.isArray(files) || files.length === 0) {
    return { ok: false, reason: 'bad payload' };
  }
  const choice = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (choice.canceled || !choice.filePaths[0]) return { ok: false, reason: 'cancelled' };
  const root = path.resolve(choice.filePaths[0], rootName);
  for (const f of files) {
    const rel = String((f && f.relPath) || '');
    const abs = path.resolve(root, rel);
    // 路径逃逸防护：清单内文件必须落在工程根之下
    if (!abs.startsWith(root + path.sep)) return { ok: false, reason: `illegal path: ${rel}` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String((f && f.content) ?? ''), 'utf8');
  }
  return { ok: true, root };
});

// 工程文件读写：主进程只负责「选路径 + 读写原始文本」，序列化/解析全在渲染进程
// （src/core/projectFile.ts）。主进程不自带任何格式逻辑，理由同 export:write。
ipcMain.handle('project:save', async (_evt, payload) => {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const { content, suggestedName } = payload || {};
  if (typeof content !== 'string') return { ok: false, reason: 'bad payload' };
  const choice = await dialog.showSaveDialog({
    defaultPath: String(suggestedName || 'project.tc'),
    filters: [{ name: 'EPComHIL 工程', extensions: ['tc', 'json'] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: false, reason: 'cancelled' };
  try {
    fs.writeFileSync(choice.filePath, content, 'utf8');
    currentProjectDir = path.dirname(choice.filePath); // 确立工程文件夹
    return { ok: true, path: choice.filePath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

ipcMain.handle('project:open', async () => {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const choice = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'EPComHIL 工程', extensions: ['tc', 'json'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return { ok: false, reason: 'cancelled' };
  try {
    currentProjectDir = path.dirname(choice.filePaths[0]); // 打开即从磁盘载入工程，确立工程文件夹
    return { ok: true, path: choice.filePaths[0], content: fs.readFileSync(choice.filePaths[0], 'utf8') };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 静默保存：「保存」记住上次路径后直接覆写，不再弹对话框（「另存为」才强制弹窗）。
// 路径只信任渲染进程记下的 project:save 返回值，这里不收任意路径之外的语义。
ipcMain.handle('project:saveDirect', async (_evt, payload) => {
  const fs = require('node:fs');
  const { path: filePath, content } = payload || {};
  if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') return { ok: false, reason: 'bad payload' };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    currentProjectDir = path.dirname(filePath); // 静默覆写仍在该工程文件夹内
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// Runtime 运行结果文件读写：与工程文件同构 —— 主进程只「选路径 + 读写原始文本」，
// 序列化/反序列化全在渲染进程（src/core/runtimeResult.ts），遵守「主进程不带格式逻辑」约定。
ipcMain.handle('runtime:saveResult', async (_evt, payload) => {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const { content, suggestedName } = payload || {};
  if (typeof content !== 'string') return { ok: false, reason: 'bad payload' };
  const choice = await dialog.showSaveDialog({
    defaultPath: String(suggestedName || 'run-result.runtime.json'),
    filters: [{ name: 'Runtime 运行结果', extensions: ['json'] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: false, reason: 'cancelled' };
  try {
    fs.writeFileSync(choice.filePath, content, 'utf8');
    return { ok: true, path: choice.filePath };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

ipcMain.handle('runtime:openResult', async () => {
  const { dialog } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const choice = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Runtime 运行结果', extensions: ['json'] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return { ok: false, reason: 'cancelled' };
  try {
    const p = choice.filePaths[0];
    return { ok: true, path: p, fileName: path.basename(p), content: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 渲染进程请求退出（文件菜单「退出」；未保存拦截在渲染进程做，主进程只管退出）
ipcMain.handle('app:quit', () => {
  // 菜单退出前渲染进程已用 ElMessageBox 确认过（含未保存文案），放行避免原生框二次弹
  allowClose = true;
  app.quit();
  return { ok: true };
});

// dirty 状态上报：点 X / Alt+F4 的关窗拦截依据
ipcMain.on('app:dirty', (_evt, v) => {
  rendererDirty = Boolean(v);
});

// 「保存并关闭」完成回调：渲染进程存盘成功后请求真正关窗
ipcMain.handle('app:confirm-close', () => {
  allowClose = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { ok: true };
});

// Linux 仿真服务器状态：渲染进程点击右上角「服务器状态」齿轮时调用。
// 采集逻辑全部在 serverMonitor.cjs（单一职责），主进程只负责转发。
ipcMain.handle('server:status', async () => {
  return fetchServerStatus();
});

// 采集目标（只读信息，供渲染层展示连接地址）
ipcMain.handle('server:statusTarget', async () => {
  return { host: cfg.host, port: cfg.port, username: cfg.username };
});

// 动态设置 SSH 连接参数（用户在界面上改完后调用，改完立即生效）
ipcMain.handle('server:setConfig', async (_evt, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'bad payload' };
  // 只允许白名单字段，防注入
  const allowed = ['host', 'port', 'username', 'password', 'readyTimeout'];
  const clean = {};
  for (const k of allowed) if (k in patch) clean[k] = patch[k];
  const result = setConfig(clean);
  return { ok: true, config: result };
});

// 仿真运行（流式）：上传产物 → 目标级构建 → 运行 → 逐块回推输出。
// 输出经 'sim:event' 推给**发起窗口**（不是广播），多窗口并存时不会串台。
// 平台侧的解析（stdout → RuntimeEvent）不在主进程做 —— 主进程只搬字节，
// 保证「解析规则」只有 src/core/simOutput.ts 一处实现。
ipcMain.handle('sim:run', async (evt, payload) => {
  const sender = evt.sender;
  const push = (e) => {
    if (!sender.isDestroyed()) sender.send('sim:event', e);
  };
  return runScenario(payload || {}, push);
});

// 停止当前仿真（信号 + 按二进制名兜底 kill，两条路一起走）
ipcMain.handle('sim:stop', async () => {
  return stopRun();
});

// 是否已有仿真在跑（单选互斥：同一时刻只允许一个产物占用仿真机）
ipcMain.handle('sim:running', async () => {
  return { running: isRunning() };
});

// 自带案例库目录：优先打包资源目录，开发/未打包时回退到工程根下的 scenarios
function scenesDir() {
  const fs = require('node:fs');
  const candidates = [
    path.join(process.resourcesPath, 'scenarios'),
    path.join(app.getAppPath(), 'scenarios'),
  ];
  for (const dir of candidates) if (fs.existsSync(dir)) return dir;
  return candidates[1];
}

// 自带案例库：列出 scenarios 下的用例文件夹（每例一个文件夹），并返回每个文件夹内的工程文件。
// 文件相对路径（folder/file）供 scenes:load 读取，内容解析仍走渲染进程 projectFile.ts
ipcMain.handle('scenes:list', async () => {
  const fs = require('node:fs');
  const root = scenesDir();
  try {
    const folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map((dir) => {
        const fdir = path.join(root, dir.name);
        const files = fs
          .readdirSync(fdir)
          .filter((f) => /\.(tc|json)$/i.test(f))
          .sort()
          .map((name) => ({ name, rel: path.join(dir.name, name) }));
        return { name: dir.name, files };
      });
    return { ok: true, path: root, folders };
  } catch {
    return { ok: true, path: root, folders: [] };
  }
});

// 自带案例库：读取指定工程文件文本（只允许落在 scenarios 目录内的相对路径，防止路径逃逸）
ipcMain.handle('scenes:load', async (_evt, rel) => {
  const fs = require('node:fs');
  const root = scenesDir();
  const abs = path.resolve(root, String(rel || ''));
  const ext = path.extname(abs).toLowerCase();
  if (!abs.startsWith(root + path.sep) || !['.tc', '.json'].includes(ext)) {
    return { ok: false, reason: 'illegal path' };
  }
  try {
    return { ok: true, content: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 自带案例库：文件夹名必须是单段（不得含路径分隔符），解析后须仍落在 scenarios 根内，防路径逃逸
function sceneFolderPath(name) {
  const root = scenesDir();
  if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
  const abs = path.resolve(root, name);
  if (abs !== path.join(root, name)) return null;
  return root;
}

// 属性：返回文件夹名称、绝对路径、工程文件数与占用大小
ipcMain.handle('scenes:statFolder', async (_evt, name) => {
  const fs = require('node:fs');
  const root = sceneFolderPath(name);
  if (!root) return { ok: false, reason: 'illegal path' };
  const fdir = path.join(root, name);
  try {
    const entries = fs.readdirSync(fdir);
    const files = entries
      .filter((f) => /\.(tc|json)$/i.test(f))
      .sort();
    let size = 0;
    for (const f of files) size += fs.statSync(path.join(fdir, f)).size;
    return { ok: true, name, abs: fdir, files: files.length, size };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 重命名：校验新名合法，且不与既有文件夹冲突
ipcMain.handle('scenes:renameFolder', async (_evt, payload) => {
  const fs = require('node:fs');
  const { oldName, newName } = payload || {};
  const root = sceneFolderPath(oldName);
  const newRoot = sceneFolderPath(newName);
  if (!root || !newRoot) return { ok: false, reason: 'illegal name' };
  const from = path.join(root, oldName);
  const to = path.join(root, newName);
  try {
    if (fs.existsSync(to)) return { ok: false, reason: '同名文件夹已存在' };
    fs.renameSync(from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 删除：整目录递归删除（删除前渲染进程须弹确认框）
ipcMain.handle('scenes:deleteFolder', async (_evt, name) => {
  const fs = require('node:fs');
  const root = sceneFolderPath(name);
  if (!root) return { ok: false, reason: 'illegal path' };
  try {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 打开所在位置：系统文件管理器定位到该文件夹
ipcMain.handle('scenes:revealFolder', async (_evt, name) => {
  const root = sceneFolderPath(name);
  if (!root) return { ok: false, reason: 'illegal path' };
  const { shell } = require('electron');
  shell.showItemInFolder(path.join(root, name));
  return { ok: true };
});

// 复制路径：把文件夹绝对路径写入剪贴板
ipcMain.handle('scenes:copyPath', async (_evt, name) => {
  const root = sceneFolderPath(name);
  if (!root) return { ok: false, reason: 'illegal path' };
  const { clipboard } = require('electron');
  const abs = path.join(root, name);
  clipboard.writeText(abs);
  return { ok: true, abs };
});

// 自带案例库：工程文件路径校验。folder 必须是单段、name 不得含路径分隔符，
// 解析后须落在 scenarios/<folder> 内，防路径逃逸。
function sceneFilePath(folder, name) {
  const root = sceneFolderPath(folder);
  if (!root) return null;
  if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
  const abs = path.resolve(root, folder, name);
  if (abs !== path.join(root, folder, name)) return null;
  return abs;
}

// 文件属性：名称、绝对路径、字节大小、最后修改时间、扩展名
ipcMain.handle('scenes:statFile', async (_evt, payload) => {
  const fs = require('node:fs');
  const { folder, name } = payload || {};
  const abs = sceneFilePath(folder, name);
  if (!abs) return { ok: false, reason: 'illegal path' };
  try {
    const st = fs.statSync(abs);
    return { ok: true, name, abs, size: st.size, mtime: st.mtimeMs, ext: path.extname(name) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 重命名：新名无扩展名时自动补回原扩展名（避免改名后从 .tc/.json 过滤列表消失）
ipcMain.handle('scenes:renameFile', async (_evt, payload) => {
  const fs = require('node:fs');
  const { folder, oldName, newName } = payload || {};
  const from = sceneFilePath(folder, oldName);
  if (!from) return { ok: false, reason: 'illegal path' };
  let toName = String(newName || '').trim();
  if (!toName) return { ok: false, reason: '文件名为空' };
  if (!path.extname(toName)) toName += path.extname(oldName);
  const to = sceneFilePath(folder, toName);
  if (!to) return { ok: false, reason: 'illegal name' };
  try {
    if (fs.existsSync(to)) return { ok: false, reason: '同名文件已存在' };
    fs.renameSync(from, to);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 删除：删除前渲染进程须弹确认框
ipcMain.handle('scenes:deleteFile', async (_evt, payload) => {
  const fs = require('node:fs');
  const { folder, name } = payload || {};
  const abs = sceneFilePath(folder, name);
  if (!abs) return { ok: false, reason: 'illegal path' };
  try {
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 打开所在位置：系统文件管理器定位到该文件
ipcMain.handle('scenes:revealFile', async (_evt, payload) => {
  const { folder, name } = payload || {};
  const abs = sceneFilePath(folder, name);
  if (!abs) return { ok: false, reason: 'illegal path' };
  const { shell } = require('electron');
  shell.showItemInFolder(abs);
  return { ok: true };
});

// 复制路径：把文件绝对路径写入剪贴板
ipcMain.handle('scenes:copyPathFile', async (_evt, payload) => {
  const { folder, name } = payload || {};
  const abs = sceneFilePath(folder, name);
  if (!abs) return { ok: false, reason: 'illegal path' };
  const { clipboard } = require('electron');
  clipboard.writeText(abs);
  return { ok: true, abs };
});

// 运行结果写入「工程所在文件夹」：currentProjectDir 由 project:save/open 确立，这里只做落盘。
// 内容序列化仍由渲染进程（runtimeResult.ts）负责，主进程不碰格式；文件名强制 .runtime.json 且
// 只许单段（防路径逃逸），与 runtime:saveResult 的「弹对话框」形成对照——本入口用于「静默入工程文件夹」。
ipcMain.handle('runtime:saveResultInProject', async (_evt, payload) => {
  const fs = require('node:fs');
  const { content, baseName } = payload || {};
  if (typeof content !== 'string' || !baseName) return { ok: false, reason: 'bad payload' };
  if (!currentProjectDir) return { ok: false, reason: 'no-project-dir' };
  let name = String(baseName);
  if (!/^[^\\/]+$/.test(name) || name.includes('..')) return { ok: false, reason: 'bad name' };
  if (!name.toLowerCase().endsWith('.runtime.json')) name += '.runtime.json';
  const abs = path.join(currentProjectDir, name);
  if (abs !== path.join(currentProjectDir, name)) return { ok: false, reason: 'bad name' };
  try {
    fs.writeFileSync(abs, content, 'utf8');
    return { ok: true, path: abs, fileName: name };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 列出工程文件夹内的运行结果文件（按修改时间倒序），供「历史结果」面板展示
ipcMain.handle('runtime:listResults', async () => {
  const fs = require('node:fs');
  if (!currentProjectDir) return { ok: true, dir: '', files: [] };
  try {
    const files = fs
      .readdirSync(currentProjectDir)
      .filter((f) => f.toLowerCase().endsWith('.runtime.json'))
      .map((f) => {
        const st = fs.statSync(path.join(currentProjectDir, f));
        return { name: f, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir: currentProjectDir, files };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

// 按文件名读取工程文件夹内的某个运行结果（文件名只许单段，防逃逸）
ipcMain.handle('runtime:readResult', async (_evt, payload) => {
  const fs = require('node:fs');
  const { name } = payload || {};
  if (typeof name !== 'string' || !/^[^\\/]+$/.test(name) || name.includes('..')) return { ok: false, reason: 'bad name' };
  if (!currentProjectDir) return { ok: false, reason: 'no-project-dir' };
  const abs = path.join(currentProjectDir, name);
  if (abs !== path.join(currentProjectDir, name)) return { ok: false, reason: 'bad name' };
  try {
    return { ok: true, path: abs, fileName: name, content: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});