// P4b fix round 1 (TOOLBAR): the user's toolbar layout (src/ui/toolbar-layout.ts): defaults per
// mode, Move to More / Show in toolbar, reordering, reading a stored layout (unknown ids and
// malformed parts ignored), and new commands finding their place.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { emptyLayout, isDefault, orderIds, pinned, placeOf, readLayout, withMove, withPlace, type ModeLayout } from '../../src/ui/toolbar-layout';

const none = (): ModeLayout => ({ place: {}, order: {} });

describe('defaults', () => {
  it('every command on the bar in both modes (v0.5.0 ribbon, Daniel: "yes show the rest as small buttons")', () => {
    expect(placeOf('solid.extrude', none())).toBe('bar');
    expect(placeOf('solid.revolve', none())).toBe('bar');
    expect(placeOf('sketch.spline', none())).toBe('bar');
    expect(isDefault(emptyLayout().model)).toBe(true);
  });
});

describe('Move to More / Show in toolbar', () => {
  it('Show in toolbar is kept (it folds last); Move to More is kept', () => {
    let m = withPlace(none(), 'solid.revolve', 'bar');
    expect(m.place).toEqual({ 'solid.revolve': 'bar' });
    expect(pinned(m, 'solid.revolve')).toBe(true);
    expect(placeOf('solid.revolve', m)).toBe('bar');
    m = withPlace(m, 'solid.extrude', 'more');
    expect(placeOf('solid.extrude', m)).toBe('more');
    m = withPlace(m, 'solid.revolve', 'more');
    expect(m.place).toEqual({ 'solid.revolve': 'more', 'solid.extrude': 'more' });
    expect(pinned(m, 'solid.revolve')).toBe(false);
    // Sketch mode: everything is on the bar by default; Move to More is kept, and so is Show in toolbar
    // (a pin: when the ribbon is too narrow it folds after the others).
    const s = withPlace(none(), 'sketch.spline', 'more');
    expect(s.place).toEqual({ 'sketch.spline': 'more' });
    expect(withPlace(s, 'sketch.spline', 'bar').place).toEqual({ 'sketch.spline': 'bar' });
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

describe('v0.5.0 ribbon: group widths and rows', () => {
  it('a width is kept clamped and rounded, auto forgets it; rows 1 to 4, three is the default; both read back and count as a change', async () => {
    const { rowsOf, widthOf, withRows, withWidth, RIBBON_ROWS, MIN_GROUP_W, MAX_GROUP_W } = await import('../../src/ui/toolbar-layout');
    let m = withWidth(none(), 'draw', 180.4);
    expect(widthOf(m, 'draw')).toBe(180);
    expect(widthOf(m, 'constrain')).toBeNull();
    expect(isDefault(m)).toBe(false);
    expect(widthOf(withWidth(m, 'draw', 3), 'draw')).toBe(MIN_GROUP_W);
    expect(widthOf(withWidth(m, 'draw', 1e6), 'draw')).toBe(MAX_GROUP_W);
    m = withWidth(m, 'draw', null);
    expect(m.widths).toBeUndefined();
    expect(isDefault(m)).toBe(true);
    expect(rowsOf(m)).toBe(RIBBON_ROWS);
    m = withRows(m, 2);
    expect(rowsOf(m)).toBe(2);
    expect(rowsOf(withRows(m, 9))).toBe(4);
    expect(rowsOf(withRows(m, 0))).toBe(1);
    expect(withRows(m, 3).rows).toBeUndefined();
    expect(withRows(m, null).rows).toBeUndefined();
    const stored = readLayout({ version: 1, model: {}, sketch: { place: {}, order: {}, widths: { draw: 200, 'bad id!': 3, constrain: 'x', modify: 5 }, rows: 2 } });
    expect(stored.sketch.widths).toEqual({ draw: 200, modify: MIN_GROUP_W });
    expect(stored.sketch.rows).toBe(2);
    expect(readLayout({ version: 1, sketch: { rows: 7 } }).sketch.rows).toBeUndefined();
  });
});
