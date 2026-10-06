// SPDX-License-Identifier: GPL-3.0-or-later
// workspace/keyNumbers.js: the numbers the Airfoil page reads a polar by (run by test_key_numbers.py).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keyNumbers, THIN_AIRFOIL_SLOPE } from '../workspace/keyNumbers.js';

/** A thin-airfoil-like polar: Cl = 0.11·(α + 2) up to 12°, then it turns over. */
function polar() {
  const rows = [];
  for (let a = -4; a <= 16; a++) {
    const cl = a <= 12 ? 0.11 * (a + 2) : 0.11 * 14 - 0.08 * (a - 12) ** 2;
    rows.push({ alpha: a, cl, cd: 0.006 + 0.0004 * (a - 1) ** 2, cm: -0.05 + 0.001 * a });
  }
  return rows;
}

describe('airfoil key numbers', () => {
  it('reads the most lift and its angle, and calls it stall only when the curve turns over in the range', () => {
    const k = keyNumbers(polar());
    assert.deepEqual([k.clMax.alpha, Number(k.clMax.cl.toFixed(4)), k.clMax.stalled], [12, 1.54, true]);
    // Cut at 10°: the most lift is at the last angle, still rising.
    const rising = keyNumbers(polar().filter((r) => r.alpha <= 10));
    assert.deepEqual([rising.clMax.alpha, rising.clMax.stalled], [10, false]);
  });

  it('fits the lift slope on the straight part (−5…8°, 3° short of stall), per degree and per radian', () => {
    const k = keyNumbers(polar());
    assert.ok(Math.abs(k.slope.perDeg - 0.11) < 1e-9);
    assert.ok(Math.abs(k.slope.perRad - 0.11 * (180 / Math.PI)) < 1e-9);
    assert.deepEqual([k.slope.from, k.slope.to], [-4, 8]);
    assert.ok(Math.abs(THIN_AIRFOIL_SLOPE - 6.2832) < 1e-4);
  });

  it('finds the zero-lift angle where Cl crosses zero, else from the slope line (said as extrapolated)', () => {
    assert.deepEqual(keyNumbers(polar()).alpha0, { alpha: -2, extrapolated: false });
    const k = keyNumbers(polar().filter((r) => r.alpha >= 0));
    assert.equal(k.alpha0.extrapolated, true);
    assert.ok(Math.abs(k.alpha0.alpha + 2) < 1e-9);
  });

  it('least drag, best lift-to-drag, and Cm at 0° (between angles too); null when out of range', () => {
    const k = keyNumbers(polar());
    assert.deepEqual([k.cdMin.alpha, Number(k.cdMin.cd.toFixed(6))], [1, 0.006]);
    const ld = polar().map((r) => ({ a: r.alpha, v: r.cl / r.cd })).sort((p, q) => q.v - p.v)[0];
    assert.equal(k.bestLd.alpha, ld.a);
    assert.ok(Math.abs(k.cm0 + 0.05) < 1e-12);
    const half = keyNumbers([
      { alpha: -1, cl: -0.1, cm: -0.04 },
      { alpha: 1, cl: 0.1, cm: -0.06 },
    ]);
    assert.ok(Math.abs(half.cm0 + 0.05) < 1e-12);
    assert.equal(keyNumbers(polar().filter((r) => r.alpha >= 2)).cm0, null);
  });

  it('skips angles without Cl, and needs two angles', () => {
    assert.equal(keyNumbers([{ alpha: 1, cl: 0.3 }]), null);
    assert.equal(keyNumbers([{ alpha: 1, cl: 0.3 }, { alpha: 2 }]), null);
    assert.equal(keyNumbers(null), null);
    // No drag: no Cd min or best L/D, the rest still read.
    const k = keyNumbers([{ alpha: 0, cl: 0.2 }, { alpha: 2, cl: 0.4 }, { alpha: 4, cl: 0.6 }]);
    assert.deepEqual([k.cdMin, k.bestLd, Number(k.slope.perDeg.toFixed(3))], [null, null, 0.1]);
  });
});
