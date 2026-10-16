// Heat Transfer (HT5): conjugate heat transfer, as a user sets it up and reads it.
// - A study on a part of two bodies: Air on Body1, then Aluminium 6061 (a solid) on Body2.
//   The study panel says which solver runs and why, shows the solid's heat source (set in
//   its material: 10 W, saved in W on the record), hides the residual target its solver
//   never reads, and says a Standard mesh reads wall heat high (not once the mesh is
//   Hex-dominant); the BC picker offers a Solid wall (its temperature in °C, saved in K).
//   Body2 given back to the air makes it buoyant flow again and back: nothing is lost.
//   All after a reload.
// - An imperial project: the heat source in BTU/h and the Solid wall in °F, saved in W and K.
// - A study copied from one with a 10 W heat source: the copy's solid has it (its own
//   record), and the case written from the copy's saved records has it in fvOptions.
// - A custom gravity direction (1, 0, 0) is saved, shows after a reload, and the written
//   case's constant/g points along +X.
// - A finished CHT run (a committed case: tests/test_ht5_cht_wsl.py's two-box case): the
//   Run panel lists the energy balance, the solid's temperatures and a thermocouple in each
//   body (the Graphs panel draws them); the results show T on a cut plane across both
//   bodies (°C metric, °F imperial); after a reload.
// - With WSL (gate:ht-ui): a channel with an aluminium block set up through the panels
//   (Body2 aluminium, gravity, a 10 W source, an inlet at 20 °C), meshed Hex-dominant,
//   solved; T on a cut plane across both bodies and the thermocouple's series, after a reload.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL, PYTHON, expect, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK = join(HERE, 'fixtures', 'channel-block.step');
const TWO = join(HERE, '..', '..', '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const CASE = join(HERE, 'fixtures', 'cht-case');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const stamp = () => Date.now().toString(36);
const WEB = resolve(HERE, '..', '..', '..');
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve(WEB, 'e2e', '.tmp-projects');

/**
 * The case a study's saved records write (tests/ht_case_from_project.py: on the committed
 * two-region mesh, no mesher or WSL): { ok, error, files: { 'constant/g': text, ... } }.
 */
function caseFromProject(pid, sid) {
  const projectDir = join(PROJECTS, pid);
  expect(existsSync(join(projectDir, 'project.json'))).toBe(true);
  const out = mkdtempSync(join(tmpdir(), 'ht5-case-'));
  try {
    const env = {
      ...process.env,
      // The plugins' own roots (heat_transfer imports incompressible_flow's flow BCs).
      PYTHONPATH: [
        join(WEB, 'python'),
        join(WEB, 'python', 'sdk'),
        join(WEB, 'bundled-plugins', 'heat_transfer'),
        join(WEB, 'bundled-plugins', 'incompressible_flow'),
      ].join(delimiter),
    };
    const r = spawnSync(
      PYTHON,
      [join(HERE, '..', 'tests', 'ht_case_from_project.py'), '--project-dir', projectDir, '--simulation-id', sid, '--out', join(out, 'case')],
      { cwd: join(WEB, 'bundled-plugins', 'heat_transfer'), env, encoding: 'utf8', timeout: 300_000, windowsHide: true },
    );
    const line = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
    if (!line.startsWith('{')) throw new Error(`ht_case_from_project: ${r.stderr || r.stdout}`);
    return JSON.parse(line);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

async function json(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** A new project with `part`, and a Heat Transfer study on it: its ids and helpers. */
async function heatStudy(page, request, { units = 'Metric', part = BLOCK } = {}) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async ([t, u]) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: u, folder: 'My Projects' })).project.id,
    [`HT5 ${units} ${stamp()}`, units],
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(part);
  await expect.poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 }).toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="heat_transfer_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  await expect
    .poll(async () => page.evaluate(() => (window.__CFD_GEOMETRY_BODIES__ ? window.__CFD_GEOMETRY_BODIES__() : [])), { timeout: 60_000 })
    .toEqual(['Body1', 'Body2']);
  const study = async () => (await json(request, q('/api/simulation', { simulation_id: sid }))).simulation || {};
  const mats = async () => (await json(request, q('/api/materials', { simulation_id: sid }))).materials || [];
  const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  const faces = async () => {
    const gid = (await json(request, q('/api/project'))).project.geometries[0].id;
    return (await json(request, q('/api/geometry/cad', { geometry_id: gid, part: 'preview' }))).faces || [];
  };
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  return { pid, sid, q, ready, study, mats, bcs, faces, studyRow };
}

/** The face of `body` whose centroid has `axis` = `value` (mm) and outward normal sign `sign` along it. */
function faceAt(list, axis, value, sign, body) {
  const i = { x: 0, y: 1, z: 2 }[axis];
  const hit = list.find(
    (f) => Math.abs(f.centroid[i] - value) < 0.5 && Math.sign(f.normal[i]) === sign && Number(f.body) === body && !f.shared_with,
  );
  if (!hit) throw new Error(`no face of Body${body} at ${axis} = ${value}`);
  return `face ${hit.id}@Body${body}`;
}

/** Add a BC of family `kind` from the "+" picker, on `face`; its id and editor. */
async function addBc(page, s, kind, face) {
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
  await picker.locator(`[data-bc-key="${kind}"]`).click();
  await picker.locator('[data-bc-add="1"]').click();
  await expect(editor.locator('[data-bc-title="1"]')).toBeVisible({ timeout: 15_000 });
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await expect.poll(async () => (await s.bcs()).some((b) => b.id === id), { timeout: 15_000 }).toBe(true);
  // The whole label: a number alone would be read as a face of Body1.
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(f), face);
  await expect.poll(async () => ((await s.bcs()).find((b) => b.id === id) || {}).faces || []).toEqual([face]);
  return { id, editor };
}

const picker = (page) => page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();

/** Air on Body1 and Aluminium 6061 on Body2, through the Materials "+": the records. */
async function airAndAluminium(page, s) {
  await s.studyRow.locator('[data-w18-mat-plus]').click();
  await expect(picker(page)).toBeVisible({ timeout: 15_000 });
  await picker(page).locator('[data-volume="Body1"] button').first().click();
  await expect.poll(async () => (await s.mats()).length).toBe(1);
  await s.studyRow.locator('[data-w18-mat-plus]').click();
  await picker(page).getByLabel('Material type').selectOption('thermo_solid');
  await expect(picker(page).getByLabel('Solid')).toHaveValue('aluminium_6061');
  await picker(page).locator('[data-volume="Body2"] button').first().click();
  await expect
    .poll(async () => (await s.mats()).map((m) => `${m.name}:${m.material_model}:${(m.assigned_volumes || []).join()}`).sort())
    .toEqual(['Air:thermo_fluid:Body1', 'Aluminium 6061:thermo_solid:Body2']);
  const all = await s.mats();
  return { air: all.find((m) => m.material_model === 'thermo_fluid'), al: all.find((m) => m.material_model === 'thermo_solid') };
}

/** Open one material record from the tree (its Materials folder expanded first). */
async function openMaterial(page, s, id) {
  const folder = s.studyRow.locator('li[data-w18-materials="1"]').first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree li[data-w18-material-id="${id}"] > .tree-row .tl`).first().click();
  await expect(picker(page)).toBeVisible({ timeout: 15_000 });
}

async function openStudy(page, s) {
  const panel = page.locator('#panel-study-settings .cfd-island');
  if (!(await panel.isVisible())) await s.studyRow.locator(':scope > .tree-row').first().click();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Close the study panel and open it again (it reads the mesh and the materials when it opens). */
async function reopenStudy(page, s) {
  const panel = page.locator('#panel-study-settings .cfd-island');
  if (await panel.isVisible()) await s.studyRow.locator(':scope > .tree-row').first().click();
  await expect(panel).toBeHidden({ timeout: 15_000 });
  return openStudy(page, s);
}

/** The open material's heat source (the Materials panel of a solid): type `value` in its unit. */
async function setHeatSource(page, value) {
  const field = picker(page).locator('[data-material-property="heat_source_W"] input');
  await field.fill(value);
  await field.press('Tab');
}

const sourceShown = (panel, id) => panel.locator(`[data-ht-heat-source="${id}"] [data-ht-heat-source-value]`);
const STANDARD_NOTE =
  /On a Standard mesh \(tetrahedra\) the heat through walls is less accurate: up to about \d+ % high next to a laminar flow and about \d+ % low with wall functions/;

const CHT_LINE = 'Conjugate heat transfer with chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). Body1 is Air (fluid).';

test('a solid body makes the study conjugate heat transfer: the panel says why, a 10 W heat source, a Solid wall in °C; back and forth loses nothing; after a reload', async ({ page, request }) => {
  test.setTimeout(400_000);
  const s = await heatStudy(page, request);
  let panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(/^Solves buoyant flow of one fluid with buoyantSimpleFoam/);
  // No mesh yet: a new one starts on Hex-dominant, so no Standard note.
  await expect(panel.locator('[data-ht-solver="1"]')).toBeVisible();
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveCount(0);
  const { air, al } = await airAndAluminium(page, s);
  // A 10 W heat source in the block, in its material (W in a metric project), saved on the record.
  await expect(picker(page).locator('[data-material-property="heat_source_W"] .bc-unit-label')).toHaveText('W');
  await setHeatSource(page, '10');
  await expect.poll(async () => (await s.mats()).find((m) => m.id === al.id).heat_source_W).toBe(10);

  panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(panel.locator('[data-ht-cht-stop="1"]')).toContainText('does not stop on its residuals');
  await expect(panel.locator('[data-schema-key="residual_target"]')).toHaveCount(0);
  await expect(panel.locator(`[data-ht-heat-source="${al.id}"]`)).toContainText('Heat source: Aluminium 6061 (Body2)');
  await expect(sourceShown(panel, al.id)).toHaveText('10 W');
  await expect(panel.locator('[data-ht-heat-source-hint="1"]')).toContainText("A solid's heat source is set in its material");
  // No mesh yet (a new one starts on Hex-dominant): no note.
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveCount(0);
  // Gravity along -Y (the channel's floor is y = 0).
  await panel.locator('[data-schema-key="gravity"] select').selectOption({ label: '−Y (down along Y)' });
  await expect.poll(async () => (await s.study()).gravity).toBe('-y');

  // A new mesh starts on Hex-dominant (no note); set to Standard, the note says what its
  // walls' heat reads; back on Hex-dominant, no note.
  const meshesNow = async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  await s.studyRow.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await meshesNow())[0]?.settings?.advanced?.mesh_engine).toBe('snappy_hexdominant');
  await form.locator('details.mesh-advanced > summary').click();
  await expect(form.locator('select[data-mesh-engine="1"]')).toHaveValue('snappy_hexdominant');
  await form.locator('select[data-mesh-engine="1"]').selectOption('standard');
  await expect.poll(async () => (await meshesNow())[0]?.settings?.advanced?.mesh_engine).toBe('standard');
  panel = await reopenStudy(page, s);
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveText(STANDARD_NOTE, { timeout: 30_000 });
  const meshFolder = s.studyRow.locator('li[data-w20-mesh="1"]').first();
  if (!(await meshFolder.evaluate((el) => el.classList.contains('expanded')))) await meshFolder.locator(':scope > .tree-row .tw').click();
  await s.studyRow.locator(`[data-w20-mesh-item="${(await meshesNow())[0].id}"] > .tree-row .tl`).first().click();
  if (!(await form.locator('details.mesh-advanced').evaluate((el) => el.open))) await form.locator('details.mesh-advanced > summary').click();
  await form.locator('select[data-mesh-engine="1"]').selectOption('snappy_hexdominant');
  await expect.poll(async () => (await meshesNow())[0]?.settings?.advanced?.mesh_engine).toBe('snappy_hexdominant');
  panel = await reopenStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(sourceShown(panel, al.id)).toHaveText('10 W');
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveCount(0);

  // The BC picker offers a Solid wall: the block's bottom face at 40 °C, saved in K.
  const list = await s.faces();
  const bottom = await addBc(page, s, 'solid_wall', faceAt(list, 'y', 0, -1, 2));
  await bottom.editor.getByLabel('Thermal', { exact: true }).selectOption({ label: 'Fixed temperature' });
  const wallT = bottom.editor.getByLabel('Wall temperature', { exact: true });
  await expect(bottom.editor.getByLabel('Wall temperature unit')).toHaveValue('°C');
  await wallT.fill('40');
  await wallT.press('Enter');
  const saved = async () => (await s.bcs()).find((b) => b.id === bottom.id) || {};
  await expect.poll(async () => Number((await saved()).wall_temperature).toFixed(2)).toBe('313.15');
  expect((await saved()).bc_type).toBe('Solid wall');

  // Body2 back to the air: buoyant flow again, the source row gone, the solid's record keeps it.
  await openMaterial(page, s, air.id);
  await picker(page).locator('[data-volume="Body2"] button').first().click();
  await expect.poll(async () => (await s.mats()).find((m) => m.material_model === 'thermo_fluid').assigned_volumes).toEqual(['Body1', 'Body2']);
  panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(/^Solves buoyant flow of one fluid with buoyantSimpleFoam/, { timeout: 30_000 });
  await expect(panel.locator('[data-ht-heat-sources="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-schema-key="residual_target"]')).toHaveCount(1);
  expect((await s.mats()).find((m) => m.id === al.id).heat_source_W).toBe(10);
  // ... and back to the aluminium: the source as it was.
  await openMaterial(page, s, al.id);
  await picker(page).locator('[data-volume="Body2"] button').first().click();
  await expect.poll(async () => (await s.mats()).find((m) => m.id === al.id).assigned_volumes).toEqual(['Body2']);
  panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(sourceShown(panel, al.id)).toHaveText('10 W');

  // After a reload: every value as saved.
  await page.reload();
  await s.ready();
  panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(sourceShown(panel, al.id)).toHaveText('10 W');
  await expect(panel.locator('[data-ht-standard-mesh="1"]')).toHaveCount(0);
  await openMaterial(page, s, al.id);
  await expect(picker(page).locator('[data-material-property="heat_source_W"] input')).toHaveValue('10');
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] [data-w19-bcs="1"] > .tree-row .tl`).first().click();
  await page.locator(`#panel-bcs-hub .cfd-island [data-open-bc="${bottom.id}"]`).click();
  const after = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(after.getByLabel('Thermal', { exact: true }).locator('option:checked')).toHaveText('Fixed temperature');
  await expect(after.getByLabel('Wall temperature', { exact: true })).toHaveValue('40');
});

test('an imperial project: the heat source in BTU/h and a Solid wall in °F, saved in W and K', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request, { units: 'Imperial' });
  const { al } = await airAndAluminium(page, s);
  await expect(picker(page).locator('[data-material-property="heat_source_W"] .bc-unit-label')).toHaveText('BTU/h');
  await setHeatSource(page, '34.1214');
  await expect.poll(async () => Number((await s.mats()).find((m) => m.id === al.id).heat_source_W).toFixed(3)).toBe('10.000');
  const panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(sourceShown(panel, al.id)).toHaveText('34.12 BTU/h');
  const bottom = await addBc(page, s, 'solid_wall', faceAt(await s.faces(), 'y', 0, -1, 2));
  await bottom.editor.getByLabel('Thermal', { exact: true }).selectOption({ label: 'Fixed temperature' });
  await expect(bottom.editor.getByLabel('Wall temperature unit')).toHaveValue('°F');
  await expect(bottom.editor.getByLabel('Wall temperature', { exact: true })).toHaveValue('68');
  const wallT = bottom.editor.getByLabel('Wall temperature', { exact: true });
  await wallT.fill('104');
  await wallT.press('Enter');
  await expect.poll(async () => Number(((await s.bcs()).find((b) => b.id === bottom.id) || {}).wall_temperature).toFixed(2)).toBe('313.15');
  await page.reload();
  await s.ready();
  await expect(sourceShown(await openStudy(page, s), al.id)).toHaveText('34.12 BTU/h', { timeout: 30_000 });
  await openMaterial(page, s, al.id);
  await expect(picker(page).locator('[data-material-property="heat_source_W"] input')).toHaveValue('34.1214');
});

test("a copy of a study with a 10 W heat source: the copy's solid has it, and the copy's case writes it", async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const { al } = await airAndAluminium(page, s);
  await setHeatSource(page, '10');
  await expect.poll(async () => (await s.mats()).find((m) => m.id === al.id).heat_source_W).toBe(10);
  // Create simulation, starting from this one (its settings).
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-type-list [data-analysis-key="heat_transfer_steady"]').click();
  await page.locator('#cs-copy-from').selectOption(s.sid);
  await page.locator('#cs-copy-mode [data-copy-mode="settings"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const copySid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(copySid).toBeTruthy();
  expect(copySid).not.toBe(s.sid);
  const copyMats = async () => (await json(request, s.q('/api/materials', { simulation_id: copySid }))).materials || [];
  await expect.poll(async () => (await copyMats()).filter((m) => m.material_model === 'thermo_solid').length, { timeout: 30_000 }).toBe(1);
  const solid = (await copyMats()).find((m) => m.material_model === 'thermo_solid');
  expect(solid.id).not.toBe(al.id);
  expect(solid.heat_source_W).toBe(10);
  // The copy's panels show it.
  const copy = { ...s, sid: copySid, studyRow: page.locator(`#left-tree [data-w17-sim-id="${copySid}"]`) };
  const panel = await openStudy(page, copy);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await expect(sourceShown(panel, solid.id)).toHaveText('10 W');
  await openMaterial(page, copy, solid.id);
  await expect(picker(page).locator('[data-material-property="heat_source_W"] input')).toHaveValue('10');
  // The case written from the copy's saved records: 10 W in the solid.
  const written = caseFromProject(s.pid, copySid);
  expect(written.ok, written.error).toBe(true);
  expect(written.files['system/aluminium_6061/fvOptions']).toMatch(/h\s+\(10 0\);/);
  expect(written.files['system/controlDict']).toMatch(/application\s+chtMultiRegionSimpleFoam;/);
});

test('a custom gravity direction (1, 0, 0) is saved, shows after a reload, and the written case pulls along +X', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  await airAndAluminium(page, s);
  let panel = await openStudy(page, s);
  await panel.locator('[data-schema-key="gravity"] select').selectOption({ label: 'Custom direction' });
  await expect.poll(async () => (await s.study()).gravity).toBe('custom');
  const axis = (p, a) => p.getByLabel(`Gravity direction ${a}`, { exact: true });
  await expect(axis(panel, 'Z')).toHaveValue('-1');
  await axis(panel, 'X').fill('1');
  await axis(panel, 'Z').fill('0');
  await axis(panel, 'Z').press('Tab');
  await expect.poll(async () => (await s.study()).gravity_vector, { timeout: 15_000 }).toEqual([1, 0, 0]);
  await page.reload();
  await s.ready();
  panel = await openStudy(page, s);
  await expect(panel.locator('[data-schema-key="gravity"] select option:checked')).toHaveText('Custom direction');
  await expect(axis(panel, 'X')).toHaveValue('1');
  await expect(axis(panel, 'Y')).toHaveValue('0');
  await expect(axis(panel, 'Z')).toHaveValue('0');
  const written = caseFromProject(s.pid, s.sid);
  expect(written.ok, written.error).toBe(true);
  expect(written.files['constant/g']).toMatch(/value\s+\(9\.80665 0 0\);/);
});

/** A run whose case is the committed finished CHT case (its run record done, its monitors). */
async function finishedRun(request, s, title) {
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: title } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  const rows = (await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || [];
  const runDir = dirname(rows.find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CASE, caseDir, { recursive: true });
  const side = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  const controls = side.ht_monitors.map((p) =>
    p.type === 'ht_thermocouple'
      ? { id: p.id, name: p.name, monitor_type: p.type, points: p.points }
      : { id: p.id, name: p.name, monitor_type: p.type, boundaries: ['bc-out'] },
  );
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status: 'done',
        stage: 'done',
        has_results: true,
        n_saved_times: 1,
        last_saved_iteration: 800,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
        analysis_key: 'heat_transfer_steady',
        result_controls: controls,
      },
      null,
      2,
    ),
  );
  return rid;
}

async function openRun(page, sid, rid) {
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) await runsFolder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
}

async function openResults(page, rid) {
  const li = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  if (!(await li.evaluate((el) => el.classList.contains('expanded')))) await li.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
  await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 90_000 });
}

async function openGraphs(page, rid) {
  // Graphs sits under the run's Results node.
  const results = page.locator(`#left-tree li[data-w27-run-results="${rid}"]`).first();
  if (!(await results.evaluate((el) => el.classList.contains('expanded')))) await results.locator(':scope > .tree-row .tw').click();
  await page.locator(`[data-w28-key="media:run:${rid}:graphs"] .tl`).first().click();
}

/** A cut plane through both bodies: its regions and the legend's range (shown unit). */
async function cutAcross(page, axis = '') {
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await expect(page.locator('#cp-coloring')).toBeVisible();
  // A plane across the part's middle normal to `axis` (else the plane the page starts with).
  if (axis) await page.locator(`.orient[data-axis="${axis}"]`).first().click();
  await expect
    .poll(async () => ((await page.evaluate(() => window.__CFD_RESULT_REGIONS__())).planes || [])[0] || [], { timeout: 90_000 })
    .toEqual(['air', 'aluminium_6061']);
  const ticks = (await page.locator('#legend .legend-ticks span').allTextContents()).map(Number);
  return { unit: (await page.locator('#legend .legend-units').textContent()).trim(), lo: Math.min(...ticks), hi: Math.max(...ticks) };
}

async function checkFinished(page, s, rid, { imperial }) {
  await openRun(page, s.sid, rid);
  const monitors = page.locator('#panel-sim-control .cfd-island [data-run-monitors="1"]');
  const deg = imperial ? '°F' : '°C';
  // The thermocouple in the block reads the block's temperature (43.7 °C, 111 °F); the one in the air the air's.
  await expect(monitors).toContainText(`TC · point 2 · Temperature ${imperial ? '111' : '43.7'} ${deg}`, { timeout: 60_000 });
  await expect(monitors).toContainText(`TC · point 1 · Temperature ${imperial ? '68.0' : '20.0'} ${deg}`);
  // The solid's own row (every solid gets one), and the energy balance (a 0.05 W source).
  await expect(monitors).toContainText(`Body2 (Aluminium 6061) · Average temperature ${imperial ? '111' : '43.7'} ${deg}`);
  await expect(monitors).toContainText('Energy balance · Heat in 0.050 W · Heat out 0.050 W');
  await openResults(page, rid);
  const cut = await cutAcross(page);
  expect(cut.unit).toBe(deg);
  // T across both bodies: the inlet air at 20 °C up to the block's 43.7 °C.
  expect(cut.lo).toBeLessThanOrEqual(imperial ? 69 : 21);
  expect(cut.hi).toBeGreaterThanOrEqual(imperial ? 108 : 42);
  // Velocity only in the air: the block grey, and the legend says so.
  await page.locator('#cp-coloring').selectOption('magU');
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 60_000 });
  await expect(page.locator('#legend-note')).toHaveText('No U in solids (shown grey)');
  await page.locator('#cp-coloring').selectOption('T');
  await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 60_000 });
  await expect(page.locator('#legend-note')).toBeHidden();
}

test('a finished CHT run: the solid\'s temperatures, a thermocouple in each body, T on a cut plane across both, after a reload', async ({ page, request }) => {
  test.setTimeout(400_000);
  const s = await heatStudy(page, request, { part: TWO });
  const rid = await finishedRun(request, s, 'Finished CHT');
  await page.reload();
  await s.ready();
  await checkFinished(page, s, rid, { imperial: false });
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  expect(answer.summary.map((i) => i.label)).toEqual(['Heat in', 'out', 'imbalance']);
  expect(answer.summary_warn).toBe(false);
  // The Graphs panel draws the thermocouple's series, one card per point.
  await openGraphs(page, rid);
  const cards = page.locator('#run-graphs-custom-cards .mon-card-name');
  await expect(cards).toContainText(['TC · point 1', 'TC · point 2'], { timeout: 60_000 });
  await page.reload();
  await s.ready();
  await checkFinished(page, s, rid, { imperial: false });
});

test('a finished CHT run in an imperial project: °F on the cut plane and in the monitors', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request, { part: TWO, units: 'Imperial' });
  const rid = await finishedRun(request, s, 'Finished CHT');
  await page.reload();
  await s.ready();
  await checkFinished(page, s, rid, { imperial: true });
});

test('WSL (gate:ht-ui): a channel with an aluminium block set up through the panels, meshed Hex-dominant and solved; T across both bodies and a thermocouple series, after a reload', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(2_400_000);
  page.setDefaultTimeout(60_000);
  const s = await heatStudy(page, request);
  const { al } = await airAndAluminium(page, s);
  let panel = await openStudy(page, s);
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(CHT_LINE, { timeout: 30_000 });
  await panel.locator('[data-schema-key="gravity"] select').selectOption({ label: '−Y (down along Y)' });
  await expect.poll(async () => (await s.study()).gravity).toBe('-y');
  await panel.locator('[data-schema-key="turbulence_model"] select').selectOption({ label: 'Laminar' });
  await expect.poll(async () => (await s.study()).turbulence_model).toBe('laminar');
  await openMaterial(page, s, al.id);
  await setHeatSource(page, '10');
  await expect.poll(async () => (await s.mats()).find((m) => m.id === al.id).heat_source_W).toBe(10);

  // An inlet at 1 m/s and 20 °C (its Thermal as the editor shows it) and a pressure outlet.
  const list = await s.faces();
  const inlet = await addBc(page, s, 'velocity_inlet', faceAt(list, 'x', 0, -1, 1));
  const inT = inlet.editor.locator('[data-bc-field-group="ht_inlet_thermal"]').getByLabel('Inlet temperature', { exact: true });
  await expect(inT).toHaveValue('20');
  await page.evaluate((id) => window.__CFD_BC_UPDATE__(id, { value: 1, unit: 'm/s' }), inlet.id);
  await expect.poll(async () => Number(((await s.bcs()).find((b) => b.id === inlet.id) || {}).value)).toBe(1);
  await addBc(page, s, 'pressure_outlet', faceAt(list, 'x', 100, 1, 1));

  // Hex-dominant, fineness 3.
  const meshesNow = async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  await s.studyRow.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await form.locator('details.mesh-advanced > summary').click();
  await form.locator('select[data-mesh-engine="1"]').selectOption('snappy_hexdominant');
  await expect.poll(async () => (await meshesNow())[0]?.settings?.advanced?.mesh_engine).toBe('snappy_hexdominant');
  await form.locator('[data-schema-key="fineness"] input').fill('3');
  await form.locator('[data-schema-key="fineness"] input').press('Enter');
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 900_000, intervals: [5_000] })
    .toBe('done ');
  const regions = ((await meshesNow())[0].live_mesh_result.regions || []).map((r) => [r.name, r.role]);
  expect(regions).toEqual([['air', 'fluid'], ['aluminium_6061', 'solid']]);

  // A run of 300 iterations with a thermocouple in the block's middle, started from its panel.
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: 'Block' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  await request.post('/api/run/update', {
    data: {
      project_id: s.pid,
      simulation_id: s.sid,
      run_id: rid,
      endTime: 300,
      writeInterval: 300,
      result_controls: [{ id: 'mon-tc', name: 'Block TC', monitor_type: 'ht_thermocouple', points: [[0.05, 0.005, 0.015]] }],
    },
  });
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  const start = page.locator('#panel-sim-control .cfd-island [data-run-control="1"] [data-run-start]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const runRow = async () => ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((r) => String(r.id) === rid) || {};
  await expect
    .poll(async () => {
      const r = await runRow();
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 1_500_000, intervals: [10_000] })
    .toBe('done ');
  const caseDir = (await runRow()).case_dir;
  expect(readFileSync(join(caseDir, 'system', 'controlDict'), 'utf8')).toMatch(/application\s+chtMultiRegionSimpleFoam;/);
  expect(readFileSync(join(caseDir, 'system', 'aluminium_6061', 'fvOptions'), 'utf8')).toMatch(/h\s+\(10 0\);/);
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  const tc = answer.custom.find((r) => r.name === 'Block TC');
  expect(tc.region).toBe('aluminium_6061');
  expect(tc.series.length).toBe(300);
  expect(tc.last.T_K).toBeGreaterThan(300);
  console.log(`[ht5 wsl] channel block: thermocouple in the block ${(tc.last.T_K - 273.15).toFixed(2)} °C after 300 iterations, ${answer.summary.map((i) => `${i.label} ${Number(i.value).toFixed(4)}`).join(', ')}`);

  const check = async () => {
    // The run's panel may still be open from Start (clicking its row again would close it).
    if (!(await page.locator('#panel-sim-control .cfd-island [data-run-control="1"]').isVisible())) await openRun(page, s.sid, rid);
    await expect(page.locator('#panel-sim-control .cfd-island [data-run-monitors="1"]')).toContainText('Block TC · Temperature', { timeout: 60_000 });
    await openGraphs(page, rid);
    await expect(page.locator('#run-graphs-custom-cards .mon-card-name')).toContainText(['Block TC'], { timeout: 60_000 });
    await openResults(page, rid);
    // Normal to X through the middle: across the air and the block (x 40 to 60 mm).
    const cut = await cutAcross(page, 'X');
    expect(cut.unit).toBe('°C');
    expect(cut.lo).toBeLessThanOrEqual(21);
    expect(cut.hi).toBeGreaterThan(30);
  };
  await check();
  await page.reload();
  await s.ready();
  await check();
});
