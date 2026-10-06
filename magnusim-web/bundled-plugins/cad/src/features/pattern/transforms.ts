// The copies of a pattern or a mirror: their keys, words and rigid transforms (pure math,
// no kernel). A transform is a 3x4 row-major matrix [r00 r01 r02 tx r10 r11 r12 ty r20 r21
// r22 tz] (the kernel's `copies` takes it as it is): a rotation, or a reflection for a mirror.
// Keys (the names and `skip` use them; the user's numbering, the original is instance 1):
//   linear, one direction     "2".."N" along it, "-2".."-N" on the other side (symmetric)
//   linear, two directions    "i.j" (i along direction 1, j along direction 2), "1.1" the original
//   circular                  "2".."N", "-2".."-N" (symmetric)
//   mirror                    "m"
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec3 } from '../../types/doc';

export type Mat = number[];

/** One copy: its key, its words ("Instance 3", "Instance 3, 2", "Instance −2", "Mirror copy") and its transform. */
export interface PatternCopy {
  key: string;
  label: string;
  matrix: Mat;
}

/** At most this many copies in one pattern (a typing slip of 10000 would stall the kernel). */
export const MAX_COPIES = 500;

export const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export function unitOf(v: Vec3): Vec3 | null {
  const l = len(v);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

export function translation(v: Vec3): Mat {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2]];
}

/** Rotation by `deg` about the line through `origin` along `dir` (right hand). */
export function rotation(origin: Vec3, dir: Vec3, deg: number): Mat {
  const k = unitOf(dir);
  if (!k) throw new Error('the axis has no direction');
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  const [x, y, z] = k;
  const R = [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
  // p' = R (p - o) + o
  const tr = [0, 1, 2].map((i) => origin[i] - (R[i][0] * origin[0] + R[i][1] * origin[1] + R[i][2] * origin[2]));
  return [R[0][0], R[0][1], R[0][2], tr[0], R[1][0], R[1][1], R[1][2], tr[1], R[2][0], R[2][1], R[2][2], tr[2]];
}

/** Reflection in the plane through `origin` with normal `normal`: p' = p - 2 ((p - o) . n) n. */
export function reflection(origin: Vec3, normal: Vec3): Mat {
  const n = unitOf(normal);
  if (!n) throw new Error('the plane has no normal');
  const d = dot(origin, n);
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * n[i] * n[j]));
  return [R[0][0], R[0][1], R[0][2], 2 * d * n[0], R[1][0], R[1][1], R[1][2], 2 * d * n[1], R[2][0], R[2][1], R[2][2], 2 * d * n[2]];
}

/** a after b (b first). */
export function compose(a: Mat, b: Mat): Mat {
  const out: Mat = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[4 * i + j] = a[4 * i] * b[j] + a[4 * i + 1] * b[4 + j] + a[4 * i + 2] * b[8 + j];
    out[4 * i + 3] = a[4 * i] * b[3] + a[4 * i + 1] * b[7] + a[4 * i + 2] * b[11] + a[4 * i + 3];
  }
  return out;
}

export function applyPoint(m: Mat, p: Vec3): Vec3 {
  return [0, 1, 2].map((i) => m[4 * i] * p[0] + m[4 * i + 1] * p[1] + m[4 * i + 2] * p[2] + m[4 * i + 3]) as Vec3;
}

/** The determinant of the rotation part (+1 a turn or a move, -1 a mirror). */
export function handedness(m: Mat): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Indices along one direction, the original (1) first: 1..count, then -2..-count when symmetric. */
function steps(count: number, symmetric: boolean): number[] {
  const out: number[] = [];
  for (let i = 1; i <= count; i++) out.push(i);
  if (symmetric) for (let i = 2; i <= count; i++) out.push(-i);
  return out;
}

/** How far instance number n (1 = the original, -2 the first on the other side) is from the original, in steps. */
const offsetOf = (n: number) => (n > 0 ? n - 1 : n + 1);

const minus = (n: number) => (n < 0 ? `−${-n}` : String(n));

export interface LinearDir {
  /** Unit direction (flip applied). */
  dir: Vec3;
  /** Distance between neighbours (mm, > 0). */
  step: number;
  /** Instances along it, the original included (per side when symmetric). */
  count: number;
  symmetric: boolean;
}

/** The step between neighbours from the panel's values: spacing as it is, extent shared by count - 1 gaps. */
export function stepOf(mode: 'spacing' | 'extent', distance: number, count: number): number {
  return mode === 'spacing' ? distance : count > 1 ? distance / (count - 1) : 0;
}

/** Every copy of a linear pattern (the original left out), in order. */
export function linearCopies(d1: LinearDir, d2: LinearDir | null): PatternCopy[] {
  const out: PatternCopy[] = [];
  const is = steps(d1.count, d1.symmetric);
  const js = d2 ? steps(d2.count, d2.symmetric) : [null];
  for (const j of js)
    for (const i of is) {
      if (i === 1 && (j === null || j === 1)) continue;
      const a = offsetOf(i) * d1.step;
      const b = j === null || !d2 ? 0 : offsetOf(j) * d2.step;
      const v: Vec3 = [0, 1, 2].map((k) => a * d1.dir[k] + (d2 ? b * d2.dir[k] : 0)) as Vec3;
      // A copy on direction 1's own row (j = 1) keeps direction 1's key ("3", not "3.1"): adding or
      // removing direction 2 then leaves its names, its skip and its body id as they were (fix round 1).
      out.push({ key: j === null || j === 1 ? String(i) : `${i}.${j}`, label: j === null ? `Instance ${minus(i)}` : `Instance ${minus(i)}, ${minus(j)}`, matrix: translation(v) });
    }
  return out;
}

export interface CircularSpec {
  origin: Vec3;
  /** Unit axis (flip applied); copies turn about it by the right hand. */
  dir: Vec3;
  count: number;
  mode: 'full' | 'angle';
  /** 'angle': from the original to the last copy (degrees). */
  angle: number;
  symmetric: boolean;
}

/**
 * Whether an Angle spread is a whole turn (360°, one side): it is then spread as Full 360° is, evenly,
 * since "first to last" over 360° would put the last copy on the original (fix round 1, B1).
 */
export function wholeTurn(c: Pick<CircularSpec, 'mode' | 'angle' | 'symmetric'>): boolean {
  return c.mode === 'angle' && !c.symmetric && c.angle >= 360 - 1e-9;
}

/** The angle between neighbours (degrees). */
export function circularStep(c: Pick<CircularSpec, 'count' | 'mode' | 'angle'> & { symmetric?: boolean }): number {
  if (c.mode === 'full' || wholeTurn({ mode: c.mode, angle: c.angle, symmetric: !!c.symmetric })) return 360 / Math.max(1, c.count);
  return c.count > 1 ? c.angle / (c.count - 1) : 0;
}

/** Every copy of a circular pattern (the original left out), in order, with its turn (degrees). */
export function circularCopies(c: CircularSpec): (PatternCopy & { turn: number })[] {
  const step = circularStep(c);
  return steps(c.count, c.mode === 'angle' && c.symmetric)
    .filter((n) => n !== 1)
    .map((n) => ({ key: String(n), label: `Instance ${minus(n)}`, turn: offsetOf(n) * step, matrix: rotation(c.origin, c.dir, offsetOf(n) * step) }));
}

/**
 * Two instances of a circular pattern at the same place (a whole turn apart): the later one's words and
 * the one it lands on ("the original" or "Instance 2"), or null. A symmetric spread of more than 180° per
 * side wraps the two sides onto each other.
 */
export function landsOn(copies: readonly { label: string; turn: number }[]): { copy: string; on: string } | null {
  const at = (deg: number) => {
    const a = ((deg % 360) + 360) % 360;
    return a > 360 - 1e-7 ? 0 : a;
  };
  const seen: { label: string; a: number }[] = [{ label: 'the original', a: 0 }];
  for (const c of copies) {
    const a = at(c.turn);
    const hit = seen.find((x) => Math.abs(x.a - a) < 1e-7 || Math.abs(Math.abs(x.a - a) - 360) < 1e-7);
    if (hit) return { copy: c.label, on: hit.label };
    seen.push({ label: c.label, a });
  }
  return null;
}

/** The mirror's one copy. */
export function mirrorCopies(origin: Vec3, normal: Vec3): PatternCopy[] {
  return [{ key: 'm', label: 'Mirror copy', matrix: reflection(origin, normal) }];
}

/** Every copy a pattern of these copies would have, the skipped ones marked. */
export function withSkips(copies: PatternCopy[], skip: readonly string[]): (PatternCopy & { skipped: boolean })[] {
  const s = new Set(skip);
  return copies.map((c) => ({ ...c, skipped: s.has(c.key) }));
}

/** Two directions along the same line (copies would land on each other). */
export function parallel(a: Vec3, b: Vec3): boolean {
  const ua = unitOf(a);
  const ub = unitOf(b);
  return !!ua && !!ub && Math.abs(Math.abs(dot(ua, ub)) - 1) < 1e-9;
}
