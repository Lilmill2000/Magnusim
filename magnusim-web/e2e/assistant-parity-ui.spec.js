// The person's side of the Assistant's new parity rows (spec 3.17 item 6): each row of
// scripts/server/assistant/parity-rows.json that names a `ui_control` (RH1: R25-R31) has that
// control in the app, where its `reach` says, for a person to use. It covers nothing beyond the
// new rows (spec 10, Cut).
// Its own server with the fake compute replaying Run_2's log through the real health tracker
// (MAGNUSIM_TEST_SOLVE_LOG), so a run with a health record exists; an old run with a log and no
// record has "Check its log".
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { seedElbowProject } from './prepare-projects.js';
import { openRunPanel } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = join(WEB, 'python', 'tests', 'fixtures', 'health');
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
