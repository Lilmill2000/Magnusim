// @vitest-environment node
// CONSTRUCT features on the REAL kernel and the real DocService: a Plane offset
// 20 mm from Top, a sketch on it and an extrude of it (the body spans z 20..30,
// and follows when the offset changes); a Plane on a face of a block follows the
// block's height; a lost face turns the Plane red with the reason, and the sketch
// on it keeps its stored plane with a warning; midplane, at an angle, through 3
// points; Axis of a cylinder and where two planes cross; Point coordinates;
// Delete refused while a sketch uses the plane.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../../src/doc';
import { refAxisDef, refPlaneDef, refPointDef } from '../../../src/features/refgeom/defs';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { kernelLookup, refOfFace } from '../../../src/naming';
import { refOfEdge, refOfVertex } from '../../../src/naming/edges';
import type { ExtrudeFeature, Feature, PersistentRef, PlaneFrame, RefAxisFeature, RefPlaneFeature, RefPointFeature, SketchFeature, Vec3 } from '../../../src/types/doc';
import type { DocService, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { KernelAdapter } from '../../../src/types/kernel';
import type { ConstructOutput } from '../../../src/types/references';
import { block, blockSketch, BLOCK_KEY, cylinder, registerSolidFeatures } from '../../doc/blocks';
import { realKernelAdapter } from '../../doc/inprocess-kernel';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function open() {
  const ws = createFakeWorkspace({ units: 'metric' });
  const { kernel } = realKernelAdapter();
  await kernel.start();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  for (const def of [refPlaneDef, refAxisDef, refPointDef]) doc.features.register(def as unknown as FeatureTypeDef);
  disposers.push(() => {
    doc.dispose();
    kernel.dispose();
  });
  await doc.load();
  return { doc, kernel };
}

async function settle(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) if (!f.suppressed) expect(s.rebuild.features[f.id]?.state ?? 'pending', f.name).not.toBe('pending');
    },
    { timeout: 30_000, interval: 10 },
  );
  return doc.state.get().rebuild;
}

const add = <F extends Feature>(doc: DocService, type: F['type'], patch: Partial<F>) => {
  const s = doc.beginNew(type, patch as Partial<Feature>);
  s.commit();
  return s.feature;
};
const edit = (doc: DocService, id: string, patch: Partial<Feature>) => {
  const s = doc.beginEdit(id);
  s.update(patch);
  s.commit();
};
const out = (doc: DocService, id: string) => doc.state.get().rebuild.outputs[id] as ConstructOutput | undefined;
const round = (v: readonly number[], d = 9) => v.map((x) => {
  const r = Math.round(x * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? 0 : r;
});

/** A sketch (a 20 x 10 rectangle at (5, 5)) on a CONSTRUCT plane, then Extrude of it, `h` along the plane's normal. */
function sketchAndExtrude(doc: DocService, plane: string, h: number) {
  const frame = (out(doc, plane) as { frame: PlaneFrame }).frame;
  const init: Partial<SketchFeature> = { ...blockSketch(5, 5, 20, 10), support: { kind: 'feature', feature: plane }, plane: frame };
  const sk = add<SketchFeature>(doc, 'sketch', init);
  const ex = add<ExtrudeFeature>(doc, 'extrude', { profiles: [{ sketch: sk, region: BLOCK_KEY, entities: ['e_1', 'e_2', 'e_3', 'e_4'], sample: [15, 10] }], extent: { kind: 'blind', distance: `${h} mm` }, op: 'new' });
  return { sk, ex, body: (doc.state.get().doc.features.find((f) => f.id === ex) as ExtrudeFeature).creates! };
}

/** The stored reference of the face of `body` whose outward normal is `n` (and centroid passes `where`). */
async function faceRef(doc: DocService, kernel: KernelAdapter, body: string, n: Vec3, where: (c: Vec3) => boolean = () => true): Promise<PersistentRef> {
  const b = doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
  const lookup = kernelLookup(kernel);
  const faces = await lookup.faces(b.shape, 'all');
  const f = faces.find((x) => x.type === 'plane' && x.normal && round(x.normal, 6).join() === round(n, 6).join() && where(x.centroid as Vec3));
  if (!f) throw new Error('no such face');
  return refOfFace(lookup, b.shape, b.names!, f.i);
}

const same = (a: readonly number[] | undefined, b: readonly number[], eps = 1e-6) => !!a && a.every((x, i) => Math.abs(x - b[i]) <= eps);

/** The stored reference of the edge of `body` that `pick` chooses (topo with its ends). */
async function edgeRef(doc: DocService, kernel: KernelAdapter, body: string, pick: (e: { type: string; first?: number[]; last?: number[]; mid?: number[]; center?: number[] }) => boolean): Promise<PersistentRef> {
  const b = doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
  const lookup = kernelLookup(kernel);
  const e = (await lookup.edges!(b.shape, 'all')).find((x) => pick(x as never));
  if (!e) throw new Error('no such edge');
  return refOfEdge(lookup, b.shape, b.names!, e.i);
}

/** The stored reference of the vertex of `body` at `p`. */
async function vertexRef(doc: DocService, kernel: KernelAdapter, body: string, p: Vec3): Promise<PersistentRef> {
  const b = doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
  const lookup = kernelLookup(kernel);
  const v = (await lookup.vertices!(b.shape, 'all')).find((x) => same(x.p, p));
  if (!v) throw new Error('no such vertex');
  return refOfVertex(lookup, b.shape, b.names!, v.i);
}

describe('CONSTRUCT features on the real kernel', () => {
  it('a Plane offset 20 mm from Top: a sketch on it and an extrude span z 20..30; the sketch follows the offset', async () => {
    const { doc } = await open();
    const plane = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '20 mm' });
    await settle(doc);
    expect(doc.state.get().rebuild.features[plane]).toMatchObject({ state: 'ok' });
    expect(out(doc, plane)).toEqual({ type: 'plane', frame: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } });
    expect(doc.state.get().doc.features.find((f) => f.id === plane)?.name).toBe('Plane 1');
    // A CONSTRUCT feature makes no body.
    expect(doc.state.get().rebuild.bodies).toHaveLength(0);
    const { sk, body } = sketchAndExtrude(doc, plane, 10);
    let r = await settle(doc);
    let b = r.bodies.find((x) => x.id === body)!;
    expect(round(b.bbox)).toEqual([5, 5, 20, 25, 15, 30]);
    expect(b.volume).toBeCloseTo(20 * 10 * 10, 6);
    // The plane moves: the sketch and its extrude follow.
    edit(doc, plane, { distance: '35 mm' } as Partial<Feature>);
    r = await settle(doc);
    b = r.bodies.find((x) => x.id === body)!;
    expect(round(b.bbox)).toEqual([5, 5, 35, 25, 15, 45]);
    expect(r.features[sk]).toMatchObject({ state: 'ok' });
    // Reverse direction: below Top.
    edit(doc, plane, { flip: true } as Partial<Feature>);
    r = await settle(doc);
    expect(round(r.bodies.find((x) => x.id === body)!.bbox)).toEqual([5, 5, -35, 25, 15, -25]);
    // The sketch uses the plane: Delete is refused, with the reason.
    expect(doc.removeBlock(plane)).toMatch(/Sketch 1/);
  });

  it('a Plane on the top face of a block follows the block; a lost face is the reason, and the sketch on it keeps its plane', async () => {
    const { doc, kernel } = await open();
    const blk = block(doc, { size: [40, 30, 20] });
    await settle(doc);
    const top = await faceRef(doc, kernel, blk.body!, [0, 0, 1]);
    const plane = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'offset', plane: { kind: 'face', body: blk.body!, ref: top }, distance: '5 mm' });
    let r = await settle(doc);
    expect(r.features[plane]).toMatchObject({ state: 'ok' });
    expect(round((out(doc, plane) as { frame: PlaneFrame }).frame.origin)).toEqual([0, 0, 25]);
    const { body } = sketchAndExtrude(doc, plane, 10);
    r = await settle(doc);
    expect(round(r.bodies.find((x) => x.id === body)!.bbox)).toEqual([5, 5, 25, 25, 15, 35]);
    // The block grows to 32 mm: the plane (on its top face) and the sketch's extrude follow.
    edit(doc, blk.extrude, { extent: { kind: 'blind', distance: '32 mm' } } as Partial<Feature>);
    r = await settle(doc);
    expect(r.features[plane]).toMatchObject({ state: 'ok' });
    expect(round((out(doc, plane) as { frame: PlaneFrame }).frame.origin)).toEqual([0, 0, 37]);
    expect(round(r.bodies.find((x) => x.id === body)!.bbox)).toEqual([5, 5, 37, 25, 15, 47]);
    // The block's extrude suppressed: the plane has nothing to stand on and says why; the sketch keeps
    // its stored plane (amber) and its extrude still builds where it was.
    doc.setSuppressed(blk.extrude, true);
    r = await settle(doc);
    expect(r.features[plane]).toMatchObject({ state: 'error', message: 'Plane 1 failed: Body 1 is not there at this point' });
    expect(r.features[doc.state.get().doc.features[3].id]).toMatchObject({ state: 'warning', message: 'Sketch 2 lost its plane: it stays where it was' });
    expect(r.bodies.find((x) => x.id === body)).toBeTruthy();
  });

  it('Midplane, At an angle and Through 3 points', async () => {
    const { doc } = await open();
    const p40 = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '40 mm' });
    const mid = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'midplane', plane: { kind: 'origin', plane: 'origin:top' }, plane2: { kind: 'feature', feature: p40 } });
    const ang = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'origin', axis: 'origin:x' }, angle: '90 deg' });
    const pts = [
      ['0 mm', '0 mm', '0 mm'],
      ['10 mm', '0 mm', '0 mm'],
      ['0 mm', '10 mm', '5 mm'],
    ].map((xyz) => add<RefPointFeature>(doc, 'ref_point', { method: 'coordinates', xyz: xyz as RefPointFeature['xyz'] }));
    const three = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'three_points', points: pts.map((feature) => ({ kind: 'feature' as const, feature })) });
    const r = await settle(doc);
    for (const id of [p40, mid, ang, three, ...pts]) expect(r.features[id], id).toMatchObject({ state: 'ok' });
    expect(round((out(doc, mid) as { frame: PlaneFrame }).frame.origin)).toEqual([0, 0, 20]);
    expect(round((out(doc, ang) as { frame: PlaneFrame }).frame.normal)).toEqual([0, -1, 0]);
    const n = (out(doc, three) as { frame: PlaneFrame }).frame.normal;
    expect(round(n)).toEqual(round([0, -50 / Math.hypot(50, 100), 100 / Math.hypot(50, 100)]));
    expect(out(doc, pts[2])).toEqual({ type: 'point', p: [0, 10, 5] });
    // The parents: Plane 2 uses Plane 1, so Plane 1 cannot be deleted.
    expect(doc.removeBlock(p40)).toMatch(/Plane 2/);
    // Three points on one line: red with the reason.
    edit(doc, pts[2], { xyz: ['20 mm', '0 mm', '0 mm'] } as Partial<Feature>);
    const r2 = await settle(doc);
    expect(r2.features[three]).toMatchObject({ state: 'error', message: 'Plane 4 failed: the three points are on one line' });
  });

  it('Axis of a cylinder, and where two planes cross', async () => {
    const { doc, kernel } = await open();
    const cyl = cylinder(doc, { at: [10, 5, 0], size: [20, 30] });
    await settle(doc);
    const b = doc.state.get().rebuild.bodies.find((x) => x.id === cyl.body)!;
    const lookup = kernelLookup(kernel);
    const side = (await lookup.faces(b.shape, 'all')).find((f) => f.type === 'cylinder')!;
    const ref = await refOfFace(lookup, b.shape, b.names!, side.i);
    const ax = add<RefAxisFeature>(doc, 'ref_axis', { method: 'cylinder', face: { kind: 'face', body: cyl.body!, ref } });
    const cross = add<RefAxisFeature>(doc, 'ref_axis', { method: 'two_planes', planes: [{ kind: 'origin', plane: 'origin:front' }, { kind: 'origin', plane: 'origin:right' }] });
    const par = add<RefAxisFeature>(doc, 'ref_axis', { method: 'two_planes', planes: [{ kind: 'origin', plane: 'origin:top' }, { kind: 'origin', plane: 'origin:top' }] });
    const r = await settle(doc);
    const a = out(doc, ax) as { origin: Vec3; dir: Vec3 };
    expect(round(a.dir.map(Math.abs))).toEqual([0, 0, 1]);
    expect(round(a.origin).slice(0, 2)).toEqual([10, 5]);
    const c = out(doc, cross) as { origin: Vec3; dir: Vec3 };
    expect(round(c.dir.map(Math.abs))).toEqual([0, 0, 1]);
    expect(round(c.origin)).toEqual([0, 0, 0]);
    expect(r.features[par]).toMatchObject({ state: 'error', message: 'Axis 3 failed: Top plane and Top plane are parallel, so they do not cross' });
    // A flat face is not a cylinder.
    const flat = (await lookup.faces(b.shape, 'all')).find((f) => f.type === 'plane')!;
    const flatRef = await refOfFace(lookup, b.shape, b.names!, flat.i);
    edit(doc, ax, { face: { kind: 'face', body: cyl.body!, ref: flatRef } } as Partial<Feature>);
    const r2 = await settle(doc);
    expect(r2.features[ax]?.state).toBe('error');
    expect(r2.features[ax]?.message).toMatch(/^Axis 1 failed: .* is not a cylinder or a cone \(it is flat\)$/);
  });

  it('a parameter drives a CONSTRUCT value, and a rename of it rewrites the expression', async () => {
    const { doc } = await open();
    const id = doc.addParam({ name: 'gap', expr: '12 mm', quantity: 'length' });
    expect(typeof id).toBe('string');
    const plane = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:front' }, distance: 'gap * 2' });
    await settle(doc);
    expect(round((out(doc, plane) as { frame: PlaneFrame }).frame.origin)).toEqual([0, -24, 0]);
    doc.updateParam(id as string, { name: 'clearance' });
    expect((doc.state.get().doc.features.find((f) => f.id === plane) as RefPlaneFeature).distance).toBe('clearance * 2');
    // The method and the references are not expressions: untouched by the rename.
    expect((doc.state.get().doc.features.find((f) => f.id === plane) as RefPlaneFeature).method).toBe('offset');
  });

  it('edges and vertices: Axis along an edge and a round edge, Point at a vertex, at a centre, on an edge, where an edge crosses a plane; Plane normal to an edge and through 3 vertices; they follow a width change', async () => {
    const { doc, kernel } = await open();
    // A 40 x 30 x 20 block at the origin, and a d 10 x 20 cylinder at (60, 0).
    const blk = block(doc, { size: [40, 30, 20] });
    const cyl = cylinder(doc, { at: [60, 0, 0], size: [10, 20] });
    await settle(doc);
    const B = blk.body!;
    // The vertical edge at x = 40, y = 0 (from z 0 to 20), the top edge along X at y = 0, z = 20.
    const vertical = await edgeRef(doc, kernel, B, (e) => e.type === 'line' && same(e.mid, [40, 0, 10]));
    const topFront = await edgeRef(doc, kernel, B, (e) => e.type === 'line' && same(e.mid, [20, 0, 20]));
    const rim = await edgeRef(doc, kernel, cyl.body!, (e) => e.type === 'circle' && !!e.center && Math.abs(e.center[2] - 20) < 1e-6);
    const corner = await vertexRef(doc, kernel, B, [40, 30, 20]);
    const along = add<RefAxisFeature>(doc, 'ref_axis', { method: 'edge', edge: { kind: 'edge', body: B, ref: topFront } });
    const roundAx = add<RefAxisFeature>(doc, 'ref_axis', { method: 'edge', edge: { kind: 'edge', body: cyl.body!, ref: rim } });
    const atCorner = add<RefPointFeature>(doc, 'ref_point', { method: 'vertex', vertex: { kind: 'vertex', body: B, ref: corner } });
    const centre = add<RefPointFeature>(doc, 'ref_point', { method: 'center', edge: { kind: 'edge', body: cyl.body!, ref: rim } });
    const quarter = add<RefPointFeature>(doc, 'ref_point', { method: 'on_edge', edge: { kind: 'edge', body: B, ref: vertical }, along: 'percent', percent: '25' });
    const fromEnd = add<RefPointFeature>(doc, 'ref_point', { method: 'on_edge', edge: { kind: 'edge', body: B, ref: vertical }, along: 'distance', distance: '5 mm', fromEnd: true });
    const z7 = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '7 mm' });
    const cross = add<RefPointFeature>(doc, 'ref_point', { method: 'edge_plane', edge: { kind: 'edge', body: B, ref: vertical }, plane: { kind: 'feature', feature: z7 } });
    const normal = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'normal_to_curve', edge: { kind: 'edge', body: B, ref: vertical }, percent: '50' });
    const v1 = await vertexRef(doc, kernel, B, [0, 0, 20]);
    const v2 = await vertexRef(doc, kernel, B, [40, 0, 20]);
    const three = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'three_points', points: [{ kind: 'vertex', body: B, ref: v1 }, { kind: 'vertex', body: B, ref: v2 }, { kind: 'vertex', body: B, ref: corner }] });
    let r = await settle(doc);
    for (const id of [along, roundAx, atCorner, centre, quarter, fromEnd, cross, normal, three]) expect(r.features[id], id).toMatchObject({ state: 'ok' });
    const ax = out(doc, along) as { origin: Vec3; dir: Vec3 };
    expect(round(ax.dir.map(Math.abs))).toEqual([1, 0, 0]);
    expect(round([ax.origin[1], ax.origin[2]])).toEqual([0, 20]);
    const rd = out(doc, roundAx) as { origin: Vec3; dir: Vec3 };
    expect(round(rd.origin)).toEqual([60, 0, 20]);
    expect(round(rd.dir.map(Math.abs))).toEqual([0, 0, 1]);
    expect(round((out(doc, atCorner) as { p: Vec3 }).p)).toEqual([40, 30, 20]);
    expect(round((out(doc, centre) as { p: Vec3 }).p)).toEqual([60, 0, 20]);
    // The vertical edge runs one way or the other: 25 % from its start is z 5 or z 15; 5 mm from its end is the other end's side.
    const q = round((out(doc, quarter) as { p: Vec3 }).p);
    const e5 = round((out(doc, fromEnd) as { p: Vec3 }).p);
    expect([q[0], q[1]]).toEqual([40, 0]);
    expect([5, 15]).toContain(q[2]);
    expect(e5[2]).toBe(q[2] === 5 ? 15 : 5);
    expect(round((out(doc, cross) as { p: Vec3 }).p)).toEqual([40, 0, 7]);
    const nf = (out(doc, normal) as { frame: PlaneFrame }).frame;
    expect(round(nf.origin)).toEqual([40, 0, 10]);
    expect(round(nf.normal.map(Math.abs))).toEqual([0, 0, 1]);
    const tf = (out(doc, three) as { frame: PlaneFrame }).frame;
    expect(round(tf.normal)).toEqual([0, 0, 1]);
    expect(round(tf.origin)).toEqual([0, 0, 20]);

    // The block made 50 wide (its sketch's rectangle): every reference follows by name.
    const sk = doc.state.get().doc.features.find((f) => f.id === blk.sketch) as SketchFeature;
    edit(doc, blk.sketch, { points: { ...sk.points, pt_2: [50, 0], pt_3: [50, 30] } } as Partial<Feature>);
    r = await settle(doc);
    for (const id of [along, atCorner, quarter, fromEnd, cross, normal, three]) expect(r.features[id], id).toMatchObject({ state: 'ok' });
    expect(round((out(doc, atCorner) as { p: Vec3 }).p)).toEqual([50, 30, 20]);
    expect(round((out(doc, cross) as { p: Vec3 }).p)).toEqual([50, 0, 7]);
    expect(round((out(doc, normal) as { frame: PlaneFrame }).frame.origin)).toEqual([50, 0, 10]);

    // Past the end of the edge: red with the reason, in the panel's words.
    edit(doc, fromEnd, { distance: '25 mm' } as Partial<Feature>);
    r = await settle(doc);
    expect(r.features[fromEnd]?.state).toBe('error');
    expect(r.features[fromEnd]?.message).toMatch(/^Point 4 failed: Distance 25 mm is past the end of .+ \(it is 20 mm long\)$/);
    // A plane the edge does not reach.
    edit(doc, z7, { distance: '70 mm' } as Partial<Feature>);
    r = await settle(doc);
    expect(r.features[cross]?.message).toMatch(/^Point 5 failed: .+ does not cross Plane 1$/);
  });


  it('Plane normal to a sketch curve (a Sweep path): at its start, at a fraction, and at a point on it; it follows the sketch', async () => {
    const { doc } = await open();
    // On Front (u = X, v = Z): a line up from the origin to (0, 50) and a circle r 10 about (30, 0).
    const path = add<SketchFeature>(doc, 'sketch', {
      support: { kind: 'plane', plane: 'origin:front' },
      plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
      points: { pt_1: [0, 0], pt_2: [0, 50], pt_3: [30, 0] },
      entities: [
        { id: 'e_1', kind: 'line', p: ['pt_1', 'pt_2'] },
        { id: 'e_2', kind: 'circle', c: 'pt_3', r: 10 },
      ],
      constraints: [],
      solved: { values: {}, dof: 7, state: 'under' },
    });
    const start = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'normal_to_curve', edge: { kind: 'sketch-curve', sketch: path, entity: 'e_1' }, percent: '0' });
    const quarter = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'normal_to_curve', edge: { kind: 'sketch-curve', sketch: path, entity: 'e_2' }, percent: '25' });
    const pt = add<RefPointFeature>(doc, 'ref_point', { method: 'coordinates', xyz: ['0 mm', '0 mm', '20 mm'] });
    const atPoint = add<RefPlaneFeature>(doc, 'ref_plane', { method: 'normal_to_curve', edge: { kind: 'sketch-curve', sketch: path, entity: 'e_1' }, points: [{ kind: 'feature', feature: pt }] });
    const along = add<RefPointFeature>(doc, 'ref_point', { method: 'on_edge', edge: { kind: 'sketch-curve', sketch: path, entity: 'e_1' }, along: 'distance', distance: '10 mm', fromEnd: true });
    let r = await settle(doc);
    for (const id of [start, quarter, atPoint, along]) expect(r.features[id], id).toMatchObject({ state: 'ok' });
    const f0 = (out(doc, start) as { frame: PlaneFrame }).frame;
    expect(round(f0.origin)).toEqual([0, 0, 0]);
    expect(round(f0.normal)).toEqual([0, 0, 1]);
    const fq = (out(doc, quarter) as { frame: PlaneFrame }).frame;
    expect(round(fq.origin)).toEqual([30, 0, 10]);
    expect(round(fq.normal)).toEqual([-1, 0, 0]);
    expect(round((out(doc, atPoint) as { frame: PlaneFrame }).frame.origin)).toEqual([0, 0, 20]);
    expect(round((out(doc, along) as { p: Vec3 }).p)).toEqual([0, 0, 40]);
    // The sketch uses a CONSTRUCT feature's parents: the path cannot be deleted under the planes.
    expect(doc.removeBlock(path)).toMatch(/Plane/);
    // The path's line made 80 long: the plane at its end... at its start stays, the point 10 mm from its end moves to 70.
    const sk = doc.state.get().doc.features.find((f) => f.id === path) as SketchFeature;
    edit(doc, path, { points: { ...sk.points, pt_2: [0, 80] } } as Partial<Feature>);
    r = await settle(doc);
    expect(round((out(doc, along) as { p: Vec3 }).p)).toEqual([0, 0, 70]);
    // A point off the curve: red with the reason.
    edit(doc, pt, { xyz: ['5 mm', '0 mm', '20 mm'] } as Partial<Feature>);
    r = await settle(doc);
    expect(r.features[atPoint]).toMatchObject({ state: 'error', message: 'Plane 3 failed: Point 1 is not on Line 1 of Sketch 1' });
  });

});
