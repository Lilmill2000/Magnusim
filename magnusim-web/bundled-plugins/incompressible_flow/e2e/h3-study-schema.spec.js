import { expect, test } from '@playwright/test';

// Incompressible Flow's study settings come from its registry schema (the turbulence
// list, the residual targets) and save to the study they belong to. Moved from the
// core's e2e/h3-islands.spec.js, which keeps the islands the core owns.
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
