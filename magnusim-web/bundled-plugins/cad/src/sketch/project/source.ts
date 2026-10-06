// Reading a link's source (P4b SELECT): the body by id, the face, edge or
// vertex by its persistent name (resolved as every stored reference is: name,
// then signature, nothing repaired silently), and the curves it gives on the
// sketch plane, from the kernel (API 5: `project`, `silhouette`, `section`,
// each with `cubic: true` so a B-spline comes back as the sketch's non-rational
// cubic). A source that is gone gives `lost` with the words the sketch shows
// ("Edge … of flange not found after rebuild"): the sketch still builds
// ("Don't block, just report").
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, FeatureId, PersistentRef, PlaneFrame, SketchLink, SketchLinkSource, Vec2, Vec3 } from '../../types/doc';
import type { KernelAdapter, KernelCallError } from '../../types/kernel';
import type { PlaneCurve as KernelCurve, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames, NamingLookup } from '../../types/naming';
import { describeFace, edgeWords, faceShortWords, kernelLookup, refOfEdge, resolveEdge, resolveFace, resolveVertex, splitEdgeName, splitMerged, splitVertexName, vertexWords } from '../../naming';
import { toPlaneUv, type KeyedCurve, type PlaneCurve } from './curves';

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** What reading a link needs: the bodies as they are before the sketch, the kernel, words. */
export interface LinkEnv {
  kernel: KernelAdapter;
  bodies: ReadonlyMap<BodyId, { shape: ShapeId; names: FaceNames | null }>;
  bodyName(id: BodyId): string;
  featureName(id: FeatureId): string | null;
}

export type LinkRead = { state: 'ok'; curves: KeyedCurve[]; warning?: string } | { state: 'lost'; message: string };

const plainPlane = (p: PlaneFrame): PlaneFrame => ({ origin: [...p.origin] as PlaneFrame['origin'], normal: [...p.normal] as PlaneFrame['normal'], xdir: [...p.xdir] as PlaneFrame['xdir'] });

const polar = (c: Vec2, r: number, deg: number): Vec2 => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];

/** A kernel plane curve as the sketch takes it (an arc by its end points; a B-spline with its ends). */
export function fromKernel(c: KernelCurve): PlaneCurve {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', a: [c.a[0], c.a[1]], b: [c.b[0], c.b[1]] };
    case 'circle':
      return { kind: 'circle', c: [c.c[0], c.c[1]], r: c.r };
    case 'arc':
      return { kind: 'arc', c: [c.c[0], c.c[1]], r: c.r, a: polar(c.c, c.r, c.a0), b: polar(c.c, c.r, c.a1), ccw: c.ccw };
    case 'point':
      return { kind: 'point', p: [c.p[0], c.p[1]] };
    case 'bspline': {
      const n = c.poles.length;
      const a = c.poles[0];
      const b = c.poles[n - 1];
      return { kind: 'bspline', degree: c.degree, poles: c.poles.map((p) => [p[0], p[1]] as Vec2), knots: [...c.knots], mults: [...c.mults], a: [a[0], a[1]], b: [b[0], b[1]], closed: Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9 };
    }
  }
}

// ------------------------------------------------------------ words

/**
 * Words for a link's source, always naming the BODY (P4b fix round 1, polish 5: an import's face read
 * "of Imported 1 (flange.step)" beside "Intersection: flange"): faces by their number on the body, as
 * the Sketch panel's Plane, Measure and Delete faces name them ("Face 3 of flange"), edges and corners
 * by the faces they join ("Edge of Face 3 and Face 7 of flange", "Corner of Face 1, Face 3 and Face 7
 * of flange"), "Silhouette of flange", "Section of flange". `sourceDetail` gives where a face came from.
 */
export function sourceWords(src: SketchLinkSource, env: Pick<LinkEnv, 'bodyName' | 'featureName' | 'bodies'>): string {
  const body = env.bodyName(src.body);
  const faceNames = env.bodies.get(src.body)?.names?.faces ?? null;
  const num = (name: string) => {
    let i = faceNames ? faceNames.indexOf(name) : -1;
    if (i < 0 && faceNames) i = faceNames.findIndex((n) => splitMerged(n).includes(name));
    if (i >= 0) return `Face ${i + 1}`;
    // A face the body no longer has (a lost reference): what its name says it was ("Face 7", "Side 2").
    return faceShortWords(name, faceNames).words || null;
  };
  const faces = (names: string[] | null) => {
    const ws = (names ?? []).map(num);
    return ws.length && ws.every(Boolean) ? (ws as string[]) : null;
  };
  const list = (ws: string[]) => (ws.length <= 2 ? ws.join(' and ') : `${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}`);
  switch (src.kind) {
    case 'edge': {
      const ws = faces(splitEdgeName(src.ref.name));
      return ws ? `Edge of ${list([...new Set(ws)])} of ${body}` : `An edge of ${body}`;
    }
    case 'vertex': {
      const ws = faces(splitVertexName(src.ref.name));
      return ws ? `Corner of ${list([...new Set(ws)])} of ${body}` : `A vertex of ${body}`;
    }
    case 'face': {
      const w = num(src.ref.name);
      return w ? `${w} of ${body}` : `A face of ${body}`;
    }
    case 'silhouette':
      return `Silhouette of ${body}`;
    case 'section':
      return `Section of ${body}`;
    case 'pierce': {
      const ws = faces(splitEdgeName(src.ref.name));
      return ws ? `Where the edge of ${list([...new Set(ws)])} of ${body} pierces the sketch` : `Where an edge of ${body} pierces the sketch`;
    }
  }
}

/** Where a source came from, in the feature's words (a tooltip): "End face of Extrude 1", "End · Side 2 of Extrude 1". */
export function sourceDetail(src: SketchLinkSource, env: Pick<LinkEnv, 'bodyName' | 'featureName' | 'bodies'>): string | null {
  const faceNames = env.bodies.get(src.body)?.names?.faces ?? null;
  const fname = (id: FeatureId) => env.featureName(id);
  if (src.kind === 'face') return describeFace(src.ref.name, fname, faceNames);
  if (src.kind === 'edge' || src.kind === 'pierce') return edgeWords(src.ref.name, fname, faceNames);
  if (src.kind === 'vertex') return vertexWords(src.ref.name, fname, faceNames);
  return null;
}

// ------------------------------------------------------------ reading

/** A cached lookup per body shape (one rebuild may resolve many references on one big body). */
const lookups = new WeakMap<KernelAdapter, { names: FaceNames | null; shape: ShapeId; lookup: NamingLookup }[]>();
export function lookupFor(kernel: KernelAdapter, shape: ShapeId, names: FaceNames | null): NamingLookup {
  let list = lookups.get(kernel);
  if (!list) {
    list = [];
    lookups.set(kernel, list);
  }
  const hit = list.find((x) => x.shape === shape && x.names === names);
  if (hit) return hit.lookup;
  const base = kernelLookup(kernel);
  const all = new Map<string, Promise<unknown>>();
  const memo = <T>(k: string, f: () => Promise<T>): Promise<T> => {
    let p = all.get(k) as Promise<T> | undefined;
    if (!p) {
      p = f();
      p.catch(() => all.delete(k));
      all.set(k, p);
    }
    return p;
  };
  const lookup: NamingLookup = {
    faces: (s, idx) => (idx === 'all' ? memo('f', () => base.faces(s, 'all')) : base.faces(s, idx)),
    edges: (s, idx) => (idx === 'all' ? memo('e', () => base.edges!(s, 'all')) : base.edges!(s, idx)),
    vertices: (s, idx) => (idx === 'all' ? memo('v', () => base.vertices!(s, 'all')) : base.vertices!(s, idx)),
  };
  list.push({ shape, names, lookup });
  if (list.length > 16) list.shift();
  return lookup;
}

function lost(src: SketchLinkSource, env: LinkEnv, why: string): LinkRead {
  return { state: 'lost', message: `${sourceWords(src, env)} ${why}` };
}

/** Project one item (an edge, a vertex, or a face's outer edges) of a shape: its curves with where each came from. */
export async function projectItem(kernel: KernelAdapter, shape: ShapeId, plane: PlaneFrame, item: { edge: number } | { vertex: number } | { face: number }): Promise<{ curves: { curve: PlaneCurve; edge?: number }[]; message?: string }> {
  const r = await kernel.call('project', { plane: plainPlane(plane), items: [{ id: shape, ...item }], cubic: true });
  const it = r.result.items[0];
  return { curves: (it?.curves ?? []).map((c) => ({ curve: fromKernel(c), ...(c.src?.edge != null ? { edge: c.src.edge } : {}) })), ...(it?.message ? { message: it.message } : {}) };
}

/** A face's outer edges projected, keyed by each edge's persistent name. */
export async function projectFace(env: LinkEnv, shape: ShapeId, names: FaceNames | null, plane: PlaneFrame, face: number): Promise<KeyedCurve[] | string> {
  const r = await projectItem(env.kernel, shape, plane, { face });
  if (!r.curves.length) return r.message ?? 'that face gives nothing on the sketch plane';
  const lookup = lookupFor(env.kernel, shape, names);
  // A periodic face (a cylinder, a cone) closes on itself along a seam edge, which its wire runs
  // twice: the seam is not a boundary, so it is not projected (P4b fix round 1, polish 2).
  const idx = [...new Set(r.curves.map((c) => c.edge).filter((e): e is number => e != null))];
  const seams = new Set((idx.length ? await lookup.edges!(shape, idx) : []).filter((e) => e.faces.length >= 1 && e.faces.every((f) => f === face)).map((e) => e.i));
  const once = new Set<number>();
  const out: KeyedCurve[] = [];
  for (const [k, c] of r.curves.entries()) {
    if (c.edge != null && (seams.has(c.edge) || once.has(c.edge))) continue;
    if (c.edge != null) once.add(c.edge);
    let key = `#${k}`;
    if (c.edge != null) {
      try {
        key = (await refOfEdge(lookup, shape, names, c.edge)).name;
      } catch {
        /* an edge with no name keeps its place in the loop */
      }
    }
    if (out.some((o) => o.key === key)) key = `${key}#${k}`;
    out.push({ key, curve: c.curve });
  }
  return out;
}

/** A body's silhouette along the sketch normal (outer loops, then the holes one sees through), keyed c0, c1, ... */
export async function projectSilhouette(env: LinkEnv, shape: ShapeId, plane: PlaneFrame): Promise<KeyedCurve[] | string> {
  const r = await env.kernel.call('silhouette', { plane: plainPlane(plane), ids: [shape], cubic: true });
  if (r.result.empty || !r.result.loops.length) return 'it covers nothing seen along the sketch normal';
  const out: KeyedCurve[] = [];
  let k = 0;
  const loops = [...r.result.loops.filter((l) => !l.hole), ...r.result.loops.filter((l) => l.hole)];
  for (const loop of loops) for (const c of loop.curves) out.push({ key: `c${k++}`, curve: fromKernel(c) });
  return out;
}

/** Where the sketch plane cuts a body, keyed by the face each curve lies on (its persistent name). */
export async function projectSection(env: LinkEnv, shape: ShapeId, names: FaceNames | null, plane: PlaneFrame): Promise<KeyedCurve[]> {
  const r = await env.kernel.call('section', { plane: plainPlane(plane), ids: [shape], cubic: true });
  const out: KeyedCurve[] = [];
  const count = new Map<string, number>();
  for (const loop of r.result.bodies[0]?.loops ?? [])
    for (const c of loop.curves) {
      const f = c.src?.face;
      const base = f != null && names?.faces[f] ? names.faces[f] : 'face';
      const n = count.get(base) ?? 0;
      count.set(base, n + 1);
      out.push({ key: `${base}#${n}`, curve: fromKernel(c) });
    }
  return out;
}

/** Read one link from the bodies as they are now. */
export async function readLink(link: SketchLink, plane: PlaneFrame, env: LinkEnv): Promise<LinkRead> {
  const src = link.source;
  const body = env.bodies.get(src.body);
  if (!body) return { state: 'lost', message: `${sourceWords(src, env)}: ${env.bodyName(src.body)} is not there at this point` };
  try {
    if (src.kind === 'silhouette') {
      const r = await projectSilhouette(env, body.shape, plane);
      return typeof r === 'string' ? lost(src, env, `: ${r}`) : { state: 'ok', curves: r };
    }
    if (src.kind === 'section') {
      const r = await projectSection(env, body.shape, body.names, plane);
      if (!r.length) return { state: 'lost', message: `The sketch plane doesn't cut ${env.bodyName(src.body)}` };
      return { state: 'ok', curves: r };
    }
    if (!body.names) return lost(src, env, `: ${env.bodyName(src.body)} has no face names`);
    const lookup = lookupFor(env.kernel, body.shape, body.names);
    const ref: PersistentRef = src.ref;
    const repaired = (how: string) => (how !== 'name' ? { warning: `${sourceWords(src, env)}: reference repaired · check` } : {});
    if (src.kind === 'vertex') {
      const res = await resolveVertex({ ref, shape: body.shape, names: body.names, lookup });
      if (!res.ok) return lost(src, env, 'not found after rebuild');
      const r = await projectItem(env.kernel, body.shape, plane, { vertex: res.index });
      return r.curves[0] ? { state: 'ok', curves: [{ key: 'v', curve: r.curves[0].curve }], ...repaired(res.how) } : lost(src, env, `: ${r.message ?? 'it cannot be projected'}`);
    }
    if (src.kind === 'pierce') {
      const res = await resolveEdge({ ref, shape: body.shape, names: body.names, lookup });
      if (!res.ok) return lost(src, env, 'not found after rebuild');
      const ev = await env.kernel.call('edge_eval', { id: body.shape, edge: res.index, plane: { origin: [...plane.origin] as Vec3, normal: [...plane.normal] as Vec3 } });
      const xs = ev.result.crossings.map((c) => c.p);
      if (!xs.length) return lost(src, env, ': the edge no longer reaches the sketch plane');
      const near = src.near;
      const best = near ? xs.reduce((a, b) => (dist3(a, near) <= dist3(b, near) ? a : b)) : xs[0];
      return { state: 'ok', curves: [{ key: 'p', curve: { kind: 'point', p: toPlaneUv(plane, best) } }], ...repaired(res.how) };
    }
    if (src.kind === 'edge') {
      const res = await resolveEdge({ ref, shape: body.shape, names: body.names, lookup });
      if (!res.ok) return lost(src, env, 'not found after rebuild');
      const r = await projectItem(env.kernel, body.shape, plane, { edge: res.index });
      return r.curves[0] ? { state: 'ok', curves: [{ key: 'e', curve: r.curves[0].curve }], ...repaired(res.how) } : lost(src, env, `: ${r.message ?? 'it cannot be projected'}`);
    }
    const res = await resolveFace({ ref, shape: body.shape, names: body.names, lookup });
    if (!res.ok) return lost(src, env, 'not found after rebuild');
    const r = await projectFace(env, body.shape, body.names, plane, res.index);
    return typeof r === 'string' ? lost(src, env, `: ${r}`) : { state: 'ok', curves: r, ...repaired(res.how) };
  } catch (err) {
    const e = err as KernelCallError;
    if (e?.kind === 'restarted' || e?.kind === 'watchdog' || e?.kind === 'crash' || e?.kind === 'cancelled') throw err;
    return lost(src, env, `: ${err instanceof Error ? err.message : String(err)}`);
  }
}
