// What a Standard mesh with no wall layers does to a study's walls (the validation set's turbulent
// pipe, 2026-11-07: validation/README.md), as the person sees it and the Assistant reads it.
// - Incompressible Flow, k-omega SST: the Run panel's "Before you start" warns that the wall cells
//   are tetrahedra under wall functions and what the pipe's friction read there (wall_friction_mesh),
//   and "Numerics as written" says the velocity gradient and the flux are not skew-corrected (k-omega
//   SST on a Standard mesh is written with the plain lines). The Assistant reads the same row
//   (read_results precheck) and the same rows (read_setup numerics), word for word. A laminar study on
//   the same mesh gets no row and the skew-corrected lines.
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake): the fake mesher leaves the
// Standard mesher's meta of a mesh with no layers (MAGNUSIM_TEST_MESH_MESHER=standard) and a clean
// checkMesh report, so the mesh facts say a Standard mesh without layers. No WSL.
// Fails on the code before it: there was no such row, and k-omega SST on Standard was written with
// the skew-corrected lines.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKMESH = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'ok-hex-2d.log');
const PID = 'standard-mesh-walls-e2e';
const STEP = { timeout: 30_000 };
const WALL_FRICTION =
  "This Standard mesh has no wall layers, so its wall cells are tetrahedra under wall functions: on the validation set's turbulent pipe such walls read the wall friction up to about 31 % low with k-omega SST (0 to 10 % with the Robust preset, 28 to 31 % with Accurate) and about 13 % low with k-epsilon (Robust; with Accurate it diverged). Add boundary layers, or mesh with Hex-dominant, for wall friction.";
const PLAIN = {
  'Velocity gradient':
    'grad(U) Gauss linear inside the gradient limiter, not skew-corrected: k-omega SST on a Standard mesh; linearUpwind, the viscous terms and turbulence production read it',
  'Flux interpolation': 'linear, not skew-corrected: k-omega SST on a Standard mesh',
  'Gradient limiter': 'grad(U) cellLimited Gauss linear 1; grad(k), grad(omega) cellLimited Gauss linear 1',
};
let host;
let fake;
let sim;
let meshId;
/** Runs and studies a test made, undone in afterEach. */
let runs = [];
let studies = [];

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}
const results = (o) => ({ project_id: '', simulation_id: '', run_id: '', kind: '', field: '', time: -1, points: [], samples: 0, filter_key: '', values: [], ...o });
const readSetup = (o) => ({ project_id: '', simulation_id: '', what: '', id: '', other_id: '', page: 0, ...o });
const lastResults = () => resultsIn(fake.requests().at(-1));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('standard-mesh-walls');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Standard walls project');
  host = await startHost({
    name: 'standard-mesh-walls',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
      MAGNUSIM_TEST_MESH_MESHER: 'standard',
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
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state', turbulence_model: 'kOmegaSST', numerics_preset: null });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ page, request }) => {
  runs = [];
  studies = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
});

test.afterEach(async ({ page, request }) => {
  await page.close();
  for (const { study, rid } of runs) await request.post(api('/api/run/delete'), { data: { project_id: PID, simulation_id: study, run_id: rid } }).catch(() => {});
  for (const s of studies) await request.post(api('/api/simulation/delete'), { data: { project_id: PID, simulation_id: s } }).catch(() => {});
  await request.post(api('/api/simulation/update'), { data: { project_id: PID, simulation_id: sim, turbulence_model: 'kOmegaSST', activate: true } }).catch(() => {});
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

async function draft(request, name, study = sim, mesh = meshId) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: study, name, mesh_id: mesh });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  runs.push({ study, rid });
  return rid;
}

const checkRow = (panel, code) => panel.locator(`[data-run-check="1"] [data-run-check-row="${code}"]`);

async function numericsOf(panel) {
  const box = panel.locator('[data-run-numerics="1"]');
  await expect(box).toBeVisible(STEP);
  if (!(await box.evaluate((el) => el.open))) await box.locator('summary').click();
  return (label) => box.locator(`[data-run-numerics-row="${label}"] .run-numerics-value`);
}

/** The Assistant's precheck and numerics reads of `rid`, from one dock turn. */
async function assistantReads(page, rid, name, study) {
  const seen = {};
  fake.reply(
    { tools: [{ name: 'read_results', input: results({ simulation_id: study, run_id: rid, kind: 'precheck' }) }] },
    () => {
      seen.check = lastResults()[0];
      return { tools: [{ name: 'read_setup', input: readSetup({ simulation_id: study, what: 'numerics', id: rid }) }] };
    },
    () => {
      seen.numerics = lastResults()[0];
      return { text: 'Read.' };
    },
  );
  await openDock(page);
  await dockSend(page, `Check ${name} before it starts.`);
  await expect(dockTurn(page).locator('[data-turn-end="done"]').last()).toBeVisible({ timeout: 60_000 });
  expect(seen.check.ok, JSON.stringify(seen.check)).toBe(true);
  expect(seen.numerics.ok, JSON.stringify(seen.numerics)).toBe(true);
  return seen;
}

test('k-omega SST on a Standard mesh with no wall layers: a warning on its walls, the plain velocity gradient and flux, as the Assistant reads them', async ({ page, request }) => {
  test.setTimeout(240_000);
  const rid = await draft(request, 'Run_std_sst');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const row = checkRow(panel, 'wall_friction_mesh');
  await expect(row).toHaveAttribute('data-level', 'warn', STEP);
  await expect(row.locator('[data-run-check-text="1"]')).toHaveText(WALL_FRICTION);
  const num = await numericsOf(panel);
  for (const [label, value] of Object.entries(PLAIN)) await expect(num(label), label).toHaveText(value, STEP);
  // The Assistant: the same row and the same rows, word for word.
  const seen = await assistantReads(page, rid, 'Run_std_sst', sim);
  const finding = seen.check.data.findings.find((f) => f.code === 'wall_friction_mesh');
  expect([finding.level, finding.text]).toEqual(['warn', WALL_FRICTION]);
  const read = Object.fromEntries(seen.numerics.data.rows.map((x) => [x.label, x.value]));
  for (const [label, value] of Object.entries(PLAIN)) expect(read[label], label).toBe(value);
});

test('a laminar study on the same Standard mesh: no wall row, and the skew-corrected lines', async ({ page, request }) => {
  test.setTimeout(240_000);
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, turbulence_model: 'laminar' });
  const rid = await draft(request, 'Run_std_laminar');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  const num = await numericsOf(panel);
  await expect(num('Velocity gradient')).toHaveText(
    'grad(U) skew-corrected (Gauss skewCorrected linear) inside the gradient limiter; linearUpwind and the viscous terms read it',
    STEP,
  );
  await expect(num('Flux interpolation')).toHaveText('flux(HbyA) skewCorrected linear; the rest linear');
  await expect(panel.locator('[data-run-check="1"]')).toBeVisible(STEP);
  await expect(checkRow(panel, 'wall_friction_mesh')).toHaveCount(0);
});
