// Dimensions: what Smart Dimension makes from what was picked (the kind
// follows the pick, and for two points where the label goes: above or below
// them horizontal, beside them vertical, elsewhere aligned), where a
// dimension's lines, arrows and label go (placement math), and the label's
// words ("40", "R10", "⌀20", "30°", driven "(44.72)", an expression "fx: 40").
// Pure functions (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchDimension, SketchDimensionKind, SketchFeature, Vec2 } from '../types/doc';
import type { UnitsService } from '../types/units';
import { add, angleOf, ccwSweep, closestOnLine, dist, dot, lineLine, norm, perp, polar, scale, sub, wrapPi } from './geom';
import { centreOf, entityOf, entityPoints, lineEnds, measureDimension, pointAt, pointIdOf, radiusOf, refKindOf } from './model';

type F = Pick<SketchFeature, 'points' | 'entities'>;

export interface DimensionPlan {
  kind: SketchDimensionKind;
  refs: string[];
  /** What it measures now (mm or deg), positive: the dimension starts here, so nothing jumps. */
  value: number;
}

const DEG = Math.PI / 180;

/** Two points' dimension kind from where the label is (SolidWorks / Fusion placement rule). */
export function linearKindFor(p: Vec2, q: Vec2, at: Vec2 | null): 'distance' | 'distance_x' | 'distance_y' {
  if (!at) return 'distance';
  const minx = Math.min(p[0], q[0]);
  const maxx = Math.max(p[0], q[0]);
  const miny = Math.min(p[1], q[1]);
  const maxy = Math.max(p[1], q[1]);
  const span = Math.max(maxx - minx, maxy - miny, 1e-12);
  const flatX = maxx - minx < 1e-9 * span;
  const flatY = maxy - miny < 1e-9 * span;
  if ((at[1] > maxy || at[1] < miny) && at[0] >= minx && at[0] <= maxx && !flatX) return flatY ? 'distance' : 'distance_x';
  if ((at[0] > maxx || at[0] < minx) && at[1] >= miny && at[1] <= maxy && !flatY) return flatX ? 'distance' : 'distance_y';
  return 'distance';
}

/**
 * Smart Dimension: the dimension the picks ask for (point ids or entity ids, in
 * pick order) with the label at `at`, or why there is none yet.
 */
export function planDimension(f: F, picks: readonly string[], at: Vec2 | null): DimensionPlan | { reason: string } {
  const kinds = picks.map((r) => refKindOf(f, r));
  if (picks.length === 0) return { reason: 'Pick a line, a circle, an arc or two points' };
  if (kinds.some((k) => k === null)) return { reason: 'That is not in the sketch' };
  // P4b (SKETCH): a spline is sized by its points.
  if (kinds.includes('spline')) return { reason: 'A spline takes dimensions on its points: pick its points (or a point and a line)' };
  const pt = (r: string) => pointAt(f, pointIdOf(f, r)!)!;
  const twoPoints = (a: string, b: string): DimensionPlan | { reason: string } => {
    const pa = pt(a);
    const pb = pt(b);
    if (dist(pa, pb) < 1e-9) return { reason: 'Those two points are at the same place' };
    let kind = linearKindFor(pa, pb, at);
    let refs = [pointIdOf(f, a)!, pointIdOf(f, b)!];
    if (kind !== 'distance') {
      const k = kind === 'distance_x' ? 0 : 1;
      if (Math.abs(pb[k] - pa[k]) < 1e-9) kind = 'distance';
      else if (pb[k] < pa[k]) refs = [refs[1], refs[0]];
    }
    const value = measureDimension(f, { kind, refs })!;
    return { kind, refs, value: Math.abs(value) };
  };
  if (picks.length === 1) {
    const [k] = kinds;
    if (k === 'line') {
      const ends = lineEnds(f, picks[0])!;
      const e = entityOf(f, picks[0]);
      if (e?.kind === 'line' && at) {
        const kind = linearKindFor(ends[0], ends[1], at);
        if (kind !== 'distance') return twoPoints(e.p[0], e.p[1]);
      }
      return { kind: 'distance', refs: [picks[0]], value: dist(ends[0], ends[1]) };
    }
    if (k === 'circle') return { kind: 'diameter', refs: [picks[0]], value: 2 * radiusOf(f, picks[0])! };
    if (k === 'arc') return { kind: 'radius', refs: [picks[0]], value: radiusOf(f, picks[0])! };
    return { reason: 'Pick a second point, a line or a circle' };
  }
  if (picks.length > 2) return { reason: 'Smart Dimension takes one or two picks' };
  const [a, b] = picks;
  const [ka, kb] = kinds as string[];
  const isRound = (k: string) => k === 'circle' || k === 'arc';
  if (ka === 'point' && kb === 'point') return twoPoints(a, b);
  if ((ka === 'point' && kb === 'line') || (ka === 'line' && kb === 'point')) {
    const p = ka === 'point' ? a : b;
    const l = ka === 'line' ? a : b;
    const refs = [pointIdOf(f, p)!, l];
    const v = measureDimension(f, { kind: 'distance', refs });
    if (!v || v < 1e-9) return { reason: 'That point lies on the line: dimension it some other way' };
    return { kind: 'distance', refs, value: v };
  }
  if (ka === 'line' && kb === 'line') {
    const la = lineEnds(f, a)!;
    const lb = lineEnds(f, b)!;
    const d1 = sub(la[1], la[0]);
    const d2 = sub(lb[1], lb[0]);
    const s = Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / (Math.hypot(...d1) * Math.hypot(...d2));
    if (s < Math.sin(0.01 * DEG)) {
      const v = measureDimension(f, { kind: 'distance', refs: [a, b] });
      if (!v || v < 1e-9) return { reason: 'Those lines lie on one line' };
      return { kind: 'distance', refs: [a, b], value: v };
    }
    const signed = measureDimension(f, { kind: 'angle', refs: [a, b] })!;
    return signed >= 0 ? { kind: 'angle', refs: [a, b], value: signed } : { kind: 'angle', refs: [b, a], value: -signed };
  }
  if ((ka === 'point' && isRound(kb)) || (isRound(ka) && kb === 'point')) {
    const p = ka === 'point' ? a : b;
    const c = centreOf(f, ka === 'point' ? b : a)!;
    return twoPoints(p, c);
  }
  if (isRound(ka) && isRound(kb)) return twoPoints(centreOf(f, a)!, centreOf(f, b)!);
  if ((ka === 'line' && isRound(kb)) || (isRound(ka) && kb === 'line')) {
    const c = centreOf(f, isRound(ka) ? a : b)!;
    const l = ka === 'line' ? a : b;
    const refs = [c, l];
    const v = measureDimension(f, { kind: 'distance', refs });
    if (!v || v < 1e-9) return { reason: 'That centre lies on the line' };
    return { kind: 'distance', refs, value: v };
  }
  return { reason: 'Pick a line, a circle, an arc or two points' };
}

// ------------------------------------------------------------ placement

export interface DimensionLayout {
  /** Extension and dimension lines (mm, u/v). */
  lines: [Vec2, Vec2][];
  /** Arrow tips and the direction each points (unit). */
  arrows: { at: Vec2; dir: Vec2 }[];
  /** The label's centre. */
  text: Vec2;
}

/**
 * Where a dimension draws, with its label at `at` (the default place when it
 * has none). `px` is mm per CSS pixel: gaps and overshoots are in pixels.
 */
export function layoutDimension(f: F, c: Pick<SketchDimension, 'kind' | 'refs' | 'at'>, px: number, reach?: LabelReach): DimensionLayout | null {
  const gap = 3 * px;
  const over = 6 * px;
  const kinds = c.refs.map((r) => refKindOf(f, r));
  const pt = (r: string) => {
    const id = pointIdOf(f, r);
    return id ? pointAt(f, id) : null;
  };
  const at = c.at ?? defaultLabelAt(f, c, px, reach);
  if (!at) return null;
  switch (c.kind) {
    case 'distance': {
      if (kinds.length === 1 && kinds[0] === 'line') {
        const ends = lineEnds(f, c.refs[0]);
        return ends ? aligned(ends[0], ends[1], at, gap, over) : null;
      }
      if (kinds[0] === 'point' && kinds[1] === 'point') {
        const p = pt(c.refs[0]);
        const q = pt(c.refs[1]);
        return p && q ? aligned(p, q, at, gap, over) : null;
      }
      if (kinds.includes('line') && kinds.includes('point')) {
        const p = pt(c.refs[kinds.indexOf('point')]);
        const ends = lineEnds(f, c.refs[kinds.indexOf('line')]);
        return p && ends ? pointToLine(p, ends, at, gap, over) : null;
      }
      if (kinds[0] === 'line' && kinds[1] === 'line') {
        const a = lineEnds(f, c.refs[0]);
        const b = lineEnds(f, c.refs[1]);
        if (!a || !b) return null;
        const p = closestOnLine(at, a[0], a[1]).p;
        const q = closestOnLine(at, b[0], b[1]).p;
        return { lines: [[p, q]], arrows: arrowsBetween(p, q), text: at };
      }
      return null;
    }
    case 'distance_x':
    case 'distance_y': {
      const k = c.kind === 'distance_x' ? 0 : 1;
      let p: Vec2 | null;
      let q: Vec2 | null;
      if (kinds.length === 1 && kinds[0] === 'line') {
        const ends = lineEnds(f, c.refs[0]);
        p = ends?.[0] ?? null;
        q = ends?.[1] ?? null;
      } else if (kinds.length === 1) {
        p = [0, 0];
        q = pt(c.refs[0]);
      } else {
        p = pt(c.refs[0]);
        q = pt(c.refs[1]);
      }
      if (!p || !q) return null;
      return axisAligned(p, q, at, k, gap, over);
    }
    case 'radius':
    case 'diameter': {
      const cid = centreOf(f, c.refs[0]);
      const ctr = cid ? pointAt(f, cid) : null;
      const r = radiusOf(f, c.refs[0]);
      if (!ctr || r == null) return null;
      let u = sub(at, ctr);
      if (Math.hypot(u[0], u[1]) < 1e-12) u = [1, 0];
      u = norm(u);
      const edge = add(ctr, scale(u, r));
      const beyond = dot(sub(at, ctr), u) > r;
      if (c.kind === 'radius') {
        const lines: [Vec2, Vec2][] = [[ctr, beyond ? at : edge]];
        return { lines, arrows: [{ at: edge, dir: beyond ? scale(u, -1) : u }], text: at };
      }
      const other = sub(ctr, scale(u, r));
      const lines: [Vec2, Vec2][] = [[other, beyond ? at : edge]];
      return { lines, arrows: [{ at: edge, dir: beyond ? scale(u, -1) : u }, { at: other, dir: scale(u, -1) }], text: at };
    }
    case 'angle': {
      let o: Vec2;
      let a1: number;
      let theta: number;
      let a: [Vec2, Vec2];
      let b: [Vec2, Vec2];
      if (kinds.length === 1 && kinds[0] === 'line') {
        // A line's angle from the sketch's horizontal, at its start.
        const ends = lineEnds(f, c.refs[0]);
        if (!ends) return null;
        o = ends[0];
        a1 = 0;
        const d = sub(ends[1], ends[0]);
        theta = Math.atan2(d[1], d[0]);
        a = [o, add(o, [dist(ends[0], ends[1]), 0])];
        b = ends;
      } else {
        if (kinds.length !== 2) return null;
        const la = lineEnds(f, c.refs[0]);
        const lb = lineEnds(f, c.refs[1]);
        if (!la || !lb) return null;
        const x = lineLine(la[0], la[1], lb[0], lb[1]);
        if (!x) return null;
        o = x.p;
        a = la;
        b = lb;
        const d1 = sub(a[1], a[0]);
        const d2 = sub(b[1], b[0]);
        a1 = Math.atan2(d1[1], d1[0]);
        theta = wrapPi(Math.atan2(d2[1], d2[0]) - a1);
      }
      const start = theta >= 0 ? a1 : a1 + theta;
      const sweep = Math.abs(theta);
      const R = Math.max(dist(o, at), 12 * px);
      const lines: [Vec2, Vec2][] = [];
      const n = Math.max(8, Math.ceil((sweep / (Math.PI / 2)) * 16));
      let prev = polar(o, R, start);
      for (let i = 1; i <= n; i++) {
        const cur = polar(o, R, start + (sweep * i) / n);
        lines.push([prev, cur]);
        prev = cur;
      }
      // Extension of each line out to the arc when the arc is beyond it.
      for (const [ends, ang] of [[a, start], [b, start + sweep]] as [[Vec2, Vec2], number][]) {
        const tip = polar(o, R + over, ang);
        const reach = Math.max(dist(o, ends[0]), dist(o, ends[1]));
        if (R > reach) lines.push([polar(o, reach + gap, ang), tip]);
      }
      const s = polar(o, R, start);
      const e = polar(o, R, start + sweep);
      const tangentS: Vec2 = [-Math.sin(start), Math.cos(start)];
      const tangentE: Vec2 = [-Math.sin(start + sweep), Math.cos(start + sweep)];
      return { lines, arrows: [{ at: s, dir: scale(tangentS, -1) }, { at: e, dir: tangentE }], text: at };
    }
  }
}

function arrowsBetween(p: Vec2, q: Vec2): DimensionLayout['arrows'] {
  const d = norm(sub(q, p));
  return [
    { at: p, dir: scale(d, -1) },
    { at: q, dir: d },
  ];
}

/** An aligned linear dimension between p and q, its line through the label. */
export function aligned(p: Vec2, q: Vec2, at: Vec2, gap: number, over: number): DimensionLayout {
  const d = norm(sub(q, p));
  const n = perp(d);
  const off = dot(sub(at, p), n);
  const sgn = off >= 0 ? 1 : -1;
  const pp = add(p, scale(n, off));
  const qq = add(q, scale(n, off));
  const lines: [Vec2, Vec2][] = [];
  if (Math.abs(off) > gap) {
    lines.push([add(p, scale(n, sgn * gap)), add(pp, scale(n, sgn * over))]);
    lines.push([add(q, scale(n, sgn * gap)), add(qq, scale(n, sgn * over))]);
  }
  // The dimension line runs between the extension lines, and on to the label when it sits outside them.
  const s = dot(sub(at, p), d);
  const L = dist(p, q);
  const from = s < 0 ? add(pp, scale(d, s)) : pp;
  const to = s > L ? add(pp, scale(d, s)) : qq;
  lines.push([from, to]);
  return { lines, arrows: arrowsBetween(pp, qq), text: add(pp, scale(d, s)) };
}

/** A horizontal (k = 0) or vertical (k = 1) dimension between p and q, its line through the label. */
export function axisAligned(p: Vec2, q: Vec2, at: Vec2, k: 0 | 1, gap: number, over: number): DimensionLayout {
  const o = 1 - k; // the other axis: where the dimension line sits
  const pp: Vec2 = k === 0 ? [p[0], at[1]] : [at[0], p[1]];
  const qq: Vec2 = k === 0 ? [q[0], at[1]] : [at[0], q[1]];
  const lines: [Vec2, Vec2][] = [];
  for (const [src, foot] of [[p, pp], [q, qq]] as [Vec2, Vec2][]) {
    const span = foot[o] - src[o];
    if (Math.abs(span) > gap) {
      const s = Math.sign(span);
      const a: Vec2 = [...src] as Vec2;
      a[o] += s * gap;
      const b: Vec2 = [...foot] as Vec2;
      b[o] += s * over;
      lines.push([a, b]);
    }
  }
  const lo = Math.min(pp[k], qq[k], at[k]);
  const hi = Math.max(pp[k], qq[k], at[k]);
  const from: Vec2 = [...pp] as Vec2;
  const to: Vec2 = [...pp] as Vec2;
  from[k] = lo;
  to[k] = hi;
  lines.push([from, to]);
  const text: Vec2 = [...pp] as Vec2;
  text[k] = at[k];
  return { lines, arrows: arrowsBetween(pp, qq), text };
}

function pointToLine(p: Vec2, ends: [Vec2, Vec2], at: Vec2, gap: number, over: number): DimensionLayout {
  const foot = closestOnLine(p, ends[0], ends[1]);
  const lines: [Vec2, Vec2][] = [];
  // The line's extension out to the foot when the foot is beyond the segment.
  if (foot.t < 0 || foot.t > 1) {
    const end = foot.t < 0 ? ends[0] : ends[1];
    const d = norm(sub(foot.p, end));
    lines.push([add(end, scale(d, gap)), add(foot.p, scale(d, over))]);
  }
  const lay = aligned(p, foot.p, at, gap, over);
  return { lines: [...lines, ...lay.lines], arrows: lay.arrows, text: lay.text };
}

/** The positions of the points joined (through shared points) to what a dimension measures: its shape. */
function shapePoints(f: F, refs: readonly string[]): Vec2[] {
  const seedPoints = new Set<string>();
  for (const r of refs) {
    const e = entityOf(f, r);
    if (e) for (const p of entityPoints(e)) seedPoints.add(p);
    else if (f.points[r]) seedPoints.add(r);
  }
  const points = new Set<string>();
  const queue = [...seedPoints];
  while (queue.length) {
    const p = queue.pop()!;
    if (points.has(p)) continue;
    points.add(p);
    for (const e of f.entities) {
      const ends = entityPoints(e);
      if (ends.includes(p)) for (const q of ends) if (!points.has(q)) queue.push(q);
    }
  }
  const out: Vec2[] = [];
  for (const id of points) {
    const at = f.points[id];
    if (at) out.push(at);
  }
  return out;
}

/** The gap (px) between a label with no place of its own and what it measures: from the pill's near side. */
export const LABEL_GAP_PX = 10;
/** The least distance (px) from what a dimension measures to its label's centre (a short label's place, as before). */
export const LABEL_OFFSET_PX = 28;

/**
 * How far (mm) a dimension label's edge lies from its centre along a sketch direction `dir`
 * (unit, u/v), for a label standing near `at`: half the pill's extent that way, as the screen
 * shows it. The sketch overlay measures its labels for it; null when it can't tell.
 */
export type LabelReach = (at: Vec2, dir: Vec2) => number | null;

/**
 * How far out from `from` (along `dir`) a label's centre goes: its near side LABEL_GAP_PX from
 * the geometry, whatever its text's width (ci2: Linux's wider DejaVu Sans put the pill of a
 * vertical line's "20 mm" on the line, under the click meant for the line), and never nearer
 * than LABEL_OFFSET_PX. With no reach the label sits LABEL_OFFSET_PX out.
 */
function labelOffset(px: number, from: Vec2, dir: Vec2, reach?: LabelReach): number {
  const r = reach?.(from, dir);
  const half = r != null && Number.isFinite(r) && r > 0 ? r : 0;
  return Math.max(LABEL_OFFSET_PX * px, LABEL_GAP_PX * px + half);
}

/**
 * The point an angle's label hangs off (its vertex), or null for other kinds: a label moved out
 * of another's way moves away from it (review P1), so it stays on its bisector and its gap from
 * both arms only grows.
 */
export function angleVertex(f: F, c: Pick<SketchDimension, 'kind' | 'refs'>): Vec2 | null {
  if (c.kind !== 'angle') return null;
  if (c.refs.length === 1) return lineEnds(f, c.refs[0])?.[0] ?? null;
  const a = lineEnds(f, c.refs[0]);
  const b = lineEnds(f, c.refs[1]);
  if (!a || !b) return null;
  return lineLine(a[0], a[1], b[0], b[1])?.p ?? null;
}

/**
 * An angle's label (review P1, the ci2 gap rule for angles): on the bisector of the angle from
 * `a1` turning `theta` about `o`, at least `r0` out and far enough that its pill's near side is
 * LABEL_GAP_PX from both arms (a 10° line's "10°" sat on the line at 0 px, so a click on the line
 * picked the label). A pill reaching `h` across an arm needs its centre `(gap + h) / sin(theta/2)`
 * out; a narrow angle's label so goes out past the line's end, where the arc and its extension
 * lines reach it. A straight angle (0°) has its label beside the arm, as a length's is.
 */
export function angleLabelAt(o: Vec2, a1: number, theta: number, r0: number, px: number, reach?: LabelReach): Vec2 {
  const half = Math.abs(theta) / 2;
  const bis = a1 + theta / 2;
  const arms: Vec2[] = [
    [-Math.sin(a1), Math.cos(a1)],
    [-Math.sin(a1 + theta), Math.cos(a1 + theta)],
  ];
  const need = (p: Vec2) => Math.max(...arms.map((n) => LABEL_GAP_PX * px + Math.max(0, reach?.(p, n) ?? 0)));
  if (half < 1e-6) {
    const p = polar(o, r0, a1);
    return add(p, scale(arms[0], labelOffset(px, p, arms[0], reach)));
  }
  let r = r0;
  for (let i = 0; i < 4; i++) {
    const want = need(polar(o, r, bis)) / Math.sin(Math.min(half, Math.PI / 2));
    if (want <= r * (1 + 1e-9)) break;
    r = want;
  }
  return polar(o, r, bis);
}

/**
 * Where a new dimension's label goes when it has no place yet: beside what it measures, its
 * pill clear of it (`reach`: how big the pill is; see labelOffset).
 */
export function defaultLabelAt(f: F, c: Pick<SketchDimension, 'kind' | 'refs'>, px: number, reach?: LabelReach): Vec2 | null {
  const off = LABEL_OFFSET_PX * px;
  const kinds = c.refs.map((r) => refKindOf(f, r));
  const pt = (r: string) => {
    const id = pointIdOf(f, r);
    return id ? pointAt(f, id) : null;
  };
  if ((c.kind === 'radius' || c.kind === 'diameter') && c.refs[0]) {
    const cid = centreOf(f, c.refs[0]);
    const ctr = cid ? pointAt(f, cid) : null;
    const r = radiusOf(f, c.refs[0]);
    if (!ctr || r == null) return null;
    const rim = polar(ctr, r, Math.PI / 4);
    return polar(ctr, r + labelOffset(px, rim, [Math.SQRT1_2, Math.SQRT1_2], reach), Math.PI / 4);
  }
  if (c.kind === 'angle' && c.refs.length === 1) {
    const ends = lineEnds(f, c.refs[0]);
    if (!ends) return null;
    const ang = angleOf(ends[0], ends[1]);
    return angleLabelAt(ends[0], 0, ang, Math.max(off, dist(ends[0], ends[1]) * 0.4), px, reach);
  }
  if (c.kind === 'angle') {
    const a = lineEnds(f, c.refs[0]);
    const b = lineEnds(f, c.refs[1]);
    if (!a || !b) return null;
    const x = lineLine(a[0], a[1], b[0], b[1]);
    if (!x) return null;
    const a1 = angleOf([0, 0], sub(a[1], a[0]));
    const theta = wrapPi(angleOf([0, 0], sub(b[1], b[0])) - a1);
    const span = Math.min(dist(a[0], a[1]), dist(b[0], b[1]));
    return angleLabelAt(x.p, a1, theta, Math.max(off, span * 0.4), px, reach);
  }
  let p: Vec2 | null = null;
  let q: Vec2 | null = null;
  if (kinds.length === 1 && kinds[0] === 'line') [p, q] = lineEnds(f, c.refs[0]) ?? [null, null];
  else if (kinds.length === 1) {
    p = [0, 0];
    q = pt(c.refs[0]);
  } else if (kinds.includes('line') && kinds.includes('point')) {
    p = pt(c.refs[kinds.indexOf('point')]);
    const ends = lineEnds(f, c.refs[kinds.indexOf('line')]);
    q = p && ends ? closestOnLine(p, ends[0], ends[1]).p : null;
  } else if (kinds[0] === 'line' && kinds[1] === 'line') {
    const a = lineEnds(f, c.refs[0]);
    const b = lineEnds(f, c.refs[1]);
    p = a ? [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2] : null;
    q = p && b ? closestOnLine(p, b[0], b[1]).p : null;
  } else {
    p = pt(c.refs[0]);
    q = pt(c.refs[1]);
  }
  if (!p || !q) return null;
  const m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  if (c.kind === 'distance_x') {
    const top: Vec2 = [m[0], Math.max(p[1], q[1])];
    return [top[0], top[1] + labelOffset(px, top, [0, 1], reach)];
  }
  if (c.kind === 'distance_y') {
    const right: Vec2 = [Math.max(p[0], q[0]), m[1]];
    return [right[0] + labelOffset(px, right, [1, 0], reach), right[1]];
  }
  const d = sub(q, p);
  const n = norm(perp(d));
  // Outward: away from the middle of the shape it measures (a rectangle's width goes below it, not
  // across its region and glyphs: review P2/P3 round 1), else away from the origin. The shape is
  // what is joined to it, not the whole sketch (round 2: a centre rectangle beside other geometry
  // got its width over its centre point, the sketch's middle lying below it).
  const pts = shapePoints(f, c.refs);
  let side = dot(m, n) >= 0 ? 1 : -1;
  if (pts.length) {
    const c: Vec2 = [pts.reduce((s, x) => s + x[0], 0) / pts.length, pts.reduce((s, x) => s + x[1], 0) / pts.length];
    const away = dot(sub(m, c), n);
    if (Math.abs(away) > 1e-9 * Math.max(1, Math.hypot(d[0], d[1]))) side = away > 0 ? 1 : -1;
  }
  const out = scale(n, side);
  return add(m, scale(out, labelOffset(px, m, out, reach)));
}

// ------------------------------------------------------------ words

/** A plain number in the expression: shown as a value; anything else ("width / 2") as "fx: 40". */
function isLiteral(expr: string): boolean {
  return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*(mm|cm|m|in|ft|deg|rad|°|"|')?\s*$/.test(expr);
}

/** Two decimals at most ("40", "44.72", "0.5"). */
export function formatDimNumber(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * A value (mm / deg) as the sketch shows it, with its display unit next to it (Daniel, 2026-10-06:
 * "it needs to be listed next to the dimension on the sketch itself"): "40 mm", "1.57 in", "30°",
 * "0.52 rad". The same text parses back as typed ("40 mm", "30°").
 */
export function withDisplayUnit(value: number, quantity: 'length' | 'angle', units: Pick<UnitsService, 'units'>): string {
  const u = units.units();
  if (quantity === 'angle') return u.angle === 'rad' ? `${formatDimNumber(value * DEG)} rad` : `${formatDimNumber(value)}°`;
  const per = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[u.length];
  return `${formatDimNumber(value / per)} ${u.length}`;
}

/** The label of a dimension with this value (mm / deg) in the document's display units, unit included ("⌀125 mm", "R10 mm", "(40 mm)", "fx: 40 mm", "30°"). */
export function dimensionLabel(c: Pick<SketchDimension, 'kind' | 'expr' | 'driving'>, value: number, units: Pick<UnitsService, 'units'>): string {
  const v = Math.abs(value);
  let text = withDisplayUnit(v, c.kind === 'angle' ? 'angle' : 'length', units);
  if (c.kind === 'radius') text = `R${text}`;
  if (c.kind === 'diameter') text = `⌀${text}`;
  if (!c.driving) return `(${text})`;
  return isLiteral(c.expr) ? text : `fx: ${text}`;
}

/** The sweep of the angle dimension's arc (for tests and hit areas). */
export function angleSweepDeg(f: F, refs: string[]): number | null {
  const a = lineEnds(f, refs[0]);
  const b = lineEnds(f, refs[1]);
  if (!a || !b) return null;
  return (ccwSweep(angleOf([0, 0], sub(a[1], a[0])), angleOf([0, 0], sub(b[1], b[0]))) * 180) / Math.PI;
}
