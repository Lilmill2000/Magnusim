// From the user's tunnel (metres, m/s, a fluid) to the lattice the GPU solves, and back.
//
// The lattice inflow speed is 0.05 (T0: the compressibility error in Cd falls as Ma²;
// 0.1 gave +4 %, 0.05 +1.8 %). A lattice can only resolve so much: its viscosity is
// floored so the grid Reynolds number (inflow speed x one cell / viscosity) stays at or
// below GRID_RE_MAX. Above that the simulated Reynolds number is lower than the real
// one, and the UI says so; the Smagorinsky model then carries the unresolved scales.
// SPDX-License-Identifier: GPL-3.0-or-later

export const U_LATTICE = 0.05;
/** Highest inflow speed x cell / viscosity the lattice is run at (τ ≥ 0.503 at 0.05). */
export const GRID_RE_MAX = 50;
/** Viscosity (lattice) below which the Smagorinsky model is switched on. */
export const SMAG_BELOW_NU = 0.005;
export const SMAG_CS = 0.1;
/** The most viscous lattice run: τ = 1.5. Slower flows lower the lattice speed instead. */
const NU_LATTICE_MAX = 1 / 3;

export interface LatticeMap {
  /** Cell size (m). */
  dx: number;
  /** Time step (s). */
  dt: number;
  /** Lattice inflow speed (cells per step). */
  u: number;
  /** Lattice kinematic viscosity. */
  nu: number;
  tau: number;
  /** The physical viscosity was raised to what the grid resolves. */
  capped: boolean;
  smagorinsky: boolean;
}

export function latticeMap(lengthM: number, nx: number, speed: number, nuPhys: number): LatticeMap {
  const dx = lengthM / nx;
  let u = U_LATTICE;
  // A very viscous or very slow flow: keep τ ≤ 1.5 by running the lattice slower.
  const nuAt = (uu: number) => (nuPhys * uu) / (speed * dx);
  if (nuAt(u) > NU_LATTICE_MAX) u = (NU_LATTICE_MAX * speed * dx) / nuPhys;
  const nuWanted = nuAt(u);
  const nuMin = u / GRID_RE_MAX;
  const nu = Math.max(nuWanted, nuMin);
  const dt = (u * dx) / speed;
  return { dx, dt, u, nu, tau: 3 * nu + 0.5, capped: nuWanted < nuMin, smagorinsky: nu < SMAG_BELOW_NU };
}

/** Reynolds number of a body of length `refM`: the real one, and the one the lattice runs. */
export function reynolds(map: LatticeMap, refM: number, speed: number, nuPhys: number): { real: number; sim: number } {
  return { real: (speed * refM) / nuPhys, sim: (map.u * (refM / map.dx)) / map.nu };
}
