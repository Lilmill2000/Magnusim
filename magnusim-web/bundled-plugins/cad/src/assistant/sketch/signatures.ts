// The references the sketch solver accepts for each relation and dimension the sketch tool takes
// (CAD tools spec §6.3), as pure data: the forms solver-api.mjs addConstraint builds, by the kinds of
// the refs in the order written. tests/assistant/signatures.test.ts runs every row on the real
// solver and checks that every other combination of ref kinds is refused there too (but tangent with
// a point, which the solver takes anywhere and the tool only at an end of both curves). The tool keeps
// the model's order and kind as written (distance_x [p, q] is q.u - p.u, signed): it never reorders
// refs or picks a kind from where a label sits, as the person's dimension tool does.
//   point_on   is point_on_line or point_on_circle, by its second ref;
//   collinear  is the Part's own relation (two point_on_line in the solver);
//   tangent    of two lines only where they share an end point; three refs name the point, which
//              must be an end of both curves (lines and arcs: where they meet). The solver takes
//              any point there, but only lines up the curves' normals at it: away from a shared end
//              that is no tangency, so the tool refuses it (and every three-ref form with a circle).
// No runtime imports: help.ts lists these rows.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchDimensionKind, SketchRelationKind } from '../../types/doc';
import type { SKETCH_CONSTRAINT_KINDS } from '../schemas';

/** What a ref is to the solver: a point (a point id, a point entity, the origin) or a curve. */
export type SigKind = 'point' | 'line' | 'circle' | 'arc';

/** The relation and dimension kinds the sketch tool takes (its schema's enum). */
export type ToolConstraintKind = (typeof SKETCH_CONSTRAINT_KINDS)[number];

export interface Signature {
  readonly refs: readonly SigKind[];
  /** The kind the Part stores. */
  readonly stored: SketchRelationKind | SketchDimensionKind;
  /** Only when the two curves share an end point (three refs: the point is an end of both). */
  readonly sharedEnd?: true;
}

const ROUND: readonly SigKind[] = ['circle', 'arc'];
/** Curves with end points. */
const ENDED: readonly SigKind[] = ['line', 'arc'];

const rows = (stored: Signature['stored'], ...forms: (readonly SigKind[])[]): Signature[] => forms.map((refs) => ({ refs, stored }));

/** Every pair of `a` and `b`, in that order. */
const pairs = (a: readonly SigKind[], b: readonly SigKind[]) => a.flatMap((x) => b.map((y) => [x, y] as const));

const TANGENT: Signature[] = [
  ...rows('tangent', ['line', 'circle'], ['circle', 'line'], ['line', 'arc'], ['arc', 'line'], ['circle', 'circle'], ['arc', 'arc'], ['circle', 'arc'], ['arc', 'circle']),
  { refs: ['line', 'line'], stored: 'tangent', sharedEnd: true },
  // Two curves and the point where they meet: an end of both (endpoint tangency there).
  ...pairs(ENDED, ENDED).map(([x, y]) => ({ refs: [x, y, 'point'] as const, stored: 'tangent' as const, sharedEnd: true as const })),
];

export const SIGNATURES: Readonly<Record<ToolConstraintKind, readonly Signature[]>> = Object.freeze({
  coincident: rows('coincident', ['point', 'point'], ['point', 'line'], ['point', 'circle'], ['point', 'arc']),
  horizontal: rows('horizontal', ['line'], ['point', 'point']),
  vertical: rows('vertical', ['line'], ['point', 'point']),
  parallel: rows('parallel', ['line', 'line']),
  perpendicular: rows('perpendicular', ['line', 'line']),
  tangent: TANGENT,
  equal: rows('equal', ['line', 'line'], ...pairs(ROUND, ROUND)),
  midpoint: rows('midpoint', ['point', 'line'], ['line', 'point']),
  symmetric: rows('symmetric', ['point', 'point', 'line'], ['point', 'point', 'point']),
  point_on: [...rows('point_on_line', ['point', 'line']), ...rows('point_on_circle', ['point', 'circle'], ['point', 'arc'])],
  concentric: rows('concentric', ...pairs(ROUND, ROUND)),
  collinear: rows('collinear', ['line', 'line']),
  distance: rows('distance', ['line'], ['point', 'point'], ['point', 'line'], ['line', 'point'], ['line', 'line'], ['point', 'circle'], ['point', 'arc'], ['circle', 'circle'], ['circle', 'line'], ['line', 'circle']),
  distance_x: rows('distance_x', ['line'], ['point', 'point'], ['point']),
  distance_y: rows('distance_y', ['line'], ['point', 'point'], ['point']),
  radius: rows('radius', ['circle'], ['arc']),
  diameter: rows('diameter', ['circle'], ['arc']),
  angle: rows('angle', ['line', 'line'], ['line']),
});

/** The dimension kinds (they take a value); the others are relations (value ""). */
export const TOOL_DIMENSIONS: readonly ToolConstraintKind[] = ['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle'];

export const isToolDimension = (k: ToolConstraintKind) => TOOL_DIMENSIONS.includes(k);

/** "point, point, line or point, point, point" (the bad_ref hint). */
export function signatureWords(kind: ToolConstraintKind): string {
  const forms = SIGNATURES[kind].map((s) => `${s.refs.join(', ')}${s.sharedEnd ? (s.refs.length === 3 ? ' (the point an end of both)' : ' (sharing an end)') : ''}`);
  return forms.length === 1 ? forms[0] : `${forms.slice(0, -1).join('; ')} or ${forms[forms.length - 1]}`;
}

/**
 * The row these ref kinds fit, or null. `sharesEnd` says whether the first two refs (two curves)
 * share an end point; with three refs, whether the third is an end of both.
 */
export function matchSignature(kind: ToolConstraintKind, kinds: readonly SigKind[], sharesEnd: boolean): Signature | null {
  for (const s of SIGNATURES[kind] ?? []) {
    if (s.refs.length !== kinds.length || !s.refs.every((k, i) => k === kinds[i])) continue;
    if (s.sharedEnd && !sharesEnd) continue;
    return s;
  }
  return null;
}

/** The tool's name for a stored kind (point_on_line and point_on_circle are point_on). */
export function toolKindOf(stored: string): ToolConstraintKind | null {
  if (stored === 'point_on_line' || stored === 'point_on_circle') return 'point_on';
  return (Object.keys(SIGNATURES) as ToolConstraintKind[]).includes(stored as ToolConstraintKind) ? (stored as ToolConstraintKind) : null;
}
