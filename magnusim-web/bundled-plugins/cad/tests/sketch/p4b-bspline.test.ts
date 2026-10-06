// P4b splines: the B-spline math every spline use reads (fit-point interpolation,
// control-point splines open and closed, sampling, closest points, crossings,
// sub-ranges and Green's area).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { arcParamCurve, chordParams, clampedUniform, closestOnSpline, crossCurves, derivs, domain, fitSpline, flatKnots, periodicUniform, pointAtParam, segmentParamCurve, splineGreen, splineLength, splineParamCurve, subSpline } from '../../src/sketch/tools/bspline';
import type { Vec2 } from '../../src/types/doc';

const near = (a: Vec2, b: Vec2, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);

describe('B-spline math', () => {
  it('a clamped cubic on 4 poles is the Bezier: ends on the end poles, tangent along the first leg, area 720', () => {
    const b = clampedUniform([[40, 0], [40, 30], [0, 30], [0, 0]], 3);
    expect(b.knots).toEqual([0, 1]);
    expect(b.mults).toEqual([4, 4]);
    near(pointAtParam(b, 0), [40, 0]);
    near(pointAtParam(b, 1), [0, 0]);
    near(pointAtParam(b, 0.5), [20, 22.5]);
    const [, d] = derivs(b, 0, 1);
    expect(d[0]).toBeCloseTo(0);
    expect(d[1]).toBeCloseTo(90);
    // The line back along the x axis adds nothing to the Green integral.
    expect(splineGreen(b)).toBeCloseTo(720, 9);
  });

  it('a fit spline passes through every fit point, natural ends, C2 inside', () => {
    const pts: Vec2[] = [[0, 0], [10, 8], [25, -3], [40, 5], [50, 0]];
    const b = fitSpline(pts);
    const u = chordParams(pts);
    pts.forEach((p, i) => near(pointAtParam(b, u[i]), p, 1e-9));
    const [, , dd0] = derivs(b, 0, 2);
    const [, , dd1] = derivs(b, 1, 2);
    near(dd0, [0, 0], 1e-6);
    near(dd1, [0, 0], 1e-6);
    // C2 at an inner knot: second derivatives from both sides agree.
    const k = u[2];
    const [, , a] = derivs(b, k - 1e-9, 2);
    const [, , c] = derivs(b, k + 1e-9, 2);
    near(a, c, 1e-3);
  });

  it('two fit points make a straight line; handles make the second and second-last poles', () => {
    const line = fitSpline([[0, 0], [30, 0]]);
    near(pointAtParam(line, 0.5), [15, 0]);
    const b = fitSpline([[0, 0], [20, 10], [40, 0]], { handles: [[5, 5], [35, 5]] });
    near(b.poles[1], [5, 5]);
    near(b.poles[b.poles.length - 2], [35, 5]);
    near(pointAtParam(b, 1), [40, 0]);
  });

  it('a closed fit spline returns to its first point with C1 and C2 across the seam', () => {
    const pts: Vec2[] = [[0, 0], [20, -5], [30, 10], [10, 20]];
    const b = fitSpline(pts, { closed: true });
    near(pointAtParam(b, 0), pointAtParam(b, 1));
    const [, d0, dd0] = derivs(b, 0, 2);
    const [, d1, dd1] = derivs(b, 1, 2);
    near(d0, d1, 1e-6);
    near(dd0, dd1, 1e-5);
    // Counter-clockwise loop: positive area, close to the polygon's (a smooth loop bulges past it).
    expect(splineGreen(b)).toBeGreaterThan(300);
  });

  it('a closed control spline is the periodic uniform B-spline, expressed clamped', () => {
    // A square of poles: the periodic cubic is symmetric, its "corners" at 2/3 of the way to each pole.
    const sq: Vec2[] = [[10, 0], [0, 10], [-10, 0], [0, -10]];
    const b = periodicUniform(sq, 3);
    near(pointAtParam(b, 0), pointAtParam(b, 1), 1e-9);
    // Uniform periodic cubic: C(knot) = (P_{i-1} + 4 P_i + P_{i+1}) / 6.
    const pts = [0, 0.25, 0.5, 0.75].map((t) => pointAtParam(b, t));
    const expected = sq.map((_, i) => {
      const a = sq[i];
      const z = sq[(i + 1) % 4];
      const c = sq[(i + 2) % 4];
      return [(a[0] + 4 * z[0] + c[0]) / 6, (a[1] + 4 * z[1] + c[1]) / 6] as Vec2;
    });
    // One of the four knot points is each expected value (the seam may start at any of them).
    for (const e of expected) expect(pts.some((p) => Math.hypot(p[0] - e[0], p[1] - e[1]) < 1e-9)).toBe(true);
    const [, d0] = derivs(b, 0, 1);
    const [, d1] = derivs(b, 1, 1);
    near(d0, d1, 1e-6);
    expect(flatKnots(b).length).toBe(b.poles.length + 4);
  });

  it('degree 5 control splines: clamped open on 7 poles, periodic closed on 6', () => {
    const P: Vec2[] = [[0, 0], [10, 10], [20, -5], [30, 10], [40, -5], [50, 10], [60, 0]];
    const b = clampedUniform(P, 5);
    expect(b.mults).toEqual([6, 1, 6]);
    near(pointAtParam(b, 0), P[0]);
    near(pointAtParam(b, 1), P[6]);
    const c = periodicUniform(P.slice(0, 6), 5);
    near(pointAtParam(c, 0), pointAtParam(c, 1), 1e-9);
    const [, , , , d4a] = derivs(c, 0, 4);
    const [, , , , d4b] = derivs(c, 1, 4);
    near(d4a, d4b, 1e-3);
    expect(() => clampedUniform(P.slice(0, 5), 5)).toThrow(/needs 6 control points/);
  });

  it('closest points, length and sub-ranges', () => {
    const b = clampedUniform([[0, 0], [10, 20], [30, 20], [40, 0]], 3);
    const c = closestOnSpline(b, [20, 30]);
    near(c.p, [20, 15], 1e-9);
    expect(c.u).toBeCloseTo(0.5, 9);
    const straight = clampedUniform([[0, 0], [10, 0], [20, 0], [30, 0]], 3);
    expect(splineLength(straight)).toBeCloseTo(30, 9);
    const s = subSpline(b, 0.25, 0.75);
    expect(domain(s)).toEqual([0.25, 0.75]);
    for (const t of [0.25, 0.4, 0.6, 0.75]) near(pointAtParam(s, t), pointAtParam(b, t), 1e-9);
  });

  it('crossings with a line, an arc and another spline', () => {
    const b = clampedUniform([[0, 0], [10, 20], [30, 20], [40, 0]], 3);
    const xs = crossCurves(splineParamCurve(b), segmentParamCurve([0, 10], [40, 10]));
    expect(xs).toHaveLength(2);
    for (const x of xs) expect(x.p[1]).toBeCloseTo(10, 9);
    const arc = crossCurves(splineParamCurve(b), arcParamCurve([20, 0], 18, 0, Math.PI));
    expect(arc).toHaveLength(2);
    for (const x of arc) expect(Math.hypot(x.p[0] - 20, x.p[1])).toBeCloseTo(18, 9);
    const other = clampedUniform([[0, 20], [10, 0], [30, 0], [40, 20]], 3);
    const ss = crossCurves(splineParamCurve(b), splineParamCurve(other));
    expect(ss).toHaveLength(2);
    for (const x of ss) expect(x.p[1]).toBeCloseTo(10, 6);
  });
});
