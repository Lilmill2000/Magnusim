// The grid for a tunnel: the cells each resolution gives, and square cells in the tunnel's shape.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Resolution, Scene } from '../scene/scene';

/** Cells in the lattice for each resolution (the grid keeps the tunnel's aspect). */
export const RESOLUTION_CELLS: Record<Exclude<Resolution, 'auto'>, number> = {
  low: 512 * 256,
  medium: 1024 * 512,
  high: 1536 * 768,
  ultra: 2048 * 1024,
};

/** The grid's limits: cells along the tunnel and across it. */
export const GRID_NX = [32, 8192] as const;
export const GRID_NY = [16, 8192] as const;

/**
 * The grid for a tunnel at about `cells` cells: square cells, so the grid has the tunnel's
 * shape. A side held at a limit sets the other from the tunnel's length over its height
 * (the cells stay square to the tunnel as set). Only a tunnel more than 512 times as long as
 * it is tall cannot keep its height (see gridHeight).
 */
export function gridFor(scene: Scene, cells: number): { nx: number; ny: number } {
  const { length, height } = scene.tunnel;
  const aspect = length / height;
  let nx = Math.round(Math.sqrt((cells * length) / height));
  let ny = Math.round(cells / nx);
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));
  if (nx === clamp(nx, GRID_NX) && ny === clamp(ny, GRID_NY)) return { nx, ny };
  // A side at a limit: the other from the tunnel's shape.
  if (nx > GRID_NX[1] || nx < GRID_NX[0]) {
    nx = clamp(nx, GRID_NX);
    ny = clamp(Math.round(nx / aspect), GRID_NY);
  }
  if (ny > GRID_NY[1] || ny < GRID_NY[0]) {
    ny = clamp(ny, GRID_NY);
    nx = clamp(Math.round(ny * aspect), GRID_NX);
  }
  return { nx, ny };
}

/** The height the grid runs (m): the tunnel's own, except for one too long and thin for the grid. */
export function gridHeight(scene: Scene, grid: { nx: number; ny: number }): number {
  return (grid.ny * scene.tunnel.length) / grid.nx;
}
