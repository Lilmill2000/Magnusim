// P2+P3 review round 4 (the SD pass's blocker and polish): one test per finding, each
// asserting what the user sees and failing without its fix. All at 1280 x 800, the
// reviewer's screen. Bodies are made from sketches (Box and Cylinder are gone).
// Blocker:
//  1. reopen-frames      A sketch reopened from History with a body made after it (rolled
//                        back while it is edited): its corners and dimension labels are in
//                        the view and clear of the tree and the panel, one double-click on
//                        the 100 edits it; after Fit and Look at too (the view aimed at the
//                        hidden body, with 1 of 4 corners and no label on screen).
//  2. reopen-far-body    The same with the later body 200 mm away: the sketch spans a good
//                        part of the free view and the camera looks at it (it sat 53 px wide
//                        beside the empty place of the hidden body).
//  3. sketch-only-fit    A Part of one 35 mm sketch: Fit in model mode and in sketch mode
//                        makes it fill the view (it was framed on the origin planes' 100 mm).
// Polish:
//  4. vertical-boxes     A vertical line's Length box sits beside the line and neither box
//                        covers it; a rectangle's Height box is beside its right side.
//  5. face-cut           Extrude from a sketch on a face: Cut goes into the body (Flip is
//                        ticked for it); pointing out, the message says to tick Flip.
//  6. split-keeps-plane  Split by the Right plane at 15 mm, "Split with" switched to Another
//                        body and back: still the Right plane at 15 mm, 2 bodies.
//  7. import-words       A clean flange's Diagnostics say "0 problems" and nothing about
//                        shapes healing changed ("Healing changed 1 shape" beside it).
//  8. tree-width         The tree card keeps its width when a warning glyph comes into
//                        History and when a name is long; the open panel does not move.
//                        A Cut that leaves Body 1 in 2 pieces says so (chip and warning).
//  9. intersect-tools    Combine Intersect with two tools keeps what the target shares with
//                        both (it kept what it shared with either), and the hint says so.
// 10. face-name          The Sketch panel names the face it lies on as Measure does
//                        ("Face N of Body 1", from "End face of Extrude 1").
// 11. menu-home-end      The tree's context menu takes Home and End.
// window.__CAD__ is used only to project model points to the screen, to wait for sketch
// edits and the camera, and to read the camera.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';
const FLANGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kernel', 'flange.step');

test.use({ viewport: { width: 1280, height: 800 } });

type V3 = [number, number, number];
type Pt = [number, number];
type Rect = { x: number; y: number; width: number; height: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  return { seen, frame };
}

const cad = <T, A = undefined>(page: Page, fn: (a: A) => T | Promise<T>, arg?: A) => workspaceFrame(page).evaluate(fn as never, arg) as Promise<T>;
const tb = (frame: FrameLocator) => frame.locator('[data-cad-toolbar]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel]');
const featureRow = (frame: FrameLocator, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** Page coordinates of a model point (null when behind the camera). */
async function project(page: Page, p: V3): Promise<Pt | null> {
  const xy = await cad<Pt | null, V3>(page, (q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q), p);
  if (!xy) return null;
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy[0], box.y + xy[1]];
}

async function at(page: Page, p: V3): Promise<Pt> {
  const xy = await project(page, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  return xy!;
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.click(x, y);
}

async function sweep(page: Page, from: V3, to: V3, n = 6) {
  for (let k = 1; k <= n; k++) {
    const [x, y] = await at(page, [from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n, from[2] + ((to[2] - from[2]) * k) / n]);
    await page.mouse.move(x, y);
  }
}

async function settled(page: Page) {
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
  // Two more frames: what each frame places (labels, boxes) has been placed.
  await cad(page, () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** No rebuild running or queued, then the camera at rest. */
async function rebuilt(page: Page) {
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status)).not.toBe('running');
  await settled(page);
}

async function sketchIdle(page: Page) {
  await cad(page, async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

async function sketchOn(page: Page, frame: FrameLocator, plane: 'top' | 'front' | 'right') {
  await frame.locator(`[data-tree-node="origin:${plane}"] > .tree-row`).click();
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function finishSketch(page: Page, frame: FrameLocator) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await rebuilt(page);
}

/** A rectangle typed w x h: from `corner` toward `toward` (corner tool), or about `corner` (centre tool). */
async function typedRect(page: Page, frame: FrameLocator, corner: V3, toward: V3, w: number, h: number, centre = false) {
  await tb(frame).locator(`[data-command="${centre ? 'sketch.rectangle-center' : 'sketch.rectangle'}"]`).click();
  await clickAt(page, corner);
  await sweep(page, corner, toward, 4);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type(String(w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(h));
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
}

/** Click a shaded region, Extrude it (distance in mm when given), Done. */
async function extrudeAt(page: Page, frame: FrameLocator, p: V3, name: string, distance?: number) {
  await clickAt(page, p);
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['region']);
  await page.keyboard.press('e');
  const pp = panel(frame);
  await expect(pp.locator('[data-panel-title]')).toHaveText(name);
  if (distance != null) {
    const d = pp.locator('.nui[data-field="distance"] input');
    await d.fill(String(distance));
    await d.press('Enter');
  }
  await expect(featureRow(frame, name)).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await pp.locator('[data-panel-done]').click();
  await expect(pp).toHaveCount(0);
  await rebuilt(page);
}

/** A block from a centre rectangle on Top at the origin, w x h, extruded `d` mm. */
async function centredBlock(page: Page, frame: FrameLocator, w: number, h: number, pick: V3, name: string, d?: number) {
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [w / 4, h / 4, 0], w, h, true);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText([String(w), String(h)]);
  await finishSketch(page, frame);
  await extrudeAt(page, frame, pick, name, d);
}

async function openBodies(frame: FrameLocator) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  return frame.locator('[data-cad-tree] [data-body-row]');
}

const volumeMm3 = async (frame: FrameLocator) => Number(await frame.locator('[data-chip="volume"] [data-volume-mm3]').getAttribute('data-volume-mm3'));
async function expectVolume(frame: FrameLocator, mm3: number, rel = 1e-6) {
  await expect.poll(() => volumeMm3(frame).then((v) => Math.abs(v - mm3) <= rel * mm3), { timeout: 30_000, message: `volume ${mm3} mm³` }).toBe(true);
}

/** Where the tree card and the open panel are, the free part of the view right of them, and the stage. */
async function layout(page: Page, frame: FrameLocator) {
  const stage = (await frame.locator('.cad-stage').boundingBox())!;
  const tree = (await frame.locator('[data-cad-tree]').boundingBox())!;
  const p = panel(frame);
  const pr = (await p.count()) ? await p.first().boundingBox() : null;
  const coverRight = Math.max(tree.x + tree.width, pr ? pr.x + pr.width : 0);
  return { stage, tree, panel: pr, free: { left: coverRight, right: stage.x + stage.width, top: stage.y, bottom: stage.y + stage.height } };
}

const inside = (p: Pt, r: Rect, m = 0) => p[0] >= r.x + m && p[0] <= r.x + r.width - m && p[1] >= r.y + m && p[1] <= r.y + r.height - m;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const words = (r: Rect) => `[${[r.x, r.y, r.x + r.width, r.y + r.height].map(Math.round).join(',')}]`;

/** What of a sketch the user cannot see or reach: corners off the view or under the tree or the panel, labels the same. */
async function hiddenParts(page: Page, frame: FrameLocator, corners: V3[], labels: string[]): Promise<string[]> {
  const { stage, tree, panel: pr } = await layout(page, frame);
  const out: string[] = [];
  for (const c of corners) {
    const s = await project(page, c);
    if (!s) out.push(`corner ${c} is behind the camera`);
    else if (!inside(s, stage, 2)) out.push(`corner ${c} at ${s.map(Math.round)} is outside the view ${words(stage)}`);
    else if (inside(s, tree) || (pr && inside(s, pr))) out.push(`corner ${c} at ${s.map(Math.round)} is under the ${inside(s, tree) ? 'tree' : 'panel'}`);
  }
  for (const text of labels) {
    const l = frame.locator('[data-sketch-dim]').filter({ hasText: new RegExp(`^${text}$`) });
    if (!(await l.count())) {
      out.push(`no ${text} label`);
      continue;
    }
    const r = (await l.boundingBox())!;
    if (r.x < stage.x || r.y < stage.y || r.x + r.width > stage.x + stage.width || r.y + r.height > stage.y + stage.height) out.push(`the ${text} label ${words(r)} is outside the view ${words(stage)}`);
    else if (overlaps(r, tree) || (pr && overlaps(r, pr))) out.push(`the ${text} label ${words(r)} is under the ${overlaps(r, tree) ? 'tree' : 'panel'}`);
  }
  return out;
}

/** How much of the free view a sketch spans (its corners on screen), across and down. */
async function spanOf(page: Page, frame: FrameLocator, corners: V3[]) {
  const { free } = await layout(page, frame);
  const pts = await Promise.all(corners.map((c) => at(page, c)));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { across: (Math.max(...xs) - Math.min(...xs)) / (free.right - free.left), down: (Math.max(...ys) - Math.min(...ys)) / (free.bottom - free.top) };
}

const cameraTarget = (page: Page) => cad<V3>(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle.camera().target);

async function reopen(page: Page, frame: FrameLocator, name: string) {
  await featureRow(frame, name).locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await rebuilt(page);
}

// ---------------------------------------------------------------- 1

test('cad:p2p3-review4-reopen-frames a sketch reopened with a body made after it shows its corners and labels clear of the cards; one double-click edits the 100; after Fit and Look at too', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Sketch 1 on Top: a 100 x 60 rectangle from the origin, typed.
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [11, 7, 0], 100, 60);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['100', '60']);
  await finishSketch(page, frame);
  // Then a 20 mm block at the origin, made after it (on the Front plane, as a box would stand there).
  await sketchOn(page, frame, 'front');
  await typedRect(page, frame, [0, 0, 0], [4, 0, 4], 20, 20);
  await finishSketch(page, frame);
  await extrudeAt(page, frame, [10, 0, 10], 'Extrude 1', 20);
  await expectVolume(frame, 8000);
  // Reopen Sketch 1 from History: the block is rolled back while it is edited.
  await reopen(page, frame, 'Sketch 1');
  await expect(frame.locator('[data-chip="volume"]')).toHaveCount(0);
  const corners: V3[] = [[0, 0, 0], [100, 0, 0], [100, 60, 0], [0, 60, 0]];
  await shot(page, 'r4-reopen');
  expect(await hiddenParts(page, frame, corners, ['100', '60']), 'reopened').toEqual([]);
  // One double-click on the 100 edits it.
  const l100 = (await frame.locator('[data-sketch-dim]').filter({ hasText: /^100$/ }).boundingBox())!;
  await page.mouse.move(l100.x + l100.width / 2, l100.y + l100.height / 2);
  await page.mouse.dblclick(l100.x + l100.width / 2, l100.y + l100.height / 2);
  await expect(frame.locator('[data-sketch-dim-edit]'), 'the 100 editor after one double-click').toBeFocused({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim-edit]')).toHaveCount(0);
  // Fit, then Look at: the same.
  await tb(frame).locator('[data-command="view.fit"]').click();
  await settled(page);
  expect(await hiddenParts(page, frame, corners, ['100', '60']), 'after Fit').toEqual([]);
  await tb(frame).locator('[data-command="view.sketch-look"]').click();
  await settled(page);
  expect(await hiddenParts(page, frame, corners, ['100', '60']), 'after Look at').toEqual([]);
  await finishSketch(page, frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 2

test('cad:p2p3-review4-reopen-far-body a sketch reopened with a later body 200 mm away fills the free view and the camera looks at it; after Fit and Look at too', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [8, 6, 0], 40, 30);
  await finishSketch(page, frame);
  // A block at (200, 200): zoom out until the spot is in the view, then a 20 x 20 rectangle there.
  await sketchOn(page, frame, 'top');
  const { stage } = await layout(page, frame);
  for (let i = 0; i < 20; i++) {
    const far = await project(page, [225, 225, 0]);
    if (far && inside(far, stage, 60)) break;
    await page.mouse.move(stage.x + stage.width * 0.6, stage.y + stage.height * 0.5);
    await page.mouse.wheel(0, 240);
    await settled(page);
  }
  await typedRect(page, frame, [200, 200, 0], [205, 205, 0], 20, 20);
  await finishSketch(page, frame);
  await extrudeAt(page, frame, [210, 210, 0], 'Extrude 1');
  await reopen(page, frame, 'Sketch 1');
  const corners: V3[] = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]];
  const check = async (when: string) => {
    expect(await hiddenParts(page, frame, corners, ['40', '30']), when).toEqual([]);
    const span = await spanOf(page, frame, corners);
    expect(Math.max(span.across, span.down), `${when}: the sketch spans ${(span.across * 100).toFixed(0)} % across and ${(span.down * 100).toFixed(0)} % down the free view`).toBeGreaterThan(0.3);
    const t = await cameraTarget(page);
    expect(t[0] >= 0 && t[0] <= 40 && t[1] >= 0 && t[1] <= 30 && Math.abs(t[2]) < 1, `${when}: the camera looks at ${t.map((v) => v.toFixed(1))}, not into the sketch`).toBe(true);
  };
  await shot(page, 'r4-reopen-far');
  await check('reopened');
  await tb(frame).locator('[data-command="view.fit"]').click();
  await settled(page);
  await check('after Fit');
  await tb(frame).locator('[data-command="view.sketch-look"]').click();
  await settled(page);
  await check('after Look at');
  await finishSketch(page, frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 3

test('cad:p2p3-review4-sketch-only-fit Fit frames a Part of one 35 mm sketch in model mode and in sketch mode', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [7, 4, 0], 35, 20);
  await finishSketch(page, frame);
  const corners: V3[] = [[0, 0, 0], [35, 0, 0], [35, 20, 0], [0, 20, 0]];
  for (const where of ['model mode', 'sketch mode']) {
    if (where === 'sketch mode') await reopen(page, frame, 'Sketch 1');
    await tb(frame).locator('[data-command="view.fit"]').click();
    await settled(page);
    const span = await spanOf(page, frame, corners);
    await shot(page, `r4-fit-${where.split(' ')[0]}`);
    expect(Math.max(span.across, span.down), `${where}: the sketch spans ${(span.across * 100).toFixed(0)} % across and ${(span.down * 100).toFixed(0)} % down the free view`).toBeGreaterThan(0.3);
    expect(await hiddenParts(page, frame, corners, []), where).toEqual([]);
  }
  await finishSketch(page, frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p2p3-review4-sketch-no-chase the sketch being drawn counts when the view is framed, but the camera never moves by itself while lines are drawn past the view', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await centredBlock(page, frame, 20, 20, [5, 5, 0], 'Extrude 1');
  await clickAt(page, [5, 5, 10]);
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await rebuilt(page);
  const before = await cad<{ position: V3; target: V3 }>(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle.camera());
  // A 200 mm line from the face's middle, far past the framed block, typed.
  await tb(frame).locator('[data-command="sketch.line"]').click();
  await clickAt(page, [0, 0, 10]);
  await sweep(page, [0, 0, 10], [6, 0, 10], 4);
  await page.keyboard.type('200');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  await rebuilt(page);
  const after = await cad<{ position: V3; target: V3 }>(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle.camera());
  expect(after, 'the camera after the line was drawn').toEqual(before);
  // Fit takes the whole sketch in.
  await tb(frame).locator('[data-command="view.fit"]').click();
  await settled(page);
  expect(await hiddenParts(page, frame, [[0, 0, 10], [200, 0, 10]], []), 'after Fit').toEqual([]);
  await finishSketch(page, frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 4

/** Where a box would cover a screen segment: the segment sampled every 2 px against the box (1 px in). */
function covers(box: Rect, a: Pt, b: Pt): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
  for (let i = 0; i <= n; i++) {
    const p: Pt = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    if (p[0] > box.x + 1 && p[0] < box.x + box.width - 1 && p[1] > box.y + 1 && p[1] < box.y + box.height - 1) return true;
  }
  return false;
}

async function boxRect(frame: FrameLocator, id: string): Promise<Rect> {
  return (await frame.locator(`[data-sketch-box="${id}"]`).locator('xpath=..').boundingBox())!;
}

test('cad:p2p3-review4-vertical-boxes a vertical line has its Length box beside it and no box on it, drawn down and up; a rectangle has its Height box beside its right side', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  for (const [from, to] of [
    [[0, 25, 0], [0, -25, 0]],
    [[20, -25, 0], [20, 25, 0]],
    // And slanted: no box on it either.
    [[-40, -25, 0], [-10, 25, 0]],
  ] as [V3, V3][]) {
    await tb(frame).locator('[data-command="sketch.line"]').click();
    await clickAt(page, from);
    await sweep(page, from, to, 8);
    await expect(frame.locator('[data-sketch-box="length"]')).toBeVisible();
    await settled(page);
    const a = await at(page, from);
    const b = await at(page, to);
    const len = await boxRect(frame, 'length');
    const ang = await boxRect(frame, 'angle');
    const vertical = from[0] === to[0];
    await shot(page, `r4-line-${vertical ? (from[1] > 0 ? 'down' : 'up') : 'slanted'}`);
    expect(covers(len, a, b), `the Length box ${words(len)} covers the line from ${a.map(Math.round)} to ${b.map(Math.round)}`).toBe(false);
    expect(covers(ang, a, b), `the Angle box ${words(ang)} covers the line from ${a.map(Math.round)} to ${b.map(Math.round)}`).toBe(false);
    // Beside it, across from its middle (Fusion): level with the line's middle, off to one side.
    if (vertical) {
      const midY = (a[1] + b[1]) / 2;
      expect(Math.abs(len.y + len.height / 2 - midY), `the Length box's middle ${Math.round(len.y + len.height / 2)} is level with the line's ${Math.round(midY)}`).toBeLessThan(len.height);
      expect(Math.min(Math.abs(len.x - a[0]), Math.abs(len.x + len.width - a[0])), 'the Length box stands off the line').toBeGreaterThan(4);
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sketchIdle(page);
  }
  // A rectangle being drawn: its Height box beside the right side, Width below the bottom one.
  await tb(frame).locator('[data-command="sketch.rectangle"]').click();
  await clickAt(page, [-40, -20, 0]);
  await sweep(page, [-40, -20, 0], [-10, 20, 0], 8);
  await expect(frame.locator('[data-sketch-box="height"]')).toBeVisible();
  await settled(page);
  const corner = await at(page, [-40, -20, 0]);
  const far = await at(page, [-10, 20, 0]);
  const right = Math.max(corner[0], far[0]);
  const height = await boxRect(frame, 'height');
  const width = await boxRect(frame, 'width');
  expect(covers(height, [right, corner[1]], [right, far[1]]), `the Height box ${words(height)} covers the right side x = ${Math.round(right)}`).toBe(false);
  expect(height.x, 'the Height box is right of the right side').toBeGreaterThan(right);
  expect(covers(width, [corner[0], Math.max(corner[1], far[1])], [far[0], Math.max(corner[1], far[1])]), `the Width box ${words(width)} covers the bottom side`).toBe(false);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await finishSketch(page, frame);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 5 and 10

test('cad:p2p3-review4-face-cut a sketch on a face names the face; Extrude Cut from it goes into the body, and pointing out it says to tick Flip direction', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 40 x 40 x 10 block; then a sketch on its top face, named as Measure names faces.
  await centredBlock(page, frame, 40, 40, [5, 5, 0], 'Extrude 1');
  await expectVolume(frame, 16000);
  // How Measure names the top face.
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  await clickAt(page, [12, 12, 10]);
  await expect(panel(frame)).toContainText(/Face \d+ of Body 1/, { timeout: 30_000 });
  const measured = /Face \d+ of Body 1/.exec((await panel(frame).textContent()) ?? '')![0];
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  // A sketch on it: the panel names it the same way, where it came from in the tooltip.
  await clickAt(page, [12, 12, 10]);
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  const plane = frame.locator('[data-cad-panel="sketch"] [data-sketch-plane]');
  await expect(plane).toHaveText(measured);
  await expect(plane).toHaveAttribute('title', `${measured}, from End face of Extrude 1`);
  await settled(page);
  // A circle of diameter 10 in its middle.
  await tb(frame).locator('[data-command="sketch.circle"]').click();
  await clickAt(page, [0, 0, 10]);
  await page.keyboard.type('10');
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await finishSketch(page, frame);
  // Extrude the circle, then Cut: it goes into the body (Flip direction ticked for it).
  await clickAt(page, [1, 1, 10]);
  await page.keyboard.press('e');
  const p = panel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 2');
  const flip = p.locator('[data-field="flip"]');
  await expect(flip).not.toBeChecked();
  await p.locator('[data-field="op"] select').selectOption('cut');
  await expect(flip).toBeChecked();
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expectVolume(frame, 16000 - Math.PI * 25 * 10, 1e-6);
  // Pointing out of the body: the words say what to do.
  await flip.uncheck();
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(p).toContainText('Nothing to cut: Extrude 2 does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1');
  await shot(page, 'r4-face-cut');
  await flip.check();
  await expect(featureRow(frame, 'Extrude 2')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 6

test('cad:p2p3-review4-split-keeps-plane Split by the Right plane at 15 mm keeps the plane and the offset when "Split with" goes to Another body and back', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [5, 5, 0], 20, 20);
  await finishSketch(page, frame);
  await extrudeAt(page, frame, [10, 10, 0], 'Extrude 1', 20);
  await expectVolume(frame, 8000);
  await tb(frame).locator('[data-command="modify.split"]').click();
  const p = panel(frame);
  const bodies = await openBodies(frame);
  await bodies.first().locator('.tree-row').first().click();
  await expect(p.locator('[data-pick-field="targets"] [data-pick-row]')).toHaveCount(1);
  await p.locator('[data-field="plane"] select').selectOption('origin:right');
  const offset = p.locator('.nui[data-field="offset"] input');
  await offset.fill('15');
  await offset.press('Enter');
  await expect(p.locator('[data-split-pieces]')).toHaveText('2 bodies', { timeout: 30_000 });
  // To Another body and back.
  await p.locator('[data-field="tool-kind"] select').selectOption('body');
  await expect(p.locator('[data-field="plane"] select')).toHaveCount(0);
  await p.locator('[data-field="tool-kind"] select').selectOption('plane');
  await expect(p.locator('[data-field="plane"] select')).toHaveValue('origin:right');
  await expect(offset).toHaveValue('15');
  await expect(p.locator('[data-split-pieces]')).toHaveText('2 bodies', { timeout: 30_000 });
  await expect(featureRow(frame, 'Split 1')).toHaveAttribute('data-state', 'ok');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // The pieces: 15 mm and 5 mm of the 20 mm block.
  const vols: number[] = [];
  for (const i of [0, 1]) {
    await (await openBodies(frame)).nth(i).locator('.tree-row').first().click();
    vols.push(await volumeMm3(frame));
  }
  expect(vols.map((v) => Math.round(v)).sort((a, b) => a - b)).toEqual([2000, 6000]);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 7

test('cad:p2p3-review4-import-words a clean flange says 0 problems and nothing about shapes healing changed', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(FLANGE);
  const p = panel(frame);
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await expect(p.locator('[data-import-diagnostics]')).toHaveText('0 problems');
  const group = p.locator('[data-import-diagnostics]').locator('xpath=..');
  await shot(page, 'r4-import');
  await expect(group).not.toContainText('Healing changed');
  await expect(group).not.toContainText(/changed \d+ shapes?/);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 8

test('cad:p2p3-review4-tree-width the tree card keeps its width when a warning glyph comes and when a name is long; a Cut leaving Body 1 in 2 pieces says so', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 30 x 10 bar and a 10 x 20 bar across its middle, both 10 mm high.
  await centredBlock(page, frame, 30, 10, [10, 0, 0], 'Extrude 1');
  await centredBlock(page, frame, 10, 20, [0, 8, 0], 'Extrude 2');
  // Combine 1 joins them (no warning), under a name of a usual length: its row is the widest.
  const bodies = await openBodies(frame);
  await tb(frame).locator('[data-command="modify.combine"]').click();
  const p = panel(frame);
  await p.locator('[data-pick-list="targets"]').click();
  await bodies.nth(0).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodies.nth(1).locator('.tree-row').first().click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  const name = 'Cut the cross bar out of the long bar';
  await featureRow(frame, 'Combine 1').locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const rename = frame.locator('[data-cad-tree] input[aria-label="Feature name"]');
  await rename.fill(name);
  await rename.press('Enter');
  await expect(featureRow(frame, name)).toHaveCount(1);
  // Its panel open, then Cut: Body 1 minus the cross bar is two 10 mm cubes, and a warning glyph
  // comes into its row with the panel open. Nothing beside the tree moves.
  await featureRow(frame, name).locator('> .tree-row').dblclick();
  await expect(p.locator('[data-field="op"] select')).toBeVisible();
  await settled(page);
  const tree = frame.locator('[data-cad-tree]');
  const width0 = (await tree.boundingBox())!.width;
  const panelX = (await p.boundingBox())!.x;
  await p.locator('[data-field="op"] select').selectOption('cut');
  await expect(featureRow(frame, name)).toHaveAttribute('data-state', 'warning', { timeout: 30_000 });
  await expect(p).toContainText('Body 1 is now in 2 separate pieces');
  await settled(page);
  await shot(page, 'r4-tree-warning');
  expect((await tree.boundingBox())!.width, 'the tree card with a warning glyph').toBeCloseTo(width0, 0);
  expect((await p.boundingBox())!.x, 'the panel with a warning glyph in the tree').toBeCloseTo(panelX, 0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  // Body 1 in 2 pieces: the chip says so.
  await (await openBodies(frame)).nth(0).locator('.tree-row').first().click();
  await expect(frame.locator('[data-chip="volume"]')).toContainText('Body 1 · 2 pieces');
  await expectVolume(frame, 2000);
  // A long name: ellipsis, same width.
  await featureRow(frame, 'Extrude 2').locator('> .tree-row').click();
  await page.keyboard.press('F2');
  const input = frame.locator('[data-cad-tree] input[aria-label="Feature name"]');
  await input.fill('Cross bar that cuts the long bar into two separate cubes');
  await input.press('Enter');
  await expect(featureRow(frame, 'Cross bar that cuts the long bar into two separate cubes')).toHaveCount(1);
  expect((await tree.boundingBox())!.width, 'the tree card with a long name').toBeCloseTo(width0, 0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 9

test('cad:p2p3-review4-intersect-tools Combine Intersect with two tools keeps what the target shares with both, as the hint says', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 x 20 block with a 10 x 40 bar and a 40 x 10 bar through it (all centred, 10 mm high).
  await centredBlock(page, frame, 20, 20, [5, 5, 0], 'Extrude 1');
  await centredBlock(page, frame, 10, 40, [0, 15, 0], 'Extrude 2');
  await centredBlock(page, frame, 40, 10, [15, 0, 0], 'Extrude 3');
  const bodies = await openBodies(frame);
  await expect(bodies).toHaveCount(3);
  await tb(frame).locator('[data-command="modify.combine"]').click();
  const p = panel(frame);
  await p.locator('[data-field="op"] select').selectOption('intersect');
  await expect(p.locator('[data-combine-op-hint]')).toHaveText('Keep only what each target shares with all the tools');
  // By name: a tool goes from the list once it is applied (tools are not kept).
  const row = (name: string) => bodies.filter({ has: frame.locator('.cad-body-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.tree-row').first();
  await p.locator('[data-pick-list="targets"]').click();
  await row('Body 1').click();
  await p.locator('[data-pick-list="tools"]').click();
  await row('Body 2').click();
  await expect(p.locator('[data-pick-field="tools"] [data-pick-row]')).toHaveCount(1);
  await row('Body 3').click();
  await expect(p.locator('[data-pick-field="tools"] [data-pick-row]')).toHaveCount(2);
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  // What all three share: the 10 x 10 middle (it kept the 20 x 20 block's parts in either bar: 3,000 mm³).
  await expectVolume(frame, 1000);
  await shot(page, 'r4-intersect');
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 11

test('cad:p2p3-review4-menu-home-end the tree menu moves to its first item on Home and its last on End', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOn(page, frame, 'top');
  await typedRect(page, frame, [0, 0, 0], [5, 5, 0], 20, 20);
  await finishSketch(page, frame);
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').click({ button: 'right' });
  const menu = frame.locator('[data-cad-menu]');
  await expect(menu).toBeVisible();
  const items = menu.locator('[role="menuitem"]');
  expect(await items.count()).toBeGreaterThan(2);
  const focusedIndex = () => menu.evaluate((m) => Array.from(m.querySelectorAll('[role="menuitem"]')).indexOf(document.activeElement as Element));
  await page.keyboard.press('End');
  await expect.poll(focusedIndex).toBe((await items.count()) - 1);
  await page.keyboard.press('Home');
  await expect.poll(focusedIndex).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedIndex).toBe(1);
  await page.keyboard.press('End');
  await expect.poll(focusedIndex).toBe((await items.count()) - 1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
