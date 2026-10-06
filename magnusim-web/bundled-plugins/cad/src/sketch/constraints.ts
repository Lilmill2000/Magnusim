// The CONSTRAIN commands (select first, then the command): which picks each
// relation takes, the references in the solver's order, and the reason it
// cannot apply to the selection ("Select two lines"). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, SketchRelationKind, Vec2 } from '../types/doc';
import { entityOf, pointAt, pointIdOf, refKindOf, type RefKind } from './model';
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
  { kind: 'symmetric', label: 'Symmetric', needs: 'Select two points and the line they are symmetric about' },
  { kind: 'concentric', label: 'Concentric', needs: 'Select two circles or arcs' },
  { kind: 'collinear', label: 'Collinear', needs: 'Select two lines' },
  { kind: 'fix', label: 'Fix', needs: 'Select points or curves to fix' },
];

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
