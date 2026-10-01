// Viewport public surface: the React host the layout mounts, and install().
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import './viewport.css';
import type { AppServices } from '../types/app';
import { viewportCommands } from './commands';

export { ViewportView } from './ViewportView';
export { createViewport, VIEWPORT_BG, DEFAULT_VIEW_DIR } from './viewport';

/** Register the viewport's commands (Fit, standard views, Normal to). Returns an uninstall. */
export function install(services: AppServices): () => void {
  const offs = viewportCommands().map((c) => services.commands.register(c));
  return () => {
    for (const off of offs) off();
  };
}
