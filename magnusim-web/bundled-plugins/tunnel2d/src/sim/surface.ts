// What the flow does on a body's surface, worked out on the CPU from a snapshot of the
// field: pressure and skin-friction coefficients panel by panel along the outline, and
// the force they integrate to (pressure and friction apart). It checks the GPU's
// momentum-exchange force a second way, and gives the Cp and Cf curves the validation
// cases compare with published data.
// SPDX-License-Identifier: GPL-3.0-or-later
import { KAPPA, WALL_B, WALL_REF_CELLS } from "./kernels";

const WALL_EKB = Math.exp(-KAPPA * WALL_B);

/** u+ on Spalding's wall law where y ut / ν = reY (as the GPU solves it). */
export function wallUplus(reY: number): number {
  let up = Math.min(Math.sqrt(Math.max(reY, 0)), 45);
  for (let i = 0; i < 40; i++) {
    const k = KAPPA * up;
    const ek = Math.exp(k);
    const Y = up + WALL_EKB * (ek - 1 - k - 0.5 * k * k - (k * k * k) / 6);
    const dY = 1 + WALL_EKB * KAPPA * (ek - 1 - k - 0.5 * k * k);
    const next = Math.max(up - (Y * up - reY) / (dY * up + Y), 1e-4);
    if (Math.abs(next - up) < 1e-10 * up) return next;
    up = next;
  }
  return up;
}

/** y+ on Spalding's law at u+. */
export function spaldingYplus(up: number): number {
  const k = KAPPA * up;
  return up + WALL_EKB * (Math.exp(k) - 1 - k - 0.5 * k * k - (k * k * k) / 6);
}

export interface FieldSnapshot {
  nx: number;
  ny: number;
  /** Per cell: velocity x, y, density, 1 inside a body (the solver's macro buffer). */
  mac: Float32Array;
}

export interface SurfaceOptions {
  /** Free-stream speed and density (lattice). */
  u: number;
  rho: number;
  /** Reference length (cells) for the coefficients. */
  lRef: number;
  /** 'resolved': shear from the velocity gradient at the wall; 'wall': from the wall law. */
  shear: "resolved" | "wall";
  /** Viscosity (lattice) of the shear: the cell viscosity when resolved, the fluid's own for the wall law. */
  nu: number;
}

export interface Panel {
  /** Midpoint (cells), outward normal, unit tangent (along the outline), length (cells). */
  x: number;
  y: number;
  nx: number;
  ny: number;
  ds: number;
  cp: number;
  /** Skin friction along the panel's tangent (signed). */
  cf: number;
}

export interface SurfaceResult {
  panels: Panel[];
  /** Force coefficients (on lRef) in the lattice's x (drag) and y (lift): pressure, friction, total. */
  cxP: number;
  cyP: number;
  cxF: number;
  cyF: number;
  cx: number;
  cy: number;
}

/** Bilinear sample of the snapshot at l over fluid cells only (null if none of the four is fluid). */
export function sampleFluid(
  f: FieldSnapshot,
  lx: number,
  ly: number,
): { ux: number; uy: number; rho: number } | null {
  const cx = Math.min(Math.max(lx, 0), f.nx - 1.001);
  const cy = Math.min(Math.max(ly, 0), f.ny - 1.001);
  const i = Math.floor(cx);
  const j = Math.floor(cy);
  const fx = cx - i;
  const fy = cy - j;
  let ux = 0;
  let uy = 0;
  let rho = 0;
  let ws = 0;
  for (let k = 0; k < 4; k++) {
    const di = k & 1;
    const dj = k >> 1;
    const c = (j + dj) * f.nx + i + di;
    if (f.mac[4 * c + 3] > 0.5) continue;
    const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
    ux += w * f.mac[4 * c];
    uy += w * f.mac[4 * c + 1];
    rho += w * f.mac[4 * c + 2];
    ws += w;
  }
  if (ws < 1e-6) return null;
  return { ux: ux / ws, uy: uy / ws, rho: rho / ws };
}

/**
 * Cp and Cf on each edge of `poly` (lattice cells, counter-clockwise, at the body's pose
 * now; the body at rest) and the force they integrate to. Pressure is read one cell off
 * the wall; the wall law's friction velocity comes from the velocity WALL_REF_CELLS off it,
 * as the solver takes it.
 */
export function analyzeSurface(
  f: FieldSnapshot,
  poly: number[],
  o: SurfaceOptions,
): SurfaceResult {
  const q = 0.5 * o.rho * o.u * o.u;
  const n = poly.length / 2;
  const panels: Panel[] = [];
  let fxP = 0;
  let fyP = 0;
  let fxF = 0;
  let fyF = 0;
  for (let e = 0; e < n; e++) {
    const ax = poly[2 * e];
    const ay = poly[2 * e + 1];
    const bx = poly[2 * ((e + 1) % n)];
    const by = poly[2 * ((e + 1) % n) + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    // Long edges in pieces of at most a cell, so Cp and Cf are local.
    const pieces = Math.max(1, Math.ceil(len));
    const ds = len / pieces;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    // Counter-clockwise: the outside is on the right.
    const nx = ty;
    const ny = -tx;
    for (let pc = 0; pc < pieces; pc++) {
      const mx = ax + tx * ds * (pc + 0.5);
      const my = ay + ty * ds * (pc + 0.5);
      const s1 = sampleFluid(f, mx + nx, my + ny);
      const s2 = sampleFluid(
        f,
        mx + WALL_REF_CELLS * nx,
        my + WALL_REF_CELLS * ny,
      );
      if (!s1 || !s2) continue;
      const p = (s1.rho - o.rho) / 3;
      let tau: number;
      const u1 = s1.ux * tx + s1.uy * ty;
      const u2 = s2.ux * tx + s2.uy * ty;
      if (o.shear === "resolved") {
        // u(0) = 0, a parabola through the samples at 1 and 2 cells: du/dn at the wall.
        const r = WALL_REF_CELLS;
        const grad = (r * r * u1 - u2) / (r * r - r);
        tau = s1.rho * o.nu * grad;
      } else {
        const ut = Math.abs(u2);
        const utau =
          ut > 1e-12 ? ut / wallUplus((WALL_REF_CELLS * ut) / o.nu) : 0;
        tau = Math.sign(u2) * s1.rho * utau * utau;
      }
      fxP += -p * nx * ds;
      fyP += -p * ny * ds;
      fxF += tau * tx * ds;
      fyF += tau * ty * ds;
      panels.push({ x: mx, y: my, nx, ny, ds, cp: p / q, cf: tau / q });
    }
  }
  const k = 1 / (q * o.lRef);
  return {
    panels,
    cxP: fxP * k,
    cyP: fyP * k,
    cxF: fxF * k,
    cyF: fyF * k,
    cx: (fxP + fxF) * k,
    cy: (fyP + fyF) * k,
  };
}

export interface BlStation {
  /** Edge speed (lattice), thicknesses (cells): 99 %, displacement, momentum; shape factor. */
  ue: number;
  delta: number;
  dstar: number;
  theta: number;
  h: number;
}

/**
 * The boundary layer's integral thicknesses on the normal out of a wall point (cells): the
 * tangential speed sampled every half cell out to `reach`, the edge where the total
 * pressure (p + ρ|u|²/2, p = ρ/3) first comes back within 1 % of the free stream's dynamic
 * pressure of its free-stream value (outside the layer the flow has lost none), and the
 * speed taken to fall linearly to 0 at the wall below the first sample.
 */
export function blStation(
  f: FieldSnapshot,
  x: number,
  y: number,
  nx: number,
  ny: number,
  reach: number,
  free: { rho: number; u: number },
): BlStation | null {
  const tx = -ny;
  const ty = nx;
  const p0inf = free.rho / 3 + 0.5 * free.rho * free.u * free.u;
  const tol = 0.01 * 0.5 * free.rho * free.u * free.u;
  const us: number[] = [0];
  const ds: number[] = [0];
  let k = -1;
  for (let d = 0.5; d <= reach; d += 0.5) {
    const s = sampleFluid(f, x + nx * d, y + ny * d);
    if (!s) return null;
    us.push(s.ux * tx + s.uy * ty);
    ds.push(d);
    const p0 = s.rho / 3 + 0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy);
    if (d >= 1 && p0 >= p0inf - tol) {
      k = us.length - 1;
      break;
    }
  }
  if (k < 1) return null;
  // The flow along the wall may run either way round the outline: take its sense from the edge.
  const sign = Math.sign(us[k]) || 1;
  const u = us.map((v) => v * sign);
  const ue = u[k];
  let dstar = 0;
  let theta = 0;
  for (let i = 1; i <= k; i++) {
    const a = u[i - 1] / ue;
    const b = u[i] / ue;
    const h = ds[i] - ds[i - 1];
    dstar += 0.5 * h * (1 - a + (1 - b));
    theta += 0.5 * h * (a * (1 - a) + b * (1 - b));
  }
  return { ue, delta: ds[k], dstar, theta, h: dstar / theta };
}
