// The CONSTRAIN commands (select first, then the command): which picks each
// relation takes, the references in the solver's order, and the reason it
// cannot apply to the selection ("Select two lines"). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchEntity, SketchFeature, SketchRelationKind, Vec2 } from '../types/doc';
import { entityEnds, entityOf, entityPoints, pointAt, pointIdOf, refKindOf, type RefKind } from './model';
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
