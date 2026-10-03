import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { H8_PROJECT } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
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

test('gate:h8-required-plugin-missing the app says the required plugin is missing and refuses to create or run', async ({ page, request }) => {
  test.setTimeout(240_000);
  // A second app server whose bundled plugins folder is empty (its own projects,
  // settings and port, so the main server's state is untouched).
  const tmp = e2eTemp('h8-missing');
  const bundled = join(tmp, 'empty-bundled');
  mkdirSync(bundled);
  const host = await startHost({ name: 'h8-missing', tmp, bundledDir: bundled });
  const { base } = host;
  try {

    // The registry says which required plugin is missing, and why, and has no default analysis.
    const reg = await (await request.get(`${base}/api/registry`)).json();
    expect(reg.analysis || []).toEqual([]);
    expect(reg.required_missing[0]).toMatchObject({ key: 'incompressible_flow', name: 'Incompressible Flow' });
    expect(reg.default_analysis).toBeNull();

    // A draft run of the project's existing study, made before the page opens.
    const made = await request.post(`${base}/api/run/create`, { data: { project_id: FIXTURE, simulation_id: 'sim_1', name: 'Without its plugin' } });
    const mj = await made.json();
    expect(made.ok(), JSON.stringify(mj)).toBe(true);
    const rid = String(mj.run_id || (mj.run && (mj.run.id || mj.run.run_id)));

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
    // A real draft run, so the refusal is the missing plugin's (a made-up run id
    // was refused as "Run not found" before the plugin was ever checked), and it
    // is said before the run's missing mesh.
    const started = await request.post(`${base}/api/run/start`, { data: { project_id: FIXTURE, run_id: rid, simulation_id: 'sim_1' } });
    expect(started.status()).toBe(400);
    const sj = await started.json();
    expect(sj.error).toContain('Incompressible Flow failed to load');
    expect(sj.fix).toEqual({ go: 'plugins' });
    // Its monitors: none, and why (this used to end in an unhandled 500).
    const mon = await request.get(`${base}/api/run/monitors?project_id=${FIXTURE}&simulation_id=sim_1&run_id=${rid}`);
    expect(mon.status()).toBe(200);
    expect((await mon.json()).unavailable).toBe("Incompressible Flow failed to load, so this run can't start.");

    // The existing study and run say why, after the action and after a reload.
    // (The study panel used to show nothing, and Start stayed off with no reason.)
    await page.locator('#cs-cancel').click();
    for (const pass of ['open', 'reload']) {
      if (pass === 'reload') await page.reload();
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
      await page.locator('#left-tree [data-w17-sim-id="sim_1"] > .tree-row').first().click();
      await expect(page.locator('#panel-study-settings [data-study-missing="1"]')).toContainText(
        "Incompressible Flow failed to load, so this simulation can't be set up or run.",
      );
      const folder = page.locator('#left-tree [data-w17-sim-id="sim_1"] li[data-w27-sim-control="1"]').first();
      if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
        await folder.locator(':scope > .tree-row .tw').click();
      }
      await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
      const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
      await expect(runPanel).toHaveAttribute('data-run-id', rid);
      await expect(runPanel.locator('[data-run-reason="1"]')).toContainText("Incompressible Flow failed to load, so this run can't start.");
      await expect(runPanel.locator('[data-run-start="1"]')).toBeDisabled();
    }
    // The Monitors dialog offers the monitor types the registry has: none without the
    // plugin, so nothing can be added (it used to offer an Area average no plugin reads).
    const runLi = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
    if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) await runLi.locator(':scope > .tree-row .tw').click();
    await page.locator(`button.rc-plus[data-w27-run-plus="${rid}"]`).click();
    await expect(page.locator('#modal-result-control')).toBeVisible();
    await expect(page.locator('#rc-type-list [data-rc-type]')).toHaveCount(0);
    await expect(page.locator('#rc-type-list')).toContainText('No monitor can be added');
    await expect(page.locator('#rc-apply')).toBeDisabled();
    await page.locator('#rc-cancel').click();
    await expect(page.locator('#modal-result-control')).toBeHidden();

    // Its fix opens Settings → Plugins.
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel.locator('[data-setup-fix="1"]')).toHaveText('Open Settings → Plugins');
    await runPanel.locator('[data-setup-fix="1"]').click();
    await expect(page.locator('#setup-wizard')).toBeVisible();
    await expect(page.locator('#setup-wizard [data-wiz-step="5"]')).toBeVisible();

    // Settings → Plugins lists it as a required plugin that failed, with no switch.
    const plugins = await (await request.get(`${base}/api/plugins`)).json();
    const row = (plugins.plugins || []).find((p) => p.key === 'incompressible_flow');
    expect(row).toMatchObject({ status: 'error', required: true, tier: 'bundled' });
  } finally {
    host.stop();
  }
});

test('gate:h8-required-plugin-dropped a plugin that knocks the required one out at load gets the same notice', async ({ page, request }) => {
  test.setTimeout(240_000);
  // A user plugin drops a boundary condition type Incompressible Flow's analyses
  // use, so the load-time cross-check unloads Incompressible Flow. The app used
  // to list nothing as missing: an empty picker, no notice, runs failing.
  const host = await startHost({ name: 'h8-dropped', pluginsFrom: 'python/tests/fixtures/dropper-plugins' });
  const { base } = host;
  try {
    const reg = await (await request.get(`${base}/api/registry`)).json();
    expect((reg.analysis || []).map((r) => r.key)).not.toContain('incompressible_steady');
    expect(reg.required_missing[0]).toMatchObject({ key: 'incompressible_flow', name: 'Incompressible Flow' });
    expect(reg.required_missing[0].error).toContain("unknown bc key(s) ['wall_slip']");
    await page.goto(`${base}/#/p/${FIXTURE}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
    const notice = page.locator('[data-required-plugin-error="app"]');
    await expect(notice).toContainText('Incompressible Flow failed to load');
    await expect(notice).toContainText('wall_slip');
    await page.locator('#btn-create-simulation').click();
    await expect(page.locator('#cs-type-list [data-required-plugin-error="picker"]')).toContainText('Incompressible Flow failed to load');
    await expect(page.locator('#cs-create')).toBeDisabled();
  } finally {
    host.stop();
  }
});

test('gate:h8-create-time-dependency Create Simulation offers only the time dependencies the picked analysis has', async ({ page }) => {
  test.setTimeout(120_000);
  // The Transient choice used to pick the first transient analysis of any family:
  // with the stub analysis (steady only) picked, it switched to Incompressible's.
  await page.goto(`/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  const transient = page.locator('#cs-time-dep .cs-time-opt[data-time-dep="Transient"]');
  const stub = page.locator('#cs-type-list [data-analysis-key="stub_diffusion_steady"]');
  await stub.click();
  await expect(stub).toHaveClass(/is-selected/);
  await expect(transient).toBeDisabled();
  await expect(transient).toHaveAttribute('title', / has no Transient version\.$/);
  // Incompressible Flow has both: its sibling is offered.
  await page.locator('#cs-type-list [data-analysis-key="incompressible_steady"]').click();
  await expect(transient).toBeEnabled();
  await expect(transient).not.toHaveAttribute('title', /.+/);
  await transient.click();
  await expect(page.locator('#cs-type-list [data-analysis-key="incompressible_transient"]')).toHaveClass(/is-selected/);
  await page.locator('#cs-cancel').click();
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
  // Named after its own analysis (its family's study name), not "Incompressible Steady-state".
  expect(sim.name).toBe('Diffusion Steady-state');
  await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first()).toContainText('Diffusion Steady-state');
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

  // gate:h10-plugin-owned-ui: the study and run panels show the stub's OWN
  // settings components (its ui/index.tsx) inside the core's chrome, and none
  // of Incompressible Flow's. The diffusivity is set in the stub's own field.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const openRun = async () => {
    const folder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
      await folder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
  };
  // The page's Start gate is the stub's own readiness (not Incompressible's
  // fluid and flow checks): it says what the stub needs, and Start is off.
  await openRun();
  await expect(runPanel.locator('[data-run-reason="1"]')).toContainText('Set the diffusivity above 0 m²/s.', { timeout: 15_000 });
  await expect(runPanel.locator('[data-run-start]')).toBeDisabled();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first().click();
  const studyPanel = page.locator('#panel-study-settings .cfd-island [data-study-panel="1"]');
  await expect(studyPanel.locator('[data-stub-study-settings="1"]')).toBeVisible({ timeout: 15_000 });
  await expect(studyPanel.locator('[data-study-analysis="1"]')).toBeVisible();
  await expect(studyPanel).not.toContainText(/simpleFoam|Turbulence model|SIMPLE/);
  await studyPanel.getByLabel('Diffusivity').fill('0.001');
  await studyPanel.getByLabel('Diffusivity').press('Enter');
  await expect
    .poll(async () => (await getJson(request, `/api/simulation?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`)).simulation?.diffusivity)
    .toBe(0.001);
  await openRun();
  await expect(runPanel.locator('[data-stub-run-settings="1"] [data-stub-iterations="1"]')).toHaveText('5');
  await expect(runPanel.locator('[data-run-steady="1"], [data-run-transient="1"]')).toHaveCount(0);
  stage(t0, 'the stub draws its own study and run settings');

  // Ready now: Start in the run panel (the user's way) writes the stub's case
  // and the core launches laplacianFoam.
  await expect(runPanel.locator('[data-run-reason="1"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 15_000 });
  await runPanel.locator('[data-run-start]').click();
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
  // Its residual plot draws the series it declares (T), not U and p.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await openRun();
  await expect(runPanel.locator('[data-residual-plot="1"]')).toBeVisible({ timeout: 60_000 });
  await expect(runPanel.locator('.sim-residual-legend')).toHaveText('T');
  stage(t0, `stub run done: laplacianFoam, frames ${frames.join(',')}`);

  // Its results colour by what it writes (T, in K): the core's results viewer
  // reads the analysis's result_fields, not a fixed U and p.
  await page.locator(`[data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 60_000 });
  await expect(page.locator('#legend .legend-units')).toHaveText('K');
  await expect(page.locator('#cp-coloring option:not([hidden])')).toHaveText(['Temperature']);
  const tRange = await page.evaluate(() => window.__CFD_W6__ && window.__CFD_W6__.foam_proof);
  expect(tRange && tRange.min != null && tRange.max != null, JSON.stringify(tRange)).toBe(true);
  stage(t0, 'the stub results colour by T');
});
