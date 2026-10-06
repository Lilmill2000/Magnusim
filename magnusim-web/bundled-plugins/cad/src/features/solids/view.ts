// What an open P4a solids panel shows in the view while it is open: the sketches
// it picks from (drawn even when hidden, and it does not count as their user), the
// profiles it uses (shaded as picked), the curves and axis it picked (the picks
// overlay), and its edges and faces (mirrored into the shared selection, which the
// viewport highlights). Everything goes back when the panel closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import type { AppServices } from '../../types/app';
import type { FeatureId } from '../../types/doc';
import type { SelectionItem } from '../../types/selection';
import { useSelectionMirror } from '../p2/pick';
import { profilesView, type RegionKey } from '../sketch/view';
import { PicksOverlay, type PickLine } from './overlay';

export function useSolidsView(services: AppServices, o: { feature: FeatureId; used: RegionKey[]; sketches: FeatureId[]; lines: PickLine[]; items: SelectionItem[] }): void {
  const usedKey = o.used.map((u) => `${u.feature}\n${u.key}`).join('\n');
  const sketchKey = o.sketches.join(',');
  useEffect(() => {
    profilesView(services).set({ used: o.used, forced: o.sketches, ignoreUser: o.feature });
  }, [usedKey, sketchKey, o.feature]);
  useEffect(
    () => () => {
      profilesView(services).set({ used: [], forced: [], ignoreUser: null, hover: null });
    },
    [],
  );
  usePicksLines(services, o.lines);
  useSelectionMirror(services, o.items);
}

/** Curves and axes an open panel picked, drawn in the picks overlay while it is open. */
export function usePicksLines(services: AppServices, pickLines: PickLine[]): void {
  const overlay = useRef<PicksOverlay | null>(null);
  const lines = useRef(pickLines);
  lines.current = pickLines;
  useEffect(() => {
    let h = services.viewport.get().handle;
    const attach = () => {
      h = services.viewport.get().handle;
      overlay.current?.dispose();
      overlay.current = h && typeof h.addLayer === 'function' ? new PicksOverlay(h) : null;
      overlay.current?.set(lines.current);
    };
    attach();
    const off = services.viewport.subscribe((s) => {
      if (s.handle !== h) attach();
    });
    return () => {
      off();
      overlay.current?.dispose();
      overlay.current = null;
    };
  }, [services]);
  const linesKey = JSON.stringify(pickLines);
  useEffect(() => {
    overlay.current?.set(pickLines);
  }, [linesKey]);
}
