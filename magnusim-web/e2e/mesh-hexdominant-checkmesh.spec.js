// Hex-dominant's checkMesh verdict (Daniel's D1, 2026-11-07: "Generate ends failed with the failed
// check named, so you never solve on a broken mesh"). Since run health RH2 the Hex-dominant script
// runs checkMesh, but Generate ended "done" whatever it found: a 55 D pipe at fineness 6 had cells
// of negative volume, the Mesh panel said Mesh ready, and the solve then failed. Now a mesh that
// fails the rule Standard and cfMesh are gated by (Mesh OK, or only skewed faces and up to 8 cells
// of high aspect ratio) ends Generate failed, naming the failed checks.
//
// Its own server with the fake mesher (MAGNUSIM_TEST_COMPUTE=fake): standing in for Hex-dominant it
// applies the real verdict (cfddesk.wsl.mesh_run.checkmesh_failure) to that pipe's own checkMesh
// report (MAGNUSIM_TEST_MESH_CHECKMESH: python/tests/fixtures/mesh-facts/checkmesh/
// hexdominant-pipe-55d.log, from W6 in tests/wsl/test_mesh_wsl.py). The Mesh panel says Mesh failed
// with the failed checks as its line, and under it the mesh's worst cells (its quality line, the
// failed checks not said twice); the tree says Failed; after a reload the same. The Assistant's
// read_setup mesh reads the same reason and the same quality lines (two-way parity).
// Fails on the code before D1: the panel said Mesh ready (and the quality line said
// "aspect ratio 4,453,130,000,…" in 94 digits).
//
// No run starts on that mesh: a run whose Start the person clicked while the mesh generated
// (queued behind it) leaves the queue once the mesh fails, never started, and the toast says why
// in the mesh's own words; a Start sent straight to the route is refused with them. Fails on D1
// alone (before Start's gate read the mesh's status): the queued run solved on the failed mesh.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { createRun, getJson, openRunPanel, runRow } from './support/compute-slot.js';
import { dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKMESH = join(HERE, '..', 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'hexdominant-pipe-55d.log');
const PID = 'mesh-hexdominant-checkmesh-e2e';
const STEP = { timeout: 30_000 };
// What the person reads, word for word.
const REASON =
  'checkMesh failed 5 checks: 8 cells with a high aspect ratio, 8 cells with a negative volume, 84 faces over 90° non-orthogonal, 644 wrongly oriented faces, 164 highly skewed faces.';
const WORST = 'Worst cells: 180° non-orthogonal, skewness 29, aspect ratio over 1,000,000';

let host;
let fake;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('mesh-hex-checkmesh');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Hex-dominant checkMesh');
  host = await startHost({
    name: 'mesh-hex-checkmesh',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_COMPUTE: 'fake',
      // Long enough to start a run while it meshes.
      MAGNUSIM_TEST_MESH_SECONDS: '8',
      MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_EVENT_HUB: '1',
    },
  });
});

test.afterAll(async () => {
  host?.stop();
  if (fake) await fake.stop();
});

test.beforeEach(async ({ request, page }) => {
  await request.post(`${host.base}/api/test/assistant/reset`, { data: {} });
  await useScriptedModel(request, host.base, fake, 'cloud');
  await page.setViewportSize({ width: 1280, height: 800 });
  page.setDefaultTimeout(30_000);
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

const api = (path) => `${host.base}${path}`;

async function meshOf(request) {
  return (await (await request.get(api(`/api/mesh?project_id=${PID}`))).json()).mesh;
}

async function openMeshPanel(page, meshId) {
  if (page.url() === api(`/#/p/${PID}`)) await page.reload();
  else await page.goto(api(`/#/p/${PID}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible(STEP);
  return form;
}

/** What the person sees of the failed mesh: Mesh failed, the reason, the worst cells, the tree's Failed. */
async function expectFailed(page, form, meshId) {
  const status = form.locator('.mesh-finished');
  await expect(status).toHaveAttribute('data-mesh-status', 'failed', { timeout: 90_000 });
  await expect(status.locator('.mat-k')).toHaveText('Mesh failed');
  await expect(status.locator('.mesh-finished-line')).toHaveText(REASON);
  await expect(status.locator('[data-mesh-quality] > div')).toHaveText([WORST], STEP);
  await expect(form.locator('[data-mesh-status="ready"]')).toHaveCount(0);
  const row = page.locator(`#left-tree li[data-w20-mesh-item="${meshId}"] > .tree-row`);
  await expect(row.locator('[data-mesh-failed="1"]')).toHaveText('Failed', STEP);
}

test('a Hex-dominant mesh that fails checkMesh ends Generate failed, naming the checks, after a reload too, and the Assistant reads the same', async ({ page, request }) => {
  test.setTimeout(240_000);
  const mesh = await meshOf(request);
  const meshId = String(mesh.id);
  // The study's mesh on Hex-dominant.
  const set = await request.post(api('/api/mesh'), {
    data: { project_id: PID, simulation_id: String(mesh.simulation_id || ''), mesh_id: meshId, advanced: { mesh_engine: 'snappy_hexdominant' } },
  });
  expect(set.ok(), await set.text()).toBe(true);
  expect((await meshOf(request)).settings?.advanced?.mesh_engine).toBe('snappy_hexdominant');

  let form = await openMeshPanel(page, meshId);
  await form.locator('[data-mesh-generate="1"]').click();
  await expectFailed(page, form, meshId);

  // The record: failed, with the reason and the mesh's quality (its failed checks and worst cells).
  const live = (await meshOf(request)).live_mesh_result || {};
  expect([live.status, live.error]).toEqual(['failed', REASON]);
  expect(live.quality).toMatchObject({ known: true, ok: false, n_failed: 5, max_non_orthogonality: 179.825 });
  expect(live.quality.failed.map((f) => [f.check, f.count])).toEqual([
    ['aspect_ratio', 8],
    ['negative_volume', 8],
    ['non_orthogonality', 84],
    ['face_pyramids', 644],
    ['skewness', 164],
  ]);

  // After a reload: the same.
  form = await openMeshPanel(page, meshId);
  await expectFailed(page, form, meshId);

  // The Assistant reads the same reason and the same lines.
  fake.reply({ tools: [{ name: 'read_setup', input: { project_id: '', simulation_id: '', what: 'mesh', id: meshId, other_id: '', page: 0 } }] }, { text: 'Read it.' });
  await openDock(page);
  await dockSend(page, 'Why did this mesh fail?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  const [read] = resultsIn(chats.at(-1));
  expect(read.ok, JSON.stringify(read)).toBe(true);
  expect(read.data.engine).toBe('snappy_hexdominant');
  expect(read.data.generated).toMatchObject({ status: 'failed', error: REASON });
  expect(read.data.quality.lines).toEqual([WORST, REASON]);
});

test('a run started while its Hex-dominant mesh generates never starts once the mesh fails checkMesh, and the person is told why', async ({ page, request }) => {
  test.setTimeout(240_000);
  const mesh = await meshOf(request);
  const meshId = String(mesh.id);
  const sim = String(mesh.simulation_id || '');
  const set = await request.post(api('/api/mesh'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId, advanced: { mesh_engine: 'snappy_hexdominant' } } });
  expect(set.ok(), await set.text()).toBe(true);
  const meshName = String(mesh.name || 'Mesh 1');
  // Start's refusal, in the mesh's own words (validateSolveReady).
  const refused = `${meshName}'s last Generate failed: ${REASON} Generate it again before using it on a run.`;
  const name = 'Run behind the mesh';
  const runId = await createRun(request, { base: host.base, projectId: PID, simulationId: sim, name });

  // Generate, then the run's Start while the mesh generates: it queues the run behind its mesh.
  const form = await openMeshPanel(page, meshId);
  await form.locator('[data-mesh-generate="1"]').click();
  await expect(form.locator('.mesh-finished')).toHaveAttribute('data-mesh-status', 'generating', STEP);
  // Every text the finish toast shows from here on (this page load stays).
  await page.evaluate(() => {
    window.__d1Toasts = [];
    const el = document.getElementById('job-finish-toast');
    new MutationObserver(() => {
      if (el && !el.hidden && el.textContent) window.__d1Toasts.push(el.textContent);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId, reload: false });
  const start = panel.locator('[data-run-start]');
  await expect(start).toHaveText('Add to queue', STEP);
  await start.click();
  await expect(start).toHaveText('Remove from queue', STEP);

  // The mesh fails; the run leaves the queue at once, never started, and the toast says why.
  await expect.poll(async () => (await meshOf(request)).live_mesh_result?.status, { timeout: 90_000 }).toBe('failed');
  await expect
    .poll(() => page.evaluate(() => window.__d1Toasts.slice()), { timeout: 30_000 })
    .toContain(`${name} could not start from the queue: ${refused}`);
  const queue = await getJson(request, api(`/api/compute-queue?project_id=${PID}`));
  expect((queue.items || []).filter((r) => String(r.run_id) === runId)).toEqual([]);
  expect((queue.failed || []).filter((f) => String(f.run_id) === runId).map((f) => f.error)).toEqual([refused.replace(/\.$/, '')]);
  // It never started: still a draft, nothing solving.
  expect((await runRow(request, { base: host.base, projectId: PID, simulationId: sim, runId })).status).toBe('draft');
  expect((await getJson(request, api('/api/compute-queue'))).busy || null).toBeNull();
  // Its Run panel: Start again, and the mesh to generate first.
  await expect(start).toHaveText('Start', STEP);
  await expect(panel.locator('[data-run-reason="1"] .sim-run-hint-msg')).toHaveText(`Generate "${meshName}" before starting.`, STEP);

  // A Start sent straight to the route is refused with the same reason.
  const direct = await request.post(api('/api/run/start'), { data: { project_id: PID, simulation_id: sim, run_id: runId } });
  expect(direct.status()).toBe(400);
  expect((await direct.json()).error).toBe(refused);
  expect((await runRow(request, { base: host.base, projectId: PID, simulationId: sim, runId })).status).toBe('draft');
});
