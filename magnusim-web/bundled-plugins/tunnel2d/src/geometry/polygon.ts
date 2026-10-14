// Closed polygons as flat coordinate arrays [x0, y0, x1, y1, ...] (the last point joins
// the first). Body outlines are counter-clockwise.
// SPDX-License-Identifier: GPL-3.0-or-later

export type Poly = number[];

export interface Pose {
  x: number;
  y: number;
  /** Rotation in radians, counter-clockwise. */
  theta: number;
}

/** Shoelace area; above 0 for a counter-clockwise outline. */
export function signedArea(p: Poly): number {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  return s / 2;
}

export function ensureCcw(p: Poly): Poly {
  if (signedArea(p) >= 0) return p;
  const out: Poly = [];
  for (let i = p.length / 2 - 1; i >= 0; i--) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

export function bbox(p: Poly): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

/** The largest distance of a vertex from the origin (the body's pivot). */
export function radius(p: Poly): number {
  let r = 0;
  for (let i = 0; i < p.length; i += 2) r = Math.max(r, Math.hypot(p[i], p[i + 1]));
  return r;
}

export function transform(p: Poly, pose: Pose, scale = 1): Poly {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  const out: Poly = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i] * scale;
    const y = p[i + 1] * scale;
    out[i] = pose.x + c * x - s * y;
    out[i + 1] = pose.y + s * x + c * y;
  }
  return out;
}

/** Even-odd point-in-polygon test. */
export function contains(p: Poly, x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i];
    const yi = p[2 * i + 1];
    const xj = p[2 * j];
    const yj = p[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to the segment a-b. */
export function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Signed distance: negative inside. */
export function signedDistance(p: Poly, x: number, y: number): number {
  let d = Infinity;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d = Math.min(d, segmentDistance(x, y, p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]));
  }
  return contains(p, x, y) ? -d : d;
}

/** True when two non-adjacent edges cross (an outline that cannot be a body). */
export function selfIntersects(p: Poly): boolean {
  const n = p.length / 2;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 1; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j === i2 || j2 === i) continue;
      const [ax, ay, bx, by] = [p[2 * i], p[2 * i + 1], p[2 * i2], p[2 * i2 + 1]];
      const [cx, cy, dx, dy] = [p[2 * j], p[2 * j + 1], p[2 * j2], p[2 * j2 + 1]];
      const d1 = cross(ax, ay, bx, by, cx, cy);
      const d2 = cross(ax, ay, bx, by, dx, dy);
      const d3 = cross(cx, cy, dx, dy, ax, ay);
      const d4 = cross(cx, cy, dx, dy, bx, by);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** An outline of one or more rings (a sketch can have islands and holes): even-odd inside. */
export type Rings = Poly[];

/** Inside an even number of rings: outside (a hole in a body, or between islands). */
export function containsRings(rings: Rings, x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) if (contains(r, x, y)) inside = !inside;
  return inside;
}

/** Signed distance to the nearest ring edge: negative inside (even-odd). */
export function signedDistanceRings(rings: Rings, x: number, y: number): number {
  let d = Infinity;
  for (const r of rings) d = Math.min(d, Math.abs(signedDistance(r, x, y)));
  return containsRings(rings, x, y) ? -d : d;
}

export function transformRings(rings: Rings, pose: Pose, scale = 1): Rings {
  return rings.map((r) => transform(r, pose, scale));
}

/** The largest distance of any ring's vertex from the origin. */
export function radiusRings(rings: Rings): number {
  return rings.reduce((m, r) => Math.max(m, radius(r)), 0);
}

export function bboxRings(rings: Rings): { x0: number; y0: number; x1: number; y1: number } {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const r of rings) {
    const q = bbox(r);
    b.x0 = Math.min(b.x0, q.x0);
    b.y0 = Math.min(b.y0, q.y0);
    b.x1 = Math.max(b.x1, q.x1);
    b.y1 = Math.max(b.y1, q.y1);
  }
  return b;
}
