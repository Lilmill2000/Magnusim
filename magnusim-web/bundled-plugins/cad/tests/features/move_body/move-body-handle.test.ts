// Move/copy body's drag handle, its math (src/features/move_body/handle-math.ts):
//   - an arrow dragged along its axis sets that Move field to what it had plus how far the pointer
//     went along it, rounded to what a pixel means (Ctrl: whole mm; in an inch Part 0.1 in);
//   - a ring dragged round reads the angle in its plane (right hand about its axis), counting past
//     half a turn; rounded to a pixel's step round the ring (Ctrl: 15 deg), in rad Parts too; a
//     ring about another of X, Y, Z than About turns About to it and starts from no turn;
//   - where the handle sits (the pivot after the move: the bodies' centre, a typed pivot, the
//     picked axis's point nearest the centre) and its rings (X, Y, Z, or the picked axis alone);
//   - what the view shows (the build's transform on its bodies or copies, else nothing moved) and
//     the preview's motion, target * shown^-1, a rigid motion that brings the shown bodies there.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { deriveBodyId } from '../../../src/doc/features/body-ids';
import { createUnitsService } from '../../../src/doc/units';
import { axisParamAt } from '../../../src/features/extrude/handle';
import { moveBodyDef, moveMatrix } from '../../../src/features/move_body/feature';
import {
  angleValue,
  basisOf,
  draggedFields,
  handleFrameOf,
  invertRigid,
  lengthValue,
  previewMatrix,
  ringPhase,
  sameMatrix,
  shownOf,
  snapLengthWords,
  turnLine,
  wrapPi,
} from '../../../src/features/move_body/handle-math';
import { inkOf } from '../../../src/features/move_body/handle';
import { applyPoint, compose, IDENTITY, rotation, translation } from '../../../src/features/pattern/transforms';
import { DARK, LIGHT } from '../../../src/viewport/palette';
import { emptyDoc } from '../../../src/doc/schema';
import type { MoveBodyFeature, Vec3 } from '../../../src/types/doc';
import type { DocState, MoveBodyOutput } from '../../../src/types/doc-service';
import type { DocUnits } from '../../../src/types/units';

const MM: DocUnits = { length: 'mm', angle: 'deg' };
const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

const units = (u: DocUnits = MM) => createUnitsService(() => u);

function feature(o: Partial<MoveBodyFeature> = {}): MoveBodyFeature {
  return { ...moveBodyDef.create(emptyDoc('metric'), {}), id: 'f_move', bodies: ['b_1'], ...o } as MoveBodyFeature;
}

/** A ray from 100 mm along `from` (from the point `at`) towards `at`. */
const rayTo = (at: Vec3, from: Vec3) => ({ origin: [at[0] + from[0] * 100, at[1] + from[1] * 100, at[2] + from[2] * 100] as Vec3, dir: [-from[0], -from[1], -from[2]] as Vec3 });

describe('an arrow: Move X, Y or Z', () => {
  it('the distance along its axis is the point of the axis nearest the pointer, less where it was taken', () => {
    const origin: Vec3 = [10, 5, 5];
    // Looking from above and a little to the side: the pointer at x = 22.5 on the X arrow's line.
    const view: Vec3 = [0.2, -0.3, 0.93];
    const grab = axisParamAt(origin, [1, 0, 0], rayTo([13, 5, 5], view))!;
    const at = axisParamAt(origin, [1, 0, 0], rayTo([22.5, 5, 5], view))!;
    expect(at - grab).toBeCloseTo(9.5, 9);
    // Dragged 9.5 mm from Move X 5: Move X 14.5, the other fields as they were.
    const f = feature({ move: ['5 mm', 'L / 2', '0 mm'] });
    const v0 = { move: [5, 7, 0] as Vec3, angle: 0, pivot: null };
    const r = draggedFields(f, v0, { part: 'x', mm: at - grab }, { pixelMm: 0.05, degPerPx: 1, units: MM, snap: false });
    expect(r.patch).toEqual({ move: ['14.5 mm', 'L / 2', '0 mm'] });
    expect(r.values.move).toEqual([14.5, 7, 0]);
    expect(r.shown).toEqual({ quantity: 'length', value: 14.5 });
  });

  it('rounded to what a pixel means at that zoom; Ctrl: whole mm (an inch Part: 0.1 in)', () => {
    expect(lengthValue(12.3456, 0.05, MM, false)).toEqual({ expr: '12.35 mm', mm: 12.35 });
    expect(lengthValue(12.3456, 0.5, MM, false)).toEqual({ expr: '12.3 mm', mm: 12.3 });
    expect(lengthValue(12.3456, 0.05, MM, true)).toEqual({ expr: '12 mm', mm: 12 });
    expect(lengthValue(-12.6, 0.05, MM, true)).toEqual({ expr: '-13 mm', mm: -13 });
    const inch: DocUnits = { length: 'in', angle: 'deg' };
    const r = lengthValue(25.4 * 1.234, 0.05, inch, true);
    expect(r.expr).toBe('1.2 in');
    expect(r.mm).toBeCloseTo(30.48, 9);
    expect(lengthValue(0.004, 0.05, MM, true)).toEqual({ expr: '0 mm', mm: 0 });
    expect(snapLengthWords('mm')).toBe('1 mm');
    expect(snapLengthWords('cm')).toBe('1 mm');
    expect(snapLengthWords('in')).toBe('0.1 in');
  });
});

describe('a ring: the Angle', () => {
  it('reads the angle round the pivot in its plane, right hand about its axis, from any side it is seen', () => {
    const o: Vec3 = [10, 5, 5];
    for (const axis of [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0.6, 0, 0.8]] as Vec3[]) {
      const { u, v } = basisOf(axis);
      expect(Math.abs(u[0] * axis[0] + u[1] * axis[1] + u[2] * axis[2])).toBeLessThan(1e-12);
      // v = axis x u: a turn by +90 takes u to v.
      const turned = applyPoint(rotation([0, 0, 0], axis, 90), u);
      expect(near(turned, v, 1e-12)).toBe(true);
      for (const deg of [0, 30, 135, -60]) {
        const t = (deg * Math.PI) / 180;
        const p: Vec3 = [0, 1, 2].map((i) => o[i] + 7 * (Math.cos(t) * u[i] + Math.sin(t) * v[i])) as Vec3;
        // Seen from the side the axis points to, and from the other side: the same angle.
        const side = [axis[0] + 0.3 * u[0], axis[1] + 0.3 * u[1], axis[2] + 0.3 * u[2]] as Vec3;
        expect(ringPhase(o, axis, rayTo(p, side))).toBeCloseTo(t, 9);
        expect(ringPhase(o, axis, rayTo(p, [-side[0], -side[1], -side[2]]))).toBeCloseTo(t, 9);
      }
    }
    // Seen edge on: no angle to read.
    expect(ringPhase(o, [0, 0, 1], rayTo([17, 5, 5], [0, 1, 0]))).toBeNull();
  });

  it('adds up the steps of a drag, so more than half a turn keeps counting', () => {
    let phase = 0;
    let turned = 0;
    for (let i = 1; i <= 12; i++) {
      const next = wrapPi(((i * 25) * Math.PI) / 180);
      turned += wrapPi(next - phase);
      phase = next;
    }
    expect((turned * 180) / Math.PI).toBeCloseTo(300, 9);
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(3 * Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
  });

  it("rounded to a pixel's step round the ring; Ctrl: 15 deg; a rad Part stores rad", () => {
    expect(angleValue(37.36, 1.43, MM, false)).toEqual({ expr: '37 deg', deg: 37 });
    expect(angleValue(37.36, 0.5, MM, false)).toEqual({ expr: '37.4 deg', deg: 37.4 });
    expect(angleValue(37.36, 1.43, MM, true)).toEqual({ expr: '30 deg', deg: 30 });
    expect(angleValue(-82, 1.43, MM, true)).toEqual({ expr: '-75 deg', deg: -75 });
    const rad: DocUnits = { length: 'mm', angle: 'rad' };
    const r = angleValue(90, 1.43, rad, true);
    expect(r.expr).toBe(`${Number((Math.PI / 2).toFixed(10))} rad`);
    expect(r.deg).toBeCloseTo(90, 6);
    expect(angleValue(37.36, 1.43, rad, false)).toEqual({ expr: '0.65 rad', deg: 0.65 * (180 / Math.PI) });
  });

  it('about the same axis as About it adds to the Angle; another of X, Y, Z turns About to it and starts from no turn', () => {
    const f = feature({ angle: '30 deg', about: 'z' });
    const v0 = { move: [0, 0, 0] as Vec3, angle: 30, pivot: null };
    const o = { pixelMm: 0.05, degPerPx: 1.43, units: MM, snap: false };
    expect(draggedFields(f, v0, { part: 'ring-z', deg: 14.8 }, o)).toMatchObject({ patch: { angle: '45 deg' }, about: 'z', values: { angle: 45 } });
    expect(draggedFields(f, v0, { part: 'ring-y', deg: 14.8 }, o)).toMatchObject({ patch: { angle: '15 deg', about: 'y' }, about: 'y', values: { angle: 15 } });
    expect(draggedFields(f, v0, { part: 'ring-x', deg: 52 }, { ...o, snap: true })).toMatchObject({ patch: { angle: '45 deg', about: 'x' }, shown: { quantity: 'angle', value: 45 } });
    const fa = feature({ about: 'axis', axis: { kind: 'origin', axis: 'origin:x' } });
    expect(draggedFields(fa, { ...v0, angle: 0 }, { part: 'ring-axis', deg: -20 }, o).patch).toEqual({ angle: '-20 deg' });
  });
});

describe('where the handle is', () => {
  const boxes = [{ id: 'b_1', bbox: [0, 0, 0, 20, 10, 10] }];
  it("at the pivot after the move: the bodies' centre, or the typed pivot; rings about X, Y and Z", () => {
    const u = units();
    const fr = handleFrameOf(feature({ move: ['5 mm', '0 mm', '1 mm'] }), null, boxes, u, null)!;
    expect(fr.pivot).toEqual([10, 5, 5]);
    expect(fr.origin).toEqual([15, 5, 6]);
    expect(fr.rings.map((r) => r.part)).toEqual(['ring-x', 'ring-y', 'ring-z']);
    // The build's centre counts over the boxes now (the bodies drawn moved).
    const out: MoveBodyOutput = { type: 'move_body', centre: [1, 2, 3], axis: null, turnAxis: null, matrix: IDENTITY };
    expect(handleFrameOf(feature(), out, boxes, u, null)!.origin).toEqual([1, 2, 3]);
    expect(handleFrameOf(feature({ pivot: ['0 mm', '0 mm', '0 mm'], move: ['2 mm', '0 mm', '0 mm'] }), out, boxes, u, null)!.origin).toEqual([2, 0, 0]);
    // No body picked: no handle. A field that does not read: no values (no drag), the handle stays.
    expect(handleFrameOf(feature({ bodies: [] }), null, boxes, u, null)).toBeNull();
    expect(handleFrameOf(feature({ move: ['nope', '0 mm', '0 mm'] }), null, boxes, u, null)).toMatchObject({ values: null, origin: [10, 5, 5] });
  });

  it("about a picked axis: on that axis, nearest the bodies' centre, with one ring about it (none until it is found)", () => {
    const u = units();
    const f = feature({ about: 'axis', axis: { kind: 'origin', axis: 'origin:x' } });
    expect(handleFrameOf(f, null, boxes, u, null)!.rings).toEqual([]);
    const fr = handleFrameOf(f, null, boxes, u, { origin: [0, 0, 0], dir: [2, 0, 0] })!;
    expect(fr.pivot).toEqual([10, 0, 0]);
    expect(fr.rings).toEqual([{ part: 'ring-axis', axis: [1, 0, 0] }]);
    // The build's own find wins over the panel's.
    const out: MoveBodyOutput = { type: 'move_body', centre: [10, 5, 5], axis: null, turnAxis: { origin: [0, 0, 8], dir: [0, 1, 0] }, matrix: IDENTITY };
    expect(handleFrameOf(f, out, boxes, u, { origin: [0, 0, 0], dir: [1, 0, 0] })!.pivot).toEqual([0, 5, 8]);
    expect(turnLine('axis', [9, 9, 9], { origin: [0, 0, 8], dir: [0, 2, 0] })).toEqual({ origin: [0, 0, 8], dir: [0, 1, 0] });
    expect(turnLine('y', [9, 9, 9], null)).toEqual({ origin: [9, 9, 9], dir: [0, 1, 0] });
  });
});

describe('what the view shows, and the preview', () => {
  const state = (o: { stored?: MoveBodyFeature | null; out?: MoveBodyOutput | null; st?: 'ok' | 'warning' | 'error' }) =>
    ({
      doc: { ...emptyDoc('metric'), features: o.stored ? [o.stored] : [] },
      rebuild: { status: 'done', seq: 1, bodies: [], outputs: o.out ? { f_move: o.out } : {}, features: o.st ? { f_move: { state: o.st } } : {}, ms: null, message: null },
    }) as unknown as Pick<DocState, 'doc' | 'rebuild'>;
  const m: number[] = translation([5, 0, 0]);
  const out: MoveBodyOutput = { type: 'move_body', centre: [10, 5, 5], axis: null, turnAxis: null, matrix: m };

  it('built: its bodies carry its transform; Keep a copy: its copies do; not built: nothing moved, and a copy not built has nothing drawn', () => {
    const f = feature({ move: ['5 mm', '0 mm', '0 mm'] });
    expect(shownOf(state({ stored: f, out, st: 'ok' }), f)).toEqual({ matrix: m, bodies: ['b_1'] });
    expect(shownOf(state({ stored: f, out, st: 'warning' }), f)).toEqual({ matrix: m, bodies: ['b_1'] });
    const c = feature({ copy: true });
    expect(shownOf(state({ stored: c, out, st: 'ok' }), c)).toEqual({ matrix: m, bodies: [deriveBodyId('f_move', 'b_1', 1)] });
    expect(shownOf(state({ stored: f, out, st: 'error' }), f)).toEqual({ matrix: IDENTITY, bodies: ['b_1'] });
    expect(shownOf(state({ stored: null }), f)).toEqual({ matrix: IDENTITY, bodies: ['b_1'] });
    expect(shownOf(state({ stored: null }), c)).toEqual({ matrix: IDENTITY, bodies: [] });
  });

  it('the preview brings bodies drawn at `shown` to the target: target * shown^-1, a rigid motion', () => {
    const shown = compose(translation([5, 0, 0]), rotation([10, 5, 5], [0, 0, 1], 30));
    const target = moveMatrix({ move: [12, -3, 1], angle: 75, pivot: null }, { origin: [10, 5, 5], dir: [0, 0, 1] });
    const p = previewMatrix(target, shown);
    expect(sameMatrix(compose(p, shown), target, 1e-12)).toBe(true);
    expect(sameMatrix(compose(invertRigid(shown), shown), IDENTITY, 1e-12)).toBe(true);
    // Nothing built yet: the preview is the target itself.
    expect(sameMatrix(previewMatrix(target, IDENTITY), target, 1e-12)).toBe(true);
    // The pivot only moves by the move: turn, then move.
    expect(near(applyPoint(target, [10, 5, 5]), [22, 2, 6], 1e-12)).toBe(true);
  });
});

describe("the handle's colours", () => {
  it("X, Y, Z in the view triad's colours of the palette (in a dark view LIGHT's over a light face); a picked axis's ring the palette's blue", () => {
    expect([inkOf('x', LIGHT), inkOf('ring-y', LIGHT), inkOf('z', LIGHT)]).toEqual(LIGHT.triad.map((color) => ({ color, face: null })));
    expect([inkOf('ring-x', DARK), inkOf('y', DARK), inkOf('ring-z', DARK)]).toEqual(DARK.triad.map((color, i) => ({ color, face: LIGHT.triad[i] })));
    expect(inkOf('ring-axis', LIGHT)).toEqual({ color: LIGHT.ink, face: null });
    expect(inkOf('ring-axis', DARK)).toEqual({ color: DARK.ink, face: LIGHT.ink });
  });
});
