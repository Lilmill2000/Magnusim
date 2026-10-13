// The tunnel's own check of its physics: Schäfer and Turek's (1996) benchmark 2D-2, a
// cylinder in a channel at Re 100 with a parabolic inflow, run through the plugin's real
// solver and body path (a 256-sided outline baked into a distance field). T0 measured
// St 0.3017 and Cd max 3.259 at 20 cells per diameter with the same method; the
// benchmark's bounds are St 0.295–0.305, Cd max 3.22–3.24, Cl max 0.99–1.01.
// SPDX-License-Identifier: GPL-3.0-or-later
import { bakeSdf } from '../geometry/sdf';
import { outline } from '../geometry/shapes';
import { MAX_STEPS } from './kernels';
import { Patch } from './refine';
import { Solver } from './solver';

export const REF_2D2 = { St: [0.295, 0.305], cdMax: [3.22, 3.24], clMax: [0.99, 1.01] };

export interface ValidationResult {
  N: number;
  steps: number;
  seconds: number;
  St: number;
  cdMax: number;
  cdMean: number;
  clMax: number;
  periods: number;
  bad: number;
  /** Cell updates the limiter changed: 0 in a clean run. */
  limited: number;
}

/** Strouhal number and force coefficients from per-step force histories (the last `tail` of them). */
export function analyzeShedding(fx: Float64Array, fy: Float64Array, ubar: number, D: number, tail = 0.3) {
  const norm = 2 / (ubar * ubar * D);
  const len = fx.length;
  const start = Math.floor(len * (1 - tail));
  let clMean = 0;
  for (let s = start; s < len; s++) clMean += fy[s] * norm;
  clMean /= len - start;
  const crossings: number[] = [];
  for (let s = start + 1; s < len; s++) {
    const a = fy[s - 1] * norm - clMean;
    const b = fy[s] * norm - clMean;
    if (a < 0 && b >= 0) crossings.push(s - 1 + a / (a - b));
  }
  let cdMax = -Infinity;
  let cdSum = 0;
  let clMax = -Infinity;
  for (let s = start; s < len; s++) {
    cdMax = Math.max(cdMax, fx[s] * norm);
    cdSum += fx[s] * norm;
    clMax = Math.max(clMax, fy[s] * norm);
  }
  const periods = crossings.length - 1;
  const T = periods > 0 ? (crossings[crossings.length - 1] - crossings[0]) / periods : NaN;
  return { St: D / (T * ubar), cdMax, cdMean: cdSum / (len - start), clMax, periods };
}

/**
 * Run 2D-2 at N cells per diameter for `tstar` convective times (t U / D). With `refine`, a
 * patch of half-size cells (2N per diameter) covers the cylinder and its near wake, and the
 * forces come from it.
 */
export async function runSchaferTurek(device: GPUDevice, N = 20, tstar = 200, onProgress?: (f: number) => void, refine = false): Promise<ValidationResult> {
  const H = Math.round(4.1 * N);
  const nx = 22 * N;
  const umax = 0.05;
  const ubar = (2 / 3) * umax;
  const nu = (ubar * N) / 100;
  const solver = new Solver(device, { nx, ny: H, walls: 'noslip', profile: 1, absorbing: false });
  solver.setPhysics({ u: umax, tau: 3 * nu + 0.5, smagorinsky: false, smagCs: 0 });
  solver.reset(0);
  // Wall planes at y = -0.5 and H - 0.5; the centre 2 D from the bottom wall and 2 D from the inlet.
  const local = outline({ kind: 'circle', diameter: N });
  const sdf = bakeSdf(local);
  const pose = { x: 2 * N, y: -0.5 + 2 * N, theta: 0 };
  solver.setBodies([{ key: 'cyl', sdf, from: pose, to: pose }]);
  let patch: Patch | null = null;
  const fineNu = 2 * nu;
  if (refine) {
    const rect = { ox: Math.round(1.0 * N), oy: Math.round(0.6 * N), wc: Math.round(4 * N), hc: Math.round(2.8 * N) };
    const fine = new Solver(device, { nx: 2 * rect.wc + 1, ny: 2 * rect.hc + 1, walls: 'noslip', patch: true });
    fine.setPhysics({ u: umax, tau: 3 * fineNu + 0.5, smagorinsky: false, smagCs: 0, nuMol: fineNu, nuFloor: 0 });
    fine.reset(0);
    const fpose = { x: 2 * (pose.x - rect.ox), y: 2 * (pose.y - rect.oy), theta: 0 };
    fine.setBodies([{ key: 'cylf', sdf: bakeSdf(outline({ kind: 'circle', diameter: 2 * N })), from: fpose, to: fpose }]);
    patch = new Patch(device, solver, fine, rect, 0);
    solver.setPatches([patch]);
    solver.setPhysics({ u: umax, tau: 3 * nu + 0.5, smagorinsky: false, smagCs: 0 });
  }
  const steps = Math.ceil((tstar * N) / ubar);
  const fx = new Float64Array(steps);
  const fy = new Float64Array(steps);
  const t0 = performance.now();
  let bad = 0;
  let limited = 0;
  // The inflow ramps up over 2 convective times (as in T0), so start slow: the parameters
  // carry the inflow speed, so ramp it frame by frame.
  const rampSteps = Math.ceil((2 * N) / ubar);
  for (let s = 0; s < steps; ) {
    const count = Math.min(solver.maxFrameSteps, steps - s, s < rampSteps ? 200 : MAX_STEPS);
    const r = s < rampSteps ? 0.5 * (1 - Math.cos((Math.PI * s) / rampSteps)) : 1;
    solver.setPhysics({ u: umax * r, tau: 3 * nu + 0.5, smagorinsky: false, smagCs: 0 });
    patch?.fine.setPhysics({ u: umax * r, tau: 3 * fineNu + 0.5, smagorinsky: false, smagCs: 0, nuMol: fineNu, nuFloor: 0 });
    const enc = device.createCommandEncoder();
    solver.encodeFrame(enc, count, { mode: 1, uRef: umax, lRef: N });
    const read = solver.prepareRead(enc, count);
    const readFine = patch ? patch.fine.prepareRead(enc, 2 * count) : null;
    device.queue.submit([enc.finish()]);
    const res = await read();
    const fres = readFine ? await readFine() : null;
    if (!res || (readFine && !fres)) throw new Error('The force readback failed.');
    for (let k = 0; k < count; k++) {
      if (fres) {
        // Fine forces per fine step, in fine units: a coarse step's is a quarter of two of them.
        const ps = fres.forces[0].perStep;
        fx[s + k] = (ps[4 * k] + ps[4 * k + 2]) / 4;
        fy[s + k] = (ps[4 * k + 1] + ps[4 * k + 3]) / 4;
      } else {
        fx[s + k] = res.forces[0].perStep[2 * k];
        fy[s + k] = res.forces[0].perStep[2 * k + 1];
      }
    }
    bad += res.bad + (fres?.bad ?? 0);
    limited += res.limited + (fres?.limited ?? 0);
    s += count;
    onProgress?.(s / steps);
    if (bad) break;
  }
  solver.destroy();
  const a = analyzeShedding(fx, fy, ubar, N);
  return { N, steps, seconds: (performance.now() - t0) / 1000, ...a, bad, limited };
}
