import { expect, test } from '@playwright/test';

const PROJECT_A = 'sample-project-steady-state-e2e';

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT_A)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('gate:h3-picker-open plugin analysis is listed', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  await page.locator('#btn-create-simulation').click();
  const island = page.locator('#cs-type-list .cfd-island');
  await expect(island).toBeVisible({ timeout: 15_000 });
  await expect(island.locator('[data-analysis-key="incompressible_steady"]')).toBeVisible();
  await expect(island.locator('[data-analysis-key="laminar_steady"]')).toBeVisible();
});

test('gate:h3-materials-island Air is the preset', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  const air = page.locator('#left-tree [data-w18-air="1"] > .tree-row').first();
  if (!(await air.isVisible().catch(() => false))) {
    await page.locator('#left-tree [data-w18-materials="1"] > .tree-row').first().click();
  }
  if (await air.count()) await air.click();
  else await page.locator('#left-tree [data-w18-materials="1"] > .tree-row').first().click();
  const island = page.locator('#panel-air-material .cfd-island, #panel-materials-hub .cfd-island').first();
  await expect(island).toBeVisible({ timeout: 15_000 });
  await expect(island.locator('.mat-panel-title')).toHaveText('Air');
  // Air is the default; the material model's other fluids and a custom fluid are offered.
  await expect(island.getByLabel('Fluid')).toHaveValue('air');
  await expect(island.getByLabel('Fluid').locator('option')).toHaveText([
    'Air',
    'Argon',
    'Carbon dioxide',
    'Hydrogen',
    'Nitrogen',
    'Water',
    'Seawater (3.5% saline)',
    'Custom fluid',
  ]);
  await expect(island.getByLabel('Kinematic viscosity')).toHaveValue(/^\d\.\d{4}e-\d+$/);
});

test('gate:h3-mesh-island engine list includes cfmesh', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
  if (!(await meshRow.isVisible().catch(() => false))) {
    await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first().click();
  }
  if (await meshRow.isVisible().catch(() => false)) await meshRow.click();
  else await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().click();
  const settings = page.locator('#mesh-inspect-settings');
  if (await settings.isVisible().catch(() => false)) await settings.click();
  const island = page.locator('#panel-mesh-form .cfd-island');
  await expect(island).toBeVisible({ timeout: 15_000 });
  await island.locator('details.mesh-advanced > summary').click();
  const engine = island.locator('details.mesh-advanced [data-mesh-engine="1"]');
  await expect(engine).toBeVisible();
  await expect(engine.locator('option[value="cfmesh"]')).toHaveCount(1);
  await expect(island.locator('[data-schema-key="fineness"]')).toBeVisible();
});

test('gate:h3-facepicker persisted faces match the picked ids', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  // The fixture inlet owns face 1; pick it by name (tree order follows the BC folders).
  const bc = page.locator('#left-tree [data-w19-bc]').filter({ hasText: 'velocity_inlet_1' }).first();
  if (!(await bc.isVisible().catch(() => false))) {
    await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row').first().click();
  }
  await expect(bc).toBeVisible({ timeout: 15_000 });
  const posted = [];
  await page.route('**/api/worker', async (route) => {
    const body = route.request().postDataJSON();
    if (body && body.method === 'bcs.set') {
      posted.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          simulation_id: 'sim_1',
          boundary_conditions: (body.params && body.params.body && body.params.body.boundary_conditions) || [],
        }),
      });
      return;
    }
    await route.continue();
  });
  await bc.locator('> .tree-row .tl').click();
  const island = page.locator('#panel-bc-editor .cfd-island');
  await expect(island).toBeVisible({ timeout: 15_000 });
  await expect(island.locator('[data-face-picker="1"]')).toBeVisible();
  const face = page.locator('#left-tree [data-w19-face="face 1@Body1"] > .tree-row .tl');
  if (!(await face.isVisible().catch(() => false))) {
    await bc.locator('> .tree-row .tw').click();
  }
  await expect(face).toBeVisible();
  const beforePosts = posted.length;
  await face.click();
  await expect.poll(() => posted.length, { timeout: 5_000 }).toBeGreaterThan(beforePosts);
  const saved = posted.at(-1);
  const list = saved.params.body.boundary_conditions || [];
  const rec = list.find((item) => item.name === 'velocity_inlet_1') || list[0];
  const shown = await island.locator('[data-face-id]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-face-id')).filter(Boolean),
  );
  expect((rec && rec.faces) || []).toEqual(shown);
  expect(JSON.stringify((rec && rec.faces) || [])).not.toBe(JSON.stringify(['face 1@Body1']));
  expect(saved.params.body.simulation_id).toBe('sim_1');
});
