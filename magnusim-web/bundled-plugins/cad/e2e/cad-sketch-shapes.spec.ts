// The shape tools and the toolbar flyouts (v0.5.0, Daniel: parity both ways, and the sketch
// toolbar laid out as SolidWorks does it), in the real host frame, as the person does it: each
// variant picked from its flyout's list (the arrow beside the button), then drawn by clicking in
// the view with typed values where the tool takes them. What the person sees is checked: the
// list's contents, the button showing the last-used variant, the shapes drawn (the Assistant's
// own macro records: "slot1__side1"...), the profile count Extrude offers and the volume chip
// against the areas of what was drawn.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { chipVolumes, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];

test.beforeAll(async ({ request }) => {
  await ensureCadOn(request);
});

async function freshPart(page: Page, request: Parameters<typeof newProject>[0]) {
  // Daniel's wide screen: every DRAW flyout on the bar (at 1600 px Slot and Polygon fold into More).
  await page.setViewportSize({ width: 1920, height: 1080 });
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

async function at(page: Page, p: V2): Promise<[number, number]> {
  const xy = await workspaceFrame(page).evaluate((pt) => {
    const h = (window as unknown as { __CAD__: { services: { viewport: { get(): { handle: { project(p: number[]): [number, number] | null } | null } } } } }).__CAD__.services.viewport.get().handle;
    return h ? h.project([pt[0], pt[1], 0]) : null;
  }, p);
  expect(xy, `sketch point ${p} is not on screen`).not.toBeNull();
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

interface Draft {
  points: Record<string, V2>;
  entities: { id: string; kind: string; r?: number; construction?: boolean }[];
}

async function drawn(page: Page): Promise<Draft> {
  return workspaceFrame(page).evaluate(() => {
    const api = (window as unknown as { __CAD__: { services: { apis: { get(): { sketch: { draft(): Draft | null } } } } } }).__CAD__.services.apis.get().sketch;
    const d = api.draft();
    return { points: d?.points ?? {}, entities: (d?.entities ?? []).map((e) => ({ id: e.id, kind: e.kind, ...(e.r !== undefined ? { r: e.r } : {}), ...(e.construction ? { construction: true } : {}) })) };
  });
}

/** Clicks in the view at sketch points (a move first, as a hand does). */
async function clicks(page: Page, pts: V2[]) {
  for (const p of pts) {
    const [x, y] = await at(page, p);
    await page.mouse.move(x - 3, y + 2);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  }
}

/** Moves to a sketch point and types into the value box shown, then Enter. */
async function typed(page: Page, frame: FrameLocator, p: V2, box: string, value: string) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x, y);
  await expect(frame.locator(`[data-sketch-box="${box}"]`)).toBeVisible();
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

/** Picks a variant from its flyout's list (the arrow), and the flyout's button shows it after. */
async function pick(frame: FrameLocator, id: string) {
  await runCommand(frame, id);
  await expect(frame.locator(`[data-cad-toolbar] .tb-btn[data-variant="${id}"]`)).toHaveCount(1);
  await expect(frame.locator(`[data-cad-toolbar] .tb-btn[data-variant="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
}

const D = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const ang = (c: V2, p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const ccw = (a: number, b: number) => (((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The area of each shape drawn, from its stored points (the macros' parts). */
function areaOf(d: Draft, id: string): number {
  const P = (part: string) => d.points[`${id}__${part}`];
  if (id.startsWith('arcslot')) {
    const c = P('center');
    const R = D(c, P('a'));
    const r = D(P('a'), P('outer_start'));
    return ccw(ang(c, P('a')), ang(c, P('b'))) * R * 2 * r + Math.PI * r * r;
  }
  if (id.startsWith('slot')) {
    const r = D(P('a'), P('p1'));
    return D(P('a'), P('b')) * 2 * r + Math.PI * r * r;
  }
  if (id.startsWith('polygon')) {
    const n = d.entities.filter((e) => new RegExp(`^${id}__s\\d+$`).test(e.id)).length;
    const R = D(P('center'), P('p1'));
    return (n / 2) * R * R * Math.sin((2 * Math.PI) / n);
  }
  if (id.startsWith('sector')) {
    const c = P('center');
    const r = D(c, P('outer_start'));
    return (ccw(ang(c, P('outer_start')), ang(c, P('outer_end'))) * r * r) / 2;
  }
  if (id.startsWith('rect') || id.startsWith('crect') || id.startsWith('pgram')) return Math.abs(cross(P('p1'), P('p2'), P('p4')));
  if (id.startsWith('circle')) return Math.PI * d.entities.find((e) => e.id === id)!.r! ** 2;
  throw new Error(`no area for ${id}`);
}

/** Extrude every profile of Sketch 1: the profiles it offers, then H typed and Done. */
async function extrudeAll(frame: FrameLocator, profiles: number, h: number) {
  const row = frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: /^(?:[(]-[)] )?Sketch 1$/ }) });
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

async function enterSketchOnTop(page: Page, frame: FrameLocator) {
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
}

test('cad:sketch-shapes-flyouts the DRAW flyouts: each list with its variants, the button showing the last-used one; the five slots, a polygon and a sector drawn by clicking extrude to the areas drawn', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  const tb = frame.locator('[data-cad-toolbar="sketch"]');
  // The flyouts and what each one lists (icon, name), as the person opens them.
  const lists: Record<string, string[]> = {
    'sketch.line': ['Line', 'Centerline', 'Midpoint line'],
    'sketch.rectangle': ['Rectangle', 'Center rectangle', '3-point corner rectangle', '3-point center rectangle', 'Parallelogram'],
    'sketch.circle': ['Circle', 'Perimeter circle'],
    'sketch.arc': ['Centerpoint arc', 'Tangent arc', '3-point arc', 'Sector'],
    'sketch.slot': ['Center-to-center slot', 'Overall slot', 'Center-point slot', '3-point arc slot', 'Center-point arc slot'],
    'sketch.spline': ['Spline', 'Control-point spline'],
  };
  for (const [bar, names] of Object.entries(lists)) {
    const arrow = tb.locator(`[data-tb-flyout="${bar}"]`);
    await arrow.click();
    const menu = frame.locator('[data-cad-menu]');
    await expect(menu.locator('[role="menuitem"] .cad-menu-label')).toHaveText(names);
    await expect(menu.locator('[role="menuitem"] svg')).toHaveCount(names.length);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
  // Polygon is one button (no list); no Ellipse flyout until its tools are registered.
  await expect(tb.locator('.tb-btn[data-command="sketch.polygon"]')).toBeVisible();
  await expect(tb.locator('[data-tb-flyout="sketch.polygon"]')).toHaveCount(0);

  // Center-to-center slot: both centres (the length typed), then the width typed.
  await pick(frame, 'sketch.slot');
  await clicks(page, [[-40, 25]]);
  await typed(page, frame, [-20, 25.3], 'length', '20');
  await typed(page, frame, [-30, 28], 'width', '6');
  await sketchIdle(page);
  // Overall slot: both ends clicked, the width typed.
  await pick(frame, 'sketch.slot-overall');
  await clicks(page, [[-5, 25], [20, 25]]);
  await typed(page, frame, [8, 28], 'width', '6');
  await sketchIdle(page);
  // The slot button now runs Overall slot (last used).
  await expect(tb.locator('.tb-btn[data-command="sketch.slot"]')).toHaveAttribute('data-variant', 'sketch.slot-overall');
  // Center-point slot: the middle, an arc centre, the width clicked.
  await pick(frame, 'sketch.slot-center-point');
  await clicks(page, [[38, 25], [46, 25], [42, 28]]);
  await sketchIdle(page);
  // 3-point arc slot: start, end, a point on the arc, then the width.
  await pick(frame, 'sketch.slot-arc-3pt');
  await clicks(page, [[-30, -5], [-45, 10], [-41, -1], [-28, -5]]);
  await sketchIdle(page);
  // Center-point arc slot: the arc's centre, start, end, then the width typed.
  await pick(frame, 'sketch.slot-arc-center');
  await clicks(page, [[0, -10], [12, -10], [0, 2]]);
  await typed(page, frame, [13, -9], 'width', '4');
  await sketchIdle(page);
  // Polygon: 5 sides typed in its box, the centre, then a corner.
  await runCommand(frame, 'sketch.polygon');
  await typed(page, frame, [35, -5], 'sides', '5');
  await clicks(page, [[35, -5], [43, -5]]);
  await sketchIdle(page);
  // Sector: the centre, the start, the end (a pie slice).
  await pick(frame, 'sketch.sector');
  await clicks(page, [[-10, -40], [10, -40], [-10, -20]]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');

  const d = await drawn(page);
  const groups = [...new Set(d.entities.map((e) => e.id.split('__')[0]))].sort();
  expect(groups).toEqual(['arcslot1', 'arcslot2', 'polygon1', 'sector1', 'slot1', 'slot2', 'slot3']);
  // The Assistant's records: a straight slot's two arcs and two sides, an arc slot's four arcs, the polygon's 5 sides.
  expect(d.entities.filter((e) => e.id.startsWith('slot1__')).map((e) => `${e.id.slice(7)}:${e.kind}`).sort()).toEqual(['arc_a:arc', 'arc_b:arc', 'axis:line', 'side1:line', 'side2:line']);
  expect(d.entities.filter((e) => e.id.startsWith('arcslot1__')).map((e) => `${e.id.slice(10)}:${e.kind}`).sort()).toEqual(['cap_a:arc', 'cap_b:arc', 'inner:arc', 'outer:arc']);
  expect(d.entities.filter((e) => /^polygon1__s\d$/.test(e.id))).toHaveLength(5);
  // The typed values hold: slot 1 is 20 long and 6 wide.
  expect(D(d.points.slot1__a, d.points.slot1__b)).toBeCloseTo(20, 6);
  expect(D(d.points.slot1__a, d.points.slot1__p1)).toBeCloseTo(3, 6);
  expect(D(d.points.arcslot2__a, d.points.arcslot2__outer_start)).toBeCloseTo(2, 6);
  const area = groups.reduce((s, g) => s + areaOf(d, g), 0);

  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await extrudeAll(frame, 7, 10);
  await expect.poll(async () => (await chipVolumes(frame)).reduce((a, b) => a + b, 0) / (area * 10)).toBeCloseTo(1, 3);
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-shapes-variants a midpoint line, an angled and a centre-angled rectangle, a parallelogram, a perimeter circle and a centrepoint arc, each picked from its flyout and clicked', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { seen, frame } = await freshPart(page, request);
  await enterSketchOnTop(page, frame);
  await pick(frame, 'sketch.line-midpoint');
  await clicks(page, [[-40, 35], [-30, 40]]);
  await pick(frame, 'sketch.rectangle-3pt');
  await clicks(page, [[-40, 0], [-25, 8], [-29, 16]]);
  await pick(frame, 'sketch.rectangle-center-3pt');
  await clicks(page, [[5, 10], [15, 10], [12, 16]]);
  await pick(frame, 'sketch.parallelogram');
  await clicks(page, [[25, -5], [40, -5], [44, 8]]);
  await pick(frame, 'sketch.circle-3pt');
  await clicks(page, [[-30, -20], [-20, -30], [-40, -30]]);
  await pick(frame, 'sketch.arc-center');
  await clicks(page, [[15, -30], [25, -30], [15, -20]]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  // The flyouts' buttons keep their last-used variants.
  const tb = frame.locator('[data-cad-toolbar="sketch"]');
  await expect(tb.locator('.tb-btn[data-command="sketch.line"]')).toHaveAttribute('data-variant', 'sketch.line-midpoint');
  await expect(tb.locator('.tb-btn[data-command="sketch.rectangle"]')).toHaveAttribute('data-variant', 'sketch.parallelogram');
  await expect(tb.locator('.tb-btn[data-command="sketch.arc"]')).toHaveAttribute('data-variant', 'sketch.arc-center');
  const d = await drawn(page);
  const groups = [...new Set(d.entities.map((e) => e.id.split('__')[0]))].sort();
  expect(groups).toEqual(['arc1', 'circle1', 'crect1', 'midline1', 'pgram1', 'rect1']);
  // The midpoint line's middle is where it was clicked first.
  const mid: V2 = [(d.points.midline1__start[0] + d.points.midline1__end[0]) / 2, (d.points.midline1__start[1] + d.points.midline1__end[1]) / 2];
  expect(D(mid, d.points.midline1__center__p)).toBeLessThan(1e-6);
  // A rectangle's corners are square; a parallelogram's opposite sides parallel.
  const P = (k: string) => d.points[k];
  const dot = (a: V2, b: V2, c: V2) => (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
  expect(Math.abs(dot(P('rect1__p1'), P('rect1__p2'), P('rect1__p3')))).toBeLessThan(1e-6);
  expect(Math.abs(dot(P('crect1__p1'), P('crect1__p2'), P('crect1__p3')))).toBeLessThan(1e-6);
  const area = ['circle1', 'crect1', 'pgram1', 'rect1'].reduce((s, g) => s + areaOf(d, g), 0);
  await runCommand(frame, 'sketch.finish');
  await expect(frame.locator('[data-cad-toolbar="model"]')).toBeVisible();
  await extrudeAll(frame, 4, 5);
  await expect.poll(async () => (await chipVolumes(frame)).reduce((a, b) => a + b, 0) / (area * 5)).toBeCloseTo(1, 3);
  expect(seen.errors).toEqual([]);
});
