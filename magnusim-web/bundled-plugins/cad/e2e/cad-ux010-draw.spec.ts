// ux010 (DRAW): three of Daniel's asks from trying CAD 0.1.0, in the real host frame, each
// asserting what he sees:
//  - Construction drawing: Draw > Construction (or X) with nothing selected is a toggle, never
//    greyed; while it is on the button is pressed, a badge on the canvas says "Construction (X)",
//    and what he draws is construction (no profile from it); a line begun before X counts; Undo
//    removes it; with a line selected X converts it as before; it is off when the sketch is
//    opened again.
//  - The press is never lost: after many fast small moves, a press dragged at once draws the
//    line from the press point to the release (also a rectangle); a quick click whose hand still
//    moves (8 px) starts the line where it was pressed; the dot at the pointer is where the
//    pointer is within two frames of a move.
//  - A new sketch fillet's radius arrow (direct manipulation: it points inward, away from the
//    corner, and the arc's midpoint follows the pointer): dragging it inward makes the radius bigger live (the
//    radius label and the Radius box say so before the release), the release keeps it (the
//    trimmed lines followed) as one undo step; too far stops at the largest radius and says why;
//    a fillet arc selected later shows the arrow too.
//  Review round: the arrow is pressed in the middle of its shaft (the R label sits off its line),
//  Escape mid-drag puts the radius and the box back; a 20 px / 60 ms slide is a click, a held drag
//  draws; with the Line tool in hand X turns construction drawing on and leaves a selection alone.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { commandControl, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
type V2 = [number, number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  await ensureCadOn(request);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

/** Page coordinates of a model point. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await cad<[number, number] | null>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null) as never, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

async function frameOffset(page: Page): Promise<[number, number]> {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x, box.y];
}

async function settled(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

interface Ent {
  id: string;
  kind: string;
  p?: [string, string];
  construction?: boolean;
  c?: string;
  a?: string;
  b?: string;
}
type Drawn = { points: Record<string, V2>; entities: Ent[]; constraints: { id: string; kind: string; expr?: string; refs: string[] }[] };
async function drawn(page: Page): Promise<Drawn> {
  return cad(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    return { points: d.points, entities: d.entities, constraints: d.constraints };
  }) as never);
}

/**
 * How near a clicked point lies to the model value it was aimed at (mm). The points come from the
 * pointer through the camera, so they carry its rounding: 15.0000019 for 15 on Linux CI, below
 * 1e-6 off on Windows; a pixel is about 0.25 mm here.
 */
const ON_LINE = 1e-4;

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"]');
const hint = (frame: FrameLocator) => panel(frame).locator('[data-sketch-hint]');
const badge = (frame: FrameLocator) => frame.locator('[data-sketch-construction-badge]');
const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.click(x, y);
};

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

async function finish(frame: FrameLocator) {
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** Close a More menu left open by commandControl. */
async function closeMenu(frame: FrameLocator) {
  const menu = frame.locator('[data-cad-menu]');
  if (await menu.count()) {
    await menu.press('Escape');
    await expect(menu).toHaveCount(0);
  }
}

/** The Construction command drawn pressed where it sits: the bar button, or its More item (active) and More itself. */
async function constructionPressed(frame: FrameLocator): Promise<boolean> {
  const tb = frame.locator('[data-cad-toolbar]');
  const btn = tb.locator('.tb-btn[data-command="sketch.construction"]');
  if (await btn.count()) return (await btn.getAttribute('aria-pressed')) === 'true';
  const more = tb.locator('[data-tb-more][data-more-commands~="sketch.construction"]');
  const morePressed = /\bis-active\b/.test((await more.getAttribute('class')) ?? '');
  const item = await commandControl(frame, 'sketch.construction');
  const itemActive = (await item.getAttribute('aria-current')) === 'true';
  await closeMenu(frame);
  return morePressed && itemActive;
}

const regionsOf = (page: Page) =>
  cad<number>(page, (() => {
    const s = (window as unknown as W).__CAD__.services;
    const f = s.doc.state.get().doc.features.find((x: { type: string }) => x.type === 'sketch');
    return f ? (s.doc.state.get().rebuild.outputs[f.id]?.regions?.length ?? -1) : -1;
  }) as never);

test('cad:ux010-draw-construction Construction with nothing selected toggles construction drawing: pressed, the badge, what is drawn is construction (no profile from it), a line begun before X counts, Undo, the selection still converts, off when the sketch opens again', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await expect(badge(frame)).toBeHidden();
  // Never greyed with nothing selected.
  const ctl = await commandControl(frame, 'sketch.construction');
  await expect(ctl).not.toHaveAttribute('aria-disabled', 'true');
  await closeMenu(frame);
  expect(await constructionPressed(frame)).toBe(false);
  // From the toolbar (bar or More): on.
  await runCommand(frame, 'sketch.construction');
  await expect(badge(frame)).toBeVisible();
  await expect(badge(frame)).toHaveText('Construction (X)');
  expect(await constructionPressed(frame)).toBe(true);
  // A rectangle while it is on: four construction lines.
  await page.keyboard.press('r');
  await clickAt(page, [-30, -15]);
  await clickAt(page, [30, 15]);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.entities.filter((e) => e.kind === 'line').map((e) => !!e.construction)).toEqual([true, true, true, true]);
  // Off, then a line whose first click came before X (on again): construction too.
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeHidden();
  await page.keyboard.press('l');
  await clickAt(page, [-40, 30]);
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeVisible();
  await clickAt(page, [40, 30]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  let lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(5);
  expect(lines[4].construction).toBe(true);
  // Undo removes it as usual.
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect((await drawn(page)).entities.filter((e) => e.kind === 'line')).toHaveLength(4);
  // Off (X): a circle is normal geometry.
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeHidden();
  expect(await constructionPressed(frame)).toBe(false);
  await page.keyboard.press('c');
  await clickAt(page, [0, 0]);
  await clickAt(page, [8, 0]);
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.entities.find((e) => e.kind === 'circle')?.construction).toBeFalsy();
  // With a line selected, X converts it back to normal geometry (construction drawing stays off).
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await clickAt(page, [0, 15]);
  await page.keyboard.press('x');
  await sketchIdle(page);
  d = await drawn(page);
  const top = d.entities.filter((e) => e.kind === 'line').find((e) => e.p!.every((id) => Math.abs(d.points[id][1] - 15) < ON_LINE));
  expect(top).toBeTruthy();
  expect(top!.construction).toBeFalsy();
  lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines.filter((e) => e.construction)).toHaveLength(3);
  await expect(badge(frame)).toBeHidden();
  // Review S1: that line still selected, L then X: with a drawing tool in hand X turns construction
  // drawing on and leaves the old selection alone; X again turns it off.
  await page.keyboard.press('l');
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeVisible();
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.entities.filter((e) => e.kind === 'line' && e.construction)).toHaveLength(3);
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeHidden();
  await page.keyboard.press('Escape');
  await finish(frame);
  // The circle is the one profile (the construction rectangle's sides and the converted line close none).
  await expect.poll(() => regionsOf(page)).toBe(1);
  // Opened again: construction drawing is off.
  await frame.locator('[data-cad-tree] [data-feature-row] > .tree-row', { hasText: 'Sketch 1' }).dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect(badge(frame)).toBeHidden();
  expect(await constructionPressed(frame)).toBe(false);
  expect(seen.errors).toEqual([]);
});

test('cad:ux010-draw-press a press after fast moves is never lost: click-drag draws the line from the press, a quick click with 8 px of drift starts where it was pressed, a click-drag rectangle; the dot is at the pointer within two frames', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await page.keyboard.press('l');
  const [ox, oy] = await frameOffset(page);
  const px = await cad<number>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle.pixelSize([0, 0, 0])) as never);
  // Many small fast moves, no waits, then press, drag and release at once.
  const [sx, sy] = await at(page, [-35, -20, 0]);
  const [ex, ey] = await at(page, [25, 10, 0]);
  for (let i = 0; i <= 40; i++) await page.mouse.move(sx - 120 + i * 3, sy + 60 - i * 1.5);
  await page.mouse.down();
  await page.mouse.move(ex, ey);
  await page.mouse.up();
  await sketchIdle(page);
  let d = await drawn(page);
  let lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(1);
  const [a, b] = lines[0].p!.map((id) => d.points[id]);
  // From the press point to the release.
  expect(Math.hypot(a[0] + 35, a[1] + 20)).toBeLessThan(2 * px);
  expect(Math.hypot(b[0] - 25, b[1] - 10)).toBeLessThan(2 * px);
  // The drag drew one line: the next press starts a new one.
  await expect(hint(frame)).toContainText('Click where the line starts');

  // The dot at the pointer: where the pointer is within two frames of a move (nothing to snap to there).
  for (const p of [[-20, 25], [10, 28], [32, -24]] as V2[]) {
    const [x, y] = await at(page, [p[0], p[1], 0]);
    await page.mouse.move(x, y);
    const dot = await cad<string | null>(page, (async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.querySelector('[data-sketch-annotations]')?.getAttribute('data-sketch-dot') ?? null;
    }) as never);
    expect(dot, 'the dot after a move').not.toBeNull();
    const [dx, dy] = dot!.split(',').map(Number);
    expect(Math.hypot(dx + ox - x, dy + oy - y)).toBeLessThanOrEqual(2);
  }

  // A quick click while the hand still moves (8 px between press and release): the line starts where it was pressed.
  const [qx, qy] = await at(page, [-30, 20, 0]);
  await page.mouse.move(qx, qy);
  await page.mouse.down();
  await page.mouse.move(qx + 8, qy);
  await page.mouse.up();
  await expect(hint(frame)).toContainText('Click the next point');
  await clickAt(page, [0, 20]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(2);
  const [q0] = lines[1].p!.map((id) => d.points[id]);
  expect(Math.hypot(q0[0] + 30, q0[1] - 20)).toBeLessThan(2 * px);

  // Review S2: a fast sloppy click (20 px slide in about 60 ms) is a click at the press point: the
  // chain stays open and the next click ends the line there.
  // (Sent inside the frame, so the 60 ms is the hand's and not the test runner's round trips.)
  const [sx2, sy2] = await at(page, [-30, -28, 0]);
  await page.mouse.move(sx2, sy2);
  const [fx, fy] = await frameOffset(page);
  await cad(page, (async (a: { x: number; y: number }) => {
    const c = document.querySelector<HTMLCanvasElement>('[data-cad-canvas], canvas.cad-viewport-canvas')!;
    const ev = (type: string, x: number, buttons: number) => new PointerEvent(type, { clientX: x, clientY: a.y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true });
    c.dispatchEvent(ev('pointerdown', a.x, 1));
    await new Promise((r) => setTimeout(r, 30));
    c.dispatchEvent(ev('pointermove', a.x + 10, 1));
    await new Promise((r) => setTimeout(r, 30));
    c.dispatchEvent(ev('pointermove', a.x + 20, 1));
    c.dispatchEvent(ev('pointerup', a.x + 20, 0));
  }) as never, { x: sx2 - fx, y: sy2 - fy });
  await expect(hint(frame)).toContainText('Click the next point');
  await clickAt(page, [10, -28]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(3);
  const [s0, s1] = lines[2].p!.map((id) => d.points[id]);
  expect(Math.hypot(s0[0] + 30, s0[1] + 28)).toBeLessThan(2 * px);
  expect(Math.hypot(s1[0] - 10, s1[1] + 28)).toBeLessThan(2 * px);
  // A deliberate drag (held 250 ms, 20 px): it draws the line to the release.
  const [dx0, dy0] = await at(page, [-30, -34, 0]);
  await page.mouse.move(dx0, dy0);
  await page.mouse.down();
  await page.mouse.move(dx0 + 20, dy0, { steps: 4 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(hint(frame)).toContainText('Click where the line starts');
  await sketchIdle(page);
  d = await drawn(page);
  lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(4);
  const [t0, t1] = lines[3].p!.map((id) => d.points[id]);
  expect(Math.hypot(t0[0] + 30, t0[1] + 34)).toBeLessThan(2 * px);
  expect(Math.hypot(t1[0] - (-30 + 20 * px), t1[1] + 34)).toBeLessThan(2 * px);

  // A click-drag rectangle after fast moves: corners at the press and at the release.
  await page.keyboard.press('r');
  const [r0x, r0y] = await at(page, [40, -30, 0]);
  const [r1x, r1y] = await at(page, [60, -10, 0]);
  for (let i = 0; i <= 20; i++) await page.mouse.move(r0x - 40 + i * 2, r0y);
  await page.mouse.down();
  await page.mouse.move(r1x, r1y);
  await page.mouse.up();
  await sketchIdle(page);
  d = await drawn(page);
  const rect = d.entities.filter((e) => e.kind === 'line').slice(4);
  expect(rect).toHaveLength(4);
  const xs = rect.flatMap((e) => e.p!.map((id) => d.points[id][0]));
  const ys = rect.flatMap((e) => e.p!.map((id) => d.points[id][1]));
  expect(Math.abs(Math.min(...xs) - 40)).toBeLessThan(2 * px);
  expect(Math.abs(Math.max(...xs) - 60)).toBeLessThan(2 * px);
  expect(Math.abs(Math.min(...ys) + 30)).toBeLessThan(2 * px);
  expect(Math.abs(Math.max(...ys) + 10)).toBeLessThan(2 * px);
  expect(seen.errors).toEqual([]);
});

/** A W x H rectangle from the origin (R, a click on the origin, W Tab H Enter): fully defined. */
async function typedRectangle(page: Page, frame: FrameLocator, w: number, h: number) {
  await page.keyboard.press('r');
  await clickAt(page, [0, 0]);
  const [x, y] = await at(page, [w * 0.7, h * 0.7, 0]);
  await page.mouse.move(x, y);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type(String(w));
  await page.keyboard.press('Tab');
  await page.keyboard.type(String(h));
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Fully defined');
}

const arcRadius = (page: Page) =>
  cad<number>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const a = d.entities.find((e: { kind: string }) => e.kind === 'arc');
    const c = d.points[a.c];
    const p = d.points[a.a];
    return Math.hypot(p[0] - c[0], p[1] - c[1]);
  }) as never);

/** The radius arrow as drawn: its grip (page px), and the page point `mm` further along it. */
async function arrow(page: Page, mm: number): Promise<{ grip: V2; to: V2 }> {
  const g = await cad<{ at: V2; dir: V2 }>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().preview.handles[0]) as never);
  const grip = await at(page, [g.at[0], g.at[1], 0]);
  const to = await at(page, [g.at[0] + g.dir[0] * mm, g.at[1] + g.dir[1] * mm, 0]);
  return { grip, to };
}

/** The page point `px` screen pixels along the radius arrow from its grip (negative: inward). */
async function alongArrow(page: Page, px: number): Promise<V2> {
  const { grip, to } = await arrow(page, 1);
  const l = Math.hypot(to[0] - grip[0], to[1] - grip[1]) || 1;
  return [grip[0] + ((to[0] - grip[0]) / l) * px, grip[1] + ((to[1] - grip[1]) / l) * px];
}

/** The top line's end at the fillet (its right end, x). */
function topEnd(d: Drawn): number {
  const top = d.entities.filter((e) => e.kind === 'line').find((e) => e.p!.every((id) => Math.abs(d.points[id][1] - 20) < ON_LINE))!;
  return Math.max(...top.p!.map((id) => d.points[id][0]));
}

const labelValue = async (frame: FrameLocator) => Number(((await frame.locator('[data-sketch-dim]', { hasText: /^R ?[\d.]+ mm$/ }).textContent()) ?? '').replace(/[^\d.]/g, ''));

test('cad:ux010-draw-fillet-handle a new fillet shows a radius arrow; dragging it inward makes the radius bigger live (label and Radius box), the release keeps it (the lines follow) as one undo step; too far stops at the largest radius and says why', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 40, 20);
  await runCommand(frame, 'sketch.fillet');
  const box = panel(frame).locator('.nui[data-field="sk-radius"] input');
  await expect(box).toHaveValue('5');
  await clickAt(page, [40, 20]);
  await sketchIdle(page);
  const handle = frame.locator('[data-sketch-handle]');
  await expect(handle).toHaveCount(1);
  await expect(handle).toBeVisible();
  await expect(hint(frame)).toContainText('Drag the arrow to size this fillet');
  const label = frame.locator('[data-sketch-dim]', { hasText: /^R ?[\d.]+ mm$/ });
  await expect(label).toHaveText(/^R ?5 mm$/);
  expect(topEnd(await drawn(page))).toBeCloseTo(35, 6);

  // Review B1: the middle of the arrow's shaft (16 px from its grip) is the arrow, not the R label
  // or a glyph; the label sits off the arrow's line.
  // 3 mm bigger: the midpoint 3 (sqrt 2 - 1) mm further inward along the bisector (a 90 degree corner).
  const { grip, to } = await arrow(page, 3 * (Math.SQRT2 - 1));
  const shaft = await alongArrow(page, 16);
  const under = await cad<string>(page, ((p: V2) => {
    const el = document.elementFromPoint(p[0], p[1]);
    return el?.closest('[data-sketch-handle]') ? 'arrow' : el?.closest('[data-sketch-dim]') ? 'label' : el?.closest('.cad-sk-glyph') ? 'glyph' : (el?.tagName ?? 'none');
  }) as never, [shaft[0] - (await frameOffset(page))[0], shaft[1] - (await frameOffset(page))[1]]);
  expect(under).toBe('arrow');
  const lb = (await label.boundingBox())!;
  const hb = (await handle.boundingBox())!;
  for (const k of [0, 8, 16, 24, 30]) {
    const p = await alongArrow(page, k);
    expect(p[0] >= lb.x && p[0] <= lb.x + lb.width && p[1] >= lb.y && p[1] <= lb.y + lb.height, `the R label covers the arrow at ${k} px`).toBe(false);
  }
  expect(hb.width).toBeGreaterThan(10);

  // Review S3: dragged towards the corner (smaller), then Escape while held: the radius and the box
  // go back, nothing is stored.
  await page.mouse.move(shaft[0], shaft[1]);
  await page.mouse.down();
  const towardCorner = await alongArrow(page, -12);
  await page.mouse.move(towardCorner[0], towardCorner[1], { steps: 3 });
  await expect(hint(frame)).toHaveText(/^(Radius [\d.]+ mm: release to keep it\.|Dragging stops at .*)$/);
  await expect.poll(() => labelValue(frame)).toBeLessThan(5);
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('5');
  await page.mouse.up();
  await sketchIdle(page);
  await expect(label).toHaveText(/^R ?5 mm$/);
  expect(await arcRadius(page)).toBeCloseTo(5, 6);
  await expect(handle).toHaveCount(1);

  // Drag from the middle of the shaft, 3 mm bigger: live first (the label and the box), then released.
  await page.mouse.move(shaft[0], shaft[1]);
  await page.mouse.down();
  await page.mouse.move(shaft[0] + (to[0] - grip[0]) / 2, shaft[1] + (to[1] - grip[1]) / 2, { steps: 3 });
  await page.mouse.move(shaft[0] + to[0] - grip[0], shaft[1] + to[1] - grip[1], { steps: 3 });
  await expect(hint(frame)).toHaveText(/^Radius [\d.]+ mm: release to keep it\.$/);
  await expect.poll(() => labelValue(frame)).toBeGreaterThan(7);
  const live = await labelValue(frame);
  await expect(box).toHaveValue(String(live));
  await page.mouse.up();
  await sketchIdle(page);
  const r1 = await arcRadius(page);
  expect(r1).toBeGreaterThan(7);
  expect(r1).toBeLessThan(9);
  expect(r1).toBeCloseTo(live, 6);
  await expect.poll(() => labelValue(frame)).toBe(+r1.toFixed(6));
  await expect(box).toHaveValue(String(+r1.toFixed(6)));
  // The trimmed line followed (its end at 40 - r); the dimension changed, none was added.
  const after = await drawn(page);
  expect(topEnd(after)).toBeCloseTo(40 - r1, 4);
  expect(after.constraints.filter((c) => c.kind === 'radius')).toHaveLength(1);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Fully defined');

  // Too far: it stops just under 20 (the short side: 19.99) and says why.
  const far = await arrow(page, 30);
  await page.mouse.move(far.grip[0], far.grip[1]);
  await page.mouse.down();
  await page.mouse.move(far.to[0], far.to[1], { steps: 4 });
  await expect(hint(frame)).toHaveText("The radius can't be bigger than 20 mm here: the lines are too short");
  await page.mouse.up();
  await sketchIdle(page);
  const r2 = await arcRadius(page);
  expect(r2).toBeCloseTo(19.99, 6);
  await expect.poll(() => labelValue(frame)).toBe(19.99);

  // One Undo per drag: back to r1, then to 5 (the label, the box and the line too).
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect(await arcRadius(page)).toBeCloseTo(r1, 6);
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect(await arcRadius(page)).toBeCloseTo(5, 6);
  await expect(label).toHaveText(/^R ?5 mm$/);
  await expect(box).toHaveValue('5');
  expect(topEnd(await drawn(page))).toBeCloseTo(35, 6);
  // Escape lets go of the arrow; the tool stays.
  await page.keyboard.press('Escape');
  await expect(handle).toHaveCount(0);
  await expect(hint(frame)).toContainText('Pick a corner or two curves');

  // Later, with the Select tool: the fillet arc clicked shows its arrow again; a drag sizes it (one undo step).
  await page.keyboard.press('Escape');
  const mid = await cad<V2>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    const a = d.entities.find((e: { kind: string }) => e.kind === 'arc');
    const c = d.points[a.c];
    const p = d.points[a.a];
    const q = d.points[a.b];
    const m = [(p[0] + q[0]) / 2 - c[0], (p[1] + q[1]) / 2 - c[1]];
    const l = Math.hypot(m[0], m[1]);
    const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
    return [c[0] + (m[0] / l) * r, c[1] + (m[1] / l) * r];
  }) as never);
  await clickAt(page, mid);
  await expect(handle).toHaveCount(1);
  const again = await arrow(page, 2 * (Math.SQRT2 - 1));
  await page.mouse.move(again.grip[0], again.grip[1]);
  await page.mouse.down();
  await page.mouse.move(again.to[0], again.to[1], { steps: 4 });
  await page.mouse.up();
  await sketchIdle(page);
  const r3 = await arcRadius(page);
  expect(r3).toBeGreaterThan(6);
  await expect.poll(() => labelValue(frame)).toBe(+r3.toFixed(6));
  await page.keyboard.press('Control+z');
  await sketchIdle(page);
  expect(await arcRadius(page)).toBeCloseTo(5, 6);
  expect(seen.errors).toEqual([]);
});

/** The fillet arc's midpoint as drawn now (the live draft while dragging), in page px. */
async function arcMidPage(page: Page): Promise<V2> {
  const m = await cad<V3>(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().draft;
    const a = d.entities.find((e: { kind: string }) => e.kind === 'arc');
    const c = d.points[a.c];
    const p = d.points[a.a];
    const q = d.points[a.b];
    const r = Math.hypot(p[0] - c[0], p[1] - c[1]);
    const mx = (p[0] + q[0]) / 2 - c[0];
    const my = (p[1] + q[1]) / 2 - c[1];
    const l = Math.hypot(mx, my);
    return [c[0] + (mx / l) * r, c[1] + (my / l) * r, 0];
  }) as never);
  return at(page, m);
}

/** Grab the radius arrow at its grip and move `px` screen pixels along it (negative: towards the corner), without letting go. */
async function dragArrowBy(page: Page, px: number): Promise<V2> {
  const { grip, to } = await arrow(page, 1);
  const l = Math.hypot(to[0] - grip[0], to[1] - grip[1]);
  const end: V2 = [grip[0] + ((to[0] - grip[0]) / l) * px, grip[1] + ((to[1] - grip[1]) / l) * px];
  await page.mouse.move(grip[0], grip[1]);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 5 });
  return end;
}

/** The arc's midpoint is under the pointer (within 2 px) once the live solve has landed. */
async function expectMidAt(page: Page, p: V2) {
  await expect.poll(async () => {
    const m = await arcMidPage(page);
    return Math.hypot(m[0] - p[0], m[1] - p[1]);
  }).toBeLessThanOrEqual(2);
}

test('cad:ux010-draw-fillet-direct the radius arrow is direct manipulation: 20 px inward makes the radius bigger with the arc midpoint under the pointer, towards the corner smaller; the same with the Select tool on an existing fillet', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 40, 20);
  await runCommand(frame, 'sketch.fillet');
  await clickAt(page, [40, 20]);
  await sketchIdle(page);
  const handle = frame.locator('[data-sketch-handle]');
  await expect(handle).toHaveCount(1);
  // The arrow points inward: from the arc's midpoint towards its centre (away from the corner).
  const g = await cad<{ at: V2; dir: V2 }>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().preview.handles[0]) as never);
  expect(g.dir[0]).toBeCloseTo(-Math.SQRT1_2, 6);
  expect(g.dir[1]).toBeCloseTo(-Math.SQRT1_2, 6);
  // 20 px inward: bigger, and the midpoint (and the handle on it) stay under the pointer.
  let p = await dragArrowBy(page, 20);
  await expectMidAt(page, p);
  await expect.poll(() => labelValue(frame)).toBeGreaterThan(5);
  const [fx, fy] = await frameOffset(page);
  await expect
    .poll(async () => {
      const [hx, hy] = ((await handle.getAttribute('data-screen')) ?? '0,0').split(',').map(Number);
      return Math.hypot(hx + fx - p[0], hy + fy - p[1]);
    })
    .toBeLessThanOrEqual(2);
  await page.mouse.up();
  await sketchIdle(page);
  const r1 = await arcRadius(page);
  expect(r1).toBeGreaterThan(5);
  // Towards the corner: smaller.
  p = await dragArrowBy(page, -20);
  await expectMidAt(page, p);
  await page.mouse.up();
  await sketchIdle(page);
  const r2 = await arcRadius(page);
  expect(r2).toBeLessThan(r1);
  // The Select tool on the existing fillet: click its arc, the arrow, the same direct drag.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await clickAt(page, await (async () => {
    const d = await drawn(page);
    const a = d.entities.find((e) => e.kind === 'arc')!;
    const c = d.points[a.c!];
    const s0 = d.points[a.a!];
    const s1 = d.points[a.b!];
    const mx = (s0[0] + s1[0]) / 2 - c[0];
    const my = (s0[1] + s1[1]) / 2 - c[1];
    const l = Math.hypot(mx, my);
    const r = Math.hypot(s0[0] - c[0], s0[1] - c[1]);
    return [c[0] + (mx / l) * r, c[1] + (my / l) * r] as V2;
  })());
  await expect(handle).toHaveCount(1);
  p = await dragArrowBy(page, 20);
  await expectMidAt(page, p);
  await page.mouse.up();
  await sketchIdle(page);
  expect(await arcRadius(page)).toBeGreaterThan(r2);
  expect(seen.errors).toEqual([]);
});
