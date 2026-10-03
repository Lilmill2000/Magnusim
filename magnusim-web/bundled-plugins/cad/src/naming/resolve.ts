// Signatures and the resolution of stored references (proposal §4.5 point 4):
// by name, then by signature; the signature is checked on every name match.
// A name match whose face is still the same kind of face (type, and for planes
// and axes the direction within 1 degree) resolves cleanly whatever moved: an
// upstream dimension change moves faces, and that is not a repair. A name match
// whose kind changed, or a signature-only match, resolves with a warning
// ("Reference repaired · check"); nothing found is an error. Nothing is
// repaired silently, and nothing here writes the document (a caller re-anchors
// only on a user edit).
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { RefSignature, Vec3 } from '../types/doc';
import type { TopoResult } from '../types/kernel-protocol';
import type { RefResolution, ResolveInput } from '../types/naming';
import { splitMerged, splitSuffix } from './names';

type TopoFace = TopoResult['faces'][number];

/** A face's signature from topo (face_mass on; face_bbox exact or fast). */
export function faceSignature(f: TopoFace): RefSignature {
  return {
    kind: 'face',
    type: f.type,
    size: f.area,
    at: (f.centroid ?? [0, 0, 0]) as Vec3,
    dir: f.normal ?? f.axis?.dir ?? null,
    radius: f.radius ?? null,
    bbox: f.bbox ?? null,
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Angle between two directions in degrees (axes: sign ignored when `axis`). */
function angleDeg(a: Vec3, b: Vec3, axis: boolean): number {
  const la = len(a);
  const lb = len(b);
  if (!(la > 0) || !(lb > 0)) return 0;
  let c = dot(a, b) / (la * lb);
  if (axis) c = Math.abs(c);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Same kind of face: same surface type, and a plane's normal / an axis within `maxDeg`. */
export function sameKind(a: RefSignature, b: RefSignature, maxDeg = 1): boolean {
  if (a.kind !== b.kind || a.type !== b.type) return false;
  if (a.dir && b.dir) {
    const axis = a.type !== 'plane';
    if (angleDeg(a.dir, b.dir, axis) > maxDeg) return false;
  }
  return true;
}

/**
 * How far signature `b` is from `a` (0 = identical; Infinity = another kind).
 * Position over the part's size, plus direction (degrees / 10), plus relative
 * size and radius differences.
 */
export function signatureDistance(a: RefSignature, b: RefSignature, scale: number): number {
  if (a.kind !== b.kind || a.type !== b.type) return Infinity;
  const s = Math.max(scale, 1e-9);
  let d = dist(a.at, b.at) / s;
  if (a.dir && b.dir) d += angleDeg(a.dir, b.dir, a.type !== 'plane') / 10;
  if (a.size != null && b.size != null) d += Math.abs(a.size - b.size) / Math.max(Math.abs(a.size), Math.abs(b.size), 1e-12);
  if (a.radius != null && b.radius != null) d += Math.abs(a.radius - b.radius) / Math.max(a.radius, b.radius, 1e-12);
  return d;
}

/** The part's size for signature distances: the diagonal of the faces' boxes, or of their centroids. */
function sizeOf(faces: readonly TopoFace[]): number {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of faces) {
    const pts: Vec3[] = f.bbox ? [[f.bbox[0], f.bbox[1], f.bbox[2]], [f.bbox[3], f.bbox[4], f.bbox[5]]] : f.centroid ? [f.centroid] : [];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const d = dist(lo, hi);
  return Number.isFinite(d) && d > 0 ? d : 1;
}

/** Faces whose name is the reference's, contains it (merged), or is it split (#k). */
export function nameCandidates(refName: string, faces: readonly string[]): number[] {
  const exact: number[] = [];
  const related: number[] = [];
  faces.forEach((n, i) => {
    if (n === refName) exact.push(i);
    else if (splitMerged(n).some((p) => p === refName || splitSuffix(p).base === refName)) related.push(i);
  });
  return exact.length ? exact : related;
}

const REPAIRED = 'Reference repaired · check';

/**
 * Resolve a stored face reference against a body. Asks the kernel (lookup) for
 * the topo of the name's candidates only; the signature search (no name
 * matched) asks for every face, which is slow on very large parts and happens
 * only when a name is lost.
 */
export async function resolveFace(input: ResolveInput): Promise<RefResolution> {
  const { ref, shape, names, lookup } = input;
  const candidates = nameCandidates(ref.name, names.faces);
  if (candidates.length) {
    const topo = await lookup.faces(shape, candidates);
    const sigs = topo.map((f) => ({ i: f.i, sig: faceSignature(f) }));
    const same = sigs.filter((s) => sameKind(ref.signature, s.sig));
    if (candidates.length === 1 && same.length === 1) return { ok: true, index: same[0].i, how: 'name', signature: same[0].sig };
    // Split, merged into another, or no longer the same kind: the nearest, with a warning.
    const pool = same.length ? same : sigs;
    const scale = sizeOf(topo);
    pool.sort((a, b) => signatureDistance(ref.signature, a.sig, scale) - signatureDistance(ref.signature, b.sig, scale));
    const best = pool[0];
    if (best && Number.isFinite(signatureDistance(ref.signature, best.sig, scale))) return { ok: true, index: best.i, how: 'moved', warning: REPAIRED, signature: best.sig };
  }
  // No name: the signature alone, accepted only when the runner-up is at least 50% worse.
  const all = await lookup.faces(shape, 'all');
  const scale = sizeOf(all);
  const scored = all
    .map((f) => ({ i: f.i, sig: faceSignature(f), d: signatureDistance(ref.signature, faceSignature(f), scale) }))
    .filter((s) => Number.isFinite(s.d))
    .sort((a, b) => a.d - b.d);
  if (scored.length && (scored.length === 1 || scored[1].d >= 1.5 * scored[0].d) && scored[0].d < 0.25) {
    return { ok: true, index: scored[0].i, how: 'signature', warning: REPAIRED, signature: scored[0].sig };
  }
  return { ok: false, message: 'Face not found after rebuild' };
}
