// P3-PROFILES drafts (docs/p2p3-plan.md §5.2 items 6-10, §5.3): profile regions
// shaded in the view, picked with the mouse, extruded from the toolbar, the
// distance dragged with the arrow, the same region kept through a dimension
// change and "Profile lost" after a trim, open-profile markers and their chip,
// the sketch row's eye, Daniel's plate flow (with a cut from a sketch on its
// top face) and the Vortex bin in an inch Part.
// Setup only: sketch mode (P3-SKETCH) draws the sketches with its tools in the
// phase gate; these drafts put a sketch in through the document
// (window.__CAD__), and change or trim it the same way. Everything asserted is
// what the user sees: shaded pixels, the tree, the panel, the chips. Needs the
// kernel's API 3 profile ops (sketch_regions, extrude_regions): the shipped
// workspace/kernel once it has them; until then CAD_E2E_KERNEL_DIR=<folder with
// mk32.mjs + mk32.wasm> serves that build to the frame instead (routed by the
// test; nothing on disk changes).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { baseUrl, ensureCadOn, newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';
import { PNG } from './png';

type V3 = [number, number, number];
type RGB = [number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };
type Loc = ReturnType<FrameLocator['locator']>;

/** Profile shading: --mg-primary #1570ef at 12% (proposal §3.3); picked: the pick green at 40%. */
const REGION: RGB = [0x15, 0x70, 0xef];
const PICK: RGB = [0x2e, 0xc4, 0x7e];
const blend = (src: RGB, a: number, dst: RGB): RGB => src.map((v, i) => Math.round(v * a + dst[i] * (1 - a))) as RGB;
const near = (a: RGB, b: RGB, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const KERNEL_DIR = process.env.CAD_E2E_KERNEL_DIR;
test.beforeEach(async ({ context }) => {
  if (!KERNEL_DIR) return;
  for (const f of ['mk32.mjs', 'mk32.wasm']) {
    await context.route(`**/plugins/cad/workspace/kernel/${f}`, (route) => route.fulfill({ path: join(KERNEL_DIR, f), contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }));
  }
});

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

async function freshPart(page: Page, request: APIRequestContext, units: 'Metric' | 'Imperial' = 'Metric') {
  const seen = await watchPage(page);
  let projectId: string;
  if (units === 'Metric') projectId = await newProject(request);
  else {
    await ensureCadOn(request);
    const r = await request.post(`${baseUrl()}/api/project`, { data: { title: `CAD e2e ${Date.now()}`, category: 'Other', units } });
    projectId = String((await r.json()).id);
  }
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame };
}

/** Put a sketch in through the document (setup; sketch mode draws it in the phase gate). Returns its id. */
async function addSketch(page: Page, init: Record<string, unknown>): Promise<string> {
  return workspaceFrame(page).evaluate((i) => {
    const doc = (window as unknown as W).__CAD__.services.doc;
    const s = doc.beginNew('sketch', i);
    s.commit();
    return s.feature as string;
  }, init);
}

/** Change a sketch through the document (setup), one undo step. */
async function editSketch(page: Page, id: string, patch: Record<string, unknown>) {
  await workspaceFrame(page).evaluate(
    ([fid, p]) => {
      const doc = (window as unknown as W).__CAD__.services.doc;
      const s = doc.beginEdit(fid);
      s.update(p);
      s.commit();
    },
    [id, patch] as const,
  );
}

/** A built sketch's regions (keys, areas, inside points), once the rebuild published them. */
async function regionsOf(page: Page, id: string, count: number): Promise<{ key: string; area: number; sample: [number, number] }[]> {
  let out: { key: string; area: number; sample: [number, number] }[] = [];
  await expect
    .poll(async () => {
      out = await workspaceFrame(page).evaluate((fid) => {
        const o = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[fid];
        return o && o.type === 'sketch' ? o.regions.map((r: { key: string; area: number; sample: [number, number] }) => ({ key: r.key, area: r.area, sample: r.sample })) : [];
      }, id);
      return out.length;
    })
    .toBe(count);
  return out;
}

/** Page point of a model point, through the viewport's own projection. */
async function at(page: Page, p: V3): Promise<[number, number]> {
  const s = await workspaceFrame(page).evaluate((q) => (window as unknown as W).__CAD__.services.viewport.get().handle.project(q) as [number, number] | null, p);
  expect(s, `projection of ${p}`).not.toBeNull();
  const box = (await page.locator('#workspace-frame').boundingBox())!;
  return [box.x + s![0], box.y + s![1]];
}

async function pixel(page: Page, pt: [number, number]): Promise<RGB> {
  return PNG.center(await page.screenshot({ clip: { x: Math.round(pt[0]) - 2, y: Math.round(pt[1]) - 2, width: 5, height: 5 } }));
}

/** The shading at a point is the region colour over what is there without it (`under`, read at a point outside every region). */
async function expectShaded(page: Page, pt: [number, number], under: RGB, color: RGB, opacity: number, message: string) {
  const want = blend(color, opacity, under);
  await expect.poll(async () => {
    const got = await pixel(page, pt);
    return near(got, want) ? 'ok' : `${got} (want ${want})`;
  }, { message, timeout: 10_000 }).toBe('ok');
}

async function topView(frame: FrameLocator) {
  await frame.locator('[data-command="view.top"]').click();
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating)).toBe(false);
}

const sketchRow = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-feature-type="sketch"]');
const extrudeRow = (frame: FrameLocator) => frame.locator('[data-cad-tree] [data-feature-type="extrude"]');
const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"] [data-volume-mm3]');
const profileList = (frame: FrameLocator) => panel(frame).locator('[data-profile-list] [data-profile]');

async function setField(p: Loc, field: string, value: string) {
  const input = p.locator(`.nui[data-field="${field}"] input`);
  await input.fill(value);
  await input.press('Enter');
  await expect(p.locator(`.nui[data-field="${field}"] [data-nui-error]`)).toHaveCount(0);
}

/** The volume the chip reads (its exact mm³ attribute), within 1e-6 relative. */
async function expectVolume(frame: FrameLocator, mm3: number) {
  await expect.poll(async () => Number(await volumeChip(frame).getAttribute('data-volume-mm3')), { timeout: 30_000 }).toBeCloseTo(mm3, Math.max(0, 6 - Math.ceil(Math.log10(mm3))));
}

function lensArea(r1: number, r2: number, d: number): number {
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  return a + b - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
}

const circles = (r2: number) => ({
  points: { pt_1: [0, 0], pt_2: [30, 0] },
  entities: [
    { id: 'e_c1', kind: 'circle', c: 'pt_1', r: 20 },
    { id: 'e_c2', kind: 'circle', c: 'pt_2', r: r2 },
  ],
  solved: { values: {}, dof: 6, state: 'under' },
});

test('cad:p3-profiles-lens two overlapping circles shade 3 regions; the lens picked in the view extrudes to its area x 10, keeps its key through a radius change, and a trim makes it "Profile lost"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const sk = await addSketch(page, circles(20));
  await expect(sketchRow(frame).locator('> .tree-row .tl')).toHaveText('(-) Sketch 1');
  await topView(frame);
  const regions = await regionsOf(page, sk, 3);
  // The three regions (left crescent, lens, right crescent) are shaded once (12%); a point outside both
  // circles is not. Points off the Top plane's axis lines (the kernel's inside points lie near y = 0).
  const outside = await pixel(page, await at(page, [-15, 25, 0]));
  for (const p of [
    [-10, 10],
    [15, 5],
    [40, 10],
  ] as const) await expectShaded(page, await at(page, [p[0], p[1], 0]), outside, REGION, 0.12, `region at ${p} shaded`);
  await shot(page, 'p3p-lens-regions');

  // Click the lens in the view: it is picked (green); Extrude opens with it.
  const lens = regions.find((r) => r.sample[0] > 10 && r.sample[0] < 20)!;
  expect(lens.area).toBeCloseTo(lensArea(20, 20, 30), 6);
  const lensPt = await at(page, [15, 5, 0]);
  await page.mouse.click(lensPt[0], lensPt[1]);
  await expectShaded(page, lensPt, outside, PICK, 0.4, 'the picked lens is green');
  await frame.locator('[data-command="solid.extrude"]').click();
  await expect(panel(frame).locator('.mgk-panel-title, [data-panel-title]').first()).toHaveText('Extrude 1');
  await expect(profileList(frame)).toHaveText([/^Profile 1.*181\.325 mm²/]);
  await expect(panel(frame).locator('.nui[data-field="distance"] input')).toHaveValue('10');
  await expectVolume(frame, lensArea(20, 20, 30) * 10);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'ok');
  await shot(page, 'p3p-lens-extruded');

  // Radius 20 -> 25 (sketch mode's dimension edit in the gate): the extrude still uses the lens, green, and follows it.
  await editSketch(page, sk, circles(25));
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'ok');
  await expectVolume(frame, lensArea(20, 25, 30) * 10);

  // Trim c_2 to its arc outside c_1: the lens is gone, the extrude is red "Profile lost".
  const x = (20 * 20 - 25 * 25 + 30 * 30) / (2 * 30);
  const y = Math.sqrt(400 - x * x);
  const onC2 = (deg: number) => [30 + 25 * Math.cos((deg * Math.PI) / 180), 25 * Math.sin((deg * Math.PI) / 180)];
  const a0 = (Math.atan2(-y, x - 30) * 180) / Math.PI;
  const a1 = (Math.atan2(y, x - 30) * 180) / Math.PI;
  await editSketch(page, sk, {
    points: { pt_1: [0, 0], pt_2: [30, 0], pt_3: onC2(a0), pt_4: onC2(a1) },
    entities: [
      { id: 'e_c1', kind: 'circle', c: 'pt_1', r: 20 },
      { id: 'e_c2', kind: 'arc', c: 'pt_2', a: 'pt_3', b: 'pt_4' },
    ],
  });
  await expect(extrudeRow(frame)).toHaveAttribute('data-state', 'error');
  await expect(extrudeRow(frame).locator('[data-feature-badge="error"]')).toHaveAttribute('aria-label', "What's wrong: Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone");
  await extrudeRow(frame).locator('> .tree-row').dblclick();
  await expect(profileList(frame)).toHaveText([/^Profile 1\s*lost/]);
  await expect(panel(frame).locator('[data-run-reason] .mgk-reason-msg')).toHaveText('Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone');
  await shot(page, 'p3p-lens-profile-lost');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-profiles-open-ends an open L of two lines shows a marker at each open end and "Open profile: 2 open ends"', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addSketch(page, {
    points: { pt_a: [0, 0], pt_b: [40, 0], pt_c: [40, 20] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    ],
    solved: { values: {}, dof: 6, state: 'under' },
  });
  await topView(frame);
  const markers = frame.locator('[data-open-end]');
  await expect(markers).toHaveCount(2);
  // Each marker sits on its open end.
  for (const [i, p] of [
    [0, [0, 0, 0]],
    [1, [40, 20, 0]],
  ] as const) {
    const box = (await markers.nth(i).boundingBox())!;
    const want = await at(page, p as V3);
    const centre: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];
    expect(Math.hypot(centre[0] - want[0], centre[1] - want[1]), `marker ${i}`).toBeLessThan(4);
  }
  // No profile: Extrude says why. The chip speaks for the selected sketch.
  await expect(frame.locator('[data-command="solid.extrude"]')).toHaveAttribute('data-disabled-reason', 'Draw a closed profile in a sketch first');
  await expect(frame.locator('[data-chip="open-profile"]')).toHaveCount(0);
  await sketchRow(frame).locator('> .tree-row').click();
  await expect(frame.locator('[data-chip="open-profile"]')).toHaveText('Open profile: 2 open ends');
  await shot(page, 'p3p-open-ends');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-profiles-arrow dragging the extrude arrow changes the distance live; the eye hides and shows the sketch', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const sk = await addSketch(page, {
    points: { pt_b: [40, 0], pt_c: [40, 20], pt_d: [0, 20] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
      { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
    ],
    solved: { values: {}, dof: 5, state: 'under' },
  });
  const [rect] = await regionsOf(page, sk, 1);
  // Nothing selected and one profile there: Extrude takes it.
  await frame.locator('[data-command="solid.extrude"]').click();
  await expect(profileList(frame)).toHaveText([/^Profile 1.*800 mm²/]);
  await expectVolume(frame, 8000);
  await frame.locator('[data-command="view.front"]').click();
  await expect.poll(() => frame.locator('[data-cad-app]').evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.state.get().animating)).toBe(false);
  // The arrow starts on the end cap above the profile's inside point and points up the screen.
  const px = await workspaceFrame(page).evaluate((p) => (window as unknown as W).__CAD__.services.viewport.get().handle.pixelSize(p) as number, [rect.sample[0], rect.sample[1], 10]);
  const grab = await at(page, [rect.sample[0], rect.sample[1], 10 + 25 * px]);
  await page.mouse.move(grab[0], grab[1]);
  await page.mouse.down();
  await page.mouse.move(grab[0], grab[1] - 20, { steps: 4 });
  await page.mouse.move(grab[0], grab[1] - 40, { steps: 4 });
  await expect(frame.locator('[data-extrude-value]')).toBeVisible();
  await page.mouse.up();
  const want = 10 + 40 * px;
  const shown = Number(await panel(frame).locator('.nui[data-field="distance"] input').inputValue());
  expect(Math.abs(shown - want)).toBeLessThan(Math.max(px, 0.01) * 1.5);
  await expectVolume(frame, 800 * shown);
  await shot(page, 'p3p-arrow-dragged');
  await panel(frame).locator('[data-panel-done]').click();

  // The extrude uses the sketch: hidden by default; the eye shows it.
  await expect(sketchRow(frame)).toHaveAttribute('data-sketch-shown', '0');
  const eye = sketchRow(frame).locator('[data-sketch-act="visibility"]');
  await expect(eye).toHaveAttribute('aria-label', 'Show Sketch 1');
  await eye.click();
  await expect(sketchRow(frame)).toHaveAttribute('data-sketch-shown', '1');
  await expect(eye).toHaveAttribute('aria-label', 'Hide Sketch 1');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-profiles-plate the plate flow: 100 x 60 with a d 20 hole, extruded 10 mm, then a d 10 hole cut from a sketch on its top face', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  const sk = await addSketch(page, {
    points: { pt_a: [0, 0], pt_b: [100, 0], pt_c: [100, 60], pt_d: [0, 60], pt_o: [50, 30] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['pt_a', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
      { id: 'e_4', kind: 'line', p: ['pt_d', 'pt_a'] },
      { id: 'e_5', kind: 'circle', c: 'pt_o', r: 10 },
    ],
    solved: { values: {}, dof: 11, state: 'under' },
  });
  await topView(frame);
  const regions = await regionsOf(page, sk, 2);
  const plate = regions.reduce((a, b) => (a.area > b.area ? a : b));
  const p = await at(page, [plate.sample[0], plate.sample[1], 0]);
  await page.mouse.click(p[0], p[1]);
  await frame.locator('[data-command="solid.extrude"]').click();
  await expectVolume(frame, (6000 - 100 * Math.PI) * 10);
  await expect(frame.locator('[data-chip="volume"]')).toContainText('56,858.4 mm³');
  await panel(frame).locator('[data-panel-done]').click();
  // A sketch on the top face (sketch mode's "Sketch" on a picked face in the gate): its end cap, by name.
  const body = await workspaceFrame(page).evaluate(() => {
    const b = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0];
    return { id: b.id as string, names: b.names.faces as string[] };
  });
  expect(body.names).toContain(`F:${await extrudeRow(frame).getAttribute('data-tree-node')}:end`);
  const endName = body.names.find((n) => /:end$/.test(n))!;
  const sk2 = await addSketch(page, {
    support: { kind: 'face', body: body.id, face: { name: endName, signature: { kind: 'face', type: 'plane', at: [50, 30, 10], dir: [0, 0, 1] } } },
    points: { pt_h: [20, 20] },
    entities: [{ id: 'e_h', kind: 'circle', c: 'pt_h', r: 5 }],
    solved: { values: {}, dof: 3, state: 'under' },
  });
  const [hole] = await regionsOf(page, sk2, 1);
  const h = await at(page, [hole.sample[0], hole.sample[1], 10]);
  await page.mouse.click(h[0], h[1]);
  await frame.locator('[data-command="solid.extrude"]').click();
  await panel(frame).locator('[data-field="op"] select').selectOption('cut');
  await panel(frame).locator('input[data-field="flip"]').check();
  await expectVolume(frame, (6000 - 100 * Math.PI) * 10 - 250 * Math.PI);
  await panel(frame).locator('[data-panel-done]').click();
  await expect(extrudeRow(frame)).toHaveCount(2);
  await expect(extrudeRow(frame).nth(1)).toHaveAttribute('data-state', 'ok');
  await shot(page, 'p3p-plate');
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('cad:p3-profiles-vortex-bin the Vortex bin in an inch Part: a d 12 in circle extruded -20 in reads 2261.95 in³', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request, 'Imperial');
  const sk = await addSketch(page, { points: {}, entities: [{ id: 'e_c', kind: 'circle', c: 'origin', r: 152.4 }], solved: { values: {}, dof: 1, state: 'under' } });
  await regionsOf(page, sk, 1);
  await frame.locator('[data-command="solid.extrude"]').click();
  await setField(panel(frame), 'distance', '-20');
  await expect(frame.locator('[data-chip="volume"]')).toContainText('2261.95 in³');
  await expectVolume(frame, Math.PI * 36 * 20 * 25.4 ** 3);
  await panel(frame).locator('[data-panel-done]').click();
  expect(seen.csp).toEqual([]);
  expect(seen.errors).toEqual([]);
});
