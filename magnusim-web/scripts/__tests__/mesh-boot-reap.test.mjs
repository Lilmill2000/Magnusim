import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Server boot reaps mesh generators a previous server left running, but only those of
// its own projects folder: e2e hosts (startHost) boot on their own roots while the
// user's app meshes on another port, and the mesh goldens run generators in temp folders.
const tmp = mkdtempSync(join(tmpdir(), 'cfd-boot-reap-'));
const mine = join(tmp, 'mine', 'projects');
const other = join(tmp, 'other app', 'projects');
process.env.MAGNUSIM_PROJECTS_ROOT = mine;
const { PYTHON } = await import('../python-env.js');
const { reapOrphanMeshGeneratorsOnBoot, pidIsAlive } = await import('../w21-mesh-generate.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

function fakeGenerator(tools, projectDir) {
  const caseDir = join(projectDir, 'meshes', 'Mesh_1', 'case');
  mkdirSync(caseDir, { recursive: true });
  return spawn(PYTHON, [join(tools, 'generate_standard.py'), '--project-dir', projectDir, '--case-dir', caseDir], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/** A generator left the way a dead server leaves one: the process that started it has exited. */
function orphanGenerator(tools, projectDir) {
  const caseDir = join(projectDir, 'meshes', 'Mesh_1', 'case');
  mkdirSync(caseDir, { recursive: true });
  const args = [join(tools, 'generate_standard.py'), '--project-dir', projectDir, '--case-dir', caseDir];
  const starter = `require('node:child_process').spawn(${JSON.stringify(PYTHON)}, ${JSON.stringify(args)}, { detached: true, stdio: 'ignore', windowsHide: true }).unref()`;
  spawnSync(process.execPath, ['-e', starter], { windowsHide: true, timeout: 20000 });
}

/** [pid, command line] of each process running a generate_standard.py. */
function listed() {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*generate_standard.py*' } | ForEach-Object { '{0}{1}{2}' -f $_.ProcessId, [char]9, $_.CommandLine }",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  return String(r.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('\t'))
    .map((line) => [Number(line.split('\t', 1)[0]), line.slice(line.indexOf('\t') + 1)]);
}

const pidsFor = (rows, projectDir) => rows.filter(([, cmd]) => cmd.includes(projectDir)).map(([pid]) => pid);

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(250);
  }
  return pred();
}

describe('mesh generators reaped at server boot', { skip: process.platform !== 'win32' && 'Windows process listing' }, () => {
  it("kills this projects root's leftover generator, spares another root's and its own", async () => {
    const tools = join(tmp, 'tools');
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, 'generate_standard.py'), 'import time\ntime.sleep(300)\n', 'utf8');
    const dirs = { mine: join(mine, 'proj_a'), other: join(other, 'proj_a') };
    orphanGenerator(tools, dirs.mine);
    orphanGenerator(tools, dirs.other);
    // Started by this process, as a Generate the server ran before its boot step.
    const own = fakeGenerator(tools, join(mine, 'proj_own'));
    let pids = { mine: [], other: [] };
    try {
      assert.ok(
        await until(() => {
          const rows = listed();
          pids = { mine: pidsFor(rows, dirs.mine), other: pidsFor(rows, dirs.other) };
          return pids.mine.length > 0 && pids.other.length > 0 && rows.some(([pid]) => pid === own.pid);
        }, 30000),
        'fake generators never showed up in the process list',
      );
      reapOrphanMeshGeneratorsOnBoot();
      assert.ok(await until(() => !pids.mine.some(pidIsAlive), 15000), "this root's leftover generator still runs");
      await sleep(1000);
      assert.ok(pids.other.every(pidIsAlive), "another projects root's generator was killed at boot");
      assert.equal(pidIsAlive(own.pid), true, 'a generator this server started was killed at boot');
    } finally {
      for (const [pid, cmd] of listed()) {
        if (cmd.includes(tmp)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      }
      await sleep(500);
    }
  });
});

// The generator reaps a leftover on its case itself (claim_generate_case). A listing
// in the server before the spawn held its event loop ~1 s per Generate, the server's
// start came late, and the mesh clock restarted at 0:00 (smoke "elapsed clock ticks").
describe('mesh Generate start', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'w21-mesh-generate.js'), 'utf8');
  for (const fn of ['function startStandardGenerate(', 'function startMeshGenerateBody(']) {
    it(`${fn.slice(9, -1)}: no process listing before the spawn`, () => {
      const start = src.indexOf(fn);
      assert.ok(start >= 0, `${fn} not found`);
      const spawnAt = src.indexOf('spawnJob({', start);
      assert.ok(spawnAt > start, `${fn} spawns no job`);
      const beforeSpawn = src.slice(start, spawnAt);
      assert.match(beforeSpawn, /mkdirSync\(winOut/);
      assert.doesNotMatch(beforeSpawn, /reapStaleMeshGenerators\(|spawnSync\(|powershell/i);
    });
  }
});
