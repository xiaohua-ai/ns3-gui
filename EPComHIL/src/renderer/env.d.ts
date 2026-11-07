/// <reference types="vite/client" />

// Vite 的 *.tc?raw 导入（自带案例库工程文件为原始文本载荷），与磁盘文件逐字符一致
declare module '*?raw' {
  const src: string;
  export default src;
}

// token requirements 导出的工程文件
declare module '*.tc' {
  const src: string;
  export default src;
}

// ====================================================================================
// 渲染进程桥接类型：electron/preload.cjs 通过 contextBridge 暴露在 window.epcomhil 上。
// 保持与 preload.cjs 的暴露项一一对应。
// ====================================================================================
interface Window {
  epcomhil?: {
    exportProject: (payload: import('@gen/exportPlan').ExportPlan) => Promise<{
      ok: boolean;
      root?: string;
      files?: { relPath: string; content: string }[];
      reason?: string;
    }>;
    saveProjectFile: (payload: {
      content: string;
      suggestedName: string;
    }) => Promise<{ ok: boolean; path?: string; reason?: string }>;
    saveProjectFileDirect: (payload: { path: string; content: string }) => Promise<{ ok: boolean; path?: string; reason?: string }>;
    openProjectFile: () => Promise<{ ok: boolean; path?: string; content?: string; reason?: string }>;
    saveRuntimeResult: (payload: { content: string; suggestedName?: string }) => Promise<{ ok: boolean; path?: string; reason?: string }>;
    openRuntimeResult: () => Promise<{ ok: boolean; path?: string; fileName?: string; content?: string; reason?: string }>;
    /** 运行结果写入工程所在文件夹（主进程记忆的 currentProjectDir）；无文件夹时返回 reason:'no-project-dir' */
    saveRuntimeResultInProject: (payload: { content: string; baseName: string }) => Promise<{ ok: boolean; path?: string; fileName?: string; reason?: string }>;
    /** 列出工程文件夹内的运行结果文件 */
    listRuntimeResults: () => Promise<{ ok: boolean; dir?: string; files?: { name: string; mtime: number; size: number }[]; reason?: string }>;
    /** 按文件名读取工程文件夹内的某个运行结果 */
    readRuntimeResult: (payload: { name: string }) => Promise<{ ok: boolean; path?: string; fileName?: string; content?: string; reason?: string }>;
    quitApp: () => Promise<{ ok: boolean }>;
    /** dirty 上报：主进程据此在点 X 关窗时弹原生确认框 */
    setDirty: (v: boolean) => void;
    /** 主进程「保存并关闭」请求（用户在关窗确认框选了保存）；返回解绑函数 */
    onSaveAndClose: (cb: () => void) => () => void;
    /** 渲染进程存盘成功后请求真正关窗 */
    confirmClose: () => Promise<{ ok: boolean }>;
    listScenes: () => Promise<{
      ok: boolean;
      path?: string;
      folders?: { name: string; files: { name: string; rel: string }[] }[];
    }>;
    loadScene: (rel: string) => Promise<{ ok: boolean; content?: string; reason?: string }>;
    /** 场景文件夹操作：属性 / 重命名 / 删除 / 打开所在位置 / 复制路径 */
    statSceneFolder: (name: string) => Promise<{ ok: boolean; name?: string; abs?: string; files?: number; size?: number; reason?: string }>;
    renameSceneFolder: (oldName: string, newName: string) => Promise<{ ok: boolean; reason?: string }>;
    deleteSceneFolder: (name: string) => Promise<{ ok: boolean; reason?: string }>;
    revealSceneFolder: (name: string) => Promise<{ ok: boolean; reason?: string }>;
    copyScenePath: (name: string) => Promise<{ ok: boolean; abs?: string; reason?: string }>;
    /** 场景文件操作（文件夹内具体 .tc/.json 工程文件）：属性 / 重命名 / 删除 / 打开所在位置 / 复制路径 */
    statSceneFile: (folder: string, name: string) => Promise<{ ok: boolean; name?: string; abs?: string; size?: number; mtime?: number; ext?: string; reason?: string }>;
    renameSceneFile: (folder: string, oldName: string, newName: string) => Promise<{ ok: boolean; reason?: string }>;
    deleteSceneFile: (folder: string, name: string) => Promise<{ ok: boolean; reason?: string }>;
    revealSceneFile: (folder: string, name: string) => Promise<{ ok: boolean; reason?: string }>;
    copySceneFilePath: (folder: string, name: string) => Promise<{ ok: boolean; abs?: string; reason?: string }>;
    /** Linux 仿真服务器状态（SSH 采集，主进程 serverMonitor.cjs） */
    getServerStatus: () => Promise<ServerStatus>;
    getServerStatusTarget: () => Promise<{ host: string; port: number; username: string }>;
    setServerConfig: (patch: { host?: string; port?: number; username?: string; password?: string }) => Promise<{ ok: boolean; config?: { host: string; port: number; username: string }; reason?: string }>;
    /** 仿真运行（流式）：上传产物 → 目标级构建 → 运行；过程事件经 onSimEvent 推来 */
    runSim: (payload: SimRunPayload) => Promise<SimRunResult>;
    /** 停止当前仿真 */
    stopSim: () => Promise<{ ok: boolean; error?: string; scenario?: string }>;
    /** 是否已有仿真在跑（单选互斥） */
    simIsRunning: () => Promise<{ running: boolean }>;
    /** 订阅运行过程事件（phase / 输出行 / 退出码）；返回解绑函数 */
    onSimEvent: (cb: (evt: SimRunEvent) => void) => () => void;
  };
}

/** runSim 入参：产物 + 运行模式（与 electron/main.cjs 的 'sim:run' 处理器一一对应） */
interface SimRunPayload {
  scenarioName: string;
  cpp: string;
  mode: SimMode;
  /** HIL 半实物 tap 名：用于运行前置检查（tap 必须存在且 UP） */
  taps?: string[];
  /** true = 只构建不运行（拓扑页「编译」按钮） */
  buildOnly?: boolean;
}

interface SimRunResult {
  ok: boolean;
  error?: string;
  scenario?: string;
  mode?: 'OFFLINE' | 'HIL';
  exitCode?: number;
  duration?: string;
  buildOnly?: boolean;
}

/** 运行过程事件（主进程 → 渲染进程） */
type SimRunEvent =
  | { type: 'phase'; phase: 'connecting' | 'uploading' | 'building' | 'precheck' | 'running' | 'done' | 'error'; detail?: string }
  | { type: 'line'; stream: 'out' | 'err'; text: string }
  | { type: 'exit'; code: number };

/** Linux 仿真服务器状态（与 electron/serverMonitor.cjs 返回体一一对应） */
interface ServerStatus {
  ok: boolean;
  error?: string;
  fetchedAt: string;
  hostIp: string;
  hostname: string;
  kernel: string;
  cores: number;
  cpuModel: string;
  mhz: { avg: number; min: number; max: number } | null;
  mem: { totalMB: number; usedMB: number; freeMB: number; availMB: number; usedPct: number } | null;
  load: number[] | null;
  uptime: string;
  connState: 'normal' | 'busy';
  simRunning: boolean;
  simProcs: string[];
}