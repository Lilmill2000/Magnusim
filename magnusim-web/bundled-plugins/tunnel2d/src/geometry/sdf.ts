// A body's signed distance field, baked once per shape and grid in the body's own frame
// (lattice cells, pivot at the origin) and sampled by the GPU each step at the body's pose.
// Narrow band: exact distances within `band` cells of the outline, ±band beyond it
// (the solver only needs the sign away from the wall).
// SPDX-License-Identifier: GPL-3.0-or-later
import { bboxRings, type Poly, type Rings } from "./polygon";

export interface SdfGrid {
  data: Float32Array<ArrayBuffer>;
  w: number;
  h: number;
  /** Local coordinates (cells) of texel (0, 0). */
  ox: number;
  oy: number;
  /** Cells per texel. */
  texel: number;
  band: number;
  /** Bounding radius (cells) around the pivot: outside it the field is +band. */
  bound: number;
}

export const SDF_BAND = 4;
/** Texels per cell: half-cell texels keep the wall's position (Bouzidi's q) sharp. */
export const SDF_TEXELS_PER_CELL = 2;
const MAX_TEXELS = 4_000_000;

/**
 * Bake an outline (local coordinates in cells): one polygon, or several rings filled
 * even-odd (a ring inside another is a hole).
 */
export function bakeSdf(outline: Poly | Rings, band = SDF_BAND): SdfGrid {
  const rings: Rings =
    outline.length && Array.isArray(outline[0])
      ? (outline as Rings)
      : [outline as Poly];
  const b = bboxRings(rings);
  const margin = band + 2;
  let texel = 1 / SDF_TEXELS_PER_CELL;
  let w = Math.ceil((b.x1 - b.x0 + 2 * margin) / texel) + 1;
  let h = Math.ceil((b.y1 - b.y0 + 2 * margin) / texel) + 1;
  while (w * h > MAX_TEXELS) {
    texel *= 1.5;
    w = Math.ceil((b.x1 - b.x0 + 2 * margin) / texel) + 1;
    h = Math.ceil((b.y1 - b.y0 + 2 * margin) / texel) + 1;
  }
  const ox = b.x0 - margin;
  const oy = b.y0 - margin;
  const data = new Float32Array(w * h).fill(band);

  // Exact distance near each edge: visit only the texels within `band` of it.
  for (const poly of rings) {
    const n = poly.length / 2;
    for (let e = 0; e < n; e++) {
      const ax = poly[2 * e];
      const ay = poly[2 * e + 1];
      const bx = poly[2 * ((e + 1) % n)];
      const by = poly[2 * ((e + 1) % n) + 1];
      const i0 = Math.max(
        0,
        Math.floor((Math.min(ax, bx) - band - ox) / texel),
      );
      const i1 = Math.min(
        w - 1,
        Math.ceil((Math.max(ax, bx) + band - ox) / texel),
      );
      const j0 = Math.max(
        0,
        Math.floor((Math.min(ay, by) - band - oy) / texel),
      );
      const j1 = Math.min(
        h - 1,
        Math.ceil((Math.max(ay, by) + band - oy) / texel),
      );
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * texel;
        for (let i = i0; i <= i1; i++) {
          const x = ox + i * texel;
          let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = x - (ax + t * dx);
          const ey = y - (ay + t * dy);
          const d = Math.sqrt(ex * ex + ey * ey);
          const k = j * w + i;
          if (d < data[k]) data[k] = d;
        }
      }
    }
  }

  // Sign: an even-odd scanline fill, row by row.
  const xs: number[] = [];
  for (let j = 0; j < h; j++) {
    const y = oy + j * texel;
    xs.length = 0;
    for (const poly of rings) {
      const n = poly.length / 2;
      for (let e = 0; e < n; e++) {
        const ay = poly[2 * e + 1];
        const by = poly[2 * ((e + 1) % n) + 1];
        if (ay > y !== by > y) {
          const ax = poly[2 * e];
          const bx = poly[2 * ((e + 1) % n)];
          xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
      }
    }
    xs.sort((a, c) => a - c);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - ox) / texel));
      const i1 = Math.min(w - 1, Math.floor((xs[s + 1] - ox) / texel));
      for (let i = i0; i <= i1; i++) data[j * w + i] = -data[j * w + i];
    }
  }

  let bound = 0;
  for (const poly of rings)
    for (let i = 0; i < poly.length; i += 2)
      bound = Math.max(bound, Math.hypot(poly[i], poly[i + 1]));
  return { data, w, h, ox, oy, texel, band, bound: bound + 1 };
}

/** Bilinear sample (as the GPU does); +band outside the grid. */
export function sampleSdf(g: SdfGrid, x: number, y: number): number {
  const u = (x - g.ox) / g.texel;
  const v = (y - g.oy) / g.texel;
  if (u < 0 || v < 0 || u > g.w - 1 || v > g.h - 1) return g.band;
  const i = Math.min(g.w - 2, Math.floor(u));
  const j = Math.min(g.h - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const a = g.data[j * g.w + i];
  const b = g.data[j * g.w + i + 1];
  const c = g.data[(j + 1) * g.w + i];
  const d = g.data[(j + 1) * g.w + i + 1];
  return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
}
