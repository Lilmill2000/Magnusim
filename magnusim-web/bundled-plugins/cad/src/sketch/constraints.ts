// The CONSTRAIN commands (select first, then the command): which picks each
// relation takes, the references in the solver's order, and the reason it
// cannot apply to the selection ("Select two lines"). Pure (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, SketchRelationKind, Vec2 } from '../types/doc';
import { pointAt, pointIdOf, refKindOf, type RefKind } from './model';

type F = Pick<SketchFeature, 'points' | 'entities'>;

/** One relation to add: kind, references (solver order), and a fix's locked position. */
export interface RelationPlan {
  kind: SketchRelationKind;
  refs: string[];
  value?: Vec2;
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
