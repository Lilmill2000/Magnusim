// A body's placement (src/naming/placement.ts): where Move/copy body features took it since it was
// made. Composition and inverse; a reference made with a placement compares where the body is now
// (a face turned by a Move is still the same kind of face, and the nearest of several candidates is
// the one nearest where it was on the body); a sketch frame on a moved face moves with it.
// Owner: DOC-CORE (naming layer).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { faceFrame, placedFaceFrame } from '../../src/features/sketch/plane';
import { resolveFace } from '../../src/naming';
import { composePlacement, invertPlacement, isIdentity, mapPoint, motionBetween } from '../../src/naming/placement';
import type { PersistentRef, Vec3 } from '../../src/types/doc';
import type { NamingLookup } from '../../src/types/naming';
import type { TopoResult } from '../../src/types/kernel-protocol';

type TopoFace = TopoResult['faces'][number];
const plane = (i: number, at: Vec3, normal: Vec3, area = 100): TopoFace => ({ i, type: 'plane', area, centroid: at, normal });
const lookupOf = (faces: TopoFace[]): NamingLookup => ({ faces: async (_s, idx) => (idx === 'all' ? faces : faces.filter((f) => idx.includes(f.i))) });
const r6 = (xs: readonly number[]) => xs.map((v) => Math.round(v * 1e6) / 1e6 + 0);
/** 90 deg about Z through the origin, then (tx, ty, tz). */
const turnZ = (tx = 0, ty = 0, tz = 0) => [0, -1, 0, tx, 1, 0, 0, ty, 0, 0, 1, tz];
const shift = (tx: number, ty = 0, tz = 0) => [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz];

describe('placement math', () => {
  it('none is identity; composition applies the right one first; the inverse undoes it; the motion between two is null when they are the same', () => {
    expect(isIdentity(null)).toBe(true);
    expect(isIdentity(shift(0))).toBe(true);
    expect(composePlacement(null, null)).toBeNull();
    const m = composePlacement(shift(5), turnZ())!;
    expect(r6(mapPoint(m, [1, 0, 0]))).toEqual([5, 1, 0]);
    expect(r6(mapPoint(invertPlacement(m)!, [5, 1, 0]))).toEqual([1, 0, 0]);
    expect(composePlacement(m, invertPlacement(m))).toBeNull();
    expect(motionBetween(m, m)).toBeNull();
    expect(r6(motionBetween(shift(50), shift(20))!)).toEqual(shift(30));
  });
});

describe('a reference made on a moved body', () => {
  const ref = (placement?: number[]): PersistentRef => ({ name: 'A', signature: { kind: 'face', type: 'plane', at: [10, 0, 5], dir: [1, 0, 0], size: 100 }, ...(placement ? { placement } : {}) });

  it('a face turned 90 deg by a Move made (or edited) after it resolves by name with no repair; without the placement it read repaired', async () => {
    // The face was picked with the body unmoved; a Move turned the body 90 deg about Z: its normal is +Y now.
    const lookup = lookupOf([plane(0, [0, 10, 5], [0, 1, 0])]);
    const now = await resolveFace({ ref: ref(), shape: 1, names: { faces: ['A'] }, lookup, placement: turnZ() });
    expect(now).toMatchObject({ ok: true, index: 0, how: 'name' });
    expect(await resolveFace({ ref: ref(), shape: 1, names: { faces: ['A'] }, lookup, placement: null })).toMatchObject({ how: 'moved', warning: 'Reference repaired · check' });
    // Picked after a turn (it keeps it), then the turn is taken out: back where the body was made.
    const back = await resolveFace({ ref: { ...ref(turnZ()), signature: { kind: 'face', type: 'plane', at: [0, 10, 5], dir: [0, 1, 0], size: 100 } }, shape: 1, names: { faces: ['A'] }, lookup: lookupOf([plane(0, [10, 0, 5], [1, 0, 0])]), placement: null });
    expect(back).toMatchObject({ ok: true, how: 'name' });
  });

  it('of a face split in two, the part nearest where it was on the body is taken after a long move (not the one nearest the old place)', async () => {
    // Picked at x = 10 on the body; the body moved 100 along X; its pieces are at x 104 and x 110.
    const lookup = lookupOf([plane(0, [104, 0, 5], [1, 0, 0]), plane(1, [110, 0, 5], [1, 0, 0])]);
    const r = await resolveFace({ ref: ref(), shape: 1, names: { faces: ['A#0', 'A#1'] }, lookup, placement: shift(100) });
    expect(r).toMatchObject({ ok: true, index: 1 });
  });
});

describe('a sketch frame on a moved face', () => {
  it('with no motion it is faceFrame; slid and turned about the face normal, the frame goes along (faceFrame alone stays on the model axes)', () => {
    const n: Vec3 = [0, 0, 1];
    expect(placedFaceFrame(n, [3, 4, 10], null)).toEqual(faceFrame(n, [3, 4, 10]));
    // Picked with the body unmoved (frame: origin (0, 0, 10), u along X); the body then turned 90 about Z and moved 50 along X.
    const m = turnZ(50);
    const f = placedFaceFrame(n, mapPoint(m, [3, 4, 10]), m);
    expect(r6(f.origin)).toEqual([50, 0, 10]);
    expect(r6(f.xdir)).toEqual([0, 1, 0]);
    expect(r6(f.normal)).toEqual([0, 0, 1]);
    expect(r6(faceFrame(n, mapPoint(m, [3, 4, 10])).xdir)).toEqual([1, 0, 0]);
  });
});
