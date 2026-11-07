// EPComHIL Linux 仿真服务器状态采集（SSH）
// 单一职责：通过 ssh2 连接 Linux 仿真机，逐条执行简单命令获取原始输出，在 JS 内解析。
// 刻意避免「拼接大命令 + 分隔符切分」的脆弱做法——每条指标独立 exec，互不污染。
// 连接参数：启动时从环境变量读默认值，运行时可通过 setConfig() 动态覆盖（界面上改完立即生效）。
const { Client } = require('ssh2');

const defaultCfg = {
  host: process.env.EPCOMHIL_SRV_HOST || '172.24.4.10',
  port: Number(process.env.EPCOMHIL_SRV_PORT || 22),
  username: process.env.EPCOMHIL_SRV_USER || 'root',
  password: process.env.EPCOMHIL_SRV_PASS || 'ASDqwe123!@#',
  readyTimeout: Number(process.env.EPCOMHIL_SRV_TIMEOUT || 6000),
};

// 运行时可被 setConfig 覆盖的当前配置
let cfg = { ...defaultCfg };

/**
 * 动态更新连接参数（用户在界面上修改后调用）。
 * 只传需要改的字段即可，其余保持原值。返回更新后的完整配置。
 */
function setConfig(patch) {
  cfg = { ...cfg, ...(patch || {}) };
  if (cfg.port != null) cfg.port = Number(cfg.port) || 22;
  if (cfg.readyTimeout != null) cfg.readyTimeout = Number(cfg.readyTimeout) || 6000;
  return { host: cfg.host, port: cfg.port, username: cfg.username };
}

function getConfig() {
  return { host: cfg.host, port: cfg.port, username: cfg.username };
}

// 单次 exec：收集 stdout，带超时兜底
function exec(conn, cmd, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; try { stream.close(); } catch (_) { /* ignore */ } reject(new Error(`exec 超时: ${cmd.slice(0, 40)}`)); }
      }, timeoutMs);
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', () => { /* 丢弃 stderr */ });
      stream.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } });
      stream.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  });
}

// 顺序跑一组命令，返回 { name -> stdout }
async function runAll(conn) {
  const commands = {
    hostname: 'hostname',
    kernel: 'uname -s -r -m',
    cores: 'nproc',
    model: "grep -m1 'model name' /proc/cpuinfo",
    mhz: "grep 'cpu MHz' /proc/cpuinfo",
    mem: 'free -m',
    load: 'cat /proc/loadavg',
    uptime: 'cat /proc/uptime',
    sim: "ps -eo comm,args | grep -iE 'ns3|scratch|waf ' | grep -v grep | head -6",
  };
  const out = {};
  for (const [name, cmd] of Object.entries(commands)) {
    const { out: text } = await exec(conn, cmd, 8000);
    out[name] = String(text || '').trim();
  }
  return out;
}

// 逐条解析原始输出 -> 结构化状态
function parse(raw) {
  const s = { cores: 0, model: '', mhz: null, mem: null, load: null, uptime: '', simProcs: [], hostname: '', kernel: '' };

  s.hostname = raw.hostname || '';
  s.kernel = raw.kernel || '';
  s.cores = parseInt(raw.cores, 10) || 0;

  const modelLine = raw.model || '';
  const afterColon = modelLine.indexOf(':');
  s.model = (afterColon >= 0 ? modelLine.slice(afterColon + 1) : modelLine).replace(/\s+/g, ' ').trim();

  const mhzVals = (raw.mhz || '')
    .split('\n')
    .map((l) => { const i = l.lastIndexOf(':'); return parseFloat(i >= 0 ? l.slice(i + 1) : l); })
    .filter((n) => Number.isFinite(n) && n > 0);
  if (mhzVals.length) {
    const avg = mhzVals.reduce((a, b) => a + b, 0) / mhzVals.length;
    s.mhz = { avg: Math.round(avg), min: Math.round(Math.min(...mhzVals)), max: Math.round(Math.max(...mhzVals)) };
  }

  const memLine = (raw.mem || '').split('\n').find((l) => l.startsWith('Mem:'));
  if (memLine) {
    const p = memLine.trim().split(/\s+/).slice(1).map(Number); // 去掉 'Mem:'，列序: total used free shared buff/cache available
    if (p.length >= 4 && p[0]) {
      const totalMB = p[0], usedMB = p[1], freeMB = p[2];
      const availMB = p.length >= 6 ? p[5] : usedMB;
      s.mem = { totalMB, usedMB, freeMB, availMB, usedPct: Math.round(((usedMB / totalMB) * 1000)) / 10 };
    }
  }

  const load = (raw.load || '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  if (load.length >= 3) s.load = [load[0], load[1], load[2]];

  const secs = parseFloat((raw.uptime || '').split(/\s+/)[0]);
  if (Number.isFinite(secs)) {
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    s.uptime = `${d}d ${h}h ${m}m`;
  }

  s.simProcs = (raw.sim || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return s;
}

/**
 * 返回 { ok:true, ...stats } 或 { ok:false, error }
 */
async function fetchServerStatus() {
  const conn = new Client();
  const header = { hostIp: cfg.host };
  const finish = (extra) => { try { conn.end(); } catch (_) { /* ignore */ } return extra; };

  const ready = () => new Promise((resolve, reject) => { conn.once('ready', resolve); conn.once('error', reject); });

  return new Promise((resolve) => {
    conn.connect(cfg);
    ready()
      .then(() => runAll(conn))
      .then((raw) => {
        const s = parse(raw);
        const busy = Boolean(s.mem && s.mem.usedPct > 95) || Boolean(s.load && s.load[0] > s.cores * 0.9);
        resolve(finish({
          ok: true,
          fetchedAt: new Date().toISOString(),
          hostIp: header.hostIp,
          hostname: s.hostname,
          kernel: s.kernel,
          cores: s.cores,
          cpuModel: s.model,
          mhz: s.mhz,
          mem: s.mem,
          load: s.load,
          uptime: s.uptime,
          connState: busy ? 'busy' : 'normal',
          simRunning: s.simProcs.length > 0,
          simProcs: s.simProcs,
        }));
      })
      .catch((err) => resolve(finish({
        ok: false,
        error: String((err && err.message) || err),
        fetchedAt: new Date().toISOString(),
        hostIp: header.hostIp,
      })));
  });
}

module.exports = { fetchServerStatus, setConfig, getConfig, runScenario, stopRun, isRunning, cfg: { get host() { return cfg.host; }, get port() { return cfg.port; }, get username() { return cfg.username; } } };

// ============================================================================
// 仿真编译 & 运行
// ============================================================================

// 建立 SSH 连接（复用 connect 逻辑）
function connect(timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const t = setTimeout(() => { try { conn.end(); } catch (_) {} reject(new Error('SSH 连接超时')); }, timeoutMs || 8000);
    conn.on('ready', () => { clearTimeout(t); resolve(conn); })
        .on('error', (e) => { clearTimeout(t); reject(e); })
        .connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: timeoutMs || 8000 });
  });
}

// 递归创建远程目录（sftp 没有 mkdir -p，自己拼）
function sftpMkdirp(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    const parts = dirPath.split('/').filter(Boolean);
    let cur = '';
    let i = 0;
    function next() {
      if (i >= parts.length) return resolve();
      cur += '/' + parts[i++];
      sftp.stat(cur, (err) => {
        if (!err) return next(); // 已存在
        sftp.mkdir(cur, (e2) => {
          if (e2) return reject(new Error(`创建目录失败 ${cur}: ${e2.message}`));
          next();
        });
      });
    }
    next();
  });
}

// 查找 ns-3 根目录（优先环境变量；否则探常见路径；最后用 find 全盘搜）
async function findNs3Root(conn) {
  const candidates = [
    process.env.EPCOMHIL_NS3_ROOT || '',
    '/root/ns-allinone-3.38/ns-3.38',
    '/root/ns-3.38',
    '/home/ns3/ns-3.38',
    '/home/roo/ns-allinone-3.38/ns-3.38',
    '/opt/ns-allinone-3.38/ns-3.38',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const { out } = await exec(conn, `test -f "${p}/ns3" && echo OK || echo NO`, 3000);
      if (String(out || '').trim() === 'OK') return p;
    } catch { /* continue */ }
  }
  // 最后兜底：在 /home 和 /root 下找 ns-3.38 目录
  try {
    const { out } = await exec(conn, 'find /home /root -maxdepth 4 -name "ns3" -type f -path "*/ns-3.38/*" 2>/dev/null | head -1', 10000);
    const found = String(out || '').trim();
    if (found) return found.replace(/\/ns3$/, '');
  } catch { /* ignore */ }
  return null;
}

// ============================================================================
// 仿真运行（流式）：上传 → 目标级构建 → 运行 → 逐块回推
// ============================================================================
//
// 为什么把旧的 simCompile/simRun/simStop 整体换掉：它们是半成品且**从没接通过**——
//   1) 路径假设 `/root/ns-allinone-3.38/...`，而这台机上实际在 `/home/roo/...`；
//   2) 用 `./ns3` 以 **root** 身份跑，而 `./ns3` 的 `refuse_run_as_root()` 卡在 main() 最开头，
//      连 build 都会被直接拒（只读 USER 环境变量，故必须 `runuser -l roo` 才能真正降权）；
//   3) 运行结果只写远程日志文件，平台侧拿不到任何输出 —— 所以 Runtime 监视台一直是空的。
//
// 现在改成**一条流式通道**：构建与运行的 stdout/stderr 都逐块推给调用方，
// 平台侧边到边解析（src/core/simOutput.ts）边入 store，于是：
//   OFFLINE —— 仿真全速推进，所有遥测瞬间到齐 → Runtime 曲线一次铺满；
//   HIL     —— RealtimeSimulatorImpl 按墙钟推进，遥测逐拍到达 → 曲线随仿真实时滚动。
// 两种查看走的是同一套通道，差别只在投递节奏。

/** 以哪个本地用户跑 `./ns3`（`./ns3` 拒绝 root，必须降权） */
const RUN_USER = process.env.EPCOMHIL_RUN_USER || 'roo';
/** 并发运行上限：同一时刻只允许一个仿真，避免两个产物抢同一台机、互相污染 scratch */
let activeRun = null;

/** 只留字母数字下划线短横 —— 场景名/tap 名会进 shell 串，必须先净化（防注入） */
function safeName(s) {
  return String(s == null ? '' : s).replace(/[^\w-]/g, '_');
}

function isRunning() {
  return Boolean(activeRun);
}

/**
 * 流式 exec：把 stdout / stderr 逐块交给回调，resolve 为退出码。
 * 刻意**不**合并 `2>&1`：ssh2 的两条通道分开，编译告警/错误才能被平台侧识别成错误级日志；
 * 合并成一条后错误会伪装成普通输出，用户只看到"跑完了"却什么也没出。
 */
function execStream(conn, cmd, opts = {}) {
  const { onOut, onErr, timeoutMs = 0, onStream } = opts;
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve({ code: -1, err: String((err && err.message) || err) });
      let done = false;
      let timer = null;
      const finish = (code) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve({ code });
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { stream.close(); } catch (_) { /* ignore */ }
          finish(-2);
        }, timeoutMs);
      }
      stream.on('data', (d) => { if (onOut) onOut(d.toString()); });
      stream.stderr.on('data', (d) => { if (onErr) onErr(d.toString()); });
      stream.on('close', (code) => finish(code));
      stream.on('error', () => finish(-1));
      if (onStream) onStream(stream);
    });
  });
}

/**
 * HIL 半实物运行前置检查。
 *
 * 这两条是上一轮实测踩出来的硬前置，缺一必崩，且崩的方式极难归因（装载期一行无主日志）：
 *   - tap 不存在 → tap-creator 会新建但**不 UP**，随后往 DOWN 的 tap 写返回 ENETDOWN →
 *     `TapBridge::ReceiveFromBridgedDevice(): Write error.` → NS_ABORT；
 *   - 必须 `ip link set <tap> up`，并汇入物理网口进混杂模式。
 * 在这里拦住，把「一行无主 abort」换成指名到 tap 的可操作提示。
 */
async function checkTaps(conn, taps) {
  for (const t of taps) {
    const { out } = await exec(conn, `ip link show ${t} 2>/dev/null`, 5000);
    const line = String(out || '');
    if (!line.trim()) {
      return {
        ok: false,
        error: `tap 网卡 ${t} 不存在。HIL 半实物运行前置（缺一不可）：\n  ip tuntap add dev ${t} mode tap\n  ip link set ${t} up\n并将各 tap 汇入同一网桥、接上物理网口。`,
      };
    }
    // `ip link show` 首行形如 `4: tap0: <BROADCAST,MULTICAST,UP,LOWER_UP> … state UP …`
    // 注意不能用 includes('UP') 粗判：state DOWN 里含 "DOWN"，但那是 D-O-W-N，不含 U-P，尚可；
    // 真正的坑是 flags 里的 LOWER_UP / 名称本身，故锚定 ` state UP`
    if (!line.includes('state UP')) {
      return {
        ok: false,
        error: `tap 网卡 ${t} 未启用（state 非 UP）。往 DOWN 的 tap 写会 ENETDOWN → TapBridge 写失败 → abort。\n请先执行：ip link set ${t} up`,
      };
    }
  }
  return { ok: true };
}

/**
 * 运行一个场景：上传产物 → 目标级构建 → （可选）运行 → 逐块回推输出。
 *
 * @param {Object} payload
 * @param {string} payload.scenarioName 场景名（只能是安全字符，内部会净化）
 * @param {string} payload.cpp          自包含 ns-3 脚本全文
 * @param {'OFFLINE'|'REALTIME'|'HIL'} [payload.mode]
 * @param {string[]} [payload.taps]     HIL 半实物 tap 名（用于运行前置检查）
 * @param {boolean} [payload.buildOnly] true = 只构建不运行（拓扑页「编译」按钮用）
 * @param {(evt:Object)=>void} onEvent  事件回调：
 *        {type:'phase', phase, detail} | {type:'line', stream:'out'|'err', text} | {type:'exit', code}
 */
async function runScenario(payload, onEvent) {
  const t0 = Date.now();
  const emit = (e) => { try { if (onEvent) onEvent(e); } catch (_) { /* 回调异常不该打断运行 */ } };
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  const p = payload || {};
  const scenario = safeName(p.scenarioName);
  const cpp = typeof p.cpp === 'string' ? p.cpp : '';
  // 模式**只透传，不推导**。
  // 来源唯一：渲染端从工程的运行设置（project.run.mode）取出后原样传到这里；通道只关心
  // 一件事 —— 是不是 HIL（HIL 直跑已构建二进制并做 tap 前置检查，其余走 `./ns3 run`）。
  // 这里曾写过一个三值白名单（`p.mode === 'HIL' ? 'HIL' : (…REALTIME… : 'OFFLINE')`）：
  // 它既造出了第二个"模式来源"，又会在白名单漏项时把 REALTIME 悄悄变成 OFFLINE。
  // 通道跑在独立进程里、加载的是本文件的进程内缓存副本（源码改了必须重启才生效），
  // 任何"自己猜"的逻辑迟早与渲染端漂移，所以这里不猜、也不在阶段行里复述模式。
  const mode = typeof p.mode === 'string' ? p.mode : 'OFFLINE';
  const isHil = mode === 'HIL';
  const taps = Array.isArray(p.taps) ? p.taps.map(safeName).filter(Boolean) : [];
  const buildOnly = Boolean(p.buildOnly);

  if (!scenario) return { ok: false, error: '缺少场景名' };
  if (!cpp.trim()) return { ok: false, error: '没有待运行的产物代码（生成结果为空）' };
  if (activeRun) return { ok: false, error: '已有仿真在运行，请先停止' };

  let conn = null;
  try {
    emit({ type: 'phase', phase: 'connecting', detail: `${cfg.host}` });
    conn = await connect(12000);

    const ns3Root = await findNs3Root(conn);
    if (!ns3Root) throw new Error('在仿真机上找不到 ns-3.38 安装目录');
    const targetCc = `${ns3Root}/scratch/${scenario}.cc`;
    // 已构建二进制的相对路径（HIL 直跑用；命名规则来自 ns-3 自身：build/scratch/ns3.<ver>-<target>-<profile>）
    const binRel = `build/scratch/ns3.38-${scenario}-default`;

    activeRun = { conn, stream: null, target: scenario, mode };

    emit({ type: 'phase', phase: 'uploading', detail: targetCc });
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        // scratch/ 一定存在（ns-3 自带），但容错一次以免换机器时踩空
        sftp.stat(`${ns3Root}/scratch`, async (e2) => {
          if (e2) {
            try { await sftpMkdirp(sftp, `${ns3Root}/scratch`); } catch (e3) { return reject(e3); }
          }
          sftp.writeFile(targetCc, cpp, (e4) => {
            if (e4) return reject(new Error(`上传失败: ${e4.message}`));
            resolve();
          });
        });
      });
    });

    emit({ type: 'phase', phase: 'building', detail: scenario });
    // 目标级构建：只编这一条 scratch 目标及其依赖。
    // 不用 `./ns3 build`（全树）—— scratch/ 里别人的历史 .cc 会被一起编，白白拖慢每次运行。
    const buildCmd = `runuser -l ${RUN_USER} -c 'cd ${ns3Root} && ./ns3 build ${scenario}'`;
    const b = await execStream(conn, buildCmd, {
      onOut: (s) => emit({ type: 'line', stream: 'out', text: s }),
      onErr: (s) => emit({ type: 'line', stream: 'err', text: s }),
      timeoutMs: 600000,
      onStream: (st) => { if (activeRun) activeRun.stream = st; },
    });
    if (b.code !== 0) {
      emit({ type: 'exit', code: b.code });
      emit({ type: 'phase', phase: 'error', detail: `构建失败（exit ${b.code}）` });
      return { ok: false, scenario, exitCode: b.code, duration: secs(), error: `构建失败（exit ${b.code}）` };
    }

    if (buildOnly) {
      emit({ type: 'exit', code: 0 });
      emit({ type: 'phase', phase: 'done', detail: '构建完成' });
      return { ok: true, scenario, buildOnly: true, duration: secs() };
    }

    if (isHil && taps.length) {
      emit({ type: 'phase', phase: 'precheck', detail: taps.join(', ') });
      const chk = await checkTaps(conn, taps);
      if (!chk.ok) {
        emit({ type: 'exit', code: 3 });
        emit({ type: 'phase', phase: 'error', detail: chk.error });
        return { ok: false, scenario, exitCode: 3, duration: secs(), error: chk.error };
      }
    }

    // 只报**场景名**：模式是"本次会话"的属性，展示层由渲染端 store 统一书写
    // （会话首行 `▶ 开始运行：… · REALTIME` 就是它写的），它才是唯一来源。
    // 此处曾写 `${scenario} · ${mode}` —— 而本模块在独立进程里被缓存（改了必须重启才生效），
    // 一旦缓存落后于源码，阶段行的模式名就会与 store 首行打架，用户无从分辨哪个是真的。
    emit({ type: 'phase', phase: 'running', detail: scenario });
    // OFFLINE / REALTIME：产物不含 tap 装配，以 roo 身份经 `./ns3 run`
    //          （./ns3 拒绝 root，且 runuser 的 -l 不能省，否则 USER 环境变量不重置，照样被拒）。
    //          REALTIME 与 OFFLINE 走同一条命令是对的 —— 实时与否由产物里那句
    //          `GlobalValue::Bind("SimulatorImplementationType", …RealtimeSimulatorImpl…)` 决定，
    //          与"怎么启动它"无关。
    // HIL    ：直接跑已构建二进制。TapBridge 建/绑 tap 需要 CAP_NET_ADMIN，必须 root。
    const runCmd =
      isHil
        ? `cd ${ns3Root} && ./${binRel}`
        : `runuser -l ${RUN_USER} -c 'cd ${ns3Root} && ./ns3 run ${scenario}'`;
    const r = await execStream(conn, runCmd, {
      onOut: (s) => emit({ type: 'line', stream: 'out', text: s }),
      onErr: (s) => emit({ type: 'line', stream: 'err', text: s }),
      onStream: (st) => { if (activeRun) activeRun.stream = st; },
    });
    emit({ type: 'exit', code: r.code });
    emit({
      type: 'phase',
      phase: r.code === 0 ? 'done' : 'error',
      detail: r.code === 0 ? `退出码 0 · ${secs()}` : `退出码 ${r.code}`,
    });
    return {
      ok: r.code === 0,
      scenario,
      mode,
      exitCode: r.code,
      duration: secs(),
      error: r.code === 0 ? undefined : `仿真进程退出码 ${r.code}`,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    emit({ type: 'phase', phase: 'error', detail: msg });
    emit({ type: 'exit', code: -1 });
    return { ok: false, scenario, duration: secs(), error: msg };
  } finally {
    activeRun = null;
    if (conn) { try { conn.end(); } catch (_) { /* ignore */ } }
  }
}

/**
 * 停止当前仿真。
 *
 * 两条路一起走：先发 SSH 信号请求（部分 sshd 不转发），再按二进制名兜底 pkill。
 * 单靠前者会「点了停止但进程还在」，单靠后者在有同名历史进程时会误杀。
 */
async function stopRun() {
  const run = activeRun;
  if (!run) return { ok: false, error: '当前没有正在运行的仿真' };
  try {
    if (run.stream) { try { run.stream.signal('INT'); } catch (_) { /* ignore */ } }
    try { await exec(run.conn, `pkill -INT -f "ns3.38-${run.target}-default"`, 5000); } catch (_) { /* ignore */ }
    try { if (run.stream) run.stream.close(); } catch (_) { /* ignore */ }
    return { ok: true, scenario: run.target };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
