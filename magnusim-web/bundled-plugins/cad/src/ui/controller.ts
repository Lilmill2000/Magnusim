// The UI shell's own state and actions: which flyout panel is open (with its
// EditSession), the context menu, inline renames, and the feature actions the
// tree, the context menu, the keyboard and the viewport share. One controller
// per AppServices (uiFor), created by install() or on first use.
// The Assistant opens panels through the person's own path (openForAssistant,
// openEditForAssistant, openParamsForAssistant, doneForAssistant,
// dropForAssistant), always behind the person: it never commits or replaces a
// panel the person has open (PersonEditing, thrown at once), except an idle
// Parameters panel, which gives way and comes back after. Its panels are
// read-only (PanelState.owner 'assistant'); the person's Escape, Ctrl+Z, a
// command or a change of its draft takes the panel over (discarded, never
// committed; doc.assistant.takeOver).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { keybindMenuItem } from './keybinds';
import { keyLabel } from '../app/keybinds';
import { dependencies } from '../doc/features/hooks';
import { isRemovedFeature, removedFeatureMessage } from '../doc/features/removed';
import { isPersonEditing, PersonEditing } from '../doc/person-editing';
import { openModal } from '../lib/modal';
import { pendingEdits } from '../lib/pendingEdits';
import { clearSelection, selectItem, showForPanel, userItems } from '../lib/selection';
import { targetOfItem } from '../viewport/normal';
import { seeThroughBy, seeThroughWhy } from '../viewport/bind';
import { createStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { AssistantStep, EditSession, TakeOverWhy } from '../types/doc-service';
import { FEATURE_ACTION_LABELS, type BodyId, type Feature, type FeatureAction, type FeatureId, type FeatureType } from '../types/doc';
import type { SelectionItem } from '../types/selection';
import type { StateStore } from '../types/state';
import { hideTip, type MenuEntry, type MenuItem, type PanelOwner } from './kit';
import { checkItemName } from './tree/names';
import { featureShown, rollbackIndex, rollbackValue, visibilityChoice } from './tree/model';

/**
 * Whether some panel edits features of this type. Every feature type brings
 * its own panel in its module (services.modules.panelFor) and registers its
 * own commands; the shell has none of its own since Box and Cylinder were
 * removed (SD pass).
 */
export function hasPanel(services: AppServices, type: FeatureType): boolean {
  return !!services.modules?.panelFor(type);
}

/**
 * The open flyout panel. `owner` 'assistant': the Assistant fills it, read-only for the person (a
 * feature panel's session is the step's; the Assistant's Parameters panel names the step in `by`).
 */
export type PanelState =
  | { kind: 'feature'; session: EditSession; type: FeatureType; feature: FeatureId; isNew: boolean; owner: PanelOwner }
  | { kind: 'params'; owner: PanelOwner; by?: string }
  /** A module's tool panel (Measure, Mass properties, Check, Export): not a feature, not undoable. */
  | { kind: 'tool'; tool: string; owner: PanelOwner };

/** A feature panel's owner: the Assistant's when its session is an Assistant step's. */
const ownerOf = (session: EditSession): PanelOwner => (session.owner ? 'assistant' : 'person');

/** The answer of an Assistant panel call after its step ended. */
const ENDED = 'This Assistant step has ended';

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
  label: string;
  /** Who opened it ("tb-more:modify": a toolbar group's More menu), so its button can show it open. */
  owner?: string;
  /** The button that opened it: a press on it toggles the menu, and Escape or Tab gives it the keyboard back. */
  anchor?: HTMLElement | null;
}

export interface MenuOptions {
  owner?: string;
  anchor?: HTMLElement | null;
}

export interface UiState {
  panel: PanelState | null;
  /** A refused panel action, shown in the panel foot until the next action. */
  panelNote: string | null;
  menu: MenuState | null;
  /** The tree row being renamed in place. */
  renaming: { kind: 'feature' | 'body'; id: string } | null;
  /** The body whose colour picker the context menu's "Colour" opens (the tree row opens it and clears this). */
  colorFor?: BodyId | null;
}

export interface UiController {
  readonly state: StateStore<UiState>;
  /** Why the model cannot be edited right now, or null. */
  editBlock(): string | null;
  /**
   * Edit in CAD: one more reason the model cannot be edited now (null when it can), asked after the
   * document's own; the returned function removes it.
   */
  addEditBlock(fn: () => string | null): () => void;
  /** Open the panel of a new feature (`init`: fields filled from the selection, select-first). */
  openNew(type: FeatureType, init?: Partial<Feature>): void;
  openEdit(id: FeatureId): void;
  openParams(): void;
  /** Open a module's tool panel (closes the open panel first, as any panel does). */
  openTool(id: string): void;
  /**
   * Close the open panel: keep what applied (commit), or discard a new feature whose inputs are incomplete.
   * On a panel the Assistant fills, the person takes it over (`why`, default 'escape'): discarded, never committed.
   */
  closePanel(opts?: { why?: TakeOverWhy }): void;
  /** Undo inside a panel: undo what the session changed (a new feature goes away; Redo brings it back) and close. On the Assistant's: a take-over ('undo'). */
  cancelPanel(): void;
  /** The panel's Delete: discard a new feature, remove an existing one. */
  deletePanelFeature(): void;
  setPanelNote(note: string | null): void;
  renameFeature(id: FeatureId, next: string): string | null;
  renameBody(id: BodyId, next: string): string | null;
  startRename(kind: 'feature' | 'body', id: string): void;
  endRename(): void;
  toggleSuppressed(id: FeatureId): void;
  /**
   * Move a feature in the history to `toIndex` (its index after the move), as a drag in the tree or
   * Move up / Move down does: the Part's own move with its order rule (a feature stays below what it
   * uses and above what uses it), as the Assistant's edit_feature move. Null, or the refusal's words.
   */
  moveFeature(id: FeatureId, toIndex: number): string | null;
  /** A body's colour ("#rrggbb"): one undo step, as the Assistant's body color. Null, or the refusal's words. */
  setBodyColor(id: BodyId, color: string): string | null;
  /** Open the tree's colour picker of a body (the context menu's Colour). */
  pickBodyColor(id: BodyId | null): void;
  /**
   * Delete several features in one undo step, the newest first, as the Assistant's delete: refused,
   * with nothing deleted, while a feature not among them uses one of them. One feature: deleteFeature.
   */
  deleteFeatures(ids: readonly FeatureId[]): void;
  /** A failed feature's own fix ("Try repair", "Retry"). */
  runFeatureAction(id: FeatureId, action: FeatureAction): void;
  deleteFeature(id: FeatureId): void;
  rollBackTo(id: FeatureId): void;
  rollToEnd(): void;
  setRollbackIndex(index: number): void;
  setBodyVisible(id: BodyId, visible: boolean): void;
  /**
   * Draw bodies see-through (on) or opaque again: INSPECT > See-through and the body's menu (view
   * state kept with the Part, no undo step; the Assistant's workspace see_through and opaque). A
   * body its feature always draws see-through (an Enclosure) stays so. Null when it applied, else
   * why nothing changed (the caller says it: a toast, the Assistant's error).
   */
  setBodiesSeeThrough(ids: readonly BodyId[], on: boolean): string | null;
  /**
   * Show or hide a sketch, or a reference plane, axis or point, in the view (its row's eye and its
   * menu's Hide / Show; view state, no undo step). A hidden reference still serves the features
   * built on it and is picked from the tree. A no-op for a feature with no eye.
   */
  setFeatureVisible(id: FeatureId, visible: boolean): void;
  /** LINK: the body's "Include in simulation" toggle (one undo step). */
  setBodyInSimulation(id: BodyId, include: boolean): void;
  /**
   * Delete bodies (the body menu's Delete, the Delete key with only bodies selected): one Delete
   * body feature for all of them at the rollback bar, one undo step, as the Assistant's direct
   * delete_body. Bodies not built now are left out; none left: nothing happens.
   */
  deleteBodies(ids: readonly BodyId[]): void;
  featureMenu(id: FeatureId): MenuEntry[];
  bodyMenu(id: BodyId): MenuEntry[];
  showMenu(x: number, y: number, items: MenuEntry[], label?: string, opts?: MenuOptions): void;
  closeMenu(): void;
  /** The feature a viewport pick belongs to (the one that last changed its body). */
  featureOfItem(item: SelectionItem): FeatureId | null;
  /** Report a failure the user must see ("Delete failed: …"). */
  fail(action: string, reason: string): void;
  /**
   * The Assistant's New feature, on the person's path (the panel, the tree row, the live rebuild),
   * read-only. Throws PersonEditing at once while the person has a menu, a rename, a dialog or a
   * panel open (an idle Parameters panel gives way and comes back after); returns the session, or
   * why it could not open. Never toasts.
   */
  openForAssistant(step: AssistantStep, type: FeatureType, init?: Partial<Feature>): EditSession | string;
  /** The Assistant's Edit of a feature: as openForAssistant, through beginEdit. */
  openEditForAssistant(step: AssistantStep, id: FeatureId): EditSession | string;
  /**
   * The Assistant's read-only Parameters panel (watch pace), when no panel is open; it closes when the
   * step ends. Null also when an idle Parameters panel is open already (it shows the new values live).
   * Else why not; PersonEditing as openForAssistant (a value typed in that panel included).
   */
  openParamsForAssistant(step: AssistantStep): string | null;
  /**
   * Done on the Assistant's panel, honestly: an incomplete feature keeps nothing (discarded) and its
   * reason is returned; else it is committed and null returned (or why it is not in the part). No flush.
   */
  doneForAssistant(step: AssistantStep): string | null;
  /** Close this step's Assistant panel, keeping nothing of its session. A no-op once the step ended. */
  dropForAssistant(step: AssistantStep): void;
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

  // Edit in CAD: other reasons (the Part being opened on a project geometry).
  const blocks = new Set<() => string | null>();
  const editBlock = (): string | null => {
    const ok = doc.editable();
    if (ok !== true) return ok;
    for (const fn of blocks) {
      const why = fn();
      if (why) return why;
    }
    return null;
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
      const undoKey = keyLabel(services, 'edit.undo');
      services.bridge.toast(`Deleted ${name}: ${list} ${broken.length === 1 ? 'fails' : 'fail'} without it. Undo${undoKey ? ` (${undoKey})` : ''} brings ${name} back.`, 'error');
    };
    const off = doc.state.subscribe(check);
    const timer = setTimeout(stop, 120_000);
    offs.push(stop);
  }

  // An idle Parameters panel of the person's that gave way to an Assistant panel comes back when that
  // panel closes by itself (Done, dropped, its step ended) or by the person's Escape or Ctrl+Z on it;
  // any other action of the person's (a command, a tree action) forgets it.
  let paramsBack = false;
  function giveBackParams() {
    if (!paramsBack || state.get().panel) return;
    paramsBack = false;
    if (doc.state.get().status !== 'ready') return;
    state.set({ panel: { kind: 'params', owner: 'person' }, panelNote: null });
  }

  /** The person took over the Assistant's panel: it goes, never committed (its session is discarded). */
  function takeOverPanel(p: PanelState, why: TakeOverWhy) {
    if (why === 'command' || why === 'draft') paramsBack = false;
    state.set({ panel: null, panelNote: null });
    try {
      doc.assistant.takeOver(why, p.kind === 'params' && p.by ? { owner: p.by } : undefined);
    } catch (err) {
      fail('Take over from the Assistant', errText(err));
    }
    giveBackParams();
  }

  function closePanel(opts: { why?: TakeOverWhy } = {}) {
    const p = state.get().panel;
    if (!p) return;
    if (p.owner === 'assistant') {
      takeOverPanel(p, opts.why ?? 'escape');
      return;
    }
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
    paramsBack = false;
    closePanel({ why: 'command' });
    closeMenu();
    let session: EditSession;
    try {
      session = fn();
    } catch (err) {
      fail(action, errText(err));
      return;
    }
    if (!session.open) return;
    state.set({ panel: { kind: 'feature', session, type, feature: session.feature, isNew: session.isNew, owner: ownerOf(session) }, panelNote: null, renaming: null });
    selectItem(services.selection, { kind: 'feature', feature: session.feature }, false);
  }

  function closeMenu() {
    if (state.get().menu) state.set({ menu: null });
    hideTip();
  }

  /** Before acting on a feature from the tree or a menu: close a panel that edits a different one. */
  function settleOtherPanel(id: FeatureId | null) {
    const p = state.get().panel;
    if (p && (p.kind !== 'feature' || p.feature !== id)) closePanel({ why: 'command' });
  }

  // ------------------------------------------------------------------ the Assistant's panels

  const panelName = (p: PanelState): string => {
    if (p.kind === 'feature') return featureName(p.feature);
    if (p.kind === 'params') return 'Parameters';
    return services.modules?.tool(p.tool)?.label ?? 'tool';
  };

  /**
   * Why the Assistant cannot open a panel now because of the person (to throw), or null: a menu, a
   * rename, an open dialog, or a panel the Assistant does not own (an idle Parameters panel does not
   * count: it gives way).
   */
  function personInTheWay(): PersonEditing | null {
    const s = state.get();
    if (s.menu) return new PersonEditing('The person has a menu open');
    if (s.renaming) {
      const r = s.renaming;
      const name = r.kind === 'feature' ? featureName(r.id) : (doc.state.get().doc.bodies[r.id]?.name ?? 'a body');
      return new PersonEditing(`The person is renaming ${name}`, r.kind === 'feature' ? r.id : null);
    }
    if (typeof document !== 'undefined' && openModal(document)) return new PersonEditing('The person has a dialog open');
    const p = s.panel;
    if (!p || p.owner === 'assistant') return null;
    if (p.kind === 'params') return pendingEdits().pending ? new PersonEditing('The person is typing a value in the Parameters panel') : null;
    if (p.kind === 'feature') return new PersonEditing(`The person is editing ${featureName(p.feature)}`, p.feature);
    return new PersonEditing(`The person has the ${panelName(p)} panel open`);
  }

  /**
   * Make room for an Assistant panel, or say why not. Throws PersonEditing for the person; refuses
   * (a reason) while the Part cannot be edited or the Assistant's own feature panel is still open. An
   * idle Parameters panel of the person's gives way (remembered, to come back after); one of the
   * Assistant's closes.
   */
  function roomForAssistant(): string | null {
    const block = editBlock();
    if (block) return block;
    const busy = personInTheWay();
    if (busy) throw busy;
    const p = state.get().panel;
    if (p?.kind === 'feature' && p.owner === 'assistant' && p.session.open) return `The Assistant's ${featureName(p.feature)} panel is still open`;
    if (p?.kind === 'params' && p.owner === 'person') paramsBack = true;
    if (p) state.set({ panel: null, panelNote: null });
    return null;
  }

  /** Open an Assistant session's panel (fn runs inside the step), or say why it could not open. */
  function openAssistantPanel(step: AssistantStep, type: FeatureType, action: string, fn: () => EditSession): EditSession | string {
    if (step.ended) return ENDED;
    const room = roomForAssistant();
    if (room) return room;
    let session: EditSession;
    try {
      session = step.run(fn);
    } catch (err) {
      giveBackParams();
      if (isPersonEditing(err)) throw err;
      return `${action} failed: ${errText(err)}`;
    }
    if (!session.open) {
      giveBackParams();
      return `${action} failed: its panel closed at once`;
    }
    state.set({ panel: { kind: 'feature', session, type, feature: session.feature, isNew: session.isNew, owner: ownerOf(session) }, panelNote: null, renaming: null });
    // Shown selected as the panel's highlight, not the person's choice: the person's next command
    // never takes the Assistant's draft as its preselection (it is discarded as that command takes over).
    showForPanel(services.selection, [{ kind: 'feature', feature: session.feature }]);
    return session;
  }

  /** This step's open panel session, or null. */
  function sessionOf(step: AssistantStep): EditSession | null {
    const p = state.get().panel;
    if (p?.kind === 'feature' && p.session.open && p.session.owner === step.owner) return p.session;
    const s = doc.session();
    return s && s.open && s.owner === step.owner ? s : null;
  }

  /** This step's panel goes (its session ended), and a Parameters panel that gave way to it comes back. */
  function closeAssistantPanel(step: AssistantStep) {
    const p = state.get().panel;
    const mine = !!p && p.owner === 'assistant' && (p.kind === 'feature' ? p.session.owner === step.owner : p.kind === 'params' && p.by === step.owner);
    if (mine) state.set({ panel: null, panelNote: null });
    giveBackParams();
  }

  const c: UiController = {
    state,
    editBlock,
    addEditBlock(fn) {
      blocks.add(fn);
      return () => {
        blocks.delete(fn);
      };
    },
    openNew(type, init) {
      const label = doc.features.get(type)?.label ?? type;
      begin(() => doc.beginNew(type, init), type, `New ${label}`);
    },
    openTool(id) {
      const p = state.get().panel;
      if (p?.kind === 'tool' && p.tool === id) return;
      if (!services.modules?.tool(id)) return;
      paramsBack = false;
      closePanel({ why: 'command' });
      closeMenu();
      state.set({ panel: { kind: 'tool', tool: id, owner: 'person' }, panelNote: null });
    },
    openEdit(id) {
      const p = state.get().panel;
      // (The Assistant's panel on it: the person's Edit takes it over and opens the person's own.)
      if (p?.kind === 'feature' && p.feature === id && p.owner === 'person') return;
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
      if (p?.kind === 'params' && p.owner === 'person') return;
      paramsBack = false;
      closePanel({ why: 'command' });
      closeMenu();
      state.set({ panel: { kind: 'params', owner: 'person' }, panelNote: null });
    },
    closePanel,
    cancelPanel() {
      const p = state.get().panel;
      if (p?.owner === 'assistant') {
        takeOverPanel(p, 'undo');
        return;
      }
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
      if (p.owner === 'assistant') {
        c.deleteFeature(p.feature);
        return;
      }
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
      // The Assistant's panel on it: the person changing its draft takes it over; the rename is then a one-shot edit.
      if (p?.kind === 'feature' && p.feature === id && p.owner === 'assistant') closePanel({ why: 'draft' });
      else if (p?.kind === 'feature' && p.feature === id) {
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
    moveFeature(id, toIndex) {
      const f = featureById(services, id);
      if (!f) return 'That feature is not in the part';
      const block = editBlock();
      if (block) {
        fail(`Move ${f.name}`, block);
        return block;
      }
      settleOtherPanel(null);
      try {
        const r = doc.move(id, toIndex);
        if (!r.ok) {
          fail(`Move ${f.name}`, r.reason);
          return r.reason;
        }
        return null;
      } catch (err) {
        fail(`Move ${f.name}`, errText(err));
        return errText(err);
      }
    },
    setBodyColor(id, color) {
      const name = doc.state.get().rebuild.bodies.find((b) => b.id === id)?.name ?? doc.state.get().doc.bodies[id]?.name ?? 'the body';
      const block = editBlock();
      if (block) {
        fail(`Colour ${name}`, block);
        return block;
      }
      settleOtherPanel(null);
      try {
        const r = doc.setBodyColor(id, color);
        if (!r.ok) {
          fail(`Colour ${name}`, r.reason);
          return r.reason;
        }
        return null;
      } catch (err) {
        fail(`Colour ${name}`, errText(err));
        return errText(err);
      }
    },
    pickBodyColor(id) {
      closeMenu();
      state.set({ colorFor: id });
    },
    deleteFeatures(ids) {
      const feats = doc.state.get().doc.features;
      const list = feats.filter((f) => ids.includes(f.id));
      if (list.length <= 1) {
        if (list[0]) c.deleteFeature(list[0].id);
        return;
      }
      const label = list.length === 2 ? `Delete ${list[0].name} and ${list[1].name}` : `Delete ${list[0].name} and ${list.length - 1} more`;
      const block = editBlock();
      if (block) return fail(label, block);
      settleOtherPanel(null);
      // A feature left that uses one of them refuses the whole delete before anything goes (as the
      // Assistant's delete): every such use named.
      const doc0 = doc.state.get().doc;
      const gone = new Set(list.map((f) => f.id));
      const uses: string[] = [];
      for (const g of doc0.features) {
        if (gone.has(g.id)) continue;
        for (const p of dependencies(doc.features, doc0, g)) if (gone.has(p)) uses.push(`${g.name} uses ${doc0.features.find((f) => f.id === p)?.name ?? 'one of them'}`);
      }
      if (uses.length) return fail(label, `nothing was deleted: ${uses.slice(0, 6).join('; ')}${uses.length > 6 ? `; and ${uses.length - 6} more` : ''}`);
      // Newest first: a listed feature's listed users go before it.
      let removed = 0;
      for (const f of [...list].reverse()) {
        const why = doc.removeBlock(f.id);
        const r = why ? { ok: false as const, reason: why } : doc.remove(f.id);
        if (!r.ok) {
          for (let i = 0; i < removed; i++) doc.undo();
          fail(label, `nothing was deleted: ${r.reason}`);
          return;
        }
        removed++;
      }
      const joined = doc.joinSteps(removed, label);
      if (!joined.ok) console.warn('[cad] the deleted features stay separate undo steps:', joined.reason);
      services.selection.set((s) => ({ ...s, items: s.items.filter((it) => !('feature' in it && gone.has(it.feature))) }));
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
        if (p.owner === 'person') {
          c.deletePanelFeature();
          return;
        }
        // The Assistant's panel on it: taken over first; a new feature is then gone already.
        closePanel({ why: 'command' });
        if (p.isNew) return;
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
    setBodyInSimulation(id, include) {
      const name = doc.state.get().rebuild.bodies.find((b) => b.id === id)?.name ?? 'the body';
      const action = include ? `Include ${name} in the simulation` : `Leave ${name} out of the simulation`;
      const block = editBlock();
      if (block) return fail(action, block);
      settleOtherPanel(null);
      try {
        const r = doc.setBodyInSimulation(id, include);
        if (!r.ok) fail(action, r.reason);
      } catch (err) {
        fail(action, errText(err));
      }
    },
    deleteBodies(ids) {
      const list = doc.state.get().rebuild.bodies.filter((b) => ids.includes(b.id));
      if (!list.length) return;
      const label = list.length === 1 ? `Delete ${list[0].name}` : `Delete ${list.length} bodies`;
      const block = editBlock();
      if (block) return fail(label, block);
      if (!doc.features.get('delete_body')) return fail(label, 'this version of Magnusim CAD cannot delete bodies');
      paramsBack = false;
      settleOtherPanel(null);
      closeMenu();
      try {
        // A new feature whose session applies at once (its bodies are given) and closes: one undo step.
        doc.beginNew('delete_body', { bodies: list.map((b) => b.id) } as Partial<Feature>).commit();
      } catch (err) {
        fail(label, errText(err));
        return;
      }
      // The deleted bodies leave the selection, with their faces, edges and points.
      const gone = new Set(list.map((b) => b.id));
      const off = (it: SelectionItem) => (it.kind === 'body' || it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex') && gone.has(it.body);
      if (services.selection.get().items.some(off)) services.selection.set((s) => ({ ...s, items: s.items.filter((it) => !off(it)) }));
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
    setBodiesSeeThrough(ids, on) {
      const d = doc.state.get();
      const built = d.rebuild.bodies.filter((b) => ids.includes(b.id));
      if (!built.length) return 'Select a body first, in the view or the tree';
      // A body its feature always draws see-through (an Enclosure's air) is left as it is.
      const always = built.filter((b) => seeThroughBy(d, services, b.id));
      const list = built.filter((b) => !always.includes(b));
      if (!list.length) return on ? null : `${always[0].name} is always see-through: ${seeThroughBy(d, services, always[0].id)!.name} draws it so`;
      try {
        doc.setBodiesSeeThrough(
          list.map((b) => b.id),
          on,
        );
      } catch (err) {
        return errText(err);
      }
      return null;
    },
    setFeatureVisible(id, visible) {
      const d = doc.state.get();
      const now = featureShown(d.doc, d.view, doc.features, id);
      if (now === null || now === visible) return;
      try {
        doc.setSketchVisibility(id, visibilityChoice(d.doc, doc.features, id, visible));
      } catch (err) {
        fail(`${visible ? 'Show' : 'Hide'} ${featureName(id)}`, errText(err));
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
      // A sketch's or a reference's eye, as its row's (view state: never blocked, no undo step).
      const shown = featureShown(d.doc, d.view, doc.features, id);
      if (shown !== null) items.push({ id: 'visibility', label: `${shown ? 'Hide' : 'Show'} ${f.name}`, run: () => c.setFeatureVisible(id, !shown) });
      items.push(
        // The history order (as the Assistant's edit_feature move; a drag of the row does the same).
        { id: 'move-up', label: 'Move up', disabled: block ?? (index === 0 ? `${f.name} is the first feature` : null), run: () => void c.moveFeature(id, index - 1) },
        { id: 'move-down', label: 'Move down', disabled: block ?? (index === d.doc.features.length - 1 ? `${f.name} is the last feature` : null), run: () => void c.moveFeature(id, index + 1) },
      );
      // P4b SELECT: Normal to a sketch (its plane, its own up) or a CONSTRUCT plane, from its row.
      if (f.type === 'sketch' || f.type === 'ref_plane') {
        const h = services.viewport.get().handle;
        const t = h ? targetOfItem(d, h, { kind: 'feature', feature: id }) : null;
        items.push({ id: 'normal-to', label: 'Normal to', disabled: t && t !== 'curved' ? null : `${f.name} is not built`, run: () => (t && t !== 'curved' ? h?.lookAt(t.normal, t.up) : undefined) });
      }
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
      // The keys of Delete and Rename (keyboard-only actions): set here, where the person meets them,
      // above Delete, which stays the menu's last item (P4a fix 1).
      items.push({ sep: true, id: 'sep-keybinds' }, keybindMenuItem(services, 'ui.delete', 'Set keybind for Delete…'), keybindMenuItem(services, 'ui.rename', 'Set keybind for Rename…'));
      // Refused while a later feature uses it: offered disabled, with the reason (review P2/P3 round 2:
      // "Delete Sketch 1" was offered, and only the click said no).
      // Several features selected, this one among them: one Delete of them all (one undo step).
      const picked = services.selection.get().items.flatMap((it) => (it.kind === 'feature' && d.doc.features.some((g) => g.id === it.feature) ? [it.feature] : []));
      if (picked.length > 1 && picked.includes(id)) items.push({ sep: true, id: 'sep-delete' }, { id: 'delete', label: `Delete ${picked.length} features`, danger: true, disabled: block, run: () => c.deleteFeatures(picked) });
      else items.push({ sep: true, id: 'sep-delete' }, { id: 'delete', label: deleteItemLabel(f.name), danger: true, disabled: block ?? doc.removeBlock(id), run: () => c.deleteFeature(id) });
      return items;
    },
    bodyMenu(id) {
      const d = doc.state.get();
      const info = d.rebuild.bodies.find((b) => b.id === id);
      if (!info) return [];
      const hidden = d.view.hiddenBodies.includes(id);
      const block = editBlock();
      const f = d.doc.features.find((x) => x.id === info.feature);
      // See-through or opaque (INSPECT > See-through for this body; view state, never blocked). An
      // Enclosure's air is always see-through: offered greyed with the reason.
      const see = seeThroughWhy(d, services, id);
      const items: MenuEntry[] = [
        { id: 'body-visibility', label: `${hidden ? 'Show' : 'Hide'} ${info.name}`, run: () => c.setBodyVisible(id, hidden) },
        {
          id: 'body-see-through',
          label: see ? `Make ${info.name} opaque` : `Make ${info.name} see-through`,
          disabled: see === 'feature' ? `${info.name} is always see-through: ${seeThroughBy(d, services, id)?.name ?? 'its feature'} draws it so` : null,
          run: () => {
            const why = c.setBodiesSeeThrough([id], !see);
            if (why) fail(see ? 'Opaque' : 'See-through', why);
          },
        },
      ];
      // LINK: a solid body goes to the project's geometry unless it is left out; a surface body never
      // does. Magnusim CAD has no projects and no simulation: no such item there.
      if (info.solids !== 0 && services.bridge.projectLinks()) {
        const inSim = d.doc.bodies[id]?.simulation !== false;
        items.push({
          id: 'body-simulation',
          label: inSim ? `Leave ${info.name} out of the simulation` : `Include ${info.name} in the simulation`,
          disabled: block,
          run: () => c.setBodyInSimulation(id, !inSim),
        });
      }
      items.push({ id: 'body-rename', label: `Rename ${info.name}`, disabled: block, run: () => c.startRename('body', id) });
      // The body's colour (as the Assistant's body color): the tree row's colour picker.
      items.push({ id: 'body-color', label: 'Colour…', disabled: block, run: () => c.pickBodyColor(id) });
      if (f) items.push({ sep: true, id: 'sep-body-feature' }, { id: 'body-edit', label: `Edit ${f.name}`, disabled: block, run: () => c.openEdit(f.id) });
      const canDelete = !!doc.features.get('delete_body');
      // The keys of Delete and Rename (Delete and F2 act on a selected body too): set here, where the person meets them.
      items.push({ sep: true, id: 'sep-keybinds' }, ...(canDelete ? [keybindMenuItem(services, 'ui.delete', 'Set keybind for Delete…')] : []), keybindMenuItem(services, 'ui.rename', 'Set keybind for Rename…'));
      // Delete, last (Daniel 2026-10-28: a body could be hidden, renamed and coloured, never removed): a
      // Delete body feature in the history, one undo step. Several bodies selected, this one among
      // them: one feature for them all.
      // The person's own selection, not an open panel's picks (Combine's target and tool bodies).
      const picked = userItems(services.selection).flatMap((it) => (it.kind === 'body' && d.rebuild.bodies.some((b) => b.id === it.body) ? [it.body] : []));
      const many = picked.length > 1 && picked.includes(id);
      const canMove = !!doc.features.get('move_body');
      if (canMove || canDelete) items.push({ sep: true, id: 'sep-body-delete' });
      // Move/copy (Daniel 2026-10-30: a body could not be moved after it was made), above Delete: the
      // Move/copy body panel with this body (or the selected ones) in it.
      if (canMove) items.push({ id: 'body-move', label: many ? `Move/copy ${picked.length} bodies…` : `Move/copy ${info.name}…`, disabled: block, run: () => c.openNew('move_body', { bodies: many ? picked : [id] } as Partial<Feature>) });
      if (canDelete) items.push({ id: 'body-delete', label: many ? `Delete ${picked.length} bodies` : `Delete ${info.name}`, danger: true, disabled: block, run: () => c.deleteBodies(many ? picked : [id]) });
      return items;
    },
    showMenu(x, y, items, label = 'Actions', opts = {}) {
      if (!items.length) return;
      hideTip();
      state.set({ menu: { x, y, items, label, ...(opts.owner ? { owner: opts.owner } : {}), ...(opts.anchor ? { anchor: opts.anchor } : {}) } });
    },
    closeMenu,
    featureOfItem(item) {
      if (item.kind === 'feature' || item.kind === 'sketch' || item.kind === 'region') return item.feature;
      if (item.kind === 'origin') return null;
      const b = doc.state.get().rebuild.bodies.find((x) => x.id === item.body);
      return b?.feature ?? null;
    },
    fail,
    openForAssistant(step, type, init) {
      if (step.ended) return ENDED;
      const label = doc.features.get(type)?.label ?? type;
      if (!hasPanel(services, type)) return `This version of Magnusim CAD has no panel for ${label} features`;
      return openAssistantPanel(step, type, `New ${label}`, () => doc.beginNew(type, init));
    },
    openEditForAssistant(step, id) {
      if (step.ended) return ENDED;
      const f = featureById(services, id);
      if (!f) return 'That feature is not in the part';
      const removed = removedFeatureMessage(f);
      if (removed) return `${removed}. Solids come from sketches now: delete it, then sketch the shape and extrude it`;
      if (!hasPanel(services, f.type)) return `This version of Magnusim CAD cannot edit ${f.name}: no panel edits ${f.type} features`;
      const p = state.get().panel;
      // Already open in this step (the same edit again): its session.
      if (p?.kind === 'feature' && p.feature === id && p.session.open && p.session.owner === step.owner) return p.session;
      return openAssistantPanel(step, f.type, `Edit ${f.name}`, () => doc.beginEdit(id));
    },
    openParamsForAssistant(step) {
      if (step.ended) return ENDED;
      const block = editBlock();
      if (block) return block;
      // The person first, as openForAssistant: a menu, a rename, a dialog, a value typed in Parameters, a panel of theirs.
      const busy = personInTheWay();
      if (busy) throw busy;
      const p = state.get().panel;
      // A Parameters panel already open (the person's idle one, or the Assistant's) shows the new values live.
      if (p?.kind === 'params') return null;
      if (p && p.owner === 'assistant') return `The Assistant's ${panelName(p)} panel is still open`;
      state.set({ panel: { kind: 'params', owner: 'assistant', by: step.owner }, panelNote: null });
      return null;
    },
    doneForAssistant(step) {
      if (step.ended) return ENDED;
      const session = sessionOf(step);
      if (!session) {
        closeAssistantPanel(step);
        return "The Assistant's panel is no longer open";
      }
      const name = session.draft.name || featureName(session.feature);
      let why: string | null;
      try {
        why = session.incomplete();
      } catch (err) {
        why = errText(err);
      }
      try {
        if (why) {
          // Nothing of an incomplete feature is kept (Done would drop a new one silently): it is said instead.
          step.run(() => session.discard());
          return why;
        }
        step.run(() => session.commit());
      } catch (err) {
        return `${session.isNew ? 'Create' : 'Edit'} ${name} failed: ${errText(err)}`;
      } finally {
        closeAssistantPanel(step);
      }
      if (!doc.state.get().doc.features.some((f) => f.id === session.feature)) return `${name} was not kept`;
      return null;
    },
    dropForAssistant(step) {
      if (step.ended) return;
      const session = sessionOf(step);
      try {
        if (session) step.run(() => session.discard());
      } catch (err) {
        console.error("[cad] the Assistant's panel could not be dropped", err);
      }
      closeAssistantPanel(step);
    },
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
        // The Assistant's panel ended with its session (its step's end, revert or restore; the person's edit).
        if (p.owner === 'assistant') giveBackParams();
        return;
      }
      if (s.session && (p?.kind !== 'feature' || p.session.id !== s.session.id)) {
        const open = doc.session();
        if (open && open.open && open.id === s.session.id && hasPanel(services, open.draft.type)) {
          state.set({ panel: { kind: 'feature', session: open, type: open.draft.type, feature: open.feature, isNew: open.isNew, owner: ownerOf(open) }, panelNote: null });
        }
      }
    }),
  );
  // The Assistant's Parameters panel (no session) goes when its step ends, as its feature panel goes
  // with its session: never left open, read-only, after the call (review: it stayed after a success).
  offs.push(
    services.bus.on('assistant:step-ended', ({ owner }) => {
      const p = state.get().panel;
      if (p?.kind !== 'params' || p.owner !== 'assistant' || p.by !== owner) return;
      state.set({ panel: null, panelNote: null });
      giveBackParams();
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

/**
 * The feature menu's Delete: "Delete" and the feature's name, the word once ("Delete Extrude 1";
 * "Delete faces 1" for the feature "Delete faces 1", not "Delete Delete faces 1"; UX review).
 */
export function deleteItemLabel(name: string): string {
  return /^delete\b/i.test(name.trim()) ? `Delete${name.trim().slice(6)}` : `Delete ${name}`;
}
