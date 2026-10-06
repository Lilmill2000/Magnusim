// The UI shell's commands, key bindings and event handlers (install()).
// Honest UI: Parameters, Undo and Redo are registered once the document offers
// editing (at least one feature type). Feature commands (Sketch, Extrude,
// Enclosure, ...) come from their modules; the shell has none of its own since
// Box and Cylinder were removed (SD pass: no one-click solids).
// Command ids: modify.parameters, edit.undo, edit.redo.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { CommandDef } from '../types/commands';
import { clearSelection } from '../lib/selection';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import type { SelectionItem } from '../types/selection';
import { targetOfItem } from '../viewport/normal';
import { uiFor, type UiController } from './controller';
import { ICONS } from './Icon';
import type { MenuEntry } from './kit';

export const UNDO_ID = 'edit.undo';
export const REDO_ID = 'edit.redo';
export const PARAMS_ID = 'modify.parameters';

function historyCommands(services: AppServices, ui: UiController): CommandDef[] {
  const undo: CommandDef = {
    id: UNDO_ID,
    label: 'Undo',
    icon: ICONS.undo,
    shortcut: 'Ctrl+Z',
    // With a feature panel open, Undo undoes that panel's changes as one step
    // (a new feature goes away; Redo brings them back); earlier steps are
    // untouched until the next Undo.
    get hint() {
      const p = ui.state.get().panel;
      if (p?.kind === 'feature') return p.isNew ? 'Undo the new feature (Redo brings it back)' : 'Undo the changes made in the open panel (Redo brings them back)';
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
const ONE: Partial<Record<SelectionItem['kind'], string>> = { body: 'A body', vertex: 'A point', region: 'A profile', face: 'A face', edge: 'An edge' };
const MANY: Partial<Record<SelectionItem['kind'], string>> = { body: 'bodies', vertex: 'points', region: 'profiles', face: 'faces', edge: 'edges' };

/** What Delete does, for a selection it cannot remove (faces, edges, points, bodies, a plane). */
export function deleteHint(services: AppServices, ui: UiController, items: readonly SelectionItem[]): string {
  const item = items[0];
  if (item.kind === 'origin') return "The origin's planes and axes cannot be deleted.";
  const f = ui.featureOfItem(item);
  const name = f ? services.doc.state.get().doc.features.find((x) => x.id === f)?.name : null;
  if (item.kind === 'sketch') return name ? `Sketch geometry is deleted in the sketch: edit ${name}.` : 'Sketch geometry is deleted in its sketch.';
  // "An edge ...", "These 4 edges ..." (review P2/P3 round 1: "A edge", and the singular for 4 edges).
  const many = items.length > 1 && items.every((it) => it.kind === item.kind) && MANY[item.kind];
  if (many) return name ? `These ${items.length} ${many} cannot be deleted on their own. To remove them, delete ${name} in the history.` : `These ${items.length} ${many} cannot be deleted on their own: delete the feature that makes them.`;
  const what = ONE[item.kind] ?? `A ${item.kind}`;
  return name ? `${what} cannot be deleted on its own. To remove it, delete ${name} in the history.` : `${what} cannot be deleted on its own: delete the feature that makes it.`;
}

/** What F2 does, for a selection it cannot rename. */
function renameHint(item: SelectionItem): string {
  if (item.kind === 'origin') return "The origin's planes and axes cannot be renamed.";
  const what = item.kind === 'vertex' ? 'Points' : item.kind === 'sketch' ? 'Sketch entities' : item.kind === 'region' ? 'Profiles' : `${item.kind[0].toUpperCase()}${item.kind.slice(1)}s`;
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
    if (services.doc.features.all().length) for (const d of historyCommands(services, ui)) reg(d);
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
        // Only faces selected: "Delete faces and heal" when that module is there and can run (P2).
        if (!ids.length && items.length && items.every((it) => it.kind === 'face') && services.commands.canRun(WELL_KNOWN_COMMANDS.deleteFaces) === true) {
          void services.commands.run(WELL_KNOWN_COMMANDS.deleteFaces);
          return;
        }
        // Nothing Delete can remove is selected: say what it does instead of doing nothing (review round 3).
        if (!ids.length && items.length) services.bridge.toast(deleteHint(services, ui, items), 'info');
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
        if (pick && (pick.item.kind === 'face' || (pick.item.kind === 'origin' && !/^origin:[xyz]$/.test(pick.item.ref)))) {
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
        // P4b SELECT: a sketch right-clicked in the view (its profile, selected by the click): Normal to it.
        if (!pick) {
          const s = services.doc.state.get();
          // (Or a sketch picked by its curve, src/sketch/project/curve-pick.ts: a feature item of a sketch.)
          const it = services.selection.get().items.find((x) => x.kind === 'region' || x.kind === 'sketch' || (x.kind === 'feature' && s.doc.features.some((f) => f.id === x.feature && f.type === 'sketch')));
          const t = it ? targetOfItem(s, h, it) : null;
          if (t && t !== 'curved') items.push({ id: 'normal-to', label: `Normal to ${t.what}`, run: () => h.lookAt(t.normal, t.up) });
        }
        if (pick && (pick.item.kind === 'face' || pick.item.kind === 'edge' || pick.item.kind === 'vertex')) {
          const what = pick.item.kind === 'vertex' ? 'point' : pick.item.kind;
          const at = pick.point;
          items.push({ id: 'orbit-here', label: `Orbit around this ${what}`, run: () => h.orbitAround(at) });
        }
        if (items.length) items.push({ sep: true, id: 'sep-orbit' });
        items.push({ id: 'orbit-center', label: 'Orbit around model center', run: () => h.orbitAround('center') }, { id: 'orbit-origin', label: 'Orbit around origin', run: () => h.orbitAround([0, 0, 0]) });
      }
      const isSep = (e: MenuEntry | undefined) => !!e && 'sep' in e && e.sep === true;
      // Modules' items (Sketch on Plane 1, the CONSTRUCT actions, Delete faces, Press-pull, Measure,
      // Edit sketch, ...) right after the core's view items, then the body's and the feature's, and
      // the feature's Delete last of all (P4a review: Delete sat between the actions).
      if (items.length) items.push({ sep: true, id: 'sep-core' });
      for (const m of services.modules?.all() ?? []) {
        if (!m.contextMenu) continue;
        let extra: ReturnType<NonNullable<typeof m.contextMenu>> = [];
        try {
          extra = m.contextMenu(services, pick);
        } catch (err) {
          console.error(`[cad] context menu of ${m.id} failed`, err);
        }
        if (!extra.length) continue;
        if (items.length && !isSep(items[items.length - 1])) items.push({ sep: true, id: `sep-${m.id}` });
        items.push(...extra.map((e) => ({ id: `${m.id}:${e.id}`, label: e.label, disabled: e.disabled ?? null, run: e.run })));
      }
      let last: MenuEntry[] = [];
      if (pick) {
        const item = pick.item;
        if (item.kind === 'face' || item.kind === 'edge' || item.kind === 'vertex' || item.kind === 'body') {
          if (items.length && !isSep(items[items.length - 1])) items.push({ sep: true, id: 'sep-modules' });
          items.push(...ui.bodyMenu(item.body).filter((e) => e.id !== 'body-edit' && e.id !== 'sep-body-feature'));
        }
        const f = ui.featureOfItem(item);
        if (f) {
          const menu = ui.featureMenu(f);
          const del = menu.findIndex((e) => e.id === 'delete');
          // The Delete (and the separator before it) goes last.
          last = del >= 0 ? menu.slice(del > 0 && isSep(menu[del - 1]) ? del - 1 : del) : [];
          const rest = del >= 0 ? menu.slice(0, del > 0 && isSep(menu[del - 1]) ? del - 1 : del) : menu;
          if (items.length && !isSep(items[items.length - 1])) items.push({ sep: true, id: 'sep-body' });
          items.push(...rest);
        }
      } else {
        const fit = services.commands.get('view.fit');
        if (fit) {
          if (items.length && !isSep(items[items.length - 1])) items.push({ sep: true, id: 'sep-modules' });
          items.push({ id: 'view.fit', label: fit.label, run: () => void services.commands.run('view.fit') });
        }
      }
      items.push(...last);
      // No separator at either end, and none twice.
      while (items.length && isSep(items[items.length - 1])) items.pop();
      const clean = items.filter((e, i) => !(isSep(e) && (i === 0 || isSep(items[i - 1]))));
      ui.showMenu(clientX, clientY, clean);
    }),
  );

  return () => {
    for (const off of offs.splice(0)) off();
    ui.closePanel();
    ui.dispose();
  };
}
