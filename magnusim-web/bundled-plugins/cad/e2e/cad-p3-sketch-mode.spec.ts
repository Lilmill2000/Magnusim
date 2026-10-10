// Sketch mode in the real host frame (P3-SKETCH's e2e drafts for the P3 exit
// gate, docs/p2p3-plan.md §5.2 items 1-5 and 11): a sketch on the Top plane
// turns the camera and swaps the toolbar; a rectangle from the origin is
// "Under defined · 2 DOF"; two dimensions typed in their value boxes make it
// "Fully defined" with lines in #101828; a diagonal asks "Make it driven?" and
// shows grey "(44.72)"; a fully defined corner does not move (cursor
// the normal arrow, the panel says why; follow-up 2026-10-06); deleting a dimension gives "Under defined · 1 DOF" and the
// corner drags; Undo inside the sketch steps back; Finish sketch, then Ctrl+Z
// removes the whole sketch session and Ctrl+Y brings it back. Also: Escape
// never finishes a sketch; typed lengths and angles become dimensions; trim;
// constraint glyphs are selectable and deletable; no console errors.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame, openSketchDetails, showAllRelations } from './helpers';
import { PNG } from './png';

const SHOTS = process.env.CAD_E2E_SHOTS || '';

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

type V3 = [number, number, number];

/** Page coordinates of a model point (the viewport's own projection plus the frame's offset). */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project(pt) : null;
  }, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

/** Waits until no view transition runs (Look at turns the camera with a 320 ms tween). */
async function settled(page: Page) {
  await expect
    .poll(() =>
      workspaceFrame(page).evaluate(() => {
        const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { state: { get(): { animating: boolean } } } | null } } } } }).__CAD__.services.viewport.get().handle;
        return h ? h.state.get().animating : true;
      }),
    )
    .toBe(false);
}

/** Every sketch edit has been solved and stored (sketch mode's queue is empty). */
async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch;
    await api?.idle?.();
  });
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await at(page, p);
  await page.mouse.click(x, y);
}

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  const tb = frame.locator('[data-cad-toolbar]');
  await tb.locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-cad-panel="sketch"] [data-panel-title]')).toHaveText('Sketch 1');
  await settled(page);
}

/** The darkest pixel within 3 px of a page point, as "r,g,b". */
async function darkestNear(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: x - 3, y: y - 3, width: 7, height: 7 } });
  const img = PNG.decode(png);
  let best = [255, 255, 255];
  for (let j = 0; j < img.height; j++)
    for (let i = 0; i < img.width; i++) {
      const k = (j * img.width + i) * 4;
      const px = [img.data[k], img.data[k + 1], img.data[k + 2]];
      if (px[0] + px[1] + px[2] < best[0] + best[1] + best[2]) best = px;
    }
  return best;
}

const chip = (frame: FrameLocator) => frame.locator('[data-chip="sketch"]');

test('cad:p3-sketch-rectangle-dof a rectangle from the origin, two dimensions, a driven diagonal, drag, undo, Finish sketch and the session undo', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');

  // Sketch is offered with nothing selected: it then waits for a plane or a flat face (SD review
  // round 1; cad-sd-review1.spec.ts tests the waiting). Here the plane is selected first.
  await expect(tb.locator('[data-command="sketch.new"]')).not.toHaveAttribute('aria-disabled', 'true');
  await enterSketchOnTop(page, frame);
  // Sketch mode: DRAW / CONSTRAIN / DIMENSION / MODIFY, Finish sketch as the primary button, VIEW, EDIT (the sketch's own undo).
  await expect(frame.locator('[data-cad-toolbar="sketch"] .tb-group-label')).toHaveText(['DRAW', 'CONSTRAIN', 'DIMENSION', 'MODIFY', 'SKETCH', 'VIEW', 'SCALE MODELS', 'EDIT']);
  await expect(tb.locator('[data-group="primary"] [data-command="sketch.finish"]')).toHaveClass(/is-primary/);
  await expect(tb.locator('[data-group="edit"] [data-command]')).toHaveCount(2);
  await expect(tb.locator('[data-command="sketch.undo"]')).toHaveAttribute('aria-disabled', 'true');
  // The camera looks straight down at the Top plane.
  const dir = await workspaceFrame(page).evaluate(() => {
    const c = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { camera(): { position: number[]; target: number[] } } } } } } }).__CAD__.services.viewport.get().handle.camera();
    const d = c.target.map((v, i) => v - c.position[i]);
    const l = Math.hypot(...d);
    return d.map((v) => v / l);
  });
  expect(dir[2]).toBeLessThan(-0.999);
  // The whole toolbar fits the frame (no command scrolled out of reach).
  const finish = await tb.locator('[data-command="sketch.finish"]').boundingBox();
  const redo = await tb.locator('[data-command="sketch.redo"]').boundingBox();
  const frameBox = await page.locator('#workspace-frame').boundingBox();
  expect(finish!.x + finish!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
  expect(redo!.x + redo!.width).toBeLessThanOrEqual(frameBox!.x + frameBox!.width);
  // Nothing drawn yet: said so (review P2/P3 round 1: an empty sketch read "Fully defined").
  await expect(chip(frame)).toHaveText('No geometry yet');
  await shot(page, 'sketch-1-entered');

  // Rectangle (R) from the origin.
  await page.keyboard.press('r');
  await expect(tb.locator('[data-command="sketch.rectangle"]')).toHaveClass(/is-active/);
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40.3, 20.2, 0]);
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  // ux010 (DRAW): relations show for the selection only by default; this test reads every glyph.
  await showAllRelations(page);
  await expect(frame.locator('[data-sketch-glyph="horizontal"]')).toHaveCount(2);
  await expect(frame.locator('[data-sketch-glyph="vertical"]')).toHaveCount(2);
  await expect(frame.locator('[data-sketch-glyph="coincident"]')).toHaveCount(1);
  await shot(page, 'sketch-2-rectangle');

  // Two dimensions: pick the line, place the label, type the value.
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  await clickAt(page, [20, 0, 0]);
  await clickAt(page, [20, -8, 0]);
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('40');
  await edit.press('Enter');
  await sketchIdle(page);
  await clickAt(page, [40, 10, 0]);
  await clickAt(page, [52, 10, 0]);
  await expect(edit).toBeFocused();
  await edit.fill('20');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm', '20 mm']);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveText('Fully defined');
  // Fully defined lines are #101828: the darkest pixel across the top line and across the left line.
  // (Real Chrome draws a line that falls between two pixel rows as two lighter rows: one of the two
  // lines is always on a whole pixel, so the nearer of the two to #101828 is the line's colour.)
  await page.mouse.move(5, 5);
  await settled(page);
  const off = (p: number[]) => Math.abs(p[0] - 0x10) + Math.abs(p[1] - 0x18) + Math.abs(p[2] - 0x28);
  const [lx, ly] = await at(page, [12, 20, 0]);
  const [vx, vy] = await at(page, [0, 12, 0]);
  const px = [await darkestNear(page, lx, ly), await darkestNear(page, vx, vy)].sort((a, b) => off(a) - off(b))[0];
  expect(off(px), `line pixel ${px}`).toBeLessThanOrEqual(24);
  await shot(page, 'sketch-3-fully');

  // A diagonal dimension would over-define it: "Make it driven?" -> grey "(44.72)".
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
  await shot(page, 'sketch-4-driven');

  // A fully defined corner does not move. The cursor stays the normal arrow (Daniel, 2026-10-06: no
  // "not-allowed" in sketches), and the panel says why in words.
  await page.keyboard.press('Escape');
  await expect(tb.locator('[data-command="sketch.dimension"]')).not.toHaveClass(/is-active/);
  const [cx, cy] = await at(page, [40, 20, 0]);
  await page.mouse.move(cx, cy);
  await expect.poll(() => frame.locator('[data-cad-canvas]').evaluate((el) => getComputedStyle(el as HTMLElement).cursor)).not.toBe('not-allowed');
  expect(await frame.locator('[data-cad-canvas]').evaluate((el) => (el as HTMLElement).style.cursor)).toMatch(/^(default|auto|)$/);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy - 40, { steps: 8 });
  await page.mouse.up();
  await sketchIdle(page);
  await expect(driven).toHaveText('(44.72 mm)');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-run-reason]').first()).toContainText('This point is fully defined: change a dimension to move it');

  // Delete the 20 dimension: 1 DOF, and the corner drags (the driven diagonal follows).
  await frame.locator('[data-sketch-dim]', { hasText: /^20 mm$/ }).click();
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');
  await expect(frame.locator('[data-sketch-dim]')).toHaveCount(2);
  const [c2x, c2y] = await at(page, [40, 20, 0]);
  await page.mouse.move(c2x, c2y);
  // ux010 (DRAW): the sketch's own open hand (an SVG, the grab keyword as its fallback).
  await expect.poll(() => frame.locator('[data-cad-canvas]').evaluate((el) => (el as HTMLElement).style.cursor)).toMatch(/url\("data:image\/svg\+xml,.*, grab$/);
  const [tx, ty] = await at(page, [40, 30, 0]);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.up();
  await sketchIdle(page);
  await expect(driven).toHaveText(/^\(5\d(\.\d+)? mm\)$/);
  await shot(page, 'sketch-5-dragged');

  // Undo inside the sketch: the drag, then the delete.
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  await expect(driven).toHaveText('(44.72 mm)');
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await page.keyboard.press('Control+y');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');

  // Finish sketch: model mode, Sketch 1 in the history; Ctrl+Z removes the whole session, Ctrl+Y brings it back.
  await tb.locator('[data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await expect(chip(frame)).toHaveCount(0);
  const rows = frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');
  await expect(rows).toHaveText([/Sketch 1$/]);
  await page.keyboard.press('Control+z');
  await expect(rows).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(rows).toHaveText([/Sketch 1$/]);
  // Editing it again opens sketch mode on the stored sketch (the state comes back with it).
  await frame.locator('[data-cad-tree] [data-feature-row] > .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(chip(frame)).toHaveText('Under defined · 1 DOF');
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm', '(44.72 mm)']);
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-sketch-escape-typed Escape never finishes a sketch; typed length and angle become dimensions; trim; glyphs select and delete', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  await enterSketchOnTop(page, frame);
  const panel = frame.locator('[data-cad-panel="sketch"]');

  // Line (L): start, then type 25, Tab, 30, Enter (Fusion's value boxes).
  await page.keyboard.press('l');
  await clickAt(page, [5, 5, 0]);
  const [mx, my] = await at(page, [20, 10, 0]);
  await page.mouse.move(mx, my);
  await expect(frame.locator('[data-sketch-box="length"]')).toBeVisible();
  await page.keyboard.type('25');
  await expect(frame.locator('[data-sketch-box="length"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(frame.locator('[data-sketch-box="angle"]')).toBeFocused();
  await page.keyboard.type('30');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['25 mm', '30°']);
  const geo = await workspaceFrame(page).evaluate(() => {
    const s = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { points: Record<string, number[]>; entities: { kind: string; p: string[] }[] } } } } } } }).__CAD__.services.apis.get().sketch.draft();
    const l = s.entities.find((e) => e.kind === 'line')!;
    const [a, b] = l.p.map((id) => s.points[id]);
    return { len: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
  });
  expect(geo.len).toBeCloseTo(25, 6);
  expect(geo.ang).toBeCloseTo(30, 6);

  // Escape (from the value box): ends the chain; again: ends the tool; then nothing more: the sketch stays open.
  await page.keyboard.press('Escape');
  await expect(tb.locator('[data-command="sketch.line"]')).toHaveClass(/is-active/);
  await page.keyboard.press('Escape');
  await expect(tb.locator('[data-command="sketch.line"]')).not.toHaveClass(/is-active/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  // Escape in a value box drops the shape being drawn, not the sketch.
  await page.keyboard.press('c');
  await clickAt(page, [60, 0, 0]);
  await page.keyboard.type('12');
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-sketch-box="diameter"]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();

  // Two overlapping circles (C): r 20 at (60, 0) and (90, 0); trim the arc inside the first one.
  await page.keyboard.press('c');
  await clickAt(page, [60, 0, 0]);
  await clickAt(page, [80, 0, 0]);
  await clickAt(page, [90, 0, 0]);
  await clickAt(page, [110, 0, 0]);
  await sketchIdle(page);
  const kinds = () =>
    workspaceFrame(page).evaluate(() =>
      (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { entities: { kind: string }[] } } } } } } }).__CAD__.services.apis
        .get()
        .sketch.draft()
        .entities.map((e) => e.kind),
    );
  expect(await kinds()).toEqual(['line', 'circle', 'circle']);
  await page.keyboard.press('t');
  await clickAt(page, [70, 0, 0]);
  await sketchIdle(page);
  expect(await kinds()).toEqual(['line', 'circle', 'arc']);
  // ux010 (DRAW): relations show for the selection only by default; this test reads every glyph.
  await showAllRelations(page);
  await expect(frame.locator('[data-sketch-glyph="point_on_circle"]')).toHaveCount(2);
  // Undo the trim inside the sketch.
  await tb.locator('[data-command="sketch.undo"]').click();
  await sketchIdle(page);
  expect(await kinds()).toEqual(['line', 'circle', 'circle']);

  // A constraint from the toolbar (select first): Equal on the two circles shows its glyphs; a glyph selects and deletes.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await clickAt(page, [60, 20, 0]);
  const [ex, ey] = await at(page, [90, -20, 0]);
  await page.keyboard.down('Control');
  await page.mouse.click(ex, ey);
  await page.keyboard.up('Control');
  await expect(tb.locator('[data-command="sketch.equal"]')).not.toHaveAttribute('aria-disabled', 'true');
  await tb.locator('[data-command="sketch.equal"]').click();
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-glyph="equal"]')).toHaveCount(2);
  await frame.locator('[data-sketch-glyph="equal"]').first().click();
  await expect(frame.locator('[data-sketch-glyph="equal"]').first()).toHaveClass(/is-selected/);
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-glyph="equal"]')).toHaveCount(0);
  // Without a fitting selection the command says what to select.
  await expect(tb.locator('[data-command="sketch.parallel"]')).toHaveAttribute('data-disabled-reason', 'Select two lines');
  await shot(page, 'sketch-6-trim-equal');

  // Right-click a line: the sketch's own menu (Construction, Delete, Look at sketch, Finish sketch); Construction dashes it.
  const [rx, ry] = await at(page, [15.83, 11.25, 0]);
  await page.mouse.click(rx, ry, { button: 'right' });
  const menu = frame.locator('[data-cad-menu] [data-menu-item]');
  // P4b SELECT: Construction is a state item; "Look at sketch" is "Normal to" (one name everywhere).
  await expect(menu).toHaveText(['Construction', 'Delete', 'Normal to', 'Finish sketch']);
  await frame.locator('[data-cad-menu] [data-menu-item="construction"]').click();
  await sketchIdle(page);
  const construction = await workspaceFrame(page).evaluate(
    () =>
      (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { entities: { kind: string; construction?: boolean }[] } } } } } } }).__CAD__.services.apis
        .get()
        .sketch.draft()
        .entities.find((e) => e.kind === 'line')?.construction,
  );
  expect(construction).toBe(true);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-sketch-face-parameter a sketch on a block face faces it; a dimension takes a parameter, and a new parameter value re-solves it in the solver worker', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const tb = frame.locator('[data-cad-toolbar]');
  // A parameter for the hole (set up through the document; the Parameters panel has its own tests).
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { addParam(p: object): unknown } } } }).__CAD__.services.doc;
    doc.addParam({ name: 'd_hole', expr: '10 mm', quantity: 'length' });
  });
  // A 20 mm block (Sketch 1 extruded: there is no Box since decision 2026-10-01), then its top face.
  await addSolid(page);
  await expect(frame.locator('[data-chip="volume"]')).toHaveText('Volume8000 mm³');
  await settled(page);
  await clickAt(page, [10, 10, 20]);
  await expect(tb.locator('[data-command="sketch.new"]')).not.toHaveAttribute('aria-disabled', 'true');
  await tb.locator('[data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  // The face as Measure names it (review P2/P3 round 4: "Face of Body 1" said which body only); ux010: under Details.
  await openSketchDetails(page, frame);
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-plane]')).toHaveText(/^Face \d+ of Body 1$/);
  await settled(page);
  const dir = await workspaceFrame(page).evaluate(() => {
    const c = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { camera(): { position: number[]; target: number[] } } } } } } }).__CAD__.services.viewport.get().handle.camera();
    const d = c.target.map((v, i) => v - c.position[i]);
    const l = Math.hypot(...d);
    return d.map((v) => v / l);
  });
  expect(dir[2]).toBeLessThan(-0.999);

  // The sketch grid lies in the face's plane but behind it: the face's edges stay whole where a grid line
  // crosses them (the grid was once drawn over coplanar edges, breaking them up).
  await page.mouse.move(5, 5);
  const [gx, gy] = await at(page, [0, 10, 20]);
  const crossing = PNG.center(await page.screenshot({ clip: { x: Math.round(gx) - 2, y: Math.round(gy) - 2, width: 5, height: 5 } }));
  expect(crossing[0] + crossing[1] + crossing[2], `edge pixel where a grid line crosses: ${crossing}`).toBeLessThan(300);

  // A circle on the face (its frame: origin above the global origin, X along X).
  await page.keyboard.press('c');
  await clickAt(page, [10, 10, 20]);
  await clickAt(page, [15, 10, 20]);
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');
  // Its diameter is the parameter.
  await page.keyboard.press('d');
  await clickAt(page, [15, 10, 20]);
  await clickAt(page, [19, 17, 20]);
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('d_hole');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['fx: ⌀10 mm']);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  await shot(page, 'sketch-7-face');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();

  // A new parameter value: the rebuild re-solves the sketch in the solver worker (not the stored shape).
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { params: { id: string; name: string }[] } } }; updateParam(id: string, p: object): unknown } } } }).__CAD__.services.doc;
    const p = doc.state.get().doc.params.find((x) => x.name === 'd_hole')!;
    doc.updateParam(p.id, { expr: '16 mm' });
  });
  const solved = () =>
    workspaceFrame(page).evaluate(() => {
      const s = (window as unknown as { __CAD__: { services: { doc: { state: { get(): { doc: { features: { id: string; type: string }[] }; rebuild: { outputs: Record<string, { source: string; radii: Record<string, number> }> } } } } } } }).__CAD__.services.doc.state.get();
      // The face's sketch: the last one (Sketch 1 is the block's).
      const f = s.doc.features.filter((x) => x.type === 'sketch').pop()!;
      const out = s.rebuild.outputs[f.id];
      return out ? { source: out.source, r: Object.values(out.radii)[0] } : null;
    });
  await expect.poll(solved).toEqual({ source: 'solved', r: 8 });
  // Opening the sketch shows the new value; the solved geometry is stored.
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['fx: ⌀16 mm']);
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-sketch-over-defined a stored sketch whose dimensions conflict opens red, lists the conflicting constraints, and one click deletes one', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // A sketch saved with a line dimensioned twice (40 and 50): sketch mode opens on it as the session starts.
  await workspaceFrame(page).evaluate(() => {
    const doc = (window as unknown as { __CAD__: { services: { doc: { beginNew(t: string, init: object): unknown } } } }).__CAD__.services.doc;
    doc.beginNew('sketch', {
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: { a: [0, 0], b: [40, 0] },
      entities: [{ id: 'l1', kind: 'line', p: ['a', 'b'] }],
      constraints: [
        { id: 'd1', kind: 'distance', refs: ['l1'], expr: '40 mm', driving: true, at: [20, -10] },
        { id: 'd2', kind: 'distance', refs: ['l1'], expr: '50 mm', driving: true, at: [20, 10] },
      ],
      solved: { values: { d1: 40, d2: 50 }, dof: 0, state: 'over' },
    });
  });
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(chip(frame)).toHaveText(/^Over defined · [12] conflicting$/);
  const list = frame.locator('[data-sketch-conflicts] li');
  await expect(frame.locator('[data-sketch-conflicts] .cad-field-group-title')).toHaveText('Conflicting constraints');
  await expect(list.first()).toContainText('Distance');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-state]')).toHaveCSS('color', 'rgb(180, 35, 24)');
  // The line is drawn red.
  await settled(page);
  await page.mouse.move(5, 5);
  const [lx, ly] = await at(page, [10, 0, 0]);
  const px = await darkestNear(page, lx, ly);
  expect(px[0], `line pixel ${px}`).toBeGreaterThan(px[1] + 60);
  await shot(page, 'sketch-8-over');
  await frame.locator('[data-conflict-delete="d2"]').click();
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 3 DOF');
  await expect(frame.locator('[data-sketch-conflicts]')).toHaveCount(0);
  await expect(frame.locator('[data-sketch-dim]')).toHaveText(['40 mm']);
  await page.keyboard.press('Enter');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
