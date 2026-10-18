// Whether a change mirrored a sketch (CAD tools spec §6.9, the flip check): a dimension driven
// through zero turns its geometry over, which the model is warned of (`flipped`), not refused.
// For each sketch whose built output changed, against the output before:
//   - the signed area of each region's outer loop, its points in the loop's order (the tokens'
//     "[p:a>p:b]" ends; a "-" token runs b to a), now and before;
//   - the direction of each signed two-point dimension (distance_x: the sign of q.u - p.u;
//     distance_y: of q.v - p.v). A distance is unsigned (it cannot go through zero, more than 0
//     always), so q - p turning is no flip: an angle (or a parameter of one) turns a line on purpose.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { isDimension } from '../../sketch/model';
import type { FeatureId, SketchFeature, Vec2 } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { SketchOutput } from '../../types/sketch';

/** The sketches' outputs now (keep this before a change; compare after with flippedSketches). */
export function sketchOutputs(s: DocState): Map<FeatureId, SketchOutput> {
  const out = new Map<FeatureId, SketchOutput>();
  for (const f of s.doc.features) {
    const o = s.rebuild.outputs[f.id];
    if (f.type === 'sketch' && o?.type === 'sketch') out.set(f.id, o as SketchOutput);
  }
  return out;
}

/** The start points of a loop's tokens, in order; null when a token does not read "[p:a>p:b]". */
export function loopPoints(loop: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const t of loop) {
    const m = /^([+-]?)[^[]*\[p:([^>\]]+)>p:([^\]]+)\]$/.exec(t);
    if (!m) return null;
    out.push(m[1] === '-' ? m[3] : m[2]);
  }
  return out;
}

function signedArea(ids: readonly string[], points: Readonly<Record<string, Vec2>>): number | null {
  let a = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = points[ids[i]];
    const q = points[ids[(i + 1) % ids.length]];
    if (!p || !q) return null;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** A dimension's two points ([p, q] in its order: two point refs, or a line's ends), or null. */
function twoPoints(f: SketchFeature, refs: readonly string[]): [string, string] | null {
  const pointOf = (r: string) => {
    if (r === 'origin' || f.points[r]) return r;
    const e = f.entities.find((x) => x.id === r);
    return e?.kind === 'point' ? e.p : null;
  };
  if (refs.length === 1) {
    const e = f.entities.find((x) => x.id === refs[0]);
    return e?.kind === 'line' ? [e.p[0], e.p[1]] : null;
  }
  if (refs.length !== 2) return null;
  const p = pointOf(refs[0]);
  const q = pointOf(refs[1]);
  return p && q ? [p, q] : null;
}

/** Whether `f` turned over between `prev` and `now` (its outputs before and after). */
export function sketchFlipped(f: SketchFeature, prev: SketchOutput, now: SketchOutput): boolean {
  const eps = 1e-9;
  for (const r of prev.regions) {
    const ids = r.loops[0] ? loopPoints(r.loops[0]) : null;
    if (!ids || ids.length < 3) continue;
    const a0 = signedArea(ids, prev.points);
    const a1 = signedArea(ids, now.points);
    if (a0 !== null && a1 !== null && Math.abs(a0) > eps && Math.abs(a1) > eps && Math.sign(a0) !== Math.sign(a1)) return true;
  }
  for (const c of f.constraints) {
    if (!isDimension(c) || !c.driving || (c.kind !== 'distance_x' && c.kind !== 'distance_y')) continue;
    const pq = twoPoints(f, c.refs);
    if (!pq) continue;
    const at = (o: SketchOutput, id: string): Vec2 | null => (id === 'origin' ? [0, 0] : (o.points[id] ?? null));
    const [p0, q0, p1, q1] = [at(prev, pq[0]), at(prev, pq[1]), at(now, pq[0]), at(now, pq[1])];
    if (!p0 || !q0 || !p1 || !q1) continue;
    const d0: Vec2 = [q0[0] - p0[0], q0[1] - p0[1]];
    const d1: Vec2 = [q1[0] - p1[0], q1[1] - p1[1]];
    const k = c.kind === 'distance_x' ? 0 : 1;
    if (Math.abs(d0[k]) > eps && Math.abs(d1[k]) > eps && Math.sign(d0[k]) !== Math.sign(d1[k])) return true;
  }
  return false;
}

/** The names of the sketches whose output changed and turned over since `before`. */
export function flippedSketches(before: ReadonlyMap<FeatureId, SketchOutput>, s: DocState): string[] {
  const out: string[] = [];
  for (const f of s.doc.features) {
    if (f.type !== 'sketch') continue;
    const prev = before.get(f.id);
    const now = s.rebuild.outputs[f.id];
    if (!prev || now?.type !== 'sketch' || now === prev) continue;
    if (sketchFlipped(f, prev, now as SketchOutput)) out.push(f.name);
  }
  return out;
}
