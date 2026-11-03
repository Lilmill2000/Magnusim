// A second Stop never silently forces a run (run health spec RH1 §3.4). The Assistant's jobs stop
// twice: the first is a plain Stop (it writes its current step), the second answers that it is
// already stopping, with no Allow card and nothing more sent. A plain Stop sent again to the route
// answers the same, never "forced". The Run panel says Stopping meanwhile, and the run ends
// "Stopped.", its last step written. Force stop stays the person's own button (and the Assistant's
// force_stop, which asks first).
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake: no WSL), whose plain Stop holds
// the run stopping for MAGNUSIM_TEST_SOLVE_STOP_SECONDS as a real one writes its step; the
// scripted model. Through the fake this covers the rule (stop-decision.js); the runner's levels
// are in the node tests (run-stop-again.test.mjs, solve-stop-slot.test.mjs, foam-runner.test.js).
// Fails on the code before: the second plain Stop answered "forced" and the run was force-stopped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PID = 'stop-twice-e2e';
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
const jobs = (o) => ({ project_id: '', action: 'stop', job_id: '', ids: [], ...o });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('assistant-stop-twice');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Stop twice project');
  host = await startHost({
    name: 'assistant-stop-twice',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_SOLVE_SECONDS: '300',
      // A plain Stop writes its current step for this long, then the run ends stopped.
      MAGNUSIM_TEST_SOLVE_STOP_SECONDS: '15',
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

const runRow = async (request, rid) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === rid) || {};

test('the Assistant stops a run twice: the second is "already stopping" with no card; the run ends Stopped., never forced', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await postOk(request, '/api/test/assistant/reset', {});
  await useScriptedModel(request, host.base, fake, 'cloud');
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run 1', mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
  await expect(panel.locator('[data-run-status="running"]')).toBeVisible(STEP);

  const chats = () => fake.requests().filter((r) => r.kind === 'chat');
  const before = chats().length;
  fake.reply(
    { text: 'Stopping it.', tools: [{ name: 'jobs', input: jobs({ job_id: `solve.${rid}` }) }] },
    { text: 'Once more.', tools: [{ name: 'jobs', input: jobs({ job_id: `solve.${rid}` }) }] },
    { text: 'It is writing its current step, then it stops.' },
  );
  await openDock(page);
  await dockSend(page, 'Stop the run.');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  // No Allow card: a plain stop asks nothing, and the second one is not a forced stop.
  await expect(dockGate(page)).toHaveCount(0);
  const first = resultsIn(chats()[before + 1])[0];
  const second = resultsIn(chats()[before + 2])[0];
  expect([first.ok, first.data.status, first.data.already]).toEqual([true, 'stopping', undefined]);
  expect([second.ok, second.data.status, second.data.already]).toEqual([true, 'stopping', true]);
  expect(second.data.done).toBe('Run 1 is already stopping: it writes its current step first');
  expect(fake.pending()).toBe(0);

  // The person sees it stopping, with Force stop as the button that ends it at once.
  await expect(panel.locator('.sim-finished > .mat-k')).toHaveText('Stopping', STEP);
  await expect(panel.locator('[data-run-reason="1"]')).toContainText("Stopping. You can change this run's settings once it has stopped.", STEP);
  await expect(panel.locator('[data-run-stop="1"]')).toHaveText('Force stop');
  // A plain Stop sent again to the route: already stopping, never forced.
  const again = await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  expect([again.stopping, again.already, again.forced, again.stopped]).toEqual([true, true, undefined, undefined]);
  expect((await runRow(request, rid)).status).toBe('running');

  // It ends as a plain Stop does: stopped, "Stopped.".
  await expect.poll(async () => (await runRow(request, rid)).status, { timeout: 60_000 }).toBe('stopped');
  expect((await runRow(request, rid)).note).toBe('Stopped.');
  await expect(panel.locator('[data-run-status="stopped"]')).toBeVisible(STEP);
  await expect(panel.locator('.sim-finished > .mat-k')).toHaveText('Run stopped');
});
