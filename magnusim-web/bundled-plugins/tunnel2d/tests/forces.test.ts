// T5's pure parts: the sweep's angles and averages, the surface-pressure points and their
// split into upper and lower surfaces, and probes and sweeps in a saved scene.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { meanBetween, sweepAngles } from '../src/sim/sweep';
import { outerRing, splitSurface, surfacePoints } from '../src/sim/surfaceCp';
import { defaultScene, parseScene, SCENE_VERSION } from '../src/scene/scene';

describe('the angle sweep', () => {
  it('visits from one end to the other by the step, keeping the far end', () => {
    expect(sweepAngles(-4, 4, 2)).toEqual([-4, -2, 0, 2, 4]);
    expect(sweepAngles(10, 0, 4)).toEqual([10, 6, 2, 0]);
    expect(sweepAngles(0, 1, -0.5)).toEqual([0, 0.5, 1]);
    expect(sweepAngles(3, 3, 1)).toEqual([3]);
  });

  it('refuses a step too small, angles out of range, or too many angles, with the reason', () => {
    expect(sweepAngles(0, 4, 0)).toEqual({ error: 'The step must be at least 0.1°.' });
    expect(sweepAngles(0, 200, 5)).toEqual({ error: 'Angles go from −180° to 180°.' });
    expect('error' in (sweepAngles(-90, 90, 1) as object)).toBe(true);
    expect(sweepAngles(-30, 30, 1)).toHaveLength(61);
  });

  it('averages only the samples in its window', () => {
    const sm = { t: [0, 1, 2, 3, 4], cl: [9, 1, 2, 3, 9], cd: [9, 0.1, 0.2, 0.3, 9], cm: [9, -1, -1, -1, 9] };
    const m = meanBetween(sm, 1, 3)!;
    expect(m.cl).toBeCloseTo(2, 12);
    expect(m.cd).toBeCloseTo(0.2, 12);
    expect(m.cm).toBeCloseTo(-1, 12);
    expect(meanBetween(sm, 5, 6)).toBeNull();
  });
});

describe('surface pressure points', () => {
  // A square, clockwise: the outer ring comes back counter-clockwise.
  const square = [0, 0, 0, 10, 10, 10, 10, 0];

  it('evenly spaced round the outline, each one off it along the outward normal', () => {
    const ring = outerRing([square]);
    const pts = surfacePoints(ring, 1, 1);
    expect(pts).toHaveLength(40);
    for (const p of pts) {
      // On the square's edge, the read point one out from it.
      const onEdge = Math.min(Math.abs(p.x), Math.abs(p.x - 10), Math.abs(p.y), Math.abs(p.y - 10)) < 1e-9;
      expect(onEdge).toBe(true);
      const out = p.px < 0 || p.px > 10 || p.py < 0 || p.py > 10;
      expect(out).toBe(true);
    }
  });

  it('split from the leading point: the lower surface first (counter-clockwise), each by x from 0 to 1', () => {
    // A thin lens, upper side bulging more: values = y, so the upper surface reads above the lower.
    const ring: number[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (2 * Math.PI * i) / 64;
      ring.push(Math.cos(Math.PI - a) * 5 + 5, Math.sin(Math.PI - a) >= 0 ? 2 * Math.sin(Math.PI - a) : Math.sin(Math.PI - a));
    }
    const pts = surfacePoints(outerRing([ring]), 0.25, 0.5);
    const { upper, lower } = splitSurface(pts, pts.map((p) => p.y));
    expect(upper[0].x).toBeCloseTo(0, 6);
    expect(lower[0].x).toBeCloseTo(0, 6);
    expect(upper[upper.length - 1].x).toBeCloseTo(1, 6);
    expect(lower[lower.length - 1].x).toBeCloseTo(1, 6);
    const mid = (c: { x: number; cp: number }[]) => c.reduce((b, p) => (Math.abs(p.x - 0.5) < Math.abs(b.x - 0.5) ? p : b)).cp;
    expect(mid(upper)).toBeGreaterThan(1.5);
    expect(mid(lower)).toBeLessThan(-0.5);
    // A value read inside a body (null) is left out.
    const holes = splitSurface(pts, pts.map((p, i) => (i % 2 ? null : p.y)));
    expect(holes.upper.length + holes.lower.length).toBeLessThan(upper.length + lower.length);
  });
});

describe('probes and sweeps in a saved scene', () => {
  it('read back, with what does not read dropped', () => {
    const s = { ...defaultScene(), probes: [{ id: 'p1', x: 3, y: 2 }], sweep: { bodyId: 'b', bodyName: 'NACA 0012', re: 6.6e5, model: 'sa', exact: true, rows: [{ angle: 0, cl: 0, cd: 0.02, cm: 0 }, { angle: 'x', cl: 1, cd: 1, cm: 1 }] } };
    const back = parseScene(JSON.parse(JSON.stringify(s)));
    expect(back.version).toBe(SCENE_VERSION);
    expect(back.probes).toEqual([{ id: 'p1', x: 3, y: 2 }]);
    expect(back.sweep?.rows).toEqual([{ angle: 0, cl: 0, cd: 0.02, cm: 0 }]);
    expect(back.sweep?.model).toBe('sa');
  });

  it('an older scene has no probes and no sweep', () => {
    const old = { ...defaultScene(), version: 5 } as Record<string, unknown>;
    delete old.probes;
    delete old.sweep;
    const back = parseScene(old);
    expect(back.probes).toEqual([]);
    expect(back.sweep).toBeNull();
  });
});
