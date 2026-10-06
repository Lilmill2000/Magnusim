// The geometry of reference planes, axes and points, from resolved inputs (mm,
// unit directions). Pure functions, exact in floating point (no kernel): every
// construction here is analytic (offset, rotation about a line, a plane through
// three points, a bisector, two planes crossing). Each refusal says why in the
// panel's words ("the three points are on one line").
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneFrame, Vec3 } from '../../types/doc';

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3) => norm(sub(a, b));

/** No negative zeros (stored frames read the same in JSON and tests). */
const clean = (v: Vec3): Vec3 => v.map((x) => (Object.is(x, -0) ? 0 : x)) as Vec3;

/** Unit vector, or null for a zero-length one. */
export function unit(a: Vec3): Vec3 | null {
  const l = norm(a);
  return l > 1e-12 ? clean([a[0] / l, a[1] / l, a[2] / l]) : null;
}

/** Directions closer than this (radians) are parallel: 1e-9 rad. */
const PARALLEL = 1e-9;
/** Lengths shorter than this (mm) are zero. */
export const TINY_MM = 1e-9;

/** Turn `v` about the unit axis `k` by `deg` degrees (Rodrigues). */
export function rotate(v: Vec3, k: Vec3, deg: number): Vec3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** An x direction in a plane of normal `n`: global X projected on it, or global Y when X is within 1 degree of the normal (sketch on a face does the same). */
export function seedX(n: Vec3): Vec3 {
  const cos1 = Math.cos(Math.PI / 180);
  const seed: Vec3 = Math.abs(n[0]) > cos1 ? [0, 1, 0] : [1, 0, 0];
  return unit(sub(seed, scale(n, dot(seed, n)))) ?? [0, 1, 0];
}

export type GeomResult<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = <T>(message: string): GeomResult<T> => ({ ok: false, message });

/** A clean frame: unit normal, xdir in the plane (unit). */
export function frameOf(origin: Vec3, normal: Vec3, xdir?: Vec3 | null): PlaneFrame | null {
  const n = unit(normal);
  if (!n) return null;
  const x0 = xdir ? unit(sub(xdir, scale(n, dot(xdir, n)))) : null;
  return { origin: clean([...origin] as Vec3), normal: n, xdir: x0 ?? seedX(n) };
}

/** `base` moved `d` mm along its normal (the normal and x direction kept). */
export function offsetPlane(base: PlaneFrame, d: number): PlaneFrame {
  const n = unit(base.normal) ?? [0, 0, 1];
  return frameOf(add(base.origin, scale(n, d)), n, base.xdir)!;
}

/**
 * The plane through the line (axis) turned `deg` about it from `base`: at 0 it is
 * parallel to `base` (the same plane when the axis lies in it). The axis must lie
 * in `base` or run parallel to it.
 */
export function planeAtAngle(base: PlaneFrame, axis: { origin: Vec3; dir: Vec3 }, deg: number): GeomResult<PlaneFrame> {
  const n = unit(base.normal);
  const k = unit(axis.dir);
  if (!n || !k) return fail('the axis has no direction');
  if (Math.abs(dot(n, k)) > Math.sin(1e-6)) return fail('the axis does not lie in the plane or run parallel to it');
  const normal = rotate(n, k, deg);
  const x = rotate(unit(base.xdir) ?? seedX(n), k, deg);
  // Where the axis comes closest to the base plane's origin: the new plane's origin.
  const t = dot(sub(base.origin, axis.origin), k);
  const origin = add(axis.origin, scale(k, t));
  return { ok: true, value: frameOf(origin, normal, x)! };
}

/** The plane through three points: origin at the first, x towards the second, normal by the right-hand rule. */
export function planeThrough(a: Vec3, b: Vec3, c: Vec3): GeomResult<PlaneFrame> {
  if (dist(a, b) < TINY_MM || dist(a, c) < TINY_MM || dist(b, c) < TINY_MM) return fail('two of the points are the same point');
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  // Sine of the angle at the first point: on one line below 1e-9.
  if (norm(n) < PARALLEL * norm(ab) * norm(ac)) return fail('the three points are on one line');
  return { ok: true, value: frameOf(a, n, ab)! };
}

/** Where two planes cross: a point on the line (the nearest to `near`) and its direction (n1 x n2). */
export function planesCross(p1: PlaneFrame, p2: PlaneFrame, near: Vec3): GeomResult<{ origin: Vec3; dir: Vec3 }> {
  const n1 = unit(p1.normal);
  const n2 = unit(p2.normal);
  if (!n1 || !n2) return fail('a plane has no normal');
  const d = cross(n1, n2);
  const s = norm(d);
  if (s < PARALLEL) return fail('the planes are parallel, so they do not cross');
  const dir = scale(d, 1 / s);
  // The point of the line nearest to `near`: solve n1.x = h1, n2.x = h2, dir.x = dir.near.
  const h1 = dot(n1, p1.origin);
  const h2 = dot(n2, p2.origin);
  const h3 = dot(dir, near);
  // x = (h1 (n2 x dir) + h2 (dir x n1) + h3 (n1 x n2)) / (n1 . (n2 x dir))
  const det = dot(n1, cross(n2, dir));
  const x = scale(add(add(scale(cross(n2, dir), h1), scale(cross(dir, n1), h2)), scale(cross(n1, n2), h3)), 1 / det);
  return { ok: true, value: { origin: clean(x), dir: clean(dir) } };
}

/**
 * The plane halfway between two planes. Parallel (either facing): the plane in the
 * middle, facing as the first. Crossing: the bisector of equal signed distance to
 * both (normal n1 - n2, so it runs between the sides the normals point to), through
 * their crossing line.
 */
export function midplane(p1: PlaneFrame, p2: PlaneFrame): GeomResult<PlaneFrame> {
  const n1 = unit(p1.normal);
  const n2 = unit(p2.normal);
  if (!n1 || !n2) return fail('a plane has no normal');
  if (norm(cross(n1, n2)) < PARALLEL) {
    // Halfway from p1's origin to its projection on p2.
    const gap = dot(sub(p1.origin, p2.origin), n2);
    const origin = sub(p1.origin, scale(n2, gap / 2));
    return { ok: true, value: frameOf(origin, n1, p1.xdir)! };
  }
  const line = planesCross(p1, p2, scale(add(p1.origin, p2.origin), 0.5));
  if (!line.ok) return line;
  const n = sub(n1, n2);
  return { ok: true, value: frameOf(line.value.origin, n, line.value.dir)! };
}

/** The plane normal to a curve's tangent at a point of it (Sweep's "normal to path" plane). */
export function planeNormalTo(at: Vec3, tangent: Vec3): GeomResult<PlaneFrame> {
  const f = frameOf(at, tangent, null);
  return f ? { ok: true, value: f } : fail('the curve has no direction at that point');
}

/** The axis through two points (from the first towards the second). */
export function axisThrough(a: Vec3, b: Vec3): GeomResult<{ origin: Vec3; dir: Vec3 }> {
  const d = unit(sub(b, a));
  if (!d || dist(a, b) < TINY_MM) return fail('the two points are the same point');
  return { ok: true, value: { origin: clean([...a] as Vec3), dir: d } };
}

/** The plane frame's normal reversed (the x direction kept, so y turns over). */
export function flipFrame(f: PlaneFrame): PlaneFrame {
  return { origin: f.origin, normal: clean(scale(f.normal, -1)), xdir: f.xdir };
}
