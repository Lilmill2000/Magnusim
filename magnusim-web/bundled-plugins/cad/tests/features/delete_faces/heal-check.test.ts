// @vitest-environment node
// The heal check's rules on their own (src/features/p2/heal-check.ts): a face not asked for that
// the history deletes is lost; added material whose faces come from such a face covers it (a
// touch along an edge, a sliver of area, does not count); a removed face standing on a kept face
// (a corner round on the plate it ends on) is told from one running along it (a fillet tangent to
// it); a large part or a slow defeature gets the history rule only, with no boolean, and says so;
// a boolean whose volumes do not add up is not trusted; the retry stops within its time. The
// real-kernel corpus: heal-check-real.test.ts.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHECK_SLOW_MS, checkHeal, coveredFaces, healRefused, lostFaces, normalAt, RETRY_BUDGET_MS, retryHoldBack, standsOn, UNCHECKED } from '../../../src/features/p2/heal-check';
import { LARGE_PART_FACES } from '../../../src/kernel/timeouts';
import type { BuildContext } from '../../../src/types/doc-service';
import type { OpHistory, TopoResult } from '../../../src/types/kernel-protocol';

const IN = 7;
const history = (deleted: number[]): OpHistory => ({ faces: [], edges: [], deleted: deleted.map((face) => ({ shape: IN, face })) });
type Face = TopoResult['faces'][number];

describe('heal check rules', () => {
  it('lost: deleted faces that were not asked for, of the input only', () => {
    const h = history([1, 2, 5]);
    h.deleted.push({ shape: 99, face: 3 }, { shape: IN, edge: 4 });
    expect(lostFaces(h, IN, [1, 2])).toEqual([5]);
    expect(lostFaces(h, IN, [1, 2, 5])).toEqual([]);
  });

  it('covered: added faces from input faces not asked for, by area; a sliver along an edge is a touch', () => {
    const added = {
      history: {
        faces: [
          { out: 0, from: [{ shape: IN, face: 1, how: 'same' as const }] },
          { out: 1, from: [{ shape: IN, face: 4, how: 'modified' as const }] },
          { out: 2, from: [{ shape: IN, face: 6, how: 'same' as const }] },
          { out: 3, from: [{ shape: 11, face: 0, how: 'modified' as const }] },
        ],
        edges: [],
        deleted: [],
      },
    };
    // Face 4 (not asked for) under 216 mm² of the added material: covered; face 6 under 1e-8 mm²: a touch.
    expect(coveredFaces(added, [500, 216, 1e-8, 900], IN, [1])).toEqual([4]);
    expect(coveredFaces(added, [500, 216, 1e-8, 900], IN, [1, 4])).toEqual([]);
    expect(healRefused({ lost: [], covered: [4], added: 1, unchecked: null })).toBe(true);
    expect(healRefused({ lost: [], covered: [], added: 0, unchecked: null })).toBe(false);
  });

  it('a round that ends on a face stands on it; a fillet tangent to a face, or a chamfer cut into it, runs along it', () => {
    const plate: Face = { i: 0, type: 'plane', normal: [0, 0, 1] };
    const wall: Face = { i: 1, type: 'plane', normal: [1, 0, 0] };
    // A vertical corner round R2 about x = 22, y = 17 (a boss's corner): its foot arc on the plate.
    const round: Face = { i: 2, type: 'cylinder', axis: { origin: [22, 17, 10], dir: [0, 0, 1] }, radius: 2 };
    const foot = [22 - Math.SQRT2, 17 - Math.SQRT2, 10];
    expect(normalAt(round, foot)!.map((x) => +x.toFixed(6))).toEqual([-0.707107, -0.707107, 0]);
    expect(standsOn(plate, round, foot)).toBe(true);
    // The same round's rail on the wall x = 20 (tangent there): runs along it.
    expect(standsOn(wall, round, [20, 17, 13])).toBe(false);
    // A 45 degree chamfer cut into the wall: runs along it (|cos| 0.71).
    const chamfer: Face = { i: 3, type: 'plane', normal: [Math.SQRT1_2, 0, Math.SQRT1_2] };
    expect(standsOn(wall, chamfer, [20, 0, 18])).toBe(false);
    // A torus tube's normal at a point; a B-spline face has none (not judged).
    const torus: Face = { i: 4, type: 'torus', axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, radius: 10, minor_radius: 2 };
    expect(normalAt(torus, [12, 0, 0])!.map((x) => +x.toFixed(6))).toEqual([1, 0, 0]);
    expect(normalAt(torus, [10, 0, 2])!.map((x) => +x.toFixed(6))).toEqual([0, 0, 1]);
    expect(standsOn(plate, { i: 5, type: 'bspline' }, foot)).toBeNull();
  });

  it('a part over LARGE_PART_FACES faces: the history rule only, no boolean, and it says so', async () => {
    const calls: string[] = [];
    const ctx = {
      faces: async () => LARGE_PART_FACES + 1,
      kernel: { call: async (op: string) => (calls.push(op), { result: {} }) },
      release: async () => {},
    } as unknown as BuildContext;
    const c = await checkHeal(ctx, IN, [1], { id: 8, history: history([1, 3]) });
    expect(c).toEqual({ lost: [3], covered: [], added: null, unchecked: UNCHECKED.large });
    expect(calls).toEqual([]);
  });

  it('after a defeature slower than CHECK_SLOW_MS: no boolean (it would take 1.7-1.8 times as long and meet the kernel limit), and it says so', async () => {
    const calls: string[] = [];
    const ctx = {
      faces: async () => 606,
      kernel: { call: async (op: string) => (calls.push(op), { result: {} }) },
      release: async () => {},
    } as unknown as BuildContext;
    const c = await checkHeal(ctx, IN, [1], { id: 8, history: history([1]) }, undefined, { defeatureMs: CHECK_SLOW_MS + 1 });
    expect(c).toEqual({ lost: [], covered: [], added: null, unchecked: UNCHECKED.slow });
    expect(calls).toEqual([]);
  });

  it("a cut that returned the whole result (its volume the body's own) is not trusted: no faces covered, the comparison said to have failed", async () => {
    // The wavy loft rounded R1: result 71,765.23 mm³, body 71,722.34, "added" 71,765.23 (all of the result).
    const volumes: Record<number, number> = { 7: 71722.34, 8: 71765.23, 9: 71765.23 };
    const ctx = {
      faces: async () => 10,
      kernel: {
        call: async (op: string, p: { id: number }) => {
          if (op === 'boolean') return { result: { id: 9, empty: false, history: { faces: [{ out: 0, from: [{ shape: IN, face: 2, how: 'same' }] }, { out: 1, from: [{ shape: IN, face: 3, how: 'same' }] }], edges: [], deleted: [] } } };
          if (op === 'topo') return { result: { faces: [{ i: 0, type: 'plane', area: 2400 }, { i: 1, type: 'bspline', area: 1800 }], edges: [], vertices: [] } };
          if (op === 'props') return { result: { volume: volumes[p.id] } };
          throw new Error(op);
        },
      },
      release: async () => {},
    } as unknown as BuildContext;
    const c = await checkHeal(ctx, IN, [1], { id: 8, history: history([1]) });
    expect(c).toEqual({ lost: [], covered: [], added: null, unchecked: UNCHECKED.failed });
    expect(healRefused(c)).toBe(false);
  });

  it('the retry stops within RETRY_BUDGET_MS on a slow part (each defeature 1.5 s here: 2 tries, not 8)', async () => {
    let clock = 0;
    const defeatures: number[][] = [];
    // Faces 0-7 picked, each next to face 9 (the one the heal covered).
    const edges = [...Array(8).keys()].map((i) => ({ i, type: 'line', faces: [i, 9] }));
    const ctx = {
      faces: async () => 455,
      kernel: {
        call: async (op: string, p: { faces: number[] }) => {
          if (op === 'topo') return { result: { faces: [], edges, vertices: [] } };
          if (op === 'defeature') {
            defeatures.push(p.faces);
            clock += 1500;
            throw Object.assign(new Error('BRepAlgoAPI_Defeaturing'), { kind: 'occt' });
          }
          throw new Error(op);
        },
      },
      release: async () => {},
    } as unknown as BuildContext;
    const r = await retryHoldBack(ctx, IN, [0, 1, 2, 3, 4, 5, 6, 7], [9], { costMs: 1500, now: () => clock });
    expect(r).toBeNull();
    expect(defeatures).toHaveLength(2);
    expect(clock).toBeLessThanOrEqual(RETRY_BUDGET_MS);
  });
});
