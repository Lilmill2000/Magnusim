// P2+P3 review round 1 (INTEGRATE): one test per blocker, each asserting what
// the user sees and failing without its fix:
//  1. refused-delete   A sketch an extrude uses: its panel shows no Delete, and a
//                      Delete from the tree is refused in words while the sketch
//                      keeps the line just drawn (it was thrown away), also after Finish.
//  2. driven-enter     Enter on "Make it driven?" places the driven dimension and
//                      stays in the sketch (it ran Finish sketch behind the dialog);
//                      Escape cancels and stays too.
//  3. line-chain       Two typed chain segments (20 Tab 90, 15 Tab 0) store those
//                      lengths and angles (the second went into the old Angle box),
//                      and A after a typed segment makes a tangent arc.
//  4. arc-radius       A 3-point arc's typed radius below half the chord keeps the
//                      box with "Radius must be at least 20 mm"; 25 Enter makes an
//                      R25 arc in sketch mode (the box vanished, keys ran shortcuts).
//  5. import-cancel    Cancel while the kernel reads a STEP frees the kernel at
//                      once: a block is built within seconds (it waited for the read).
//  6. toolbar-fit      At 1280 x 800 and 1440 x 900, in model and sketch mode, every
//                      command button lies inside the frame (Undo, Redo and views
//                      were scrolled out of reach).
//  7. split-piece-name A consumed split piece in Combine's Tools list reads
//                      "flange (2)" (it read "A deleted body").
//  8. measure-plane    A face picked in the viewport plus the Top plane picked in
//                      the tree measure their distance and angle (the panel ignored
//                      the tree and kept measuring the face alone).
// The round's coverage gaps and polish:
//  9. sketch-tools     Center rectangle, Point, Centerline, Tangent arc, Extend and
//                      Look at (no test drew with them).
// 10. constraints      All twelve CONSTRAIN commands, selected first, hold in the
//                      solved sketch (only Equal and Parallel were clicked).
// 11. combine-no-change A Cut whose tool only touches fails in words; a Join whose
//                      tool lies inside says it adds nothing (both passed silently).
// 12. words            Delete on 2 edges ("A edge"), an empty sketch ("Fully
//                      defined"), "Delete selected", keyboard-reachable glyphs, a
//                      Split switched to a face without the stale error.
// 13. import-words     A STEP that does not knit: "not a closed solid", Check
//                      "Open" in amber, "raise the tolerance"; no "Loaded from the
//                      stored healed shapes" right after an import.
// 14. unsolvable      Dimensions that cannot all hold are listed (red) with a
//                      one-click delete (only "Not solved" showed, every edit refused).
// 15. import-cancel-big (opt-in CAD_E2E_BIG_STEP) the reviewer's case itself.
// window.__CAD__ is used only to project model points to the screen, to wait for
// sketch edits, to read what the sketch stores, and the kernel's busy op, and
// (helpers.ts addSolid) to set sketched blocks and a cylinder up: there is no Box
// or Cylinder since decision 2026-10-01.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, runCommand } from './helpers';
import { PNG } from './png';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLANGE = join(resolve(HERE, '..', 'fixtures', 'kernel'), 'flange.step');
const SHOTS = process.env.CAD_E2E_SHOTS || '';

type V3 = [number, number, number];
type Pt = [number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
interface Draft {
  points: Record<string, Pt>;
  entities: { id: string; kind: string; p?: string[]; c?: string; a?: string; b?: string }[];
  constraints: { id: string; kind: string; refs: string[]; expr?: string; driving?: boolean }[];
}

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

async function moveTo(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y, { steps: 2 });
}

async function settled(page: Page) {
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true)).toBe(false);
}

/**
 * Zoom out (the wheel, in the middle of the free view) until these model points are in the
 * view and clear of the tree and the panel, as a user does before drawing past what is framed.
 * Since round 4 a sketch is framed on what it holds, and the origin planes' 100 mm square
 * reaches only to the edge of a 1600 px view.
 */
async function inView(page: Page, frame: FrameLocator, pts: V3[]) {
  for (let i = 0; i < 30; i++) {
    const stage = (await frame.locator('.cad-stage').boundingBox())!;
    const cards = [await frame.locator('[data-cad-tree]').boundingBox(), (await frame.locator('[data-cad-panel]').count()) ? await frame.locator('[data-cad-panel]').first().boundingBox() : null];
    const left = Math.max(stage.x, ...cards.map((c) => (c ? c.x + c.width : 0))) + 30;
    const right = stage.x + stage.width - 30;
    let ok = true;
    for (const p of pts) {
      const [x, y] = await at(page, p);
      if (x < left || x > right || y < stage.y + 30 || y > stage.y + stage.height - 70) ok = false;
    }
    if (ok) return;
    await page.mouse.move((left + right) / 2, stage.y + stage.height / 2);
    await page.mouse.wheel(0, 120);
    await settled(page);
  }
  throw new Error(`could not bring ${JSON.stringify(pts)} into the view`);
}

async function sketchIdle(page: Page) {
  await cad(page, async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  });
}

/** What the open sketch stores now (sketch mode's session draft). */
const draft = (page: Page) => cad<Draft>(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.draft());

/** The stored sketch feature by name (after Finish). */
const storedSketch = (page: Page, name: string) =>
  cad<Draft | null, string>(page, (n) => (window as unknown as W).__CAD__.services.doc.state.get().doc.features.find((f: { name: string }) => f.name === n) ?? null, name);

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

/** A history row by its name (a sketch's row starts with its state: "(-) Sketch 1"). */
const featureRow = (frame: FrameLocator, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** A line's length and angle (degrees) as stored. */
function lineGeo(d: Draft, id: string) {
  const e = d.entities.find((x) => x.id === id)!;
  const [a, b] = e.p!.map((p) => (p === 'origin' ? ([0, 0] as Pt) : d.points[p]));
  return { len: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

/** A rectangle from the origin to (40, 20) dimensioned 40 x 20 (fully defined), as the P3 gate draws it. */
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

// ---------------------------------------------------------------- 1

test('cad:p2p3-review1-refused-delete a sketch an extrude uses shows no Delete; a refused Delete keeps the line just drawn, also after Finish', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40, 20, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  // A new sketch can be discarded: its Delete is there.
  await expect(panel(frame).locator('[data-panel-delete]')).toBeVisible();
  await finishSketch(frame);
  // Extrude 1 from the rectangle's region.
  await clickAt(page, [20, 10, 0]);
  await page.keyboard.press('e');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 1');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');

  // Edit Sketch 1 and draw a line beside the rectangle.
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
  await inView(page, frame, [[60, 0, 0], [60, 30, 0]]);
  await page.keyboard.press('l');
  await clickAt(page, [60, 0, 0]);
  await clickAt(page, [60, 30, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect((await draft(page)).entities.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line', 'line']);
  // Extrude 1 uses Sketch 1: no Delete in its panel (Daniel's rule: Delete only when something can be removed).
  await expect(panel(frame).locator('[data-panel-delete]')).toHaveCount(0);
  await expect(panel(frame).locator('[data-panel-done]')).toBeVisible();

  // Delete from the tree's menu: offered disabled, the reason beside it (review round 2: it was
  // offered and only the click said no); a click does nothing, the panel and the line stay.
  await featureRow(frame, 'Sketch 1').locator('> .tree-row').click({ button: 'right' });
  const del = frame.locator('[data-cad-menu] [data-menu-item="delete"]');
  await expect(del).toHaveAttribute('aria-disabled', 'true');
  await del.hover();
  await expect(frame.locator('[data-cad-tip]')).toContainText('Extrude 1 uses Sketch 1: delete Extrude 1 or change what it uses first');
  await del.click({ force: true });
  await expect(frame.locator('[data-cad-menu]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-menu]')).toHaveCount(0);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await sketchIdle(page);
  expect((await draft(page)).entities.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line', 'line']);
  await shot(page, 'r1-refused-delete');
  // Finish stores the line.
  await finishSketch(frame);
  expect((await storedSketch(page, 'Sketch 1'))!.entities).toHaveLength(5);
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');

  // Extrude 1 is used by nothing: its panel shows Delete.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Extrude 1');
  await expect(panel(frame).locator('[data-panel-delete]')).toBeVisible();
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 2

test('cad:p2p3-review1-driven-enter Enter on "Make it driven?" places the driven dimension and stays in the sketch; Escape cancels and stays', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await definedRectangle(page, frame, 60, 20);
  const q = frame.locator('[data-sketch-question="driven"]');

  // The diagonal from (0, 0) to (60, 20): Escape on the question places nothing and stays.
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [60, 20, 0]);
  await clickAt(page, [76, 40, 0]);
  await expect(q).toBeVisible();
  await expect(q.locator('.cad-sk-dialog-copy')).toHaveText('Distance 63.25 mm would over-define Sketch 1. A driven dimension shows the value without holding it.');
  await expect(q.locator('[data-question-accept]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(q).toBeHidden();
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['60', '20']);

  // Again, and Enter: the focused "Make it driven" is pressed.
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [60, 20, 0]);
  await clickAt(page, [76, 40, 0]);
  await expect(q).toBeVisible();
  await expect(q.locator('[data-question-accept]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(q).toBeHidden();
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  const driven = frame.locator('[data-sketch-dim][data-driving="0"]');
  await expect(driven).toHaveText('(63.25)');
  expect(await driven.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(102, 112, 133)');
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Fully defined');
  await shot(page, 'r1-driven-enter');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect((await storedSketch(page, 'Sketch 1'))!.constraints.filter((c) => c.driving === false)).toHaveLength(1);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 3

test('cad:p2p3-review1-line-chain two typed chain segments store their own lengths and angles; A after a typed segment makes a tangent arc', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const length = frame.locator('[data-sketch-box="length"]');
  const angle = frame.locator('[data-sketch-box="angle"]');
  await page.keyboard.press('l');
  await clickAt(page, [5, 5, 0]);
  await moveTo(page, [20, 12, 0]);
  await expect(length).toBeVisible();
  // Segment 1: 20, Tab, 90, Enter.
  await page.keyboard.type('20');
  await expect(length).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(angle).toBeFocused();
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  // The boxes let go: nothing typed, they follow the pointer again.
  await expect(length).not.toBeFocused();
  await expect(angle).not.toBeFocused();
  // (From the end at (5, 25) to (25, 30): 14.04 degrees.)
  await moveTo(page, [25, 30, 0]);
  await expect(angle).toHaveValue('14.04');
  // Segment 2: 15, Tab, 0, Enter (the digits start in Length again).
  await page.keyboard.type('15');
  await expect(length).toBeFocused();
  await expect(length).toHaveValue('15');
  await page.keyboard.press('Tab');
  await expect(angle).toBeFocused();
  await page.keyboard.type('0');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  let d = await draft(page);
  const lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(2);
  const g1 = lineGeo(d, lines[0].id);
  const g2 = lineGeo(d, lines[1].id);
  expect(g1.len).toBeCloseTo(20, 6);
  expect(g1.ang).toBeCloseTo(90, 6);
  expect(g2.len).toBeCloseTo(15, 6);
  expect(g2.ang).toBeCloseTo(0, 6);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['20', '90°', '15', '0°']);
  expect(d.constraints.filter((c) => c.kind === 'distance' || c.kind === 'angle').map((c) => c.expr)).toEqual(['20 mm', '90 deg', '15 mm', '0 deg']);

  // A: the next segment is a tangent arc (A reached the tool, not a box).
  await page.keyboard.press('a');
  await expect(frame.locator('[data-sketch-line-arc]')).toBeChecked();
  await expect(length).toHaveCount(0);
  await clickAt(page, [30, 35, 0]);
  await sketchIdle(page);
  d = await draft(page);
  expect(d.entities.map((e) => e.kind)).toEqual(['line', 'line', 'arc']);
  const arc = d.entities[2];
  expect(d.constraints.some((c) => c.kind === 'tangent' && c.refs.includes(lines[1].id) && c.refs.includes(arc.id))).toBe(true);
  await shot(page, 'r1-line-chain');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 4

test('cad:p2p3-review1-arc-radius a 3-point arc: a radius below half the chord keeps the box and says the least; 25 Enter makes an R25 arc in sketch mode', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await inView(page, frame, [[80, 20, 0], [120, 20, 0], [100, 32, 0]]);
  await page.keyboard.press('a');
  await expect(tb(frame).locator('[data-command="sketch.arc"]')).toHaveClass(/is-active/);
  await clickAt(page, [80, 20, 0]);
  await clickAt(page, [120, 20, 0]);
  await moveTo(page, [100, 32, 0]);
  const box = frame.locator('[data-sketch-box="radius"]');
  await expect(box).toBeVisible();
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-hint]')).toHaveText('Click a point the arc passes through, or type its radius and Enter.');
  // "2": too small for a 40 mm chord. The box stays (with the keyboard) and says why.
  await page.keyboard.press('2');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('2');
  // Half the chord as clicked (40 mm give or take the click's pixel), rounded up.
  await expect(frame.locator('[data-sketch-box-error="radius"]')).toHaveText(/^Radius must be at least 20(\.0\d)? mm$/);
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  // Enter now places nothing and keeps the sketch open.
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(box).toBeFocused();
  await expect(frame.locator('[data-cad-panel="sketch"] [data-run-reason]')).toContainText(/Not applied: Radius must be at least 20(\.0\d)? mm/);
  await shot(page, 'r1-arc-radius-small');
  // "5": 25 mm, valid.
  await page.keyboard.press('5');
  await expect(box).toHaveValue('25');
  await expect(frame.locator('[data-sketch-box-error="radius"]')).toBeHidden();
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  const d = await draft(page);
  expect(d.entities.map((e) => e.kind)).toEqual(['arc']);
  const a = d.entities[0];
  const c = d.points[a.c!];
  const p1 = d.points[a.a!];
  const p2 = d.points[a.b!];
  expect(Math.hypot(p1[0] - c[0], p1[1] - c[1])).toBeCloseTo(25, 6);
  expect(Math.hypot(p2[0] - c[0], p2[1] - c[1])).toBeCloseTo(25, 6);
  expect(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])).toBeCloseTo(40, 3);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['R25']);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 5

test('cad:p2p3-review1-import-cancel Cancel while the kernel reads a STEP frees it at once: a Box is built within seconds', async ({ page, request }) => {
  // A slow read, as a large STEP's: the kernel worker's module (as served to this page only) holds
  // every import_step for 40 s before reading. Nothing else in the worker changes.
  await page.context().route('**/plugins/cad/workspace/kernel/kernel-worker.js', async (route) => {
    const r = await route.fetch();
    const slow = [
      '{',
      '  const add = self.addEventListener.bind(self);',
      "  self.addEventListener = (type, fn, opts) => add(type, type === 'message' ? (ev) => {",
      "    const m = ev.data;",
      "    if (m && m.type === 'call' && m.op === 'import_step') { const until = Date.now() + 40000; while (Date.now() < until) {} }",
      '    fn(ev);',
      '  } : fn, opts);',
      '}',
    ].join('\n');
    await route.fulfill({ response: r, body: `${slow}\n${await r.text()}` });
  });
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(FLANGE);
  const stage = panel(frame).locator('[data-import-stage]');
  await expect(stage).toHaveText(/^Reading flange\.step · \d+ s$/, { timeout: 30_000 });
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.kernel.status.get().busy)).toBe('import_step');
  await page.waitForTimeout(1500);
  await panel(frame).locator('[data-import-cancel]').click();
  const t0 = Date.now();
  await expect(panel(frame)).toHaveCount(0);
  await expect(featureRow(frame, 'Imported 1 (flange.step)')).toHaveCount(0);
  // The kernel is not reading any more, and a block (a sketch, its profile, an extrude) is made at once.
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.kernel.status.get().busy), { timeout: 8000 }).not.toBe('import_step');
  await addSolid(page);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³', { timeout: 10_000 });
  const took = Date.now() - t0;
  expect(took, `the block took ${took} ms after Cancel`).toBeLessThan(10_000);
  await expect(featureRow(frame, 'Extrude 1')).toHaveAttribute('data-state', 'ok');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 6

async function expectToolbarFits(page: Page, frame: FrameLocator, where: string) {
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  const vp = page.viewportSize()!;
  const right = Math.min(fr.x + fr.width, vp.width);
  // Command buttons and the groups' More buttons (P4a: what does not fit is in a More menu).
  const buttons = frame.locator('[data-cad-toolbar] [data-command], [data-cad-toolbar] [data-tb-more]');
  const n = await buttons.count();
  expect(n, `${where}: commands on the toolbar`).toBeGreaterThan(10);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const r = (await b.boundingBox())!;
    if (!r || r.x < fr.x - 0.5 || r.x + r.width > right + 0.5) out.push(`${(await b.getAttribute('data-command')) ?? (await b.getAttribute('aria-label'))} at ${Math.round(r?.x ?? -1)}..${Math.round((r?.x ?? 0) + (r?.width ?? 0))}`);
  }
  expect(out, `${where}: buttons outside the frame (right edge ${Math.round(right)})`).toEqual([]);
  const scroll = await frame.locator('[data-cad-toolbar]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(scroll.sw, `${where}: the toolbar scrolls`).toBeLessThanOrEqual(scroll.cw + 1);
}

test('cad:p2p3-review1-toolbar-fit at 1280 x 800 and 1440 x 900 every command button lies inside the frame, in model and sketch mode', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { seen, frame } = await freshPart(page, request);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
    await expectToolbarFits(page, frame, `model mode at ${size.width}`);
    await shot(page, `r1-toolbar-model-${size.width}`);
    await sketchOnTop(page, frame);
    await expectToolbarFits(page, frame, `sketch mode at ${size.width}`);
    await shot(page, `r1-toolbar-sketch-${size.width}`);
    // The labels stay as the tooltip and the accessible name.
    await expect(frame.locator('[data-command="sketch.redo"]')).toHaveAttribute('aria-label', 'Redo');
    await finishSketch(frame);
  }
  // Wide enough (1920 px, P4a): every modelling command labelled, none in a More menu; VIEW and
  // EDIT keep their icons (their labels are the tooltips).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(frame.locator('[data-cad-toolbar="model"]')).toHaveAttribute('data-folded', '0');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toHaveAttribute('data-fit', '1');
  await expect(frame.locator('[data-cad-toolbar] [data-tb-more]')).toHaveCount(0);
  await expect(frame.locator('[data-command="modify.parameters"] .tb-txt')).toBeVisible();
  await expect(frame.locator('[data-command="edit.undo"]')).toHaveAttribute('aria-label', 'Undo');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 7

test('cad:p2p3-review1-split-piece-name a split piece used up by a Combine Join is listed by its name, "flange (2)"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(FLANGE);
  await expect(panel(frame).locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await panel(frame).locator('[data-panel-done]').click();
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  const bodies = frame.locator('[data-cad-tree] [data-body-row]');
  // Split by the Right plane: flange and flange (2).
  await runCommand(frame, 'modify.split');
  await bodies.first().locator('.tree-row').first().click();
  await expect(panel(frame).locator('[data-split-pieces]')).toHaveText('2 bodies', { timeout: 30_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await expect(bodies.locator('.cad-body-name')).toHaveText(['flange', 'flange (2)']);
  // Combine Join: target flange, tool flange (2).
  await runCommand(frame, 'modify.combine');
  const p = panel(frame);
  await p.locator('[data-field="op"] select').selectOption('join');
  await p.locator('[data-pick-list="targets"]').click();
  await bodies.nth(0).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodies.nth(1).locator('.tree-row').first().click();
  await expect(frame.locator('[data-cad-tree] [data-bodies-folder] > .tree-row .tl')).toHaveText('Bodies (1)', { timeout: 30_000 });
  await expect(p.locator('[data-pick-field="tools"] [data-pick-row] .cad-pick-name')).toHaveText(['flange (2)']);
  await expect(p.locator('[data-pick-field="targets"] [data-pick-row] .cad-pick-name')).toHaveText(['flange']);
  await shot(page, 'r1-split-piece-name');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'ok');
  // Reopened, the list still names it.
  await featureRow(frame, 'Combine 1').locator('> .tree-row').dblclick();
  await expect(panel(frame).locator('[data-pick-field="tools"] [data-pick-row] .cad-pick-name')).toHaveText(['flange (2)']);
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 8

test('cad:p2p3-review1-measure-plane Measure takes the Top plane picked in the tree: a block top face and the Top plane are 20 mm apart at 0°', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A 20 mm block, sketched and extruded.
  await addSolid(page);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');
  await settled(page);
  await tb(frame).locator('[data-command="inspect.measure"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-tool-panel="inspect.measure"]')).toBeVisible();
  await clickAt(page, [10, 10, 20]);
  await expect(p.locator('[data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-measure-value="a.area"]')).toHaveText('400 mm²', { timeout: 30_000 });
  // The Top plane from the tree (planes are not drawn once the part has a body).
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await expect(p.locator('[data-pick-row]')).toHaveCount(2);
  await expect(p.locator('[data-pick-row]').nth(1)).toContainText('Top plane');
  await expect(p.locator('[data-measure-value="distance"]')).toHaveText('20 mm', { timeout: 30_000 });
  await expect(p.locator('[data-measure-value="angle"]')).toHaveText('0°');
  // The viewport shows what the panel measures: both picks are the selection.
  const sel = await cad<string[]>(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind));
  expect(sel).toEqual(['face', 'origin']);
  await shot(page, 'r1-measure-plane');
  // A feature row clicked meanwhile measures nothing new and the viewport goes back to the picks.
  await featureRow(frame, 'Extrude 1').locator('> .tree-row').click();
  await expect(p.locator('[data-pick-row]')).toHaveCount(2);
  await expect.poll(() => cad<string[]>(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['face', 'origin']);
  await p.locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- coverage: the sketch tools no test drew with

/** Where to click a sketch item: a point at itself, a line 40% along, a circle on its rim. */
function spot(d: Draft, ref: string): V3 {
  const pt = (id: string): Pt => (id === 'origin' ? [0, 0] : d.points[id]);
  const e = d.entities.find((x) => x.id === ref);
  if (!e) {
    const p = pt(ref);
    return [p[0], p[1], 0];
  }
  if (e.kind === 'point') return [...pt((e as unknown as { p: string }).p), 0] as V3;
  if (e.kind === 'line') {
    const [a, b] = e.p!.map(pt);
    return [a[0] + (b[0] - a[0]) * 0.4, a[1] + (b[1] - a[1]) * 0.4, 0];
  }
  if (e.kind === 'circle') {
    const c = pt(e.c!);
    const r = (e as unknown as { r: number }).r;
    return [c[0] + r * Math.cos(1), c[1] + r * Math.sin(1), 0];
  }
  throw new Error(`no spot for ${ref}`);
}

/** The entity a drawing step added (the newest of its kind). */
const newest = (d: Draft, kind: string) => [...d.entities].reverse().find((e) => e.kind === kind)!;

/** Draw one line with the Line tool (Ctrl: no inferred relations), ending the chain. */
async function drawLine(page: Page, a: Pt, b: Pt) {
  await page.keyboard.down('Control');
  await clickAt(page, [a[0], a[1], 0]);
  await clickAt(page, [b[0], b[1], 0]);
  await page.keyboard.up('Control');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
}

async function drawCircle(page: Page, c: Pt, r: number) {
  await page.keyboard.down('Control');
  await clickAt(page, [c[0], c[1], 0]);
  await clickAt(page, [c[0] + r, c[1], 0]);
  await page.keyboard.up('Control');
  await sketchIdle(page);
}

/** Select sketch items by clicking them (Ctrl for the second and later), then run a CONSTRAIN command. */
async function constrain(page: Page, frame: FrameLocator, kind: string, refs: string[]) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const d = await draft(page);
  for (let i = 0; i < refs.length; i++) {
    const [x, y] = await at(page, spot(d, refs[i]));
    if (i) await page.keyboard.down('Control');
    await page.mouse.move(x + 2, y + 2);
    await page.mouse.click(x, y);
    if (i) await page.keyboard.up('Control');
  }
  const btn = tb(frame).locator(`[data-command="sketch.${kind}"]`);
  await expect(btn, `${kind}: ${await btn.getAttribute('data-disabled-reason')}`).not.toHaveAttribute('aria-disabled', 'true');
  const before = (await draft(page)).constraints.filter((c) => c.kind === kind).length;
  await btn.click();
  await sketchIdle(page);
  const after = await draft(page);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-run-reason]'), `${kind} was refused`).toHaveCount(0);
  expect(after.constraints.filter((c) => c.kind === kind).length, `${kind} added`).toBeGreaterThan(before);
  return after;
}

const P = (d: Draft, id: string): Pt => (id === 'origin' ? [0, 0] : d.points[id]);
const ends = (d: Draft, id: string): [Pt, Pt] => {
  const e = d.entities.find((x) => x.id === id)!;
  return [P(d, e.p![0]), P(d, e.p![1])];
};
const dir = (d: Draft, id: string): Pt => {
  const [a, b] = ends(d, id);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};
const len = (d: Draft, id: string) => {
  const [a, b] = ends(d, id);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

test('cad:p2p3-review1-sketch-tools Center rectangle, Point, Centerline, Tangent arc, Extend and Look at draw and store what they say', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  const t = tb(frame);
  await inView(page, frame, [[100, 30, 0], [110, 36, 0], [100, -20, 0], [80, -35, 0], [120, -35, 0], [0, 40, 0], [35, 55, 0], [60, 10, 0], [85, 0, 0], [85, 20, 0]]);

  // Center rectangle: the centre, then a corner: 4 lines symmetric about a construction centre point.
  await runCommand(frame, 'sketch.rectangle-center');
  await clickAt(page, [100, 30, 0]);
  await clickAt(page, [110, 36, 0]);
  await sketchIdle(page);
  let d = await draft(page);
  expect(d.entities.map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line', 'point']);
  expect((d.entities[4] as unknown as { construction?: boolean }).construction).toBe(true);
  const sym = d.constraints.find((c) => c.kind === 'symmetric')!;
  expect(sym).toBeTruthy();
  const [s1, s2] = [P(d, sym.refs[0]), P(d, sym.refs[1])];
  expect((s1[0] + s2[0]) / 2).toBeCloseTo(100, 3);
  expect((s1[1] + s2[1]) / 2).toBeCloseTo(30, 3);
  expect(Math.abs(s1[0] - s2[0])).toBeCloseTo(20, 3);
  expect(Math.abs(s1[1] - s2[1])).toBeCloseTo(12, 3);

  // Point.
  await runCommand(frame, 'sketch.point');
  await clickAt(page, [100, -20, 0]);
  await sketchIdle(page);
  d = await draft(page);
  const pe = newest(d, 'point') as unknown as { p: string };
  expect(P(d, pe.p)[0]).toBeCloseTo(100, 0);
  expect(P(d, pe.p)[1]).toBeCloseTo(-20, 0);

  // Centerline: a construction line, drawn dashed.
  await runCommand(frame, 'sketch.centerline');
  await clickAt(page, [80, -35, 0]);
  await clickAt(page, [120, -35, 0]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await draft(page);
  const cl = newest(d, 'line') as unknown as { construction?: boolean; centerline?: boolean };
  expect(cl.construction).toBe(true);
  expect(cl.centerline).toBe(true);

  // A line, then the Tangent arc tool from its end: an arc with a tangent relation to the line.
  await page.keyboard.press('l');
  await drawLine(page, [0, 40], [20, 40]);
  d = await draft(page);
  const base = newest(d, 'line');
  await runCommand(frame, 'sketch.arc-tangent');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-hint]')).toHaveText('Click the end of a line or an arc to start a tangent arc.');
  await clickAt(page, [...ends(d, base.id)[1], 0] as V3);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-hint]')).toHaveText('Click where the tangent arc ends.');
  await clickAt(page, [35, 55, 0]);
  await sketchIdle(page);
  d = await draft(page);
  const arc = newest(d, 'arc');
  expect(arc).toBeTruthy();
  expect(d.constraints.some((c) => c.kind === 'tangent' && c.refs.includes(base.id) && c.refs.includes(arc.id))).toBe(true);

  // Extend: a free end runs to the next curve (a line at x = 85).
  await page.keyboard.press('l');
  await drawLine(page, [60, 10], [70, 10]);
  d = await draft(page);
  const short = newest(d, 'line');
  await drawLine(page, [85, 0], [85, 20]);
  await runCommand(frame, 'sketch.extend');
  await clickAt(page, [69, 10, 0]);
  await sketchIdle(page);
  d = await draft(page);
  const [, end] = ends(d, short.id);
  expect(end[0]).toBeCloseTo(85, 4);
  expect(end[1]).toBeCloseTo(10, 1);
  await shot(page, 'r1-sketch-tools');

  // Look at: from the iso view back to straight down at the sketch.
  await page.keyboard.press('Escape');
  await t.locator('[data-command="view.iso"]').click();
  await settled(page);
  const down = () =>
    cad<number>(page, () => {
      const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
      const v = c.target.map((x: number, i: number) => x - c.position[i]);
      return v[2] / Math.hypot(...v);
    });
  expect(await down()).toBeGreaterThan(-0.99);
  await t.locator('[data-command="view.sketch-look"]').click();
  await settled(page);
  expect(await down()).toBeLessThan(-0.999);
  await finishSketch(frame);
  // In model mode the centerline is dashed too (it looked solid): along it, columns of the line and
  // columns of background between the dashes.
  await page.mouse.move(5, 5);
  await settled(page);
  const [x0, y0] = await at(page, [85, -35, 0]);
  const [x1] = await at(page, [115, -35, 0]);
  const strip = PNG.decode(await page.screenshot({ clip: { x: Math.round(x0), y: Math.round(y0) - 3, width: Math.round(x1 - x0), height: 7 } }));
  const darkest: number[] = [];
  // The background: the brightest pixel of the strip (its rows above and below the line).
  let bg = 0;
  for (let i = 0; i < strip.width; i++) {
    let m = 765;
    for (let j = 0; j < strip.height; j++) {
      const k = (j * strip.width + i) * 4;
      const v = strip.data[k] + strip.data[k + 1] + strip.data[k + 2];
      m = Math.min(m, v);
      bg = Math.max(bg, v);
    }
    darkest.push(m);
  }
  const line = darkest.filter((v) => v < bg - 60).length;
  const gap = darkest.filter((v) => v >= bg - 10).length;
  expect(line, `line columns along the centerline (${darkest.join(',')})`).toBeGreaterThan(10);
  expect(gap, `background columns between dashes (${darkest.join(',')})`).toBeGreaterThan(5);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-constraints each CONSTRAIN command, selected first, holds in the solved sketch', async ({ page, request }) => {
  test.setTimeout(360_000);
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // Geometry drawn with Ctrl (no inferred relations), apart from each other, between u = -65 and 65
  // (the sketch is framed beside the tree and the Sketch panel, its origin in the middle of the rest).
  await page.keyboard.press('l');
  await drawLine(page, [-60, 5], [-40, 11]); // L1
  await drawLine(page, [-30, 0], [-25, 18]); // L2
  await drawLine(page, [-15, 0], [5, 4]); // L3
  await drawLine(page, [-15, 12], [3, 22]); // L4
  await drawLine(page, [-15, -20], [5, -14]); // L5
  await drawLine(page, [-55, 50], [-15, 52]); // L6 (tangent to C1)
  await drawLine(page, [-65, -30], [-45, -31]); // L7
  await drawLine(page, [-35, -27], [-20, -26]); // L8 (collinear with L7)
  await drawLine(page, [15, 50], [35, 56]); // L9 (midpoint)
  await drawLine(page, [25, -40], [65, -40]); // L10 (mirror line)
  let d = await draft(page);
  const [L1, L2, L3, L4, L5, L6, L7, L8, L9, L10] = d.entities.filter((e) => e.kind === 'line').map((e) => e.id);
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await drawCircle(page, [-35, 66], 8); // C1
  await drawCircle(page, [45, -10], 5); // C2
  await drawCircle(page, [48, -9], 9); // C3 (its centre clear of C2's rim, where C2 is clicked)
  d = await draft(page);
  const [C1, C2, C3] = d.entities.filter((e) => e.kind === 'circle').map((e) => e.id);
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.point');
  for (const p of [
    [35, 20],
    [45, 30],
    [20, 40],
    [35, -30],
    [55, -48],
    [65, 20],
  ] as Pt[]) {
    await page.keyboard.down('Control');
    await clickAt(page, [p[0], p[1], 0]);
    await page.keyboard.up('Control');
  }
  await sketchIdle(page);
  d = await draft(page);
  const [Q1, Q2, R, S1, S2, T] = d.entities.filter((e) => e.kind === 'point').map((e) => e.id);
  const pointOf = (d0: Draft, id: string) => P(d0, (d0.entities.find((e) => e.id === id) as unknown as { p: string }).p);

  d = await constrain(page, frame, 'horizontal', [L1]);
  expect(ends(d, L1)[0][1]).toBeCloseTo(ends(d, L1)[1][1], 6);
  d = await constrain(page, frame, 'vertical', [L2]);
  expect(ends(d, L2)[0][0]).toBeCloseTo(ends(d, L2)[1][0], 6);
  d = await constrain(page, frame, 'perpendicular', [L3, L4]);
  expect(dir(d, L3)[0] * dir(d, L4)[0] + dir(d, L3)[1] * dir(d, L4)[1]).toBeCloseTo(0, 6);
  d = await constrain(page, frame, 'parallel', [L3, L5]);
  expect(dir(d, L3)[0] * dir(d, L5)[1] - dir(d, L3)[1] * dir(d, L5)[0]).toBeCloseTo(0, 6);
  d = await constrain(page, frame, 'equal', [L1, L2]);
  expect(len(d, L1)).toBeCloseTo(len(d, L2), 6);
  d = await constrain(page, frame, 'coincident', [Q1, Q2]);
  expect(Math.hypot(pointOf(d, Q1)[0] - pointOf(d, Q2)[0], pointOf(d, Q1)[1] - pointOf(d, Q2)[1])).toBeCloseTo(0, 6);
  d = await constrain(page, frame, 'midpoint', [R, L9]);
  const [m0, m1] = ends(d, L9);
  expect(pointOf(d, R)[0]).toBeCloseTo((m0[0] + m1[0]) / 2, 6);
  expect(pointOf(d, R)[1]).toBeCloseTo((m0[1] + m1[1]) / 2, 6);
  d = await constrain(page, frame, 'tangent', [L6, C1]);
  {
    const [a, b] = ends(d, L6);
    const c1 = d.entities.find((e) => e.id === C1)!;
    const ctr = P(d, c1.c!);
    const dist = Math.abs((b[0] - a[0]) * (a[1] - ctr[1]) - (a[0] - ctr[0]) * (b[1] - a[1])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
    expect(dist).toBeCloseTo((c1 as unknown as { r: number }).r, 6);
  }
  d = await constrain(page, frame, 'concentric', [C2, C3]);
  {
    const [a, b] = [C2, C3].map((id) => P(d, d.entities.find((e) => e.id === id)!.c!));
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(0, 6);
  }
  d = await constrain(page, frame, 'collinear', [L7, L8]);
  {
    const [a, b] = ends(d, L7);
    for (const q of ends(d, L8)) expect((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])).toBeCloseTo(0, 4);
  }
  d = await constrain(page, frame, 'symmetric', [S1, S2, L10]);
  {
    const [a, b] = [pointOf(d, S1), pointOf(d, S2)];
    const [u0, u1] = ends(d, L10);
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // The middle lies on the mirror line, and the two points are square to it.
    expect((u1[0] - u0[0]) * (m[1] - u0[1]) - (u1[1] - u0[1]) * (m[0] - u0[0])).toBeCloseTo(0, 4);
    expect((u1[0] - u0[0]) * (b[0] - a[0]) + (u1[1] - u0[1]) * (b[1] - a[1])).toBeCloseTo(0, 4);
  }
  const dof0 = await cad<number>(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.state.get().status.dof);
  d = await constrain(page, frame, 'fix', [T]);
  const fx = d.constraints.find((c) => c.kind === 'fix' && c.refs.includes((d.entities.find((e) => e.id === T) as unknown as { p: string }).p))!;
  expect(fx).toBeTruthy();
  await expect.poll(() => cad<number>(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.state.get().status.dof)).toBe(dof0 - 2);
  // Every relation shows its glyph.
  for (const k of ['horizontal', 'vertical', 'perpendicular', 'parallel', 'equal', 'coincident', 'midpoint', 'tangent', 'concentric', 'collinear', 'symmetric', 'fix']) {
    await expect(frame.locator(`[data-sketch-glyph="${k}"]`).first(), `the ${k} glyph`).toBeVisible();
  }
  await shot(page, 'r1-constraints');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- polish

test('cad:p2p3-review1-combine-no-change a Cut whose tool only touches is refused in words; a Join whose tool lies inside says it adds nothing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // Blocks, sketched and extruded (there is no Box since decision 2026-10-01).
  const addBlock = (origin: V3, size: V3) => addSolid(page, { at: origin, size });
  await addBlock([0, 0, 0], [20, 20, 20]);
  await addBlock([20, 0, 0], [20, 20, 20]); // touches Body 1's +X face
  await addBlock([5, 5, 5], [4, 4, 4]); // inside Body 1
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  const bodies = frame.locator('[data-cad-tree] [data-body-row]');
  await expect(bodies).toHaveCount(3);
  // Cut Body 1 by Body 2: nothing to cut.
  await runCommand(frame, 'modify.combine');
  let p = panel(frame);
  await p.locator('[data-field="op"] select').selectOption('cut');
  await p.locator('[data-pick-list="targets"]').click();
  await bodies.nth(0).locator('.tree-row').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  await bodies.nth(1).locator('.tree-row').first().click();
  await expect(p.locator('[data-run-reason]')).toContainText('Combine 1 failed: Nothing to cut: Body 2 does not overlap Body 1 (touching is not enough)', { timeout: 30_000 });
  // The failed feature changes nothing: Body 2 is still there.
  await expect(bodies).toHaveCount(3);
  await shot(page, 'r1-combine-touching-cut');
  // As a Join with the small block inside instead: amber, it adds nothing.
  await p.locator('[data-field="op"] select').selectOption('join');
  await p.locator('[data-pick-field="tools"] [data-pick-remove]').first().click();
  await p.locator('[data-pick-list="tools"]').click();
  // (The Join with Body 2 used it up meanwhile: the rows are found by name.)
  await bodies.filter({ has: frame.locator('.cad-body-name', { hasText: /^Body 3$/ }) }).locator('.tree-row').first().click();
  await expect(p.locator('.mgk-hint--warning')).toHaveText('Body 3 lies inside Body 1: joining adds nothing', { timeout: 30_000 });
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Combine 1')).toHaveAttribute('data-state', 'warning');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-words plain words: Delete on edges, an empty sketch, the sketch panel buttons, keyboard glyphs, a split switched to a face', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const toast = page.locator('#workspace-overlay [data-ws-toast]');
  // An empty sketch is not "Fully defined".
  await sketchOnTop(page, frame);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('No geometry yet');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveText('No geometry yet');
  // Two lines, Equal: the glyph is a button the keyboard reaches; Space selects it, Delete deletes it.
  await page.keyboard.press('l');
  await drawLine(page, [0, 20], [30, 20]);
  await drawLine(page, [0, 40], [20, 46]);
  await page.keyboard.press('Escape');
  const d = await draft(page);
  const [a, b] = d.entities.map((e) => e.id);
  await constrain(page, frame, 'equal', [a, b]);
  const glyph = frame.locator('[data-sketch-glyph="equal"]').first();
  await expect(glyph).toHaveAttribute('role', 'button');
  await expect(glyph).toHaveAttribute('aria-label', /^Equal: /);
  await page.keyboard.press('Escape');
  await glyph.focus();
  await page.keyboard.press('Space');
  await expect(glyph).toHaveAttribute('aria-pressed', 'true');
  // The panel's own Delete says what it deletes (the foot Delete is the sketch's).
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-action="delete"]')).toHaveText('Delete selected');
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-glyph="equal"]')).toHaveCount(0);
  await finishSketch(frame);

  // Delete with two edges selected: "These 2 edges", not "A edge". A 20 mm block (Sketch 2, Extrude 1).
  await addSolid(page);
  await settled(page);
  await page.keyboard.press('Escape');
  await clickAt(page, [10, 0, 20]);
  const [ex, ey] = await at(page, [0, 10, 20]);
  await page.keyboard.down('Control');
  await page.mouse.click(ex, ey);
  await page.keyboard.up('Control');
  await expect.poll(() => cad<string[]>(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['edge', 'edge']);
  await page.keyboard.press('Delete');
  await expect(toast).toHaveText(/These 2 edges cannot be deleted on their own\. To remove them, delete Extrude 1 in the history\./);

  // Split by the Right plane on a block it does not cut, then "Plane of a flat face": the old error goes.
  await page.keyboard.press('Escape');
  await addSolid(page, { at: [50, 0, 0] });
  const folder = frame.locator('[data-cad-tree] [data-bodies-folder]');
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('> .tree-row .tw').click();
  await runCommand(frame, 'modify.split');
  const sp = panel(frame);
  await frame.locator('[data-cad-tree] [data-body-row]').nth(1).locator('.tree-row').first().click();
  await expect(sp.locator('[data-run-reason]')).toContainText('does not cut', { timeout: 30_000 });
  await sp.locator('[data-field="tool-kind"] select').selectOption('face');
  await expect(sp.locator('[data-run-reason]')).toHaveText(['Pick a flat face to split with']);
  await sp.locator('[data-panel-delete]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-import-words a STEP that does not knit at 0.001 mm: "not a closed solid", Check "Open", "raise the tolerance"; at 0.01 mm a valid solid', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(join(resolve(HERE, '..', 'fixtures', 'kernel'), 'box20-gap.step'));
  const p = panel(frame);
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 60_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  // Right after the import the panel does not claim it loaded stored shapes.
  await expect(p.locator('[data-import-output]')).toHaveCount(0);
  await expect(p.locator('[data-switch="knit"] input')).toBeChecked();
  await p.locator('[data-import-heal]').click();
  await expect(p.locator('[data-import-healed]')).toHaveText('Healed at 0.001 mm, knit', { timeout: 60_000 });
  await expect(p.locator('[data-import-diagnostics]')).toHaveText(/ · not a closed solid$/);
  await expect(p.locator('[data-import-check]')).toHaveText(['Open']);
  // In the warning colour, as the lines below it (a table cell's own colour won before).
  const warn = await p.locator('[data-import-loose]').evaluate((el) => getComputedStyle(el).color);
  expect(await p.locator('[data-import-check]').evaluate((el) => getComputedStyle(el).color)).toBe(warn);
  await expect(p.locator('[data-import-shells]')).toHaveText('1 surface body: the faces did not knit at 0.001 mm: raise the tolerance and Heal all again');
  await shot(page, 'r1-import-gap-0.001');
  const tol = p.locator('.nui[data-field="tolerance"] input');
  await tol.fill('0.01');
  await tol.press('Enter');
  await p.locator('[data-import-heal]').click();
  await expect(p.locator('[data-import-healed]')).toHaveText('Healed at 0.01 mm, knit', { timeout: 60_000 });
  await expect(p.locator('[data-import-check]')).toHaveText(['Valid']);
  await expect(p.locator('[data-import-diagnostics]')).not.toHaveText(/not a closed solid/);
  await expect(p.locator('[data-import-shells]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-unsolvable a triangle whose sides cannot hold (10, 7.81, 30): the panel lists its dimensions in red; one click deletes the 30 and the sketch solves', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A stored sketch whose dimensions no triangle can have (opened as the session starts, as the over-defined gate test does).
  await cad(page, () => {
    (window as unknown as W).__CAD__.services.doc.beginNew('sketch', {
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: { a: [10, 10], b: [20, 10], c: [15, 16] },
      entities: [
        { id: 'l1', kind: 'line', p: ['a', 'b'] },
        { id: 'l2', kind: 'line', p: ['b', 'c'] },
        { id: 'l3', kind: 'line', p: ['c', 'a'] },
      ],
      constraints: [
        { id: 'd1', kind: 'distance', refs: ['l1'], expr: '10 mm', driving: true, at: [15, 4] },
        { id: 'd2', kind: 'distance', refs: ['l2'], expr: '7.81 mm', driving: true, at: [22, 16] },
        { id: 'd3', kind: 'distance', refs: ['l3'], expr: '30 mm', driving: true, at: [8, 16] },
      ],
      solved: { values: { d1: 10, d2: 7.81, d3: 30 }, dof: 3, state: 'unsolved' },
    });
  });
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Not solved: the constraints cannot all hold');
  const list = frame.locator('[data-sketch-conflicts]');
  await expect(list.locator('.cad-field-group-title')).toHaveText('Dimensions that cannot all hold');
  await expect(list.locator('li')).toHaveCount(3);
  await expect(frame.locator('[data-sketch-dim="d3"]')).toHaveClass(/is-over/);
  await shot(page, 'r1-unsolvable');
  await frame.locator('[data-conflict-delete="d3"]').click();
  await sketchIdle(page);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText(/^Under defined · \d+ DOF$/);
  await expect(list).toHaveCount(0);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['10', '7.81']);
  // New geometry is taken again.
  await inView(page, frame, [[40, 0, 0], [60, 0, 0]]);
  await page.keyboard.press('l');
  await clickAt(page, [40, 0, 0]);
  await clickAt(page, [60, 0, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  expect((await draft(page)).entities).toHaveLength(4);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-press-pull-curved Press-pull says why a click on a curved face picks nothing', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A cylinder: a circle of diameter 20 on Top, extruded 20 mm.
  await addSolid(page, { circle: true, size: [20, 20] });
  await expect(frame.locator('[data-chip="volume"]')).toContainText('mm³');
  await settled(page);
  const r = 10;
  await runCommand(frame, 'modify.press-pull');
  const p = panel(frame);
  // The side of the cylinder, on the side the camera sees (default view from -x, -y).
  const side: V3 = [-r * Math.SQRT1_2, -r * Math.SQRT1_2, 5];
  await clickAt(page, side);
  await expect(p.locator('[data-pick-error="faces"]')).toHaveText('Press-pull works on flat faces: that face is curved');
  await expect(p.locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(0);
  await p.locator('[data-panel-delete]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p2p3-review1-import-cancel-big (opt-in CAD_E2E_BIG_STEP) Cancel 3 s into reading the 113 MB STEP: the kernel is free at once and a block is built within seconds', async ({ page, request }) => {
  const big = process.env.CAD_E2E_BIG_STEP || '';
  test.skip(!big, 'opt-in: set CAD_E2E_BIG_STEP to the 113 MB STEP (8m0119333_V12.step)');
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  const name = big.split(/[\\/]/).pop()!;
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(big);
  const stage = panel(frame).locator('[data-import-stage]');
  await expect(stage).toHaveText(new RegExp(`^Reading ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ([3-9]|\\d\\d) s$`), { timeout: 120_000 });
  await panel(frame).locator('[data-import-cancel]').click();
  const t0 = Date.now();
  await expect(panel(frame)).toHaveCount(0);
  await expect.poll(() => cad(page, () => (window as unknown as W).__CAD__.services.kernel.status.get().busy), { timeout: 8000 }).not.toBe('import_step');
  await addSolid(page);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³', { timeout: 15_000 });
  const took = Date.now() - t0;
  // (It took 36.5 s before: the next action waited for the read to end.)
  expect(took, `the block took ${took} ms after Cancel`).toBeLessThan(15_000);
  console.log(`[r1] block built ${took} ms after Cancel of the 113 MB read`);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
