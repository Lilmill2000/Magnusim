// The lattice a tunnel runs on, and the Reynolds numbers it reports.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GRID_RE_MAX, latticeMap, reynolds, U_LATTICE } from '../src/sim/units';

describe('the lattice map', () => {
  it('caps the Reynolds number at what the grid resolves, and says so', () => {
    // 8 m in 1536 cells, 10 m/s of air: the real Re of a 1 m chord is 660,000.
    const m = latticeMap(8, 1536, 10, 1.516e-5);
    expect(m.u).toBe(U_LATTICE);
    expect(m.capped).toBe(true);
    expect(m.nu).toBeCloseTo(U_LATTICE / GRID_RE_MAX, 12);
    expect(m.tau).toBeCloseTo(0.503, 9);
    expect(m.smagorinsky).toBe(true);
    const re = reynolds(m, 1, 10, 1.516e-5);
    expect(re.real).toBeCloseTo(659_631, -1);
    // 192 cells per chord x 50 per cell.
    expect(re.sim).toBeCloseTo(192 * GRID_RE_MAX, 6);
    // dt from the lattice speed: 0.05 cells a step at 10 m/s.
    expect(m.dt).toBeCloseTo((0.05 * (8 / 1536)) / 10, 15);
  });
  it('runs a resolved flow at its real Reynolds number', () => {
    // A 1 cm cylinder in 1 cm/s of water: Re 100.
    const m = latticeMap(0.2, 1024, 0.01, 1.004e-6);
    expect(m.capped).toBe(false);
    expect(reynolds(m, 0.01, 0.01, 1.004e-6).sim).toBeCloseTo(99.6, 1);
    expect(m.smagorinsky).toBe(false);
  });
  it('slows the lattice for a very viscous flow instead of a relaxation time above 1.5', () => {
    const m = latticeMap(1, 512, 0.001, 1e-3);
    expect(m.u).toBeLessThan(U_LATTICE);
    expect(m.tau).toBeLessThanOrEqual(1.5 + 1e-12);
  });
});
