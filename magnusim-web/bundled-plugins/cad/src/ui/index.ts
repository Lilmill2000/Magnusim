// UI shell public surface: the components the layout frame mounts, and install().
// Owner: UI-SHELL. The layout (src/app/App.tsx) mounts exactly these exports:
// Toolbar (top row), LeftStack (floating column: tree card, flyout panel),
// StatusDock (bottom-left chips), Overlays (context menu, tooltip; last).
//
// install() registers (see ./commands.ts):
//   solid.<type>       for each feature type the document registered that has a
//                      UI panel (P1: box, cylinder); opens the panel via
//                      doc.beginNew(type)
//   modify.parameters  the Parameters panel      } only when at least one
//   edit.undo / redo   Ctrl+Z / Ctrl+Y (+Ctrl+Shift+Z) } feature type exists
// key bindings Escape (menu, rename, panel, else app:escape), Delete (selected
// features), F2 (rename the selected feature or body); and handles the events
// ui:edit-feature, viewport:dblclick and viewport:contextmenu.
// Ungrouped commands with an id starting "view." (VIEWPORT's) show in the
// toolbar's VIEW group.
// SPDX-License-Identifier: GPL-3.0-or-later
import './ui.css';
import type { AppServices } from '../types/app';
import { installUi } from './commands';

export { Toolbar } from './Toolbar';
export { DesignTree } from './tree/DesignTree';
export { LeftStack } from './LeftStack';
export { Overlays } from './Overlays';
export { StatusDock } from './StatusDock';
export { Icon, ICONS } from './Icon';
export { uiFor } from './controller';

/** Register the UI's commands, key bindings and event handlers. Returns an uninstall. */
export function install(services: AppServices): () => void {
  return installUi(services);
}
