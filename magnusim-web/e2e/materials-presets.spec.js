import { expect, test } from '@playwright/test';
import { MATERIALS_PROJECT } from './prepare-projects.js';

// The Materials panel's Fluid list and values come from Incompressible Flow's
// material model (its registry presets), as the user sees them. No WSL:
// - the Fluid picker lists every fluid, then Custom fluid;
// - a project saved by an older version (Air without a library code, its own
//   1.529e-5 / 1.196) opens as Air with those numbers, and opening it saves nothing;
// - a new study's Air is air at 20 C (1.516e-5 m2/s, 1.204 kg/m3) and saves so;
// - choosing Argon saves Argon's values, under every record key.
const PROJECT = MATERIALS_PROJECT;
const FLUIDS = ['Air', 'Argon', 'Carbon dioxide', 'Hydrogen', 'Nitrogen', 'Water', 'Seawater (3.5% saline)', 'Custom fluid'];

test.describe.configure({ mode: 'serial' });

async function getJson(request, url) {
  const r = await request.get(url);
  expect(r.ok(), `${url} -> ${r.status()}`).toBeTruthy();
  return r.json();
}

async function materials(request, simId) {
  const q = new URLSearchParams({ project_id: PROJECT, ...(simId ? { simulation_id: simId } : {}) });
  return (await getJson(request, `/api/materials?${q}`)).materials || [];
}

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('an older Air opens as Air with its saved numbers, and the picker lists every fluid', async ({ page, request }) => {
  test.setTimeout(120_000);
  const before = (await materials(request, 'sim_1')).find((m) => m.name === 'Air');
  expect(before, 'the seeded study has its Air').toBeTruthy();
  expect([before.kinematic_viscosity, before.density, before.library, before.preset]).toEqual([1.529e-5, 1.196, undefined, undefined]);

  await openProject(page);
  const air = page.locator('#left-tree [data-w18-air="1"] > .tree-row').first();
  if (!(await air.isVisible().catch(() => false))) {
    await page.locator('#left-tree [data-w18-materials="1"] > .tree-row').first().click();
  }
  await air.click();
  const panel = page.locator('#panel-air-material .cfd-island');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('.mat-panel-title')).toHaveText('Air');
  const fluid = panel.getByLabel('Fluid');
  await expect(fluid).toHaveValue('air');
  await expect(fluid.locator('option')).toHaveText(FLUIDS);
  await expect(panel.getByLabel('Kinematic viscosity')).toHaveValue('1.5290e-5');
  await expect(panel.getByLabel('Density')).toHaveValue('1.196');
  await expect(panel).toContainText('(ν) Kinematic viscosity');
  await expect(panel).toContainText('Newtonian');

  // Opening it rewrote nothing: the record is as the older version saved it.
  await page.waitForTimeout(1_000);
  const after = (await materials(request, 'sim_1')).find((m) => m.id === before.id);
  expect(after).toEqual(before);
});

test("a new study's Air is air at 20 C, and choosing Argon saves Argon's values", async ({ page, request }) => {
  test.setTimeout(150_000);
  await openProject(page);
  const first = await page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId);
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  await page.waitForFunction((old) => {
    const id = window.__CFD_W17__ && window.__CFD_W17__.activeId;
    return !!id && id !== old;
  }, first, { timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(await materials(request, sid)).toEqual([]);

  // The new study's fluid, before anything is saved: the default preset, Air.
  await page.locator('#left-tree #btn-materials-plus').first().click();
  const panel = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByLabel('Fluid')).toHaveValue('air');
  await expect(panel.getByLabel('Kinematic viscosity')).toHaveValue('1.5160e-5');
  await expect(panel.getByLabel('Density')).toHaveValue('1.204');

  // Assigning the body saves it with those numbers.
  await panel.locator('[data-volume="Body1"] button').first().click();
  const saved = async () => (await materials(request, sid))[0] || {};
  await expect.poll(async () => (await saved()).assigned_volumes, { timeout: 15_000 }).toEqual(['Body1']);
  expect(await saved()).toMatchObject({
    name: 'Air',
    preset: 'air',
    library: 'AIR',
    material_model: 'newtonian_incompressible',
    kinematic_viscosity: 1.516e-5,
    nu: 1.516e-5,
    density: 1.204,
    rho: 1.204,
  });

  // Argon: its values, under every record key; the panel shows them.
  await panel.getByLabel('Fluid').selectOption('argon');
  await expect.poll(async () => (await saved()).preset, { timeout: 15_000 }).toBe('argon');
  expect(await saved()).toMatchObject({
    name: 'Argon',
    library: 'ARGON',
    kinematic_viscosity: 1.34e-5,
    nu: 1.34e-5,
    density: 1.661,
    rho: 1.661,
    assigned_volumes: ['Body1'],
  });
  await expect(panel.getByLabel('Kinematic viscosity')).toHaveValue('1.3400e-5');
  await expect(panel.getByLabel('Density')).toHaveValue('1.661');
  await expect(panel.locator('.mat-panel-title')).toHaveText('Argon');

  // After a reload the study still opens as Argon.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
  // Open the new study's fluid from its own tree folder (the older study has one too).
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  const row = study.locator('[data-w18-air="1"] > .tree-row').first();
  if (!(await row.isVisible().catch(() => false))) {
    await study.locator('[data-w18-materials="1"] > .tree-row').first().click();
  }
  await expect(row).toContainText('Argon');
  await row.click();
  const again = page.locator('#panel-air-material .cfd-island');
  await expect(again.getByLabel('Fluid')).toHaveValue('argon', { timeout: 15_000 });
  await expect(again.getByLabel('Density')).toHaveValue('1.661');

  // The older study's Air is still its own.
  const old = (await materials(request, first)).find((m) => m.name === 'Air');
  expect([old.kinematic_viscosity, old.density]).toEqual([1.529e-5, 1.196]);
});
