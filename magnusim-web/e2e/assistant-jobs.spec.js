// The Assistant's job tools in the workbench (Assistant phase 5 spec 06, C4): the person asks in
// the dock, the scripted model calls compute, wait and jobs, and the person sees it where they
// look: a compute card in the dock, the mesh generating in the tree, the wait's progress in the
// dock step, the mesh stopped by the AI's jobs stop (Stopped in the tree and the panel), the
// turn's end line naming what still runs after the person's Stop (the mesh keeps running), and
// a finished export's Download link in the dock that saves the zip when clicked.
// Its own server with the Assistant's test switches (a test home, the scripted model:
// support/fake-llm.mjs) and the fake compute (MAGNUSIM_TEST_COMPUTE=fake: a stand-in mesher and
// solver, no WSL). The compute card's own words (gateText) come with the runner's per-call
// cards (lane A); until then the card is the runner's generic compute card. Until ui_sync
// (lane B), the workbench learns of a job the Assistant started from its queue watch (every
// 10 s while idle), so the fake mesher here runs 30 s.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, offeredTools, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'assistant-jobs-e2e';
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

/** A compute call's input as a strict model sends it: every field, "" / 0 / -1 / [] when unused. */
const compute = (o) => ({ project_id: '', simulation_id: '', action: '', mesh_id: '', run_id: '', extra_iterations: 0, end_time: 0, frames: '', time: -1, plugin: '', chain: [], estimate_minutes: 0, ...o });
const wait = (ids, timeout = 120) => ({ project_id: '', job_ids: ids, until: 'all', timeout_s: timeout });
const jobs = (o) => ({ project_id: '', action: 'stop', job_id: '', ids: [], ...o });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('assistant-jobs');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Jobs project');
  host = await startHost({
    name: 'assistant-jobs',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      // Long enough that the workbench's queue watch (every 10 s while idle) sees it run.
      MAGNUSIM_TEST_MESH_SECONDS: '30',
    },
  });
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  meshId = String(doc.mesh.id);
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ request, page }) => {
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async ({ request }) => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
  // Nothing left meshing for the next test.
  await request.post(api('/api/mesh/stop'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
});

async function openProject(page) {
  await page.goto(api(`/#/p/${PID}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await openDock(page);
}

const meshRow = (page) => page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
const meshLive = async (request) => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status || '';

/** Allows the dock's compute card. */
async function allow(page) {
  const card = dockGate(page);
  await expect(card).toBeVisible(STEP);
  await expect(card.locator('[data-dock-risk="compute"], .dock-gate-title')).not.toHaveCount(0);
  await card.locator('[data-gate-answer="yes"]').click(STEP);
}

test('the AI meshes and waits: a compute card, the mesh generating in the tree, the wait in the dock, then done', async ({ page, request }) => {
  test.setTimeout(180_000);
  fake.reply(
    { text: 'Meshing.', tools: [{ name: 'compute', input: compute({ action: 'mesh_generate' }) }] },
    { tools: [{ name: 'wait', input: wait([`mesh.${meshId}`]) }] },
    { text: 'Mesh 1 is generated.' },
  );
  await openProject(page);
  await dockSend(page, 'Mesh the study.');
  await allow(page);
  // The tree shows it generating (the person's own view of the job), then generated.
  await expect(meshRow(page).locator('.tree-spin')).toBeVisible(STEP);
  const waitStep = dockTurn(page).locator('[data-dock-step]').nth(1);
  await expect(waitStep.locator('.dock-progress-label')).toContainText('Mesh 1:', STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await expect(waitStep.locator('[data-dock-result]')).toContainText('Mesh 1 done');
  await expect(meshRow(page).locator('.tree-check')).toBeVisible(STEP);
  expect(await meshLive(request)).toBe('done');
  // The tools were offered in the workbench, and the model got the mesh's result.
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  expect(offeredTools(chats[0]).map((t) => t.name)).toEqual(expect.arrayContaining(['compute', 'wait', 'jobs']));
  const started = resultsIn(chats[1])[0];
  expect(started.data).toMatchObject({ job_id: `mesh.${meshId}`, state: 'running' });
  const waited = resultsIn(chats[2])[0];
  expect(waited.data.jobs[0]).toMatchObject({ job_id: `mesh.${meshId}`, status: 'done', result: { cells: 1, points: 8 } });
});

test("the AI's jobs stop ends a mesh it started: the tree and the panel say Stopped", async ({ page, request }) => {
  test.setTimeout(180_000);
  fake.reply(
    { tools: [{ name: 'compute', input: compute({ action: 'mesh_generate', mesh_id: meshId }) }] },
    async () => {
      // The stop goes in once the person sees it generating.
      await expect(meshRow(page).locator('.tree-spin')).toBeVisible(STEP);
      return { tools: [{ name: 'jobs', input: jobs({ job_id: `mesh.${meshId}` }) }] };
    },
    { text: 'Stopped it.' },
  );
  await openProject(page);
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  await dockSend(page, 'Mesh it, then stop.');
  await allow(page);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  const stopStep = dockTurn(page).locator('[data-dock-step]').nth(1);
  await expect(stopStep.locator('[data-dock-result]')).toContainText('Stopped Mesh 1');
  await expect(meshRow(page).locator('[data-mesh-stopped="1"]')).toHaveText('Stopped', STEP);
  await expect(page.locator('#panel-mesh-form .cfd-island .mesh-finished[data-mesh-status="stopped"] .mat-k')).toHaveText('Stopped', STEP);
  expect(await meshLive(request)).toBe('stopped');
});

test("the person's Stop ends the turn, not the mesh: the end line says it still runs and how to stop it", async ({ page, request }) => {
  test.setTimeout(180_000);
  fake.reply({ tools: [{ name: 'compute', input: compute({ action: 'mesh_generate' }) }] }, { tools: [{ name: 'wait', input: wait([`mesh.${meshId}`], 300) }] });
  await openProject(page);
  // A mesh long enough to outlive the turn.
  await dockSend(page, 'Mesh it and wait.');
  await allow(page);
  const waitStep = dockTurn(page).locator('[data-dock-step]').nth(1);
  await expect(waitStep.locator('.dock-progress-label')).toContainText('Mesh 1:', STEP);
  await page.locator('#assistant-dock [data-dock-stop="1"]').click();
  await expect(dockTurn(page).locator('[data-turn-end="stopped"]')).toBeVisible(STEP);
  await expect(dockTurn(page).locator('[data-dock-line="note"]').last()).toHaveText(/Still running: Mesh 1\. Stop it from the tree, the Queue, or ask the Assistant\./);
  // The mesh was not stopped with the turn.
  expect(await meshLive(request)).toBe('running');
  await expect(meshRow(page).locator('.tree-spin')).toBeVisible(STEP);
});

test("a finished export shows a Download link in the dock; the person's click saves the zip", async ({ page, request }) => {
  test.setTimeout(240_000);
  // A finished run whose case is a copy of the committed cavity case (saved times 0.1 ... 0.5).
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run export' });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  const rows = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs || [];
  const runDir = dirname(rows.find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(sidecar, JSON.stringify(doc, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(runJson, JSON.stringify({ ...rec, status: 'done', stage: 'done', has_results: true, n_saved_times: 5, last_saved_iteration: 0.5, finished_at: new Date().toISOString(), case_dir: caseDir }, null, 2));

  fake.reply(
    { tools: [{ name: 'compute', input: compute({ action: 'vtk_export', run_id: rid, frames: 'current', time: -1 }) }] },
    (body) => {
      const jobId = resultsIn(body)[0].data.job_id;
      return { tools: [{ name: 'wait', input: wait([jobId], 180) }] };
    },
    { text: 'The VTK file is ready: use the Download link.' },
  );
  await openProject(page);
  await dockSend(page, 'Export the latest time as VTK.');
  await allow(page);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 180_000 });
  const link = dockTurn(page).locator('a[data-dock-download]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText(/^Download Run_export-vtk-0\.5\.zip$/);
  // The model got the file's name and size, never its address.
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  const waited = resultsIn(chats.at(-1))[0];
  expect(waited.data.jobs[0]).toMatchObject({ status: 'done', result: { file_name: 'Run_export-vtk-0.5.zip' } });
  expect(JSON.stringify(waited)).not.toContain('/api/results/export-vtk');
  // The person's click saves it.
  const saved = page.waitForEvent('download');
  await link.click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe('Run_export-vtk-0.5.zip');
  const path = await download.path();
  expect(readFileSync(path).subarray(0, 2).toString('latin1')).toBe('PK');
});

test('the AI starts a run and waits for it: the run solves (the fake solver) and the tree says it is done', async ({ page, request }) => {
  test.setTimeout(240_000);
  // A generated mesh first (the fake mesher), as the person would have.
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(() => meshLive(request), { timeout: 90_000 }).toBe('done');
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run AI', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  fake.reply(
    { tools: [{ name: 'compute', input: compute({ action: 'run_start', run_id: rid }) }] },
    { tools: [{ name: 'wait', input: wait([`solve.${rid}`], 120) }] },
    { text: 'Run AI is done.' },
  );
  await openProject(page);
  await dockSend(page, 'Run it.');
  await allow(page);
  const waitStep = dockTurn(page).locator('[data-dock-step]').nth(1);
  await expect(waitStep.locator('.dock-progress-label')).toContainText('Run AI: iteration', STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 120_000 });
  await expect(waitStep.locator('[data-dock-result]')).toContainText('Run AI done');
  const status = await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}&run_id=${rid}`);
  expect(status.run.status).toBe('done');
  // The tree says so (after a reload: the open page follows the AI's runs live once ui_sync lands, lane B).
  const tree = await getJson(request, `/api/project/tree?project_id=${PID}`);
  const runRow = (tree.geometries || []).flatMap((g) => g.studies || []).flatMap((st) => st.runs || []).find((r) => String(r.id) === rid);
  expect(runRow?.status, JSON.stringify(runRow)).toBe('done');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await expect(page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tree-check`)).toBeVisible(STEP);
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  expect(resultsIn(chats.at(-1))[0].data.jobs[0]).toMatchObject({ job_id: `solve.${rid}`, status: 'done' });
});
