// The pre-run check (RH2, spec 4.4-4.6): what the person sees of a draft's check in its Run panel's
// "Before you start", and the Assistant's same check and fixes through the same routes.
// - A draft set as Run_2 was (PISO, Max Courant 100) shows the piso_high_co row (a warning, never a
//   block): Start stays enabled and its title says what it starts with; the estimate line is shown.
// - Apply ("Use 3 outer correctors, Max Courant 5") changes its Run settings to 3 and 5 and the row
//   goes; "Keep as set" moves the row under "Kept (1)" and saves checks_kept (after a reload too);
//   a Start shows "Checked at start: … (Max Courant 100 with PISO, kept as set…)".
// - A scripted Assistant reads precheck (what-if values first, nothing saved), changes the run
//   with setup_edit, reads precheck again: the panel's row goes without a reload. Its checks_kept
//   (setup_edit run update) moves the row under Kept too.
// - Review fixes: "Undo keep" brings a kept row back (saved without it); a check that fails says
//   "Not checked", never "Nothing found"; Cores changed while its save is held are checked as
//   shown; "Apply all" applies only the problems and warnings shown and says what it changes; a
//   study fix ("Use Start from potential flow") from the person and from the Assistant's study_edit
//   sets the study and the row goes; the Assistant's steady copy (study_edit copy, set_time) makes
//   a steady study with a draft run; a draft on a mesh not generated yet says only its settings
//   were checked.
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake): the fake mesher writes a
// one-cell mesh with OpenFOAM's own checkMesh report of a clean mesh, so its quality is known.
// Fails on the code before RH2: the Run panel had no "Before you start".
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKMESH = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'ok-hex-2d.log');
const PID = 'run-precheck-e2e';
const STEP = { timeout: 30_000 };
let host;
let fake;
let sim;
let meshId;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}
const results = (o) => ({ project_id: '', simulation_id: '', run_id: '', kind: '', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...o });
const study = (o) => ({ project_id: '', action: '', id: '', ids: [], analysis: '', geometry_id: '', copy_from: '', copy_mode: '', time_dependency: '', name: '', plugin: '', kind: '', values: [], ...o });
const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
const runRow = async (request, id) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === id) || {};
/** The tool results a scripted step got (the last request's). */
const lastResults = () => resultsIn(fake.requests().at(-1));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('run-precheck');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Precheck project');
  host = await startHost({
    name: 'run-precheck',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
      MAGNUSIM_TEST_SOLVE_SECONDS: '600',
      PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
    },
  });
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  meshId = String(doc.mesh.id);
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 90_000 }).toBe('done');
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

/** A draft set as Run_2 was: PISO (1 outer corrector) at Max Courant 100. */
async function run2(request, name) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name, mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', {
    project_id: PID,
    simulation_id: sim,
    run_id: rid,
    transient: { end_time: 10, write_count: 60, max_co: 100, n_outer_correctors: 1, n_correctors: 2, time_step_mode: 'adjustable' },
  });
  return rid;
}

const checkOf = (panel) => panel.locator('[data-run-check="1"]');
const pisoRow = (panel) => checkOf(panel).locator('[data-run-check-row="piso_high_co"]');

test('a draft at Max Courant 100 with PISO: the row, Start enabled with its title; Apply makes it 3 and 5 and the row goes', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_2');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const check = checkOf(panel);
  await expect(check).toBeVisible(STEP);
  await expect(check.locator('.mat-k').first()).toHaveText('Before you start');
  await expect(pisoRow(panel)).toHaveAttribute('data-level', 'warn', STEP);
  await expect(pisoRow(panel).locator('[data-run-check-text="1"]')).toContainText(
    'Max Courant 100 with 1 outer corrector. Max Courant is not a speed setting on its own. With 1 outer corrector (PISO) keep it at or below 1; 2-3 outer correctors allow up to about 5. At 100 expect the',
  );
  // The estimate line is always shown; at Max Courant 100 with PISO it counts Courant 1, as PISO allows.
  await expect(check.locator('[data-run-check-estimate="1"]')).toContainText('at Max Courant 1, as 1 outer corrector allows');
  // No check blocks Start: it stays enabled and says what it starts with.
  const start = panel.locator('[data-run-start="1"]');
  await expect(start).toBeEnabled(STEP);
  await expect(start).toHaveAttribute('title', /^Starts with \d+ warnings? \(see Before you start\)$/);
  // Apply: the fix's words, then the run's settings change and the row goes.
  const apply = pisoRow(panel).locator('[data-run-check-apply="piso_high_co"]');
  await expect(apply).toHaveText('Use 3 outer correctors, Max Courant 5');
  await expect(pisoRow(panel).locator('[data-run-check-alt="piso_high_co"]')).toHaveText(/^Max Courant 1 \((about .+|under a minute)\)$/);
  await apply.click();
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.transient?.n_outer_correctors, r.transient?.max_co];
  }, STEP).toEqual([3, 5]);
  await expect(pisoRow(panel)).toHaveCount(0, STEP);
  await expect(panel.getByLabel('Max Courant number')).toHaveValue('5');
  await expect(panel.getByLabel('Outer correctors')).toHaveValue('3');
  // After a reload too.
  const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(checkOf(again)).toBeVisible(STEP);
  await expect(pisoRow(again)).toHaveCount(0);
  await expect(again.getByLabel('Max Courant number')).toHaveValue('5');
});

test('Keep as set moves the row under "Kept (1)", saved with the run; a Start says it was checked at start', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_kept');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(pisoRow(panel)).toBeVisible(STEP);
  await pisoRow(panel).locator('[data-run-check-keep="piso_high_co"]').click();
  const kept = checkOf(panel).locator('[data-run-check-kept="1"]');
  await expect(kept.locator('summary')).toHaveText('Kept (1)', STEP);
  await expect(pisoRow(panel)).toHaveCount(0);
  await expect.poll(async () => (await runRow(request, rid)).checks_kept, STEP).toEqual(['piso_high_co']);
  // The run's settings are as they were (Keep as set changes nothing else).
  const row = await runRow(request, rid);
  expect([row.transient?.max_co, row.transient?.n_outer_correctors]).toEqual([100, 1]);
  // After a reload too.
  const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(checkOf(again).locator('[data-run-check-kept="1"] summary')).toHaveText('Kept (1)', STEP);
  await checkOf(again).locator('[data-run-check-kept="1"] summary').click();
  await expect(checkOf(again).locator('[data-run-check-kept-row="piso_high_co"]')).toContainText('Max Courant 100 with 1 outer corrector.');
  // Start: the run starts, and its status says what the check found as it started.
  await again.locator('[data-run-start="1"]').click();
  // Every warning it started with, the kept one marked (the one-cell test mesh adds the start-up one).
  await expect(again.locator('[data-run-checked-at-start="1"]')).toHaveText(/^Checked at start: \d+ warnings? \(Max Courant 100 with PISO, kept as set(; [^)]+)?\)$/, { timeout: 60_000 });
  await expect(checkOf(again)).toHaveCount(0);
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid, force: true });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).not.toBe('running');
});

test('Undo keep brings a kept row back with its fix, and the run is saved without it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_unkeep');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(pisoRow(panel)).toBeVisible(STEP);
  await pisoRow(panel).locator('[data-run-check-keep="piso_high_co"]').click();
  const kept = checkOf(panel).locator('[data-run-check-kept="1"]');
  await expect(kept.locator('summary')).toHaveText('Kept (1)', STEP);
  await expect.poll(async () => (await runRow(request, rid)).checks_kept, STEP).toEqual(['piso_high_co']);
  // Start counts the kept row as Checked at start will, and says it is kept.
  await expect(panel.locator('[data-run-start="1"]')).toHaveAttribute('title', /^Starts with \d+ warnings?, 1 kept as set \(see Before you start\)$/, STEP);
  await kept.locator('summary').click();
  const undo = kept.locator('[data-run-check-unkeep="piso_high_co"]');
  await expect(undo).toHaveText('Undo keep');
  await undo.click();
  await expect(pisoRow(panel)).toBeVisible(STEP);
  await expect(pisoRow(panel).locator('[data-run-check-apply="piso_high_co"]')).toHaveText('Use 3 outer correctors, Max Courant 5');
  await expect(kept).toHaveCount(0);
  await expect.poll(async () => (await runRow(request, rid)).checks_kept, STEP).toEqual([]);
  await expect(panel.locator('[data-run-start="1"]')).toHaveAttribute('title', /^Starts with \d+ warnings? \(see Before you start\)$/, STEP);
  // After a reload too.
  const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(pisoRow(again)).toBeVisible(STEP);
  await expect(checkOf(again).locator('[data-run-check-kept="1"]')).toHaveCount(0);
});

test('a check that fails says "Not checked" with why, never "Nothing found"; Check again shows the rows', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_check_fails');
  // The server's answer to a check that threw (the worker timed out): a 500 with no `ok`.
  const failing = (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'worker call analysis.run_check timed out after 30000 ms', empty: false, proves_not_baked_only: true }),
    });
  await page.route('**/api/run/precheck', failing);
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const check = checkOf(panel);
  await expect(check.locator('[data-run-check-error="1"]')).toHaveText('Not checked: worker call analysis.run_check timed out after 30000 ms', STEP);
  await expect(check.locator('[data-run-check-none="1"]')).toHaveCount(0);
  await expect(check.locator('[data-run-check-row]')).toHaveCount(0);
  // Start says nothing about what it starts with: it was not checked.
  await expect(panel.locator('[data-run-start="1"]')).not.toHaveAttribute('title', /Starts with/);
  await page.unroute('**/api/run/precheck', failing);
  await check.locator('[data-run-check-again="1"]').click();
  await expect(pisoRow(panel)).toBeVisible(STEP);
  await expect(check.locator('[data-run-check-error="1"]')).toHaveCount(0);
});

test("the check reads Cores as the panel shows them, while their save is still on its way, to a number and back to Auto", async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_cores');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const line = checkOf(panel).locator('[data-run-check-estimate="1"]');
  // Auto: the one-cell test mesh runs serial.
  await expect(line).toContainText(' on 1 core', STEP);
  // The Cores save is held until the check has answered: the server still has Auto saved.
  let release;
  const held = new Promise((r) => (release = r));
  const hold = async (route) => {
    await held;
    await route.continue();
  };
  await page.route('**/api/run/update', hold);
  await panel.getByLabel('Cores', { exact: true }).selectOption('2');
  await expect(line).toContainText(' on 2 cores', STEP);
  // Checked while the save was still held: the server had Auto saved all along.
  expect((await runRow(request, rid)).cores ?? null).toBeNull();
  const saved = page.waitForResponse((r) => r.url().includes('/api/run/update') && r.request().method() === 'POST');
  release();
  await saved;
  await page.unroute('**/api/run/update', hold);
  await expect.poll(async () => (await runRow(request, rid)).cores, STEP).toBe(2);
  await expect(line).toContainText(' on 2 cores');
  // Back to Auto with its save held: the server still has 2 saved, and Auto (sent as null)
  // is checked as Auto, not as the saved 2.
  let releaseAuto;
  const heldAuto = new Promise((r) => (releaseAuto = r));
  const holdAuto = async (route) => {
    await heldAuto;
    await route.continue();
  };
  await page.route('**/api/run/update', holdAuto);
  await panel.getByLabel('Cores', { exact: true }).selectOption('auto');
  await expect(line).toContainText(' on 1 core', STEP);
  expect((await runRow(request, rid)).cores).toBe(2);
  const savedAuto = page.waitForResponse((r) => r.url().includes('/api/run/update') && r.request().method() === 'POST');
  releaseAuto();
  await savedAuto;
  await page.unroute('**/api/run/update', holdAuto);
  await expect.poll(async () => (await runRow(request, rid)).cores ?? null, STEP).toBeNull();
  await expect(line).toContainText(' on 1 core');
});

test('Apply all applies the problems and warnings shown, not the notes, and its title says what it changes', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_apply_all');
  const before = (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation;
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const check = checkOf(panel);
  const avg = check.locator('[data-run-check-row="average_startup"]');
  await expect(pisoRow(panel)).toBeVisible(STEP);
  await expect(avg).toHaveAttribute('data-level', 'warn', STEP);
  // The notes this draft has (not applied by Apply all).
  const notes = await check.locator('[data-run-check-row][data-level="info"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-run-check-row')));
  expect(notes).toContain('still_start');
  const avgLabel = ((await avg.locator('[data-run-check-apply="average_startup"]').textContent()) || '').replace(/^Use /, '');
  const all = check.locator('[data-run-check-apply-all="1"]');
  await expect(all).toHaveAttribute('title', `Applies 3 outer correctors, Max Courant 5; ${avgLabel}`);
  await all.click();
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.transient?.n_outer_correctors, r.transient?.max_co, r.transient?.average_from > 0];
  }, STEP).toEqual([3, 5, true]);
  await expect(pisoRow(panel)).toHaveCount(0, STEP);
  await expect(avg).toHaveCount(0, STEP);
  // The notes were not applied: the study still starts from rest, the run keeps its 10 s.
  const after = (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation;
  expect(!!after.potential_flow).toBe(!!before.potential_flow);
  expect((await runRow(request, rid)).transient?.end_time).toBe(10);
  await expect(check.locator('[data-run-check-row="still_start"]')).toBeVisible();
});

/** The study's Study panel (its settings form). */
async function openStudyPanel(page) {
  await page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row`).first().click();
  const panel = page.locator('#panel-study-settings .cfd-island');
  await expect(panel.locator('[data-study-panel="1"]')).toBeVisible(STEP);
  return panel;
}

test('a study fix: "Use Start from potential flow" sets the study (simulation.update) and the row goes', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_study_fix');
  try {
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const row = checkOf(panel).locator('[data-run-check-row="still_start"]');
    await expect(row.locator('[data-run-check-text="1"]')).toHaveText('The run starts from rest; starting from potential flow shortens the start-up.', STEP);
    await row.locator('[data-run-check-apply="still_start"]').click();
    await expect.poll(async () => (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation?.potential_flow, STEP).toBe(true);
    await expect(row).toHaveCount(0, STEP);
    // The person sees it where the study's settings are.
    const study = await openStudyPanel(page);
    await expect(study.locator('[data-schema-key="potential_flow"] button')).toHaveAttribute('aria-pressed', 'true', STEP);
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, potential_flow: false });
  }
});

test.describe('the Assistant', () => {
  test.beforeEach(async ({ request }) => {
    await postOk(request, '/api/test/assistant/reset', {});
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(async () => {
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  /** Runs one dock turn and allows any card it raises. */
  async function turn(page, text) {
    await dockSend(page, text);
    const card = dockGate(page);
    const ended = dockTurn(page).locator('[data-turn-end="done"]');
    for (let i = 0; i < 3; i++) {
      await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
      if (await ended.isVisible()) break;
      await card.locator('[data-gate-answer="yes"]').click(STEP);
    }
    await expect(ended).toBeVisible({ timeout: 60_000 });
  }

  test('precheck (what-if, then saved), setup_edit, precheck: the panel updates without a reload', async ({ page, request }) => {
    test.setTimeout(240_000);
    const rid = await run2(request, 'Run_ai');
    const seen = {};
    fake.reply(
      { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck', values: [{ key: 'transient.n_outer_correctors', value: '3' }, { key: 'transient.max_co', value: '5' }] }) }] },
      () => {
        seen.whatIf = lastResults()[0];
        return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] };
      },
      () => {
        seen.before = lastResults()[0];
        const piso = seen.before.data.findings.find((f) => f.code === 'piso_high_co');
        return { tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: piso.fix[0].values }) }] };
      },
      () => {
        seen.edit = lastResults()[0];
        return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] };
      },
      () => {
        seen.after = lastResults()[0];
        return { text: 'Set 3 outer correctors and Max Courant 5.' };
      },
    );
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(pisoRow(panel)).toBeVisible(STEP);
    const panelText = await pisoRow(panel).locator('[data-run-check-text="1"]').textContent();
    await openDock(page);
    await turn(page, 'Check Run_ai before it starts and fix it.');
    // The what-if: checked with the proposed values, nothing saved.
    expect(seen.whatIf.ok, JSON.stringify(seen.whatIf)).toBe(true);
    expect(seen.whatIf.data.using).toBe('proposed');
    expect(seen.whatIf.data.findings.map((f) => f.code)).not.toContain('piso_high_co');
    // The saved settings: the row the person sees, word for word, with its fix as the call that makes it.
    expect(seen.before.data.using).toBe('saved');
    expect(seen.before.data.shown_in).toBe('Run panel → Before you start');
    const piso = seen.before.data.findings.find((f) => f.code === 'piso_high_co');
    expect(piso.text).toBe(panelText);
    expect(piso.level).toBe('warn');
    expect(piso.fix[0].call).toMatch(/^setup_edit \{kind:'run', action:'update', id:'/);
    expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    expect(seen.after.data.findings.map((f) => f.code)).not.toContain('piso_high_co');
    // The panel: the row went and the settings show 3 and 5, without a reload.
    await expect(pisoRow(panel)).toHaveCount(0, STEP);
    await expect(panel.getByLabel('Max Courant number')).toHaveValue('5', STEP);
    await expect(panel.getByLabel('Outer correctors')).toHaveValue('3', STEP);
  });

  test("a study fix through study_edit set (the fix's own values): the study changes and the panel's row goes", async ({ page, request }) => {
    test.setTimeout(240_000);
    const rid = await run2(request, 'Run_ai_study');
    const seen = {};
    fake.reply(
      { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] },
      () => {
        seen.before = lastResults()[0];
        const still = seen.before.data.findings.find((f) => f.code === 'still_start');
        seen.call = still.fix[0].call;
        return { tools: [{ name: 'study_edit', input: study({ action: 'set', id: sim, values: still.fix[0].values }) }] };
      },
      () => {
        seen.edit = lastResults()[0];
        return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] };
      },
      () => {
        seen.after = lastResults()[0];
        return { text: 'It starts from potential flow now.' };
      },
    );
    try {
      const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
      const row = checkOf(panel).locator('[data-run-check-row="still_start"]');
      await expect(row).toBeVisible(STEP);
      await openDock(page);
      await turn(page, 'Make it start from potential flow, as the check suggests.');
      expect(seen.call).toBe(`study_edit {action:'set', id:'${sim}', values:[{"key":"potential_flow","value":"true"}]}`);
      expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
      expect(seen.after.data.findings.map((f) => f.code)).not.toContain('still_start');
      expect((await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation?.potential_flow).toBe(true);
      // The panel: the row went without a reload, and the study shows it.
      await expect(row).toHaveCount(0, STEP);
      const studyPanel = await openStudyPanel(page);
      await expect(studyPanel.locator('[data-schema-key="potential_flow"] button')).toHaveAttribute('aria-pressed', 'true', STEP);
    } finally {
      await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, potential_flow: false });
    }
  });

  test("the steady copy as its call says (study_edit copy, then set_time steady): a steady study with a draft run; the transient one stays", async ({ page, request }) => {
    test.setTimeout(240_000);
    const rid = await run2(request, 'Run_ai_steady');
    const seen = {};
    const before = (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations.map((s) => s.id);
    fake.reply(
      { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] },
      () => {
        seen.before = lastResults()[0];
        seen.fix = seen.before.data.findings.find((f) => f.code === 'steady_for_mean').fix[0];
        return { tools: [{ name: 'study_edit', input: study({ action: 'copy', copy_from: sim, copy_mode: 'settings' }) }] };
      },
      () => {
        seen.copy = lastResults()[0];
        return { tools: [{ name: 'study_edit', input: study({ action: 'set_time', id: seen.copy.data.ids.study, time_dependency: 'steady' }) }] };
      },
      () => {
        seen.time = lastResults()[0];
        return { text: 'A steady copy is ready.' };
      },
    );
    await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await openDock(page);
    try {
      await turn(page, 'Make the steady copy the check suggests.');
    } finally {
      // The copy became the active study; the tests after this one open the transient study's runs.
      await postOk(request, '/api/simulation/activate', { project_id: PID, simulation_id: sim });
    }
    expect(seen.fix.call).toBe(`study_edit {action:'copy', copy_from:'${sim}', copy_mode:'settings'}, then study_edit {action:'set_time', id:<the copy>, time_dependency:'steady'}`);
    expect(seen.copy.ok, JSON.stringify(seen.copy)).toBe(true);
    expect(seen.time.ok, JSON.stringify(seen.time)).toBe(true);
    const copyId = seen.copy.data.ids.study;
    expect(before).not.toContain(copyId);
    const all = (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations;
    expect(all.find((s) => s.id === copyId).time_dependency).toMatch(/steady/i);
    expect(all.find((s) => s.id === sim).time_dependency).toMatch(/transient/i);
    // Its first run is a draft, and the person sees the copy in the tree.
    const runs = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${copyId}`)).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => !r.status || r.status === 'draft')).toBe(true);
    await expect(page.locator(`#left-tree [data-w17-sim-id="${copyId}"]`).first()).toBeVisible(STEP);
    expect((await runRow(request, rid)).transient?.max_co).toBe(100);
  });

  test("the Assistant's checks_kept moves the row under Kept, as Keep as set does", async ({ page, request }) => {
    test.setTimeout(180_000);
    const rid = await run2(request, 'Run_ai_kept');
    const seen = {};
    fake.reply(
      { tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'checks_kept', value: '["piso_high_co"]' }] }) }] },
      () => {
        seen.edit = lastResults()[0];
        return { tools: [{ name: 'read_results', input: results({ run_id: rid, kind: 'precheck' }) }] };
      },
      () => {
        seen.after = lastResults()[0];
        return { text: 'Kept as set.' };
      },
    );
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(pisoRow(panel)).toBeVisible(STEP);
    await openDock(page);
    await turn(page, 'Keep its Max Courant as set.');
    expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    expect(seen.after.data.findings.find((f) => f.code === 'piso_high_co').kept).toBe(true);
    await expect(checkOf(panel).locator('[data-run-check-kept="1"] summary')).toHaveText('Kept (1)', STEP);
    await expect(pisoRow(panel)).toHaveCount(0);
    expect((await runRow(request, rid)).checks_kept).toEqual(['piso_high_co']);
  });
});

test('"Make a steady copy" copies the study, sets the copy steady and opens its run; the transient study stays', async ({ page, request }) => {
  test.setTimeout(180_000);
  const rid = await run2(request, 'Run_steady');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const row = checkOf(panel).locator('[data-run-check-row="steady_for_mean"]');
  await expect(row).toBeVisible(STEP);
  await expect(row.locator('[data-run-check-text="1"]')).toContainText('If you need the mean flow, a steady k-omega SST run solves for it directly');
  const before = (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations.map((s) => s.id);
  await row.locator('[data-run-check-apply="steady_for_mean"]').click();
  // A new study, steady, with a run; the transient study and its run are as they were.
  await expect.poll(async () => (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations.length, STEP).toBe(before.length + 1);
  const all = (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations;
  const copy = all.find((s) => !before.includes(s.id));
  await expect.poll(async () => (await getJson(request, `/api/simulation?project_id=${PID}`)).simulations.find((s) => s.id === copy.id)?.time_dependency, STEP).toMatch(/steady/i);
  expect(all.find((s) => s.id === sim).time_dependency).toMatch(/transient/i);
  await expect(page.locator('#panel-sim-control [data-run-mode="1"]')).toHaveText('Steady-state', STEP);
  expect((await runRow(request, rid)).transient?.max_co).toBe(100);
});

test('a draft on a mesh not generated yet: only its run settings were checked, and the line waits for the mesh', async ({ page, request }) => {
  test.setTimeout(180_000);
  // The transient study again (the steady copies before this test became the active study).
  await postOk(request, '/api/simulation/activate', { project_id: PID, simulation_id: sim });
  // A second mesh of the study, not generated, and a draft on it at the default settings.
  const made = await postOk(request, '/api/mesh', { project_id: PID, simulation_id: sim, create: true, name: 'Mesh not generated' });
  const fresh = String((made.mesh && made.mesh.id) || made.mesh_id || '');
  expect(fresh).not.toBe('');
  expect(fresh).not.toBe(meshId);
  const run = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_no_mesh', mesh_id: fresh });
  const rid = String(run.run_id || run.run?.id || run.run?.run_id);
  // Settings with nothing to find (a new draft takes the last run's).
  const calm = { end_time: 10, write_count: 60, max_co: 1, n_outer_correctors: 1, n_correctors: 2, time_step_mode: 'adjustable' };
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: calm });
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const check = checkOf(panel);
  await expect(check.locator('[data-run-check-estimate="1"]')).toHaveText('No time-step estimate until the mesh is generated', STEP);
  await expect(check.locator('[data-run-check-partial="1"]')).toHaveText('Only its run settings were checked: its mesh and physics are checked once the mesh is generated.');
  await expect(check.locator('[data-run-check-none="1"]')).toHaveText('Nothing found in its run settings.');
  await expect(check).not.toContainText('no inlet speed');
  await expect(check).not.toContainText('mesh or physics');
  // Its settings are still checked: Run_2's PISO at Max Courant 100 shows its row.
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { max_co: 100, n_outer_correctors: 1 } });
  const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(pisoRow(again)).toBeVisible(STEP);
  await expect(checkOf(again).locator('[data-run-check-partial="1"]')).toBeVisible();
});
