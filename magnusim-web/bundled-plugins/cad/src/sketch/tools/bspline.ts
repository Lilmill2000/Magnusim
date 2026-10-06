// B-spline math for sketch splines (P4b): a spline entity's curve as a clamped,
// non-rational B-spline in OCCT's form (distinct knots + multiplicities), built
// from its solved points: a fit-point spline is a C2 cubic through its points
// (chord-length parameters; natural ends, or end derivatives from its tangent
// handles; closed: C1 and C2 across the seam), a control-point spline is a
// uniform B-spline on its poles (clamped when open; periodic when closed, then
// re-expressed clamped). Evaluation (de Boor), sampling, closest points,
// crossings with lines, circles and other splines, tangents and Green's area.
// Everything a spline does in the sketch (drawing, picking, trim, extend,
// offset, the kernel's `bspline` curve) reads this one representation, so what
// is drawn is what is extruded. Pure functions (unit-tested).
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';

/** A clamped B-spline in OCCT form (Geom2d_BSplineCurve(poles, knots, mults, degree, false)). */
export interface BSpline {
  degree: number;
  poles: Vec2[];
  /** Distinct knot values, increasing. */
  knots: number[];
  /** Multiplicities (first and last = degree + 1). */
  mults: number[];
}

/** What a spline entity says about its curve (its points already solved). */
export interface SplineInput {
  form: 'fit' | 'control';
  degree: number;
  pts: Vec2[];
  closed?: boolean;
  /** fit, open: tangent handles (the curve's second and second-last poles), or null. */
  handles?: [Vec2 | null, Vec2 | null];
  /** control: an explicit clamped knot vector (a trimmed piece); absent = uniform. */
  knots?: number[];
  mults?: number[];
  /** fit, open: the first and last spans' parameter lengths as multiples of their chords (a trimmed piece keeps the curve exactly); absent = 1. */
  spans?: [number, number];
}

// ------------------------------------------------------------ knots and basis

/** The knot vector with each knot repeated by its multiplicity. */
export function flatKnots(b: Pick<BSpline, 'knots' | 'mults'>): number[] {
  const out: number[] = [];
  b.knots.forEach((k, i) => {
    for (let m = 0; m < b.mults[i]; m++) out.push(k);
  });
  return out;
}

/** Distinct knots and multiplicities from a flat knot vector. */
export function compressKnots(U: readonly number[]): { knots: number[]; mults: number[] } {
  const knots: number[] = [];
  const mults: number[] = [];
  for (const u of U) {
    if (knots.length && Math.abs(u - knots[knots.length - 1]) < 1e-14) mults[mults.length - 1]++;
    else {
      knots.push(u);
      mults.push(1);
    }
  }
  return { knots, mults };
}

/** The knot span index i with U[i] <= u < U[i+1] (NURBS Book A2.1); n = poles - 1. */
function findSpan(n: number, p: number, u: number, U: readonly number[]): number {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Basis functions and their derivatives up to order `nd` at u (NURBS Book A2.3): ders[k][j] for N_{span-p+j}. */
function dersBasis(span: number, u: number, p: number, nd: number, U: readonly number[]): number[][] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const ders: number[][] = Array.from({ length: nd + 1 }, () => new Array(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a: number[][] = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= nd; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
        d += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = d;
      const t = s1;
      s1 = s2;
      s2 = t;
    }
  }
  let r = p;
  for (let k = 1; k <= nd; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= r;
    r *= p - k;
  }
  return ders;
}

/** The curve's parameter range. */
export function domain(b: BSpline): [number, number] {
  return [b.knots[0], b.knots[b.knots.length - 1]];
}

/** The point and derivatives (order 0..nd) at u. */
export function derivs(b: BSpline, u: number, nd = 1): Vec2[] {
  const U = flatKnots(b);
  const n = b.poles.length - 1;
  const p = b.degree;
  const [u0, u1] = domain(b);
  const uu = Math.min(u1, Math.max(u0, u));
  const span = findSpan(n, p, uu, U);
  const N = dersBasis(span, uu, p, Math.min(nd, p), U);
  const out: Vec2[] = [];
  for (let k = 0; k <= nd; k++) {
    if (k > p) {
      out.push([0, 0]);
      continue;
    }
    let x = 0;
    let y = 0;
    for (let j = 0; j <= p; j++) {
      const P = b.poles[span - p + j];
      x += N[k][j] * P[0];
      y += N[k][j] * P[1];
    }
    out.push([x, y]);
  }
  return out;
}

export function pointAtParam(b: BSpline, u: number): Vec2 {
  return derivs(b, u, 0)[0];
}

// ------------------------------------------------------------ building

/** Solve A x = B (dense, partial pivoting); B has two columns (x, y). Throws when singular. */
function solveDense(A: number[][], B: Vec2[]): Vec2[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, B[i][0], B[i][1]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) throw new Error('the spline points do not give a curve (two points in one place?)');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n + 1; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => [row[n] / M[i][i], row[n + 1] / M[i][i]] as Vec2);
}

/** One row of the interpolation system: sum_j coef_j P_j = rhs. */
interface Row {
  u: number;
  /** Derivative order of the curve at u (0: the point). */
  order: number;
  rhs: Vec2;
  /** Another (u, order) whose value is subtracted (a continuity row C^(k)(u) - C^(k)(u2) = rhs). */
  minus?: { u: number; order: number };
}

/** Poles of the B-spline with flat knots U and degree p satisfying the rows (as many rows as poles). */
function polesFor(U: readonly number[], p: number, rows: readonly Row[]): Vec2[] {
  const nPoles = U.length - p - 1;
  if (rows.length !== nPoles) throw new Error('spline interpolation: rows and poles differ');
  const n = nPoles - 1;
  const rowOf = (u: number, order: number, sign: number, into: number[]) => {
    const span = findSpan(n, p, u, U);
    const N = dersBasis(span, u, p, order, U);
    for (let j = 0; j <= p; j++) into[span - p + j] += sign * N[order][j];
  };
  const A = rows.map((r) => {
    const a = new Array(nPoles).fill(0);
    rowOf(r.u, r.order, 1, a);
    if (r.minus) rowOf(r.minus.u, r.minus.order, -1, a);
    return a;
  });
  return solveDense(A, rows.map((r) => r.rhs));
}

/** Chord-length parameters in [0, 1] for points (closed: the closing chord back to the first counts). */
export function chordParams(pts: readonly Vec2[], closed = false, spans?: [number, number]): number[] {
  const all = closed ? [...pts, pts[0]] : [...pts];
  const d: number[] = [0];
  const n = all.length - 1;
  for (let i = 1; i < all.length; i++) {
    let l = Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]);
    // fix1 B4: a trimmed fit spline's end spans keep their place in the parameter (the curve stays exact).
    if (spans && !closed) {
      if (i === 1) l *= spans[0];
      if (i === n && n > 1) l *= spans[1];
    }
    d.push(d[i - 1] + l);
  }
  const L = d[d.length - 1];
  if (!(L > 0)) throw new Error('the spline points are all in one place');
  // Two points in one place would give two equal parameters (no curve): spread them a little.
  return d.map((x) => x / L);
}

/**
 * The fit-point spline: a C2 cubic through `pts` with knots at their chord-length
 * parameters. Open: natural ends (no bending at an end) unless a handle sets the
 * end's derivative (the handle is the curve's second / second-last pole). Closed:
 * through pts and back to pts[0], C1 and C2 across that seam.
 */
export function fitSpline(pts: readonly Vec2[], opts: { closed?: boolean; handles?: [Vec2 | null, Vec2 | null]; spans?: [number, number]; params?: number[] } = {}): BSpline {
  const closed = !!opts.closed && pts.length >= 3;
  if (pts.length < 2) throw new Error('a spline needs two points or more');
  const Q = closed ? [...pts, pts[0]] : [...pts];
  // `params`: given (the solver's frozen parameters for one load), else chord lengths.
  const u = opts.params ?? chordParams(pts, closed, opts.spans);
  for (let i = 1; i < u.length; i++) if (!(u[i] - u[i - 1] > 1e-12)) throw new Error('two spline points in one place');
  const p = 3;
  const inner = u.slice(1, -1);
  const U = [0, 0, 0, 0, ...inner, 1, 1, 1, 1];
  const rows: Row[] = Q.map((q, i) => ({ u: u[i], order: 0, rhs: q }));
  const du1 = u[1] - u[0];
  const duN = u[u.length - 1] - u[u.length - 2];
  if (closed) {
    rows.push({ u: 0, order: 1, rhs: [0, 0], minus: { u: 1, order: 1 } });
    rows.push({ u: 0, order: 2, rhs: [0, 0], minus: { u: 1, order: 2 } });
  } else {
    const [h0, h1] = opts.handles ?? [null, null];
    // C'(0) = 3 (P1 - P0) / u1: the handle is P1 exactly.
    rows.push(h0 ? { u: 0, order: 1, rhs: [(3 * (h0[0] - Q[0][0])) / du1, (3 * (h0[1] - Q[0][1])) / du1] } : { u: 0, order: 2, rhs: [0, 0] });
    const last = Q[Q.length - 1];
    rows.push(h1 ? { u: 1, order: 1, rhs: [(3 * (last[0] - h1[0])) / duN, (3 * (last[1] - h1[1])) / duN] } : { u: 1, order: 2, rhs: [0, 0] });
  }
  const poles = polesFor(U, p, rows);
  // The ends are the end points exactly (the solve leaves round-off).
  poles[0] = [Q[0][0], Q[0][1]];
  poles[poles.length - 1] = closed ? [Q[0][0], Q[0][1]] : [Q[Q.length - 1][0], Q[Q.length - 1][1]];
  return { degree: p, poles, ...compressKnots(U) };
}

/** A clamped uniform B-spline on `poles` (open control-point spline). */
export function clampedUniform(poles: readonly Vec2[], degree: number): BSpline {
  const n = poles.length;
  if (n < degree + 1) throw new Error(`a degree ${degree} spline needs ${degree + 1} control points or more`);
  const spans = n - degree;
  const knots = Array.from({ length: spans + 1 }, (_, i) => i / spans);
  const mults = knots.map((_, i) => (i === 0 || i === spans ? degree + 1 : 1));
  return { degree, poles: poles.map((q) => [q[0], q[1]] as Vec2), knots, mults };
}

/**
 * A closed control-point spline: the periodic uniform B-spline on `poles`,
 * re-expressed clamped on [0, 1] (the same curve; C^(degree-1) at the seam).
 */
export function periodicUniform(poles: readonly Vec2[], degree: number): BSpline {
  const n = poles.length;
  if (n < degree + 1) throw new Error(`a closed degree ${degree} spline needs ${degree + 1} control points or more`);
  // The periodic curve as an unclamped spline: poles wrapped, integer knots, domain [p, p + n].
  const ext = [...poles, ...poles.slice(0, degree)].map((q) => [q[0], q[1]] as Vec2);
  const Uper = Array.from({ length: ext.length + degree + 1 }, (_, i) => i);
  const per = (t: number, order: number): Vec2 => {
    const span = findSpan(ext.length - 1, degree, t, Uper);
    const N = dersBasis(span, t, degree, order, Uper);
    let x = 0;
    let y = 0;
    for (let j = 0; j <= degree; j++) {
      x += N[order][j] * ext[span - degree + j][0];
      y += N[order][j] * ext[span - degree + j][1];
    }
    return [x, y];
  };
  // Clamped knots with the same inner knots (scaled to [0, 1]): the curve is exactly representable.
  const inner = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
  const U = [...new Array(degree + 1).fill(0), ...inner, ...new Array(degree + 1).fill(1)];
  const nPoles = U.length - degree - 1; // n + degree
  // Rows: points at the Greville abscissae of the clamped vector (distinct, well-conditioned).
  const rows: Row[] = [];
  for (let i = 0; i < nPoles; i++) {
    let g = 0;
    for (let k = 1; k <= degree; k++) g += U[i + k];
    g /= degree;
    rows.push({ u: g, order: 0, rhs: per(degree + g * n, 0) });
  }
  const poles2 = polesFor(U, degree, rows);
  poles2[poles2.length - 1] = [poles2[0][0], poles2[0][1]];
  return { degree, poles: poles2, ...compressKnots(U) };
}

/** The B-spline of a spline entity (throws a plain reason when its points cannot make one). */
export function splineCurve(s: SplineInput): BSpline {
  if (s.form === 'fit') return fitSpline(s.pts, { closed: s.closed, handles: s.handles, spans: s.spans });
  if (s.knots && s.mults) {
    const sum = s.mults.reduce((a, m) => a + m, 0);
    if (sum !== s.pts.length + s.degree + 1) throw new Error('the spline knots do not fit its control points');
    return { degree: s.degree, poles: s.pts.map((q) => [q[0], q[1]] as Vec2), knots: [...s.knots], mults: [...s.mults] };
  }
  return s.closed ? periodicUniform(s.pts, s.degree) : clampedUniform(s.pts, s.degree);
}

/**
 * fix1 B2: a spline's poles as fixed affine combinations of its inputs (its points, then its
 * handles): poles[j] = sum_k W[j][k] * input_k, the same for u and v. A fit spline's chord-length
 * parameters are frozen at the inputs given (the solver's view for one load). With the curve's flat
 * knots and degree, the solver holds a point ON the curve at a free parameter.
 */
export function splineAffine(s: SplineInput): { curve: BSpline; W: number[][]; flat: number[] } {
  const handles = (s.handles ?? [null, null]).filter((h): h is Vec2 => !!h);
  const inputs: Vec2[] = [...s.pts, ...handles];
  const params = s.form === 'fit' ? chordParams(s.pts, !!s.closed && s.pts.length >= 3, s.spans) : undefined;
  const build = (ins: Vec2[]): BSpline => {
    const pts = ins.slice(0, s.pts.length);
    let hi = s.pts.length;
    const hs: [Vec2 | null, Vec2 | null] = [s.handles?.[0] ? ins[hi++] : null, s.handles?.[1] ? ins[hi++] : null];
    if (s.form === 'fit') return fitSpline(pts, { closed: s.closed, handles: hs, params });
    return splineCurve({ ...s, pts });
  };
  const curve = build(inputs);
  // Linear in the inputs once the parameters are fixed: the poles of a unit input are its column.
  const zero = build(inputs.map(() => [0, 0] as Vec2));
  const W: number[][] = curve.poles.map(() => new Array(inputs.length).fill(0));
  inputs.forEach((_, k) => {
    const unit = build(inputs.map((_, i) => (i === k ? [1, 0] : [0, 0]) as Vec2));
    unit.poles.forEach((q, j) => (W[j][k] = q[0] - zero.poles[j][0]));
  });
  return { curve, W, flat: flatKnots(curve) };
}

// ------------------------------------------------------------ using it

/** Points along the curve: `perSpan` per knot span (and at every knot), ends included. */
export function sampleSpline(b: BSpline, perSpan = 16): { u: number; p: Vec2 }[] {
  const out: { u: number; p: Vec2 }[] = [];
  for (let k = 0; k < b.knots.length - 1; k++) {
    const a = b.knots[k];
    const z = b.knots[k + 1];
    for (let i = 0; i < perSpan; i++) {
      const u = a + ((z - a) * i) / perSpan;
      out.push({ u, p: pointAtParam(b, u) });
    }
  }
  const [, u1] = domain(b);
  out.push({ u: u1, p: pointAtParam(b, u1) });
  return out;
}

/** The polyline for drawing and window tests. */
export function splinePolyline(b: BSpline, perSpan = 16): Vec2[] {
  return sampleSpline(b, perSpan).map((s) => s.p);
}

/** The closest point on the curve to q (sampled, then refined by Newton), with its parameter. */
export function closestOnSpline(b: BSpline, q: Vec2): { u: number; p: Vec2; d: number } {
  const S = sampleSpline(b, 24);
  let best = 0;
  let bd = Infinity;
  S.forEach((s, i) => {
    const d = Math.hypot(s.p[0] - q[0], s.p[1] - q[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  const [u0, u1] = domain(b);
  let u = S[best].u;
  for (let it = 0; it < 20; it++) {
    const [C, D1, D2] = derivs(b, u, 2);
    const r: Vec2 = [C[0] - q[0], C[1] - q[1]];
    const f = r[0] * D1[0] + r[1] * D1[1];
    const fp = D1[0] * D1[0] + D1[1] * D1[1] + r[0] * D2[0] + r[1] * D2[1];
    if (!(Math.abs(fp) > 1e-300)) break;
    const nu = Math.min(u1, Math.max(u0, u - f / fp));
    if (Math.abs(nu - u) < 1e-14) {
      u = nu;
      break;
    }
    u = nu;
  }
  const p = pointAtParam(b, u);
  const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
  // Newton may wander off to a worse local answer: keep the sample if it is nearer.
  return d <= bd ? { u, p, d } : { u: S[best].u, p: S[best].p, d: bd };
}

/** The unit tangent at u (the direction the curve runs). */
export function tangentAt(b: BSpline, u: number): Vec2 {
  const [, D] = derivs(b, u, 1);
  const l = Math.hypot(D[0], D[1]);
  return l > 0 ? [D[0] / l, D[1] / l] : [1, 0];
}

/** Curve length (Gauss-Legendre per span). */
export function splineLength(b: BSpline): number {
  const g = GAUSS5;
  let L = 0;
  for (let k = 0; k < b.knots.length - 1; k++) {
    const a = b.knots[k];
    const z = b.knots[k + 1];
    for (const [x, w] of g) {
      const u = a + ((z - a) * (x + 1)) / 2;
      const [, D] = derivs(b, u, 1);
      L += (w * (z - a) * Math.hypot(D[0], D[1])) / 2;
    }
  }
  return L;
}

/** Green's integral 1/2 ∮ (x dy - y dx) along the curve (exact for polynomial pieces up to degree 5). */
export function splineGreen(b: BSpline): number {
  let A = 0;
  for (let k = 0; k < b.knots.length - 1; k++) {
    const a = b.knots[k];
    const z = b.knots[k + 1];
    for (const [x, w] of GAUSS6) {
      const u = a + ((z - a) * (x + 1)) / 2;
      const [C, D] = derivs(b, u, 1);
      A += (w * (z - a) * (C[0] * D[1] - C[1] * D[0])) / 4;
    }
  }
  return A;
}

const GAUSS5: [number, number][] = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.4786286704993665],
  [0.5384693101056831, 0.4786286704993665],
  [-0.906179845938664, 0.2369268850561891],
  [0.906179845938664, 0.2369268850561891],
];
const GAUSS6: [number, number][] = [
  [-0.6612093864662645, 0.3607615730481386],
  [0.6612093864662645, 0.3607615730481386],
  [-0.2386191860831969, 0.4679139345726910],
  [0.2386191860831969, 0.4679139345726910],
  [-0.9324695142031521, 0.1713244923791704],
  [0.9324695142031521, 0.1713244923791704],
];

/** Where two polylines (with parameters) cross: candidate parameter pairs, refined by the caller. */
function polyCross(a: { u: number; p: Vec2 }[], b: { u: number; p: Vec2 }[]): { ua: number; ub: number; p: Vec2 }[] {
  const out: { ua: number; ub: number; p: Vec2 }[] = [];
  for (let i = 1; i < a.length; i++) {
    const p1 = a[i - 1].p;
    const p2 = a[i].p;
    const minx = Math.min(p1[0], p2[0]);
    const maxx = Math.max(p1[0], p2[0]);
    const miny = Math.min(p1[1], p2[1]);
    const maxy = Math.max(p1[1], p2[1]);
    for (let j = 1; j < b.length; j++) {
      const q1 = b[j - 1].p;
      const q2 = b[j].p;
      if (Math.max(q1[0], q2[0]) < minx || Math.min(q1[0], q2[0]) > maxx || Math.max(q1[1], q2[1]) < miny || Math.min(q1[1], q2[1]) > maxy) continue;
      const d1: Vec2 = [p2[0] - p1[0], p2[1] - p1[1]];
      const d2: Vec2 = [q2[0] - q1[0], q2[1] - q1[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-18) continue;
      const w: Vec2 = [q1[0] - p1[0], q1[1] - p1[1]];
      const t = (w[0] * d2[1] - w[1] * d2[0]) / den;
      const s = (w[0] * d1[1] - w[1] * d1[0]) / den;
      const e = 1e-9;
      if (t < -e || t > 1 + e || s < -e || s > 1 + e) continue;
      out.push({ ua: a[i - 1].u + (a[i].u - a[i - 1].u) * t, ub: b[j - 1].u + (b[j].u - b[j - 1].u) * s, p: [p1[0] + d1[0] * t, p1[1] + d1[1] * t] });
    }
  }
  // Two segments meeting at a sample report the same crossing twice.
  return out.filter((x, i) => !out.slice(0, i).some((y) => Math.hypot(x.p[0] - y.p[0], x.p[1] - y.p[1]) < 1e-9));
}

/** A curve given as a parametric function for crossing tests (a line segment, a circle, an arc, a spline). */
export interface ParamCurve {
  /** Point and first derivative at t. */
  at(t: number): [Vec2, Vec2];
  t0: number;
  t1: number;
  /** Samples for the coarse search. */
  samples: number;
  closed?: boolean;
}

export function splineParamCurve(b: BSpline): ParamCurve {
  const [t0, t1] = domain(b);
  return {
    at: (t) => {
      const [C, D] = derivs(b, t, 1);
      return [C, D];
    },
    t0,
    t1,
    samples: Math.max(32, (b.knots.length - 1) * 24),
  };
}

export function segmentParamCurve(a: Vec2, z: Vec2, extend = 0): ParamCurve {
  const d: Vec2 = [z[0] - a[0], z[1] - a[1]];
  return { at: (t) => [[a[0] + d[0] * t, a[1] + d[1] * t], d], t0: -extend, t1: 1 + extend, samples: 1 };
}

export function arcParamCurve(c: Vec2, r: number, a0: number, sweep: number): ParamCurve {
  return {
    at: (t) => {
      const a = a0 + sweep * t;
      return [
        [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)],
        [-r * sweep * Math.sin(a), r * sweep * Math.cos(a)],
      ];
    },
    t0: 0,
    t1: 1,
    samples: Math.max(8, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 96)),
  };
}

/** Where two parametric curves cross, each parameter within its range (Newton-refined): [tA, tB, point]. */
export function crossCurves(A: ParamCurve, B: ParamCurve): { ta: number; tb: number; p: Vec2 }[] {
  const samp = (c: ParamCurve) => Array.from({ length: c.samples + 1 }, (_, i) => {
    const t = c.t0 + ((c.t1 - c.t0) * i) / c.samples;
    return { u: t, p: c.at(t)[0] };
  });
  const cand = polyCross(samp(A), samp(B));
  const out: { ta: number; tb: number; p: Vec2 }[] = [];
  const clampA = (t: number) => Math.min(A.t1, Math.max(A.t0, t));
  const clampB = (t: number) => Math.min(B.t1, Math.max(B.t0, t));
  for (const c of cand) {
    let ta = c.ua;
    let tb = c.ub;
    for (let it = 0; it < 30; it++) {
      const [pa, da] = A.at(ta);
      const [pb, db] = B.at(tb);
      const f: Vec2 = [pa[0] - pb[0], pa[1] - pb[1]];
      if (Math.hypot(f[0], f[1]) < 1e-12) break;
      // [da, -db] [dta, dtb]^T = -f
      const det = da[0] * -db[1] - da[1] * -db[0];
      if (Math.abs(det) < 1e-300) break;
      const dta = (-f[0] * -db[1] - -f[1] * -db[0]) / det;
      const dtb = (da[0] * -f[1] - da[1] * -f[0]) / det;
      ta = clampA(ta + dta);
      tb = clampB(tb + dtb);
    }
    const [pa] = A.at(ta);
    const [pb] = B.at(tb);
    if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 1e-7 * Math.max(1, Math.abs(pa[0]) + Math.abs(pa[1]))) continue;
    if (out.some((o) => Math.hypot(o.p[0] - pa[0], o.p[1] - pa[1]) < 1e-9)) continue;
    out.push({ ta, tb, p: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] });
  }
  return out;
}

/** The spline cut to [ua, ub] (re-fitted exactly: the same polynomial pieces on the sub-range), clamped. */
export function subSpline(b: BSpline, ua: number, ub: number): BSpline {
  const p = b.degree;
  const [u0, u1] = domain(b);
  const a = Math.max(u0, Math.min(ua, ub));
  const z = Math.min(u1, Math.max(ua, ub));
  const inner = b.knots.filter((k) => k > a + 1e-12 && k < z - 1e-12);
  const innerFlat: number[] = [];
  for (const k of inner) for (let m = 0; m < b.mults[b.knots.indexOf(k)]; m++) innerFlat.push(k);
  const U = [...new Array(p + 1).fill(a), ...innerFlat, ...new Array(p + 1).fill(z)];
  const nPoles = U.length - p - 1;
  const rows: Row[] = [];
  for (let i = 0; i < nPoles; i++) {
    let g = 0;
    for (let k = 1; k <= p; k++) g += U[i + k];
    g /= p;
    rows.push({ u: g, order: 0, rhs: pointAtParam(b, g) });
  }
  const poles = polesFor(U, p, rows);
  poles[0] = pointAtParam(b, a);
  poles[poles.length - 1] = pointAtParam(b, z);
  return { degree: p, poles, ...compressKnots(U) };
}
