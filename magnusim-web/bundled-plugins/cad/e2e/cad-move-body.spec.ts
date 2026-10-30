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
//   cad:move-body-drag-arrow  the handle in the view (Fusion's Move): at the centre of the body's box,
//                          arrows and rings in the view triad's colours; the X arrow dragged 8 mm:
//                          Move X reads it while the button is held, the body is drawn there and a
//                          label says it, with no rebuild and no camera move; let go: the rebuild
//                          puts the body there; Move Y typed moves the body and the handle; Done:
//                          Body-Move 1, one undo step; the handle goes with the panel;
//   cad:move-body-drag-ring  the Z ring dragged about 37 deg: Angle reads it, the body is drawn
//                          turned; Ctrl held snaps to 15 deg (87 -> 90); the X ring dragged, then
//                          Escape with the button held: Angle, About and the body as before, no
//                          rebuild, the history as it was, the panel open.
// Setup (blocks) goes in through the document as the other specs do; what is asserted is what the
// person sees: the tree, the panel, the bodies' boxes as the view draws them (the rebuild's bodies,
// the same numbers the volume chip and Measure read).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, historyNames, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

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

// ---------------------------------------------------------------- the drag handle in the view

type V3 = [number, number, number];
type Part = { part: string; color: number; lit: boolean; dir?: V3; axis?: V3; radiusMm?: number; u?: V3; v?: V3 };
type HandleView = { origin: V3; pixelMm: number; dragging: boolean; parts: Part[] };

/** The open Move/copy body handle as window.__CAD__ reads it (null: none). */
const handleOf = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { moveHandle: unknown } }).__CAD__.moveHandle as HandleView | null);
/** Where the view draws a body now (its preview included): [xmin, ymin, zmin, xmax, ymax, zmax]. */
const drawn = (page: Page, id: string) =>
  workspaceFrame(page).evaluate((b) => {
    const r = (window as unknown as W).__CAD__.services.viewport.get().handle.drawnBox(b) as { min: number[]; max: number[] };
    return [...r.min, ...r.max];
  }, id);
const rebuildSeq = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.seq as number);
const featureCount = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.length as number);
const cameraMoves = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.userCameraMoves() as number);
const settledNow = async (page: Page) => {
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status as string)).toBe('done');
  await expect.poll(() => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating as boolean)).toBe(false);
};
const near = (a: readonly number[], b: readonly number[], tol: number) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fieldValue = async (frame: FrameLocator, field: string) => Number(await panel(frame).locator(`.nui[data-field="${field}"] input`).inputValue());
const at = (o: V3, d: V3, s: number): V3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
const round3 = (xs: number[]) => xs.map((v) => Math.round(v * 1000) / 1000 + 0);
/** The point of a ring `deg` degrees round from its u towards its v. */
const onRing = (h: HandleView, p: Part, deg: number): V3 => {
  const t = (deg * Math.PI) / 180;
  return [0, 1, 2].map((i) => h.origin[i] + p.radiusMm! * (Math.cos(t) * p.u![i] + Math.sin(t) * p.v![i])) as V3;
};
/** Points along a ring from `from` degrees round to `from + by`. */
const arc = (h: HandleView, p: Part, from: number, by: number) => [0, 1, 2, 3].map((k) => onRing(h, p, from + (by * k) / 3));

/** Press on model point `path[0]` and move through the rest (12 steps between each two page points); the button stays down. */
async function pressAlong(page: Page, path: V3[]): Promise<[number, number]> {
  const pts: [number, number][] = [];
  for (const q of path) pts.push(await modelOnPage(page, q));
  await page.mouse.move(pts[0][0], pts[0][1], { steps: 2 });
  await page.mouse.down();
  for (let k = 1; k < pts.length; k++) for (let i = 1; i <= 12; i++) await page.mouse.move(pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 12, pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * i) / 12);
  return pts[pts.length - 1];
}

/** pressAlong, `during` with the button held, then let go. */
async function dragAlong(page: Page, path: V3[], during?: () => Promise<void>) {
  await pressAlong(page, path);
  if (during) await during();
  await page.mouse.up();
}

/** A selected Body 1 (20 x 10 x 10 at the origin) in a new Move/copy body panel, its handle drawn. */
async function openWithHandle(page: Page, frame: FrameLocator): Promise<{ b: string; h: HandleView }> {
  const b = await oneBlock(page, frame);
  await frame.locator(`[data-body-row="${b}"] > .tree-row`).click();
  await runCommand(frame, 'modify.move-body');
  await expect(panel(frame).locator('[data-feature-panel="move_body"]')).toBeVisible();
  await settledNow(page);
  await expect.poll(async () => (await handleOf(page))?.parts.map((x) => x.part) ?? null).toEqual(['x', 'y', 'z', 'ring-x', 'ring-y', 'ring-z']);
  return { b, h: (await handleOf(page))! };
}

test("cad:move-body-drag-arrow the handle's X arrow dragged 8 mm: Move X and the drawn body follow with no rebuild; let go, the body is built there; Done: one undo step; the handle goes with the panel", async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const { b, h } = await openWithHandle(page, frame);
  const p = panel(frame);
  await expect(p.locator('[data-move-drag]')).toHaveText('Or drag the arrows and rings in the view (Ctrl: steps of 1 mm and 15°).');
  // At the centre of the body's box, in the view triad's light colours (the host's --mg-axis-x/y/z).
  expect(near(h.origin, [10, 5, 5], 1e-9)).toBe(true);
  const colours = Object.fromEntries(h.parts.map((x) => [x.part, x.color]));
  expect(colours).toEqual({ x: 0xd42828, y: 0x1f9a3a, z: 0x2a5bd7, 'ring-x': 0xd42828, 'ring-y': 0x1f9a3a, 'ring-z': 0x2a5bd7 });

  const seq0 = await rebuildSeq(page);
  const features0 = await featureCount(page);
  const moves0 = await cameraMoves(page);
  // Taken 30 px along its shaft, let go 8 mm further along X.
  const grab = at(h.origin, [1, 0, 0], 30 * h.pixelMm);
  let held = NaN;
  await dragAlong(page, [grab, at(grab, [1, 0, 0], 8)], async () => {
    await expect.poll(() => fieldValue(frame, 'move-x')).toBeGreaterThan(7.8);
    held = await fieldValue(frame, 'move-x');
    expect(held).toBeLessThan(8.2);
    await expect(frame.locator('[data-move-value]')).toHaveText(/^X \d+(\.\d+)? mm$/);
    // The body is drawn where the field says, with no rebuild, no feature added and no camera move.
    await expect.poll(async () => near(await drawn(page, b), [held, 0, 0, 20 + held, 10, 10], 1e-3)).toBe(true);
    expect(await rebuildSeq(page)).toBe(seq0);
    expect(await featureCount(page)).toBe(features0);
    const now = (await handleOf(page))!;
    expect(now.dragging).toBe(true);
    // The arrow held is drawn lit (thicker, in its own red); the others are not.
    expect(now.parts.filter((x) => x.lit).map((x) => [x.part, x.color])).toEqual([['x', 0xd42828]]);
    expect(near(now.origin, [10 + held, 5, 5], 1e-6)).toBe(true);
  });
  // Let go: the value stays (it was let go at the same pixel), the rebuild puts the body there.
  const kept = await fieldValue(frame, 'move-x');
  expect(Math.abs(kept - held)).toBeLessThan(0.05);
  await expect.poll(() => boxes(page)).toEqual([['Body 1', round3([kept, 0, 0, 20 + kept, 10, 10])]]);
  await settledNow(page);
  expect(near(await drawn(page, b), [kept, 0, 0, 20 + kept, 10, 10], 1e-3)).toBe(true);
  expect(near((await handleOf(page))!.origin, [10 + kept, 5, 5], 1e-6)).toBe(true);
  await expect(frame.locator('[data-move-value]')).toBeHidden();
  expect(await cameraMoves(page)).toBe(moves0);
  // Typing moves the body and the handle too: Move Y 3.
  await typeIn(frame, 'move-y', '3');
  await expect.poll(async () => near((await handleOf(page))!.origin, [10 + kept, 8, 5], 1e-6)).toBe(true);
  await expect.poll(() => boxes(page)).toEqual([['Body 1', round3([kept, 3, 0, 20 + kept, 13, 10])]]);
  await settledNow(page);
  expect(near(await drawn(page, b), [kept, 3, 0, 20 + kept, 13, 10], 1e-3)).toBe(true);
  // Done: Body-Move 1, one undo step; the handle goes with the panel.
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await expect(historyNames(frame).last()).toHaveText('Body-Move 1');
  expect(await undoLabel(page)).toBe('Body-Move 1');
  expect(await handleOf(page)).toBeNull();
  await expect.poll(() => boxes(page)).toEqual([['Body 1', round3([kept, 3, 0, 20 + kept, 13, 10])]]);
});

test('cad:move-body-drag-ring the Z ring dragged: Angle and the drawn body follow; Ctrl snaps to 15 deg; Escape with the button held puts the drag back and changes nothing', async ({ page, request }) => {
  test.setTimeout(240_000);
  const frame = await freshPart(page, request);
  const { b, h } = await openWithHandle(page, frame);
  const p = panel(frame);
  const ringZ = h.parts.find((x) => x.part === 'ring-z')!;
  // Taken 45 deg round (between the X and Y arrows), turned 37 deg further.
  const seq0 = await rebuildSeq(page);
  let held = NaN;
  await dragAlong(page, arc(h, ringZ, 45, 37), async () => {
    await expect.poll(() => fieldValue(frame, 'angle')).toBeGreaterThan(35.5);
    held = await fieldValue(frame, 'angle');
    expect(held).toBeLessThan(38.5);
    await expect(frame.locator('[data-move-value]')).toHaveText(/^Z \d+(\.\d+)?°$/);
    // Drawn turned about Z through (10, 5, 5): the box of a 20 x 10 turned by the angle.
    const t = (held * Math.PI) / 180;
    const hx = 10 * Math.cos(t) + 5 * Math.sin(t);
    const hy = 10 * Math.sin(t) + 5 * Math.cos(t);
    await expect.poll(async () => near(await drawn(page, b), [10 - hx, 5 - hy, 0, 10 + hx, 5 + hy, 10], 1e-3)).toBe(true);
    expect(await rebuildSeq(page)).toBe(seq0);
  });
  await expect(p.locator('[data-field="about"] select')).toHaveValue('z');
  const a1 = await fieldValue(frame, 'angle');
  expect(Math.abs(a1 - held)).toBeLessThan(1.01);
  await settledNow(page);
  // Ctrl held: whole steps of 15 deg (a1 + 50, about 87, snaps to 90): built at 90.
  const h2 = (await handleOf(page))!;
  await page.keyboard.down('Control');
  await dragAlong(page, arc(h2, h2.parts.find((x) => x.part === 'ring-z')!, 45, 50));
  await page.keyboard.up('Control');
  await expect.poll(() => fieldValue(frame, 'angle')).toBe(90);
  await expect.poll(() => boxes(page)).toEqual([['Body 1', [5, -5, 0, 15, 15, 10]]]);
  await settledNow(page);

  // The X ring dragged 30 deg, then Escape with the button held: Angle 90 about Z again, the body as
  // built, no rebuild, the history as it was, the panel open; the rest of the press changes nothing.
  const seq1 = await rebuildSeq(page);
  const features1 = await featureCount(page);
  const undo1 = await undoLabel(page);
  const h3 = (await handleOf(page))!;
  const end = await pressAlong(page, arc(h3, h3.parts.find((x) => x.part === 'ring-x')!, 45, 30));
  await expect(p.locator('[data-field="about"] select')).toHaveValue('x');
  await expect.poll(() => fieldValue(frame, 'angle')).toBeGreaterThan(25);
  expect(near(await drawn(page, b), [5, -5, 0, 15, 15, 10], 1e-3)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(p.locator('[data-field="about"] select')).toHaveValue('z');
  await expect.poll(() => fieldValue(frame, 'angle')).toBe(90);
  await expect.poll(async () => near(await drawn(page, b), [5, -5, 0, 15, 15, 10], 1e-3)).toBe(true);
  await expect(frame.locator('[data-move-value]')).toBeHidden();
  await page.mouse.move(end[0] + 40, end[1] + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await rebuildSeq(page)).toBe(seq1);
  expect(await featureCount(page)).toBe(features1);
  expect(await undoLabel(page)).toBe(undo1);
  await expect(p.locator('[data-feature-panel="move_body"]')).toBeVisible();
  await expect(p.locator('[data-field="about"] select')).toHaveValue('z');
  expect(await fieldValue(frame, 'angle')).toBe(90);
  expect(near(await drawn(page, b), [5, -5, 0, 15, 15, 10], 1e-3)).toBe(true);
  expect(await boxes(page)).toEqual([['Body 1', [5, -5, 0, 15, 15, 10]]]);
});
