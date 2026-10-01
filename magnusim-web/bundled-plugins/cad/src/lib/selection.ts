// Selection helpers over the shared selection store. Frozen (scaffold).
// Core conventions: a click replaces, Ctrl/Cmd+click toggles, a click on empty
// space clears (runtime.js applyCadPick).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from './store';
import { selectionKey, type Selection, type SelectionItem, type SelectKind } from '../types/selection';
import type { StateStore } from '../types/state';

export function createSelectionStore(): StateStore<Selection> {
  return createStateStore<Selection>({ items: [], filter: [] });
}

export function isSelected(sel: Selection, item: SelectionItem): boolean {
  const k = selectionKey(item);
  return sel.items.some((i) => selectionKey(i) === k);
}

/** Click (replace) or Ctrl+click (toggle). */
export function selectItem(store: StateStore<Selection>, item: SelectionItem, additive: boolean): void {
  store.set((prev) => {
    if (!additive) return { ...prev, items: [item] };
    const k = selectionKey(item);
    const has = prev.items.some((i) => selectionKey(i) === k);
    return { ...prev, items: has ? prev.items.filter((i) => selectionKey(i) !== k) : [...prev.items, item] };
  });
}

export function clearSelection(store: StateStore<Selection>): void {
  store.set((prev) => (prev.items.length ? { ...prev, items: [] } : prev));
}

export function setSelectionFilter(store: StateStore<Selection>, filter: SelectKind[]): void {
  store.set((prev) => ({ ...prev, filter }));
}

/** Whether a pick of `kind` passes the filter (empty filter = everything). */
export function passesFilter(sel: Selection, kind: SelectKind): boolean {
  return sel.filter.length === 0 || sel.filter.includes(kind);
}
