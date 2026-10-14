// The live surface-pressure plot's geometry: points along a body's outline, evenly spaced,
// each a set distance out along the outward normal (read one cell off the wall, as
// surface.ts does for the validation runs); and the split into the upper and lower surfaces
// from the leading point (the most upstream one, in the body's own frame), as XFOIL plots Cp.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Poly, Rings } from '../geometry/polygon';

/** Twice the signed area of a polygon (counter-clockwise positive). */
function area2(p: Poly): number {
  let a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a;
}

/** The outer ring of an outline: the one of largest area, counter-clockwise. */
export function outerRing(rings: Rings): Poly {
  let best: Poly = [];
  let ba = 0;
  for (const r of rings) {
    const a = Math.abs(area2(r));
    if (a > ba) {
      ba = a;
      best = r;
    }
  }
  if (area2(best) >= 0) return best;
  const out: number[] = [];
  for (let i = best.length - 2; i >= 0; i -= 2) out.push(best[i], best[i + 1]);
  return out;
}

export interface SurfacePoint {
  /** On the outline (body frame). */
  x: number;
  y: number;
  /** Where it is read: `offset` out along the outward normal. */
  px: number;
  py: number;
}

/**
 * Points every `spacing` along a counter-clockwise ring (closed), in order, each with its read
 * point `offset` outside. At a vertex the normal is between its two edges'.
 */
export function surfacePoints(ring: Poly, spacing: number, offset: number): SurfacePoint[] {
  const n = ring.length >> 1;
  if (n < 3) return [];
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(ring[2 * j] - ring[2 * i], ring[2 * j + 1] - ring[2 * i + 1]);
    seg.push(l);
    total += l;
  }
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;
  const out: SurfacePoint[] = [];
  let i = 0;
  let along = 0;
  for (let k = 0; k < count; k++) {
    const s = k * step;
    while (i < n - 1 && along + seg[i] < s) along += seg[i++];
    const j = (i + 1) % n;
    const t = seg[i] > 0 ? (s - along) / seg[i] : 0;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const dx = ring[2 * j] - ax;
    const dy = ring[2 * j + 1] - ay;
    const l = Math.hypot(dx, dy) || 1;
    // Outward on a counter-clockwise ring: the edge turned clockwise.
    let nx = dy / l;
    let ny = -dx / l;
    if (t < 1e-6) {
      const h = (i - 1 + n) % n;
      const ex = ax - ring[2 * h];
      const ey = ay - ring[2 * h + 1];
      const el = Math.hypot(ex, ey) || 1;
      nx += ey / el;
      ny += -ex / el;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
    }
    const x = ax + dx * t;
    const y = ay + dy * t;
    out.push({ x, y, px: x + nx * offset, py: y + ny * offset });
  }
  return out;
}

export interface CpPoint {
  /** Along the body's own x: 0 at its leading point, 1 at its trailing one. */
  x: number;
  cp: number;
}

/**
 * Split values read round a counter-clockwise outline into its lower surface (a
 * counter-clockwise ring runs from its most upstream point along the lower side) and its
 * upper one, each by x/c from 0 to 1. Null values (read inside a body) are left out.
 */
export function splitSurface(pts: { x: number; y: number }[], cp: (number | null)[]): { upper: CpPoint[]; lower: CpPoint[] } {
  const n = pts.length;
  if (n < 3) return { upper: [], lower: [] };
  let lead = 0;
  let trail = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[lead].x) lead = i;
    if (pts[i].x > pts[trail].x) trail = i;
  }
  const x0 = pts[lead].x;
  const span = pts[trail].x - x0 || 1;
  const toTrail = (trail - lead + n) % n;
  const lower: CpPoint[] = [];
  const upper: CpPoint[] = [];
  for (let k = 0; k < n; k++) {
    const i = (lead + k) % n;
    const v = cp[i];
    if (v == null || !Number.isFinite(v)) continue;
    const c = { x: (pts[i].x - x0) / span, cp: v };
    if (k <= toTrail) lower.push(c);
    if (k === 0 || k >= toTrail) upper.push(c);
  }
  upper.sort((a, b) => a.x - b.x);
  lower.sort((a, b) => a.x - b.x);
  return { upper, lower };
}
