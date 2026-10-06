// P2+P3 review round 1, the polish items and the fixes that had only unit tests,
// each asserting what the user sees and failing without its fix:
//  1. layout-1280     At 1280 x 800 a new sketch's plane is centred beside the tree and
//                     the Sketch panel, not under them (Look at put the origin at x = 640
//                     with the panels over x < 600); the value boxes stay inside the frame.
//  2. refit-grow      A block that reaches out of a view nobody has moved is framed (the
//                     Vortex fluid domain was cut off until F); after an orbit it is not.
//  3. planes-auto     Auto shows the origin planes on an empty Part only: not in sketch
//                     mode, not under a finished sketch (the Top plane's blue square sat
//                     under the sketch, in the same blue as its regions).
//  4. sketch-colours  In model mode a dimensioned rectangle is drawn in the fully defined
//                     colour beside a free circle in blue (the whole sketch was blue).
//  5. face-names      Press-pull and Measure name the same face the same way, "Face N of
//                     flange" (Press-pull said "Face 7 (Imported 1 (flange.step))"); the
//                     name holds while the panel is open, as the result renumbers faces.
//  6. dimension-place A rectangle's typed width and height label outside it (the 60 was
//                     drawn through the middle of the region).
//  7. symmetric-twin  Symmetric on two points in one place is refused in words (it was
//                     taken, and every later line was refused as over-defining).
//  8. trim-relation   After a trim splits a line, a point on the far piece is On line of
//                     that piece, and its glyph says so (it named the old piece).
//  9. delete-words    A Delete faces OCCT cannot heal says why in words, with no OCCT token.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSolid, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
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
  entities: { id: string; kind: string; p?: string[] }[];
  constraints: { id: string; kind: string; refs: string[] }[];
}
type Box = { x: number; y: number; width: number; height: number };

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

async function clickAt(page: Page, p: V3, ctrl = false) {
  const [x, y] = await at(page, p);
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y, { steps: 2 });
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.click(x, y);
  if (ctrl) await page.keyboard.up('Control');
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
 * view and clear of the tree and the panel, as a user does before drawing past what is framed
 * (since round 4 a stored sketch opens framed on what it holds).
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

const draft = (page: Page) => cad<Draft>(page, () => (window as unknown as W).__CAD__.services.apis.get().sketch.draft());
const camera = (page: Page) => cad<{ position: number[]; target: number[] }>(page, () => (window as unknown as W).__CAD__.services.viewport.get().handle.camera());

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

const featureRow = (frame: FrameLocator, name: string) =>
  frame.locator('[data-cad-tree] [data-feature-row]').filter({ has: frame.locator('> .tree-row .tl', { hasText: new RegExp(`^(\\(.\\) )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/**
 * A block (corner, size): a rectangle sketched on Top and extruded, set up through
 * the document (helpers.ts addSolid; there is no Box since decision 2026-10-01).
 */
const addBlock = (page: Page, origin: V3, size: V3 = [20, 20, 20]) => addSolid(page, { at: origin, size });

/** The corners of a box (origin, size). */
const corners = (o: V3, s: V3): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [o[0] + (k & 1 ? s[0] : 0), o[1] + (k & 2 ? s[1] : 0), o[2] + (k & 4 ? s[2] : 0)]);

/** An rgb colour. */
type RGB = [number, number, number];

/** The darkest pixel (the line's) and the brightest (the paper beside it) within r px of a model point. */
async function inkAndPaper(page: Page, p: V3, r = 3): Promise<{ ink: RGB; paper: RGB }> {
  const [x, y] = await at(page, p);
  const img = PNG.decode(await page.screenshot({ clip: { x: Math.round(x) - r, y: Math.round(y) - r, width: 2 * r + 1, height: 2 * r + 1 } }));
  let ink: RGB = [255, 255, 255];
  let paper: RGB = [0, 0, 0];
  for (let i = 0; i < img.width * img.height; i++) {
    const c: RGB = [img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2]];
    if (c[0] + c[1] + c[2] < ink[0] + ink[1] + ink[2]) ink = c;
    if (c[0] + c[1] + c[2] > paper[0] + paper[1] + paper[2]) paper = c;
  }
  return { ink, paper };
}

/**
 * How well a pixel is `colour` laid over `paper`: an antialiased line (Linux CI draws with
 * SwiftShader, whose thin lines never reach their full colour) is
 * coverage * colour + (1 - coverage) * paper in every channel, with one coverage. Returns the
 * best coverage (least squares) and what is left over (rms, in rgb units): a few units for the
 * line's own colour, tens for another colour.
 */
function coverageOf(px: RGB, paper: RGB, colour: RGB): { coverage: number; off: number } {
  const d = [0, 1, 2].map((i) => paper[i] - px[i]);
  const e = [0, 1, 2].map((i) => paper[i] - colour[i]);
  const ee = e.reduce((s, v) => s + v * v, 0);
  const coverage = ee ? d.reduce((s, v, i) => s + v * e[i], 0) / ee : 0;
  const off = Math.sqrt(d.reduce((s, v, i) => s + (v - coverage * e[i]) ** 2, 0) / 3);
  return { coverage, off };
}

/** The sketch colours (src/features/sketch/colors.ts): fully defined #101828, under defined #1570ef. */
const FULLY: RGB = [0x10, 0x18, 0x28];
const UNDER: RGB = [0x15, 0x70, 0xef];

/** A stored sketch on the Top plane, opened in sketch mode as the session starts (as the gate's over-defined test does). */
async function storedSketch(page: Page, frame: FrameLocator, s: { points: Record<string, Pt>; entities: unknown[]; constraints: unknown[] }) {
  await cad(
    page,
    (q) => {
      (window as unknown as W).__CAD__.services.doc.beginNew('sketch', {
        support: { kind: 'plane', plane: 'origin:top' },
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        ...q,
        solved: { values: {}, dof: 0, state: 'under' },
      });
    },
    s,
  );
  await expect(frame.locator('[data-cad-toolbar="sketch"]')).toBeVisible();
  await sketchIdle(page);
  await settled(page);
}

// ---------------------------------------------------------------- 1

test('cad:p2p3-review1-layout-1280 at 1280 x 800 a new sketch is centred beside the tree and the Sketch panel; Look at too; the value boxes stay inside the frame', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { seen, frame } = await freshPart(page, request);
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  const right = fr.x + fr.width;
  await sketchOnTop(page, frame);
  const expectBeside = async (where: string) => {
    const stack = (await frame.locator('[data-cad-left-stack]').boundingBox())!;
    const edge = stack.x + stack.width;
    const [ox] = await at(page, [0, 0, 0]);
    // The plane's origin in the middle of what the panels leave free (it was at 640, the frame's middle).
    expect(Math.abs(ox - (edge + right) / 2), `${where}: origin at x = ${Math.round(ox)}, the free part ${Math.round(edge)}..${Math.round(right)}`).toBeLessThan(40);
    // And the plane's left part (u = -40) right of the panels.
    const [lx] = await at(page, [-40, 0, 0]);
    expect(lx, `${where}: u = -40 at x = ${Math.round(lx)}, under the panels (to ${Math.round(edge)})`).toBeGreaterThan(edge + 4);
  };
  await expectBeside('new sketch');
  await shot(page, 'r1-layout-1280-sketch');
  // Look at, from the iso view.
  await tb(frame).locator('[data-command="view.iso"]').click();
  await settled(page);
  await tb(frame).locator('[data-command="view.sketch-look"]').click();
  await settled(page);
  await expectBeside('Look at');
  // A line drawn up to the frame's right edge (as the reviewer's chain went there): its Length
  // and Angle boxes, centred on what they measure and moved out from under the pointer, stay
  // inside the frame (the Angle box sat past x = 1280).
  await page.keyboard.press('l');
  const y = fr.y + fr.height / 2 + 60;
  await page.mouse.move(right - 140, y);
  await page.mouse.click(right - 140, y);
  await page.mouse.move(right - 40, y + 8, { steps: 4 });
  await page.mouse.move(right - 12, y + 10, { steps: 2 });
  const boxes = frame.locator('[data-sketch-box]');
  await expect(boxes).toHaveCount(2);
  for (const b of await boxes.all()) {
    const r = (await b.locator('xpath=..').boundingBox())!;
    expect(r.x + r.width, `the ${await b.getAttribute('data-sketch-box')} box's right edge`).toBeLessThanOrEqual(right);
    expect(r.y + r.height).toBeLessThanOrEqual(fr.y + fr.height);
  }
  await shot(page, 'r1-layout-1280-boxes');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 2

test('cad:p2p3-review1-refit-grow a block that reaches out of a view nobody has moved is framed; after an orbit the camera stays', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const canvasIn = async (o: V3, s: V3, where: string) => {
    const c = (await frame.locator('.cad-viewport').boundingBox())!;
    const stack = (await frame.locator('[data-cad-left-stack]').boundingBox())!;
    for (const p of corners(o, s)) {
      const [x, y] = await at(page, p);
      expect(x > stack.x + stack.width && x < c.x + c.width && y > c.y && y < c.y + c.height, `${where}: corner ${p} at ${Math.round(x)}, ${Math.round(y)}`).toBe(true);
    }
  };
  await addBlock(page, [0, 0, 0]);
  await settled(page);
  // The second block 200 mm away: the view frames both.
  await addBlock(page, [200, 0, 0]);
  await settled(page);
  await canvasIn([0, 0, 0], [20, 20, 20], 'Extrude 1');
  await canvasIn([200, 0, 0], [20, 20, 20], 'Extrude 2');
  await shot(page, 'r1-refit-grow');
  // The user orbits: a third block far away leaves the camera where the user put it.
  const c = (await frame.locator('.cad-viewport').boundingBox())!;
  const mid: Pt = [c.x + c.width * 0.7, c.y + c.height * 0.5];
  await page.mouse.move(...mid);
  await page.mouse.down();
  await page.mouse.move(mid[0] + 60, mid[1] + 20, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  const before = await camera(page);
  await addBlock(page, [-400, 0, 0]);
  await settled(page);
  expect(await camera(page)).toEqual(before);
  // F frames them all.
  await page.keyboard.press('f');
  await settled(page);
  await canvasIn([-400, 0, 0], [20, 20, 20], 'Extrude 3 after F');
  await canvasIn([200, 0, 0], [20, 20, 20], 'Extrude 2 after F');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 3

test('cad:p2p3-review1-planes-auto the origin planes show on an empty Part only: not in sketch mode, not under a finished sketch', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const top = frame.locator('[data-plane-label="origin:top"]');
  await settled(page);
  await expect(top).toBeVisible();
  await sketchOnTop(page, frame);
  await expect(top).toBeHidden();
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40, 20, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await shot(page, 'r1-planes-sketch-mode');
  await finishSketch(frame);
  await settled(page);
  await expect(top).toBeHidden();
  // Selected in the tree, it shows (as once bodies exist).
  await frame.locator('[data-tree-node="origin:top"] > .tree-row').click();
  await expect(top).toBeVisible();
  await page.keyboard.press('Escape');
  // (The pointer still on the row would show it as hovered: move it to an empty part of the view.
  // A jump out of the frame leaves the row hovered in real Chrome, whose frame gets no pointer-out.)
  const fr = (await page.locator('#workspace-frame').boundingBox())!;
  await page.mouse.move(fr.x + fr.width - 60, fr.y + fr.height - 140, { steps: 8 });
  await expect(top).toBeHidden();
  // Undo the sketch: the Part is empty again, and the planes are back.
  await page.keyboard.press('Control+z');
  await expect(frame.locator('[data-cad-tree] [data-feature-row]')).toHaveCount(0);
  await expect(top).toBeVisible();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 4

test('cad:p2p3-review1-sketch-colours in model mode a dimensioned rectangle is drawn in the fully defined colour beside a free circle in blue', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  // A rectangle from the origin, 40 x 20, dimensioned: fully defined.
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await clickAt(page, [40.3, 20.2, 0]);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('d');
  const edit = frame.locator('[data-sketch-dim-edit]');
  await clickAt(page, [20, 0, 0]);
  await clickAt(page, [20, -8, 0]);
  await edit.fill('40');
  await edit.press('Enter');
  await sketchIdle(page);
  await clickAt(page, [40, 10, 0]);
  await clickAt(page, [52, 10, 0]);
  await edit.fill('20');
  await edit.press('Enter');
  await sketchIdle(page);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText('Fully defined');
  // A free circle: the sketch is under defined.
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await clickAt(page, [75, 10, 0], true);
  await clickAt(page, [83, 10, 0], true);
  await sketchIdle(page);
  await expect(frame.locator('[data-chip="sketch"]')).toHaveText(/^Under defined · 3 DOF$/);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  await page.mouse.move(5, 5);
  await settled(page);
  await shot(page, 'r1-sketch-colours-model');
  // #101828 on the rectangle's edges, #1570ef on the circle: each line's darkest pixel is its colour
  // laid over the paper beside it (one coverage in every channel), clearly drawn, and not the
  // other colour. Measured against the paper, not as an absolute sum: Linux CI's SwiftShader
  // antialiases a 1 px line to rgb 90,100,117 (#101828 at about 66 %), where a GPU draws ~#101828.
  for (const p of [
    [10, 0, 0],
    [40, 14, 0],
  ] as V3[]) {
    const { ink, paper } = await inkAndPaper(page, p);
    const fully = coverageOf(ink, paper, FULLY);
    const under = coverageOf(ink, paper, UNDER);
    const said = `rectangle edge at ${p}: rgb ${ink} on rgb ${paper}: as #101828 ${fully.coverage.toFixed(2)} off ${fully.off.toFixed(1)}, as #1570ef ${under.coverage.toFixed(2)} off ${under.off.toFixed(1)}`;
    expect(fully.coverage, `${said} (drawn)`).toBeGreaterThan(0.4);
    expect(fully.off, `${said} (the fully defined colour)`).toBeLessThan(15);
    expect(under.off, `${said} (not blue)`).toBeGreaterThan(25);
  }
  {
    const { ink, paper } = await inkAndPaper(page, [75, 18, 0]);
    const fully = coverageOf(ink, paper, FULLY);
    const under = coverageOf(ink, paper, UNDER);
    const said = `circle at the top: rgb ${ink} on rgb ${paper}: as #1570ef ${under.coverage.toFixed(2)} off ${under.off.toFixed(1)}, as #101828 ${fully.coverage.toFixed(2)} off ${fully.off.toFixed(1)}`;
    expect(under.coverage, `${said} (drawn)`).toBeGreaterThan(0.4);
    expect(under.off, `${said} (the under defined colour)`).toBeLessThan(15);
    expect(fully.off, `${said} (not the fully defined colour)`).toBeGreaterThan(25);
  }
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 5

test('cad:p2p3-review1-face-names Press-pull and Measure name the same face the same way, "Face N of flange"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const chooser = page.waitForEvent('filechooser');
  await tb(frame).locator('[data-command="file.import-step"]').click();
  await (await chooser).setFiles(FLANGE);
  await expect(panel(frame).locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await settled(page);
  const measured = async (z: number) => {
    await page.keyboard.press('Escape');
    await tb(frame).locator('[data-command="inspect.measure"]').click();
    await expect(panel(frame).locator('[data-tool-panel="inspect.measure"]')).toBeVisible();
    await clickAt(page, [-40, -40, z]);
    const row = panel(frame).locator('[data-pick-row]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.cad-pick-name')).toHaveText(/^Face \d+ of flange$/);
    const t = (await row.locator('.cad-pick-name').textContent())!;
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    return t;
  };
  // Measure names the top face (z = 10) ...
  const before = await measured(10);
  // ... and Press-pull names it the same.
  await page.keyboard.press('Escape');
  await clickAt(page, [-40, -40, 10]);
  await page.keyboard.press('q');
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="press_pull"]')).toBeVisible();
  const name = p.locator('[data-pick-field="faces"] .cad-pick-name');
  await expect(name).toHaveText([before]);
  await expect(name).toHaveAttribute('title', new RegExp(`^${before}, from Face \\d+ of Imported 1 \\(flange\\.step\\)$`));
  // 5 mm out: the result numbers its faces anew, the row keeps the name it was picked by.
  const d = p.locator('.nui[data-field="distance"] input');
  await d.fill('5');
  await d.press('Enter');
  await expect(frame.locator('[data-chip="size"]')).toHaveText('Size100 mm × 100 mm × 15 mm', { timeout: 30_000 });
  await expect(name).toHaveText([before]);
  await shot(page, 'r1-face-names-press-pull');
  await p.locator('[data-panel-done]').click();
  await expect(featureRow(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
  // Reopened, Press-pull names it as the part is now, and Measure (the face at z = 15) the same.
  await featureRow(frame, 'Press-pull 1').locator('> .tree-row').dblclick();
  await expect(name).toHaveText([/^Face \d+ of flange$/]);
  const now = (await name.textContent())!;
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  expect(await measured(15)).toBe(now);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 6

test('cad:p2p3-review1-dimension-place a rectangle typed 60 x 20 labels its width below it and its height right of it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await sketchOnTop(page, frame);
  await page.keyboard.press('r');
  await clickAt(page, [0, 0, 0]);
  await moveTo(page, [50, 15, 0]);
  await expect(frame.locator('[data-sketch-box="width"]')).toBeVisible();
  await page.keyboard.type('60');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  const dims = frame.locator('[data-sketch-dim]');
  await expect(dims).toHaveText(['60', '20']);
  await settled(page);
  const centre = (b: Box): Pt => [b.x + b.width / 2, b.y + b.height / 2];
  const w = centre((await dims.nth(0).boundingBox())!);
  const h = centre((await dims.nth(1).boundingBox())!);
  const [, bottom] = await at(page, [30, 0, 0]);
  const [rightEdge] = await at(page, [60, 10, 0]);
  expect(w[1], `the 60 at y = ${Math.round(w[1])}, the bottom edge at ${Math.round(bottom)}`).toBeGreaterThan(bottom + 4);
  expect(h[0], `the 20 at x = ${Math.round(h[0])}, the right edge at ${Math.round(rightEdge)}`).toBeGreaterThan(rightEdge + 4);
  await shot(page, 'r1-dimension-place');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 7

test('cad:p2p3-review1-symmetric-twin Symmetric on two points in one place is refused in words, and new lines are taken after it', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await storedSketch(page, frame, {
    points: { a: [20, 0], b: [20, 0], c: [20, -20], d: [20, 20] },
    entities: [
      { id: 'q1', kind: 'point', p: 'a' },
      { id: 'q2', kind: 'point', p: 'b' },
      { id: 'm', kind: 'line', p: ['c', 'd'] },
    ],
    constraints: [],
  });
  // A window around the two points (the line runs out of it), then Ctrl+click the line.
  const [x0, y0] = await at(page, [16, 4, 0]);
  const [x1, y1] = await at(page, [24, -4, 0]);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  await clickAt(page, [20, 14, 0], true);
  const btn = tb(frame).locator('[data-command="sketch.symmetric"]');
  await expect(btn).toHaveAttribute('aria-disabled', 'true');
  await expect(btn).toHaveAttribute('data-disabled-reason', 'Symmetric needs two points apart: these two are in the same place');
  await shot(page, 'r1-symmetric-twin');
  // A new line is taken.
  await page.keyboard.press('Escape');
  await inView(page, frame, [[40, 0, 0], [60, 10, 0]]);
  await page.keyboard.press('l');
  await clickAt(page, [40, 0, 0], true);
  await clickAt(page, [60, 10, 0], true);
  await sketchIdle(page);
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-cad-panel="sketch"] [data-run-reason]')).toHaveCount(0);
  expect((await draft(page)).entities.map((e) => e.kind)).toEqual(['point', 'point', 'line', 'line']);
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 8

test('cad:p2p3-review1-trim-relation after a trim splits a line, a point on the far piece is On line of that piece, and its glyph says so', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await storedSketch(page, frame, {
    points: { a: [0, 0], b: [40, 0], c1: [10, -10], c2: [10, 10], e1: [30, -10], e2: [30, 10], q: [35, 0], s: [35, 8] },
    entities: [
      { id: 'h', kind: 'line', p: ['a', 'b'] },
      { id: 'v1', kind: 'line', p: ['c1', 'c2'] },
      { id: 'v2', kind: 'line', p: ['e1', 'e2'] },
      { id: 'k', kind: 'line', p: ['q', 's'] },
    ],
    constraints: [{ id: 'on1', kind: 'point_on_line', refs: ['q', 'h'] }],
  });
  const glyph = frame.locator('[data-sketch-glyph="point_on_line"][data-constraint="on1"]');
  await expect(glyph).toHaveAttribute('aria-label', 'On line: End of Line 4, Line 1');
  // Trim the middle of the long line (between the two crossings).
  await tb(frame).locator('[data-command="sketch.trim"]').click();
  await clickAt(page, [20, 0, 0]);
  await sketchIdle(page);
  const d = await draft(page);
  const lines = d.entities.filter((e) => e.kind === 'line');
  expect(lines).toHaveLength(5);
  const piece = lines[4];
  const ends = piece.p!.map((id) => d.points[id][0]).sort((m, n) => m - n);
  expect(ends[0]).toBeCloseTo(30, 6);
  expect(ends[1]).toBeCloseTo(40, 6);
  expect(d.constraints.find((c) => c.id === 'on1')!.refs).toEqual(['q', piece.id]);
  await expect(glyph).toHaveAttribute('aria-label', 'On line: End of Line 4, Line 5');
  await shot(page, 'r1-trim-relation');
  await page.keyboard.press('Escape');
  await finishSketch(frame);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------- 9

test('cad:p2p3-review1-delete-words a face of a block that OCCT cannot remove and heal says why in words, with no OCCT token', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBlock(page, [0, 0, 0]);
  await settled(page);
  // The front face (y = 0), Delete, then "Delete faces and heal".
  await clickAt(page, [10, 0, 10]);
  await expect.poll(() => cad<string[]>(page, () => (window as unknown as W).__CAD__.services.selection.get().items.map((i: { kind: string }) => i.kind))).toEqual(['face']);
  await page.keyboard.press('Delete');
  await frame.locator('[data-dialog-choice="faces"]').click();
  const p = panel(frame);
  await expect(p.locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  const reason = p.locator('[data-run-reason]').first();
  await expect(reason).toHaveText(/^Delete faces 1 failed: /, { timeout: 30_000 });
  const text = (await reason.textContent())!;
  expect(text, text).not.toMatch(/BOPAlgo|_Alert|Alert[A-Z]/);
  expect(text).toContain('(the faces around them cannot be extended to close the gap)');
  await shot(page, 'r1-delete-words');
  await p.locator('[data-panel-delete]').click();
  await expect(featureRow(frame, 'Delete faces 1')).toHaveCount(0);
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
