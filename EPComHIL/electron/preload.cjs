// EPComHIL 预加载脚本：向渲染进程安全暴露受限能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('epcomhil', {
  // 按导出清单落盘（清单由渲染进程的 planExport 生成，主进程不做内容生成）
  exportProject: (payload) => ipcRenderer.invoke('export:write', payload),
  // 工程文件读写：内容由渲染进程的 projectFile.ts 序列化/解析，主进程只做选路径与读写
  saveProjectFile: (payload) => ipcRenderer.invoke('project:save', payload),
  // 静默保存（文件菜单「保存」记住路径后直接覆写）
  saveProjectFileDirect: (payload) => ipcRenderer.invoke('project:saveDirect', payload),
  openProjectFile: () => ipcRenderer.invoke('project:open'),
  // Runtime 运行结果读写：内容由渲染进程的 runtimeResult.ts 序列化/解析，主进程只做选路径与读写
  saveRuntimeResult: (payload) => ipcRenderer.invoke('runtime:saveResult', payload),
  openRuntimeResult: () => ipcRenderer.invoke('runtime:openResult'),
  // 运行结果写入「工程所在文件夹」（主进程记忆的 currentProjectDir），不弹保存对话框
  saveRuntimeResultInProject: (payload) => ipcRenderer.invoke('runtime:saveResultInProject', payload),
  // 列出工程文件夹内的运行结果文件（供「历史结果」展示）
  listRuntimeResults: () => ipcRenderer.invoke('runtime:listResults'),
  // 按文件名读取工程文件夹内的某个运行结果
  readRuntimeResult: (payload) => ipcRenderer.invoke('runtime:readResult', payload),
  // 退出应用（文件菜单「退出」）
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // 关窗防护：dirty 上报（点 X 时主进程弹原生确认框）+ 「保存并关闭」接管
  setDirty: (v) => ipcRenderer.send('app:dirty', Boolean(v)),
  onSaveAndClose: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:save-and-close', handler);
    return () => ipcRenderer.removeListener('app:save-and-close', handler);
  },
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  // 自带案例库：扫描/读取 scenarios 文件夹内的工程文件（渲染进程只拿文本，解析仍走 projectFile.ts）
  listScenes: () => ipcRenderer.invoke('scenes:list'),
  loadScene: (rel) => ipcRenderer.invoke('scenes:load', rel),
  // 场景文件夹操作：属性 / 重命名 / 删除 / 打开所在位置 / 复制路径
  statSceneFolder: (name) => ipcRenderer.invoke('scenes:statFolder', name),
  renameSceneFolder: (oldName, newName) => ipcRenderer.invoke('scenes:renameFolder', { oldName, newName }),
  deleteSceneFolder: (name) => ipcRenderer.invoke('scenes:deleteFolder', name),
  revealSceneFolder: (name) => ipcRenderer.invoke('scenes:revealFolder', name),
  copyScenePath: (name) => ipcRenderer.invoke('scenes:copyPath', name),
  // 场景文件操作（文件夹内具体 .tc/.json 工程文件）：属性 / 重命名 / 删除 / 打开所在位置 / 复制路径
  statSceneFile: (folder, name) => ipcRenderer.invoke('scenes:statFile', { folder, name }),
  renameSceneFile: (folder, oldName, newName) => ipcRenderer.invoke('scenes:renameFile', { folder, oldName, newName }),
  deleteSceneFile: (folder, name) => ipcRenderer.invoke('scenes:deleteFile', { folder, name }),
  revealSceneFile: (folder, name) => ipcRenderer.invoke('scenes:revealFile', { folder, name }),
  copySceneFilePath: (folder, name) => ipcRenderer.invoke('scenes:copyPathFile', { folder, name }),
  // Linux 仿真服务器状态（SSH 采集）
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  getServerStatusTarget: () => ipcRenderer.invoke('server:statusTarget'),
  setServerConfig: (patch) => ipcRenderer.invoke('server:setConfig', patch),
  // 仿真运行（流式）：runSim 的 Promise 只在**结束后**兑现最终结果；
  // 过程中的 phase / 输出行 / 退出码经 onSimEvent 逐条推来（返回解绑函数）。
  runSim: (payload) => ipcRenderer.invoke('sim:run', payload),
  stopSim: () => ipcRenderer.invoke('sim:stop'),
  simIsRunning: () => ipcRenderer.invoke('sim:running'),
  onSimEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('sim:event', handler);
    return () => ipcRenderer.removeListener('sim:event', handler);
  },
});
