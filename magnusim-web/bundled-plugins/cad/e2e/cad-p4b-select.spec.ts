// P4b SELECT: Construction from the right-click menu on any sketch selection, and
// SolidWorks-style box selection in sketch mode and in model mode (Daniel's must-haves 5
// and 6), each as the user meets it: right-clicks and the menu's items and check marks,
// boxes dragged with Ctrl held (left to right: a solid box that selects what it encloses;
// right to left: a dashed box that selects what it touches; Ctrl+Shift adds; the selection
// filter; a plain left drag orbits and Shift + drag pans, as in the core viewer), and what the Sketch panel's "Selected" line and the dock's chips say.
// The 10k-face timing test feeds the viewport a synthetic tessellation (as the viewport
// perf spec does) and times the box (tagged serial: it times the browser).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { addSolid, modelOnPage, newPartFromTree, newProject, openProject, openSketchDetails, partOpened, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type V3 = [number, number, number];

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, projectId };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;

/** A sketch on Top put in through the document (setup), then opened for editing as a user does (a double-click on its row). */
async function openSketchOnTop(page: Page, frame: FrameLocator, init: Record<string, unknown>) {
  await cad(page, (async (i: Record<string, unknown>) => {
    const s = (window as unknown as W).__CAD__.services;
    const sk = s.doc.beginNew('sketch', { support: { kind: 'plane', plane: 'origin:top' }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }, ...i });
    sk.commit();
    for (let k = 0; k < 400; k++) {
      if (s.doc.state.get().rebuild.outputs[sk.feature]) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }) as never, init);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await idle(page);
}

/** No view transition, and sketch mode has stored every edit. */
async function idle(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

const at = (page: Page, p: V3) => modelOnPage(page, p);

/**
 * The Sketch panel's "Selected" words (its tooltip holds them all), or [] with nothing selected.
 * ux010: the selection is under the panel's Details, which must be open (openSketchDetails), so an
 * empty list means nothing is selected, not a compact panel.
 */
async function selectedWords(frame: FrameLocator): Promise<string[]> {
  await expect(frame.locator('[data-cad-panel="sketch"] [data-sketch-details]')).toHaveAttribute('data-sketch-details', 'open');
  const el = frame.locator('[data-sketch-selection] .cad-sk-selected');
  if (!(await el.count())) return [];
  const t = (await el.getAttribute('title')) ?? '';
  return t ? t.split(', ') : [];
}

/**
 * A box dragged from `a` to `b` (page px) with Ctrl held (the box binding since 2026-10-06) and the
 * other modifiers. Halfway, it checks the box the user sees: its mode (enclose / touch) and its
 * border style (solid / dashed).
 */
async function dragBox(page: Page, frame: FrameLocator, a: [number, number], b: [number, number], opts: { mods?: 'Shift'[]; expect?: 'enclose' | 'touch'; caption?: RegExp | string } = {}) {
  const mods = ['Control', ...(opts.mods ?? [])];
  await page.mouse.move(a[0], a[1]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 });
  await page.mouse.move(b[0], b[1], { steps: 4 });
  const box = frame.locator('[data-box-select]');
  await expect(box).toHaveCount(1);
  if (opts.expect) {
    await expect(box).toHaveAttribute('data-box-mode', opts.expect);
    expect(await box.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe(opts.expect === 'enclose' ? 'solid' : 'dashed');
  }
  if (opts.caption) await expect(box.locator('.cad-box-caption')).toHaveText(opts.caption);
  await page.mouse.up();
  for (const m of mods.reverse()) await page.keyboard.up(m);
  await expect(box).toHaveCount(0);
  await idle(page);
}

/** A left drag with no key of its own (the caller may hold Shift or Alt): no box may show while it moves. */
async function plainDrag(page: Page, frame: FrameLocator, a: [number, number], b: [number, number]) {
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 });
  await page.mouse.move(b[0], b[1], { steps: 4 });
  await expect(frame.locator('[data-box-select]')).toHaveCount(0);
  await page.mouse.up();
  await idle(page);
}

const cameraPos = (page: Page) => cad<number[]>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle.camera().position) as never);
const cameraDir = (page: Page) =>
  cad<number[]>(page, (() => {
    const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
    return [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
  }) as never);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Degrees between two directions. */
function angleBetween(a: number[], b: number[]): number {
  const n = Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]);
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n;
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

const LINES = {
  points: { pt_1: [0, 0], pt_2: [30, 0], pt_3: [0, 20], pt_4: [60, 20], pt_5: [80, 10] },
  entities: [
    { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
    { id: 'e_2', kind: 'line', p: ['pt_3', 'pt_4'] },
    { id: 'e_3', kind: 'circle', c: 'pt_5', r: 5 },
  ],
  constraints: [],
  solved: { values: {}, dof: 0, state: 'under' },
};

test('cad:p4b-select-construction-menu right-click Construction on any sketch selection: a check mark, Make construction / Make normal when mixed, X and the toolbar still toggle', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await openSketchOnTop(page, frame, LINES);
  // ux010: the selection's words are under the Sketch panel's Details.
  await openSketchDetails(page, frame);
  const menu = frame.locator('[data-cad-menu]');
  const item = (id: string) => menu.locator(`[data-menu-item="${id}"]`);
  const rightClick = async (p: V3) => {
    const [x, y] = await at(page, p);
    await page.mouse.click(x, y, { button: 'right' });
    await expect(menu).toBeVisible();
  };

  // Line 1, a normal line: "Construction", unchecked (a state item).
  await rightClick([15, 0, 0]);
  await expect(item('construction')).toHaveText('Construction');
  await expect(item('construction')).toHaveAttribute('role', 'menuitemcheckbox');
  await expect(item('construction')).toHaveAttribute('aria-checked', 'false');
  await item('construction').click();
  await expect(menu).toHaveCount(0);
  await idle(page);
  // Now it is construction: the item is checked; Line 2 (another line) is not touched.
  await rightClick([15, 0, 0]);
  await expect(item('construction')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await rightClick([30, 20, 0]);
  await expect(item('construction')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  // Line 1 (construction) and Circle 1 (normal) together: both ways are offered.
  const [l1x, l1y] = await at(page, [15, 0, 0]);
  await page.mouse.click(l1x, l1y);
  const [cx, cy] = await at(page, [85, 10, 0]);
  await page.keyboard.down('Control');
  await page.mouse.click(cx, cy);
  await page.keyboard.up('Control');
  expect(await selectedWords(frame)).toEqual(['Line 1', 'Circle 1']);
  await page.mouse.click(cx, cy, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(item('construction')).toHaveCount(0);
  await expect(item('construction-on')).toHaveText('Make construction');
  await expect(item('construction-off')).toHaveText('Make normal');
  await item('construction-off').click();
  await idle(page);
  await page.mouse.click(cx, cy, { button: 'right' });
  await expect(item('construction')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  // X (the existing shortcut) on the same two: both construction; the menu agrees.
  await page.keyboard.press('x');
  await idle(page);
  await page.mouse.click(cx, cy, { button: 'right' });
  await expect(item('construction')).toHaveAttribute('aria-checked', 'true');
  // Clicking the checked item makes both normal again.
  await item('construction').click();
  await idle(page);
  const kinds = await cad<{ id: string; construction: boolean }[]>(page, (() => {
    const m = (window as unknown as W).__CAD__.services.apis.get().sketch;
    return m.draft().entities.map((e: { id: string; construction?: boolean }) => ({ id: e.id, construction: !!e.construction }));
  }) as never);
  expect(kinds).toEqual([
    { id: 'e_1', construction: false },
    { id: 'e_2', construction: false },
    { id: 'e_3', construction: false },
  ]);
  // The toolbar's Construction is there too (it toggles the selection).
  await expect(frame.locator('[data-cad-toolbar] [data-command="sketch.construction"], [data-cad-toolbar] [data-tb-more][data-more-commands~="sketch.construction"]')).toHaveCount(1);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-select-sketch-box Ctrl+drag: left to right encloses (solid), right to left touches (dashed), Ctrl+Shift adds, an empty box clears, the sketch filter; a plain drag orbits', { tag: '@smoke' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await openSketchOnTop(page, frame, LINES);
  // ux010: the selection's words are under the Sketch panel's Details.
  await openSketchDetails(page, frame);
  const tl = await at(page, [-5, 25, 0]);
  const br = await at(page, [35, -5, 0]);

  // Ctrl + drag left to right around Line 1 (whole) and part of Line 2: only Line 1.
  await dragBox(page, frame, tl, br, { expect: 'enclose', caption: 'Enclose · curves, points, dimensions' });
  expect(await selectedWords(frame)).toEqual(['Line 1']);

  // The same box right to left: what it touches, Line 1 and Line 2.
  await dragBox(page, frame, br, tl, { expect: 'touch', caption: 'Touch · curves, points, dimensions' });
  expect(await selectedWords(frame)).toEqual(['Line 1', 'Line 2']);

  // Ctrl+Shift: a box around the circle adds it.
  await dragBox(page, frame, await at(page, [70, 18, 0]), await at(page, [90, 2, 0]), { mods: ['Shift'], expect: 'enclose' });
  expect(await selectedWords(frame)).toEqual(['Line 1', 'Line 2', 'Circle 1']);

  // Ctrl alone: the box replaces the selection (around Line 1: Line 1 only).
  await dragBox(page, frame, await at(page, [-5, 5, 0]), await at(page, [35, -5, 0]), { expect: 'enclose' });
  expect(await selectedWords(frame)).toEqual(['Line 1']);

  // An empty Ctrl+Shift box keeps the selection; an empty Ctrl box clears it. (Below the lines, well
  // inside the view: real Chrome drops synthetic mouse events past the window's edge, where
  // [100, 40]..[110, 30] reached in the full Chrome run.)
  await dragBox(page, frame, await at(page, [40, -20, 0]), await at(page, [55, -30, 0]), { mods: ['Shift'] });
  expect(await selectedWords(frame)).toEqual(['Line 1']);
  await dragBox(page, frame, await at(page, [40, -20, 0]), await at(page, [55, -30, 0]));
  expect(await selectedWords(frame)).toEqual([]);

  // A plain left drag from empty space orbits the view (as the core viewer does): no box, nothing selected.
  const cam0 = await cameraPos(page);
  const [ex, ey] = await at(page, [40, -20, 0]);
  await plainDrag(page, frame, [ex, ey], [ex + 80, ey + 30]);
  await expect.poll(() => cameraPos(page)).not.toEqual(cam0);
  expect(await selectedWords(frame)).toEqual([]);
  // Back to looking at the sketch (Normal to, N in sketch mode) for the filter's boxes.
  await page.keyboard.press('n');
  await idle(page);

  // The selection filter in sketch mode shows the sketch's kinds; Points only: the box takes Line 1's ends.
  await frame.locator('[data-vp-opens="filter"]').click();
  const pop = frame.locator('[data-vp-pop="filter"]');
  await expect(pop.locator('[data-filter]')).toHaveText(['Points', 'Curves', 'Dimensions']);
  await pop.locator('[data-filter="point"]').click();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await dragBox(page, frame, await at(page, [-5, 5, 0]), await at(page, [35, -5, 0]), { expect: 'enclose', caption: 'Enclose · points' });
  expect(await selectedWords(frame)).toEqual(['End of Line 1', 'End of Line 1']);
  // A click on a line picks nothing under the Points filter (its ends would).
  const [mx, my] = await at(page, [15, 0, 0]);
  await page.mouse.click(mx, my);
  expect(await selectedWords(frame)).toEqual([]);
  // Back to everything.
  await frame.locator('[data-vp-opens="filter"]').click();
  await frame.locator('[data-filter-clear]').click();
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-select-sketch-box-dimension a box takes a dimension label it encloses, and never starts on one', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await openSketchOnTop(page, frame, {
    ...LINES,
    constraints: [{ id: 'c_d', kind: 'distance', refs: ['e_1'], expr: '30 mm', driving: true, at: [15, -8] }],
    solved: { values: { c_d: 30 }, dof: 0, state: 'under' },
  });
  // ux010: the selection's words are under the Sketch panel's Details.
  await openSketchDetails(page, frame);
  const label = frame.locator('[data-sketch-dim="c_d"]');
  await expect(label).toBeVisible();
  const r = (await label.boundingBox())!;
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  // Around the label only (left to right): the dimension.
  await dragBox(page, frame, [r.x - 12, r.y - 12], [r.x + r.width + 12, r.y + r.height + 12], { expect: 'enclose' });
  expect(await selectedWords(frame)).toEqual(['Distance 30 mm']);
  // A press on the label drags the label, never a box.
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 30, r.y + r.height / 2 + 20, { steps: 5 });
  await expect(frame.locator('[data-box-select]')).toHaveCount(0);
  await page.mouse.up();
  void fb;
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-select-model-box Ctrl+drag boxes, from empty space or on the body: enclose (solid) or touch (dashed), only what is visible, the filter, Ctrl+Shift adds, an empty box clears; Ctrl+click still toggles', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  const chip = frame.locator('[data-chip="selection"] [data-selection-count]');
  const pick = frame.locator('[data-pick-info]');
  // Ctrl + drag around the whole block, left to right: with no filter it selects edges
  // (SolidWorks), the 9 the view shows (3 hidden behind the block are not).
  const corners: V3[] = [
    [0, 0, 0], [20, 0, 0], [0, 20, 0], [20, 20, 0], [0, 0, 20], [20, 0, 20], [0, 20, 20], [20, 20, 20],
  ];
  const pts = await Promise.all(corners.map((c) => at(page, c)));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const lo: [number, number] = [Math.min(...xs) - 25, Math.min(...ys) - 25];
  const hi: [number, number] = [Math.max(...xs) + 25, Math.max(...ys) + 25];
  const cam0 = await cameraPos(page);
  await dragBox(page, frame, lo, hi, { expect: 'enclose', caption: 'Enclose · edges' });
  await expect(chip).toHaveText('9 edges');
  // The camera did not move (a box, not an orbit).
  expect(await cameraPos(page)).toEqual(cam0);

  // Faces filter: the same box encloses the 3 faces seen; right to left across the top face's middle
  // only (no edge in it): that face alone, which the pick chip names.
  await frame.locator('[data-vp-opens="filter"]').click();
  await frame.locator('[data-vp-pop="filter"] [data-filter="face"]').click();
  await page.keyboard.press('Escape');
  await dragBox(page, frame, lo, hi, { expect: 'enclose', caption: 'Enclose · faces' });
  await expect(chip).toHaveText('3 faces');
  const top = await at(page, [10, 10, 20]);
  // Right to left from empty space: the box starts outside the block and reaches the top face's middle.
  await dragBox(page, frame, [hi[0], top[1] - 3], [top[0], top[1] + 3], { expect: 'touch', caption: 'Touch · faces' });
  // Touching: the top face (End of Extrude 1), with the side face the strip crosses on its way in when
  // the view shows one there: the pick chip names a lone face, the selection chip counts several.
  await expect(chip.or(pick)).toHaveCount(1);
  if (await chip.count()) await expect(chip).toHaveText(/^[23] faces$/);
  else await expect(pick).toHaveText('Face · End (Extrude 1)');
  // Ctrl+Shift: the enclosing box adds what is not selected yet: all three.
  await dragBox(page, frame, lo, hi, { mods: ['Shift'], expect: 'enclose' });
  await expect(chip).toHaveText('3 faces');
  // A Ctrl box that STARTS ON the block is a box too (not an orbit): right to left from the top
  // face's middle, it touches the top face (and what the strip crosses), replacing the three.
  await dragBox(page, frame, [top[0], top[1] - 3], [lo[0], top[1] + 3], { expect: 'touch', caption: 'Touch · faces' });
  expect(await cameraPos(page)).toEqual(cam0);
  await expect(chip.or(pick)).toHaveCount(1);
  if (await chip.count()) await expect(chip).toHaveText(/^[12] faces$/);
  else await expect(pick).toHaveText('Face · End (Extrude 1)');
  // An empty Ctrl box clears.
  await dragBox(page, frame, [lo[0], lo[1]], [lo[0] + 10, lo[1] + 10]);
  await expect(chip).toHaveCount(0);
  await expect(pick).toHaveCount(0);

  // A Ctrl+click with no drag stays the single-pick toggle: the top face on, then off again.
  await page.keyboard.down('Control');
  await page.mouse.click(top[0], top[1]);
  await page.keyboard.up('Control');
  await expect(pick).toHaveText('Face · End (Extrude 1)');
  await page.keyboard.down('Control');
  await page.mouse.click(top[0], top[1]);
  await page.keyboard.up('Control');
  await expect(pick).toHaveCount(0);
  expect(await cameraPos(page)).toEqual(cam0);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-select-orbit-binding a plain left drag orbits wherever it starts (empty space or the body), Shift+drag pans, Alt+Ctrl+drag orbits: nothing selected, no box (the core viewer\'s binding, Daniel 2026-10-06)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  const chip = frame.locator('[data-chip="selection"] [data-selection-count]');
  const pick = frame.locator('[data-pick-info]');
  const corner = await at(page, [0, 0, 0]);
  const fb = (await page.locator('#workspace-frame').boundingBox())!;
  // Empty space: well beside the block, inside the view.
  const empty: [number, number] = [Math.min(corner[0] + 220, fb.x + fb.width - 120), corner[1] - 60];
  expect(await cad<string>(page, (([x, y]: [number, number]) => document.elementFromPoint(x, y)?.tagName ?? 'none') as never, [empty[0] - fb.x, empty[1] - fb.y])).toBe('CANVAS');

  // Plain left drag from empty space: the camera orbits (its direction changes), no box, nothing selected.
  const dir0 = await cameraDir(page);
  await plainDrag(page, frame, empty, [empty[0] + 90, empty[1] + 30]);
  await expect.poll(async () => angleBetween(await cameraDir(page), dir0), { message: 'a plain drag from empty space orbits' }).toBeGreaterThan(5);
  await expect(chip).toHaveCount(0);
  await expect(pick).toHaveCount(0);

  // Plain left drag that starts on the block: orbits too.
  const dir1 = await cameraDir(page);
  const mid = await at(page, [10, 10, 20]);
  await plainDrag(page, frame, mid, [mid[0] - 70, mid[1] + 20]);
  await expect.poll(async () => angleBetween(await cameraDir(page), dir1), { message: 'a plain drag on the block orbits' }).toBeGreaterThan(5);
  await expect(chip).toHaveCount(0);
  await expect(pick).toHaveCount(0);

  // Shift + left drag pans: the direction stays, the camera moves sideways.
  const dir2 = await cameraDir(page);
  const pos2 = await cameraPos(page);
  await page.keyboard.down('Shift');
  await plainDrag(page, frame, empty, [empty[0] + 60, empty[1] - 20]);
  await page.keyboard.up('Shift');
  await expect.poll(async () => dist(await cameraPos(page), pos2), { message: 'Shift + drag pans' }).toBeGreaterThan(1);
  expect(angleBetween(await cameraDir(page), dir2)).toBeLessThan(0.5);

  // Alt + Ctrl + left drag: Alt always moves the camera (no box).
  const dir3 = await cameraDir(page);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Control');
  await plainDrag(page, frame, empty, [empty[0] + 60, empty[1] + 40]);
  await page.keyboard.up('Control');
  await page.keyboard.up('Alt');
  await expect.poll(async () => angleBetween(await cameraDir(page), dir3), { message: 'Alt + Ctrl + drag orbits' }).toBeGreaterThan(5);

  // And Ctrl + drag from the same empty spot draws the box, leaving the camera where it is.
  const pos4 = await cameraPos(page);
  await dragBox(page, frame, empty, [empty[0] + 50, empty[1] + 40], { expect: 'enclose', caption: 'Enclose · edges' });
  expect(await cameraPos(page)).toEqual(pos4);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-select-box-10k a box over a 10,000-face part takes one id pass: faces and edges under 250 ms', { tag: '@serial' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  // The Part's first (empty) rebuild is done: the viewport's binding would replace the bodies set below.
  await expect.poll(() => cad<boolean>(page, (() => {
    const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild;
    return r.seq > 0 && r.status === 'done';
  }) as never)).toBe(true);
  // A synthetic tessellation: a 100 x 100 grid of square faces (2 triangles each) and its lines, an edge per cell side.
  const ms = await cad<{ faces: number; faceMs: number; edges: number; edgeMs: number; touch: number; touchMs: number }>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const h = s.viewport.get().handle;
    const N = 100;
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const ranges: number[] = [];
    const ep: number[] = [];
    const er: number[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const v = pos.length / 3;
        const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        for (const [x, y] of q) {
          pos.push(x, y, 0);
          nrm.push(0, 0, 1);
        }
        ranges.push(idx.length, 6);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    // The grid's lines, one edge per cell side (20,200).
    for (let i = 0; i <= N; i++)
      for (let j = 0; j < N; j++) {
        er.push(ep.length / 3, 2);
        ep.push(i, j, 0, i, j + 1, 0);
        er.push(ep.length / 3, 2);
        ep.push(j, i, 0, j + 1, i, 0);
      }
    const tess = { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), faceRanges: new Uint32Array(ranges), edgePositions: new Float32Array(ep), edgeRanges: new Uint32Array(er) };
    h.setBodies([{ id: 'b_grid', color: '#bdc9db', visible: true, tessKey: 'grid', tess, vertices: null }]);
    h.setView('top', { animate: false });
    h.fit({ animate: false });
    await new Promise((r) => setTimeout(r, 300));
    const c = document.querySelector('[data-cad-canvas]')!.getBoundingClientRect();
    const all = { x0: c.left + 2, y0: c.top + 2, x1: c.right - 2, y1: c.bottom - 2 };
    const faces = h.boxSelect(all, 'enclose', ['face']).length;
    const faceMs = h.stats().lastBoxMs;
    const edges = h.boxSelect(all, 'enclose', ['edge']).length;
    const edgeMs = h.stats().lastBoxMs;
    const mid = { x0: (c.left + c.right) / 2 - 40, y0: (c.top + c.bottom) / 2 - 40, x1: (c.left + c.right) / 2 + 40, y1: (c.top + c.bottom) / 2 + 40 };
    const touch = h.boxSelect(mid, 'touch', ['face']).length;
    const touchMs = h.stats().lastBoxMs;
    return { faces, faceMs, edges, edgeMs, touch, touchMs };
  }) as never);
  test.info().annotations.push({ type: 'box-10k', description: JSON.stringify(ms) });
  console.log(`[box-10k] ${JSON.stringify(ms)}`);
  expect(ms.faces).toBe(10_000);
  expect(ms.edges).toBe(20_200);
  expect(ms.touch).toBeGreaterThan(4);
  expect(ms.faceMs, 'faces box').toBeLessThan(250);
  expect(ms.edgeMs, 'edges box').toBeLessThan(250);
  expect(ms.touchMs, 'touch box').toBeLessThan(250);
  void frame;
  expect(seen.errors).toEqual([]);
});

// ---- Scope addition B (Daniel, 2026-10-06): "Normal to" for a face, a plane or a sketch.

/** The camera's view direction now (unit, from the target to the camera). */
async function viewDir(page: Page): Promise<V3> {
  return cad<V3>(page, (() => {
    const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
    const d = [0, 1, 2].map((k) => c.position[k] - c.target[k]);
    const l = Math.hypot(...d);
    return d.map((x) => x / l);
  }) as never);
}
async function looksAlong(page: Page, n: V3) {
  await idle(page);
  await expect
    .poll(async () => {
      const d = await viewDir(page);
      return Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
    })
    .toBeGreaterThan(0.9999);
}

test("cad:p4b-normal-to Normal to from a face's right-click, a sketch row's right-click, N with a sketch row selected, a sketch's profile right-clicked, and N in sketch mode", async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  // A sketch on the Right plane (normal +X) with a closed profile, beside the block.
  await cad(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const h = s.viewport.get().handle;
    const look = h.lookAt;
    h.lookAt = () => {};
    try {
      const sk = s.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:right' },
        plane: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] },
        points: { a: [-40, 0], b: [-30, 0], c: [-30, 10], d: [-40, 10] },
        entities: [
          { id: 'e1', kind: 'line', p: ['a', 'b'] },
          { id: 'e2', kind: 'line', p: ['b', 'c'] },
          { id: 'e3', kind: 'line', p: ['c', 'd'] },
          { id: 'e4', kind: 'line', p: ['d', 'a'] },
        ],
        constraints: [],
        solved: { values: {}, dof: 8, state: 'under' },
      });
      sk.commit();
    } finally {
      h.lookAt = look;
    }
  }) as never);
  // Built and framed (the new sketch may refit the view): then the points are where they are drawn.
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status === 'done') as never)).toBe(true);
  await page.keyboard.press('7');
  await idle(page);
  const menu = frame.locator('[data-cad-menu]');

  // 1. The block's top face, right-clicked: Normal to looks down Z.
  const top = await at(page, [10, 10, 20]);
  await page.mouse.click(top[0], top[1], { button: 'right' });
  await menu.locator('[data-menu-item="normal-to"]').click();
  await looksAlong(page, [0, 0, 1]);

  // 2. The sketch's row, right-clicked: Normal to looks along +X (the sketch's plane).
  const skRow = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last();
  await skRow.locator('> .tree-row').click({ button: 'right' });
  await expect(menu.locator('[data-menu-item="normal-to"]')).toHaveText('Normal to');
  await menu.locator('[data-menu-item="normal-to"]').click();
  await looksAlong(page, [1, 0, 0]);

  // 3. The isometric view, then N with the sketch's row selected.
  await page.keyboard.press('7');
  await idle(page);
  await skRow.locator('> .tree-row').click();
  await page.keyboard.press('n');
  await looksAlong(page, [1, 0, 0]);

  // 4. The sketch's profile right-clicked in the view: "Normal to Sketch 2".
  await page.keyboard.press('Escape');
  await page.keyboard.press('7');
  await idle(page);
  const prof = await at(page, [0, -35, 5]);
  await page.mouse.click(prof[0], prof[1], { button: 'right' });
  await expect(menu.locator('[data-menu-item="normal-to"]')).toHaveText(/^Normal to Sketch \d$/);
  await menu.locator('[data-menu-item="normal-to"]').click();
  await looksAlong(page, [1, 0, 0]);

  // 5. In sketch mode (the sketch opened), after a turn, N looks normal to it; its button is called Normal to.
  await skRow.locator('> .tree-row').dblclick();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await page.keyboard.press('7');
  await idle(page);
  await page.keyboard.press('n');
  await looksAlong(page, [1, 0, 0]);
  await expect(frame.locator('[data-cad-toolbar] [data-command="view.sketch-look"]')).toHaveAttribute('aria-label', 'Normal to');
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- P4b fix round 1 (review: selection and linked geometry)

test('cad:p4b-fix-p3-ctrl-click-drift a Ctrl+click that drifts 6 px is still the toggle (the third face is added); no box shows and the selection is kept', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  const chip = frame.locator('[data-chip="selection"] [data-selection-count]');
  const top = await at(page, [10, 10, 20]);
  const front = await at(page, [10, 0, 10]);
  // The left face (x = 0): the home view shows the top, the front and the left faces.
  const side = await at(page, [0, 10, 10]);
  await page.mouse.click(top[0], top[1]);
  await page.keyboard.down('Control');
  await page.mouse.click(front[0], front[1]);
  await page.keyboard.up('Control');
  await expect(chip).toHaveText('2 faces');
  // Ctrl down on the third face, a 6 x 2 px drift, up.
  await page.keyboard.down('Control');
  await page.mouse.move(side[0], side[1]);
  await page.mouse.down();
  await page.mouse.move(side[0] + 3, side[1] + 1);
  await page.mouse.move(side[0] + 6, side[1] + 2);
  await expect(frame.locator('[data-box-select]')).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await idle(page);
  await expect(chip).toHaveText('3 faces');
  // A real box (well past 10 px) still boxes.
  const pts = await Promise.all(([[0, 0, 0], [20, 0, 0], [0, 20, 0], [20, 20, 0], [0, 0, 20], [20, 0, 20], [0, 20, 20], [20, 20, 20]] as V3[]).map((q) => at(page, q)));
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  await dragBox(page, frame, [Math.min(...xs) - 25, Math.min(...ys) - 25], [Math.max(...xs) + 25, Math.max(...ys) + 25], { expect: 'enclose' });
  await expect(chip).toHaveText(/edges$/);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p6-lone-line-normal-to a sketch with one line (no profile): a click on the line selects the sketch, a right-click offers "Normal to Sketch N", which looks along its normal', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await cad(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const h = s.viewport.get().handle;
    const look = h.lookAt;
    h.lookAt = () => {};
    try {
      const sk = s.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:right' },
        plane: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] },
        points: { a: [-40, 0], b: [-30, 20] },
        entities: [{ id: 'e1', kind: 'line', p: ['a', 'b'] }],
        constraints: [],
        solved: { values: {}, dof: 4, state: 'under' },
      });
      sk.commit();
    } finally {
      h.lookAt = look;
    }
  }) as never);
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status === 'done') as never)).toBe(true);
  await page.keyboard.press('7');
  await idle(page);
  const mid = await at(page, [0, -35, 10]);
  const row = frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last();
  await page.mouse.click(mid[0], mid[1]);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(row).not.toHaveAttribute('aria-selected', 'true');
  await page.mouse.click(mid[0], mid[1], { button: 'right' });
  const item = frame.locator('[data-cad-menu] [data-menu-item="normal-to"]');
  await expect(item).toHaveText(/^Normal to Sketch \d$/);
  await item.click();
  await looksAlong(page, [1, 0, 0]);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix-p8-bottom-face-roll the bottom face\'s Normal to and a sketch on that face (entry, N, its row\'s Normal to) look with the same up', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSolid(page, { size: [20, 20, 20] });
  await page.keyboard.press('6');
  await idle(page);
  const bottom = await at(page, [10, 10, 0]);
  await page.mouse.click(bottom[0], bottom[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="normal-to"]').click();
  await looksAlong(page, [0, 0, -1]);
  const up0 = await viewUp(page);
  // A sketch on that face: its entry turns the camera with the same up.
  await page.keyboard.press('7');
  await idle(page);
  await page.keyboard.press('6');
  await idle(page);
  await page.mouse.click(bottom[0], bottom[1], { button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="sketch-mode:new-sketch"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await looksAlong(page, [0, 0, -1]);
  expect(dot(await viewUp(page), up0)).toBeGreaterThan(0.999);
  // N in sketch mode.
  await page.keyboard.press('7');
  await idle(page);
  await page.keyboard.press('n');
  await looksAlong(page, [0, 0, -1]);
  expect(dot(await viewUp(page), up0)).toBeGreaterThan(0.999);
  await frame.locator('[data-cad-toolbar] [data-command="sketch.finish"]').click();
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  // Its row's Normal to.
  await page.keyboard.press('7');
  await idle(page);
  await frame.locator('[data-cad-tree] [data-feature-row][data-feature-type="sketch"]').last().locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="normal-to"]').click();
  await looksAlong(page, [0, 0, -1]);
  expect(dot(await viewUp(page), up0)).toBeGreaterThan(0.999);
  expect(seen.errors).toEqual([]);
});

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** The camera's up now (unit). */
async function viewUp(page: Page): Promise<V3> {
  return cad<V3>(page, (() => {
    const c = (window as unknown as W).__CAD__.services.viewport.get().handle.camera();
    const l = Math.hypot(...c.up);
    return c.up.map((x: number) => x / l);
  }) as never);
}

/**
 * A synthetic 10,000-face part (a 100 x 100 grid, its 20,200 cell sides as edges) put in the view, framed from
 * the top. (The viewport alone: its bodies are not in the document, so the chips that read the document's
 * bodies do not apply, but the selection, the highlight and the count chip do.)
 */
async function gridPart(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => {
    const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild;
    return r.seq > 0 && r.status === 'done';
  }) as never)).toBe(true);
  await cad(page, (async () => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const N = 100;
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const ranges: number[] = [];
    const ep: number[] = [];
    const er: number[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        const v = pos.length / 3;
        for (const [x, y] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]) {
          pos.push(x, y, 0);
          nrm.push(0, 0, 1);
        }
        ranges.push(idx.length, 6);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    for (let i = 0; i <= N; i++)
      for (let j = 0; j < N; j++) {
        er.push(ep.length / 3, 2);
        ep.push(i, j, 0, i, j + 1, 0);
        er.push(ep.length / 3, 2);
        ep.push(j, i, 0, j + 1, i, 0);
      }
    const tess = { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx), faceRanges: new Uint32Array(ranges), edgePositions: new Float32Array(ep), edgeRanges: new Uint32Array(er) };
    h.setBodies([{ id: 'b_grid', color: '#bdc9db', visible: true, tessKey: 'grid', tess, vertices: null }]);
    h.setView('top', { animate: false });
    h.fit({ animate: false });
  }) as never);
  await idle(page);
}

test('cad:p4b-fix-b3-box-user-path a Ctrl box over the 10,000-face part, timed as the user meets it: release -> the selection applied, highlighted and the chip updated, and the page answering again', { tag: '@serial' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await gridPart(page);
  const c = (await frame.locator('[data-cad-canvas]').boundingBox())!;
  const chip = frame.locator('[data-chip="selection"] [data-selection-count]');
  const timings: Record<string, number> = {};
  for (const [name, from, to, want] of [
    ['enclose', [c.x + 5, c.y + 5], [c.x + c.width - 5, c.y + c.height - 5], '20200 edges'],
    ['touch', [c.x + c.width / 2 + 60, c.y + c.height / 2 + 60], [c.x + c.width / 2 - 60, c.y + c.height / 2 - 60], null],
  ] as const) {
    await page.mouse.move(from[0], from[1]);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 6 });
    const frames0 = await cad<number>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle.stats().frames) as never);
    const t0 = Date.now();
    await page.mouse.up();
    await page.keyboard.up('Control');
    // The chip shows the new count (the selection applied), then the page answers a round trip after a frame.
    if (want) await expect(chip).toHaveText(want);
    else await expect(chip).toHaveText(/^\d+ edges$/);
    await cad(page, (() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))) as never);
    timings[name] = Date.now() - t0;
    // One frame for the new highlight; none for the box itself, a hover pick at the release, or the dock growing.
    timings[`${name}Frames`] = (await cad<number>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle.stats().frames) as never)) - frames0;
    expect(timings[`${name}Frames`], `${name}: frames drawn after the release`).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(chip).toHaveCount(0);
  }
  test.info().annotations.push({ type: 'box-user-path', description: JSON.stringify(timings) });
  console.log(`[box-user-path] ${JSON.stringify(timings)}`);
  expect(timings.enclose, 'release -> selection, highlight and chip').toBeLessThan(1500);
  expect(timings.touch, 'release -> selection, highlight and chip').toBeLessThan(1500);
  expect(seen.errors).toEqual([]);
});
