// The Part viewport as a user sees it, in the host's sandboxed frame:
//  - an empty part shows the Top / Front / Right planes with labels; hovering
//    one lights it, clicking selects it (the tree row too), Ctrl+click adds,
//    empty space clears; the triad and the XYZ key sit bottom-right like the
//    core's;
//  - a kernel box (made and tessellated by the frame's own kernel worker) is
//    shaded with the core's headlight Phong (pixel-exact against the formula;
//    the core viewer shows the same pixels for the same cube), hover
//    pre-highlights, clicks select faces / edges / vertices, the filter picks
//    bodies, standard views turn the camera (Top is face-on), orthographic
//    keeps parallel lines parallel, the section view cuts and caps (Flip keeps
//    the other side), hiding the body empties the view, the wheel zooms to the
//    cursor, drags orbit / pan / zoom, right-click announces the context menu,
//    the keys 5 / 1 / N / F work;
//  - a Box made with the toolbar (the document's rebuild) is drawn from
//    doc.state, its vertices come from the kernel, double-click edits it, the
//    tree's eye hides it and Undo removes it.
// No CSP violations and no console errors. In real Chrome/Edge the sandboxed
// frame runs in its own process, so input reaches it after the CDP call
// returns: every check after an input polls.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Frame, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addSketch, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type RGB = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any }; __vpMenu?: unknown[] };

const BG: RGB = [0xf0, 0xf2, 0xf7];
const BODY: RGB = [0xbd, 0xc9, 0xdb];
const HOVER: RGB = [0xb2, 0xcc, 0xff];
const PICK: RGB = [0x2e, 0xc4, 0x7e];
const SET_BLUE: RGB = [0x48, 0x84, 0xeb];
const BODY_SEL: RGB = [0x47, 0x85, 0xeb];
const HOME: V3 = [-0.55, -0.75, 0.42];

/** The core's vtk.js headlight Phong (src/viewport/colors.ts): ambient .16, diffuse .78, specular .22 (body colour), power 28. */
function lit(c: RGB, n: V3, towardViewer: V3, spec: RGB = BODY): RGB {
  const l = Math.hypot(...towardViewer);
  const nz = Math.max(0, (n[0] * towardViewer[0] + n[1] * towardViewer[1] + n[2] * towardViewer[2]) / l);
  return c.map((v, i) => Math.min(255, Math.round(v * 0.16 + nz * v * 0.78 + Math.pow(nz, 28) * spec[i] * 0.22))) as RGB;
}
function blend(src: RGB, a: number, dst: RGB): RGB {
  return src.map((v, i) => Math.round(v * a + dst[i] * (1 - a))) as RGB;
}
function near(a: RGB, b: RGB, tol = 3): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

interface Topo {
  faces: { i: number; normal?: V3 }[];
  edges: { i: number; mid: V3 }[];
  vertices: { i: number; p: V3 }[];
}

// ---- the viewport through window.__CAD__ (state checks and projections only; the user's actions go through the mouse and keys)
const project = (frame: Frame, p: V3) => frame.evaluate((q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q) as [number, number] | null, p);
const screenDist = (frame: Frame, a: V3, b: V3) =>
  frame.evaluate(([x, y]) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const p = h.project(x);
    const q = h.project(y);
    return Math.hypot(p[0] - q[0], p[1] - q[1]) as number;
  }, [a, b] as const);
const vpState = (frame: Frame) =>
  frame.evaluate(() => {
    const s = (window as unknown as W).__CAD__.services.viewport.get().handle.state.get();
    return { ...s, hover: s.hover ? s.hover.item : null } as { hover: unknown; triangles: number; bodies: number; section: { on: boolean }; animating: boolean; bvhPending: number };
  });
const hoverItem = async (frame: Frame) => (await vpState(frame)).hover;
const selection = (frame: Frame) => frame.evaluate(() => (window as unknown as W).__CAD__.services.selection.get().items as unknown[]);
const filterOf = (frame: Frame) => frame.evaluate(() => (window as unknown as W).__CAD__.services.selection.get().filter as unknown[]);
const pickModel = (frame: Frame, p: V3) =>
  frame.evaluate((q) => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const s = h.project(q);
    const r = h.pick(s[0], s[1]);
    return r ? r.item : null;
  }, p);

async function expectSelection(frame: Frame, items: unknown[]) {
  await expect.poll(() => selection(frame)).toEqual(items);
}

/** The frame's client point in page coordinates. */
async function pagePoint(page: Page, p: [number, number]): Promise<[number, number]> {
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + p[0], box.y + p[1]];
}

/** Page point of a model point (through the viewport's own projection). */
async function at(page: Page, frame: Frame, p: V3): Promise<[number, number]> {
  const s = await project(frame, p);
  expect(s, `projection of ${p}`).not.toBeNull();
  return pagePoint(page, s!);
}

/**
 * A page screenshot, then one paint of the frame: in real Chrome/Edge the next
 * mouse event after a screenshot sometimes never reaches the sandboxed frame
 * (its own process) until the frame paints again (measured: 1-2 of 12 moves
 * lost after screenshots, none with this repaint or without screenshots).
 */
async function shot(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const buf = await page.screenshot({ clip });
  await workspaceFrame(page).evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => {
          document.body.style.setProperty('--e2e-repaint', String(Math.random()));
          requestAnimationFrame(() => r(null));
        }),
      ),
  );
  return buf;
}

async function pixel(page: Page, pt: [number, number]): Promise<RGB> {
  return PNG.center(await shot(page, { x: Math.round(pt[0]) - 2, y: Math.round(pt[1]) - 2, width: 5, height: 5 }));
}

/** The pixels of an n x n square around a point. */
async function region(page: Page, pt: [number, number], n = 11): Promise<RGB[]> {
  const h = Math.floor(n / 2);
  const img = PNG.decode(await shot(page, { x: Math.round(pt[0]) - h, y: Math.round(pt[1]) - h, width: n, height: n }));
  const out: RGB[] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) out.push(PNG.at(img, x, y));
  return out;
}

/** Polls a pixel until it is `want` (within tol). */
async function expectPixel(page: Page, pt: [number, number], want: RGB, message: string, tol = 3) {
  await expect
    .poll(
      async () => {
        const got = await pixel(page, pt);
        return near(got, want, tol) ? 'ok' : `${got} (want ${want})`;
      },
      { message, timeout: 10_000 },
    )
    .toBe('ok');
}

/** Wait until no transition runs and every picking structure is built, then two more frames. */
async function settle(frame: Frame) {
  await frame.waitForFunction(() => {
    const s = (window as unknown as W).__CAD__.services.viewport.get().handle.state.get();
    return !s.animating && s.bvhPending === 0;
  });
  await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A box made and tessellated by the frame's kernel, drawn through the viewport's own API. */
async function addBox(frame: Frame, size: V3): Promise<Topo> {
  return frame.evaluate(async (sz) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type R = Record<string, any>;
    const s = (window as unknown as W).__CAD__.services;
    const box = (await s.kernel.call('box', { dx: sz[0], dy: sz[1], dz: sz[2] })).result as R;
    const t = await s.kernel.call('tessellate', { id: box.id });
    const topo = (await s.kernel.call('topo', { id: box.id })).result as R;
    const b = t.buffers as Record<string, ArrayBuffer>;
    const tess = {
      positions: new Float32Array(b.positions),
      normals: new Float32Array(b.normals),
      indices: new Uint32Array(b.indices),
      faceRanges: new Uint32Array(b.face_ranges),
      edgePositions: new Float32Array(b.edge_positions),
      edgeRanges: new Uint32Array(b.edge_ranges),
      edgeFlags: b.edge_flags ? new Uint8Array(b.edge_flags) : null,
    };
    const vertices = new Float32Array((topo.vertices as { p: number[] }[]).flatMap((v) => v.p));
    s.viewport.get().handle.setBodies([{ id: 'b_test', color: '#bdc9db', visible: true, tessKey: 't1', tess, vertices }]);
    return topo as unknown as Topo;
  }, size);
}

test.describe.configure({ mode: 'serial' });

test('cad:p1-viewport-empty the origin planes, labels, hover, selection and the triad', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const f = await partOpened(page);
  const frame = workspaceFrame(page);
  await expect(f.locator('[data-cad-app]')).toHaveAttribute('data-viewport', 'ready');
  await settle(frame);

  // Labels on the three planes; the bottom-right cluster like the core's.
  await expect(f.locator('.cad-vp-label:visible')).toHaveText(['Top', 'Front', 'Right']);
  await expect(f.locator('.cad-vp-axes-key .ax')).toHaveText(['X', 'Y', 'Z']);
  await expect(f.locator('[data-vp-fit]')).toHaveAttribute('title', 'Fit model to viewport');

  // The triad: red, green and blue arrows in its 72 px slot.
  const slot = (await f.locator('[data-triad-slot]').boundingBox())!;
  expect(Math.round(slot.width)).toBe(72);
  const tri = PNG.decode(await shot(page, slot));
  const count = (pred: (c: RGB) => boolean) => {
    let n = 0;
    for (let y = 0; y < tri.height; y++) for (let x = 0; x < tri.width; x++) if (pred(PNG.at(tri, x, y))) n++;
    return n;
  };
  expect(count(([r, g, b]) => r > 140 && g < 90 && b < 90), 'red X arrow').toBeGreaterThan(20);
  expect(count(([r, g, b]) => g > 110 && r < 90 && b < 110), 'green Y arrow').toBeGreaterThan(20);
  expect(count(([r, g, b]) => b > 140 && r < 90 && g < 140), 'blue Z arrow').toBeGreaterThan(20);

  // A point only the Top plane covers (the planes are see-through: none other in front or behind).
  const topPt = await at(page, frame, [45, -45, 0]);
  await expectPixel(page, topPt, blend(SET_BLUE, 0.07, BG), 'plane fill');
  await page.mouse.move(...topPt);
  await expect.poll(() => hoverItem(frame)).toEqual({ kind: 'origin', ref: 'origin:top' });
  await expect(f.locator('.cad-vp-label[data-plane-label="origin:top"]')).toHaveAttribute('data-state', 'hover');
  await expectPixel(page, topPt, blend(HOVER, 0.45, BG), 'hovered plane', 4);

  // Click selects it (pick fill), and the tree shows the row selected.
  await page.mouse.click(...topPt);
  await expectSelection(frame, [{ kind: 'origin', ref: 'origin:top' }]);
  await expectPixel(page, topPt, blend(PICK, 0.28, BG), 'selected plane', 4);
  await expect(f.locator('[data-tree-node="origin:top"]')).toHaveClass(/selected/);

  // Ctrl+click the Front plane adds it; a click on empty space clears.
  const frontPt = await at(page, frame, [-30, 0, 30]);
  await page.keyboard.down('Control');
  await page.mouse.click(...frontPt);
  await page.keyboard.up('Control');
  await expectSelection(frame, [
    { kind: 'origin', ref: 'origin:top' },
    { kind: 'origin', ref: 'origin:front' },
  ]);
  const vpBox = (await f.locator('.cad-viewport-canvas').boundingBox())!;
  await page.mouse.click(vpBox.x + vpBox.width - 150, vpBox.y + 40);
  await expectSelection(frame, []);
  // Selecting a plane's row in the tree lights it in the viewport.
  await f.locator('[data-tree-node="origin:right"] > .tree-row').click();
  await expectPixel(page, await at(page, frame, [0, 45, 45]), blend(PICK, 0.28, BG), 'plane selected from the tree', 4);

  const shots = process.env.CAD_E2E_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'viewport-empty.png') });
  }
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-viewport-box shading, picking, views, section, visibility and the mouse', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const f = await partOpened(page);
  const frame = workspaceFrame(page);
  await expect(f.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  await frame.waitForFunction(() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.status !== 'running');
  await settle(frame);

  const topo = await addBox(frame, [10, 20, 30]);
  await settle(frame);
  const faceBy = (n: V3) => topo.faces.find((x) => x.normal && x.normal.every((v, i) => Math.abs(v - n[i]) < 1e-9))!.i;
  const front = faceBy([0, -1, 0]);
  const left = faceBy([-1, 0, 0]);
  const top = faceBy([0, 0, 1]);
  expect(await vpState(frame)).toMatchObject({ triangles: 12, bodies: 1 });
  // With a body, the origin planes (auto) are not drawn.
  await expect(f.locator('.cad-vp-label:visible')).toHaveCount(0);

  // Shading: the first body is framed from the core's default direction; each face lights by the formula.
  const frontPt = await at(page, frame, [5, 0, 15]);
  const leftPt = await at(page, frame, [0, 10, 15]);
  const topPt = await at(page, frame, [5, 10, 30]);
  await expectPixel(page, frontPt, lit(BODY, [0, -1, 0], HOME), 'front face');
  await expectPixel(page, leftPt, lit(BODY, [-1, 0, 0], HOME), 'left face');
  await expectPixel(page, topPt, lit(BODY, [0, 0, 1], HOME), 'top face');
  // Edges in the core's near-black.
  const edgePt = await at(page, frame, [5, 0, 30]);
  const e = await pixel(page, edgePt);
  expect(e[0] < 60 && e[1] < 60 && e[2] < 60, `edge pixel ${e}`).toBe(true);

  // Hover pre-highlights a face; a click selects it (pick green).
  await page.mouse.move(...frontPt);
  await expect.poll(() => hoverItem(frame)).toEqual({ kind: 'face', body: 'b_test', index: front });
  await expectPixel(page, frontPt, lit(HOVER, [0, -1, 0], HOME), 'hovered face');
  await page.mouse.click(...frontPt);
  await expectSelection(frame, [{ kind: 'face', body: 'b_test', index: front }]);
  await page.mouse.move(...leftPt);
  await expectPixel(page, frontPt, lit(PICK, [0, -1, 0], HOME), 'selected face');
  // Ctrl+click adds the left face; empty space clears.
  await page.keyboard.down('Control');
  await page.mouse.click(...leftPt);
  await page.keyboard.up('Control');
  await expectSelection(frame, [
    { kind: 'face', body: 'b_test', index: front },
    { kind: 'face', body: 'b_test', index: left },
  ]);
  const vpBox = (await f.locator('.cad-viewport-canvas').boundingBox())!;
  const empty: [number, number] = [vpBox.x + vpBox.width - 150, vpBox.y + 40];
  await page.mouse.click(...empty);
  await expectSelection(frame, []);

  // An edge 6 px off the front face's top edge: hover, then select it (a green line).
  const topEdge = topo.edges.find((x) => Math.hypot(x.mid[0] - 5, x.mid[1], x.mid[2] - 30) < 1e-6)!.i;
  await page.mouse.move(edgePt[0], edgePt[1] - 6);
  await expect.poll(() => hoverItem(frame)).toEqual({ kind: 'edge', body: 'b_test', index: topEdge });
  await page.mouse.click(edgePt[0], edgePt[1] - 6);
  await expectSelection(frame, [{ kind: 'edge', body: 'b_test', index: topEdge }]);
  await page.mouse.move(...empty);
  await expect
    .poll(async () => {
      const g = await pixel(page, edgePt);
      return g[1] > 150 && g[0] < 90 && g[2] < 160 ? 'green' : String(g);
    }, { message: 'selected edge pixel' })
    .toBe('green');

  // A vertex (the kernel's index of the corner at 0,0,30): a green marker.
  const corner = topo.vertices.find((v) => Math.hypot(v.p[0], v.p[1], v.p[2] - 30) < 1e-6)!.i;
  const cPt = await at(page, frame, [0, 0, 30]);
  await page.mouse.move(cPt[0] + 2, cPt[1] + 2);
  await expect.poll(() => hoverItem(frame)).toEqual({ kind: 'vertex', body: 'b_test', index: corner });
  await page.mouse.click(cPt[0] + 2, cPt[1] + 2);
  await expectSelection(frame, [{ kind: 'vertex', body: 'b_test', index: corner }]);
  await page.mouse.move(...empty);
  await expect
    .poll(async () => {
      const g = await pixel(page, cPt);
      return g[1] > 180 && g[0] < 90 ? 'green' : String(g);
    }, { message: 'vertex marker' })
    .toBe('green');

  // The filter: Bodies only -> a click on a face selects the body (the core's selected-body blue).
  await f.locator('[data-vp-opens="filter"]').click();
  await f.locator('[data-filter="body"]').click();
  await expect.poll(() => filterOf(frame)).toEqual(['body']);
  await page.mouse.click(...topPt);
  await expectSelection(frame, [{ kind: 'body', body: 'b_test' }]);
  await page.mouse.move(...empty);
  await expectPixel(page, topPt, lit(BODY_SEL, [0, 0, 1], HOME), 'selected body');
  await f.locator('[data-vp-opens="filter"]').click();
  await f.locator('[data-filter-clear]').click();
  await expect.poll(() => filterOf(frame)).toEqual([]);
  await page.mouse.click(...empty);
  await expectSelection(frame, []);

  // Standard views from the menu. Top looks straight down: the top face is face-on (1.16 x the body colour, clamped).
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-view="top"]').click();
  await expect.poll(() => screenDist(frame, [5, 10, 0], [5, 10, 30]), { message: 'top view: the axis through the centre is a point' }).toBeLessThan(0.5);
  await settle(frame);
  await expectPixel(page, await at(page, frame, [5, 10, 30]), lit(BODY, [0, 0, 1], [0, 0, 1]), 'top view: top face-on');
  // Front, then orthographic: the front and back corners of a side edge coincide.
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-view="front"]').click();
  await expect.poll(() => screenDist(frame, [5, 0, 15], [5, 20, 15])).toBeLessThan(0.5);
  await settle(frame);
  expect(await screenDist(frame, [0, 0, 0], [0, 20, 0])).toBeGreaterThan(1);
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-vp-seg="Projection"] [data-value="orthographic"]').click();
  await expect.poll(() => screenDist(frame, [0, 0, 0], [0, 20, 0])).toBeLessThan(0.01);
  await page.keyboard.press('Escape');
  await expectPixel(page, await at(page, frame, [5, 0, 15]), lit(BODY, [0, -1, 0], [0, -1, 0]), 'ortho front face-on');
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-vp-seg="Projection"] [data-value="perspective"]').click();
  await expect.poll(() => screenDist(frame, [0, 0, 0], [0, 20, 0])).toBeGreaterThan(1);
  await page.keyboard.press('Escape');

  // Home (the core's Fit button) goes back to the default direction.
  await f.locator('[data-vp-fit]').click();
  await expect.poll(() => screenDist(frame, [5, 0, 15], [5, 20, 15])).toBeGreaterThan(5);
  await settle(frame);
  const leftHome = await at(page, frame, [0, 5, 15]);
  await expectPixel(page, leftHome, lit(BODY, [-1, 0, 0], HOME), 'left face, home view');

  // Section view: the cut at the middle of the box (y = 10) removes the front half; where the left
  // face was (y = 5) the cap now shows, lit like a face turned to -Y, and nothing is picked there.
  // Flip keeps the other half, and the left face is back.
  await f.locator('[data-vp-opens="section"]').click();
  await expect(f.locator('[data-vp-pop="section"]')).toBeVisible();
  await expect.poll(async () => (await vpState(frame)).section).toEqual({ on: true, plane: 'origin:front', offset: -10, flip: false });
  await expect(f.locator('[data-section-value]')).toHaveText('Y 10 mm');
  // The cap: lit like a face turned to -Y, with diagonal hatching (0.62 of that colour) so it reads as a cut.
  const capLit = lit(BODY, [0, -1, 0], HOME);
  const hatch = capLit.map((v) => Math.round(v * 0.62)) as RGB;
  await expect
    .poll(async () => {
      const px = await region(page, leftHome);
      const plain = px.filter((p) => near(p, capLit)).length;
      const dark = px.filter((p) => near(p, hatch, 6)).length;
      return plain > 50 && dark > 8 ? 'hatched cap' : `plain ${plain}, hatch ${dark} of ${px.length}`;
    }, { message: 'section cap' })
    .toBe('hatched cap');
  expect(await pickModel(frame, [0, 5, 15])).toBeNull();
  await f.locator('[data-section-flip]').click();
  await expectPixel(page, leftHome, lit(BODY, [-1, 0, 0], HOME), 'flipped: the left face is back');
  await f.locator('[data-vp-opens="section"]').click();
  await expect.poll(async () => (await vpState(frame)).section.on).toBe(false);

  // Keys (the frame has focus after the clicks): 5 = Top, 1 = Front, N = normal to the selected top face, F = fit.
  await page.keyboard.press('5');
  await expect.poll(() => screenDist(frame, [5, 10, 0], [5, 10, 30])).toBeLessThan(0.5);
  await settle(frame);
  await page.mouse.click(...(await at(page, frame, [5, 10, 30])));
  await expectSelection(frame, [{ kind: 'face', body: 'b_test', index: top }]);
  await page.keyboard.press('1');
  await expect.poll(() => screenDist(frame, [5, 0, 15], [5, 20, 15])).toBeLessThan(0.5);
  await page.keyboard.press('n');
  await expect.poll(() => screenDist(frame, [5, 10, 0], [5, 10, 30])).toBeLessThan(0.5);
  await settle(frame);
  const before = await screenDist(frame, [0, 0, 0], [10, 0, 0]);
  await page.mouse.move(...empty);
  // One wheel notch out (Chrome: wheelDeltaY -120, whatever deltaY says): 1 / 1.1 like vtk.js.
  await page.mouse.wheel(0, 100);
  await expect.poll(() => screenDist(frame, [0, 0, 0], [10, 0, 0])).toBeLessThan(before * 0.95);
  await page.keyboard.press('f');
  await expect.poll(() => screenDist(frame, [0, 0, 0], [10, 0, 0])).toBeGreaterThan(before * 0.99);
  await settle(frame);

  // The wheel zooms to the cursor: the model point under it stays put, the box grows.
  await f.locator('[data-vp-fit]').click();
  await expect.poll(() => screenDist(frame, [5, 0, 15], [5, 20, 15])).toBeGreaterThan(5);
  await settle(frame);
  const anchorModel: V3 = [2, 0, 25];
  const a0 = await at(page, frame, anchorModel);
  const w0 = await screenDist(frame, [0, 0, 0], [10, 0, 0]);
  await page.mouse.move(...a0);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await screenDist(frame, [0, 0, 0], [10, 0, 0])) / w0).toBeGreaterThan(1.05);
  const a1 = await at(page, frame, anchorModel);
  expect(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), 'anchor stays under the cursor').toBeLessThan(1.5);

  // Left drag orbits (the view direction changes; not a click), middle drag pans, right drag down zooms in.
  const zDir = async () => {
    const c = (await project(frame, [0, 0, 0]))!;
    const d = (await project(frame, [0, 0, 30]))!;
    return [d[0] - c[0], d[1] - c[1]];
  };
  const d0 = await zDir();
  const mid: [number, number] = [vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2];
  await page.mouse.move(...mid);
  await page.mouse.down();
  await page.mouse.move(mid[0] + 80, mid[1] + 30, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const d1 = await zDir();
      return Math.abs(d1[0] - d0[0]) + Math.abs(d1[1] - d0[1]);
    }, { message: 'orbit' })
    .toBeGreaterThan(5);
  await expectSelection(frame, [{ kind: 'face', body: 'b_test', index: top }]);
  const o0 = await at(page, frame, [5, 10, 15]);
  await page.mouse.move(...mid);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(mid[0] + 40, mid[1] - 20, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => {
      const o1 = await at(page, frame, [5, 10, 15]);
      return Math.abs(o1[0] - o0[0] - 40) < 1.5 && Math.abs(o1[1] - o0[1] + 20) < 1.5 ? 'panned' : `${o1[0] - o0[0]},${o1[1] - o0[1]}`;
    }, { message: 'pan by (40, -20)' })
    .toBe('panned');
  const z0 = await screenDist(frame, [0, 0, 0], [10, 0, 0]);
  await page.mouse.move(...mid);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(mid[0], mid[1] + 60, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await screenDist(frame, [0, 0, 0], [10, 0, 0])) / z0, { message: 'right drag down zooms in' }).toBeGreaterThan(1.05);

  // A right click (no drag) on the body announces the context menu with the pick, and selects it.
  await f.locator('[data-vp-fit]').click();
  await expect.poll(() => screenDist(frame, [5, 0, 15], [5, 20, 15])).toBeGreaterThan(5);
  await settle(frame);
  await frame.evaluate(() => {
    const w = window as unknown as W;
    w.__vpMenu = [];
    w.__CAD__.services.bus.on('viewport:contextmenu', (ev: { pick: { item: unknown } | null }) => w.__vpMenu!.push(ev.pick ? ev.pick.item : null));
  });
  await page.mouse.click(...(await at(page, frame, [5, 0, 15])), { button: 'right' });
  await expect.poll(() => frame.evaluate(() => (window as unknown as W).__vpMenu)).toEqual([{ kind: 'face', body: 'b_test', index: front }]);
  await expectSelection(frame, [{ kind: 'face', body: 'b_test', index: front }]);
  await page.keyboard.press('Escape');

  // Hiding the body (what the tree's eye does): nothing drawn or picked there.
  const fp = await at(page, frame, [5, 0, 15]);
  await frame.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setVisibility('b_test', false));
  await expect.poll(async () => (await vpState(frame)).bodies).toBe(0);
  await expect
    .poll(async () => {
      const g = await pixel(page, fp);
      return near(g, lit(PICK, [0, -1, 0], HOME), 12) || near(g, lit(BODY, [0, -1, 0], HOME), 12) ? `still the body: ${g}` : 'gone';
    })
    .toBe('gone');
  // Nothing of the body is picked there (with every body hidden the origin planes show again, as on an empty part).
  expect(await pickModel(frame, [5, 0, 15])).not.toMatchObject({ body: 'b_test' });
  await expect(f.locator('.cad-vp-label:visible')).toHaveCount(3);
  await frame.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.setVisibility('b_test', true));
  await page.mouse.click(...empty);
  await expectSelection(frame, []);
  await expectPixel(page, fp, lit(BODY, [0, -1, 0], HOME), 'shown again');

  // Display: Wireframe draws only the edges (the face is background, the edge still dark);
  // Shaded draws no edges (the edge pixel takes the face colour); then back to shaded with edges.
  const faceNow = await at(page, frame, [5, 0, 15]);
  const edgeNow = await at(page, frame, [5, 0, 30]);
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-vp-seg="Display"] [data-value="wireframe"]').click();
  await expectPixel(page, faceNow, BG, 'wireframe: no surface');
  await expect
    .poll(async () => {
      const g = await pixel(page, edgeNow);
      return g[0] < 60 && g[1] < 60 && g[2] < 60 ? 'dark' : String(g);
    }, { message: 'wireframe: edges drawn' })
    .toBe('dark');
  await f.locator('[data-vp-seg="Display"] [data-value="shaded"]').click();
  await expectPixel(page, faceNow, lit(BODY, [0, -1, 0], HOME), 'shaded: the face');
  await expect
    .poll(async () => {
      const g = await pixel(page, [edgeNow[0], edgeNow[1] + 2]);
      return g[0] > 80 ? 'no edge line' : String(g);
    }, { message: 'shaded: no edge line' })
    .toBe('no edge line');
  await f.locator('[data-vp-seg="Display"] [data-value="shaded-edges"]').click();
  await page.keyboard.press('Escape');

  // Origin planes: Always draws them with a body; Auto hides them again.
  await f.locator('[data-vp-opens="views"]').click();
  await f.locator('[data-vp-seg="Origin planes"] [data-value="always"]').click();
  await expect(f.locator('.cad-vp-label:visible')).toHaveCount(3);
  await f.locator('[data-vp-seg="Origin planes"] [data-value="auto"]').click();
  await expect(f.locator('.cad-vp-label:visible')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const shots = process.env.CAD_E2E_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'viewport-box.png') });
  }
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:p1-viewport-doc a sketch extruded from the toolbar is drawn, picked (with kernel vertices), edited on double-click, hidden by the eye', async ({ page, request }) => {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const f = await partOpened(page);
  const frame = workspaceFrame(page);
  await expect(f.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');

  // The document makes the body (DocService rebuild); the viewport draws it from doc.state.
  // A 20 x 20 sketch on Top, extruded 20 mm (no one-click Box since decision 2026-10-01).
  await addSketch(page);
  await f.locator('[data-command="solid.extrude"]').click();
  const panel = f.locator('[data-cad-panel="feature"]');
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  const dist = panel.locator('.nui[data-field="distance"] input');
  await dist.fill('20');
  await dist.press('Enter');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await vpState(frame)).bodies).toBe(1);
  await settle(frame);
  const body = await frame.evaluate(() => {
    const b = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0];
    return { id: b.id as string, shape: b.shape as number, bbox: b.bbox as number[] };
  });
  expect(body.bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0, 20, 20, 20]);
  expect((await vpState(frame)).triangles).toBe(12);
  const frontPt = await at(page, frame, [10, 0, 10]);
  await expectPixel(page, frontPt, lit(BODY, [0, -1, 0], HOME), 'the extruded block, front face');

  // Vertices come from the kernel (topo, vertices only) through the viewport's binding.
  const corner = await frame.evaluate(async (shape) => {
    const t = (await (window as unknown as W).__CAD__.services.kernel.call('topo', { id: shape, faces: 'none', edges: 'none' })).result;
    return (t.vertices as { i: number; p: number[] }[]).find((v) => Math.hypot(v.p[0], v.p[1], v.p[2] - 20) < 1e-6)!.i;
  }, body.shape);
  const cPt = await at(page, frame, [0, 0, 20]);
  await page.mouse.move(cPt[0] + 2, cPt[1] + 2);
  await expect.poll(() => hoverItem(frame), { timeout: 15_000 }).toEqual({ kind: 'vertex', body: body.id, index: corner });

  // Click the front face, then double-click it: the Extrude 1 panel opens (the UI edits the feature that made it).
  await page.mouse.click(...frontPt);
  await expect.poll(async () => ((await selection(frame)) as { kind: string; body: string }[]).map((s) => `${s.kind}:${s.body}`)).toEqual([`face:${body.id}`]);
  await page.mouse.dblclick(...frontPt);
  await expect(panel.locator('[data-panel-title]')).toHaveText('Extrude 1');
  await panel.locator('[data-panel-done]').click();
  await expect(panel).toHaveCount(0);

  // The tree's eye hides the body in the viewport, and shows it again.
  const folder = f.locator('[data-bodies-folder] > .tree-row');
  const bodyRow = f.locator(`[data-body-row="${body.id}"]`);
  if (!(await bodyRow.isVisible())) await folder.click();
  await expect(bodyRow).toBeVisible();
  await bodyRow.hover();
  const eye = bodyRow.locator('[data-body-act="visibility"]').first();
  await eye.click();
  await expect.poll(async () => (await vpState(frame)).bodies).toBe(0);
  await expect
    .poll(async () => {
      const g = await pixel(page, frontPt);
      return near(g, lit(BODY, [0, -1, 0], HOME), 12) || near(g, lit(PICK, [0, -1, 0], HOME), 12) ? `still the body: ${g}` : 'gone';
    })
    .toBe('gone');
  await bodyRow.hover();
  await eye.click();
  await expect.poll(async () => (await vpState(frame)).bodies).toBe(1);

  // Undo removes the extrude, and its body from the viewport.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await vpState(frame)).bodies).toBe(0);
  expect((await vpState(frame)).triangles).toBe(0);

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
