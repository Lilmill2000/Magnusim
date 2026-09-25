import { expect, test } from '@playwright/test';

// Findings §8 "already works": new project creation through the Home dialog (not the bridge).
test('New project dialog creates a project and opens its workbench', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/#/');
  await expect(page.locator('#home-new-project')).toBeVisible({ timeout: 60_000 });
  // The button is static markup; wait until the runtime has wired the dialog behind it.
  await page.waitForFunction(() => typeof window.__CFD_OPEN_NEW_PROJECT_MODAL__ === 'function', null, { timeout: 60_000 });
  await page.locator('#home-new-project').click();
  const modal = page.locator('#modal-new-project');
  await expect(modal).toBeVisible({ timeout: 15_000 });
  const title = `e2e home dialog ${Date.now()}`;
  await page.locator('#np-title').fill(title);
  await page.locator('#np-create').click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/#\/p\//);
  const pid = decodeURIComponent(page.url().split('#/p/')[1] || '').split(/[/?]/)[0];
  const project = await (await request.get(`/api/project?project_id=${encodeURIComponent(pid)}`)).json();
  expect(project.title || project.project?.title).toBe(title);
  // An empty project offers geometry import and nothing that needs geometry yet.
  await expect(page.locator('#btn-import-geometry')).toBeVisible();
  await expect(page.locator('#btn-create-simulation')).toBeHidden();
});
