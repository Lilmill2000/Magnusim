// Picking for P2 panels and tools: while a panel's selection field is active,
// a viewport tool takes left clicks (no drag) and hands what is under the
// pointer to the field instead of the shared selection; orbit, pan, zoom and
// hover stay as they are. The selection filter follows the field ("Faces",
// "Bodies") while it is active and goes back to what it was after, as
// Fusion's command filters do. What the field holds is shown by mirroring it
// into the shared selection (the viewport highlights the selection).
// Owner: P2-FEATURES (shared by its panels; INTEGRATE may lift it into the kit).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import { setSelectionFilter } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import { selectionKey, type PickResult, type SelectionItem, type SelectKind } from '../../types/selection';
import type { ViewportHandle } from '../../types/viewport';

export interface PickerOptions {
  /** False: no tool (the field is not active). */
  active: boolean;
  /** What a click may pick while active (the selection filter). */
  kinds: SelectKind[];
  /** A click picked this (Ctrl held: `additive`). */
  onPick(pick: PickResult, additive: boolean): void;
  /** Tool id (tests, debugging). */
  id: string;
}

/** Push a pick tool on the viewport while `active`; the newest picker wins. */
export function usePicker(services: AppServices, opts: PickerOptions): void {
  const ref = useRef(opts);
  ref.current = opts;
  const kindsKey = opts.kinds.join(',');
  useEffect(() => {
    if (!opts.active) return;
    let pop: (() => void) | null = null;
    let handle: ViewportHandle | null = null;
    const attach = (h: ViewportHandle | null) => {
      if (h === handle) return;
      pop?.();
      pop = null;
      handle = h;
      if (!h) return;
      pop = h.pushTool({
        id: ref.current.id,
        cursor: 'pointer',
        onPointer(e) {
          // Clicks pick for the field; a double-click must not open another feature meanwhile.
          if (e.type === 'dblclick') return true;
          if (e.type !== 'click' || e.button !== 0) return false;
          const p = h.pick(e.clientX, e.clientY);
          if (p) ref.current.onPick(p, e.ctrl);
          return true;
        },
      });
    };
    attach(services.viewport.get().handle);
    const off = services.viewport.subscribe((s) => attach(s.handle));
    // The filter follows the field, and goes back afterwards unless the user changed it meanwhile.
    const before = services.selection.get().filter;
    const mine = kindsKey ? (kindsKey.split(',') as SelectKind[]) : [];
    setSelectionFilter(services.selection, mine);
    return () => {
      off();
      pop?.();
      const now = services.selection.get().filter;
      if (now.join(',') === mine.join(',')) setSelectionFilter(services.selection, before);
    };
  }, [services, opts.active, kindsKey]);
}

/**
 * Show `items` as the shared selection (the viewport highlights it) while the
 * panel is open; on close, a selection that is still ours is cleared.
 * Selection changes from elsewhere (a body row clicked in the tree) are passed
 * to `onOutside` with the items that are new, so a body field can take them;
 * items only taken out (a rebuild dropping a body) are not a pick.
 */
export function useSelectionMirror(services: AppServices, items: SelectionItem[], onOutside?: (items: SelectionItem[]) => void): void {
  const key = items.map(selectionKey).join('\n');
  const last = useRef<string>('');
  const outside = useRef(onOutside);
  outside.current = onOutside;
  useEffect(() => {
    last.current = key;
    const cur = services.selection.get().items.map(selectionKey).join('\n');
    if (cur !== key) services.selection.set({ items });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, key]);
  useEffect(() => {
    const off = services.selection.subscribe((s, prev) => {
      if (s.items === prev.items) return;
      const k = s.items.map(selectionKey).join('\n');
      if (k === last.current) return;
      // Items only taken out (a rebuild that no longer makes a body this panel's
      // feature removed) are not a pick: only what is new goes to the panel.
      const mine = new Set(last.current ? last.current.split('\n') : []);
      const added = s.items.filter((it) => !mine.has(selectionKey(it)));
      if (!added.length) {
        last.current = k;
        return;
      }
      outside.current?.(added);
    });
    return () => {
      off();
      const cur = services.selection.get().items.map(selectionKey).join('\n');
      if (cur === last.current && cur) services.selection.set({ items: [] });
    };
  }, [services]);
}

/** Toggle an item in a list (by selection key). */
export function toggleItem<T>(list: readonly T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  return list.some((x) => key(x) === k) ? list.filter((x) => key(x) !== k) : [...list, item];
}
