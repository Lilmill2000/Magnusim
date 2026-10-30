// @vitest-environment node
// The heal check's rules on their own (src/features/p2/heal-check.ts): a face not asked for that
// the history deletes is lost; added material whose faces come from such a face covers it (a
// touch along an edge, a sliver of area, does not count); a large part gets the history rule
// only, with no boolean (its cost there). The real-kernel corpus: heal-check-real.test.ts.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkHeal, coveredFaces, healRefused, lostFaces } from '../../../src/features/p2/heal-check';
import { LARGE_PART_FACES } from '../../../src/kernel/timeouts';
import type { BuildContext } from '../../../src/types/doc-service';
import type { OpHistory } from '../../../src/types/kernel-protocol';

const IN = 7;
const history = (deleted: number[]): OpHistory => ({ faces: [], edges: [], deleted: deleted.map((face) => ({ shape: IN, face })) });

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

  it('a part over LARGE_PART_FACES faces: the history rule only, no boolean', async () => {
    const calls: string[] = [];
    const ctx = {
      faces: async () => LARGE_PART_FACES + 1,
      kernel: { call: async (op: string) => (calls.push(op), { result: {} }) },
      release: async () => {},
    } as unknown as BuildContext;
    const c = await checkHeal(ctx, IN, [1], { id: 8, history: history([1, 3]) });
    expect(c).toEqual({ lost: [3], covered: [], added: null, unchecked: null });
    expect(calls).toEqual([]);
  });
});
