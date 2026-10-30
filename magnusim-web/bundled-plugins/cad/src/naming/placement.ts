// Where a body is against where it was made: the turns and moves of every Move/copy body since
// (one rigid 3x4 row-major matrix, as the kernel's `copies` takes it). A body no Move has moved has
// none (null). The rebuild keeps it on each body (BuiltBody / BodyInfo .placement); a stored
// reference keeps its body's placement from when it was made (PersistentRef.placement). Resolving
// it maps what was stored by `now x then^-1` first, so a reference made before or after a Move, or
// across an edit of one, compares like with like: a turned face is still the same kind of face,
// the nearest of several candidates is the nearest where the body is now, and a sketch on a moved
// face moves with it (features/sketch/plane.ts placedFaceFrame).
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneFrame, RefSignature, Vec3 } from '../types/doc';

/** A rigid placement: [r00 r01 r02 tx r10 r11 r12 ty r20 r21 r22 tz]. */
export type Placement = readonly number[];

const IDENTITY: Placement = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** No placement, or one that moves nothing. */
export function isIdentity(m: Placement | null | undefined): boolean {
  return !m || m.length !== 12 || m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);
}

/** The placement to keep: null for none (identity), else a plain copy. */
export function keptPlacement(m: Placement | null | undefined): number[] | null {
  return isIdentity(m) ? null : [...m!];
}

/** a after b (b first); null stands for none. */
export function composePlacement(a: Placement | null | undefined, b: Placement | null | undefined): number[] | null {
  if (isIdentity(a)) return keptPlacement(b);
  if (isIdentity(b)) return keptPlacement(a);
  const A = a!;
  const B = b!;
  const out: number[] = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[4 * i + j] = A[4 * i] * B[j] + A[4 * i + 1] * B[4 + j] + A[4 * i + 2] * B[8 + j];
    out[4 * i + 3] = A[4 * i] * B[3] + A[4 * i + 1] * B[7] + A[4 * i + 2] * B[11] + A[4 * i + 3];
  }
  return keptPlacement(out);
}

/** The inverse of a rigid placement (its rotation transposed). */
export function invertPlacement(m: Placement | null | undefined): number[] | null {
  if (isIdentity(m)) return null;
  const M = m!;
  const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
  const t = [M[3], M[7], M[11]];
  const it = [0, 1, 2].map((i) => -(R[3 * i] * t[0] + R[3 * i + 1] * t[1] + R[3 * i + 2] * t[2]));
  return [R[0], R[1], R[2], it[0], R[3], R[4], R[5], it[1], R[6], R[7], R[8], it[2]];
}

/** What took a body from where it was (`then`) to where it is (`now`): now x then^-1, null when nothing. */
export function motionBetween(now: Placement | null | undefined, then: Placement | null | undefined): number[] | null {
  return composePlacement(now, invertPlacement(then));
}

export function mapPoint(m: Placement, p: readonly number[]): Vec3 {
  return [0, 1, 2].map((i) => m[4 * i] * p[0] + m[4 * i + 1] * p[1] + m[4 * i + 2] * p[2] + m[4 * i + 3]) as Vec3;
}

export function mapDir(m: Placement, d: readonly number[]): Vec3 {
  return [0, 1, 2].map((i) => m[4 * i] * d[0] + m[4 * i + 1] * d[1] + m[4 * i + 2] * d[2]) as Vec3;
}

/** A signature where the motion takes it (sizes and radii stay; a box becomes the box of its turned corners). */
export function mapSignature(m: Placement, s: RefSignature): RefSignature {
  let bbox = s.bbox ?? null;
  if (bbox) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [bbox[0], bbox[3]])
      for (const y of [bbox[1], bbox[4]])
        for (const z of [bbox[2], bbox[5]]) {
          const p = mapPoint(m, [x, y, z]);
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], p[k]);
            hi[k] = Math.max(hi[k], p[k]);
          }
        }
    bbox = [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
  }
  return { ...s, at: mapPoint(m, s.at), ...(s.dir ? { dir: mapDir(m, s.dir) } : {}), ...(s.bbox !== undefined ? { bbox } : {}) };
}

/** A plane frame where the motion takes it. */
export function mapFrame(m: Placement, f: PlaneFrame): PlaneFrame {
  return { origin: mapPoint(m, f.origin), normal: mapDir(m, f.normal), xdir: mapDir(m, f.xdir) };
}
