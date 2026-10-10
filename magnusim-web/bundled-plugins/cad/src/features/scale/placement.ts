// Where the banana goes when it is added (ux010, the brief): on the ground beside the geometry.
// Its underside at the bodies' lowest Z, just to the +X side of their box with a gap of 10 % of
// the box's largest size (at least 20 mm), its long axis along Y, centred on the box in Y. With
// no body, at the origin. Pure maths (unit-tested).
// Owner: TOOLBAR builder (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ScaleModelPlace, Vec3 } from '../../types/doc';
import type { BBox } from '../../types/kernel-protocol';

/** The smallest gap between the bodies and the banana (mm). */
export const MIN_GAP = 20;
/** The gap as a share of the bodies' largest size. */
export const GAP_SHARE = 0.1;

/** The box around boxes ([xmin, ymin, zmin, xmax, ymax, zmax]), or null for none. */
export function unionBox(boxes: readonly BBox[]): BBox | null {
  const ok = boxes.filter((b) => b && b.length === 6 && b.every((v) => Number.isFinite(v)) && b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5]);
  if (!ok.length) return null;
  const u: BBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of ok) for (let a = 0; a < 3; a++) (u[a] = Math.min(u[a], b[a])), (u[a + 3] = Math.max(u[a + 3], b[a + 3]));
  return u;
}

/** The gap between the bodies' box and the banana (mm). */
export function gapFor(box: BBox): number {
  return Math.max(MIN_GAP, GAP_SHARE * Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]));
}

/**
 * The banana's place beside `boxes` (the shown bodies' boxes). `mesh` is the banana's own box as
 * it lies unturned (min, max; underside at z 0). Rotation 0: its long axis along Y.
 */
export function placeBeside(boxes: readonly BBox[], mesh: { min: Vec3; max: Vec3 }): ScaleModelPlace {
  const u = unionBox(boxes);
  if (!u) return { at: [0, 0, 0], rot: 0 };
  const gap = gapFor(u);
  return { at: [u[3] + gap - mesh.min[0], (u[1] + u[4]) / 2 - (mesh.min[1] + mesh.max[1]) / 2, u[2] - mesh.min[2]], rot: 0 };
}

/** The banana's box in model mm where it lies (`place`), turned `place.rot` degrees about +Z. */
export function placedBox(place: ScaleModelPlace, mesh: { min: Vec3; max: Vec3 }): BBox {
  const r = (place.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const out: BBox = [Infinity, Infinity, place.at[2] + mesh.min[2], -Infinity, -Infinity, place.at[2] + mesh.max[2]];
  for (const x of [mesh.min[0], mesh.max[0]])
    for (const y of [mesh.min[1], mesh.max[1]]) {
      const px = place.at[0] + c * x - s * y;
      const py = place.at[1] + s * x + c * y;
      out[0] = Math.min(out[0], px);
      out[1] = Math.min(out[1], py);
      out[3] = Math.max(out[3], px);
      out[4] = Math.max(out[4], py);
    }
  return out;
}

// ---------------------------------------------------------------- dragging it (Daniel: "it can be
// very hard to position it correctly ... it doesn't get dragged super far away from the part")

/** The leash's least reach beyond the bodies' box (mm). */
export const LEASH_MIN = 300;

/** How far beyond the bodies' box (or the origin, with none) the banana's centre may go: max(the box's diagonal, 300 mm). */
export function leashOf(box: BBox | null): number {
  if (!box) return LEASH_MIN;
  return Math.max(LEASH_MIN, Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]));
}

/**
 * The centre (x, y) kept on the leash: within `reach` of the rectangle [x0, y0, x1, y1] (in the
 * plane); beyond it, the nearest point at that distance (so a drag past the limit slides along it).
 */
export function onLeash(c: [number, number], rect: [number, number, number, number], reach: number): [number, number] {
  const px = Math.min(Math.max(c[0], rect[0]), rect[2]);
  const py = Math.min(Math.max(c[1], rect[1]), rect[3]);
  const dx = c[0] - px;
  const dy = c[1] - py;
  const d = Math.hypot(dx, dy);
  if (d <= reach) return c;
  return [px + (dx * reach) / d, py + (dy * reach) / d];
}

/** The banana's half extents in x and y as it lies turned `rot` degrees (its centre is its origin). */
export function halfFootprint(mesh: { min: Vec3; max: Vec3 }, rot: number): [number, number] {
  const b = placedBox({ at: [0, 0, 0], rot }, mesh);
  return [(b[3] - b[0]) / 2, (b[4] - b[1]) / 2];
}

export interface Slot {
  /** "+x centre", "+x min", "-y max", ...: the side of the box and where along it. */
  name: string;
  at: [number, number];
}

/**
 * The magnet slots: on each of the box's four sides, the banana at the placement gap from it,
 * centred on that side or aligned with either end of it (12 in all).
 */
export function slotsAround(box: BBox, half: [number, number]): Slot[] {
  const g = gapFor(box);
  const [hx, hy] = half;
  const midX = (box[0] + box[3]) / 2;
  const midY = (box[1] + box[4]) / 2;
  const alongY: [string, number][] = [
    ['centre', midY],
    ['min', box[1] + hy],
    ['max', box[4] - hy],
  ];
  const alongX: [string, number][] = [
    ['centre', midX],
    ['min', box[0] + hx],
    ['max', box[3] - hx],
  ];
  const out: Slot[] = [];
  for (const [n, y] of alongY) {
    out.push({ name: `+x ${n}`, at: [box[3] + g + hx, y] });
    out.push({ name: `-x ${n}`, at: [box[0] - g - hx, y] });
  }
  for (const [n, x] of alongX) {
    out.push({ name: `+y ${n}`, at: [x, box[4] + g + hy] });
    out.push({ name: `-y ${n}`, at: [x, box[1] - g - hy] });
  }
  return out;
}

/** The slot nearest a centre (after a turn: where the banana goes, beside the part). */
export function nearestSlot(slots: readonly Slot[], c: [number, number]): Slot | null {
  let best: Slot | null = null;
  let bd = Infinity;
  for (const s of slots) {
    const d = Math.hypot(s.at[0] - c[0], s.at[1] - c[1]);
    if (d < bd) (bd = d), (best = s);
  }
  return best;
}

/**
 * The leash in 3D: the point `c` kept within `reach` of the box (the bodies' box; a point box at
 * the origin with none); beyond it, the nearest point at that distance (a drag past the limit
 * slides along it).
 */
export function onLeash3(c: Vec3, box: BBox, reach: number): Vec3 {
  const q: Vec3 = [0, 1, 2].map((a) => Math.min(Math.max(c[a], box[a]), box[a + 3])) as Vec3;
  const d = Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]);
  if (d <= reach) return c;
  return [0, 1, 2].map((a) => q[a] + ((c[a] - q[a]) * reach) / d) as Vec3;
}

/** Where a ray meets the plane through `p` with normal `n`, or null when it runs along it. */
export function rayOnPlane(ray: { origin: Vec3; dir: Vec3 }, p: Vec3, n: Vec3): Vec3 | null {
  const den = ray.dir[0] * n[0] + ray.dir[1] * n[1] + ray.dir[2] * n[2];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p[0] - ray.origin[0]) * n[0] + (p[1] - ray.origin[1]) * n[1] + (p[2] - ray.origin[2]) * n[2]) / den;
  return [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1], ray.origin[2] + t * ray.dir[2]];
}
