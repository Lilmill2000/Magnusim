// Slices of bodies across an axis, for the assembly checks (check.ts). A slice is what the kernel's
// section gives in a plane square to the axis, in the plane's own u, v (mm) with the axis at the
// origin: closed loops, here as polylines (arcs every 2 degrees, B-splines sampled), the material
// inside an odd number of them. Pure (no kernel, no UI), so the person's panel and the Assistant read
// the same numbers:
//   radialSet     the radii where a circle about the axis meets the material: a shaft is [0, r], a
//                 wheel [bore, rim]; its ends are the curves' own radii (a circle's r, exactly);
//   anglesAt      the material on the circle of radius rho, as angles (radians, counter-clockwise
//                 about the axis direction, from u);
//   boreOf        the radius of the hole round the axis when the material goes all the way round
//                 it without covering it (a wheel's bore), else null;
//   overlaps      whether two slices share material (more than a sliver along any circle);
//   firstContact  turning one slice about the axis: the first angle each way at which it meets the
//                 other (0 when they touch, `already` when they share material before turning);
//   fitGap        the radial gap between a bore and what is inside it, along rays from the axis on
//                 the curves themselves (lines and arcs exact): a D or hex shaft in its own shape of
//                 bore has the clearance between them, not the gap between two circles.
// Circles about the axis are where a turning part goes, so every test runs along them, at the radii
// where either slice changes (between those radii nothing appears or goes) and between them.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneCurve } from '../../types/kernel-protocol';

export type P2 = readonly [number, number];
/** A circular interval of angles [s, e], 0 <= s < 2pi, s < e <= s + 2pi (a full circle is [0, 2pi]). */
export type Arc = readonly [number, number];
/** A span of radii or lengths [from, to]. */
export type Span = readonly [number, number];

const TAU = 2 * Math.PI;
/** Arcs and circles become polylines with a point every this many radians. */
const ARC_STEP = TAU / 180;
/** Points per B-spline curve. */
const SPLINE_POINTS = 64;
/** Two radii closer than this are one. */
const R_EPS = 1e-7;
/** Shared material along a circle shorter than this (mm of arc) is a touch, not an overlap. */
export const ARC_MM_EPS = 1e-4;
/** Most radii one test samples between two slices. */
const SAMPLES_MAX = 900;

export interface Slice {
  /** Closed loops as polylines (the first point not repeated). */
  loops: P2[][];
  /** Each loop's curves as the kernel gave them (fitGap reads lines and arcs exactly). */
  curves: PlaneCurve[][];
  /** The radii where a circle about the axis starts or stops meeting the material, sorted, unique. */
  crit: number[];
  /** The axis lies in the material. */
  centerIn: boolean;
  /** Loops the section left open (a surface body, a cut along a face): not counted. */
  open: number;
}

const hyp = (x: number, y: number) => Math.hypot(x, y);

/** An arc's points from a0 to a1 (degrees), counter-clockwise when ccw. */
function arcPoints(c: readonly number[], r: number, a0: number, a1: number, ccw: boolean): P2[] {
  const s = (a0 * Math.PI) / 180;
  let sweep = ((((a1 - a0) % 360) + 360) % 360) * (Math.PI / 180);
  if (sweep < 1e-12) sweep = TAU;
  if (!ccw) sweep = sweep - TAU;
  if (!ccw && sweep > -1e-12) sweep = -TAU;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = s + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

/** A B-spline's point at u (de Boor; rational when it has weights). */
function deBoor(degree: number, poles: readonly (readonly number[])[], weights: readonly number[] | undefined, knots: readonly number[], u: number): P2 {
  const n = poles.length;
  let k = degree;
  while (k < n - 1 && u >= knots[k + 1]) k++;
  const w = (i: number) => (weights ? weights[i] : 1);
  const d: [number, number, number][] = [];
  for (let j = 0; j <= degree; j++) {
    const i = Math.min(n - 1, Math.max(0, j + k - degree));
    d.push([poles[i][0] * w(i), poles[i][1] * w(i), w(i)]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const den = knots[i + degree - r + 1] - knots[i];
      const a = den === 0 ? 0 : (u - knots[i]) / den;
      for (let m = 0; m < 3; m++) d[j][m] = (1 - a) * d[j - 1][m] + a * d[j][m];
    }
  }
  const h = d[degree];
  return [h[0] / h[2], h[1] / h[2]];
}

function splinePoints(c: Extract<PlaneCurve, { kind: 'bspline' }>): P2[] {
  const knots: number[] = [];
  c.knots.forEach((k, i) => {
    for (let m = 0; m < c.mults[i]; m++) knots.push(k);
  });
  const u0 = knots[c.degree];
  const u1 = knots[knots.length - c.degree - 1];
  const out: P2[] = [];
  for (let i = 0; i <= SPLINE_POINTS; i++) out.push(deBoor(c.degree, c.poles, c.weights, knots, u0 + ((u1 - u0) * i) / SPLINE_POINTS));
  return out;
}

/** One curve's points, from its own start to its end (a point is none). */
function curvePoints(c: PlaneCurve): P2[] {
  switch (c.kind) {
    case 'line':
      return [[c.a[0], c.a[1]], [c.b[0], c.b[1]]];
    case 'arc':
      return arcPoints(c.c, c.r, c.a0, c.a1, c.ccw);
    case 'circle':
      return arcPoints(c.c, c.r, 0, 360, true);
    case 'bspline':
      return splinePoints(c);
    default:
      return [];
  }
}

/** The radii where a curve starts or stops meeting circles about the origin (its nearest, farthest and end points). */
function curveRadii(c: PlaneCurve, pts: readonly P2[], out: number[]): void {
  const segRadii = () => {
    for (let i = 0; i < pts.length; i++) {
      out.push(hyp(pts[i][0], pts[i][1]));
      if (i > 0) out.push(footDistance(pts[i - 1], pts[i]));
    }
  };
  if (c.kind === 'line') {
    segRadii();
    return;
  }
  if (c.kind === 'arc' || c.kind === 'circle') {
    const d = hyp(c.c[0], c.c[1]);
    if (d < 1e-12) {
      out.push(c.r);
      if (c.kind === 'arc') {
        out.push(hyp(pts[0][0], pts[0][1]), hyp(pts[pts.length - 1][0], pts[pts.length - 1][1]));
      }
      return;
    }
    if (c.kind === 'circle') {
      out.push(Math.abs(d - c.r), d + c.r);
      return;
    }
    out.push(hyp(pts[0][0], pts[0][1]), hyp(pts[pts.length - 1][0], pts[pts.length - 1][1]));
    // The nearest and farthest points of the whole circle, when the arc holds them.
    const far = Math.atan2(c.c[1], c.c[0]);
    const near = far + Math.PI;
    if (onArc(near, c.a0, c.a1, c.ccw)) out.push(Math.abs(d - c.r));
    if (onArc(far, c.a0, c.a1, c.ccw)) out.push(d + c.r);
    return;
  }
  segRadii();
}

/** Whether angle t (radians) lies on the arc from a0 to a1 (degrees). */
function onArc(t: number, a0: number, a1: number, ccw: boolean): boolean {
  const deg = (((t * 180) / Math.PI) % 360 + 360) % 360;
  const [from, to] = ccw ? [a0, a1] : [a1, a0];
  const sweep = (((to - from) % 360) + 360) % 360 || 360;
  const at = (((deg - from) % 360) + 360) % 360;
  return at <= sweep + 1e-9;
}

/** The distance from the origin to segment a-b. */
function footDistance(a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-24) return hyp(a[0], a[1]);
  const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / l2));
  return hyp(a[0] + t * dx, a[1] + t * dy);
}

/** The kernel's section loops of one body as a slice. */
export function sliceOf(loops: readonly { closed: boolean; curves: readonly PlaneCurve[] }[]): Slice {
  const polys: P2[][] = [];
  const curves: PlaneCurve[][] = [];
  const radii: number[] = [];
  let open = 0;
  for (const loop of loops) {
    if (!loop.closed) {
      open++;
      continue;
    }
    const poly: P2[] = [];
    for (const c of loop.curves) {
      let pts = curvePoints(c);
      if (!pts.length) continue;
      curveRadii(c, pts, radii);
      // Curves run head to tail, each by its own parameter: turn one that runs backwards.
      if (poly.length) {
        const last = poly[poly.length - 1];
        const dStart = hyp(pts[0][0] - last[0], pts[0][1] - last[1]);
        const dEnd = hyp(pts[pts.length - 1][0] - last[0], pts[pts.length - 1][1] - last[1]);
        if (dEnd < dStart) pts = [...pts].reverse();
        pts = pts.slice(1);
      }
      poly.push(...pts);
    }
    // The last point closes onto the first.
    if (poly.length > 1 && hyp(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 1e-9) poly.pop();
    if (poly.length >= 3) {
      polys.push(poly);
      curves.push([...loop.curves]);
    }
  }
  const s: Slice = { loops: polys, curves, crit: uniqueSorted(radii), centerIn: false, open };
  s.centerIn = inside(s, 0, 0);
  return s;
}

function uniqueSorted(v: number[]): number[] {
  const sorted = v.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of sorted) if (!out.length || x - out[out.length - 1] > R_EPS) out.push(x);
  return out;
}

/** Whether (x, y) lies in the material (inside an odd number of loops). */
export function inside(s: Slice, x: number, y: number): boolean {
  let odd = false;
  for (const poly of s.loops) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** The largest radius of the material (0 for an empty slice). */
export const rmaxOf = (s: Slice): number => (s.crit.length ? s.crit[s.crit.length - 1] : 0);

/** The material on the circle of radius rho, as circular intervals (empty, some, or [[0, 2pi]]). */
export function anglesAt(s: Slice, rho: number): Arc[] {
  if (rho <= 0) return s.centerIn ? [[0, TAU]] : [];
  const angles: number[] = [];
  const r2 = rho * rho;
  for (const poly of s.loops) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const A = dx * dx + dy * dy;
      if (A < 1e-24) continue;
      const B = 2 * (p[0] * dx + p[1] * dy);
      const C = p[0] * p[0] + p[1] * p[1] - r2;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t >= 0 && t < 1) angles.push(norm(Math.atan2(p[1] + t * dy, p[0] + t * dx)));
      }
    }
  }
  if (!angles.length) return inside(s, rho, 0) ? [[0, TAU]] : [];
  angles.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const a of angles) if (!cuts.length || a - cuts[cuts.length - 1] > 1e-12) cuts.push(a);
  if (cuts.length > 1 && cuts[0] + TAU - cuts[cuts.length - 1] < 1e-12) cuts.pop();
  if (cuts.length === 1) return inside(s, rho * Math.cos(cuts[0] + Math.PI), rho * Math.sin(cuts[0] + Math.PI)) ? [[0, TAU]] : [];
  // Between two cuts the circle is all in or all out: its middle says which.
  const out: [number, number][] = [];
  for (let i = 0; i < cuts.length; i++) {
    const a = cuts[i];
    const b = i + 1 < cuts.length ? cuts[i + 1] : cuts[0] + TAU;
    const m = (a + b) / 2;
    if (!inside(s, rho * Math.cos(m), rho * Math.sin(m))) continue;
    if (out.length && Math.abs(out[out.length - 1][1] - a) < 1e-12) out[out.length - 1][1] = b;
    else out.push([a, b]);
  }
  // The last interval may run on into the first (across angle 0).
  if (out.length > 1 && Math.abs(out[out.length - 1][1] - TAU - out[0][0]) < 1e-12) {
    const last = out.pop()!;
    out[0] = [last[0], out[0][1] + TAU];
  }
  if (out.length === 1 && out[0][1] - out[0][0] >= TAU - 1e-12) return [[0, TAU]];
  return out;
}

const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/** Whether the material goes all the way round the circle of radius rho. */
export function fullAt(s: Slice, rho: number): boolean {
  const a = anglesAt(s, rho);
  return a.length === 1 && a[0][1] - a[0][0] >= TAU - 1e-9;
}

/** The radii between two neighbouring critical radii of `s` within [lo, hi] (their middles). */
function middles(crit: readonly number[], lo: number, hi: number): number[] {
  const cuts = [lo, ...crit.filter((r) => r > lo + R_EPS && r < hi - R_EPS), hi];
  const out: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > R_EPS) out.push((cuts[i] + cuts[i + 1]) / 2);
  return out;
}

const radialCache = new WeakMap<Slice, Span[]>();

/** The radii where a circle about the axis meets the material, as spans (a shaft [0, r], a wheel [bore, rim]). */
export function radialSet(s: Slice): Span[] {
  const hit = radialCache.get(s);
  if (hit) return hit;
  const out: [number, number][] = [];
  const cuts = [0, ...s.crit.filter((r) => r > R_EPS)];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a <= R_EPS) continue;
    if (!anglesAt(s, (a + b) / 2).length) continue;
    if (out.length && Math.abs(out[out.length - 1][1] - a) <= R_EPS) out[out.length - 1][1] = b;
    else out.push([a, b]);
  }
  radialCache.set(s, out);
  return out;
}

/**
 * The radius of the hole round the axis when the material goes all the way round it without
 * covering it (a wheel's bore, a plate's bearing hole), else null (a shaft covers the axis; a part
 * beside the axis never goes round it).
 */
export function boreOf(s: Slice): number | null {
  if (s.centerIn) return null;
  for (const [a, b] of radialSet(s)) {
    for (const rho of middles(s.crit, a, b)) if (fullAt(s, rho)) return a;
  }
  return null;
}

/** Whether the material goes all the way round the axis somewhere (a shaft, a tube, a wheel). */
export function goesRound(s: Slice): boolean {
  return s.centerIn || boreOf(s) !== null;
}

/** The overlap of two span lists (positive lengths only). */
export function spanOverlap(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const x of a) for (const y of b) {
    const lo = Math.max(x[0], y[0]);
    const hi = Math.min(x[1], y[1]);
    if (hi - lo > R_EPS) out.push([lo, hi]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** The radii where two slices are both present, sampled: each span's middles between both slices' critical radii, and points near its ends. */
function sampleRadii(a: Slice, b: Slice): number[] {
  const spans = spanOverlap(radialSet(a), radialSet(b));
  const crit = uniqueSorted([...a.crit, ...b.crit]);
  const out: number[] = [];
  for (const [lo, hi] of spans) {
    const cuts = [lo, ...crit.filter((r) => r > lo + R_EPS && r < hi - R_EPS), hi];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const p = cuts[i];
      const q = cuts[i + 1];
      const w = q - p;
      if (w <= R_EPS) continue;
      // Near both ends and three inside: what changes between two critical radii changes smoothly.
      for (const f of [0.001, 0.25, 0.5, 0.75, 0.999]) out.push(p + w * f);
    }
  }
  if (out.length <= SAMPLES_MAX) return out;
  const step = out.length / SAMPLES_MAX;
  return Array.from({ length: SAMPLES_MAX }, (_, i) => out[Math.floor(i * step)]);
}

/** The shared measure (radians) of two circular intervals, the first turned by `turn`. */
function shared(a: Arc, b: Arc, turn: number): number {
  let total = 0;
  const s0 = a[0] + turn;
  const e0 = a[1] + turn;
  for (const k of [-2, -1, 0, 1, 2]) {
    const lo = Math.max(s0, b[0] + k * TAU);
    const hi = Math.min(e0, b[1] + k * TAU);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** Whether two slices share material (more than ARC_MM_EPS along some circle about the axis). */
export function overlaps(a: Slice, b: Slice): boolean {
  for (const rho of sampleRadii(a, b)) {
    const x = anglesAt(a, rho);
    const y = anglesAt(b, rho);
    const eps = ARC_MM_EPS / rho;
    for (const p of x) for (const q of y) if (shared(p, q, 0) > eps) return true;
  }
  return false;
}

/** Where one slice, turned about the axis, first meets another: the angle (radians), the radius and the angle there of the other's edge. */
export interface Contact {
  turn: number;
  rho: number;
  theta: number;
}

/**
 * Turning slice `a` about the axis (counter-clockwise about the axis direction: `pos`; the other way:
 * `neg`): the first angle at which it meets `b` (0: they touch already). `already`: they share
 * material before turning. Null each way when they never meet (no circle about the axis holds both).
 */
export function firstContact(a: Slice, b: Slice): { already: boolean; pos: Contact | null; neg: Contact | null } {
  let pos: Contact | null = null;
  let neg: Contact | null = null;
  for (const rho of sampleRadii(a, b)) {
    const x = anglesAt(a, rho);
    const y = anglesAt(b, rho);
    if (!x.length || !y.length) continue;
    const eps = ARC_MM_EPS / rho;
    for (const p of x) for (const q of y) if (shared(p, q, 0) > eps) return { already: true, pos: null, neg: null };
    for (const p of x) {
      for (const q of y) {
        let up = norm(q[0] - p[1]);
        if (up > TAU - 1e-9) up = 0;
        if (!pos || up < pos.turn) pos = { turn: up, rho, theta: norm(q[0]) };
        let down = norm(p[0] - q[1]);
        if (down > TAU - 1e-9) down = 0;
        if (!neg || down < neg.turn) neg = { turn: down, rho, theta: norm(q[1]) };
      }
    }
  }
  return { already: false, pos, neg };
}

/** A curve of a slice as fitGap reads it: a segment, or an arc of a circle (exact); its nearest distance to the axis (a lower bound for arcs). */
type Edge =
  | { kind: 'seg'; a: P2; b: P2; near: number }
  | { kind: 'arc'; c: P2; r: number; a0: number; a1: number; ccw: boolean; full: boolean; near: number };

const edgeCache = new WeakMap<Slice, Edge[][]>();

/** Each loop's curves as edges: lines and arcs exact, B-splines as their sampled points. */
function edgesOf(s: Slice): Edge[][] {
  const hit = edgeCache.get(s);
  if (hit) return hit;
  const out = s.curves.map((loop) => {
    const edges: Edge[] = [];
    for (const c of loop) {
      if (c.kind === 'line') {
        const a: P2 = [c.a[0], c.a[1]];
        const b: P2 = [c.b[0], c.b[1]];
        edges.push({ kind: 'seg', a, b, near: footDistance(a, b) });
      } else if (c.kind === 'arc' || c.kind === 'circle') {
        const full = c.kind === 'circle';
        const d = hyp(c.c[0], c.c[1]);
        // The circle's nearest point to the axis when the arc holds it, else the nearer end.
        const ends = full ? [] : [c.a0, c.a1].map((deg) => hyp(c.c[0] + c.r * Math.cos((deg * Math.PI) / 180), c.c[1] + c.r * Math.sin((deg * Math.PI) / 180)));
        const toward = d < 1e-12 ? 0 : Math.atan2(-c.c[1], -c.c[0]);
        const near = full || d < 1e-12 || onArc(toward, c.a0, c.a1, c.ccw) ? Math.abs(d - c.r) : Math.min(...ends);
        edges.push({ kind: 'arc', c: [c.c[0], c.c[1]], r: c.r, a0: full ? 0 : c.a0, a1: full ? 360 : c.a1, ccw: full ? true : c.ccw, full, near });
      } else {
        const pts = curvePoints(c);
        for (let i = 0; i + 1 < pts.length; i++) edges.push({ kind: 'seg', a: pts[i], b: pts[i + 1], near: footDistance(pts[i], pts[i + 1]) });
      }
    }
    return edges;
  });
  edgeCache.set(s, out);
  return out;
}

/** Where the ray from the axis along (dx, dy) crosses an edge: its distances along the ray (above 0). */
function rayHits(e: Edge, dx: number, dy: number, out: number[]): void {
  if (e.kind === 'seg') {
    const ex = e.b[0] - e.a[0];
    const ey = e.b[1] - e.a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-15) return;
    const t = (e.a[0] * ey - e.a[1] * ex) / den;
    const s = (e.a[0] * dy - e.a[1] * dx) / den;
    if (t > 0 && s >= -1e-12 && s <= 1 + 1e-12) out.push(t);
    return;
  }
  const b = dx * e.c[0] + dy * e.c[1];
  const disc = b * b - (e.c[0] * e.c[0] + e.c[1] * e.c[1]) + e.r * e.r;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  for (const t of [b - sq, b + sq]) {
    if (t <= 0) continue;
    if (!e.full && !onArc(Math.atan2(t * dy - e.c[1], t * dx - e.c[0]), e.a0, e.a1, e.ccw)) continue;
    out.push(t);
  }
}

/** Rays per turn fitGap always tries, besides where the curves end or come nearest the axis. */
const GAP_RAYS = 360;
/** A crossing of the material inside this far (mm) past the bore's edge still ends it there (a press fit drawn equal). */
const GAP_TOUCH = 1e-3;

/**
 * The radial gap between the bore of `outer` (its loop nearest the axis: the edge of the hole the
 * axis is in) and the material of `inner` inside it: the least, over rays from the axis, of how far
 * the bore's edge lies beyond the inner material's last edge before it. Exact on lines and arcs at
 * the rays tried (every degree, where each curve ends, where each line and circle comes nearest the
 * axis). Null when no ray finds both. For slices that do not share material (overlaps): it reads
 * their edges, not what lies between them.
 */
export function fitGap(outer: Slice, inner: Slice): number | null {
  const loops = edgesOf(outer);
  let bore = -1;
  let nearest = Infinity;
  loops.forEach((loop, k) => {
    for (const e of loop) {
      if (e.near < nearest) {
        nearest = e.near;
        bore = k;
      }
    }
  });
  if (bore < 0) return null;
  const be = loops[bore];
  // The inner material that can lie inside the bore: within its farthest point.
  const far = Math.max(...outer.loops[bore].map((p) => hyp(p[0], p[1]))) * 1.001 + 1e-6;
  const ie = edgesOf(inner)
    .flat()
    .filter((e) => e.near <= far);
  if (!ie.length) return null;
  const angles: number[] = [];
  for (let i = 0; i < GAP_RAYS; i++) angles.push((i * TAU) / GAP_RAYS);
  for (const e of [...be, ...ie]) {
    if (e.kind === 'seg') {
      angles.push(Math.atan2(e.a[1], e.a[0]), Math.atan2(e.b[1], e.b[0]));
      const dx = e.b[0] - e.a[0];
      const dy = e.b[1] - e.a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, -(e.a[0] * dx + e.a[1] * dy) / l2));
      angles.push(Math.atan2(e.a[1] + t * dy, e.a[0] + t * dx));
    } else {
      if (!e.full) for (const deg of [e.a0, e.a1]) angles.push(Math.atan2(e.c[1] + e.r * Math.sin((deg * Math.PI) / 180), e.c[0] + e.r * Math.cos((deg * Math.PI) / 180)));
      if (hyp(e.c[0], e.c[1]) > 1e-12) angles.push(Math.atan2(e.c[1], e.c[0]), Math.atan2(-e.c[1], -e.c[0]));
    }
  }
  let best = Infinity;
  const hits: number[] = [];
  for (const th of angles) {
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    hits.length = 0;
    for (const e of be) rayHits(e, dx, dy, hits);
    if (!hits.length) continue;
    const edge = Math.min(...hits);
    hits.length = 0;
    for (const e of ie) rayHits(e, dx, dy, hits);
    let last = -Infinity;
    for (const t of hits) if (t <= edge + GAP_TOUCH && t > last) last = t;
    const gap = last === -Infinity ? (inner.centerIn ? 0 : null) : edge - last;
    if (gap !== null && gap < best) best = gap;
  }
  return Number.isFinite(best) ? best : null;
}
