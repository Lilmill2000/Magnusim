// The CONSTRAIN commands (select first, then the command): which picks each
// relation takes, the references in the solver's order, and the reason it
// cannot apply to the selection ("Select two lines"). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, SketchRelationKind, Vec2 } from '../types/doc';
import { arcGeom, centreOf, entityEnds, entityLabel, entityOf, entityPoints, isDimension, lineEnds as lineEndsOf, ORIGIN, pointAt, pointIdOf, radiusOf, refKindOf, type RefKind } from './model';
// P4b (SKETCH): splines.
import { splineOf } from './tools/spline-entity';

type F = Pick<SketchFeature, 'points' | 'entities'>;

/** One relation to add: kind, references (solver order), and a fix's locked position. */
export interface RelationPlan {
  kind: SketchRelationKind;
  refs: string[];
  value?: Vec2;
  /**
   * P4b (SKETCH): what a spline needs first: `handle`, a fit spline's tangent handle at that end
   * (where the curve's direction is now) before Tangent.
   */
  handle?: { spline: string; end: 0 | 1; at: Vec2 };
}

/** The relations the command adds for these picks, or why it cannot. */
export type ConstraintOutcome = { ok: true; add: RelationPlan[] } | { ok: false; reason: string };

/** The CONSTRAIN commands in toolbar order with what each needs (the reason shown when the selection does not fit). */
export const CONSTRAIN_COMMANDS: { kind: SketchRelationKind; label: string; needs: string }[] = [
  { kind: 'coincident', label: 'Coincident', needs: 'Select two points, or a point and a curve' },
  { kind: 'horizontal', label: 'Horizontal', needs: 'Select lines, or two points' },
  { kind: 'vertical', label: 'Vertical', needs: 'Select lines, or two points' },
  { kind: 'parallel', label: 'Parallel', needs: 'Select two lines' },
  { kind: 'perpendicular', label: 'Perpendicular', needs: 'Select two lines' },
  { kind: 'tangent', label: 'Tangent', needs: 'Select a line or an arc and a circle or an arc' },
  { kind: 'equal', label: 'Equal', needs: 'Select lines, or circles and arcs' },
  { kind: 'midpoint', label: 'Midpoint', needs: 'Select a point and a line' },
  { kind: 'symmetric', label: 'Symmetric', needs: 'Select two points and the line they are symmetric about, or two lines or two circles and a centerline' },
  { kind: 'concentric', label: 'Concentric', needs: 'Select two circles or arcs' },
  { kind: 'collinear', label: 'Collinear', needs: 'Select two lines' },
  { kind: 'fix', label: 'Fix', needs: 'Select points or curves to fix' },
];

/** The same references, in any order. */
export const sameRefs = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const ON_CURVE = new Set<string>(['point_on_line', 'point_on_circle']);

/** Whether the sketch has this record (Coincident of a point and a curve is also stored as On line / On curve). */
export function hasRelation(f: Pick<SketchFeature, 'constraints'>, r: Pick<RelationPlan, 'kind' | 'refs'>): boolean {
  return f.constraints.some((c) => {
    if (isDimension(c)) return false;
    const kindOk = c.kind === r.kind || (r.kind === 'coincident' && r.refs.length === 2 && ON_CURVE.has(c.kind)) || (ON_CURVE.has(r.kind) && c.kind === 'coincident');
    if (!kindOk) return false;
    if (r.kind === 'symmetric') return c.refs.length === 3 && c.refs[2] === r.refs[2] && sameRefs(c.refs.slice(0, 2), r.refs.slice(0, 2));
    return sameRefs(c.refs, r.refs);
  });
}

/**
 * How near counts as one place, or as nothing, after a relation is solved, as a part of the
 * sketch's extent: the solver stops within its tolerance, so a relation that can only hold by
 * shrinking a line leaves it a few ten-thousandths long, not zero (Perpendicular on a rectangle's
 * opposite sides left a 0.00035 mm line in a 40 mm sketch).
 */
const RELATION_TOL = 1e-4;

function extentOf(f: F): number {
  let scale = 1;
  for (const p of Object.values(f.points)) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  return scale;
}

/** A curve a relation's solution shrinks to (next to) nothing: the reason it is refused, or null. */
export function curvesCollapsed(before: F, after: F): string | null {
  const tiny = RELATION_TOL * extentOf(before);
  const size = (f: F, id: string): number | null => {
    const e = entityOf(f, id);
    if (e?.kind === 'line') {
      const ends = lineEndsOf(f, id);
      return ends ? Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) : null;
    }
    return e?.kind === 'circle' || e?.kind === 'arc' ? radiusOf(f, id) : null;
  };
  for (const e of after.entities) {
    const [a, b] = [size(after, e.id), size(before, e.id)];
    if (a != null && b != null && a <= tiny && b > tiny) return `would shrink ${entityLabel(after, e.id)} to nothing`;
  }
  return null;
}

/**
 * Review (relations lane): a relation whose solution puts two of its curves on top of each other
 * (Tangent on concentric circles makes one circle of two) is no relation the person wants: the
 * reason it is refused, or null. Curves already on top of each other before are left alone.
 */
export function curvesMerged(before: F, after: F, ids: readonly string[], opts: { coradial?: boolean } = {}): string | null {
  const tol = RELATION_TOL * extentOf(before);
  const near = (a: Vec2 | null, b: Vec2 | null) => !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const onTop = (f: F, x: string, y: string): boolean => {
    const [a, b] = [entityOf(f, x), entityOf(f, y)];
    if (!a || !b) return false;
    if (a.kind === 'line' && b.kind === 'line') {
      const [a0, a1, b0, b1] = [...a.p, ...b.p].map((id) => pointAt(f, id));
      return (near(a0, b0) && near(a1, b1)) || (near(a0, b1) && near(a1, b0));
    }
    const ra = radiusOf(f, x);
    const rb = radiusOf(f, y);
    if (ra == null || rb == null) return false;
    const [ca, cb] = [centreOf(f, x), centreOf(f, y)];
    if (!(!!ca && !!cb && near(pointAt(f, ca), pointAt(f, cb)) && Math.abs(ra - rb) <= tol)) return false;
    // Integration review: an arc on a circle's path, or two arcs of one circle side by side, is
    // coradial (an arc on a pitch circle), not one curve on another: only two full circles, or
    // two arcs whose spans overlap, are. But a relation that can only hold by making its curves
    // coradial (`coradial`: Tangent of curves with one centre, which the solver meets with equal
    // radii, so the arc lies on the circle and "touches" it everywhere) is refused for any.
    if (opts.coradial) return true;
    if (a.kind === 'circle' && b.kind === 'circle') return true;
    if (a.kind !== 'arc' || b.kind !== 'arc') return false;
    const [ga, gb] = [arcGeom(f, a), arcGeom(f, b)];
    return !!ga && !!gb && spansOverlap(ga.a0, ga.sweep, gb.a0, gb.sweep);
  };
  const curves = [...new Set(ids)].filter((id) => {
    const k = entityOf(after, id)?.kind;
    return k === 'line' || k === 'circle' || k === 'arc';
  });
  for (let i = 0; i < curves.length; i++)
    for (let j = i + 1; j < curves.length; j++) {
      if (onTop(after, curves[i], curves[j]) && !onTop(before, curves[i], curves[j])) return `would put ${entityLabel(after, curves[i])} on ${entityLabel(after, curves[j])}`;
    }
  return null;
}

/** Whether two counter-clockwise spans (start, sweep) of one circle share more than an end. */
function spansOverlap(a0: number, sa: number, b0: number, sb: number): boolean {
  const TAU = 2 * Math.PI;
  const eps = 1e-6;
  const inside = (t: number, s0: number, sw: number) => ((((t - s0) % TAU) + TAU) % TAU) < sw - eps;
  // Overlap with positive length: one span's start (or a point just after it) lies inside the other.
  return inside(b0 + eps, a0, sa) || inside(a0 + eps, b0, sb);
}

/**
 * The relations a new one makes redundant on the same references, which it replaces (SolidWorks
 * does the same): Midpoint a Coincident / On line of that point and line (the on-curve snap infers
 * one), Collinear a Parallel of those two lines.
 */
export const SUPERSEDES: Partial<Record<SketchRelationKind, SketchRelationKind[]>> = {
  midpoint: ['coincident', 'point_on_line'],
  collinear: ['parallel'],
};

/**
 * Where the solver starts for an angle relation of two lines (Parallel, Perpendicular, Collinear):
 * the line free to turn, turned to the wanted direction, its length kept. From far off the solver
 * met the relation by shrinking a line instead (Perpendicular on a horizontal line and one at 22
 * degrees left the horizontal one a few ten-thousandths long).
 * Integration review: the turn never moves what the sketch holds. A point is held when it is
 * fully defined (`fully`, the sketch's analysis), Fixed (a point Fix, or a point of a Fixed curve,
 * whose Fix holds it where it is loaded), a point of linked geometry (projected: fixed where its
 * model puts it), or one place with any of those (Coincident, the origin). A line with a held end
 * turns about that end; one with both ends held, or with its own Horizontal, Vertical or Fix,
 * does not turn; when neither line can, the solver starts from where things are (null).
 */
export function turnedForAngle(
  f: Pick<SketchFeature, 'points' | 'entities' | 'constraints'>,
  r: Pick<RelationPlan, 'kind' | 'refs'>,
  fully: (point: string) => boolean = () => false,
): Record<string, Vec2> | null {
  if (r.kind !== 'parallel' && r.kind !== 'perpendicular' && r.kind !== 'collinear') return null;
  if (r.refs.length !== 2) return null;
  const held = (id: string) => f.constraints.some((c) => (c.kind === 'horizontal' || c.kind === 'vertical' || c.kind === 'fix') && c.refs.length === 1 && c.refs[0] === id);
  const same = coincidentGroups(f);
  const fixedPoints = new Set<string>([ORIGIN]);
  const curveFixed = (id: string) => f.constraints.some((c) => c.kind === 'fix' && c.refs.length === 1 && c.refs[0] === id);
  for (const e of f.entities) if (e.link || curveFixed(e.id)) for (const q of entityPoints(e)) fixedPoints.add(q);
  for (const c of f.constraints) if (c.kind === 'fix' && c.refs.length === 1 && f.points[c.refs[0]]) fixedPoints.add(c.refs[0]);
  const pinned = (q: string) => fully(q) || [...fixedPoints].some((x) => same(q, x));
  const turnable = (id: string) => {
    const e = entityOf(f, id);
    return e?.kind === 'line' && !held(id) && !e.link && !(pinned(e.p[0]) && pinned(e.p[1]));
  };
  const [a, b] = r.refs;
  const turn = turnable(b) ? b : turnable(a) ? a : null;
  if (!turn) return null;
  const keep = turn === a ? b : a;
  const [k, t] = [lineEndsOf(f, keep), lineEndsOf(f, turn)];
  const line = entityOf(f, turn);
  if (!k || !t || line?.kind !== 'line') return null;
  const kd: Vec2 = [k[1][0] - k[0][0], k[1][1] - k[0][1]];
  const kl = Math.hypot(kd[0], kd[1]);
  const td: Vec2 = [t[1][0] - t[0][0], t[1][1] - t[0][1]];
  const tl = Math.hypot(td[0], td[1]);
  if (kl < 1e-9 || tl < 1e-9) return null;
  let u: Vec2 = r.kind === 'perpendicular' ? [-kd[1] / kl, kd[0] / kl] : [kd[0] / kl, kd[1] / kl];
  if (u[0] * td[0] + u[1] * td[1] < 0) u = [-u[0], -u[1]];
  const [p0, p1] = line.p;
  // About its held end (the other end swings), else about its middle.
  if (pinned(p0)) return { [p1]: [t[0][0] + u[0] * tl, t[0][1] + u[1] * tl] };
  if (pinned(p1)) return { [p0]: [t[1][0] - u[0] * tl, t[1][1] - u[1] * tl] };
  const m: Vec2 = [(t[0][0] + t[1][0]) / 2, (t[0][1] + t[1][1]) / 2];
  return {
    [p0]: [m[0] - (u[0] * tl) / 2, m[1] - (u[1] * tl) / 2],
    [p1]: [m[0] + (u[0] * tl) / 2, m[1] + (u[1] * tl) / 2],
  };
}

const round = (k: RefKind | null) => k === 'circle' || k === 'arc';

/**
 * The relations `kind` adds for the picked sketch items (point ids, point
 * entities, curve entity ids), or the reason it does not fit them.
 */
export function planConstraint(f: F, kind: SketchRelationKind, picks: readonly string[]): ConstraintOutcome {
  const need = CONSTRAIN_COMMANDS.find((c) => c.kind === kind)?.needs ?? 'Select sketch geometry';
  const no: ConstraintOutcome = { ok: false, reason: need };
  const kinds = picks.map((r) => refKindOf(f, r));
  if (!picks.length || kinds.some((k) => !k)) return no;
  const points = picks.filter((_, i) => kinds[i] === 'point').map((r) => pointIdOf(f, r)!);
  const lines = picks.filter((_, i) => kinds[i] === 'line');
  const rounds = picks.filter((_, i) => round(kinds[i]));
  const curves = picks.filter((_, i) => kinds[i] !== 'point');
  const only = (n: number) => picks.length === n;
  // ---- P4b (SKETCH): splines
  const splines = picks.filter((_, i) => kinds[i] === 'spline');
  if (splines.length) {
    const sp = planSpline(f, kind, picks, kinds, points);
    if (sp) return sp;
  }
  // Ellipses, parabolas, conics.
  if (kinds.some((k) => CONIC_REFS.has(k))) {
    const cp = planConic(f, kind, picks, kinds, points);
    if (cp) return cp;
  }
  switch (kind) {
    case 'coincident':
      if (only(2) && points.length === 2) return points[0] === points[1] ? no : { ok: true, add: [{ kind, refs: points }] };
      if (only(2) && points.length === 1 && curves.length === 1) return { ok: true, add: [{ kind, refs: [points[0], curves[0]] }] };
      return no;
    case 'horizontal':
    case 'vertical':
      if (lines.length && lines.length === picks.length) return { ok: true, add: lines.map((l) => ({ kind, refs: [l] })) };
      if (only(2) && points.length === 2 && points[0] !== points[1]) return { ok: true, add: [{ kind, refs: points }] };
      return no;
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
      return only(2) && lines.length === 2 ? { ok: true, add: [{ kind, refs: lines }] } : no;
    case 'tangent':
      if (only(2) && curves.length === 2 && rounds.length >= 1) {
        // A line first (the solver takes line-circle and line-arc in either order).
        const refs = lines.length ? [lines[0], rounds[0]] : rounds;
        return { ok: true, add: [{ kind, refs }] };
      }
      return no;
    case 'equal':
      if (lines.length >= 2 && lines.length === picks.length) return { ok: true, add: lines.slice(1).map((l) => ({ kind, refs: [lines[0], l] })) };
      if (rounds.length >= 2 && rounds.length === picks.length) return { ok: true, add: rounds.slice(1).map((r) => ({ kind, refs: [rounds[0], r] })) };
      return no;
    case 'midpoint':
      return only(2) && points.length === 1 && lines.length === 1 ? { ok: true, add: [{ kind, refs: [points[0], lines[0]] }] } : no;
    case 'symmetric': {
      // Two lines, or two circles or arcs, about the one centerline picked with them (SolidWorks'
      // Symmetric): their ends, or their centres, mirrored.
      if (only(3) && (lines.length === 3 || (lines.length === 1 && rounds.length === 2))) return planSymmetricPair(f, lines, rounds);
      if (!(only(3) && points.length === 2 && lines.length === 1)) return no;
      // Two points in one place have no mirror line: the relation is degenerate, and the solver then
      // refused every later edit as over-defining (review P2/P3 round 1).
      const [a, b] = [pointAt(f, points[0]), pointAt(f, points[1])];
      if (points[0] === points[1] || (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6)) return { ok: false, reason: 'Symmetric needs two points apart: these two are in the same place' };
      return { ok: true, add: [{ kind, refs: [points[0], points[1], lines[0]] }] };
    }
    case 'concentric':
      return only(2) && rounds.length === 2 ? { ok: true, add: [{ kind, refs: rounds }] } : no;
    case 'fix': {
      const add: RelationPlan[] = [];
      for (let i = 0; i < picks.length; i++) {
        if (kinds[i] === 'point') {
          const id = pointIdOf(f, picks[i])!;
          const p = pointAt(f, id);
          if (p) add.push({ kind, refs: [id], value: [p[0], p[1]] });
        } else add.push({ kind, refs: [picks[i]] });
      }
      return add.length ? { ok: true, add } : no;
    }
    default:
      return no;
  }
}

/**
 * Which points are one point: the same id, or tied by Coincident relations of two points (through
 * the origin too, as lines drawn from it are).
 */
export function coincidentGroups(f: F): (x: string, y: string) => boolean {
  const constraints = (f as Partial<Pick<SketchFeature, 'constraints'>>).constraints ?? [];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const isPoint = (r: string) => r === ORIGIN || !!f.points[r];
  for (const c of constraints) {
    if (c.kind !== 'coincident' || c.refs.length !== 2 || !c.refs.every(isPoint)) continue;
    const [a, b] = [find(c.refs[0]), find(c.refs[1])];
    if (a !== b) parent.set(a, b);
  }
  return (x, y) => x === y || find(x) === find(y);
}

/**
 * Symmetric of two lines (their ends) or of two circles or arcs (their centres) about a centerline:
 * with three lines the axis is the one centerline among them. Each end pairs with the other line's
 * end nearer its mirror image; a vertex the two lines share stays on the axis (On line).
 */
function planSymmetricPair(f: F, lines: string[], rounds: string[]): ConstraintOutcome {
  const centerline = (id: string) => {
    const e = entityOf(f, id);
    return e?.kind === 'line' && !!(e as { centerline?: boolean }).centerline;
  };
  const axes = rounds.length ? lines : lines.filter(centerline);
  if (axes.length !== 1) return { ok: false, reason: 'Symmetric of three lines needs one of them a centerline: the axis' };
  const axis = axes[0];
  const ends = lineEndsOf(f, axis);
  if (!ends) return { ok: false, reason: 'That centerline has no length' };
  const mirror = (p: Vec2): Vec2 => {
    const [a, b] = ends;
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const len2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2;
    const q: Vec2 = [a[0] + d[0] * t, a[1] + d[1] * t];
    return [2 * q[0] - p[0], 2 * q[1] - p[1]];
  };
  const apart = (x: string, y: string) => {
    const [a, b] = [pointAt(f, x), pointAt(f, y)];
    return x !== y && !(a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6);
  };
  const sym = (x: string, y: string): RelationPlan => ({ kind: 'symmetric', refs: [x, y, axis] });
  if (rounds.length) {
    const [c1, c2] = rounds.map((id) => entityOf(f, id) as Extract<SketchEntity, { kind: 'circle' | 'arc' }>).map((e) => e.c);
    if (!apart(c1, c2)) return { ok: false, reason: 'Symmetric needs two circles apart: these two have one centre' };
    return { ok: true, add: [sym(c1, c2)] };
  }
  const [l1, l2] = lines.filter((id) => id !== axis).map((id) => (entityOf(f, id) as Extract<SketchEntity, { kind: 'line' }>).p);
  // Review (relations lane): a V's two lines meet at one vertex: one point id, two points tied by
  // Coincident (lines drawn from the origin each get their own point tied to it), or two points in
  // one place. Its far ends are mirrored; the vertex is joined (when it is two points) and put on
  // the axis, unless it is there already (the centerline drawn from it, or tied to its end).
  const same = coincidentGroups(f);
  const samePlace = (x: string, y: string) => same(x, y) || !apart(x, y);
  let vertex: [string, string] | null = null;
  for (const a of l1) for (const b of l2) if (!vertex && samePlace(a, b)) vertex = [a, b];
  if (vertex) {
    const [a, b] = vertex;
    const fa = l1.find((p) => p !== a)!;
    const fb = l2.find((p) => p !== b)!;
    if (!apart(fa, fb) || same(fa, fb)) return { ok: false, reason: 'Symmetric needs two lines apart: these two lie on each other' };
    const axisEnds = (entityOf(f, axis) as Extract<SketchEntity, { kind: 'line' }>).p;
    const constraints = (f as Partial<Pick<SketchFeature, 'constraints'>>).constraints ?? [];
    const onAxis = (p: string) =>
      axisEnds.some((q) => same(p, q)) || constraints.some((c) => (c.kind === 'point_on_line' || c.kind === 'coincident' || c.kind === 'midpoint') && c.refs[1] === axis && same(c.refs[0], p));
    const add: RelationPlan[] = [sym(fa, fb)];
    if (!same(a, b)) add.push({ kind: 'coincident', refs: [a, b] });
    if (!onAxis(a) && !onAxis(b)) add.push({ kind: 'point_on_line', refs: [a, axis] });
    return { ok: true, add };
  }
  const at = (id: string) => pointAt(f, id) ?? ([0, 0] as Vec2);
  const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const m0 = mirror(at(l1[0]));
  const straight = dist(m0, at(l2[0])) <= dist(m0, at(l2[1]));
  const pairs: [string, string][] = straight ? [[l1[0], l2[0]], [l1[1], l2[1]]] : [[l1[0], l2[1]], [l1[1], l2[0]]];
  if (pairs.some(([x, y]) => !apart(x, y))) return { ok: false, reason: 'Symmetric needs two lines apart: these two lie on each other' };
  return { ok: true, add: pairs.map(([x, y]) => sym(x, y)) };
}

const CONIC_REFS = new Set<RefKind | null>(['ellipse', 'ellipse_arc', 'parabola', 'conic']);
const ELLIPTIC = new Set<RefKind | null>(['ellipse', 'ellipse_arc']);
const CONIC_WORD: Record<string, string> = { ellipse: 'an ellipse', ellipse_arc: 'a partial ellipse', parabola: 'a parabola', conic: 'a conic' };

/**
 * Relations that take an ellipse's, a parabola's or a conic's curve (the solver's own rules,
 * src/solver-worker/solver-api.mjs): Coincident (On curve) of a point with an ellipse, a partial
 * ellipse (its whole ellipse) or a parabola; Horizontal / Vertical of an ellipse's major axis or a
 * parabola's axis; Tangent of a line and an ellipse anywhere, or of two curves at an end they share
 * (a conic only there); Equal of ellipses (both radii) or of parabolas (focal length); Concentric
 * of an ellipse with a circle, an arc or another ellipse. Fix: every point (the general rule). Null:
 * the general rules decide.
 */
function planConic(f: F, kind: SketchRelationKind, picks: readonly string[], kinds: (RefKind | null)[], points: string[]): ConstraintOutcome | null {
  if (kind === 'fix') return null;
  const conics = picks.filter((_, i) => CONIC_REFS.has(kinds[i]));
  const first = kinds.find((k) => CONIC_REFS.has(k))!;
  const word = CONIC_WORD[first];
  const no = (reason: string): ConstraintOutcome => ({ ok: false, reason });
  switch (kind) {
    case 'coincident':
    case 'point_on_circle': {
      if (picks.length !== 2 || points.length !== 1 || conics.length !== 1) return no('Select a point and the ellipse, parabola or conic');
      const e = entityOf(f, conics[0])!;
      if (entityPoints(e).includes(points[0])) return no(`That point is already one of ${word}'s points`);
      if (e.kind === 'conic') return no('A point lies on a conic only at its ends: make it coincident with an end point');
      return { ok: true, add: [{ kind: 'coincident', refs: [points[0], conics[0]] }] };
    }
    case 'horizontal':
    case 'vertical': {
      const lines = picks.filter((_, i) => kinds[i] === 'line');
      if (conics.length + lines.length !== picks.length) return no('Select lines, ellipses (their major axis) or parabolas (their axis)');
      if (kinds.includes('conic')) return no('A conic has no axis: make its points horizontal or vertical');
      return { ok: true, add: picks.map((id) => ({ kind, refs: [id] })) };
    }
    case 'tangent': {
      if (picks.length !== 2 || kinds.some((k) => k === 'point' || k === null)) return no('Select two curves');
      const [a, b] = picks.map((id) => entityOf(f, id)!);
      const shared = entityEnds(a).find((p) => entityEnds(b).includes(p));
      if (shared) {
        if (kinds.includes('circle')) return no('A circle has no ends: make it tangent to a line instead');
        return { ok: true, add: [{ kind, refs: [a.id, b.id] }] };
      }
      const li = kinds.indexOf('line');
      const el = 1 - li;
      if (li >= 0 && ELLIPTIC.has(kinds[el])) return { ok: true, add: [{ kind, refs: [picks[li], picks[el]] }] };
      return no(`${word[0].toUpperCase()}${word.slice(1)} is tangent to a line${ELLIPTIC.has(first) ? ' anywhere' : ''}, or to a curve at an end they share: join them first`);
    }
    case 'equal': {
      if (picks.length >= 2 && kinds.every((k) => ELLIPTIC.has(k))) return { ok: true, add: picks.slice(1).map((id) => ({ kind, refs: [picks[0], id] })) };
      if (picks.length >= 2 && kinds.every((k) => k === 'parabola')) return { ok: true, add: picks.slice(1).map((id) => ({ kind, refs: [picks[0], id] })) };
      return no('Equal takes ellipses (both radii) or parabolas (focal length) of one kind');
    }
    case 'concentric': {
      const ok = (k: RefKind | null) => k === 'circle' || k === 'arc' || ELLIPTIC.has(k);
      if (picks.length === 2 && kinds.every(ok)) return { ok: true, add: [{ kind, refs: [...picks] }] };
      return no('Concentric takes two of circles, arcs and ellipses');
    }
    default:
      return no(`That relation does not take ${word}'s curve: use its points`);
  }
}

/**
 * P4b (SKETCH): relations that take a spline's curve: Tangent at an end it shares with a line, an
 * arc or another spline (a fit spline gets a tangent handle there first), and Coincident of a point
 * with a fit spline (the point becomes a fit point). Null: the general rules decide (a spline
 * picked with others where nothing spline-specific applies is refused by them).
 */
function planSpline(f: F, kind: SketchRelationKind, picks: readonly string[], kinds: (RefKind | null)[], points: string[]): ConstraintOutcome | null {
  // Fix holds every point of a spline (the solver's own rule).
  if (kind === 'fix') return null;
  if (kind === 'coincident' && picks.length === 2 && points.length === 1) {
    const spline = picks.find((_, i) => kinds[i] === 'spline')!;
    const e = entityOf(f, spline);
    if (e?.kind !== 'spline') return null;
    if (e.pts.includes(points[0]) || e.handles?.includes(points[0])) return { ok: false, reason: 'That point is already one of the spline\'s points' };
    // fix1 B2: on the curve, sliding along it (the spline keeps its shape).
    return { ok: true, add: [{ kind, refs: [points[0], spline] }] };
  }
  if (kind === 'tangent') {
    if (picks.length !== 2 || kinds.some((k) => k !== 'line' && k !== 'arc' && k !== 'spline')) return { ok: false, reason: 'Select a spline and the line, arc or spline it meets at its end' };
    const [a, b] = picks.map((id) => entityOf(f, id)!);
    const endsOf = (e: SketchEntity) => (e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : e.kind === 'spline' && !e.closed ? [e.pts[0], e.pts[e.pts.length - 1]] : []);
    const shared = endsOf(a).find((p) => endsOf(b).includes(p));
    if (!shared) return { ok: false, reason: 'A spline is tangent at an end it shares with the other curve: join them first' };
    const plan: RelationPlan = { kind, refs: [a.id, b.id] };
    for (const e of [a, b]) {
      if (e.kind !== 'spline' || e.form !== 'fit') continue;
      const end: 0 | 1 = e.pts[0] === shared ? 0 : 1;
      if (e.handles?.[end]) continue;
      const curve = splineOf(f, e);
      if (!curve) return { ok: false, reason: 'That spline has no shape' };
      // The handle where the curve heads now (its second pole: the shape does not jump).
      const pole = end === 0 ? curve.poles[1] : curve.poles[curve.poles.length - 2];
      if (plan.handle) return { ok: false, reason: 'Make two fit splines tangent one at a time' };
      plan.handle = { spline: e.id, end, at: [pole[0], pole[1]] };
    }
    return { ok: true, add: [plan] };
  }
  return { ok: false, reason: `${kind === 'equal' ? 'Equal' : 'That relation'} does not take a spline's curve: use its points` };
}
