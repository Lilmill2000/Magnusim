import { expect, test } from '@playwright/test';

const PROJECT_A = 'sample-project-steady-state-e2e';
const PROJECT_B = 'sample-project-empty-e2e';

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT_A)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('gate:h3-simulation-island defaults come from the registry schema', async ({ page, request }) => {
  test.setTimeout(90_000);
  const beforeB = JSON.stringify(await (await request.get(`/api/project/tree?project_id=${PROJECT_B}`)).json());
  await openProject(page);
  const study = page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first();
  await study.click();
  const island = page.locator('#panel-incompressible-defaults .cfd-island');
  await expect(island).toBeVisible({ timeout: 15_000 });
  await expect(island.locator('[data-schema-key="turbulence_model"]')).toBeVisible();
  await expect(island.locator('[data-schema-key="residual_u"]')).toBeVisible();

  // Physics saves go through the study update route and name this study only.
  const posted = [];
  await page.route('**/api/simulation/update', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.continue();
  });
  const turbulence = island.locator('[data-schema-key="turbulence_model"] select');
  await expect(turbulence.locator('option')).toHaveText([
    'Laminar',
    'k-epsilon',
    'k-omega SST',
    'LRR (Reynolds stress)',
    'SSG (Reynolds stress)',
  ]);
  await turbulence.selectOption({ label: 'k-epsilon' });
  await expect.poll(() => posted.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(posted[0].simulation_id).toBe('sim_1');
  expect(posted[0].project_id).toBe(PROJECT_A);
  expect(posted[0].turbulence_model).toBe('kEpsilon');
  expect(JSON.stringify(posted[0])).not.toContain(PROJECT_B);
  await expect
    .poll(async () => {
      const sim = (await (await request.get(`/api/simulation?project_id=${PROJECT_A}&simulation_id=sim_1`)).json()).simulation;
      return sim && sim.turbulence_model;
    })
    .toBe('kEpsilon');
  await turbulence.selectOption({ label: 'k-omega SST' });
  await expect
    .poll(async () => {
      const sim = (await (await request.get(`/api/simulation?project_id=${PROJECT_A}&simulation_id=sim_1`)).json()).simulation;
      return sim && sim.turbulence_model;
    })
    .toBe('kOmegaSST');
  const afterB = JSON.stringify(await (await request.get(`/api/project/tree?project_id=${PROJECT_B}`)).json());
  expect(afterB).toBe(beforeB);
});

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
  // Air is the only fluid until ROADMAP.md's Water criteria are met; tiny nu reads in sci notation.
  await expect(island.getByText('Water', { exact: true })).toHaveCount(0);
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
