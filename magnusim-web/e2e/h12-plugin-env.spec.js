import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';

// H12, a plugin with its own Python environment, as the user meets it: Settings
// > Plugins says it needs setup, Install dependencies builds the environment
// (the core's packages untouched), its backend then answers from its own
// service process on that environment, its job runs there too and stops with
// everything it started, its old studies are upgraded by it, and editing its
// lock puts it back to "Needs setup". A second app server on its own plugins,
// environments and projects folders, so the lock can be edited safely.
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'env-demo';

function stage(t0, msg) {
  console.log(`[h12 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

async function waitUp(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

// Is this path inside that folder (both resolved on disk: Windows may hand out short names)?
const inside = (path, folder) =>
  realpathSync.native(path).toLowerCase().startsWith(realpathSync.native(folder).toLowerCase());

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('gate:h12-needs-setup a plugin with its own environment is set up, runs there, and asks again for a new lock', async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const port = String(Number(process.env.MAGNUSIM_E2E_PORT || 8083) + 12);
  const base = `http://127.0.0.1:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-h12-'));
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const plugins = join(tmp, 'plugins');
  const plugin = join(plugins, KEY);
  cpSync(resolve('python/tests/fixtures/env-plugins/env-demo'), plugin, { recursive: true });
  const envs = join(tmp, 'envs');
  const prefs = join(tmp, 'prefs.json');
  writeFileSync(prefs, JSON.stringify({ wizard_completed: true, units: 'Metric', port: Number(port) }));
  // A study its plugin saved with schema 1 of its kind (the plugin is at 2 now).
  const oldStudy = join(projects, PROJECT, 'plugins', KEY, 'studies', 'st-0ld00001');
  mkdirSync(oldStudy, { recursive: true });
  writeFileSync(
    join(oldStudy, 'study.json'),
    JSON.stringify({
      id: 'st-0ld00001',
      kind: 'demo_case',
      title: 'Wing',
      schema_version: 1,
      rev: 1,
      plugin: KEY,
      plugin_name: 'Env demo',
      plugin_version: '1.0.0',
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
    }),
  );
  const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--strictPort'], {
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projects,
      MAGNUSIM_LOCAL_JSON: prefs,
      MAGNUSIM_PORT: port,
      MAGNUSIM_BOUND_PORT: port,
      MAGNUSIM_PLUGINS_DIR: plugins,
      MAGNUSIM_PLUGIN_ENVS_DIR: envs,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  let jobChild = 0;
  try {
    expect(await waitUp(`${base}/api/registry`, 120_000), `second server did not start:\n${log.slice(-2000)}`).toBe(true);
    stage(t0, 'server up');

    // The tree says why its study cannot open yet.
    await page.goto(`${base}/#/p/${PROJECT}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    const studyRow = page.locator('#plugin-studies-section [data-plugin-study="st-0ld00001"]');
    await expect(studyRow).toContainText('Env demo needs setup', { timeout: 30_000 });

    // Settings > Plugins: needs setup, then Install dependencies.
    await page.locator('#wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const row = wizard.locator(`.wiz-pane[data-wiz-step="5"] [data-plugin-key="${KEY}"]`);
    await expect(row).toHaveAttribute('data-plugin-status', 'needs setup');
    await expect(row.locator('.wiz-plugin-status')).toHaveText('Needs setup');
    await expect(row.locator('[data-plugin-env="needs_setup"]')).toHaveText('Needs setup: its dependencies are not installed yet.');
    await expect(row.locator('[data-plugin-toggle]')).toHaveText('Disable');
    const freeze = () => spawnSync(resolve('python/.venv/Scripts/python.exe'), ['-m', 'pip', 'freeze'], { encoding: 'utf8' }).stdout;
    const before = process.platform === 'win32' ? freeze() : '';
    await row.locator(`[data-plugin-install="${KEY}"]`).click();
    await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 180_000 });
    await expect(row.locator('.wiz-plugin-status')).toHaveText('On');
    await expect(row.locator('[data-plugin-env]')).toHaveCount(0);
    await expect(row.locator('[data-plugin-install]')).toHaveCount(0);
    if (process.platform === 'win32') expect(freeze(), 'the install changed the core packages').toBe(before);
    stage(t0, 'installed: Ready');

    // Its backend answers from its own process, on its own environment.
    const hello = await (await request.get(`${base}/api/plugin/${KEY}/hello?echo=hi&project_id=${PROJECT}`)).json();
    expect(hello.echo).toBe('hi');
    expect(hello.project_id).toBe(PROJECT);
    expect(hello.cfddesk_importable).toBe(false);
    expect(inside(hello.prefix, envs), hello.prefix).toBe(true);

    // A call that runs too long times out; the core's reads never wait for it.
    const slow = request.get(`${base}/api/plugin/${KEY}/slow?seconds=8`, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 300));
    const tt = Date.now();
    const tree = await request.get(`${base}/api/project/tree?project_id=${PROJECT}`);
    expect(tree.ok()).toBe(true);
    expect(Date.now() - tt, 'project.tree waited for the plugin').toBeLessThan(1500);
    const slowAnswer = await slow;
    expect(slowAnswer.status()).toBe(504);
    expect((await slowAnswer.json()).error).toMatch(/took longer than 2 s/);
    // A crash is an error, and the next call starts it again.
    const crash = await request.get(`${base}/api/plugin/${KEY}/crash`);
    expect(crash.status()).toBe(502);
    expect((await crash.json()).error).toMatch(/its service stopped \(exit 1\)/);
    const again = await (await request.get(`${base}/api/plugin/${KEY}/hello`)).json();
    expect(again.pid).not.toBe(hello.pid);
    stage(t0, 'service: timeout, crash, restart');

    // Its job runs on its environment, and Stop ends what it started too.
    const started = await request.post(`${base}/api/jobs`, {
      data: { kind: 'env_demo_sleep', params: { project_id: PROJECT, seconds: 600 } },
    });
    expect(started.status(), await started.text()).toBe(202);
    const jobId = (await started.json()).job.id;
    let event = null;
    await expect
      .poll(async () => {
        const j = await (await request.get(`${base}/api/jobs/${jobId}?project_id=${PROJECT}`)).json();
        event = ((j.job && j.job.events) || []).find((e) => e && e.child_pid) || null;
        return !!event;
      }, { timeout: 60_000 })
      .toBe(true);
    jobChild = event.child_pid;
    expect(inside(event.prefix, envs), event.prefix).toBe(true);
    expect(alive(jobChild)).toBe(true);
    const stopped = await request.post(`${base}/api/jobs/${jobId}/stop?project_id=${PROJECT}`);
    expect(stopped.ok()).toBe(true);
    await expect.poll(() => alive(jobChild), { timeout: 10_000 }).toBe(false);
    stage(t0, 'job stopped with its child');

    // Its old study is upgraded by the plugin when the tree lists it.
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.reload();
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(studyRow).toContainText('Wing (upgraded)', { timeout: 30_000 });
    await expect(studyRow).not.toHaveAttribute('data-unavailable', /.+/);
    const saved = JSON.parse(readFileSync(join(oldStudy, 'study.json'), 'utf8'));
    expect([saved.schema_version, saved.units, saved.plugin_version]).toEqual([2, 'SI', '2.0.0']);
    stage(t0, 'study upgraded');

    // A new lock: needs setup again, and Install makes it ready again.
    writeFileSync(join(plugin, 'requirements.lock'), readFileSync(join(plugin, 'requirements.lock'), 'utf8') + '# pinned again\n');
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    await wizard.locator('[data-plugins-reload]').click();
    await expect(row).toHaveAttribute('data-plugin-status', 'needs setup', { timeout: 60_000 });
    const blocked = await request.get(`${base}/api/plugin/${KEY}/hello`);
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error).toMatch(/needs setup/);
    await row.locator(`[data-plugin-install="${KEY}"]`).click();
    await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 180_000 });
    expect((await (await request.get(`${base}/api/plugin/${KEY}/hello`)).json()).cfddesk_importable).toBe(false);
    stage(t0, 'new lock: set up again');
  } finally {
    if (jobChild && alive(jobChild)) spawnSync('taskkill', ['/PID', String(jobChild), '/T', '/F'], { stdio: 'ignore' });
    killTree(server);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a service may still hold a file for a moment */
    }
  }
});
