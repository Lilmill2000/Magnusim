// Parts for the Assistant's real-kernel tests, made as the person's panels make them (one undo step
// each, through tests/assistant/harness.ts add()):
//   plate   parameters w, d, t; a w x d rectangle on Top centred on the origin; Extrude t (Body 1)
//   fillet  a Fillet of every edge of the plate's top face, radius `radius` (an expression)
// and, for the selector tests, sketches with the ids the tests name their faces by, extrudes of
// their regions, a fillet of an edge, a sketch on a face.
// SPDX-License-Identifier: GPL-3.0-or-later
import { refOfRegion } from '../../src/features/extrude/profiles';
import { pickFace } from '../../src/features/p2/refs';
import { faceFrame } from '../../src/features/sketch/plane';
import { kernelLookup, refOfFace } from '../../src/naming';
import { refOfEdge } from '../../src/naming/edges';
import { ORIGIN_PLANES, type BodyId, type OriginPlaneRef, type PersistentRef, type PlaneFrame, type RegionRef, type SketchEntity, type Vec2, type Vec3 } from '../../src/types/doc';
import type { BodyInfo } from '../../src/types/kernel';
import type { SketchOutput } from '../../src/types/sketch';
import { rectangle, type AssistantHarness } from './harness';

export interface Plate {
  sketch: string;
  extrude: string;
  body: string;
  /** The rectangle's region, as an extrude keeps it. */
  profile: RegionRef;
}

export async function plate(h: AssistantHarness, o: { w?: number; d?: number; t?: number } = {}): Promise<Plate> {
  const w = o.w ?? 60;
  const d = o.d ?? 40;
  const t = o.t ?? 6;
  h.doc.addParam({ name: 'w', expr: `${w} mm`, quantity: 'length' });
  h.doc.addParam({ name: 'd', expr: `${d} mm`, quantity: 'length' });
  h.doc.addParam({ name: 't', expr: `${t} mm`, quantity: 'length' });
  const rect = rectangle(w, d, -w / 2, -d / 2);
  const sketch = await h.add('sketch', { points: rect.points, entities: rect.entities });
  const out = h.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const r = out.regions[0];
  const profile: RegionRef = { sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  const extrude = await h.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: 't' }, op: 'new' });
  const body = h.doc.state.get().rebuild.bodies[0].id;
  return { sketch, extrude, body, profile };
}

/** A Fillet of the plate's top face (all its edges), radius `radius`. */
export async function fillet(h: AssistantHarness, p: Plate, radius: string): Promise<string> {
  const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === p.body)!;
  const index = b.names!.faces.indexOf(`F:${p.extrude}:end`);
  const picked = await pickFace(h.services, b, index, null);
  if (!picked.ok) throw new Error(picked.reason);
  return h.add('fillet', { body: p.body, edges: [], faces: [picked.ref], radius });
}

/** A feature's state now. */
export const stateOf = (h: AssistantHarness, id: string) => h.doc.state.get().rebuild.features[id]?.state ?? null;

/** The Part's undo label now. */
export const undoLabel = (h: AssistantHarness) => h.doc.state.get().history.undoLabel;

/** Sketch geometry with the ids the test chooses (points p_<n> are made as needed). */
export class Shapes {
  points: Record<string, Vec2> = {};
  entities: SketchEntity[] = [];
  private pt(p: Vec2): string {
    for (const [k, v] of Object.entries(this.points)) if (Math.hypot(v[0] - p[0], v[1] - p[1]) < 1e-9) return k;
    const id = `p_${Object.keys(this.points).length + 1}`;
    this.points[id] = p;
    return id;
  }
  line(id: string, a: Vec2, b: Vec2): this {
    this.entities.push({ id, kind: 'line', p: [this.pt(a), this.pt(b)] });
    return this;
  }
  /** Four lines `${id}1`..`${id}4`: bottom, right, top, left. */
  rect(id: string, x0: number, y0: number, x1: number, y1: number): this {
    return this.line(`${id}1`, [x0, y0], [x1, y0])
      .line(`${id}2`, [x1, y0], [x1, y1])
      .line(`${id}3`, [x1, y1], [x0, y1])
      .line(`${id}4`, [x0, y1], [x0, y0]);
  }
  circle(id: string, c: Vec2, r: number): this {
    this.entities.push({ id, kind: 'circle', c: this.pt(c), r });
    return this;
  }
  arc(id: string, c: Vec2, a: Vec2, b: Vec2): this {
    this.entities.push({ id, kind: 'arc', c: this.pt(c), a: this.pt(a), b: this.pt(b) });
    return this;
  }
}

const frameOf = (plane: OriginPlaneRef): PlaneFrame => {
  const p = ORIGIN_PLANES[plane];
  return { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 };
};

/** A sketch named `name` on an origin plane. */
export function sketchOn(h: AssistantHarness, name: string, plane: OriginPlaneRef, s: Shapes): Promise<string> {
  return h.add('sketch', { name, support: { kind: 'plane', plane }, plane: frameOf(plane), points: s.points, entities: s.entities, constraints: [], solved: { values: {}, dof: 1, state: 'under' } });
}

/** A sketch named `name` on flat face `face` of `body` (the frame sketch mode gives it). */
export async function sketchOnFace(h: AssistantHarness, name: string, body: BodyInfo, face: number, s: Shapes): Promise<string> {
  const t = await h.services.kernel.call('topo', { id: body.shape, faces: [face], edges: 'none', vertices: 'none', face_bbox: 'fast', face_mass: true });
  const f = t.result.faces[0];
  const ref: PersistentRef = await refOfFace(kernelLookup(h.services.kernel), body, face);
  return h.add('sketch', { name, support: { kind: 'face', body: body.id, face: ref }, plane: faceFrame(f.normal as Vec3, f.centroid as Vec3), points: s.points, entities: s.entities, constraints: [], solved: { values: {}, dof: 1, state: 'under' } });
}

/** A sketch's region references (all, or those whose sample point `pick` takes). */
export function regions(h: AssistantHarness, sketch: string, pick: (sample: Vec2, area: number) => boolean = () => true): RegionRef[] {
  const out = h.doc.state.get().rebuild.outputs[sketch] as SketchOutput | undefined;
  if (!out || out.type !== 'sketch') throw new Error(`${sketch} did not build`);
  return out.regions.filter((r) => pick(r.sample, r.area)).map((r) => refOfRegion(sketch, r));
}

/** An extrude named `name` of `profiles`, blind `distance` (or another extent), op new unless said. */
export function extrude(h: AssistantHarness, name: string, profiles: RegionRef[], o: { distance?: string; op?: 'new' | 'join' | 'cut' | 'intersect'; flip?: boolean; scope?: BodyId[]; extent?: Record<string, unknown> } = {}): Promise<string> {
  const op = o.op ?? 'new';
  return h.add('extrude', { name, profiles, extent: o.extent ?? { kind: 'blind', distance: o.distance ?? '10 mm' }, flip: o.flip ?? false, op, ...(op === 'new' ? {} : { creates: null, scope: o.scope ?? [] }) });
}

/** The body named `name` as the rebuild shows it. */
export function bodyNamed(h: AssistantHarness, name: string): BodyInfo {
  const b = h.doc.state.get().rebuild.bodies.find((x) => x.name === name);
  if (!b) throw new Error(`no body ${name}: ${h.doc.state.get().rebuild.bodies.map((x) => x.name).join(', ')}`);
  return b;
}

/** The index of the face of `body` whose stored name is `name` (exactly). */
export function faceNamed(body: BodyInfo, name: string): number {
  const i = body.names?.faces.indexOf(name) ?? -1;
  if (i < 0) throw new Error(`no face ${name} on ${body.name}: ${body.names?.faces.join(', ')}`);
  return i;
}

/** A fillet named `name` of the edge of `body` between faces `a` and `b` (stored names). */
export async function filletEdge(h: AssistantHarness, name: string, body: BodyInfo, a: number, b: number, radius = '2 mm'): Promise<string> {
  const t = await h.services.kernel.call('topo', { id: body.shape, faces: 'none', edges: 'all', vertices: 'none', edge_length: true, edge_ends: true });
  const e = t.result.edges.find((x) => new Set(x.faces).size === 2 && x.faces.includes(a) && x.faces.includes(b));
  if (!e) throw new Error('no edge between those faces');
  const ref = await refOfEdge(kernelLookup(h.services.kernel), body, e.i);
  return h.add('fillet', { name, body: body.id, edges: [ref], faces: [], radius });
}
