// Heat Transfer (HT6): the mesher a new mesh starts with (host API 1.8
// AnalysisType.default_mesher). A new mesh in a Heat Transfer study starts on Hex-dominant,
// in an Incompressible Flow study on Standard, as the Mesh panel shows it and as it is saved;
// after a reload, the same. A mesh that exists keeps its mesher (one set to Standard stays
// Standard when another mesh is made), and a copy keeps its source's. Restore defaults on a
// Heat Transfer mesh gives Hex-dominant back, not Standard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK = join(HERE, 'fixtures', 'channel-block.step');
const stamp = () => Date.now().toString(36);

async function json(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** A new project with the channel part: its id, a ready() and a q() for its API. */
async function project(page, request) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' })).project.id,
    `Default mesher ${stamp()}`,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(BLOCK);
  await expect.poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 }).toBe(1);
  return { pid, q, ready };
}

/** Create a study of `analysis` from the Create Simulation modal: its id. */
async function study(page, analysis) {
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await page.locator(`#cs-type-list [data-analysis-key="${analysis}"]`).click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  return sid;
}

/** "+" a new mesh in study `sid` from the Mesh panel; the meshes after it. */
async function newMesh(page, request, p, sid, before) {
  const meshes = async () => (await json(request, p.q('/api/mesh', { simulation_id: sid }))).meshes || [];
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  await expect.poll(async () => (await meshes()).length, { timeout: 15_000 }).toBe(before + 1);
  return meshes();
}

/** Open mesh `mid` of study `sid` from the tree (the study and its Mesh folder expanded first). */
async function openMesh(page, sid, mid) {
  const studyLi = page.locator(`#left-tree li[data-w17-sim-id="${sid}"]`).first();
  if (!(await studyLi.evaluate((el) => el.classList.contains('expanded')))) await studyLi.locator(':scope > .tree-row .tw').click();
  const folder = studyLi.locator('li[data-w20-mesh="1"]').first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  await studyLi.locator(`[data-w20-mesh-item="${mid}"] > .tree-row .tl`).first().click();
}

const engineSelect = (page) => page.locator('#panel-mesh-form .cfd-island select[data-mesh-engine="1"]');

test('a new mesh starts on Hex-dominant in a Heat Transfer study and on Standard in an Incompressible Flow one; an existing mesh and a copy keep theirs', async ({ page, request }) => {
  test.setTimeout(300_000);
  const p = await project(page, request);

  // Heat Transfer: Hex-dominant, shown and saved.
  const ht = await study(page, 'heat_transfer_steady');
  let htMeshes = await newMesh(page, request, p, ht, 0);
  expect(htMeshes[0].settings.advanced.mesh_engine).toBe('snappy_hexdominant');
  await expect(engineSelect(page)).toHaveValue('snappy_hexdominant');

  // Incompressible Flow: Standard, as before.
  const iff = await study(page, 'incompressible_steady');
  const ifMeshes = await newMesh(page, request, p, iff, 0);
  expect(ifMeshes[0].settings.advanced.mesh_engine).toBe('standard');
  await expect(engineSelect(page)).toHaveValue('standard');

  // After a reload: each as saved.
  await page.reload();
  await p.ready();
  await openMesh(page, ht, htMeshes[0].id);
  await expect(engineSelect(page)).toHaveValue('snappy_hexdominant', { timeout: 30_000 });

  // An existing mesh keeps its mesher: Heat Transfer's Mesh 1 set to Standard stays so when Mesh 2 is made.
  const form = page.locator('#panel-mesh-form .cfd-island');
  if (!(await form.locator('details.mesh-advanced').evaluate((el) => el.open))) await form.locator('details.mesh-advanced > summary').click();
  await engineSelect(page).selectOption('standard');
  const htQ = () => json(request, p.q('/api/mesh', { simulation_id: ht }));
  await expect.poll(async () => ((await htQ()).meshes || [])[0]?.settings?.advanced?.mesh_engine).toBe('standard');
  const firstId = htMeshes[0].id;
  htMeshes = await newMesh(page, request, p, ht, 1);
  expect(htMeshes.find((m) => m.id === firstId).settings.advanced.mesh_engine).toBe('standard');
  expect(htMeshes.find((m) => m.id !== firstId).settings.advanced.mesh_engine).toBe('snappy_hexdominant');
  // The panel shows the new mesh's own.
  await expect(engineSelect(page)).toHaveValue('snappy_hexdominant');

  // A copy keeps its source's: Incompressible Flow's Standard mesh copied into the Heat Transfer study.
  const made = await request.post('/api/mesh', {
    data: { project_id: p.pid, simulation_id: ht, create: true, name: 'Copied', copy_from: ifMeshes[0].id },
  });
  expect(made.ok()).toBe(true);
  const copied = ((await htQ()).meshes || []).find((m) => m.name === 'Copied');
  expect(copied.settings.advanced.mesh_engine).toBe('standard');

  // Restore defaults on Mesh 1 (set to Standard above): the study's mesher, Hex-dominant.
  await openMesh(page, ht, firstId);
  await expect(engineSelect(page)).toHaveValue('standard', { timeout: 30_000 });
  await form.getByRole('button', { name: 'Restore defaults' }).click();
  await expect
    .poll(async () => ((await htQ()).meshes || []).find((m) => m.id === firstId)?.settings?.advanced?.mesh_engine)
    .toBe('snappy_hexdominant');
  await expect(engineSelect(page)).toHaveValue('snappy_hexdominant');
});
