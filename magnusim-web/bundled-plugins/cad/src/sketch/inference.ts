// Inference while drawing (proposal §2.2 MVP): where the pointer snaps and
// which relations a click adds. Snaps, in order: an existing point (coincident;
// the new end joins it), a line's midpoint (midpoint), an intersection of two
// curves (on both), a curve (on curve); then, from the start of the segment
// being drawn, horizontal, vertical, perpendicular or parallel to the line the
// segment starts on, or tangent to the arc it starts on, and a direction snap
// that ends on a curve takes both. Alignment with another point (dashed guide)
// snaps without a relation. Ctrl held suppresses all of it (Fusion).
// The pick radius is 8 px (proposal §4.7). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, Vec2 } from '../types/doc';
import { add, circleCircle, dist, dot, lineCircle, lineLine, norm, perp, scale, sub } from './geom';
import { arcGeom, closestOn, distanceTo, entityOf, lineEnds, ORIGIN, pointAt } from './model';

export const SNAP_PX = 8;

export type GlyphKind = 'coincident' | 'midpoint' | 'on-curve' | 'intersection' | 'horizontal' | 'vertical' | 'perpendicular' | 'parallel' | 'tangent';

/** Where the new point lands on existing geometry. */
export type Snap =
  | { kind: 'point'; id: string }
  | { kind: 'midpoint'; line: string }
  | { kind: 'curve'; entity: string }
  | { kind: 'intersection'; entities: [string, string] }
  | null;

/** The direction the new segment takes from its start. */
export type DirectionRelation = { kind: 'horizontal' | 'vertical' } | { kind: 'perpendicular' | 'parallel'; line: string } | { kind: 'tangent'; curve: string } | null;

export interface Inference {
  /** The snapped position (mm, u/v). */
  at: Vec2;
  snap: Snap;
  direction: DirectionRelation;
  /** Glyphs to show at the pointer while it is here. */
  glyphs: GlyphKind[];
  /** Dashed guide segments (alignment, direction). */
  guides: [Vec2, Vec2][];
}

export interface InferenceInput {
  f: Pick<SketchFeature, 'points' | 'entities'>;
  /** The pointer on the sketch plane (mm). */
  at: Vec2;
  /** mm per CSS pixel at the sketch. */
  px: number;
  /** The start of the segment being drawn (its point id when it is one). */
  anchor?: { at: Vec2; point: string | null } | null;
  /** Lines/arcs the segment continues from (the previous one in a chain, or those ending at the start point). */
  from?: string[];
  /** Points and entities being drawn now (never snapped to). */
  exclude?: ReadonlySet<string>;
  /** Infer the direction of a straight segment from the anchor. */
  directions?: boolean;
  /** Ctrl held: no inference at all. */
  suppress?: boolean;
}

const DEG = Math.PI / 180;

function isCurve(e: SketchEntity): boolean {
  return e.kind === 'line' || e.kind === 'circle' || e.kind === 'arc';
}

/** Positions on an entity a segment can meet at an intersection (the curves' own, within their extent). */
function intersections(f: InferenceInput['f'], a: SketchEntity, b: SketchEntity): Vec2[] {
  const seg = (e: SketchEntity) => (e.kind === 'line' ? lineEnds(f, e.id) : null);
  const circ = (e: SketchEntity) => {
    if (e.kind === 'circle') {
      const c = pointAt(f, e.c);
      return c ? { c, r: e.r, arc: null } : null;
    }
    if (e.kind === 'arc') {
      const g = arcGeom(f, e);
      return g ? { c: g.c, r: g.r, arc: g } : null;
    }
    return null;
  };
  const onEntity = (e: SketchEntity, p: Vec2) => distanceTo(f, e, p) < 1e-6 * Math.max(1, Math.abs(p[0]) + Math.abs(p[1]));
  const out: Vec2[] = [];
  const sa = seg(a), sb = seg(b), ca = circ(a), cb = circ(b);
  if (sa && sb) {
    const x = lineLine(sa[0], sa[1], sb[0], sb[1]);
    if (x && x.t >= 0 && x.t <= 1 && x.s >= 0 && x.s <= 1) out.push(x.p);
  } else if (sa && cb) {
    for (const x of lineCircle(sa[0], sa[1], cb.c, cb.r)) if (x.t >= 0 && x.t <= 1 && onEntity(b, x.p)) out.push(x.p);
  } else if (ca && sb) {
    for (const x of lineCircle(sb[0], sb[1], ca.c, ca.r)) if (x.t >= 0 && x.t <= 1 && onEntity(a, x.p)) out.push(x.p);
  } else if (ca && cb) {
    for (const p of circleCircle(ca.c, ca.r, cb.c, cb.r)) if (onEntity(a, p) && onEntity(b, p)) out.push(p);
  }
  return out;
}

/** Unit tangent of a line or an arc at one of its ends, pointing away from the entity (the way a chain continues). */
export function tangentAtEnd(f: InferenceInput['f'], e: SketchEntity, pointId: string): Vec2 | null {
  if (e.kind === 'line') {
    const ends = lineEnds(f, e.id);
    if (!ends) return null;
    return e.p[1] === pointId ? norm(sub(ends[1], ends[0])) : e.p[0] === pointId ? norm(sub(ends[0], ends[1])) : null;
  }
  if (e.kind === 'arc') {
    const c = pointAt(f, e.c);
    const p = pointAt(f, pointId);
    if (!c || !p || (pointId !== e.a && pointId !== e.b)) return null;
    const r = sub(p, c);
    const ccw = e.ccw !== false;
    // Travel direction along the arc at p: ccw at the end b continues ccw; at the start a it leaves backwards.
    const along = ccw ? perp(r) : scale(perp(r), -1);
    return norm(pointId === e.b ? along : scale(along, -1));
  }
  return null;
}

export function infer(input: InferenceInput): Inference {
  const { f, at, px } = input;
  const tol = SNAP_PX * px;
  const none: Inference = { at, snap: null, direction: null, glyphs: [], guides: [] };
  if (input.suppress) return none;
  const exclude = input.exclude ?? new Set<string>();

  // 1. Points (the origin, every stored point not being drawn, point entities).
  let best: { id: string; d: number; p: Vec2 } | null = null;
  const consider = (id: string, p: Vec2) => {
    if (exclude.has(id)) return;
    const d = dist(p, at);
    if (d <= tol && (!best || d < best.d)) best = { id, d, p };
  };
  consider(ORIGIN, [0, 0]);
  for (const [id, p] of Object.entries(f.points)) consider(id, p);
  if (best) {
    const b = best as { id: string; d: number; p: Vec2 };
    return { at: [b.p[0], b.p[1]], snap: { kind: 'point', id: b.id }, direction: null, glyphs: ['coincident'], guides: [] };
  }

  const curves = f.entities.filter((e) => isCurve(e) && !exclude.has(e.id));

  // 2. Midpoints of lines.
  let midBest: { line: string; d: number; p: Vec2 } | null = null;
  for (const e of curves) {
    if (e.kind !== 'line') continue;
    const ends = lineEnds(f, e.id);
    if (!ends) continue;
    const m: Vec2 = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
    const d = dist(m, at);
    if (d <= tol && (!midBest || d < midBest.d)) midBest = { line: e.id, d, p: m };
  }
  if (midBest) {
    const m = midBest as { line: string; d: number; p: Vec2 };
    return { at: m.p, snap: { kind: 'midpoint', line: m.line }, direction: null, glyphs: ['midpoint'], guides: [] };
  }

  // 3. Intersections of two curves near the pointer.
  const near = curves.filter((e) => distanceTo(f, e, at) <= tol);
  let xBest: { p: Vec2; d: number; pair: [string, string] } | null = null;
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      for (const p of intersections(f, near[i], near[j])) {
        const d = dist(p, at);
        if (d <= tol && (!xBest || d < xBest.d)) xBest = { p, d, pair: [near[i].id, near[j].id] };
      }
    }
  }
  if (xBest) {
    const x = xBest as { p: Vec2; d: number; pair: [string, string] };
    return { at: x.p, snap: { kind: 'intersection', entities: x.pair }, direction: null, glyphs: ['intersection'], guides: [] };
  }

  // 4. Direction from the anchor (a straight segment being drawn).
  let direction: DirectionRelation = null;
  let dirAt: Vec2 | null = null;
  let dirLine: [Vec2, Vec2] | null = null;
  const anchor = input.anchor ?? null;
  if (anchor && input.directions && dist(anchor.at, at) > tol) {
    const d = sub(at, anchor.at);
    type Cand = { rel: Exclude<DirectionRelation, null>; dir: Vec2; off: number };
    const cands: Cand[] = [];
    const tryDir = (rel: Exclude<DirectionRelation, null>, u: Vec2) => {
      const n = norm(u);
      const along = dot(d, n);
      const off = Math.abs(dot(d, perp(n)));
      if (off <= tol && Math.abs(along) > tol) cands.push({ rel, dir: n, off });
    };
    tryDir({ kind: 'horizontal' }, [1, 0]);
    tryDir({ kind: 'vertical' }, [0, 1]);
    for (const id of input.from ?? []) {
      const e = entityOf(f, id);
      if (!e) continue;
      if (e.kind === 'line') {
        const ends = lineEnds(f, id);
        if (!ends) continue;
        const ld = sub(ends[1], ends[0]);
        // Horizontal / vertical lines already give these directions through H/V.
        const flat = Math.abs(ld[1]) < 1e-9 * Math.abs(ld[0]) || Math.abs(ld[0]) < 1e-9 * Math.abs(ld[1]);
        if (!flat) {
          tryDir({ kind: 'perpendicular', line: id }, perp(ld));
          tryDir({ kind: 'parallel', line: id }, ld);
        }
      } else if (e.kind === 'arc' && anchor.point) {
        const t = tangentAtEnd(f, e, anchor.point);
        if (t) tryDir({ kind: 'tangent', curve: id }, t);
      }
    }
    if (cands.length) {
      cands.sort((a, b) => a.off - b.off);
      const c = cands[0];
      direction = c.rel;
      dirAt = add(anchor.at, scale(c.dir, dot(d, c.dir)));
      dirLine = [anchor.at, dirAt];
    }
  }

  // 5. A curve near the pointer (or near where the direction snap puts it).
  const probe = dirAt ?? at;
  let cBest: { e: SketchEntity; d: number; p: Vec2 } | null = null;
  for (const e of curves) {
    const d = distanceTo(f, e, probe);
    if (d <= tol && (!cBest || d < cBest.d)) {
      const p = closestOn(f, e, probe);
      if (p) cBest = { e, d, p };
    }
  }
  const glyphs: GlyphKind[] = [];
  const guides: [Vec2, Vec2][] = [];
  if (direction && dirAt && dirLine) {
    let p = dirAt;
    let snap: Snap = null;
    if (cBest) {
      // Where the direction line meets that curve, nearest the pointer.
      const c = cBest as { e: SketchEntity; d: number; p: Vec2 };
      const hit = meetAlong(f, c.e, dirLine[0], dirLine[1], probe);
      if (hit && dist(hit, probe) <= tol) {
        p = hit;
        snap = { kind: 'curve', entity: c.e.id };
        glyphs.push('on-curve');
      }
    }
    glyphs.unshift(direction.kind);
    guides.push([dirLine[0], p]);
    return { at: p, snap, direction, glyphs, guides };
  }
  if (cBest) {
    const c = cBest as { e: SketchEntity; d: number; p: Vec2 };
    return { at: c.p, snap: { kind: 'curve', entity: c.e.id }, direction: null, glyphs: ['on-curve'], guides: [] };
  }

  // 6. Alignment with another point (a dashed guide, no relation).
  let au: { p: Vec2; d: number } | null = null;
  let av: { p: Vec2; d: number } | null = null;
  for (const [id, p] of [[ORIGIN, [0, 0] as Vec2], ...Object.entries(f.points)] as [string, Vec2][]) {
    if (exclude.has(id)) continue;
    const du = Math.abs(p[0] - at[0]);
    const dv = Math.abs(p[1] - at[1]);
    if (du <= tol && (!au || du < au.d)) au = { p, d: du };
    if (dv <= tol && (!av || dv < av.d)) av = { p, d: dv };
  }
  const out: Vec2 = [at[0], at[1]];
  if (au) {
    out[0] = (au as { p: Vec2 }).p[0];
  }
  if (av) {
    out[1] = (av as { p: Vec2 }).p[1];
  }
  if (au) guides.push([(au as { p: Vec2 }).p, out]);
  if (av) guides.push([(av as { p: Vec2 }).p, out]);
  return { at: out, snap: null, direction: null, glyphs, guides };
}

/** Where the line through a, b meets an entity's curve, nearest `near` (null when it does not). */
function meetAlong(f: InferenceInput['f'], e: SketchEntity, a: Vec2, b: Vec2, near: Vec2): Vec2 | null {
  if (e.kind === 'line') {
    const ends = lineEnds(f, e.id);
    if (!ends) return null;
    const x = lineLine(a, b, ends[0], ends[1]);
    return x ? x.p : null;
  }
  let c: Vec2 | null = null;
  let r = 0;
  if (e.kind === 'circle') {
    c = pointAt(f, e.c);
    r = e.r;
  } else if (e.kind === 'arc') {
    const g = arcGeom(f, e);
    if (g) {
      c = g.c;
      r = g.r;
    }
  }
  if (!c) return null;
  const hits = lineCircle(a, b, c, r).map((h) => h.p);
  hits.sort((p, q) => dist(p, near) - dist(q, near));
  return hits[0] ?? null;
}

/** Angle tolerance used where a pixel tolerance has no length to work on (tangent arcs). */
export const ANGLE_SNAP = 3 * DEG;
