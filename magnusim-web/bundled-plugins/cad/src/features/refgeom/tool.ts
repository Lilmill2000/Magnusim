// Hover and pick of CONSTRUCT items in model mode, through the shared selection:
// the pointer over a drawn plane, axis or point pre-highlights it (instead of
// the face behind it); a click selects it as `{ kind: 'feature', feature }`
// (Ctrl+click toggles), as its tree row does; a double-click opens its panel; a
// right-click selects it and opens the viewport's menu for it (the shell's
// feature items plus this module's "Sketch on Plane 1"). A body in front of it
// wins. Inactive in sketch mode, and when the selection filter leaves features out.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { isSelected, selectItem } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import type { ViewportHandle, ViewportPointer, ViewportTool } from '../../types/viewport';
import { constructOverlayOf } from './overlay';
import { constructUnder, type ConstructHit } from './pick';
import { constructView, isOriginAxis } from './scene';

export const CONSTRUCT_TOOL_ID = 'construct.pick';

export function constructTool(services: AppServices, handle: ViewportHandle): ViewportTool {
  const view = constructView(services);
  const setHover = (id: string | null) => {
    if (view.get().hover !== id) view.set({ hover: id });
  };
  const under = (e: ViewportPointer): ConstructHit | null => {
    const filter = services.selection.get().filter;
    if (filter.length && !filter.includes('feature')) return null;
    const drawn = constructOverlayOf(services)?.items() ?? [];
    return drawn.length ? constructUnder(handle, drawn, e) : null;
  };
  return {
    id: CONSTRUCT_TOOL_ID,
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
        const hit = under(e);
        setHover(hit?.feature ?? null);
        return !!hit;
      }
      if (e.type === 'click' && e.button === 0) {
        const hit = under(e);
        if (!hit) return false;
        selectItem(services.selection, isOriginAxis(hit.feature) ? { kind: 'origin', ref: hit.feature } : { kind: 'feature', feature: hit.feature }, e.ctrl);
        return true;
      }
      if (e.type === 'dblclick') {
        const hit = under(e);
        if (!hit) return false;
        // The origin's axes have no panel.
        if (!isOriginAxis(hit.feature)) services.bus.emit('ui:edit-feature', { feature: hit.feature });
        return true;
      }
      if (e.type === 'contextmenu') {
        const hit = under(e);
        if (!hit) return false;
        const item = isOriginAxis(hit.feature) ? { kind: 'origin' as const, ref: hit.feature } : { kind: 'feature' as const, feature: hit.feature };
        if (!isSelected(services.selection.get(), item)) selectItem(services.selection, item, false);
        services.bus.emit('viewport:contextmenu', { pick: { item, point: hit.point, normal: null, depth: hit.t, screen: [e.clientX, e.clientY] }, clientX: e.clientX, clientY: e.clientY });
        return true;
      }
      return false;
    },
  };
}
