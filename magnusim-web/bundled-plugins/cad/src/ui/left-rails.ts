// The left column's collapsed states (ux010, Daniel 2026-10-07: "it also doesn't need to show the
// full part tree when I'm working on a sketch ... collapse [sideways], not collapse up ... Same with
// the sketch"). The design tree card and the Sketch panel each slide into a slim rail at the left
// edge of the view (never folded upward); a click on the rail brings the card back.
// - The tree: the user's chevron in model mode (remembered); while a sketch is edited it is a rail
//   whatever the user chose, until the rail is clicked (for that sketch only: it comes back as the
//   user had it when the sketch ends, and a rail click is never taken back by the app).
// - The Sketch panel: collapsed or not (remembered, so the next sketch opens the same way), and its
//   Details disclosure (remembered).
// Storage: the user's plugin prefs (`ws.prefs`, host API 1.7; keys below), read once when the page
// starts (another tab's change is not followed live: a rail that moved under the pointer would fight
// the user). A host without `ws.prefs`, or one that refuses it, keeps them for this page only.
// Keyboard: Ctrl+\ (by key, or by its place on the keyboard) collapses or expands the Sketch panel in
// sketch mode, the tree in model mode. A toggle clicked on a control it removes hands the keyboard to
// the control that replaces it (focusAfter / takeFocus). The column is drawn once the prefs are read.
// Owner: ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, type RefObject } from 'react';
import { openModal } from '../lib/modal';
import { createStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { StateStore } from '../types/state';

/** ws.prefs keys (absent = false). */
export const PREF_TREE_COLLAPSED = 'tree-collapsed';
export const PREF_SKETCH_COLLAPSED = 'sketch-panel-collapsed';
export const PREF_SKETCH_DETAILS = 'sketch-details-open';
/** Every key this module keeps (tests reset them). */
export const RAIL_PREF_KEYS = [PREF_TREE_COLLAPSED, PREF_SKETCH_COLLAPSED, PREF_SKETCH_DETAILS] as const;

/** The shortcut that collapses or expands the Sketch panel (sketch mode) or the tree (model mode). */
export const RAIL_SHORTCUT = 'Ctrl+\\';

export interface RailsState {
  /** The user collapsed the tree card (model mode; remembered). */
  treeCollapsed: boolean;
  /** While a sketch is edited: the user brought the tree back for this sketch. Reset when a sketch starts or ends. */
  treeShownInSketch: boolean;
  /** The Sketch panel is a rail (remembered). */
  sketchCollapsed: boolean;
  /** The Sketch panel's Details are open (remembered). */
  sketchDetails: boolean;
  /** The prefs were read (or there are none): `data-rails-ready` on the stack. */
  ready: boolean;
}


/** The control that takes the keyboard after a toggle swapped the clicked one away (review 4). */
export type RailFocus = 'sketch-expand' | 'sketch-collapse' | 'tree-rail' | 'tree-collapse';

export interface Rails {
  readonly state: StateStore<RailsState>;
  /** Whether the tree shows as its rail now (`sketching`: a sketch is being edited). */
  treeIsRail(sketching: boolean): boolean;
  /** The tree's chevron or its rail: in sketch mode for this sketch only, in model mode remembered. */
  setTreeShown(shown: boolean, sketching: boolean): void;
  /** A sketch started or ended: the tree follows the user's own choice again. */
  sketchChanged(): void;
  setSketchCollapsed(collapsed: boolean): void;
  setSketchDetails(open: boolean): void;
  /** The next toggle was clicked on a control it removes: its counterpart takes the keyboard once drawn. */
  focusAfter(target: RailFocus): void;
  /** Called by a counterpart when it is drawn: true (once) when it should take the keyboard. */
  takeFocus(target: RailFocus): boolean;
}

type Key = 'treeCollapsed' | 'sketchCollapsed' | 'sketchDetails';
const KEY_OF: Record<Key, string> = { treeCollapsed: PREF_TREE_COLLAPSED, sketchCollapsed: PREF_SKETCH_COLLAPSED, sketchDetails: PREF_SKETCH_DETAILS };

/** A host that never answers the prefs read: the column shows with the defaults after this long. */
export const PREFS_READ_GIVE_UP_MS = 1500;

const railsOf = new WeakMap<AppServices, Rails>();

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function railsFor(services: AppServices): Rails {
  const have = railsOf.get(services);
  if (have) return have;
  const state = createStateStore<RailsState>({ treeCollapsed: false, treeShownInSketch: false, sketchCollapsed: false, sketchDetails: false, ready: false });
  const prefs = services.bridge.prefs;
  /** Set before the prefs were read: the user's click wins over what is stored. */
  const changed = new Set<Key>();
  let usePrefs = !!prefs;
  let focusNext: RailFocus | null = null;
  const save = (key: Key, value: boolean) => {
    changed.add(key);
    state.set({ [key]: value } as Partial<RailsState>);
    if (!prefs || !usePrefs) return;
    const name = KEY_OF[key];
    (value ? prefs.set(name, true) : prefs.remove(name)).catch((err: unknown) => {
      console.warn(`[cad] ws.prefs refused ${name}; it is kept for this page only`, err);
      usePrefs = false;
    });
  };
  const rails: Rails = {
    state,
    treeIsRail: (sketching) => {
      const s = state.get();
      return sketching ? !s.treeShownInSketch : s.treeCollapsed;
    },
    setTreeShown(shown, sketching) {
      if (sketching) state.set({ treeShownInSketch: shown });
      else save('treeCollapsed', !shown);
    },
    sketchChanged() {
      state.set({ treeShownInSketch: false });
    },
    setSketchCollapsed: (collapsed) => save('sketchCollapsed', collapsed),
    setSketchDetails: (open) => save('sketchDetails', open),
    focusAfter(target) {
      focusNext = target;
    },
    takeFocus(target) {
      if (focusNext !== target) return false;
      focusNext = null;
      return true;
    },
  };
  railsOf.set(services, rails);
  if (!prefs) state.set({ ready: true });
  else {
    // Until the prefs are read the column is not drawn (review 6: a stored rail showed the card first).
    const giveUp = setTimeout(() => state.set({ ready: true }), PREFS_READ_GIVE_UP_MS);
    void (async () => {
      try {
        const read = await Promise.all((Object.keys(KEY_OF) as Key[]).map(async (k) => [k, (await prefs.get<boolean>(KEY_OF[k])) === true] as const));
        const next: Partial<RailsState> = {};
        // Read after the give-up: a value the user has not changed since still applies.
        for (const [k, v] of read) if (!changed.has(k)) next[k] = v;
        state.set(next);
      } catch (err) {
        console.warn('[cad] ws.prefs not read; the tree and the Sketch panel open expanded', err);
        usePrefs = false;
      } finally {
        clearTimeout(giveUp);
        state.set({ ready: true });
      }
    })();
  }
  // Ctrl+\: the Sketch panel in sketch mode, the tree in model mode.
  const toggle = () => {
    if (services.mode.get().mode === 'sketch') rails.setSketchCollapsed(!state.get().sketchCollapsed);
    else rails.setTreeShown(state.get().treeCollapsed, false);
  };
  services.keyboard.bind({ combo: RAIL_SHORTCUT, run: toggle });
  // The key by its place too (review 9): where the backslash needs AltGr (German, French) the event
  // reads Ctrl+Alt+\ and the binding above never matches. Same rules as the keyboard's: not while
  // typing, not with an in-frame dialog open.
  const doc = typeof document !== 'undefined' ? document : null;
  doc?.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.code !== 'Backslash') return;
    if (e.key === '\\' && !e.altKey && !e.shiftKey) return; // the binding has it
    if (typingIn(e.target) || openModal(doc)) return;
    e.preventDefault();
    toggle();
  });
  return rails;
}

/** Gives `ref` the keyboard when it is drawn as the counterpart of a toggle clicked away (review 4). */
export function useRailFocus(rails: Rails, target: RailFocus, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (rails.takeFocus(target)) ref.current?.focus({ preventScroll: true });
  }, [rails, target, ref]);
}
