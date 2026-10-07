import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { PYTHON } from '../scripts/python-env.js';

// A server booting reaps mesh generators left running on its own projects folder only.
// It used to match every generate_*.py on the PC: starting a second server (each e2e
// startHost(), or a second app) would kill the mesh the user's app was generating.
// Here the suite's server stands in for the user's app, meshing in its projects root;
// a second server boots on its own root, where a generator was left behind.
const MAIN_ROOT = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A python process whose command line is a generator's (it only sleeps; no folders made). */
function fakeGenerator(tools, projectDir) {
  const caseDir = join(projectDir, 'meshes', 'Mesh_1', 'case');
  return spawn(PYTHON, [join(tools, 'generate_standard.py'), '--project-dir', projectDir, '--case-dir', caseDir, '--generate-id', 'boot-reap-e2e'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

test("a server's boot leaves another server's running mesh alone", async () => {
  test.skip(process.platform !== 'win32', 'generator processes are listed on Windows only');
  test.setTimeout(240_000);
  const tmp = e2eTemp('boot-reap');
  const tools = join(tmp, 'tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'generate_standard.py'), 'import time\ntime.sleep(600)\n', 'utf8');
  const projects = join(tmp, 'projects');
  const users = fakeGenerator(tools, join(MAIN_ROOT, 'boot-reap-e2e-project'));
  const leftover = fakeGenerator(tools, join(projects, 'boot-reap-e2e-project'));
  let host = null;
  try {
    await sleep(1500);
    expect(alive(users.pid) && alive(leftover.pid), 'fake generators started').toBe(true);
    host = await startHost({ name: 'boot-reap', tmp, projects, seed: false });
    // boot() runs once the live registry is ready, which may be just after /api/registry answers.
    await expect.poll(() => alive(leftover.pid), { timeout: 60_000, message: "the new server's own leftover generator is reaped" }).toBe(false);
    await sleep(1000);
    expect(alive(users.pid), "the other server's mesh generator still runs").toBe(true);
  } finally {
    for (const p of [users, leftover]) {
      if (alive(p.pid)) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    }
    if (host) host.stop();
  }
});
