// Daniel's first test of the CAD desktop app, in the real host frame, asserting what he sees:
//  - SolidWorks-style relations: he selects sketch lines with the Select tool and a palette of the
//    relations that apply shows beside them (one line: Horizontal, Vertical, Fix; two lines:
//    Parallel, Perpendicular, Equal, Collinear...); a click adds the relation (the sketch's
//    relations and its DOF change), the button then shows pressed and the contradicting one goes;
//    the palette never covers his sketch and goes when nothing is selected;
//  - the construction badge: "Construction · X" with a real × ("Turn off construction") that turns
//    construction drawing off (what he draws next is normal geometry).
//  Review round (relations lane): what the sketch implies shows pressed (a rectangle's sides), what
//  would contradict it is left out (Tangent on concentric circles, Parallel on adjacent sides), a V
//  drawn from the origin takes Symmetric, the keyboard keeps its place in the palette, a pressed
//  button says what the toolbar says, and the palette never covers the origin, the badge or a long
//  line when zoomed in.
//  Integration review: Parallel, Perpendicular and Collinear never move a Fixed or a projected line
//  (the drawn line turns about their shared end), Equal of an arc and a circle with one centre
//  applies, and the palette moves clear of the badge when Construction's key makes it wider.
//  Verify round: Tangent of an arc and a circle with one centre is never offered and refused.
// With RELATIONS_SHOTS=<folder>: screenshots of the palette and the badge for a person to look at.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { addSolid, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

type V2 = [number, number];
type V3 = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function cad<T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T> {
  return workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
}

async function at(page: Page, p: V3): Promise<[number, number]> {
  const xy = await cad<[number, number] | null>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle?.project(pt) ?? null) as never, p);
  expect(xy, `model point ${p} is not on screen`).not.toBeNull();
  const box = await page.locator('#workspace-frame').boundingBox();
  return [box!.x + xy![0], box!.y + xy![1]];
}

const clickAt = async (page: Page, p: V2, ctrl = false) => {
  const [x, y] = await at(page, [p[0], p[1], 0]);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.click(x, y);
  if (ctrl) await page.keyboard.up('Control');
};

async function settled(page: Page) {
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

async function sketchIdle(page: Page) {
  await cad(page, (async () => {
    await (window as unknown as W).__CAD__.services.apis.get().sketch?.idle?.();
  }) as never);
}

type Drawn = { points: Record<string, V2>; entities: { id: string; kind: string; p?: [string, string]; construction?: boolean }[]; constraints: { id: string; kind: string; refs: string[] }[] };
async function drawn(page: Page): Promise<Drawn> {
  return cad(page, (() => {
    const d = (window as unknown as W).__CAD__.services.apis.get().sketch.draft();
    return { points: d.points, entities: d.entities, constraints: d.constraints };
  }) as never);
}

const palette = (frame: FrameLocator) => frame.locator('[data-sketch-relations-palette]');
const relation = (frame: FrameLocator, kind: string) => palette(frame).locator(`[data-relation="${kind}"]`);
const badge = (frame: FrameLocator) => frame.locator('[data-sketch-construction-badge]');
const dofChip = (frame: FrameLocator) => frame.locator('[data-sketch-dof]');
const dof = async (frame: FrameLocator) => Number(await dofChip(frame).getAttribute('data-sketch-dof'));

async function shot(page: Page, name: string) {
  if (!process.env.RELATIONS_SHOTS) return;
  await page.screenshot({ path: join(process.env.RELATIONS_SHOTS, `${name}.png`) });
}

/** The line whose ends are these two points (as drawn: the clicks land within a pixel). */
function lineAt(d: Drawn, a: V2, b: V2): string {
  const near = (id: string, p: V2) => Math.hypot(d.points[id][0] - p[0], d.points[id][1] - p[1]) < 1;
  const l = d.entities.find((e) => e.kind === 'line' && ((near(e.p![0], a) && near(e.p![1], b)) || (near(e.p![0], b) && near(e.p![1], a))));
  expect(l, `a line from ${a} to ${b}`).toBeTruthy();
  return l!.id;
}

const mid = (a: V2, b: V2): V2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

const kindsShown = (frame: FrameLocator) => palette(frame).locator('[data-relation]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-relation')}${e.getAttribute('data-implied') ? '~' : e.getAttribute('aria-pressed') === 'true' ? '*' : ''}`));
const note = (page: Page) => cad<string | null>(page, (() => (window as unknown as W).__CAD__.services.apis.get().sketch.view.get().note) as never);

/** The palette's rectangle and whether it comes near a page point (px). */
async function paletteCovers(frame: FrameLocator, page: Page, p: V2, gap = 4): Promise<boolean> {
  const box = (await palette(frame).boundingBox())!;
  const [x, y] = await at(page, [p[0], p[1], 0]);
  return x >= box.x - gap && x <= box.x + box.width + gap && y >= box.y - gap && y <= box.y + box.height + gap;
}

async function startSketch(page: Page, request: Parameters<typeof newProject>[0], opts: { solid?: [number, number, number] } = {}) {
  await ensureCadOn(request);
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  if (opts.solid) await addSolid(page, { size: opts.solid });
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await frame.locator('[data-cad-toolbar] [data-command="sketch.new"]').click();
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await settled(page);
  return { seen, frame };
}

/** Lines drawn with the Line tool, each its own (Escape after each), then back to Select. */
async function drawLines(page: Page, lines: [V2, V2][]) {
  await page.keyboard.press('l');
  for (const [p, q] of lines) {
    await clickAt(page, p);
    await clickAt(page, q);
    await page.keyboard.press('Escape');
    await sketchIdle(page);
  }
  await page.keyboard.press('Escape');
  await sketchIdle(page);
}

test('cad:sketch-relations-palette selecting lines shows the relations that apply beside them; a click adds one (relations and DOF change), it then shows pressed; the keyboard keeps its place; a pressed one says what the toolbar says; the construction badge\'s × turns construction drawing off', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  // Two slanted lines, apart (nothing inferred between them).
  const A: [V2, V2] = [
    [-30, -12],
    [10, -22],
  ];
  const B: [V2, V2] = [
    [-26, 14],
    [16, 31],
  ];
  await drawLines(page, [A, B]);
  let d = await drawn(page);
  const l1 = lineAt(d, ...A);
  const l2 = lineAt(d, ...B);
  const before = d.constraints.length;
  await expect(palette(frame)).toBeHidden();
  const dof0 = await dof(frame);
  expect(dof0).toBe(8);

  // One line selected: Horizontal, Vertical, Fix beside it.
  await clickAt(page, mid(...A));
  await expect(palette(frame)).toBeVisible();
  await expect.poll(() => kindsShown(frame)).toEqual(['horizontal', 'vertical', 'fix']);
  await expect(relation(frame, 'horizontal')).toHaveAttribute('aria-label', 'Horizontal');
  await shot(page, 'palette-one-line');
  // Beside the selection, never over the line itself (its middle stays clickable).
  expect(await paletteCovers(frame, page, mid(...A))).toBe(false);
  const box = (await palette(frame).boundingBox())!;
  const [mx, my] = await at(page, [...mid(...A), 0]);
  expect(Math.hypot(box.x + box.width / 2 - mx, box.y + box.height / 2 - my)).toBeLessThan(260);

  // Horizontal from the keyboard (review: the focus fell to the page and the next Enter finished
  // the sketch): the relation is in the sketch, one DOF less, the button pressed and still focused,
  // Vertical gone; Fix gone too (a horizontal line's two ends held over-define it: the toolbar's
  // Fix refuses it as well).
  // Tab to it, as a person does (the keyboard lets Enter through to a button the keyboard focused).
  const focusedRelation = () => cad<string | null>(page, (() => document.activeElement?.getAttribute('data-relation') ?? null) as never);
  for (let i = 0; i < 200 && (await focusedRelation()) !== 'horizontal'; i++) await page.keyboard.press('Tab');
  expect(await focusedRelation()).toBe('horizontal');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.constraints.slice(before).map((c) => [c.kind, c.refs])).toEqual([['horizontal', [l1]]]);
  await expect.poll(() => dof(frame)).toBe(dof0 - 1);
  await expect(relation(frame, 'horizontal')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => kindsShown(frame)).toEqual(['horizontal*']);
  await expect(relation(frame, 'horizontal')).toBeFocused();
  // Enter again: the pressed button refuses with the toolbar's words; the sketch stays open.
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await expect.poll(() => note(page)).toBe('Not applied: Horizontal is already in the sketch');
  await runCommand(frame, 'sketch.horizontal');
  await sketchIdle(page);
  expect(await note(page)).toBe('Not applied: Horizontal is already in the sketch');

  // Ctrl+click the second line: the two-line relations (Vertical left out: the first is horizontal).
  await clickAt(page, mid(...B), true);
  await expect.poll(() => kindsShown(frame)).toEqual(['horizontal', 'parallel', 'perpendicular', 'equal', 'collinear']);
  await shot(page, 'palette-two-lines');
  await relation(frame, 'parallel').click();
  await sketchIdle(page);
  d = await drawn(page);
  expect(d.constraints.slice(before).map((c) => c.kind)).toEqual(['horizontal', 'parallel']);
  expect(d.constraints.slice(before)[1].refs.sort()).toEqual([l1, l2].sort());
  await expect.poll(() => dof(frame)).toBe(dof0 - 2);
  // The second line followed (parallel to the horizontal one).
  const e2 = d.entities.find((e) => e.id === l2)!;
  expect(Math.abs(d.points[e2.p![0]][1] - d.points[e2.p![1]][1])).toBeLessThan(1e-6);
  // Parallel pressed; Horizontal for both now holds already (implied, pressed); Perpendicular gone.
  await expect.poll(() => kindsShown(frame)).toEqual(['horizontal~', 'parallel*', 'equal', 'collinear']);
  await expect(relation(frame, 'horizontal')).toHaveAttribute('aria-pressed', 'true');
  // Equal too, from the same selection.
  await relation(frame, 'equal').click();
  await sketchIdle(page);
  await expect.poll(() => dof(frame)).toBe(dof0 - 3);
  await shot(page, 'palette-two-lines-added');

  // Nothing selected: no palette.
  await page.keyboard.press('Escape');
  await expect(palette(frame)).toBeHidden();

  // Construction drawing on (X): the badge says so with the shortcut, and its × turns it off.
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeVisible();
  await expect(badge(frame).locator('[data-sketch-construction-text]')).toHaveText('Construction · X');
  const off = badge(frame).getByRole('button', { name: 'Turn off construction' });
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute('title', /\(X\)/);
  await shot(page, 'construction-badge');
  await off.click();
  await expect(badge(frame)).toBeHidden();
  expect(await cad<boolean>(page, (() => !!(window as unknown as W).__CAD__.services.apis.get().sketch.drawConstruction) as never)).toBe(false);
  // What is drawn next is normal geometry.
  const C: [V2, V2] = [
    [-30, 45],
    [20, 50],
  ];
  await drawLines(page, [C]);
  d = await drawn(page);
  // The newest line (its ends may snap to the others' ends' alignment).
  const newest = d.entities.filter((e) => e.kind === 'line').pop()!;
  expect(newest.id).not.toBe(l1);
  expect(newest.id).not.toBe(l2);
  expect(newest.construction).toBeFalsy();
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-relations-palette-implied a rectangle: adjacent sides show Perpendicular pressed (it holds) and no Parallel; opposite sides Parallel and Equal pressed and no Perpendicular; concentric circles offer no Tangent', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  await page.keyboard.press('r');
  await clickAt(page, [-30, -15]);
  await clickAt(page, [25, 20]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  const d = await drawn(page);
  const bottom = lineAt(d, [-30, -15], [25, -15]);
  const top = lineAt(d, [-30, 20], [25, 20]);
  const right = lineAt(d, [25, -15], [25, 20]);
  expect(new Set([bottom, top, right]).size).toBe(3);
  // Adjacent sides.
  await clickAt(page, [0, -15]);
  await clickAt(page, [25, 0], true);
  await expect(palette(frame)).toBeVisible();
  await expect.poll(() => kindsShown(frame)).toEqual(['perpendicular~', 'equal']);
  await expect(relation(frame, 'perpendicular')).toHaveAttribute('aria-pressed', 'true');
  await expect(relation(frame, 'perpendicular')).toHaveAttribute('title', /already holds/);
  await shot(page, 'palette-implied-adjacent');
  // A click on it changes nothing and says why, as the toolbar does.
  const n0 = (await drawn(page)).constraints.length;
  // (Pressed, it is aria-disabled, which Playwright will not click; a person's click still lands.)
  await relation(frame, 'perpendicular').click({ force: true });
  await sketchIdle(page);
  expect((await drawn(page)).constraints.length).toBe(n0);
  await expect.poll(() => note(page)).toBe('Not applied: Perpendicular already holds (the other relations imply it)');
  await runCommand(frame, 'sketch.perpendicular');
  await sketchIdle(page);
  expect(await note(page)).toBe('Not applied: Perpendicular already holds (the other relations imply it)');
  // Opposite sides.
  await page.keyboard.press('Escape');
  await clickAt(page, [0, -15]);
  await clickAt(page, [0, 20], true);
  await expect.poll(() => kindsShown(frame)).toEqual(['horizontal*', 'parallel~', 'equal~']);
  await shot(page, 'palette-implied-opposite');
  // Two circles, one centre (Concentric): no Tangent (it made one circle of the two).
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await clickAt(page, [60, 0]);
  await clickAt(page, [66, 0]);
  await clickAt(page, [60, 0]);
  await clickAt(page, [70, 0]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  await clickAt(page, [66, 0]);
  await clickAt(page, [70, 0], true);
  await expect(palette(frame)).toBeVisible();
  const shown = await kindsShown(frame);
  expect(shown).not.toContain('tangent');
  expect(shown).not.toContain('equal');
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-relations-palette-symmetric a V drawn from the origin about a centerline from the origin: Symmetric is offered and applies', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  await runCommand(frame, 'sketch.centerline');
  await clickAt(page, [0, 0]);
  await clickAt(page, [0, 40]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await drawLines(page, [
    [
      [0, 0],
      [-18, 30],
    ],
    [
      [0, 0],
      [21, 27],
    ],
  ]);
  const d = await drawn(page);
  const left = lineAt(d, [0, 0], [-18, 30]);
  const right = lineAt(d, [0, 0], [21, 27]);
  const axis = lineAt(d, [0, 0], [0, 40]);
  await clickAt(page, mid([0, 0], [-18, 30]));
  await clickAt(page, mid([0, 0], [21, 27]), true);
  await clickAt(page, [0, 33], true);
  await expect(palette(frame)).toBeVisible();
  await expect.poll(() => kindsShown(frame)).toContain('symmetric');
  await shot(page, 'palette-symmetric-v');
  const n0 = (await drawn(page)).constraints.length;
  await relation(frame, 'symmetric').click();
  await sketchIdle(page);
  expect(await note(page)).toBeNull();
  const after = await drawn(page);
  const added = after.constraints.slice(n0);
  expect(added.map((c) => c.kind)).toEqual(['symmetric']);
  // The far ends mirrored about the axis.
  const far = (id: string) => after.entities.find((e) => e.id === id)!.p!.map((p) => after.points[p]).find((q) => Math.hypot(q[0], q[1]) > 1)!;
  const [a0, a1] = after.entities.find((e) => e.id === axis)!.p!.map((p) => after.points[p]);
  const [p, q] = [far(left), far(right)];
  const dir = [a1[0] - a0[0], a1[1] - a0[1]];
  const t = ((q[0] - a0[0]) * dir[0] + (q[1] - a0[1]) * dir[1]) / (dir[0] ** 2 + dir[1] ** 2);
  const foot = [a0[0] + dir[0] * t, a0[1] + dir[1] * t];
  expect(Math.hypot(p[0] - (2 * foot[0] - q[0]), p[1] - (2 * foot[1] - q[1]))).toBeLessThan(1e-6);
  await expect(relation(frame, 'symmetric')).toHaveAttribute('aria-pressed', 'true');
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-relations-palette-place the palette never covers the origin, a long line when zoomed in, or the construction badge', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  // A short line just left of the origin (the palette was placed on the origin there).
  const S: [V2, V2] = [
    [-40, -10],
    [-15, -10],
  ];
  // A long line under the construction badge's place.
  const T: [V2, V2] = [
    [-90, 92],
    [-4, 92],
  ];
  await drawLines(page, [S, T]);
  await clickAt(page, mid(...S));
  await expect(palette(frame)).toBeVisible();
  expect(await paletteCovers(frame, page, [0, 0], 8)).toBe(false);
  for (let x = -40; x <= -15; x += 1) expect(await paletteCovers(frame, page, [x, -10], 2)).toBe(false);
  // Construction drawing on (nothing selected, then X), then the long line selected: clear of the badge.
  await page.keyboard.press('Escape');
  await page.keyboard.press('x');
  await expect(badge(frame)).toBeVisible();
  await clickAt(page, mid(...T));
  await expect(palette(frame)).toBeVisible();
  const pb = (await palette(frame).boundingBox())!;
  const bb = (await badge(frame).boundingBox())!;
  expect(pb.x < bb.x + bb.width && bb.x < pb.x + pb.width && pb.y < bb.y + bb.height && bb.y < pb.y + pb.height).toBe(false);
  for (let x = -90; x <= -4; x += 2) expect(await paletteCovers(frame, page, [x, 92], 2)).toBe(false);
  await shot(page, 'palette-clear-of-badge');
  // Integration review: Construction's key changed to a long one (as Set keybind's Done does): the
  // badge widens on both sides and the palette moves clear of it again, with nothing else changing.
  const setKey = (combo: string | null) =>
    cad<boolean>(page, ((c: string | null) => {
      const k = (window as unknown as { __CAD__: { keybinds: { model: { setKeybind(id: string, c: string): { ok: boolean }; resetToDefault(id: string): { ok: boolean } } } } }).__CAD__.keybinds.model;
      return (c ? k.setKeybind('sketch.construction', c) : k.resetToDefault('sketch.construction')).ok;
    }) as never, combo);
  const narrow = bb.width;
  try {
    expect(await setKey('Ctrl+Shift+Alt+X')).toBe(true);
    await expect.poll(async () => (await badge(frame).boundingBox())!.width).toBeGreaterThan(narrow + 30);
    await expect
      .poll(async () => {
        const p2 = (await palette(frame).boundingBox())!;
        const b2 = (await badge(frame).boundingBox())!;
        return p2.x < b2.x + b2.width + 4 && b2.x < p2.x + p2.width + 4 && p2.y < b2.y + b2.height + 4 && b2.y < p2.y + p2.height + 4;
      })
      .toBe(false);
    await shot(page, 'palette-clear-of-wide-badge');
  } finally {
    await setKey(null);
  }
  // Zoomed in on the long line until it runs past both sides of the view: still clear of it.
  await badge(frame).getByRole('button', { name: 'Turn off construction' }).click();
  const view = (await page.locator('#workspace-frame').boundingBox())!;
  for (let i = 0; i < 40; i++) {
    const [lx] = await cad<[number, number]>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(pt)) as never, [-90, 92, 0]);
    const [rx] = await cad<[number, number]>(page, ((pt: V3) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(pt)) as never, [-4, 92, 0]);
    if (lx < 0 && rx > view.width) break;
    const [zx, zy] = await at(page, [-47, 92, 0]);
    await page.mouse.move(zx, zy);
    await page.mouse.wheel(0, -300);
    await settled(page);
  }
  await expect(palette(frame)).toBeVisible();
  const [lx] = await at(page, [-90, 92, 0]);
  const [rx] = await at(page, [-4, 92, 0]);
  expect(lx).toBeLessThan(view.x);
  expect(rx).toBeGreaterThan(view.x + view.width);
  await expect
    .poll(async () => {
      for (let x = -90; x <= -4; x += 0.5) if (await paletteCovers(frame, page, [x, 92], 2)) return false;
      return true;
    })
    .toBe(true);
  await shot(page, 'palette-zoomed-long-line');
  expect(seen.errors).toEqual([]);
});

/** A point, as the sketch has it now. */
const pointNow = (page: Page, id: string) => cad<V2>(page, ((i: string) => (window as unknown as W).__CAD__.services.apis.get().sketch.draft().points[i]) as never, id);

test('cad:sketch-relations-palette-held Parallel, Perpendicular and Collinear next to a Fixed line leave it where it is (the drawn line turns about their shared end); a projected line stays on its edge; Equal of an arc and a circle with one centre applies', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  // A slanted base line, Fixed from the palette, and a line drawn on from its end.
  const A: [V2, V2] = [
    [-50, -34],
    [-20, -28],
  ];
  const B: [V2, V2] = [
    [-20, -28],
    [-14, -10],
  ];
  await drawLines(page, [A, B]);
  let d = await drawn(page);
  const l1 = lineAt(d, ...A);
  const l2 = lineAt(d, ...B);
  const [pa, pb] = d.entities.find((e) => e.id === l1)!.p!;
  expect(d.entities.find((e) => e.id === l2)!.p).toContain(pb);
  await clickAt(page, mid(...A));
  await expect.poll(() => kindsShown(frame)).toContain('fix');
  await relation(frame, 'fix').click();
  await sketchIdle(page);
  const held = [await pointNow(page, pa), await pointNow(page, pb)];
  for (const kind of ['parallel', 'perpendicular', 'collinear']) {
    await page.keyboard.press('Escape');
    await clickAt(page, mid(...A));
    await clickAt(page, mid(...B), true);
    await expect.poll(() => kindsShown(frame)).toContain(kind);
    if (kind === 'parallel') await shot(page, 'palette-fixed-neighbour');
    await relation(frame, kind).click();
    await sketchIdle(page);
    expect(await note(page), kind).toBeNull();
    d = await drawn(page);
    expect(d.constraints.some((c) => c.kind === kind)).toBe(true);
    // The fixed line has not moved.
    expect(Math.hypot(d.points[pa][0] - held[0][0], d.points[pa][1] - held[0][1]), `${kind}: its start`).toBeLessThan(1e-6);
    expect(Math.hypot(d.points[pb][0] - held[1][0], d.points[pb][1] - held[1][1]), `${kind}: its end`).toBeLessThan(1e-6);
    await page.keyboard.press('Control+z');
    await sketchIdle(page);
  }
  // An arc and a circle with one centre (Concentric), then Equal: the arc lies on the circle.
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await clickAt(page, [60, -40]);
  await clickAt(page, [68, -40]);
  await page.keyboard.press('Escape');
  // The arc well apart from the circle (its ends near the circle would snap onto it).
  await page.keyboard.press('a');
  await clickAt(page, [30, -60]);
  await clickAt(page, [46, -60]);
  await clickAt(page, [38, -54]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  d = await drawn(page);
  const circle = d.entities.find((e) => e.kind === 'circle')!;
  const arc = d.entities.find((e) => e.kind === 'arc')!;
  // Each on its curve where it is now (Concentric moves them): the circle, the arc.
  const select2 = async () => {
    const now = await drawn(page);
    const k = now.entities.find((e) => e.id === circle.id) as unknown as { c: string; r: number };
    const ar = now.entities.find((e) => e.id === arc.id) as unknown as { c: string; a: string; b: string; ccw?: boolean };
    const kc = now.points[k.c];
    const [c, pa, pb] = [now.points[ar.c], now.points[ar.a], now.points[ar.b]];
    const ang = (q: V2) => Math.atan2(q[1] - c[1], q[0] - c[0]);
    const [s0, s1] = ar.ccw === false ? [ang(pb), ang(pa)] : [ang(pa), ang(pb)];
    const sweep = (((s1 - s0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    const r = Math.hypot(pa[0] - c[0], pa[1] - c[1]);
    // A third of the way along (its relation glyphs sit at its middle).
    const m = s0 + sweep / 3;
    await page.keyboard.press('Escape');
    // The circle across from the arc's middle (its ends may lie on the circle's rim).
    await clickAt(page, [kc[0] - k.r * Math.cos(m), kc[1] - k.r * Math.sin(m)]);
    await clickAt(page, [c[0] + r * Math.cos(m), c[1] + r * Math.sin(m)], true);
    await expect(palette(frame)).toBeVisible();
  };
  await select2();
  await expect.poll(() => kindsShown(frame)).toContain('concentric');
  await relation(frame, 'concentric').click();
  await sketchIdle(page);
  expect(await note(page)).toBeNull();
  await select2();
  await expect.poll(() => kindsShown(frame)).toContain('equal');
  await shot(page, 'palette-arc-on-circle');
  await relation(frame, 'equal').click();
  await sketchIdle(page);
  expect(await note(page)).toBeNull();
  d = await drawn(page);
  expect(d.constraints.filter((c) => c.refs.includes(circle.id) && c.refs.includes(arc.id)).map((c) => c.kind).sort()).toEqual(['concentric', 'equal']);
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-relations-palette-projected Perpendicular with a line drawn from a projected edge\'s end: the projected line stays on its model edge', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request, { solid: [40, 20, 10] });
  // Project the top face's front edge (y = 0, z = 10): a linked line from (0, 0) to (40, 0).
  await page.keyboard.press('p');
  const [ex, ey] = await at(page, [20, 0, 10]);
  await page.mouse.click(ex, ey);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  let d = await drawn(page);
  const proj = d.entities.find((e) => e.kind === 'line' && (e as { link?: string }).link);
  expect(proj, 'a projected line').toBeTruthy();
  const ends = proj!.p!.map((q) => [...d.points[q]] as V2);
  // A line drawn on from the projected line's far end, and a horizontal line apart (over the face).
  const far = ends.find((q) => q[0] > 20)!;
  await drawLines(page, [
    [far, [far[0] + 6, far[1] + 18]],
    [
      [5, 12],
      [30, 12],
    ],
  ]);
  d = await drawn(page);
  const drawnFromEdge = d.entities.filter((e) => e.kind === 'line' && !(e as { link?: string }).link && e.p!.some((q) => proj!.p!.includes(q)));
  expect(drawnFromEdge, 'the line drawn from the projected end shares its point').toHaveLength(1);
  await clickAt(page, [17.5, 12]);
  await clickAt(page, [far[0] + 3, far[1] + 9], true);
  await expect.poll(() => kindsShown(frame)).toContain('perpendicular');
  await relation(frame, 'perpendicular').click();
  await sketchIdle(page);
  expect(await note(page)).toBeNull();
  d = await drawn(page);
  proj!.p!.forEach((q, i) => expect(Math.hypot(d.points[q][0] - ends[i][0], d.points[q][1] - ends[i][1]), 'the projected line\'s ends').toBeLessThan(1e-6));
  expect(seen.errors).toEqual([]);
});

test('cad:sketch-relations-palette-coradial an arc drawn from a circle\'s centre: Tangent is never offered and the toolbar refuses it (it would put the arc on the circle); Equal applies', async ({ page, request }) => {
  const { seen, frame } = await startSketch(page, request);
  await page.keyboard.press('c');
  await clickAt(page, [60, -40]);
  await clickAt(page, [72, -40]);
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  // A Centerpoint arc from the circle's centre (it snaps there: one centre point), radius 5, a quarter turn.
  await runCommand(frame, 'sketch.arc-center');
  await clickAt(page, [60, -40]);
  await clickAt(page, [65, -40]);
  for (let k = 1; k <= 8; k++) {
    const t = (k / 8) * (Math.PI / 2);
    const [x, y] = await at(page, [60 + 5 * Math.cos(t), -40 + 5 * Math.sin(t), 0]);
    await page.mouse.move(x, y);
  }
  await clickAt(page, [60, -35]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sketchIdle(page);
  let d = await drawn(page);
  const circle = d.entities.find((e) => e.kind === 'circle')!;
  const arc = d.entities.find((e) => e.kind === 'arc')!;
  const centreOf = (e: object) => (e as { c: string }).c;
  expect(centreOf(arc), 'the arc shares the circle\'s centre').toBe(centreOf(circle));
  expect(d.constraints.filter((c) => c.kind === 'concentric')).toEqual([]);
  await clickAt(page, [72, -40]);
  const q = Math.PI / 4;
  await clickAt(page, [60 + 5 * Math.cos(q * 0.6), -40 + 5 * Math.sin(q * 0.6)], true);
  await expect(palette(frame)).toBeVisible();
  await expect.poll(() => kindsShown(frame)).toContain('equal');
  expect(await kindsShown(frame)).not.toContain('tangent');
  await shot(page, 'palette-coradial-no-tangent');
  // The toolbar's Tangent: refused, nothing changed.
  await runCommand(frame, 'sketch.tangent');
  await sketchIdle(page);
  expect(await note(page)).toMatch(/^Not applied: Tangent would put (Circle 1 on Arc 1|Arc 1 on Circle 1)$/);
  d = await drawn(page);
  expect(d.constraints.filter((c) => c.kind === 'tangent')).toEqual([]);
  // Equal: the arc goes onto the circle's path (allowed).
  await relation(frame, 'equal').click();
  await sketchIdle(page);
  expect(await note(page)).toBeNull();
  d = await drawn(page);
  expect(d.constraints.filter((c) => c.kind === 'equal')).toHaveLength(1);
  expect(seen.errors).toEqual([]);
});
