// Move/copy body (Daniel 2026-10-30: a body could not be moved after it was made), as the person
// meets it:
//   cad:move-body-move     a body selected (its row in the tree), MODIFY's Move/copy body: the panel
//                          says it turns first, then moves; Move X 20 moves the body 20 mm along X in
//                          the view at once; Done: "Body-Move 1" in the history, the body still
//                          "Body 1"; Ctrl+Z puts it back, Ctrl+Y moves it again; Edit from its row
//                          shows Move X 20 again; the key M with a body selected opens the panel too;
//   cad:move-body-copy-turn  the body's menu in the tree, "Move/copy Body 1…" (just above "Delete
//                          Body 1"): Keep a copy renames the row Body-Copy 1, Move Y 30 and a turn of
//                          90 deg about Z (through the centre of its box): "Body 1" stays where it was
//                          and "Body 1 (Copy)" is a second body in the tree, turned (20 x 10 becomes
//                          10 x 20) and moved; Done; Undo takes the copy away.
// Setup (blocks) goes in through the document as the other specs do; what is asserted is what the
// person sees: the tree, the panel, the bodies' boxes as the view draws them (the rebuild's bodies,
// the same numbers the volume chip and Measure read).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, historyNames, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

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

/** The bodies built now, by name, with their boxes (rounded to 0.001 mm) as the view draws them. */
const boxes = (page: Page) =>
  workspaceFrame(page).evaluate(() =>
    ((window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies as { name: string; bbox: number[] }[]).map((b) => [b.name, b.bbox.map((v) => Math.round(v * 1000) / 1000 + 0)]),
  );
const undoLabel = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().history.undoLabel as string | null);
const bodyRows = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-body-row] .cad-body-name');
const featureRow = (frame: FrameLocator, name: string) => frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^${name}$`) }) });
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');

async function typeIn(frame: FrameLocator, field: string, value: string) {
  const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(panel(frame).locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** A 20 x 10 x 10 block at the origin (Body 1), the Bodies folder open. */
async function oneBlock(page: Page, frame: FrameLocator): Promise<string> {
  const b = (await addSolid(page, { at: [0, 0, 0], size: [20, 10, 10] })).body!;
  await frame.locator('[data-bodies-folder] > .tree-row').click();
  await expect(bodyRows(frame)).toHaveText(['Body 1']);
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [0, 0, 0, 20, 10, 10]]]);
  return b;
}

test('cad:move-body-move a selected body, Move/copy body, Move X 20: the body moves; Done names it Body-Move 1; Undo and Redo; Edit shows the values; M opens it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const b = await oneBlock(page, frame);
  await frame.locator(`[data-body-row="${b}"] > .tree-row`).click();
  await runCommand(frame, 'modify.move-body');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="move_body"]')).toBeVisible();
  await expect(p.locator('[data-pick-field="bodies"] .cad-pick-name')).toHaveText(['Body 1']);
  await expect(p.locator('[data-move-order]')).toHaveText('It turns first, then moves.');
  // Nothing typed yet: Done waits, and says why.
  await expect(p.locator('[data-incomplete-hint]')).toHaveText('Nothing to move: give a distance or an angle');
  // The pivot shows the centre of the body's box.
  await expect(p.locator('[data-pivot="centre"]')).toBeVisible();
  await expect(p.locator('.nui[data-field="pivot-x"] input')).toHaveValue('10');
  await typeIn(frame, 'move-x', '20');
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [20, 0, 0, 40, 10, 10]]]);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await expect(historyNames(frame).last()).toHaveText('Body-Move 1');
  await expect(bodyRows(frame)).toHaveText(['Body 1']);
  expect(await undoLabel(page)).toBe('Body-Move 1');
  // Ctrl+Z: back where it was; Ctrl+Y: moved again.
  await frame.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [0, 0, 0, 20, 10, 10]]]);
  await expect(featureRow(frame, 'Body-Move 1')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [20, 0, 0, 40, 10, 10]]]);
  // Edit from its row: the panel shows Move X 20 again.
  const row = featureRow(frame, 'Body-Move 1');
  await row.locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="edit"]').click();
  await expect(p.locator('[data-feature-panel="move_body"]')).toBeVisible();
  await expect(p.locator('.nui[data-field="move-x"] input')).toHaveValue('20');
  await expect(p.locator('.nui[data-field="move-y"] input')).toHaveValue('0');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // M with the body selected opens a new Move/copy body with it.
  await frame.locator(`[data-body-row="${b}"] > .tree-row`).click();
  await page.keyboard.press('m');
  await expect(p.locator('[data-feature-panel="move_body"][data-new="1"]')).toBeVisible();
  await expect(p.locator('[data-pick-field="bodies"] .cad-pick-name')).toHaveText(['Body 1']);
});

test("cad:move-body-copy-turn the body's menu, Move/copy Body 1…: Keep a copy, Move Y 30, Turn 90 about Z: Body 1 stays, Body 1 (Copy) is turned and moved; Undo takes it away", async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const b = await oneBlock(page, frame);
  await frame.locator(`[data-body-row="${b}"] > .tree-row`).click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  // Just above Delete Body 1, the menu's last item.
  const ids = await menu.locator('[data-menu-item]').evaluateAll((els) => els.map((e) => e.getAttribute('data-menu-item')));
  expect(ids.slice(-2)).toEqual(['body-move', 'body-delete']);
  await expect(menu.locator('[data-menu-item="body-move"]')).toHaveText('Move/copy Body 1…');
  await menu.locator('[data-menu-item="body-move"]').click();
  await expect(menu).toHaveCount(0);
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="move_body"]')).toBeVisible();
  await expect(p.locator('[data-pick-field="bodies"] .cad-pick-name')).toHaveText(['Body 1']);
  // Keep a copy: the feature is Body-Copy 1, and the panel says the originals stay.
  await p.locator('input[data-field="copy"]').check();
  await expect(p.locator('[data-move-order]')).toHaveText('The originals stay; the copies turn first, then move.');
  await typeIn(frame, 'move-y', '30');
  await expect(bodyRows(frame)).toHaveText(['Body 1', 'Body 1 (Copy)']);
  await expect.poll(() => boxes(page)).toEqual([
    ['Body 1', [0, 0, 0, 20, 10, 10]],
    ['Body 1 (Copy)', [0, 30, 0, 20, 40, 10]],
  ]);
  // Turn 90 about Z (the default axis), through the centre of its box (10, 5, 5): 10 x 20 in plan, then 30 along Y.
  await expect(p.locator('[data-field="about"] select')).toHaveValue('z');
  await typeIn(frame, 'angle', '90');
  await expect.poll(() => boxes(page)).toEqual([
    ['Body 1', [0, 0, 0, 20, 10, 10]],
    ['Body 1 (Copy)', [5, 25, 0, 15, 45, 10]],
  ]);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await expect(historyNames(frame).last()).toHaveText('Body-Copy 1');
  // Undo: the copy is gone, Body 1 never moved.
  await frame.locator('[data-part-name] > .tree-row').click();
  await page.keyboard.press('Control+z');
  await expect(bodyRows(frame)).toHaveText(['Body 1']);
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [0, 0, 0, 20, 10, 10]]]);
});
