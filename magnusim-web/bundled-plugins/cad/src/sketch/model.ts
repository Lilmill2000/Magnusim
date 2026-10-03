// The sketch model as sketch mode reads it: points (SKETCH_ORIGIN included),
// entity geometry, what a constraint reference is, the solver's view of a
// sketch (toSolverSketch, also used by the rebuild's re-solve), driven
// dimensions measured in JS (never PlaneGCS driving:false, solver.md §5), and
// words for panels. Pure functions over a SketchFeature.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { SKETCH_ORIGIN, type SketchConstraint, type SketchDimension, type SketchDimensionKind, type SketchEntity, type SketchFeature, type SketchRelation, type SketchRelationKind, type Vec2 } from '../types/doc';
import type { SolverSketch, SolverValues } from '../types/sketch';
import type { Quantity, UnitsService } from '../types/units';
import { angleOf, ccwSweep, closestOnArc, closestOnCircle, closestOnLine, closestOnSegment, cross, dist, norm, sub, wrapPi, type ArcGeom } from './geom';

export const ORIGIN = SKETCH_ORIGIN;
/** The solver's id for the origin's lock (never shown; filtered out of conflict lists). */
export const ORIGIN_FIX = '#origin';

export const DIMENSION_KINDS: readonly SketchDimensionKind[] = ['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle'];
export const RELATION_KINDS: readonly SketchRelationKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'midpoint',
  'symmetric',
  'point_on_line',
  'point_on_circle',
  'concentric',
  'collinear',
  'fix',
];

export function isDimension(c: SketchConstraint): c is SketchDimension {
  return (DIMENSION_KINDS as readonly string[]).includes(c.kind);
}

export function quantityOf(kind: SketchDimensionKind): Extract<Quantity, 'length' | 'angle'> {
  return kind === 'angle' ? 'angle' : 'length';
}

/** A point's solved position (SKETCH_ORIGIN is [0, 0]); null when it is not in the sketch. */
export function pointAt(f: Pick<SketchFeature, 'points'>, id: string): Vec2 | null {
  if (id === ORIGIN) return [0, 0];
  return f.points[id] ?? null;
}

export function entityOf(f: Pick<SketchFeature, 'entities'>, id: string): SketchEntity | null {
  return f.entities.find((e) => e.id === id) ?? null;
}

/** Point ids an entity uses (line ends; circle centre; arc centre, start, end; a point entity's point). */
export function entityPoints(e: SketchEntity): string[] {
  switch (e.kind) {
    case 'point':
      return [e.p];
    case 'line':
      return [e.p[0], e.p[1]];
    case 'circle':
      return [e.c];
    case 'arc':
      return [e.c, e.a, e.b];
  }
}

/** End points (lines and arcs), in the entity's own direction. */
export function entityEnds(e: SketchEntity): string[] {
  if (e.kind === 'line') return [e.p[0], e.p[1]];
  if (e.kind === 'arc') return [e.a, e.b];
  return [];
}

export type RefKind = 'point' | 'line' | 'circle' | 'arc';

/** What a constraint reference is: a point id (or the origin), a point entity (a point), or a curve. */
export function refKindOf(f: Pick<SketchFeature, 'points' | 'entities'>, ref: string): RefKind | null {
  if (ref === ORIGIN || f.points[ref]) return 'point';
  const e = entityOf(f, ref);
  if (!e) return null;
  return e.kind === 'point' ? 'point' : e.kind;
}

/** A reference's point id (a point id itself, or a point entity's point). */
export function pointIdOf(f: Pick<SketchFeature, 'points' | 'entities'>, ref: string): string | null {
  if (ref === ORIGIN || f.points[ref]) return ref;
  const e = entityOf(f, ref);
  return e?.kind === 'point' ? e.p : null;
}

/** An arc's circle and its counter-clockwise span (radius from the centre to its start point). */
export function arcGeom(f: Pick<SketchFeature, 'points'>, e: Extract<SketchEntity, { kind: 'arc' }>): ArcGeom | null {
  const c = pointAt(f, e.c);
  const a = pointAt(f, e.a);
  const b = pointAt(f, e.b);
  if (!c || !a || !b) return null;
  const r = dist(c, a);
  const ccw = e.ccw !== false;
  const s = angleOf(c, ccw ? a : b);
  const t = angleOf(c, ccw ? b : a);
  return { c, r, a0: s, sweep: ccwSweep(s, t) };
}

/** Distance from p to an entity's curve (a point entity: to its point). */
export function distanceTo(f: Pick<SketchFeature, 'points' | 'entities'>, e: SketchEntity, p: Vec2): number {
  switch (e.kind) {
    case 'point': {
      const q = pointAt(f, e.p);
      return q ? dist(p, q) : Infinity;
    }
    case 'line': {
      const a = pointAt(f, e.p[0]);
      const b = pointAt(f, e.p[1]);
      return a && b ? dist(p, closestOnSegment(p, a, b).p) : Infinity;
    }
    case 'circle': {
      const c = pointAt(f, e.c);
      return c ? dist(p, closestOnCircle(p, c, e.r)) : Infinity;
    }
    case 'arc': {
      const g = arcGeom(f, e);
      return g ? dist(p, closestOnArc(p, g)) : Infinity;
    }
  }
}

/** The closest point on an entity's curve (the infinite line for a line when `infinite`). */
export function closestOn(f: Pick<SketchFeature, 'points' | 'entities'>, e: SketchEntity, p: Vec2, infinite = false): Vec2 | null {
  switch (e.kind) {
    case 'point':
      return pointAt(f, e.p);
    case 'line': {
      const a = pointAt(f, e.p[0]);
      const b = pointAt(f, e.p[1]);
      if (!a || !b) return null;
      return (infinite ? closestOnLine(p, a, b) : closestOnSegment(p, a, b)).p;
    }
    case 'circle': {
      const c = pointAt(f, e.c);
      return c ? closestOnCircle(p, c, e.r) : null;
    }
    case 'arc': {
      const g = arcGeom(f, e);
      return g ? closestOnArc(p, g) : null;
    }
  }
}

/** A line's two end positions. */
export function lineEnds(f: Pick<SketchFeature, 'points' | 'entities'>, id: string): [Vec2, Vec2] | null {
  const e = entityOf(f, id);
  if (e?.kind !== 'line') return null;
  const a = pointAt(f, e.p[0]);
  const b = pointAt(f, e.p[1]);
  return a && b ? [a, b] : null;
}

/** The centre point id of a circle or an arc. */
export function centreOf(f: Pick<SketchFeature, 'entities'>, id: string): string | null {
  const e = entityOf(f, id);
  return e?.kind === 'circle' || e?.kind === 'arc' ? e.c : null;
}

/** Radius of a circle or an arc now. */
export function radiusOf(f: Pick<SketchFeature, 'points' | 'entities'>, id: string): number | null {
  const e = entityOf(f, id);
  if (e?.kind === 'circle') return e.r;
  if (e?.kind === 'arc') return arcGeom(f, e)?.r ?? null;
  return null;
}

// ------------------------------------------------------------ measuring (driven dimensions, starting values)

/**
 * What a dimension measures on the geometry now (mm or deg), or null when its
 * references do not fit its kind. distance_x / distance_y are signed (second
 * minus first; a single point: its coordinate), angle is the signed angle from
 * the first line's direction to the second's in (-180, 180].
 */
export function measureDimension(f: Pick<SketchFeature, 'points' | 'entities'>, c: Pick<SketchDimension, 'kind' | 'refs'>): number | null {
  const kinds = c.refs.map((r) => refKindOf(f, r));
  const pt = (r: string) => {
    const id = pointIdOf(f, r);
    return id ? pointAt(f, id) : null;
  };
  switch (c.kind) {
    case 'distance': {
      if (kinds.length === 1 && kinds[0] === 'line') {
        const ends = lineEnds(f, c.refs[0]);
        return ends ? dist(ends[0], ends[1]) : null;
      }
      if (kinds[0] === 'point' && kinds[1] === 'point') {
        const a = pt(c.refs[0]);
        const b = pt(c.refs[1]);
        return a && b ? dist(a, b) : null;
      }
      if ((kinds[0] === 'point' && kinds[1] === 'line') || (kinds[0] === 'line' && kinds[1] === 'point')) {
        const p = pt(kinds[0] === 'point' ? c.refs[0] : c.refs[1]);
        const ends = lineEnds(f, kinds[0] === 'line' ? c.refs[0] : c.refs[1]);
        return p && ends ? Math.abs(pointLineDistance(p, ends[0], ends[1])) : null;
      }
      if (kinds[0] === 'line' && kinds[1] === 'line') {
        const a = lineEnds(f, c.refs[0]);
        const b = lineEnds(f, c.refs[1]);
        return a && b ? Math.abs(pointLineDistance(a[0], b[0], b[1])) : null;
      }
      return null;
    }
    case 'distance_x':
    case 'distance_y': {
      const k = c.kind === 'distance_x' ? 0 : 1;
      if (kinds.length === 1 && kinds[0] === 'line') {
        const ends = lineEnds(f, c.refs[0]);
        return ends ? ends[1][k] - ends[0][k] : null;
      }
      if (kinds.length === 1 && kinds[0] === 'point') {
        const p = pt(c.refs[0]);
        return p ? p[k] : null;
      }
      if (kinds[0] === 'point' && kinds[1] === 'point') {
        const a = pt(c.refs[0]);
        const b = pt(c.refs[1]);
        return a && b ? b[k] - a[k] : null;
      }
      return null;
    }
    case 'radius':
    case 'diameter': {
      const r = radiusOf(f, c.refs[0]);
      return r == null ? null : c.kind === 'radius' ? r : 2 * r;
    }
    case 'angle': {
      if (kinds.length === 2 && kinds[0] === 'line' && kinds[1] === 'line') {
        const a = lineEnds(f, c.refs[0]);
        const b = lineEnds(f, c.refs[1]);
        if (!a || !b) return null;
        const d1 = sub(a[1], a[0]);
        const d2 = sub(b[1], b[0]);
        return (wrapPi(Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0])) * 180) / Math.PI;
      }
      if (kinds.length === 1 && kinds[0] === 'line') {
        const a = lineEnds(f, c.refs[0]);
        if (!a) return null;
        const d = sub(a[1], a[0]);
        return (Math.atan2(d[1], d[0]) * 180) / Math.PI;
      }
      return null;
    }
  }
}

/** Signed distance from p to the line through a, b (positive on the left of a -> b). */
export function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const d = norm(sub(b, a));
  return cross(d, sub(p, a));
}

// ------------------------------------------------------------ the solver's sketch

/** Solver constraint ids that stand for one stored constraint (collinear: two point_on_line). */
export function storedIdOf(solverId: string): string | null {
  if (solverId === ORIGIN_FIX) return null;
  const i = solverId.indexOf('#');
  return i > 0 ? solverId.slice(0, i) : solverId;
}

/** Stored constraint ids from solver ids (internal ones dropped, collinear halves merged). */
export function storedIds(solverIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of solverIds) {
    const id = storedIdOf(s);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The sketch as the solver takes it: the origin as a locked point, collinear as
 * two point_on_line, each driving dimension with its value (`values[id]`, else
 * what it measures now), driven ones as driving:false (the solver measures them
 * and never uses them).
 */
export function toSolverSketch(f: Pick<SketchFeature, 'points' | 'entities' | 'constraints'>, values: Readonly<Record<string, number>> = {}): SolverSketch {
  const points: Record<string, Vec2> = { [ORIGIN]: [0, 0] };
  for (const [id, p] of Object.entries(f.points)) points[id] = [p[0], p[1]];
  const entities: SolverSketch['entities'] = f.entities.map((e) => {
    const base = { id: e.id, ...(e.construction ? { construction: true } : {}) };
    switch (e.kind) {
      case 'point':
        return { ...base, kind: 'point' as const, p: e.p };
      case 'line':
        return { ...base, kind: 'line' as const, p: [e.p[0], e.p[1]] as [string, string] };
      case 'circle':
        return { ...base, kind: 'circle' as const, c: e.c, r: e.r };
      case 'arc':
        return { ...base, kind: 'arc' as const, c: e.c, a: e.a, b: e.b, ...(e.ccw === false ? { ccw: false } : {}) };
    }
  });
  const constraints: SolverSketch['constraints'] = [{ id: ORIGIN_FIX, kind: 'fix', refs: [ORIGIN], value: [0, 0] }];
  for (const c of f.constraints) {
    if (isDimension(c)) {
      const v = values[c.id] ?? measureDimension(f, c);
      if (v == null || !Number.isFinite(v)) continue;
      constraints.push({ id: c.id, kind: c.kind, refs: [...c.refs], value: v, ...(c.driving ? {} : { driving: false }) });
      continue;
    }
    if (c.kind === 'collinear') {
      const other = entityOf(f, c.refs[1]);
      if (other?.kind !== 'line') continue;
      constraints.push({ id: `${c.id}#a`, kind: 'point_on_line', refs: [other.p[0], c.refs[0]] }, { id: `${c.id}#b`, kind: 'point_on_line', refs: [other.p[1], c.refs[0]] });
      continue;
    }
    if (c.kind === 'fix') {
      constraints.push({ id: c.id, kind: 'fix', refs: [...c.refs], ...(c.value ? { value: [c.value[0], c.value[1]] as Vec2 } : {}) });
      continue;
    }
    constraints.push({ id: c.id, kind: c.kind, refs: [...c.refs] });
  }
  return { points, entities, constraints };
}

/** The feature's geometry with the solver's answer (points and circle radii; the origin is not stored). */
export function withSolved<F extends Pick<SketchFeature, 'points' | 'entities'>>(f: F, v: Pick<SolverValues, 'points' | 'radii'>): F {
  const points: Record<string, Vec2> = {};
  for (const id of Object.keys(f.points)) {
    const p = v.points[id];
    points[id] = p ? [p[0], p[1]] : f.points[id];
  }
  const entities = f.entities.map((e) => (e.kind === 'circle' && v.radii[e.id] != null && v.radii[e.id] !== e.r ? { ...e, r: v.radii[e.id] } : e));
  return { ...f, points, entities };
}

/**
 * Every dimension's value: driving ones evaluated from their expressions (mm /
 * deg), with the first problem per dimension. Driven ones are left out (they
 * are measured).
 */
export function evaluateDimensions(f: Pick<SketchFeature, 'constraints'>, units: UnitsService): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const c of f.constraints) {
    if (!isDimension(c) || !c.driving) continue;
    const r = units.evaluate(c.expr, quantityOf(c.kind));
    if (!r.ok) errors[c.id] = r.error;
    else if ((c.kind === 'radius' || c.kind === 'diameter' || c.kind === 'distance') && !(r.value > 0)) errors[c.id] = 'Must be more than 0';
    else values[c.id] = r.value;
  }
  return { values, errors };
}

// ------------------------------------------------------------ words

const ENTITY_WORD: Record<SketchEntity['kind'], string> = { point: 'Point', line: 'Line', circle: 'Circle', arc: 'Arc' };

/** "Line 3", "Centerline 1", "Circle 2", "Arc 1", "Point 4" (numbered by kind in drawing order). */
export function entityLabel(f: Pick<SketchFeature, 'entities'>, id: string): string {
  if (id === ORIGIN) return 'Origin';
  const e = entityOf(f, id);
  if (!e) return 'Point';
  const word = e.kind === 'line' && e.centerline ? 'Centerline' : ENTITY_WORD[e.kind];
  const same = f.entities.filter((x) => x.kind === e.kind && (e.kind !== 'line' || !!(x as { centerline?: boolean }).centerline === !!(e as { centerline?: boolean }).centerline));
  return `${word} ${same.indexOf(e) + 1}`;
}

export const RELATION_LABELS: Record<SketchRelationKind, string> = {
  coincident: 'Coincident',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  midpoint: 'Midpoint',
  symmetric: 'Symmetric',
  point_on_line: 'On line',
  point_on_circle: 'On curve',
  concentric: 'Concentric',
  collinear: 'Collinear',
  fix: 'Fix',
};

export const DIMENSION_LABELS: Record<SketchDimensionKind, string> = {
  distance: 'Distance',
  distance_x: 'Horizontal distance',
  distance_y: 'Vertical distance',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
};

/** Words for a reference in a list: a point of an entity says which ("Point 2" / "End of Line 3"). */
export function refLabel(f: Pick<SketchFeature, 'points' | 'entities'>, ref: string): string {
  if (ref === ORIGIN) return 'Origin';
  if (f.points[ref]) {
    const owner = f.entities.find((e) => entityPoints(e).includes(ref));
    if (!owner) return 'Point';
    if (owner.kind === 'point') return entityLabel(f, owner.id);
    if ((owner.kind === 'circle' || owner.kind === 'arc') && owner.c === ref) return `Centre of ${entityLabel(f, owner.id)}`;
    return `End of ${entityLabel(f, owner.id)}`;
  }
  return entityLabel(f, ref);
}

/** "Horizontal · Line 3", "Distance 40 mm · Line 1", "(Distance 44.72 mm) · Point 1, Point 3". */
export function constraintLabel(f: Pick<SketchFeature, 'points' | 'entities'>, c: SketchConstraint, units?: UnitsService): string {
  const refs = c.refs.map((r) => refLabel(f, r)).join(', ');
  if (isDimension(c)) {
    let v = c.expr;
    if (units) {
      const m = c.driving ? units.evaluate(c.expr, quantityOf(c.kind)) : null;
      const val = m && m.ok ? m.value : measureDimension(f, c);
      if (val != null) v = units.format(Math.abs(val), quantityOf(c.kind), { digits: 2 });
    }
    const text = `${DIMENSION_LABELS[c.kind]} ${v}`;
    return `${c.driving ? text : `(${text})`} · ${refs}`;
  }
  return `${RELATION_LABELS[(c as SketchRelation).kind]} · ${refs}`;
}

/** The constraints that reference any of these ids (entities or points). */
export function constraintsUsing(f: Pick<SketchFeature, 'constraints' | 'entities'>, ids: ReadonlySet<string>): SketchConstraint[] {
  return f.constraints.filter((c) => c.refs.some((r) => ids.has(r)) || (c.kind === 'collinear' && c.refs.some((r) => ids.has(r))));
}
