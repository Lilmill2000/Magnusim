// A running run's settings stay as they are solved (run health spec, RH1 commit 1): while a run
// solves, the Assistant's setup_edit of its solve settings is refused (run_running) before
// anything is saved, as the person's Run panel keeps them locked. The panel still shows Max
// Courant 100, the study's default for new runs is not rewritten (Add run shows 100), and the
// route refuses the same change for every caller. A save that changes none of its settings goes
// through and leaves them as it solves with them: the time steps its Start worked out are not
// written into the study's default (Add run shows them blank).
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake: no WSL) and the scripted model.
// Fails on the code before the stopped-run feature: the change was saved onto the running run and
// into the study's default while the person's panel was locked.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PID = 'run-locked-e2e';
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
  const tmp = e2eTemp('assistant-running-run-locked');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Locked run project');
  host = await startHost({
    name: 'assistant-running-run-locked',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      // Solving for the whole test: it is stopped at its end.
      MAGNUSIM_TEST_SOLVE_SECONDS: '300',
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

const runRow = async (request, rid) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === rid) || {};
const maxCo = (panel) => panel.getByLabel('Max Courant number', { exact: true });

/** Opens the run's Advanced settings (where Max Courant is). */
async function openAdvanced(panel) {
  const details = panel.locator('details.mesh-advanced').first();
  await expect(details).toBeVisible(STEP);
  if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
}

test("the Assistant's change of a running run's Max Courant is refused: the panel and the study's default keep 100", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run 1', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient: { end_time: 1, write_count: 10, max_co: 100, n_outer_correctors: 1 } });
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
  try {
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(panel.locator('[data-run-status="running"]')).toBeVisible(STEP);
    await openAdvanced(panel);
    await expect(maxCo(panel)).toHaveValue('100');
    await expect(maxCo(panel)).toBeDisabled();

    fake.reply(
      { text: 'Lowering Max Courant.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'transient.max_co', value: '5' }] }) }] },
      { text: 'It is solving: its settings can change once it has ended.' },
    );
    await openDock(page);
    await dockSend(page, 'Set Max Courant to 5.');
    await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
    // Refused before anything is asked or saved.
    await expect(dockGate(page)).toHaveCount(0);
    const chats = fake.requests().filter((r) => r.kind === 'chat');
    const result = resultsIn(chats.at(-1))[0];
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('run_running');
    expect(fake.pending()).toBe(0);

    // As a real Start leaves it (the analysis's plan): its time steps worked out (`auto`), its
    // write interval. Written beside the fake solve's own writes, so checked and written again.
    const worked = { delta_t: 0.0005, max_delta_t: 0.1, write_interval: 0.1, adjust_time_step: true, source: { delta_t: 'auto', max_delta_t: 'auto' } };
    const runJson = join(dirname((await runRow(request, rid)).case_dir), 'run.json');
    await expect.poll(async () => {
      const doc = JSON.parse(readFileSync(runJson, 'utf8'));
      if (doc.transient?.delta_t !== worked.delta_t) writeFileSync(runJson, JSON.stringify({ ...doc, transient: { ...doc.transient, ...worked } }, null, 2));
      await new Promise((r) => setTimeout(r, 400));
      return JSON.parse(readFileSync(runJson, 'utf8')).transient?.delta_t;
    }, STEP).toBe(worked.delta_t);
    // The Assistant's save of the value it already has: it changes nothing, and is not refused.
    const chatsBefore = fake.requests().filter((r) => r.kind === 'chat').length;
    fake.reply(
      { text: 'Keeping Max Courant.', tools: [{ name: 'setup_edit', input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'transient.max_co', value: '100' }] }) }] },
      { text: 'It stays 100.' },
    );
    await dockSend(page, 'Keep Max Courant at 100.');
    await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
    await expect(dockGate(page)).toHaveCount(0);
    const kept = resultsIn(fake.requests().filter((r) => r.kind === 'chat')[chatsBefore + 1])[0];
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    expect(fake.pending()).toBe(0);
    const solving = JSON.parse(readFileSync(runJson, 'utf8')).transient;
    expect(solving).toMatchObject({ max_co: 100, ...worked });

    // What the person sees: the running run's Max Courant as it solves.
    await expect(maxCo(panel)).toHaveValue('100');
    const row = await runRow(request, rid);
    expect([row.status, row.transient?.max_co]).toEqual(['running', 100]);
    // The route refuses it for every caller.
    const refused = await request.post(api('/api/run/update'), { data: { project_id: PID, simulation_id: sim, run_id: rid, transient: { max_co: 5 } } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: 'run_running' });
    expect((await runRow(request, rid)).transient?.max_co).toBe(100);
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await openAdvanced(panel);
    await expect(maxCo(panel)).toHaveValue('100');

    // Add run: a new run takes the study's default, which is still 100.
    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    const before = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id));
    await page.locator('#btn-create-run').click();
    let added = '';
    await expect.poll(async () => {
      added = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.map((r) => String(r.id)).find((id) => !before.includes(id)) || '';
      return added;
    }, STEP).not.toBe('');
    await expect(panel).toHaveAttribute('data-run-id', added, STEP);
    // As soon as the new run is made, with no reload: the study's saved settings, not the analysis's defaults.
    await openAdvanced(panel);
    await expect(maxCo(panel)).toHaveValue('100', STEP);
    await expect(maxCo(panel)).toBeEnabled();
    await expect(panel.getByLabel('Result frames', { exact: true })).toHaveValue('10');
    // Its time steps blank (worked out at its own Start), not the ones the running run's Start worked out.
    await expect(panel.getByLabel('Time step in seconds', { exact: true })).toHaveValue('');
    await expect(panel.getByLabel('Maximum time step in seconds', { exact: true })).toHaveValue('');
    expect((await runRow(request, added)).transient?.max_co).toBe(100);
    expect((await getJson(request, `/api/simulation-control?project_id=${PID}&simulation_id=${sim}`)).transient?.max_co).toBe(100);
    // After a reload, the same.
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: added });
    await openAdvanced(panel);
    await expect(maxCo(panel)).toHaveValue('100');
  } finally {
    await request.post(api('/api/run/stop'), { data: { project_id: PID, run_id: rid } });
  }
});
