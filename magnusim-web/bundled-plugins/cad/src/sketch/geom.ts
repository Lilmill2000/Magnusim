// 2D geometry for sketch mode: vectors, distances to curves, intersections of
// lines, circles and arcs, and arc angles. Sketch u/v in mm; angles in
// radians here unless a name says deg. Pure functions (unit-tested).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../types/doc';

export const TAU = Math.PI * 2;

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Rotated 90 degrees counter-clockwise. */
export const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
}
export const polar = (c: Vec2, r: number, ang: number): Vec2 => [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
export const angleOf = (c: Vec2, p: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** An angle in [0, 2pi). */
export function wrap(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** An angle in (-pi, pi]. */
export function wrapPi(a: number): number {
  let r = wrap(a);
  if (r > Math.PI) r -= TAU;
  return r;
}

/** The arc a counter-clockwise sweep from `from` to `to` covers (0, 2pi]. */
export function ccwSweep(from: number, to: number): number {
  const s = wrap(to - from);
  return s === 0 ? TAU : s;
}

/** Closest point on segment ab to p, and the parameter t in [0, 1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { p: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return { p: a, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { p: lerp(a, b, t), t };
}

/** Closest point on the infinite line through a, b and its parameter (0 at a, 1 at b). */
export function closestOnLine(p: Vec2, a: Vec2, b: Vec2): { p: Vec2; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return { p: a, t: 0 };
  const t = dot(sub(p, a), ab) / l2;
  return { p: lerp(a, b, t), t };
}

/** An arc: centre, radius, start angle and counter-clockwise sweep (radians). */
export interface ArcGeom {
  c: Vec2;
  r: number;
  /** Start angle (at the arc's first point in the counter-clockwise sense). */
  a0: number;
  /** Counter-clockwise sweep from a0, in (0, 2pi]. */
  sweep: number;
}

/** Whether angle `a` lies on the arc (within `tol` radians). */
export function onArcAngle(arc: Pick<ArcGeom, 'a0' | 'sweep'>, a: number, tol = 1e-9): boolean {
  const d = wrap(a - arc.a0);
  return d <= arc.sweep + tol || d >= TAU - tol;
}

/** Parameter along the arc in [0, 1] (0 at a0), or the nearest end's for an angle outside it. */
export function arcParam(arc: Pick<ArcGeom, 'a0' | 'sweep'>, a: number): number {
  const d = wrap(a - arc.a0);
  if (d <= arc.sweep) return d / arc.sweep;
  // outside: whichever end is nearer in angle
  return d - arc.sweep < TAU - d ? 1 : 0;
}

/** Closest point on a full circle. */
export function closestOnCircle(p: Vec2, c: Vec2, r: number): Vec2 {
  const d = sub(p, c);
  const l = len(d);
  if (l === 0) return [c[0] + r, c[1]];
  return add(c, scale(d, r / l));
}

/** Closest point on an arc (an end when the radial projection falls outside it). */
export function closestOnArc(p: Vec2, arc: ArcGeom): Vec2 {
  const a = angleOf(arc.c, p);
  if (onArcAngle(arc, a)) return polar(arc.c, arc.r, a);
  const s = polar(arc.c, arc.r, arc.a0);
  const e = polar(arc.c, arc.r, arc.a0 + arc.sweep);
  return dist(p, s) <= dist(p, e) ? s : e;
}

/** Intersections of two infinite lines (a1-b1, a2-b2), with parameters along each (0 at a, 1 at b). */
export function lineLine(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): { p: Vec2; t: number; s: number } | null {
  const d1 = sub(b1, a1);
  const d2 = sub(b2, a2);
  const den = cross(d1, d2);
  const scaleLen = len(d1) * len(d2);
  if (scaleLen === 0 || Math.abs(den) < 1e-12 * scaleLen) return null;
  const w = sub(a2, a1);
  const t = cross(w, d2) / den;
  const s = cross(w, d1) / den;
  return { p: add(a1, scale(d1, t)), t, s };
}

/** Intersections of the infinite line a-b with a circle: points and their line parameters. */
export function lineCircle(a: Vec2, b: Vec2, c: Vec2, r: number): { p: Vec2; t: number }[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  if (A === 0) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  const tol = 1e-12 * Math.max(1, B * B, Math.abs(4 * A * C));
  if (disc < -tol) return [];
  if (disc < tol) disc = 0;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  const out = [{ p: add(a, scale(d, t1)), t: t1 }];
  if (sq > 0) out.push({ p: add(a, scale(d, t2)), t: t2 });
  return out;
}

/** Intersections of two circles (0, 1 or 2 points). */
export function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  if (d === 0) return [];
  const tol = 1e-9 * Math.max(1, r1, r2);
  if (d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const u = scale(sub(c2, c1), 1 / d);
  const pm = add(c1, scale(u, a));
  if (h === 0) return [pm];
  const n = perp(u);
  return [add(pm, scale(n, h)), sub(pm, scale(n, h))];
}

/** Signed area of a polygon (positive when counter-clockwise). */
export function polygonArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += cross(pts[i], pts[(i + 1) % pts.length]);
  return s / 2;
}

/**
 * The circle through three points, or null when they are (nearly) collinear.
 * The arc from p1 through p2 to p3: `ccw` says which way it turns.
 */
export function circleThrough(p1: Vec2, p2: Vec2, p3: Vec2): { c: Vec2; r: number; ccw: boolean } | null {
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const span = Math.max(dist(p1, p2), dist(p2, p3), dist(p1, p3));
  if (span === 0 || Math.abs(d) < 1e-9 * span * span) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const c: Vec2 = [ux, uy];
  // p1 -> p2 -> p3 turning left = counter-clockwise
  const ccw = cross(sub(p2, p1), sub(p3, p2)) > 0;
  return { c, r: dist(c, p1), ccw };
}

/**
 * The arc tangent to direction `t` at `a` that ends at `b`: centre, radius and
 * turn (null when b lies on the tangent line).
 */
export function tangentArc(a: Vec2, t: Vec2, b: Vec2): { c: Vec2; r: number; ccw: boolean } | null {
  const tn = norm(t);
  const n = perp(tn);
  const ab = sub(b, a);
  const den = 2 * dot(ab, n);
  const l = len(ab);
  if (l === 0 || Math.abs(den) < 1e-9 * l) return null;
  // centre = a + n * s, |c - b| = |s|: s = |ab|^2 / (2 ab.n)
  const s = dot(ab, ab) / den;
  const c = add(a, scale(n, s));
  return { c, r: Math.abs(s), ccw: s > 0 };
}

/** Angle between two directions folded into [0, pi/2] (radians). */
export function acuteAngle(d1: Vec2, d2: Vec2): number {
  const a = Math.abs(wrapPi(Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0])));
  return a > Math.PI / 2 ? Math.PI - a : a;
}
