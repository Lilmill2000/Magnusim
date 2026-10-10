// ux010 (DRAW, Daniel 2026-10-09: "can you have the constraints be either on a toggle or have them
// only show up if you select the feature they belong to? that radius pull thing looks way too
// cluttered"): which relation glyphs a sketch shows.
//   off (default)  a glyph shows only for what is selected: a relation of a selected curve or point
//                  (or the relation itself, picked from the panel);
//   on             every glyph, as before ("Show relations", VIEW group, Shift+R; pressed while on).
// Whatever the toggle says, a conflicting or redundant relation always shows (red). Dimensions are
// not relations: they always show. The panel's Details still list every relation.
// The choice is the user's in every project: plugin prefs (`ws.prefs`, host API 1.7) key
// PREF_SHOW_RELATIONS, read once when the page starts; a host without prefs keeps it for the page.
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { SketchConstraint, SketchFeature } from '../types/doc';
import type { StateStore } from '../types/state';
import { entityPoints } from './model';

/** ws.prefs key (absent = false: relations show for the selection only). */
export const PREF_SHOW_RELATIONS = 'sketch-show-relations';
export const SHOW_RELATIONS_SHORTCUT = 'Shift+R';

export interface RelationsView {
  readonly state: StateStore<{ showAll: boolean }>;
  setShowAll(on: boolean): void;
}

const views = new WeakMap<AppServices, RelationsView>();

export function relationsView(services: AppServices): RelationsView {
  const have = views.get(services);
  if (have) return have;
  const state = createStateStore<{ showAll: boolean }>({ showAll: false });
  const prefs = services.bridge?.prefs ?? null;
  let usePrefs = !!prefs;
  let touched = false;
  const view: RelationsView = {
    state,
    setShowAll(on) {
      touched = true;
      if (state.get().showAll === on) return;
      state.set({ showAll: on });
      if (!prefs || !usePrefs) return;
      (on ? prefs.set(PREF_SHOW_RELATIONS, true) : prefs.remove(PREF_SHOW_RELATIONS)).catch((err: unknown) => {
        console.warn(`[cad] ws.prefs refused ${PREF_SHOW_RELATIONS}; it is kept for this page only`, err);
        usePrefs = false;
      });
    },
  };
  views.set(services, view);
  if (prefs) {
    void prefs
      .get<boolean>(PREF_SHOW_RELATIONS)
      .then((v) => {
        // A click before the read wins.
        if (!touched) state.set({ showAll: v === true });
      })
      .catch((err: unknown) => {
        console.warn('[cad] ws.prefs not read; relations show for the selection only', err);
        usePrefs = false;
      });
  }
  return view;
}

/**
 * Whether a relation's glyph shows: every one with `showAll`; else a conflicting or redundant one,
 * the relation itself selected, or one that names a selected curve or point (a selected curve's end
 * and centre points count). `hidden`: entities whose relations stay hidden unless `showAll` or in
 * conflict (a fillet arc while its radius arrow shows).
 */
export function relationShown(
  d: Pick<SketchFeature, 'entities'>,
  c: Pick<SketchConstraint, 'id' | 'refs'>,
  opts: { showAll: boolean; conflict: ReadonlySet<string>; selected: ReadonlySet<string>; hidden?: ReadonlySet<string> },
): boolean {
  if (opts.conflict.has(c.id)) return true;
  if (opts.showAll) return true;
  if (opts.selected.has(c.id)) return true;
  if (opts.hidden && c.refs.some((r) => opts.hidden!.has(r))) return false;
  if (!opts.selected.size) return false;
  const touched = new Set<string>();
  for (const id of opts.selected) {
    touched.add(id);
    const e = d.entities.find((x) => x.id === id);
    if (e) for (const p of entityPoints(e)) touched.add(p);
  }
  // A selected point entity's point; a selected point's entity.
  for (const e of d.entities) if (e.kind === 'point' && touched.has(e.p)) touched.add(e.id);
  return c.refs.some((r) => touched.has(r));
}
