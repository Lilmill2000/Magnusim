// Edges and vertices of bodies for the CONSTRUCT features: a stored edge or
// vertex reference resolved on its body (SOLIDS' src/naming/edges.ts: by name,
// then by signature, never silently), then what the kernel says it is now: a
// line's ends, a circle's centre and axis (`topo`), a point along it with its
// tangent, where it crosses a plane, the point of it nearest a point
// (`edge_eval`, kernel API 4).
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { kernelLookup } from '../../naming';
import { edgeWords as namingEdgeWords, refOfEdge, refOfVertex, resolveEdge, resolveVertex, vertexWords as namingVertexWords } from '../../naming/edges';
import type { FeatureId, PersistentRef, Vec3 } from '../../types/doc';
import type { BuiltBody } from '../../types/doc-service';
import type { KernelAdapter } from '../../types/kernel';
import type { FaceNames } from '../../types/naming';
import type { Resolved } from './resolve';

export interface EdgeInfo {
  /** Index of the edge on the body's shape now. */
  index: number;
  shape: number;
  type: string;
  length: number;
  first: Vec3;
  last: Vec3;
  closed: boolean;
  mid: Vec3 | null;
  center: Vec3 | null;
  radius: number | null;
  axisDir: Vec3 | null;
}

/** "End · Side 2 of Extrude 1" (the naming layer's words), or "An edge of Body 1". */
export function edgeWords(name: string, featureName: (id: FeatureId) => string | null, bodyName: string | null = null, faceNames: readonly string[] | null = null): string {
  const w = namingEdgeWords(name, featureName, faceNames);
  if (w) return w;
  return bodyName ? `An edge of ${bodyName}` : 'An edge';
}

/** "Corner of End, Side 1 and Side 2 of Extrude 1", or "A vertex of Body 1". */
export function vertexWords(name: string, featureName: (id: FeatureId) => string | null, bodyName: string | null = null, faceNames: readonly string[] | null = null): string {
  const w = namingVertexWords(name, featureName, faceNames);
  if (w) return w;
  return bodyName ? `A vertex of ${bodyName}` : 'A vertex';
}

/** Where along an edge: a fraction of its length (0..1), or a distance (mm) from its start or its end. */
export type EdgeAt = { fraction: number } | { distance: number; fromEnd?: boolean };

/** A point of an edge and the unit tangent there (along the curve's own parameter). */
export async function edgePoint(kernel: KernelAdapter, shape: number, edge: number, at: EdgeAt): Promise<{ point: Vec3; tangent: Vec3; length: number }> {
  if ('fraction' in at) {
    const r = await kernel.call('edge_eval', { id: shape, edge, at: [{ fraction: Math.max(0, Math.min(1, at.fraction)) }] });
    const p = r.result.points[0];
    return { point: p.p, tangent: p.tangent, length: r.result.length };
  }
  let d = at.distance;
  if (at.fromEnd) {
    const len = (await kernel.call('edge_eval', { id: shape, edge })).result.length;
    d = len - d;
  }
  const r = await kernel.call('edge_eval', { id: shape, edge, at: [{ distance: d }] });
  const p = r.result.points[0];
  return { point: p.p, tangent: p.tangent, length: r.result.length };
}

/** Every point where an edge crosses a plane, in order along the edge. */
export async function edgeCrossings(kernel: KernelAdapter, shape: number, edge: number, plane: { origin: Vec3; normal: Vec3 }): Promise<Vec3[]> {
  const r = await kernel.call('edge_eval', { id: shape, edge, plane });
  return (r.result.crossings ?? []).map((c) => c.p);
}

/** The point of an edge nearest `p`, its tangent and how far `p` is from it. */
export async function edgeNearest(kernel: KernelAdapter, shape: number, edge: number, p: Vec3): Promise<{ point: Vec3; tangent: Vec3; distance: number } | null> {
  const r = await kernel.call('edge_eval', { id: shape, edge, near: p });
  const n = r.result.nearest;
  return n ? { point: n.p, tangent: n.tangent, distance: n.distance } : null;
}

/** A stored edge reference on its body, and what the edge is now. */
export async function edgeInfo(kernel: KernelAdapter, body: BuiltBody, ref: PersistentRef, words: () => string, bodyName: string): Promise<Resolved<EdgeInfo>> {
  const lookup = kernelLookup(kernel);
  const r = await resolveEdge({ ref, shape: body.shape, names: body.names!, lookup });
  if (!r.ok) return { ok: false, message: `${words()} not found on ${bodyName} after rebuild` };
  const [e] = await lookup.edges!(body.shape, [r.index]);
  if (!e) return { ok: false, message: `${words()} not found on ${bodyName} after rebuild` };
  const ev = (await kernel.call('edge_eval', { id: body.shape, edge: r.index })).result;
  return {
    ok: true,
    value: {
      index: r.index,
      shape: body.shape,
      type: e.type,
      length: ev.length,
      first: ev.first,
      last: ev.last,
      closed: ev.closed,
      mid: (e.mid as Vec3 | undefined) ?? null,
      center: (e.center as Vec3 | undefined) ?? null,
      radius: e.radius ?? null,
      axisDir: (e.axis_dir as Vec3 | undefined) ?? null,
    },
    ...(r.how !== 'name' ? { warning: `${words()}: ${r.warning ?? 'Reference repaired · check'}` } : {}),
  };
}

/** A stored vertex reference on its body, and where the vertex is now. */
export async function vertexPoint(kernel: KernelAdapter, body: BuiltBody, ref: PersistentRef, words: () => string, bodyName: string): Promise<Resolved<Vec3>> {
  const lookup = kernelLookup(kernel);
  const r = await resolveVertex({ ref, shape: body.shape, names: body.names!, lookup });
  if (!r.ok) return { ok: false, message: `${words()} not found on ${bodyName} after rebuild` };
  const t = await kernel.call('topo', { id: body.shape, faces: 'none', edges: 'none', vertices: [r.index] });
  const v = t.result.vertices.find((x) => x.i === r.index);
  if (!v) return { ok: false, message: `${words()} not found on ${bodyName} after rebuild` };
  return { ok: true, value: [...v.p] as Vec3, ...(r.how !== 'name' ? { warning: `${words()}: ${r.warning ?? 'Reference repaired · check'}` } : {}) };
}

/** The stored reference for edge `index` of a shown body (made at pick time: the re-anchoring point). */
export async function pickEdge(kernel: KernelAdapter, body: { shape: number; names?: FaceNames | null }, index: number): Promise<PersistentRef> {
  if (!body.names) throw new Error('the faces of this body have no names');
  return refOfEdge(kernelLookup(kernel), body.shape, body.names, index);
}

/** The stored reference for vertex `index` of a shown body. */
export async function pickVertex(kernel: KernelAdapter, body: { shape: number; names?: FaceNames | null }, index: number): Promise<PersistentRef> {
  if (!body.names) throw new Error('the faces of this body have no names');
  return refOfVertex(kernelLookup(kernel), body.shape, body.names, index);
}

/** Where a stored edge or vertex reference is on a body now (its index), or null when it is not found. */
export async function resolveIndexOn(kernel: KernelAdapter, kind: 'edge' | 'vertex', shape: number, names: FaceNames, ref: PersistentRef): Promise<number | null> {
  const input = { ref, shape, names, lookup: kernelLookup(kernel) };
  const r = kind === 'edge' ? await resolveEdge(input) : await resolveVertex(input);
  return r.ok ? r.index : null;
}
