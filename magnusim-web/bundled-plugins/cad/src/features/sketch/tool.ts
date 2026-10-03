// Picking profile regions in model mode: hovering a region pre-highlights it,
// a click selects it (a region item in the shared selection). Profiles toggle:
// a click on a region while only regions of that sketch are selected adds or
// removes it (proposal §3.4 "one click toggles a region"); otherwise it
// replaces the selection, as a click does in the core. Ctrl+click always
// toggles. A right-click selects the region under it before the menu opens;
// a double-click opens the region's sketch. Inactive in sketch mode
// (sketch mode's own tool takes the pointer there).
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { selectItem } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import type { SelectionItem } from '../../types/selection';
import type { ViewportTool } from '../../types/viewport';
import { regionUnder } from './pick';
import { profilesView } from './view';

export const REGION_TOOL_ID = 'profiles.pick';

/** Select a region as a click does (see the file header). */
export function clickRegion(services: AppServices, item: Extract<SelectionItem, { kind: 'region' }>, ctrl: boolean): void {
  const items = services.selection.get().items;
  const profilesOnly = items.length > 0 && items.every((it) => it.kind === 'region' && it.feature === item.feature);
  selectItem(services.selection, item, ctrl || profilesOnly);
}

export function regionTool(services: AppServices): ViewportTool {
  const view = profilesView(services);
  const setHover = (h: { feature: string; key: string } | null) => {
    const was = view.get().hover;
    if (was?.feature === h?.feature && was?.key === h?.key) return;
    view.set({ hover: h });
  };
  return {
    id: REGION_TOOL_ID,
    onPointer(e) {
      if (services.mode.get().mode === 'sketch') {
        setHover(null);
        return false;
      }
      if (e.type === 'leave') {
        setHover(null);
        return false;
      }
      if (e.type === 'move') {
        if (e.buttons) return false;
        const hit = regionUnder(services, e);
        setHover(hit ? { feature: hit.feature, key: hit.key } : null);
        // The region pre-highlights instead of the face behind it.
        return !!hit;
      }
      if (e.type === 'click' && e.button === 0) {
        const hit = regionUnder(services, e);
        if (!hit) return false;
        clickRegion(services, { kind: 'region', feature: hit.feature, key: hit.key }, e.ctrl);
        return true;
      }
      if (e.type === 'contextmenu') {
        // A right-click on a profile selects it first (as on a face), then the menu opens with what
        // acts on it ("Extrude profile"); the plane or face behind it is not what was clicked.
        const hit = regionUnder(services, e);
        if (!hit) return false;
        if (!services.selection.get().items.some((it) => it.kind === 'region' && it.feature === hit.feature && it.key === hit.key)) {
          selectItem(services.selection, { kind: 'region', feature: hit.feature, key: hit.key }, false);
        }
        services.bus.emit('viewport:contextmenu', { pick: null, clientX: e.clientX, clientY: e.clientY });
        return true;
      }
      if (e.type === 'dblclick') {
        const hit = regionUnder(services, e);
        if (!hit || !services.modules?.panelFor('sketch')) return false;
        services.bus.emit('ui:edit-feature', { feature: hit.feature });
        return true;
      }
      return false;
    },
  };
}
