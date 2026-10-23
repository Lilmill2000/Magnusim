import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { computeProfile, runHardwareCheck, runProbe } from '../hardware-profile.js';

describe('hardware profile MPI ranks', () => {
  it('caps Windows core counts to fewer WSL Open MPI slots', () => {
    const hw = computeProfile({ physical: 14, logical: 20, ram_gb: 64, wsl_slots: 10 });
    assert.equal(hw.n_procs, 10);
  });

  it('still reserves a Windows core when WSL has enough slots', () => {
    const hw = computeProfile({ physical: 16, logical: 32, ram_gb: 64, wsl_slots: 16 });
    assert.equal(hw.n_procs, 15);
  });
});

// The check ran its probes with spawnSync (PowerShell 20 s, OpenFOAM 90 s, lscpu 20 s):
// the whole server stopped answering for up to about two minutes.
describe('the hardware check does not hold the server', () => {
  it('a probe is a child process the event loop keeps running beside', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const t0 = Date.now();
    const r = await runProbe(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("7"), 600)'], 10_000);
    clearInterval(timer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '7');
    assert.ok(Date.now() - t0 >= 550);
    assert.ok(ticks >= 10, `the event loop ticked ${ticks} times while the probe ran`);
  });

  it('a probe that outlives its timeout is killed and gives no status', async () => {
    const t0 = Date.now();
    const r = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], 300);
    assert.equal(r.status, null);
    assert.ok(Date.now() - t0 < 5_000);
  });

  it('a command that is not there gives no status (never throws)', async () => {
    const r = await runProbe('magnusim-no-such-command-xyz', [], 5_000);
    assert.equal(r.status, null);
  });

  it('another request is answered while a slow check runs (a fake slow wsl)', async () => {
    const calls = [];
    // Each probe answers after 400 ms, the way a cold WSL does after many seconds.
    const run = (command, args, timeoutMs) => {
      calls.push({ command, timeoutMs, what: args.join(' ') });
      const out = command === 'wsl' && /lscpu/.test(args.join(' ')) ? '6\n' : '8\n';
      return new Promise((resolve) => setTimeout(() => resolve({ status: 0, stdout: out }), 400));
    };
    const written = [];
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const check = runHardwareCheck({ run, write: (patch) => written.push(patch) });
      const t0 = Date.now();
      const answer = await new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      assert.equal(answer, 'ok');
      assert.ok(Date.now() - t0 < 300, 'answered before the first probe ended');
      const hw = await check;
      assert.equal(hw.openfoam_ok, true);
      assert.equal(hw.wsl_mpi_slots, 6);
      assert.deepEqual(written, [{ hardware: hw }]);
      // The same probes and timeouts as before.
      const wsl = calls.filter((c) => c.command === 'wsl');
      assert.deepEqual(
        wsl.map((c) => c.timeoutMs),
        [90_000, 20_000],
      );
      assert.match(wsl[0].what, /simpleFoam -help/);
      if (process.platform === 'win32') assert.deepEqual([calls[0].command, calls[0].timeoutMs], ['powershell.exe', 20_000]);
    } finally {
      server.close();
    }
  });
});
