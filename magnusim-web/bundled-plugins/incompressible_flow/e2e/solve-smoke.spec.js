import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_WSL, wslPathExists } from '../../../e2e/toolchain.js';

// Incompressible Flow's half of the smoke run (the core keeps the mesh, BC, material
// and import tests in e2e/smoke.spec.js): the sample's steady solve, a transient
// pimpleFoam run, results and every export, the study panel, and a physics choice
// reaching the solve. The steady solve needs a mesh, so the first test makes one (F=1).
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';

/** GET json; a poll can reuse a keep-alive socket just as the server closes it, so retry that. */
const getJson = async (request, url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

/** Click a mesh form toggle until aria-pressed/checked is the wanted state. */
async function setIslandToggle(page, label, on) {
  const el = page.locator(`#panel-mesh-form .cfd-island button[aria-label="${label}"]`);
  await expect(el).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 4; i += 1) {
    const pressed = await el.getAttribute('aria-pressed');
    if ((pressed === 'true') === on) return;
    await el.click();
    await page.waitForTimeout(150);
  }
}

/** Click, wait for the browser download, and return its name and bytes. */
async function download(page, click) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}
const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebm = (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
const isMp4 = (b) => b.subarray(4, 8).toString('latin1') === 'ftyp';
/** A CSV with a header and at least one numeric data row. */
function expectCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[1].split(',').some((cell) => Number.isFinite(Number(cell)) && cell.trim() !== '')).toBe(true);
}

test.describe('Incompressible Flow smoke', () => {
  test('the sample meshes at F=1 for the solves below', async ({ page, request }) => {
    test.skip(!WSL, NO_WSL);
    const id = 'sample-project-steady-state-e2e';
    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    // Collapsed Mesh hides Mesh 1; expand the section, then click the row.
    const meshSectionTw = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
    const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
    if (await meshRow.count()) {
      if (!(await meshRow.isVisible().catch(() => false))) {
        if (await meshSectionTw.count()) await meshSectionTw.click();
      }
      if (await meshRow.isVisible().catch(() => false)) {
        await meshRow.click();
      } else {
        await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().click();
      }
    } else {
      await page.locator('#left-tree').getByText(/Mesh\s*1/i).first().click();
    }
    // If inspect chip is up (generated mesh), open Settings to reach the form.
    const settingsBtn = page.locator('#mesh-inspect-settings');
    try {
      await settingsBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await settingsBtn.click();
    } catch {
      /* form may already be opening for ungenerated mesh */
    }

    await expect(page.locator('#panel-mesh-form')).toBeVisible({ timeout: 30_000 });
    const fineness = page.locator('#panel-mesh-form .cfd-island [data-schema-key="fineness"] input');
    await expect(fineness).toBeVisible({ timeout: 10_000 });
    await fineness.fill('1');
    // F=1 + hexcore hits HXT failure on this sample; prove Generate?n_cells>0 with hex off.
    // Test harness only ? no product mesher change.
    await setIslandToggle(page, 'Hex element core', false);
    await setIslandToggle(page, 'Automatic boundary layers', false);

    // One Generate path: the island button, then the panel itself must say so.
    const gen = page.locator('#panel-mesh-form [data-mesh-generate="1"]');
    await expect(gen).toHaveText(/^Generate$/);
    await gen.click();
    const status = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toHaveAttribute('data-mesh-status', /generating|finishing|ready/);
    await expect(gen).toBeDisabled();
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/case?project_id=${encodeURIComponent(id)}`).catch(() => null);
          if (!r || !r.ok()) return 'wait';
          const j = await r.json();
          return j.status || j.live_mesh_result?.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed/);

    const final = await (
      await request.get(`/api/case?project_id=${encodeURIComponent(id)}`)
    ).json();
    const caseStatus = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(caseStatus).toBe('done');
    expect(nCells).toBeGreaterThan(0);
  });

  test('simulation hub + optional solve (endTime=20)', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;

    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Simulation/i, { timeout: 30_000 });

    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    await expect(page.locator('#panel-sim-hub')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#btn-create-run')).toBeVisible();

    await page.locator('#btn-create-run').click();
    await expect(page.locator('#panel-sim-control')).toBeVisible({ timeout: 15_000 });
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel.locator('[data-run-start]')).toBeVisible();
    const iterations = runPanel.getByLabel('Iterations', { exact: true });
    await iterations.fill('20');
    await iterations.press('Enter');
    const writeInterval = runPanel.getByLabel('Write interval', { exact: true });
    await writeInterval.fill('20');
    await writeInterval.press('Enter');
    test.info().annotations.push({ type: 'smoke', description: 'solve hub + endTime=20' });

    if (!WSL) {
      // No generated mesh here: Start stays off and says why, with a link to the fix.
      await expect(runPanel.locator('[data-run-start]')).toBeDisabled();
      await expect(runPanel.locator('[data-run-reason]')).toContainText(/Generate .* before starting/);
      await expect(runPanel.locator('[data-run-reason] [data-setup-fix]')).toBeVisible();
      test.info().annotations.push({
        type: 'skip-solve',
        description: 'MAGNUSIM_E2E_WSL/CFDDESK_E2E_WSL!=1',
      });
      return;
    }

    const meshRes = await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`);
    expect(meshRes.ok()).toBeTruthy();
    const meshJson = await meshRes.json();
    expect(meshJson.meshes.some((m) => m.ready && m.n_cells > 0), 'mesh test must generate a real mesh').toBeTruthy();
    await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 30_000 });
    await expect(runPanel.locator('[data-run-reason]')).toHaveCount(0);

    await runPanel.locator('[data-run-start]').click();
    await expect(runPanel.locator('[data-run-status]')).toHaveAttribute('data-run-status', /running|done/, { timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`).catch(() => null);
          if (!r || !r.ok()) return 'wait';
          const j = await r.json();
          const run = j.run || j;
          return run.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed|stopped/);

    const final = await (
      await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`)
    ).json();
    const run = final.run || final;
    expect(run.status).toBe('done');
    const residuals = run.residuals || [];
    expect(residuals.length).toBeGreaterThan(0);
    // The solve's WSL copy goes once its results are on Windows.
    expect(run.wsl_case_path, 'the run names its WSL case').toMatch(/\/cfddesk-w27-[a-z0-9-]+$/);
    expect(wslPathExists(run.wsl_case_path), `${run.wsl_case_path} removed after the solve`).toBe(false);
    test.info().annotations.push({
      type: 'solve',
      description: `endTime=20 done residuals=${residuals.length}`,
    });
  });

  test('transient pimpleFoam run writes real result frames', async ({ page, request }) => {
    test.skip(!WSL, NO_WSL);
    const id = 'sample-project-steady-state-e2e';
    const changed = await request.post('/api/simulation/update', {
      data: { project_id: id, simulation_id: 'sim_1', time_dependency: 'Transient' },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    // The fixture's 50 m/s inlet is not solvable on this F=1 tet mesh (no BL,
    // no hex core): a few inlet-edge cells run away to the 500 m/s velocity
    // limit by t≈2e-4 s and Δt locks near 2e-7 s (~45k steps for 0.01 s). A
    // shorter end time does not help (the run away starts before the 2nd frame).
    // At 2 m/s the same mesh, end time and frame count solve in ~150 steps with
    // no limited cells and a Courant-limited Δt, so the test still proves
    // adjustable-Δt pimpleFoam, 2 saved frames, residuals and openable results.
    const bcsUrl = `/api/bcs?project_id=${id}&simulation_id=sim_1`;
    const fixtureInlet = ((await getJson(request, bcsUrl)).boundary_conditions || []).find((b) => /velocity inlet/i.test(b.bc_type));
    expect(fixtureInlet, 'fixture velocity inlet').toBeTruthy();
    // The fixture stores the legacy "Velocity Inlet" spelling; writes take the canonical one.
    const inlet = { ...fixtureInlet, bc_type: 'Velocity inlet', project_id: id, simulation_id: 'sim_1' };
    const slowed = await request.post('/api/bcs', { data: { ...inlet, value: 2 } });
    expect(slowed.ok(), await slowed.text()).toBeTruthy();
    expect(((await getJson(request, bcsUrl)).boundary_conditions || []).find((b) => b.id === inlet.id)?.value).toBe(2);
    await page.goto(`/#/p/${id}`);
    await expect(page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    const previousRuns = (await getJson(request, `/api/run/status?project_id=${id}&simulation_id=sim_1`)).runs || [];
    const previousIds = new Set(previousRuns.map((run) => run.id));
    await page.locator('#btn-create-run').click();
    let createdId;
    await expect.poll(async () => {
      const body = await getJson(request, `/api/run/status?project_id=${id}&simulation_id=sim_1`);
      createdId = body.run?.id;
      return !!createdId && !previousIds.has(createdId);
      // Run creation is a worker round trip; 5 s (the default) failed once on a loaded machine.
    }, { timeout: 30_000 }).toBe(true);
    const trPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(trPanel.locator('[data-run-transient]')).toBeVisible();
    const simTime = trPanel.getByLabel('Simulation time', { exact: true });
    await simTime.fill('0.01');
    await simTime.press('Enter');
    const frames = trPanel.getByLabel('Result frames', { exact: true });
    await frames.fill('2');
    await frames.press('Enter');
    await expect(trPanel.locator('[data-run-transient-hint]')).toContainText('(2 frames)');
    await expect(trPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 30_000 });
    await trPanel.locator('[data-run-start]').click();
    let completed;
    await expect.poll(async () => {
      const body = await getJson(request, `/api/run/status?project_id=${id}&simulation_id=sim_1`);
      completed = body.run;
      return completed?.id === createdId && completed?.time_dependency === 'Transient' ? completed.status : 'waiting';
    }, { timeout: 300_000 }).toMatch(/done|failed|stopped/);
    expect(completed.status, completed.error).toBe('done');
    expect(completed.path_kind).toBe('pimpleFoam');
    expect(completed.has_results).toBe(true);
    expect(completed.n_saved_times).toBeGreaterThanOrEqual(2);
    expect(completed.residuals.length).toBeGreaterThan(0);
    // Every frame came back to Windows, so the transient run's WSL copy is gone too.
    expect(completed.wsl_case_path, 'the run names its WSL case').toMatch(/\/cfddesk-w27-[a-z0-9-]+$/);
    expect(wslPathExists(completed.wsl_case_path), `${completed.wsl_case_path} removed after the solve`).toBe(false);
    const runs = (await getJson(request, `/api/run/status?project_id=${id}&simulation_id=sim_1`)).runs;
    expect(runs.some((run) => run.time_dependency === 'Steady-state' && run.status === 'done')).toBe(true);
    await page.reload();
    const runNode = page.locator(`[data-w27-run="${completed.id}"] > .tree-row`).first();
    await expect(runNode).toBeVisible({ timeout: 30_000 });
    await runNode.click();
    const resultNode = page.locator(`[data-w27-run-results="${completed.id}"] > .tree-row`);
    await expect(resultNode).toBeVisible();
    await resultNode.click();
    await expect(page.locator('#iter-scrub')).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('#iter-value')).not.toHaveValue('50');
    await request.post('/api/bcs', { data: inlet });
  });

  test('saved result screenshot, gallery, and every graph / media export format', async ({ page, request }) => {
    test.skip(!WSL, NO_WSL);
    const projectId = 'sample-project-steady-state-e2e';
    const status = await getJson(request, `/api/run/status?project_id=${projectId}&simulation_id=sim_1`);
    const run = status.runs.find((entry) => entry.status === 'done' && entry.has_results);
    expect(run).toBeTruthy();
    await page.goto(`/#/p/${projectId}`);
    const runRow = page.locator(`[data-w27-run="${run.id}"] > .tree-row .tl`);
    await expect(runRow).toBeVisible({ timeout: 30_000 });
    await runRow.click();
    const results = page.locator(`[data-w27-run-results="${run.id}"]`);
    await results.locator(':scope > .tree-row .tl').click();
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 60_000 });
    await page.locator('#toolbar [data-label="Particle Trace"]').click();
    await expect(page.locator('#pt-faces-hint')).toHaveText(/\d+ seeds · [1-9]\d* traces[.]/, { timeout: 60_000 });
    await page.locator('#toolbar [data-label="Screenshot"]').click();
    await page.locator('#capture-go').click();
    await expect(page.locator('#modal-capture-save')).toBeVisible();
    await page.locator('#cs-save-name').fill('Release audit screenshot');
    await page.locator('#cs-save-confirm').click();
    await expect(page.locator('#modal-capture-save')).toBeHidden();
    const gallery = page.locator(`[data-w28-key="media:run:${run.id}:screenshot"] > .tree-row`);
    if (!(await gallery.isVisible())) await results.locator(':scope > .tree-row .tw').click();
    await gallery.click();
    await expect(page.locator('#run-media-list')).toContainText('Release audit screenshot');
    await page.locator('#run-media-list').getByRole('button', { name: 'View', exact: true }).first().click();
    await expect(page.locator('#modal-media-view img')).toBeVisible();
    await expect.poll(() => page.locator('#modal-media-view img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator('#mv-close').click();
    await page.locator(`[data-w28-key="media:run:${run.id}:graphs"] > .tree-row`).click();
    await expect(page.locator('#run-graphs-list svg').first()).toBeVisible({ timeout: 30_000 });
    // The monitor results are read by the run's analysis (analysis.run_monitors,
    // Incompressible Flow since H9): the inlet and outlet cards and the mass balance.
    expect(await page.locator('#run-graphs-list .mon-card').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#run-graphs-balance')).toHaveText(/^Flow in .+ · out .+ · imbalance .+/);
    await expect(page.locator('#run-graphs-list .mon-card').first()).toContainText(/m\/s|Pa|m³\/s/);
    // Every export button the Graphs panel shows produces a real file of its type.
    const all = await download(page, () => page.locator('#run-graphs-csv').click());
    expect(all.name).toMatch(/monitors\.csv$/);
    expectCsv(all.bytes.toString('utf8'));
    const card = page.locator('#run-graphs-list .mon-card').first();
    const png = await download(page, () => card.locator('[data-mon-act="png"]').click());
    expect(png.name).toMatch(/\.png$/);
    expect(isPng(png.bytes)).toBe(true);
    const jpg = await download(page, () => card.locator('[data-mon-act="jpg"]').click());
    expect(jpg.name).toMatch(/\.jpe?g$/);
    expect(isJpg(jpg.bytes)).toBe(true);
    const oneCsv = await download(page, () => card.locator('[data-mon-act="csv"]').click());
    expect(oneCsv.name).toMatch(/\.csv$/);
    expectCsv(oneCsv.bytes.toString('utf8'));
    await card.locator('[data-mon-act="expand"]').click();
    await expect(page.locator('#modal-mon-chart')).toBeVisible();
    expect(isPng((await download(page, () => page.locator('#mon-chart-png').click())).bytes)).toBe(true);
    expect(isJpg((await download(page, () => page.locator('#mon-chart-jpg').click())).bytes)).toBe(true);
    expectCsv((await download(page, () => page.locator('#mon-chart-csv').click())).bytes.toString('utf8'));
    await page.locator('#mon-chart-close').click();
    await expect(page.locator('#modal-mon-chart')).toBeHidden();
    await page.locator('#toolbar [data-label="Record"]').click();
    await page.locator('#capture-duration').fill('1');
    await page.locator('#capture-go').click();
    await expect(page.locator('#modal-capture-save')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cs-save-heading')).toContainText('recording');
    await page.locator('#cs-save-name').fill('Release audit recording');
    await page.locator('#cs-save-confirm').click();
    await expect(page.locator('#modal-capture-save')).toBeHidden();
    await page.locator(`[data-w28-key="media:run:${run.id}:recording"] > .tree-row`).click();
    await expect(page.locator('#run-media-list')).toContainText('Release audit recording');
    const video = await download(page, () =>
      page.locator('#run-media-list').getByRole('link', { name: 'Download' }).first().click(),
    );
    expect(video.name).toMatch(/\.(webm|mp4)$/);
    expect(video.bytes.length).toBeGreaterThan(1000);
    expect(isWebm(video.bytes) || isMp4(video.bytes), `${video.name} is a real video container`).toBe(true);
    // The saved screenshot downloads as a real PNG too.
    await page.locator(`[data-w28-key="media:run:${run.id}:screenshot"] > .tree-row`).click();
    await expect(page.locator('#run-media-list')).toContainText('Release audit screenshot');
    const shot = await download(page, () =>
      page.locator('#run-media-list').getByRole('link', { name: 'Download' }).first().click(),
    );
    expect(shot.name).toMatch(/\.png$/);
    expect(isPng(shot.bytes)).toBe(true);

  });

  // Phase 6: the study panel is back to V0.1.0's rows, and what it shows is what the solve reads.
  const STUDY_PROJECT = 'sample-project-steady-state-e2e';
  const studyUrl = `/api/simulation?project_id=${STUDY_PROJECT}&simulation_id=sim_1`;

  async function openStudyPanel(page) {
    await page.goto(`/#/p/${STUDY_PROJECT}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first().click();
    const panel = page.locator('#panel-study-settings .cfd-island [data-study-panel="1"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    return panel;
  }

  test('study panel: V0.1.0 rows, field help, time dependency and rename persist', async ({ page, request }) => {
    const readSim = async () => (await getJson(request, studyUrl)).simulation || {};
    const original = await readSim();
    const panel = await openStudyPanel(page);
    try {
      await expect(panel.locator('[data-panel-title]')).toHaveText(original.name);
      await expect(panel.locator('[data-study-analysis]')).toHaveText(/Incompressible/);
      await expect(panel.getByLabel('Turbulence model', { exact: true }).locator('option')).toHaveText([
        'Laminar',
        'k-epsilon',
        'k-omega SST',
        'LRR (Reynolds stress)',
        'SSG (Reynolds stress)',
      ]);
      await expect(panel).not.toContainText(/Energy|Passive species|Time scheme/);

      const time = panel.getByLabel('Time dependency');
      await time.selectOption('Steady-state');
      await expect.poll(async () => (await readSim()).time_dependency).toBe('Steady-state');
      await expect(panel.locator('[data-study-algorithm]')).toHaveText('SIMPLE');

      // Field help shows on hover, not only as a slow native title.
      await panel.locator('[data-schema-key="residual_u"] .mat-k').hover();
      await expect(panel.locator('[data-schema-key="residual_u"] [role="tooltip"]')).toBeVisible();
      await expect(panel.locator('[data-schema-key="residual_u"] [role="tooltip"]')).toContainText('Convergence target');
      await panel.locator('[data-schema-key="turbulence_model"] .mat-k').hover();
      await expect(panel.locator('[data-schema-key="turbulence_model"] [role="tooltip"]')).toContainText('k-omega SST');

      await time.selectOption('Transient');
      await expect.poll(async () => (await readSim()).time_dependency).toBe('Transient');
      await expect(panel.locator('[data-study-algorithm]')).toHaveText('PIMPLE');
      await expect(panel.locator('[data-schema-key="residual_u"]')).toHaveCount(0);
      await expect(panel.locator('[data-study-transient-note]')).toBeVisible();

      await panel.getByRole('button', { name: 'Rename simulation' }).click();
      const nameInput = panel.getByLabel('Simulation name');
      await nameInput.fill('Physics check');
      await nameInput.press('Enter');
      await expect.poll(async () => (await readSim()).name).toBe('Physics check');
      await expect(panel.locator('[data-panel-title]')).toHaveText('Physics check');
    } finally {
      await request.post('/api/simulation/update', {
        data: { project_id: STUDY_PROJECT, simulation_id: 'sim_1', name: original.name, time_dependency: original.time_dependency },
      });
    }
  });

  test('physics panel choice reaches the solve (k-epsilon, relaxation 0.5)', async ({ page, request }) => {
    test.skip(!WSL, NO_WSL);
    test.setTimeout(600_000);
    const readSim = async () => (await getJson(request, studyUrl)).simulation || {};
    const panel = await openStudyPanel(page);
    await panel.getByLabel('Time dependency').selectOption('Steady-state');
    await expect.poll(async () => (await readSim()).time_dependency).toBe('Steady-state');
    await panel.getByLabel('Turbulence model', { exact: true }).selectOption({ label: 'k-epsilon' });
    await expect.poll(async () => (await readSim()).turbulence_model).toBe('kEpsilon');
    const relax = panel.getByLabel('Relaxation U', { exact: true });
    await relax.fill('0.5');
    await relax.press('Enter');
    await expect.poll(async () => (await readSim()).relax_u).toBe(0.5);

    const statusUrl = `/api/run/status?project_id=${STUDY_PROJECT}&simulation_id=sim_1`;
    const before = new Set(((await getJson(request, statusUrl)).runs || []).map((r) => r.id));
    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    await page.locator('#btn-create-run').click();
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel.locator('[data-run-start]')).toBeVisible({ timeout: 30_000 });
    let runId;
    await expect
      .poll(
        async () => {
          runId = (await getJson(request, statusUrl)).run?.id;
          return !!runId && !before.has(runId);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const iterations = runPanel.getByLabel('Iterations', { exact: true });
    await iterations.fill('5');
    await iterations.press('Enter');
    const writeInterval = runPanel.getByLabel('Write interval', { exact: true });
    await writeInterval.fill('5');
    await writeInterval.press('Enter');
    await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 30_000 });
    await runPanel.locator('[data-run-start]').click();
    let run;
    await expect
      .poll(
        async () => {
          const j = await getJson(request, statusUrl);
          run = (j.runs || []).find((r) => r.id === runId) || j.run;
          return run && run.status;
        },
        { timeout: 500_000 },
      )
      .toMatch(/done|failed|stopped/);
    expect(run.status, JSON.stringify(run.log_excerpt || '').slice(-1500)).toBe('done');

    const caseDir = run.case_dir;
    const read = (rel) => readFileSync(join(caseDir, rel), 'utf8');
    expect(read('constant/turbulenceProperties')).toMatch(/RASModel\s+kEpsilon;/);
    expect(existsSync(join(caseDir, '0', 'epsilon'))).toBe(true);
    expect(existsSync(join(caseDir, '0', 'omega'))).toBe(false);
    const fvSolution = read('system/fvSolution');
    expect(fvSolution).toMatch(/"\(U\|k\|epsilon\)"/);
    expect(fvSolution).toMatch(/^\s+U\s+0\.5;/m);
    expect(read('system/fvSchemes')).toMatch(/div\(phi,epsilon\)/);
    expect(read('log.simpleFoam')).toMatch(/Solving for epsilon/);
    expect(JSON.parse(read('w27-case.json')).turbulence.model).toBe('kEpsilon');

    // Its results colour by what this run wrote, from the analysis's result
    // fields: k and epsilon, not omega (a k-omega SST field this run has none of).
    const runNode = page.locator(`#left-tree [data-w27-run="${runId}"]`).first();
    const resultsRow = page.locator(`#left-tree [data-w27-run-results="${runId}"] > .tree-row .tl`).first();
    if (!(await resultsRow.isVisible())) await runNode.locator(':scope > .tree-row .tw').first().click();
    await resultsRow.click();
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 60_000 });
    // The field is picked in the Cutting planes block, as in V0.1.0.
    await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
    await expect(page.locator('#cp-coloring')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#cp-coloring option:not([hidden])')).toHaveText(
      ['Velocity Magnitude', 'Pressure', 'Turbulent kinetic energy', 'Turbulent dissipation rate', 'Turbulent viscosity'],
      { timeout: 60_000 },
    );
    await page.locator('#cp-coloring').selectOption('epsilon');
    await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.field), { timeout: 60_000 }).toBe('epsilon');
    await expect(page.locator('#legend .legend-title')).toHaveText('Turbulent dissipation rate');
    await expect(page.locator('#legend .legend-units')).toHaveText('m²/s³');
    const eps = await page.evaluate(() => window.__CFD_W6__?.foam_proof);
    expect(eps && Number(eps.max) > 0, JSON.stringify(eps)).toBe(true);
  });

});
