// Magnusim CAD as a person meets it: Home and Settings with nothing of the simulation app,
// New project making a Part that opens in CAD with its kernel running, a block drawn and
// kept, and the project page's Parts (New part, Rename, Delete). No Python, no WSL
// (e2e-cad/server.mjs), and Magnusim's workbench is never loaded.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from './pw';
import { drawBlock, historyNames, partOpened, watchPage } from '../bundled-plugins/cad/e2e/helpers';

async function loadedModules(page: Page): Promise<string[]> {
  return page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
}

test('Home and Settings are the CAD app\'s', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Magnusim CAD - Projects');
  await expect(page.locator('#home')).toBeVisible();
  // Nothing to set up first: Settings does not open by itself.
  await page.waitForTimeout(500);
  await expect(page.locator('#setup-wizard')).toBeHidden();
  await page.locator('#home-prefs').click();
  await expect(page.locator('#setup-wizard')).toBeVisible();
  await expect(page.locator('#wiz-rail li:visible')).toHaveText(['Units', 'Keybinds', 'Assistant', 'Plugins']);
  // Keybinds: the app's own keys under the app's name, and the Part's commands (cad-keybinds-settings.spec.ts changes one).
  await page.locator('#wiz-rail li[data-wiz-key="keybinds"]').click();
  const keybinds = page.locator('#setup-wizard .wiz-pane[data-wiz-key="keybinds"]');
  await expect(keybinds.locator('[data-keys-plugin="app"] .wiz-keys-scope-title')).toHaveText('Magnusim CAD');
  await expect(keybinds.locator('[data-keys-plugin="app"] [data-keybind="app.assistant"] kbd').first()).toHaveText('Ctrl+/');
  await expect(keybinds.locator('[data-keys-plugin="cad"] [data-keys-workspace="part"] [data-keybind="sketch.rectangle"]')).toBeVisible();
  await expect(keybinds.getByText('No plugin that is on lists its keys here yet.')).toHaveCount(0);
  await page.locator('#wiz-rail li[data-wiz-key="plugins"]').click();
  await expect(page.locator('#setup-wizard')).toContainText('Magnusim CAD');
  await page.locator('#wiz-close').click();
  await expect(page.locator('#setup-wizard')).toBeHidden();
  const modules = await loadedModules(page);
  // Neither the workbench nor its simulation panels. (src/plugin-api still brings the viewer's
  // modules for plugin UIs; nothing of it is drawn.)
  expect(modules.filter((m) => /\/workbench\/runtime\.js|\/panels\/(mesh|bcs|materials|run|simulation|geometry)\//.test(m))).toEqual([]);
});

test('New project makes a Part that opens in CAD, and the project page keeps its Parts', async ({ page }) => {
  const seen = await watchPage(page);
  await page.goto('/');
  await page.locator('#home-new-project').click();
  const dialog = page.locator('#modal-new-project');
  await expect(dialog).toBeVisible();
  // Start from is not asked: its one choice (a Part) is already made; no Import geometry, no Category.
  await expect(dialog.locator('#np-start')).toBeHidden();
  await expect(dialog.locator('input[name="np-start-choice"]')).toHaveCount(1);
  await expect(dialog.locator('input[name="np-start-choice"]')).toBeChecked();
  await expect(dialog.locator('#np-category')).toBeHidden();
  await dialog.locator('#np-title').fill('Bracket set');
  await dialog.locator('#np-create').click();

  // The Part opens in CAD's workspace; the kernel runs in the page.
  const frame = await partOpened(page);
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Part 1/);
  await expect(page.locator('#btn-queue')).toBeHidden();
  await drawBlock(page, frame, 40, 20, 10);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1']);

  // Back to the project: its page lists the Part.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  const project = page.locator('#cad-project');
  await expect(project.locator('.cad-project-title')).toHaveText('Bracket set');
  await expect(project.locator('.cad-part-title')).toHaveText(['Part 1']);

  // It opens again with the block kept.
  await project.locator('.cad-part-open', { hasText: 'Part 1' }).click();
  const again = await partOpened(page);
  await expect(historyNames(again)).toHaveText(['Sketch 1', 'Extrude 1']);
  await page.locator('#workspace-overlay [data-ws-back]').click();

  // New part makes Part 2 and opens it; back, it is renamed, then deleted.
  await project.locator('#cad-new-part').click();
  await partOpened(page);
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Part 2/);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(project.locator('.cad-part-title')).toHaveText(['Part 1', 'Part 2']);
  await project.locator('.cad-part', { hasText: 'Part 2' }).getByRole('button', { name: 'Rename Part 2' }).click();
  const prompt = page.locator('#modal-prompt');
  await expect(prompt).toBeVisible();
  await prompt.locator('#pm-input').fill('Lid');
  await prompt.locator('#pm-confirm').click();
  await expect(project.locator('.cad-part-title')).toHaveText(['Part 1', 'Lid']);
  await project.locator('.cad-part', { hasText: 'Lid' }).getByRole('button', { name: 'Delete Lid' }).click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await page.locator('#cf-confirm').click();
  await expect(project.locator('.cad-part-title')).toHaveText(['Part 1']);

  // Home lists the project.
  await project.locator('#cad-home').click();
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#home')).toContainText('Bracket set');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  expect((await loadedModules(page)).filter((m) => /workbench\/runtime\.js/.test(m))).toEqual([]);
});

test('a project link (or a reload) opens its page, and a Part link opens the Part', async ({ page, request }) => {
  const made = await request.post('/api/project', { data: { title: 'Linked', category: 'Other', units: 'Metric' } });
  const pid = String((await made.json()).id);
  const st = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Hinge' } });
  const sid = String((await st.json()).study.id);
  await page.goto(`/#/p/${pid}`);
  await expect(page.locator('#cad-project .cad-project-title')).toHaveText('Linked');
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Hinge']);
  await page.reload();
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Hinge']);
  await page.goto(`/#/p/${pid}/ws/cad/part/${sid}`);
  await page.reload();
  await partOpened(page);
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toHaveText(/Magnusim CAD\s*›\s*Hinge/);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Hinge']);
});
