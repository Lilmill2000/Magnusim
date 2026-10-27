// The CONSTRAIN commands (select first, then the command): which picks each
// relation takes, the references in the solver's order, and the reason it
// cannot apply to the selection ("Select two lines"). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, SketchRelationKind, Vec2 } from '../types/doc';
import { entityEnds, entityOf, entityPoints, isDimension, lineEnds as lineEndsOf, pointAt, pointIdOf, refKindOf, type RefKind } from './model';
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

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const ON_CURVE = new Set<string>(['point_on_line', 'point_on_circle']);

/** Whether the sketch has this record (Coincident of a point and a curve is also stored as On line / On curve). */
export function hasRelation(f: Pick<SketchFeature, 'constraints'>, r: Pick<RelationPlan, 'kind' | 'refs'>): boolean {
  return f.constraints.some((c) => {
    if (isDimension(c)) return false;
    const kindOk = c.kind === r.kind || (r.kind === 'coincident' && r.refs.length === 2 && ON_CURVE.has(c.kind)) || (ON_CURVE.has(r.kind) && c.kind === 'coincident');
    if (!kindOk) return false;
    if (r.kind === 'symmetric') return c.refs.length === 3 && c.refs[2] === r.refs[2] && sameSet(c.refs.slice(0, 2), r.refs.slice(0, 2));
    return sameSet(c.refs, r.refs);
  });
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
 * Symmetric of two lines (their ends) or of two circles or arcs (their centres) about a centerline:
 * with three lines the axis is the one centerline among them. Each end pairs with the other line's
 * end nearer its mirror image; an end the two lines share stays on the axis (On line).
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
  const shared = l1.find((p) => l2.includes(p));
  if (shared) {
    const a = l1.find((p) => p !== shared)!;
    const b = l2.find((p) => p !== shared)!;
    if (!apart(a, b)) return { ok: false, reason: 'Symmetric needs two lines apart: these two lie on each other' };
    return { ok: true, add: [sym(a, b), { kind: 'point_on_line', refs: [shared, axis] }] };
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
