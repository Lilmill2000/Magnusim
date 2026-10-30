// Section view (Daniel 2026-10-29: "any plane including constructed reference planes, their own
// normal, a draggable normal arrow in the view moving the cut, typed offset and flip kept"; he did
// not find the section in the view tools strip), as the person meets it:
//   cad:section-view-plane-arrow  INSPECT > Section view: the panel opens with the view cut (Front
//                          plane, the view tools' section button pressed); Plane 1 (the Top plane
//                          turned 30 deg about X) clicked in the tree: the panel names it, the cut lies
//                          on it (its own normal), the arrow stands on the cut along that normal; the
//                          arrow dragged 6 mm: Offset follows while the button is held and the cut and
//                          the arrow move with it, no rebuild; a typed Offset -4 moves them again;
//                          Keep the other side flips the kept side; the key X (Section view) closes the
//                          panel and the cut stays; reloaded, the Part comes back cut on Plane 1;
//                          Cut the view off: no cut, the button not pressed, no arrow.
// What is asserted is what the person sees: the panel's words and fields, the view's section state
// (window.__CAD__: the clipping plane the view draws), where the arrow is, a point of the block that
// the cut takes away and gives back (the view's own pick there).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, modelOnPage, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
type Arrow = { origin: V3; dir: V3; pixelMm: number; lengthMm: number; color: number; lit: boolean; dragging: boolean };
type Section = { on: boolean; plane: { kind: string; feature?: string; plane?: string }; frame: { origin: V3; normal: V3 }; offset: number; flip: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any; sectionArrow: Arrow | null } };

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { frame, seen };
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="tool"]');
const section = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().section as Section);
const arrow = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.sectionArrow);
const rebuildSeq = (page: Page) => workspaceFrame(page).evaluate(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.seq as number);
const savedSection = (page: Page) => workspaceFrame(page).evaluate(() => ((window as unknown as W).__CAD__.services.doc.state.get().view.section ?? null) as { plane: { kind: string }; offset: number; flip: boolean } | null);
const offsetField = (frame: FrameLocator) => panel(frame).locator('.nui[data-field="section-offset"] input');
const stripButton = (frame: FrameLocator) => frame.locator('[data-vp-opens="section"]');
const near = (a: readonly number[], b: readonly number[], tol: number) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const at = (o: V3, d: V3, s: number): V3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s];
/** The body's face the view picks at a model point (null: nothing there, the cut took it away). */
const pickAt = (page: Page, p: V3) =>
  workspaceFrame(page).evaluate((q) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const xy = h.project(q) as [number, number] | null;
    if (!xy) return 'off screen';
    // The body's faces only (the panel draws the origin planes while it waits for a plane).
    const r = h.pickKinds(xy[0], xy[1], ['face']);
    return r ? (r.item.kind as string) : null;
  }, p);

/** Plane 1: the Top plane turned 30 deg about the X axis (normal (0, -1/2, sqrt 3 / 2)), put in through the document as setup. */
async function tiltedPlane(page: Page): Promise<string> {
  const id = await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as W).__CAD__.services.doc;
    const s = doc.beginNew('ref_plane', { method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'origin', axis: 'origin:x' }, angle: '30 deg' });
    s.commit();
    return s.feature as string;
  });
  await expect.poll(() => workspaceFrame(page).evaluate((f) => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[f]?.type ?? null, id), { timeout: 30_000 }).toBe('plane');
  return id;
}

test('cad:section-view-plane-arrow INSPECT > Section view on a construction plane at an angle: the arrow dragged, a typed offset, flip, the key X, kept on reload, turned off', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { frame, seen } = await freshPart(page, request);
  // A 20 mm cube at the origin, and Plane 1 tilted 30 deg about X through the origin.
  await addSolid(page, { size: [20, 20, 20] });
  const plane = await tiltedPlane(page);
  const s = 0.5;
  const c = Math.sqrt(3) / 2;
  const FRONT_POINT: V3 = [10, 0, 15];

  // INSPECT > Section view: the panel opens with the view cut on the plane it had (Front), and the
  // view tools' section button says so.
  await runCommand(frame, 'inspect.section');
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.section"]')).toBeVisible();
  await expect.poll(async () => (await section(page)).on).toBe(true);
  expect((await section(page)).plane).toEqual({ kind: 'origin', plane: 'origin:front' });
  await expect(p.locator('[data-pick-field="section-plane"] .cad-pick-name')).toHaveText(['Front plane']);
  await expect(stripButton(frame)).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('[data-switch="section-on"] input')).toBeChecked();

  // Plane 1 clicked in the tree: the panel names it, the cut lies on it at offset 0, along its own normal.
  await frame.locator('[data-cad-tree] [data-feature-row] > .tree-row').filter({ hasText: 'Plane 1' }).click();
  await expect(p.locator('[data-pick-field="section-plane"] .cad-pick-name')).toHaveText(['Plane 1']);
  await expect.poll(async () => (await section(page)).plane).toEqual({ kind: 'feature', feature: plane });
  const cut0 = await section(page);
  expect(cut0.offset).toBe(0);
  expect(near(cut0.frame.normal, [0, -s, c], 1e-9)).toBe(true);
  expect(near(cut0.frame.origin, [0, 0, 0], 1e-9)).toBe(true);
  await expect(offsetField(frame)).toHaveValue('0');
  await expect(p.locator('[data-section-where]')).toHaveText(/^Cuts through \(0 mm, 0 mm, 0 mm\); keeps the side against its normal$/);
  // A point of the cube's front face (y = 0, seen from the Home view) above Plane 1: cut away (the cap shows there; nothing is picked).
  await expect.poll(() => pickAt(page, FRONT_POINT)).toBeNull();

  // The arrow stands on the cut, along Plane 1's normal, in the palette's ink.
  await expect.poll(async () => (await arrow(page))?.dir ?? null).not.toBeNull();
  const a0 = (await arrow(page))!;
  expect(near(a0.dir, [0, -s, c], 1e-9)).toBe(true);
  const onCut = (o: V3, offset: number) => Math.abs(o[1] * -s + o[2] * c - offset);
  expect(onCut(a0.origin, 0)).toBeLessThan(1e-6);

  // Dragged 6 mm along it: Offset follows while the button is held, the cut and the arrow with it, no rebuild.
  const seq0 = await rebuildSeq(page);
  const grab = at(a0.origin, a0.dir, 0.6 * a0.lengthMm);
  const from = await modelOnPage(page, grab);
  const to = await modelOnPage(page, at(grab, a0.dir, 6));
  await page.mouse.move(from[0], from[1], { steps: 2 });
  await expect.poll(async () => (await arrow(page))?.lit).toBe(true);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12);
  await expect.poll(async () => Number(await offsetField(frame).inputValue())).toBeGreaterThan(5.6);
  const held = Number(await offsetField(frame).inputValue());
  expect(held).toBeLessThan(6.4);
  expect((await arrow(page))!.dragging).toBe(true);
  expect((await section(page)).offset).toBeCloseTo(held, 6);
  await expect(frame.locator('[data-section-drag-value]')).toHaveText(/^Offset \d+(\.\d+)? mm$/);
  expect(onCut((await arrow(page))!.origin, held)).toBeLessThan(1e-6);
  expect(await rebuildSeq(page)).toBe(seq0);
  await page.mouse.up();
  await expect(frame.locator('[data-section-drag-value]')).toBeHidden();
  const kept = (await section(page)).offset;
  expect(Math.abs(kept - held)).toBeLessThan(0.05);
  await expect.poll(async () => (await savedSection(page))?.offset).toBeCloseTo(kept, 6);
  expect(await rebuildSeq(page)).toBe(seq0);

  // A typed offset: -4 mm (the Part's units; an expression would do as in any length field).
  await offsetField(frame).fill('-4');
  await offsetField(frame).press('Enter');
  await expect.poll(async () => (await section(page)).offset).toBe(-4);
  await expect.poll(async () => onCut((await arrow(page))!.origin, -4)).toBeLessThan(1e-6);

  // Keep the other side: what was cut away is kept, and the other way round.
  await expect.poll(() => pickAt(page, FRONT_POINT)).toBeNull();
  await p.locator('[data-switch="section-flip"] .cad-switch-label').click();
  await expect.poll(async () => (await section(page)).flip).toBe(true);
  await expect.poll(() => pickAt(page, FRONT_POINT)).not.toBeNull();
  await expect(p.locator('[data-section-where]')).toHaveText(/keeps the side along its normal$/);

  // The key X (Section view, Settings > Keybinds) closes the panel: the cut stays, the arrow goes.
  // (A click on the panel's words takes the keyboard from the switch: a key typed in a control is the control's.)
  await p.locator('[data-section-where]').click();
  await page.keyboard.press('x');
  await expect(p).toHaveCount(0);
  expect(await section(page)).toMatchObject({ on: true, plane: { kind: 'feature', feature: plane }, offset: -4, flip: true });
  expect(await arrow(page)).toBeNull();

  // Kept with the Part: reloaded, it comes back cut on Plane 1.
  await expect.poll(() => savedSection(page)).toEqual({ plane: { kind: 'feature', feature: plane }, offset: -4, flip: true });
  await page.waitForTimeout(2200); // the view's own save cadence (one write per 2 s at most)
  await page.reload();
  const again = page.frameLocator('#workspace-frame');
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect.poll(async () => (await section(page)).plane, { timeout: 60_000 }).toEqual({ kind: 'feature', feature: plane });
  expect(await section(page)).toMatchObject({ on: true, offset: -4, flip: true });
  expect(near((await section(page)).frame.normal, [0, -s, c], 1e-9)).toBe(true);
  await expect(stripButton(again)).toHaveAttribute('aria-pressed', 'true');

  // Turned off in the panel: no cut, the button not pressed, no arrow; the Part keeps it off.
  await runCommand(again, 'inspect.section');
  const p2 = panel(again);
  await expect(p2.locator('[data-pick-field="section-plane"] .cad-pick-name')).toHaveText(['Plane 1']);
  await expect(p2.locator('.nui[data-field="section-offset"] input')).toHaveValue('-4');
  await expect.poll(async () => (await arrow(page))?.dir ?? null).not.toBeNull();
  await p2.locator('[data-switch="section-on"] .cad-switch-label').click();
  await expect.poll(async () => (await section(page)).on).toBe(false);
  await expect(stripButton(again)).toHaveAttribute('aria-pressed', 'false');
  expect(await arrow(page)).toBeNull();
  await expect.poll(() => savedSection(page)).toBeNull();
  await expect.poll(() => pickAt(page, FRONT_POINT)).not.toBeNull();
  expect(seen.errors, 'console errors').toEqual([]);
});
