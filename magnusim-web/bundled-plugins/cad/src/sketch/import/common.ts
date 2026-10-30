// SVG and DXF drawings into a sketch: the part both formats share. What a drawing reads as
// (DrawingCurve: lines, circles, arcs, ellipses and their arcs, B-splines, fit-point splines and
// points, in the drawing's own units with y up), the caps on an untrusted file, the exact maths
// (an affine map of a circle or an ellipse piece, a B-spline as Bezier pieces, degree elevation),
// and the import itself (planImport, importIntoDraft): the curves of the layers kept, scaled and
// placed, joined where their ends meet within max(1e-4 mm, min(1e-6 of the drawing's size, 1e-3 of
// its middle-sized curve)) (one sketch point; no other relation is added, so the result is
// under-defined as imported geometry is), duplicates and pieces too small to draw left out, what
// it weighs for the sketch solver capped (solverLoad), and the summary the person's panel and
// the Assistant's reply both give (summaryWords). Pure data in and out (unit-tested): the
// person's Import SVG/DXF (tool.ts) and the Assistant's import row (assistant/sketch/ops.ts) both
// run importIntoDraft on what readDrawing (index.ts) read.
// SPDX-License-Identifier: GPL-3.0-or-later
import { newId } from '../../lib/ids';
import type { SketchEntity, Vec2 } from '../../types/doc';
import { SketchBuilder, type EditOutcome, type SketchDraft } from '../edit';
import { fitSpline, splinePolyline } from '../tools/bspline';

type V2 = Vec2;

/** The host's cap on an attached drawing, and the person's file: 20 MiB. */
export const DRAWING_MAX_BYTES = 20 * 1024 * 1024;
/**
 * The most one import may weigh for the sketch solver (solverLoad: each sketch point 1, a circle 1
 * more, an arc or an ellipse 20 more, a partial ellipse 40 more): a drawing over it is refused
 * with its weight. Every later edit of the sketch solves and analyses all of it: at this load each
 * takes about a second, where 1,000 arcs take ten and 1,500 break the solver.
 */
export const IMPORT_MAX_LOAD = 10_000;
/** What a curve the solver holds by rules of its own weighs over its points (solverLoad). */
const RULE_LOAD: Readonly<Partial<Record<DrawingCurve['kind'], number>>> = { circle: 1, arc: 20, ellipse: 20, ellipse_arc: 40 };
/** The most curves a file is read for (blocks inserted many times stop here): the reading's own cap. */
export const READ_MAX_CURVES = 100_000;
/** A SPLINE past this degree is left out (its maths grows with the square of it). */
export const READ_MAX_DEGREE = 25;
/** A SPLINE with more control or fit points than this is left out (no sketch carries it). */
export const READ_MAX_SPLINE_POINTS = 100_000;

/** A drawing that cannot be imported, with the reason in the person's words. */
export class DrawingRefused extends Error {}

interface CurveBase {
  /** The DXF layer it is on (an SVG has none). */
  layer?: string;
}

/** One curve of a drawing, in its units, y up. Arcs run from a to b, counter-clockwise unless ccw is false. */
export type DrawingCurve = CurveBase &
  (
    | { kind: 'line'; a: V2; b: V2 }
    | { kind: 'circle'; c: V2; r: number }
    | { kind: 'arc'; c: V2; r: number; a: V2; b: V2; ccw: boolean }
    /** ux: the unit major direction; A >= B > 0 the radii. */
    | { kind: 'ellipse'; c: V2; ux: V2; A: number; B: number }
    | { kind: 'ellipse_arc'; c: V2; ux: V2; A: number; B: number; a: V2; b: V2; ccw: boolean }
    /** Clamped, non-rational, OCCT form (distinct knots and multiplicities). */
    | { kind: 'bspline'; degree: number; poles: V2[]; knots: number[]; mults: number[] }
    /** A curve through these points (the sketch's fit spline); closed does not repeat the first. */
    | { kind: 'fit'; pts: V2[]; closed: boolean }
    | { kind: 'point'; p: V2 }
  );

export interface DrawingLayer {
  name: string;
  /** Curves on it. */
  count: number;
  /** Off or frozen in the file: left out unless asked for. */
  off: boolean;
}

/** What a drawing file read as. */
export interface Drawing {
  format: 'svg' | 'dxf';
  /** The file's name. */
  name: string;
  curves: DrawingCurve[];
  /** mm per drawing unit, as its units say. */
  mmPerUnit: number;
  /** Where that came from, in words ("width 210mm over a viewBox 210 wide", "$INSUNITS 1: inches"). */
  units: string;
  /** What was left out, by reason (see skipWords), and how many. */
  skipped: Record<string, number>;
  /** What the reading did that changes the curves (a projection, an approximation), in words. */
  notes: string[];
  /** DXF layers with curves (an SVG has none). */
  layers: DrawingLayer[];
}

/** Words for each reason a part of a drawing is skipped: [one, many]. A DXF entity type is its own word. */
const SKIP_WORDS: Readonly<Record<string, [string, string]>> = {
  text: ['text', 'texts'],
  script: ['script (never run)', 'scripts (never run)'],
  foreignObject: ['embedded page (foreignObject, never shown)', 'embedded pages (foreignObject, never shown)'],
  image: ['image', 'images'],
  use: ['use reference', 'use references'],
  style: ['style sheet', 'style sheets'],
  event: ['event attribute (on..., never run)', 'event attributes (on..., never run)'],
  external: ['link to another file (never fetched)', 'links to other files (never fetched)'],
  entity: ['entity declaration (never expanded)', 'entity declarations (never expanded)'],
  entityRef: ['entity reference (never expanded)', 'entity references (never expanded)'],
  defs: ['definition (defs, symbol, clipPath, mask, pattern, marker)', 'definitions (defs, symbol, clipPath, mask, pattern, marker)'],
  hidden: ['hidden element', 'hidden elements'],
  other: ['other element', 'other elements'],
  unreadable: ['shape with numbers that cannot be read', 'shapes with numbers that cannot be read'],
  deep: ['element nested too deep', 'elements nested too deep'],
  edgeOn: ['curve seen edge-on (its plane stands on the drawing)', 'curves seen edge-on (their plane stands on the drawing)'],
  nested: ['block nested past 16 levels', 'blocks nested past 16 levels'],
  selfInsert: ['INSERT of a block inside itself', 'INSERTs of a block inside itself'],
  missingBlock: ['INSERT of a block the file does not have', 'INSERTs of blocks the file does not have'],
  badSpline: ['SPLINE whose numbers do not make a curve', 'SPLINEs whose numbers do not make a curve'],
  highDegree: [`SPLINE of degree past ${READ_MAX_DEGREE}`, `SPLINEs of degree past ${READ_MAX_DEGREE}`],
  longSpline: [`SPLINE with more than ${READ_MAX_SPLINE_POINTS.toLocaleString('en-US')} points`, `SPLINEs with more than ${READ_MAX_SPLINE_POINTS.toLocaleString('en-US')} points`],
  mesh: ['polygon mesh or polyface', 'polygon meshes or polyfaces'],
  paper: ['entity in paper space', 'entities in paper space'],
};

/** "3 texts", "1 script (never run)", "2 TEXT". */
export function skipWords(key: string, n: number): string {
  const w = SKIP_WORDS[key];
  return `${n} ${w ? w[n === 1 ? 0 : 1] : key}`;
}

/** Count a skip. */
export function skip(skipped: Record<string, number>, key: string, n = 1) {
  skipped[key] = (skipped[key] ?? 0) + n;
}

// ------------------------------------------------------------ numbers and vectors

export const sig = (x: number): string => String(Number(x.toPrecision(6)));
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const TAU = Math.PI * 2;

/** An SVG matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f. */
export type Mat2 = [number, number, number, number, number, number];
export const IDENTITY: Mat2 = [1, 0, 0, 1, 0, 0];
/** m after n (n applied first). */
export const mul = (m: Mat2, n: Mat2): Mat2 => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export const applyMat = (m: Mat2, p: V2): V2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const applyLinear = (m: Mat2, v: V2): V2 => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];

/**
 * The curve P(t) = c + U cos t + V sin t for t from t0 over `sweep` radians (signed; 2 pi or more:
 * the whole curve), already mapped: a circle or an arc when U and V make one, else an ellipse or
 * an arc of one. `ends` are the exact ends when the caller has them (a path's own points). Null
 * when U and V are parallel (a circle seen edge-on).
 */
export function conicPiece(c: V2, U: V2, V: V2, t0: number, sweep: number, ends?: [V2, V2] | null): DrawingCurve | null {
  const det = cross(U, V);
  const size = dot(U, U) + dot(V, V);
  if (!(size > 0) || Math.abs(det) <= 1e-12 * size) return null;
  // The principal axes: K K^T = [[a, b], [b, d]] with K = [U V].
  const a = U[0] * U[0] + V[0] * V[0];
  const b = U[0] * U[1] + V[0] * V[1];
  const d = U[1] * U[1] + V[1] * V[1];
  const h = Math.hypot((a - d) / 2, b);
  const l1 = (a + d) / 2 + h;
  const l2 = Math.max(0, (a + d) / 2 - h);
  const A = Math.sqrt(l1);
  const B = Math.sqrt(l2);
  const at = (t: number): V2 => [c[0] + U[0] * Math.cos(t) + V[0] * Math.sin(t), c[1] + U[1] * Math.cos(t) + V[1] * Math.sin(t)];
  const whole = Math.abs(sweep) >= TAU - 1e-12;
  const [pa, pb] = ends ?? [at(t0), at(t0 + sweep)];
  // Increasing t runs counter-clockwise when det > 0.
  const ccw = det > 0 === sweep > 0;
  if (A - B <= 1e-9 * A) {
    const r = (A + B) / 2;
    return whole ? { kind: 'circle', c: [c[0], c[1]], r } : { kind: 'arc', c: [c[0], c[1]], r, a: [pa[0], pa[1]], b: [pb[0], pb[1]], ccw };
  }
  let ux: V2 = Math.abs(b) > 1e-300 ? [l1 - d, b] : a >= d ? [1, 0] : [0, 1];
  const n = Math.hypot(ux[0], ux[1]);
  ux = [ux[0] / n, ux[1] / n];
  return whole ? { kind: 'ellipse', c: [c[0], c[1]], ux, A, B } : { kind: 'ellipse_arc', c: [c[0], c[1]], ux, A, B, a: [pa[0], pa[1]], b: [pb[0], pb[1]], ccw };
}

// ------------------------------------------------------------ B-splines and Beziers

const binom = (n: number, k: number) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/** The knot span of u (the last k in p..n with U[k] <= u, else p), found by halving: a long spline costs log n per point. */
function spanOf(p: number, n: number, U: readonly number[], u: number): number {
  if (u >= U[n + 1]) return n;
  let lo = p;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (U[mid] <= u) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** De Boor at u: degree p, poles P, flat knots U (clamped or not); u within [U[p], U[n+1]]. */
export function deBoor(p: number, P: readonly V2[], U: readonly number[], u: number): V2 {
  const n = P.length - 1;
  const k = spanOf(p, n, U, u);
  const d: V2[] = [];
  for (let j = 0; j <= p; j++) d.push([P[j + k - p][0], P[j + k - p][1]]);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = U[i + p - r + 1] - U[i];
      const al = den > 0 ? (u - U[i]) / den : 0;
      d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1]];
    }
  }
  return d[p];
}

/** A rational B-spline (weights per pole) as a function of u: its weighted poles made once. */
export function rationalAt(p: number, P: readonly V2[], W: readonly number[], U: readonly number[]): (u: number) => V2 {
  const H = P.map((q, i) => [q[0] * W[i], q[1] * W[i]] as V2);
  const WW = W.map((x) => [x, 0] as V2);
  return (u) => {
    const num = deBoor(p, H, U, u);
    const w = deBoor(p, WW, U, u)[0];
    return [num[0] / w, num[1] / w];
  };
}

/** Whether flat knots U suit degree p and n + 1 poles (as many as they need, never decreasing, a domain of some length). */
export function knotsFit(p: number, poles: number, U: readonly number[]): boolean {
  const n = poles - 1;
  if (!Number.isInteger(p) || p < 1 || n < p || U.length !== n + p + 2) return false;
  for (let i = 1; i < U.length; i++) if (!(U[i] >= U[i - 1])) return false;
  return U[n + 1] > U[p] && Number.isFinite(U[0]) && Number.isFinite(U[U.length - 1]);
}

/** The Bezier poles of a degree-p piece from its points at t = k / p (k = 0..p) on [0, 1]. */
export function bezierFromSamples(S: readonly V2[]): V2[] {
  const p = S.length - 1;
  if (p === 0) return [[S[0][0], S[0][1]]];
  const M = S.map((s, k) => {
    const t = k / p;
    const row = Array.from({ length: p + 1 }, (_, j) => binom(p, j) * t ** j * (1 - t) ** (p - j));
    return [...row, s[0], s[1]];
  });
  for (let c = 0; c <= p; c++) {
    let piv = c;
    for (let r = c + 1; r <= p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r <= p; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= p + 2; k++) M[r][k] -= f * M[c][k];
    }
  }
  const out = M.map((row, i) => [row[p + 1] / row[i], row[p + 2] / row[i]] as V2);
  // The ends exactly where the curve ends.
  out[0] = [S[0][0], S[0][1]];
  out[p] = [S[p][0], S[p][1]];
  return out;
}

/** A Bezier's poles one degree up (the same curve). */
export function elevate(P: readonly V2[]): V2[] {
  const p = P.length - 1;
  const out: V2[] = [[P[0][0], P[0][1]]];
  for (let i = 1; i <= p; i++) {
    const a = i / (p + 1);
    out.push([a * P[i - 1][0] + (1 - a) * P[i][0], a * P[i - 1][1] + (1 - a) * P[i][1]]);
  }
  out.push([P[p][0], P[p][1]]);
  return out;
}

/** A cubic Bezier as the sketch's curve: four poles, knots [0, 1]. */
export const cubic = (P: readonly V2[]): DrawingCurve => ({ kind: 'bspline', degree: 3, poles: P.map((q) => [q[0], q[1]] as V2), knots: [0, 1], mults: [4, 4] });

/** Whether a flat knot vector is clamped at both ends for degree p. */
function clamped(p: number, U: readonly number[]): boolean {
  for (let i = 1; i <= p; i++) if (U[i] !== U[0] || U[U.length - 1 - i] !== U[U.length - 1]) return false;
  return true;
}

/** Distinct knots and multiplicities of a flat knot vector. */
function compress(U: readonly number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const u of U) {
    if (knots.length && u === knots[knots.length - 1]) mults[mults.length - 1]++;
    else {
      knots.push(u);
      mults.push(1);
    }
  }
  return { knots, mults };
}

/**
 * A non-rational B-spline (flat knots, clamped or not) as the sketch takes one, exactly: kept as it
 * is when clamped of degree 3 or 5; else as Bezier pieces raised to degree 3 (from 2) or 5 (from 4)
 * and joined end to end. Degree 1 gives its lines. Null when its numbers make no curve; 'approx'
 * when the degree is past 5 (the caller approximates it).
 */
export function bsplineCurves(p: number, P: readonly V2[], U: readonly number[]): DrawingCurve[] | null | 'approx' {
  const n = P.length - 1;
  if (!knotsFit(p, P.length, U)) return null;
  if (p > 5) return 'approx';
  if ((p === 3 || p === 5) && clamped(p, U)) {
    const { knots, mults } = compress(U);
    return [{ kind: 'bspline', degree: p, poles: P.map((q) => [q[0], q[1]] as V2), knots, mults }];
  }
  // The pieces between the distinct knots of the domain.
  const breaks: number[] = [];
  for (let i = p; i <= n + 1; i++) if (!breaks.length || U[i] > breaks[breaks.length - 1]) breaks.push(U[i]);
  if (p === 1) {
    const pts = breaks.map((u) => deBoor(1, P, U, u));
    const out: DrawingCurve[] = [];
    for (let i = 1; i < pts.length; i++) out.push({ kind: 'line', a: pts[i - 1], b: pts[i] });
    return out;
  }
  const to = p <= 3 ? 3 : 5;
  const poles: V2[] = [];
  for (let s = 1; s < breaks.length; s++) {
    const a = breaks[s - 1];
    const z = breaks[s];
    let B = bezierFromSamples(Array.from({ length: p + 1 }, (_, k) => deBoor(p, P, U, a + ((z - a) * k) / p)));
    while (B.length - 1 < to) B = elevate(B);
    // Each piece starts where the one before ends (one pole between them).
    if (poles.length) B[0] = poles[poles.length - 1];
    poles.push(...(poles.length ? B.slice(1) : B));
  }
  const pieces = breaks.length - 1;
  const knots = breaks.map((_, i) => i);
  const mults = breaks.map((_, i) => (i === 0 || i === pieces ? to + 1 : to));
  return [{ kind: 'bspline', degree: to, poles, knots, mults }];
}

/** Points along a curve (drawing and the size): `n` per span or turn. */
export function curveSamples(c: DrawingCurve, n = 24): V2[] {
  switch (c.kind) {
    case 'line':
      return [c.a, c.b];
    case 'point':
      return [c.p];
    case 'circle':
      return Array.from({ length: 4 * n + 1 }, (_, i) => [c.c[0] + c.r * Math.cos((TAU * i) / (4 * n)), c.c[1] + c.r * Math.sin((TAU * i) / (4 * n))] as V2);
    case 'arc': {
      const a0 = Math.atan2(c.a[1] - c.c[1], c.a[0] - c.c[0]);
      const sw = arcSweep(c);
      const k = Math.max(2, Math.ceil((Math.abs(sw) / TAU) * 4 * n));
      return Array.from({ length: k + 1 }, (_, i) => (i === 0 ? c.a : i === k ? c.b : ([c.c[0] + c.r * Math.cos(a0 + (sw * i) / k), c.c[1] + c.r * Math.sin(a0 + (sw * i) / k)] as V2)));
    }
    case 'ellipse':
    case 'ellipse_arc': {
      const uy: V2 = [-c.ux[1], c.ux[0]];
      const at = (t: number): V2 => [c.c[0] + c.A * Math.cos(t) * c.ux[0] + c.B * Math.sin(t) * uy[0], c.c[1] + c.A * Math.cos(t) * c.ux[1] + c.B * Math.sin(t) * uy[1]];
      if (c.kind === 'ellipse') return Array.from({ length: 4 * n + 1 }, (_, i) => at((TAU * i) / (4 * n)));
      const t0 = eccentric(c, c.a);
      const sw = ellipseSweep(c);
      const k = Math.max(2, Math.ceil((Math.abs(sw) / TAU) * 4 * n));
      return Array.from({ length: k + 1 }, (_, i) => (i === 0 ? c.a : i === k ? c.b : at(t0 + (sw * i) / k)));
    }
    case 'bspline': {
      const U = c.knots.flatMap((k, i) => new Array(c.mults[i]).fill(k) as number[]);
      const out: V2[] = [];
      for (let s = 1; s < c.knots.length; s++) for (let i = 0; i < n; i++) out.push(deBoor(c.degree, c.poles, U, c.knots[s - 1] + ((c.knots[s] - c.knots[s - 1]) * i) / n));
      out.push(c.poles[c.poles.length - 1]);
      return out;
    }
    case 'fit': {
      try {
        return splinePolyline(fitSpline(c.pts, { closed: c.closed }), Math.max(4, Math.ceil(n / 2)));
      } catch {
        return c.pts;
      }
    }
  }
}

/** An arc's signed sweep (radians): positive counter-clockwise. */
function arcSweep(c: Extract<DrawingCurve, { kind: 'arc' }>): number {
  const a0 = Math.atan2(c.a[1] - c.c[1], c.a[0] - c.c[0]);
  const a1 = Math.atan2(c.b[1] - c.c[1], c.b[0] - c.c[0]);
  let s = a1 - a0;
  if (c.ccw) while (s <= 0) s += TAU;
  else while (s >= 0) s -= TAU;
  return s;
}

/** A point's eccentric angle on an ellipse. */
function eccentric(c: { c: V2; ux: V2; A: number; B: number }, p: V2): number {
  const q = sub(p, c.c);
  return Math.atan2(dot(q, [-c.ux[1], c.ux[0]]) / c.B, dot(q, c.ux) / c.A);
}

function ellipseSweep(c: Extract<DrawingCurve, { kind: 'ellipse_arc' }>): number {
  let s = eccentric(c, c.b) - eccentric(c, c.a);
  if (c.ccw) while (s <= 0) s += TAU;
  else while (s >= 0) s -= TAU;
  return s;
}

/** A curve with every point mapped by p -> p * s + t (s > 0). */
function scaled(c: DrawingCurve, s: number, t: V2): DrawingCurve {
  const f = (p: V2): V2 => [p[0] * s + t[0], p[1] * s + t[1]];
  const layer = c.layer !== undefined ? { layer: c.layer } : {};
  switch (c.kind) {
    case 'line':
      return { kind: 'line', a: f(c.a), b: f(c.b), ...layer };
    case 'point':
      return { kind: 'point', p: f(c.p), ...layer };
    case 'circle':
      return { kind: 'circle', c: f(c.c), r: c.r * s, ...layer };
    case 'arc':
      return { kind: 'arc', c: f(c.c), r: c.r * s, a: f(c.a), b: f(c.b), ccw: c.ccw, ...layer };
    case 'ellipse':
      return { kind: 'ellipse', c: f(c.c), ux: c.ux, A: c.A * s, B: c.B * s, ...layer };
    case 'ellipse_arc':
      return { kind: 'ellipse_arc', c: f(c.c), ux: c.ux, A: c.A * s, B: c.B * s, a: f(c.a), b: f(c.b), ccw: c.ccw, ...layer };
    case 'bspline':
      return { kind: 'bspline', degree: c.degree, poles: c.poles.map(f), knots: [...c.knots], mults: [...c.mults], ...layer };
    case 'fit':
      return { kind: 'fit', pts: c.pts.map(f), closed: c.closed, ...layer };
  }
}

/** A curve's ends (where it joins others), or null (circles, ellipses, closed fit curves have none; a point is its own end). */
function endsOf(c: DrawingCurve): [V2, V2] | [V2] | null {
  switch (c.kind) {
    case 'line':
    case 'arc':
    case 'ellipse_arc':
      return [c.a, c.b];
    case 'bspline':
      return [c.poles[0], c.poles[c.poles.length - 1]];
    case 'fit':
      return c.closed ? null : [c.pts[0], c.pts[c.pts.length - 1]];
    case 'point':
      return [c.p];
    default:
      return null;
  }
}

// ------------------------------------------------------------ the import

export interface ImportOptions {
  /** mm per drawing unit; left out, the drawing's own. */
  scale?: number;
  /** origin: the drawing's origin on the sketch origin (default); centre: its middle there. */
  place?: 'origin' | 'centre';
  /** The layers to take (DXF); left out, every layer the file has on. */
  layers?: readonly string[] | null;
}

/** Sketch entity kinds an import makes (a fit curve is a spline too). */
export type ImportKind = 'line' | 'arc' | 'circle' | 'ellipse' | 'ellipse_arc' | 'spline' | 'point';
const KIND_WORDS: Readonly<Record<ImportKind, [string, string]>> = {
  line: ['line', 'lines'],
  arc: ['arc', 'arcs'],
  circle: ['circle', 'circles'],
  ellipse: ['ellipse', 'ellipses'],
  ellipse_arc: ['elliptical arc', 'elliptical arcs'],
  spline: ['spline', 'splines'],
  point: ['point', 'points'],
};

export interface ImportSummary {
  file: string;
  format: 'svg' | 'dxf';
  /** What goes into the sketch, by kind. */
  read: Partial<Record<ImportKind, number>>;
  /** Curves in all. */
  total: number;
  /** What the file had that is not drawn, by reason (skipWords). */
  skipped: Record<string, number>;
  /** Curves on top of another of the same shape (left out), and too small to draw (under the join tolerance). */
  duplicates: number;
  tooSmall: number;
  /** The imported curves' size (mm) and where their box lies in the sketch (mm). */
  size: [number, number];
  box: { min: V2; max: V2 } | null;
  /** mm per drawing unit used, and where the drawing's own came from. */
  scale: number;
  defaultScale: number;
  units: string;
  /** Curve ends that meet no other curve's end (a closed outline has none); ends joined into one point. */
  openEnds: number;
  joins: number;
  /** The join tolerance (mm). */
  tolerance: number;
  /** What it weighs for the sketch solver (solverLoad; at most IMPORT_MAX_LOAD goes in). */
  load: number;
  notes: string[];
  /** Layers (DXF): each one's curves and whether it is taken. */
  layers: { name: string; count: number; on: boolean }[];
  /** Why it cannot go in (too large for the sketch solver, nothing to draw), or null. */
  refused: string | null;
}

export interface ImportPlan {
  curves: DrawingCurve[];
  /** Each curve's end points' cluster ids (a point: one). */
  ends: (number[] | null)[];
  /** Each cluster's place (mm). */
  places: V2[];
  summary: ImportSummary;
}

const round = (x: number, tol: number) => Math.round(x / tol);

/** The layers taken: the ones asked for, else every one the file has on. */
export function layersTaken(d: Drawing, o: ImportOptions): Set<string> {
  return new Set(o.layers ?? d.layers.filter((l) => !l.off).map((l) => l.name));
}

/** Whether every number of a curve is finite (1e999 in a file, or a transform that overflows, gives one that is not). */
export function finiteCurve(c: DrawingCurve): boolean {
  const f = (p: V2) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  switch (c.kind) {
    case 'line':
      return f(c.a) && f(c.b);
    case 'point':
      return f(c.p);
    case 'circle':
      return f(c.c) && Number.isFinite(c.r);
    case 'arc':
      return f(c.c) && Number.isFinite(c.r) && f(c.a) && f(c.b);
    case 'ellipse':
      return f(c.c) && f(c.ux) && Number.isFinite(c.A) && Number.isFinite(c.B);
    case 'ellipse_arc':
      return f(c.c) && f(c.ux) && Number.isFinite(c.A) && Number.isFinite(c.B) && f(c.a) && f(c.b);
    case 'bspline':
      return c.poles.every(f) && c.knots.every(Number.isFinite);
    case 'fit':
      return c.pts.every(f);
  }
}

const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const andList = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));

/** What an import of the drawing with these options adds, and its summary (nothing changes yet). */
export function planImport(d: Drawing, o: ImportOptions = {}): ImportPlan {
  const s = o.scale ?? d.mmPerUnit;
  if (!(Number.isFinite(s) && s > 0)) throw new DrawingRefused(o.scale === undefined ? `${d.name}'s own units (${d.units}) give no scale: set the scale (mm per drawing unit)` : `The scale must be a number above 0, not ${o.scale}`);
  const on = layersTaken(d, o);
  const unknown = (o.layers ?? []).filter((l) => !d.layers.some((x) => x.name === l));
  if (unknown.length) throw new DrawingRefused(`${d.name} has no layer ${unknown.map((l) => `"${l}"`).join(', ')}${d.layers.length ? ` (its layers: ${d.layers.map((l) => l.name).join(', ')})` : ' (an SVG has no layers)'}`);
  const picked = d.curves.filter((c) => !d.layers.length || on.has(c.layer ?? '0'));
  const skipped = { ...d.skipped };
  // Scaled, then placed; a curve whose numbers are not finite (or overflow at this scale) cannot be drawn.
  let curves: DrawingCurve[] = [];
  for (const c of picked) {
    const k = scaled(c, s, [0, 0]);
    if (finiteCurve(k)) curves.push(k);
    else skip(skipped, 'unreadable');
  }
  let boxes = curves.map(curveBox);
  let box = unionBox(boxes);
  if (o.place === 'centre' && box) {
    const t: V2 = [-(box.min[0] + box.max[0]) / 2, -(box.min[1] + box.max[1]) / 2];
    curves = curves.map((c) => scaled(c, 1, t));
    boxes = boxes.map((b) => (b ? { min: [b.min[0] + t[0], b.min[1] + t[1]] as V2, max: [b.max[0] + t[0], b.max[1] + t[1]] as V2 } : null));
    box = unionBox(boxes);
  }
  const diag = box ? Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1]) : 0;
  // The join tolerance: 1e-6 of the drawing's size, but at most 1e-3 of its middle-sized curve (a
  // curve far off the rest widens the box, never the tolerance), and never under 1e-4 mm.
  const sizes = curves
    .map((c, i) => (c.kind === 'point' || !boxes[i] ? -1 : Math.hypot(boxes[i]!.max[0] - boxes[i]!.min[0], boxes[i]!.max[1] - boxes[i]!.min[1])))
    .filter((x) => x >= 0)
    .sort((a, b) => a - b);
  const typical = sizes.length ? sizes[sizes.length >> 1] : diag;
  const tol = Math.max(1e-4, Math.min(1e-6 * diag, 1e-3 * typical));
  // Too small to draw: under the join tolerance (the kernel refuses a curve of no length).
  let tooSmall = 0;
  const kept: DrawingCurve[] = [];
  for (const c of curves) {
    const t = tidy(c, tol);
    if (t) kept.push(t);
    else tooSmall++;
  }
  // Ends within the tolerance share one point: clusters by a grid of the tolerance.
  const places: V2[] = [];
  const grid = new Map<string, number[]>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner: number[] = [];
  const ends: (number[] | null)[] = kept.map((c, ci) => {
    const e = endsOf(c);
    if (!e) return null;
    return e.map((p) => {
      const id = places.length;
      places.push(p);
      parent.push(id);
      owner.push(ci);
      const gx = Math.floor(p[0] / tol);
      const gy = Math.floor(p[1] / tol);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (owner[j] === ci || dist(places[j], p) > tol) continue;
            const a = find(id);
            const b = find(j);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
      const key = `${gx},${gy}`;
      const cell = grid.get(key);
      if (cell) cell.push(id);
      else grid.set(key, [id]);
      return id;
    });
  });
  for (let i = 0; i < parent.length; i++) parent[i] = find(i);
  const clusterOf = (i: number) => parent[i];
  // Duplicates: the same shape again (either way round) goes.
  const seen = new Set<string>();
  const curvesOut: DrawingCurve[] = [];
  const endsOut: (number[] | null)[] = [];
  let duplicates = 0;
  kept.forEach((c, i) => {
    const key = shapeKey(c, ends[i]?.map(clusterOf) ?? null, tol);
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    curvesOut.push(c);
    endsOut.push(ends[i]?.map(clusterOf) ?? null);
  });
  // A curve whose own two ends meet (a closed spline, a loop of one cubic) closes there: that
  // place is one, not two open ends (the sketch still gives it two points: a curve never ends on itself).
  const closedAt = new Map<number, number>();
  curvesOut.forEach((c, i) => {
    const e = endsOut[i];
    if (c.kind === 'point' || !e || e.length < 2 || e[0] === e[1]) return;
    if (dist(places[e[0]], places[e[1]]) <= tol) closedAt.set(e[1], e[0]);
  });
  // Open ends: a place holding one curve end (a point entity is not an end).
  const endsAt = new Map<number, number>();
  curvesOut.forEach((c, i) => {
    if (c.kind === 'point') return;
    for (const k of endsOut[i] ?? []) {
      const at = closedAt.get(k) ?? k;
      endsAt.set(at, (endsAt.get(at) ?? 0) + 1);
    }
  });
  let openEnds = 0;
  let joins = 0;
  for (const n of endsAt.values()) {
    if (n === 1) openEnds++;
    else joins++;
  }
  const read: Partial<Record<ImportKind, number>> = {};
  for (const c of curvesOut) {
    const k: ImportKind = c.kind === 'bspline' || c.kind === 'fit' ? 'spline' : c.kind;
    read[k] = (read[k] ?? 0) + 1;
  }
  const outBox = unionBox(curvesOut.map(curveBox));
  const size: [number, number] = outBox ? [outBox.max[0] - outBox.min[0], outBox.max[1] - outBox.min[1]] : [0, 0];
  const layers = d.layers.map((l) => ({ name: l.name, count: l.count, on: on.has(l.name) }));
  const notes = [...d.notes];
  if (1e-6 * diag > 10 * tol) notes.push(`A few curves lie far from the rest (it spans ${sig(size[0])} × ${sig(size[1])} mm): ends are joined within ${sig(tol)} mm, by the size of its curves`);
  const load = solverLoad(curvesOut, endsOut);
  let refused: string | null = null;
  if (load.load > IMPORT_MAX_LOAD) {
    const k = load.kinds;
    const parts = [plural(load.points, 'point'), k.circle ? plural(k.circle, 'circle') : '', k.arc ? plural(k.arc, 'arc') : '', k.ellipse ? plural(k.ellipse, 'ellipse') : '', k.ellipse_arc ? plural(k.ellipse_arc, 'partial ellipse', 'partial ellipses') : ''].filter(Boolean);
    const weights = ['each point 1', k.circle ? 'each circle 1 more' : '', k.arc || k.ellipse ? `each ${k.arc && k.ellipse ? 'arc or ellipse' : k.arc ? 'arc' : 'ellipse'} 20 more` : '', k.ellipse_arc ? 'each partial ellipse 40 more' : ''].filter(Boolean);
    refused = `${d.name} is too large for one sketch: its ${andList(parts)} weigh ${fmt(load.load)} for the sketch solver (${weights.join(', ')}), at most ${fmt(IMPORT_MAX_LOAD)}${d.layers.length > 1 ? ' (leave some layers out)' : ''}`;
  } else if (!curvesOut.length) refused = `${d.name} has nothing to draw${picked.length < d.curves.length ? ' on the layers taken' : ''}`;
  return {
    curves: curvesOut,
    ends: endsOut,
    places,
    summary: {
      file: d.name,
      format: d.format,
      read,
      total: curvesOut.length,
      skipped,
      duplicates,
      tooSmall,
      size,
      box: outBox,
      scale: s,
      defaultScale: d.mmPerUnit,
      units: d.units,
      openEnds,
      joins,
      tolerance: tol,
      load: load.load,
      notes,
      layers,
      refused,
    },
  };
}

/**
 * What the curves weigh for the sketch solver once in the sketch: each sketch point the import
 * makes 1 (a join is one, the centres, an ellipse's axis ends and a spline's inner points too), and
 * each curve the solver holds by rules of its own more (RULE_LOAD). Every solve and analysis of
 * the sketch grows with it (measured with the shipped PlaneGCS: 10,000 points of lines take about
 * a second; 500 arcs as long; 1,500 arcs break the solver).
 */
export function solverLoad(curves: readonly DrawingCurve[], ends: readonly (number[] | null)[]): { load: number; points: number; kinds: Partial<Record<DrawingCurve['kind'], number>> } {
  const used = new Set<number>();
  let points = 0;
  let ruled = 0;
  const kinds: Partial<Record<DrawingCurve['kind'], number>> = {};
  curves.forEach((c, i) => {
    const e = ends[i];
    if (e) {
      for (const k of e) used.add(k);
      if (e.length > 1 && e[0] === e[1]) points++;
    }
    switch (c.kind) {
      case 'circle':
      case 'arc':
        points++;
        break;
      case 'ellipse':
      case 'ellipse_arc':
        points += 3;
        break;
      case 'bspline':
        points += Math.max(0, c.poles.length - 2);
        break;
      case 'fit':
        points += c.closed ? c.pts.length : Math.max(0, c.pts.length - 2);
        break;
    }
    ruled += RULE_LOAD[c.kind] ?? 0;
    kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  });
  points += used.size;
  return { load: points + ruled, points, kinds };
}

/** A curve fit to draw at this tolerance (an arc whose ends meet is its circle), or null when it is too small. */
function tidy(c: DrawingCurve, tol: number): DrawingCurve | null {
  switch (c.kind) {
    case 'line':
      return dist(c.a, c.b) > tol ? c : null;
    case 'point':
      return c;
    case 'circle':
      return c.r > tol ? c : null;
    case 'ellipse':
      return c.B > tol ? c : null;
    case 'arc': {
      if (!(c.r > tol)) return null;
      if (dist(c.a, c.b) > tol) return Math.abs(arcSweep(c)) * c.r > tol ? c : null;
      // Ends together: the whole circle (the sweep nearly a turn), else nothing.
      return Math.abs(arcSweep(c)) > Math.PI ? { kind: 'circle', c: c.c, r: c.r, ...(c.layer !== undefined ? { layer: c.layer } : {}) } : null;
    }
    case 'ellipse_arc': {
      if (!(c.B > tol)) return null;
      if (dist(c.a, c.b) > tol) return c;
      return Math.abs(ellipseSweep(c)) > Math.PI ? { kind: 'ellipse', c: c.c, ux: c.ux, A: c.A, B: c.B, ...(c.layer !== undefined ? { layer: c.layer } : {}) } : null;
    }
    case 'bspline':
      return c.poles.some((q) => dist(q, c.poles[0]) > tol) ? c : null;
    case 'fit': {
      const pts = c.pts.filter((q, i) => i === 0 || dist(q, c.pts[i - 1]) > tol);
      if (c.closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= tol) pts.pop();
      if (pts.length < (c.closed ? 3 : 2)) return null;
      return { ...c, pts };
    }
  }
}

/** The same shape gives the same key, whichever way it runs. */
function shapeKey(c: DrawingCurve, ends: number[] | null, tol: number): string {
  const r = (x: number) => round(x, tol);
  const P = (p: V2) => `${r(p[0])},${r(p[1])}`;
  switch (c.kind) {
    case 'line':
      return `L${Math.min(ends![0], ends![1])},${Math.max(ends![0], ends![1])}`;
    case 'point':
      return `P${ends![0]}`;
    case 'circle':
      return `C${P(c.c)},${r(c.r)}`;
    case 'arc':
      return `A${c.ccw ? ends![0] : ends![1]},${c.ccw ? ends![1] : ends![0]},${P(c.c)},${r(c.r)}`;
    case 'ellipse':
    case 'ellipse_arc': {
      const ang = Math.round(((Math.atan2(c.ux[1], c.ux[0]) + TAU) % Math.PI) * 1e6);
      const head = `E${P(c.c)},${r(c.A)},${r(c.B)},${ang}`;
      if (c.kind === 'ellipse') return head;
      return `${head},${c.ccw ? ends![0] : ends![1]},${c.ccw ? ends![1] : ends![0]}`;
    }
    case 'bspline': {
      const f = [ends![0], ...c.poles.slice(1, -1).map(P), ends![1], c.degree, ...c.knots.map((k) => k.toPrecision(9)), ...c.mults].join(';');
      const g = [ends![1], ...c.poles.slice(1, -1).reverse().map(P), ends![0], c.degree, ...[...c.knots].reverse().map((k) => (c.knots[0] + c.knots[c.knots.length - 1] - k).toPrecision(9)), ...[...c.mults].reverse()].join(';');
      return `S${f < g ? f : g}`;
    }
    case 'fit': {
      const f = c.pts.map(P).join(';');
      const g = [...c.pts].reverse().map(P).join(';');
      return `F${c.closed ? 'c' : 'o'}${f < g ? f : g}`;
    }
  }
}

/** A curve's box (sampled; an ellipse's exact), or null when it has no finite point. */
function curveBox(c: DrawingCurve): { min: V2; max: V2 } | null {
  let min: V2 = [Infinity, Infinity];
  let max: V2 = [-Infinity, -Infinity];
  const pts = c.kind === 'ellipse' ? ellipseBox(c) : curveSamples(c, 16);
  for (const p of pts) {
    if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue;
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** The box round boxes, or null for none. */
function unionBox(boxes: readonly ({ min: V2; max: V2 } | null)[]): { min: V2; max: V2 } | null {
  let min: V2 = [Infinity, Infinity];
  let max: V2 = [-Infinity, -Infinity];
  for (const b of boxes) {
    if (!b) continue;
    min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1])];
    max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1])];
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** An ellipse's box corners, exactly. */
function ellipseBox(c: Extract<DrawingCurve, { kind: 'ellipse' }>): V2[] {
  const uy: V2 = [-c.ux[1], c.ux[0]];
  const hx = Math.hypot(c.A * c.ux[0], c.B * uy[0]);
  const hy = Math.hypot(c.A * c.ux[1], c.B * uy[1]);
  return [
    [c.c[0] - hx, c.c[1] - hy],
    [c.c[0] + hx, c.c[1] + hy],
  ];
}

/**
 * The import as one sketch edit: the plan's curves as sketch entities on new points, one point
 * per join (a curve whose two ends meet each other keeps two points there). Returns the edit and
 * the new entities' ids in the plan's order.
 */
export function importIntoDraft(draft: SketchDraft, plan: ImportPlan): { outcome: EditOutcome; added: string[] } {
  if (plan.summary.refused) return { outcome: { ok: false, reason: plan.summary.refused }, added: [] };
  const b = new SketchBuilder(draft);
  const pointOf = new Map<number, string>();
  const at = (k: number): string => {
    let id = pointOf.get(k);
    if (!id) {
      id = b.addPoint(plan.places[k]);
      pointOf.set(k, id);
    }
    return id;
  };
  const added: string[] = [];
  plan.curves.forEach((c, i) => {
    const ends = plan.ends[i];
    const pa = ends ? at(ends[0]) : null;
    // Both ends of one curve at one place: two points there (a curve never ends on itself).
    const pb = ends && ends.length > 1 ? (ends[1] === ends[0] ? b.addPoint(plan.places[ends[1]]) : at(ends[1])) : null;
    const id = newId('e');
    let e: SketchEntity;
    switch (c.kind) {
      case 'line':
        e = { id, kind: 'line', p: [pa!, pb!] };
        break;
      case 'point':
        e = { id, kind: 'point', p: pa! };
        break;
      case 'circle':
        e = { id, kind: 'circle', c: b.addPoint(c.c), r: c.r };
        break;
      case 'arc':
        e = { id, kind: 'arc', c: b.addPoint(c.c), a: pa!, b: pb!, ...(c.ccw ? {} : { ccw: false }) };
        break;
      case 'ellipse':
      case 'ellipse_arc': {
        const uy: V2 = [-c.ux[1], c.ux[0]];
        const cp = b.addPoint(c.c);
        const major = b.addPoint([c.c[0] + c.A * c.ux[0], c.c[1] + c.A * c.ux[1]]);
        const minor = b.addPoint([c.c[0] + c.B * uy[0], c.c[1] + c.B * uy[1]]);
        e = c.kind === 'ellipse' ? { id, kind: 'ellipse', c: cp, major, minor } : { id, kind: 'ellipse_arc', c: cp, major, minor, a: pa!, b: pb!, ...(c.ccw ? {} : { ccw: false }) };
        break;
      }
      case 'bspline':
        e = { id, kind: 'spline', form: 'control', degree: c.degree, pts: [pa!, ...c.poles.slice(1, -1).map((q) => b.addPoint(q)), pb!], knots: [...c.knots], mults: [...c.mults] };
        break;
      case 'fit':
        e = c.closed
          ? { id, kind: 'spline', form: 'fit', degree: 3, pts: c.pts.map((q) => b.addPoint(q)), closed: true }
          : { id, kind: 'spline', form: 'fit', degree: 3, pts: [pa!, ...c.pts.slice(1, -1).map((q) => b.addPoint(q)), pb!] };
        break;
    }
    b.addEntity(e);
    added.push(id);
  });
  return { outcome: { ok: true, draft: b.result(), optional: [], removed: [] }, added };
}

/** The summary in words, line by line: what the person's panel shows and the Assistant's reply says. */
export function summaryWords(s: ImportSummary): { read: string; skipped: string; size: string; open: string; join: string; scale: string; layers: string | null; notes: string[] } {
  const kinds = (Object.keys(KIND_WORDS) as ImportKind[]).filter((k) => s.read[k]).map((k) => `${s.read[k]} ${KIND_WORDS[k][s.read[k] === 1 ? 0 : 1]}`);
  const skipped = Object.entries(s.skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => skipWords(k, n));
  if (s.duplicates) skipped.push(`${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'} (a curve on top of another)`);
  if (s.tooSmall) skipped.push(`${s.tooSmall} too small to draw`);
  const off = s.layers.filter((l) => !l.on);
  return {
    read: `Read: ${kinds.length ? kinds.join(', ') : 'nothing to draw'}`,
    skipped: `Skipped: ${skipped.length ? skipped.join(', ') : 'nothing'}`,
    size: `Size: ${sig(s.size[0])} × ${sig(s.size[1])} mm`,
    open: `Open ends: ${s.openEnds}${s.openEnds ? ' (where a curve ends and nothing else does)' : ''}`,
    join: `Ends joined within ${sig(s.tolerance)} mm`,
    scale: `Scale: 1 unit = ${sig(s.scale)} mm (${s.units})`,
    layers: s.layers.length ? `Layers: ${s.layers.map((l) => `${l.name} (${l.count})`).join(', ')}${off.length ? `; left out: ${off.map((l) => l.name).join(', ')}` : ''}` : null,
    notes: [...s.notes],
  };
}

/** The plan's curves as preview segments (sketch mode's rubber band), at most `max` segments. */
export function previewSegments(plan: ImportPlan, max = 200_000): [V2, V2][] {
  const out: [V2, V2][] = [];
  const per = Math.max(4, Math.min(24, Math.floor(max / Math.max(1, plan.curves.length) / 4)));
  for (const c of plan.curves) {
    const pts = curveSamples(c, per);
    for (let i = 1; i < pts.length && out.length < max; i++) out.push([pts[i - 1], pts[i]]);
  }
  return out;
}
