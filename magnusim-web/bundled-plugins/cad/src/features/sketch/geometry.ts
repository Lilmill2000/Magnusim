// A sketch's geometry as plain numbers: entities resolved against solved point
// coordinates, the curves the kernel gets for its profile regions, the driving
// dimensions' values and the driven dimensions' measures (in JS, never through
// PlaneGCS driving:false, research/solver.md). Pure functions, no kernel.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { SKETCH_ORIGIN, type SketchConstraint, type SketchConstraintId, type SketchDimension, type SketchEntity, type SketchEntityId, type SketchFeature, type SketchPointId, type SketchRelation, type Vec2 } from '../../types/doc';
import { DIMENSION_LABELS, RELATION_LABELS } from '../../sketch/model';
import type { SketchCurve } from '../../types/kernel-protocol';
import type { UnitsService } from '../../types/units';
// P4b (SKETCH): splines.
import { splineOf } from '../../sketch/tools/spline-entity';
import { splinePolyline, type BSpline } from '../../sketch/tools/bspline';
import { evaluateTies } from '../../sketch/tools/ties';

const DEG = 180 / Math.PI;

/** One entity with its coordinates (mm, sketch u/v; arc angles in degrees from xdir, counter-clockwise about the normal). */
export type EntityGeom =
  | { kind: 'point'; id: SketchEntityId; construction: boolean; p: Vec2; pid: SketchPointId }
  | { kind: 'line'; id: SketchEntityId; construction: boolean; a: Vec2; b: Vec2; pa: SketchPointId; pb: SketchPointId }
  | { kind: 'circle'; id: SketchEntityId; construction: boolean; c: Vec2; r: number; pc: SketchPointId }
  | { kind: 'arc'; id: SketchEntityId; construction: boolean; c: Vec2; r: number; a: Vec2; b: Vec2; a0: number; a1: number; ccw: boolean; pa: SketchPointId; pb: SketchPointId; pc: SketchPointId }
  /** P4b (SKETCH): a spline as its B-spline (OCCT form) and a dense polyline; `a`/`b` its ends (closed: both at pa). */
  | { kind: 'spline'; id: SketchEntityId; construction: boolean; curve: BSpline; poly: Vec2[]; a: Vec2; b: Vec2; pa: SketchPointId; pb: SketchPointId; closed: boolean };

/** The points a sketch uses, SKETCH_ORIGIN included at [0, 0]. */
export function withOrigin(points: Record<SketchPointId, Vec2>): Record<SketchPointId, Vec2> {
  return { ...points, [SKETCH_ORIGIN]: [0, 0] };
}

/** The circle radii a sketch stores (its own `r`), by entity id. */
export function storedRadii(f: Pick<SketchFeature, 'entities'>): Record<SketchEntityId, number> {
  const out: Record<SketchEntityId, number> = {};
  for (const e of f.entities) if (e.kind === 'circle') out[e.id] = e.r;
  return out;
}

/** A construction entity (or a centerline) is never part of a profile. */
export function isConstruction(e: SketchEntity): boolean {
  return !!e.construction || (e.kind === 'line' && !!e.centerline);
}

function angleOf(c: Vec2, p: Vec2): number {
  return Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG;
}

/**
 * Every entity with its coordinates. Throws a plain reason when an entity uses
 * a point that is not there ("line e_3 uses a point that is not in the sketch").
 */
export function entityGeometry(f: Pick<SketchFeature, 'entities'>, points: Record<SketchPointId, Vec2>, radii: Record<SketchEntityId, number>): EntityGeom[] {
  const pts = withOrigin(points);
  const at = (e: SketchEntity, id: SketchPointId): Vec2 => {
    const p = pts[id];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${e.kind} ${e.id} uses a point that is not in the sketch`);
    return [p[0], p[1]];
  };
  return f.entities.map((e): EntityGeom => {
    const construction = isConstruction(e);
    switch (e.kind) {
      case 'point':
        return { kind: 'point', id: e.id, construction, p: at(e, e.p), pid: e.p };
      case 'line':
        return { kind: 'line', id: e.id, construction, a: at(e, e.p[0]), b: at(e, e.p[1]), pa: e.p[0], pb: e.p[1] };
      case 'circle': {
        const r = radii[e.id] ?? e.r;
        return { kind: 'circle', id: e.id, construction, c: at(e, e.c), r, pc: e.c };
      }
      case 'arc': {
        const c = at(e, e.c);
        const a = at(e, e.a);
        const b = at(e, e.b);
        return { kind: 'arc', id: e.id, construction, c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), a, b, a0: angleOf(c, a), a1: angleOf(c, b), ccw: e.ccw !== false, pa: e.a, pb: e.b, pc: e.c };
      }
      // P4b (SKETCH): the curve from the solved points (src/sketch/tools/bspline.ts).
      case 'spline': {
        for (const id of [...e.pts, ...(e.handles ?? [])]) if (id) at(e, id);
        const curve = splineOf({ points: pts }, e);
        if (!curve) throw new Error(`spline ${e.id}: its points do not make a curve (two in one place?)`);
        const first = curve.poles[0];
        const last = curve.poles[curve.poles.length - 1];
        const pa = e.pts[0];
        const pb = e.closed ? e.pts[0] : e.pts[e.pts.length - 1];
        return { kind: 'spline', id: e.id, construction, curve, poly: splinePolyline(curve, 24), a: [first[0], first[1]], b: [last[0], last[1]], pa, pb, closed: !!e.closed };
      }
    }
  });
}

/**
 * The curves the kernel builds profile regions from (SketchCurve): every
 * line, arc and circle that is not construction, with the sketch point ids at
 * their ends and centres (the kernel names split points by them), plus every
 * point entity (ignored for regions; it names a split point lying on it).
 */
export function curvesOf(geom: readonly EntityGeom[]): SketchCurve[] {
  const out: SketchCurve[] = [];
  for (const g of geom) {
    if (g.construction) continue;
    if (g.kind === 'line') out.push({ id: g.id, kind: 'line', a: g.a, b: g.b, pa: g.pa, pb: g.pb });
    else if (g.kind === 'circle') out.push({ id: g.id, kind: 'circle', c: g.c, r: g.r, pc: g.pc });
    else if (g.kind === 'arc') out.push({ id: g.id, kind: 'arc', c: g.c, r: g.r, a0: g.a0, a1: g.a1, ccw: g.ccw, pa: g.pa, pb: g.pb, pc: g.pc });
    // P4b (SKETCH): kernel request R1 (`bspline`, clamped, OCCT form).
    else if (g.kind === 'spline') out.push(bsplineCurve(g));
    else out.push({ id: g.id, kind: 'point', p: g.p, pid: g.pid });
  }
  return out;
}

/** P4b (SKETCH): a spline as the kernel's `bspline` curve (R1). */
function bsplineCurve(g: Extract<EntityGeom, { kind: 'spline' }>): SketchCurve {
  return { id: g.id, kind: 'bspline', degree: g.curve.degree, poles: g.curve.poles.map((q) => [q[0], q[1]] as Vec2), knots: [...g.curve.knots], mults: [...g.curve.mults], pa: g.pa, pb: g.pb };
}

/** Whether the curves can bound a region at all (a sketch of points only has none; the kernel is not asked). */
export function hasProfileCurves(curves: readonly SketchCurve[]): boolean {
  return curves.some((c) => c.kind !== 'point');
}

// ------------------------------------------------------------ dimensions

export const isDimension = (c: SketchConstraint): c is SketchDimension => 'expr' in c && 'driving' in c;

/** How panels and messages name a dimension: "d1", "d2", ... in the order the sketch keeps them. */
export function dimensionLabel(f: Pick<SketchFeature, 'constraints'>, id: SketchConstraintId, units?: Pick<UnitsService, 'unitLabel'>): string {
  // The words sketch mode's conflict list uses ("Distance 40 mm", "Horizontal"): the user never sees ids.
  const c = f.constraints.find((x) => x.id === id);
  if (!c) return 'a constraint that is gone';
  if (isDimension(c)) {
    // A bare number is in the document's unit: say which ("Distance 40 mm"); "40 in" or "w / 2" as typed.
    const bare = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(c.expr));
    const unit = bare && units ? units.unitLabel(c.kind === 'angle' ? 'angle' : 'length') : '';
    return `${DIMENSION_LABELS[c.kind]} ${String(c.expr).trim()}${!unit ? '' : unit === '°' ? '°' : ` ${unit}`}`;
  }
  return RELATION_LABELS[(c as SketchRelation).kind] ?? c.kind;
}

/** Dimensions in the sketch (driving and driven): the tree row's count. */
export function dimensionCount(f: Pick<SketchFeature, 'constraints'>): number {
  return f.constraints.filter(isDimension).length;
}

const POSITIVE: ReadonlySet<SketchDimension['kind']> = new Set(['radius', 'diameter']);

/** Every driving dimension's value (mm or degrees), or the first one that does not evaluate, in words. */
export function drivingValues(f: Pick<SketchFeature, 'constraints'>, units: UnitsService): { ok: true; values: Record<SketchConstraintId, number> } | { ok: false; message: string } {
  const values: Record<SketchConstraintId, number> = {};
  for (const c of f.constraints) {
    if (!isDimension(c) || !c.driving) continue;
    const label = dimensionLabel(f, c.id, units);
    const r = units.evaluate(typeof c.expr === 'string' ? c.expr : String(c.expr ?? ''), c.kind === 'angle' ? 'angle' : 'length');
    if (!r.ok) return { ok: false, message: `${label}: ${r.error}` };
    if (POSITIVE.has(c.kind) && !(r.value > 0)) return { ok: false, message: `${label}: a ${c.kind} must be more than 0` };
    if (c.kind === 'distance' && !(r.value >= 0)) return { ok: false, message: `${label}: a distance cannot be negative` };
    values[c.id] = r.value;
  }
  // P4b (SKETCH): sketch patterns' and offsets' values (keys `<tie>:<name>`).
  const ties = evaluateTies(f as { ties?: import('../../types/doc').SketchTie[] }, units);
  const bad = Object.entries(ties.errors)[0];
  if (bad) return { ok: false, message: `${(f as { ties?: { id: string; kind: string }[] }).ties?.find((t) => bad[0].startsWith(`${t.id}:`))?.kind === 'offset' ? 'Offset' : 'Sketch pattern'} ${bad[0].split(':')[1]}: ${bad[1]}` };
  Object.assign(values, ties.values);
  return { ok: true, values };
}

/** The evaluated values are the ones the stored geometry was solved for (1e-9 relative): no re-solve is needed. */
export function sameValues(now: Record<SketchConstraintId, number>, stored: Record<SketchConstraintId, number>): boolean {
  for (const [id, v] of Object.entries(now)) {
    const s = stored[id];
    if (typeof s !== 'number' || !Number.isFinite(s)) return false;
    if (Math.abs(v - s) > 1e-9 * Math.max(Math.abs(v), Math.abs(s), 1e-9)) return false;
  }
  return true;
}

function normDeg(a: number): number {
  let x = a;
  while (x <= -180) x += 360;
  while (x > 180) x -= 360;
  return x;
}

/** Distance from point p to the infinite line through a and b. */
function pointLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (!(l > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l;
}

/**
 * A dimension measured on the geometry (the solver's own semantics,
 * src/solver-worker/solver-api.mjs `measure` and its constraint signatures):
 * distance (a line's length, point-point, point-line, line-line, point-curve,
 * curve-curve, curve-line), distance_x / distance_y (signed: second minus
 * first), radius, diameter, angle (a line's direction, or the second line's
 * minus the first's, degrees in (-180, 180]). null when the references do not
 * fit the kind.
 */
export function measureDimension(c: Pick<SketchDimension, 'kind' | 'refs'>, geom: readonly EntityGeom[], points: Record<SketchPointId, Vec2>): number | null {
  const pts = withOrigin(points);
  const byId = new Map(geom.map((g) => [g.id, g]));
  type Ref = { kind: 'point'; p: Vec2 } | { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'curve'; c: Vec2; r: number };
  const refOf = (id: string): Ref | null => {
    const g = byId.get(id);
    if (g) {
      if (g.kind === 'point') return { kind: 'point', p: g.p };
      if (g.kind === 'line') return { kind: 'line', a: g.a, b: g.b };
      // P4b (SKETCH): no dimension measures a spline's curve itself (its points take dimensions).
      if (g.kind === 'spline') return null;
      return { kind: 'curve', c: g.c, r: g.r };
    }
    const p = pts[id];
    return p ? { kind: 'point', p } : null;
  };
  const refs = c.refs.map(refOf);
  if (refs.some((r) => !r)) return null;
  const [r0, r1] = refs as Ref[];
  const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  switch (c.kind) {
    case 'distance': {
      if (refs.length === 1 && r0.kind === 'line') return dist(r0.a, r0.b);
      if (refs.length !== 2) return null;
      if (r0.kind === 'point' && r1.kind === 'point') return dist(r0.p, r1.p);
      if (r0.kind === 'point' && r1.kind === 'line') return pointLine(r0.p, r1.a, r1.b);
      if (r0.kind === 'line' && r1.kind === 'point') return pointLine(r1.p, r0.a, r0.b);
      if (r0.kind === 'line' && r1.kind === 'line') return pointLine(r0.a, r1.a, r1.b);
      if (r0.kind === 'point' && r1.kind === 'curve') return Math.abs(dist(r0.p, r1.c) - r1.r);
      if (r0.kind === 'curve' && r1.kind === 'point') return Math.abs(dist(r1.p, r0.c) - r0.r);
      if (r0.kind === 'curve' && r1.kind === 'curve') {
        const d = dist(r0.c, r1.c);
        if (d >= r0.r + r1.r) return d - r0.r - r1.r;
        if (d <= Math.abs(r0.r - r1.r)) return Math.abs(r0.r - r1.r) - d;
        return 0;
      }
      if (r0.kind === 'curve' && r1.kind === 'line') return Math.max(0, pointLine(r0.c, r1.a, r1.b) - r0.r);
      if (r0.kind === 'line' && r1.kind === 'curve') return Math.max(0, pointLine(r1.c, r0.a, r0.b) - r1.r);
      return null;
    }
    case 'distance_x':
    case 'distance_y': {
      const k = c.kind === 'distance_x' ? 0 : 1;
      if (refs.length === 1 && r0.kind === 'line') return r0.b[k] - r0.a[k];
      if (refs.length === 1 && r0.kind === 'point') return r0.p[k];
      if (refs.length === 2 && r0.kind === 'point' && r1.kind === 'point') return r1.p[k] - r0.p[k];
      return null;
    }
    case 'radius':
    case 'diameter':
      if (r0?.kind !== 'curve') return null;
      return c.kind === 'radius' ? r0.r : 2 * r0.r;
    case 'angle': {
      const dir = (l: Ref) => (l.kind === 'line' ? Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) * DEG : NaN);
      if (refs.length === 1 && r0.kind === 'line') return normDeg(dir(r0));
      if (refs.length === 2 && r0.kind === 'line' && r1.kind === 'line') return normDeg(dir(r1) - dir(r0));
      return null;
    }
  }
}

/** The driven (reference) dimensions measured on the geometry used, for their grey labels. */
export function drivenMeasures(f: Pick<SketchFeature, 'constraints'>, geom: readonly EntityGeom[], points: Record<SketchPointId, Vec2>): Record<SketchConstraintId, number> {
  const out: Record<SketchConstraintId, number> = {};
  for (const c of f.constraints) {
    if (!isDimension(c) || c.driving) continue;
    const v = measureDimension(c, geom, points);
    if (v != null && Number.isFinite(v)) out[c.id] = v;
  }
  return out;
}

/** The root of an entity's lineage (a trim keeps `e_1` and makes `e_1.b` with parent `e_1`): both are `e_1`. */
export function lineageRoot(id: SketchEntityId, parents: ReadonlyMap<SketchEntityId, SketchEntityId | null | undefined>): SketchEntityId {
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const p = parents.get(cur);
    if (!p || seen.has(p)) break;
    seen.add(cur);
    cur = p;
  }
  // An id whose entity is gone still says its lineage in its spelling ("e_1.b").
  const dot = cur.indexOf('.');
  return dot > 0 ? cur.slice(0, dot) : cur;
}
