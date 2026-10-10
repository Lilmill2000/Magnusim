// ux010 (DRAW): which relation glyphs show (src/sketch/relations-view.ts relationShown).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { relationShown } from '../../src/sketch/relations-view';
import type { SketchEntity } from '../../src/types/doc';

const d = {
  entities: [
    { id: 'l1', kind: 'line', p: ['a', 'b'] },
    { id: 'l2', kind: 'line', p: ['b', 'c'] },
    { id: 'arc', kind: 'arc', c: 'k', a: 'c', b: 'e' },
    { id: 'pt', kind: 'point', p: 'z' },
  ] as SketchEntity[],
};
const none = new Set<string>();
const show = (c: { id: string; refs: string[] }, o: Partial<{ showAll: boolean; conflict: Set<string>; selected: Set<string>; hidden: Set<string> }> = {}) =>
  relationShown(d, c, { showAll: false, conflict: none, selected: none, ...o });

describe('relation glyphs', () => {
  it('none by default; those of the selection (its curves, their ends, a point entity); all with Show relations', () => {
    const h1 = { id: 'h1', refs: ['l1'] };
    const co = { id: 'co', refs: ['b', 'origin'] };
    const tg = { id: 'tg', refs: ['l2', 'arc'] };
    const onz = { id: 'onz', refs: ['z', 'l2'] };
    expect([h1, co, tg, onz].map((c) => show(c))).toEqual([false, false, false, false]);
    expect([h1, co, tg, onz].map((c) => show(c, { selected: new Set(['l1']) }))).toEqual([true, true, false, false]);
    expect(show(onz, { selected: new Set(['pt']) })).toBe(true);
    expect(show(onz, { selected: new Set(['z']) })).toBe(true);
    expect(show(tg, { selected: new Set(['tg']) })).toBe(true);
    expect([h1, co, tg, onz].every((c) => show(c, { showAll: true }))).toBe(true);
  });

  it('a conflict always shows; a fillet arc under its radius arrow hides its own unless Show relations is on', () => {
    const tg = { id: 'tg', refs: ['l2', 'arc'] };
    expect(show(tg, { conflict: new Set(['tg']) })).toBe(true);
    expect(show(tg, { conflict: new Set(['tg']), hidden: new Set(['arc']) })).toBe(true);
    expect(show(tg, { selected: new Set(['arc']), hidden: new Set(['arc']) })).toBe(false);
    expect(show(tg, { showAll: true, hidden: new Set(['arc']) })).toBe(true);
  });
});
