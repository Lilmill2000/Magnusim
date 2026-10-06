// The user's toolbar layout (P4b fix round 1, Daniel 2026-10-06: "I prefer 1280 px (model) but let
// people arrange the icons however they want"). Per mode (model, sketch) and per command: whether
// it sits on the toolbar ("bar") or in its group's More menu ("more"), and each group's order.
// What the user has not changed follows the defaults: model mode shows only each group's main
// command(s) (KEEP_IN_VIEW: the compact layout seen at 1280 px), at every width; sketch mode shows
// every command. Commands on the bar still fold into More in FOLD_ORDER when the frame is too
// narrow. Unknown or removed ids in a stored layout are ignored; new commands take their place
// from the registry's order.
//
// Storage: the user's, in every project: the host's plugin prefs (`ws.prefs`, host API 1.7, key
// TOOLBAR_PREF_KEY), so a layout set in one project shows in every other, and another open CAD tab
// follows a change at once (`onChange`). The first time, a layout this project kept per project
// (TOOLBAR_LAYOUT_FILE, below) is copied over, once. A 1.6 host has no `ws.prefs` (and the frame is
// sandboxed with no localStorage): there the layout stays per project in the plugin's own data
// (`ws.data`, TOOLBAR_LAYOUT_FILE), shared by every Part of the project.
// Owner: INTEGRATE (TOOLBAR fixer).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../lib/store';
import type { StateStore } from '../types/state';
import type { AppServices } from '../types/app';
import type { Mode } from '../types/commands';

export const TOOLBAR_LAYOUT_FILE = 'toolbar-layout.json';

export type Place = 'bar' | 'more';
export type LayoutMode = 'model' | 'sketch';

export interface ModeLayout {
  /** Commands the user moved: id -> where. Absent: the default. */
  place: Record<string, Place>;
  /** A group's commands in the user's order (ids; unknown ones are skipped). */
  order: Record<string, string[]>;
}

export interface ToolbarLayout {
  version: 1;
  model: ModeLayout;
  sketch: ModeLayout;
}

export const EMPTY_MODE: ModeLayout = Object.freeze({ place: {}, order: {} }) as ModeLayout;

export function emptyLayout(): ToolbarLayout {
  return { version: 1, model: { place: {}, order: {} }, sketch: { place: {}, order: {} } };
}

export function layoutModeOf(mode: Mode): LayoutMode {
  return mode === 'sketch' ? 'sketch' : 'model';
}

const ID = /^[a-z0-9_.:-]{1,80}$/i;

function readMode(raw: unknown): ModeLayout {
  const out: ModeLayout = { place: {}, order: {} };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { place?: unknown; order?: unknown };
  if (r.place && typeof r.place === 'object') {
    for (const [id, p] of Object.entries(r.place as Record<string, unknown>)) {
      if (ID.test(id) && (p === 'bar' || p === 'more')) out.place[id] = p;
    }
  }
  if (r.order && typeof r.order === 'object') {
    for (const [g, ids] of Object.entries(r.order as Record<string, unknown>)) {
      if (!ID.test(g) || !Array.isArray(ids)) continue;
      const seen = new Set<string>();
      const list = ids.filter((x): x is string => typeof x === 'string' && ID.test(x) && !seen.has(x) && !!seen.add(x));
      if (list.length) out.order[g] = list;
    }
  }
  return out;
}

/** A stored layout as far as it can be read: anything malformed is dropped, never an error. */
export function readLayout(raw: unknown): ToolbarLayout {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return emptyLayout();
  const r = raw as { model?: unknown; sketch?: unknown };
  return { version: 1, model: readMode(r.model), sketch: readMode(r.sketch) };
}

export function isDefault(m: ModeLayout): boolean {
  return !Object.keys(m.place).length && !Object.keys(m.order).length;
}

/**
 * Where a command sits when the frame is wide enough. `keep`: the commands shown by default in
 * model mode (each group's main command, Toolbar.tsx KEEP_IN_VIEW).
 */
export function placeOf(id: string, mode: LayoutMode, m: ModeLayout, keep: ReadonlySet<string>): Place {
  const p = m.place[id];
  if (p) return p;
  if (mode === 'sketch') return 'bar';
  return keep.has(id) ? 'bar' : 'more';
}

/**
 * A group's ids in the user's order: the stored order's known ids first as stored, and each id it
 * does not list (a new command) right after the one before it in the registry's order.
 */
export function orderIds(registry: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved || !saved.length) return [...registry];
  const known = new Set(registry);
  const out = saved.filter((id) => known.has(id));
  const placed = new Set(out);
  registry.forEach((id, i) => {
    if (placed.has(id)) return;
    const prev = i > 0 ? registry[i - 1] : null;
    const at = prev ? out.indexOf(prev) : -1;
    out.splice(at + 1, 0, id);
    placed.add(id);
  });
  return out;
}

/**
 * The layout with `id` put on the bar or in More. "Show in toolbar" is always kept (a command the
 * user asked for folds last when the frame is narrow: Toolbar.tsx); "Move to More" of a command
 * that is in More by default just forgets the earlier choice.
 */
export function withPlace(m: ModeLayout, id: string, place: Place, mode: LayoutMode, keep: ReadonlySet<string>): ModeLayout {
  const next = { ...m.place };
  delete next[id];
  if (place === 'bar' || placeOf(id, mode, { place: {}, order: {} }, keep) !== 'more') next[id] = place;
  return { place: next, order: m.order };
}

/** The user asked for it on the bar: it folds after every other command when the frame is narrow. */
export function pinned(m: ModeLayout, id: string): boolean {
  return m.place[id] === 'bar';
}

/**
 * The group's order with `id` moved to just before `before` (null: to the end). `current` is the
 * group's order as shown now (orderIds of the registry and the stored order).
 */
export function withMove(m: ModeLayout, group: string, current: readonly string[], id: string, before: string | null): ModeLayout {
  const list = current.filter((x) => x !== id);
  const at = before == null ? list.length : list.indexOf(before);
  list.splice(at < 0 ? list.length : at, 0, id);
  return { place: m.place, order: { ...m.order, [group]: list } };
}

// ---------------------------------------------------------------- the store (per services)

export interface ToolbarPrefs {
  /** The layout (the defaults until the stored one is read). */
  readonly state: StateStore<{ layout: ToolbarLayout }>;
  /** Settles once the stored layout was read (or there was none, or it could not be read). */
  readonly loaded: Promise<void>;
  /** Replace one mode's layout and save. */
  setMode(mode: LayoutMode, m: ModeLayout): void;
  /** One mode back to the defaults (and save). */
  reset(mode: LayoutMode): void;
  /** The last save, for tests. */
  saved(): Promise<void>;
}

const prefsOf = new WeakMap<AppServices, ToolbarPrefs>();

export function toolbarPrefs(services: AppServices): ToolbarPrefs {
  const have = prefsOf.get(services);
  if (have) return have;
  const state = createStateStore<{ layout: ToolbarLayout }>({ layout: emptyLayout() });
  const store = layoutStore(services);
  let ready = false;
  let changedBeforeLoad = false;
  let last: Promise<void> = Promise.resolve();
  let pending: ToolbarLayout | null = null;
  let writing = false;
  let loaded: Promise<void> = Promise.resolve();
  const write = (): Promise<void> => {
    if (writing || !pending) return last;
    writing = true;
    last = loaded
      .then(() => {
        const doc = pending!;
        pending = null;
        return store.write(doc);
      })
      .catch((err: unknown) => {
        services.bridge.toast(`The toolbar layout was not saved: ${err instanceof Error ? err.message : String(err)}`, 'error');
      })
      .then(() => {
        writing = false;
        if (pending) return write();
      });
    return last;
  };
  const save = (layout: ToolbarLayout) => {
    pending = layout;
    void write();
  };
  const prefs: ToolbarPrefs = {
    state,
    get loaded() {
      return loaded;
    },
    setMode(mode, m) {
      changedBeforeLoad = changedBeforeLoad || !ready;
      const layout = { ...state.get().layout, [mode]: m };
      state.set({ layout });
      save(layout);
    },
    reset(mode) {
      prefs.setMode(mode, { place: {}, order: {} });
    },
    saved: () => last,
  };
  prefsOf.set(services, prefs);
  loaded = (async () => {
    try {
      const raw = await store.read();
      // A change made while the layout was read wins over it; nothing stored keeps the defaults (no update).
      if (raw != null && !changedBeforeLoad) state.set({ layout: readLayout(raw) });
    } catch (err) {
      console.warn('[cad] toolbar layout not read; the defaults are used', err);
    } finally {
      ready = true;
    }
  })();
  // Another open CAD tab or window changed the layout (ws.prefs only): this toolbar follows at once.
  store.onChange((raw) => state.set({ layout: raw == null ? emptyLayout() : readLayout(raw) }));
  return prefs;
}

/** The user's layout in every project (host API 1.7 `ws.prefs`). */
export const TOOLBAR_PREF_KEY = 'toolbar-layout';
/**
 * Set once the project's TOOLBAR_LAYOUT_FILE (a 1.6 host's per-project layout) was looked at and,
 * when there was one and no user layout yet, copied: after that the user's layout always wins, and
 * a Reset (which removes TOOLBAR_PREF_KEY) never brings an old project's file back.
 */
export const TOOLBAR_MIGRATED_KEY = 'toolbar-layout.migrated';

/** Where the layout is kept: the user's prefs (1.7), else the project's plugin data (1.6). */
interface LayoutStore {
  read(): Promise<unknown | null>;
  write(layout: ToolbarLayout): Promise<void>;
  onChange(fn: (raw: unknown | null) => void): void;
}

function layoutStore(services: AppServices): LayoutStore {
  const data = services.bridge.data;
  const projectFile: LayoutStore = {
    read: () => data.read<unknown>(TOOLBAR_LAYOUT_FILE),
    write: (layout) => data.write(TOOLBAR_LAYOUT_FILE, layout),
    onChange: () => {},
  };
  const p = services.bridge.prefs;
  if (!p) return projectFile;
  // The host's SDK has ws.prefs; should its bridge still refuse the calls (not_allowed), the layout
  // stays per project, as on a 1.6 host.
  let use: LayoutStore = projectFile;
  const userPrefs: LayoutStore = {
    async read() {
      const v = await p.get<unknown>(TOOLBAR_PREF_KEY);
      if (v != null) return v;
      if (await p.get<boolean>(TOOLBAR_MIGRATED_KEY)) return null;
      // Once: the layout this project kept before (per project, host 1.6) becomes the user's.
      const old = await data.read<unknown>(TOOLBAR_LAYOUT_FILE).catch(() => null);
      let copied: ToolbarLayout | null = null;
      if (old != null) {
        const l = readLayout(old);
        if (!isDefault(l.model) || !isDefault(l.sketch)) {
          await p.set(TOOLBAR_PREF_KEY, l);
          copied = l;
        }
      }
      await p.set(TOOLBAR_MIGRATED_KEY, true);
      return copied;
    },
    // Reset to the defaults removes the user's layout; anything else is stored as it is.
    write: (layout) => (isDefault(layout.model) && isDefault(layout.sketch) ? p.remove(TOOLBAR_PREF_KEY) : p.set(TOOLBAR_PREF_KEY, layout)),
    onChange(fn) {
      p.onChange((key, value) => {
        if (key === TOOLBAR_PREF_KEY) fn(value ?? null);
      });
    },
  };
  return {
    async read() {
      try {
        const v = await userPrefs.read();
        use = userPrefs;
        return v;
      } catch (err) {
        console.warn('[cad] ws.prefs refused; the toolbar layout stays with this project', err);
        use = projectFile;
        return projectFile.read();
      }
    },
    write: (layout) => use.write(layout),
    onChange: (fn) => userPrefs.onChange(fn),
  };
}
