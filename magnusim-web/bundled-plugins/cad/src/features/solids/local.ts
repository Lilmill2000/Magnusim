// Build steps of the P4a local operations on one body (Fillet, Chamfer, Shell): the
// body before the feature, its stored edge and face references found on it now (by
// name, then by signature; a miss is the feature's error naming the edge, a repair
// its warning), a face's edges, and words for edges by index.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describeFace, kernelLookup, resolveFace } from '../../naming';
import { edgesOfFace, edgeWords, resolveEdge } from '../../naming/edges';
import { edgeName } from '../../naming/names';
import type { BodyId, PersistentRef } from '../../types/doc';
import type { BuildContext, BuiltBody } from '../../types/doc-service';
import type { ShapeId, TopoResult } from '../../types/kernel-protocol';
import type { NamingLookup } from '../../types/naming';
import type { Step } from './build';

/** A kernel lookup that reads every edge / vertex of a shape once per build. */
export function cachedLookup(ctx: Pick<BuildContext, 'kernel'>): NamingLookup {
  const base = kernelLookup(ctx.kernel);
  const edges = new Map<ShapeId, Promise<TopoResult['edges']>>();
  const verts = new Map<ShapeId, Promise<TopoResult['vertices']>>();
  return {
    faces: base.faces,
    async edges(shape, indices) {
      let all = edges.get(shape);
      if (!all) {
        all = base.edges!(shape, 'all');
        edges.set(shape, all);
      }
      const list = await all;
      return indices === 'all' ? list : list.filter((e) => indices.includes(e.i));
    },
    async vertices(shape, indices) {
      let all = verts.get(shape);
      if (!all) {
        all = base.vertices!(shape, 'all');
        verts.set(shape, all);
      }
      const list = await all;
      return indices === 'all' ? list : list.filter((v) => indices.includes(v.i));
    },
  };
}

/** The body a local operation works on, as built before it. */
export function bodyFor(name: string, id: BodyId | '', ctx: Pick<BuildContext, 'bodies' | 'bodyName'>): Step<BuiltBody> {
  if (!id) return { ok: false, message: `${name} failed: Pick a body` };
  const body = ctx.bodies.get(id);
  if (!body) return { ok: false, message: `${name} failed: ${ctx.bodyName(id)} is not there at this point` };
  if (!body.names) return { ok: false, message: `${name} failed: the faces of ${ctx.bodyName(id)} have no names (the step that made it gave none)` };
  return { ok: true, value: body };
}

/** Every stored edge, and every edge of every stored face, found on the body now (indices, no repeats). */
export async function resolveEdgeSet(name: string, body: BuiltBody, edges: readonly PersistentRef[], faces: readonly PersistentRef[], ctx: Pick<BuildContext, 'kernel' | 'bodyName' | 'featureName'>, lookup: NamingLookup): Promise<Step<{ edges: number[]; warning: string | null }>> {
  const out: number[] = [];
  let warning: string | null = null;
  const fname = (id: string) => ctx.featureName(id);
  const faceNames = body.names?.faces ?? null;
  for (const ref of edges) {
    const r = await resolveEdge({ ref, shape: body.shape, names: body.names!, lookup });
    if (!r.ok) return { ok: false, message: `${name} failed: ${edgeWords(ref.name, fname, faceNames) ?? 'An edge'} not found on ${ctx.bodyName(body.id)} after rebuild` };
    if (r.warning) warning = `${edgeWords(ref.name, fname, faceNames) ?? 'An edge'}: ${r.warning}`;
    if (!out.includes(r.index)) out.push(r.index);
  }
  for (const ref of faces) {
    const r = await resolveFace({ ref, shape: body.shape, names: body.names!, lookup });
    if (!r.ok) return { ok: false, message: `${name} failed: ${describeFace(ref.name, fname, faceNames)} not found on ${ctx.bodyName(body.id)} after rebuild` };
    if (r.warning) warning = `${describeFace(ref.name, fname, faceNames)}: ${r.warning}`;
    for (const e of await edgesOfFace(lookup, body.shape, r.index)) if (!out.includes(e)) out.push(e);
  }
  return { ok: true, value: { edges: out, warning } };
}

/** Edges of a body by index, in words ("End · Side 2 of Extrude 1, Start · Side 1 of Extrude 1"). */
export async function edgeListWords(body: BuiltBody, indices: readonly number[], ctx: Pick<BuildContext, 'featureName'>, lookup: NamingLookup, max = 4): Promise<string> {
  if (!indices.length || !body.names) return 'these edges';
  const all = await lookup.edges!(body.shape, [...indices]);
  const words = all.map((e) => {
    const f = [...new Set(e.faces)];
    const a = body.names!.faces[f[0]];
    const b = body.names!.faces[f.length > 1 ? f[1] : f[0]];
    return a && b ? (edgeWords(edgeName(a, b), (id) => ctx.featureName(id), body.names!.faces) ?? 'an edge') : 'an edge';
  });
  const uniq = [...new Set(words)];
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')} and ${uniq.length - max} more`;
}

/** A length rounded down to two significant digits (a suggestion that surely works: 4.87 -> 4.8). */
export function roundDown(mm: number): number {
  if (!(mm > 0)) return 0;
  const step = Math.pow(10, Math.floor(Math.log10(mm)) - 1);
  return Math.floor(mm / step + 1e-9) * step;
}
