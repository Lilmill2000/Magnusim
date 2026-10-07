// Press-pull on curved faces (kernel API 6, Daniel 2026-10-06): a true offset of the picked
// faces. Each test clicks as a user does and checks what the user sees: the volume chip
// (analytic, or the native OCCT 7.9.3 value in fixtures/kernel/reference.json p5_offset), the
// panel's words ("Bore radius 10 mm → 8 mm"), the red foot's words with what works, the rows.
//   bore        a sketched plate with a hole: the bore clicked, Q; the default 10 mm would close
//               the hole (red, "9.9 mm or less works"); 2 mm makes it r 8.
//   history     undo, redo, the Part left and opened again, then the plate made thicker
//               upstream: Press-pull still builds (the hole is now blind, its floor trimmed).
//   fillet      a filleted edge's face pushed out 1 mm: the fillet is r 4 and still tangent
//               (24000 - (1 - pi/4) r^2 20), and keeps its name (the pick chip); -1 mm: r 6.
//   draft       a flat face whose neighbour slopes: the slope is extended to meet it (no step).
//   step        the synthetic flange STEP: one hole's bore pulled in 1 mm (r 5 -> 6).
//   vortex      (CAD_E2E_VORTEX_STEP) the torus fillet re-rounded (native); the inlet pipe refused
//               in words (tangent to B-spline faces: moving it alone would leave a step).
// Fix round 1 (the review's findings, one test each):
//   vortex-outlets (CAD_E2E_VORTEX_STEP) B4: UI Faces 12 and 17, reached in the section view,
//               at -1, -2 and +1 (the cylinder method, native volumes).
//   b1-fillet-minus40, b1-bore-split (and P4), b2-fillet-top, b2-chamfer-top, b2-legacy, b3-cone,
//   b4-stepped-step (the synthetic stepped-bore STEP), p2-p3-p5, p3-slope, p6-imperial.
// window.__CAD__ is used to set sketched solids up (helpers addSolid) and to find where a face
// is on screen (its triangles, checked with the view's own pick).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSolid, baseUrl, chipVolumes, ensureCadOn, featureRowNamed, modelOnPage, newPartFromTree, newProject, openPart, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures', 'kernel');
const FLANGE = join(FIXTURES, 'flange.step');
const REF = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8'));
const NATIVE = REF.p5_offset;
const FIX1 = REF.p5_fix1;
const STEPPED = join(FIXTURES, 'stepped-bore.step');
const VORTEX = process.env.CAD_E2E_VORTEX_STEP || '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type V3 = [number, number, number];
interface TopoFace {
  i: number;
  type: string;
  area: number;
  normal?: V3;
  centroid?: V3;
  radius?: number;
}

async function freshPart(page: Page, request: APIRequestContext) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

const cad = <T>(page: Page, fn: (arg: never) => T | Promise<T>, arg?: unknown) => workspaceFrame(page).evaluate(fn as never, arg as never) as Promise<T>;
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const foot = (frame: FrameLocator) => panel(frame).locator('[data-run-reason] .mgk-reason-msg');
const lines = (frame: FrameLocator) => panel(frame).locator('[data-press-line]');
const distance = (frame: FrameLocator) => panel(frame).locator('.nui[data-field="distance"] input');

/** The rebuild is done and every feature has a state; no view transition runs. */
async function settled(page: Page) {
  await expect
    .poll(
      () =>
        cad<boolean>(page, (() => {
          const st = (window as unknown as W).__CAD__.services.doc.state.get();
          return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
        }) as never),
      { timeout: 180_000 },
    )
    .toBe(true);
  await expect.poll(() => cad<boolean>(page, (() => (window as unknown as W).__CAD__.services.viewport.get().handle?.state.get().animating ?? true) as never)).toBe(false);
}

/** The first body's volume as the chip shows it, waited for to be `expected` within `rel`. */
async function expectVolume(frame: FrameLocator, page: Page, expected: number, rel = 1e-9) {
  const id = await cad<string>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0]?.id) as never);
  const at = frame.locator(`[data-chip="volume"] [data-volume-body="${id}"]`).first();
  await expect.poll(async () => Math.abs(Number(await at.getAttribute('data-volume-mm3')) / expected - 1), { timeout: 60_000 }).toBeLessThan(rel);
}

/** The first body's faces (topo). */
async function faces(page: Page): Promise<TopoFace[]> {
  return cad<TopoFace[]>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    return (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: true })).result.faces;
  }) as never);
}

/** A page point where the view's own pick finds this face of the first body (the middle of one of its triangles), or null. */
async function tryPointOn(page: Page, index: number): Promise<[number, number] | null> {
  const xy = await cad<[number, number] | null>(page, ((i: number) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const h = s.viewport.get().handle;
    const t = b.tess;
    const st = t.faceRanges[2 * i];
    const n = t.faceRanges[2 * i + 1];
    const tris: { p: number[]; area: number }[] = [];
    for (let k = st; k < st + n; k += 3) {
      const v = [t.indices[k], t.indices[k + 1], t.indices[k + 2]].map((j: number) => [t.positions[3 * j], t.positions[3 * j + 1], t.positions[3 * j + 2]]);
      const a = [0, 1, 2].map((c) => v[1][c] - v[0][c]);
      const bb = [0, 1, 2].map((c) => v[2][c] - v[0][c]);
      const cr = [a[1] * bb[2] - a[2] * bb[1], a[2] * bb[0] - a[0] * bb[2], a[0] * bb[1] - a[1] * bb[0]];
      // The middle first, then points nearer each corner (a long triangle down a deep bore is seen only near one end).
      for (const w of [
        [1 / 3, 1 / 3, 1 / 3],
        [0.7, 0.15, 0.15],
        [0.15, 0.7, 0.15],
        [0.15, 0.15, 0.7],
      ])
        tris.push({ p: [0, 1, 2].map((c) => w[0] * v[0][c] + w[1] * v[1][c] + w[2] * v[2][c]), area: Math.hypot(cr[0], cr[1], cr[2]) * (w[0] === 1 / 3 ? 1 : 0.5) });
    }
    // Larger triangles first: their middles are well inside the face.
    tris.sort((x, y) => y.area - x.area);
    for (const tri of tris) {
      const c = h.project(tri.p);
      if (!c) continue;
      const hit = h.pick(c[0], c[1]);
      if (hit && hit.item.kind === 'face' && hit.item.index === i && hit.item.body === b.id) return c;
    }
    return null;
  }) as never, index);
  if (!xy) return null;
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + xy[0], box.y + xy[1]];
}

async function clickFace(page: Page, index: number) {
  const p = await tryPointOn(page, index);
  expect(p, `a point of face ${index} in view`).not.toBeNull();
  await page.mouse.move(p![0] + 2, p![1] + 2);
  await page.mouse.move(p![0], p![1], { steps: 2 });
  await page.mouse.click(p![0], p![1]);
}

/** clickFace, in the first standard view (as it is, Top, Iso, Front) that shows a point of the face. */
async function clickFaceInAView(page: Page, frame: FrameLocator, index: number) {
  for (const view of [null, 'view.top', 'view.iso', 'view.front']) {
    if (view) {
      await runCommand(frame, view);
      await settled(page);
    }
    if (await tryPointOn(page, index)) return clickFace(page, index);
  }
  expect(null, `face ${index} in some standard view`).not.toBeNull();
}

async function clickAt(page: Page, p: V3) {
  const [x, y] = await modelOnPage(page, p);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

async function typeDistance(page: Page, frame: FrameLocator, value: string) {
  await distance(frame).fill(value);
  await distance(frame).press('Enter');
  await settled(page);
}

async function importStep(page: Page, frame: FrameLocator, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(path);
  const p = frame.locator('[data-cad-panel]');
  await expect(p.locator('[data-import-diagnostics]')).toBeVisible({ timeout: 180_000 });
  await expect(p.locator('[data-import-progress]')).toHaveCount(0);
  await p.locator('[data-panel-done]').click();
  await expect(p).toHaveCount(0);
  await settled(page);
}

/** The 60 x 40 x 10 plate, sketched and extruded, with a 20 mm hole at (30, 20) cut through it (Extrude 2). */
async function plateWithHole(page: Page): Promise<number> {
  const plate = await addSolid(page, { size: [60, 40, 10] });
  await addSolid(page, { circle: true, at: [30, 20, 0], size: [20, 10], op: 'cut', scope: [plate.body!] });
  await settled(page);
  const bore = (await faces(page)).filter((f) => f.type === 'cylinder');
  expect(bore).toHaveLength(1);
  return bore[0].i;
}

/** A trapezoid on Front (x 0..40 at z 0, x 0..30 at z 20), extruded 30 (Sketch 1, Extrude 1): its top meets a slope. */
async function trapezoid(page: Page) {
    const sketch = await cad<string>(page, (async () => {
      const s = (window as unknown as W).__CAD__.services;
      const handle = s.viewport.get().handle;
      const lookAt = handle?.lookAt;
      if (handle) handle.lookAt = () => {};
      let id: string;
      try {
        const sk = s.doc.beginNew('sketch', {
          support: { kind: 'plane', plane: 'origin:front' },
          plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
          points: { p1: [0, 0], p2: [40, 0], p3: [30, 20], p4: [0, 20] },
          entities: [
            { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
            { id: 'e2', kind: 'line', p: ['p2', 'p3'] },
            { id: 'e3', kind: 'line', p: ['p3', 'p4'] },
            { id: 'e4', kind: 'line', p: ['p4', 'p1'] },
          ],
          constraints: [],
          solved: { values: {}, dof: 8, state: 'under' },
        });
        sk.commit();
        id = sk.feature;
      } finally {
        if (handle && lookAt) handle.lookAt = lookAt;
      }
      for (let k = 0; k < 400; k++) {
        const o = s.doc.state.get().rebuild.outputs[id];
        if (o && o.type === 'sketch' && o.regions?.length) return id;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the sketch made no profile');
    }) as never);
    await cad(page, ((sk: string) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      const region = doc.state.get().rebuild.outputs[sk].regions[0];
      doc.beginNew('extrude', { profiles: [{ sketch: sk, region: region.key, entities: region.entities, sample: region.sample }], extent: { kind: 'blind', distance: '30 mm' }, op: 'new' }).commit();
    }) as never, sketch);
  await settled(page);
}

/** The sum of the volume chip's bodies (mm³). */
async function chipVolumesSum(frame: FrameLocator): Promise<number> {
  return (await chipVolumes(frame)).reduce((a, b) => a + b, 0);
}

const PLATE = 60 * 40 * 10;
const holeVolume = (r: number, h = 10) => Math.PI * r * r * h;

test.describe('Press-pull on curved faces', () => {
  test('cad:p5-pp-bore a sketched plate with a hole: the bore clicked, Q; 10 mm would close the hole (red, with what works); 2 mm makes it r 8 (volume, panel words)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const bore = await plateWithHole(page);
    await expectVolume(frame, page, PLATE - holeVolume(10));
    // Select first, then act: the bore clicked, Q.
    await clickFace(page, bore);
    await page.keyboard.press('q');
    await expect(panel(frame).locator('[data-feature-panel="press_pull"]')).toBeVisible();
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toContainText('cylinder');
    await expect(panel(frame).locator('[data-pick-error="faces"]')).toHaveCount(0);
    await settled(page);
    // The default 10 mm would close the 10 mm hole: red, in words, with the largest that works.
    await expect(foot(frame)).toHaveText('Press-pull 1 failed: the hole would close: 9.9 mm or less works');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
    await expectVolume(frame, page, PLATE - holeVolume(10));
    // 2 mm: material added along the bore's outward normal (toward its axis): the hole is r 8.
    await typeDistance(page, frame, '2');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, PLATE - holeVolume(8), 1e-12);
    await expect(panel(frame).locator('[data-press-sense]')).toHaveText('Adds material: the faces move out of the body');
    await expect(lines(frame)).toHaveText(['Bore radius 10 mm → 8 mm']);
    await expect(panel(frame).locator('[data-press-note]')).toHaveCount(0);
    await expect(panel(frame).locator('[data-press-tangent]')).toHaveCount(0);
    // -2 mm: the hole opens to r 12.
    await typeDistance(page, frame, '-2');
    await expectVolume(frame, page, PLATE - holeVolume(12), 1e-12);
    await expect(panel(frame).locator('[data-press-sense]')).toHaveText('Removes material: the faces move into the body');
    await expect(lines(frame)).toHaveText(['Bore radius 10 mm → 12 mm']);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-pp-history undo, redo, the Part left and opened again; then the plate made 14 mm thick upstream: Press-pull still builds (the hole blind, its floor trimmed)', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { seen, frame } = await freshPart(page, request);
    const bore = await plateWithHole(page);
    await runCommand(frame, 'modify.press-pull');
    await expect(panel(frame).locator('[data-feature-panel="press_pull"]')).toBeVisible();
    await typeDistance(page, frame, '2');
    await clickFace(page, bore);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await settled(page);
    await expectVolume(frame, page, PLATE - holeVolume(8), 1e-12);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    // Undo: the Press-pull is gone, the hole r 10 again; Redo brings it back.
    await page.keyboard.press('Control+z');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveCount(0);
    await settled(page);
    await expectVolume(frame, page, PLATE - holeVolume(10), 1e-12);
    await page.keyboard.press('Control+y');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await settled(page);
    await expectVolume(frame, page, PLATE - holeVolume(8), 1e-12);
    // Back, and the Part opened again: rebuilt to the same volume, the panel says the same words.
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 120_000 });
    const again = await openPart(page, page.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page.locator('.tl', { hasText: 'Part 1' }) }));
    await expect(featureRowNamed(again, 'Press-pull 1')).toHaveAttribute('data-state', 'ok', { timeout: 120_000 });
    await settled(page);
    await expectVolume(again, page, PLATE - holeVolume(8), 1e-12);
    await featureRowNamed(again, 'Press-pull 1').locator('> .tree-row').dblclick();
    await expect(lines(again)).toHaveText(['Bore radius 10 mm → 8 mm']);
    await panel(again).locator('[data-panel-done]').click();
    await expect(panel(again)).toHaveCount(0);
    // Upstream: Extrude 1 (the plate) 10 -> 14 mm. The hole (Extrude 2, 10 deep) is blind now;
    // the bore keeps its name, so Press-pull still finds it, and the hole's floor is trimmed to r 8.
    await featureRowNamed(again, 'Extrude 1').locator('> .tree-row').dblclick();
    await expect(panel(again).locator('[data-feature-panel="extrude"]')).toBeVisible();
    await distance(again).fill('14');
    await distance(again).press('Enter');
    await settled(page);
    await panel(again).locator('[data-panel-done]').click();
    await expect(panel(again)).toHaveCount(0);
    await settled(page);
    await expect(featureRowNamed(again, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expect(again.locator('[data-cad-tree] [data-feature-row][data-state="error"]')).toHaveCount(0);
    await expectVolume(again, page, 60 * 40 * 14 - holeVolume(8), 1e-12);
    await featureRowNamed(again, 'Press-pull 1').locator('> .tree-row').dblclick();
    await expect(lines(again)).toHaveText(['Bore radius 10 mm → 8 mm']);
    await panel(again).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test("cad:p5-pp-fillet a fillet's face pushed out 1 mm is r 4 and still tangent; in 1 mm r 6; it keeps its name (the pick chip)", async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    // Fillet 1: the vertical edge at x 0, y 0 (the one the view looks at), 5 mm.
    await runCommand(frame, 'modify.fillet');
    await expect(panel(frame).locator('[data-feature-panel="fillet"]')).toBeVisible();
    await clickAt(page, [0, 0, 10]);
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(1);
    const r = panel(frame).locator('.nui[data-field="radius"] input');
    await r.fill('5');
    await r.press('Enter');
    await settled(page);
    const box = 40 * 30 * 20;
    const filleted = (rad: number) => box - (1 - Math.PI / 4) * rad * rad * 20;
    await expectVolume(frame, page, filleted(5), 1e-12);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    const fillet = (await faces(page)).filter((f) => f.type === 'cylinder');
    expect(fillet).toHaveLength(1);
    // Press-pull with nothing selected, then the fillet face clicked in the panel's field.
    await runCommand(frame, 'modify.press-pull');
    await expect(panel(frame).locator('[data-feature-panel="press_pull"]')).toBeVisible();
    await typeDistance(page, frame, '1');
    await clickFace(page, fillet[0].i);
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await settled(page);
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    // Out of a convex corner the corner gets sharper: r 4, still tangent (the volume formula holds only then).
    await expectVolume(frame, page, filleted(4), 1e-12);
    expect(NATIVE.fillet.plus_1.volume).toBeCloseTo(filleted(4), 6);
    await expect(lines(frame)).toHaveText(['Fillet radius 5 mm → 4 mm']);
    await typeDistance(page, frame, '-1');
    await expectVolume(frame, page, filleted(6), 1e-12);
    await expect(lines(frame)).toHaveText(['Fillet radius 5 mm → 6 mm']);
    await panel(frame).locator('[data-panel-done]').click();
    await expect(panel(frame)).toHaveCount(0);
    const after = (await faces(page)).filter((f) => f.type === 'cylinder');
    expect(after).toHaveLength(1);
    expect(after[0].radius).toBeCloseTo(6, 9);
    // The new fillet face is still Fillet 1's fillet.
    await clickFace(page, after[0].i);
    await expect(frame.locator('[data-chip="pick"] [data-pick-info]')).toHaveText('Face · Fillet (Fillet 1)');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-pp-draft a flat face whose neighbour slopes: the slope is extended to meet it, no step, no note (native volume)', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // A trapezoid on Front (x 0..40 at z 0, x 0..30 at z 20), extruded 30: its top meets a slope.
    await trapezoid(page);
    await settled(page);
    await expectVolume(frame, page, NATIVE.trap.in.volume, 1e-12);
    const top = (await faces(page)).filter((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99);
    expect(top).toHaveLength(1);
    await clickFace(page, top[0].i);
    await page.keyboard.press('q');
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await typeDistance(page, frame, '5');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    // The slope runs on up to z 25: (40 * 25 - 0.25 * 25^2) * 30, natively the same; the prism-and-fuse
    // of before would have left a 5 mm step (its native volume is another).
    await expectVolume(frame, page, NATIVE.trap.offset_plus_5.volume, 1e-12);
    expect(NATIVE.trap.offset_plus_5.volume).toBeCloseTo((40 * 25 - 0.25 * 625) * 30, 6);
    expect(NATIVE.trap.prism_plus_5.volume).not.toBeCloseTo(NATIVE.trap.offset_plus_5.volume, 0);
    expect((await faces(page)).length).toBe(NATIVE.trap.offset_plus_5.faces);
    await expect(lines(frame)).toHaveText(['Flat face moves 5 mm out of the body']);
    await expect(panel(frame).locator('[data-press-note]')).toHaveCount(0);
    await typeDistance(page, frame, '-5');
    await expectVolume(frame, page, NATIVE.trap.offset_minus_5.volume, 1e-12);
    await expect(lines(frame)).toHaveText(['Flat face moves 5 mm into the body']);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test("cad:p5-pp-step the synthetic flange STEP: one hole's bore pulled in 1 mm, r 5 -> 6 (the volume, the words)", async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await importStep(page, frame, FLANGE);
    const fs = await faces(page);
    const holes = fs.filter((f) => f.type === 'cylinder');
    expect(holes).toHaveLength(4);
    let hole: TopoFace | null = null;
    for (const h of holes) if (await tryPointOn(page, h.i)) {
      hole = h;
      break;
    }
    expect(hole, 'a hole the view shows').not.toBeNull();
    await clickFace(page, hole!.i);
    await page.keyboard.press('q');
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await typeDistance(page, frame, '-1');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, REF.flange.import.volume - Math.PI * (36 - 25) * 10, 1e-9);
    await expect(lines(frame)).toHaveText(['Bore radius 5 mm → 6 mm']);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test("cad:p5-pp-vortex (needs CAD_E2E_VORTEX_STEP) the Vortex's torus fillet re-rounded at 13.7 mm (native volume, words); its inlet pipe, tangent to B-spline faces, is refused in words (fix round 1: no thickened step)", async ({ page, request }) => {
    test.skip(!VORTEX, "CAD_E2E_VORTEX_STEP is not set: the Vortex case needs Daniel's STEP file");
    expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP names no file: ${VORTEX}`).toBe(true);
    test.setTimeout(480_000);
    const { seen, frame } = await freshPart(page, request);
    await importStep(page, frame, VORTEX);
    const fs = await faces(page);
    await expectVolume(frame, page, NATIVE.vortex.in.volume, 1e-9);
    const inlet = fs.filter((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 25.4) < 1e-6).sort((a, b) => b.area - a.area)[0];
    const torus = fs.find((f) => f.type === 'torus')!;
    await runCommand(frame, 'view.iso');
    await settled(page);
    // The torus fillet: rounded again at 13.7 mm.
    await clickFace(page, torus.i);
    await page.keyboard.press('q');
    await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
    await typeDistance(page, frame, '1');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok', { timeout: 120_000 });
    await expectVolume(frame, page, NATIVE.vortex.torus_refillet_plus_1.volume, 1e-9);
    await expect(lines(frame)).toHaveText(['Fillet radius 12.7 mm → 13.7 mm']);
    await expect(panel(frame).locator('[data-press-note]')).toHaveCount(0);
    await panel(frame).locator('[data-panel-done]').click();
    await page.keyboard.press('Control+z');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveCount(0);
    await settled(page);
    await expectVolume(frame, page, NATIVE.vortex.in.volume, 1e-9);
    // The inlet pipe: its offset is refused by OCCT, and moving it alone would leave a step where it
    // meets the B-spline faces it is tangent to: red, in words, the part as it was.
    await clickFace(page, inlet.i);
    await page.keyboard.press('q');
    await typeDistance(page, frame, '1');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error', { timeout: 120_000 });
    await expect(foot(frame)).toHaveText(/^Press-pull 1 failed: the face could not be moved cleanly by 1 mm \(a face next to it is not square to it, so moving it alone would leave a step \(.+\)\)\. No smaller distance works either$/);
    await expect(foot(frame)).not.toContainText('BRepCheck');
    await expectVolume(frame, page, NATIVE.vortex.in.volume, 1e-9);
    await panel(frame).locator('[data-panel-delete]').click();
    expect(seen.errors).toEqual([]);
  });

  test("cad:p5-fix1-vortex-outlets (needs CAD_E2E_VORTEX_STEP) review B4: the outlet cylinders (UI Faces 12 and 17), reached in the section view, opened and closed by 1 and 2 mm: the native volumes", async ({ page, request }) => {
    test.skip(!VORTEX, "CAD_E2E_VORTEX_STEP is not set: the Vortex case needs Daniel's STEP file");
    expect(existsSync(VORTEX), `CAD_E2E_VORTEX_STEP names no file: ${VORTEX}`).toBe(true);
    test.setTimeout(600_000);
    const { seen, frame } = await freshPart(page, request);
    await importStep(page, frame, VORTEX);
    const fs = await faces(page);
    const o25 = fs.filter((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 25.4) < 1e-6).sort((a, b) => a.area - b.area)[0];
    const o30 = fs.find((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 30.1752) < 1e-6)!;
    expect(o25.area).toBeCloseTo(FIX1.vortex.outlet_25_area, 6);
    // No standard view shows them (the reviewer tried all seven): the section view on Front, cut at
    // y 0 through their axis, shows them from inside.
    await frame.locator('[data-vp-opens="section"]').click();
    await expect(frame.locator('[data-vp-pop="section"]')).toBeVisible();
    await expect(frame.locator('[data-section-value]')).toHaveText('Y 0 mm');
    await settled(page);
    let seenBoth = !!(await tryPointOn(page, o25.i)) && !!(await tryPointOn(page, o30.i));
    if (!seenBoth) {
      await frame.locator('[data-section-flip]').click();
      await settled(page);
      seenBoth = !!(await tryPointOn(page, o25.i)) && !!(await tryPointOn(page, o30.i));
    }
    expect(seenBoth, 'both outlet cylinders in the section view').toBe(true);
    await page.keyboard.press('Escape');
    for (const [face, name, ui, r] of [
      [o25, 'outlet_25', 12, 25.4],
      [o30, 'outlet_30', 17, 30.1752],
    ] as [TopoFace, string, number, number][]) {
      const label = (x: number) => `${x.toFixed(4).replace(/\.?0+$/, '')} mm`;
      const role = name === 'outlet_25' ? 'Cylinder radius' : 'Bore radius';
      for (const [d, key] of [
        [-1, 'minus_1'],
        [-2, 'minus_2'],
        [1, 'plus_1'],
      ] as [number, string][]) {
        await clickFace(page, face.i);
        await page.keyboard.press('q');
        await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
        await typeDistance(page, frame, String(d));
        await expect(featureRowNamed(frame, 'Press-pull 1'), `UI Face ${ui} at ${d}`).toHaveAttribute('data-state', 'ok', { timeout: 120_000 });
        await expectVolume(frame, page, FIX1.vortex[`${name}_ring_${key}`].volume, 1e-9);
        // Out adds material: the convex outlet pipe grows, the bore around it closes in.
        const after = role === 'Cylinder radius' ? r + d : r - d;
        await expect(lines(frame)).toHaveText([`${role} ${label(r)} → ${label(after)}`]);
        await panel(frame).locator('[data-panel-done]').click();
        await expect(panel(frame)).toHaveCount(0);
        await page.keyboard.press('Control+z');
        await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveCount(0);
        await settled(page);
      }
    }
    expect(seen.errors).toEqual([]);
  });
});

/** The body's size as the SIZE chip shows it (mm), waited for to be `want`. */
async function expectSize(frame: FrameLocator, want: number[], tol = 1e-6) {
  await expect
    .poll(
      async () => {
        const raw = (await frame.locator('[data-chip="size"] [data-size-mm]').getAttribute('data-size-mm').catch(() => null)) ?? '';
        const got = raw.split(',').map(Number);
        return got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) < tol) ? 'ok' : raw;
      },
      { timeout: 30_000 },
    )
    .toBe('ok');
}

/** A Fillet or Chamfer of the edges at these model points, through its panel. */
async function roundEdges(page: Page, frame: FrameLocator, kind: 'fillet' | 'chamfer', points: V3[], size: number) {
  await runCommand(frame, `modify.${kind}`);
  await expect(panel(frame).locator(`[data-feature-panel="${kind}"]`)).toBeVisible();
  for (const [i, p] of points.entries()) {
    await clickAt(page, p);
    await expect(panel(frame).locator('[data-pick-field="edges"] [data-pick-row]')).toHaveCount(i + 1);
  }
  const input = panel(frame).locator(`.nui[data-field="${kind === 'fillet' ? 'radius' : 'distance'}"] input`);
  await input.fill(String(size));
  await input.press('Enter');
  await settled(page);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
}

/** The top face of the first body (its outward normal +Z, the highest). */
async function topFace(page: Page): Promise<number> {
  const fs = (await faces(page)).filter((f) => f.type === 'plane' && f.normal && f.normal[2] > 0.99).sort((a, b) => (b.centroid?.[2] ?? 0) - (a.centroid?.[2] ?? 0));
  return fs[0].i;
}

test.describe('Press-pull fix round 1', () => {
  test('cad:p5-fix1-b1-fillet-minus40 review B1: a fillet face at -40 is red in words with what works, never a split body or an unchanged volume; the suggested distance works', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    await roundEdges(page, frame, 'fillet', [[0, 0, 10]], 5);
    const filleted = (r: number) => 40 * 30 * 20 - (1 - Math.PI / 4) * r * r * 20;
    await expectVolume(frame, page, filleted(5), 1e-12);
    const fillet = (await faces(page)).find((f) => f.type === 'cylinder')!;
    await clickFace(page, fillet.i);
    await page.keyboard.press('q');
    await typeDistance(page, frame, '-40');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
    await expect(foot(frame)).toHaveText(/^Press-pull 1 failed: the face could not be moved cleanly by -40 mm \(the fillet would not fit at that radius\)\. Up to -24(\.\d)? mm works$/);
    await expect(frame.locator('[data-chip="volume"] [data-volume-body]')).toHaveCount(1);
    await expectVolume(frame, page, filleted(5), 1e-12);
    const ok = /Up to (-[\d.]+) mm works/.exec((await foot(frame).textContent()) ?? '')![1];
    await typeDistance(page, frame, ok);
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, filleted(5 - Number(ok)), 1e-9);
    await expect(lines(frame)).toHaveText([`Fillet radius 5 mm → ${5 - Number(ok)} mm`]);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b1-bore-split review B1 and P4: the bore at -12 breaks the plate in two (amber, the radius line still shown); at -40 nothing would be left: red, and the distance it suggests works', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const bore = await plateWithHole(page);
    await clickFace(page, bore);
    await page.keyboard.press('q');
    await typeDistance(page, frame, '-12');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'warning');
    await expect(lines(frame)).toHaveText(['Bore radius 10 mm → 22 mm']);
    // The ring r 22 clipped by the plate's 40 mm width.
    const half = (x: number) => x * Math.sqrt(22 * 22 - x * x) + 22 * 22 * Math.asin(x / 22);
    await expect.poll(async () => (await chipVolumesSum(frame)) / (PLATE - 2 * half(20) * 10) - 1, { timeout: 30_000 }).toBeLessThan(1e-9);
    await typeDistance(page, frame, '-40');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
    await expect(foot(frame)).toHaveText(/^Press-pull 1 failed: the face could not be moved cleanly by -40 mm \(nothing would be left of the body\)\. Up to -\d+(\.\d)? mm works$/);
    const ok = /Up to (-[\d.]+) mm works/.exec((await foot(frame).textContent()) ?? '')![1];
    expect(Number(ok)).toBeLessThan(-12);
    await typeDistance(page, frame, ok);
    await expect(featureRowNamed(frame, 'Press-pull 1')).not.toHaveAttribute('data-state', 'error');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b2-fillet-top review B2: a block top with both long top edges rounded r 3, +5: the walls stay (40 x 30 x 25), the fillets stay r 3, and the panel says so', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    await roundEdges(page, frame, 'fillet', [[0, 15, 20], [40, 15, 20]], 3);
    const corner = (1 - Math.PI / 4) * 9 * 30;
    await expectVolume(frame, page, 24000 - 2 * corner, 1e-12);
    await clickFace(page, await topFace(page));
    await page.keyboard.press('q');
    await typeDistance(page, frame, '5');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 40 * 30 * 25 - 2 * corner, 1e-12);
    await expectSize(frame, [40, 30, 25]);
    await expect(lines(frame)).toHaveText(['Flat face moves 5 mm out of the body']);
    await expect(panel(frame).locator('[data-press-carried]')).toHaveText('Keeps the 2 fillets beside it at their size');
    await expect(panel(frame).locator('[data-press-tangent]')).toHaveCount(0);
    await panel(frame).locator('[data-panel-done]').click();
    const fillets = (await faces(page)).filter((f) => f.type === 'cylinder');
    expect(fillets.map((f) => Math.round((f.radius ?? 0) * 1e9) / 1e9)).toEqual([3, 3]);
    // Still Fillet 1's faces.
    await clickFace(page, fillets[0].i);
    await expect(frame.locator('[data-chip="pick"] [data-pick-info]')).toHaveText('Face · Fillet (Fillet 1)');
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b2-chamfer-top review B2: a block top beside a 4 mm chamfer, +5: the chamfer keeps its size and the top rises (29,760, as Fusion), the panel says so', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await addSolid(page, { size: [40, 30, 20] });
    await roundEdges(page, frame, 'chamfer', [[40, 15, 20]], 4);
    await expectVolume(frame, page, 24000 - 0.5 * 16 * 30, 1e-12);
    await clickFace(page, await topFace(page));
    await page.keyboard.press('q');
    await typeDistance(page, frame, '5');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, 40 * 30 * 25 - 0.5 * 16 * 30, 1e-12);
    await expectSize(frame, [40, 30, 25]);
    await expect(panel(frame).locator('[data-press-carried]')).toHaveText('Keeps the chamfer beside it at its size');
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b3-cone review B3: a cone over a cylinder of its radius, +1: the line says what holds ("Cone face moves 1 mm out…"), the volume is the cylinder run up to the offset cone; -8 is red (a step), with what works', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    const sketch = await cad<string>(page, (async () => {
      const s = (window as unknown as W).__CAD__.services;
      const handle = s.viewport.get().handle;
      const lookAt = handle?.lookAt;
      if (handle) handle.lookAt = () => {};
      let id: string;
      try {
        const sk = s.doc.beginNew('sketch', {
          support: { kind: 'plane', plane: 'origin:front' },
          plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
          points: { p1: [0, 0], p2: [20, 0], p3: [20, 10], p4: [10, 30], p5: [0, 30] },
          entities: [
            { id: 'e1', kind: 'line', p: ['p1', 'p2'] },
            { id: 'e2', kind: 'line', p: ['p2', 'p3'] },
            { id: 'e3', kind: 'line', p: ['p3', 'p4'] },
            { id: 'e4', kind: 'line', p: ['p4', 'p5'] },
            { id: 'e5', kind: 'line', p: ['p5', 'p1'] },
          ],
          constraints: [],
          solved: { values: {}, dof: 10, state: 'under' },
        });
        sk.commit();
        id = sk.feature;
      } finally {
        if (handle && lookAt) handle.lookAt = lookAt;
      }
      for (let k = 0; k < 400; k++) {
        const o = s.doc.state.get().rebuild.outputs[id];
        if (o && o.type === 'sketch' && o.regions?.length) return id;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the sketch made no profile');
    }) as never);
    await cad(page, ((sk: string) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      const region = doc.state.get().rebuild.outputs[sk].regions[0];
      doc.beginNew('revolve', { profiles: [{ sketch: sk, region: region.key, entities: region.entities, sample: region.sample }], axis: { kind: 'origin', axis: 'origin:z' } }).commit();
    }) as never, sketch);
    await settled(page);
    await expectVolume(frame, page, Math.PI * 400 * 10 + (Math.PI * 20 / 3) * (400 + 200 + 100), 1e-9);
    const cone = (await faces(page)).find((f) => f.type === 'cone')!;
    await clickFace(page, cone.i);
    await page.keyboard.press('q');
    await typeDistance(page, frame, '1');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expect(lines(frame)).toHaveText(['Cone face moves 1 mm out of the body, square to the face']);
    const k1 = 1 / Math.cos(Math.atan(0.5));
    const z = 10 + 2 * k1;
    const rTop = 10 + k1;
    await expectVolume(frame, page, Math.PI * 400 * z + (Math.PI * (30 - z) / 3) * (400 + 20 * rTop + rTop * rTop), 1e-9);
    // The size is still 40 across: the wide end stays r 20 (the old line said 20 → 21.118).
    await expectSize(frame, [40, 40, 30]);
    await typeDistance(page, frame, '-8');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
    await expect(foot(frame)).toHaveText(/^Press-pull 1 failed: the face could not be moved cleanly by -8 mm \(a face next to it is not square to it, so moving it alone would leave a step \(.+\)\)\. Up to -4\.4 mm works$/);
    await panel(frame).locator('[data-panel-delete]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b4-stepped-step review B4 without the Vortex: the stepped-bore STEP; its counterbore r 15 opened 2 mm into its 1 mm side wall (OCCT\'s offset gives no shape: the cylinder method) and its bore r 10 opened 2 mm: native volumes, words', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await importStep(page, frame, STEPPED);
    await expectVolume(frame, page, FIX1.stepped.in.volume, 1e-9);
    const fs = await faces(page);
    const b15 = fs.find((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 15) < 1e-6)!;
    const b10 = fs.find((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 10) < 1e-6)!;
    for (const [face, d, volume, line] of [
      [b15, -2, FIX1.stepped.bore15_ring_minus_2.volume, 'Bore radius 15 mm → 17 mm'],
      [b15, 1, FIX1.stepped.bore15_offset_plus_1.volume, 'Bore radius 15 mm → 14 mm'],
      [b10, -2, FIX1.stepped.bore10_offset_minus_2.volume, 'Bore radius 10 mm → 12 mm'],
    ] as [TopoFace, number, number, string][]) {
      await clickFaceInAView(page, frame, face.i);
      await page.keyboard.press('q');
      await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(1);
      await typeDistance(page, frame, String(d));
      await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
      await expectVolume(frame, page, volume, 1e-9);
      await expect(lines(frame)).toHaveText([line]);
      await panel(frame).locator('[data-panel-done]').click();
      await expect(panel(frame)).toHaveCount(0);
      await page.keyboard.press('Control+z');
      await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveCount(0);
      await settled(page);
    }
    expect(seen.errors).toEqual([]);
  });

  test("cad:p5-fix1-p2-p3-p5 review P2, P3 and P5: a boss pushed out past its plate has no false step note; a sloped top pushed down its whole height is red in plain words (OCCT's own in Details); a plain box top says 'Flat face moves'", async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    // P5: a box top +5.
    await addSolid(page, { size: [20, 20, 20] });
    await clickFace(page, await topFace(page));
    await page.keyboard.press('q');
    await typeDistance(page, frame, '5');
    await expect(lines(frame)).toHaveText(['Flat face moves 5 mm out of the body']);
    await expectVolume(frame, page, 20 * 20 * 25, 1e-12);
    await panel(frame).locator('[data-panel-delete]').click();
    await settled(page);
    // P2: a plate with a 20 mm boss, 15 high; its side +15 overhangs the 40 mm plate.
    const { seen: seen2, frame: f2 } = await freshPart(page, request);
    const plate = await addSolid(page, { size: [60, 40, 10] });
    await addSolid(page, { circle: true, at: [30, 20, 10], size: [20, 15], op: 'join', scope: [plate.body!] });
    await settled(page);
    const side = (await faces(page)).find((f) => f.type === 'cylinder')!;
    await clickFace(page, side.i);
    await page.keyboard.press('q');
    await typeDistance(page, f2, '15');
    await expect(featureRowNamed(f2, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(f2, page, PLATE + Math.PI * 625 * 15, 1e-12);
    await expect(lines(f2)).toHaveText(['Cylinder radius 10 mm → 25 mm']);
    await expect(panel(f2).locator('[data-press-note]')).toHaveCount(0);
    await panel(f2).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
    expect(seen2.errors).toEqual([]);
  });

  test('cad:p5-fix1-p3-slope review P3: a sloped top pushed down its whole height (-20) is red in plain words, OCCT\'s own words only under Details, and what it suggests works', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await trapezoid(page);
    await expectVolume(frame, page, NATIVE.trap.in.volume, 1e-12);
    await clickFace(page, await topFace(page));
    await page.keyboard.press('q');
    await typeDistance(page, frame, '-20');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'error');
    await expect(foot(frame)).toHaveText(/^Press-pull 1 failed: the face could not be moved cleanly by -20 mm \(the result would not be a valid solid\)\. Up to -19 mm works$/);
    await expect(foot(frame)).not.toContainText('BRepCheck');
    const details = panel(frame).locator('[data-press-detail]');
    await expect(details).toContainText('BRepCheck');
    await expectVolume(frame, page, NATIVE.trap.in.volume, 1e-12);
    await typeDistance(page, frame, '-19');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, (40 * 1 - 0.25 * 1) * 30, 1e-9);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-p6-imperial review P6: in an Imperial project the bore\'s default 0.5 in is red with a suggestion rounded in inches ("0.39 in or less works"), which works', async ({ page, request }) => {
    const seen = await watchPage(page);
    await ensureCadOn(request);
    const r = await request.post(`${baseUrl()}/api/project`, { data: { title: `CAD e2e ${Date.now()}`, category: 'Other', units: 'Imperial' } });
    expect(r.ok(), await r.text()).toBe(true);
    await openProject(page, String((await r.json()).id));
    await newPartFromTree(page, 'Part 1');
    const frame = await partOpened(page);
    await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
    const bore = await plateWithHole(page);
    await clickFace(page, bore);
    await page.keyboard.press('q');
    await settled(page);
    await expect(foot(frame)).toHaveText('Press-pull 1 failed: the hole would close: 0.39 in or less works');
    await typeDistance(page, frame, '0.39');
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    await expectVolume(frame, page, PLATE - holeVolume(10 - 0.39 * 25.4), 1e-9);
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });

  test('cad:p5-fix1-b2-legacy review B2: a Press-pull made before version 2 (no version: as the f54f8b7 build saved it) keeps the prism and its step, and its panel says why', async ({ page, request }) => {
    const { seen, frame } = await freshPart(page, request);
    await trapezoid(page);
    const top = await topFace(page);
    // As a document saved before keeps it: no `version`.
    const made = await cad<string>(page, (async (face: number) => {
      const s = (window as unknown as W).__CAD__.services;
      const b = s.doc.state.get().rebuild.bodies[0];
      const name = b.names.faces[face];
      const t = (await s.kernel.call('topo', { id: b.shape, faces: [face], edges: 'none', vertices: 'none' })).result.faces[0];
      const ses = s.doc.beginNew('press_pull', { body: b.id, faces: [{ name, signature: { kind: 'face', type: 'plane', size: t.area, at: t.centroid, dir: t.normal, radius: null } }], distance: '5 mm', version: undefined });
      ses.commit();
      return ses.feature;
    }) as never, top);
    await settled(page);
    await expect(featureRowNamed(frame, 'Press-pull 1')).toHaveAttribute('data-state', 'ok');
    // The prism of the 30 mm top: 21,000 + 30 x 30 x 5 (a new Press-pull extends the slope: 25,312.5).
    await expectVolume(frame, page, 21000 + 30 * 30 * 5, 1e-12);
    expect(NATIVE.trap.prism_plus_5.volume).toBeCloseTo(25500, 6);
    await featureRowNamed(frame, 'Press-pull 1').locator('> .tree-row').dblclick();
    await expect(panel(frame).locator('[data-press-legacy]')).toContainText('Made before press-pull took curved faces');
    expect(made).toBeTruthy();
    await panel(frame).locator('[data-panel-done]').click();
    expect(seen.errors).toEqual([]);
  });
});
