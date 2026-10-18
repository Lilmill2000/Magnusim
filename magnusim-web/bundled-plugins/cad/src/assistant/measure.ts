// Exact numbers for the Assistant from the geometry kernel (CAD tools spec §3.2.3, §9.3), on the
// bodies built now. Each function gives the raw numbers (the tool rounds them for the reply; the
// eval's facts read them as they are):
//   bodyFacts    one body: volume, area, centre of mass, bounding box, solids, shells, voids
//                (shells - solids for closed solids; null for a surface body), faces, edges, valid
//                (DocService.measure, which keeps the shells);
//   entityFacts  one face, edge, vertex, point, plane or axis: kernel measure {a} (and topo for a
//                curved face's axis), a point on a face by the selectors' rule (find's point_mm);
//   pairFacts    two targets: kernel measure {a, b} (minimum distance, both points, delta, angle,
//                centre distance);
//   overlapFacts two bodies: their common volume (boolean common, props, release; empty is 0)
//                and their union's solids and voids (boolean fuse, props, release);
//   sectionFacts one body cut by a plane: kernel section, its loops as sketch curves, the regions
//                (sketch_regions); the material is the regions at even depth (outside, then a
//                hole, then an island in the hole...).
// Kernel shapes made here are released before the function returns (unless their worker died
// meanwhile: the next one's ids are its own). A kernel failure is kernel_failed with the
// kernel's words; the caller measures again once when the Part changed meanwhile.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { faceFrame } from '../features/sketch/plane';
import { timeoutFor, timeoutForFaces } from '../kernel/timeouts';
import type { AppServices } from '../types/app';
import type { PlaneFrame, Vec2, Vec3 } from '../types/doc';
import type { BodyInfo, KernelCallError, KernelReply } from '../types/kernel';
import type { BBox, KernelOp, KernelParams, MeasureOne, MeasureTarget, PlaneCurve, ShapeId, SketchCurve } from '../types/kernel-protocol';
import { ToolError } from './errors';
import type { Entity } from './measure-targets';
import { pointOnFace } from './selectors/geometry';
import type { TopoFace } from './selectors/resolve';
import { regionRows } from './sketch/regions';

/** Two bodies closer than this (mm) meet: the replies give lengths to 1e-4 mm. */
export const TOUCH_MM = 5e-5;
/** Most section pieces a reply lists. */
export const SECTION_REGIONS_MAX = 50;
const NO_TRI = { uv: new Float32Array(0), idx: new Uint32Array(0) };

/** A kernel call with the timeout its inputs' size asks for; a failure is kernel_failed with the kernel's words. */
async function kcall<Op extends KernelOp>(services: AppServices, op: Op, params: KernelParams<Op>, what: string, faces = 0): Promise<KernelReply<Op>> {
  try {
    const timeoutMs = timeoutForFaces(op, faces) ?? timeoutFor(op);
    return await services.kernel.call(op, params, { timeoutMs });
  } catch (e) {
    const k = e as KernelCallError;
    const words = e instanceof Error ? e.message : String(e);
    throw new ToolError('kernel_failed', `The geometry kernel could not ${what}: ${words}`, { detail: { op, ...(k?.kind ? { kind: k.kind } : {}) } });
  }
}

/**
 * Free kernel shapes made here while the kernel's worker was the `epoch`-th (its respawn count). A
 * worker that died took them with it, and its successor numbers its own shapes from the start: an
 * old id there may be a body's, so nothing is sent to it.
 */
async function release(services: AppServices, ids: ShapeId[], epoch: number): Promise<void> {
  if (!ids.length || services.kernel.status.get().respawns !== epoch) return;
  try {
    await services.kernel.call('release', { ids });
  } catch {
    // The worker was respawned: its shapes are gone anyway.
  }
}

/** The kernel's target for an entity. */
export function kernelTarget(e: Entity): MeasureTarget {
  switch (e.kind) {
    case 'body':
      return { id: e.body.shape };
    case 'face':
      return { id: e.body.shape, face: e.index };
    case 'edge':
      return { id: e.body.shape, edge: e.index };
    case 'vertex':
      return { id: e.body.shape, vertex: e.index };
    case 'point':
      return { point: [...e.p] };
    case 'plane':
      return { plane: { origin: [...e.frame.origin], normal: [...e.frame.normal] } };
    case 'axis':
      return { axis: { origin: [...e.origin], dir: [...e.dir] } };
  }
}

export interface BodyFacts {
  body: string;
  /** null for a surface body (solids 0): it has no volume. */
  volume: number | null;
  area: number;
  centroid: Vec3 | null;
  bbox: BBox;
  solids: number;
  shells: number;
  /** Sealed inner voids: shells - solids for a body of closed solids; null for a surface body. */
  voids: number | null;
  faces: number;
  edges: number;
  valid: boolean;
}

/** One body's exact properties (DocService.measure: the kernel's, with the shells). */
export async function bodyFacts(services: AppServices, b: BodyInfo): Promise<BodyFacts> {
  let p;
  try {
    p = await services.doc.measure(b.id);
  } catch (e) {
    throw new ToolError('kernel_failed', `The geometry kernel could not measure ${b.name}: ${e instanceof Error ? e.message : String(e)}`, { detail: { body: b.name } });
  }
  const surface = p.solids === 0;
  return {
    body: b.name,
    volume: surface ? null : p.volume,
    area: p.area,
    centroid: p.centroid ? [...p.centroid] : null,
    bbox: [...p.bbox] as BBox,
    solids: p.solids,
    shells: p.shells,
    voids: surface ? null : Math.max(0, p.shells - p.solids),
    faces: p.faces,
    edges: p.edges,
    valid: b.valid,
  };
}

/** One face, edge, vertex, point, plane or axis as the kernel measures it (raw; mm, mm², degrees). */
export interface EntityFacts {
  kind: Entity['kind'];
  type?: string;
  area?: number;
  length?: number;
  radius?: number;
  center?: Vec3;
  normal?: Vec3;
  axis?: { point: Vec3; dir: Vec3 };
  point?: Vec3;
  /** A round edge: the whole circle's length, or the arc's angle. */
  circumference?: number;
  arcDeg?: number;
}

/** A face, edge, vertex, point, plane or axis (a body goes to bodyFacts). */
export async function entityFacts(services: AppServices, e: Exclude<Entity, { kind: 'body' }>): Promise<EntityFacts> {
  // The reference geometry is what it says: no kernel call.
  if (e.kind === 'point') return { kind: 'point', point: [...e.p] };
  if (e.kind === 'plane') return { kind: 'plane', point: [...e.frame.origin], normal: [...e.frame.normal] };
  if (e.kind === 'axis') return { kind: 'axis', axis: { point: [...e.origin], dir: [...e.dir] } };
  const faces = e.body.faces;
  const r = await kcall(services, 'measure', { a: kernelTarget(e) }, `measure ${e.words}`, faces);
  const one: MeasureOne = r.result.a;
  const out: EntityFacts = { kind: e.kind };
  if (one.type) out.type = one.type;
  if (e.kind === 'face') {
    if (typeof one.area === 'number') out.area = one.area;
    if (typeof one.radius === 'number') out.radius = one.radius;
    if (one.center) out.center = [...one.center];
    let axis: { origin: Vec3; dir: Vec3 } | undefined;
    if (one.type === 'plane' && one.dir) out.normal = [...one.dir];
    else if (one.dir) {
      // A curved face's axis runs through the point topo gives (its centroid may lie off the axis).
      const topo = await kcall(services, 'topo', { id: e.body.shape, faces: [e.index], edges: 'none', vertices: 'none', face_bbox: 'none', face_mass: false }, `read ${e.words}`, faces);
      const f = topo.result.faces.find((x) => x.i === e.index) ?? topo.result.faces[0];
      axis = f?.axis ? { origin: [...f.axis.origin], dir: [...f.axis.dir] } : undefined;
      out.axis = { point: f?.axis ? [...f.axis.origin] : out.center ? [...out.center] : [0, 0, 0], dir: [...one.dir] };
    }
    // A point on the face by the selectors' rule (find's point_mm): on its plane or cylinder.
    const p = e.body.tess ? pointOnFace(e.body.tess, e.index, { type: (one.type ?? 'other') as TopoFace['type'], normal: out.normal, centroid: out.center ?? null, axis, radius: out.radius }) : null;
    if (p) out.point = p;
    return out;
  }
  if (e.kind === 'edge') {
    if (typeof one.length === 'number') out.length = one.length;
    if (typeof one.radius === 'number') out.radius = one.radius;
    if (one.center) out.center = [...one.center];
    if (one.point) out.point = [...one.point];
    if (one.dir) out.axis = { point: one.center ? [...one.center] : one.point ? [...one.point] : [0, 0, 0], dir: [...one.dir] };
    if (one.type === 'circle' && typeof one.radius === 'number' && one.radius > 0 && typeof one.length === 'number') {
      const full = 2 * Math.PI * one.radius;
      if (Math.abs(one.length - full) <= 1e-6 * Math.max(1, full)) out.circumference = one.length;
      else out.arcDeg = ((one.length / one.radius) * 180) / Math.PI;
    }
    return out;
  }
  if (one.point) out.point = [...one.point];
  return out;
}

export interface PairFacts {
  distance: number;
  p1: Vec3;
  p2: Vec3;
  delta: Vec3;
  angleDeg?: number;
  parallel?: boolean;
  centerDistance?: number;
}

/** Two targets: the minimum distance, where it is reached, the angle and the centre distance. */
export async function pairFacts(services: AppServices, a: Entity, b: Entity): Promise<PairFacts> {
  const faces = ('body' in a ? a.body.faces : 0) + ('body' in b ? b.body.faces : 0);
  const r = (await kcall(services, 'measure', { a: kernelTarget(a), b: kernelTarget(b) }, `measure ${a.words} against ${b.words}`, faces)).result;
  const out: PairFacts = {
    distance: r.distance ?? 0,
    p1: r.p1 ? [...r.p1] : [0, 0, 0],
    p2: r.p2 ? [...r.p2] : [0, 0, 0],
    delta: r.delta ? [...r.delta] : [0, 0, 0],
  };
  if (typeof r.angle_deg === 'number') out.angleDeg = r.angle_deg;
  if (typeof r.parallel === 'boolean') out.parallel = r.parallel;
  if (typeof r.center_distance === 'number') out.centerDistance = r.center_distance;
  return out;
}

export interface OverlapFacts {
  /** The volume the two bodies share (0: no interference); null when one is a surface body. */
  overlap: number | null;
  /** Solids and sealed voids of the two joined; null when one is a surface body. */
  unionSolids: number | null;
  unionVoids: number | null;
  /** Why the numbers are null, or absent. */
  note?: string;
}

/**
 * Two bodies' interference and their union (§9.3): boolean common then props {volume} (an empty
 * result is 0), boolean fuse then props (solids, shells). The bodies never change (the kernel works
 * on copies); the shapes made here are released.
 */
export async function overlapFacts(services: AppServices, a: BodyInfo, b: BodyInfo, solids: { a: number; b: number }): Promise<OverlapFacts> {
  if (solids.a === 0 || solids.b === 0) {
    const s = solids.a === 0 ? a.name : b.name;
    return { overlap: null, unionSolids: null, unionVoids: null, note: `${s} is a surface body (an open shell): it has no volume to overlap` };
  }
  const faces = a.faces + b.faces;
  const made: ShapeId[] = [];
  const epoch = services.kernel.status.get().respawns;
  try {
    const common =(await kcall(services, 'boolean', { op: 'common', targets: [a.shape], tools: [b.shape], keep_tools: true }, `intersect ${a.name} with ${b.name}`, faces)).result;
    made.push(common.id);
    let overlap = 0;
    if (!common.empty) {
      const p = (await kcall(services, 'props', { id: common.id, volume: true, bbox: 'none' }, `measure what ${a.name} and ${b.name} share`, faces)).result;
      overlap = Math.max(0, p.volume ?? 0);
    }
    const fuse = (await kcall(services, 'boolean', { op: 'fuse', targets: [a.shape], tools: [b.shape], keep_tools: true }, `join ${a.name} and ${b.name}`, faces)).result;
    made.push(fuse.id);
    const u = (await kcall(services, 'props', { id: fuse.id, bbox: 'none' }, `count the pieces of ${a.name} and ${b.name} joined`, faces)).result;
    return { overlap, unionSolids: u.solids, unionVoids: u.solids > 0 ? Math.max(0, u.shells - u.solids) : null };
  } finally {
    await release(services, made, epoch);
  }
}

/** A section loop's curve as a sketch curve (ids s0, s1, ...); a point is no curve. */
function sketchCurveOf(c: PlaneCurve, id: string): SketchCurve | null {
  switch (c.kind) {
    case 'line':
      return { id, kind: 'line', a: [...c.a] as Vec2, b: [...c.b] as Vec2 };
    case 'arc':
      return { id, kind: 'arc', c: [...c.c] as Vec2, r: c.r, a0: c.a0, a1: c.a1, ccw: c.ccw };
    case 'circle':
      return { id, kind: 'circle', c: [...c.c] as Vec2, r: c.r };
    case 'bspline':
      return { id, kind: 'bspline', degree: c.degree, poles: c.poles.map((p) => [...p] as Vec2), knots: [...c.knots], mults: [...c.mults], ...(c.weights ? { weights: [...c.weights] } : {}) };
    default:
      return null;
  }
}

export interface SectionFacts {
  plane: PlaneFrame;
  /** The material's area in the plane (mm²): the regions at even depth. */
  area: number;
  /** Closed loops the plane cuts (outer boundaries and holes). */
  loops: number;
  /** Holes in the material (inner loops of its pieces). */
  holes: number;
  /** Loops left open (a surface body, or a cut along an edge). */
  open: number;
  /** Each piece of material, largest first. */
  regions: { area: number; holes: number }[];
}

/** One body cut by `plane`: the material's area, its loops, holes and pieces (a plane that misses gives area 0). */
export async function sectionFacts(services: AppServices, b: BodyInfo, plane: PlaneFrame): Promise<SectionFacts> {
  const frame: PlaneFrame = { origin: [...plane.origin], normal: [...plane.normal], xdir: [...plane.xdir] };
  const cut = (await kcall(services, 'section', { plane: frame, ids: [b.shape] }, `cut ${b.name}`, b.faces)).result;
  const loops = cut.bodies[0]?.loops ?? [];
  const curves: SketchCurve[] = [];
  let open = 0;
  for (const loop of loops) {
    if (!loop.closed) open++;
    for (const c of loop.curves) {
      const sc = sketchCurveOf(c, `s${curves.length}`);
      if (sc) curves.push(sc);
    }
  }
  const closed = loops.length - open;
  if (!curves.length) return { plane: frame, area: 0, loops: 0, holes: 0, open, regions: [] };
  const found = (await kcall(services, 'sketch_regions', { plane: frame, curves, tess: false }, `find the regions of the cut through ${b.name}`, b.faces)).result;
  // The rows' order and depth (no triangles were asked for).
  const rows = regionRows({ regions: found.regions.map((r) => ({ ...r, tri: NO_TRI })) });
  const raw = new Map(found.regions.map((r) => [r.key, r]));
  const material = rows.filter((r) => r.depth % 2 === 0);
  const regions = material.map((r) => ({ area: raw.get(r.key)?.area ?? r.area_mm2, holes: r.holes }));
  return {
    plane: frame,
    area: regions.reduce((sum, r) => sum + r.area, 0),
    loops: closed,
    holes: regions.reduce((sum, r) => sum + r.holes, 0),
    open,
    regions,
  };
}

/** A flat face's plane, framed as a sketch on it would be (§5.7); a curved face is bad_section. */
export async function planeOfFace(services: AppServices, e: Extract<Entity, { kind: 'face' }>): Promise<PlaneFrame> {
  const r = await kcall(services, 'measure', { a: kernelTarget(e) }, `measure ${e.words}`, e.body.faces);
  const one = r.result.a;
  if (one.type !== 'plane' || !one.dir || !one.center) {
    throw new ToolError('bad_section', `section: ${e.words} is not flat (${one.type ?? 'unknown'}); the section needs a plane or a flat face.`, { detail: { field: 'section' } });
  }
  return faceFrame([...one.dir] as Vec3, [...one.center] as Vec3);
}
