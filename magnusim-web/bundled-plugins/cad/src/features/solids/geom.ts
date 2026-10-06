// Sketch curves in model mode for the P4a solids' panels: which curve of a drawn
// sketch is under the pointer (a Revolve axis on a centerline, a Sweep path), a
// sketch line as an axis in space, the curves a path names, polylines to draw
// them, and a sketch curve's frame at a point (for a plane normal to a curve).
// Pure functions over the rebuild's outputs; no kernel.
// Owner: P4a SOLIDS (src/features/solids/: shared by revolve, sweep, loft,
// fillet, chamfer, shell; no index.ts, so module discovery skips it).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import { SKETCH_ORIGIN, type FeatureId, type SketchEntityId, type SketchFeature, type Vec2, type Vec3 } from '../../types/doc';
import type { SketchCurve } from '../../types/kernel-protocol';
import type { SketchOutput } from '../../types/sketch';
import { entityGeometry, type EntityGeom } from '../sketch/geometry';
import { rayPlane, toModel } from '../sketch/plane';
import { drawnSketches, profilesView } from '../sketch/view';
// P4b (SKETCH): splines.
import { polyAt, polyDistance } from '../../sketch/tools/spline-entity';

/** How near (CSS px) the pointer must be to pick a curve. */
export const CURVE_PICK_PX = 8;

const DEG = Math.PI / 180;

/** Distance (mm) from a point to an entity's curve in its sketch's u/v. */
export function distanceToCurve(g: EntityGeom, p: Vec2): number {
  if (g.kind === 'point') return Math.hypot(p[0] - g.p[0], p[1] - g.p[1]);
  if (g.kind === 'line') {
    const dx = g.b[0] - g.a[0];
    const dy = g.b[1] - g.a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dy) / l2));
    return Math.hypot(p[0] - (g.a[0] + t * dx), p[1] - (g.a[1] + t * dy));
  }
  // P4b (SKETCH)
  if (g.kind === 'spline') return polyDistance(g.poly, p);
  const rho = Math.hypot(p[0] - g.c[0], p[1] - g.c[1]);
  if (g.kind === 'circle') return Math.abs(rho - g.r);
  // An arc: on its sweep, the radial distance; else the nearer end.
  const ang = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) / DEG;
  const sweep = (((g.ccw ? g.a1 - g.a0 : g.a0 - g.a1) % 360) + 360) % 360 || 360;
  const from = (((g.ccw ? ang - g.a0 : g.a0 - ang) % 360) + 360) % 360;
  if (from <= sweep) return Math.abs(rho - g.r);
  return Math.min(Math.hypot(p[0] - g.a[0], p[1] - g.a[1]), Math.hypot(p[0] - g.b[0], p[1] - g.b[1]));
}

/** "Line 2", "Arc 1", "Circle 1": a sketch curve by its kind and place among that kind in its sketch. */
export function curveWords(sketch: SketchFeature | undefined, entity: SketchEntityId): string {
  const e = sketch?.entities.find((x) => x.id === entity);
  if (!sketch || !e) return 'A curve that is gone';
  const same = sketch.entities.filter((x) => x.kind === e.kind);
  const n = same.findIndex((x) => x.id === entity) + 1;
  const word = e.kind === 'line' ? 'Line' : e.kind === 'arc' ? 'Arc' : e.kind === 'circle' ? 'Circle' : e.kind === 'spline' ? 'Spline' : 'Point';
  return `${word} ${n}`;
}

/**
 * A sketch point in words, by the curves that meet there: "Centre of Circle 1", "End of Line 2",
 * "Corner of Line 1 and Line 2", "Point 1" (a point entity), "Sketch origin" (P4a review: every
 * point of a sketch read "Point of Sketch 3").
 */
export function sketchPointWords(sketch: SketchFeature | undefined, point: string): string {
  if (point === 'origin') return 'Sketch origin';
  if (!sketch) return 'A point';
  const centreOf = sketch.entities.find((e) => (e.kind === 'circle' || e.kind === 'arc') && e.c === point);
  if (centreOf) return `Centre of ${curveWords(sketch, centreOf.id)}`;
  const ends = sketch.entities.filter((e) => (e.kind === 'line' && e.p.includes(point)) || (e.kind === 'arc' && (e.a === point || e.b === point)) || (e.kind === 'spline' && !e.closed && (e.pts[0] === point || e.pts[e.pts.length - 1] === point)));
  if (ends.length === 1) return `End of ${curveWords(sketch, ends[0].id)}`;
  if (ends.length > 1) {
    const w = ends.map((e) => curveWords(sketch, e.id));
    return `Corner of ${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
  }
  const own = sketch.entities.find((e) => e.kind === 'point' && e.p === point);
  if (own) return curveWords(sketch, own.id);
  return 'A point';
}

/** A sketch's entities with their coordinates as built (empty when they cannot be read). */
export function geometryOf(feature: SketchFeature, out: SketchOutput): EntityGeom[] {
  try {
    return entityGeometry(feature, out.points, out.radii);
  } catch {
    return [];
  }
}

export interface CurveHit {
  feature: FeatureId;
  entity: SketchEntityId;
  geom: EntityGeom;
  /** Distance along the pointer's ray (mm). */
  t: number;
}

/**
 * The sketch curve nearest the pointer among the drawn sketches (within CURVE_PICK_PX), or
 * null. `lines`: straight lines only (an axis); `construction`: construction lines and
 * centerlines count (an axis), else not (a path); `only`: one sketch.
 */
export function curveUnder(services: AppServices, at: { clientX: number; clientY: number; ray: { origin: Vec3; dir: Vec3 } }, opts: { lines?: boolean; construction?: boolean; only?: FeatureId | null } = {}): CurveHit | null {
  const handle = services.viewport.get().handle;
  if (!handle) return null;
  const s = services.doc.state.get();
  const drawn = drawnSketches(s, services.mode.get().mode, profilesView(services).get(), services.doc.features);
  let best: (CurveHit & { px: number }) | null = null;
  for (const { feature, output } of drawn) {
    if (opts.only && feature.id !== opts.only) continue;
    const hit = rayPlane(output.plane, at.ray);
    if (!hit) continue;
    const px = handle.pixelSize(hit.p) || 1;
    for (const g of geometryOf(feature, output)) {
      if (g.kind === 'point') continue;
      if (opts.lines && g.kind !== 'line') continue;
      if (g.construction && !opts.construction) continue;
      const d = distanceToCurve(g, hit.uv) / px;
      if (d > CURVE_PICK_PX) continue;
      if (!best || d < best.px - 0.5 || (Math.abs(d - best.px) <= 0.5 && hit.t < best.t)) best = { feature: feature.id, entity: g.id, geom: g, t: hit.t, px: d };
    }
  }
  if (!best) return null;
  // A body in front of the curve takes the click.
  const pick = handle.pick(at.clientX, at.clientY);
  if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
    const l = Math.hypot(at.ray.dir[0], at.ray.dir[1], at.ray.dir[2]) || 1;
    const along = ((pick.point[0] - at.ray.origin[0]) * at.ray.dir[0] + (pick.point[1] - at.ray.origin[1]) * at.ray.dir[1] + (pick.point[2] - at.ray.origin[2]) * at.ray.dir[2]) / l;
    if (along < best.t - 3 * handle.pixelSize(pick.point)) return null;
  }
  const { px: _px, ...hit } = best;
  void _px;
  return hit;
}

export interface SketchPointHit {
  feature: FeatureId;
  /** The point's id in the sketch's points (a line's end, a centre, a point entity). */
  point: string;
  /** Where it is (model mm). */
  p: Vec3;
  /** Distance along the pointer's ray (mm). */
  t: number;
}

/**
 * The sketch point nearest the pointer among the drawn sketches (within CURVE_PICK_PX): a line's
 * end, an arc's or circle's centre, a point (the sketch's own origin is left out: the fields offer
 * the origin as a button). A body in front of it takes the click (null). P4a integration: sketch
 * points as point inputs of the CONSTRUCT fields.
 */
export function sketchPointUnder(services: AppServices, at: { clientX: number; clientY: number; ray: { origin: Vec3; dir: Vec3 } }): SketchPointHit | null {
  const handle = services.viewport.get().handle;
  if (!handle) return null;
  const s = services.doc.state.get();
  const drawn = drawnSketches(s, services.mode.get().mode, profilesView(services).get(), services.doc.features);
  let best: (SketchPointHit & { px: number }) | null = null;
  for (const { feature, output } of drawn) {
    const hit = rayPlane(output.plane, at.ray);
    if (!hit) continue;
    const px = handle.pixelSize(hit.p) || 1;
    for (const [id, uv] of Object.entries(output.points)) {
      if (id === SKETCH_ORIGIN) continue;
      const d = Math.hypot(uv[0] - hit.uv[0], uv[1] - hit.uv[1]) / px;
      if (d > CURVE_PICK_PX) continue;
      if (!best || d < best.px - 0.5 || (Math.abs(d - best.px) <= 0.5 && hit.t < best.t)) best = { feature: feature.id, point: id, p: toModel(output.plane, uv), t: hit.t, px: d };
    }
  }
  if (!best) return null;
  const pick = handle.pick(at.clientX, at.clientY);
  if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
    const l = Math.hypot(at.ray.dir[0], at.ray.dir[1], at.ray.dir[2]) || 1;
    const along = ((pick.point[0] - at.ray.origin[0]) * at.ray.dir[0] + (pick.point[1] - at.ray.origin[1]) * at.ray.dir[1] + (pick.point[2] - at.ray.origin[2]) * at.ray.dir[2]) / l;
    if (along < best.t - 3 * handle.pixelSize(pick.point)) return null;
  }
  const { px: _px, ...out } = best;
  void _px;
  return out;
}

/** Model points along an entity (a polyline), for drawing it highlighted. */
export function curvePolyline(g: EntityGeom, out: Pick<SketchOutput, 'plane'>): Vec3[] {
  if (g.kind === 'point') return [toModel(out.plane, g.p)];
  if (g.kind === 'line') return [toModel(out.plane, g.a), toModel(out.plane, g.b)];
  // P4b (SKETCH)
  if (g.kind === 'spline') return g.poly.map((q) => toModel(out.plane, q));
  let a0 = 0;
  let sweep = 360;
  if (g.kind === 'arc') {
    a0 = g.a0;
    const d = (((g.a1 - g.a0) % 360) + 360) % 360;
    sweep = g.ccw ? d || 360 : -((360 - d) % 360 || 360);
  }
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / 5));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (a0 + (sweep * i) / n) * DEG;
    pts.push(toModel(out.plane, [g.c[0] + g.r * Math.cos(a), g.c[1] + g.r * Math.sin(a)]));
  }
  return pts;
}

/** A line entity of a sketch as an axis in space (origin at its first point, unit direction to its second), or null. */
export function sketchLineAxis(feature: SketchFeature, out: SketchOutput, entity: SketchEntityId): { origin: Vec3; dir: Vec3 } | null {
  const g = geometryOf(feature, out).find((x) => x.id === entity);
  if (!g || g.kind !== 'line') return null;
  const a = toModel(out.plane, g.a);
  const b = toModel(out.plane, g.b);
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (!(l > 1e-9)) return null;
  return { origin: a, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/**
 * The curves a sweep path takes from its sketch's built curves: the listed entities (or every
 * curve when the list is empty), points left out. Returns the ids it could not find.
 */
export function pathCurves(out: SketchOutput, entities: readonly SketchEntityId[]): { curves: SketchCurve[]; missing: SketchEntityId[] } {
  const curves = out.curves.filter((c) => c.kind !== 'point' && (!entities.length || entities.includes(c.id)));
  const have = new Set(curves.map((c) => c.id));
  return { curves, missing: entities.filter((e) => !have.has(e)) };
}

/**
 * A sketch curve's point and unit tangent at a fraction 0..1 of its length (lines and arcs in
 * their own direction; a circle counter-clockwise from its +u point), in model coordinates.
 */
export function sketchCurveFrame(g: EntityGeom, out: Pick<SketchOutput, 'plane'>, fraction: number): { p: Vec3; tangent: Vec3 } | null {
  const f = Math.max(0, Math.min(1, fraction));
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (v: Vec3): Vec3 | null => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
  };
  if (g.kind === 'line') {
    const uv: Vec2 = [g.a[0] + (g.b[0] - g.a[0]) * f, g.a[1] + (g.b[1] - g.a[1]) * f];
    const t = unit(sub(toModel(out.plane, g.b), toModel(out.plane, g.a)));
    return t ? { p: toModel(out.plane, uv), tangent: t } : null;
  }
  if (g.kind === 'circle' || g.kind === 'arc') {
    let a0 = 0;
    let sweep = 360;
    if (g.kind === 'arc') {
      a0 = g.a0;
      const d = (((g.a1 - g.a0) % 360) + 360) % 360;
      sweep = g.ccw ? d || 360 : -((360 - d) % 360 || 360);
    }
    const a = (a0 + sweep * f) * DEG;
    const s = Math.sign(sweep) || 1;
    const p = toModel(out.plane, [g.c[0] + g.r * Math.cos(a), g.c[1] + g.r * Math.sin(a)]);
    const ahead = toModel(out.plane, [g.c[0] + g.r * Math.cos(a) - s * Math.sin(a), g.c[1] + g.r * Math.sin(a) + s * Math.cos(a)]);
    const t = unit(sub(ahead, p));
    return t ? { p, tangent: t } : null;
  }
  // P4b (SKETCH): along the spline's polyline by length.
  if (g.kind === 'spline') {
    const r = polyAt(g.poly, f);
    if (!r) return null;
    const p = toModel(out.plane, r.p);
    const t = unit(sub(toModel(out.plane, [r.p[0] + r.dir[0], r.p[1] + r.dir[1]]), p));
    return t ? { p, tangent: t } : null;
  }
  return null;
}
