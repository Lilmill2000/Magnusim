// The document: public surface. createDocService (src/doc/service.ts) is the
// one owner of the model (schema v2, parameters, features, rebuild, undo,
// autosave, conflicts); install() registers the document's own commands.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';

export { createDocService, type DocServiceOptions } from './service';
export { createFeatureRegistry, createBuiltinRegistry } from './features/registry';
export { removedFeatureMessage, isRemovedFeature } from './features/removed';
export { OP_LABELS } from './features/body-op';
export { paramNameProblem } from './params';

/**
 * Undo and redo (Ctrl+Z; Ctrl+Y or Ctrl+Shift+Z). Keyboard commands with no
 * toolbar group; UI-SHELL may register buttons with the same ids (the later
 * registration wins). New-feature commands belong with their panels (UI-SHELL):
 * `services.doc.beginNew('extrude')` opens the session the panel edits.
 * Returns an uninstall.
 */
export function install(services: AppServices): () => void {
  const { commands, keyboard } = services;
  const offs = [
    commands.register({
      id: 'edit.undo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      enabled: (s) => {
        const ok = s.doc.editable();
        if (ok !== true) return ok;
        const h = s.doc.state.get().history;
        return h.canUndo || s.doc.state.get().session ? true : 'Nothing to undo';
      },
      hint: 'Undo the last change to the part',
      run: (s) => s.doc.undo(),
    }),
    commands.register({
      id: 'edit.redo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      enabled: (s) => {
        const ok = s.doc.editable();
        if (ok !== true) return ok;
        return s.doc.state.get().history.canRedo ? true : 'Nothing to redo';
      },
      hint: 'Redo the change you undid',
      run: (s) => s.doc.redo(),
    }),
    keyboard.bind({
      combo: 'Ctrl+Shift+Z',
      run: () => {
        void commands.run('edit.redo');
      },
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
