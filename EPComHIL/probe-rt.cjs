const { Client } = require('ssh2');
const c = new Client();
c.on('ready', () => {
  // 实测：以 roo 身份跑 scratch 的 P2P UDP 实时场景，带实时模式+10s，测量墙钟耗时
  const cmd = "runuser -l roo -c 'cd /home/roo/ns-allinone-3.38/ns-3.38 && /usr/bin/time -f \"WALL=%e\" ./ns3 run ___P2P__UDP -- --mode=REALTIME --stop=10' 2>&1 | tail -30";
  c.exec(cmd, { pty: true }, (e, s) => {
    if (e) { console.error('EXEC_ERR', e.message); c.end(); return; }
    let out = '';
    s.on('data', d => { out += d.toString(); process.stdout.write(d); });
    s.stderr.on('data', d => { out += d.toString(); process.stdout.write(d); });
    s.on('close', () => {
      // 额外探测进程是否还在
      c.exec('pgrep -af "___P2P__UDP" | head', (e2, s2) => {
        const collect = (d) => process.stdout.write('PROC:' + d);
        s2.on('data', collect); s2.on('stderr', collect);
        s2.on('close', () => c.end());
      });
    });
  });
});
c.on('error', e => console.error('CONN_ERR', e.message));
c.connect({ host: '172.24.4.10', port: 22, username: 'roo', password: 'ASDqwe123!@#' });