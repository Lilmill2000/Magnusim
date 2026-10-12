// The Strouhal/force analysis the 2D-2 check uses, on a known signal.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { analyzeShedding } from '../src/sim/validate';

describe('shedding analysis', () => {
  it('finds the period and the peaks of a clean oscillation', () => {
    const N = 20;
    const ubar = 0.05;
    const period = 1333.3;
    const n = 40_000;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    const norm = (ubar * ubar * N) / 2;
    for (let s = 0; s < n; s++) {
      fx[s] = (3.2 + 0.02 * Math.sin((4 * Math.PI * s) / period)) * norm;
      fy[s] = (0.1 + 1.0 * Math.sin((2 * Math.PI * s) / period)) * norm;
    }
    const a = analyzeShedding(fx, fy, ubar, N);
    expect(a.St).toBeCloseTo(N / (period * ubar), 3);
    expect(a.cdMax).toBeCloseTo(3.22, 3);
    expect(a.clMax).toBeCloseTo(1.1, 3);
    // The last 30 % (12,000 steps) holds 9 periods; whole periods between the first and last crossings: 7 or 8.
    expect(a.periods).toBeGreaterThanOrEqual(7);
  });
});
