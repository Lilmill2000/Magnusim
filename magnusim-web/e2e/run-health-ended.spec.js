// Run health of runs that ended early or oddly (RH1 review fixes, spec 2.1, 3.9-3.12). The fake
// compute (MAGNUSIM_TEST_COMPUTE=fake) "solves" the first 3 time steps of Run_2's log through the
// real health tracker, so its health is still "Checking" when it ends.
// - A run that fails at step 3 reads "Failed", its finding saying it failed before its health
//   could be judged, with the solver's reason; never "Checking (needs 6 time steps)".
// - A run stopped at step 3 reads "Not judged": it ended before its health could be judged.
// - A Start that fails before its solver starts says so, not "This run ran before health checks
//   existed." (MAGNUSIM_TEST_SOLVE_FAIL_START).
// - "Check its log" on an old run deleted while the check runs: the run does not come back.
// - A stopped unhealthy run whose health offers no fix, and whose onset lies in the unread middle
//   of its log: the tree badge, the subline and Start's question say "between t = A and t = B",
//   and Start's question promises no fix ("A new run keeps these results.").
// Fails on the code before these fixes: the chip said "Checking (needs 6 time steps)" on the ended
// runs, the failed Start said it ran before health checks existed, the deleted run came back as a
// run folder holding only its health, and the texts read "since t = A" and "with the fix".
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { seedElbowProject } from './prepare-projects.js';
import { openRunPanel } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = join(WEB, 'python', 'tests', 'fixtures', 'health');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'run-health-ended-e2e';
const STEP = { timeout: 30_000 };
let host;
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

/** Run_2's log up to (not including) its 4th time step: 3 steps, never scored. */
function firstThreeSteps() {
  const lines = gunzipSync(readFileSync(join(HEALTH, 'run2-head.log.gz'))).toString('utf8').split('\n');
  let seen = 0;
  const cut = lines.findIndex((l) => /^Time = /.test(l) && ++seen === 4);
  return lines.slice(0, cut).join('\n') + '\n';
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const tmp = e2eTemp('run-health-ended');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Health ended project');
  const log = join(tmp, 'run2-three-steps.log');
  writeFileSync(log, firstThreeSteps());
  host = await startHost({
    name: 'run-health-ended',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '8',
      MAGNUSIM_TEST_SOLVE_RESULT: 'fail',
      MAGNUSIM_TEST_SOLVE_LOG: log,
      MAGNUSIM_TEST_SOLVE_HINTS: join(HEALTH, 'run2.hints.json'),
      MAGNUSIM_TEST_SOLVE_PACE_MS: '40',
      MAGNUSIM_TEST_SOLVE_FAIL_START: 'Start fails',
      // "Check its log" answers 8 s after it read the log, as a long log's check would.
      MAGNUSIM_TEST_HEALTH_CHECK_HOLD_MS: '8000',
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
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

const runRow = async (request, rid) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === rid) || {};
const panelOf = (page) => page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
const chip = (page) => panelOf(page).locator('[data-run-health]');

async function newRun(request, name) {
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

test('a run that fails or is stopped before its 6th time step never reads "Checking"', async ({ page, request }) => {
  test.setTimeout(180_000);
  // Fails at step 3: Failed, with why.
  const failed = await newRun(request, 'Fails early');
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: failed });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: failed });
  await expect(chip(page)).toHaveText('Checking (needs 6 time steps)', { timeout: 60_000 });
  await expect.poll(async () => (await runRow(request, failed)).status, { timeout: 60_000 }).toBe('failed');
  await expect(chip(page)).toHaveText('Failed', STEP);
  await expect(panelOf(page).locator('[data-run-health-finding="failed"] [data-run-health-text="1"]')).toHaveText(
    'The run failed at time step 3, before its health could be judged (from the 6th time step on): Fake solver failed',
  );
  // It still lists what its settings showed from step 1.
  await expect(panelOf(page).locator('[data-run-health-finding="courant_mode"]')).toHaveCount(1);

  // Stopped at step 3: Not judged, and why.
  const stopped = await newRun(request, 'Stopped early');
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: stopped });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: stopped });
  await expect(chip(page)).toHaveText('Checking (needs 6 time steps)', { timeout: 60_000 });
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: stopped });
  await expect.poll(async () => (await runRow(request, stopped)).status, STEP).toBe('stopped');
  await expect(chip(page)).toHaveText('Not judged', STEP);
  await expect(chip(page)).toHaveAttribute('title', 'It ended before its health could be judged (from the 6th time step on).');
  await expect(panelOf(page).locator('[data-run-health-subline="1"]')).toHaveText('It ended before its health could be judged (from the 6th time step on)');
});

test('a Start that fails before its solver starts says so', async ({ page, request }) => {
  test.setTimeout(120_000);
  const rid = await newRun(request, 'Start fails');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  // The person's Start.
  await panel.locator('[data-run-start="1"]').click();
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('failed');
  await expect(panel.locator('[data-run-health-none="1"]')).toHaveText('It failed before its solver started, so there is no solver output to check.', STEP);
  await expect(panel.locator('[data-run-health-before="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-run-health-check="1"]')).toHaveCount(0);
});

test('"Check its log" on an old run deleted while it checks: the run does not come back', async ({ page, request }) => {
  test.setTimeout(120_000);
  // A run that stays, so the tree's runs are there to look at.
  const keptMade = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Kept run', mesh_id: meshId });
  const kept = String(keptMade.run_id || keptMade.run?.id || keptMade.run?.run_id);
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Old deleted', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  const row = await runRow(request, rid);
  const runDir = dirname(row.case_dir);
  const caseDir = join(runDir, 'case');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'log.pimpleFoam'), gunzipSync(readFileSync(join(HEALTH, 'run2-head.log.gz'))));
  writeFileSync(join(caseDir, 'w27-case.json'), JSON.stringify({ health_hints: JSON.parse(readFileSync(join(HEALTH, 'run2.hints.json'), 'utf8')) }));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify({
      ...rec,
      status: 'done',
      stage: 'done',
      time_dependency: 'Transient',
      path_kind: 'pimpleFoam',
      analysis_key: 'incompressible_transient',
      n_steps: 119,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      case_dir: caseDir,
    }),
  );
  const asked = await getJson(request, `/api/run/health?project_id=${PID}&simulation_id=${sim}&run_id=${rid}&recompute=1`);
  expect(asked.checking, JSON.stringify(asked)).toBe(true);
  // Its log is read within a few seconds; its answer comes 8 s after that. Deleted meanwhile.
  await page.waitForTimeout(4_000);
  await postOk(request, '/api/run/delete', { project_id: PID, simulation_id: sim, run_id: rid });
  expect(existsSync(runDir)).toBe(false);
  // The answer comes and finds no run to keep it in.
  await page.waitForTimeout(10_000);
  expect(existsSync(runDir), 'the deleted run folder came back').toBe(false);
  const runs = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs || [];
  expect(runs.map((x) => String(x.id))).not.toContain(rid);
  await page.goto(`${host.base}/#/p/${encodeURIComponent(PID)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  const folder = page.locator(`#left-tree [data-w17-sim-id="${sim}"] li[data-w27-sim-control="1"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  await expect(page.locator(`#left-tree li[data-w27-run="${kept}"]`)).toBeVisible(STEP);
  await expect(page.locator(`#left-tree li[data-w27-run="${rid}"]`)).toHaveCount(0);
});

test('an onset in the unread middle reads as a span, and Start promises no fix that is not offered', async ({ page, request }) => {
  test.setTimeout(120_000);
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Span run', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  const row = await runRow(request, rid);
  const runDir = dirname(row.case_dir);
  const caseDir = join(runDir, 'case');
  mkdirSync(caseDir, { recursive: true });
  cpSync(join(CAVITY, '0.5'), join(caseDir, '0.16666667'), { recursive: true });
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  // An old run's "Check its log" answer: unhealthy somewhere in the unread middle, no fix offered.
  const health = {
    v: 1,
    verdict: 'unhealthy',
    at: new Date().toISOString(),
    step: 4000,
    t: 0.2,
    unit: 'time step',
    window: 50,
    live: false,
    checked: ['pv_coupling'],
    skipped: [],
    findings: [{ code: 'pv_coupling', level: 'error', text: 'Pressure and velocity do not settle within a step.', evidence: null, since_t: 0.0069 }],
    timeline: [{ t: 0.0069, verdict: 'unhealthy' }],
    first_unhealthy: { t: 0.0031, step: null, wall_s: null, approx: true, by_t: 0.0069 },
    restart: 'from_zero',
  };
  writeFileSync(
    runJson,
    JSON.stringify({
      ...rec,
      status: 'stopped',
      stage: 'stopped',
      time_dependency: 'Transient',
      path_kind: 'pimpleFoam',
      has_results: true,
      n_saved_times: 1,
      last_saved_iteration: 0.16666667,
      n_steps: 4000,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      case_dir: caseDir,
      health_checked: true,
      health,
    }),
  );
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const badge = page.locator(`#left-tree li[data-w27-run="${rid}"] > .tree-row [data-run-health-badge="unhealthy"]`);
  await expect(badge).toHaveAttribute('title', 'Health: Unhealthy since some time between t = 0.0031 s and t = 0.0069 s', STEP);
  await expect(chip(page)).toHaveText('Unhealthy', STEP);
  await expect(panel.locator('[data-run-health-subline="1"]')).toContainText('Unhealthy between t = 0.0031 s and t = 0.0069 s');
  await expect(panel.locator('[data-run-health-newrun="0"]')).toHaveCount(0);
  const posted = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/run\/(continue|start|reopen)/.test(r.url())) posted.push(r.url());
  });
  await panel.locator('[data-run-start="1"]').click();
  await expect(page.locator('#cf-heading')).toHaveText('Start "Span run" over?');
  await expect(page.locator('#cf-copy')).toContainText('"Span run" became unhealthy between t = 0.0031 s and t = 0.0069 s. A new run keeps these results.');
  await expect(page.locator('#cf-copy')).not.toContainText('with the fix');
  await page.locator('#cf-cancel').click();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await page.waitForTimeout(500);
  expect(posted).toEqual([]);
});
