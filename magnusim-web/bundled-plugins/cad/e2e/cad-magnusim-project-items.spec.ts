// Magnusim still shows every project and simulation item of the Part (Daniel 2026-10-29: Magnusim
// CAD, the desktop edition whose welcome says projectLinks false, hides them all; in Magnusim,
// whose welcome has no projectLinks, everything stays exactly as it is):
//   cad:magnusim-project-items  the toolbar's CFD PREP group with Enclosure and its "air around the
//                     part" tooltip; the Banana's tooltip names the simulation; a body's menu has
//                     "Leave Body 1 out of the simulation"; a new Enclosure's panel has its fields and
//                     the air volume hint; the Assistant's tools as the Part registers them have
//                     send_to_simulation, the enclosure kind and their fields.
// Magnusim CAD hides them: unit tests (tests/features/enclosure/edition.test.tsx,
// tests/assistant/edition-no-projects.test.ts, parity-no-projects.test.ts) and that app's own suite
// (magnusim-web/e2e-cad), which runs the real CAD-edition host.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } };
type W = { __CAD__: { services: { bridge: { projectLinks(): boolean } }; assistant: { registered: Tool[] } | null } };

async function freshPart(page: Page, request: APIRequestContext) {
  await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return frame;
}

test('cad:magnusim-project-items in Magnusim the Part keeps CFD PREP and Enclosure, the simulation words, the body\'s simulation item and the Assistant\'s send and enclosure', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.bridge.projectLinks())).toBe(true);

  // CFD PREP with Enclosure, and its tooltip's air.
  const toolbar = frame.locator('[data-cad-toolbar]');
  await expect(toolbar.locator('[data-group="cfd"] .tb-group-label')).toHaveText('CFD PREP');
  const enclosure = toolbar.locator('[data-command="cfd.enclosure"]');
  await expect(enclosure).toBeVisible();
  await enclosure.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('for the air around the part: then Combine, Cut');
  // The Banana's tooltip names the simulation.
  await toolbar.locator('[data-command="scale.banana"]').hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText("It's not part of the model or the simulation");

  // A body's menu: its simulation item.
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await frame.locator('[data-cad-tree] [data-body-row] > .tree-row').first().click({ button: 'right' });
  await expect(frame.locator('[data-cad-menu] [data-menu-item="body-simulation"]')).toHaveText('Leave Body 1 out of the simulation');
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-menu]')).toHaveCount(0);

  // A new Enclosure: its fields and the air volume hint, not the read-only panel.
  await runCommand(frame, 'cfd.enclosure');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-feature-panel="enclosure"]')).toBeVisible();
  await expect(p.locator('[data-field="padding"] select')).toBeVisible();
  await expect(p).toContainText('The air volume is a separate Combine: Cut, with Keep the tool bodies on.');
  await expect(p.locator('[data-enclosure-kept]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);

  // The Assistant's tools as the Part registered them: send_to_simulation, the enclosure kind and its fields.
  const tools = await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.assistant?.registered ?? []);
  expect(tools).toHaveLength(22);
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  expect(tool('workspace').inputSchema.properties.action.enum).toContain('send_to_simulation');
  expect(tool('workspace').description).toContain('send_to_simulation (save and link, as Back does)');
  expect(tool('direct').inputSchema.properties.kind.enum).toContain('enclosure');
  expect(Object.keys(tool('direct').inputSchema.properties)).toEqual(expect.arrayContaining(['shape', 'padding', 'sides']));
  expect(Object.keys(tool('body').inputSchema.properties)).toContain('simulation');
});
