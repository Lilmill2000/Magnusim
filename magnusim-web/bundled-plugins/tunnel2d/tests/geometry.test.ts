// Outlines, polygons and the baked distance field the GPU samples.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contains, selfIntersects, signedArea, signedDistance, transform } from '../src/geometry/polygon';
import { bakeSdf, sampleSdf, SDF_BAND } from '../src/geometry/sdf';
import { outline, referenceLength, type Shape } from '../src/geometry/shapes';

const SHAPES: Shape[] = [
  { kind: 'naca', code: '2412', chord: 1 },
  { kind: 'circle', diameter: 0.5 },
  { kind: 'rect', width: 0.4, height: 0.2 },
  { kind: 'ellipse', width: 0.6, height: 0.2 },
  { kind: 'plate', length: 1, thickness: 0.02 },
];

describe('outlines', () => {
  it('are counter-clockwise and simple, with the pivot inside', () => {
    for (const s of SHAPES) {
      const p = outline(s);
      expect(signedArea(p), s.kind).toBeGreaterThan(0);
      expect(selfIntersects(p), s.kind).toBe(false);
      expect(contains(p, 0, 0), s.kind).toBe(true);
    }
  });
  it('turn an airfoil about its quarter chord', () => {
    const p = outline({ kind: 'naca', code: '0012', chord: 2 });
    const xs = p.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-0.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(1.5, 6);
    expect(referenceLength({ kind: 'naca', code: '0012', chord: 2 })).toBe(2);
  });
  it('give a circle the area of a circle', () => {
    expect(signedArea(outline({ kind: 'circle', diameter: 2 }))).toBeCloseTo(Math.PI, 3);
  });
});

describe('the distance field', () => {
  it('matches the exact signed distance near the wall, and has the right sign everywhere', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const s of SHAPES) {
      const local = transform(outline(s), { x: 0, y: 0, theta: 0 }, 100); // 100 cells per metre
      const g = bakeSdf(local);
      let worst = 0;
      for (let k = 0; k < 4000; k++) {
        const x = g.ox + rand() * (g.w - 1) * g.texel;
        const y = g.oy + rand() * (g.h - 1) * g.texel;
        const exact = signedDistance(local, x, y);
        const got = sampleSdf(g, x, y);
        if (Math.abs(exact) < SDF_BAND - 1) worst = Math.max(worst, Math.abs(got - exact));
        // The sign decides fluid or solid: right wherever the wall is more than a texel away.
        if (Math.abs(exact) > g.texel * 1.5) expect(Math.sign(got), `${s.kind} at ${x},${y}`).toBe(Math.sign(exact));
      }
      // Bilinear sampling of half-cell texels: within a quarter cell of the exact distance.
      expect(worst, s.kind).toBeLessThan(0.25);
    }
  });
  it('is +band outside its grid', () => {
    const g = bakeSdf(transform(outline({ kind: 'circle', diameter: 1 }), { x: 0, y: 0, theta: 0 }, 20));
    expect(sampleSdf(g, 1e4, 0)).toBe(SDF_BAND);
    expect(g.bound).toBeGreaterThanOrEqual(10);
  });
});
