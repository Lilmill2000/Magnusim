// P2+P3 review round 2 (INTEGRATE): one test per blocker, each asserting what
// the user sees and failing without its fix:
//  1. driven-tab        Tab inside "Make it driven?" stays in the dialog (Cancel, then
//                       the action, round again); Enter then on Cancel adds no dimension
//                       and the sketch stays (Tab sent the keyboard out of the frame and
//                       Enter ran Finish sketch behind the dialog).
//  2. dialog-keys       "Delete faces of Extrude 1?": Tab stays in the dialog; 1 and Delete
//                       do nothing behind it (1 turned the view to Front and Delete
//                       opened a second dialog on top); a key that reaches the page
//                       outside the dialog runs no shortcut either.
//  3. arrow-iso         Dragging the extrude arrow in Isometric view to the spot that
//                       showed 25 mm stores 25 mm, and the camera holds still during the
//                       drag (the view refitted on each live rebuild and the value ran
//                       away to 77.6 mm).
//  4. typed-snap        A line typed with a length only keeps the horizontal or vertical
//                       direction its preview snapped to, with the relation (it was
//                       stored 2.86 degrees off, with no relation).
//  5. boxes-apart       The Length and Angle boxes of a short line never overlap, and the
//                       focused one is fully visible (the Angle box covered the typed 30).
// The round's polish:
//  6. tab-to-angle      With no box focused, Tab goes to Angle (Length is the active box,
//                       as in Fusion): Tab 180 Enter stores 180 degrees, not 180 mm.
//  7. first-move        One pointer move after a typed segment, onto the next segment's
//                       Angle box, moves the preview and the boxes, and a click there places
//                       the segment (the move went to the box and the click into it).
//  8. center-rect-labels A centre rectangle beside other geometry labels its width below it
//                       and its height right of it (the 20 sat over its centre point).
//  9. empty-sketch      An empty sketch shows no "Fully defined" lock in the history.
// 10. intersect-touching An Intersect of two blocks that only touch fails in the words a Cut
//                       uses, and both bodies stay (amber "removed completely", target gone).
// 11. delete-names-broken Deleting Combine 1 names the Press-pull that fails without it, and
//                       that one says which face ("Face not found after rebuild" named none).
// 12. extrude-view      A new extrude seen straight on turns to Isometric, frames its sketch
//                       (the circles were cut off), and its arrow shows a grab hand.
// 13. panel-undo        Undo with a panel open takes its changes back as one step that Redo
//                       brings back (they were dropped for good).
// 14. reload-words      Reload after "Changed in another tab" says that this tab's unsaved
//                       Enclosure 1 is gone (it went without a word; then it was a Cylinder).
// The tree menu's Delete, offered while it would be refused, is checked in the updated
// cad-p2p3-review1.spec.ts refused-delete test (now disabled, the reason beside it).
// window.__CAD__ is used only to project model points to the screen, to wait for
// sketch edits, to read what the sketch stores and the camera, and (helpers.ts
// addSketch / addSolid) to set sketched blocks up: there is no Box since decision
// 2026-10-01.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSketch, addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, runCommand } from './helpers';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];
type Pt = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
interface Draft {
  points: Record<string, Pt>;
  entities: { id: string; kind: string; p?: string[]; c?: string; r?: number }[];
  constraints: { id: string; kind: string; refs: string[]; expr?: string; driving?: boolean }[];
}
type Rect = { x: number; y: number; width: number; height: number };
type Cam = { position: V3; target: V3; up: V3; orthoHeight: number };

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

async function at(page: Page, p: V3): Promise<Pt> {
  const xy = await cad<Pt | null, V3>(page, (q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q), p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy![0], box.y + xy![1]];
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y, { steps: 2 });
  await page.mouse.click(x, y);
}

/** The pointer moved in small steps from `from` to `to` (model points), as a hand moves it. */
async function sweep(page: Page, from: V3, to: V3, n = 12) {
  for (let k = 1; k <= n; k++) {
    const p: V3 = [from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n, from[2] + ((to[2] - from[2]) * k) / n];
    const [x, y] = await at(page, p);
    await page.mouse.move(x, y);
  }
}

async function settled(page: Page) {
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

const camera = (page: Page) => cad<Cam>(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle.camera());
const draft = (page: Page) => cad<Draft>(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.draft());

async function sketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function finishSketch(frame: FrameLocator) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** A line's length and angle (degrees) as stored. */
function lineGeo(d: Draft, id: string) {
  const e = d.entities.find((x) => x.id === id)!;
  const [a, b] = e.p!.map((p) => (p === 'origin' ? ([0, 0] as Pt) : d.points[p]));
  return { len: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

/** The relations and dimensions on one entity, as kinds (dimensions with their expression). */
const relationsOf = (d: Draft, id: string) => d.constraints.filter((c) => c.refs.includes(id)).map((c) => (c.expr ? `${c.kind} ${c.expr}` : c.kind));

/** A rectangle from the origin dimensioned w x h (fully defined), as the P3 gate draws it. */
async function definedRectangle(page: Page, frame: FrameLocator, w: number, h: number) {
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [w + 0.3, h + 0.2, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  const edit = frame.locator('[data-sketch-dim-edit]');
  await clickAt(page, [w / 2, 0, 0]);
  await clickAt(page, [w / 2, -8, 0]);
  await expect(edit).toBeFocused();
  await edit.fill(String(w));
  await edit.press('Enter');
  await sketchIdle(page);
  await clickAt(page, [w, h / 2, 0]);
  await clickAt(page, [w + 12, h / 2, 0]);
  await expect(edit).toBeFocused();
  await edit.fill(String(h));
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Fully defined');
}

/** What has the keyboard inside the frame: the focused element's attributes, or 'none' when the frame lost it. */
const frameFocus = (page: Page) =>
  cad<string>(page, () => {
    if (!document.hasFocus()) return 'none (the frame lost the keyboard)';
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return 'body';
    return Array.from(a.attributes).filter((x) => x.name.startsWith('data-')).map((x) => `${x.name}=${x.value}`).join(' ') || a.tagName;
  });

/** A keydown that reaches the page outside any dialog (as the reviewer's keys did once Tab had moved the keyboard). */
const keyOnBody = (page: Page, key: string) =>
  cad<void, string>(page, (k) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }, key);

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Each value box's rectangle (its label), page pixels. */
async function boxRects(frame: FrameLocator): Promise<Record<string, Rect>> {
  const out: Record<string, Rect> = {};
  for (const b of await frame.locator('[data-sketch-box]').all()) out[(await b.getAttribute('data-sketch-box'))!] = (await b.locator('xpath=..').boundingBox())!;
  return out;
}

/** The focused box's input is what the page shows at its centre and its four corners (nothing covers it). */
const focusedBoxUncovered = (page: Page) =>
  cad<string>(page, () => {
    const el = document.activeElement as HTMLInputElement | null;
    if (!el || !el.hasAttribute('data-sketch-box')) return 'no box has the keyboard';
    const r = el.getBoundingClientRect();
    const pts: [number, number][] = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return `outside the frame: ${JSON.stringify(r)}`;
    for (const [x, y] of pts) {
      const top = document.elementFromPoint(x, y);
      if (top !== el && !el.parentElement?.contains(top)) return `covered at ${Math.round(x)},${Math.round(y)} by ${top?.outerHTML.slice(0, 80)}`;
    }
    return 'visible';
  });

// ---------------------------------------------------------------- 1

test('cad:p2p3-review2-driven-tab Tab stays inside "Make it driven?"; Enter on Cancel then adds no dimension and the sketch stays', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await definedRectangle(page, frame, 60, 20);
  const before = (await draft(page)).constraints.length;
  const q = frame.locator('[data-sketch-question="driven"]');
  // A Dimension from (0, 0) to (0, 20): the height again, so it would over-define the sketch.
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [0, 20, 0]);
  await clickAt(page, [-15, 10, 0]);
  await expect(q).toBeVisible();
  await expect(q.locator('.cad-sk-dialog-copy')).toHaveText('Distance 20 mm would over-define Sketch 1. A driven dimension shows the value without holding it.');
  await expect(q.locator('[data-question-accept]')).toBeFocused();
  // Tab goes round the dialog's two buttons and never out of it.
  await page.keyboard.press('Tab');
  expect(await frameFocus(page)).toBe('data-question-cancel=1');
  await page.keyboard.press('Tab');
  expect(await frameFocus(page)).toBe('data-question-accept=1');
  await page.keyboard.press('Shift+Tab');
  expect(await frameFocus(page)).toBe('data-question-cancel=1');
  // Keys that are shortcuts elsewhere do nothing while the question is open.
  await page.keyboard.press('l');
  await keyOnBody(page, 'Enter');
  await keyOnBody(page, 'l');
  await expect(q).toBeVisible();
  expect(await cad(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.state.get().tool)).toBe('dimension');
  await shot(page, 'r2-driven-tab');
  // Enter presses Cancel: no dimension, still in the sketch.
  await page.keyboard.press('Enter');
  await expect(q).toBeHidden();
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  expect((await draft(page)).constraints).toHaveLength(before);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['60', '20']);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 2

test('cad:p2p3-review2-dialog-keys "Delete faces of Extrude 1?": Tab stays in the dialog; 1 and Delete do nothing behind it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 mm block, sketched and extruded.
  await addSolid(page);
  await expect(frame.locator('[data-chip="volume"]')).toContainText('8000 mm³');
  await settled(page);
  // The block's front face (y = 0).
  await clickAt(page, [10, 0, 10]);
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['face']);
  await page.keyboard.press('Delete');
  const dlg = frame.locator('dialog[open]');
  await expect(dlg).toHaveCount(1);
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Extrude 1?');
  await expect(dlg.locator('[data-dialog-choice="cancel"]')).toBeFocused();
  const cam = await camera(page);
  // Tab from Cancel (the last button) goes round to the first; Shift+Tab back.
  await page.keyboard.press('Tab');
  expect(await frameFocus(page)).toBe(`data-dialog-choice=${await dlg.locator('[data-dialog-choice]').first().getAttribute('data-dialog-choice')}`);
  await page.keyboard.press('Shift+Tab');
  expect(await frameFocus(page)).toBe('data-dialog-choice=cancel');
  await page.keyboard.press('Tab');
  // 1 (Front view) and Delete (this dialog again) do nothing while it is open.
  await page.keyboard.press('1');
  await page.keyboard.press('Delete');
  await keyOnBody(page, '1');
  await keyOnBody(page, 'Delete');
  await page.waitForTimeout(400);
  await settled(page);
  await expect(frame.locator('dialog[open]')).toHaveCount(1);
  expect(await camera(page)).toEqual(cam);
  await shot(page, 'r2-dialog-keys');
  await page.keyboard.press('Escape');
  await expect(frame.locator('dialog[open]')).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(2);
  // Closed: the keys work again (1 is the Front view).
  await page.keyboard.press('1');
  await settled(page);
  expect(await camera(page)).not.toEqual(cam);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 3

/** Two circles of diameter 40 (centres 30 mm apart) on the Top plane, the lens between them extruded (panel left open). */
async function lensExtrude(page: Page, frame: FrameLocator) {
  await sketchOnTop(page, frame);
  for (const c of [[0, 0, 0], [30, 0, 0]] as V3[]) {
    if (!(await tb(frame).locator('[data-command="sketch.circle"]').evaluate((el) => el.classList.contains('is-active')))) await page.keyboard.press('c');
    await clickAt(page, c);
    await page.keyboard.type('40');
    await expect(frame.locator('[data-sketch-box="diameter"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await sketchIdle(page);
  }
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['⌀40', '⌀40']);
  await finishSketch(frame);
  await clickAt(page, [15, 5, 0]);
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['region']);
  await page.keyboard.press('e');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(panel(frame).locator('.nui[data-field="distance"] input')).toHaveValue('10');
}

/** Where the extrude's arrow stands on: the profile's inside point and the extrude direction (model mm). */
const arrowAxis = (page: Page) =>
  cad<{ origin: V3; axis: V3 }>(page, () => {
    const s = (window as unknown as W).__CAD__.services.doc.state.get();
    const ex = s.doc.features.find((f: { type: string }) => f.type === 'extrude');
    const out = s.rebuild.outputs[ex.profiles[0].sketch];
    const reg = out.regions.find((r: { key: string }) => r.key === ex.profiles[0].region);
    const pl = out.plane;
    const n = pl.normal;
    const x = pl.xdir;
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const o = [0, 1, 2].map((i) => pl.origin[i] + reg.sample[0] * x[i] + reg.sample[1] * y[i]);
    return { origin: o as V3, axis: (ex.flip ? n.map((v: number) => -v) : n) as V3 };
  });

test('cad:p2p3-review2-arrow-iso dragging the extrude arrow in Isometric view to the spot of 25 mm stores 25 mm; the camera holds still during the drag', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await lensExtrude(page, frame);
  await tb(frame).locator('[data-command="view.iso"]').click();
  await settled(page);
  const { origin, axis } = await arrowAxis(page);
  const along = (t: number): V3 => [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t];
  const px = await cad<number, V3>(page, (p) => (window as unknown as W).__CAD__.services.viewport.get().handle.pixelSize(p), along(10));
  // Taken on its shaft, 20 px above its base; dropped where 25 mm (plus that offset) was on the screen when the drag began.
  const grab = 20 * px;
  const [x0, y0] = await at(page, along(10 + grab));
  const [x1, y1] = await at(page, along(25 + grab));
  const cam = await camera(page);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const moved: string[] = [];
  for (let k = 1; k <= 20; k++) {
    await page.mouse.move(x0 + ((x1 - x0) * k) / 20, y0 + ((y1 - y0) * k) / 20);
    await page.waitForTimeout(80);
    const now = await camera(page);
    if (JSON.stringify(now) !== JSON.stringify(cam)) moved.push(`step ${k}: ${now.position.map((v) => v.toFixed(1)).join(', ')}`);
  }
  await page.waitForTimeout(400);
  expect(moved, 'the camera moved during the drag').toEqual([]);
  const shown = await frame.locator('[data-extrude-value]').innerText();
  await shot(page, 'r2-arrow-iso');
  await page.mouse.up();
  const field = panel(frame).locator('.nui[data-field="distance"] input');
  await expect.poll(async () => Math.abs(Number(await field.inputValue()) - 25), { message: `stored ${await field.inputValue()} (shown while dragging: ${shown})` }).toBeLessThanOrEqual(px);
  await panel(frame).locator('[data-panel-done]').click();
  const stored = await cad<string>(page, () => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f: { type: string }) => f.type === 'extrude').extent.distance);
  expect(Math.abs(parseFloat(stored) - 25), `stored "${stored}"`).toBeLessThanOrEqual(px);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 4

test('cad:p2p3-review2-typed-snap a line typed with only a length keeps the horizontal or vertical snap of its preview, with the relation', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const length = frame.locator('[data-sketch-box="length"]');
  const angle = frame.locator('[data-sketch-box="angle"]');
  const glyph = (k: string) => frame.locator(`[data-sketch-infer="${k}"]`);
  await page.keyboard.press('l');
  // About 2.9 degrees above horizontal: the preview snaps to horizontal.
  await clickAt(page, [-60, -30, 0]);
  await sweep(page, [-60, -30, 0], [-30, -28.5, 0]);
  await expect(glyph('horizontal')).toHaveCount(1);
  await expect(angle).toHaveValue('0');
  await page.keyboard.type('30');
  await expect(length).toBeFocused();
  await expect(length).toHaveValue('30');
  // Typing a length keeps the snap: still horizontal, the glyph still shown.
  await expect(angle).toHaveValue('0');
  await expect(glyph('horizontal')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  let d = await draft(page);
  const h = d.entities.filter((e) => e.kind === 'line').at(-1)!;
  expect(lineGeo(d, h.id).len).toBeCloseTo(30, 6);
  expect(lineGeo(d, h.id).ang).toBeCloseTo(0, 6);
  expect(relationsOf(d, h.id).sort()).toEqual(['distance 30 mm', 'horizontal']);
  // Up, about 2.9 degrees off vertical.
  await clickAt(page, [40, -60, 0]);
  await sweep(page, [40, -60, 0], [41.5, -30, 0]);
  await expect(glyph('vertical')).toHaveCount(1);
  await expect(angle).toHaveValue('90');
  await page.keyboard.type('25');
  await expect(angle).toHaveValue('90');
  await expect(glyph('vertical')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  d = await draft(page);
  const v = d.entities.filter((e) => e.kind === 'line').at(-1)!;
  expect(lineGeo(d, v.id).len).toBeCloseTo(25, 6);
  expect(lineGeo(d, v.id).ang).toBeCloseTo(90, 6);
  expect(relationsOf(d, v.id).sort()).toEqual(['distance 25 mm', 'vertical']);
  await shot(page, 'r2-typed-snap');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 5

test('cad:p2p3-review2-boxes-apart a short line: the Length and Angle boxes never overlap, and the one with the keyboard is fully visible', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const length = frame.locator('[data-sketch-box="length"]');
  const angle = frame.locator('[data-sketch-box="angle"]');
  await page.keyboard.press('l');
  for (const [from, to] of [
    [[-40, 10, 0], [-24, 10.6, 0]],
    [[-40, -20, 0], [-35, -19, 0]],
    [[20, 30, 0], [20.5, 46, 0]],
  ] as [V3, V3][]) {
    await clickAt(page, from);
    await sweep(page, from, to, 8);
    await expect(length).toBeVisible();
    const where = `line ${from} -> ${to}`;
    let r = await boxRects(frame);
    expect(overlap(r.length, r.angle), `${where}, following the pointer: ${JSON.stringify(r)}`).toBe(false);
    const len = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]));
    await page.keyboard.type(String(len));
    await expect(length).toBeFocused();
    r = await boxRects(frame);
    expect(overlap(r.length, r.angle), `${where}, Length typed: ${JSON.stringify(r)}`).toBe(false);
    expect(await focusedBoxUncovered(page), `${where}, Length typed`).toBe('visible');
    await page.keyboard.press('Tab');
    await expect(angle).toBeFocused();
    r = await boxRects(frame);
    expect(overlap(r.length, r.angle), `${where}, Angle focused: ${JSON.stringify(r)}`).toBe(false);
    expect(await focusedBoxUncovered(page), `${where}, Angle focused`).toBe('visible');
    if (from[0] === -40 && from[1] === 10) await shot(page, 'r2-boxes-apart');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
  }
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 6

test('cad:p2p3-review2-tab-to-angle with no box focused, Tab goes to Angle: Tab 180 Enter stores a 180 degree segment', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const angle = frame.locator('[data-sketch-box="angle"]');
  await page.keyboard.press('l');
  await clickAt(page, [10, 10, 0]);
  await sweep(page, [10, 10, 0], [-5, 13, 0], 6);
  await expect(angle).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(angle).toBeFocused();
  await page.keyboard.type('180');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  const d = await draft(page);
  const l = d.entities.find((e) => e.kind === 'line')!;
  expect(lineGeo(d, l.id).ang).toBeCloseTo(180, 6);
  expect(lineGeo(d, l.id).len).toBeGreaterThan(10);
  expect(relationsOf(d, l.id)).toContain('angle 180 deg');
  expect(relationsOf(d, l.id).some((r) => r.startsWith('distance'))).toBe(false);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 7

test('cad:p2p3-review2-first-move one pointer move after a typed segment moves the preview and the boxes', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const length = frame.locator('[data-sketch-box="length"]');
  const angle = frame.locator('[data-sketch-box="angle"]');
  await page.keyboard.press('l');
  await clickAt(page, [10, 10, 0]);
  await sweep(page, [10, 10, 0], [26, 14, 0], 6);
  await page.keyboard.type('20');
  await page.keyboard.press('Tab');
  await page.keyboard.type('0');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await expect(angle).not.toBeFocused();
  // The next segment's Angle box sits just below the new end at (30, 10): one move onto it,
  // straight down from the end (as the reviewer's move landed there).
  const [ex, ey] = await at(page, [30, 10, 0]);
  const box = (await angle.locator('xpath=..').boundingBox())!;
  expect(box.y).toBeGreaterThan(ey);
  const y = box.y + box.height / 2;
  await page.mouse.move(ex, y);
  // The preview follows: the boxes say about -90 degrees, and the box is no longer under the pointer.
  await expect.poll(async () => Number(await angle.inputValue())).toBeLessThan(-80);
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  await expect.poll(() => cad<string, Pt>(page, ([px, py]) => document.elementFromPoint(px, py)?.tagName ?? 'none', [ex - fr.x, y - fr.y])).toBe('CANVAS');
  await page.mouse.down();
  await page.mouse.up();
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  const d = await draft(page);
  const lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines, 'the click placed the second segment (it went into the box)').toHaveLength(2);
  expect(lineGeo(d, lines[1].id).ang).toBeLessThan(-80);
  expect(lineGeo(d, lines[1].id).ang).toBeGreaterThan(-100);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- polish: more

/** A history row by its name (a sketch's row starts with its state: "(-) Sketch 1"). */
const featureRow = (frame: FrameLocator, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** A block (corner, size): a rectangle sketched on Top and extruded (helpers.ts addSolid). */
const addBlock = (page: Page, origin: V3, size: V3) => addSolid(page, { at: origin, size });

/** The Bodies folder open; its rows. */
async function bodyRows(frame: FrameLocator) {
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  return frame.locator('[data-cad-tree] [data-body-row]');
}

/** Combine with one target and one tool picked from the tree. */
async function combine(frame: FrameLocator, op: 'join' | 'cut' | 'intersect', target: number, tool: number) {
  const bodies = await bodyRows(frame);
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  await p.locator('[data-field="op"] select').selectOption(op);
  await p.locator('[data-pick-list="targets"]').click();
  await bodies.nth(target).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodies.nth(tool).locator('.tree-row').first().click();
  return p;
}

test('cad:p2p3-review2-center-rect-labels a centre rectangle typed 20 x 10 beside other geometry: the 20 below it and the 10 right of it, clear of its centre', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // Other geometry below and left of where the rectangle goes: the sketch's middle lies below it.
  await page.keyboard.press('l');
  await clickAt(page, [-60, -45, 0]);
  await clickAt(page, [-20, -45, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.rectangle-center');
  await clickAt(page, [30, 20, 0]);
  await sweep(page, [30, 20, 0], [37, 24, 0], 4);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('20');
  await page.keyboard.press('Tab');
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  const dims = frame.locator('[data-sketch-dim]');
  await expect(dims).toHaveText(['20', '10']);
  await settled(page);
  const centre = (b: Rect): Pt => [b.x + b.width / 2, b.y + b.height / 2];
  const w = centre((await dims.nth(0).boundingBox())!);
  const h = centre((await dims.nth(1).boundingBox())!);
  const [, bottom] = await at(page, [30, 15, 0]);
  const [right] = await at(page, [40, 20, 0]);
  const mid = await at(page, [30, 20, 0]);
  expect(w[1], `the 20 at y = ${Math.round(w[1])}, the bottom edge at ${Math.round(bottom)}`).toBeGreaterThan(bottom + 4);
  expect(h[0], `the 10 at x = ${Math.round(h[0])}, the right edge at ${Math.round(right)}`).toBeGreaterThan(right + 4);
  expect(Math.hypot(w[0] - mid[0], w[1] - mid[1]), 'the 20 is clear of the centre point').toBeGreaterThan(20);
  await shot(page, 'r2-center-rect-labels');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-empty-sketch an empty sketch shows no "Fully defined" lock in the history', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('No geometry yet');
  await finishSketch(frame);
  const row = featureRow(frame, 'Sketch 1');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-sketch-lock]')).toHaveCount(0);
  await expect(row.locator('> .tree-row .tl')).toHaveText('Sketch 1');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-intersect-touching an Intersect of two blocks that only touch fails in the words a Cut uses, and both bodies stay', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBlock(page, [0, 0, 0], [20, 20, 20]);
  await addBlock(page, [20, 0, 0], [20, 20, 20]);
  const p = await combine(frame, 'intersect', 0, 1);
  await expect(p.locator('[data-run-reason]')).toContainText('Combine 1 failed: Nothing in common: Body 2 does not overlap Body 1 (touching is not enough)', { timeout: 30_000 });
  await expect(await bodyRows(frame)).toHaveCount(2);
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'error');
  await expect(await bodyRows(frame)).toHaveCount(2);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-delete-names-broken deleting Combine 1 names the Press-pull that fails without it, and that one says which face', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const toast = page.locator('#workspace-overlay [data-ws-toast]');
  await addBlock(page, [0, 0, 0], [20, 20, 20]);
  await addBlock(page, [5, 5, 10], [10, 10, 20]);
  const p = await combine(frame, 'cut', 0, 1);
  await expect(frame.locator('[data-chip="volume"]')).toContainText('7000 mm³', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  // The pocket's floor (made by Extrude 2's start face, z = 10, in the Cut), seen from the top, pulled up 3 mm.
  await page.keyboard.press('5');
  await settled(page);
  await clickAt(page, [10, 10, 10]);
  await page.keyboard.press('q');
  const pp = panel(frame);
  await expect(pp.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
  const d = pp.locator('.nui[data-field="distance"] input');
  await d.fill('3');
  await d.press('Enter');
  await expect(frame.locator('[data-chip="volume"]')).toContainText('7300 mm³', { timeout: 30_000 });
  await pp.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
  // Delete Combine 1 (nothing uses it as a feature): it goes, and the Press-pull that loses its face is named.
  await featureRow(frame, 'Combine 1').locator('> .tree-row').click({ button: 'right' });
  const del = frame.locator('[data-cad-menu] [data-menu-item="delete"]');
  await expect(del).not.toHaveAttribute('aria-disabled', 'true');
  await del.click();
  await expect(toast).toHaveText(/Deleted Combine 1: Press-pull 1 fails without it\. Undo \(Ctrl\+Z\) brings Combine 1 back\./, { timeout: 30_000 });
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
  await expect(featureRow(frame, 'Press-pull 1').locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', /^What's wrong: Press-pull 1 failed: Start face of Extrude 2 not found on Body 1 after rebuild$/);
  await shot(page, 'r2-delete-names-broken');
  // Undo brings it back, and the Press-pull builds again.
  await page.keyboard.press('Control+z');
  await expect(featureRow(frame, 'Combine 1')).toHaveCount(1);
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-extrude-view a new extrude seen straight on turns to Isometric, frames its sketch, and its arrow shows a grab hand', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await lensExtrude(page, frame);
  await settled(page);
  const { origin, axis } = await arrowAxis(page);
  // The view no longer looks along the extrude: the arrow has a length on the screen.
  const cam = await camera(page);
  const look = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
  const cos = Math.abs(look[0] * axis[0] + look[1] * axis[1] + look[2] * axis[2]) / Math.hypot(look[0], look[1], look[2]);
  expect(cos, 'the view looks along the extrude direction').toBeLessThan(Math.cos((25 * Math.PI) / 180));
  const along = (t: number): V3 => [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t];
  const px = await cad<number, V3>(page, (p) => (window as unknown as W).__CAD__.services.viewport.get().handle.pixelSize(p), along(10));
  const [bx, by] = await at(page, along(10));
  const [tx, ty] = await at(page, along(10 + 60 * px));
  expect(Math.hypot(tx - bx, ty - by), 'the arrow on the screen (px)').toBeGreaterThan(30);
  // The whole sketch is in the view: both circles, right of the panels.
  const c = (await frame.locator('.cad-viewport').boundingBox())!;
  const stack = (await frame.locator('[data-cad-left-stack]').boundingBox())!;
  for (const p of [[-20, 0, 0], [50, 0, 0], [0, 20, 0], [0, -20, 0], [30, 20, 0], [30, -20, 0]] as V3[]) {
    const [x, y] = await at(page, p);
    expect(x > stack.x + stack.width && x < c.x + c.width && y > c.y && y < c.y + c.height, `circle point ${p} at ${Math.round(x)}, ${Math.round(y)}`).toBe(true);
  }
  await shot(page, 'r2-extrude-view');
  // A grab hand over the arrow, a closed one while dragging it.
  const cursor = () => cad<string>(page, () => document.querySelector<HTMLCanvasElement>('.cad-viewport canvas')!.style.cursor);
  const [gx, gy] = await at(page, along(10 + 20 * px));
  await page.mouse.move(gx + 30, gy + 30);
  await page.mouse.move(gx, gy, { steps: 3 });
  await expect.poll(cursor).toBe('grab');
  await page.mouse.down();
  await page.mouse.move(gx, gy - 10, { steps: 3 });
  await expect.poll(cursor).toBe('grabbing');
  await page.mouse.up();
  await page.mouse.move(gx + 120, gy + 120, { steps: 3 });
  await expect.poll(cursor).not.toMatch(/grab/);
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-panel-undo Undo in an open panel takes back its changes as one step that Redo brings back', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const undo = tb(frame).locator('[data-command="edit.undo"]');
  const redo = tb(frame).locator('[data-command="edit.redo"]');
  const volume = frame.locator('[data-chip="volume"]');
  // A 20 x 20 sketch, then a new Extrude (10 mm), panel open: Ctrl+Z takes it away; Redo brings it back.
  await addSketch(page);
  await tb(frame).locator('[data-command="solid.extrude"]').click();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(volume).toContainText('4000 mm³');
  await page.keyboard.press('Control+z');
  await expect(panel(frame)).toHaveCount(0);
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(1);
  await expect(redo).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Control+y');
  await expect(featureRow(frame, 'Extrude 1')).toHaveCount(1);
  await expect(volume).toContainText('4000 mm³');
  // An existing Extrude edited in its panel: Undo takes the change back, Redo brings it back.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  const size = panel(frame).locator('.nui[data-field="distance"] input');
  await size.fill('30');
  await size.press('Enter');
  await expect(volume).toContainText('12,000 mm³');
  await undo.click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(volume).toContainText('4000 mm³');
  await expect(redo).not.toHaveAttribute('aria-disabled', 'true');
  await redo.click();
  await expect(volume).toContainText('12,000 mm³');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review2-reload-words Reload after "Changed in another tab" says that this tab\'s unsaved Enclosure 1 is gone', async ({ page, context, request }) => {
  const { seen, frame: a } = await freshPart(page, request);
  // Tab A: a 20 mm block (Sketch 1, Extrude 1), saved.
  await addSolid(page);
  await expect(a.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  const page2 = await context.newPage();
  const seen2 = await watchPage(page2);
  await page2.goto(page.url());
  const b = page2.frameLocator('#workspace-frame');
  await expect(b.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(featureRow(b, 'Extrude 1')).toHaveCount(1);
  // Tab A adds a second block (Sketch 2, Extrude 2) and saves; tab B adds an Enclosure: its save is refused.
  await addSolid(page, { at: [50, 0, 0] });
  await expect(a.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  await tb(b).locator('[data-command="cfd.enclosure"]').click();
  await expect(panel(b).locator('[data-panel-title]')).toHaveText('Enclosure 1');
  await panel(b).locator('[data-panel-done]').click();
  const chip = b.locator('[data-chip="save"][data-state="conflict"]');
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.getByRole('button', { name: 'Reload' }).click();
  await expect(page2.locator('#workspace-overlay [data-ws-toast]')).toHaveText(/Reloaded the other tab's version: Enclosure 1, made in this tab and not saved, is gone\./, { timeout: 20_000 });
  await expect(featureRow(b, 'Enclosure 1')).toHaveCount(0);
  await expect(featureRow(b, 'Extrude 2')).toHaveCount(1);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
  expect(seen2.csp).toEqual([]);
  const conflict409 = /^Failed to load resource: the server responded with a status of 409 \(Conflict\)/;
  expect(seen2.errors.filter((e) => !conflict409.test(e)), 'console errors (tab 2)').toEqual([]);
  await page2.close();
});
