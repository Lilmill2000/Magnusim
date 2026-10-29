// A body's own menu in the tree (Daniel 2026-10-28: "I can hide it or rename it or even color it,
// but I can't remove it"), as the person meets it:
//   cad:body-delete-menu  right-click a body in the tree: "Delete Body 1" is the menu's last item;
//                     its click takes the body out of the tree and the view, "Body-Delete 1" is in
//                     the history, Ctrl+Z brings the body back and Ctrl+Y takes it again;
//   cad:body-delete-two   two bodies selected: the menu says "Delete 2 bodies" and makes one feature
//                     for both (one undo step); the Delete key on a selected body does the same, and
//                     the history's row is "Body-Delete 1" (never "Delete body 1", read as Body 1);
//   cad:body-delete-panel-pick  with Combine open, the bodies it shows picked are the panel's: Delete
//                     deletes nothing and the panel stays open; a picked body's menu deletes only it;
//   cad:body-delete-edit  Edit "Body-Delete 1" from its history row: the panel lists the bodies it
//                     deletes by name, × on one brings it back at once (tree, view, volume chip),
//                     Done keeps that; Suppress brings the rest back, Delete of the row all of them;
//   cad:body-sim-magnusim in Magnusim (the host has projects: no projectLinks false in its welcome)
//                     a solid body still has its simulation toggle, its "still in the simulation"
//                     marks when hidden, and "Leave Body 1 out of the simulation" in its menu;
//   cad:body-sim-cad  Magnusim CAD's welcome (projectLinks false in the context the page's SDK reads,
//                     put in here as that app sends it): the Part shows none of them.
// Setup (blocks) goes in through the document as the other specs do; everything asserted is what
// the person sees (the tree, the view's drawn bodies, the volume chip) or the record their click stored.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, chipVolumes, historyNames, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: APIRequestContext) {
  await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return frame;
}

/** The bodies the view draws now. */
const drawn = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().bodies as number);
const undoLabel = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel as string | null);
/** The Delete body features stored, each with the bodies it deletes. */
const deleteFeatures = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.filter((f: { type: string }) => f.type === 'delete_body').map((f: { name: string; bodies: string[] }) => ({ name: f.name, bodies: f.bodies })));
const bodyRows = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-body-row] .cad-body-name');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });

/** Three blocks (Body 1..3) side by side, and the Bodies folder open. */
async function threeBlocks(page: Page, frame: FrameLocator): Promise<string[]> {
  const ids: string[] = [];
  for (const x of [0, 40, 80]) ids.push((await addSolid(page, { at: [x, 0, 0], size: [20, 20, 20] })).body!);
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(3);
  return ids;
}

test('cad:body-delete-menu right-click a body in the tree, Delete: gone from the tree and the view, Body-Delete 1 in the history, Undo and Redo', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const [b1] = await threeBlocks(page, frame);
  const row = frame.locator(`[data-body-row="${b1}"]`);
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  // The menu's last item, in danger red.
  await expect(menu.locator('[data-menu-item]').last()).toHaveText('Delete Body 1');
  await expect(menu.locator('[data-menu-item="body-delete"]')).toHaveClass(/danger/);
  await menu.locator('[data-menu-item="body-delete"]').click();
  await expect(menu).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(bodyRows(frame)).toHaveText(['Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(2);
  await expect.poll(async () => (await chipVolumes(frame)).map(Math.round)).toEqual([8000, 8000]);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Sketch 3', 'Extrude 3', 'Body-Delete 1']);
  expect(await deleteFeatures(page)).toEqual([{ name: 'Body-Delete 1', bodies: [b1] }]);
  expect(await undoLabel(page)).toBe('Body-Delete 1');
  // Ctrl+Z: the body is back in the tree and the view; Ctrl+Y: gone again.
  await frame.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(3);
  await expect(historyNames(frame)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Sketch 3', 'Extrude 3']);
  await page.keyboard.press('Control+y');
  await expect(bodyRows(frame)).toHaveText(['Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(2);
  await expect(historyNames(frame).last()).toHaveText('Body-Delete 1');
});

test('cad:body-delete-two two bodies selected: Delete 2 bodies makes one feature for both; the Delete key on a selected body does the same', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const [b1, b2, b3] = await threeBlocks(page, frame);
  const rowOf = (id: string) => frame.locator(`[data-body-row="${id}"] > .tree-row`);
  await rowOf(b1).click();
  await rowOf(b2).click({ modifiers: ['Control'] });
  await rowOf(b2).click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-delete"]')).toHaveText('Delete 2 bodies');
  await menu.locator('[data-menu-item="body-delete"]').click();
  await expect(bodyRows(frame)).toHaveText(['Body 3']);
  await expect.poll(() => drawn(page)).toBe(1);
  expect(await deleteFeatures(page)).toEqual([{ name: 'Body-Delete 1', bodies: [b1, b2] }]);
  // One undo step brings both back.
  await frame.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(3);
  expect(await deleteFeatures(page)).toEqual([]);
  // The Delete key on one selected body (a click on its row): one Delete body feature. Its row does
  // not read as Body 1 deleted ("Delete body 1" did, with Body 1 still in the tree).
  await rowOf(b3).click();
  await page.keyboard.press('Delete');
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2']);
  await expect.poll(() => drawn(page)).toBe(2);
  await expect(historyNames(frame).last()).toHaveText('Body-Delete 1');
  expect(await deleteFeatures(page)).toEqual([{ name: 'Body-Delete 1', bodies: [b3] }]);
  // And on two: Body 1 and Body 2 together, a second feature.
  await rowOf(b1).click();
  await rowOf(b2).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await expect(bodyRows(frame)).toHaveCount(0);
  await expect.poll(() => drawn(page)).toBe(0);
  expect(await deleteFeatures(page)).toEqual([
    { name: 'Body-Delete 1', bodies: [b3] },
    { name: 'Body-Delete 2', bodies: [b1, b2] },
  ]);
  expect(await undoLabel(page)).toBe('Body-Delete 2');
});

test("cad:body-delete-panel-pick with Combine open, the bodies it shows picked are the panel's: Delete deletes nothing and the panel stays; a picked body's menu deletes only that body", async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const [b1, b2] = await threeBlocks(page, frame);
  const rowOf = (id: string) => frame.locator(`[data-body-row="${id}"] > .tree-row`);
  await runCommand(frame, 'modify.combine');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  const targets = p.locator('[data-pick-field="targets"] .cad-pick-name');
  // Body 1 as the target (its row in the tree), then Delete: nothing is deleted, the panel keeps it.
  await rowOf(b1).click();
  await expect(targets).toHaveText(['Body 1']);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await expect(targets).toHaveText(['Body 1']);
  expect(await deleteFeatures(page)).toEqual([]);
  // Its row clicked again (the panel shows just it): still the panel's, Delete still deletes nothing.
  await rowOf(b1).click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await expect(targets).toHaveText(['Body 1']);
  // Body 2 a target too: right-click Body 1 (both shown picked): its menu deletes Body 1 alone.
  await p.locator('[data-pick-list="targets"]').click();
  await rowOf(b2).click();
  await expect(targets).toHaveText(['Body 1', 'Body 2']);
  await rowOf(b1).click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-delete"]')).toHaveText('Delete Body 1');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect(p.locator('[data-feature-panel="combine"]')).toBeVisible();
  await expect(targets).toHaveText(['Body 1', 'Body 2']);
  expect(await deleteFeatures(page)).toEqual([]);
});

test('cad:body-delete-edit Edit Body-Delete 1 from its history row: the bodies by name, x brings one back at once, Done keeps it; Suppress and Delete of the row bring the rest back', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const [b1, b2] = await threeBlocks(page, frame);
  const rowOf = (id: string) => frame.locator(`[data-body-row="${id}"] > .tree-row`);
  await rowOf(b1).click();
  await rowOf(b2).click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await expect(bodyRows(frame)).toHaveText(['Body 3']);
  const row = featureRow(frame, 'Body-Delete 1');
  const menu = frame.locator('[data-cad-menu]');
  const rowMenu = async (item: string) => {
    await row.locator('> .tree-row').click({ button: 'right' });
    await menu.locator(`[data-menu-item="${item}"]`).click();
    await expect(menu).toHaveCount(0);
  };
  // Edit from its row: the panel lists Body 1 and Body 2 by their names.
  await rowMenu('edit');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-feature-panel="delete_body"]')).toBeVisible();
  const listed = p.locator('[data-pick-field="bodies"] .cad-pick-name');
  await expect(listed).toHaveText(['Body 1', 'Body 2']);
  await expect(p.locator('[data-pick-field="bodies"] .cad-pick-label')).toHaveText('Bodies to delete (2)');
  // x on Body 2: it is back in the tree, the view and the volume chip at once, the panel still open.
  await p.locator(`[data-pick-remove="${b2}"]`).click();
  await expect(listed).toHaveText(['Body 1']);
  await expect(bodyRows(frame)).toHaveText(['Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(2);
  await expect.poll(async () => (await chipVolumes(frame)).map(Math.round)).toEqual([8000, 8000]);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await expect(bodyRows(frame)).toHaveText(['Body 2', 'Body 3']);
  expect(await deleteFeatures(page)).toEqual([{ name: 'Body-Delete 1', bodies: [b1] }]);
  // Suppress from its row's menu: Body 1 is back.
  await rowMenu('suppress');
  await expect(row).toHaveAttribute('data-suppressed', '1');
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(3);
  // Unsuppress: gone again. Delete the row: back, and the row is gone.
  await rowMenu('suppress');
  await expect(bodyRows(frame)).toHaveText(['Body 2', 'Body 3']);
  await row.locator('> .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item="delete"]')).toHaveText('Delete Body-Delete 1');
  await menu.locator('[data-menu-item="delete"]').click();
  await expect(row).toHaveCount(0);
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 2', 'Body 3']);
  await expect.poll(() => drawn(page)).toBe(3);
  expect(await deleteFeatures(page)).toEqual([]);
});

test('cad:body-sim-magnusim in Magnusim a body keeps its simulation toggle, its hidden-but-included marks and its menu item', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const made = await addSolid(page, { size: [20, 20, 20] });
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.bridge.projectLinks() as boolean)).toBe(true);
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  const row = frame.locator(`[data-body-row="${made.body}"]`);
  await expect(row).toHaveAttribute('data-in-simulation', '1');
  await expect(row.locator('[data-body-act="simulation"]')).toHaveAttribute('aria-label', 'Leave Body 1 out of the simulation');
  await row.locator('[data-body-act="visibility"]').click();
  await expect(row).toHaveAttribute('data-hidden-in-simulation', '1');
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-simulation"]')).toHaveText('Leave Body 1 out of the simulation');
  await menu.locator('[data-menu-item="body-simulation"]').click();
  await expect(row).toHaveAttribute('data-in-simulation', '0');
  expect(await undoLabel(page)).toBe('Leave Body 1 out of the simulation');
});

/**
 * Magnusim CAD's welcome, as that app sends it: projectLinks false in the context the workspace page's
 * SDK reads (the host here has projects and leaves the flag out). Put in before the page's own scripts.
 */
async function welcomeWithoutProjects(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener(
      'message',
      (e: MessageEvent) => {
        const d = e.data as { magnusim?: string; context?: Record<string, unknown> } | null;
        if (!d || d.magnusim !== 'welcome' || !d.context || d.context.projectLinks === false) return;
        e.stopImmediatePropagation();
        window.dispatchEvent(new MessageEvent('message', { data: { ...d, context: { ...d.context, projectLinks: false } }, origin: e.origin, source: e.source, ports: [...e.ports] }));
      },
      true,
    );
  });
}

test('cad:body-sim-cad in Magnusim CAD (its welcome says projectLinks false) a body has no simulation toggle, no hidden-but-included marks and no simulation menu item', async ({ page, request }) => {
  test.setTimeout(240_000);
  await welcomeWithoutProjects(page);
  const frame = await freshPart(page, request);
  const made = await addSolid(page, { size: [20, 20, 20] });
  expect(await workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.bridge.projectLinks() as boolean)).toBe(false);
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  const row = frame.locator(`[data-body-row="${made.body}"]`);
  await expect(row.locator('.cad-body-name')).toHaveText('Body 1');
  await expect(row.locator('[data-body-act="visibility"]')).toBeVisible();
  await expect(row.locator('[data-body-act="simulation"]')).toHaveCount(0);
  await expect(row).not.toHaveAttribute('data-in-simulation');
  // Hidden: no "still in the simulation" mark.
  await row.locator('[data-body-act="visibility"]').click();
  await expect(row).toHaveAttribute('data-visible', '0');
  await expect(row).not.toHaveAttribute('data-hidden-in-simulation');
  // Its menu: no simulation item.
  await row.locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu.locator('[data-menu-item="body-visibility"]')).toHaveText('Show Body 1');
  await expect(menu.locator('[data-menu-item="body-simulation"]')).toHaveCount(0);
  await expect(menu.locator('[data-menu-item]').filter({ hasText: /simulation/i })).toHaveCount(0);
});
