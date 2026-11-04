// The Mesh panel's quality line (RH2, run health spec 4.4): a generated mesh shows its worst
// cells ("Worst cells: 73° non-orthogonal, skewness 8.0, aspect ratio 38") and checkMesh's
// failed checks, only when they are known, and the Assistant's read_setup mesh reads the same
// numbers and lines (two-way parity: what the panel shows, the Assistant reads).
//
// Generate runs the fake mesher (MAGNUSIM_TEST_COMPUTE=fake: no WSL, no OpenFOAM) with a real
// checkMesh report (MAGNUSIM_TEST_MESH_CHECKMESH, from OpenFOAM v2606: python/tests/fixtures/
// mesh-facts/checkmesh): it writes the mesh's facts as the real meshers do (cfddesk.mesh.facts),
// so the path from the generator's result to the record, the panel and the Assistant runs.
// Seeded records cover a failed check the meshers do not accept, a mesh made before checkMesh
// numbers were kept (no line), and an older record with the worst cells as top-level keys.
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKMESH = join(HERE, '..', 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh');
const GEN = 'mesh-quality-gen-e2e';
const SEEDED = 'mesh-quality-seeded-e2e';
const STEP = { timeout: 30_000 };

let host;
let fake;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('mesh-quality');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, GEN, 'Mesh quality');
  seedElbowProject(projects, SEEDED, 'Mesh quality seeded');
  host = await startHost({
    name: 'mesh-quality',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '2',
      MAGNUSIM_TEST_MESH_CHECKMESH: join(CHECKMESH, 'skewed.log'),
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
});

test.afterEach(() => {
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
});

const api = (path) => `${host.base}${path}`;

async function meshOf(request, pid) {
  const doc = await (await request.get(api(`/api/mesh?project_id=${pid}`))).json();
  return doc.mesh;
}

async function openProject(page, pid) {
  if (page.url() === api(`/#/p/${pid}`)) await page.reload();
  else await page.goto(api(`/#/p/${pid}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
}

async function openMeshPanel(page, meshId) {
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible(STEP);
  return form;
}

/** The Assistant's read_setup mesh answer, through the dock (a scripted turn). */
async function assistantReadsMesh(page, meshId) {
  fake.reply({ tools: [{ name: 'read_setup', input: { project_id: '', simulation_id: '', what: 'mesh', id: meshId, other_id: '', page: 0 } }] }, { text: 'Read it.' });
  await dockSend(page, 'How good is this mesh?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
  const chats = fake.requests().filter((r) => r.kind === 'chat');
  const [read] = resultsIn(chats.at(-1));
  expect(read.ok, JSON.stringify(read)).toBe(true);
  return read.data;
}

/** The folder of a project's only mesh record. */
function meshFolder(pid) {
  const geoms = join(host.projects, pid, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const root = join(sims, s, 'meshes');
      if (!existsSync(root)) continue;
      for (const f of readdirSync(root)) if (existsSync(join(root, f, 'mesh.json'))) return join(root, f);
    }
  }
  throw new Error(`no mesh folder in ${pid}`);
}

/** A done mesh record whose result carries `extra` (a quality, the older top-level keys, or none). */
function seedDoneMesh(pid, extra) {
  const file = join(meshFolder(pid), 'mesh.json');
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const caseDir = join(meshFolder(pid), 'case');
  writeFileSync(
    file,
    JSON.stringify({
      ...rec,
      generated: true,
      live_mesh_result: { status: 'done', generate_id: 'g-e2e', n_cells: 960, n_points: 2070, case_dir: caseDir, mesh_path: join(caseDir, 'constant', 'polyMesh'), ...extra },
    }),
  );
  return String(rec.id);
}

const SKEWED_LINES = ['Worst cells: 73° non-orthogonal, skewness 8.0, aspect ratio 38', 'checkMesh failed 1 check: 22 highly skewed faces.'];

test('a generated mesh shows its worst cells and failed check, after a reload too, and the Assistant reads the same', async ({ page, request }) => {
  test.setTimeout(240_000);
  const meshId = String((await meshOf(request, GEN)).id);
  await openProject(page, GEN);
  let form = await openMeshPanel(page, meshId);
  await expect(form.locator('[data-mesh-quality]')).toHaveCount(0);
  await form.locator('[data-mesh-generate="1"]').click();
  await expect(form.locator('.mesh-finished[data-mesh-status="ready"]')).toBeVisible({ timeout: 90_000 });
  await expect(form.locator('[data-mesh-quality] > div')).toHaveText(SKEWED_LINES, STEP);

  // The record keeps checkMesh's numbers; the mesh's facts and Courant rates are beside it.
  const live = (await meshOf(request, GEN)).live_mesh_result;
  expect(live.quality).toMatchObject({
    known: true,
    ok: false,
    n_failed: 1,
    max_non_orthogonality: 72.64597596,
    max_skewness: 8.000000342,
    max_aspect_ratio: 38.02406827,
    failed: [{ check: 'skewness', count: 22, unit: 'faces', accepted: true }],
  });
  expect(existsSync(join(live.case_dir, 'mesh-facts.json'))).toBe(true);
  expect(existsSync(join(live.case_dir, 'courant-rates.json'))).toBe(true);

  await openProject(page, GEN);
  form = await openMeshPanel(page, meshId);
  await expect(form.locator('[data-mesh-quality] > div')).toHaveText(SKEWED_LINES, STEP);

  // The Assistant reads what the panel shows.
  await openDock(page);
  const read = await assistantReadsMesh(page, meshId);
  expect(read.quality).toEqual({
    max_non_orthogonality: 72.64597596,
    max_skewness: 8.000000342,
    max_aspect_ratio: 38.02406827,
    n_failed: 1,
    failed: [{ check: 'skewness', count: 22, unit: 'faces' }],
    lines: SKEWED_LINES,
  });
});

test('seeded records: a failed check the meshers do not accept, no line without checkMesh numbers, and an older record still read', async ({ page }) => {
  test.setTimeout(240_000);
  // OpenFOAM v2606's report on a mesh with a cell turned inside out (checkmesh/negative-volume.log).
  const meshId = seedDoneMesh(SEEDED, {
    quality: {
      known: true,
      ok: false,
      n_failed: 4,
      max_non_orthogonality: 107.448358,
      avg_non_orthogonality: 3.79442965,
      severe_non_orthogonal_faces: 0,
      max_skewness: 2.088148346,
      skewed_faces: 0,
      max_aspect_ratio: 4.34120625,
      min_volume_m3: -6.768447007e-5,
      failed: [
        { check: 'non_aligned_edges', count: 1, unit: 'edges', accepted: false },
        { check: 'negative_volume', count: 1, unit: 'cells', accepted: false },
        { check: 'non_orthogonality', count: 3, unit: 'faces', accepted: false },
        { check: 'face_pyramids', count: 4, unit: 'faces', accepted: false },
      ],
    },
  });
  await openProject(page, SEEDED);
  let form = await openMeshPanel(page, meshId);
  await expect(form.locator('.mesh-finished[data-mesh-status="ready"]')).toBeVisible(STEP);
  await expect(form.locator('[data-mesh-quality] > div')).toHaveText(
    [
      'Worst cells: 107° non-orthogonal, skewness 2.1, aspect ratio 4.3',
      'checkMesh failed 4 checks: 1 edge out of line with the 2D directions, 1 cell with a negative volume, 3 faces over 90° non-orthogonal, 4 wrongly oriented faces.',
    ],
    STEP,
  );

  // A mesh made before its checkMesh numbers were kept: its cells, and no quality line.
  seedDoneMesh(SEEDED, {});
  await openProject(page, SEEDED);
  form = await openMeshPanel(page, meshId);
  await expect(form.locator('.mesh-finished[data-mesh-status="ready"] .mesh-finished-line')).toHaveText('960 cells / 2,070 nodes', STEP);
  await expect(form.locator('[data-mesh-quality]')).toHaveCount(0);
  await openDock(page);
  expect((await assistantReadsMesh(page, meshId)).quality).toBeNull();

  // An older record with the worst cells as top-level keys: the panel and the Assistant read them.
  seedDoneMesh(SEEDED, { max_non_orthogonality: 78.2, max_skewness: 3.84 });
  await openProject(page, SEEDED);
  form = await openMeshPanel(page, meshId);
  await expect(form.locator('[data-mesh-quality] > div')).toHaveText(['Worst cells: 78° non-orthogonal, skewness 3.8'], STEP);
  await openDock(page);
  const read = await assistantReadsMesh(page, meshId);
  expect(read.quality).toEqual({ max_non_orthogonality: 78.2, max_skewness: 3.84, max_aspect_ratio: null, n_failed: 0, failed: [], lines: ['Worst cells: 78° non-orthogonal, skewness 3.8'] });
});
