// The sketch and extrude features in the real DocService and rebuild, over a
// scripted kernel (tests/features/sketch/fake-profiles-kernel.ts): regions
// published by the sketch, extrude volumes and face names, region keys found
// again after a change (same key; repaired by entities and the inside point;
// lost), the sketch rebuilt downstream, its isolation while edited, a
// parameter re-solving a sketch (with and without the solver), validation
// words, Try repair of an invalid extruded shape, Join with a body before it,
// and sketch visibility.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../../src/doc';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createStateStore } from '../../../src/lib/store';
import { extrudeDef } from '../../../src/features/extrude/def';
import { sketchDef } from '../../../src/features/sketch/def';
import { drawnSketches, sketchShown } from '../../../src/features/sketch/view';
import type { ExtrudeFeature, Feature, RegionRef, SketchFeature } from '../../../src/types/doc';
import { blockSketch, profileOf } from '../../doc/blocks';
import type { DocService, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { SketchCurve } from '../../../src/types/kernel-protocol';
import type { SketchSolverClient, SolverSolveResult } from '../../../src/types/sketch';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { ProfilesFakeKernel, rectRegion, type FakeRegion } from '../sketch/fake-profiles-kernel';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function make(opts: { solver?: SketchSolverClient | null } = {}) {
  const ws = createFakeWorkspace();
  const kernel = new ProfilesFakeKernel();
  const solver = createStateStore<{ s: SketchSolverClient | null }>({ s: opts.solver ?? null });
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {}, solver: () => solver.get().s });
  doc.features.register(sketchDef as unknown as FeatureTypeDef);
  doc.features.register(extrudeDef as unknown as FeatureTypeDef);
  services.push(doc);
  return { ws, kernel, doc, solver };
}

async function rebuilt(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state, f.name).not.toBe('pending');
    },
    { timeout: 3000, interval: 5 },
  );
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(() => expect(doc.state.get().rebuild.status).toBe('done'), { timeout: 3000, interval: 5 });
  return doc.state.get().rebuild;
}

/** A W x H rectangle from the origin (pt_b, pt_c, pt_d), its width dimension `w` driving. */
function rectSketch(w = 40, h = 20, widthExpr = `${w} mm`): Partial<SketchFeature> {
  return {
    points: { pt_b: [w, 0], pt_c: [w, h], pt_d: [0, h] },
    entities: [
      { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
      { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
      { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
      { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
    ],
    constraints: [{ id: 'c_w', kind: 'distance', refs: ['e_1'], expr: widthExpr, driving: true }],
    solved: { values: { c_w: w }, dof: 1, state: 'under' },
  };
}

const RECT_KEY = '+e_1[p:origin>p:pt_b] +e_2[p:pt_b>p:pt_c] +e_3[p:pt_c>p:pt_d] +e_4[p:pt_d>p:origin]';

/** The kernel's regions for the rectangle sketch: one region, its box from the curves. */
function rectRegions(curves: SketchCurve[]): { regions: FakeRegion[] } {
  const lines = curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');
  if (lines.length < 4) return { regions: [] };
  const us = lines.flatMap((l) => [l.a[0], l.b[0]]);
  const vs = lines.flatMap((l) => [l.a[1], l.b[1]]);
  const ids = lines.map((l) => l.id);
  const key = lines.map((l) => `+${l.id}[p:${l.pa}>p:${l.pb}]`).join(' ');
  return { regions: [rectRegion(key, ids, Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs))] };
}

async function sketchAndExtrude(doc: DocService, kernel: ProfilesFakeKernel, ext: Partial<ExtrudeFeature> = {}) {
  kernel.regionsFor = rectRegions;
  doc.beginNew('sketch', { id: 'f_sk', ...rectSketch() } as Partial<Feature>).commit();
  let r = await rebuilt(doc);
  const out = r.outputs.f_sk;
  expect(out?.type).toBe('sketch');
  const region = out!.type === 'sketch' ? out!.regions[0] : null;
  const ref: RegionRef = { sketch: 'f_sk', region: region!.key, entities: region!.entities, sample: region!.sample };
  doc.beginNew('extrude', { id: 'f_ex', profiles: [ref], ...ext } as Partial<Feature>).commit();
  r = await rebuilt(doc);
  return r;
}

describe('the sketch feature', () => {
  it('publishes its regions from the kernel, on the Top plane, from the stored geometry', async () => {
    const { doc, kernel } = make();
    await doc.load();
    kernel.regionsFor = rectRegions;
    doc.beginNew('sketch', { id: 'f_sk', ...rectSketch() } as Partial<Feature>).commit();
    const r = await rebuilt(doc);
    expect(r.features.f_sk).toMatchObject({ state: 'ok' });
    const out = r.outputs.f_sk;
    expect(out).toMatchObject({ type: 'sketch', source: 'stored', plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } });
    if (out?.type !== 'sketch') throw new Error('no output');
    expect(out.regions.map((x) => [x.key, x.area])).toEqual([[RECT_KEY, 800]]);
    expect(out.regions[0].tri.idx.length).toBe(6);
    expect(out.points.origin).toEqual([0, 0]);
    expect(r.bodies).toEqual([]);
    const call = kernel.calls.find((c) => c.op === 'sketch_regions')!;
    expect((call.params.curves as SketchCurve[]).map((c) => c.id)).toEqual(['e_1', 'e_2', 'e_3', 'e_4']);
    expect(call.params.tess).toBe(true);
  });

  it('asks the kernel nothing for a sketch with no curves', async () => {
    const { doc, kernel } = make();
    await doc.load();
    doc.beginNew('sketch', { id: 'f_sk' } as Partial<Feature>).commit();
    const r = await rebuilt(doc);
    expect(r.features.f_sk.state).toBe('ok');
    expect(kernel.ops(['sketch_regions'])).toEqual([]);
    expect(r.outputs.f_sk).toMatchObject({ regions: [], open: [], dangling: [] });
  });

  it('says so when the kernel cannot find regions (an API 2 kernel), and keeps the sketch', async () => {
    const { doc, kernel } = make();
    kernel.noApi3 = true;
    await doc.load();
    doc.beginNew('sketch', { id: 'f_sk', ...rectSketch() } as Partial<Feature>).commit();
    const r = await rebuilt(doc);
    expect(r.features.f_sk).toMatchObject({ state: 'warning', message: 'Sketch 1 has no profiles: this kernel cannot find profile regions (it needs kernel API 3)' });
  });

  it('shows the stored shape with a warning when a parameter changed a dimension and the solver is not running', async () => {
    const { doc, kernel } = make();
    await doc.load();
    kernel.regionsFor = rectRegions;
    const id = doc.addParam({ name: 'w', expr: '40 mm', quantity: 'length' });
    expect(typeof id).toBe('string');
    doc.beginNew('sketch', { id: 'f_sk', ...rectSketch(40, 20, 'w') } as Partial<Feature>).commit();
    let r = await rebuilt(doc);
    expect(r.outputs.f_sk).toMatchObject({ source: 'stored' });
    doc.updateParam(id as string, { expr: '60 mm' });
    r = await rebuilt(doc);
    expect(r.features.f_sk).toMatchObject({ state: 'warning', message: 'Sketch 1 shows its last solved shape: the sketch solver is not running' });
    expect(r.outputs.f_sk).toMatchObject({ source: 'stored-unsolved' });
  });

  it('re-solves through the solver when a parameter changed a dimension, and names conflicting dimensions when it cannot', async () => {
    let answer: (values: Record<string, number>) => SolverSolveResult = (v) => ({
      status: 'Success',
      solved: true,
      dof: 1,
      conflicting: [],
      redundant: [],
      values: { points: { origin: [0, 0], pt_b: [v.c_w, 0], pt_c: [v.c_w, 20], pt_d: [0, 20] }, radii: {}, measures: {} },
      ms: 1,
    });
    const solver = { solveFeature: vi.fn(async (_f: SketchFeature, values: Record<string, number>) => answer(values)) } as unknown as SketchSolverClient;
    const { doc, kernel } = make({ solver });
    await doc.load();
    kernel.regionsFor = rectRegions;
    const id = doc.addParam({ name: 'w', expr: '40 mm', quantity: 'length' }) as string;
    doc.beginNew('sketch', { id: 'f_sk', ...rectSketch(40, 20, 'w') } as Partial<Feature>).commit();
    await rebuilt(doc);
    expect(solver.solveFeature).not.toHaveBeenCalled();
    doc.updateParam(id, { expr: '60 mm' });
    let r = await rebuilt(doc);
    expect(solver.solveFeature).toHaveBeenCalledWith(expect.objectContaining({ id: 'f_sk' }), { c_w: 60 });
    expect(r.features.f_sk.state).toBe('ok');
    expect(r.outputs.f_sk).toMatchObject({ source: 'solved', points: { pt_b: [60, 0] } });
    if (r.outputs.f_sk?.type === 'sketch') expect(r.outputs.f_sk.regions[0].area).toBe(1200);
    answer = () => ({ status: 'Failed', solved: false, dof: 0, conflicting: ['c_w'], redundant: [], values: { points: {}, radii: {}, measures: {} }, ms: 1 });
    doc.updateParam(id, { expr: '70 mm' });
    r = await rebuilt(doc);
    expect(r.features.f_sk).toMatchObject({ state: 'error', message: 'Sketch 1 failed: the dimensions cannot all hold (conflicting: Distance w)' });
  });

  // A sketch on a face of a body (found by its stored reference, following it, keeping its plane
  // when the face is gone) is tested on the real kernel: tests/features/extrude/real-kernel.test.ts.
});

describe('the extrude feature', () => {
  it('extrudes a profile into a new body with the area x distance, named by sub-segment and caps', async () => {
    const { doc, kernel } = make();
    await doc.load();
    const r = await sketchAndExtrude(doc, kernel);
    expect(r.features.f_ex).toMatchObject({ state: 'ok' });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toMatchObject({ feature: 'f_ex', name: 'Body 1', volume: 800 * 10 });
    expect(r.bodies[0].names?.faces).toEqual([
      'F:f_ex:start',
      'F:f_ex:end',
      'F:f_ex:side:e_1[p:origin>p:pt_b]',
      'F:f_ex:side:e_2[p:pt_b>p:pt_c]',
      'F:f_ex:side:e_3[p:pt_c>p:pt_d]',
      'F:f_ex:side:e_4[p:pt_d>p:origin]',
    ]);
    const call = kernel.calls.find((c) => c.op === 'extrude_regions')!;
    expect(call.params).toMatchObject({ regions: [RECT_KEY], extent: { kind: 'blind', d: 10 }, flip: false });
    // The sketch is shown until the extrude uses it.
    const s = doc.state.get();
    expect(sketchShown(s.doc, s.view, doc.features, 'f_sk')).toBe(false);
    expect(drawnSketches(s, 'model', { forced: [], ignoreUser: null }, doc.features)).toEqual([]);
    expect(drawnSketches(s, 'model', { forced: [], ignoreUser: 'f_ex' }, doc.features).map((d) => d.feature.id)).toEqual(['f_sk']);
    doc.setSketchVisibility('f_sk', 'shown');
    expect(sketchShown(doc.state.get().doc, doc.state.get().view, doc.features, 'f_sk')).toBe(true);
  });

  it('follows a dimension change of its sketch (same region key) and rebuilds only then', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    const before = kernel.extrudes.length;
    // An edit of the extrude's own name rebuilds nothing.
    doc.rename('f_ex', 'Plate');
    await rebuilt(doc);
    expect(kernel.extrudes.length).toBe(before);
    // Width 40 -> 50: the rectangle keeps its key; the extrude follows.
    const s = doc.beginEdit('f_sk');
    s.update({ ...rectSketch(50, 20) } as Partial<Feature>);
    // While the sketch is edited, the extrude waits (rolled back), the sketch's regions update.
    let r = await rebuilt(doc);
    expect(r.features.f_ex.state).toBe('rolled-back');
    expect(r.bodies).toEqual([]);
    expect(r.outputs.f_sk?.type === 'sketch' && r.outputs.f_sk.regions[0].area).toBe(1000);
    s.commit();
    r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'ok' });
    expect(r.bodies[0].volume).toBe(1000 * 10);
    expect(kernel.extrudes.length).toBe(before + 1);
  });

  it('finds a profile again by its entities and inside point when its key changed ("Profile repaired · check")', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    // A trim renamed a corner point: the key changes, the entities and the region stay.
    kernel.regionsFor = (curves) => {
      const r = rectRegions(curves).regions[0];
      return { regions: [{ ...r, key: r.key.replace(/pt_c/g, 'pt_c2') }] };
    };
    const s = doc.beginEdit('f_sk');
    s.update({ points: { pt_b: [40, 0], pt_c: [40, 20], pt_d: [0, 20], pt_z: [1, 1] } } as Partial<Feature>);
    s.commit();
    const r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'warning', message: 'Profile repaired · check' });
    expect(r.bodies[0].volume).toBe(8000);
  });

  it('counts a piece of a trimmed entity (lineage e_2.b) as the entity it came from', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    kernel.regionsFor = (curves) => {
      const r = rectRegions(curves).regions[0];
      return { regions: [{ ...r, key: 'renamed', entities: ['e_1', 'e_2.b', 'e_3', 'e_4'] }] };
    };
    const s = doc.beginEdit('f_sk');
    const f = doc.state.get().doc.features[0] as SketchFeature;
    s.update({ entities: [...f.entities, { id: 'e_2.b', kind: 'line', p: ['pt_b', 'pt_c'], parent: 'e_2' }] } as Partial<Feature>);
    s.commit();
    const r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'warning', message: 'Profile repaired · check' });
  });

  it('is red "Profile lost" when the region is gone, and when another region with the same entities does not hold its point', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    // Same entities, another place (the lens trimmed away, a crescent left): lost, not a quiet switch.
    kernel.regionsFor = (curves) => {
      const r = rectRegions(curves).regions[0];
      return { regions: [{ ...rectRegion('other', r.entities, 100, 100, 110, 110) }] };
    };
    let s = doc.beginEdit('f_sk');
    s.update({ points: { pt_b: [40, 0], pt_c: [40, 20], pt_d: [0, 20], pt_z: [2, 2] } } as Partial<Feature>);
    s.commit();
    let r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'error', message: 'Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone' });
    expect(r.bodies).toEqual([]);
    // No region at all.
    kernel.regionsFor = () => ({ regions: [] });
    s = doc.beginEdit('f_sk');
    s.update({ points: { pt_b: [40, 0], pt_c: [40, 20], pt_d: [0, 20], pt_z: [3, 3] } } as Partial<Feature>);
    s.commit();
    r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'error', message: 'Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone' });
    // The sketch suppressed: the extrude says its sketch did not build.
    doc.setSuppressed('f_sk', true);
    r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'error', message: 'Extrude 1 failed: Sketch 1 did not build' });
  });

  it('extrudes several profiles in one call and names their caps by profile index', async () => {
    const { doc, kernel } = make();
    await doc.load();
    kernel.regionsFor = () => ({ regions: [rectRegion('+e_1[] ', ['e_1'], 0, 0, 10, 10), rectRegion('+e_2[]', ['e_2'], 20, 0, 30, 10)] });
    doc.beginNew('sketch', { id: 'f_sk', ...rectSketch() } as Partial<Feature>).commit();
    let r = await rebuilt(doc);
    const regions = r.outputs.f_sk?.type === 'sketch' ? r.outputs.f_sk.regions : [];
    const refs: RegionRef[] = regions.map((x) => ({ sketch: 'f_sk', region: x.key, entities: x.entities, sample: x.sample }));
    doc.beginNew('extrude', { id: 'f_ex', profiles: [refs[1], refs[0]] } as Partial<Feature>).commit();
    r = await rebuilt(doc);
    expect(r.features.f_ex.state).toBe('ok');
    expect(r.bodies[0].volume).toBe(2000);
    expect(r.bodies[0].names?.faces.slice(0, 4)).toEqual(['F:f_ex:start:0', 'F:f_ex:end:0', 'F:f_ex:start:1', 'F:f_ex:end:1']);
  });

  it('builds Symmetric, Two sides and flipped extents, and says what is wrong with the distances', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel, { extent: { kind: 'symmetric', distance: '30 mm' }, flip: true });
    expect(kernel.calls.filter((c) => c.op === 'extrude_regions').at(-1)!.params).toMatchObject({ extent: { kind: 'symmetric', d: 30 }, flip: true });
    const s = doc.beginEdit('f_ex');
    s.update({ extent: { kind: 'two', distance: '5 mm', distance2: '-5 mm' } } as Partial<Feature>);
    expect(s.incomplete()).toBe('The two distances must not add up to 0');
    s.update({ extent: { kind: 'two', distance: '5 mm', distance2: '15 mm' } } as Partial<Feature>);
    expect(s.incomplete()).toBeNull();
    s.update({ extent: { kind: 'blind', distance: '0 mm' } } as Partial<Feature>);
    expect(s.incomplete()).toBe('Distance must not be 0');
    s.update({ extent: { kind: 'symmetric', distance: '-3 mm' } } as Partial<Feature>);
    expect(s.incomplete()).toBe('Distance must be more than 0');
    s.update({ profiles: [] } as Partial<Feature>);
    expect(s.incomplete()).toBe('Pick a profile');
    s.discard();
    const r = await rebuilt(doc);
    expect(r.bodies[0].volume).toBe(800 * 30);
    // The last valid version is the one that applied before the bad ones.
    const two = doc.beginEdit('f_ex');
    two.update({ extent: { kind: 'two', distance: '5 mm', distance2: '15 mm' } } as Partial<Feature>);
    two.commit();
    expect((await rebuilt(doc)).bodies[0].volume).toBe(800 * 20);
  });

  it('refuses profiles from two sketches', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    const s = doc.beginEdit('f_ex');
    const f = s.draft as ExtrudeFeature;
    s.update({ profiles: [...f.profiles, { ...f.profiles[0], sketch: 'f_other' }] } as Partial<Feature>);
    expect(s.incomplete()).toBe('Pick profiles from one sketch');
    s.discard();
  });

  it('turns red with Try repair when the kernel says the extruded shape is invalid; Try repair runs ShapeFix', async () => {
    const { doc, kernel } = make();
    await doc.load();
    kernel.extrudeValid = false;
    let r = await sketchAndExtrude(doc, kernel);
    expect(r.features.f_ex).toMatchObject({ state: 'error', actions: ['repair'], message: 'Extrude 1 failed: the extruded shape is not a valid solid: (BRepCheck): BadOrientationOfSubshape x1' });
    expect(r.bodies).toEqual([]);
    expect(doc.repair('f_ex')).toEqual({ ok: true });
    r = await rebuilt(doc);
    expect(r.features.f_ex).toMatchObject({ state: 'warning', message: 'Extrude 1 was repaired: check the result' });
    expect(r.bodies[0].volume).toBe(8000);
    expect(kernel.ops(['repair'])).toEqual(['repair']);
  });

  it('joins a body made before it (the P1.5 Operation rules come with applyBodyOp)', async () => {
    const { doc, kernel } = make();
    await doc.load();
    // A 40 x 20 x 10 block first (Sketch 1, Extrude 1), then the rectangle's Extrude 2 joins it.
    kernel.regionsFor = rectRegions;
    const base = blockSketch(0, 0, 40, 20);
    doc.beginNew('sketch', { id: 'f_base', ...base } as Partial<Feature>).commit();
    doc.beginNew('extrude', { id: 'f_block', profiles: [profileOf('f_base', base)] } as Partial<Feature>).commit();
    await rebuilt(doc);
    const r = await sketchAndExtrude(doc, kernel, { op: 'join', creates: null });
    expect(r.features.f_ex).toMatchObject({ state: 'ok', bodiesBefore: 1 });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].feature).toBe('f_ex');
    // A cut down from the sketch plane removes nothing from a block above it: the words say why.
    const s = doc.beginEdit('f_ex');
    s.update({ op: 'cut', flip: true } as Partial<Feature>);
    s.commit();
    const r2 = await rebuilt(doc);
    // (What follows the reason, the way to cut into the block, is the extrude's own wording.)
    expect(r2.features.f_ex.state).toBe('error');
    expect(r2.features.f_ex.message?.startsWith('Nothing to cut: Extrude 2 does not overlap any body made before it (touching is not enough)')).toBe(true);
  });

  it('renames a parameter in its distances only (region keys and ids are not expressions)', async () => {
    const { doc, kernel } = make();
    await doc.load();
    const id = doc.addParam({ name: 'e_1', expr: '10 mm', quantity: 'length' }) as string;
    await sketchAndExtrude(doc, kernel, { extent: { kind: 'two', distance: 'e_1', distance2: 'e_1 / 2' } });
    expect(doc.updateParam(id, { name: 'depth' })).toEqual({ ok: true });
    const f = doc.state.get().doc.features.find((g) => g.id === 'f_ex') as ExtrudeFeature;
    expect(f.extent).toEqual({ kind: 'two', distance: 'depth', distance2: 'depth / 2' });
    expect(f.profiles[0].region).toBe(RECT_KEY);
    expect(f.profiles[0].entities).toEqual(['e_1', 'e_2', 'e_3', 'e_4']);
  });

  it('keeps the sketch while an extrude uses it (the parent guard)', async () => {
    const { doc, kernel } = make();
    await doc.load();
    await sketchAndExtrude(doc, kernel);
    expect(doc.remove('f_sk')).toEqual({ ok: false, reason: 'Extrude 1 uses Sketch 1: delete Extrude 1 or change what it uses first' });
  });
});
