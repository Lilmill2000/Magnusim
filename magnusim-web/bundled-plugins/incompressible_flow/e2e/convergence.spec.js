import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONVERGENCE_PROJECT } from './seed.js';

// F5 convergence, no WSL:
// 1. A draft run's panel offers "Stop when a monitor settles" with the run's own
//    monitors (Forces: its coefficients; a Point probe and an area average: pressure
//    and velocity) and its study's openings (pressure, velocity, flow rate); a monitor
//    placed on nothing is not offered. The pick, its amount and window are saved on the
//    run and shown again after a reload; Off clears it. A force coefficient while the
//    study has no reference area says it would not be used, until the study has one.
// 2. A finished run that converged says so: the Run panel's title "Converged", its line
//    "Converged after N iterations" and a note of how (the residuals, or the monitor's
//    sentence), and a "Converged" badge on its tree row. One that ran to its iteration
//    limit keeps the v0.2.0 title and line ("Run finished", "N iterations") and a marked
//    note that it did not converge. A converged run is a finished one: it is offered
//    Continue (F6) from its last saved result.
// 3. "Copy from previous run" carries the stop: it follows its monitor to the copy's
//    own (new) monitor, and the copy's panel shows it picked.
// Fails on the code before F5: the panel had no such setting, a converged run read
// "Run finished" with no badge, and a copy got no stop.
const PROJECT = CONVERGENCE_PROJECT;
const SIM = 'sim_1';

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

const statusUrl = `/api/run/status?project_id=${PROJECT}&simulation_id=${SIM}`;
const runRow = async (request, rid) =>
  ((await getJson(request, statusUrl)).runs || []).find((r) => String(r.id) === String(rid)) || {};

async function createRun(request, name) {
  const r = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: SIM, name } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return String(j.run_id || (j.run && (j.run.id || j.run.run_id)) || j.id);
}

async function openRun(page, rid) {
  // A fresh load each time: a click on the run already open would close its panel.
  await page.goto(`/#/p/${PROJECT}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
    await folder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const runControl = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  await expect(runControl).toHaveAttribute('data-run-id', rid);
  return runControl;
}

const BASE = { write_control: 'Time step', results: null, series: null, chart_values: null, results_available: false };
const MONITORS = [
  { ...BASE, id: 'rc-f1', name: 'Forces 1', monitor_type: 'forces', kind: 'Forces', category: 'Boundary data', boundaries: ['@walls'] },
  { ...BASE, id: 'rc-f2', name: 'Forces 2', monitor_type: 'forces', kind: 'Forces', category: 'Boundary data', boundaries: [] },
  { ...BASE, id: 'rc-p1', name: 'Probe 1', monitor_type: 'probe', kind: 'Point probe', category: 'Point data', points: [[0, 0, 0]] },
  { ...BASE, id: 'rc-a1', name: 'Area average 1', monitor_type: 'area_average', kind: 'Area average', category: 'Surface data', faces: ['face 1@Body1'] },
];

test('the Run panel offers Stop when a monitor settles from the run monitors and keeps it after a reload', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const rid = await createRun(request, 'Settle');
  const set = await request.post('/api/run/update', {
    data: { project_id: PROJECT, simulation_id: SIM, run_id: rid, result_controls: MONITORS },
  });
  expect(set.ok(), await set.text()).toBe(true);

  let runControl = await openRun(page, rid);
  const select = runControl.getByLabel('Stop when a monitor settles', { exact: true });
  await expect(select).toHaveValue('');
  // The run's monitors, then the study's boundaries, each in the order the run and the
  // study list them (their saved order: by name).
  await expect(select.locator('option')).toHaveText([
    'Off',
    'Area average 1 · Pressure',
    'Area average 1 · Velocity',
    'Forces 1 · Cd',
    'Forces 1 · Cl',
    'Forces 1 · Cs',
    'Forces 1 · Cm',
    'Probe 1 · Pressure (average of its points)',
    'Probe 1 · Velocity (average of its points)',
    'pressure_1 · Pressure',
    'pressure_1 · Velocity',
    'pressure_1 · Flow rate',
    'velocity_inlet_1 · Pressure',
    'velocity_inlet_1 · Velocity',
    'velocity_inlet_1 · Flow rate',
  ]);
  await expect(runControl.getByLabel('Within', { exact: true })).toHaveCount(0);

  await select.selectOption({ label: 'Forces 1 · Cd' });
  const within = runControl.getByLabel('Within', { exact: true });
  const span = runControl.getByLabel('Over the last', { exact: true });
  await expect(within).toHaveValue('0.001');
  await expect(span).toHaveValue('100');
  // The seeded study has no reference area: the stop would not be written, and says so.
  await expect(runControl.locator('[data-run-settle-hint="1"]')).toHaveText(
    "Not used as set: force coefficients need the study's reference area. Set it in the study's Reference values.",
  );
  await within.fill('0.002');
  await within.press('Enter');
  await span.fill('80');
  await span.press('Enter');
  await expect
    .poll(async () => JSON.stringify((await runRow(request, rid)).settle || null), { timeout: 15_000 })
    .toBe(JSON.stringify({ source: 'monitor', id: 'rc-f1', quantity: 'Cd', tolerance: 0.002, window: 80 }));

  // The study gets a reference area; after a reload: the same pick, amount and window, used.
  const area = await request.post('/api/simulation/update', { data: { project_id: PROJECT, simulation_id: SIM, ref_area: 0.5 } });
  expect(area.ok(), await area.text()).toBe(true);
  runControl = await openRun(page, rid);
  await expect(runControl.locator('[data-run-settle-hint="1"]')).toHaveText(
    'Ends the run once Forces 1 · Cd stays within 0.002 of its average over the last 80 iterations. The residual targets still end it too.',
  );
  await expect(runControl.getByLabel('Stop when a monitor settles', { exact: true }).locator('option:checked')).toHaveText(
    'Forces 1 · Cd',
  );
  await expect(runControl.getByLabel('Within', { exact: true })).toHaveValue('0.002');
  await expect(runControl.getByLabel('Over the last', { exact: true })).toHaveValue('80');

  // A boundary's flow rate, then Off.
  await runControl.getByLabel('Stop when a monitor settles', { exact: true }).selectOption({ label: 'pressure_1 · Flow rate' });
  await expect
    .poll(async () => {
      const s = (await runRow(request, rid)).settle || {};
      return `${s.source}/${s.quantity}/${s.tolerance}/${s.window}`;
    }, { timeout: 15_000 })
    .toBe(`boundary/Q/${1e-6}/80`);
  await expect(runControl.getByText('m³/s', { exact: true })).toBeVisible();
  await runControl.getByLabel('Stop when a monitor settles', { exact: true }).selectOption({ label: 'Off' });
  await expect.poll(async () => (await runRow(request, rid)).settle ?? null, { timeout: 15_000 }).toBeNull();
  await expect(runControl.getByLabel('Within', { exact: true })).toHaveCount(0);
});

test("Copy from previous run carries the stop, following its monitor to the copy's", async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const src = await createRun(request, 'Copy source');
  const settle = { source: 'monitor', id: 'rc-p1', quantity: 'p', tolerance: 3, window: 60 };
  const set = await request.post('/api/run/update', {
    data: { project_id: PROJECT, simulation_id: SIM, run_id: src, result_controls: MONITORS, settle },
  });
  expect(set.ok(), await set.text()).toBe(true);
  await expect.poll(async () => ((await runRow(request, src)).settle || {}).id).toBe('rc-p1');
  const dest = await createRun(request, 'Copy target');

  const runControl = await openRun(page, dest);
  await runControl.getByRole('button', { name: 'Copy from previous run' }).click();
  const pick = runControl.getByLabel('Run to copy settings from', { exact: true });
  await pick.selectOption(src);
  // The copy's probe is its own (a new id), and its stop watches that one.
  await expect
    .poll(async () => {
      const row = await runRow(request, dest);
      const probe = (row.result_controls || []).find((rc) => rc.name === 'Probe 1');
      const s = row.settle || {};
      return !!probe && probe.id !== 'rc-p1' && s.id === probe.id && s.quantity === 'p' && s.tolerance === 3 && s.window === 60;
    }, { timeout: 15_000 })
    .toBe(true);
  await expect(runControl.getByLabel('Stop when a monitor settles', { exact: true }).locator('option:checked')).toHaveText(
    'Probe 1 · Pressure (average of its points)',
  );
  await expect(runControl.getByLabel('Within', { exact: true })).toHaveValue('3');
});

test('a converged run says so in the Run panel and on its tree row', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const seedDone = async (name, extra) => {
    const rid = await createRun(request, name);
    const caseDir = (await runRow(request, rid)).case_dir;
    const runJson = join(dirname(caseDir), 'run.json');
    const rec = JSON.parse(readFileSync(runJson, 'utf8'));
    writeFileSync(
      runJson,
      JSON.stringify(
        {
          ...rec,
          status: 'done',
          stage: 'done',
          time_dependency: 'Steady-state',
          endTime: 2000,
          writeInterval: 100,
          has_results: true,
          n_saved_times: 3,
          finished_at: new Date().toISOString(),
          note: 'simpleFoam finished. Results are in the run folder.',
          ...extra,
        },
        null,
        2,
      ),
    );
    return rid;
  };
  const residuals = await seedDone('Converged by residuals', {
    iteration: 215,
    last_saved_iteration: 215,
    converged: { by: 'residuals', iteration: 215 },
  });
  // Its last saved result, what Continue starts from.
  const savedAt = join((await runRow(request, residuals)).case_dir, '215');
  mkdirSync(savedAt, { recursive: true });
  for (const f of ['U', 'p']) writeFileSync(join(savedAt, f), 'x');
  const settled = await seedDone('Settled', {
    iteration: 140,
    last_saved_iteration: 140,
    result_controls: MONITORS.slice(0, 1),
    settle: { source: 'monitor', id: 'rc-f1', quantity: 'Cd', tolerance: 0.001, window: 100 },
    prepare_run: {
      residual_control: true,
      stop_when: { label: 'Forces 1 · Cd', text: 'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations' },
    },
    converged: { by: 'monitor', iteration: 140, text: 'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations' },
  });
  // Its stop was set, but its plan could not use it: it says so, and its end does not name it.
  const limit = await seedDone('Iteration limit', {
    iteration: 2000,
    last_saved_iteration: 2000,
    result_controls: MONITORS.slice(0, 1),
    settle: { source: 'monitor', id: 'rc-f1', quantity: 'Cd', tolerance: 0.001, window: 100 },
    prepare_run: { residual_control: true, stop_when: { label: 'Forces 1 · Cd', error: "force coefficients need the study's reference area" } },
    converged: false,
  });

  let runControl = await openRun(page, residuals);
  const status = runControl.locator('[data-run-status="done"]');
  await expect(status.locator(':scope > .mat-k')).toHaveText('Converged');
  await expect(runControl.locator('[data-run-line="1"]')).toHaveText('Converged after 215 iterations');
  await expect(runControl.locator('[data-run-converged="residuals"]')).toHaveText(
    'Every residual met its target, so the solver stopped early.',
  );
  const badge = (rid) => page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row [data-run-converged="1"]`);
  await expect(badge(residuals)).toHaveText('Converged');
  await expect(badge(residuals)).toHaveAttribute('title', 'Converged after 215 iterations');
  await expect(badge(settled)).toHaveText('Converged');
  await expect(badge(limit)).toHaveCount(0);
  // Converged is finished (status done): Continue is offered, from iteration 215.
  const cont = runControl.locator('[data-run-continue="1"]');
  await expect(cont).toBeVisible();
  await expect(cont.locator('[data-run-continue-go="1"]')).toBeEnabled();
  await expect(cont.locator('[data-run-continue-reason="1"]')).toHaveCount(0);
  await expect(cont.locator('[data-run-continue-hint="1"]')).toContainText('Continues from the last saved result, iteration 215');

  runControl = await openRun(page, settled);
  await expect(runControl.locator('[data-run-line="1"]')).toHaveText('Converged after 140 iterations');
  await expect(runControl.locator('[data-run-converged="monitor"]')).toHaveText(
    'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations.',
  );
  // Its stop, read-only now that it ran.
  await expect(runControl.locator('[data-run-settle="1"]')).toContainText(
    'Forces 1 · Cd stays within 0.001 of its average over 100 iterations',
  );
  await expect(runControl.locator('[data-run-settle-unused="1"]')).toHaveCount(0);

  runControl = await openRun(page, limit);
  await expect(runControl.locator('[data-run-status="done"] > .mat-k')).toHaveText('Run finished');
  await expect(runControl.locator('[data-run-line="1"]')).toHaveText('2000 iterations');
  await expect(runControl.locator('[data-run-converged="no"]')).toHaveText(
    'Reached the iteration limit before the residuals met their targets.',
  );
  await expect(runControl.locator('[data-run-settle-unused="1"]')).toHaveText(
    "Stop when settled was not used: force coefficients need the study's reference area.",
  );
});
