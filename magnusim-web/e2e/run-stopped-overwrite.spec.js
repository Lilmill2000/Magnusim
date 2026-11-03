// A run that ended, and a change of its settings (Daniel, 2026-11-03: "if I'm in a simulation
// run and I start it, stop it, and want to change some settings ... it should let me do that,
// but give a warning that it will overwrite the current run"):
// - On a stopped run with results, the first change of a solve setting asks (Overwrite "Run 1"?,
//   Cancel by default). Cancel keeps everything (the field shows the saved value, the results and
//   Continue stay). Overwrite deletes the results at once: the run is a draft with the change,
//   Continue, the tree's Results row and its Monitors panel's charts go, and it stays so after a
//   reload. A second change made while that save is on its way, and later edits, ask nothing;
//   Start solves it from the beginning.
// - A reset the server refuses (the run still stops) is not saved: a toast says why, and the
//   field shows the saved value again.
// - A stopped run with nothing saved and a queued Start: a change asks nothing, and the queued
//   Start stays and solves it.
// - Start on a stopped run with results asks too (Start "Run 1" over?); Cancel posts nothing.
// - After the study's time dependency changed, the panel says what Start or a change does, the
//   question names the mode, and the run follows its study once started over.
// - A finished run is never overwritten: a change asks to make a new run with the same settings
//   (write interval, cores, monitors and their stop) and the change ("Run 1" has finished / Make
//   new run), which is selected; Cancel restores. After its study changed mode, the new run
//   solves the study's mode.
// - The Assistant's change of a stopped run asks in the dock with the same words.
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake: no WSL) and the scripted model.
// Fails on the code before: a stopped run's change saved with no question and its results stayed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'run-overwrite-e2e';
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
  const tmp = e2eTemp('run-stopped-overwrite');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Overwrite project');
  host = await startHost({
    name: 'run-stopped-overwrite',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '6',
    },
  });
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  meshId = String(doc.mesh.id);
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 90_000 }).toBe('done');
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

const runRow = async (request, rid) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === rid) || {};
const runDirOf = async (request, rid) => dirname((await runRow(request, rid)).case_dir);
const slotFree = async (request) => {
  await expect.poll(async () => {
    const q = await getJson(request, '/api/compute-queue');
    return !q.live && !q.busy;
  }, { timeout: 30_000 }).toBe(true);
};

/** A new run of 100 iterations saving every 50, on the generated mesh. */
async function newRun(request, name) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name, mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, endTime: 100, writeInterval: 50 });
  return rid;
}

/** Its saved result at iteration 50 (the cavity's last frame), as a solve that stopped there leaves it; `extra` over its record. */
async function giveResults(request, rid, status, extra = {}) {
  const runDir = await runDirOf(request, rid);
  const caseDir = join(runDir, 'case');
  mkdirSync(caseDir, { recursive: true });
  cpSync(join(CAVITY, '0.5'), join(caseDir, '50'), { recursive: true });
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status,
        stage: status,
        time_dependency: rec.time_dependency || 'Steady-state',
        has_results: true,
        n_saved_times: 1,
        last_saved_iteration: 50,
        iteration: status === 'done' ? 100 : 60,
        n_steps: status === 'done' ? 100 : 60,
        endTime: 100,
        writeInterval: 50,
        residuals: [{ t: 1, Ux: 1, p: 1 }, { t: 50, Ux: 0.01, p: 0.02 }],
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
        ...extra,
      },
      null,
      2,
    ),
  );
  return caseDir;
}

/** The run's record as stored (run.json): what the status rows leave out (its cores). */
const runDoc = async (request, rid) => JSON.parse(readFileSync(join(await runDirOf(request, rid), 'run.json'), 'utf8'));

/** A run stopped with its result at iteration 50, through the server's own Start and Stop. */
async function stoppedRun(request, name) {
  const rid = await newRun(request, name);
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  await slotFree(request);
  return { rid, caseDir: await giveResults(request, rid, 'stopped') };
}

const panelOf = (page) => page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
const open = (page, rid, reload = true) => openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid, reload });
const resultsRow = (page, rid) => page.locator(`#left-tree [data-w27-run-results="${rid}"]`);
const modal = (page) => page.locator('#modal-confirm');

async function setField(panel, label, value) {
  const field = panel.getByLabel(label, { exact: true });
  await field.fill(String(value));
  await field.press('Enter');
}

/** A monitor row as a solve's /api/run/monitors gives it (the fake compute writes none). */
const OLD_MONITOR = {
  key: 'old-outlet',
  name: 'Old outlet',
  patch: 'outlet',
  write_control: 'Time step',
  series: [
    { t: 1, p: 1 },
    { t: 50, p: 2 },
  ],
  final: { pressure_Pa: 2 },
};

/** Opens the run's Monitors panel from the tree, as the person does. */
async function openRunMonitors(page, rid) {
  const runLi = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  await expect(runLi).toBeVisible(STEP);
  if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) await runLi.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree li[data-w27-run-rcs="${rid}"] > .tree-row .tl`).click();
  await expect(page.locator('#panel-results-hub')).toBeVisible(STEP);
}

/** A Forces monitor as the run records it (convergence.spec.js's). */
const FORCES = {
  write_control: 'Time step',
  results: null,
  series: null,
  chart_values: null,
  results_available: false,
  id: 'rc-fin-f1',
  name: 'Forces 1',
  monitor_type: 'forces',
  kind: 'Forces',
  category: 'Boundary data',
  boundaries: ['@walls'],
};

/** The compute queue's rows of this run. */
const queuedRows = async (request, rid) => ((await getJson(request, '/api/compute-queue')).items || []).filter((r) => String(r.run_id) === rid);

test('a stopped run: a change asks first, Cancel keeps its results, Overwrite starts it over, and Start solves it from the beginning', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const rid = await newRun(request, 'Run 1');
  // Started and stopped from its panel, as the person does.
  let panel = await open(page, rid);
  await panel.locator('[data-run-start]').click();
  await expect(panel.locator('[data-run-status="running"]')).toBeVisible(STEP);
  await panel.locator('[data-run-stop="1"]').click();
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  await slotFree(request);
  const caseDir = await giveResults(request, rid, 'stopped');
  panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  await expect(resultsRow(page, rid)).toBeVisible(STEP);
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  const iterations = panel.getByLabel('Iterations', { exact: true });
  await expect(iterations).toHaveValue('100');
  await expect(iterations).toBeEnabled();

  // The first change of a solve setting asks; Cancel is the safe answer.
  await setField(panel, 'Iterations', 200);
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Overwrite "Run 1"?');
  await expect(page.locator('#cf-copy')).toHaveText(
    'Changing this setting starts "Run 1" over. Its results (1 saved, up to iteration 50) are deleted now, and Start solves it again from the beginning. To keep them, cancel and add a run, or use Continue to go on from iteration 50.',
  );
  await expect(page.locator('#cf-confirm')).toHaveText('Overwrite');
  await expect(page.locator('#cf-cancel')).toBeFocused();
  await page.locator('#cf-cancel').click();
  await expect(modal(page)).toBeHidden();
  await expect(iterations).toHaveValue('100');
  await page.waitForTimeout(500);
  const kept = await runRow(request, rid);
  expect([kept.status, kept.endTime, kept.has_results]).toEqual(['stopped', 100, true]);
  expect(existsSync(join(caseDir, '50')), 'Cancel keeps the results').toBe(true);
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  await expect(resultsRow(page, rid)).toBeVisible();

  // Its Monitors panel shows what its solve recorded (the page keeps it).
  const monitorsOfRun = (url) => url.pathname === '/api/run/monitors' && url.searchParams.get('run_id') === rid;
  await page.route(monitorsOfRun, (route) =>
    route.fulfill({ json: { ok: true, run_id: rid, status: 'stopped', transient: false, monitors: [OLD_MONITOR], custom: [] } }),
  );
  await openRunMonitors(page, rid);
  const monitorList = page.locator('#panel-results-hub #run-monitors-list');
  await expect(monitorList).toContainText('Old outlet', STEP);
  panel = await open(page, rid, false);

  // Overwrite: the results go now, and the run is a draft with the change, with no reload. A
  // second change made while that save is still on its way asks nothing more, and is saved after it.
  await page.evaluate(() => {
    window.__OVERWRITE_SAME_PAGE__ = true;
  });
  let release = () => {};
  const held = new Promise((r) => {
    release = r;
  });
  let holding = 0;
  const runUpdates = (url) => url.pathname === '/api/run/update';
  await page.route(runUpdates, async (route) => {
    const body = route.request().postDataJSON() || {};
    if (body.overwrite === true && !holding) {
      holding += 1;
      await held;
    }
    await route.continue();
  });
  await setField(panel, 'Iterations', 200);
  await expect(modal(page)).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(modal(page)).toBeHidden();
  await expect.poll(() => holding, STEP).toBe(1);
  await setField(panel, 'Write interval', 25);
  await page.waitForTimeout(800);
  await expect(modal(page), 'the second change asks nothing').toBeHidden();
  release();
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.status, r.endTime, r.writeInterval, r.has_results, Number(r.n_saved_times) || 0];
  }, STEP).toEqual(['draft', 200, 25, false, 0]);
  await expect(page.locator('.app-toasts')).toContainText('"Run 1" starts over: its old results were deleted.', STEP);
  await page.unroute(runUpdates);
  // No "changed elsewhere" notice for the second change.
  await expect(modal(page)).toBeHidden();
  expect(existsSync(caseDir), 'its case folder is gone').toBe(false);
  const shownAsDraft = async () => {
    // Not started: its progress block (Run stopped, the iteration it stopped at) is gone.
    await expect(panel.locator('[data-run-status]')).toHaveCount(0, STEP);
    await expect(iterations).toHaveValue('200');
    await expect(panel.getByLabel('Write interval', { exact: true })).toHaveValue('25');
    await expect(panel.locator('[data-run-continue="1"]')).toHaveCount(0);
    await expect(resultsRow(page, rid)).toHaveCount(0, STEP);
    await expect(panel.locator('[data-run-start]')).toBeEnabled(STEP);
  };
  await shownAsDraft();
  // Its Monitors panel no longer shows the deleted results' charts: a draft's.
  await openRunMonitors(page, rid);
  await expect(monitorList).toContainText('Values appear once the run starts.', STEP);
  await expect(monitorList).not.toContainText('Old outlet');
  await page.unroute(monitorsOfRun);
  panel = await open(page, rid, false);
  expect(await page.evaluate(() => window.__OVERWRITE_SAME_PAGE__ === true), 'no reload').toBe(true);
  panel = await open(page, rid);
  await shownAsDraft();

  // A draft now: further changes ask nothing.
  await setField(panel, 'Write interval', 20);
  await expect.poll(async () => (await runRow(request, rid)).writeInterval, STEP).toBe(20);
  await expect(modal(page)).toBeHidden();

  // Start solves it from the beginning, to the new end, and the old result does not come back.
  await panel.locator('[data-run-start]').click();
  await expect(modal(page)).toBeHidden();
  await expect(panel.locator('[data-run-line="1"]')).toHaveText(/^Iteration \d+ \/ 200$/, { timeout: 60_000 });
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 60_000 }).toBe('done');
  expect(existsSync(join(caseDir, '50'))).toBe(false);
  expect((await runRow(request, rid)).endTime).toBe(200);
});

test('Start on a stopped run with results asks first; Cancel sends nothing; after the study changed mode it solves the new mode', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const { rid, caseDir } = await stoppedRun(request, 'Run 2');
  let panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  const sent = [];
  page.on('request', (r) => {
    if (/\/api\/run\/(start|reopen|update)/.test(r.url())) sent.push(r.url());
  });
  await panel.locator('[data-run-start]').click();
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Start "Run 2" over?');
  await expect(page.locator('#cf-copy')).toHaveText(
    'Its results (1 saved, up to iteration 50) are deleted, and it solves again from the beginning. To keep them, cancel and use Continue to go on from iteration 50, or add a run.',
  );
  await expect(page.locator('#cf-confirm')).toHaveText('Overwrite and start');
  await page.locator('#cf-cancel').click();
  await expect(modal(page)).toBeHidden();
  await page.waitForTimeout(800);
  expect(sent, 'Cancel sends nothing').toEqual([]);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  await expect(panel).not.toContainText('Starting');
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  expect(existsSync(join(caseDir, '50'))).toBe(true);

  // The study becomes Transient: the stopped Steady-state run says what Start does now.
  await page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row .tl`).first().click();
  const td = page.getByRole('complementary', { name: 'Setup details' }).getByLabel('Time dependency');
  await expect(td).toBeVisible(STEP);
  await td.selectOption('Transient');
  await expect.poll(async () => (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation?.time_dependency, STEP).toMatch(/transient/i);
  try {
    panel = await open(page, rid);
    await expect(panel.locator('[data-run-mode="1"]')).toHaveText('Steady-state');
    await expect(panel.locator('[data-run-reason="1"]')).toContainText(
      'This run solved Steady-state; its study is now Transient. Start or a settings change solves Transient in this run and overwrites its results. Add a run to keep them.',
    );
    await panel.locator('[data-run-start]').click();
    await expect(modal(page)).toBeVisible();
    await expect(page.locator('#cf-copy')).toHaveText(/ It solves Transient, as its study is now\.$/);
    await page.locator('#cf-confirm').click();
    await expect(modal(page)).toBeHidden();
    await expect(page.locator('.app-toasts')).toContainText('"Run 2" starts over: its old results were deleted.', STEP);
    await expect.poll(async () => (await runRow(request, rid)).time_dependency, STEP).toBe('Transient');
    await expect(panel.locator('[data-run-mode="1"]')).toHaveText('Transient', STEP);
    await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 60_000 }).toMatch(/^(running|done)$/);
    expect(existsSync(join(caseDir, '50'))).toBe(false);
    await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 60_000 }).toBe('done');
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
    await slotFree(request);
  }
});

test('a reset the server refuses (the run still stops) is not saved: a toast says why, and the field shows the saved value', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const STOPPING = 'This run is still stopping. Its settings can change once it has stopped.';
  const { rid, caseDir } = await stoppedRun(request, 'Stopping run');
  const panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  const iterations = panel.getByLabel('Iterations', { exact: true });
  await expect(iterations).toHaveValue('100');
  // The server still holds the run's stop (its slot drains): it refuses the reset with its words.
  const runUpdates = (url) => url.pathname === '/api/run/update';
  await page.route(runUpdates, (route) =>
    (route.request().postDataJSON() || {}).overwrite === true
      ? route.fulfill({ status: 409, json: { ok: false, code: 'still_stopping', error: STOPPING } })
      : route.continue(),
  );
  await setField(panel, 'Iterations', 200);
  await expect(modal(page)).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(modal(page)).toBeHidden();
  await expect(page.locator('.app-toasts')).toContainText(`Not saved. ${STOPPING}`, STEP);
  await expect(iterations).toHaveValue('100', STEP);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  const kept = await runRow(request, rid);
  expect([kept.status, kept.endTime, kept.has_results]).toEqual(['stopped', 100, true]);
  expect(existsSync(join(caseDir, '50'))).toBe(true);
  await page.unroute(runUpdates);
  // Once it has stopped, the same change asks again and starts it over.
  await setField(panel, 'Iterations', 200);
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Overwrite "Stopping run"?');
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.status, r.endTime];
  }, STEP).toEqual(['draft', 200]);
  await expect(iterations).toHaveValue('200', STEP);
});

test('a stopped run with nothing saved, queued to start: a change asks nothing, and its queued Start stays and solves it', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // Stopped before it saved anything (the fake solve writes no results).
  const rid = await newRun(request, 'Queued run');
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  await slotFree(request);
  expect(!!(await runRow(request, rid)).has_results).toBe(false);
  const busy = await newRun(request, 'Busy run');
  const panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  // Another run solves: Start queues this one.
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: busy });
  await expect.poll(async () => (await runRow(request, busy)).status, STEP).toBe('running');
  const start = panel.locator('[data-run-start]');
  await start.click();
  await expect(start).toHaveText('Remove from queue', STEP);
  expect((await queuedRows(request, rid)).length).toBe(1);
  // Its iterations change with no question (nothing to overwrite): it is a draft again, still queued.
  await setField(panel, 'Iterations', 300);
  await expect.poll(async () => (await runRow(request, rid)).endTime, STEP).toBe(300);
  await expect(modal(page)).toBeHidden();
  // It starts once the other run has finished, and solves to the new end.
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 90_000 }).toBe('done');
  await expect(panel.locator('[data-run-status="done"]')).toBeVisible(STEP);
  expect((await runRow(request, rid)).endTime).toBe(300);
  await slotFree(request);
});

test('a finished run keeps its results: a change makes a new run with the same settings, selected; Cancel restores', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const rid = await newRun(request, 'Finished run');
  // Settings that are none of a new run's defaults: a write interval, its cores, a monitor and a stop on it.
  const caseDir = await giveResults(request, rid, 'done', {
    writeInterval: 25,
    cores: 2,
    result_controls: [FORCES],
    settle: { source: 'monitor', id: FORCES.id, quantity: 'Cd', tolerance: 0.001, window: 100 },
  });
  let panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="done"]')).toBeVisible();
  await expect(panel.locator('[data-run-reason="1"]')).toContainText('This run finished. Changing a setting makes a new run with the same settings and that change.');
  await expect(panel.locator('[data-run-reason="1"]').getByRole('button', { name: 'Add run' })).toBeVisible();
  await expect(panel.locator('[data-run-start]')).toHaveCount(0);
  const iterations = panel.getByLabel('Iterations', { exact: true });
  await expect(iterations).toBeEnabled();
  const before = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id));

  await setField(panel, 'Iterations', 300);
  await expect(modal(page)).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('"Finished run" has finished');
  await expect(page.locator('#cf-copy')).toHaveText('Its results stay as they are. Make a new run with the same settings and this change?');
  await expect(page.locator('#cf-confirm')).toHaveText('Make new run');
  await page.locator('#cf-cancel').click();
  await expect(modal(page)).toBeHidden();
  await expect(iterations).toHaveValue('100');
  await page.waitForTimeout(500);
  expect((await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.length).toBe(before.length);

  await setField(panel, 'Iterations', 300);
  await expect(modal(page)).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(modal(page)).toBeHidden();
  let made = '';
  await expect.poll(async () => {
    made = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id)).find((id) => !before.includes(id)) || '';
    return made;
  }, STEP).not.toBe('');
  // The new run has the finished run's settings and the change, and is the one shown.
  await expect.poll(async () => {
    const r = await runRow(request, made);
    return [r.status || 'draft', r.endTime, r.writeInterval, String(r.mesh_id), (r.result_controls || []).map((c) => c.name)];
  }, STEP).toEqual(['draft', 300, 25, meshId, ['Forces 1']]);
  const copied = await runDoc(request, made);
  expect(copied.cores, 'its cores').toBe(2);
  const monitorId = String(copied.result_controls[0].id);
  expect(monitorId, 'the copied monitor has its own id').not.toBe(FORCES.id);
  expect([copied.settle?.id, copied.settle?.quantity, copied.settle?.tolerance, copied.settle?.window], 'its stop follows its own monitor').toEqual([monitorId, 'Cd', 0.001, 100]);
  const newName = (await runRow(request, made)).name;
  expect(newName).toMatch(/^Run \d+$/);
  await expect(panel).toHaveAttribute('data-run-id', made, STEP);
  await expect(iterations).toHaveValue('300');
  await expect(panel.locator('[data-run-status]')).toHaveCount(0);
  await expect(panel.locator('[data-run-start]')).toBeVisible();
  await expect(page.locator(`#left-tree li[data-w27-run="${made}"]`).first()).toHaveClass(/selected/, STEP);
  await expect(page.locator('.app-toasts')).toContainText(`Made "${newName}" with the settings of "Finished run" and your change. "Finished run" keeps its results.`, STEP);
  // The finished run is as it was.
  const done = await runRow(request, rid);
  expect([done.status, done.endTime, done.has_results]).toEqual(['done', 100, true]);
  expect(existsSync(join(caseDir, '50'))).toBe(true);
  panel = await open(page, rid);
  await expect(iterations).toHaveValue('100');
  await expect(resultsRow(page, rid)).toBeVisible(STEP);

  // The study becomes Transient: the panel says so, and the new run a change makes solves Transient.
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
  try {
    panel = await open(page, rid);
    await expect(panel.locator('[data-run-reason="1"]')).toContainText(
      "This run solved Steady-state; its study is now Transient. Changing a setting makes a new Transient run with this run's settings.",
      STEP,
    );
    const runs = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id));
    await setField(panel, 'Iterations', 400);
    await expect(modal(page)).toBeVisible();
    await expect(page.locator('#cf-heading')).toHaveText('"Finished run" has finished');
    await page.locator('#cf-confirm').click();
    await expect(modal(page)).toBeHidden();
    let again = '';
    await expect.poll(async () => {
      again = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id)).find((id) => !runs.includes(id)) || '';
      return again;
    }, STEP).not.toBe('');
    await expect.poll(async () => (await runRow(request, again)).time_dependency, STEP).toBe('Transient');
    await expect(panel).toHaveAttribute('data-run-id', again, STEP);
    await expect(panel.locator('[data-run-mode="1"]')).toHaveText('Transient', STEP);
    const kept = await runRow(request, rid);
    expect([kept.status, kept.time_dependency, kept.endTime]).toEqual(['done', 'Steady-state', 100]);
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
  }
});

test("the Assistant's change of a stopped run asks in the dock with the same words, then the panel shows it started over", async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const { rid, caseDir } = await stoppedRun(request, 'Assistant run');
  const panel = await open(page, rid);
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible();
  await expect(panel.locator('[data-run-continue="1"]')).toBeVisible();
  fake.reply(
    { text: 'Changing the iterations.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'endTime', value: '300' }] }) }] },
    { text: 'Assistant run starts over with 300 iterations.' },
  );
  await openDock(page);
  await dockSend(page, 'Run it for 300 iterations.');
  const card = dockGate(page);
  await expect(card.locator('.dock-gate-title')).toHaveText('Allow the Assistant to overwrite "Assistant run"?', { timeout: 60_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText(
    'Changing this setting starts "Assistant run" over. Its results (1 saved, up to iteration 50) are deleted now, and Start solves it again from the beginning. To keep them, cancel and add a run, or use Continue to go on from iteration 50.',
  );
  // The app's own dialog stays shut: the Assistant asks in the dock.
  await expect(modal(page)).toBeHidden();
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => {
    const r = await runRow(request, rid);
    return [r.status, r.endTime, r.has_results];
  }, STEP).toEqual(['draft', 300, false]);
  expect(existsSync(caseDir)).toBe(false);
  // The open panel shows it, with no reload.
  await expect(panel.locator('[data-run-status]')).toHaveCount(0, STEP);
  await expect(panel.getByLabel('Iterations', { exact: true })).toHaveValue('300', STEP);
  await expect(panel.locator('[data-run-continue="1"]')).toHaveCount(0);
  await expect(resultsRow(page, rid)).toHaveCount(0, STEP);
  expect(fake.pending()).toBe(0);
});
