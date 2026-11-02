// Delete faces at a red exit (src/features/delete_faces/plan.ts, kernel API 8): what recognition
// says about the pick, with no kernel. The second way runs only for a version 2 Delete faces whose
// pick is exactly Analysis Situs' set at R (every fillet up to the largest picked radius, cliffs
// inside R included, nothing 'uncertain'), on one solid of at most 2,000 faces, Try repair not
// used; "the rest" is every fillet up to R when only part of it is picked (version 2), else the
// rest of the chains and holes the picks are part of; a mixed pick whose fillets alone qualify and
// a Delete faces saved before version 2 whose pick qualifies are told so. Rings (faces closing on
// themselves, which SuppressBlendsInc never takes off) in every fillet up to R: none of those
// sentences, and never that set as the rest; the words say the rings stop it (review 2026-11-02).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { groupRest, LEGACY_WORDS, limitOf, matchSet, planRed, radiusWords, readPick, ringWords, type RedPlanInput } from '../../../src/features/delete_faces/plan';
import type { RecognizeResult, RecognizedBlend } from '../../../src/types/kernel-protocol';

const MM = { length: 'mm', angle: 'deg' } as const;
const blend = (face: number, r: number, kind: RecognizedBlend['kind'] = 'ordinary', chain: number | null = 0): RecognizedBlend => ({ face, r, r_min: r, r_max: r, convex: true, kind, chain });
const rec = (blends: RecognizedBlend[], o: Partial<RecognizeResult> = {}): RecognizeResult => ({
  faces: 50,
  solids: 1,
  blends,
  chains: o.chains ?? [{ faces: blends.map((b) => b.face), r_min: 1, r_max: 2, length: 100 }],
  holes: o.holes ?? [],
  timings: { copy_ms: 0, aag_ms: 0, blends_ms: 0, holes_ms: 0 },
  ...o,
});
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
/** A rounded T-block's 40 blends R2, faces 10..49 (one chain). */
const T = rec(range(10, 50).map((i) => blend(i, 2, i >= 46 ? 'vertex' : 'ordinary')));
const input = (o: Partial<RedPlanInput>): RedPlanInput => ({ version: 2, repair: false, picks: range(10, 50), faces: 50, rec: T, atR: T, rings: null, bodyName: 'Body 1', units: MM, ...o });

describe('readPick and matchSet', () => {
  it('a pick reads as fillets (recognised blends, not uncertain: cliffs count, as the kernel counts them) and others, with the largest radius', () => {
    const r = rec([blend(3, 2), blend(4, 1.5, 'vertex'), blend(5, 1, 'cliff'), blend(6, 2.5, 'uncertain')]);
    expect(readPick(r, [6, 3, 7, 5, 4, 3])).toEqual({ fillets: [3, 4, 5], others: [6, 7], r: 2 });
    expect(readPick(r, [7])).toEqual({ fillets: [], others: [7], r: null });
    expect(limitOf(2)).toBeCloseTo(2.002, 12);
  });

  it("the set at R against the picked fillets: missing, extra (read as larger), cliffs among the missing, uncertain in the set", () => {
    const atR = rec([blend(1, 2), blend(2, 2), blend(3, 0.4, 'cliff'), blend(4, 1)]);
    expect(matchSet(atR, [1, 2, 3, 4])).toMatchObject({ size: 4, same: true, missing: [], extra: [], cliffs: 0, uncertain: 0 });
    expect(matchSet(atR, [1, 2])).toMatchObject({ same: false, missing: [3, 4], extra: [], cliffs: 1 });
    expect(matchSet(atR, [1, 2, 3, 4, 9])).toMatchObject({ same: false, missing: [], extra: [9] });
    expect(matchSet(rec([blend(1, 2), blend(2, 2, 'uncertain')]), [1])).toMatchObject({ same: false, uncertain: 1 });
  });

  it('the rest of the chains and holes the picked faces are part of', () => {
    const r = rec([blend(1, 2, 'ordinary', 0), blend(2, 2, 'ordinary', 0), blend(3, 1, 'ordinary', 1), blend(9, 1, 'ordinary', 2)], {
      chains: [{ faces: [1, 2], r_min: 2, r_max: 2, length: 10 }, { faces: [3], r_min: 1, r_max: 1, length: 5 }, { faces: [9], r_min: 1, r_max: 1, length: 5 }],
      holes: [{ faces: [5, 6, 9], d_min: 6, d_max: 6, through: false }],
    });
    expect(groupRest(r, [1])).toEqual({ faces: [2], fillets: true, holes: false });
    expect(groupRest(r, [5])).toEqual({ faces: [6, 9], fillets: false, holes: true });
    expect(groupRest(r, [1, 5])).toEqual({ faces: [2, 6, 9], fillets: true, holes: true });
    expect(groupRest(r, [3])).toEqual({ faces: [], fillets: false, holes: false });
  });
});

describe('planRed', () => {
  it('version 2, the pick is every fillet up to R: take them off as fillets, nothing said', () => {
    expect(planRed(input({}))).toEqual({ takeOff: true, r: 2, rest: [], sentences: [] });
  });

  it('never with Try repair used, on two solids, over 2,000 faces, with an uncertain face in the set, or without recognition', () => {
    expect(planRed(input({ repair: true })).takeOff).toBe(false);
    expect(planRed(input({ repair: true })).sentences).toEqual([]);
    const two = rec(T.blends, { solids: 2 });
    expect(planRed(input({ rec: two, atR: two })).takeOff).toBe(false);
    expect(planRed(input({ faces: 2001 })).takeOff).toBe(false);
    expect(planRed(input({ faces: 2000 })).takeOff).toBe(true);
    const withUncertain = rec([...T.blends, blend(9, 1, 'uncertain')]);
    expect(planRed(input({ atR: withUncertain })).takeOff).toBe(false);
    expect(planRed(input({ rec: null, atR: null }))).toEqual({ takeOff: false, r: null, rest: [], sentences: [] });
  });

  it('saved before version 2 and the pick qualifies: OCCT only, and the legacy words', () => {
    expect(planRed(input({ version: undefined }))).toEqual({ takeOff: false, r: 2, rest: [], sentences: [LEGACY_WORDS] });
    expect(LEGACY_WORDS).toBe('This Delete faces was made before Delete faces could take fillets off as fillets: a new Delete faces of these faces may do it');
  });

  it('version 2, part of every fillet up to R picked: the rest is the set, and the words say with all of them it can', () => {
    const p = planRed(input({ picks: range(11, 50) }));
    expect(p).toEqual({
      takeOff: false,
      r: 2,
      rest: [10],
      sentences: ['Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets'],
    });
    // Cliffs inside R (SuppressBlendsInc takes them; Find and Add by size never add them): named.
    const withCliffs = rec([...T.blends, blend(7, 0.4, 'cliff', 3), blend(8, 1, 'cliff', 4)]);
    const c = planRed(input({ atR: withCliffs, rec: withCliffs }));
    expect(c.rest).toEqual([7, 8]);
    expect(c.sentences).toEqual(['Every fillet up to R2 on Body 1 is 42 faces, including 2 rounds that are tangent on one side only, and 40 are picked: with all 42, Delete faces can take them off as fillets']);
    // A pick read as a larger fillet (not in the set): adding the rest would not do it, so the chain words instead.
    const extra = planRed(input({ atR: rec(T.blends.slice(1)) }));
    expect(extra.takeOff).toBe(false);
    expect(extra.sentences).toEqual([]);
  });

  it('saved before version 2, part of the fillets picked: the rest of their chain, never the promise of the second way', () => {
    const p = planRed(input({ version: undefined, picks: range(11, 50) }));
    expect(p).toEqual({ takeOff: false, r: 2, rest: [10], sentences: ['The picked faces are part of fillets with 1 more face'] });
  });

  it('a mixed pick whose fillets alone qualify: said, and the rest of its holes', () => {
    const r = rec(T.blends, { holes: [{ faces: [3, 4], d_min: 6, d_max: 6, through: true }] });
    const p = planRed(input({ rec: r, picks: [...range(10, 50), 3] }));
    expect(p.takeOff).toBe(false);
    expect(p.rest).toEqual([4]);
    expect(p.sentences).toEqual(['The fillets alone (40 faces, every fillet up to R2) can be taken off as fillets in a Delete faces of their own', 'The picked faces are part of holes with 1 more face']);
    // Not every fillet up to R among the picks: no mixed words.
    expect(planRed(input({ rec: r, picks: [...range(11, 50), 3] })).sentences).toEqual(['The picked faces are part of fillets and holes with 2 more faces']);
  });

  it('every fillet up to R holds rings (a hole rim, a boss foot): never "can take them off", never that set as the rest; the rings are named', () => {
    // A holed T-block: faces 48 and 49 are the hole's rim rings, each its own chain; 3 is the hole's wall.
    const ringed = rec(
      range(10, 50).map((i) => blend(i, 2, 'ordinary', i < 48 ? 0 : i - 47)),
      { chains: [{ faces: range(10, 48), r_min: 2, r_max: 2, length: 400 }, { faces: [48], r_min: 2, r_max: 2, length: 25 }, { faces: [49], r_min: 2, r_max: 2, length: 25 }], holes: [{ faces: [3, 48, 49], d_min: 8, d_max: 8, through: true }] },
    );
    const rings = new Set([3, 48, 49]);
    const at = { rec: ringed, atR: ringed, rings };
    const said = 'Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: 2 of the 40 are rings round a boss or a hole';
    // Every fillet but the rings picked: without the rings known, the promise and the rings as the rest (which the kernel would refuse).
    expect(planRed(input({ rec: ringed, atR: ringed, picks: range(10, 48) }))).toMatchObject({ rest: [48, 49], sentences: [expect.stringMatching(/with all 40, Delete faces can take them off as fillets$/)] });
    expect(planRed(input({ ...at, picks: range(10, 48) }))).toEqual({ takeOff: false, r: 2, rest: [], sentences: [said] });
    // A mixed pick (every fillet and the hole's wall): no "the fillets alone can be taken off".
    const mixed = planRed(input({ ...at, picks: [...range(10, 50), 3] }));
    expect(mixed.sentences).toEqual([said]);
    expect(mixed.rest).toEqual([]);
    expect(planRed(input({ rec: ringed, atR: ringed, picks: [...range(10, 50), 3] })).sentences).toEqual(['The fillets alone (40 faces, every fillet up to R2) can be taken off as fillets in a Delete faces of their own']);
    // Saved before version 2: not "a new Delete faces may do it".
    expect(planRed(input({ ...at, version: undefined }))).toEqual({ takeOff: false, r: 2, rest: [], sentences: [said] });
    // Version 2 with every fillet picked: the kernel is asked, and its refusal names the rings.
    expect(planRed(input(at))).toEqual({ takeOff: true, r: 2, rest: [], sentences: [] });
    // A ring outside the set changes nothing.
    expect(planRed(input({ picks: range(11, 50), rings: new Set([3]) })).rest).toEqual([10]);
  });

  it('the ring words: some, all, the one', () => {
    expect(ringWords('Body 1', 2, MM, 42, 1)).toBe('Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: 1 of the 42 is a ring round a boss or a hole');
    expect(ringWords('Body 1', 2, MM, 2, 2)).toBe('Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: all 2 are rings round a boss or a hole');
    expect(ringWords('Body 1', 2, MM, 1, 1)).toBe('Delete faces cannot take the fillets up to R2 on Body 1 off as fillets: it is a ring round a boss or a hole');
    expect(ringWords('flange', 2, { length: 'in', angle: 'deg' }, 1200, 2)).toBe('Delete faces cannot take the fillets up to R0.07874 in on flange off as fillets: 2 of the 1,200 are rings round a boss or a hole');
  });

  it('a hole picked in part (no fillet): the rest of the hole; nothing recognised: nothing said', () => {
    const r = rec([], { chains: [], holes: [{ faces: [3, 4, 5], d_min: 6, d_max: 11, through: false }] });
    expect(planRed(input({ rec: r, atR: null, picks: [3] }))).toEqual({ takeOff: false, r: null, rest: [4, 5], sentences: ['The picked face is part of holes with 2 more faces'] });
    expect(planRed(input({ rec: rec([], { chains: [] }), atR: null, picks: [3] }))).toEqual({ takeOff: false, r: null, rest: [], sentences: [] });
  });

  it("radii in the Part's units, four significant digits as the kernel's words", () => {
    expect(radiusWords(2, MM)).toBe('R2');
    expect(radiusWords(1.23456, MM)).toBe('R1.235');
    expect(radiusWords(2, { length: 'in', angle: 'deg' })).toBe('R0.07874 in');
    expect(planRed(input({ picks: range(11, 50), units: { length: 'in', angle: 'deg' } })).sentences[0]).toMatch(/^Every fillet up to R0\.07874 in on Body 1 is 40 faces/);
  });
});
