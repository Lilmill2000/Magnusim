// A spline entity against the sketch's solved points: its point ids, its ends,
// its B-spline (src/sketch/tools/bspline.ts) and what the shared sketch code
// asks of any curve (samples, distance, closest point). model.ts, pick.ts and
// the sketch feature's geometry call these for kind 'spline'.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, SketchSplineEntity, Vec2 } from '../../types/doc';
import { closestOnSpline, splineCurve, splinePolyline, type BSpline } from './bspline';

type Pts = Pick<SketchFeature, 'points'>;

const at = (f: Pts, id: string): Vec2 | null => (id === 'origin' ? [0, 0] : (f.points[id] ?? null));

/** Every point id the spline uses: its fit points or poles, then its handles. */
export function splinePointIds(e: SketchSplineEntity): string[] {
  const out = [...e.pts];
  for (const h of e.handles ?? []) if (h && !out.includes(h)) out.push(h);
  return out;
}

/** Its end point ids (open), or none (closed). */
export function splineEndIds(e: SketchSplineEntity): string[] {
  return e.closed ? [] : [e.pts[0], e.pts[e.pts.length - 1]];
}

/** The spline's curve now, or null when a point is missing or the points make no curve. */
export function splineOf(f: Pts, e: SketchSplineEntity): BSpline | null {
  const pts: Vec2[] = [];
  for (const id of e.pts) {
    const p = at(f, id);
    if (!p) return null;
    pts.push(p);
  }
  const handles: [Vec2 | null, Vec2 | null] = [e.handles?.[0] ? at(f, e.handles[0]) : null, e.handles?.[1] ? at(f, e.handles[1]) : null];
  try {
    return splineCurve({ form: e.form, degree: e.degree, pts, closed: e.closed, handles, knots: e.knots, mults: e.mults, spans: e.spans });
  } catch {
    return null;
  }
}

/** Points along it for drawing and window tests (empty when it has no curve). */
export function splineSamples(f: Pts, e: SketchSplineEntity, n = 48): Vec2[] {
  const b = splineOf(f, e);
  if (!b) return [];
  const spans = b.knots.length - 1;
  return splinePolyline(b, Math.max(4, Math.ceil(n / Math.max(1, spans))));
}

export function distanceToSpline(f: Pts, e: SketchSplineEntity, p: Vec2): number {
  const b = splineOf(f, e);
  return b ? closestOnSpline(b, p).d : Infinity;
}

export function closestOnSplineEntity(f: Pts, e: SketchSplineEntity, p: Vec2): Vec2 | null {
  const b = splineOf(f, e);
  return b ? closestOnSpline(b, p).p : null;
}

// ------------------------------------------------------------ a built spline as a polyline (model-mode readers)

/** Length of a polyline. */
export function polyLength(poly: readonly Vec2[]): number {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return L;
}

/** The fraction (0..1 of its length) of a polyline nearest a point. */
export function polyFraction(poly: readonly Vec2[], q: Vec2): number {
  const L = polyLength(poly);
  if (!(L > 0)) return 0;
  let best = Infinity;
  let at = 0;
  let run = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
    const l = Math.sqrt(l2);
    if (d < best) {
      best = d;
      at = run + t * l;
    }
    run += l;
  }
  return at / L;
}

/** Distance from a point to a polyline. */
export function polyDistance(poly: readonly Vec2[], q: Vec2): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
  }
  return poly.length === 1 ? Math.hypot(q[0] - poly[0][0], q[1] - poly[0][1]) : best;
}

/** The point and unit direction at a fraction of a polyline's length. */
export function polyAt(poly: readonly Vec2[], fraction: number): { p: Vec2; dir: Vec2 } | null {
  const L = polyLength(poly);
  if (!(L > 0)) return null;
  const want = Math.max(0, Math.min(1, fraction)) * L;
  let run = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run + l >= want || i === poly.length - 1) {
      const t = l ? Math.min(1, (want - run) / l) : 0;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: l ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0] };
    }
    run += l;
  }
  return null;
}
