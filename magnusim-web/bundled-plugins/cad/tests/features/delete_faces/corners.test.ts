// Delete faces' third way (src/features/delete_faces/corners.ts, kernel API 9), with no kernel: the
// riders of picked rounds on made-up topology (a corner piece of another fillet across a round's
// cross edge, recognised or an unrecognised curved face between two kept blends; never a face
// across a spring edge, a plane, a boss's side the round only ends on, or the rest of the round's
// own fillet chain), spring edges of a cylinder and a torus, the groups the faces come off in, the
// history composed over two heals, and the chain bound's recognition over a rider that is one piece
// of a long chain.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { boundRecognition, composeHistory, groupsOf, isSpring, ridersFrom } from '../../../src/features/delete_faces/corners';
import { EDGE_FLAG, type OpHistory, type RecognizeResult, type RecognizedBlend, type TopoResult } from '../../../src/types/kernel-protocol';

type Face = TopoResult['faces'][number];
type Edge = TopoResult['edges'][number];
const blend = (face: number, r: number, kind: RecognizedBlend['kind'] = 'ordinary'): RecognizedBlend => ({ face, r, r_min: r, r_max: r, convex: true, kind, chain: 0 });
const recOf = (blends: RecognizedBlend[], chains: number[][]): Pick<RecognizeResult, 'blends' | 'chains'> => ({ blends, chains: chains.map((faces) => ({ faces, r_min: 1, r_max: 2, length: 10 })) });

// A round along y (face 0: a cylinder, axis along y) between two planes (1, 2) along its spring
// edges, ending at y = 0 on face 3 and at y = 36 on face 4 (its cross edges: circular arcs).
const ROUND: Face = { i: 0, type: 'cylinder', axis: { origin: [0, 0, 0], dir: [0, 1, 0] } } as Face;
const face = (i: number, type: Face['type']): Face => ({ i, type }) as Face;
const spring = (i: number, a: number, b: number): Edge => ({ i, type: 'line', faces: [a, b], dir: [0, 1, 0] }) as Edge;
const cross = (i: number, a: number, b: number, y: number): Edge => ({ i, type: 'circle', faces: [a, b], center: [0, y, 0], axis_dir: [0, 1, 0] }) as Edge;
const plain = (i: number, a: number, b: number): Edge => ({ i, type: 'bspline', faces: [a, b] }) as Edge;

describe('the riders of picked rounds', () => {
  it('a corner piece of another fillet across a cross edge rides on the round: a recognised blend, or an unrecognised curved face between two kept blends', () => {
    // 3: a B-spline corner piece recognised as a blend of the other fillet (chain [3, 5, 6]);
    // 4: an unrecognised B-spline face between two kept blends (5 and 6).
    const t = { faces: [ROUND, face(1, 'plane'), face(2, 'plane'), face(3, 'bspline'), face(4, 'bspline'), face(5, 'cylinder'), face(6, 'cylinder')], edges: [spring(0, 0, 1), spring(1, 0, 2), cross(2, 0, 3, 0), cross(3, 0, 4, 36), plain(4, 4, 5), plain(5, 4, 6), plain(6, 3, 5)] };
    const rec = recOf([blend(0, 1), blend(3, 1.02, 'vertex'), blend(5, 2), blend(6, 2)], [[0], [3, 5, 6]]);
    expect(ridersFrom(t, [], [0], rec)).toEqual([3, 4]);
  });

  it('never across a spring edge, a plane, a curved face the round only ends on (a boss side), a hidden edge, or the rest of its own chain', () => {
    // 1: a cylinder blend across a spring edge (a fillet the round rolls on); 3: a plane it ends on;
    // 4: a boss's cylindrical side it ends on (not a blend, no kept blends beside it); 5: across a
    // seam; 6: the next piece of the round's own chain (the rest, offered in words).
    const t = {
      faces: [ROUND, face(1, 'cylinder'), face(2, 'plane'), face(3, 'plane'), face(4, 'cylinder'), face(5, 'bspline'), face(6, 'torus')],
      edges: [spring(0, 0, 1), spring(1, 0, 2), cross(2, 0, 3, 0), cross(3, 0, 4, 36), cross(4, 0, 5, 36), cross(5, 0, 6, 36)],
    };
    const rec = recOf([blend(0, 1), blend(1, 2), blend(5, 1), blend(6, 1)], [[0, 6], [1], [5]]);
    expect(ridersFrom(t, [0, 0, 0, 0, EDGE_FLAG.seam, 0], [0], rec)).toEqual([]);
    // The same B-spline blend across a cross edge that is not hidden rides on it.
    expect(ridersFrom(t, [], [0], rec)).toEqual([5]);
  });

  it("a torus round's spring edges are circles about its axis; a cylinder's are lines along it; other picks have none", () => {
    const torus = { type: 'torus', axis: { origin: [0, 0, 0], dir: [0, 0, 1] } } as Face;
    expect(isSpring(torus, { type: 'circle', center: [0, 0, 5], axis_dir: [0, 0, -1] } as Edge)).toBe(true);
    expect(isSpring(torus, { type: 'circle', center: [3, 0, 0], axis_dir: [0, 1, 0] } as Edge)).toBe(false);
    expect(isSpring(torus, { type: 'line', dir: [0, 0, 1] } as Edge)).toBe(false);
    expect(isSpring(ROUND, { type: 'line', dir: [0, -1, 0] } as Edge)).toBe(true);
    expect(isSpring(ROUND, { type: 'circle', center: [0, 0, 0], axis_dir: [0, 1, 0] } as Edge)).toBe(false);
    expect(isSpring({ type: 'bspline' } as Face, { type: 'line', dir: [0, 1, 0] } as Edge)).toBeNull();
  });
});

describe('the goes, the history and the bound', () => {
  it('faces that share an edge come off together, each group in face order', () => {
    const t = { edges: [{ faces: [4, 0] }, { faces: [0, 9] }, { faces: [2, 7] }, { faces: [7, 7] }, { faces: [9, 1] }] as Edge[] };
    expect(groupsOf(t, [9, 0, 4, 2, 7, 5])).toEqual([[0, 4, 9], [2, 7], [5]]);
  });

  it('two heals composed: faces keep their sources on the body before, deleted faces are deleted, a face only generated stays generated', () => {
    // Body 1 (shape 1): faces 0..3. Heal 1 (-> shape 2) removes 1, grows 0, keeps 2, 3; heal 2 (-> 3) removes 2's image, grows 3's.
    const h1: OpHistory = { faces: [{ out: 0, from: [{ shape: 1, face: 0, how: 'modified' }] }, { out: 1, from: [{ shape: 1, face: 2, how: 'same' }] }, { out: 2, from: [{ shape: 1, face: 3, how: 'same' }] }], edges: [], deleted: [{ shape: 1, face: 1 }] };
    const h2: OpHistory = { faces: [{ out: 0, from: [{ shape: 2, face: 0, how: 'same' }] }, { out: 1, from: [{ shape: 2, face: 2, how: 'modified' }] }, { out: 2, from: [{ shape: 2, edge: 4, how: 'generated' }] }], edges: [], deleted: [{ shape: 2, face: 1 }] };
    const h = composeHistory(1, h1, 2, h2);
    expect(h.faces).toEqual([
      { out: 0, from: [{ shape: 1, face: 0, how: 'modified' }] },
      { out: 1, from: [{ shape: 1, face: 3, how: 'modified' }] },
      { out: 2, from: [] },
    ]);
    expect(h.deleted).toEqual([{ shape: 1, face: 1 }, { shape: 1, face: 2 }]);
  });

  it("the bound counts a rider's chain only by the rider's share of its area; whole chains as they are", () => {
    const rec = { ...recOf([blend(0, 1), blend(1, 2), blend(2, 2), blend(3, 2)], [[0], [1, 2, 3]]), faces: 10, solids: 1, holes: [], timings: { copy_ms: 0, aag_ms: 0, blends_ms: 0, holes_ms: 0 } } as RecognizeResult;
    const area = (f: number) => [5, 1, 3, 4][f];
    const b = boundRecognition(rec, [0, 1], area);
    expect(b.chains.map((c) => c.length)).toEqual([10, 1.25]);
    expect(boundRecognition(rec, [0, 1, 2, 3], area).chains.map((c) => c.length)).toEqual([10, 10]);
  });
});
