import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { H8_PROJECT, prepareE2eProjectsRoot } from './prepare-projects.js';
import { NO_WSL } from './toolchain.js';

// H8, the analysis contract and the bundled plugin tier, as the user meets them:
// - without its required plugin the app says so and refuses to create or run
//   simulations (never an empty picker);
// - a simulation type the core knows nothing about (the stub analysis fixture
//   plugin: steady scalar diffusion on laplacianFoam) is created, blocked by its
//   own readiness message, then written and solved through the contract.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const FIXTURE = 'sample-project-steady-state-e2e';

function stage(t0, msg) {
  console.log(`[h8 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
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

test('gate:h8-required-plugin-missing the app says the required plugin is missing and refuses to create or run', async ({ page, request }) => {
  test.setTimeout(240_000);
  // A second app server whose bundled plugins folder is empty (its own projects,
  // settings and port, so the main server's state is untouched).
  const port = String(Number(process.env.MAGNUSIM_E2E_PORT || 8083) + 11);
  const base = `http://127.0.0.1:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), 'magnusim-h8-missing-'));
  const root = join(tmp, 'projects');
  prepareE2eProjectsRoot(root);
  const bundled = join(tmp, 'empty-bundled');
  const userPlugins = join(tmp, 'no-user-plugins');
  mkdirSync(bundled);
  mkdirSync(userPlugins);
  const prefs = join(tmp, 'prefs.json');
  writeFileSync(prefs, JSON.stringify({ wizard_completed: true, units: 'Metric', port: Number(port) }));
  const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--strictPort'], {
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: root,
      MAGNUSIM_LOCAL_JSON: prefs,
      MAGNUSIM_PORT: port,
      MAGNUSIM_BOUND_PORT: port,
      MAGNUSIM_BUNDLED_DIR: bundled,
      MAGNUSIM_PLUGINS_DIR: userPlugins,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  try {
    expect(await waitUp(`${base}/api/registry`, 120_000), `second server did not start:\n${log.slice(-2000)}`).toBe(true);

    // The registry says which required plugin is missing, and why.
    const reg = await (await request.get(`${base}/api/registry`)).json();
    expect(reg.analysis || []).toEqual([]);
    expect(reg.required_missing[0]).toMatchObject({ key: 'incompressible_flow', name: 'Incompressible Flow' });

    // What the user sees: the notice on every page, and the picker says it too.
    await page.goto(`${base}/#/p/${FIXTURE}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
    const notice = page.locator('[data-required-plugin-error="app"]');
    await expect(notice).toContainText('Incompressible Flow failed to load');
    await expect(notice).toContainText("Magnusim can't create or run simulations.");
    await expect(notice).toContainText(String(bundled));
    await page.locator('#btn-create-simulation').click();
    const picker = page.locator('#cs-type-list [data-required-plugin-error="picker"]');
    await expect(picker).toContainText('Incompressible Flow failed to load');
    await expect(page.locator('#cs-type-list [data-analysis-key]')).toHaveCount(0);
    await expect(page.locator('#cs-create')).toBeDisabled();

    // The server refuses too: no study is created and no run starts.
    const created = await request.post(`${base}/api/simulation`, { data: { project_id: FIXTURE, time_dependency: 'Steady-state' } });
    expect(created.status()).toBe(503);
    expect((await created.json()).error).toContain('Incompressible Flow failed to load');
    const started = await request.post(`${base}/api/run/start`, { data: { project_id: FIXTURE, run_id: 'any', simulation_id: 'sim_1' } });
    expect(started.ok()).toBe(false);

    // Settings → Plugins lists it as a required plugin that failed, with no switch.
    const plugins = await (await request.get(`${base}/api/plugins`)).json();
    const row = (plugins.plugins || []).find((p) => p.key === 'incompressible_flow');
    expect(row).toMatchObject({ status: 'error', required: true, tier: 'bundled' });
  } finally {
    killTree(server);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gate:h8-stub-analysis a simulation type the core does not know runs through the contract', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_800_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const PROJECT = H8_PROJECT;

  // Create a study of the stub analysis in the Create Simulation modal.
  await page.goto(`/#/p/${PROJECT}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="stub_diffusion_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  const sim = (await getJson(request, `/api/simulation?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`)).simulation;
  expect(sim).toMatchObject({ analysis_type: 'stub_diffusion_steady', analysis_title: 'Scalar diffusion (stub)', algorithm: 'Laplacian' });
  stage(t0, `stub study ${sid}`);

  // A coarse mesh for it.
  const meshesNow = async () => (await getJson(request, `/api/mesh?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`)).meshes || [];
  const beforeIds = new Set((await meshesNow()).map((m) => String(m.id)));
  const meshFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row`).first();
  await expect(meshFolder).toBeVisible({ timeout: 15_000 });
  await meshFolder.locator('.tl').click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  let meshId = '';
  await expect
    .poll(async () => {
      meshId = (await meshesNow()).map((m) => String(m.id)).find((id) => !beforeIds.has(id)) || '';
      return meshId;
    }, { timeout: 15_000 })
    .not.toBe('');
  await form.locator('[data-schema-key="fineness"] input').fill('1');
  for (const label of ['Hex element core', 'Automatic boundary layers']) {
    const toggle = form.locator(`button[aria-label="${label}"]`);
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  }
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const m = (await meshesNow()).find((row) => String(row.id) === meshId) || {};
      const st = (m.live_mesh_result && m.live_mesh_result.status) || 'wait';
      return /done|failed|stopped/.test(st) ? st : 'wait';
    }, { timeout: 900_000, intervals: [3_000] })
    .toBe('done');
  stage(t0, 'mesh done');

  // A run. Start is refused with the stub's own readiness message.
  const made = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: sid, name: 'Stub run', mesh_id: meshId } });
  const mj = await made.json();
  expect(made.ok(), JSON.stringify(mj)).toBe(true);
  const rid = mj.run_id || (mj.run && (mj.run.id || mj.run.run_id));
  // A new run starts from the analysis's own run defaults (5 iterations, not the core's 200).
  expect(mj.run).toMatchObject({ endTime: 5, writeInterval: 5 });
  const start = () => request.post('/api/run/start', { data: { project_id: PROJECT, run_id: rid, simulation_id: sid } });
  const runRow = async () => ((await getJson(request, `/api/run/status?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`)).runs || []).find((r) => String(r.id) === String(rid)) || {};
  const refused = await start();
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe('Set the diffusivity above 0 m²/s');
  expect((await runRow()).status).toBe('draft');
  stage(t0, 'blocked by its own readiness message');

  // Set it; now the stub writes its case and the core launches laplacianFoam.
  const upd = await request.post('/api/simulation/update', { data: { project_id: PROJECT, simulation_id: sid, diffusivity: 0.001 } });
  expect(upd.ok()).toBe(true);
  const ok = await start();
  expect(ok.status(), JSON.stringify(await ok.json())).toBe(202);
  await expect
    .poll(async () => {
      const st = (await runRow()).status || 'none';
      return /done|failed|stopped/.test(st) ? st : 'running';
    }, { timeout: 900_000, intervals: [3_000] })
    .toBe('done');
  const row = await runRow();
  expect(row).toMatchObject({ path_kind: 'laplacianFoam' });
  const caseDir = row.case_dir;
  expect(caseDir && existsSync(caseDir), `case_dir ${caseDir}`).toBe(true);
  expect(readFileSync(join(caseDir, 'system', 'controlDict'), 'utf8')).toMatch(/application\s+laplacianFoam;/);
  expect(readFileSync(join(caseDir, 'constant', 'transportProperties'), 'utf8')).toMatch(/DT\s+0\.001;/);
  // The solved frame came back (the analysis's frame field is T, not U/p).
  const frames = readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== '0');
  expect(frames.length, `frames in ${caseDir}`).toBeGreaterThan(0);
  expect(frames.some((f) => existsSync(join(caseDir, f, 'T')))).toBe(true);
  expect(frames).toContain('5');
  stage(t0, `stub run done: laplacianFoam, frames ${frames.join(',')}`);
});
