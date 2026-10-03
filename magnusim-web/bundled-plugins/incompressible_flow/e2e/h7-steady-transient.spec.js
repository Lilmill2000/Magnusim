import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_WSL } from '../../../e2e/toolchain.js';
import { waitSlotFree } from '../../../e2e/support/compute-slot.js';

// Steady-state and Transient agree end to end (H7):
// - a study's analysis key follows its time dependency (create, toggle, reload,
//   and studies saved before the fix are repaired when the project is read);
// - what the Run panel shows, what prepare_run writes and what is launched is
//   one decision: a started run keeps the mode it solved with after its study is
//   switched, and a draft (new, never started) run follows the study;
// - the time step the Run panel shows is the deltaT written to controlDict.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const PROJECT = 'h7-steady-transient-e2e';
const SIM = 'sim_1';
const PROJECTS_ROOT = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');

function stage(t0, msg) {
  console.log(`[h7 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
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

const simUrl = (sid) => `/api/simulation?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`;
const statusUrl = (sid) => `/api/run/status?project_id=${PROJECT}&simulation_id=${encodeURIComponent(sid)}`;

/** The study folder's id.json on disk (the record the catalog is walked from). */
function studyIdJson(sid) {
  const geoms = join(PROJECTS_ROOT, PROJECT, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const p = join(sims, s, 'id.json');
      if (existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).id === sid) return p;
    }
  }
  throw new Error(`no id.json for study ${sid}`);
}

/** The written case folder of a run (simulation_runs/<Run>/case). */
function runCaseDir(runId) {
  const geoms = join(PROJECTS_ROOT, PROJECT, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const runs = join(sims, s, 'simulation_runs');
      if (!existsSync(runs)) continue;
      for (const r of readdirSync(runs)) {
        const idp = join(runs, r, 'id.json');
        if (existsSync(idp) && JSON.parse(readFileSync(idp, 'utf8')).id === runId) return join(runs, r, 'case');
      }
    }
  }
  return null;
}

function controlDict(runId) {
  const dir = runCaseDir(runId);
  const p = dir && join(dir, 'system', 'controlDict');
  if (!p || !existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const val = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s+([^;]+);`, 'm'));
    return m ? m[1].trim() : null;
  };
  const num = (key) => (val(key) != null ? Number(val(key)) : null);
  return { application: val('application'), deltaT: num('deltaT'), endTime: num('endTime'), writeInterval: num('writeInterval') };
}

async function openStudyPanel(page, sid) {
  const row = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  await row.click();
  const panel = page.locator('#panel-study-settings .cfd-island [data-study-panel="1"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

async function openProject(page) {
  await page.goto(`/#/p/${PROJECT}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
}

test('gate:h7-transient-key a study solves as the analysis its time dependency says', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await openProject(page);

  // Create a Transient study in the Create Simulation modal.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  const readSim = async () => (await getJson(request, simUrl(sid))).simulation || {};
  await expect.poll(async () => (await readSim()).analysis_type).toBe('incompressible_transient');
  expect((await readSim()).time_dependency).toBe('Transient');
  expect(JSON.parse(readFileSync(studyIdJson(sid), 'utf8')).analysis_type).toBe('incompressible_transient');

  const panel = await openStudyPanel(page, sid);
  await expect(panel.getByLabel('Time dependency')).toHaveValue('Transient');
  await expect(panel.locator('[data-study-transient-note]')).toBeVisible();

  // Toggle to Steady-state: the key flips with it and survives a reload.
  await panel.getByLabel('Time dependency').selectOption('Steady-state');
  await expect.poll(async () => (await readSim()).analysis_type).toBe('incompressible_steady');
  await page.reload();
  await openProject(page);
  const again = await openStudyPanel(page, sid);
  await expect(again.getByLabel('Time dependency')).toHaveValue('Steady-state');
  expect((await readSim()).analysis_type).toBe('incompressible_steady');
  expect(JSON.parse(readFileSync(studyIdJson(sid), 'utf8')).analysis_type).toBe('incompressible_steady');

  // A study saved before the fix (Transient but keyed steady) is repaired on read.
  const idPath = studyIdJson(sid);
  const legacy = JSON.parse(readFileSync(idPath, 'utf8'));
  writeFileSync(idPath, JSON.stringify({ ...legacy, time_dependency: 'Transient', analysis_type: 'incompressible_steady' }));
  expect((await readSim()).analysis_type).toBe('incompressible_transient');
  expect(JSON.parse(readFileSync(idPath, 'utf8')).analysis_type).toBe('incompressible_transient');

  const removed = await request.post('/api/simulation/delete', { data: { project_id: PROJECT, simulation_id: sid } });
  expect(removed.ok()).toBe(true);
});

test('gate:h7-restart-after-toggle and gate:h7-dt-preview-matches-case', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const runs = async () => (await getJson(request, statusUrl(SIM))).runs || [];
  const runRow = async (rid) => (await runs()).find((r) => String(r.id) === String(rid)) || {};

  await openProject(page);

  // A coarse mesh for the study (the seeded elbow has none generated): a new mesh,
  // generated at fineness 1 without hex core or layers.
  const meshesNow = async () => (await getJson(request, `/api/mesh?project_id=${PROJECT}&simulation_id=${SIM}`)).meshes || [];
  const beforeIds = new Set((await meshesNow()).map((m) => String(m.id)));
  const meshFolder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] [data-w20-mesh="1"] > .tree-row`).first();
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
    .poll(
      async () => {
        const m = (await meshesNow()).find((row) => String(row.id) === meshId) || {};
        const st = (m.live_mesh_result && m.live_mesh_result.status) || 'wait';
        return /done|failed|stopped/.test(st) ? st : 'wait';
      },
      { timeout: 900_000, intervals: [3_000] },
    )
    .toBe('done');
  stage(t0, 'mesh done');

  const studyPanel = await openStudyPanel(page, SIM);
  await studyPanel.getByLabel('Time dependency').selectOption('Transient');
  await expect.poll(async () => (await getJson(request, simUrl(SIM))).simulation?.analysis_type).toBe('incompressible_transient');

  const createRun = async (name) => {
    const r = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: SIM, name } });
    const j = await r.json();
    expect(r.ok(), JSON.stringify(j)).toBe(true);
    const rid = j.run_id || (j.run && (j.run.id || j.run.run_id)) || j.id;
    expect(rid).toBeTruthy();
    return rid;
  };
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const openRun = async (rid) => {
    await page.reload();
    await openProject(page);
    const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
      await folder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
  };
  const setField = async (label, value) => {
    const f = runPanel.getByLabel(label, { exact: true });
    await f.fill(String(value));
    await f.press('Enter');
  };
  const waitStatus = async (rid, want, timeout) => {
    await expect
      .poll(
        async () => {
          const st = (await runRow(rid)).status || 'none';
          return want.test(st) || /done|failed|stopped/.test(st) ? st : 'waiting';
        },
        { timeout, intervals: [3_000] },
      )
      .toMatch(want);
  };
  // Solving has begun (the live run doc for this run has a stage / iteration / time).
  const waitSolving = async (rid) => {
    await expect
      .poll(async () => {
        const j = await getJson(request, `${statusUrl(SIM)}&run_id=${encodeURIComponent(rid)}`);
        const r = (j.run && String(j.run.run_id || j.run.id) === String(rid) ? j.run : null) || (await runRow(rid));
        if (/done|failed|stopped/.test(r.status || '')) return `ended:${r.status}`;
        const moving = r.stage === 'solve' || Number(r.iteration || 0) > 0 || Number(r.sim_time || 0) > 0;
        return moving ? 'solving' : 'waiting';
      }, { timeout: 600_000, intervals: [2_000] })
      .toBe('solving');
  };
  const previewDt = async (rid) => {
    const r = await request.post('/api/run/transient-preview', { data: { project_id: PROJECT, run_id: rid, simulation_id: SIM } });
    const j = await r.json();
    expect(j.ok, JSON.stringify(j)).toBe(true);
    expect(j.partial, `preview is partial: ${j.reason}`).toBe(false);
    return j.control;
  };
  const sig4 = (v) => Number(Number(v).toPrecision(4));
  // The run's note: the app, the analysis family, and the physics and algorithm
  // the case was written with (from prepare_run since H9; before, Node's tables).
  const runNote = async (rid) => {
    const j = await getJson(request, `${statusUrl(SIM)}&run_id=${encodeURIComponent(rid)}`);
    const r = (j.run && String(j.run.run_id || j.run.id) === String(rid) ? j.run : null) || (await runRow(rid));
    return String(r.note || '');
  };
  // The Δt the Run panel shows the user: "starting Δt ≈ 1.2e-5 s (auto)".
  const shownDt = async () => {
    const text = String(await runPanel.locator('[data-run-transient-hint]').textContent());
    const m = text.match(/(?:starting Δt ≈|fixed Δt) (\S+) s/);
    return m ? Number(m[1]) : NaN;
  };
  // Same number at the panel's display precision (at least two significant figures).
  const sameShown = (shown, v) => Number.isFinite(shown) && Math.abs(shown - Number(v)) <= 0.05 * Math.abs(Number(v));

  // Run A: Transient. The Δt the Run panel previews is the deltaT written.
  const runA = await createRun('H7 transient');
  await openRun(runA);
  await expect(runPanel.locator('[data-run-transient]')).toBeVisible();
  // A transient run's settings are its analysis's: a save that bypasses the
  // panel (the API) is cleaned by the plugin's run model, not stored as sent.
  const bypass = await request.post('/api/run/update', {
    data: { project_id: PROJECT, simulation_id: SIM, run_id: runA, transient: { n_correctors: 99 } },
  });
  expect(bypass.ok(), await bypass.text()).toBe(true);
  await openRun(runA);
  await runPanel.locator('summary', { hasText: 'Advanced settings' }).click();
  await expect(runPanel.getByLabel('Pressure correctors', { exact: true })).toHaveValue('10');
  await setField('Pressure correctors', 2);
  await expect.poll(async () => ((await runRow(runA)).transient || {}).n_correctors).toBe(2);
  await runPanel.locator('summary', { hasText: 'Advanced settings' }).click();
  stage(t0, 'stored settings cleaned by the analysis');
  // More result frames than the analysis keeps (5000): the panel shows what is
  // stored, also while the save is on its way. Its own clean-up had no cap, so it
  // showed the typed 10000 until the stored 5000 came back.
  let releaseFrames = () => {};
  const framesHeld = new Promise((resolve) => (releaseFrames = resolve));
  await page.route('**/api/run/update', async (route) => {
    await framesHeld;
    await route.continue();
  });
  await setField('Result frames', 10000);
  await expect(runPanel.getByLabel('Result frames', { exact: true })).toHaveValue('5000');
  releaseFrames();
  await expect.poll(async () => ((await runRow(runA)).transient || {}).write_count).toBe(5000);
  await page.unroute('**/api/run/update');
  await openRun(runA);
  await expect(runPanel.getByLabel('Result frames', { exact: true })).toHaveValue('5000');
  const ctl = await previewDt(runA);
  expect(ctl.source.delta_t).toBe('auto');
  const dt = Number(ctl.delta_t);
  stage(t0, `preview Δt ${dt}`);
  await setField('Simulation time', sig4(dt * 2000));
  await setField('Result frames', 10);
  await expect(runPanel.locator('[data-run-transient-hint]')).toContainText('(auto)');
  const ctlLong = await previewDt(runA);
  await expect.poll(async () => sameShown(await shownDt(), ctlLong.delta_t)).toBe(true);
  const shown = await shownDt();
  await runPanel.locator('[data-run-start]').click();
  await waitStatus(runA, /^running$/, 300_000);
  await expect.poll(() => controlDict(runA)?.application, { timeout: 120_000 }).toBe('pimpleFoam');
  // While it runs, the note names the physics the case was written with (the
  // finished note replaces it).
  expect(await runNote(runA)).toMatch(/^pimpleFoam (serial|\d+ ranks) — Incompressible \/ k-omega SST \/ PIMPLE · /);
  const written = controlDict(runA);
  expect(sig4(written.endTime)).toBe(sig4(dt * 2000));
  expect(sig4(written.deltaT)).toBe(sig4(ctlLong.delta_t));
  expect(sameShown(shown, written.deltaT), `panel showed Δt ${shown} s, controlDict has ${written.deltaT}`).toBe(true);
  expect(sig4((await runRow(runA)).transient?.delta_t)).toBe(sig4(written.deltaT));
  stage(t0, `run A writes deltaT ${written.deltaT} = preview ${ctlLong.delta_t}; the panel showed ${shown} s`);
  await waitSolving(runA);
  await runPanel.locator('[data-run-stop="1"]').click();
  await waitStatus(runA, /^stopped$/, 300_000);
  await waitSlotFree(request);
  stage(t0, 'run A stopped');

  // Switch the study to Steady-state. Run A solved Transient, so it stays Transient
  // (the panel says so) and a restart solves that: case, launch and panel agree.
  const panel2 = await openStudyPanel(page, SIM);
  await panel2.getByLabel('Time dependency').selectOption('Steady-state');
  await expect.poll(async () => (await getJson(request, simUrl(SIM))).simulation?.analysis_type).toBe('incompressible_steady');
  await openRun(runA);
  await expect(runPanel.locator('[data-run-transient]')).toBeVisible();
  // It says so, and offers the study's other mode as a new run (decided with
  // Daniel 2026-09-29: a started run keeps its mode; the toggle is for new runs).
  const reason = runPanel.locator('[data-run-reason="1"]');
  await expect(reason).toContainText('This run solved Transient, so a restart continues Transient. Add a run to solve Steady-state.');
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled();
  const runsBefore = new Set((await runs()).map((r) => String(r.id)));
  await reason.getByRole('button', { name: 'Add run' }).click();
  let added = '';
  await expect
    .poll(async () => {
      added = (await runs()).map((r) => String(r.id)).find((id) => !runsBefore.has(id)) || '';
      return added;
    })
    .not.toBe('');
  await expect(runPanel).toHaveAttribute('data-run-id', added);
  await expect(runPanel.locator('[data-run-mode="1"]')).toHaveText('Steady-state');
  await expect(runPanel.locator('[data-run-transient]')).toHaveCount(0);
  await expect.poll(async () => (await runRow(added)).time_dependency).toBe('Steady-state');
  await request.post('/api/run/delete', { data: { project_id: PROJECT, simulation_id: SIM, run_id: added } });
  stage(t0, 'stopped transient run offers a Steady-state run');
  await openRun(runA);
  await expect(runPanel.locator('[data-run-transient]')).toBeVisible();
  await setField('Simulation time', sig4(dt * 10));
  await setField('Result frames', 1);
  await runPanel.locator('[data-run-start]').click();
  await waitStatus(runA, /^done$/, 900_000);
  expect(controlDict(runA).application).toBe('pimpleFoam');
  // The case solves the simulation time typed for the restart.
  expect(sig4(controlDict(runA).endTime)).toBe(sig4(dt * 10));
  expect((await runRow(runA)).path_kind).toBe('pimpleFoam');
  expect((await runRow(runA)).status).toBe('done');
  stage(t0, 'run A restarted after the switch: pimpleFoam, done');

  // Run B: new after the switch, so Steady-state. Stop it, switch the study back to
  // Transient, restart: it stays Steady-state (simpleFoam) and completes.
  const runB = await createRun('H7 steady');
  await openRun(runB);
  await expect(runPanel.locator('[data-run-transient]')).toHaveCount(0);
  await setField('Iterations', 5000);
  await setField('Write interval', 1000);
  await runPanel.locator('[data-run-start]').click();
  await waitStatus(runB, /^running$/, 300_000);
  await expect.poll(() => controlDict(runB)?.application, { timeout: 120_000 }).toBe('simpleFoam');
  expect(await runNote(runB)).toMatch(/^simpleFoam (serial|\d+ ranks) — Incompressible \/ k-omega SST \/ SIMPLE$/);
  expect(controlDict(runB)).toMatchObject({ endTime: 5000, writeInterval: 1000 });
  await waitSolving(runB);
  await runPanel.locator('[data-run-stop="1"]').click();
  await waitStatus(runB, /^stopped$/, 300_000);
  await waitSlotFree(request);
  const panel3 = await openStudyPanel(page, SIM);
  await panel3.getByLabel('Time dependency').selectOption('Transient');
  await expect.poll(async () => (await getJson(request, simUrl(SIM))).simulation?.analysis_type).toBe('incompressible_transient');
  await openRun(runB);
  await expect(runPanel.locator('[data-run-transient]')).toHaveCount(0);
  await setField('Iterations', 10);
  await setField('Write interval', 5);
  await runPanel.locator('[data-run-start]').click();
  await waitStatus(runB, /^done$/, 900_000);
  expect(controlDict(runB).application).toBe('simpleFoam');
  // The iterations typed for the restart, not the 5000 it first ran with.
  expect(controlDict(runB)).toMatchObject({ endTime: 10, writeInterval: 5 });
  expect((await runRow(runB)).path_kind).toBe('simpleFoam');
  stage(t0, 'run B restarted after the switch back: simpleFoam, done');

  // Run C: a draft (never started) follows its study. Made while the study is
  // Transient, it becomes Steady-state when the study is switched, and solves that.
  const runC = await createRun('H7 draft');
  await openRun(runC);
  await expect(runPanel.locator('[data-run-transient]')).toBeVisible();
  const panel4 = await openStudyPanel(page, SIM);
  await panel4.getByLabel('Time dependency').selectOption('Steady-state');
  await expect.poll(async () => (await getJson(request, simUrl(SIM))).simulation?.analysis_type).toBe('incompressible_steady');
  await expect.poll(async () => (await runRow(runC)).time_dependency).toBe('Steady-state');
  await openRun(runC);
  await expect(runPanel.locator('[data-run-transient]')).toHaveCount(0);
  await setField('Iterations', 10);
  await setField('Write interval', 5);
  await runPanel.locator('[data-run-start]').click();
  await waitStatus(runC, /^done$/, 900_000);
  expect(controlDict(runC).application).toBe('simpleFoam');
  expect(controlDict(runC)).toMatchObject({ endTime: 10, writeInterval: 5 });
  expect((await runRow(runC)).path_kind).toBe('simpleFoam');
  stage(t0, 'draft run C followed the study to Steady-state: simpleFoam, done');
});
