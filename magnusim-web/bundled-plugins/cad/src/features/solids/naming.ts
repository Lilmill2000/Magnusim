// Face names after a local operation on one body (fillet, chamfer, shell; proposal
// §4.5 point 3: "Fillet faces: F:<feat>:fillet:<edgeName>"), from the kernel's
// history against the input body:
//   a face kept or modified from input faces    their name (merged: A|B)
//   a face made from an input edge               F:<feature>:<role>:E:<a>&<b>
//   a face made from an input vertex (a corner)  F:<feature>:<role>:V:<a>&<b>&<c>
//   a face made from an input face (an offset)   F:<feature>:<role>:<that face's name>
//   a face with no history                       F:<feature>:<role>
// and names given to several faces get #k (in face order: stable for one kernel build).
// Null when the input body has no names or the kernel gave no history.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { edgeName, faceName, mergeNames, vertexName } from '../../naming/names';
import type { FeatureId } from '../../types/doc';
import type { KernelAdapter } from '../../types/kernel';
import type { OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';

export async function localOpNames(
  feature: FeatureId,
  role: string,
  result: { faces?: number; history?: OpHistory | null },
  input: { shape: ShapeId; names: FaceNames | null },
  kernel: Pick<KernelAdapter, 'call'>,
): Promise<FaceNames | null> {
  const h = result.history;
  if (typeof result.faces !== 'number' || !h || !input.names) return null;
  const names = input.names.faces;
  const edges = new Set<number>();
  const verts = new Set<number>();
  for (const e of h.faces)
    for (const s of e.from) {
      if (s.shape !== input.shape) continue;
      if (s.edge !== undefined) edges.add(s.edge);
      if (s.vertex !== undefined) verts.add(s.vertex);
    }
  const edgeOf = new Map<number, string | null>();
  const vertOf = new Map<number, string | null>();
  if (edges.size || verts.size) {
    const t = await kernel.call('topo', { id: input.shape, faces: 'none', edges: edges.size ? [...edges] : 'none', vertices: verts.size ? [...verts] : 'none', edge_length: false, vertex_faces: true });
    for (const e of t.result.edges) {
      const f = [...new Set(e.faces)];
      const a = names[f[0]];
      const b = names[f.length > 1 ? f[1] : f[0]];
      edgeOf.set(e.i, a && b ? edgeName(a, b) : null);
    }
    for (const v of t.result.vertices) {
      const fs = (v.faces ?? []).map((i) => names[i]);
      vertOf.set(v.i, fs.length && fs.every(Boolean) ? vertexName([...new Set(fs)]) : null);
    }
  }
  const raw: (string | null)[] = new Array(result.faces).fill(null);
  for (const entry of h.faces) {
    if (entry.out < 0 || entry.out >= result.faces) continue;
    const kept = entry.from.filter((s) => s.how !== 'generated' && s.face !== undefined && s.shape === input.shape);
    if (kept.length) {
      const ns = kept.map((s) => names[s.face!]).filter((n): n is string => !!n);
      if (ns.length) raw[entry.out] = ns.length === 1 ? ns[0] : mergeNames(ns);
      continue;
    }
    const made: string[] = [];
    for (const s of entry.from) {
      if (s.shape !== input.shape) continue;
      let detail: string | null | undefined = null;
      if (s.edge !== undefined) detail = edgeOf.get(s.edge);
      else if (s.vertex !== undefined) detail = vertOf.get(s.vertex);
      else if (s.face !== undefined) detail = names[s.face];
      if (detail) made.push(faceName(feature, role, detail));
    }
    if (made.length) raw[entry.out] = made.length === 1 ? made[0] : mergeNames(made);
  }
  const faces = raw.map((n) => n ?? faceName(feature, role));
  const groups = new Map<string, number[]>();
  faces.forEach((n, i) => groups.set(n, [...(groups.get(n) ?? []), i]));
  for (const [n, list] of groups) if (list.length > 1) list.forEach((i, k) => (faces[i] = `${n}#${k}`));
  return { faces };
}
