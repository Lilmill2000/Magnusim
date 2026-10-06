import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Incompressible Flow's study settings come from its registry schema (the turbulence
// list, the residual targets) and save to the study they belong to. Moved from the
// core's e2e/h3-islands.spec.js, which keeps the islands the core owns.
const PROJECT_A = 'sample-project-steady-state-e2e';
const PROJECT_B = 'sample-project-empty-e2e';
const PROJECTS_ROOT = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');

/** A study folder's id.json on disk (the record the catalog is walked from). */
function studyIdJson(projectId, sid) {
  const geoms = join(PROJECTS_ROOT, projectId, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const p = join(sims, s, 'id.json');
      if (existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).id === sid) return p;
    }
  }
  throw new Error(`no id.json for study ${sid}`);
}

const readIdJson = (projectId, sid) => JSON.parse(readFileSync(studyIdJson(projectId, sid), 'utf8'));

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT_A)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('gate:h3-simulation-island defaults come from the registry schema', async ({ page, request }) => {
  test.setTimeout(90_000);
  // Older versions also kept the turbulence model in the study folder's id.json (as
  // display text). Such a project opens with that model, and its id.json is left
  // with the study's identity only: the setting lives in simulations.json.
  const idPath = studyIdJson(PROJECT_A, 'sim_1');
  writeFileSync(idPath, JSON.stringify({ ...readIdJson(PROJECT_A, 'sim_1'), turbulence_model: 'k-omega SST' }, null, 2));
  const beforeB = JSON.stringify(await (await request.get(`/api/project/tree?project_id=${PROJECT_B}`)).json());
  await openProject(page);
  const study = page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first();
  await study.click();
  const island = page.locator('#panel-study-settings .cfd-island');
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
  await expect(turbulence.locator('option:checked')).toHaveText('k-omega SST');
  const simNow = async () =>
    (await (await request.get(`/api/simulation?project_id=${PROJECT_A}&simulation_id=sim_1`)).json()).simulation;
  expect((await simNow()).turbulence_model).toBe('k-omega SST');
  await expect.poll(() => 'turbulence_model' in readIdJson(PROJECT_A, 'sim_1')).toBe(false);
  await expect(turbulence.locator('option')).toHaveText([
    'Laminar',
    'Spalart-Allmaras (one equation)',
    'k-epsilon',
    'Realizable k-epsilon',
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
  // The change is saved to the study's record, not to its folder's id.json.
  expect('turbulence_model' in readIdJson(PROJECT_A, 'sim_1')).toBe(false);
  await page.reload();
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first().click();
  await expect(turbulence.locator('option:checked')).toHaveText('k-epsilon', { timeout: 15_000 });
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
