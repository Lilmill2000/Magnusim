// A Part on the real kernel with the P4a solids registered, and the steps the
// solids' tests take as a user would: a sketch of lines / arcs / circles on a plane
// or a face (stored geometry), its regions' references, picks of faces, edges and
// vertices (the same helpers the panels use), and volumes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from 'vitest';
import { chamferDef } from '../../../src/features/chamfer/def';
import { refOfRegion } from '../../../src/features/extrude/profiles';
import { filletDef } from '../../../src/features/fillet/def';
import { loftDef } from '../../../src/features/loft/def';
import { pickFace } from '../../../src/features/p2/refs';
import { revolveDef } from '../../../src/features/revolve/def';
import { shellDef } from '../../../src/features/shell/def';
import { faceFrame } from '../../../src/features/sketch/plane';
import { sweepDef } from '../../../src/features/sweep/def';
import { kernelLookup } from '../../../src/naming';
import { refOfEdge, refOfVertex } from '../../../src/naming/edges';
import { ORIGIN_PLANES, type BodyId, type Feature, type OriginPlaneRef, type PersistentRef, type PlaneFrame, type RegionRef, type SketchEntity, type SketchFeature, type Vec2, type Vec3 } from '../../../src/types/doc';
import type { FeatureTypeDef } from '../../../src/types/doc-service';
import type { BodyInfo } from '../../../src/types/kernel';
import type { TopoResult } from '../../../src/types/kernel-protocol';
import { registerSolidFeatures } from '../../doc/blocks';
import { openRealDoc, settle, type RealDoc } from '../p2/real-doc';

export { settle };

export const SOLID_DEFS = [revolveDef, sweepDef, loftDef, filletDef, chamferDef, shellDef];

export async function openSolids(opts: { folder?: RealDoc['folder'] } = {}): Promise<RealDoc> {
  const r = await openRealDoc(opts);
  registerSolidFeatures(r.doc);
  for (const d of SOLID_DEFS) if (!r.doc.features.get(d.type)) r.doc.features.register(d as unknown as FeatureTypeDef);
  return r;
}

/** Sketch geometry from a list of drawn things (ids e_<n>, points p_<n>). */
export class SketchBuilder {
  points: Record<string, Vec2> = {};
  entities: SketchEntity[] = [];
  private n = 0;
  private pt(p: Vec2): string {
    for (const [k, v] of Object.entries(this.points)) if (Math.hypot(v[0] - p[0], v[1] - p[1]) < 1e-9) return k;
    const id = `p_${Object.keys(this.points).length + 1}`;
    this.points[id] = p;
    return id;
  }
  line(a: Vec2, b: Vec2, o: { centerline?: boolean; construction?: boolean } = {}): string {
    const id = `e_${++this.n}`;
    this.entities.push({ id, kind: 'line', p: [this.pt(a), this.pt(b)], ...(o.centerline ? { centerline: true } : {}), ...(o.construction ? { construction: true } : {}) });
    return id;
  }
  rect(x0: number, y0: number, x1: number, y1: number): string[] {
    return [this.line([x0, y0], [x1, y0]), this.line([x1, y0], [x1, y1]), this.line([x1, y1], [x0, y1]), this.line([x0, y1], [x0, y0])];
  }
  circle(c: Vec2, r: number): string {
    const id = `e_${++this.n}`;
    this.entities.push({ id, kind: 'circle', c: this.pt(c), r });
    return id;
  }
  /** An arc about c from a to b, counter-clockwise unless ccw is false. */
  arc(c: Vec2, a: Vec2, b: Vec2, ccw = true): string {
    const id = `e_${++this.n}`;
    this.entities.push({ id, kind: 'arc', c: this.pt(c), a: this.pt(a), b: this.pt(b), ...(ccw ? {} : { ccw: false }) });
    return id;
  }
}

export function onPlane(plane: OriginPlaneRef, b: SketchBuilder): Partial<SketchFeature> {
  const p = ORIGIN_PLANES[plane];
  return { support: { kind: 'plane', plane }, plane: { origin: [...p.origin], normal: [...p.normal], xdir: [...p.xdir] } as PlaneFrame, points: b.points, entities: b.entities, constraints: [], solved: { values: {}, dof: 1, state: 'under' } };
}

/** Add a sketch (one undo step) and wait for it to build. */
export async function addSketch(r: RealDoc, init: Partial<SketchFeature>): Promise<string> {
  const s = r.doc.beginNew('sketch', init as Partial<Feature>);
  s.commit();
  await settle(r.doc);
  return s.feature;
}

/** The references of a sketch's regions: all of them, or the ones whose sample point `pick` accepts. */
export function regionsOf(r: RealDoc, sketch: string, pick: (sample: Vec2, area: number) => boolean = () => true): RegionRef[] {
  const out = r.doc.state.get().rebuild.outputs[sketch];
  if (!out || out.type !== 'sketch') throw new Error(`${sketch} did not build`);
  return out.regions.filter((g) => pick(g.sample, g.area)).map((g) => refOfRegion(sketch, g));
}

/** Add a feature with `init` (one panel session, committed) and wait for the rebuild. */
export async function addFeature(r: RealDoc, type: Feature['type'], init: Record<string, unknown>) {
  const s = r.doc.beginNew(type, init as Partial<Feature>);
  const id = s.feature;
  s.commit();
  const rb = await settle(r.doc);
  return { id, rb, status: rb.features[id] };
}

export function body(r: RealDoc, i = 0): BodyInfo {
  const b = r.doc.state.get().rebuild.bodies[i];
  if (!b) throw new Error(`no body ${i}`);
  return b;
}

export async function volume(r: RealDoc, id: BodyId): Promise<number> {
  return (await r.doc.measure(id)).volume;
}

export async function topo(r: RealDoc, b: BodyInfo): Promise<TopoResult> {
  return (await r.kernel.call('topo', { id: b.shape, face_bbox: 'fast', edge_ends: true, vertex_faces: true })).result;
}

export async function faceRef(r: RealDoc, b: BodyInfo, i: number): Promise<PersistentRef> {
  const p = await pickFace(r.services, b, i, null);
  if (!p.ok) throw new Error(p.reason);
  return p.ref;
}

export async function edgeRef(r: RealDoc, b: BodyInfo, i: number): Promise<PersistentRef> {
  return refOfEdge(kernelLookup(r.kernel), b.shape, b.names ?? null, i);
}

export async function vertexRef(r: RealDoc, b: BodyInfo, i: number): Promise<PersistentRef> {
  return refOfVertex(kernelLookup(r.kernel), b.shape, b.names ?? null, i);
}

/** A sketch on a flat face of a body (the frame the sketch would take). */
export async function onFace(r: RealDoc, b: BodyInfo, face: number, sk: SketchBuilder): Promise<Partial<SketchFeature>> {
  const t = await topo(r, b);
  const f = t.faces.find((x) => x.i === face)!;
  expect(f.type).toBe('plane');
  return { support: { kind: 'face', body: b.id, face: await faceRef(r, b, face) }, plane: faceFrame(f.normal as Vec3, f.centroid as Vec3), points: sk.points, entities: sk.entities, constraints: [], solved: { values: {}, dof: 1, state: 'under' } };
}

export const close = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
