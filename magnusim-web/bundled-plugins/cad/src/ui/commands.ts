// The UI shell's commands, key bindings and event handlers (install()).
// Honest UI: a feature command is registered only for a feature type the
// document registered AND the UI has a panel for; Parameters, Undo and Redo
// only once the document offers such editing (at least one feature type).
// Command ids: solid.<type>, modify.parameters, edit.undo, edit.redo.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { CommandDef } from '../types/commands';
import type { FeatureType } from '../types/doc';
import { clearSelection } from '../lib/selection';
import type { SelectionItem } from '../types/selection';
import { PANEL_TYPES, uiFor, type UiController } from './controller';
import { ICONS } from './Icon';
import type { MenuEntry } from './kit';

const FEATURE_HINTS: Partial<Record<FeatureType, { hint: string; order: number }>> = {
  box: { hint: 'A box body from its size and corner position', order: 10 },
  cylinder: { hint: 'A cylinder body along an origin axis', order: 20 },
};

export const UNDO_ID = 'edit.undo';
export const REDO_ID = 'edit.redo';
export const PARAMS_ID = 'modify.parameters';

function featureCommand(ui: UiController, type: FeatureType, label: string, icon: string): CommandDef {
  const meta = FEATURE_HINTS[type];
  return {
    id: `solid.${type}`,
    label,
    group: 'solid',
    icon: icon || (ICONS as Record<string, string>)[type] || ICONS.part,
    hint: meta?.hint,
    order: meta?.order,
    enabled: () => ui.editBlock() ?? true,
    run: () => {
      const p = ui.state.get().panel;
      // Clicking the command of the new feature being edited just keeps it open.
      if (p?.kind === 'feature' && p.isNew && p.type === type) return;
      ui.openNew(type);
    },
  };
}

function historyCommands(services: AppServices, ui: UiController): CommandDef[] {
  const undo: CommandDef = {
    id: UNDO_ID,
    label: 'Undo',
    icon: ICONS.undo,
    shortcut: 'Ctrl+Z',
    // With a feature panel open, Undo cancels that panel's changes (a new
    // feature goes away); earlier steps are untouched until the next Undo.
    get hint() {
      const p = ui.state.get().panel;
      if (p?.kind === 'feature') return p.isNew ? 'Cancel the new feature' : 'Cancel the changes made in the open panel';
      const l = services.doc.state.get().history.undoLabel;
      return l ? `Undo ${l}` : undefined;
    },
    enabled: () => {
      const h = services.doc.state.get().history;
      return ui.editBlock() ?? (h.canUndo || ui.state.get().panel?.kind === 'feature' ? true : 'Nothing to undo');
    },
    run: () => {
      if (ui.state.get().panel?.kind === 'feature') ui.cancelPanel();
      else services.doc.undo();
    },
  };
  const redo: CommandDef = {
    id: REDO_ID,
    label: 'Redo',
    icon: ICONS.redo,
    shortcut: 'Ctrl+Y',
    get hint() {
      const l = services.doc.state.get().history.redoLabel;
      return l ? `Redo ${l}` : undefined;
    },
    enabled: () => {
      const h = services.doc.state.get().history;
      return ui.editBlock() ?? (h.canRedo ? true : 'Nothing to redo');
    },
    run: () => services.doc.redo(),
  };
  const params: CommandDef = {
    id: PARAMS_ID,
    label: 'Parameters',
    group: 'modify',
    icon: ICONS.params,
    hint: 'Named values that any size or position field can use',
    order: 10,
    enabled: () => ui.editBlock() ?? true,
    run: () => {
      if (ui.state.get().panel?.kind === 'params') ui.closePanel();
      else ui.openParams();
    },
  };
  return [undo, redo, params];
}

/** What Delete does, for a selection it cannot remove (a face, an edge, a point, a body, a plane). */
function deleteHint(services: AppServices, ui: UiController, item: SelectionItem): string {
  if (item.kind === 'origin') return 'The origin planes cannot be deleted.';
  const f = ui.featureOfItem(item);
  const name = f ? services.doc.state.get().doc.features.find((x) => x.id === f)?.name : null;
  const what = item.kind === 'body' ? 'A body' : item.kind === 'vertex' ? 'A point' : `A ${item.kind}`;
  return name ? `${what} cannot be deleted on its own. To remove it, delete ${name} in the history.` : `${what} cannot be deleted on its own: delete the feature that makes it.`;
}

/** What F2 does, for a selection it cannot rename. */
function renameHint(item: SelectionItem): string {
  if (item.kind === 'origin') return 'The origin planes cannot be renamed.';
  const what = item.kind === 'vertex' ? 'Points' : `${item.kind[0].toUpperCase()}${item.kind.slice(1)}s`;
  return `${what} have no names. F2 renames a feature or a body: select one in the tree.`;
}

/** Registers the UI's commands, key bindings and bus handlers. Returns an uninstall. */
export function installUi(services: AppServices): () => void {
  const ui = uiFor(services);
  const offs: (() => void)[] = [];
  const registered = new Set<string>();
  const reg = (def: CommandDef) => {
    if (registered.has(def.id)) return;
    registered.add(def.id);
    offs.push(services.commands.register(def));
  };

  const sync = () => {
    const defs = services.doc.features.all().filter((d) => PANEL_TYPES.includes(d.type));
    for (const d of defs) reg(featureCommand(ui, d.type, d.label, d.icon));
    if (defs.length) for (const d of historyCommands(services, ui)) reg(d);
  };
  sync();
  // Feature types may be registered when the document loads.
  offs.push(
    services.doc.state.subscribe((s, prev) => {
      if (s.status !== prev.status) sync();
    }),
  );

  const kb = services.keyboard;
  offs.push(
    // Ctrl+Shift+Z redoes too (the command's own shortcut is Ctrl+Y).
    kb.bind({ combo: 'Ctrl+Shift+Z', run: () => void services.commands.run(REDO_ID) }),
    kb.bind({
      combo: 'Escape',
      // From a field, only a panel's own fields pass Escape on (after reverting
      // what was typed, see NumberUnitInput); other inputs keep it.
      inInputs: true,
      run: (e) => {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName?.toLowerCase();
        if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !t?.closest('[data-cad-panel]')) return;
        const s = ui.state.get();
        if (s.menu) ui.closeMenu();
        else if (s.renaming) ui.endRename();
        else if (s.panel) ui.closePanel();
        else {
          // Nothing open: Escape lets go of the selection (review round 3), as a click on empty space does.
          clearSelection(services.selection);
          services.bus.emit('app:escape', {});
        }
      },
    }),
    kb.bind({
      combo: 'Delete',
      run: () => {
        const items = services.selection.get().items;
        const ids = items.flatMap((it) => (it.kind === 'feature' ? [it.feature] : []));
        for (const id of ids) ui.deleteFeature(id);
        // Nothing Delete can remove is selected: say what it does instead of doing nothing (review round 3).
        if (!ids.length && items.length) services.bridge.toast(deleteHint(services, ui, items[0]), 'info');
      },
    }),
    kb.bind({
      combo: 'F2',
      run: () => {
        const items = services.selection.get().items;
        const first = items.find((it) => it.kind === 'feature' || it.kind === 'body');
        if (first?.kind === 'feature') ui.startRename('feature', first.feature);
        else if (first?.kind === 'body') ui.startRename('body', first.body);
        else if (items.length) services.bridge.toast(renameHint(items[0]), 'info');
      },
    }),
  );

  offs.push(
    services.bus.on('ui:edit-feature', ({ feature }) => ui.openEdit(feature)),
    services.bus.on('viewport:dblclick', ({ pick }) => {
      const f = ui.featureOfItem(pick.item);
      if (f) ui.openEdit(f);
    }),
    services.bus.on('viewport:contextmenu', ({ pick, clientX, clientY }) => {
      const items: MenuEntry[] = [];
      // The core's viewport items come first (runtime.js showFaceCtxMenu,
      // shell.html:687-694): Normal to, Orbit around this point / model center /
      // origin. Its Hide face / Show all faces are not offered: CAD does not hide faces.
      const h = services.viewport.get().handle;
      if (h) {
        if (pick && (pick.item.kind === 'face' || pick.item.kind === 'origin')) {
          const n = h.planeNormal(pick.item);
          items.push({
            id: 'normal-to',
            label: 'Normal to',
            disabled: n ? null : 'Only flat faces can snap normal',
            run: () => {
              if (n) h.lookAt(n, Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]);
            },
          });
        }
        if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
          const what = pick.item.kind === 'vertex' ? 'point' : pick.item.kind;
          const at = pick.point;
          items.push({ id: 'orbit-here', label: `Orbit around this ${what}`, run: () => h.orbitAround(at) });
        }
        if (items.length) items.push({ sep: true, id: 'sep-orbit' });
        items.push({ id: 'orbit-center', label: 'Orbit around model center', run: () => h.orbitAround('center') }, { id: 'orbit-origin', label: 'Orbit around origin', run: () => h.orbitAround([0, 0, 0]) });
      }
      if (pick) {
        if (items.length) items.push({ sep: true, id: 'sep-core' });
        const item = pick.item;
        if (item.kind === 'face' || item.kind === 'edge' || item.kind === 'vertex' || item.kind === 'body') {
          items.push(...ui.bodyMenu(item.body).filter((e) => e.id !== 'body-edit' && e.id !== 'sep-body-feature'));
        }
        const f = ui.featureOfItem(item);
        if (f) {
          if (items.length) items.push({ sep: true, id: 'sep-body' });
          items.push(...ui.featureMenu(f));
        }
      } else {
        const fit = services.commands.get('view.fit');
        if (fit) {
          if (items.length) items.push({ sep: true, id: 'sep-core' });
          items.push({ id: 'view.fit', label: fit.label, run: () => void services.commands.run('view.fit') });
        }
      }
      ui.showMenu(clientX, clientY, items);
    }),
  );

  return () => {
    for (const off of offs.splice(0)) off();
    ui.closePanel();
    ui.dispose();
  };
}
