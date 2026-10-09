// P3 exit gate (proposal §7 "P3: Sketcher", docs/p2p3-plan.md §5.2): sketches
// drawn with the mouse and the keyboard in sketch mode, in the real host frame
// with the real kernel and solver. One test per exit bullet; each asserts what
// the user sees (the DOF chip and panel, line pixels, dimension labels, the
// cursor, shaded regions, the tree, the extrude's volume).
//
//   1. A rectangle from the origin -> "Under defined · 2 DOF". Two dimensions
//      (40, 20) -> "Fully defined", lines #101828.
//   2. A diagonal dimension -> "Make it driven?"; accepting shows it grey, in
//      parentheses "(44.72)".
//   3. A fully defined corner won't drag (the cursor stays the arrow; the panel says why). Deleting a
//      dimension -> "Under defined · 1 DOF", and the corner drags.
//      (1-3 are one story on one sketch; undo inside the sketch, Finish sketch,
//      and the whole session as one undo step follow.)
//   4. Two overlapping circles (drawn: centre click, typed diameter) -> 3 shaded
//      regions. Clicking the middle one and E extrudes it (lens area x 10).
//      Changing a radius (its dimension, 40 -> 50) keeps the same region (the
//      extrude stays green, its volume follows the new lens). A trim that
//      removes the lens -> Extrude 1 red "Profile lost".
//   5. An open chain (an L of two lines) -> the open-profile markers at both ends
//      and "Open profile: 2 open ends".
//   6. A sketch on a box's top face, a circle, Extrude Cut 20 mm into the box ->
//      32,000 - pi·5²·20 mm³.
// window.__CAD__ is used only to project model points to screen pixels, to wait
// for the sketch's solver queue, and to read the drawn geometry for the
// analytic volumes; every action goes through the mouse and the keyboard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, soloVolume, openSketchDetails } from './helpers';
import { PNG } from './png';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

// ---------------------------------------------------------------- helpers

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freshPart(page, request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

const cad = (page, fn, arg) => workspaceFrame(page).evaluate(fn, arg);
const tb = (frame) => frame.locator('[data-cad-toolbar]');
const chip = (frame) => frame.locator('[data-chip="sketch"]');
const featurePanel = (frame) => frame.locator('[data-cad-panel="feature"]');
const sketchRow = (frame) => frame.locator('[data-cad-tree] [data-feature-type="sketch"]');
const extrudeRow = (frame) => frame.locator('[data-cad-tree] [data-feature-type="extrude"]');
const volumeValue = (frame) => soloVolume(frame);

/** Page coordinates of a model point (the viewport's own projection plus the frame's offset). */
async function at(page, p) {
  const xy = await cad(page, (pt) => window.__CAD__.services.viewport.get().handle.project(pt), p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box.x + xy[0], box.y + xy[1]];
}

async function clickAt(page, p, modifiers = []) {
  const [x, y] = await at(page, p);
  // page.mouse.click takes no modifiers: hold them on the keyboard (Ctrl+click adds to the selection).
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(x, y);
  for (const m of modifiers) await page.keyboard.up(m);
}

/** No view transition runs (Look at and the standard views turn the camera with a 320 ms tween). */
async function settled(page) {
  await expect.poll(() => cad(page, () => window.__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

/** Every sketch edit has been solved and stored (sketch mode's queue is empty). */
async function sketchIdle(page) {
  await cad(page, async () => {
    await window.__CAD__.services.apis.get().sketch?.idle?.();
  });
}

/** The sketch being edited: its points and entities (to compute analytic areas from what was drawn). */
const draft = (page) => cad(page, () => window.__CAD__.services.apis.get().sketch.draft());

/** Select the Top plane in the tree, then Sketch: sketch mode on it. */
async function sketchOnTop(page, frame, name = 'Sketch 1') {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-cad-panel="sketch"] [data-panel-title]')).toHaveText(name);
  await settled(page);
}

async function finishSketch(frame) {
  await tb(frame).locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** The darkest pixel within 3 px of a page point, as [r, g, b]. */
async function darkestNear(page, x, y) {
  const img = PNG.decode(await page.screenshot({ clip: { x: x - 3, y: y - 3, width: 7, height: 7 } }));
  let best = [255, 255, 255];
  for (let j = 0; j < img.height; j++)
    for (let i = 0; i < img.width; i++) {
      const k = (j * img.width + i) * 4;
      const px = [img.data[k], img.data[k + 1], img.data[k + 2]];
      if (px[0] + px[1] + px[2] < best[0] + best[1] + best[2]) best = px;
    }
  return best;
}

/** The pixel at a page point, as [r, g, b] (the centre of a 5 x 5 clip). */
async function pixel(page, pt) {
  return PNG.center(await page.screenshot({ clip: { x: Math.round(pt[0]) - 2, y: Math.round(pt[1]) - 2, width: 5, height: 5 } }));
}

const REGION = [0x15, 0x70, 0xef]; // --mg-primary, profiles at 12% (proposal §3.3)
const blend = (src, a, dst) => src.map((v, i) => Math.round(v * a + dst[i] * (1 - a)));
const near = (a, b, tol = 5) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** The shading at a point is the region colour at 12% over what is there without it (`under`). */
async function expectShaded(page, pt, under, message) {
  const want = blend(REGION, 0.12, under);
  await expect.poll(async () => {
    const got = await pixel(page, pt);
    return near(got, want) ? 'ok' : `${got} (want ${want})`;
  }, { message, timeout: 10_000 }).toBe('ok');
}

/** The volume chip's exact figure is `mm3` within `rel`. */
async function expectVolume(frame, mm3, rel = 1e-6) {
  await expect
    .poll(async () => {
      const v = Number(await volumeValue(frame).getAttribute('data-volume-mm3', { timeout: 1000 }).catch(() => NaN));
      return Math.abs(v / mm3 - 1) <= rel ? 'ok' : `${v} (want ${mm3})`;
    }, { timeout: 30_000 })
    .toBe('ok');
}

function lensArea(r1, r2, d) {
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  return a + b - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
}

/** The two circles of the drawn sketch: their radii and the distance between their centres. */
async function twoCircles(page) {
  const d = await draft(page);
  const cs = d.entities.filter((e) => e.kind === 'circle');
  expect(cs).toHaveLength(2);
  const pt = (id) => (id === 'origin' ? [0, 0] : d.points[id]);
  const [a, b] = cs.map((c) => pt(c.c));
  return { r1: cs[0].r, r2: cs[1].r, d: Math.hypot(b[0] - a[0], b[1] - a[1]) };
}

/** A circle: C (if not on), its centre clicked, the diameter typed, Enter. */
async function circle(page, frame, centre, diameter) {
  if (!(await tb(frame).locator('[data-command="sketch.circle"]').evaluate((el) => el.classList.contains('is-active')))) await page.keyboard.press('c');
  await clickAt(page, centre);
  await page.keyboard.type(String(diameter));
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await sketchIdle(page);
}

// ---------------------------------------------------------------- 1-3. DOF, dimensions, driven, drag

test('cad:p3-sketch-dof a rectangle from the origin is "Under defined · 2 DOF"; two dimensions make it "Fully defined" in #101828; a diagonal is driven "(44.72)"; a fully defined corner will not drag; deleting a dimension gives "1 DOF" and it drags', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Sketch is offered with nothing selected (it then waits for a plane or a flat face: SD review
  // round 1, cad-sd-review1.spec.ts); here the plane is selected first.
  await expect(tb(frame).locator('[data-command="sketch.new"]')).not.toHaveAttribute('aria-disabled', 'true');
  await sketchOnTop(page, frame);
  await expect(frame.locator('[data-cad-toolbar="sketch"] .tb-group-label')).toHaveText(['DRAW', 'CONSTRAIN', 'DIMENSION', 'MODIFY', 'SKETCH', 'VIEW', 'EDIT']);
  // Nothing drawn yet: said so (review P2/P3 round 1: an empty sketch read "Fully defined").
  await expect(chip(frame)).toHaveText('No geometry yet');

  // 1. Rectangle (R) from the origin: two DOF left (its width and height).
  await page.keyboard.press('r');
  await expect(tb(frame).locator('[data-command="sketch.rectangle"]')).toHaveClass(/is-active/);
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40.3, 20.2, 0]);
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveText('Under defined · 2 DOF');
  await expect(frame.locator('[data-sketch-glyph="horizontal"]')).toHaveCount(2);
  await expect(frame.locator('[data-sketch-glyph="vertical"]')).toHaveCount(2);

  // Two dimensions: pick a line, place the label, type the value.
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, [20, 0, 0]);
  await clickAt(page, [20, -8, 0]);
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('40');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');
  await clickAt(page, [40, 10, 0]);
  await clickAt(page, [52, 10, 0]);
  await expect(edit).toBeFocused();
  await edit.fill('20');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveText('Fully defined');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm', '20 mm']);
  // Fully defined lines are #101828: the darkest pixel across the top line and across the left line.
  // (Real Chrome draws a line that falls between two pixel rows as two lighter rows: one of the two
  // lines is always on a whole pixel, so the nearer of the two to #101828 is the line's colour.)
  await page.mouse.move(5, 5);
  await settled(page);
  const off = (p) => Math.abs(p[0] - 0x10) + Math.abs(p[1] - 0x18) + Math.abs(p[2] - 0x28);
  const [lx, ly] = await at(page, [12, 20, 0]);
  const [vx, vy] = await at(page, [0, 12, 0]);
  const px = [await darkestNear(page, lx, ly), await darkestNear(page, vx, vy)].sort((a, b) => off(a) - off(b))[0];
  expect(off(px), `line pixel ${px}`).toBeLessThanOrEqual(24);
  await shot(page, 'p3-sketch-fully-defined');

  // 2. A diagonal would over-define it: "Make it driven?" -> grey "(44.72)".
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40, 20, 0]);
  await clickAt(page, [56, 44, 0]);
  const q = frame.locator('[data-sketch-question="driven"]');
  await expect(q).toBeVisible();
  await expect(q.locator('h2')).toHaveText('Make it driven?');
  await expect(q.locator('[data-question-accept]')).toBeFocused();
  await q.locator('[data-question-accept]').click();
  await sketchIdle(page);
  await expect(q).toBeHidden();
  const driven = frame.locator('[data-sketch-dim][data-driving="0"]');
  await expect(driven).toHaveText('(44.72 mm)');
  expect(await driven.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(102, 112, 133)');
  await expect(chip(frame)).toHaveText('Fully defined');
  await shot(page, 'p3-sketch-driven-diagonal');

  // 3. A fully defined corner does not move; the cursor stays the normal arrow, the panel says why.
  await page.keyboard.press('Escape');
  await expect(tb(frame).locator('[data-command="sketch.dimension"]')).not.toHaveClass(/is-active/);
  const [cx, cy] = await at(page, [40, 20, 0]);
  await page.mouse.move(cx, cy);
  await expect.poll(() => frame.locator('[data-cad-canvas]').evaluate((el) => getComputedStyle(el).cursor)).not.toBe('not-allowed');
  expect(await frame.locator('[data-cad-canvas]').evaluate((el) => el.style.cursor)).toMatch(/^(default|auto|)$/);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 40, { steps: 8 });
  await page.mouse.up();
  await sketchIdle(page);
  await expect(driven).toHaveText('(44.72 mm)');
  // The rectangle's corner opposite the origin (the point furthest from it).
  const corner = async () => Object.values((await draft(page)).points).reduce((a, b) => (a[0] + a[1] >= b[0] + b[1] ? a : b));
  expect(await corner()).toEqual([40, 20]);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-run-reason]').first()).toContainText('This point is fully defined: change a dimension to move it');

  // Delete the 20 dimension: one DOF, and the corner drags (the driven diagonal follows).
  await frame.locator('[data-sketch-dim]', { hasText: /^20 mm$/ }).click();
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm', '(44.72 mm)']);
  const [c2x, c2y] = await at(page, [40, 20, 0]);
  await page.mouse.move(c2x, c2y);
  await expect.poll(() => frame.locator('[data-cad-canvas]').evaluate((el) => el.style.cursor)).toBe('move');
  const [tx, ty] = await at(page, [40, 30, 0]);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.up();
  await sketchIdle(page);
  await expect(driven).toHaveText(/^\(5\d(\.\d+)? mm\)$/);
  const moved = await corner();
  expect(moved[0]).toBeCloseTo(40, 6);
  expect(moved[1]).toBeGreaterThan(25);
  await shot(page, 'p3-sketch-dragged');

  // Undo inside the sketch: the drag, then the delete; redo the delete.
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  await expect(driven).toHaveText('(44.72 mm)');
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await page.keyboard.press('Control+y');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');

  // Finish sketch: the tree row says under defined; Ctrl+Z removes the whole session, Ctrl+Y brings it back.
  await finishSketch(frame);
  await expect(chip(frame)).toHaveCount(0);
  await expect(sketchRow(frame).locator('> .tree-row .tl')).toHaveText('(-) Sketch 1');
  await page.keyboard.press('Control+z');
  await expect(sketchRow(frame)).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(sketchRow(frame).locator('> .tree-row .tl')).toHaveText('(-) Sketch 1');
  // Reopened, the sketch is as it was left.
  await sketchRow(frame).locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm', '(44.72 mm)']);
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 4. regions, extrude, same region, Profile lost

test('cad:p3-sketch-regions two overlapping circles give 3 shaded regions; the middle one extrudes; a new radius keeps the same region; a trim that removes it is "Profile lost"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // Two circles of diameter 40: centres at the origin and 30 mm along X.
  await circle(page, frame, [0, 0, 0], 40);
  await circle(page, frame, [30, 0, 0], 40);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['⌀40 mm', '⌀40 mm']);
  const g = await twoCircles(page);
  expect(g.r1).toBeCloseTo(20, 9);
  expect(g.r2).toBeCloseTo(20, 9);
  // Three regions (two crescents and the lens), each shaded once; outside both circles nothing.
  await page.mouse.move(5, 5);
  await settled(page);
  await expect
    .poll(() => cad(page, () => {
      const s = window.__CAD__.services.doc.state.get();
      const o = s.session ? s.rebuild.outputs[s.session.feature] : null;
      return o && o.type === 'sketch' ? o.regions.length : -1;
    }), { timeout: 20_000 })
    .toBe(3);
  // Points off the sketch grid's lines (every 10 mm, and finer when zoomed in).
  const outside = await pixel(page, await at(page, [-17.3, 27.7, 0]));
  for (const p of [[-12.3, 7.7], [15.3, 3.7], [42.7, 7.3]]) await expectShaded(page, await at(page, [p[0], p[1], 0]), outside, `region at ${p} shaded`);
  await shot(page, 'p3-sketch-overlapping-circles-regions');
  await finishSketch(frame);

  // The lens, clicked in the view, then E: Extrude 1 with that one profile, 10 mm.
  await clickAt(page, [g.d / 2, 5, 0]);
  await expect.poll(() => cad(page, () => window.__CAD__.services.selection.get().items.map((i) => i.kind))).toEqual(['region']);
  await page.keyboard.press('e');
  const p = featurePanel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(p.locator('[data-profile-list] [data-profile]')).toHaveCount(1);
  const lens = lensArea(g.r1, g.r2, g.d);
  expect(Number(await p.locator('[data-profile-area]').getAttribute('data-profile-area'))).toBeCloseTo(lens, 6);
  await expect(p.locator('.nui[data-field="distance"] input')).toHaveValue('10');
  await expectVolume(frame, lens * 10);
  await p.locator('[data-panel-done]').click();
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'ok');
  const keyOf = () => cad(page, () => window.__CAD__.services.doc.state.get().doc.features.find((f) => f.type === 'extrude').profiles[0].region);
  const key = await keyOf();
  await shot(page, 'p3-sketch-lens-extruded');

  // A new radius: the second circle's dimension 40 -> 50 (double-click its label in the sketch).
  await sketchRow(frame).locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
  await frame.locator('[data-sketch-dim]').nth(1).dblclick();
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('50');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['⌀40 mm', '⌀50 mm']);
  const g2 = await twoCircles(page);
  expect(g2.r2).toBeCloseTo(25, 9);
  await finishSketch(frame);
  // The same region: the extrude is still green, uses the same key, and follows the new lens.
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'ok');
  expect(await keyOf()).toBe(key);
  await expectVolume(frame, lensArea(g2.r1, g2.r2, g2.d) * 10);
  await extrudeRow(frame).locator('> .tree-row').dblclick();
  await expect(featurePanel(frame).locator('[data-profile-list] [data-profile]')).toHaveAttribute('data-profile-state', 'ok');
  await featurePanel(frame).locator('[data-panel-done]').click();

  // Trim the arc of the second circle inside the first: the lens is gone -> "Profile lost".
  await sketchRow(frame).locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
  await page.keyboard.press('t');
  await expect(tb(frame).locator('[data-command="sketch.trim"]')).toHaveClass(/is-active/);
  await clickAt(page, [g2.d - g2.r2, 0, 0]);
  await sketchIdle(page);
  expect((await draft(page)).entities.map((e) => e.kind).sort()).toEqual(['arc', 'circle']);
  await finishSketch(frame);
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'error');
  await expect(extrudeRow(frame).locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', "What's wrong: Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone");
  await extrudeRow(frame).locator('> .tree-row').dblclick();
  await expect(featurePanel(frame).locator('[data-profile-list] [data-profile]')).toHaveAttribute('data-profile-state', 'lost');
  await expect(featurePanel(frame).locator('[data-run-reason] .mgk-reason-msg')).toHaveText('Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone');
  await shot(page, 'p3-sketch-profile-lost');
  await featurePanel(frame).locator('[data-panel-done]').click();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 5. open chain

test('cad:p3-sketch-open-profile an open L of two lines shows a marker at each open end and "Open profile: 2 open ends"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // Line (L): three clicks make two chained lines; Escape ends the chain.
  await page.keyboard.press('l');
  await clickAt(page, [10, 10, 0]);
  await clickAt(page, [50, 10.4, 0]);
  await clickAt(page, [50.3, 30, 0]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  expect((await draft(page)).entities.map((e) => e.kind)).toEqual(['line', 'line']);
  await expect(frame.locator('[data-chip="open-profile"]')).toHaveText('Open profile: 2 open ends');
  const markers = frame.locator('[data-open-end]');
  await expect(markers).toHaveCount(2);
  // Each marker sits on its open end (the drawn ends, as solved).
  const d = await draft(page);
  const lines = d.entities.filter((e) => e.kind === 'line');
  const ends = [d.points[lines[0].p[0]], d.points[lines[1].p[1]]];
  await page.mouse.move(5, 5);
  for (let i = 0; i < 2; i++) {
    const box = await markers.nth(i).boundingBox();
    const centre = [box.x + box.width / 2, box.y + box.height / 2];
    const dists = await Promise.all(ends.map(async (e) => {
      const w = await at(page, [e[0], e[1], 0]);
      return Math.hypot(centre[0] - w[0], centre[1] - w[1]);
    }));
    expect(Math.min(...dists), `marker ${i}`).toBeLessThan(4);
  }
  await shot(page, 'p3-sketch-open-profile');
  await finishSketch(frame);
  // No closed profile: Extrude says why; the chip speaks for the selected sketch.
  await expect(tb(frame).locator('[data-command="solid.extrude"]')).toHaveAttribute('data-disabled-reason', 'Draw a closed profile in a sketch first');
  await sketchRow(frame).locator('> .tree-row').click();
  await expect(frame.locator('[data-chip="open-profile"]')).toHaveText('Open profile: 2 open ends');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- 6. sketch on a face, extrude cut

test('cad:p3-sketch-face-cut a sketch on the top face of a 40 x 40 x 20 block, a circle of diameter 10, Extrude Cut 20 mm into the block: 32,000 - pi·25·20 mm³', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // The block: Sketch 1 (40 x 40 on Top) and Extrude 1, 20 mm (there is no Box since decision 2026-10-01).
  await addSolid(page, { size: [40, 40, 20] });
  await expectVolume(frame, 32000);
  await settled(page);
  // Its top face, then Sketch: the sketch faces it.
  await clickAt(page, [30, 30, 20]);
  await tb(frame).locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  // The face as Measure names it (review P2/P3 round 4: "Face of Body 1" said which body only); ux010: under Details.
  await openSketchDetails(page, frame);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-plane]')).toHaveText(/^Face \d+ of Body 1$/);
  await settled(page);
  await circle(page, frame, [20, 20, 20], 10);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['⌀10 mm']);
  await finishSketch(frame);
  // The circle's region, E, Cut, flipped into the block, 20 mm.
  await clickAt(page, [20, 21, 20]);
  await expect.poll(() => cad(page, () => window.__CAD__.services.selection.get().items.map((i) => i.kind))).toEqual(['region']);
  await page.keyboard.press('e');
  const p = featurePanel(frame);
  await expect(p.locator('[data-panel-title]')).toHaveText('Extrude 2');
  await p.locator('[data-field="op"] select').selectOption('cut');
  await p.locator('input[data-field="flip"]').check();
  const dist = p.locator('.nui[data-field="distance"] input');
  await dist.fill('20');
  await dist.press('Enter');
  const want = 32000 - Math.PI * 25 * 20;
  await expectVolume(frame, want);
  await expect(frame.locator('[data-chip="volume"]')).toContainText('30,429.2 mm³');
  await shot(page, 'p3-sketch-face-cut');
  await p.locator('[data-panel-done]').click();
  await expect(extrudeRow(frame)).toHaveCount(2);
  await expect(extrudeRow(frame).last()).toHaveAttribute('data-state', 'ok');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
