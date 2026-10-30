// Delete faces never shows a heal past the gap as a success (2026-10-30): a part's every face's
// edges rounded R2 by Fillet 1, then the blends selected, Delete faces, "Delete faces and heal".
//  1. heal-fill   an L-block (Extrude 60 x 40 x 20, Extrude Cut 30 x 40 x 10 off one end): OCCT's
//                 heal filled the step and the app showed Delete faces 1 ok with the volume chip
//                 at 48,000 mm³ (the full box). Now the heal is tried again in two goes: Delete
//                 faces 1 is ok and the chip shows the sharp L-block's 36,000 mm³, its 8 faces.
//  2. heal-refuse a T-block (a bar 60 x 40 x 10 on a stem 20 x 40 x 10), which two goes cannot
//                 make right: Delete faces 1 is red and says what the heal would have done, that
//                 the body is unchanged and that deleting Fillet 1 takes the fillet off; the chip
//                 keeps Fillet 1's volume. Done keeps the red row.
// Review 2026-10-30:
//  3. heal-boss   a plate with a boss joined on it, Fillet 1 of the boss's 4 vertical edges R2,
//                 Delete faces of the 4 rounds: ok, the chip at the sharp boss's 25,200 mm³ (it was
//                 red: "would add 20.6018 mm³ over faces you kept (End face of Extrude 1)", the
//                 corners' end caps on the plate read as a fill).
//  4. heal-loft   a ruled loft with a wavy top, Fillet 1 of the wavy face R1, Delete faces of the 4
//                 rounds: the check's boolean returned the whole body, so Delete faces 1 is a
//                 warning with "the kernel could not compare the result with the body before it:
//                 check the result" and the chip at the sharp loft's volume (it was red with the
//                 body's own 71,765.2 mm³ as "would add").
//  5. heal-large  a STEP part of over 2000 faces (the rounded L-block with a 2000-sided prism on it),
//                 its blends but one torus deleted: the heal fills the step, and the row is a
//                 warning, "this part is too large to compare the result with the body before it:
//                 check the result" (it was ok with no word).
//  6. pattern     a Linear pattern of the rounded L-block's blend faces (picked, then the
//                 command): red, "OCCT could not take those faces off Body 1 cleanly (healing
//                 filled more than the gap ...)", the chip as Fillet 1 left it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSolid, featureRowNamed, newPartFromTree, newProject, openProject, partOpened, runCommand, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any } };

async function shot(page: Page, name: string) {
  const dir = process.env.CAD_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
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

/** The rebuild is done and every feature has a state. */
async function settled(page: Page) {
  await expect
    .poll(() =>
      cad<boolean>(page, (() => {
        const st = (window as unknown as W).__CAD__.services.doc.state.get();
        return st.rebuild.status === 'done' && st.doc.features.every((f: { id: string }) => st.rebuild.features[f.id] && st.rebuild.features[f.id].state !== 'pending');
      }) as never),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const panel = (frame: FrameLocator) => frame.locator('[data-cad-panel="feature"]');
const volumeChip = (frame: FrameLocator) => frame.locator('[data-chip="volume"]');
const sizeChip = (frame: FrameLocator) => frame.locator('[data-chip="size"]');
const chipVolumes = (frame: FrameLocator) => volumeChip(frame).locator('[data-volume-mm3]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-volume-mm3'))));

/** The chip's one volume, read until it is `v` within `rel` (one body listed). */
async function expectOneVolume(frame: FrameLocator, v: number, rel = 1e-6) {
  await expect
    .poll(
      async () => {
        const vs = await chipVolumes(frame);
        return vs.length === 1 ? Math.abs(vs[0] / v - 1) : 1;
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(rel);
}

/** Select faces of the one body: all of them, or the ones not flat. */
async function selectFaces(page: Page, which: 'all' | 'round'): Promise<number> {
  return cad<number>(page, (async (w: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' })).result;
    const idx = t.faces.filter((f: { type: string }) => w === 'all' || f.type !== 'plane').map((f: { i: number }) => f.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'face', body: b.id, index })) }));
    return idx.length;
  }) as never, which);
}

/** Fillet 1 of every face (radius 2, through the panel), then the blends selected, Delete faces, "Delete faces and heal". */
async function roundThenDelete(page: Page, frame: FrameLocator, faces: number, blends: number | null): Promise<number> {
  expect(await selectFaces(page, 'all')).toBe(faces);
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill('2');
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  const filleted = (await chipVolumes(frame))[0];
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  const picked = await selectFaces(page, 'round');
  if (blends !== null) expect(picked).toBe(blends);
  else expect(picked).toBeGreaterThan(faces);
  await runCommand(frame, 'modify.delete-faces');
  const dlg = frame.locator('[data-cad-dialog]');
  await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
  await dlg.locator('[data-dialog-choice="faces"]').click();
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
  return filleted;
}

const bodyFaces = (page: Page) => cad<number>(page, (() => (window as unknown as W).__CAD__.services.doc.state.get().rebuild.bodies[0].faces) as never);
const sizeOf = async (frame: FrameLocator) => ((await sizeChip(frame).locator('[data-size-mm]').getAttribute('data-size-mm')) ?? '').split(',').map((v) => Math.round(Number(v) * 1e6) / 1e6);

test('cad:delete-faces-heal-fill Delete faces of every blend of a rounded L-block: ok, the chip shows the sharp L-block (36,000 mm³), not the box', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const block = await addSolid(page, { size: [60, 40, 20] });
  await addSolid(page, { at: [30, 0, 10], size: [30, 40, 10], op: 'cut', scope: [block.body!] });
  await settled(page);
  await expectOneVolume(frame, 36000);
  const filleted = await roundThenDelete(page, frame, 8, 30);
  expect(Math.abs(filleted / 35601.6258 - 1)).toBeLessThan(1e-6);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  // The sharp L-block (the heal in one go made the 60 x 40 x 20 box of 48,000 mm³).
  await expectOneVolume(frame, 36000);
  await expect(volumeChip(frame)).not.toContainText('48,000');
  await expect.poll(() => sizeOf(frame)).toEqual([60, 40, 20]);
  expect(await bodyFaces(page)).toBe(8);
  await shot(page, 'delete-faces-heal-fill');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expectOneVolume(frame, 36000);
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-refuse Delete faces of every blend of a rounded T-block: red with what the heal would do, the body and its chips unchanged', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const bar = await addSolid(page, { at: [0, 0, 10], size: [60, 40, 10] });
  await addSolid(page, { at: [20, 0, 0], size: [20, 40, 10], op: 'join', scope: [bar.body!] });
  await settled(page);
  await expectOneVolume(frame, 32000);
  const faces0 = await bodyFaces(page);
  const filleted = await roundThenDelete(page, frame, faces0, null);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'error');
  const reason = panel(frame).locator('[data-run-reason]').first();
  await expect(reason).toHaveText(
    /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d+ mm³ over faces you kept \([^)]*Extrude [12][^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead/,
    { timeout: 30_000 },
  );
  // The body is as Fillet 1 left it: not the 60 x 40 x 20 box of 48,000 mm³ the heal made.
  await expectOneVolume(frame, filleted);
  await expect(volumeChip(frame)).not.toContainText('48,000');
  await shot(page, 'delete-faces-heal-refuse');
  // Done: the row stays red, the body unchanged.
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});

/** Select the edges of the one body that `which` keeps (by their topo rows). */
async function selectEdges(page: Page, which: 'boss-vertical'): Promise<number> {
  return cad<number>(page, (async (w: string) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    const t = (await s.kernel.call('topo', { id: b.shape, faces: 'none', edges: 'all', vertices: 'none' })).result;
    const idx = t.edges.filter((e: { type: string; mid: number[] }) => w === 'boss-vertical' && e.type === 'line' && Math.abs(e.mid[2] - 13) < 1e-6).map((e: { i: number }) => e.i);
    s.selection.set((st: object) => ({ ...st, items: idx.map((index: number) => ({ kind: 'edge', body: b.id, index })) }));
    return idx.length;
  }) as never, which);
}

/** Select faces `idx` of the one body. */
async function selectFaceIndices(page: Page, idx: number[]) {
  await cad(page, ((a: number[]) => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    s.selection.set((st: object) => ({ ...st, items: a.map((index) => ({ kind: 'face', body: b.id, index })) }));
  }) as never, idx);
}

/** The one body's faces: type, area, bbox. */
const bodyTopo = (page: Page) =>
  cad<{ i: number; type: string; area: number; bbox: number[] }[]>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    const b = s.doc.state.get().rebuild.bodies[0];
    return (await s.kernel.call('topo', { id: b.shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'exact', face_mass: true })).result.faces;
  }) as never);

/** Fillet 1 of what is selected, radius `r` through the panel, ok; Done. Its chip volume. */
async function filletSelected(page: Page, frame: FrameLocator, r: string): Promise<number> {
  await runCommand(frame, 'modify.fillet');
  await expect(panel(frame).locator('[data-panel-title]')).toHaveText('Fillet 1');
  const radius = panel(frame).locator('.nui[data-field="radius"] input');
  await radius.fill(r);
  await radius.press('Enter');
  await settled(page);
  await expect(featureRowNamed(frame as never, 'Fillet 1')).toHaveAttribute('data-state', 'ok');
  const v = (await chipVolumes(frame))[0];
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  return v;
}

/** Delete faces of what is selected: the dialog's "Delete faces and heal" when it asks; the panel open, settled. */
async function deleteSelected(page: Page, frame: FrameLocator, ofFillet: boolean) {
  await runCommand(frame, 'modify.delete-faces');
  if (ofFillet) {
    const dlg = frame.locator('[data-cad-dialog]');
    await expect(dlg.locator('h2')).toHaveText('Delete faces of Fillet 1?');
    await dlg.locator('[data-dialog-choice="faces"]').click();
  }
  await expect(panel(frame).locator('[data-feature-panel="delete_faces"]')).toBeVisible();
  await settled(page);
}

test("cad:delete-faces-heal-boss Delete faces of a boss's 4 corner rounds on its plate: ok, the chip at the sharp boss (25,200 mm³), not red", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const plate = await addSolid(page, { size: [60, 40, 10] });
  await addSolid(page, { at: [20, 15, 10], size: [20, 10, 6], op: 'join', scope: [plate.body!] });
  await settled(page);
  await expectOneVolume(frame, 25200);
  expect(await selectEdges(page, 'boss-vertical')).toBe(4);
  const filleted = await filletSelected(page, frame, '2');
  expect(Math.abs(filleted / (25200 - 4 * (4 - Math.PI) * 6) - 1)).toBeLessThan(1e-9);
  expect(await selectFaces(page, 'round')).toBe(4);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'ok');
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  await expectOneVolume(frame, 25200);
  expect(await bodyFaces(page)).toBe(11);
  await shot(page, 'delete-faces-heal-boss');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'ok');
  expect(seen.errors).toEqual([]);
});

/** A feature made through the document (setup, as a panel commits it), the camera left as it is; its id once built. */
async function add(page: Page, type: string, init: Record<string, unknown>): Promise<string> {
  const id = await cad<string>(page, ((a: { type: string; init: Record<string, unknown> }) => {
    const s = (window as unknown as W).__CAD__.services;
    const handle = s.viewport.get().handle;
    const lookAt = handle?.lookAt;
    if (handle) handle.lookAt = () => {};
    try {
      const f = s.doc.beginNew(a.type, a.init);
      f.commit();
      return f.feature as string;
    } finally {
      if (handle && lookAt) handle.lookAt = lookAt;
    }
  }) as never, { type, init });
  await settled(page);
  return id;
}

/** A 60 x 30 outline whose top edge is a wavy control spline (14 poles, amplitude 4), at height z (on Top, or on the plane feature `on`). */
function wavySketch(z: number, on: string | null): Record<string, unknown> {
  const n = 14;
  const P: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    P.push([60 * (1 - t), 30 + 4 * Math.sin(3 * Math.PI * t) * Math.sin(Math.PI * t)]);
  }
  P[1] = [P[1][0], 30];
  P[n - 2] = [P[n - 2][0], 30];
  const points: Record<string, number[]> = { a: [0, 0], b: [60, 0] };
  P.forEach((p, i) => (points[`s${i}`] = p));
  return {
    support: on ? { kind: 'feature', feature: on } : { kind: 'plane', plane: 'origin:top' },
    plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] },
    points,
    entities: [
      { id: 'e1', kind: 'line', p: ['a', 'b'] },
      { id: 'e2', kind: 'line', p: ['b', 's0'] },
      { id: 'e3', kind: 'spline', form: 'control', pts: P.map((_, i) => `s${i}`), degree: 3 },
      { id: 'e4', kind: 'line', p: [`s${n - 1}`, 'a'] },
    ],
    constraints: [],
    solved: { values: {}, dof: 2 * (n + 2), state: 'under' },
  };
}

/** A built sketch's one region, as a Loft keeps it. */
const regionRef = (page: Page, sketch: string) =>
  cad<Record<string, unknown>>(page, ((id: string) => {
    const r = (window as unknown as W).__CAD__.services.doc.state.get().rebuild.outputs[id].regions[0];
    return { sketch: id, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  }) as never, sketch);

test('cad:delete-faces-heal-loft Delete faces of the rounds of a wavy loft whose check cannot compare: a warning to check the result, the chip at the sharp loft', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const up = await add(page, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '40 mm' });
  const s1 = await add(page, 'sketch', wavySketch(0, null));
  const s2 = await add(page, 'sketch', wavySketch(40, up));
  await add(page, 'loft', { sections: [await regionRef(page, s1), await regionRef(page, s2)], ruled: true, op: 'new' });
  await expect(featureRowNamed(frame as never, 'Loft 1')).toHaveAttribute('data-state', 'ok');
  await expect.poll(async () => (await chipVolumes(frame)).length, { timeout: 30_000 }).toBe(1);
  const sharp = (await chipVolumes(frame))[0];
  const wavy = (await bodyTopo(page)).filter((f) => f.type !== 'plane');
  expect(wavy).toHaveLength(1);
  await selectFaceIndices(page, [wavy[0].i]);
  await filletSelected(page, frame, '1');
  const faces = (await bodyTopo(page)).filter((f) => f.type !== 'plane');
  const big = faces.reduce((m, f) => (f.area > m.area ? f : m));
  const rounds = faces.filter((f) => f.i !== big.i).map((f) => f.i);
  expect(rounds).toHaveLength(4);
  await selectFaceIndices(page, rounds);
  await deleteSelected(page, frame, true);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'warning');
  await expect(panel(frame).locator('[data-warning]')).toHaveText('the kernel could not compare the result with the body before it: check the result', { timeout: 30_000 });
  await expect(panel(frame).locator('[data-run-reason]')).toHaveCount(0);
  // The sharp loft again (OCCT's one-go heal: 71,765.227 mm³ against 71,765.210).
  await expectOneVolume(frame, sharp, 1e-6);
  await shot(page, 'delete-faces-heal-loft');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'warning');
  expect(seen.errors).toEqual([]);
});

test('cad:delete-faces-heal-large Delete faces on a STEP part of over 2000 faces whose heal fills a step: a warning to check the result, not ok', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { seen, frame } = await freshPart(page, request);
  // Made in code with the app's kernel: the L-block with every edge R2 and a 2000-sided prism standing on its top (one solid, 2039 faces), as STEP.
  const b64 = await cad<string>(page, (async () => {
    const k = (window as unknown as W).__CAD__.services.kernel;
    const c = async (op: string, p: Record<string, unknown>) => (await k.call(op, p)).result;
    const box = async (d: number[], o: number[]) => (await c('box', { dx: d[0], dy: d[1], dz: d[2], origin: o })).id;
    const L = (await c('boolean', { op: 'cut', targets: [await box([60, 40, 20], [0, 0, 0])], tools: [await box([31, 42, 11], [30, -1, 10])] })).id;
    const es = (await c('topo', { id: L, faces: 'none', edges: 'all', vertices: 'none' })).edges.map((e: { i: number }) => e.i);
    const fl = (await c('fillet', { id: L, edges: es, r: 2 })).id;
    const n = 2000;
    const pt = (i: number) => [15 + 8 * Math.cos((2 * Math.PI * i) / n), 20 + 8 * Math.sin((2 * Math.PI * i) / n)];
    const loop = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, kind: 'line', a: pt(i), b: pt((i + 1) % n) }));
    const prism = (await c('extrude', { profile: { plane: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] }, loops: [loop] }, extent: { kind: 'blind', d: 10 } })).id;
    const both = (await c('boolean', { op: 'fuse', targets: [fl], tools: [prism] })).id;
    const step = (await k.call('export_step', { shapes: [{ id: both, name: 'Large' }], schema: 'AP214' })).buffers.step as ArrayBuffer;
    let bin = '';
    const u8 = new Uint8Array(step);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }) as never);
  const file = join(tmpdir(), `cad-e2e-large-${process.pid}-${Date.now()}.step`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  const chooser = page.waitForEvent('filechooser');
  await frame.locator('[data-cad-toolbar] [data-command="file.import-step"]').click();
  await (await chooser).setFiles(file);
  await expect(panel(frame).locator('[data-feature-panel="import"]')).toBeVisible();
  await expect(panel(frame).locator('[data-import-diagnostics]')).toBeVisible({ timeout: 120_000 });
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await settled(page);
  expect(await bodyFaces(page)).toBeGreaterThan(2000);
  // A part this large shows its volume on request: read it from the kernel.
  const bodyVolume = () => cad<number>(page, (async () => {
    const s = (window as unknown as W).__CAD__.services;
    return (await s.kernel.call('props', { id: s.doc.state.get().rebuild.bodies[0].shape, volume: true, bbox: 'none' })).result.volume;
  }) as never);
  const v0 = await bodyVolume();
  const faces = await bodyTopo(page);
  const blends = faces.filter((f) => f.type !== 'plane' && f.bbox[3] < 61);
  expect(blends).toHaveLength(30);
  const torus = blends.find((f) => f.type === 'torus')!;
  await selectFaceIndices(page, blends.filter((f) => f.i !== torus.i).map((f) => f.i));
  await deleteSelected(page, frame, false);
  const row = featureRowNamed(frame as never, 'Delete faces 1');
  await expect(row).toHaveAttribute('data-state', 'warning', { timeout: 120_000 });
  await expect(panel(frame).locator('[data-warning]')).toHaveText('this part is too large to compare the result with the body before it: check the result');
  // What the person is asked to check: the heal filled the step (12,393.6 mm³ more).
  expect((await bodyVolume()) - v0).toBeGreaterThan(12_000);
  await shot(page, 'delete-faces-heal-large');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(row).toHaveAttribute('data-state', 'warning');
  expect(seen.errors).toEqual([]);
});

test("cad:delete-faces-heal-pattern a Linear pattern of a rounded L-block's blend faces: red with the heal's words, the chip as Fillet 1 left it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { seen, frame } = await freshPart(page, request);
  const block = await addSolid(page, { size: [60, 40, 20] });
  await addSolid(page, { at: [30, 0, 10], size: [30, 40, 10], op: 'cut', scope: [block.body!] });
  await settled(page);
  expect(await selectFaces(page, 'all')).toBe(8);
  const filleted = await filletSelected(page, frame, '2');
  expect(await selectFaces(page, 'round')).toBe(30);
  await runCommand(frame, 'pattern.linear');
  await expect(panel(frame).locator('[data-feature-panel="pattern_linear"]')).toBeVisible();
  await expect(panel(frame).locator('[data-pick-field="faces"] [data-pick-row]')).toHaveCount(30);
  await panel(frame).locator('[data-pick-field="dir1"] [data-pick-list]').click();
  await frame.locator('[data-tree-node="origin:x"] > .tree-row').click();
  for (const [field, value] of [['dir1-count', '2'], ['dir1-distance', '70']]) {
    const input = panel(frame).locator(`.nui[data-field="${field}"] input`);
    await input.fill(value);
    await input.press('Enter');
  }
  await settled(page);
  const row = featureRowNamed(frame as never, 'Linear pattern 1');
  await expect(row).toHaveAttribute('data-state', 'error');
  await expect(panel(frame).locator('[data-run-reason]').first()).toHaveText(/^Linear pattern 1 failed: OCCT could not take those faces off Body 1 cleanly \(healing (filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept|would also take away faces you kept) \(/, { timeout: 30_000 });
  await expectOneVolume(frame, filleted);
  await shot(page, 'delete-faces-heal-pattern');
  await panel(frame).locator('[data-panel-done]').click();
  await expect(panel(frame)).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'error');
  await expectOneVolume(frame, filleted);
  expect(seen.errors).toEqual([]);
});
