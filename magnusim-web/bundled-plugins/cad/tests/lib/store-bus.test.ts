// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/lib/bus';
import { nextName, newId } from '../../src/lib/ids';
import { clearSelection, createSelectionStore, isSelected, selectItem } from '../../src/lib/selection';
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

describe('ids', () => {
  it('makes prefixed unique ids and next names', () => {
    const a = newId('f');
    expect(a).toMatch(/^f_[0-9a-z]{12}$/);
    expect(newId('f')).not.toBe(a);
    expect(nextName('Box', ['Box 1', 'Box 3', 'Cylinder 1'])).toBe('Box 4');
    expect(nextName('Box', [])).toBe('Box 1');
  });
});
