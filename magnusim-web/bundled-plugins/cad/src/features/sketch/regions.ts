// Profile regions of a sketch: the kernel's sketch_regions answer unpacked
// into SketchRegion (each with its shading triangles), and the point tests the
// region picking and the profile resolution use. Pure functions.
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import type { KernelRegion } from '../../types/kernel-protocol';
import type { SketchRegion } from '../../types/sketch';

/**
 * Regions from sketch_regions' result and buffers (tri_uv f32 u,v pairs,
 * tri_idx u32, tri_ranges u32 [start, count] per region). Each region gets the
 * shared uv array and its own index slice. A region with no triangles keeps
 * empty ones (it is still a profile; it just cannot be shaded or clicked).
 */
export function unpackRegions(regions: readonly KernelRegion[], buffers: Record<string, ArrayBuffer | undefined>): SketchRegion[] {
  const uv = buffers.tri_uv ? new Float32Array(buffers.tri_uv) : new Float32Array(0);
  const idx = buffers.tri_idx ? new Uint32Array(buffers.tri_idx) : new Uint32Array(0);
  const ranges = buffers.tri_ranges ? new Uint32Array(buffers.tri_ranges) : new Uint32Array(0);
  return regions.map((r, i) => {
    const start = ranges[2 * i] ?? 0;
    const count = ranges[2 * i + 1] ?? 0;
    const ok = start + count <= idx.length && count % 3 === 0;
    return { ...r, tri: { uv, idx: ok ? idx.slice(start, start + count) : new Uint32Array(0) } };
  });
}

/** Whether point p lies in triangle (a, b, c) (edges included, within a tiny tolerance). */
function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const scale = Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), Math.abs(c[0]), Math.abs(c[1]), 1);
  const eps = 1e-12 * scale * scale;
  const neg = d1 < -eps || d2 < -eps || d3 < -eps;
  const pos = d1 > eps || d2 > eps || d3 > eps;
  return !(neg && pos);
}

/** Whether a sketch point (u/v, mm) lies inside a region (on its shading triangles; its bounding box first). */
export function regionContains(r: Pick<SketchRegion, 'bbox' | 'tri'>, p: Vec2): boolean {
  const [u0, v0, u1, v1] = r.bbox;
  const pad = 1e-9 * Math.max(1, u1 - u0, v1 - v0);
  if (p[0] < u0 - pad || p[0] > u1 + pad || p[1] < v0 - pad || p[1] > v1 + pad) return false;
  const { uv, idx } = r.tri;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a: Vec2 = [uv[2 * idx[i]], uv[2 * idx[i] + 1]];
    const b: Vec2 = [uv[2 * idx[i + 1]], uv[2 * idx[i + 1] + 1]];
    const c: Vec2 = [uv[2 * idx[i + 2]], uv[2 * idx[i + 2] + 1]];
    if (inTriangle(p, a, b, c)) return true;
  }
  return false;
}

/**
 * The region under a sketch point. Regions do not overlap (the kernel splits
 * the plane by every curve), so the first that contains it; the smallest when
 * a point on a shared boundary lies in two.
 */
export function regionAt<R extends Pick<SketchRegion, 'bbox' | 'tri' | 'area'>>(regions: readonly R[], p: Vec2): R | null {
  let best: R | null = null;
  for (const r of regions) if (regionContains(r, p) && (!best || r.area < best.area)) best = r;
  return best;
}
