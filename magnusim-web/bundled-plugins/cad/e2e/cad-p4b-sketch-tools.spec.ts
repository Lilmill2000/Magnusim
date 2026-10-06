// P4b sketch tools in the real host frame, each asserting what the user sees: the
// status chip's words (DOF), the entities drawn, the panel's rows, the profile count
// Extrude offers and the volume chip (checked analytically).
//  - Spline (S): fit points, 8 DOF for 4 points, a fit point drags and the curve
//    follows; Enter places a control-point spline without finishing the sketch;
//    a closed spline and a spline + line close profiles that extrude to the volume
//    Green's theorem gives.
//  - Mirror (M): copies tied by Symmetric, points on the line shared, still fully
//    defined; two profiles.
//  - Linear and circular patterns: copies follow, the row's count re-lays them out.
//  - Offset (O): an outside copy of a closed chain at the distance; its row edits it.
//  - Fillet and chamfer: a corner rounded / cut, still fully defined, the volume.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
// fix1: the curve as drawn, computed independently of the trim (the spline's own math on the points placed).
import { closestOnSpline, fitSpline, splineGreen, subSpline } from '../src/sketch/tools/bspline';
import { baseUrl, chipVolumes, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, singleVolume, watchPage, workspaceFrame } from './helpers';

type V3 = [number, number, number];
type V2 = [number, number];

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** Page coordinates of a model point. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project(pt) : null;
  }, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

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

async function sketchIdle(page: Page) {
  await workspaceFrame(page).evaluate(async () => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { idle?(): Promise<void> } | null } } } } }).__CAD__.services.apis.get().sketch;
    await api?.idle?.();
  });
}

const clickAt = async (page: Page, p: V2) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  await page.mouse.click(x, y);
};

/** The sketch being edited, as drawn now: its entities by kind and its points. */
async function drawn(page: Page): Promise<{ kinds: Record<string, number>; points: Record<string, V2>; entities: { id: string; kind: string; pts?: string[]; construction?: boolean }[]; ties: { kind: string; copies: number }[] }> {
  return workspaceFrame(page).evaluate(() => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): { points: Record<string, [number, number]>; entities: { id: string; kind: string; pts?: string[]; construction?: boolean }[]; ties?: { kind: string; copies: unknown[] }[] } | null } } } } } }).__CAD__.services.apis.get().sketch;
    const d = api.draft();
    const kinds: Record<string, number> = {};
    for (const e of d?.entities ?? []) if (!e.construction) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return { kinds, points: d?.points ?? {}, entities: d?.entities ?? [], ties: (d?.ties ?? []).map((t) => ({ kind: t.kind, copies: t.copies.length })) };
  });
}

const chip = (frame: FrameLocator) => frame.locator('[data-chip="sketch"]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="sketch"]');

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

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
  await expect(chip(frame)).toHaveText('Fully defined');
}

/** A circle of diameter D at a point (C, a click, D Enter). */
async function typedCircle(page: Page, frame: FrameLocator, c: V2, dia: number) {
  await page.keyboard.press('c');
  await clickAt(page, c);
  const [x, y] = await at(page, [c[0] + dia, c[1], 0]);
  await page.mouse.move(x, y);
  await expect(frame.locator('[data-sketch-box="diameter"]')).toBeVisible();
  await page.keyboard.type(String(dia));
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
}

async function finish(frame: FrameLocator) {
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
}

/** Extrude every profile of the sketch named (its tree row, then Extrude): the profiles it offers, then H typed and Done. */
async function extrudeAll(frame: FrameLocator, sketch: string, profiles: number, h: number) {
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(?:[(]-[)] )?${sketch}$`) }) });
  await row.locator('> .tree-row').click();
  await runCommand(frame, 'solid.extrude');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-profile-list] [data-profile]')).toHaveCount(profiles);
  const dist = p.locator('.nui[data-field="distance"] input');
  await dist.fill(String(h));
  await dist.press('Enter');
  await expect(p.locator('.nui[data-field="distance"] [data-nui-error]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
}

/** Exact area of a closed uniform periodic cubic B-spline on poles P (Green, 4-point Gauss per span: exact for its degree-5 integrand). */
function periodicCubicArea(P: V2[]): number {
  const n = P.length;
  const g: [number, number][] = [
    [-0.8611363115940526, 0.3478548451374538],
    [-0.3399810435848563, 0.6521451548625461],
    [0.3399810435848563, 0.6521451548625461],
    [0.8611363115940526, 0.3478548451374538],
  ];
  let A = 0;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [P[i], P[(i + 1) % n], P[(i + 2) % n], P[(i + 3) % n]];
    for (const [x, w] of g) {
      const t = (x + 1) / 2;
      const b = [(1 - t) ** 3 / 6, (3 * t ** 3 - 6 * t ** 2 + 4) / 6, (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6, t ** 3 / 6];
      const db = [-((1 - t) ** 2) / 2, (3 * t ** 2 - 4 * t) / 2, (-3 * t ** 2 + 2 * t + 1) / 2, t ** 2 / 2];
      const X = b[0] * p0[0] + b[1] * p1[0] + b[2] * p2[0] + b[3] * p3[0];
      const Y = b[0] * p0[1] + b[1] * p1[1] + b[2] * p2[1] + b[3] * p3[1];
      const DX = db[0] * p0[0] + db[1] * p1[0] + db[2] * p2[0] + db[3] * p3[0];
      const DY = db[0] * p0[1] + db[1] * p1[1] + db[2] * p2[1] + db[3] * p3[1];
      A += (w / 2) * (X * DY - Y * DX) / 2;
    }
  }
  return Math.abs(A);
}

/** Area between a cubic Bezier (4 poles) and its chord (Green: the curve, then the chord back; exact by 4-point Gauss). */
function bezierChordArea(P: V2[]): number {
  const g: [number, number][] = [
    [-0.8611363115940526, 0.3478548451374538],
    [-0.3399810435848563, 0.6521451548625461],
    [0.3399810435848563, 0.6521451548625461],
    [0.8611363115940526, 0.3478548451374538],
  ];
  let A = 0;
  for (const [x, w] of g) {
    const t = (x + 1) / 2;
    const b = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
    const db = [-3 * (1 - t) ** 2, 3 * (1 - t) ** 2 - 6 * (1 - t) * t, 6 * (1 - t) * t - 3 * t ** 2, 3 * t ** 2];
    const X = b.reduce((s, k, i) => s + k * P[i][0], 0);
    const Y = b.reduce((s, k, i) => s + k * P[i][1], 0);
    const DX = db.reduce((s, k, i) => s + k * P[i][0], 0);
    const DY = db.reduce((s, k, i) => s + k * P[i][1], 0);
    A += ((w / 2) * (X * DY - Y * DX)) / 2;
  }
  // The chord from the last pole back to the first.
  A += (P[3][0] * P[0][1] - P[0][0] * P[3][1]) / 2;
  return Math.abs(A);
}

test('cad:p4b-sketch-spline-fit fit-point spline: S, four clicks and a double-click; 8 DOF; a fit point drags and the curve follows; Enter places a control-point spline', { tag: '@smoke' }, async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await page.keyboard.press('s');
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('Click where the spline starts');
  for (const p of [[-30, -10], [-10, 10], [10, -10]] as V2[]) await clickAt(page, p);
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('3 so far');
  const [lx, ly] = await at(page, [30, 10, 0]);
  await page.mouse.dblclick(lx, ly);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ spline: 1 });
  expect(d.entities[0].pts).toHaveLength(4);
  await expect(chip(frame)).toHaveText('Under defined · 8 DOF');

  // Drag the second fit point up 10: the spline passes through it there (the curve follows).
  await page.keyboard.press('Escape');
  const second = d.entities[0].pts![1];
  const [sx, sy] = await at(page, [-10, 10, 0]);
  const [tx, ty] = await at(page, [-10, 20, 0]);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.up();
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.points[second][1]).toBeGreaterThan(16);
  await expect(chip(frame)).toHaveText('Under defined · 8 DOF');

  // Control-point spline: four clicks, then Enter places it and the sketch stays open.
  await runCommand(frame, 'sketch.spline-control');
  await expect(panel(frame).locator('[data-sketch-options="spline-control"] select')).toHaveValue('3');
  for (const p of [[-30, -30], [-10, -20], [10, -40], [30, -30]] as V2[]) await clickAt(page, p);
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  d = await drawn(page);
  expect(d.kinds).toEqual({ spline: 2 });
  await expect(chip(frame)).toHaveText('Under defined · 16 DOF');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-spline-profiles a closed control-point spline and a Bezier closed by a line are profiles; their extrudes have the analytic volumes', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  // Closed: four poles, a click on the first closes it (no degree 3 points short).
  await runCommand(frame, 'sketch.spline-control');
  const poles: V2[] = [[20, 0], [40, 0], [40, 20], [20, 20]];
  for (const p of poles) await clickAt(page, p);
  await clickAt(page, poles[0]);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ spline: 1 });
  await expect(chip(frame)).toHaveText('Under defined · 8 DOF');
  // The analytic area from the poles as placed (a click lands within a pixel of the aim).
  const closedSp = d.entities[0].pts!.map((id) => d.points[id]);
  const closedArea = periodicCubicArea(closedSp);
  expect(closedArea).toBeGreaterThan(200);
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  // B-spline sides: OCCT's volume integration is good to ~1e-6 relative (lines and arcs are exact).
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / (closedArea * 10) - 1)).toBeLessThan(1e-5);
  // Sketch 2: an open Bezier (4 poles) from (0, 0) up and over to (-40, 0), closed by a line along the x axis.
  // (Its own sketch: one Extrude of a closed spline region with another region is 0.04 % off in the kernel, R5.)
  await enterSketchOnTop(page, frame);
  // The view framed the body: zoom out about the origin so -40..40 is on screen.
  const [ox, oy] = await at(page, [0, 0, 0]);
  await page.mouse.move(ox, oy);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
  await settled(page);
  await runCommand(frame, 'sketch.spline-control');
  for (const p of [[0, 0], [0, 30], [-40, 30], [-40, 0]] as V2[]) await clickAt(page, p);
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('l');
  await clickAt(page, [-40, 0]);
  await clickAt(page, [0, 0]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.kinds).toEqual({ spline: 1, line: 1 });
  const bez = d.entities.find((e) => e.kind === 'spline')!.pts!.map((id) => d.points[id] ?? ([0, 0] as V2));
  const bezArea = bezierChordArea(bez);
  expect(bezArea).toBeGreaterThan(700);
  await finish(frame);
  await extrudeAll(frame, 'Sketch 2', 1, 10);
  await expect.poll(async () => (await chipVolumes(frame)).length).toBe(2);
  const vols = (await chipVolumes(frame)).sort((a, b) => a - b);
  const want = [closedArea * 10, bezArea * 10].sort((a, b) => a - b);
  expect(Math.abs(vols[0] / want[0] - 1)).toBeLessThan(1e-5);
  expect(Math.abs(vols[1] / want[1] - 1)).toBeLessThan(1e-5);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-mirror mirror a rectangle about its own edge: Symmetric copies, shared points, still fully defined, two profiles, 12000 mm3', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 30, 20);
  await page.keyboard.press('m');
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('Pick the entities to mirror');
  for (const p of [[15, 0], [30, 10], [15, 20]] as V2[]) await clickAt(page, p);
  await expect(panel(frame).locator('[data-sketch-option="picked"]')).toHaveText('To mirror: Line 1, Line 2, Line 3');
  await panel(frame).locator('[data-sketch-option="next"]').click();
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('Click the mirror line');
  await clickAt(page, [0, 10]);
  await sketchIdle(page);
  const d = await drawn(page);
  // The left edge is on the mirror line: not copied; its ends are shared by the copies.
  expect(d.kinds).toEqual({ line: 7 });
  await expect(frame.locator('[data-sketch-glyph="symmetric"]')).toHaveCount(2);
  await expect(chip(frame)).toHaveText('Fully defined');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 2, 10);
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(12000, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-linear-pattern a circle in a row of 4 at 20 mm, the row count to 6; fully defined; six cylinders', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedCircle(page, frame, [0, 0], 10);
  await expect(chip(frame)).toHaveText('Fully defined');
  await runCommand(frame, 'sketch.pattern-linear');
  await clickAt(page, [5, 0]);
  const opts = panel(frame).locator('[data-sketch-options="pattern-linear"]');
  await expect(opts.locator('[data-sketch-option="picked"]')).toHaveText('To pattern: Circle 1');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  await count.fill('4');
  await count.press('Enter');
  const spacing = opts.locator('.nui[data-field="sk-spacing1"] input');
  await spacing.fill('20');
  await spacing.press('Enter');
  await opts.locator('[data-sketch-option="place"]').click();
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ circle: 4 });
  expect(d.ties).toEqual([{ kind: 'linear', copies: 3 }]);
  await expect(chip(frame)).toHaveText('Fully defined');
  const row = panel(frame).locator('[data-sketch-tie]');
  await expect(row).toHaveAttribute('data-tie-instances', '4');
  await expect(row).toContainText('Linear pattern 1 of Circle 1');
  // The row: count 6 lays out two more.
  const rc = row.locator('.nui[data-field="tie-count"] input');
  await rc.fill('6');
  await rc.press('Enter');
  await sketchIdle(page);
  await expect(row).toHaveAttribute('data-tie-instances', '6');
  d = await drawn(page);
  expect(d.kinds).toEqual({ circle: 6 });
  const xs = Object.values(d.points).map((p) => Math.round(p[0] * 1000) / 1000).sort((a, b) => a - b);
  expect(xs).toEqual([0, 20, 40, 60, 80, 100]);
  await expect(chip(frame)).toHaveText('Fully defined');
  await finish(frame);
  // One Extrude of six separate profiles: one body of six cylinders.
  await extrudeAll(frame, 'Sketch 1', 6, 5);
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(6 * Math.PI * 25 * 5, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-circular-pattern six circles round the origin follow their source; 2 DOF stay 2 DOF', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedCircle(page, frame, [25, 0], 8);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  await runCommand(frame, 'sketch.pattern-circular');
  await clickAt(page, [29, 0]);
  const opts = panel(frame).locator('[data-sketch-options="pattern-circular"]');
  await expect(opts.locator('[data-sketch-option="centre"]')).toHaveText('Centre: the sketch origin');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  await count.fill('6');
  await count.press('Enter');
  await opts.locator('[data-sketch-option="place"]').click();
  await sketchIdle(page);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ circle: 6 });
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  // Every centre is as far from the origin as the source's.
  const centres = Object.values(d.points).filter((p) => Math.hypot(p[0], p[1]) > 1);
  expect(centres).toHaveLength(6);
  // As far out as the source's centre (clicked near 25), each one.
  const r0 = Math.hypot(centres[0][0], centres[0][1]);
  expect(r0).toBeCloseTo(25, 1);
  for (const c of centres) expect(Math.hypot(c[0], c[1])).toBeCloseTo(r0, 6);
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 6, 4);
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(6 * Math.PI * 16 * 4, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-offset an outside offset of a rectangle at 5 mm: fully defined, its row sets 4 mm; the profiles extrude to a 38 x 28 block', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 30, 20);
  await page.keyboard.press('o');
  const [x, y] = await at(page, [15, -3, 0]);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ line: 8 });
  expect(d.ties).toEqual([{ kind: 'offset', copies: 1 }]);
  await expect(chip(frame)).toHaveText('Fully defined');
  const ext = () => {
    const xs = Object.values(d.points).map((p) => p[0]);
    return [Math.min(...xs), Math.max(...xs)];
  };
  expect(ext()[0]).toBeCloseTo(-5, 6);
  const row = panel(frame).locator('[data-sketch-tie][data-tie-kind="offset"]');
  await expect(row).toContainText(/^Offset 1 of Line \d, Line \d, Line \d and 1 more/);
  const dist = row.locator('.nui[data-field="tie-distance"] input');
  await dist.fill('4');
  await dist.press('Enter');
  await sketchIdle(page);
  d = await drawn(page);
  expect(ext()[0]).toBeCloseTo(-4, 6);
  expect(ext()[1]).toBeCloseTo(34, 6);
  await expect(chip(frame)).toHaveText('Fully defined');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 2, 10);
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(38 * 28 * 10, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-fillet-chamfer a 5 mm fillet and a 4 mm chamfer on a 40 x 20 rectangle: still fully defined; the volume loses r^2(1 - pi/4) and 8 mm2 x height', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 40, 20);
  await runCommand(frame, 'sketch.fillet');
  await expect(panel(frame).locator('[data-sketch-hint]')).toContainText('Pick a corner or two curves');
  await expect(panel(frame).locator('.nui[data-field="sk-radius"] input')).toHaveValue('5');
  await clickAt(page, [40, 20]);
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ line: 4, arc: 1 });
  await expect(chip(frame)).toHaveText('Fully defined');
  await expect(frame.locator('[data-sketch-dim]', { hasText: /^R ?5 mm$/ })).toHaveCount(1);
  // Chamfer the opposite corner (the origin corner), 4 mm both ways, picking its two lines.
  await runCommand(frame, 'sketch.chamfer');
  const dist = panel(frame).locator('.nui[data-field="sk-distance1"] input');
  await dist.fill('4');
  await dist.press('Enter');
  await clickAt(page, [20, 0]);
  await clickAt(page, [0, 10]);
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.kinds).toEqual({ line: 5, arc: 1 });
  await expect(chip(frame)).toHaveText('Fully defined');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  const area = 800 - 25 * (1 - Math.PI / 4) - 8;
  await expect.poll(() => singleVolume(frame)).toBeCloseTo(area * 10, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-spline-trim fix1 B2/B4: a line trimmed against a fit spline ends ON it and the spline keeps its points; the spline trimmed at the line is the curve it was (extruded region = the drawn curve)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await page.keyboard.press('s');
  for (const p of [[-45, 0], [-15, 25], [15, -25]] as V2[]) await clickAt(page, p);
  const [lx, ly] = await at(page, [45, 0, 0]);
  await page.mouse.dblclick(lx, ly);
  await sketchIdle(page);
  await page.keyboard.press('l');
  await clickAt(page, [-35, -12]);
  await clickAt(page, [-35, 30]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds).toEqual({ spline: 1, line: 1 });
  const fitIds = d.entities.find((e) => e.kind === 'spline')!.pts!;
  const fitBefore = fitIds.map((id) => d.points[id]);
  // B2: trim the line above the spline.
  await page.keyboard.press('t');
  await clickAt(page, [-35, 28]);
  await sketchIdle(page);
  d = await drawn(page);
  const sp1 = d.entities.find((e) => e.kind === 'spline')!;
  // The spline keeps its four fit points where they were (it was re-shaped by a 5th before).
  expect(sp1.pts).toEqual(fitIds);
  expect(sp1.pts!.map((id) => d.points[id])).toEqual(fitBefore);
  const line = d.entities.find((e) => e.kind === 'line') as unknown as { p: [string, string] };
  const lineEnd = [line.p[0], line.p[1]].sort((a, b) => d.points[b][1] - d.points[a][1])[0];
  // The cut end is ON the curve as drawn, held there by On curve.
  const orig = fitSpline(fitBefore);
  expect(closestOnSpline(orig, d.points[lineEnd]).d).toBeLessThan(1e-6);
  await expect(frame.locator('[data-sketch-glyph="point_on_circle"]')).toHaveCount(1);
  // B4: trim the spline's left tail: it now starts at the line's end, the same point.
  await clickAt(page, [-42, 4.5]);
  await sketchIdle(page);
  d = await drawn(page);
  const sp2 = d.entities.find((e) => e.kind === 'spline')!;
  expect(sp2.pts![0]).toBe(lineEnd);
  // Close a region under it and extrude it: its volume is the region under the curve AS DRAWN.
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  for (const p of [[45, 0], [45, -40], [-35, -40], [-35, -12]] as V2[]) await clickAt(page, p);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  const X = d.points[lineEnd];
  const uCut = closestOnSpline(orig, X).u;
  const kept = subSpline(orig, uCut, 1);
  // Green: the kept curve X -> (45, 0), then the lines (45, 0) -> (45, -40) -> (-35, -40) -> (-35, -12) -> X.
  const near = (q: V2) => Object.values(d.points).reduce((a, b) => (Math.hypot(b[0] - q[0], b[1] - q[1]) < Math.hypot(a[0] - q[0], a[1] - q[1]) ? b : a));
  const loop: V2[] = [fitBefore[3], near([45, -40]), near([-35, -40]), near([-35, -12]), X];
  let area = splineGreen(kept);
  for (let i = 1; i < loop.length; i++) area += (loop[i - 1][0] * loop[i][1] - loop[i][0] * loop[i - 1][1]) / 2;
  area = Math.abs(area);
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / (area * 10) - 1)).toBeLessThan(1e-5);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix1-pattern-source-still editing a pattern row moves only the copies: an under-defined source stays where it was drawn (circular and linear)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedCircle(page, frame, [30, 0], 6);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  const source = async () => {
    const d = await drawn(page);
    const c = d.entities.find((e) => e.kind === 'circle')!;
    return d.points[(c as unknown as { c: string }).c];
  };
  const start = await source();
  await runCommand(frame, 'sketch.pattern-circular');
  await clickAt(page, [33, 0]);
  const opts = panel(frame).locator('[data-sketch-options="pattern-circular"]');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  await count.fill('4');
  await count.press('Enter');
  await opts.locator('[data-sketch-option="full"]').uncheck();
  const ang = opts.locator('.nui[data-field="sk-angle"] input');
  await ang.fill('90');
  await ang.press('Enter');
  await opts.locator('[data-sketch-option="place"]').click();
  await sketchIdle(page);
  const row = panel(frame).locator('[data-sketch-tie][data-tie-kind="circular"]');
  await expect(row).toHaveAttribute('data-tie-instances', '4');
  // The reviewer's four edits: angle 60, count 7, full circle on, off.
  const rowAngle = row.locator('.nui[data-field="tie-angle"] input');
  await rowAngle.fill('60');
  await rowAngle.press('Enter');
  await sketchIdle(page);
  const rowCount = row.locator('.nui[data-field="tie-count"] input');
  await rowCount.fill('7');
  await rowCount.press('Enter');
  await sketchIdle(page);
  await row.locator('[data-tie-full]').click();
  await sketchIdle(page);
  await expect(row.locator('[data-tie-full]')).toBeChecked();
  await row.locator('[data-tie-full]').click();
  await sketchIdle(page);
  await expect(row.locator('[data-tie-full]')).not.toBeChecked();
  const now = await source();
  expect(now[0]).toBeCloseTo(start[0], 6);
  expect(now[1]).toBeCloseTo(start[1], 6);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ circle: 7 });
  for (const e of d.entities) expect((e as unknown as { r: number }).r).toBeCloseTo(3, 6);
  await expect(chip(frame)).toHaveText('Under defined · 2 DOF');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix1-offset-rounded fix1 B3: an offset of a rounded rectangle (four fillets) places, stays fully defined, and extrudes to the analytic area', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 40, 30);
  await runCommand(frame, 'sketch.fillet');
  const r = panel(frame).locator('.nui[data-field="sk-radius"] input');
  await r.fill('8');
  await r.press('Enter');
  for (const p of [[40, 30], [0, 0], [40, 0], [0, 30]] as V2[]) {
    await clickAt(page, p);
    await sketchIdle(page);
  }
  await expect(chip(frame)).toHaveText('Fully defined');
  await page.keyboard.press('o');
  const [x, y] = await at(page, [20, -3, 0]);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await sketchIdle(page);
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ line: 8, arc: 8 });
  expect(d.ties).toEqual([{ kind: 'offset', copies: 1 }]);
  await expect(chip(frame)).toHaveText('Fully defined');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 2, 10);
  // The outside offset of a 40 x 30 rectangle with R8 corners by 5: 50 x 40 with R13 corners.
  const area = 50 * 40 - (4 - Math.PI) * 13 * 13;
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / (area * 10) - 1)).toBeLessThan(1e-7);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix1-pattern-skip fix1 B5: a deleted pattern copy stays deleted when the count changes; the row says so and Restore brings it back', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedCircle(page, frame, [0, 0], 10);
  await runCommand(frame, 'sketch.pattern-linear');
  await clickAt(page, [5, 0]);
  const opts = panel(frame).locator('[data-sketch-options="pattern-linear"]');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  await count.fill('4');
  await count.press('Enter');
  const spacing = opts.locator('.nui[data-field="sk-spacing1"] input');
  await spacing.fill('20');
  await spacing.press('Enter');
  await opts.locator('[data-sketch-option="place"]').click();
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  // Delete the copy at x = 40.
  await clickAt(page, [45, 0]);
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  const centresX = async () => {
    const dd = await drawn(page);
    return dd.entities.filter((e) => e.kind === 'circle').map((e) => Math.round(dd.points[(e as unknown as { c: string }).c][0] * 1000) / 1000).sort((a, b) => a - b);
  };
  expect(await centresX()).toEqual([0, 20, 60]);
  const row = panel(frame).locator('[data-sketch-tie][data-tie-kind="linear"]');
  await expect(row.locator('[data-tie-skipped]')).toContainText('1 instance deleted (skipped)');
  await expect(row).toHaveAttribute('data-tie-instances', '3');
  const rc = row.locator('.nui[data-field="tie-count"] input');
  await rc.fill('5');
  await rc.press('Enter');
  await sketchIdle(page);
  expect(await centresX()).toEqual([0, 20, 60, 80]);
  await row.locator('[data-tie-restore]').click();
  await sketchIdle(page);
  expect(await centresX()).toEqual([0, 20, 40, 60, 80]);
  await expect(row.locator('[data-tie-skipped]')).toHaveCount(0);
  await expect(chip(frame)).toHaveText('Fully defined');
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix1-polish fillet labels stay outside and clickable (P4); Enter after typing in the pattern panel places it (P5); deleting the source says the pattern is gone (P6); chamfer Same distance is one value (P7)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 40, 30);
  // P4: four fillets; the 40 and 30 labels are outside the part and nothing covers them.
  await runCommand(frame, 'sketch.fillet');
  for (const p of [[40, 30], [0, 0], [40, 0], [0, 30]] as V2[]) {
    await clickAt(page, p);
    await sketchIdle(page);
  }
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  const [x0, y0] = await at(page, [0, 0, 0]);
  const [x1, y1] = await at(page, [40, 30, 0]);
  const part = { left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) };
  const fbox = (await page.locator('#workspace-frame').boundingBox())!;
  for (const v of ['40', '30']) {
    const label = frame.locator('[data-sketch-dim]', { hasText: new RegExp(`^${v} mm$`) });
    const b = (await label.boundingBox())!;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const inside = cx > part.left && cx < part.right && cy > part.top && cy < part.bottom;
    expect(inside, `label ${v} inside the part`).toBe(false);
    const top = await workspaceFrame(page).evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el?.closest('[data-sketch-dim]')?.textContent ?? el?.closest('[data-sketch-glyph]')?.getAttribute('data-sketch-glyph') ?? null;
    }, [cx - fbox.x, cy - fbox.y]);
    expect(top).toBe(`${v} mm`);
  }
  await expect(chip(frame)).toHaveText('Fully defined');
  // P5 + P6 on a circle pattern.
  await typedCircle(page, frame, [-25, -15], 6);
  await runCommand(frame, 'sketch.pattern-linear');
  await clickAt(page, [-22, -15]);
  const opts = panel(frame).locator('[data-sketch-options="pattern-linear"]');
  const count = opts.locator('.nui[data-field="sk-count"] input');
  // A refused entry keeps the keyboard in the field, with the reason.
  await count.fill('1');
  await count.press('Enter');
  await expect(opts.locator('.nui[data-field="sk-count"] [data-nui-error]')).toContainText('A whole number from 2');
  await expect(count).toBeFocused();
  // An accepted one hands it back at once: the very next Enter places (final check: in real Chrome the
  // field kept the keyboard for that Enter while the hand-back waited for a timer).
  await count.fill('3');
  await count.press('Enter');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  let d = await drawn(page);
  expect(d.kinds.circle).toBe(3);
  await page.keyboard.press('Escape');
  await clickAt(page, [-22, -15]);
  await page.keyboard.press('Delete');
  await sketchIdle(page);
  await expect(panel(frame).locator('[data-run-reason]')).toContainText('Linear pattern 1 is gone with its source: the 2 copies stay as free geometry (Undo brings it back).');
  d = await drawn(page);
  expect(d.kinds.circle).toBe(2);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-fix1-chamfer-same fix1 P7: chamfer Same distance is one dimension: editing it cuts both lines (the volume)', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await typedRectangle(page, frame, 20, 10);
  await runCommand(frame, 'sketch.chamfer');
  await expect(panel(frame).locator('[data-sketch-option="equal"]')).toBeChecked();
  const dist = panel(frame).locator('.nui[data-field="sk-distance1"] input');
  await dist.fill('3');
  await dist.press('Enter');
  await clickAt(page, [20, 10]);
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await expect(frame.locator('[data-sketch-dim]', { hasText: /^3 mm$/ })).toHaveCount(1);
  await expect(frame.locator('[data-sketch-glyph="equal"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await frame.locator('[data-sketch-dim]', { hasText: /^3 mm$/ }).dblclick();
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await edit.fill('5');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Fully defined');
  await page.keyboard.press('Escape');
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  await expect.poll(() => singleVolume(frame)).toBeCloseTo((200 - 12.5) * 10, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-spline-revolve a profile with a control-point spline side, revolved about the sketch centerline: Pappus volume', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  // Three lines of the profile, then the spline side joining their free ends, then the axis.
  await page.keyboard.press('l');
  for (const p of [[20, 30], [10, 30], [10, 0], [20, 0]] as V2[]) await clickAt(page, p);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await runCommand(frame, 'sketch.spline-control');
  for (const p of [[20, 0], [30, 10], [30, 20], [20, 30]] as V2[]) await clickAt(page, p);
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await runCommand(frame, 'sketch.centerline');
  await clickAt(page, [0, -5]);
  await clickAt(page, [0, 40]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  const d = await drawn(page);
  expect(d.kinds).toEqual({ line: 3, spline: 1 });
  const sp = d.entities.find((e) => e.kind === 'spline')!.pts!.map((id) => d.points[id]);
  // Pappus: V = 2 pi * (first moment of the region about the axis x = 0) = 2 pi |oint x^2/2 dy|, along the
  // loop spline P0 -> P3, then the lines P3 -> (10, 30) -> (10, 0) -> P0 (the drawn points nearest those).
  const near = (q: V2) => Object.values(d.points).reduce((a, b) => (Math.hypot(b[0] - q[0], b[1] - q[1]) < Math.hypot(a[0] - q[0], a[1] - q[1]) ? b : a));
  const g: [number, number][] = [
    [-0.8611363115940526, 0.3478548451374538],
    [-0.3399810435848563, 0.6521451548625461],
    [0.3399810435848563, 0.6521451548625461],
    [0.8611363115940526, 0.3478548451374538],
  ];
  let m = 0;
  for (const [x, w] of g) {
    const t = (x + 1) / 2;
    const b = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
    const db = [-3 * (1 - t) ** 2, 3 * (1 - t) ** 2 - 6 * (1 - t) * t, 6 * (1 - t) * t - 3 * t ** 2, 3 * t ** 2];
    const X = b.reduce((s, k, i) => s + k * sp[i][0], 0);
    const DY = db.reduce((s, k, i) => s + k * sp[i][1], 0);
    m += (w / 2) * ((X * X) / 2) * DY;
  }
  const loop = [sp[3], near([10, 30]), near([10, 0]), sp[0]];
  // A straight segment: oint x^2/2 dy = (y1 - y0) (x0^2 + x0 x1 + x1^2) / 6.
  for (let i = 1; i < loop.length; i++) m += ((loop[i][1] - loop[i - 1][1]) * (loop[i - 1][0] ** 2 + loop[i - 1][0] * loop[i][0] + loop[i][0] ** 2)) / 6;
  const want = 2 * Math.PI * Math.abs(m);
  expect(want).toBeGreaterThan(2 * Math.PI * 15 * 300);
  await finish(frame);
  await runCommand(frame, 'solid.revolve');
  const p = frame.locator('[data-cad-panel="feature"]');
  await expect(p.locator('[data-pick-field="profiles"] [data-pick-row]')).toHaveCount(1);
  await expect(p.locator('[data-pick-field="axis"] [data-pick-row]')).toHaveText(/Line of Sketch 1/);
  await p.locator('[data-panel-done]').click();
  await expect.poll(async () => Math.abs((await singleVolume(frame)) / want - 1)).toBeLessThan(1e-5);
  expect(seen.errors).toEqual([]);
});

test('cad:p4b-sketch-spline-tangent Tangent between a line and a fit spline at their shared end adds a handle there: 8 DOF become 9, the line turns along the curve', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await page.keyboard.press('l');
  await clickAt(page, [-30, -20]);
  await clickAt(page, [-10, 0]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  await clickAt(page, [-10, 0]);
  await clickAt(page, [10, 15]);
  const [lx, ly] = await at(page, [30, 0, 0]);
  await page.mouse.dblclick(lx, ly);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(chip(frame)).toHaveText('Under defined · 8 DOF');
  // Select the line, Ctrl+click the spline, Tangent.
  await clickAt(page, [-20, -10]);
  // Ctrl+click the curve between its points (found by walking up x = 20 until the spline is picked).
  const splineId = (await drawn(page)).entities.find((e) => e.kind === 'spline')!.id;
  const picked = () => workspaceFrame(page).evaluate((id) => (window as unknown as { __CAD__: { services: { selection: { get(): { items: { kind: string; id?: string }[] } } } } }).__CAD__.services.selection.get().items.some((it) => it.kind === 'sketch' && it.id === id), splineId);
  for (let y = 4; y <= 18 && !(await picked()); y += 1) {
    const [sx, sy] = await at(page, [20, y, 0]);
    await page.keyboard.down('Control');
    await page.mouse.click(sx, sy);
    await page.keyboard.up('Control');
  }
  expect(await picked()).toBe(true);
  await expect(panel(frame).locator('[data-sketch-selection]')).toContainText('Line 1, Spline 1');
  await runCommand(frame, 'sketch.tangent');
  await sketchIdle(page);
  await expect(chip(frame)).toHaveText('Under defined · 9 DOF');
  // One Tangent relation: its glyph beside each of the two curves it names.
  await expect(frame.locator('[data-sketch-glyph="tangent"]')).toHaveCount(2);
  const d = await drawn(page);
  const sp = d.entities.find((e) => e.kind === 'spline') as unknown as { pts: string[]; handles: [string | null, string | null] };
  expect(sp.handles[0]).toBeTruthy();
  // The line runs along the handle's direction: (start -> joint) parallel to (joint -> handle).
  const line = d.entities.find((e) => e.kind === 'line') as unknown as { p: [string, string] };
  const [a, j] = line.p.map((id) => d.points[id]);
  const h = d.points[sp.handles[0]!];
  const u: V2 = [j[0] - a[0], j[1] - a[1]];
  const v: V2 = [h[0] - j[0], h[1] - j[1]];
  expect(Math.abs(u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v))).toBeLessThan(1e-6);
  expect(seen.errors).toEqual([]);
});

// ------------------------------------------------------------ P4b follow-up (Daniel, 2026-10-06)

/** A Part in a new project with these units (Imperial: inches). */
async function freshPartIn(page: Page, request: Parameters<typeof newProject>[0], units: 'Metric' | 'Imperial') {
  const seen = await watchPage(page);
  await ensureCadOn(request);
  const r = await request.post(`${baseUrl()}/api/project`, { data: { title: `CAD e2e ${Date.now()}`, category: 'Other', units } });
  expect(r.ok(), await r.text()).toBe(true);
  await openProject(page, String((await r.json()).id));
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** What the sketch's hover halo is on now (an entity or point id), or null. */
async function hovered(page: Page): Promise<string | null> {
  return workspaceFrame(page).evaluate(() => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { view?: { get(): { hover: { id: string } | null } } } | null } } } } }).__CAD__.services.apis.get().sketch;
    return api?.view?.get().hover?.id ?? null;
  });
}

test('cad:p4b-fu-dim-units a dimension shows its unit next to its value: on the sketch (⌀125 mm), in the value boxes while drawing (mm, °) and in the edit box; "5 in" typed in a mm document reads 127 mm, a bare number is in mm as before; an inch document reads in', async ({ page, request }) => {
  const { seen, frame } = await freshPartIn(page, request, 'Metric');
  await enterSketchOnTop(page, frame);
  // A line's boxes while drawing: the length with its unit, the angle with °.
  await page.keyboard.press('l');
  await clickAt(page, [-40, -30]);
  const [lx, ly] = await at(page, [-10, -20, 0]);
  await page.mouse.move(lx, ly);
  await expect(frame.locator('[data-sketch-box="length"]')).toHaveValue(/^\d+(\.\d+)? mm$/);
  await expect(frame.locator('[data-sketch-box="angle"]')).toHaveValue(/^-?\d+(\.\d+)?°$/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A circle on the origin, its diameter typed: the box shows mm until typed in; the label reads ⌀125 mm.
  await page.keyboard.press('c');
  await clickAt(page, [0, 0]);
  const [cx, cy] = await at(page, [30, 0, 0]);
  await page.mouse.move(cx, cy);
  const box = frame.locator('[data-sketch-box="diameter"]');
  await expect(box).toHaveValue(/^\d+(\.\d+)? mm$/);
  await page.keyboard.type('125');
  await expect(box).toHaveValue('125');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  const label = frame.locator('[data-sketch-dim]');
  await expect(label).toHaveText(['⌀125 mm']);
  await expect(chip(frame)).toHaveText('Fully defined');
  // The edit box shows the value with its unit; "5 in" typed there reads 127 mm.
  await label.dblclick();
  const edit = frame.locator('[data-sketch-dim-edit]');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveValue('125 mm');
  await edit.fill('5 in');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(label).toHaveText(['⌀127 mm']);
  // A bare number is in the document's unit, as before; Enter on the unchanged "80 mm" keeps it.
  await label.dblclick();
  await expect(edit).toHaveValue('127 mm');
  await edit.fill('80');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(label).toHaveText(['⌀80 mm']);
  await label.dblclick();
  await expect(edit).toHaveValue('80 mm');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(label).toHaveText(['⌀80 mm']);
  await finish(frame);
  await extrudeAll(frame, 'Sketch 1', 1, 10);
  expect(await singleVolume(frame)).toBeCloseTo(Math.PI * 40 * 40 * 10, 3);
  expect(seen.errors).toEqual([]);

  // An inch document: the label and the boxes read in.
  const inch = await freshPartIn(page, request, 'Imperial');
  await enterSketchOnTop(page, inch.frame);
  await page.keyboard.press('c');
  await clickAt(page, [0, 0]);
  const [ix, iy] = await at(page, [25.4, 0, 0]);
  await page.mouse.move(ix, iy);
  await expect(inch.frame.locator('[data-sketch-box="diameter"]')).toHaveValue(/^\d+(\.\d+)? in$/);
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(inch.frame.locator('[data-sketch-dim]')).toHaveText(['⌀2 in']);
  await inch.frame.locator('[data-sketch-dim]').dblclick();
  await expect(inch.frame.locator('[data-sketch-dim-edit]')).toHaveValue('2 in');
  await page.keyboard.press('Escape');
  expect(inch.seen.errors).toEqual([]);
});

test('cad:p4b-fu-no-not-allowed a fully defined line and the origin keep the normal arrow on hover (no not-allowed cursor); a drag of them moves nothing and the panel says why; a free circle still shows the move cursor', async ({ page, request }) => {
  const { seen, frame } = await freshPartIn(page, request, 'Metric');
  await enterSketchOnTop(page, frame);
  const canvas = frame.locator('[data-cad-canvas]');
  const cursor = () => canvas.evaluate((el) => ({ style: (el as HTMLElement).style.cursor, computed: getComputedStyle(el as HTMLElement).cursor }));
  const reason = panel(frame).locator('[data-run-reason]');
  // The origin (before anything is drawn on it): the arrow; a drag says it cannot move.
  const [ox, oy] = await at(page, [0, 0, 0]);
  await page.mouse.move(ox - 40, oy + 40);
  await page.mouse.move(ox, oy, { steps: 4 });
  await expect.poll(() => hovered(page)).not.toBeNull();
  let c = await cursor();
  expect(c.style).toMatch(/^(default|auto|)$/);
  expect(c.computed).not.toBe('not-allowed');
  await page.mouse.down();
  await page.mouse.move(ox - 50, oy + 50, { steps: 8 });
  expect((await cursor()).computed).not.toBe('not-allowed');
  await page.mouse.up();
  await sketchIdle(page);
  await expect(reason.first()).toContainText("The origin can't be moved");
  await typedRectangle(page, frame, 40, 30);
  // Hover the bottom line: its halo shows, the arrow stays.
  const [bx, by] = await at(page, [20, 0, 0]);
  await page.mouse.move(bx, by - 30);
  await page.mouse.move(bx, by, { steps: 4 });
  await expect.poll(() => hovered(page)).not.toBeNull();
  c = await cursor();
  expect(c.style).toMatch(/^(default|auto|)$/);
  expect(c.computed).not.toBe('not-allowed');
  // A drag of it: nothing moves; the words say why.
  const before = (await drawn(page)).points;
  await page.mouse.down();
  await page.mouse.move(bx, by + 60, { steps: 8 });
  c = await cursor();
  expect(c.computed).not.toBe('not-allowed');
  await page.mouse.up();
  await sketchIdle(page);
  expect((await drawn(page)).points).toEqual(before);
  await expect(reason.first()).toContainText('This line is fully defined: change a dimension to move it');
  // Something that can move still says so: a free circle shows the move cursor.
  await page.keyboard.press('c');
  await clickAt(page, [70, 15]);
  await clickAt(page, [76, 15]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  const [fx, fy] = await at(page, [76, 15, 0]);
  await page.mouse.move(fx + 30, fy);
  await page.mouse.move(fx, fy, { steps: 4 });
  await expect.poll(async () => (await cursor()).style).toBe('move');
  expect(seen.errors).toEqual([]);
});
