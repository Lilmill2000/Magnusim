// The Assistant adds a monitor to a run and then changes it, while the person has that run's
// Monitors panel open (core host tools spec C2, 6.4): the open panel lists the new monitor and
// then its new name, with no reload. A run's monitors live on the run, so the AI's write says
// "runs" changed; the page reads the run list again, draws the panel's list of monitors and,
// for a run that has started, reads their numbers (window.__CFD_REFRESH_MONITORS__, a GET
// /api/run/monitors). The run has results, so the change asks first ("Can't be undone").
// The panel's list once stayed as it was (only the cards were drawn again), and a renamed
// monitor kept its old name in the tree.
// Its own server with the Assistant's test switches, the scripted model (support/fake-llm.mjs)
// and the fake compute (MAGNUSIM_TEST_COMPUTE=fake), which meshes and solves the run first.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PID = 'assistant-monitors-e2e';
const STEP = { timeout: 30_000 };
let host;
let fake;
let sim;
let rid;
let probeType;

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
  test.setTimeout(300_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('assistant-core-monitors');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Monitors project');
  host = await startHost({
    name: 'assistant-core-monitors',
    tmp,
    projects,
    env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base, MAGNUSIM_TEST_COMPUTE: 'fake', MAGNUSIM_TEST_MESH_SECONDS: '2', MAGNUSIM_TEST_SOLVE_SECONDS: '2' },
  });
  // A run that has solved (the fake mesher and solver), as the person's would have.
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  const meshId = String(doc.mesh.id);
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 90_000 }).toBe('done');
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name: 'Run monitored', mesh_id: meshId });
  rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
  await expect.poll(async () => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}&run_id=${rid}`)).run?.status, { timeout: 90_000 }).toBe('done');
  // A point probe: the monitor type the registry places at points.
  const registry = await getJson(request, '/api/registry');
  probeType = (registry.monitor || []).find((m) => m.target === 'point')?.key;
  expect(probeType, 'the registry has a point monitor').toBeTruthy();
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

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

/** Opens the run's Monitors panel from the tree, as the person does. */
async function openRunMonitors(page) {
  const folder = page.locator(`#left-tree [data-w17-sim-id="${sim}"] li[data-w27-sim-control="1"]`).first();
  await expect(folder).toBeVisible(STEP);
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  const runLi = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  await expect(runLi).toBeVisible(STEP);
  if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) await runLi.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree li[data-w27-run-rcs="${rid}"] > .tree-row .tl`).click();
  await expect(page.locator('#panel-results-hub')).toBeVisible(STEP);
}

test("the AI adds a monitor, then renames and moves it: the open Monitors panel shows each change, with no reload", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(api(`/#/p/${PID}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await openRunMonitors(page);
  const hub = page.locator('#panel-results-hub');
  await expect(hub.locator('#results-hub-list')).not.toContainText('Tip probe');
  // A reload would lose this.
  await page.evaluate(() => {
    window.__G2_SAME_PAGE__ = true;
  });

  let monitorId = '';
  fake.reply(
    { text: 'Adding a probe.', tools: [{ name: 'setup_edit', input: setup({ kind: 'monitor', action: 'add', other_id: rid, type: probeType, name: 'Tip probe', values: [{ key: 'points', value: '[[0, 0, 0.05]]' }] }) }] },
    async (body) => {
      const [added] = resultsIn(body);
      expect(added.ok, JSON.stringify(added)).toBe(true);
      monitorId = added.data.ids.monitor;
      // The panel shows it before the model changes it.
      await expect(hub.locator('#results-hub-list')).toContainText('Tip probe', STEP);
      await expect(hub.locator('#run-monitors-custom-cards .mon-card-name')).toHaveText(['Tip probe'], STEP);
      return { tools: [{ name: 'setup_edit', input: setup({ kind: 'monitor', action: 'update', other_id: rid, id: monitorId, name: 'Tip probe moved', values: [{ key: 'points', value: '[[0, 0, 0.08]]' }] }) }] };
    },
    { text: 'The probe is at the tip.' },
  );
  // The page reads the run's monitors again after each change (the started run's numbers).
  const monitorsRead = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/run/monitors' && new URL(r.url()).searchParams.get('run_id') === rid);
  await openDock(page);
  await dockSend(page, 'Add a probe at the tip, then move it.');
  // The run has results made with its old monitors: changing one asks first (spec 14.2).
  const card = dockGate(page);
  await expect(card).toContainText("Can't be undone", { timeout: 60_000 });
  await expect(card.locator('.dock-gate-copy')).toContainText('Run monitored');
  await card.locator('[data-gate-answer="yes"]').click(STEP);
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
  await monitorsRead;
  // The renamed monitor, in the panel still open, and only once.
  await expect(hub).toBeVisible();
  await expect(hub.locator('#results-hub-list')).toContainText('Tip probe moved', STEP);
  await expect(hub.locator('#run-monitors-custom-cards .mon-card-name')).toHaveText(['Tip probe moved'], STEP);
  // The tree's Monitors folder lists it too.
  await expect(page.locator(`#left-tree li[data-w27-run-rcs="${rid}"]`)).toContainText('Tip probe moved');
  expect(await page.evaluate(() => window.__G2_SAME_PAGE__ === true), 'the page was not reloaded').toBe(true);
  // What the run holds now.
  const status = await page.evaluate(async ([p, s, r]) => (await (await fetch(`/api/run/status?project_id=${p}&simulation_id=${s}&run_id=${r}`)).json()).run, [PID, sim, rid]);
  const rec = (status.result_controls || []).find((m) => m.id === monitorId);
  expect([rec?.name, rec?.points]).toEqual(['Tip probe moved', [[0, 0, 0.08]]]);
});
