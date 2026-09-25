import { expect, test } from '@playwright/test';

const PROJECT = 'sample-project-steady-state-e2e';

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Elbow', { timeout: 30_000 });
}

async function openMeshForm(page) {
  const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
  if (await meshRow.count()) {
    if (!(await meshRow.isVisible().catch(() => false))) {
      const twist = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
      if (await twist.count()) await twist.click();
    }
    if (await meshRow.isVisible().catch(() => false)) await meshRow.click();
    else await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().click();
  } else {
    await page.locator('#left-tree').getByText(/Mesh\s*1/i).first().click();
  }
  const settingsBtn = page.locator('#mesh-inspect-settings');
  try {
    await settingsBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await settingsBtn.click();
  } catch {
    /* form may already be open */
  }
  const form = page.locator('#panel-mesh-form .cfd-island');
  await form.locator('details.mesh-advanced > summary').click({ timeout: 30_000 });
  await expect(form.locator('[data-mesh-engine="1"]')).toBeVisible();
}

/** Settings opens the Setup wizard card; the Plugins step is the last rail entry. */
async function openSettingsPlugins(page, button = '#wb-prefs') {
  await expect(page.locator(button)).toHaveText('Settings');
  await page.locator(button).click();
  const wizard = page.locator('#setup-wizard');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('#wiz-rail li')).toHaveText(['Welcome', 'Units', 'This PC', 'Port', 'Workspace', 'Plugins']);
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const step = wizard.locator('.wiz-pane[data-wiz-step="5"]');
  await expect(step).toBeVisible();
  await expect(wizard.locator('#wiz-next')).toHaveText('Finish');
  return step;
}

async function enableDemo(request, key) {
  await request.post(`/api/plugins/${key}/enable`);
}

test('gate:h5-demos-visible laminar, extra mesher, and one React copy', async ({ page }) => {
  test.setTimeout(90_000);
  await openProject(page);
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true);
  await expect.poll(() => page.evaluate(() => window.__CFD_SINGLE_REACT__)).toBe(true);

  await page.locator('#btn-create-simulation').click();
  const picker = page.locator('#cs-type-list .cfd-island');
  await expect(picker.locator('[data-analysis-key="laminar_steady"]')).toBeVisible({ timeout: 15_000 });
  await expect(picker.locator('[data-analysis-key="laminar_steady"]')).toContainText('Laminar');
  await page.locator('#cs-cancel').click();

  await openMeshForm(page);
  await expect(page.locator('[data-mesh-engine="1"] option', { hasText: 'Extra mesher' })).toHaveCount(1);

  const step = await openSettingsPlugins(page);
  await expect(step.locator('[data-plugin-key]')).toHaveCount(3, { timeout: 15_000 });
  const hook = step.locator('[data-plugin-key="example-hook-monitor"] [data-plugin-hook="1"]');
  await expect(hook).toBeVisible({ timeout: 15_000 });
  await expect(hook).toHaveText('What does this hook do?');
  await hook.click();
  await expect(hook).toHaveText('Hide hook details');
  await expect(step.locator('[data-plugin-hook-detail="1"]')).toContainText('case.written');
  await page.locator('#wiz-skip').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
});

test('gate:h5-disable-removes demo rows after reload', async ({ page, request }) => {
  test.setTimeout(90_000);
  try {
    await openProject(page);
    const step = await openSettingsPlugins(page);
    const laminar = step.locator('[data-plugin-key="example-laminar"]');
    const mesher = step.locator('[data-plugin-key="example-extra-mesher"]');
    await expect(laminar).toBeVisible({ timeout: 15_000 });
    await laminar.locator('[data-plugin-toggle="example-laminar"]').click();
    await expect(laminar).toHaveAttribute('data-plugin-status', 'disabled');
    await mesher.locator('[data-plugin-toggle="example-extra-mesher"]').click();
    await expect(mesher).toHaveAttribute('data-plugin-status', 'disabled');
    await page.locator('#wiz-next').click();
    await expect(page.locator('#setup-wizard')).toBeHidden();

    await page.locator('#btn-create-simulation').click();
    const picker = page.locator('#cs-type-list .cfd-island');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(picker.locator('[data-analysis-key="laminar_steady"]')).toHaveCount(0);
    await expect(picker.locator('[data-analysis-key="incompressible_steady"]')).toBeVisible();
    await page.locator('#cs-cancel').click();

    await openMeshForm(page);
    await expect(page.locator('[data-mesh-engine="1"] option', { hasText: 'Extra mesher' })).toHaveCount(0);
    await expect(page.locator('[data-mesh-engine="1"] option', { hasText: 'Standard' })).toHaveCount(1);
  } finally {
    await enableDemo(request, 'example-laminar');
    await enableDemo(request, 'example-extra-mesher');
  }
});

test('gate:h5-broken-plugin surfaces a thrown UI and the workbench stays up', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__CFD_LOAD_PLUGIN_UI__ === 'function');
  await page.evaluate(async () => {
    const url = URL.createObjectURL(
      new Blob(['export function register() { throw new Error("ui failed"); }'], { type: 'text/javascript' }),
    );
    await window.__CFD_LOAD_PLUGIN_UI__({
      key: 'broken-ui',
      name: 'Broken UI',
      version: '0.0.0',
      ui: 'ui',
      ui_entry: 'index.js',
      status: 'enabled',
      enabled: true,
      source: 'local',
      url,
    }).catch(() => undefined);
  });
  await expect(page.locator('[data-plugin-toast]')).toContainText('ui failed');
  const step = await openSettingsPlugins(page, '#home-prefs');
  await expect(step.locator('[data-plugin-key="broken-ui"]')).toContainText('ui failed');
  await expect(page.locator('#home')).toBeVisible();
});
