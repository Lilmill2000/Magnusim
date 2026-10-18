// What find tells of a face from data the page holds (CAD tools spec §5.7): a point on it, whether
// a round face is a hole or a boss, and the frame a sketch on a flat face gets. Pure: the
// tessellation and the kernel's topo come in.
//   point   the incentre of the face's triangle with the largest inscribed circle, moved onto the
//           face's plane (or cylinder) only when that moves it less than half that circle's radius
//   hole    a cylinder or cone face whose outward normals point toward its axis (a bore), boss when
//           they point away; only for faces that go at least half way round (a fillet is neither)
//   frame   faceFrame(normal, centroid): the model origin projected onto the face, u along model
//           X projected (model Y when X is within 1 degree of the normal), v = n x u
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { faceFrame, ydirOf } from '../../features/sketch/plane';
import type { PlaneFrame, Vec3 } from '../../types/doc';
import type { TessPayload } from '../../types/kernel';
import type { BBox, TopoResult } from '../../types/kernel-protocol';
import { frameWords } from '../model';
import { dir, vec } from '../numbers';

type TopoFace = TopoResult['faces'][number];

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: readonly number[], s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]): Vec3 => {
  const l = norm(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};
export const distance = (a: readonly number[], b: readonly number[]) => norm(sub(a, b));

/** The triangles of face `face` as corner index triples into `tess.positions`. */
function* triangles(tess: TessPayload, face: number): Generator<[number, number, number]> {
  const start = tess.faceRanges[2 * face];
  const count = tess.faceRanges[2 * face + 1];
  if (start === undefined || !count) return;
  for (let t = start; t + 2 < start + count; t += 3) yield [tess.indices[t], tess.indices[t + 1], tess.indices[t + 2]];
}

const point = (tess: TessPayload, i: number): Vec3 => [tess.positions[3 * i], tess.positions[3 * i + 1], tess.positions[3 * i + 2]];
const normal = (tess: TessPayload, i: number): Vec3 => [tess.normals[3 * i], tess.normals[3 * i + 1], tess.normals[3 * i + 2]];

/** The point of an axis nearest to p. */
function onAxis(axis: { origin: readonly number[]; dir: readonly number[] }, p: readonly number[]): Vec3 {
  const d = unit(axis.dir);
  return add(axis.origin, scale(d, dot(sub(p, axis.origin), d)));
}

/**
 * A point on face `face` (model mm): the incentre of its triangle with the largest inscribed circle,
 * moved onto the face's plane or cylinder when that moves it less than half that radius; the
 * centroid when the face has no triangles.
 */
export function pointOnFace(tess: TessPayload | null, face: number, topo: Pick<TopoFace, 'type' | 'normal' | 'centroid' | 'axis' | 'radius'>): Vec3 | null {
  let best: { p: Vec3; r: number } | null = null;
  if (tess) {
    for (const [i, j, k] of triangles(tess, face)) {
      const A = point(tess, i);
      const B = point(tess, j);
      const C = point(tess, k);
      const a = distance(B, C);
      const b = distance(A, C);
      const c = distance(A, B);
      const per = a + b + c;
      if (!(per > 0)) continue;
      const area = norm(cross(sub(B, A), sub(C, A))) / 2;
      const r = (2 * area) / per;
      if (best && r <= best.r) continue;
      best = { p: [(a * A[0] + b * B[0] + c * C[0]) / per, (a * A[1] + b * B[1] + c * C[1]) / per, (a * A[2] + b * B[2] + c * C[2]) / per], r };
    }
  }
  if (!best) return topo.centroid ? ([...topo.centroid] as Vec3) : null;
  let p = best.p;
  let moved: Vec3 | null = null;
  if (topo.type === 'plane' && topo.normal && topo.centroid) {
    const n = unit(topo.normal);
    moved = sub(p, scale(n, dot(sub(p, topo.centroid), n)));
  } else if (topo.type === 'cylinder' && topo.axis && topo.radius) {
    const q = onAxis(topo.axis, p);
    const radial = sub(p, q);
    if (norm(radial) > 0) moved = add(q, scale(unit(radial), topo.radius));
  }
  if (moved && distance(moved, p) < best.r / 2) p = moved;
  return p;
}

/**
 * Whether a cylinder or cone face is a hole (its outward normals point toward its axis), a boss
 * (away), or neither (it goes less than half way round its axis, or it has no triangles).
 */
export function holeOrBoss(tess: TessPayload | null, face: number, topo: Pick<TopoFace, 'type' | 'axis'>): 'hole' | 'boss' | null {
  if (!tess || (topo.type !== 'cylinder' && topo.type !== 'cone') || !topo.axis) return null;
  const axis = topo.axis;
  const k = unit(axis.dir);
  // A basis across the axis, for the angles the face spans.
  const seed: Vec3 = Math.abs(k[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(sub(seed, scale(k, dot(seed, k))));
  const e2 = cross(k, e1);
  let inward = 0;
  let outward = 0;
  const angles: number[] = [];
  const seen = new Set<number>();
  for (const tri of triangles(tess, face)) {
    for (const i of tri) {
      if (seen.has(i)) continue;
      seen.add(i);
      const p = point(tess, i);
      const radial = sub(p, onAxis(axis, p));
      if (norm(radial) < 1e-9) continue;
      const s = dot(normal(tess, i), radial);
      if (s < 0) inward++;
      else if (s > 0) outward++;
      angles.push(Math.atan2(dot(radial, e2), dot(radial, e1)));
    }
  }
  if (angles.length < 3) return null;
  angles.sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const span = 2 * Math.PI - gap;
  if (span < Math.PI - 1e-6) return null;
  if (inward === outward) return null;
  return inward > outward ? 'hole' : 'boss';
}

/** The frame a sketch on a flat face gets, in numbers and words. */
export function faceFrameRow(topo: Pick<TopoFace, 'type' | 'normal' | 'centroid'>): { origin_mm: number[]; u: number[]; v: number[]; normal: number[]; words: string } | null {
  if (topo.type !== 'plane' || !topo.normal || !topo.centroid) return null;
  const f: PlaneFrame = faceFrame(topo.normal as Vec3, topo.centroid as Vec3);
  return { origin_mm: vec(f.origin), u: dir(f.xdir), v: dir(ydirOf(f)), normal: dir(f.normal), words: frameWords(f) };
}

/** The distance from p to a box (0 inside it). */
export function boxDistance(b: BBox | null | undefined, p: readonly number[]): number {
  if (!b) return 0;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(b[k] - p[k], 0, p[k] - b[k + 3]);
    s += d * d;
  }
  return Math.sqrt(s);
}

/** The diagonal of a box (0 for none). */
export const boxDiagonal = (b: BBox | null | undefined) => (b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : 0);

/** The smallest box holding every box given (null for none). */
export function unionBox(boxes: readonly (BBox | null | undefined)[]): BBox | null {
  let out: BBox | null = null;
  for (const b of boxes) {
    if (!b) continue;
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.min(out[2], b[2]), Math.max(out[3], b[3]), Math.max(out[4], b[4]), Math.max(out[5], b[5])] : [...b];
  }
  return out;
}

export { add, cross, dot, norm, scale, sub, unit };
