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

// ---- A panel's highlight is not the user's selection (P4a review)
//
// An open panel shows what its fields hold by writing it into the shared selection (the
// viewport highlights the selection). Those items are the panel's, not something the user
// selected: the next command must not take them as its preselection (the Fillet panel's
// face opened Chamfer with it and chamfered six edges). The arrays a panel writes are
// marked; any other write (a click, a row, Ctrl+click, a clear) makes a new array.

const shownByPanel = new WeakSet<readonly SelectionItem[]>();

/** Show `items` as the selection on a panel's behalf (marked as the panel's highlight). */
export function showForPanel(store: StateStore<Selection>, items: readonly SelectionItem[]): void {
  const arr = [...items];
  shownByPanel.add(arr);
  store.set((prev) => ({ ...prev, items: arr }));
}

/** Whether the selection is only a panel's highlight (showForPanel), not the user's choice. */
export function isPanelHighlight(sel: Selection): boolean {
  return sel.items.length > 0 && shownByPanel.has(sel.items);
}

/** What the user selected: the selection, or nothing while it only shows an open panel's picks. */
export function userSelection(sel: Selection): Selection {
  return isPanelHighlight(sel) ? { ...sel, items: [] } : sel;
}

/** The user's selected items (see userSelection). */
export function userItems(store: { get(): Selection }): SelectionItem[] {
  return userSelection(store.get()).items;
}
