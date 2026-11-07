// 探针：定位用户"编译后第一次运行中途截至、第二次正常"的根因侧（ns-3 还是应用层）。
const { Client } = require('ssh2');
const c = new Client();
const NS = '/home/roo/ns-allinone-3.38/ns-3.38';
function sh(cmd) {
  return new Promise((resolve) => {
    c.exec(cmd, (e, s) => {
      if (e) return resolve({ out: 'EXECERR ' + e.message });
      let out = '';
      s.on('data', (d) => (out += d));
      s.stderr.on('data', (d) => (out += d));
      s.on('close', () => resolve({ out }));
    });
  });
}
async function runOnce(bin) {
  // 当前连接即 roo，直接跑已构建二进制（REALTIME 非 HIL，无 tap 前置）。
  const cmd = `cd ${NS} && /usr/bin/time -f "WALL=%e" ./build/scratch/${bin} 2>&1 | tail -5`;
  const { out } = await sh(cmd);
  return out;
}
c.on('ready', async () => {
  try {
    const list = await sh(`ls ${NS}/scratch/*.cc 2>/dev/null | xargs -n1 basename | sed 's/\\.cc$//'`);
    const names = String(list.out).split(/\s+/).map((s) => s.trim()).filter(Boolean);
    console.log('SCRATCH_TARGETS', names.join(','));
    let rt = null;
    for (const n of names) {
      const g = await sh(`grep -l "RealtimeSimulatorImpl" ${NS}/scratch/${n}.cc 2>/dev/null`);
      if (String(g.out).trim()) { rt = n; break; }
    }
    console.log('REALTIME_TARGET', rt || '(none)');
    if (!rt) { c.end(); return; }
    const bin = `ns3.38-${rt}-default`;
    const exists = await sh(`ls -l ${NS}/build/scratch/${bin} 2>/dev/null`);
    console.log('BIN:\n' + exists.out.trim() || '(no prebuilt binary)');
    const sm = await sh(`grep -n "SynchronizationMode" ${NS}/scratch/${rt}.cc | head`);
    console.log('SYNC_MODE_LINES:\n' + sm.out.trim() || '(none)');
    console.log('--- FIRST RUN ---');
    console.log((await runOnce(bin)).trim());
    console.log('--- SECOND RUN ---');
    console.log((await runOnce(bin)).trim());
  } catch (err) { console.error('PROBE_ERR', err); }
  finally { c.end(); }
});
c.on('error', (e) => console.error('CONN_ERR', e.message));
c.connect({ host: '172.24.4.10', port: 22, username: 'roo', password: 'ASDqwe123!@#' });