// The Delete faces panel's Add by size in words (src/features/delete_faces/words.ts): the default
// sizes from the body's box diagonal (nice: the largest 1, 2 or 5 x 10^k not above), the body Add
// uses with none picked, and the result line, in mm and in inches.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { addedWords, addTarget, CLICK_A_FACE_FIRST, defaultSizes, DELETE_FACES_HINT, hasWords, nice, noneWords, rangeWords } from '../../../src/features/delete_faces/words';
import type { FeaturesSummary } from '../../../src/kernel/recognition';
import type { DocUnits } from '../../../src/types/units';

const MM = { length: 'mm', angle: 'deg' } as DocUnits;
const IN = { length: 'in', angle: 'deg' } as DocUnits;

describe('Add by size: default sizes', () => {
  it('nice() is the largest 1, 2 or 5 x 10^k not above x', () => {
    expect(nice(3.4)).toBe(2);
    expect(nice(8.5)).toBe(5);
    expect(nice(1)).toBe(1);
    expect(nice(0.999)).toBe(0.5);
    expect(nice(1000)).toBe(1000);
    expect(nice(999.9)).toBe(500);
    expect(nice(0.07)).toBe(0.05);
    expect(nice(0.002)).toBe(0.002);
    expect(nice(19.99)).toBe(10);
    expect(nice(0)).toBeNull();
    expect(nice(-3)).toBeNull();
    expect(nice(Number.NaN)).toBeNull();
  });

  it('fillets nice(d / 50), holes nice(d / 20), in the Part\'s unit', () => {
    // The plan's example: a 170 mm diagonal gives 2 mm and 5 mm.
    expect(defaultSizes(170, MM)).toEqual({ fillets: 2, holes: 5 });
    // The e2e block, 80 x 50 x 20: a 96.4 mm diagonal.
    expect(defaultSizes(Math.hypot(80, 50, 20), MM)).toEqual({ fillets: 1, holes: 2 });
    // In inches: 170 mm is 6.69 in: 0.1 in and 0.2 in.
    expect(defaultSizes(170, IN)).toEqual({ fillets: 0.1, holes: 0.2 });
    expect(defaultSizes(0, MM)).toBeNull();
  });
});

describe('Add by size: which body', () => {
  it('the field\'s body; else the Part\'s one solid body; else words', () => {
    expect(addTarget([{ id: 'b1', solids: 1 }, { id: 'b2', solids: 1 }], 'b2')).toEqual({ body: 'b2' });
    expect(addTarget([{ id: 'b1', solids: 1 }], '')).toEqual({ body: 'b1' });
    // A surface body beside it does not count; a body not measured yet counts as a solid.
    expect(addTarget([{ id: 'b1', solids: 0 }, { id: 'b2', solids: null }], '')).toEqual({ body: 'b2' });
    expect(addTarget([{ id: 'b1', solids: 1 }, { id: 'b2', solids: 1 }], '')).toEqual({ why: CLICK_A_FACE_FIRST });
    expect(addTarget([], '')).toEqual({ why: 'Click a face of the body first' });
  });
});

describe('Add by size: the line', () => {
  const summary: FeaturesSummary = { fillets: { faces: 6, r_min: 3, r_max: 5 }, holes: { count: 4, d_min: 8, d_max: 12 } };
  const none: FeaturesSummary = { fillets: { faces: 0, r_min: null, r_max: null }, holes: { count: 0, d_min: null, d_max: null } };

  it('says what was added: fillet chains and their radii, holes up to the size and how many go through', () => {
    expect(addedWords({ kind: 'fillets', faces: 12, chains: 3, r_min: 1.5, r_max: 2 }, MM)).toBe('Added 12 faces: 3 fillet chains, R1.5 to R2');
    expect(addedWords({ kind: 'fillets', faces: 1, chains: 1, r_min: 1.9999999, r_max: 2.0000001 }, MM)).toBe('Added 1 face: 1 fillet chain, R2');
    expect(addedWords({ kind: 'holes', faces: 8, holes: 4, through: 2, size: 6 }, MM)).toBe('Added 8 faces: 4 holes up to Ø6 mm (2 through)');
    expect(addedWords({ kind: 'holes', faces: 2, holes: 1, through: 0, size: 6 }, MM)).toBe('Added 2 faces: 1 hole up to Ø6 mm');
    expect(addedWords({ kind: 'fillets', faces: 4, chains: 1, r_min: 2.54, r_max: 2.54 }, IN)).toBe('Added 4 faces: 1 fillet chain, R0.1 in');
  });

  it('says what the body has when nothing new matched', () => {
    expect(noneWords('fillets', 2, 'Body 1', summary, MM)).toBe('No fillets up to 2 mm on Body 1 that are not already picked (Body 1 has 6 fillet faces, R3 to R5)');
    expect(noneWords('holes', 6, 'Body 1', summary, MM)).toBe('No holes up to Ø6 mm on Body 1 that are not already picked (Body 1 has 4 drilled holes, Ø8 to Ø12)');
    expect(noneWords('fillets', 2, 'flange', none, MM)).toBe('No fillets up to 2 mm on flange that are not already picked (flange has no fillets)');
    expect(noneWords('holes', 6, 'flange', none, MM)).toBe('No holes up to Ø6 mm on flange that are not already picked (flange has no drilled holes)');
    expect(hasWords('Body 1', 'fillets', { ...summary, fillets: { faces: 1, r_min: 25.4, r_max: 25.4 } }, IN)).toBe('Body 1 has 1 fillet face, R1 in');
    expect(rangeWords('Ø', 6, 10, MM)).toBe('Ø6 to Ø10');
  });

  it('the hint names both rows', () => {
    expect(DELETE_FACES_HINT).toBe('The faces around each deleted face grow to close the gap (holes, fillets, bosses). Fillets up to and Holes up to add faces by size.');
  });
});
