// The viewport's commands: Fit (F), the standard views (1-7) and Normal to (N).
// They have no toolbar group: the keys and the views menu reach them.
// Ctrl+1..8 would be SOLIDWORKS' keys, but browsers keep those for tabs.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { CommandDef } from '../types/commands';
import type { Vec3 } from '../types/doc';
import type { Selection } from '../types/selection';
import type { StandardView, ViewportHandle } from '../types/viewport';

export const VIEW_COMMANDS: { view: StandardView; label: string; shortcut: string }[] = [
  { view: 'front', label: 'Front', shortcut: '1' },
  { view: 'back', label: 'Back', shortcut: '2' },
  { view: 'left', label: 'Left', shortcut: '3' },
  { view: 'right', label: 'Right', shortcut: '4' },
  { view: 'top', label: 'Top', shortcut: '5' },
  { view: 'bottom', label: 'Bottom', shortcut: '6' },
  { view: 'iso', label: 'Isometric', shortcut: '7' },
];

const NO_VIEWPORT = 'The viewport is not ready';

/** What Normal to would look at: the first selected planar face or origin plane, or why not. */
export function normalToTarget(sel: Pick<Selection, 'items'>, handle: Pick<ViewportHandle, 'planeNormal'>): { normal: Vec3; up: Vec3 } | { reason: string } {
  for (const it of sel.items) {
    if (it.kind !== 'face' && it.kind !== 'origin') continue;
    const n = handle.planeNormal(it);
    if (!n) continue;
    return { normal: n, up: Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1] };
  }
  return { reason: 'Select a planar face or a plane to look at it straight on' };
}

function viewport(s: AppServices): ViewportHandle | null {
  return s.viewport.get().handle;
}

export function viewportCommands(): CommandDef[] {
  const ready = (s: AppServices) => (viewport(s) ? true : NO_VIEWPORT);
  return [
    {
      id: 'view.fit',
      label: 'Fit',
      shortcut: 'F',
      hint: 'Frame the visible bodies, keeping the view direction',
      enabled: ready,
      run: (s) => viewport(s)?.fit(),
    },
    ...VIEW_COMMANDS.map(
      (v): CommandDef => ({
        id: `view.${v.view}`,
        label: `${v.label} view`,
        shortcut: v.shortcut,
        enabled: ready,
        run: (s) => viewport(s)?.setView(v.view),
      }),
    ),
    {
      id: 'view.normal-to',
      label: 'Normal to',
      shortcut: 'N',
      hint: 'Look straight at the selected planar face or plane',
      explainRefusal: true,
      enabled: (s) => {
        const h = viewport(s);
        if (!h) return NO_VIEWPORT;
        const t = normalToTarget(s.selection.get(), h);
        return 'reason' in t ? t.reason : true;
      },
      run: (s) => {
        const h = viewport(s);
        if (!h) return;
        const t = normalToTarget(s.selection.get(), h);
        if (!('reason' in t)) h.lookAt(t.normal, t.up);
      },
    },
  ];
}
