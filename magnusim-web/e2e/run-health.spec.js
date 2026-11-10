// Run health (RH1, spec 3.10-3.12, 3.17): what the person sees of a run's health in its Run
// panel, the tree, the queue and the notices. The fake compute (MAGNUSIM_TEST_COMPUTE=fake)
// "solves" Run_2's own log (MAGNUSIM_TEST_SOLVE_LOG: its first 3,000 lines, a PISO run at Max
// Courant 100 that blows up) through the real health tracker, the shape check and the scrub.
// - The chip goes "Checking (needs 6 time steps)", then "Watch closely", then "Unhealthy"; the
//   velocity finding names the 226 m/s limit; a one-time notice says it is unhealthy since
//   t = 0.0069 s; the tree shows an Unhealthy badge and the queue line ends " · Unhealthy".
// - "Show in log" opens Solver output at the finding's line, highlighted; "From the start"
//   shows the header, with no host name and no home folder.
// - While it solves, What to do offers a plain Stop and the new-run fix, and no Continue
//   sentence. The fix ("New run: 3 outer correctors, Max Courant 5 (~...") adds "Run_2 fixed" with
//   those values, a draft that has not started; Run_2 keeps solving and keeps its results.
// - Stopped with a saved time after the onset: Continue says the saved results come after it
//   became unhealthy and asks first; Start asks "Start "Run_2" over?" with the health sentence.
//   Cancel posts nothing.
// - An old run with a log and no health record says it ran before health checks existed;
//   "Check its log" brings a verdict.
// - A verdict always says why (old steady runs, the logs of python/tests/unit/health_steady_logs.py):
//   the validation pipe's pattern (k-omega SST on Hex-dominant: k and omega bounded every
//   iteration, omega's first residual 1.06e-3 / 0.90e-3 on odd / even iterations) reads Healthy
//   with its two info rows; a stall that clears just before the run ends reads "Watch closely"
//   with the stall's warn row saying it cleared and that the run ended before the verdict could
//   ease; a residual that swings wide (3e-3 / 3e-4) without falling reads "Watch closely" with
//   the stall's warn row. All after a reload, and the run health read the Assistant's
//   read_results takes carries the same rows. The pipe's log solved by the fake compute (its own
//   server) reads Healthy all the way. Before the fix the pipe read "Watch closely" (from
//   iteration 551 while it solved) and the stall showed no warn row: only info rows; then the
//   swing read Healthy with no stall row, and the ended stall said "Watch closely stays until 5
//   iterations in a row are better" as if it could still ease.
// Fails on the code before RH1: the Run panel had no Health block.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PYTHON } from '../scripts/python-env.js';
import { seedElbowProject } from './prepare-projects.js';
import { openRunPanel } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = join(WEB, 'python', 'tests', 'fixtures', 'health');
const STEADY_LOGS = join(WEB, 'python', 'tests', 'unit', 'health_steady_logs.py');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'run-health-e2e';
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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const tmp = e2eTemp('run-health');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Health project');
  host = await startHost({
    name: 'run-health',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '600',
      MAGNUSIM_TEST_SOLVE_LOG: join(HEALTH, 'run2-head.log.gz'),
      MAGNUSIM_TEST_SOLVE_PACE_MS: '350',
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

/** A transient run named `name`: PISO (1 outer corrector) at Max Courant 100, as Run_2 was. */
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

test("a solving run's health: the chip, the findings, the notice, the badge, the log and the fix", async ({ page, request }) => {
  test.setTimeout(300_000);
  const rid = await run2(request, 'Run_2');
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  // Every chip word and every notice the page shows, in order.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__chips = [];
    w.__toasts = [];
    const note = () => {
      const c = document.querySelector('#panel-sim-control [data-run-health]');
      const text = c ? String(c.textContent || '') : '';
      if (text && w.__chips[w.__chips.length - 1] !== text) w.__chips.push(text);
      const t = document.getElementById('job-finish-toast');
      const tt = t && !t.hidden ? String(t.textContent || '').trim() : '';
      if (tt && w.__toasts[w.__toasts.length - 1] !== tt) w.__toasts.push(tt);
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  const panel = panelOf(page);
  await expect(chip(page)).toHaveText('Unhealthy', { timeout: 90_000 });
  const chips = await page.evaluate(() => /** @type {any} */ (window).__chips);
  const at = (w) => chips.indexOf(w);
  expect(at('Checking (needs 6 time steps)'), chips.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(at('Watch closely'), chips.join(' | ')).toBeGreaterThan(at('Checking (needs 6 time steps)'));
  expect(at('Unhealthy'), chips.join(' | ')).toBeGreaterThan(at('Watch closely'));
  // Healthy never reads as good results: the chip's title says what it covers.
  await expect(chip(page)).toHaveAttribute('title', /^Stability problems found in the last \d+ time steps/);
  await expect(panel.locator('[data-run-health-subline="1"]')).toContainText('Unhealthy since t = 0.0069 s');

  // The velocity finding (from step 26) names the limit.
  await expect(panel.locator('[data-run-health-finding="velocity_clipped"] [data-run-health-text="1"]')).toContainText('the 226 m/s limit caught', { timeout: 60_000 });

  // The notice, once; the tree's badge; the queue line.
  await expect(page.locator('#job-finish-toast')).toContainText('is unhealthy since t = 0.0069 s. See Health in its Run panel.', STEP);
  const badge = page.locator(`#left-tree li[data-w27-run="${rid}"] > .tree-row [data-run-health-badge="unhealthy"]`);
  await expect(badge).toHaveText('Unhealthy', STEP);
  await expect(badge).toHaveAttribute('title', 'Health: Unhealthy since t = 0.0069 s');
  await expect.poll(async () => page.locator('#job-queue-now').textContent(), STEP).toMatch(/ · Unhealthy$/);

  // "Show in log": Solver output at the finding's line, highlighted.
  await panel.locator('[data-run-health-finding="pv_coupling"] [data-run-health-evidence="1"]').click();
  const log = panel.locator('[data-run-solver-log="1"]');
  await expect(log).toHaveAttribute('open', '');
  await expect(log.locator('[data-hit="1"]')).toContainText('Solving for p, Initial residual', STEP);
  // "From the start": the header and the setup, with no host name and no home folder.
  await log.locator('[data-run-solver-log-at] [data-at="start"]').click();
  await expect(log.locator('[data-run-solver-log-lines="1"]')).toContainText('Create time', STEP);
  const startText = await log.locator('[data-run-solver-log-lines="1"]').textContent();
  expect(startText).not.toContain('cfdbox-17');
  expect(startText).not.toContain('/home/');
  expect(startText).not.toMatch(/^Host\s*:/m);

  // While it solves: a plain Stop and the fix; no Continue sentence.
  const fix = panel.locator('[data-run-health-fix="1"]');
  await expect(fix.locator('[data-run-health-stop="1"]')).toHaveText('Stop this run');
  await expect(fix.locator('[data-run-health-next="1"]')).toHaveCount(0);
  const newRun = fix.locator('[data-run-health-newrun="0"]');
  await expect(newRun).toHaveText(/^New run: 3 outer correctors, Max Courant 5 \(~[\d,]+ steps, about \d+ (days|hours?)\)$/);

  // The notice came once.
  const toasts = await page.evaluate(() => /** @type {any} */ (window).__toasts.filter((t) => /is unhealthy since/.test(t)));
  expect(toasts.length, toasts.join(' | ')).toBe(1);

  // The fix adds "Run_2 fixed" with its values, a draft; Run_2 keeps solving.
  await newRun.click();
  await expect(panel.locator('[data-run-title="1"]')).toHaveText('Run_2 fixed', STEP);
  const fixedId = await panel.getAttribute('data-run-id');
  expect(fixedId).not.toBe(rid);
  await expect(panel.locator('[data-run-start="1"]')).toBeVisible(STEP);
  await expect.poll(async () => {
    const r = await runRow(request, String(fixedId));
    return [r.status || 'draft', r.transient?.max_co, r.transient?.n_outer_correctors];
  }, STEP).toEqual(['draft', 5, 3]);
  await expect(panel.getByLabel('Max Courant number', { exact: true })).toHaveValue('5');
  await expect(panel.getByLabel('Outer correctors', { exact: true })).toHaveValue('3');
  expect((await runRow(request, rid)).status).toBe('running');

  // Run_2 stopped, with a saved time after the onset (t = 0.16666667): Continue and Start ask.
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  const caseDir = (await runRow(request, rid)).case_dir;
  cpSync(join(CAVITY, '0.5'), join(caseDir, '0.16666667'), { recursive: true });
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(chip(page)).toHaveText('Unhealthy', STEP);
  const posted = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/run\/(continue|start|reopen)/.test(r.url())) posted.push(r.url());
  });
  const box = panel.locator('[data-run-continue="1"]');
  await expect(box.locator('[data-run-continue-health="1"]')).toHaveText(
    'Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.',
    STEP,
  );
  await box.locator('[data-run-continue-go="1"]').click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Continue "Run_2"?');
  await expect(page.locator('#cf-confirm')).toHaveText('Continue anyway');
  await page.locator('#cf-cancel').click();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  // What to do on the stopped run: the from_zero sentence.
  await expect(panel.locator('[data-run-health-next="1"]')).toHaveText(
    'Its saved results (from t = 0.167 s) come after the problem began (t = 0.0069 s), so Continue would carry it on. Start again from t = 0 in a new run; Run_2 and its results stay.',
  );
  // Start asks to start it over, with the health sentence.
  await panel.locator('[data-run-start="1"]').click();
  await expect(page.locator('#cf-heading')).toHaveText('Start "Run_2" over?');
  await expect(page.locator('#cf-copy')).toContainText('"Run_2" became unhealthy at t = 0.0069 s. A new run with the fix keeps these results.');
  await page.locator('#cf-cancel').click();
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await page.waitForTimeout(500);
  expect(posted).toEqual([]);
  expect((await runRow(request, rid)).status).toBe('stopped');
});

test('an old run with a log and no health record: "Check its log" brings a verdict', async ({ page, request }) => {
  test.setTimeout(180_000);
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Old run', mesh_id: meshId });
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
      has_results: false,
      n_steps: 119,
      sim_time: 0.0189,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      case_dir: caseDir,
    }),
  );
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(panel.locator('[data-run-health-before="1"]')).toHaveText('This run ran before health checks existed.', STEP);
  await panel.locator('[data-run-health-check="1"]').click();
  await expect(chip(page)).toHaveText('Unhealthy', { timeout: 60_000 });
  await expect(panel.locator('[data-run-health-subline="1"]')).toContainText('before it ended');
  // It stays after a reload: the record is the run's.
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(chip(page)).toHaveText('Unhealthy', STEP);
});

/** The finding rows the panel shows: code, level and words. */
const rowsOf = (panel) =>
  panel.locator('[data-run-health-finding]').evaluateAll((els) =>
    els.map((el) => ({
      code: el.getAttribute('data-run-health-finding'),
      level: el.getAttribute('data-level'),
      text: String(el.querySelector('[data-run-health-text="1"]')?.textContent || ''),
    })),
  );

/** The rows of a run's health record as the Assistant's read_results {kind:'health'} reads it (its host read run.health: /api/run/health). */
async function hostRows(request, base, pid, simId, rid) {
  const got = await (await request.get(`${base}/api/run/health?project_id=${pid}&simulation_id=${simId}&run_id=${rid}`)).json();
  return { verdict: got.health?.verdict, rows: (got.health?.findings || []).map((f) => ({ code: f.code, level: f.level, text: f.text })) };
}

/** The validation pipe's two info rows (k-omega SST on Hex-dominant, health_steady_logs.py c2_sst). */
const PIPE_ROWS = [
  { code: 'bounded_from_start', level: 'info', text: 'omega was negative from the first iteration (lowest -764 against a mean of 850): check the inlet values or the mesh.' },
  { code: 'not_settled', level: 'info', text: 'It ended without its residuals meeting their targets: its results may not have settled.' },
];

test.describe('a verdict always says why', () => {
  /** @type {string[]} the runs a test made, deleted in afterEach (with the page closed first). */
  let made = [];

  test.afterEach(async ({ page, request }) => {
    await page.close();
    for (const rid of made) await request.post(api('/api/run/delete'), { data: { project_id: PID, simulation_id: sim, run_id: rid } }).catch(() => {});
    made = [];
  });

  /** An ended steady run whose case holds the synthetic log `log` and its hints, with no health record. */
  async function oldSteadyRun(request, name, log) {
    const created = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name, mesh_id: meshId });
    const rid = String(created.run_id || created.run?.id || created.run?.run_id);
    made.push(rid);
    const runDir = dirname((await runRow(request, rid)).case_dir);
    const caseDir = join(runDir, 'case');
    const wrote = spawnSync(PYTHON, [STEADY_LOGS, log, caseDir], { encoding: 'utf8', windowsHide: true });
    expect(wrote.status, wrote.stderr).toBe(0);
    const runJson = join(runDir, 'run.json');
    const rec = JSON.parse(readFileSync(runJson, 'utf8'));
    const iterations = log === 'stall_end' || log === 'swing' ? 1000 : 2500;
    writeFileSync(
      runJson,
      JSON.stringify({
        ...rec,
        status: 'done',
        stage: 'done',
        time_dependency: 'Steady-state',
        path_kind: 'simpleFoam',
        analysis_key: 'incompressible_steady',
        has_results: false,
        n_steps: iterations,
        sim_time: iterations,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
      }),
    );
    return rid;
  }

  /** "Check its log" on the run, then the chip's word. */
  async function checkItsLog(page, rid, word) {
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(panel.locator('[data-run-health-before="1"]')).toHaveText('This run ran before health checks existed.', STEP);
    await panel.locator('[data-run-health-check="1"]').click();
    await expect(chip(page)).toHaveText(word, { timeout: 60_000 });
    return panel;
  }

  test("the validation pipe's pattern reads Healthy with its two info rows, after a reload too", async ({ page, request }) => {
    test.setTimeout(180_000);
    const rid = await oldSteadyRun(request, 'Pipe SST', 'c2_sst');
    let panel = await checkItsLog(page, rid, 'Healthy');
    const want = PIPE_ROWS;
    await expect.poll(() => rowsOf(panel), STEP).toEqual(want);
    await expect(chip(page)).toHaveAttribute('title', /^No stability problems found in the last 50 iterations\./);
    // It stays after a reload, and the Assistant reads the same record.
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(chip(page)).toHaveText('Healthy', STEP);
    await expect.poll(() => rowsOf(panel), STEP).toEqual(want);
    expect(await hostRows(request, host.base, PID, sim, rid)).toEqual({ verdict: 'healthy', rows: want });
  });

  test('a stall that clears just before the end reads Watch closely with the stall saying why, after a reload too', async ({ page, request }) => {
    test.setTimeout(180_000);
    const rid = await oldSteadyRun(request, 'Stalled', 'stall_end');
    let panel = await checkItsLog(page, rid, 'Watch closely');
    const stall = {
      code: 'residuals_stalled',
      level: 'warn',
      text:
        "The omega residual has not halved in 500 iterations (about 0.0011, from 0.002); a steady run's residuals should keep falling. " +
        'It cleared at iteration 998; the run ended before 5 better iterations in a row could ease Watch closely.',
    };
    const settled = { code: 'not_settled', level: 'info', text: 'It ended without its residuals meeting their targets: its results may not have settled.' };
    await expect.poll(() => rowsOf(panel), STEP).toEqual([stall, settled]);
    await expect(panel.locator('[data-run-health-finding="residuals_stalled"] [data-run-health-evidence="1"]')).toHaveText('Show in log');
    // It stays after a reload, and the Assistant reads the same record.
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(chip(page)).toHaveText('Watch closely', STEP);
    await expect.poll(() => rowsOf(panel), STEP).toEqual([stall, settled]);
    expect(await hostRows(request, host.base, PID, sim, rid)).toEqual({ verdict: 'watch', rows: [stall, settled] });
  });

  test('a residual that swings wide without falling reads Watch closely with the stall saying why, after a reload too', async ({ page, request }) => {
    test.setTimeout(180_000);
    const rid = await oldSteadyRun(request, 'Swinging', 'swing');
    let panel = await checkItsLog(page, rid, 'Watch closely');
    const stall = {
      code: 'residuals_stalled',
      level: 'warn',
      text: "The omega residual has not halved in 500 iterations (about 0.0016, from 0.0016); a steady run's residuals should keep falling.",
    };
    const settled = { code: 'not_settled', level: 'info', text: 'It ended without its residuals meeting their targets: its results may not have settled.' };
    await expect.poll(() => rowsOf(panel), STEP).toEqual([stall, settled]);
    // It stays after a reload, and the Assistant reads the same record.
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(chip(page)).toHaveText('Watch closely', STEP);
    await expect.poll(() => rowsOf(panel), STEP).toEqual([stall, settled]);
    expect(await hostRows(request, host.base, PID, sim, rid)).toEqual({ verdict: 'watch', rows: [stall, settled] });
  });
});

// The same pattern while it solves: the fake compute replays the pipe's log through the real
// tracker (MAGNUSIM_TEST_SOLVE_LOG) on its own server, a steady study. Before the fix its chip
// went "Watch closely" at iteration 551 and stayed, with only info rows.
test.describe('a solving run that settles like the validation pipe', () => {
  const SPID = 'run-health-steady-e2e';
  let live;
  let ssim;
  let smesh;
  let made = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('run-health-steady');
    const logDir = join(tmp, 'log');
    const wrote = spawnSync(PYTHON, [STEADY_LOGS, 'c2_sst', logDir], { encoding: 'utf8', windowsHide: true });
    expect(wrote.status, wrote.stderr).toBe(0);
    const hints = join(logDir, 'c2_sst.hints.json');
    writeFileSync(hints, JSON.stringify(JSON.parse(readFileSync(join(logDir, 'w27-case.json'), 'utf8')).health_hints));
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    seedElbowProject(projects, SPID, 'Steady health project');
    live = await startHost({
      name: 'run-health-steady',
      tmp,
      projects,
      env: {
        MAGNUSIM_TEST_COMPUTE: 'fake',
        MAGNUSIM_TEST_MESH_SECONDS: '1',
        MAGNUSIM_TEST_SOLVE_SECONDS: '4',
        MAGNUSIM_TEST_SOLVE_LOG: join(logDir, 'log.simpleFoam'),
        MAGNUSIM_TEST_SOLVE_HINTS: hints,
        MAGNUSIM_TEST_SOLVE_PACE_MS: '3',
        PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
      },
    });
    const doc = await (await request.get(`${live.base}/api/mesh?project_id=${SPID}`)).json();
    ssim = doc.simulation_id;
    smesh = String(doc.mesh.id);
    const gen = await request.post(`${live.base}/api/mesh/generate`, { data: { project_id: SPID, simulation_id: ssim, mesh_id: smesh } });
    expect(gen.status(), await gen.text()).toBeLessThan(300);
    await expect
      .poll(async () => (await (await request.get(`${live.base}/api/mesh?project_id=${SPID}&mesh_id=${smesh}`)).json()).mesh?.live_mesh_result?.status, { timeout: 90_000 })
      .toBe('done');
    const up = await request.post(`${live.base}/api/simulation/update`, { data: { project_id: SPID, simulation_id: ssim, time_dependency: 'Steady-state' } });
    expect(up.ok(), await up.text()).toBe(true);
  });

  test.afterAll(async () => {
    live?.stop();
  });

  test.afterEach(async ({ page, request }) => {
    await page.close();
    for (const rid of made) {
      await request.post(`${live.base}/api/run/stop`, { data: { project_id: SPID, simulation_id: ssim, run_id: rid } }).catch(() => {});
      await request.post(`${live.base}/api/run/delete`, { data: { project_id: SPID, simulation_id: ssim, run_id: rid } }).catch(() => {});
    }
    made = [];
  });

  test('it reads Healthy all the way, then its two info rows, after a reload too', async ({ page, request }) => {
    test.setTimeout(240_000);
    const post = async (path, data) => {
      const r = await request.post(`${live.base}${path}`, { data });
      const j = await r.json().catch(() => ({}));
      expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
      return j;
    };
    const created = await post('/api/run/create', { project_id: SPID, simulation_id: ssim, name: 'Pipe SST', mesh_id: smesh });
    const rid = String(created.run_id || created.run?.id || created.run?.run_id);
    made.push(rid);
    let panel = await openRunPanel(page, { base: live.base, projectId: SPID, simulationId: ssim, runId: rid });
    // Every chip word the page shows, in order.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__chips = [];
      const note = () => {
        const c = document.querySelector('#panel-sim-control [data-run-health]');
        const text = c ? String(c.textContent || '') : '';
        if (text && w.__chips[w.__chips.length - 1] !== text) w.__chips.push(text);
      };
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await post('/api/run/start', { project_id: SPID, simulation_id: ssim, run_id: rid });
    const status = async () =>
      ((await (await request.get(`${live.base}/api/run/status?project_id=${SPID}&simulation_id=${ssim}`)).json()).runs || []).find((r) => String(r.id) === rid) || {};
    // Past iteration 551 while it solves (where it turned "Watch closely"), then done.
    await expect.poll(async () => Number((await status()).n_steps) || 0, { timeout: 90_000 }).toBeGreaterThan(600);
    await expect.poll(async () => (await status()).status, { timeout: 90_000 }).toBe('done');
    await expect(chip(page)).toHaveText('Healthy', STEP);
    const chips = await page.evaluate(() => /** @type {any} */ (window).__chips);
    expect(chips, chips.join(' | ')).toContain('Healthy');
    expect(chips, chips.join(' | ')).not.toContain('Watch closely');
    await expect.poll(() => rowsOf(panel), STEP).toEqual(PIPE_ROWS);
    // It stays after a reload, and the Assistant reads the same record.
    panel = await openRunPanel(page, { base: live.base, projectId: SPID, simulationId: ssim, runId: rid });
    await expect(chip(page)).toHaveText('Healthy', STEP);
    await expect.poll(() => rowsOf(panel), STEP).toEqual(PIPE_ROWS);
    expect(await hostRows(request, live.base, SPID, ssim, rid)).toEqual({ verdict: 'healthy', rows: PIPE_ROWS });
  });
});
