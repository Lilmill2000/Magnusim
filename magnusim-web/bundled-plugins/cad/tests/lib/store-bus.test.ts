// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/lib/bus';
import { nextName, newId } from '../../src/lib/ids';
import { clearSelection, createSelectionStore, isPanelHighlight, isSelected, selectItem, showForPanel, userItems } from '../../src/lib/selection';
import { volumeListShown } from '../../src/ui/StatusDock';
import { createStateStore } from '../../src/lib/store';

describe('state store', () => {
  it('merges partials, skips no-op sets and notifies with prev', () => {
    const s = createStateStore({ a: 1, b: 'x' });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
    s.set({ a: 2 });
    expect(fn).toHaveBeenCalledWith({ a: 2, b: 'x' }, { a: 1, b: 'x' });
    s.set((p) => ({ ...p, b: 'y' }));
    expect(s.get()).toEqual({ a: 2, b: 'y' });
  });
});

describe('event bus', () => {
  it('delivers to listeners, once, and survives a throwing handler', () => {
    const bus = createBus<{ ping: { n: number } }>();
    const a = vi.fn();
    const once = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on('ping', () => {
      throw new Error('bad');
    });
    const off = bus.on('ping', a);
    bus.once('ping', once);
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    off();
    bus.emit('ping', { n: 3 });
    expect(a.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    expect(once).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('selection', () => {
  it('click replaces, ctrl+click toggles, clear empties', () => {
    const s = createSelectionStore();
    const top = { kind: 'origin', ref: 'origin:top' } as const;
    const front = { kind: 'origin', ref: 'origin:front' } as const;
    selectItem(s, top, false);
    selectItem(s, front, true);
    expect(s.get().items).toHaveLength(2);
    selectItem(s, top, true);
    expect(isSelected(s.get(), top)).toBe(false);
    selectItem(s, top, false);
    expect(s.get().items).toEqual([top]);
    clearSelection(s);
    expect(s.get().items).toEqual([]);
  });
});

describe('a panel highlight is not the user selection (P4a review)', () => {
  it('items a panel shows are not a preselection; any other write makes them the user own again', () => {
    const sel = createSelectionStore();
    const face = { kind: 'face' as const, body: 'b_1', index: 2 };
    showForPanel(sel, [face]);
    expect(sel.get().items).toEqual([face]);
    expect(isPanelHighlight(sel.get())).toBe(true);
    expect(userItems(sel)).toEqual([]);
    // The user clicks the same face: now it is theirs.
    selectItem(sel, face, false);
    expect(userItems(sel)).toEqual([face]);
    showForPanel(sel, [face]);
    sel.set({ items: [face] });
    expect(userItems(sel)).toEqual([face]);
    clearSelection(sel);
    expect(isPanelHighlight(sel.get())).toBe(false);
  });
});

describe('the volume list of many bodies (P4a review)', () => {
  it('the CFD bodies and the biggest are the ones shown, in their own order; a short list is kept as it is', () => {
    const b = (id: string, volume: number) => ({ id, name: id, volume });
    const five = [b('b1', 10), b('b2', 20), b('b3', 30), b('b4', 40), b('enc', 1)];
    expect(volumeListShown(five, new Set(['enc'])).map((x) => x.id)).toEqual(['b2', 'b3', 'b4', 'enc']);
    expect(volumeListShown(five).map((x) => x.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(volumeListShown([b('a', 1), b('z', 9)]).map((x) => x.id)).toEqual(['a', 'z']);
  });
});

describe('ids', () => {
  it('makes prefixed unique ids and next names', () => {
    const a = newId('f');
    expect(a).toMatch(/^f_[0-9a-z]{12}$/);
    expect(newId('f')).not.toBe(a);
    expect(nextName('Box', ['Box 1', 'Box 3', 'Cylinder 1'])).toBe('Box 4');
    expect(nextName('Box', [])).toBe('Box 1');
  });
});
