// Edge and vertex names (src/naming/edges.ts): splitting names whose faces hold an
// edge name themselves, the words panels show, and resolution by name then by
// signature (a clean match, a repair, a miss), against a scripted lookup.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { edgeWords, faceShortWords, resolveEdge, resolveVertex, splitEdgeName, splitVertexName, vertexWords } from '../../src/naming/edges';
import { edgeName, vertexName } from '../../src/naming/names';
import type { PersistentRef } from '../../src/types/doc';
import type { TopoResult } from '../../src/types/kernel-protocol';
import type { NamingLookup } from '../../src/types/naming';

const fn = (id: string) => ({ f_ex: 'Extrude 1', f_pp: 'Press-pull 1', f_fl: 'Fillet 1', f_imp: 'Imported 1' })[id] ?? null;

describe('splitting edge and vertex names', () => {
  it('splits a plain edge name and one whose face holds an edge name (a press-pull side)', () => {
    expect(splitEdgeName(edgeName('F:f_ex:end', 'F:f_ex:side:e_1[p:a>p:b]'))).toEqual(['F:f_ex:end', 'F:f_ex:side:e_1[p:a>p:b]']);
    const side = `F:f_pp:side:${edgeName('F:f_ex:start', 'F:f_ex:side:e_2[p:b>p:c]')}`;
    expect(splitEdgeName(edgeName(side, 'F:f_ex:end'))).toEqual(['F:f_ex:end', side]);
    expect(splitEdgeName(edgeName(side, 'F:z:end'))).toEqual([side, 'F:z:end']);
    // Two nested edges, merged faces.
    const fillet = `F:f_fl:fillet:${edgeName(side, 'F:f_ex:end')}`;
    expect(splitEdgeName(edgeName(fillet, `${side}|F:f_ex:end`))).toEqual([fillet, `${side}|F:f_ex:end`].sort());
    expect(splitEdgeName('F:f_ex:end')).toBeNull();
  });

  it('splits a vertex name into its faces, nested edge names kept whole', () => {
    const side = `F:f_pp:side:${edgeName('F:a:start', 'F:a:end')}`;
    const v = vertexName(['F:f_ex:end', side, 'F:f_ex:side:e_1']);
    expect(splitVertexName(v)?.sort()).toEqual(['F:f_ex:end', 'F:f_ex:side:e_1', side].sort());
  });
});

describe('words', () => {
  it('names faces shortly and edges by their two faces, sides numbered on the body', () => {
    const body = ['F:f_ex:start', 'F:f_ex:end', 'F:f_ex:side:e_1[p:a>p:b]', 'F:f_ex:side:e_2[p:b>p:c]', 'F:f_ex:side:e_10[p:c>p:a]'];
    expect(faceShortWords('F:f_ex:side:e_2[p:b>p:c]', body)).toEqual({ owner: 'f_ex', words: 'Side 2' });
    expect(faceShortWords('F:f_ex:side:e_10[p:c>p:a]', body).words).toBe('Side 3');
    expect(faceShortWords('F:f_imp:import:0:11').words).toBe('Face 12');
    expect(faceShortWords('F:f_fl:fillet:E:x&y#1').words).toBe('Fillet · part 2');
    expect(edgeWords(edgeName('F:f_ex:end', 'F:f_ex:side:e_2[p:b>p:c]'), fn, body)).toBe('End · Side 2 of Extrude 1');
    expect(edgeWords(edgeName('F:f_ex:end', 'F:f_pp:side:E:a&b'), fn, body)).toBe('End of Extrude 1 · Side of Press-pull 1');
    expect(edgeWords('F:f_ex:end', fn)).toBeNull();
    expect(vertexWords(vertexName(['F:f_ex:end', 'F:f_ex:side:e_1[p:a>p:b]', 'F:f_ex:side:e_2[p:b>p:c]']), fn, body)).toBe('Corner of End, Side 1 and Side 2 of Extrude 1');
  });
});

type TEdge = TopoResult['edges'][number];
const line = (i: number, faces: number[], mid: [number, number, number], dir: [number, number, number], length = 20): TEdge => ({ i, type: 'line', faces, mid, dir, length });

function lookup(edges: TEdge[], vertices: TopoResult['vertices'] = []): NamingLookup {
  return {
    faces: async () => [],
    edges: async (_s, ix) => (ix === 'all' ? edges : edges.filter((e) => ix.includes(e.i))),
    vertices: async (_s, ix) => (ix === 'all' ? vertices : vertices.filter((v) => ix.includes(v.i))),
  };
}
const ref = (name: string, mid: [number, number, number], dir: [number, number, number], length = 20): PersistentRef => ({ name, signature: { kind: 'edge', type: 'line', size: length, at: mid, dir } });

describe('resolving edge references', () => {
  const names = { faces: ['F:a:end', 'F:a:side:s1', 'F:a:side:s2', 'F:a:start'] };
  it('by name (moved by a dimension change: still clean), and by name among two edges of the same faces (nearest)', async () => {
    const r = await resolveEdge({ ref: ref(edgeName('F:a:end', 'F:a:side:s1'), [10, 0, 20], [1, 0, 0]), shape: 1, names, lookup: lookup([line(0, [0, 1], [15, 0, 20], [1, 0, 0], 30), line(1, [0, 2], [30, 10, 20], [0, 1, 0])]) });
    expect(r).toMatchObject({ ok: true, index: 0, how: 'name' });
    const two = await resolveEdge({ ref: ref(edgeName('F:a:end', 'F:a:side:s1'), [10, 0, 20], [1, 0, 0]), shape: 1, names, lookup: lookup([line(0, [0, 1], [10, 0, 20], [1, 0, 0]), line(1, [0, 1], [10, 40, 20], [1, 0, 0])]) });
    expect(two).toMatchObject({ ok: true, index: 0, how: 'name' });
  });

  it('a name whose edge turned another way is a repair; no name and nothing alike is a miss', async () => {
    const turned = await resolveEdge({ ref: ref(edgeName('F:a:end', 'F:a:side:s1'), [10, 0, 20], [1, 0, 0]), shape: 1, names, lookup: lookup([line(0, [0, 1], [10, 0, 20], [0, 1, 0])]) });
    expect(turned).toMatchObject({ ok: true, how: 'moved', warning: 'Reference repaired · check' });
    const gone = await resolveEdge({ ref: ref(edgeName('F:x:end', 'F:x:side:q'), [500, 0, 0], [0, 0, 1], 3), shape: 1, names, lookup: lookup([line(0, [0, 1], [10, 0, 20], [1, 0, 0]), line(1, [1, 2], [10, 9, 20], [1, 0, 0])]) });
    expect(gone).toEqual({ ok: false, message: 'Edge not found after rebuild' });
  });

  it('a face split in two (#0, #1) still finds its edge, with a warning', async () => {
    const split = { faces: ['F:a:end#0', 'F:a:side:s1', 'F:a:end#1'] };
    const r = await resolveEdge({ ref: ref(edgeName('F:a:end', 'F:a:side:s1'), [10, 0, 20], [1, 0, 0]), shape: 1, names: split, lookup: lookup([line(0, [0, 1], [5, 0, 20], [1, 0, 0], 10), line(1, [1, 2], [15, 0, 20], [1, 0, 0], 10)]) });
    expect(r).toMatchObject({ ok: true, how: 'moved' });
  });

  it('vertices resolve by their faces', async () => {
    const vref: PersistentRef = { name: vertexName(['F:a:end', 'F:a:side:s1', 'F:a:side:s2']), signature: { kind: 'vertex', type: 'vertex', at: [20, 0, 20] } };
    const r = await resolveVertex({ ref: vref, shape: 1, names, lookup: lookup([], [{ i: 0, p: [0, 0, 20], faces: [0, 1, 3] }, { i: 1, p: [25, 0, 20], faces: [0, 1, 2] }]) });
    expect(r).toMatchObject({ ok: true, index: 1, how: 'name' });
  });
});
