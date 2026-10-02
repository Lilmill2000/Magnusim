import { expect, test } from '@playwright/test';

const PROJECT = 'sample-project-steady-state-e2e';

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
}

test('gate:h4-replace-panel shows a replacement and a thrown panel stays in bounds', async ({ page }) => {
  test.setTimeout(120_000);
  // The boundary logs each panel it catches: '[panel] <panel id> <error> <stack>'.
  let caught = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().startsWith('[panel] panel-sim-control')) caught += 1;
  });
  await openProject(page);
  await page.evaluate(() => window.__CFD_REPLACE_PANEL__('panel-sim-control', 'ok'));
  await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
  await page.locator('#btn-create-run').click();
  await expect(page.locator('[data-plugin-panel="probe"]')).toBeVisible({ timeout: 15_000 });

  await page.evaluate(() => window.__CFD_REPLACE_PANEL__('panel-sim-control', 'throw'));
  const card = page.locator('#panel-sim-control [data-panel-boundary="1"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute('role', 'alert');
  await expect(card.locator('.mgk-error-title')).toHaveText('This panel stopped working.');
  await expect(card.locator('.mgk-error-msg')).toHaveText('panel failed');
  await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect.poll(() => caught).toBeGreaterThan(0);

  // Try again mounts the panel again; the probe throws again, so the card comes back.
  const before = caught;
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => caught, { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(card).toBeVisible();
  await expect(card.locator('.mgk-error-msg')).toHaveText('panel failed');

  // Done closes the panel; the workbench is still there.
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#panel-sim-control')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#wb-home')).toBeVisible();

  // After a reload the replacement is gone: the real Run panel opens, with no card.
  await page.reload();
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
  await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
  await page.locator('#btn-create-run').click();
  await expect(page.locator('#panel-sim-control .cfd-island [data-run-control="1"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel-boundary]')).toHaveCount(0);

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
