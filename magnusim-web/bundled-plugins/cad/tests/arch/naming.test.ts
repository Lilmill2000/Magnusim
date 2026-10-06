// The naming layer (src/naming, proposal §4.5): names after an operation from
// its history, the grammar helpers, and stored-reference resolution.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describeFace, edgeName, mergeNames, namesAfter, nameCandidates, namesFromResult, resolveFace, splitMerged, splitSuffix } from '../../src/naming';
import type { PersistentRef } from '../../src/types/doc';
import type { OpHistory, TopoResult } from '../../src/types/kernel-protocol';
import type { FaceNames, NamingLookup } from '../../src/types/naming';

type TopoFace = TopoResult['faces'][number];
const plane = (i: number, at: [number, number, number], normal: [number, number, number], area = 100): TopoFace => ({ i, type: 'plane', area, centroid: at, normal, bbox: [at[0] - 5, at[1] - 5, at[2], at[0] + 5, at[1] + 5, at[2]] });
const cyl = (i: number, at: [number, number, number], r: number): TopoFace => ({ i, type: 'cylinder', area: 50, centroid: at, axis: { origin: at, dir: [0, 0, 1] }, radius: r });

function lookupOf(faces: TopoFace[]): NamingLookup & { asked: (number[] | 'all')[] } {
  const asked: (number[] | 'all')[] = [];
  return {
    asked,
    async faces(_shape, indices) {
      asked.push(indices);
      return indices === 'all' ? faces : faces.filter((f) => indices.includes(f.i));
    },
  };
}

describe('grammar', () => {
  it('merges sorted and unique, splits merged names outside brackets, and finds split suffixes after the last bracket', () => {
    expect(mergeNames(['F:b:x', 'F:a:y', 'F:b:x'])).toBe('F:a:y|F:b:x');
    expect(splitMerged('F:f:side:e_1[x:e_1|e_2#0>p:pt_a]|F:g:start')).toEqual(['F:f:side:e_1[x:e_1|e_2#0>p:pt_a]', 'F:g:start']);
    expect(splitSuffix('F:f:side:e_1[x:e_1|e_2#0>p:pt_a]')).toEqual({ base: 'F:f:side:e_1[x:e_1|e_2#0>p:pt_a]', k: null });
    expect(splitSuffix('F:f:side:e_1[x:e_1|e_2#0>p:pt_a]#1')).toEqual({ base: 'F:f:side:e_1[x:e_1|e_2#0>p:pt_a]', k: 1 });
    expect(edgeName('F:b', 'F:a')).toBe('E:F:a&F:b');
  });

  it('describes faces in words for panels', () => {
    const names: Record<string, string> = { f_ex: 'Extrude 1', f_imp: 'Imported 1', f_box: 'Box 1' };
    const fn = (id: string) => names[id] ?? null;
    expect(describeFace('F:f_ex:end', fn)).toBe('End face of Extrude 1');
    // A side is numbered among its feature's sides on the body, never by the sketch's token (P4a review).
    expect(describeFace('F:f_ex:side:e_1[p:a>p:b]#1', fn)).toBe('Side face · part 2 of Extrude 1');
    const body = ['F:f_ex:start', 'F:f_ex:end', 'F:f_ex:side:e_6cctu2upm20i[p:a>p:b]', 'F:f_ex:side:e_1[p:a>p:b]#1', 'F:f_ex:side:e_1[p:a>p:b]#0'];
    expect(describeFace('F:f_ex:side:e_6cctu2upm20i[p:a>p:b]', fn, body)).toBe('Side 2 of Extrude 1');
    expect(describeFace('F:f_ex:side:e_1[p:a>p:b]#1', fn, body)).toBe('Side 1 · part 2 of Extrude 1');
    expect(describeFace('F:f_fl:fillet:E:F:f_ex:end&F:f_ex:start', (id) => (id === 'f_fl' ? 'Fillet 1' : null))).toBe('Fillet face of Fillet 1');
    expect(describeFace('F:f_imp:import:0:11', fn)).toBe('Face 12 of Imported 1');
    expect(describeFace('F:f_box:primitive:2', fn)).toBe('Face 3 of Box 1');
    expect(describeFace('F:f_gone:start', fn)).toBe('Start face of a deleted feature');
    // A merged face says what it was made of, in a fixed order (review P2/P3 round 3: "(merged)").
    expect(describeFace('F:f_box:primitive:5|F:f_ex:end', fn)).toBe('End face of Extrude 1 merged with Face 6 of Box 1');
    expect(describeFace('F:f_box:primitive:12|F:f_box:primitive:5', fn)).toBe('Face 6 of Box 1 merged with Face 13 of Box 1');
    expect(describeFace('F:f_box:primitive:1|F:f_box:primitive:2|F:f_ex:end', fn)).toBe('End face of Extrude 1 merged with 2 other faces');
    expect(describeFace('F:f_box:primitive:1|F:f_box:primitive:2', fn)).not.toContain('(merged)');
  });
});

describe('namesAfter', () => {
  const inputs = new Map<number, FaceNames>([
    [1, { faces: ['F:t:0', 'F:t:1', 'F:t:2'] }],
    [2, { faces: ['F:u:0', 'F:u:1'] }],
  ]);

  it('keeps names through same / modified, merges, numbers splits by centroid, and names sweep sides and caps', () => {
    const history: OpHistory = {
      faces: [
        { out: 0, from: [{ shape: 1, face: 0, how: 'same' }] },
        { out: 1, from: [{ shape: 1, face: 1, how: 'modified' }, { shape: 2, face: 0, how: 'modified' }] },
        { out: 2, from: [{ shape: 1, face: 2, how: 'modified' }] },
        { out: 3, from: [{ shape: 1, face: 2, how: 'modified' }] },
        { out: 4, from: [{ seg: 'e_1[p:a>p:b]', how: 'generated' }] },
        { out: 5, from: [{ cap: 'end', how: 'generated' }] },
      ],
      edges: [],
      deleted: [],
    };
    const topo = { faces: [2, 3].map((i) => plane(i, [i === 2 ? 10 : -10, 0, 0], [0, 0, 1])) };
    const r = namesAfter({ feature: 'f_op', faces: 7, history, inputs, topo });
    expect(r.names.faces).toEqual(['F:t:0', 'F:t:1|F:u:0', 'F:t:2#1', 'F:t:2#0', 'F:f_op:side:e_1[p:a>p:b]', 'F:f_op:end', 'F:f_op:new']);
    expect(r.warnings).toEqual(['1 face has no history and was named as new']);
  });

  it('names faces generated from an edge by the edge (its two faces), or by position with a warning', () => {
    const history: OpHistory = { faces: [{ out: 0, from: [{ shape: 1, edge: 4, how: 'generated' }] }], edges: [], deleted: [] };
    const withEdges = namesAfter({ feature: 'f_pp', faces: 1, history, inputs, role: 'side' }, () => [0, 2]);
    expect(withEdges.names.faces).toEqual(['F:f_pp:side:E:F:t:0&F:t:2']);
    const noEdges = namesAfter({ feature: 'f_pp', faces: 1, history, inputs, role: 'side' });
    expect(noEdges.names.faces).toEqual(['F:f_pp:side:e4']);
    expect(noEdges.warnings).toEqual(['1 face was named by position (no edge names)']);
  });

  it('gives no names when the result has no face count or history, or an input is unnamed (never unstable names)', () => {
    const h: OpHistory = { faces: [{ out: 0, from: [{ shape: 1, face: 0, how: 'same' }] }], edges: [], deleted: [] };
    expect(namesFromResult('f', { history: h }, new Map([[1, { faces: ['A'] }]]))).toBeNull();
    expect(namesFromResult('f', { faces: 1 }, new Map([[1, { faces: ['A'] }]]))).toBeNull();
    expect(namesFromResult('f', { faces: 1, history: h }, new Map([[1, null]]))).toBeNull();
    expect(namesFromResult('f', { faces: 1, history: h }, new Map([[1, { faces: ['A'] }]]))).toEqual({ faces: ['A'] });
  });
});

describe('resolveFace', () => {
  const ref = (name: string, sig: Partial<PersistentRef['signature']> = {}): PersistentRef => ({ name, signature: { kind: 'face', type: 'plane', at: [0, 0, 10], dir: [0, 0, 1], size: 100, ...sig } });

  it('a name match of the same kind resolves cleanly even after the face moved (an upstream dimension change)', async () => {
    const lookup = lookupOf([plane(0, [0, 0, 0], [0, 0, -1]), plane(1, [0, 0, 25], [0, 0, 1], 400)]);
    const r = await resolveFace({ ref: ref('F:f_box:primitive:5'), shape: 7, names: { faces: ['F:f_box:primitive:4', 'F:f_box:primitive:5'] }, lookup });
    expect(r).toMatchObject({ ok: true, index: 1, how: 'name' });
    expect(lookup.asked).toEqual([[1]]);
  });

  it('a name match whose kind changed, or a face split in two, resolves with "Reference repaired · check"', async () => {
    const turned = await resolveFace({ ref: ref('A'), shape: 1, names: { faces: ['A'] }, lookup: lookupOf([plane(0, [0, 0, 10], [1, 0, 0])]) });
    expect(turned).toMatchObject({ ok: true, index: 0, how: 'moved', warning: 'Reference repaired · check' });
    const split = await resolveFace({ ref: ref('A'), shape: 1, names: { faces: ['A#0', 'B', 'A#1'] }, lookup: lookupOf([plane(0, [0, 0, -50], [0, 0, 1]), plane(1, [9, 9, 9], [0, 1, 0]), plane(2, [0, 0, 11], [0, 0, 1])]) });
    expect(split).toMatchObject({ ok: true, index: 2, how: 'moved' });
    expect(nameCandidates('A', ['A|C', 'B'])).toEqual([0]);
  });

  it('with no name, the signature resolves only when the runner-up is at least 50% worse; otherwise "Face not found after rebuild"', async () => {
    const clear = await resolveFace({ ref: ref('gone'), shape: 1, names: { faces: ['X', 'Y'] }, lookup: lookupOf([plane(0, [0, 0, 10.1], [0, 0, 1]), plane(1, [0, 0, 300], [0, 0, 1])]) });
    expect(clear).toMatchObject({ ok: true, index: 0, how: 'signature', warning: 'Reference repaired · check' });
    const twins = await resolveFace({ ref: ref('gone'), shape: 1, names: { faces: ['X', 'Y'] }, lookup: lookupOf([plane(0, [1, 0, 10], [0, 0, 1]), plane(1, [-1, 0, 10], [0, 0, 1])]) });
    expect(twins).toEqual({ ok: false, message: 'Face not found after rebuild' });
    const otherKind = await resolveFace({ ref: ref('gone'), shape: 1, names: { faces: ['X'] }, lookup: lookupOf([cyl(0, [0, 0, 10], 5)]) });
    expect(otherKind).toEqual({ ok: false, message: 'Face not found after rebuild' });
  });
});
