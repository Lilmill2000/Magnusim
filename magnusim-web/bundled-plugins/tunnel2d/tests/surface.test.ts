// The surface analysis the turbulence model's checks rest on: the wall law, the sampling
// beside a wall, and the force a uniform field integrates to.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { analyzeSurface, sampleFluid, spaldingYplus, wallUplus } from '../src/sim/surface';
import { KAPPA, WALL_B } from '../src/sim/kernels';

describe('the wall law', () => {
  it('inverts Spalding: u+ from y+ u+ and back', () => {
    for (const up of [0.5, 3, 8, 12, 20, 28, 35]) {
      const yp = spaldingYplus(up);
      expect(wallUplus(yp * up)).toBeCloseTo(up, 6);
    }
  });
  it('is linear in the viscous sublayer and logarithmic far out', () => {
    expect(wallUplus(4)).toBeCloseTo(2, 2); // u+ = y+ = 2
    const yp = 1e4;
    const up = Math.log(yp) / KAPPA + WALL_B;
    expect(spaldingYplus(up)).toBeCloseTo(yp, -2);
  });
});

describe('the surface sampling', () => {
  const nx = 20;
  const ny = 20;
  // Uniform flow (0.05, 0), density 1.01, with a solid block x < 5.
  const mac = new Float32Array(4 * nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = 4 * (j * nx + i);
      const solid = i < 5;
      mac.set(solid ? [0, 0, 1, 1] : [0.05, 0, 1.01, 0], k);
    }
  const f = { nx, ny, mac };
  it('leaves solid cells out of the interpolation', () => {
    const s = sampleFluid(f, 4.5, 10)!;
    expect(s.ux).toBeCloseTo(0.05, 7);
    expect(s.rho).toBeCloseTo(1.01, 6);
    expect(sampleFluid(f, 2, 10)).toBeNull();
  });
  it('gives no force from a uniform field round a closed body', () => {
    // A square well inside the fluid, counter-clockwise.
    const poly = [8, 8, 14, 8, 14, 14, 8, 14];
    const r = analyzeSurface(f, poly, { u: 0.05, rho: 1.01, lRef: 6, shear: 'wall', nu: 1e-6 });
    expect(Math.abs(r.cxP)).toBeLessThan(1e-9);
    expect(Math.abs(r.cyP)).toBeLessThan(1e-9);
    // Uniform flow slides along the top and bottom: friction drags them downstream, equally.
    expect(r.cxF).toBeGreaterThan(0);
    expect(Math.abs(r.cyF)).toBeLessThan(1e-9);
  });
});
