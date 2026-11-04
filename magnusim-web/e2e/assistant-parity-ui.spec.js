// The person's side of the Assistant's new parity rows (spec 3.17 item 6): each row of
// scripts/server/assistant/parity-rows.json that names a `ui_control` (RH1: R25-R31; RH2: R32-R34; RH3: R35)
// has that control in the app, where its `reach` says, for a person to use. It covers nothing
// beyond the new rows (spec 10, Cut). RH2's rows are checked both ways: what the person does
// in Before you start is what the Assistant's routes read, and what those routes write is what
// the person sees. RH3's note on R16: run_continue's numerics "new" and "as_was" are the person's
// Continue question's two answers, and what each goes on with is what R35 shows both sides.
// Its own server with the fake compute replaying Run_2's log through the real health tracker
// (MAGNUSIM_TEST_SOLVE_LOG), so a run with a health record exists; an old run with a log and no
// record has "Check its log". The fake mesher writes a clean checkMesh report with its one-cell
// mesh (MAGNUSIM_TEST_MESH_CHECKMESH), so a draft's pre-run check has its mesh's quality.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { seedElbowProject } from './prepare-projects.js';
import { openRunPanel } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = join(WEB, 'python', 'tests', 'fixtures', 'health');
const CHECKMESH = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'ok-hex-2d.log');
const ROWS = JSON.parse(readFileSync(join(WEB, 'scripts', 'server', 'assistant', 'parity-rows.json'), 'utf8')).rows;
const PID = 'parity-ui-e2e';
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
const runRow = async (request, id) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === id) || {};

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const tmp = e2eTemp('parity-ui');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Parity project');
  host = await startHost({
    name: 'parity-ui',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
      MAGNUSIM_TEST_SOLVE_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_LOG: join(HEALTH, 'run2-head.log.gz'),
      MAGNUSIM_TEST_SOLVE_PACE_MS: '5',
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

/** The RH1 rows that name the person's control. */
const UI_ROWS = ROWS.filter((r) => r.ui_control && /^R(2[5-9]|3[01])$/.test(r.row));

test('each RH1 parity row names a control the person has (R25-R31)', async ({ page, request }) => {
  test.setTimeout(240_000);
  expect(UI_ROWS.map((r) => r.row)).toEqual(['R25', 'R26', 'R27', 'R28', 'R29', 'R30', 'R31']);
  // A run solved to its end through the tracker: an Unhealthy record (R25, R26-R28, R30, R31).
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_2', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 10, write_count: 60, max_co: 100, n_outer_correctors: 1, n_correctors: 2 } });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 90_000 }).toBe('done');
  expect((await runRow(request, rid)).health?.verdict).toBe('unhealthy');
  // An old run with a log and no record (R29).
  const old = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Old run', mesh_id: meshId });
  const oid = String(old.run_id || old.run?.id || old.run?.run_id);
  const caseDir = (await runRow(request, oid)).case_dir;
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'log.pimpleFoam'), gunzipSync(readFileSync(join(HEALTH, 'run2-head.log.gz'))));
  const runJson = join(dirname(caseDir), 'run.json');
  writeFileSync(runJson, JSON.stringify({ ...JSON.parse(readFileSync(runJson, 'utf8')), status: 'done', time_dependency: 'Transient', path_kind: 'pimpleFoam', n_steps: 119, finished_at: new Date().toISOString(), case_dir: caseDir }));

  const sel = (row) => UI_ROWS.find((r) => r.row === row).ui_control.selector;
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(panel.locator(sel('R25'))).toHaveText('Unhealthy', STEP);
  await expect(panel.locator(sel('R26'))).toBeVisible();
  await panel.locator(`${sel('R26')} > summary`).click();
  await expect(panel.locator(sel('R27'))).toBeVisible();
  await expect(panel.locator(sel('R28')).first()).toBeVisible();
  await expect(panel.locator(sel('R30'))).toBeVisible();
  await expect(panel.locator(`${sel('R30')} [data-run-health-newrun="0"]`)).toContainText('New run: ');
  // R31: the notice's place and the tree's badge.
  await expect(page.locator('#job-finish-toast')).toHaveCount(1);
  await expect(page.locator(`#left-tree li[data-w27-run="${rid}"] > .tree-row [data-run-health-badge]`)).toBeVisible(STEP);
  expect(sel('R31')).toContain('[data-run-health-badge]');
  const oldPanel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: oid });
  await expect(oldPanel.locator(sel('R29'))).toHaveText('Check its log', STEP);
});

/** RH2's rows that name the person's control. */
const RH2_ROWS = ROWS.filter((r) => r.ui_control && /^R3[2-4]$/.test(r.row));
const precheck = async (request, id) => postOk(request, '/api/run/precheck', { project_id: PID, simulation_id: sim, run_id: id });

test("each RH2 parity row names the person's control, and both sides read and write the same (R32-R34)", async ({ page, request }) => {
  test.setTimeout(240_000);
  expect(RH2_ROWS.map((r) => r.row)).toEqual(['R32', 'R33', 'R34']);
  const sel = (row) => RH2_ROWS.find((r) => r.row === row).ui_control.selector;
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_pc', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 10, write_count: 60, max_co: 100, n_outer_correctors: 1, n_correctors: 2 } });
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  // R32: Before you start; the Assistant's read (run.precheck) has the row the person sees, word for word.
  const block = panel.locator(sel('R32'));
  await expect(block).toBeVisible(STEP);
  const row = block.locator('[data-run-check-row="piso_high_co"]');
  await expect(row).toBeVisible(STEP);
  const read = await precheck(request, rid);
  const piso = read.checks.find((c) => c.code === 'piso_high_co');
  await expect(row.locator('[data-run-check-text="1"]')).toHaveText(piso.text);
  // R33: the person's Apply writes what the Assistant's run update would (run.update): the route's
  // next read has no such row and the run has the fix's values.
  await row.locator(sel('R33')).click();
  await expect.poll(async () => (await precheck(request, rid)).checks.some((c) => c.code === 'piso_high_co'), STEP).toBe(false);
  const fixed = await runRow(request, rid);
  expect([fixed.transient?.n_outer_correctors, fixed.transient?.max_co]).toEqual([3, 5]);
  await expect(block.locator('[data-run-check-row="piso_high_co"]')).toHaveCount(0, STEP);
  // R34: the person's Keep as set is what the Assistant reads as kept (checks_kept)...
  const first = block.locator('[data-run-check-row]').first();
  const code = await first.getAttribute('data-run-check-row');
  await first.locator(sel('R34')).click();
  await expect.poll(async () => (await runRow(request, rid)).checks_kept, STEP).toEqual([code]);
  expect((await precheck(request, rid)).checks.find((c) => c.code === code).kept).toBe(true);
  // ...and the person's Undo keep is what it reads as not kept, as its checks_kept without the code is.
  const keptBox = block.locator('[data-run-check-kept="1"]');
  await keptBox.locator('summary').click();
  await keptBox.locator(`[data-run-check-kept-row="${code}"]`).locator(sel('R34')).click();
  await expect.poll(async () => (await runRow(request, rid)).checks_kept, STEP).toEqual([]);
  expect((await precheck(request, rid)).checks.find((c) => c.code === code).kept).toBe(false);
  await expect(block.locator(`[data-run-check-row="${code}"]`)).toBeVisible(STEP);
  // And the other way: checks_kept written through run.update (setup_edit's route) is what the person
  // sees, after the page reads the run again: kept, then not.
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, checks_kept: [code] });
  let again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(again.locator('[data-run-check-kept="1"] summary')).toHaveText('Kept (1)', STEP);
  await expect(again.locator(`${sel('R32')} [data-run-check-row="${code}"]`)).toHaveCount(0);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, checks_kept: [] });
  again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(again.locator(`${sel('R32')} [data-run-check-row="${code}"]`)).toBeVisible(STEP);
  await expect(again.locator('[data-run-check-kept="1"]')).toHaveCount(0);
});

/** RH3's row that names the person's control (R35). */
test("RH3's parity row names the person's control, and both sides read the same (R35)", async ({ page, request }) => {
  test.setTimeout(240_000);
  const row = ROWS.find((r) => r.row === 'R35');
  expect(row.ui_control.selector).toBe('[data-run-numerics]');
  expect(row.paths[0]).toMatchObject({ tool: 'read_setup', where: { what: 'numerics' } });
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_numerics', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 1, write_count: 10, max_co: 4, n_outer_correctors: 3, n_correctors: 2, outer_relax_p: 0.4 } });
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const box = panel.locator(row.ui_control.selector);
  await expect(box).toBeVisible(STEP);
  await box.locator('summary').click();
  // What the Assistant's read_setup numerics reads (run.precheck's numerics) is what the person sees, word for word.
  const shownRows = async () => {
    const read = await precheck(request, rid);
    expect(read.numerics.length).toBeGreaterThan(5);
    for (const n of read.numerics) {
      await expect(box.locator(`[data-run-numerics-group="${n.group}"] [data-run-numerics-row="${n.label}"] .run-numerics-value`)).toHaveText(n.value, STEP);
    }
    return Object.fromEntries(read.numerics.map((n) => [n.label, n.value]));
  };
  let seen = await shownRows();
  expect(seen['Outer relaxation']).toBe('p 0.4, equations 0.7; the final outer loop 1');
  expect(seen['Max Courant']).toBe('4');
  // And the other way: a change through run.update (setup_edit's route) is what the person sees.
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 1, write_count: 10, max_co: 2, n_outer_correctors: 3, n_correctors: 2, outer_relax_p: 0.5 } });
  const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const box2 = again.locator(row.ui_control.selector);
  await expect(box2).toBeVisible(STEP);
  await box2.locator('summary').click();
  await expect(box2.locator('[data-run-numerics-row="Outer relaxation"] .run-numerics-value')).toHaveText('p 0.5, equations 0.7; the final outer loop 1', STEP);
  seen = Object.fromEntries((await precheck(request, rid)).numerics.map((n) => [n.label, n.value]));
  expect(seen['Max Courant']).toBe('2');
  await expect(box2.locator('[data-run-numerics-row="Max Courant"] .run-numerics-value')).toHaveText('2', STEP);
});

/** RH3's note on R16: run_continue's numerics answers are the person's Continue question's, checked with R35. */
test("R16's numerics answers are the person's Continue question's answers, and each goes on with what Numerics as written shows both sides (R35)", async ({ page, request }) => {
  test.setTimeout(240_000);
  const r16 = ROWS.find((r) => r.row === 'R16');
  const r35 = ROWS.find((r) => r.row === 'R35');
  expect(r16.ui_control).toMatchObject({ selector: '#modal-run-continue', answers: ['#rcn-new', '#rcn-as-was'] });
  expect(r16.paths.find((p) => p.where && p.where.numerics).where).toEqual({ action: 'run_continue', numerics: ['new', 'as_was'] });
  const [freshAnswer, asWasAnswer] = r16.ui_control.answers;
  // A run that started (recording the numerics it started with) and finished, with a saved time.
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run_cont', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 0.1, write_count: 2, max_co: 1, n_outer_correctors: 1, n_correctors: 2 } });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 90_000 }).toBe('done');
  expect((await runRow(request, rid)).numerics_used?.values).toBeTruthy();
  const caseDir = (await runRow(request, rid)).case_dir;
  cpSync(join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d', '0.5'), join(caseDir, '0.05'), { recursive: true });
  const runJson = join(dirname(caseDir), 'run.json');
  writeFileSync(runJson, JSON.stringify({ ...JSON.parse(readFileSync(runJson, 'utf8')), has_results: true, n_saved_times: 1, last_saved_iteration: 0.05 }));
  // The study's p relative tolerance changes after it started.
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, p_rel_tol: 0.02 });
  try {
    /** "Numerics as written" (R35) as the person sees it equals what read_setup numerics reads; the p row's value. */
    const pRow = async (panel) => {
      const box = panel.locator(r35.ui_control.selector);
      await expect(box).toBeVisible(STEP);
      if (!(await box.evaluate((el) => el.open))) await box.locator('summary').click();
      const read = await precheck(request, rid);
      for (const n of read.numerics) {
        await expect(box.locator(`[data-run-numerics-group="${n.group}"] [data-run-numerics-row="${n.label}"] .run-numerics-value`)).toHaveText(n.value, STEP);
      }
      return read.numerics.find((n) => n.group === 'Linear solvers' && n.label === 'p').value;
    };
    const posted = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/run\/continue$/.test(r.url())) posted.push(r.postDataJSON());
    });
    const continueWith = async (answer) => {
      const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
      await expect(panel.locator('[data-run-continue-numerics]')).toHaveText(/^The study's numerics changed after "Run_cont" started: p relative tolerance preset → 0\.02\.$/, STEP);
      await panel.locator('[data-run-continue-go="1"]').click();
      await expect(page.locator(r16.ui_control.selector)).toBeVisible(STEP);
      await page.locator(answer).click();
      await expect(page.locator(r16.ui_control.selector)).toBeHidden();
      await expect.poll(() => posted.length, STEP).toBeGreaterThan(0);
      await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 90_000 }).toBe('done');
      return panel;
    };
    // "Continue as it was" is run_continue numerics "as_was": it goes on with what it started with.
    let panel = await continueWith(asWasAnswer);
    expect(posted.at(-1).numerics).toBe('as_was');
    expect((await runRow(request, rid)).numerics_used.values.p_rel_tol ?? null).toBeNull();
    expect(await pRow(panel)).toMatch(/relTol 0\.01\b/);
    // "Continue with the new numerics" is numerics "new": it goes on with the study's, both sides.
    panel = await continueWith(freshAnswer);
    expect(posted.at(-1).numerics).toBe('new');
    expect((await runRow(request, rid)).numerics_used.values.p_rel_tol).toBe(0.02);
    expect(await pRow(panel)).toMatch(/relTol 0\.02\b/);
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, p_rel_tol: null });
  }
});
