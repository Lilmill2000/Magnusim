// P4b fix round 1 (TOOLBAR): the user's toolbar layout (src/ui/toolbar-layout.ts): defaults per
// mode, Move to More / Show in toolbar, reordering, reading a stored layout (unknown ids and
// malformed parts ignored), and new commands finding their place.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { emptyLayout, isDefault, orderIds, pinned, placeOf, readLayout, withMove, withPlace, type ModeLayout } from '../../src/ui/toolbar-layout';

const KEEP = new Set(['solid.extrude', 'modify.fillet', 'sketch.line']);
const none = (): ModeLayout => ({ place: {}, order: {} });

describe('defaults', () => {
  it('model mode: only the main commands on the bar; sketch mode: everything', () => {
    expect(placeOf('solid.extrude', 'model', none(), KEEP)).toBe('bar');
    expect(placeOf('solid.revolve', 'model', none(), KEEP)).toBe('more');
    expect(placeOf('sketch.spline', 'sketch', none(), KEEP)).toBe('bar');
    expect(isDefault(emptyLayout().model)).toBe(true);
  });
});

describe('Move to More / Show in toolbar', () => {
  it('Show in toolbar is kept (it folds last); Move to More of a default-More command forgets the choice', () => {
    let m = withPlace(none(), 'solid.revolve', 'bar', 'model', KEEP);
    expect(m.place).toEqual({ 'solid.revolve': 'bar' });
    expect(pinned(m, 'solid.revolve')).toBe(true);
    expect(placeOf('solid.revolve', 'model', m, KEEP)).toBe('bar');
    m = withPlace(m, 'solid.extrude', 'more', 'model', KEEP);
    expect(placeOf('solid.extrude', 'model', m, KEEP)).toBe('more');
    m = withPlace(m, 'solid.revolve', 'more', 'model', KEEP);
    expect(m.place).toEqual({ 'solid.extrude': 'more' });
    // Sketch mode: everything is on the bar by default; Move to More is kept, and so is Show in toolbar
    // (a pin: when the ribbon is too narrow it folds after the others).
    const s = withPlace(none(), 'sketch.spline', 'more', 'sketch', KEEP);
    expect(s.place).toEqual({ 'sketch.spline': 'more' });
    expect(withPlace(s, 'sketch.spline', 'bar', 'sketch', KEEP).place).toEqual({ 'sketch.spline': 'bar' });
    expect(pinned(none(), 'sketch.spline')).toBe(false);
  });
});

describe('order', () => {
  const reg = ['a', 'b', 'c', 'd'];
  it('a stored order wins; ids it does not know are dropped; new ids follow their registry neighbour', () => {
    expect(orderIds(reg, undefined)).toEqual(reg);
    expect(orderIds(reg, ['c', 'a', 'b', 'd'])).toEqual(['c', 'a', 'b', 'd']);
    expect(orderIds(reg, ['gone', 'd', 'a'])).toEqual(['d', 'a', 'b', 'c']);
    // 'b' is new: after 'a' wherever 'a' is; 'a' new and first in the registry: at the start.
    expect(orderIds(reg, ['d', 'a', 'c'])).toEqual(['d', 'a', 'b', 'c']);
    expect(orderIds(reg, ['c', 'b', 'd'])).toEqual(['a', 'c', 'b', 'd']);
  });
  it('a move puts the command before another one, or at the end', () => {
    expect(withMove(none(), 'g', reg, 'd', 'a').order).toEqual({ g: ['d', 'a', 'b', 'c'] });
    expect(withMove(none(), 'g', reg, 'a', null).order).toEqual({ g: ['b', 'c', 'd', 'a'] });
    expect(withMove(none(), 'g', reg, 'b', 'd').order).toEqual({ g: ['a', 'c', 'b', 'd'] });
  });
});

describe('reading a stored layout', () => {
  it('keeps what it can read and drops the rest, never throws', () => {
    expect(readLayout(null)).toEqual(emptyLayout());
    expect(readLayout({ version: 2, model: { place: { x: 'bar' } } })).toEqual(emptyLayout());
    const l = readLayout({
      version: 1,
      model: { place: { 'solid.revolve': 'bar', 'bad id!': 'bar', 'solid.loft': 'side' }, order: { solid: ['solid.loft', 3, 'solid.loft', 'solid.extrude'], 'x y': ['a'] } },
      sketch: 'nonsense',
    });
    expect(l.model).toEqual({ place: { 'solid.revolve': 'bar' }, order: { solid: ['solid.loft', 'solid.extrude'] } });
    expect(l.sketch).toEqual({ place: {}, order: {} });
  });
});
