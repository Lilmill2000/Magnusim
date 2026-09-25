import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const PROJECT_A = 'sample-project-steady-state-e2e';
const PROJECT_B = 'sample-project-empty-e2e';

test('opening project B hides project A', async ({ page, request }) => {
  test.setTimeout(90_000);
  const treeA = await request.get(`/api/project/tree?project_id=${PROJECT_A}`);
  expect(treeA.ok()).toBeTruthy();
  expect(JSON.stringify(await treeA.json())).toContain('Mesh 1');

  const treeB = await request.get(`/api/project/tree?project_id=${PROJECT_B}`);
  expect(treeB.ok()).toBeTruthy();
  const treeBText = JSON.stringify(await treeB.json());
  expect(treeBText).toContain('Empty study');
  expect(treeBText).not.toContain('Mesh 1');

  const foreign = await request.get(
    `/api/case?project_id=${PROJECT_B}&simulation_id=sim-empty&case_dir=${encodeURIComponent(resolve('e2e/.tmp-projects', PROJECT_A))}`,
  );
  expect(foreign.status()).toBe(403);

  await page.goto(`/#/p/${encodeURIComponent(PROJECT_A)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });

  const meshRow = page.locator('#left-tree [data-w20-mesh-item="mesh_1"]');
  if (!(await meshRow.isVisible().catch(() => false))) {
    const twist = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
    if (await twist.count()) await twist.click();
  }
  await meshRow.click();
  await expect(page.locator('#panel-mesh-form, #mesh-inspect')).toBeVisible({ timeout: 15_000 });

  await page.evaluate((id) => window.__CFD_HOME__.open(id, { reloadIfNeeded: false }), PROJECT_B);
  await expect(page.locator('#left-tree')).toContainText('Empty study', { timeout: 30_000 });
  await expect(page.locator('#left-tree')).not.toContainText('Mesh 1');
  await expect(page.locator('[data-w20-mesh-item="mesh_1"]')).toHaveCount(0);
  await expect(page.locator('#panel-mesh-form')).toBeHidden();
  await expect(page.locator('#mesh-inspect')).toBeHidden();

  const caseB = await request.get(`/api/case?project_id=${PROJECT_B}&simulation_id=sim-empty`);
  expect(caseB.ok()).toBeTruthy();
  const caseBody = await caseB.json();
  const caseDir = String(caseBody.case_dir || caseBody.live_mesh_result?.case_dir || '');
  expect(caseDir).not.toContain(PROJECT_A);
});
