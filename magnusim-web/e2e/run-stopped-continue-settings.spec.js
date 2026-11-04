// A stopped run's change for when it continues (run health spec, Daniel's A2, 2026-11-03): on a
// stopped transient run with a saved time, changing its Max Courant, outer correctors, pressure
// correctors or Max time step asks one question with three answers, "Start over", "Use when
// continuing" and "Cancel" (focused; Escape and Enter answer it):
// - Cancel: the field shows the saved value, and its results and Continue stay.
// - Use when continuing: its results stay; the field shows the new value with "Takes effect when
//   you Continue" under it, the Continue box says what Continue applies, and the same after a
//   reload. A later change joins it (here the Assistant's, with the same card saying it joins).
//   Continue then applies it (the run records it applied) and the marks go.
// - Start over: the run's results are deleted and it is a draft again.
// - Any other solve setting asks the two-way Overwrite question; a finished run's change offers a
//   new run.
// - The Assistant states its choice in setup_edit's type: none is refused (choose_restart, no
//   card); "at_continue" asks with a compute card, then the panel shows the marks; "start_over"
//   asks with the destructive overwrite card; "at_continue" of a value it already has saves as
//   any change and says nothing new waits.
// - The run keeps the block it solved with (what its Start worked out stays for Continue), and a
//   new run (Add run) gets the settings as typed: its time steps blank, worked out at its Start.
// - A transient run whose study is now Steady-state, or a steady run, never waits for Continue:
//   the person gets the two-way Overwrite question, the Assistant the destructive card.
// - An unhealthy stopped run (where RH1's health meets A2): the question's "Use when continuing"
//   line reads its health as the panel shows it (restart from its latest saved time); What to do
//   and the Continue box offer "Use when continuing" only where the run can take it, and once a
//   change waits (here the Assistant's) both say only Health on the continued part can tell; each
//   earlier part names the change it was continued with; Health's fix makes its new run with the
//   run's own values, not the ones waiting for its Continue.
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake: no WSL) and the scripted model.
// Fails on the code before: the change asked the two-way Overwrite question only (or, from the
// Assistant, was saved with nothing recorded). The last test failed on the code before the seam
// fixes: the line read run.json's stale restart, What to do offered "Use when continuing" to a run
// whose study is Steady-state and kept advising it once a change waited, the earlier parts hung
// the change on the first part, and "Run 8 fixed" got the 3 waiting outer correctors.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PARITY = JSON.parse(readFileSync(join(WEB, 'scripts', 'server', 'assistant', 'parity-rows.json'), 'utf8'));
const PID = 'run-continue-settings-e2e';
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
const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('run-stopped-continue-settings');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Continue settings project');
  host = await startHost({
    name: 'run-stopped-continue-settings',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '4',
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

const runRow = async (request, rid) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === rid) || {};
const runDirOf = async (request, rid) => dirname((await runRow(request, rid)).case_dir);
const runDoc = async (request, rid) => JSON.parse(readFileSync(join(await runDirOf(request, rid), 'run.json'), 'utf8'));

/**
 * A transient run with Max Courant 100 and 1 outer corrector, stopped with its result saved at
 * t = 0.05 (the cavity's case, its last frame renamed), as a solve that stopped there leaves it:
 * its transient block as its Start worked it out (the time steps `auto`, the write interval).
 * `status` 'done' makes it finished instead; `steady` makes it a steady run saved at iteration 50.
 */
async function endedRun(request, name, status = 'stopped', { steady = false } = {}) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name, mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', {
    project_id: PID,
    simulation_id: sim,
    run_id: rid,
    transient: { end_time: 0.1, write_count: 2, max_co: 100, n_outer_correctors: 1, n_correctors: 2 },
  });
  const runDir = await runDirOf(request, rid);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const side = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete side.plugin;
  delete side.study_id;
  writeFileSync(sidecar, JSON.stringify(side, null, 2));
  renameSync(join(caseDir, '0.5'), join(caseDir, steady ? '50' : '0.05'));
  for (const t of ['0.1', '0.2', '0.3', '0.4']) rmSync(join(caseDir, t), { recursive: true, force: true });
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status,
        stage: status,
        ...(steady
          ? { time_dependency: 'Steady-state', analysis_key: 'incompressible_steady', path_kind: 'simpleFoam', last_saved_iteration: 50, iteration: 55, n_steps: 55 }
          : {
              time_dependency: 'Transient',
              analysis_key: 'incompressible_transient',
              path_kind: 'pimpleFoam',
              last_saved_iteration: 0.05,
              iteration: 0.06,
              sim_time: 0.06,
              n_steps: 30,
              // As its Start worked it out (the analysis's plan): the steps `auto`, the write interval.
              transient: {
                ...rec.transient,
                delta_t: 0.0005,
                max_delta_t: 0.05,
                write_interval: 0.05,
                adjust_time_step: true,
                source: { delta_t: 'auto', max_delta_t: 'auto' },
                estimate: { delta_t: 0.0005, steps: 200 },
              },
            }),
        has_results: true,
        n_saved_times: 1,
        residuals: [
          { t: steady ? 10 : 0.01, Ux: 0.1, p: 0.5 },
          { t: steady ? 50 : 0.05, Ux: 0.01, p: 0.05 },
        ],
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
      },
      null,
      2,
    ),
  );
  return { rid, caseDir };
}

/**
 * An unhealthy record from t = `onset`, as the run's health tracker last sent it (run.json keeps
 * that `restart`; the reads work it out again from the run's latest saved time), offering a new
 * run with Max Courant 1.
 */
function sickHealth(onset, restart) {
  return {
    v: 1,
    verdict: 'unhealthy',
    at: new Date().toISOString(),
    step: 30,
    t: 0.06,
    unit: 'time step',
    window: 25,
    live: false,
    checked: ['courant_mode'],
    skipped: [],
    findings: [
      {
        code: 'courant_mode',
        level: 'error',
        text: 'Likely cause: Max Courant 100 with 1 outer corrector (PISO).',
        evidence: null,
        since_t: onset,
        fix: [{ label: 'New run: Max Courant 1', target: 'new_run', values: [{ key: 'transient.max_co', value: 1 }], cost: null }],
      },
    ],
    timeline: [{ t: onset, verdict: 'unhealthy' }],
    first_unhealthy: { t: onset, step: 15, wall_s: 5 },
    restart,
  };
}

/** Puts `health` (and `more`) on the run made by endedRun. */
function writeHealth(caseDir, health, more = {}) {
  const runJson = join(dirname(caseDir), 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(runJson, JSON.stringify({ ...rec, health_checked: true, health, ...more }, null, 2));
}

const open = (page, rid, reload = true) => openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid, reload });
const choice = (page) => page.locator('#modal-run-change');
const confirm = (page) => page.locator('#modal-confirm');
const resultsRow = (page, rid) => page.locator(`#left-tree [data-w27-run-results="${rid}"]`);

/** Opens the run's Advanced settings (Max Courant and the correctors are there). */
async function openAdvanced(panel) {
  const details = panel.locator('details.mesh-advanced').first();
  await expect(details).toBeVisible(STEP);
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
}

async function setField(panel, label, value) {
  const field = panel.getByLabel(label, { exact: true });
  await field.fill(String(value));
  await field.press('Enter');
}

test('Cancel keeps it; Use when continuing keeps the results and marks the field; a later change joins it; Continue applies it', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const { rid, caseDir } = await endedRun(request, 'Run 1');
  let panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible(STEP);
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  await openAdvanced(panel);
  const maxCo = panel.getByLabel('Max Courant number', { exact: true });
  await expect(maxCo).toHaveValue('100');

  // The question: three answers, Cancel focused; Escape answers Cancel.
  await setField(panel, 'Max Courant number', 5);
  await expect(choice(page)).toBeVisible(STEP);
  await expect(confirm(page)).toBeHidden();
  await expect(page.locator('#rcc-heading')).toHaveText('Change "Run 1"?');
  await expect(page.locator('#rcc-copy')).toHaveText('Max Courant 100 → 5. "Run 1" has results up to t = 0.05 s.');
  await expect(page.locator('#rcc-over')).toHaveText('Start over');
  await expect(page.locator('#rcc-over-line')).toHaveText('Deletes its results (1 saved, up to t = 0.05 s) now. Start solves it again from t = 0.');
  await expect(page.locator('#rcc-continue')).toHaveText('Use when continuing');
  await expect(page.locator('#rcc-continue-line')).toHaveText('Keeps its results. Continue goes on from t = 0.05 s with the new value, and the run records the change.');
  await expect(page.locator('#rcc-cancel')).toBeFocused();
  // Parity row R24: the person's control the row names.
  const r24 = PARITY.rows.find((r) => r.row === 'R24');
  await expect(page.locator(r24.ui_control.selector)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(choice(page)).toBeHidden();
  await expect(maxCo).toHaveValue('100');
  await page.waitForTimeout(500);
  let doc = await runDoc(request, rid);
  expect([doc.status, doc.transient.max_co, doc.continue_changes]).toEqual(['stopped', 100, undefined]);
  expect(existsSync(join(caseDir, '0.05')), 'Cancel keeps the results').toBe(true);
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();

  // Use when continuing: its results stay; the field shows 5 and says when it takes effect.
  await setField(panel, 'Max Courant number', 5);
  await expect(choice(page)).toBeVisible(STEP);
  await page.locator('#rcc-continue').click();
  await expect(choice(page)).toBeHidden();
  await expect(page.locator('.app-toasts')).toContainText('Max Courant 5 takes effect when "Run 1" continues.', STEP);
  const shownWaiting = async (line) => {
    await expect(maxCo).toHaveValue('5', STEP);
    await expect(panel.locator('[data-run-takes-effect="max_co"]')).toHaveText('Takes effect when you Continue', STEP);
    await expect(panel.locator('[data-run-continue-changes]')).toHaveText(line, STEP);
    await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
    await expect(panel.locator('[data-run-continue-go="1"]')).toBeEnabled();
    await expect(resultsRow(page, rid)).toBeVisible(STEP);
  };
  await shownWaiting('Continue applies: Max Courant 100 → 5 (from t = 0.05 s).');
  await expect(page.locator(r24.ui_control.marker)).toBeVisible();
  doc = await runDoc(request, rid);
  expect([doc.status, doc.transient.max_co, doc.continue_changes.length]).toEqual(['stopped', 5, 1]);
  expect(doc.continue_changes[0]).toMatchObject({ from_t: 0.05, by: 'person', kind: 'settings', applied_at: null, changes: [{ key: 'transient.max_co', from: 100, to: 5 }] });
  expect(existsSync(join(caseDir, '0.05')), 'its results stay').toBe(true);
  // After a reload, the same.
  panel = await open(page, rid);
  await openAdvanced(panel);
  await shownWaiting('Continue applies: Max Courant 100 → 5 (from t = 0.05 s).');

  // The Assistant's change of the outer correctors joins it: the same card says so.
  fake.reply(
    { text: 'Raising the outer correctors.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'transient.n_outer_correctors', value: '3' }] }) }] },
    { text: 'Continue applies both.' },
  );
  await openDock(page);
  await dockSend(page, 'Use 3 outer correctors when it continues.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to change "Run 1" for when it continues?', { timeout: 60_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText(
    'Joins the change already waiting for "Run 1" to continue. Continue then applies: Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.05 s). Its results are kept.',
  );
  await expect(choice(page), 'the person is asked nothing').toBeHidden();
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator('[data-run-continue-changes]')).toHaveText('Continue applies: Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.05 s).', STEP);
  await expect(panel.locator('[data-run-takes-effect="n_outer_correctors"]')).toHaveText('Takes effect when you Continue');
  await expect(panel.getByLabel('Outer correctors', { exact: true })).toHaveValue('3');
  doc = await runDoc(request, rid);
  expect([doc.continue_changes.length, doc.continue_changes[0].by]).toEqual([1, 'both']);
  expect(existsSync(join(caseDir, '0.05'))).toBe(true);
  expect(fake.pending()).toBe(0);

  // Continue: it goes on from t = 0.05 s with them; the run records them applied and the marks go.
  await panel.locator('[data-run-continue-go="1"]').click();
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 60_000 }).toBe('done');
  doc = await runDoc(request, rid);
  expect(typeof doc.continue_changes[0].applied_at).toBe('string');
  expect([doc.transient.max_co, doc.transient.n_outer_correctors]).toEqual([5, 3]);
  await expect(panel.locator('[data-run-status="done"]')).toBeVisible(STEP);
  await expect(panel.locator('[data-run-takes-effect]')).toHaveCount(0, STEP);
  await expect(panel.locator('[data-run-continue-changes]')).toHaveCount(0);
  // It kept the block it solved with (Continue saves as often as it did, every 0.05 s).
  expect([doc.transient.write_interval, doc.transient.delta_t, doc.transient.source]).toEqual([0.05, 0.0005, { delta_t: 'auto', max_delta_t: 'auto' }]);

  // Add run: the new run gets the settings as typed (Max Courant 5, 3 outer correctors); the time
  // steps "Run 1" worked out at its Start are blank, worked out again at the new run's Start.
  await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
  const before = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id));
  await page.locator('#btn-create-run').click();
  let added = '';
  await expect.poll(async () => {
    added = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id)).find((id) => !before.includes(id)) || '';
    return added;
  }, STEP).not.toBe('');
  await expect(panel).toHaveAttribute('data-run-id', added, STEP);
  await openAdvanced(panel);
  await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('5', STEP);
  await expect(panel.getByLabel('Outer correctors', { exact: true })).toHaveValue('3');
  await expect(panel.getByLabel('Time step in seconds', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Maximum time step in seconds', { exact: true })).toHaveValue('');
});

test('Start over deletes its results; another setting asks the two-way question; a finished run offers a new run', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const { rid, caseDir } = await endedRun(request, 'Run 2');
  let panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible(STEP);

  // Another solve setting: the two-way Overwrite question, never the three-way one.
  await setField(panel, 'Simulation time', 0.2);
  await expect(confirm(page)).toBeVisible(STEP);
  await expect(choice(page)).toBeHidden();
  await expect(page.locator('#cf-heading')).toHaveText('Overwrite "Run 2"?');
  await page.locator('#cf-cancel').click();
  await expect(confirm(page)).toBeHidden();
  await expect(panel.getByLabel('Simulation time', { exact: true })).toHaveValue('0.1');

  // The run changed elsewhere while the question was open: "Use when continuing" saves nothing
  // over that change (the rev it had when asked), and says so.
  await openAdvanced(panel);
  await setField(panel, 'Max Courant number', 5);
  await expect(choice(page)).toBeVisible(STEP);
  const revBefore = (await runDoc(request, rid)).rev;
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, cores: 2 });
  expect((await runDoc(request, rid)).rev).not.toBe(revBefore);
  await page.locator('#rcc-continue').click();
  await expect(confirm(page)).toBeVisible(STEP);
  await expect(page.locator('#cf-heading')).toHaveText('Not saved: changed elsewhere');
  await page.locator('#cf-confirm').click();
  await expect(confirm(page)).toBeHidden();
  await openAdvanced(panel);
  await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('100', STEP);
  const kept = await runDoc(request, rid);
  expect([kept.status, kept.transient.max_co, kept.continue_changes, kept.cores]).toEqual(['stopped', 100, undefined, 2]);
  expect(existsSync(join(caseDir, '0.05'))).toBe(true);

  // Start over: the existing overwrite path.
  await openAdvanced(panel);
  await setField(panel, 'Max Courant number', 5);
  await expect(choice(page)).toBeVisible(STEP);
  await page.locator('#rcc-over').click();
  await expect(choice(page)).toBeHidden();
  await expect(page.locator('.app-toasts')).toContainText('"Run 2" starts over: its old results were deleted.', STEP);
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.status, r.transient?.max_co, r.has_results];
  }, STEP).toEqual(['draft', 5, false]);
  expect(existsSync(caseDir), 'its case folder is gone').toBe(false);
  await expect(panel.locator('[data-run-status]')).toHaveCount(0, STEP);
  await expect(panel.locator('[data-run-continue="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-run-takes-effect]')).toHaveCount(0);

  // A finished run's change offers a new run with its settings (never "Use when continuing").
  const done = await endedRun(request, 'Run 3', 'done');
  panel = await open(page, done.rid);
  await expect(panel.locator('[data-run-status="done"]')).toBeVisible(STEP);
  await openAdvanced(panel);
  await setField(panel, 'Max Courant number', 5);
  await expect(confirm(page)).toBeVisible(STEP);
  await expect(choice(page)).toBeHidden();
  await expect(page.locator('#cf-heading')).toHaveText('"Run 3" has finished');
  await page.locator('#cf-cancel').click();
  await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('100');
  expect((await runRow(request, done.rid)).status).toBe('done');
});

test("the Assistant says how the change applies: none is refused, at_continue asks with a compute card, start_over with the destructive one", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const { rid, caseDir } = await endedRun(request, 'Run 4');
  const panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible(STEP);
  const maxCo = (type) => setup({ kind: 'run', action: 'update', id: rid, type, values: [{ key: 'transient.max_co', value: '5' }] });
  const chats = () => fake.requests().filter((r) => r.kind === 'chat');
  const before = chats().length;
  fake.reply(
    { text: 'Lowering Max Courant.', tools: [{ name: 'setup_edit', input: maxCo('') }] },
    { text: 'Keeping its results.', tools: [{ name: 'setup_edit', input: maxCo('at_continue') }] },
    { text: 'It takes effect when it continues.' },
  );
  await openDock(page);
  await dockSend(page, 'Set Max Courant to 5 for when it continues.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to change "Run 4" for when it continues?', { timeout: 60_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText('Max Courant 100 → 5 takes effect when "Run 4" continues from t = 0.05 s. Its results are kept.');
  // The call with no type was refused with the choice to make, and asked nothing.
  const refused = resultsIn(chats()[before + 1])[0];
  expect([refused.ok, refused.error.code]).toEqual([false, 'choose_restart']);
  expect(refused.error.message).toBe('"Run 4" has results up to t = 0.05 s. Say how Max Courant 100 → 5 applies.');
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await openAdvanced(panel);
  await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('5', STEP);
  await expect(panel.locator('[data-run-takes-effect="max_co"]')).toHaveText('Takes effect when you Continue', STEP);
  await expect(panel.locator('[data-run-continue-changes]')).toHaveText('Continue applies: Max Courant 100 → 5 (from t = 0.05 s).');
  const doc = await runDoc(request, rid);
  expect(doc.continue_changes[0]).toMatchObject({ by: 'assistant', applied_at: null });
  expect(existsSync(join(caseDir, '0.05'))).toBe(true);

  // at_continue of the value it already has: nothing to ask or refuse; it says nothing new waits.
  const again = chats().length;
  fake.reply({ text: 'Again.', tools: [{ name: 'setup_edit', input: maxCo('at_continue') }] }, { text: 'It already waits.' });
  await dockSend(page, 'Max Courant 5 for when it continues, please.');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await expect(dockTurn(page).locator('[data-gate]')).toHaveCount(0);
  const same = resultsIn(chats()[again + 1])[0];
  expect(same.ok, JSON.stringify(same)).toBe(true);
  expect(same.data.done).toBe(
    'Saved transient.max_co of run "Run 4". No solve setting changed: nothing new waits for its Continue. Continue applies: Max Courant 100 → 5 (from t = 0.05 s).',
  );
  await expect(panel.locator('[data-run-continue-changes]')).toHaveText('Continue applies: Max Courant 100 → 5 (from t = 0.05 s).');

  // start_over: the destructive overwrite card; declined, nothing changes.
  fake.reply(
    { text: 'Starting it over.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, type: 'start_over', values: [{ key: 'transient.max_co', value: '2' }] }) }] },
    { text: 'Left as it is.' },
  );
  await dockSend(page, 'Start it over with Max Courant 2.');
  const over = dockGate(page);
  await expect(over.locator('.dock-gate-title')).toHaveText('Allow the Assistant to overwrite "Run 4"?', { timeout: 60_000 });
  await expect(over.locator('.dock-gate-copy')).toContainText('Changing this setting starts "Run 4" over. Its results (1 saved, up to t = 0.05 s) are deleted now');
  await over.locator('[data-gate-answer="no"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end]')).toBeVisible({ timeout: 90_000 });
  expect((await runRow(request, rid)).status).toBe('stopped');
  expect(existsSync(join(caseDir, '0.05'))).toBe(true);
  expect(fake.pending()).toBe(0);
});

test('a transient run whose study is now Steady-state, or a steady run: the two-way question and the destructive card, never "Use when continuing"', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const { rid, caseDir } = await endedRun(request, 'Run 5');
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
  try {
    const steady = await endedRun(request, 'Run 6', 'stopped', { steady: true });
    const panel = await open(page, rid);
    await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible(STEP);
    await openAdvanced(panel);
    // The person: Max Courant asks the two-way Overwrite question, as the reason line says.
    await setField(panel, 'Max Courant number', 5);
    await expect(confirm(page)).toBeVisible(STEP);
    await expect(choice(page)).toBeHidden();
    await expect(page.locator('#cf-heading')).toHaveText('Overwrite "Run 5"?');
    await expect(page.locator('#cf-copy')).toContainText('It becomes a Steady-state run, as its study is now.');
    await page.locator('#cf-cancel').click();
    await expect(confirm(page)).toBeHidden();
    await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('100', STEP);

    // The Assistant: at_continue is refused with why (no card) for both; without a type, the destructive card.
    const edit = (id, type) => setup({ kind: 'run', action: 'update', id, type, values: [{ key: 'transient.max_co', value: '5' }] });
    const chats = () => fake.requests().filter((r) => r.kind === 'chat');
    const before = chats().length;
    fake.reply(
      { text: 'For when it continues.', tools: [{ name: 'setup_edit', input: edit(rid, 'at_continue') }] },
      { text: 'And the steady one.', tools: [{ name: 'setup_edit', input: edit(steady.rid, 'at_continue') }] },
      { text: 'Then it starts over.', tools: [{ name: 'setup_edit', input: edit(rid, '') }] },
      { text: 'Left as it is.' },
    );
    await openDock(page);
    await dockSend(page, 'Set Max Courant to 5 for when they continue.');
    const card = dockGate(page);
    await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to overwrite "Run 5"?', { timeout: 60_000 });
    await expect(card.locator('.dock-gate-copy')).toContainText('It becomes a Steady-state run, as its study is now.');
    const mismatch = resultsIn(chats()[before + 1])[0];
    expect([mismatch.ok, mismatch.error.code, mismatch.error.message]).toEqual([
      false,
      'not_continue_settings',
      '"Run 5" solved Transient; its study is now Steady-state: a change of its settings starts it over as a Steady-state run.',
    ]);
    const steadyRefused = resultsIn(chats()[before + 2])[0];
    expect([steadyRefused.ok, steadyRefused.error.code]).toEqual([false, 'not_continue_settings']);
    expect(steadyRefused.error.message).toBe(
      '"Run 6" solved Steady-state: its Continue goes on in iterations and never uses Max Courant, the correctors or Max time step. A change of them starts it over.',
    );
    await card.locator('[data-gate-answer="no"]').click(STEP);
    await expect(dockTurn(page).locator('[data-turn-end]')).toBeVisible({ timeout: 90_000 });
    expect(fake.pending()).toBe(0);
    for (const [id, dir, t] of [[rid, caseDir, '0.05'], [steady.rid, steady.caseDir, '50']]) {
      const d = await runDoc(request, id);
      expect([d.status, d.transient?.max_co, d.continue_changes]).toEqual(['stopped', 100, undefined]);
      expect(existsSync(join(dir, t))).toBe(true);
    }
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
  }
});

test("an unhealthy stopped run: the question, What to do, the Continue box and the fix's new run say what is true for it", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');

  // Run 7 became unhealthy at t = 0.03 and its result at t = 0.05 was saved after the tracker last
  // sent its record (run.json still says continue_after_fix). The panel reads from_zero, and so
  // does the question's "Use when continuing" line.
  const seven = await endedRun(request, 'Run 7');
  writeHealth(seven.caseDir, sickHealth(0.03, 'continue_after_fix'));
  let panel = await open(page, seven.rid);
  const next = panel.locator('[data-run-health-next="1"]');
  await expect(next).toHaveText(
    'Its saved results (from t = 0.05 s) come after the problem began (t = 0.03 s), so Continue would carry it on. Start again from t = 0 in a new run; Run 7 and its results stay.',
    STEP,
  );
  await openAdvanced(panel);
  await setField(panel, 'Max Courant number', 5);
  await expect(choice(page)).toBeVisible(STEP);
  await expect(page.locator('#rcc-continue-line')).toHaveText(
    'Keeps its results. Continue goes on from t = 0.05 s with the new value, and the run records the change. Its saved results are from after it became unhealthy (t = 0.03 s); continuing from them carries that on.',
  );
  await page.keyboard.press('Escape');
  await expect(choice(page)).toBeHidden();

  // Run 8 became unhealthy at t = 0.08, after its last saved time (0.05). It was continued twice
  // before: once with no change (to t = 0.01), once with pressure correctors 1 → 2 (from t = 0.02).
  const eight = await endedRun(request, 'Run 8');
  writeHealth(eight.caseDir, sickHealth(0.08, 'continue_after_fix'), {
    attempts: [
      { status: 'stopped', last_saved_iteration: 0.01, health: { verdict: 'healthy', codes: [] } },
      { status: 'stopped', last_saved_iteration: 0.02, health: { verdict: 'watch', codes: ['courant_mode'] } },
    ],
    continue_changes: [
      { from_t: 0.02, from_iteration: null, at: '2026-11-03T10:00:00.000Z', by: 'person', kind: 'settings', changes: [{ key: 'transient.n_correctors', from: 1, to: 2 }], applied_at: '2026-11-03T10:01:00.000Z' },
    ],
  });
  const said = 'Its last saved time (t = 0.05 s) is before it became unhealthy (t = 0.08 s).';
  const same = 'Continue goes on from there; with the same settings it will likely become unhealthy again.';
  // Its study now Steady-state: no change can wait for its Continue, so nothing offers one.
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
  try {
    panel = await open(page, eight.rid);
    await expect(panel.locator('[data-run-health-next="1"]')).toHaveText(`${said} ${same} A new run from t = 0 is the surer way.`, STEP);
    await expect(panel.locator('[data-run-continue-health="1"]')).toHaveText(`${said} ${same} A new run from t = 0 is the surer way.`);
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
  }
  panel = await open(page, eight.rid);
  await expect(panel.locator('[data-run-health-next="1"]')).toHaveText(
    `${said} ${same} A change made with "Use when continuing" (Max Courant or the correctors) may avoid that, but only Health on the continued part can tell. A new run from t = 0 is the surer way.`,
    STEP,
  );
  // Each earlier part with the change made when it was continued.
  await expect(panel.locator('[data-run-health-earlier="1"]')).toHaveText([
    'Earlier part (to t = 0.01 s): Healthy.',
    'Earlier part (to t = 0.02 s): Watch closely (Courant number). Then pressure correctors 1 → 2 from t = 0.02 s.',
  ]);

  // The Assistant sets 3 outer correctors for when it continues: the Continue box and What to do
  // both read that change, and say only Health on the continued part can tell.
  fake.reply(
    { text: 'Raising the outer correctors for when it continues.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: eight.rid, type: 'at_continue', values: [{ key: 'transient.n_outer_correctors', value: '3' }] }) }] },
    { text: 'It waits for Continue.' },
  );
  await openDock(page);
  await dockSend(page, 'Use 3 outer correctors when Run 8 continues.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to change "Run 8" for when it continues?', { timeout: 60_000 });
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  const checks = 'Health checks the continued part from t = 0.05 s; whether the change is enough shows only there.';
  await expect(panel.locator('[data-run-continue-changes]')).toHaveText('Continue applies: outer correctors 1 → 3 (from t = 0.05 s).', STEP);
  await expect(panel.locator('[data-run-continue-health="1"]')).toHaveText(checks, STEP);
  await expect(panel.locator('[data-run-health-next="1"]')).toHaveText(`${said} ${checks} A new run from t = 0 is the surer way.`, STEP);
  expect(fake.pending()).toBe(0);

  // Health's fix makes the run its words and cost describe: Max Courant 1 with the 1 outer
  // corrector Run 8 solved with, not the 3 that wait for Run 8's Continue.
  const fixButton = panel.locator('[data-run-health-newrun="0"]');
  await expect(fixButton).toHaveText('New run: Max Courant 1');
  await fixButton.click();
  await expect(panel.locator('[data-run-title="1"]')).toHaveText('Run 8 fixed', STEP);
  const fixedId = String(await panel.getAttribute('data-run-id'));
  expect(fixedId).not.toBe(eight.rid);
  await expect.poll(async () => {
    const r = await runRow(request, fixedId);
    return [r.status || 'draft', r.transient?.max_co, r.transient?.n_outer_correctors];
  }, STEP).toEqual(['draft', 1, 1]);
  // Run 8 keeps its results and the change waiting for its Continue.
  const kept = await runDoc(request, eight.rid);
  expect([kept.status, kept.transient.n_outer_correctors, kept.continue_changes.filter((e) => !e.applied_at).length]).toEqual(['stopped', 3, 1]);
  expect(existsSync(join(eight.caseDir, '0.05'))).toBe(true);
});
