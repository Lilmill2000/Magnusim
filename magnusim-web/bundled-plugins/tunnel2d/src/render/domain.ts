// The tunnel's pixels on the GPU canvas (device px), as the render shader decides them: a pixel
// whose centre's lattice point lies in [-0.5, n - 0.5] on both axes is the tunnel's, the rest are
// the view's margins (src/sim/kernels.ts, fs, its first test). The overlay paints the dark view's
// margins and the ring at the tunnel's wall by it. The shader works in f32, so a pixel centre
// within a rounding of the boundary can go either way: the ring covers the tunnel's outermost
// pixels, so such a pixel is always painted over (tests/domain.test.ts runs the shader's test).
// SPDX-License-Identifier: GPL-3.0-or-later

/** The frame on the GPU canvas: its lattice view (f32, as the shader has it), its grid, the canvas's size. */
export interface Drawn {
  /** Lattice cells per device pixel. */
  scale: number;
  /** The lattice point of the canvas's top-left corner. */
  ox: number;
  oy: number;
  nx: number;
  ny: number;
  /** The canvas (device px). */
  w: number;
  h: number;
}

/** The tunnel's pixels on the canvas: columns [x0, x1), rows [y0, y1), and which of its walls are on the canvas. */
export interface DomainPx {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  walls: { left: boolean; right: boolean; top: boolean; bottom: boolean };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The tunnel's pixels on the canvas, or null when it has none (the canvas is all margin). */
export function domainRectPx(d: Drawn): DomainPx | null {
  const s = d.scale;
  // Pixel (i, j)'s centre is the lattice point (ox + (i + 0.5) s, oy - (j + 0.5) s).
  const x0 = Math.ceil((-0.5 - d.ox) / s - 0.5);
  const x1 = Math.floor((d.nx - 0.5 - d.ox) / s - 0.5) + 1;
  const y0 = Math.ceil((d.oy - d.ny + 0.5) / s - 0.5);
  const y1 = Math.floor((d.oy + 0.5) / s - 0.5) + 1;
  const r = { x0: clamp(x0, 0, d.w), x1: clamp(x1, 0, d.w), y0: clamp(y0, 0, d.h), y1: clamp(y1, 0, d.h) };
  if (!(r.x0 < r.x1 && r.y0 < r.y1)) return null;
  return { ...r, walls: { left: x0 >= 0, right: x1 <= d.w, top: y0 >= 0, bottom: y1 <= d.h } };
}
