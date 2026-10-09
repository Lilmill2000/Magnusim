// UX 0.1.0 (TOOLBAR): a command dragged from its group's More onto the bar (src/ui/toolbar-layout.ts
// barDropOf, withSwapIn). Daniel's example: sketch DRAW shows Line, Rectangle, Circle, 3-point arc
// and Spline, Tangent arc is in More; dragging Tangent arc onto the bar puts it there and Spline
// goes to More, the bar keeping its count. Dropped between two bar commands it goes in there;
// dropped on the last slot or after it, it takes the last slot.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { barDropOf, held, isDefault, orderIds, placeOf, readLayout, withMove, withPlace, withSwapIn, type LayoutMode, type ModeLayout } from '../../src/ui/toolbar-layout';

const KEEP = new Set(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'pattern.linear', 'modify.fillet', 'modify.chamfer']);
const none = (): ModeLayout => ({ place: {}, order: {} });
// DRAW in the registry's order (sketch mode); at 1600 px the frame folds the others into More.
const DRAW = ['sketch.line', 'sketch.rectangle', 'sketch.rectangle-center', 'sketch.circle', 'sketch.arc', 'sketch.arc-tangent', 'sketch.centerline', 'sketch.point', 'sketch.spline', 'sketch.spline-control', 'sketch.construction'];
const SHOWN = ['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.spline'];

/** The group as the toolbar shows it: the bar (shown: placed on the bar and not folded by width), More. */
function view(m: ModeLayout, mode: LayoutMode, registry: string[], foldedByWidth: Set<string>) {
  const order = orderIds(registry, m.order.g);
  const bar = order.filter((id) => placeOf(id, mode, m, KEEP) === 'bar' && !(foldedByWidth.has(id) && m.place[id] !== 'bar'));
  return { bar, more: order.filter((id) => !bar.includes(id)) };
}

describe('barDropOf: where a More command lands and who leaves', () => {
  it('between two bar commands it goes in there; the bar\'s last leaves', () => {
    expect(barDropOf(SHOWN, 1)).toEqual({ before: 'sketch.rectangle', displaced: 'sketch.spline' });
    expect(barDropOf(SHOWN, 0)).toEqual({ before: 'sketch.line', displaced: 'sketch.spline' });
  });
  it('on the last slot or after it, it takes the last slot', () => {
    expect(barDropOf(SHOWN, 4)).toEqual({ before: 'sketch.spline', displaced: 'sketch.spline' });
    expect(barDropOf(SHOWN, 5)).toEqual({ before: 'sketch.spline', displaced: 'sketch.spline' });
    expect(barDropOf(SHOWN, 99)).toEqual({ before: 'sketch.spline', displaced: 'sketch.spline' });
    expect(barDropOf(SHOWN, -3)).toEqual({ before: 'sketch.line', displaced: 'sketch.spline' });
  });
  it('a group with nothing on the bar just takes it', () => {
    expect(barDropOf([], 0)).toEqual({ before: null, displaced: null });
  });
});

describe('withSwapIn: the group keeps its count on the bar', () => {
  // At 1600 px the frame folds these DRAW commands (FOLD_ORDER), Tangent arc among them.
  const folded = new Set(['sketch.rectangle-center', 'sketch.arc-tangent', 'sketch.centerline', 'sketch.point', 'sketch.spline-control', 'sketch.construction']);

  it("Daniel's example: Tangent arc onto the last slot, Spline to More", () => {
    const m = withSwapIn(none(), 'g', DRAW, SHOWN, 'sketch.arc-tangent', SHOWN.length, 'sketch', KEEP);
    expect(m.place).toEqual({ 'sketch.arc-tangent': 'bar', 'sketch.spline': 'more' });
    const v = view(m, 'sketch', DRAW, folded);
    expect(v.bar).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.arc-tangent']);
    expect(v.bar).toHaveLength(SHOWN.length);
    expect(v.more).toContain('sketch.spline');
    expect(v.more).not.toContain('sketch.arc-tangent');
  });

  it('dropped between Line and Rectangle it goes in there; Spline leaves', () => {
    const m = withSwapIn(none(), 'g', DRAW, SHOWN, 'sketch.arc-tangent', 1, 'sketch', KEEP);
    expect(view(m, 'sketch', DRAW, folded).bar).toEqual(['sketch.line', 'sketch.arc-tangent', 'sketch.rectangle', 'sketch.circle', 'sketch.arc']);
    // Its place in the group's order is kept (More lists the group in that order).
    expect(m.order.g.indexOf('sketch.arc-tangent')).toBe(m.order.g.indexOf('sketch.rectangle') - 1);
  });

  it('dropped before the last command it takes the last slot as well', () => {
    const m = withSwapIn(none(), 'g', DRAW, SHOWN, 'sketch.point', 4, 'sketch', KEEP);
    expect(view(m, 'sketch', DRAW, folded).bar).toEqual(['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.point']);
  });

  it('then back: the one that left can be dragged in again, and the count still holds', () => {
    let m = withSwapIn(none(), 'g', DRAW, SHOWN, 'sketch.arc-tangent', 5, 'sketch', KEEP);
    const v1 = view(m, 'sketch', DRAW, folded);
    m = withSwapIn(m, 'g', orderIds(DRAW, m.order.g), v1.bar, 'sketch.spline', 0, 'sketch', KEEP);
    const v2 = view(m, 'sketch', DRAW, folded);
    expect(v2.bar).toEqual(['sketch.spline', 'sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc']);
    expect(v2.more).toContain('sketch.arc-tangent');
  });

  it('model mode: a More command onto a one-command group takes its slot (PATTERN: Circular pattern for Linear pattern)', () => {
    const reg = ['pattern.linear', 'pattern.circular', 'pattern.mirror'];
    const m = withSwapIn(none(), 'g', reg, ['pattern.linear'], 'pattern.circular', 1, 'model', KEEP);
    expect(m.place).toEqual({ 'pattern.circular': 'bar', 'pattern.linear': 'more' });
    expect(view(m, 'model', reg, new Set()).bar).toEqual(['pattern.circular']);
  });

  it('model mode: a command the user had put on the bar leaves by forgetting the choice (its default is More)', () => {
    const reg = ['modify.fillet', 'modify.chamfer', 'modify.shell', 'modify.split'];
    let m = withPlace(none(), 'modify.shell', 'bar', 'model', KEEP);
    m = withSwapIn(m, 'g', reg, ['modify.fillet', 'modify.chamfer', 'modify.shell'], 'modify.split', 3, 'model', KEEP);
    expect(m.place).toEqual({ 'modify.split': 'bar' });
    expect(view(m, 'model', reg, new Set()).bar).toEqual(['modify.fillet', 'modify.chamfer', 'modify.split']);
  });

  it('nothing on the bar: it goes there and nothing leaves', () => {
    const reg = ['solid.extrude', 'solid.revolve'];
    const m = withSwapIn(withPlace(none(), 'solid.extrude', 'more', 'model', new Set(['solid.extrude'])), 'g', reg, [], 'solid.revolve', 0, 'model', new Set(['solid.extrude']));
    expect(m.place).toEqual({ 'solid.extrude': 'more', 'solid.revolve': 'bar' });
  });

  it('the result is stored in the same format (version 1, place and order) and reads back the same', () => {
    const m = withSwapIn(none(), 'draw', DRAW, SHOWN, 'sketch.arc-tangent', 1, 'sketch', KEEP);
    const stored = JSON.parse(JSON.stringify({ version: 1, model: none(), sketch: m }));
    expect(readLayout(stored).sketch).toEqual(m);
  });
});

describe('held: a command dragged onto the bar never folds for the width (review B2)', () => {
  it('a swap holds the command that came in; Move to More lets it go; Show in toolbar and a move keep the list', () => {
    let m = withSwapIn(none(), 'draw', DRAW, SHOWN.slice(0, 4), 'sketch.arc-tangent', 4, 'sketch', KEEP);
    // 1150 px: DRAW shows Line, Rectangle, Circle, 3-point arc; Tangent arc takes 3-point arc's slot.
    expect(m.place).toEqual({ 'sketch.arc-tangent': 'bar', 'sketch.arc': 'more' });
    expect(m.held).toEqual(['sketch.arc-tangent']);
    expect(held(m, 'sketch.arc-tangent')).toBe(true);
    expect(isDefault(m)).toBe(false);
    m = withMove(m, 'draw', DRAW, 'sketch.arc-tangent', 'sketch.line');
    m = withPlace(m, 'sketch.spline', 'bar', 'sketch', KEEP);
    expect(m.held).toEqual(['sketch.arc-tangent']);
    m = withPlace(m, 'sketch.arc-tangent', 'more', 'sketch', KEEP);
    expect(m.held).toBeUndefined();
    expect(held(m, 'sketch.arc-tangent')).toBe(false);
  });
  it('a held command swapped out is no longer held; the one coming in is', () => {
    let m = withSwapIn(none(), 'draw', DRAW, SHOWN, 'sketch.arc-tangent', 5, 'sketch', KEEP);
    m = withSwapIn(m, 'draw', orderIds(DRAW, m.order.draw), ['sketch.line', 'sketch.rectangle', 'sketch.circle', 'sketch.arc', 'sketch.arc-tangent'], 'sketch.point', 5, 'sketch', KEEP);
    expect(m.held).toEqual(['sketch.point']);
    expect(m.place['sketch.arc-tangent']).toBe('more');
  });
  it('read back from the stored prefs (an additive field; malformed entries dropped); absent when none', () => {
    const l = readLayout({ version: 1, model: { place: {}, order: {}, held: ['pattern.circular', 7, 'bad id!', 'pattern.circular'] }, sketch: { place: {}, order: {}, held: [] } });
    expect(l.model.held).toEqual(['pattern.circular']);
    expect('held' in l.sketch).toBe(false);
    expect(readLayout({ version: 1, model: { place: {}, order: {}, held: 'x' } }).model).toEqual({ place: {}, order: {} });
  });
});
