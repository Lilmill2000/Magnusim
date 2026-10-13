import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';
import { NO_WSL } from './toolchain.js';

// Host API 1.8, the pieces the Heat Transfer plugin builds on, through a test plugin
// (python/tests/fixtures/heat-plugins/example-heat) on its own server:
// - an analysis that offers a fluid and a solid material model: a study holds one
//   material per group of bodies, each a row in the tree; a body belongs to one
//   material at a time (assigning it takes it from the other);
// - Thermal fields the analysis adds to another plugin's walls (bc_fields), in the
//   project's temperature unit (°C metric, °F imperial), saved in K;
// - Generate refuses a study whose materials make separate regions, with the reason.
// Incompressible Flow's own panels are unchanged (their specs and h10 parity say so).
const HERE = dirname(fileURLToPath(import.meta.url));
const PART = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'ht1-materials', pluginsFrom: 'python/tests/fixtures/heat-plugins' });
});

test.afterAll(() => {
  if (host) host.stop();
});

const json = async (request, url) => (await request.get(`${host.base}${url}`)).json();

/** A new project with the two-box part and a study of the heat example; its ids. */
async function heatStudy(page, request, units) {
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (u) =>
      (await window.__CFD_W16_CREATE__({ title: `HT1 ${u} ${Date.now().toString(36)}`, description: '', category: 'Other', units: u, folder: 'My Projects' }))
        .project.id,
    units,
  );
  await page.goto(`${host.base}/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(PART);
  await expect
    .poll(async () => ((await json(request, `/api/project?project_id=${pid}`)).project?.geometries || []).length, { timeout: 120_000 })
    .toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="example_heat_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  await expect
    .poll(async () => page.evaluate(() => (window.__CFD_GEOMETRY_BODIES__ ? window.__CFD_GEOMETRY_BODIES__() : [])), { timeout: 60_000 })
    .toEqual(['Body1', 'Body2']);
  return { pid, sid };
}

test('a study holds a fluid and a solid; a body belongs to one; the tree lists both after a reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { pid, sid } = await heatStudy(page, request, 'Metric');
  const mats = async () => (await json(request, `/api/materials?project_id=${pid}&simulation_id=${sid}`)).materials || [];
  const bodiesOf = async () => Object.fromEntries((await mats()).map((m) => [m.name, m.assigned_volumes || []]));
  const picker = page.locator('#panel-material-picker .cfd-island');
  const record = page.locator('#panel-air-material .cfd-island');
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);

  // "+" opens a new material; its first change makes it. A solid, with Body2.
  await study.locator('[data-w18-mat-plus]').click();
  await expect(picker.getByLabel('Material type')).toHaveValue('example_heat_fluid');
  await picker.getByLabel('Material type').selectOption('example_heat_solid');
  await expect.poll(async () => (await mats()).map((m) => [m.name, m.material_model])).toEqual([['Aluminium 6061', 'example_heat_solid']]);
  await expect(picker.locator('[data-material-property="k"] .bc-unit-label')).toHaveText('W/(m·K)');
  await picker.locator('[data-volume="Body2"] button').click();
  await expect.poll(bodiesOf).toEqual({ 'Aluminium 6061': ['Body2'] });

  // "+" again: a fluid. It takes Body1, then Body2 from the solid.
  await study.locator('[data-w18-mat-plus]').click();
  await expect(picker.locator('[data-volume="Body2"] .mat-assign-state')).toHaveText('In Aluminium 6061');
  await picker.locator('[data-volume="Body1"] button').click();
  await expect.poll(bodiesOf).toEqual({ 'Aluminium 6061': ['Body2'], Air: ['Body1'] });
  await picker.locator('[data-volume="Body2"] button').click();
  await expect.poll(bodiesOf).toEqual({ 'Aluminium 6061': [], Air: ['Body1', 'Body2'] });

  // The tree: a row per material, each with its bodies.
  const rows = study.locator('[data-w18-material-id]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(study.locator('[data-w18-material-id] [data-w18-assign]')).toHaveCount(2);

  // The solid's row opens it; Body2 goes back to it.
  const solidId = (await mats()).find((m) => m.material_model === 'example_heat_solid').id;
  await study.locator(`[data-w18-material-id="${solidId}"] > .tree-row .tl`).click();
  await expect(record.getByLabel('Material type')).toHaveValue('example_heat_solid');
  await expect(record.getByLabel('Solid')).toHaveValue('aluminium');
  await record.locator('[data-volume="Body2"] button').click();
  await expect.poll(bodiesOf).toEqual({ 'Aluminium 6061': ['Body2'], Air: ['Body1'] });

  // After a reload: both rows, and the solid opens as it was saved.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await expect(study.locator('[data-w18-material-id]')).toHaveCount(2, { timeout: 30_000 });
  await study.locator(`[data-w18-material-id="${solidId}"] > .tree-row .tl`).click();
  await expect(record.getByLabel('Material type')).toHaveValue('example_heat_solid');
  await expect(record.locator('[data-volume="Body2"]')).toHaveAttribute('data-assigned', '1');

  // Delete takes only that material.
  await record.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await mats()).map((m) => m.name)).toEqual(['Air']);
  await expect(study.locator('[data-w18-material-id]')).toHaveCount(1, { timeout: 30_000 });
});

/** Add a Wall BC from the "+" picker; the editor. */
async function addWall(page) {
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
  await picker.locator('[data-bc-key="wall"]').click();
  await picker.locator('[data-bc-add="1"]').click();
  await expect(editor.locator('[data-bc-title="1"]')).toHaveText(/^Wall \d+$/, { timeout: 15_000 });
  return editor;
}

for (const [units, unit, shown, typed, kelvin] of [
  ['Metric', '°C', '20', '80', 353.15],
  ['Imperial', '°F', '68', '176', 353.15],
]) {
  test(`a wall's Thermal fields come from the study's analysis, in ${unit}, saved in K (${units})`, async ({ page, request }) => {
    test.setTimeout(300_000);
    const { pid, sid } = await heatStudy(page, request, units);
    const editor = await addWall(page);
    const id = await editor.getAttribute('data-bc-id');
    const saved = async () =>
      ((await json(request, `/api/bcs?project_id=${pid}&simulation_id=${sid}`)).boundary_conditions || []).find((b) => b.id === id) || {};
    const group = editor.locator('[data-bc-field-group="wall_thermal"]');
    await expect(group).toContainText('Heat through the wall.');
    await group.getByLabel('Thermal', { exact: true }).selectOption('Fixed temperature');
    await expect(group.getByLabel('Wall temperature unit')).toHaveValue(unit);
    await expect(group.getByLabel('Wall temperature', { exact: true })).toHaveValue(shown);
    await group.getByLabel('Wall temperature', { exact: true }).fill(typed);
    await group.getByLabel('Wall temperature', { exact: true }).press('Enter');
    await expect.poll(async () => Number((await saved()).wall_temperature).toFixed(2)).toBe(kelvin.toFixed(2));
    expect((await saved()).thermal_wall).toBe('Fixed temperature');
    // The picker shows K too; the value stays in K.
    await group.getByLabel('Wall temperature unit').selectOption('K');
    await expect(group.getByLabel('Wall temperature', { exact: true })).toHaveValue('353.15');

    await page.reload();
    await page.waitForFunction((p) => window.__CFD_PROJECT_READY__ === p, pid, { timeout: 60_000 });
    await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-bcs="1"] > .tree-row .tl`).first().click();
    await page.locator(`#panel-bcs-hub .cfd-island [data-open-bc="${id}"]`).click();
    const after = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"] [data-bc-field-group="wall_thermal"]');
    // A schema form's choice is an <option> by index: read its text.
    await expect(after.getByLabel('Thermal', { exact: true }).locator('option:checked')).toHaveText('Fixed temperature');
    await expect(after.getByLabel('Wall temperature', { exact: true })).toHaveValue(typed);
  });
}

test("two materials mesh as two regions (HT2): each region's cells shown; the mesh goes out of date when a body changes material", async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(600_000);
  const { pid, sid } = await heatStudy(page, request, 'Metric');
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  const picker = page.locator('#panel-material-picker .cfd-island');
  const mats = async () => (await json(request, `/api/materials?project_id=${pid}&simulation_id=${sid}`)).materials || [];
  await study.locator('[data-w18-mat-plus]').click();
  await picker.locator('[data-volume="Body1"] button').click();
  await expect.poll(async () => (await mats()).length).toBe(1);
  await study.locator('[data-w18-mat-plus]').click();
  await picker.getByLabel('Material type').selectOption('example_heat_solid');
  await picker.locator('[data-volume="Body2"] button').click();
  await expect.poll(async () => (await mats()).map((m) => (m.assigned_volumes || []).join()).sort()).toEqual(['Body1', 'Body2']);

  const meshesNow = async () => (await json(request, `/api/mesh?project_id=${pid}&simulation_id=${sid}`)).meshes || [];
  await study.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 480_000, intervals: [3_000] })
    .toBe('done ');
  const regions = ((await meshesNow())[0].live_mesh_result || {}).regions || [];
  expect(regions.map((r) => [r.name, r.role, r.bodies])).toEqual([
    ['air', 'fluid', ['Body1']],
    ['aluminium_6061', 'solid', ['Body2']],
  ]);
  expect(Math.min(...regions.map((r) => r.cells))).toBeGreaterThan(0);
  const meta = page.locator('#panel-mesh-form .mesh-finished-meta');
  await expect(meta).toContainText(`air: ${regions[0].cells.toLocaleString('en-US')} cells`, { timeout: 30_000 });
  await expect(meta).toContainText(`aluminium_6061: ${regions[1].cells.toLocaleString('en-US')} cells`);
  const stale = page.locator('#panel-mesh-form [data-mesh-out-of-date-line="1"]');
  await expect(stale).toHaveCount(0);

  // Body2 moves to Air: the mesh's regions are not the materials' any more.
  const fluidId = (await mats()).find((m) => m.material_model === 'example_heat_fluid').id;
  await study.locator(`[data-w18-material-id="${fluidId}"] > .tree-row .tl`).click();
  const record = page.locator('#panel-air-material .cfd-island');
  await record.locator('[data-volume="Body2"] button').click();
  await expect.poll(async () => (await mats()).find((m) => m.id === fluidId).assigned_volumes).toEqual(['Body1', 'Body2']);
  await page.reload();
  await page.waitForFunction((p) => window.__CFD_PROJECT_READY__ === p, pid, { timeout: 60_000 });
  const meshRow = study.locator('[data-w20-mesh-item]').first();
  await meshRow.locator(':scope > .tree-row .tl').click();
  await expect(stale).toContainText("made before this simulation's materials changed", { timeout: 30_000 });
});
