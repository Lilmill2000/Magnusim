// H15: the relay is launched by a hidden starter: no console window, and out of the
// app's process tree, so `taskkill /T` of the server (stop.bat) does not reach it.
// Windows only; needs the Python side (part P1).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = join(HERE, '..', '..', 'python', 'tools', 'run_foam_case.py');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-relay-launch-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { PYTHON } = await import('../python-env.js');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the relay may still be finishing */
  }
});

const skip = process.platform !== 'win32' ? 'Windows only' : !existsSync(RELAY) ? 'the Python relay (part P1) is not here yet' : false;

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('the hidden starter', { skip }, () => {
  it('the relay has no visible console and outlives a taskkill /T of its Node parent', async () => {
    const out = join(ROOT, 'selftest.jsonl');
    // A stand-in for the server: Node starts the starter on pipes, as spawnJob does, and stays up.
    const parentJs = join(ROOT, 'parent.cjs');
    writeFileSync(
      parentJs,
      `const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(PYTHON)}, [${JSON.stringify(RELAY)}, '--launch', '--selftest', 'console', '--out', ${JSON.stringify(out)}, '--sleep', '6'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', () => {});
setInterval(() => {}, 1000);
`,
    );
    const parent = spawn(process.execPath, [parentJs], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    parent.stdout.on('data', (d) => (said += String(d)));
    await until(() => said.includes('"relay_launch"'), 30_000, 'relay_launch');
    const first = await until(() => lines(out)[0], 30_000, 'the relay to start');
    assert.ok(first.pid > 0);
    assert.ok(first.console_hwnd === 0 || first.console_visible === false, JSON.stringify(first));
    // stop.bat: the whole tree of the server, forced.
    const killed = spawnSync('taskkill', ['/PID', String(parent.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(killed.status, 0, killed.stdout + killed.stderr);
    await until(() => lines(out).some((l) => l.late === true), 20_000, 'the relay to write its late line after its parent was killed');
  });
});
