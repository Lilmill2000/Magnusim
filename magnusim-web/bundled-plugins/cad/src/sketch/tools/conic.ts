// Ellipses, arcs of an ellipse, arcs of a parabola and rho conics as curves of
// their solved points: each one's frame (centre, axes, radii; focus and vertex),
// a parameter s in [0, 1] along it (an ellipse from its major end, counter-
// clockwise; an arc from its counter-clockwise start; a parabola or a conic
// from `a` to `b`), points and derivatives, the closest point, samples, the
// exact rational B-spline the kernel builds (quadratic pieces: an ellipse in
// quarter-turn pieces, a parabola piece as one quadratic Bezier, a conic as
// its rational quadratic Bezier), pieces for Trim, and the words the panels use.
// model.ts, pick.ts, edit.ts and the sketch feature's geometry call these.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchConicEntity, SketchEntity, SketchFeature, Vec2 } from '../../types/doc';
import type { ParamCurve } from './bspline';

type Pts = Pick<SketchFeature, 'points'>;
export type ConicKind = SketchConicEntity['kind'];
export const CONIC_KINDS: readonly ConicKind[] = ['ellipse', 'ellipse_arc', 'parabola', 'conic'];

const TAU = Math.PI * 2;
const at = (f: Pts, id: string): Vec2 | null => (id === 'origin' ? [0, 0] : (f.points[id] ?? null));
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const wrap = (a: number) => {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
};

export function isConic(e: SketchEntity | null | undefined): e is SketchConicEntity {
  return !!e && (CONIC_KINDS as readonly string[]).includes(e.kind);
}

/** Every point id it uses (ellipse: centre, major end, minor end; arcs add their ends; parabola: focus, vertex, ends; conic: ends, top). */
export function conicPointIds(e: SketchConicEntity): string[] {
  switch (e.kind) {
    case 'ellipse':
      return [e.c, e.major, e.minor];
    case 'ellipse_arc':
      return [e.c, e.major, e.minor, e.a, e.b];
    case 'parabola':
      return [e.f, e.v, e.a, e.b];
    case 'conic':
      return [e.a, e.b, e.t];
  }
}

/** Its end point ids (an ellipse has none). */
export function conicEndIds(e: SketchConicEntity): string[] {
  return e.kind === 'ellipse' ? [] : [e.a, e.b];
}

/** The centre point id of an ellipse or an arc of one. */
export function conicCentre(e: SketchEntity): string | null {
  return e.kind === 'ellipse' || e.kind === 'ellipse_arc' ? e.c : null;
}

// ------------------------------------------------------------ frames

/** An ellipse's frame: centre, unit major direction `ux`, `uy` = ux turned +90 degrees, radii (major >= minor > 0). */
export interface EllipseFrame {
  c: Vec2;
  ux: Vec2;
  uy: Vec2;
  major: number;
  minor: number;
  /** The minor end's side: +1 on uy's side, -1 on the other. */
  side: 1 | -1;
}

/** The frame from a centre, a major end and a minor end (the minor radius is the minor end's distance across the major axis). */
export function ellipseFrameOf(c: Vec2, major: Vec2, minor: Vec2): EllipseFrame | null {
  const d = sub(major, c);
  const A = Math.hypot(d[0], d[1]);
  if (!(A > 0)) return null;
  const ux: Vec2 = [d[0] / A, d[1] / A];
  const uy: Vec2 = [-ux[1], ux[0]];
  const y = dot(sub(minor, c), uy);
  const B = Math.abs(y);
  if (!(B > 0)) return null;
  return { c, ux, uy, major: A, minor: B, side: y < 0 ? -1 : 1 };
}

export function ellipseFrame(f: Pts, e: Extract<SketchConicEntity, { kind: 'ellipse' | 'ellipse_arc' }>): EllipseFrame | null {
  const c = at(f, e.c);
  const M = at(f, e.major);
  const N = at(f, e.minor);
  return c && M && N ? ellipseFrameOf(c, M, N) : null;
}

/** The point at eccentric angle t. */
export function ellipsePoint(g: EllipseFrame, t: number): Vec2 {
  const x = g.major * Math.cos(t);
  const y = g.minor * Math.sin(t);
  return [g.c[0] + x * g.ux[0] + y * g.uy[0], g.c[1] + x * g.ux[1] + y * g.uy[1]];
}

/** The eccentric angle of a point (exact on the curve; the angle of its scaled position otherwise), in [0, 2pi). */
export function ellipseAngle(g: EllipseFrame, p: Vec2): number {
  const q = sub(p, g.c);
  return wrap(Math.atan2(dot(q, g.uy) / g.minor, dot(q, g.ux) / g.major));
}

/** A parabola's frame: vertex, unit axis `ux` towards the focus, `uy` = ux turned +90, focal length p. */
export interface ParabolaFrame {
  v: Vec2;
  ux: Vec2;
  uy: Vec2;
  p: number;
}

export function parabolaFrameOf(focus: Vec2, vertex: Vec2): ParabolaFrame | null {
  const d = sub(focus, vertex);
  const p = Math.hypot(d[0], d[1]);
  if (!(p > 0)) return null;
  const ux: Vec2 = [d[0] / p, d[1] / p];
  return { v: vertex, ux, uy: [-ux[1], ux[0]], p };
}

/** The parabola's point at u (its distance across the axis): v + u^2 / (4p) ux + u uy. */
export function parabolaPoint(g: ParabolaFrame, u: number): Vec2 {
  const x = (u * u) / (4 * g.p);
  return [g.v[0] + x * g.ux[0] + u * g.uy[0], g.v[1] + x * g.ux[1] + u * g.uy[1]];
}
export function parabolaDeriv(g: ParabolaFrame, u: number): Vec2 {
  const x = u / (2 * g.p);
  return [x * g.ux[0] + g.uy[0], x * g.ux[1] + g.uy[1]];
}
/** A point's u (its distance across the axis; exact on the curve). */
export function parabolaU(g: ParabolaFrame, p: Vec2): number {
  return dot(sub(p, g.v), g.uy);
}

/** The rho conic's middle weight: rho / (1 - rho). */
export const rhoWeight = (rho: number) => rho / (1 - rho);
/** rho from a normalised middle weight. */
export const weightRho = (w: number) => w / (1 + w);
/** Whether rho is one a conic takes: strictly between 0 and 1. */
export const rhoOk = (rho: number) => Number.isFinite(rho) && rho > 0 && rho < 1;

/** The rational quadratic Bezier (P0, P1, P2; weights 1, w, 1) at s: point and derivative. */
export function rationalQuad(P0: Vec2, P1: Vec2, P2: Vec2, w: number, s: number): [Vec2, Vec2] {
  const b0 = (1 - s) * (1 - s);
  const b1 = 2 * s * (1 - s);
  const b2 = s * s;
  const W = b0 + w * b1 + b2;
  const N: Vec2 = [b0 * P0[0] + w * b1 * P1[0] + b2 * P2[0], b0 * P0[1] + w * b1 * P1[1] + b2 * P2[1]];
  const d0 = -2 * (1 - s);
  const d1 = 2 - 4 * s;
  const d2 = 2 * s;
  const dW = d0 + w * d1 + d2;
  const dN: Vec2 = [d0 * P0[0] + w * d1 * P1[0] + d2 * P2[0], d0 * P0[1] + w * d1 * P1[1] + d2 * P2[1]];
  return [
    [N[0] / W, N[1] / W],
    [(dN[0] * W - N[0] * dW) / (W * W), (dN[1] * W - N[1] * dW) / (W * W)],
  ];
}

/** The shoulder point of a rho conic: rho of the way from the chord's midpoint to the top point. */
export function conicShoulder(a: Vec2, b: Vec2, t: Vec2, rho: number): Vec2 {
  const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [m[0] + rho * (t[0] - m[0]), m[1] + rho * (t[1] - m[1])];
}

/** rho from a point the curve should pass near: its projection on the line from the chord's midpoint to the top point. */
export function rhoThrough(a: Vec2, b: Vec2, t: Vec2, p: Vec2): number {
  const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const d = sub(t, m);
  const l2 = dot(d, d);
  return l2 > 0 ? dot(sub(p, m), d) / l2 : NaN;
}

// ------------------------------------------------------------ the curve

/** An exact rational B-spline (OCCT form: distinct knots and multiplicities); weights absent = non-rational. */
export interface Nurbs {
  degree: number;
  poles: Vec2[];
  weights?: number[];
  knots: number[];
  mults: number[];
}

/** A conic entity's curve now: s in [0, 1] along it. */
export interface ConicCurve {
  kind: ConicKind;
  closed: boolean;
  /** Point and derivative (d/ds) at s. */
  at(s: number): [Vec2, Vec2];
  /** The point ids at s = 0 and s = 1 (an ellipse: its major end at both). */
  startId: string;
  endId: string;
  ellipse?: EllipseFrame;
  /** An ellipse or an arc of one: the eccentric angle at s = 0 and the counter-clockwise sweep. */
  t0?: number;
  sweep?: number;
  parabola?: ParabolaFrame;
  /** A parabola piece: u at s = 0 and at s = 1. */
  u0?: number;
  u1?: number;
  /** A conic: its control points and middle weight. */
  bez?: { P0: Vec2; P1: Vec2; P2: Vec2; w: number };
}

function ellipseCurve(g: EllipseFrame, t0: number, sweep: number, closed: boolean, startId: string, endId: string, kind: ConicKind): ConicCurve {
  return {
    kind,
    closed,
    startId,
    endId,
    ellipse: g,
    t0,
    sweep,
    at: (s) => {
      const t = t0 + sweep * s;
      const x = -g.major * Math.sin(t) * sweep;
      const y = g.minor * Math.cos(t) * sweep;
      return [ellipsePoint(g, t), [x * g.ux[0] + y * g.uy[0], x * g.ux[1] + y * g.uy[1]]];
    },
  };
}

/** The curve of a conic entity against the sketch's points, or null when its points make none. */
export function conicCurve(f: Pts, e: SketchConicEntity): ConicCurve | null {
  switch (e.kind) {
    case 'ellipse': {
      const g = ellipseFrame(f, e);
      return g ? ellipseCurve(g, 0, TAU, true, e.major, e.major, 'ellipse') : null;
    }
    case 'ellipse_arc': {
      const g = ellipseFrame(f, e);
      const a = at(f, e.a);
      const b = at(f, e.b);
      if (!g || !a || !b) return null;
      const ccw = e.ccw !== false;
      const s = ellipseAngle(g, ccw ? a : b);
      const t = ellipseAngle(g, ccw ? b : a);
      let sweep = wrap(t - s);
      if (!(sweep > 1e-12)) sweep = TAU;
      return ellipseCurve(g, s, sweep, false, ccw ? e.a : e.b, ccw ? e.b : e.a, 'ellipse_arc');
    }
    case 'parabola': {
      const F = at(f, e.f);
      const V = at(f, e.v);
      const a = at(f, e.a);
      const b = at(f, e.b);
      if (!F || !V || !a || !b) return null;
      const g = parabolaFrameOf(F, V);
      if (!g) return null;
      const u0 = parabolaU(g, a);
      const u1 = parabolaU(g, b);
      if (!(Math.abs(u1 - u0) > 0)) return null;
      return {
        kind: 'parabola',
        closed: false,
        startId: e.a,
        endId: e.b,
        parabola: g,
        u0,
        u1,
        at: (s) => {
          const u = u0 + (u1 - u0) * s;
          const d = parabolaDeriv(g, u);
          return [parabolaPoint(g, u), [d[0] * (u1 - u0), d[1] * (u1 - u0)]];
        },
      };
    }
    case 'conic': {
      const P0 = at(f, e.a);
      const P2 = at(f, e.b);
      const P1 = at(f, e.t);
      if (!P0 || !P1 || !P2 || !rhoOk(e.rho)) return null;
      const cr = (P1[0] - P0[0]) * (P2[1] - P0[1]) - (P1[1] - P0[1]) * (P2[0] - P0[0]);
      if (!(Math.abs(cr) > 0)) return null;
      const w = rhoWeight(e.rho);
      return { kind: 'conic', closed: false, startId: e.a, endId: e.b, bez: { P0, P1, P2, w }, at: (s) => rationalQuad(P0, P1, P2, w, s) };
    }
  }
}

/** The curve as a ParamCurve (crossings with other curves, src/sketch/tools/bspline.ts crossCurves). */
export function conicParamCurve(c: ConicCurve): ParamCurve {
  const n = c.sweep != null ? Math.max(24, Math.ceil((c.sweep / TAU) * 128)) : 64;
  return { at: (s) => c.at(s), t0: 0, t1: 1, samples: n, ...(c.closed ? { closed: true } : {}) };
}

/** Points along it, `n` over a whole turn (ellipses) or along the piece. */
export function conicPolyline(c: ConicCurve, n = 96): Vec2[] {
  const k = c.sweep != null ? Math.max(8, Math.ceil((n * c.sweep) / TAU)) : Math.max(16, Math.ceil(n / 2));
  return Array.from({ length: k + 1 }, (_, i) => c.at(i / k)[0]);
}

/** The point of the curve between s0 and s1 nearest p (golden-section on the distance). */
function refine(c: ConicCurve, p: Vec2, lo: number, hi: number): { s: number; p: Vec2; d: number } {
  const d2 = (s: number) => {
    const q = c.at(s)[0];
    return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let x1 = b - g * (b - a);
  let x2 = a + g * (b - a);
  let f1 = d2(x1);
  let f2 = d2(x2);
  for (let i = 0; i < 80 && b - a > 1e-14; i++) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - g * (b - a);
      f1 = d2(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + g * (b - a);
      f2 = d2(x2);
    }
  }
  const s = (a + b) / 2;
  const q = c.at(s)[0];
  return { s, p: q, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

/** The closest point of the curve to p: its parameter s, the point, the distance. */
export function closestOnConicCurve(c: ConicCurve, p: Vec2): { s: number; p: Vec2; d: number } {
  const n = 128;
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i <= n; i++) {
    const q = c.at(i / n)[0];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  let r = refine(c, p, Math.max(0, (best - 1) / n), Math.min(1, (best + 1) / n));
  // A closed curve: the seam's other side.
  if (c.closed && (best === 0 || best === n)) {
    const o = best === 0 ? refine(c, p, (n - 1) / n, 1) : refine(c, p, 0, 1 / n);
    if (o.d < r.d) r = o;
  }
  // Exact ends.
  for (const s of [0, 1]) {
    const q = c.at(s)[0];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < r.d) r = { s, p: q, d };
  }
  return r;
}

/** The parameter s of a point on (or near) the curve. */
export function conicParamOf(c: ConicCurve, p: Vec2): number {
  if (c.ellipse && c.sweep != null && c.t0 != null) {
    const t = ellipseAngle(c.ellipse, p);
    const d = wrap(t - c.t0);
    if (c.closed) return d / TAU;
    if (d <= c.sweep + 1e-12) return Math.min(1, d / c.sweep);
    return d - c.sweep < TAU - d ? 1 : 0;
  }
  if (c.parabola && c.u0 != null && c.u1 != null) {
    const s = (parabolaU(c.parabola, p) - c.u0) / (c.u1 - c.u0);
    return Math.max(0, Math.min(1, s));
  }
  return closestOnConicCurve(c, p).s;
}

// ------------------------------------------------------------ exact rational B-splines (the kernel's curves)

/** The unit circle from angle a to a + sweep as quadratic rational pieces of at most a quarter turn, mapped by `map`. */
function arcNurbs(t0: number, sweep: number, map: (x: number, y: number) => Vec2): Nurbs {
  const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
  const d = sweep / n;
  const w = Math.cos(d / 2);
  const poles: Vec2[] = [];
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = t0 + i * d;
    const m = a + d / 2;
    if (i === 0) {
      poles.push(map(Math.cos(a), Math.sin(a)));
      weights.push(1);
    }
    poles.push(map(Math.cos(m) / w, Math.sin(m) / w));
    weights.push(w);
    poles.push(map(Math.cos(a + d), Math.sin(a + d)));
    weights.push(1);
  }
  const knots = Array.from({ length: n + 1 }, (_, i) => i / n);
  const mults = knots.map((_, i) => (i === 0 || i === n ? 3 : 2));
  return { degree: 2, poles, weights, knots, mults };
}

/** The curve as an exact rational B-spline (a closed ellipse starts and ends at its major end). */
export function conicNurbs(c: ConicCurve): Nurbs {
  if (c.ellipse && c.t0 != null && c.sweep != null) {
    const g = c.ellipse;
    const out = arcNurbs(c.t0, c.sweep, (x, y) => {
      const X = g.major * x;
      const Y = g.minor * y;
      return [g.c[0] + X * g.ux[0] + Y * g.uy[0], g.c[1] + X * g.ux[1] + Y * g.uy[1]];
    });
    // The ends exactly where the curve's own evaluation puts them (a closed one shares its first pole).
    out.poles[0] = c.at(0)[0];
    out.poles[out.poles.length - 1] = c.closed ? out.poles[0] : c.at(1)[0];
    return out;
  }
  if (c.parabola && c.u0 != null && c.u1 != null) {
    // A parabola piece is a polynomial quadratic: one Bezier, its middle pole where the end tangents meet.
    const P0 = parabolaPoint(c.parabola, c.u0);
    const P2 = parabolaPoint(c.parabola, c.u1);
    const d = parabolaDeriv(c.parabola, c.u0);
    const h = (c.u1 - c.u0) / 2;
    return { degree: 2, poles: [P0, [P0[0] + h * d[0], P0[1] + h * d[1]], P2], knots: [0, 1], mults: [3, 3] };
  }
  const z = c.bez!;
  return { degree: 2, poles: [z.P0, z.P1, z.P2], weights: [1, z.w, 1], knots: [0, 1], mults: [3, 3] };
}

/** The piece of a rational quadratic Bezier between s0 and s1 (blossoming in homogeneous coordinates), normalised to end weights 1. */
export function subConic(P0: Vec2, P1: Vec2, P2: Vec2, w: number, s0: number, s1: number): { P0: Vec2; P1: Vec2; P2: Vec2; w: number } {
  const H = [
    [P0[0], P0[1], 1],
    [w * P1[0], w * P1[1], w],
    [P2[0], P2[1], 1],
  ];
  const blossom = (x: number, y: number) => {
    const c0 = (1 - x) * (1 - y);
    const c1 = (1 - x) * y + x * (1 - y);
    const c2 = x * y;
    return [0, 1, 2].map((k) => c0 * H[0][k] + c1 * H[1][k] + c2 * H[2][k]);
  };
  const R0 = blossom(s0, s0);
  const R1 = blossom(s0, s1);
  const R2 = blossom(s1, s1);
  const pt = (R: number[]): Vec2 => [R[0] / R[2], R[1] / R[2]];
  return { P0: pt(R0), P1: pt(R1), P2: pt(R2), w: R1[2] / Math.sqrt(R0[2] * R2[2]) };
}

// ------------------------------------------------------------ words

export const CONIC_WORDS: Record<ConicKind, string> = { ellipse: 'Ellipse', ellipse_arc: 'Partial ellipse', parabola: 'Parabola', conic: 'Conic' };

/** The role of one of its points ("Centre", "Major axis end", "Focus", "Top"), or null for an end. */
export function conicPointRole(e: SketchConicEntity, id: string): string | null {
  if ((e.kind === 'ellipse' || e.kind === 'ellipse_arc') && e.c === id) return 'Centre';
  if ((e.kind === 'ellipse' || e.kind === 'ellipse_arc') && e.major === id) return 'Major axis end';
  if ((e.kind === 'ellipse' || e.kind === 'ellipse_arc') && e.minor === id) return 'Minor axis end';
  if (e.kind === 'parabola' && e.f === id) return 'Focus';
  if (e.kind === 'parabola' && e.v === id) return 'Vertex';
  if (e.kind === 'conic' && e.t === id) return 'Top';
  return null;
}
