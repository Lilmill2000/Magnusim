// Which drawn CONSTRUCT item is under the pointer: a point within 8 px of its
// marker beats an axis within 8 px of its line, which beats a plane the ray
// meets inside its square (as a vertex beats an edge, which beats a face).
// What a body shows in front of it wins: the hit counts only when it is not
// behind the body face, edge or vertex the viewport picks there.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId, Vec3 } from '../../types/doc';
import type { ViewportHandle } from '../../types/viewport';
import type { ConstructKind } from './api';
import { add, dot, scale, sub, unit } from './geom';
import type { DrawnConstruct } from './scene';

/** Screen radius (CSS px) within which an axis or a point is picked (the viewport's PICK_TOL_PX). */
export const PICK_PX = 8;

export interface ConstructHit {
  feature: FeatureId;
  kind: ConstructKind;
  /** Where along the ray (mm from its origin). */
  t: number;
  point: Vec3;
}

type Ray = { origin: Vec3; dir: Vec3 };
type Project = (p: Vec3) => [number, number] | null;

function segDist2(p: [number, number], a: [number, number], b: [number, number]): { d2: number; s: number } {
  const ax = b[0] - a[0];
  const ay = b[1] - a[1];
  const l2 = ax * ax + ay * ay;
  const s = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / l2)) : 0;
  const x = a[0] + ax * s - p[0];
  const y = a[1] + ay * s - p[1];
  return { d2: x * x + y * y, s };
}

/** Distance along the ray to the point of it nearest `p`. */
function along(ray: Ray, p: Vec3): number {
  const d = unit(ray.dir) ?? [0, 0, 1];
  return dot(sub(p, ray.origin), d);
}

/** The drawn item under the pointer (pure: the caller gives the projection), or null. */
export function hitConstruct(drawn: readonly DrawnConstruct[], at: { x: number; y: number; ray: Ray }, project: Project, accept: readonly ConstructKind[] | null = null): ConstructHit | null {
  const ok = (k: ConstructKind) => !accept || accept.includes(k);
  const tol2 = PICK_PX * PICK_PX;
  let best: (ConstructHit & { rank: number; d2: number }) | null = null;
  const consider = (h: ConstructHit & { rank: number; d2: number }) => {
    if (!best || h.rank < best.rank || (h.rank === best.rank && (h.d2 < best.d2 - 1e-9 || (Math.abs(h.d2 - best.d2) <= 1e-9 && h.t < best.t)))) best = h;
  };
  for (const c of drawn) {
    if (!ok(c.kind)) continue;
    if (c.point) {
      const s = project(c.point);
      if (!s) continue;
      const d2 = (s[0] - at.x) ** 2 + (s[1] - at.y) ** 2;
      if (d2 <= tol2) consider({ feature: c.feature, kind: c.kind, t: along(at.ray, c.point), point: c.point, rank: 0, d2 });
    } else if (c.axis) {
      const a = project(c.axis.a);
      const b = project(c.axis.b);
      if (!a || !b) continue;
      const { d2, s } = segDist2([at.x, at.y], a, b);
      if (d2 > tol2) continue;
      // The model point at that spot (the projection is not linear in perspective, but close enough for depth).
      const p = add(c.axis.a, scale(sub(c.axis.b, c.axis.a), s));
      consider({ feature: c.feature, kind: c.kind, t: along(at.ray, p), point: p, rank: 1, d2 });
    } else if (c.plane) {
      const n = unit(c.plane.frame.normal);
      const d = unit(at.ray.dir);
      if (!n || !d) continue;
      const den = dot(d, n);
      if (Math.abs(den) < 1e-9) continue;
      const t = dot(sub(c.plane.frame.origin, at.ray.origin), n) / den;
      if (!(t >= 0)) continue;
      const p = add(at.ray.origin, scale(d, t));
      const q = sub(p, c.plane.center);
      if (Math.abs(dot(q, c.plane.u)) > c.plane.half || Math.abs(dot(q, c.plane.v)) > c.plane.half) continue;
      consider({ feature: c.feature, kind: c.kind, t, point: p, rank: 2, d2: 0 });
    }
  }
  if (!best) return null;
  const { feature, kind, t, point } = best as ConstructHit;
  return { feature, kind, t, point };
}

/**
 * The drawn item under the pointer in the app's viewport, unless a body is in front of it
 * (the viewport's own pick at the same spot, nearer by more than 3 px of depth).
 */
export function constructUnder(handle: ViewportHandle, drawn: readonly DrawnConstruct[], at: { clientX: number; clientY: number; ray: Ray }, accept: readonly ConstructKind[] | null = null): ConstructHit | null {
  const hit = hitConstruct(drawn, { x: at.clientX, y: at.clientY, ray: at.ray }, (p) => handle.project(p), accept);
  if (!hit) return null;
  const pick = handle.pick(at.clientX, at.clientY);
  if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
    const tol = 3 * handle.pixelSize(hit.point) + 1e-9;
    // A plane through a face (offset 0) or an axis along an edge: equal depth keeps the CONSTRUCT item.
    if (along(at.ray, pick.point) < hit.t - tol) return null;
  }
  return hit;
}
