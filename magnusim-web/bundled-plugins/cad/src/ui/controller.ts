// The UI shell's own state and actions: which flyout panel is open (with its
// EditSession), the context menu, inline renames, and the feature actions the
// tree, the context menu, the keyboard and the viewport share. One controller
// per AppServices (uiFor), created by install() or on first use.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { isRemovedFeature, removedFeatureMessage } from '../doc/features/removed';
import { clearSelection, selectItem } from '../lib/selection';
import { createStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { EditSession } from '../types/doc-service';
import { FEATURE_ACTION_LABELS, type BodyId, type Feature, type FeatureAction, type FeatureId, type FeatureType } from '../types/doc';
import type { SelectionItem } from '../types/selection';
import type { StateStore } from '../types/state';
import { hideTip, type MenuEntry, type MenuItem } from './kit';
import { checkItemName } from './tree/names';
import { rollbackIndex, rollbackValue } from './tree/model';

/**
 * Whether some panel edits features of this type. Every feature type brings
 * its own panel in its module (services.modules.panelFor) and registers its
 * own commands; the shell has none of its own since Box and Cylinder were
 * removed (SD pass).
 */
export function hasPanel(services: AppServices, type: FeatureType): boolean {
  return !!services.modules?.panelFor(type);
}

export type PanelState =
  | { kind: 'feature'; session: EditSession; type: FeatureType; feature: FeatureId; isNew: boolean }
  | { kind: 'params' }
  /** A module's tool panel (Measure, Mass properties, Check, Export): not a feature, not undoable. */
  | { kind: 'tool'; tool: string };

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  label: string;
}

export interface UiState {
  panel: PanelState | null;
  /** A refused panel action, shown in the panel foot until the next action. */
  panelNote: string | null;
  menu: MenuState | null;
  /** The tree row being renamed in place. */
  renaming: { kind: 'feature' | 'body'; id: string } | null;
}

export interface UiController {
  readonly state: StateStore<UiState>;
  /** Why the model cannot be edited right now, or null. */
  editBlock(): string | null;
  /** Open the panel of a new feature (`init`: fields filled from the selection, select-first). */
  openNew(type: FeatureType, init?: Partial<Feature>): void;
  openEdit(id: FeatureId): void;
  openParams(): void;
  /** Open a module's tool panel (closes the open panel first, as any panel does). */
  openTool(id: string): void;
  /** Close the open panel: keep what applied (commit), or discard a new feature whose inputs are incomplete. */
  closePanel(): void;
  /** Undo inside a panel: undo what the session changed (a new feature goes away; Redo brings it back) and close. */
  cancelPanel(): void;
  /** The panel's Delete: discard a new feature, remove an existing one. */
  deletePanelFeature(): void;
  setPanelNote(note: string | null): void;
  renameFeature(id: FeatureId, next: string): string | null;
  renameBody(id: BodyId, next: string): string | null;
  startRename(kind: 'feature' | 'body', id: string): void;
  endRename(): void;
  toggleSuppressed(id: FeatureId): void;
  /** A failed feature's own fix ("Try repair", "Retry"). */
  runFeatureAction(id: FeatureId, action: FeatureAction): void;
  deleteFeature(id: FeatureId): void;
  rollBackTo(id: FeatureId): void;
  rollToEnd(): void;
  setRollbackIndex(index: number): void;
  setBodyVisible(id: BodyId, visible: boolean): void;
  featureMenu(id: FeatureId): MenuEntry[];
  bodyMenu(id: BodyId): MenuEntry[];
  showMenu(x: number, y: number, items: MenuEntry[], label?: string): void;
  closeMenu(): void;
  /** The feature a viewport pick belongs to (the one that last changed its body). */
  featureOfItem(item: SelectionItem): FeatureId | null;
  /** Report a failure the user must see ("Delete failed: …"). */
  fail(action: string, reason: string): void;
  dispose(): void;
}

const controllers = new WeakMap<AppServices, UiController>();

export function uiFor(services: AppServices): UiController {
  let c = controllers.get(services);
  if (!c) {
    c = createUiController(services);
    controllers.set(services, c);
  }
  return c;
}

function featureById(services: AppServices, id: FeatureId): Feature | undefined {
  return services.doc.state.get().doc.features.find((f) => f.id === id);
}

export function createUiController(services: AppServices): UiController {
  const { doc } = services;
  const state = createStateStore<UiState>({ panel: null, panelNote: null, menu: null, renaming: null });
  const offs: (() => void)[] = [];

  const fail = (action: string, reason: string) => {
    services.bridge.toast(`${action} failed: ${reason}`, 'error');
  };

  const editBlock = (): string | null => {
    const ok = doc.editable();
    return ok === true ? null : ok;
  };

  const featureName = (id: FeatureId) => featureById(services, id)?.name ?? 'the feature';

  /**
   * After a Delete: the later features that built before it and fail once the part is rebuilt
   * without it are named, with the way back (review P2/P3 round 2: deleting Combine 1 turned
   * Delete faces 1 and Press-pull 1 red, "Face not found after rebuild", and nothing said why).
   */
  function nameBrokenAfterDelete(id: FeatureId, name: string) {
    const s0 = doc.state.get();
    const builtBefore = new Set(s0.doc.features.filter((f) => f.id !== id && ['ok', 'warning'].includes(s0.rebuild.features[f.id]?.state ?? '')).map((f) => f.id));
    if (!builtBefore.size) return;
    const seq0 = s0.rebuild.seq;
    let done = false;
    const stop = () => {
      done = true;
      off();
      clearTimeout(timer);
    };
    const check = () => {
      const s = doc.state.get();
      if (done || s.rebuild.seq <= seq0 || s.rebuild.status === 'running' || s.doc.features.some((f) => f.id === id)) return;
      stop();
      const broken = s.doc.features.filter((f) => builtBefore.has(f.id) && s.rebuild.features[f.id]?.state === 'error').map((f) => f.name);
      if (!broken.length) return;
      const list = broken.length === 1 ? broken[0] : `${broken.slice(0, -1).join(', ')} and ${broken[broken.length - 1]}`;
      services.bridge.toast(`Deleted ${name}: ${list} ${broken.length === 1 ? 'fails' : 'fail'} without it. Undo (Ctrl+Z) brings ${name} back.`, 'error');
    };
    const off = doc.state.subscribe(check);
    const timer = setTimeout(stop, 120_000);
    offs.push(stop);
  }

  function closePanel() {
    const p = state.get().panel;
    if (!p) return;
    state.set({ panel: null, panelNote: null });
    if (p.kind === 'feature') {
      try {
        if (p.isNew && p.session.incomplete()) p.session.discard();
        else p.session.commit();
      } catch (err) {
        fail(p.isNew ? `Create ${featureName(p.feature)}` : `Edit ${featureName(p.feature)}`, errText(err));
      }
    }
    // Done: what the panel applied is written now (Back may follow at once).
    void doc.flush().catch(() => {});
  }

  function begin(fn: () => EditSession, type: FeatureType, action: string) {
    const block = editBlock();
    if (block) {
      fail(action, block);
      return;
    }
    closePanel();
    closeMenu();
    let session: EditSession;
    try {
      session = fn();
    } catch (err) {
      fail(action, errText(err));
      return;
    }
    if (!session.open) return;
    state.set({ panel: { kind: 'feature', session, type, feature: session.feature, isNew: session.isNew }, panelNote: null, renaming: null });
    selectItem(services.selection, { kind: 'feature', feature: session.feature }, false);
  }

  function closeMenu() {
    if (state.get().menu) state.set({ menu: null });
    hideTip();
  }

  /** Before acting on a feature from the tree or a menu: close a panel that edits a different one. */
  function settleOtherPanel(id: FeatureId | null) {
    const p = state.get().panel;
    if (p && (p.kind !== 'feature' || p.feature !== id)) closePanel();
  }

  const c: UiController = {
    state,
    editBlock,
    openNew(type, init) {
      const label = doc.features.get(type)?.label ?? type;
      begin(() => doc.beginNew(type, init), type, `New ${label}`);
    },
    openTool(id) {
      const p = state.get().panel;
      if (p?.kind === 'tool' && p.tool === id) return;
      if (!services.modules?.tool(id)) return;
      closePanel();
      closeMenu();
      state.set({ panel: { kind: 'tool', tool: id }, panelNote: null });
    },
    openEdit(id) {
      const p = state.get().panel;
      if (p?.kind === 'feature' && p.feature === id) return;
      const f = featureById(services, id);
      if (!f) return;
      // A removed type (Box, Cylinder): say so and what to do instead (SD pass).
      const removed = removedFeatureMessage(f);
      if (removed) {
        services.bridge.toast(`${removed}. Solids come from sketches now: delete it, then sketch the shape and extrude it.`, 'info');
        return;
      }
      // No panel edits this type (a module that is not installed): say so, never open another panel on it.
      if (!hasPanel(services, f.type)) {
        services.bridge.toast(`This version of Magnusim CAD cannot edit ${f.name}: no panel edits ${f.type} features`, 'info');
        return;
      }
      begin(() => doc.beginEdit(id), f.type, `Edit ${f.name}`);
    },
    openParams() {
      const p = state.get().panel;
      if (p?.kind === 'params') return;
      closePanel();
      closeMenu();
      state.set({ panel: { kind: 'params' }, panelNote: null });
    },
    closePanel,
    cancelPanel() {
      const p = state.get().panel;
      state.set({ panel: null, panelNote: null });
      if (p?.kind !== 'feature') return;
      try {
        // What Done would keep becomes one undo step, undone at once, so Redo brings it back (review
        // P2/P3 round 2: Ctrl+Z dropped the panel's changes, a new feature went away, and Redo could
        // not bring them back). A new feature still incomplete is only discarded.
        if (p.session.changed && p.session.incomplete() === null) {
          p.session.commit();
          doc.undo();
        } else p.session.discard();
      } catch (err) {
        fail(`Undo ${featureName(p.feature)}`, errText(err));
      }
    },
    deletePanelFeature() {
      const p = state.get().panel;
      if (!p || p.kind !== 'feature') return;
      const name = featureName(p.feature);
      if (p.isNew) {
        state.set({ panel: null, panelNote: null });
        try {
          p.session.discard();
        } catch (err) {
          fail(`Delete ${name}`, errText(err));
        }
        return;
      }
      // Refused (a later feature uses it): say why and keep the panel and its work
      // as they are. (Review P2/P3 round 1: the session was discarded first, so a
      // refused Delete threw away every edit made in the open sketch.)
      const block = doc.removeBlock(p.feature);
      if (block) {
        state.set({ panelNote: `Delete failed: ${block}` });
        return;
      }
      // Undo the session's own changes, then remove the feature: one undo step
      // brings back the feature as it was before the panel opened.
      try {
        p.session.discard();
      } catch (err) {
        fail(`Delete ${name}`, errText(err));
        state.set({ panel: null, panelNote: null });
        return;
      }
      const r = doc.remove(p.feature);
      state.set({ panel: null, panelNote: null });
      if (!r.ok) fail(`Delete ${name}`, r.reason);
      else nameBrokenAfterDelete(p.feature, name);
    },
    setPanelNote(note) {
      state.set({ panelNote: note });
    },
    renameFeature(id, next) {
      const check = checkItemName(next, doc.state.get().doc.features, id, 'feature');
      if (check.ok === 'same') return null;
      if (check.ok === false) return check.reason;
      const block = editBlock();
      if (block) return block;
      const p = state.get().panel;
      if (p?.kind === 'feature' && p.feature === id) {
        // Part of the open panel session (one undo step with its other edits).
        try {
          p.session.update({ name: check.name });
          return null;
        } catch (err) {
          return errText(err);
        }
      }
      settleOtherPanel(id);
      try {
        const r = doc.rename(id, check.name);
        return r.ok ? null : r.reason;
      } catch (err) {
        return errText(err);
      }
    },
    renameBody(id, next) {
      const d = doc.state.get().doc;
      const siblings = Object.entries(d.bodies).map(([bid, b]) => ({ id: bid, name: b.name }));
      const check = checkItemName(next, siblings, id, 'body');
      if (check.ok === 'same') return null;
      if (check.ok === false) return check.reason;
      const block = editBlock();
      if (block) return block;
      settleOtherPanel(null);
      try {
        const r = doc.renameBody(id, check.name);
        return r.ok ? null : r.reason;
      } catch (err) {
        return errText(err);
      }
    },
    startRename(kind, id) {
      closeMenu();
      state.set({ renaming: { kind, id } });
    },
    endRename() {
      if (state.get().renaming) state.set({ renaming: null });
    },
    toggleSuppressed(id) {
      const f = featureById(services, id);
      if (!f) return;
      const verb = f.suppressed ? 'Unsuppress' : 'Suppress';
      const block = editBlock();
      if (block) return fail(`${verb} ${f.name}`, block);
      settleOtherPanel(null);
      try {
        const r = doc.setSuppressed(id, !f.suppressed);
        if (!r.ok) fail(`${verb} ${f.name}`, r.reason);
      } catch (err) {
        fail(`${verb} ${f.name}`, errText(err));
      }
    },
    runFeatureAction(id, action) {
      const f = featureById(services, id);
      if (!f) return;
      const label = `${FEATURE_ACTION_LABELS[action]} ${f.name}`;
      try {
        const r = action === 'repair' ? doc.repair(id) : doc.retry(id);
        if (!r.ok) fail(label, r.reason);
      } catch (err) {
        fail(label, errText(err));
      }
    },
    deleteFeature(id) {
      const p = state.get().panel;
      if (p?.kind === 'feature' && p.feature === id) {
        c.deletePanelFeature();
        return;
      }
      const f = featureById(services, id);
      if (!f) return;
      const block = editBlock();
      if (block) return fail(`Delete ${f.name}`, block);
      settleOtherPanel(null);
      try {
        const r = doc.remove(id);
        if (!r.ok) fail(`Delete ${f.name}`, r.reason);
        else {
          // The deleted feature leaves the selection.
          services.selection.set((s) => ({ ...s, items: s.items.filter((it) => !(it.kind === 'feature' && it.feature === id)) }));
          nameBrokenAfterDelete(id, f.name);
        }
      } catch (err) {
        fail(`Delete ${f.name}`, errText(err));
      }
    },
    rollBackTo(id) {
      const feats = doc.state.get().doc.features;
      const i = feats.findIndex((f) => f.id === id);
      if (i < 0) return;
      c.setRollbackIndex(i + 1);
    },
    rollToEnd() {
      c.setRollbackIndex(doc.state.get().doc.features.length);
    },
    setRollbackIndex(index) {
      const count = doc.state.get().doc.features.length;
      const next = rollbackValue(index, count);
      if (rollbackValue(rollbackIndex(doc.state.get().view, count), count) === next) return;
      settleOtherPanel(null);
      try {
        doc.setRollback(next);
      } catch (err) {
        fail('Roll back', errText(err));
      }
    },
    setBodyVisible(id, visible) {
      try {
        doc.setBodyVisible(id, visible);
      } catch (err) {
        fail(visible ? 'Show body' : 'Hide body', errText(err));
        return;
      }
      // A hidden body leaves the selection, with its faces, edges and points
      // (review round 3: it stayed selected, out of sight, and the chip still measured it).
      if (!visible) {
        const gone = (it: SelectionItem) => (it.kind === 'body' || it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex') && it.body === id;
        if (services.selection.get().items.some(gone)) services.selection.set((s) => ({ ...s, items: s.items.filter((it) => !gone(it)) }));
      }
    },
    featureMenu(id) {
      const d = doc.state.get();
      const f = d.doc.features.find((x) => x.id === id);
      if (!f) return [];
      const index = d.doc.features.indexOf(f);
      const bar = rollbackIndex(d.view, d.doc.features.length);
      const block = editBlock();
      const rolledBack = index >= bar;
      const items: MenuEntry[] = [
        {
          id: 'edit',
          label: `Edit ${f.name}`,
          disabled: block ?? (isRemovedFeature(f) ? `${removedFeatureMessage(f)}. Solids come from sketches now: delete it, then sketch the shape and extrude it` : rolledBack ? `Roll forward to edit ${f.name}` : null),
          run: () => c.openEdit(id),
        },
        { id: 'rename', label: `Rename ${f.name}`, disabled: block, run: () => c.startRename('feature', id) },
        { id: 'suppress', label: `${f.suppressed ? 'Unsuppress' : 'Suppress'} ${f.name}`, disabled: block, run: () => c.toggleSuppressed(id) },
      ];
      for (const a of d.rebuild.features[id]?.actions ?? []) {
        items.push({ id: `action-${a}`, label: FEATURE_ACTION_LABELS[a], disabled: a === 'repair' ? block : null, run: () => c.runFeatureAction(id, a) });
      }
      items.push(
        { sep: true, id: 'sep-roll' },
        {
          id: 'rollback',
          label: 'Roll back to here',
          disabled: bar === index + 1 ? 'The rollback bar is already below this feature' : null,
          run: () => c.rollBackTo(id),
        },
      );
      if (bar < d.doc.features.length) items.push({ id: 'roll-end', label: 'Roll to end', run: () => c.rollToEnd() } satisfies MenuItem);
      // Refused while a later feature uses it: offered disabled, with the reason (review P2/P3 round 2:
      // "Delete Sketch 1" was offered, and only the click said no).
      items.push({ sep: true, id: 'sep-delete' }, { id: 'delete', label: `Delete ${f.name}`, danger: true, disabled: block ?? doc.removeBlock(id), run: () => c.deleteFeature(id) });
      return items;
    },
    bodyMenu(id) {
      const d = doc.state.get();
      const info = d.rebuild.bodies.find((b) => b.id === id);
      if (!info) return [];
      const hidden = d.view.hiddenBodies.includes(id);
      const block = editBlock();
      const f = d.doc.features.find((x) => x.id === info.feature);
      const items: MenuEntry[] = [
        { id: 'body-visibility', label: `${hidden ? 'Show' : 'Hide'} ${info.name}`, run: () => c.setBodyVisible(id, hidden) },
        { id: 'body-rename', label: `Rename ${info.name}`, disabled: block, run: () => c.startRename('body', id) },
      ];
      if (f) items.push({ sep: true, id: 'sep-body-feature' }, { id: 'body-edit', label: `Edit ${f.name}`, disabled: block, run: () => c.openEdit(f.id) });
      return items;
    },
    showMenu(x, y, items, label = 'Actions') {
      if (!items.length) return;
      hideTip();
      state.set({ menu: { x, y, items, label } });
    },
    closeMenu,
    featureOfItem(item) {
      if (item.kind === 'feature' || item.kind === 'sketch' || item.kind === 'region') return item.feature;
      if (item.kind === 'origin') return null;
      const b = doc.state.get().rebuild.bodies.find((x) => x.id === item.body);
      return b?.feature ?? null;
    },
    fail,
    dispose() {
      for (const off of offs) off();
    },
  };

  // The panel follows the document's session: a session the document ended
  // (undo and other edits commit it first; a reload drops it) closes the
  // panel; a session opened elsewhere (doc.beginEdit by another area) gets
  // its panel.
  offs.push(
    doc.state.subscribe((s) => {
      const p = state.get().panel;
      if (p?.kind === 'feature' && (!p.session.open || s.status !== 'ready')) {
        state.set({ panel: null, panelNote: null });
        return;
      }
      if (s.session && (p?.kind !== 'feature' || p.session.id !== s.session.id)) {
        const open = doc.session();
        if (open && open.open && open.id === s.session.id && hasPanel(services, open.draft.type)) {
          state.set({ panel: { kind: 'feature', session: open, type: open.draft.type, feature: open.feature, isNew: open.isNew }, panelNote: null });
        }
      }
    }),
  );
  // A rebuild that no longer makes a selected body (deleted, suppressed, rolled
  // back) drops the body and its faces, edges and vertices from the selection,
  // so nothing (the volume chip, the tree) reads a selection that is gone
  // (review round 2: the volume chip vanished).
  offs.push(
    doc.state.subscribe((s, prev) => {
      if (s.rebuild.seq === prev.rebuild.seq || s.status !== 'ready') return;
      const built = new Set(s.rebuild.bodies.map((b) => b.id));
      // Sketch items stay while their sketch is built (sketch mode prunes its own); a region while its key exists.
      const keep = (it: SelectionItem) => {
        if (it.kind === 'feature' || it.kind === 'origin') return true;
        if (it.kind === 'sketch') return !!s.rebuild.outputs?.[it.feature];
        if (it.kind === 'region') {
          const out = s.rebuild.outputs?.[it.feature];
          return !!out && out.type === 'sketch' && out.regions.some((r) => r.key === it.key);
        }
        return built.has(it.body);
      };
      if (services.selection.get().items.every(keep)) return;
      services.selection.set((sel) => ({ ...sel, items: sel.items.filter(keep) }));
    }),
  );
  // Opening a panel selects its feature (the viewport shows what is edited);
  // closing it lets go of that selection, unless the user picked more since.
  offs.push(
    state.subscribe((s, prev) => {
      const was = prev.panel?.kind === 'feature' ? prev.panel.feature : null;
      const now = s.panel?.kind === 'feature' ? s.panel.feature : null;
      if (!was || was === now) return;
      const items = services.selection.get().items;
      if (items.length === 1 && items[0].kind === 'feature' && items[0].feature === was) clearSelection(services.selection);
    }),
  );
  return c;
}

export function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/^Error:\s*/, '') || 'unknown error';
}
