// The P4a solids' pure rules and words: Revolve's angles, Loft's sections, the
// Extrude extents' values and the face profile, sketch curves under the pointer and
// their frames, the fillet suggestion's rounding, the chain line, the pick chip's words.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { extentProblem, profilesProblem, resolveExtent } from '../../../src/features/extrude/def';
import { chainWords } from '../../../src/features/fillet/panel';
import { sectionsProblem } from '../../../src/features/loft/def';
import { faceWordsWithOwner } from '../../../src/features/pickinfo';
import { resolveRevolveExtent } from '../../../src/features/revolve/def';
import { distanceToCurve, sketchCurveFrame } from '../../../src/features/solids/geom';
import { roundDown } from '../../../src/features/solids/local';
import type { EntityGeom } from '../../../src/features/sketch/geometry';
import type { UnitsService } from '../../../src/types/units';

const units: UnitsService = {
  units: () => ({ length: 'mm', angle: 'deg' }),
  evaluate(text, quantity) {
    const m = /^\s*(-?[\d.]+)\s*(mm|deg|in)?\s*$/.exec(text);
    if (!m) return { ok: false, error: `cannot read "${text}"` };
    const v = Number(m[1]) * (m[2] === 'in' ? 25.4 : 1);
    return { ok: true, value: v, quantity, uses: [] };
  },
  format: (v) => `${v} mm`,
  unitLabel: () => 'mm',
};

describe('rules', () => {
  it('Revolve angles: one side, symmetric, two sides, with the panel\'s words', () => {
    expect(resolveRevolveExtent({ extent: { kind: 'one', angle: '360 deg' } }, units)).toEqual({ ok: true, values: { kind: 'one', angle: 360 } });
    expect(resolveRevolveExtent({ extent: { kind: 'symmetric', angle: '90' } }, units)).toEqual({ ok: true, values: { kind: 'symmetric', angle: 90 } });
    expect(resolveRevolveExtent({ extent: { kind: 'one', angle: '0' } }, units)).toEqual({ ok: false, message: 'Angle must be more than 0' });
    expect(resolveRevolveExtent({ extent: { kind: 'one', angle: '400' } }, units)).toEqual({ ok: false, message: 'Angle must be at most 360°' });
    expect(resolveRevolveExtent({ extent: { kind: 'two', angle: '200', angle2: '200' } }, units)).toEqual({ ok: false, message: 'The two angles must add up to at most 360°' });
    expect(resolveRevolveExtent({ extent: { kind: 'two', angle: '30', angle2: 'x' } }, units)).toEqual({ ok: false, message: 'Angle 2: cannot read "x"' });
  });

  it('Loft wants two profiles or more, one per sketch', () => {
    const r = (sketch: string) => ({ sketch, region: 'k', entities: [], sample: [0, 0] as [number, number] });
    expect(sectionsProblem({ sections: [] })).toBe('Pick two or more profiles, one in each sketch');
    expect(sectionsProblem({ sections: [r('a')] })).toBe('Pick a second profile, in another sketch');
    expect(sectionsProblem({ sections: [r('a'), r('a')] })).toBe('Pick one profile per sketch');
    expect(sectionsProblem({ sections: [r('a'), r('b')] })).toBeNull();
  });

  it('Extrude: Through all and Up to values; a face profile excludes sketch profiles; Up to waits for its target', () => {
    expect(resolveExtent({ extent: { kind: 'through_all', both: true, distance: '10 mm' } }, units)).toEqual({ ok: true, values: { kind: 'through_all', both: true } });
    expect(resolveExtent({ extent: { kind: 'to', target: null, offset: '2 mm', distance: '10 mm' } }, units)).toEqual({ ok: true, values: { kind: 'to', offset: 2 } });
    expect(resolveExtent({ extent: { kind: 'to', target: null, offset: 'x', distance: '10 mm' } }, units)).toEqual({ ok: false, message: 'Offset: cannot read "x"' });
    expect(extentProblem({ extent: { kind: 'to', target: null, offset: '0', distance: '1' } })).toBe('Up to: pick a face or a vertex to extrude up to');
    const face = { body: 'b', ref: { name: 'F:f:end', signature: { kind: 'face' as const, type: 'plane', at: [0, 0, 0] as [number, number, number] } } };
    expect(profilesProblem({ profiles: [], face })).toBeNull();
    expect(profilesProblem({ profiles: [{ sketch: 's', region: 'k', entities: [], sample: [0, 0] }], face })).toBe('Extrude either a flat face or sketch profiles, not both');
  });
});

describe('sketch curves', () => {
  const line: EntityGeom = { kind: 'line', id: 'e', construction: false, a: [0, 0], b: [10, 0], pa: 'a', pb: 'b' };
  const arc: EntityGeom = { kind: 'arc', id: 'a', construction: false, c: [0, 0], r: 10, a: [10, 0], b: [0, 10], a0: 0, a1: 90, ccw: true, pa: 'a', pb: 'b', pc: 'c' };
  const top = { plane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] } };
  it('distance to a line, an arc (on its sweep, else its nearer end)', () => {
    expect(distanceToCurve(line, [5, 3])).toBeCloseTo(3);
    expect(distanceToCurve(line, [13, 4])).toBeCloseTo(5);
    expect(distanceToCurve(arc, [Math.SQRT1_2 * 12, Math.SQRT1_2 * 12])).toBeCloseTo(2);
    expect(distanceToCurve(arc, [0, -10])).toBeCloseTo(Math.hypot(10, 10));
  });
  it('a curve\'s point and tangent at a fraction of it', () => {
    expect(sketchCurveFrame(line, top, 0.5)).toEqual({ p: [5, 0, 0], tangent: [1, 0, 0] });
    const f = sketchCurveFrame(arc, top, 0.5)!;
    expect(f.p[0]).toBeCloseTo(Math.SQRT1_2 * 10);
    expect(f.tangent[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(f.tangent[1]).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('words', () => {
  it('rounds a suggestion down to two digits; says the chain; names a picked face', () => {
    expect(roundDown(4.87)).toBeCloseTo(4.8);
    expect(roundDown(0.0937)).toBeCloseTo(0.093);
    expect(roundDown(12.9)).toBe(12);
    expect(chainWords('Rounds', 2, 8)).toBe('Rounds 8 edges: 2 picked, 6 more along their tangent chains');
    expect(chainWords('Rounds', 4, 4)).toBeNull();
    const fname = (id: string) => ({ f_fl: 'Fillet 1', f_ex: 'Extrude 1' })[id] ?? null;
    expect(faceWordsWithOwner('F:f_fl:fillet:E:F:f_ex:end&F:f_ex:side:e_1[p:a>p:b]', [], fname)).toBe('Fillet (Fillet 1)');
    expect(faceWordsWithOwner('F:f_ex:side:e_1|F:f_ex:end', ['F:f_ex:side:e_1'], fname)).toBe('Side 1 (Extrude 1) + End (Extrude 1)');
  });
});
