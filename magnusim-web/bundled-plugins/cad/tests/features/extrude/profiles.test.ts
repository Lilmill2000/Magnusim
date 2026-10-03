// Region-key resolution (exact, repaired through entities + the inside point and
// lineage, lost), extrude face names (one profile; several by profile index;
// merged regions; refusing positional caps), the extent rules, and the
// distance arrow's math (axis parameter under a ray, rounding to a pixel step,
// the fields a drag writes).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createUnitsService } from '../../../src/doc/units';
import { profilesProblem, resolveExtent } from '../../../src/features/extrude/def';
import { axisParamAt, draggedExtent, extentLength, roundedDistance } from '../../../src/features/extrude/handle';
import { extrudeNames } from '../../../src/features/extrude/names';
import { refOfRegion, resolveRegionRef } from '../../../src/features/extrude/profiles';
import { unpackRegions } from '../../../src/features/sketch/regions';
import type { ExtrudeFeature, RegionRef } from '../../../src/types/doc';
import type { KernelRegion, OpHistory } from '../../../src/types/kernel-protocol';
import type { SketchRegion } from '../../../src/types/sketch';

/** Regions with square triangles at [u0, v0, u1, v1]. */
function regions(list: (KernelRegion & { box: [number, number, number, number] })[]): SketchRegion[] {
  const uv: number[] = [];
  const idx: number[] = [];
  const ranges: number[] = [];
  for (const r of list) {
    const [u0, v0, u1, v1] = r.box;
    const b = uv.length / 2;
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    ranges.push(idx.length, 6);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return unpackRegions(
    list.map(({ box: _b, ...r }) => r),
    { tri_uv: new Float32Array(uv).buffer, tri_idx: new Uint32Array(idx).buffer, tri_ranges: new Uint32Array(ranges).buffer },
  );
}
const R = (key: string, entities: string[], box: [number, number, number, number]) => ({ key, loops: [], entities, area: (box[2] - box[0]) * (box[3] - box[1]), sample: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] as [number, number], bbox: box, box });

// Two overlapping circles c_1, c_2: three regions bounded by the same two circles (boxes stand in for the shapes).
const LENS = '+c_1[x:c_1|c_2#1>x:c_1|c_2#0] +c_2[x:c_1|c_2#0>x:c_1|c_2#1]';
const lens = regions([R('left', ['c_1', 'c_2'], [-20, -20, 10, 20]), R(LENS, ['c_1', 'c_2'], [10, -10, 20, 10]), R('right', ['c_1', 'c_2'], [20, -20, 50, 20])]);
const lensRef: RegionRef = refOfRegion('f_sk', lens[1]);

describe('profile references', () => {
  it('keeps what was picked: key, sorted entities, a point inside', () => {
    expect(refOfRegion('f_sk', { key: 'K', entities: ['e_2', 'e_1'], sample: [1, 2] })).toEqual({ sketch: 'f_sk', region: 'K', entities: ['e_1', 'e_2'], sample: [1, 2] });
  });

  it('finds the same key (a dimension change keeps keys)', () => {
    const moved = regions([R('left', ['c_1', 'c_2'], [-25, -25, 12, 25]), R(LENS, ['c_1', 'c_2'], [12, -12, 20, 12]), R('right', ['c_1', 'c_2'], [20, -25, 55, 25])]);
    expect(resolveRegionRef(lensRef, moved)).toMatchObject({ ok: true, how: 'exact', key: LENS });
  });

  it('among regions with the same entities takes the one holding the stored point, with a warning', () => {
    const renamed = regions([R('left', ['c_1', 'c_2'], [-20, -20, 10, 20]), R('lens renamed', ['c_1', 'c_2'], [10, -10, 20, 10]), R('right', ['c_1', 'c_2'], [20, -20, 50, 20])]);
    expect(resolveRegionRef(lensRef, renamed)).toMatchObject({ ok: true, how: 'repaired', key: 'lens renamed' });
  });

  it('is lost when the arc bounding the lens is trimmed: the region left with the same entities does not hold its point', () => {
    // c_2's arc inside c_1 trimmed: c_1's disc {c_1} holds the lens point, the right crescent {c_1, c_2} does not.
    const trimmed = regions([R('disc', ['c_1'], [-20, -20, 20, 20]), R('crescent', ['c_1', 'c_2'], [20, -20, 50, 20])]);
    expect(resolveRegionRef(lensRef, trimmed)).toEqual({ ok: false });
  });

  it('counts trim pieces as the entity they came from (lineage)', () => {
    const ref: RegionRef = { sketch: 'f_sk', region: 'old', entities: ['e_1', 'e_2'], sample: [5, 5] };
    const now = regions([R('new', ['e_1.b', 'e_2'], [0, 0, 10, 10])]);
    expect(resolveRegionRef(ref, now, new Map([['e_1.b', 'e_1']]))).toMatchObject({ ok: true, how: 'repaired', key: 'new' });
    // By spelling alone, when the piece's entity is not in the sketch any more.
    expect(resolveRegionRef(ref, now)).toMatchObject({ ok: true, how: 'repaired' });
    // Another entity set: lost.
    const other = regions([R('new', ['e_1', 'e_3'], [0, 0, 10, 10])]);
    expect(resolveRegionRef(ref, other)).toEqual({ ok: false });
  });
});

describe('extrude face names', () => {
  const hist = (faces: OpHistory['faces'], extra: Partial<OpHistory> = {}): OpHistory => ({ faces, edges: [], deleted: [], ...extra });

  it('names sides by sub-segment token and the caps start / end with one profile', () => {
    const h = hist([
      { out: 0, from: [{ seg: 'e_1[p:a>p:b]', how: 'generated' }] },
      { out: 1, from: [{ cap: 'start', how: 'generated' }] },
      { out: 2, from: [{ cap: 'end', how: 'generated' }] },
    ]);
    expect(extrudeNames('f_x', { faces: 3, history: h }, ['K'])?.faces).toEqual(['F:f_x:side:e_1[p:a>p:b]', 'F:f_x:start', 'F:f_x:end']);
    // Caps given by index only.
    expect(extrudeNames('f_x', { faces: 2, history: hist([], { start: 1, end: 0 }) }, ['K'])?.faces).toEqual(['F:f_x:end', 'F:f_x:start']);
  });

  it('names caps by profile index with several profiles; merged regions share the lowest index', () => {
    const h = hist(
      [
        { out: 0, from: [{ cap: 'start', how: 'generated' }] },
        { out: 1, from: [{ cap: 'end', how: 'generated' }] },
        { out: 2, from: [{ cap: 'start', how: 'generated' }] },
        { out: 3, from: [{ cap: 'end', how: 'generated' }] },
      ],
      { caps: { A: { start: 2, end: 3 }, B: { start: 0, end: 1 }, C: { start: 0, end: 1 } } },
    );
    expect(extrudeNames('f_x', { faces: 4, history: h }, ['A', 'B', 'C'])?.faces).toEqual(['F:f_x:start:1', 'F:f_x:end:1', 'F:f_x:start:0', 'F:f_x:end:0']);
  });

  it('refuses to name caps by position (no caps per region), and needs the face count and history', () => {
    const h = hist([
      { out: 0, from: [{ cap: 'start', how: 'generated' }] },
      { out: 1, from: [{ cap: 'start', how: 'generated' }] },
    ]);
    expect(extrudeNames('f_x', { faces: 2, history: h }, ['A', 'B'])).toBeNull();
    expect(extrudeNames('f_x', { faces: 2, history: { ...h, caps: { A: { start: 0, end: null } } } }, ['A', 'B'])).toBeNull();
    expect(extrudeNames('f_x', { history: h }, ['A'])).toBeNull();
    expect(extrudeNames('f_x', { faces: 2 }, ['A'])).toBeNull();
  });
});

describe('extent and profiles rules', () => {
  const units = createUnitsService(
    () => ({ length: 'in', angle: 'deg' }),
    () => [{ id: 'p', name: 'D_bin', expr: '12 in', quantity: 'length' }],
  );
  it('evaluates distances in mm with their words', () => {
    expect(resolveExtent({ extent: { kind: 'blind', distance: '-20 in' } }, units)).toEqual({ ok: true, values: { kind: 'blind', d: -508 } });
    const sym = resolveExtent({ extent: { kind: 'symmetric', distance: 'D_bin' } }, units);
    expect(sym.ok && sym.values.kind === 'symmetric' && sym.values.d).toBeCloseTo(304.8, 9);
    expect(resolveExtent({ extent: { kind: 'two', distance: '1 in', distance2: '2 mm' } }, units)).toEqual({ ok: true, values: { kind: 'two', d1: 25.4, d2: 2 } });
    expect(resolveExtent({ extent: { kind: 'blind', distance: '0' } }, units)).toEqual({ ok: false, message: 'Distance must not be 0' });
    expect(resolveExtent({ extent: { kind: 'two', distance: '1 in', distance2: '-25.4 mm' } }, units)).toEqual({ ok: false, message: 'The two distances must not add up to 0' });
    const bad = resolveExtent({ extent: { kind: 'two', distance: '1 in', distance2: 'nope' } }, units);
    expect(!bad.ok && bad.message).toMatch(/^Distance 2: /);
    // Each says the field the panel shows (Two sides said "Distance" under "Distance 1").
    expect(resolveExtent({ extent: { kind: 'two', distance: 'w', distance2: '0 mm' } }, units)).toEqual({ ok: false, message: 'Distance 1: Unknown parameter "w"' });
    expect(resolveExtent({ extent: { kind: 'symmetric', distance: 'w' } }, units)).toEqual({ ok: false, message: 'Total distance: Unknown parameter "w"' });
    expect(resolveExtent({ extent: { kind: 'blind', distance: 'w' } }, units)).toEqual({ ok: false, message: 'Distance: Unknown parameter "w"' });
  });
  it('wants profiles of one sketch', () => {
    const p = (sketch: string): RegionRef => ({ sketch, region: 'k', entities: [], sample: [0, 0] });
    expect(profilesProblem({ profiles: [] })).toBe('Pick a profile');
    expect(profilesProblem({ profiles: [p('a'), p('b')] })).toBe('Pick profiles from one sketch');
    expect(profilesProblem({ profiles: [p('a'), p('a')] })).toBeNull();
  });
});

describe('the distance arrow', () => {
  it('finds the axis parameter under a ray, and none looking straight down the axis', () => {
    // Axis: from the origin along +Z; a ray along +Y crossing x = 0, z = 12.
    expect(axisParamAt([0, 0, 0], [0, 0, 1], { origin: [0, -100, 12], dir: [0, 1, 0] })).toBeCloseTo(12, 12);
    expect(axisParamAt([0, 0, 0], [0, 0, 1], { origin: [5, -100, -3], dir: [0, 2, 0] })).toBeCloseTo(-3, 12);
    expect(axisParamAt([0, 0, 0], [0, 0, 1], { origin: [0, 0, 100], dir: [0, 0, -1] })).toBeNull();
  });

  it('rounds to a step a pixel can show, in the display unit, stored with the unit', () => {
    expect(roundedDistance(12.3456, 0.2, { length: 'mm', angle: 'deg' })).toEqual({ expr: '12.3 mm', mm: 12.3 });
    expect(roundedDistance(12.3456, 0.02, { length: 'mm', angle: 'deg' })).toEqual({ expr: '12.35 mm', mm: 12.35 });
    expect(roundedDistance(12.3456, 3, { length: 'mm', angle: 'deg' })).toEqual({ expr: '12 mm', mm: 12 });
    const inch = roundedDistance(508.3, 1, { length: 'in', angle: 'deg' });
    expect(inch.expr).toBe('20.01 in');
  });

  it('writes the field the dragged arrow stands for', () => {
    const f = (extent: ExtrudeFeature['extent']) => ({ extent }) as ExtrudeFeature;
    const mm = { length: 'mm' as const, angle: 'deg' as const };
    expect(draggedExtent(f({ kind: 'blind', distance: '10 mm' }), 'd1', -14.04, 0.1, mm)).toEqual({ extent: { kind: 'blind', distance: '-14 mm' } });
    expect(draggedExtent(f({ kind: 'blind', distance: '10 mm' }), 'd1', 0.01, 0.1, mm)).toBeNull();
    expect(draggedExtent(f({ kind: 'symmetric', distance: '10 mm' }), 'd1', 7.5, 0.1, mm)).toEqual({ extent: { kind: 'symmetric', distance: '15 mm' } });
    expect(draggedExtent(f({ kind: 'symmetric', distance: '10 mm' }), 'd1', -2, 0.1, mm)).toBeNull();
    expect(draggedExtent(f({ kind: 'two', distance: '1 mm', distance2: '2 mm' }), 'd2', -6, 0.1, mm)).toEqual({ extent: { kind: 'two', distance: '1 mm', distance2: '6 mm' } });
    expect(extentLength({ kind: 'two', d1: 1, d2: 2 }, 'd2')).toBe(2);
  });
});
