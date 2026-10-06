// The pure parts of the PATTERN group: the copies' keys, words and transforms (linear in one
// or two directions, symmetric, circular full or over an angle, the mirror), the copies' body
// ids, and the copies' face names with their words.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { copyCode, instanceList } from '../../../src/features/pattern/build';
import { copyFaceName, copyNames, copyRole } from '../../../src/features/pattern/naming';
import { applyPoint, circularCopies, circularStep, compose, handedness, landsOn, linearCopies, mirrorCopies, parallel, reflection, rotation, stepOf, translation, wholeTurn, withSkips } from '../../../src/features/pattern/transforms';
import { copiesIn, copyGoneWhy } from '../../../src/features/pattern/gone';
import { describeFace, edgeName } from '../../../src/naming/names';
import { edgeWords, faceShortWords, splitEdgeName } from '../../../src/naming/edges';
import type { Vec3 } from '../../../src/types/doc';

const near = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

describe('transforms', () => {
  it('a translation, a rotation about an axis off the origin, a reflection, and their composition', () => {
    expect(applyPoint(translation([1, 2, 3]), [1, 1, 1])).toEqual([2, 3, 4]);
    const r = rotation([10, 0, 0], [0, 0, 1], 90);
    expect(near(applyPoint(r, [20, 0, 5]), [10, 10, 5])).toBe(true);
    expect(handedness(r)).toBeCloseTo(1, 12);
    const m = reflection([5, 0, 0], [1, 0, 0]);
    expect(near(applyPoint(m, [7, 3, 2]), [3, 3, 2])).toBe(true);
    expect(handedness(m)).toBeCloseTo(-1, 12);
    // A mirror after a move: the move first.
    expect(near(applyPoint(compose(m, translation([1, 0, 0])), [7, 3, 2]), [2, 3, 2])).toBe(true);
    expect(() => rotation([0, 0, 0], [0, 0, 0], 10)).toThrow(/no direction/);
  });

  it('linear: keys 2..N, symmetric -2..-N, two directions i.j; offsets along each direction; extent shares the distance', () => {
    const one = linearCopies({ dir: [1, 0, 0], step: 20, count: 4, symmetric: false }, null);
    expect(one.map((c) => c.key)).toEqual(['2', '3', '4']);
    expect(one.map((c) => c.label)).toEqual(['Instance 2', 'Instance 3', 'Instance 4']);
    expect(one.map((c) => applyPoint(c.matrix, [0, 0, 0])[0])).toEqual([20, 40, 60]);
    const sym = linearCopies({ dir: [1, 0, 0], step: 10, count: 3, symmetric: true }, null);
    expect(sym.map((c) => c.key)).toEqual(['2', '3', '-2', '-3']);
    expect(sym.map((c) => applyPoint(c.matrix, [0, 0, 0])[0])).toEqual([10, 20, -10, -20]);
    expect(sym[2].label).toBe('Instance −2');
    const two = linearCopies({ dir: [1, 0, 0], step: 10, count: 2, symmetric: false }, { dir: [0, 1, 0], step: 5, count: 3, symmetric: false });
    // Direction 1's own row keeps direction 1's keys ("2", not "2.1": adding direction 2 renames nothing).
    expect(two.map((c) => c.key)).toEqual(['2', '1.2', '2.2', '1.3', '2.3']);
    expect(two[0].label).toBe('Instance 2, 1');
    expect(near(applyPoint(two[4].matrix, [0, 0, 0]), [10, 10, 0])).toBe(true);
    expect(two[4].label).toBe('Instance 2, 3');
    expect(stepOf('extent', 60, 4)).toBe(20);
    expect(stepOf('spacing', 60, 4)).toBe(60);
    expect(withSkips(one, ['3']).map((c) => c.skipped)).toEqual([false, true, false]);
    expect(parallel([1, 0, 0], [-2, 0, 0])).toBe(true);
    expect(parallel([1, 0, 0], [1, 1, 0])).toBe(false);
  });

  it('circular: full 360 equal; an angle first to last; symmetric both ways', () => {
    const full = circularCopies({ origin: [0, 0, 0], dir: [0, 0, 1], count: 6, mode: 'full', angle: 0, symmetric: false });
    expect(full.map((c) => c.key)).toEqual(['2', '3', '4', '5', '6']);
    expect(near(applyPoint(full[0].matrix, [20, 0, 0]), [10, 20 * Math.sin(Math.PI / 3), 0])).toBe(true);
    expect(circularStep({ count: 3, mode: 'angle', angle: 90 })).toBe(45);
    const sym = circularCopies({ origin: [0, 0, 0], dir: [0, 0, 1], count: 3, mode: 'angle', angle: 90, symmetric: true });
    expect(sym.map((c) => c.key)).toEqual(['2', '3', '-2', '-3']);
    expect(near(applyPoint(sym[3].matrix, [10, 0, 0]), [0, -10, 0])).toBe(true);
    // Symmetric means nothing for a full turn.
    expect(circularCopies({ origin: [0, 0, 0], dir: [0, 0, 1], count: 4, mode: 'full', angle: 0, symmetric: true }).map((c) => c.key)).toEqual(['2', '3', '4']);
  });

  it('circular, Angle 360 (one side) spreads evenly as Full 360; copies that land on another are found', () => {
    expect(wholeTurn({ mode: 'angle', angle: 360, symmetric: false })).toBe(true);
    expect(wholeTurn({ mode: 'angle', angle: 360, symmetric: true })).toBe(false);
    expect(circularStep({ count: 4, mode: 'angle', angle: 360 })).toBe(90);
    const turned = circularCopies({ origin: [0, 0, 0], dir: [0, 0, 1], count: 6, mode: 'angle', angle: 360, symmetric: false });
    expect(turned.map((c) => c.turn)).toEqual([60, 120, 180, 240, 300]);
    expect(landsOn(turned)).toBeNull();
    // Symmetric, 3 per side over 180 each way: +180 and -180 are one place.
    expect(landsOn(circularCopies({ origin: [0, 0, 0], dir: [0, 0, 1], count: 3, mode: 'angle', angle: 180, symmetric: true }))).toEqual({ copy: 'Instance −3', on: 'Instance 3' });
    expect(landsOn([{ label: 'Instance 2', turn: 360 }])).toEqual({ copy: 'Instance 2', on: 'the original' });
  });

  it('mirror: one copy keyed "m"', () => {
    const [m] = mirrorCopies([0, 0, 0], [1, 0, 0]);
    expect(m.key).toBe('m');
    expect(m.label).toBe('Mirror copy');
    expect(near(applyPoint(m.matrix, [5, 1, 2]), [-5, 1, 2])).toBe(true);
  });

  it('copy body ids: a whole number per key, never the same twice', () => {
    expect(copyCode('m')).toBe(1);
    expect(copyCode('2')).toBe(3);
    expect(copyCode('-2')).toBe(4);
    const keys = linearCopies({ dir: [1, 0, 0], step: 1, count: 6, symmetric: true }, { dir: [0, 1, 0], step: 1, count: 6, symmetric: true }).map((c) => c.key);
    const codes = keys.map(copyCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => Number.isInteger(c) && c >= 1)).toBe(true);
    expect(instanceList(['Instance 4'])).toBe('Instance 4');
    expect(instanceList(['Instance 2', 'Instance 3', 'Instance 4'])).toBe('Instances 2, 3 and 4');
  });
});

describe('copy names', () => {
  const P = 'f_pat';
  it('each part of a merged name prefixed; a copy keeps (or maps) the source numbering', () => {
    expect(copyRole('3')).toBe('i3');
    expect(copyRole('2.-1')).toBe('i2.-1');
    expect(copyRole('m')).toBe('m');
    expect(copyFaceName(P, '3', 'F:f_ex:side:e_1[p:a>p:b]')).toBe('F:f_pat:i3:F:f_ex:side:e_1[p:a>p:b]');
    expect(copyFaceName(P, '3', 'F:f_a:end|F:f_b:end')).toBe('F:f_pat:i3:F:f_a:end|F:f_pat:i3:F:f_b:end');
    expect(copyNames(P, 'm', { faces: ['A', 'B', 'C'] }, [2, 0, 1], 3)).toEqual({ faces: ['F:f_pat:m:B', 'F:f_pat:m:C', 'F:f_pat:m:A'] });
    expect(copyNames(P, '2', { faces: ['A', 'B'] }, null, 2)).toEqual({ faces: ['F:f_pat:i2:A', 'F:f_pat:i2:B'] });
    expect(copyNames(P, '2', null, null, 2)).toBeNull();
  });

  it('words: a copy face reads as its source with the instance; edges of copies split right', () => {
    const fname = (id: string) => ({ f_pat: 'Linear pattern 1', f_ex: 'Extrude 2', f_base: 'Extrude 1', f_m: 'Mirror 1' })[id] ?? null;
    const side = 'F:f_ex:side:e_1[p:a>p:b]';
    const copy = copyFaceName(P, '3', side);
    const body = ['F:f_base:end', side, copy];
    expect(describeFace(copy, fname, body)).toBe('Side 1 of Extrude 2 · instance 3 of Linear pattern 1');
    expect(describeFace(copyFaceName('f_m', 'm', 'F:f_base:end'), fname, body)).toBe('End face of Extrude 1 · the mirror copy of Mirror 1');
    expect(describeFace(`${copyFaceName(P, '-2', 'F:f_base:end')}#1`, fname, body)).toBe('End face · part 2 of Extrude 1 · instance −2 of Linear pattern 1');
    expect(faceShortWords(copy, body)).toEqual({ owner: 'f_ex', words: 'Side 1 (instance 3)' });
    const e = edgeName('F:f_base:end', copy);
    expect(splitEdgeName(e)).toEqual(['F:f_base:end', copy]);
    expect(edgeWords(e, fname, body)).toBe('End of Extrude 1 · Side 1 (instance 3) of Extrude 2');
    // A copy of a fillet face (its name holds an edge name) still splits at its own '&'.
    const fil = copyFaceName(P, '2', 'F:f_fl:fillet:E:F:f_base:end&F:f_ex:side:e_1[p:a>p:b]');
    expect(splitEdgeName(edgeName('F:f_base:end', fil))).toEqual(['F:f_base:end', fil]);
  });
});

describe('why a copy is gone (fix round 1, P4)', () => {
  const fname = (id: string) => ({ f_pat: 'Linear pattern 1', f_m: 'Mirror 1' })[id] ?? null;
  const name = 'E:F:f_base:end&F:f_pat:i3:F:f_ex:side:e_1[p:a>p:b]';
  const out = (copies: { key: string; skipped: boolean }[]) => new Map([['f_pat', { type: 'pattern' as const, copies: copies.map((c) => ({ ...c, label: `Instance ${c.key}`, at: [0, 0, 0] as [number, number, number] })), made: 0, origin: null }]]);
  it('names the pattern and the copy, from the stored name and the build outputs', () => {
    expect(copiesIn(name)).toEqual([{ pattern: 'f_pat', role: 'i3' }]);
    expect(copyGoneWhy(name, out([{ key: '2', skipped: false }, { key: '3', skipped: true }]), fname)).toBe('instance 3 of Linear pattern 1 is skipped');
    expect(copyGoneWhy(name, out([{ key: '2', skipped: false }]), fname)).toBe('Linear pattern 1 now makes 2 instances, so there is no instance 3');
    expect(copyGoneWhy(name, new Map(), fname)).toBe('Linear pattern 1 did not build');
    expect(copyGoneWhy('E:F:f_base:end&F:f_ex:side:x', out([]), fname)).toBeNull();
    expect(copyGoneWhy(name, out([{ key: '3', skipped: false }]), fname)).toBeNull();
  });
});
