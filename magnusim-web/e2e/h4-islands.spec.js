import { expect, test } from '@playwright/test';

const PROJECT = 'sample-project-steady-state-e2e';

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('gate:h4-replace-panel shows a replacement and a thrown panel stays in bounds', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  await page.evaluate(() => window.__CFD_REPLACE_PANEL__('panel-sim-control', 'ok'));
  await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
  await page.locator('#btn-create-run').click();
  await expect(page.locator('[data-plugin-panel="probe"]')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => window.__CFD_REPLACE_PANEL__('panel-sim-control', 'throw'));
  await expect(page.locator('[data-panel-boundary="1"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#wb-home')).toBeVisible();
  await page.locator('#wb-home').click();
  await expect(page.locator('#home')).toBeVisible({ timeout: 15_000 });
});

test('gate:h4-place-filters renders a plugin section and drops an unscoped tree node', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  await page.evaluate(() => window.__CFD_REGISTER_FILTER__('Probe filter'));
  await expect(page.locator('[data-filter-plugin="1"]')).toHaveText('Probe filter');
  await page.evaluate((projectId) => {
    window.__CFD_TREE_TRANSFORM__((nodes) => [
      ...nodes,
      { label: 'Scoped extra', scope: `p:${projectId}/s:sim_1` },
      { label: 'Orphan extra' },
    ]);
  }, PROJECT);
  await expect(page.locator('[data-plugin-node="Scoped extra"]')).toBeAttached();
  await expect(page.locator('[data-plugin-node="Orphan extra"]')).toHaveCount(0);
});
