// The person's keybinds: the registry's defaults (src/app/keymap.ts) with their overrides, kept in
// the plugin's per-user prefs (ws.prefs "keybinds": { "<id>": ["Shift+KeyR"] | [] }; [] cleared,
// missing the defaults) and applied live: a change made elsewhere (the app's Settings, another
// tab) takes effect without reopening the Part. It is also the UI-agnostic editor the "Set
// keybind" dialog (src/ui/keybinds), the Settings page and the Assistant (workspace keybind_*) use:
// setKeybind answers a conflict with the command that has the combo (the caller offers Replace or
// Cancel); replace takes the combo from it; resetToDefault, clear, current.
// Keys show through the layout: navigator.keyboard.getLayoutMap() when the browser has it (the
// layout's character for each physical key), else the US names ("KeyR" shows as "R").
// keybindsFor(services) is the Part's one model (bootstrap sets it; a test's services get their
// own); bindCommandKeys binds a keyboard-only action (Delete, F2, Ctrl+\) by its id, so its keys
// follow the person's.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PrefsApi } from '../lib/bridge';
import type { AppServices } from '../types/app';
import type { KeyBinding } from '../types/commands';
import {
  appUseOf,
  captureCombo,
  comboProblem,
  contextsMeet,
  conflictsIn,
  defaultKeys,
  displayCombo,
  KEYMAP,
  keymapEntry,
  normaliseCombo,
  parseCombo,
  SHOWN_VIA,
  type Captured,
  type KeyLike,
  type KeymapEntry,
  type LayoutMap,
} from './keymap';

/** The ws.prefs key of the overrides. */
export const KEYBINDS_PREF = 'keybinds';
/** At most this many keys per command. */
export const MAX_KEYS = 4;

/** A command named for a question: its id, its label, and its label with where it works ("Delete (sketch)"). */
export interface NamedCommand {
  id: string;
  label: string;
  name: string;
}

/** A command's label with where it works: "Delete (sketch)", "Undo (model)", "Fit (everywhere)". */
export function whereName(id: string): string {
  const e = keymapEntry(id);
  if (!e) return id;
  return `${e.label} (${e.context === 'sketch' ? 'sketch' : e.context === 'model' ? 'model' : 'everywhere'})`;
}

export type KeybindResult =
  | { ok: true; id: string; keys: readonly string[]; was: readonly string[]; took?: NamedCommand[] }
  /** The combo is another command's in a context that meets this one's: offer Replace or Cancel (Replace takes it from every one of `conflicts`). */
  | { ok: false; reason: 'conflict'; id: string; combo: string; with: string; label: string; conflicts: NamedCommand[] }
  /** Unknown command, a combo it cannot have (reserved, the app's own, no key). */
  | { ok: false; reason: 'unknown' | 'refused'; id: string; combo?: string; message: string };

export interface Keybinds {
  /** Resolves once the stored overrides were read (or could not be: then a change is stored only after they are read). */
  readonly ready: Promise<void>;
  /** The registry. */
  entries(): readonly KeymapEntry[];
  entry(id: string): KeymapEntry | null;
  /** The keys bound to an id now (its own; Finish sketch's shown key comes from shown()). */
  current(id: string): readonly string[];
  /** Alias of current: what the keyboard binds. */
  keys(id: string): readonly string[];
  defaults(id: string): readonly string[];
  isDefault(id: string): boolean;
  /** A combo as the person reads it, through the keyboard layout. */
  display(combo: string): string;
  /** A key press in a "press the new keys" field (captureCombo, its reasons through the layout). */
  capture(e: KeyLike): Captured;
  /** The first key's words for a command's tooltip (Finish sketch: Place or finish's), or undefined. */
  shown(id: string): string | undefined;
  /** A command with no key of its own whose tooltip shows another one's (Finish sketch: Enter, through Place or finish), or null. */
  via(id: string): { id: string; label: string; shown: string } | null;
  /** The commands and actions that have `combo` now, in any context. */
  owners(combo: string): string[];
  /** The commands that have `combo` in a context that meets `id`'s (not `id` itself). */
  conflictsWith(id: string, combo: string): string[];
  /** Set the command's key to `combo` (its only key). A conflict changes nothing. */
  setKeybind(id: string, combo: string): KeybindResult;
  /** As setKeybind, taking the combo from the commands that have it. */
  replace(id: string, combo: string): KeybindResult;
  /** Back to the default keys; a default another command took meanwhile is a conflict unless `replace`. */
  resetToDefault(id: string, opts?: { replace?: boolean }): KeybindResult;
  /** No key at all. */
  clear(id: string): KeybindResult;
  /** Every command back to its defaults. */
  resetAll(): void;
  /** The overrides as stored (id -> keys). */
  overrides(): Readonly<Record<string, readonly string[]>>;
  /** Pairs that conflict now (overrides written elsewhere may make some); both keep their key. */
  conflicts(): { combo: string; ids: [string, string] }[];
  /** Resolves when the last change is stored (read again and merged first): true, or the reason it was not. */
  flush(): Promise<true | string>;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The overrides a stored value holds: known ids, valid combos, at most MAX_KEYS each; anything else is left out. */
export function parseOverrides(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    const entry = keymapEntry(id);
    if (!entry || !Array.isArray(raw)) continue;
    const keys: string[] = [];
    for (const c of raw) {
      if (typeof c !== 'string') continue;
      const n = normaliseCombo(c);
      if (!n || comboProblem(n) || keys.includes(n)) continue;
      keys.push(n);
    }
    if (raw.length && !keys.length) continue;
    out[id] = keys.slice(0, MAX_KEYS);
  }
  return out;
}

interface KeyboardApi {
  getLayoutMap?(): Promise<LayoutMap>;
}

/** The browser's layout map, or null. */
async function readLayout(): Promise<LayoutMap | null> {
  const kb = (typeof navigator !== 'undefined' ? (navigator as unknown as { keyboard?: KeyboardApi }).keyboard : undefined) ?? null;
  if (!kb || typeof kb.getLayoutMap !== 'function') return null;
  try {
    return await kb.getLayoutMap();
  } catch {
    return null;
  }
}

export function createKeybinds(o: { prefs: PrefsApi | null; layout?: boolean }): Keybinds {
  // The overrides in effect: the stored ones (as last read) with this page's changes on top.
  let over: Record<string, string[]> = {};
  let stored: Record<string, string[]> = {};
  // This page's changes not stored yet (null: back to the default), and a Reset all not stored yet.
  const dirty = new Map<string, string[] | null>();
  let resetAllPending = false;
  // How many stores went through: a read that began before one is older than what it wrote.
  let storeCount = 0;
  let layout: LayoutMap | null = null;
  let disposed = false;
  let writing: Promise<true | string> = Promise.resolve(true);
  const listeners = new Set<() => void>();
  const offs: (() => void)[] = [];
  const tell = () => {
    for (const fn of [...listeners]) fn();
  };
  const keysOf = (id: string): readonly string[] => over[id] ?? defaultKeys(id);
  const merged = (base: Record<string, string[]>): Record<string, string[]> => {
    const out: Record<string, string[]> = resetAllPending ? {} : { ...base };
    for (const [id, v] of dirty) {
      if (v === null) delete out[id];
      else out[id] = v;
    }
    return out;
  };
  const show = (next: Record<string, string[]>) => {
    if (JSON.stringify(next) === JSON.stringify(over)) return;
    over = next;
    tell();
  };
  // A stored value (the first read, or a change made in Settings or another tab), under this page's changes not stored yet.
  const take = (v: unknown) => {
    stored = parseOverrides(v);
    show(merged(stored));
  };
  /**
   * Stores this page's changes: the stored value is read again first and only these changes go on
   * top of it, so overrides made elsewhere (or never read here) are never written over. When it
   * cannot be read, nothing is written and the change applies to this Part only (flush says so).
   */
  const store = () => {
    const prefs = o.prefs;
    writing = writing.then(async () => {
      if (!prefs) return 'this Magnusim keeps no preferences, so it applies to this Part until it is closed';
      if (!dirty.size && !resetAllPending) return true;
      let base: Record<string, string[]>;
      try {
        base = parseOverrides(await prefs.get<unknown>(KEYBINDS_PREF));
      } catch (err) {
        console.warn('[cad] ws.prefs keybinds not read; the change is not stored', err);
        return `your keybinds could not be read, so the change was not saved (it applies to this Part until it is closed): ${err instanceof Error && err.message ? err.message : String(err)}`;
      }
      const changes = new Map(dirty);
      const all = resetAllPending;
      const next = merged(base);
      try {
        if (Object.keys(next).length) await prefs.set(KEYBINDS_PREF, JSON.parse(JSON.stringify(next)));
        else await prefs.remove(KEYBINDS_PREF);
      } catch (err) {
        console.warn('[cad] keybinds not stored', err);
        return err instanceof Error && err.message ? err.message : String(err);
      }
      for (const [id, v] of changes) if (dirty.get(id) === v) dirty.delete(id);
      if (all) resetAllPending = false;
      storeCount++;
      stored = next;
      if (!disposed) show(merged(stored));
      return true as const;
    });
  };
  const put = (id: string, keys: readonly string[]) => {
    const v = same(keys, defaultKeys(id)) ? null : [...keys];
    dirty.set(id, v);
    const next = { ...over };
    if (v === null) delete next[id];
    else next[id] = v;
    over = next;
  };
  const conflictsWith = (id: string, combo: string): string[] => {
    const me = keymapEntry(id);
    if (!me) return [];
    return KEYMAP.filter((x) => x.id !== id && contextsMeet(me.context, x.context) && keysOf(x.id).includes(combo)).map((x) => x.id);
  };
  const named = (id: string) => ({ id, label: keymapEntry(id)?.label ?? id, name: whereName(id) });
  const assign = (id: string, combos: readonly string[], replace: boolean): KeybindResult => {
    const entry = keymapEntry(id);
    if (!entry) return { ok: false, reason: 'unknown', id, message: `No command or key action is called ${id}` };
    const was = keysOf(id);
    const keys: string[] = [];
    for (const raw of combos) {
      const p = parseCombo(raw);
      const why = p.ok ? comboProblem(p.combo, layout) : p.why;
      if (!p.ok || why) return { ok: false, reason: 'refused', id, combo: p.ok ? p.combo : raw, message: why };
      if (!keys.includes(p.combo)) keys.push(p.combo);
    }
    const taken = keys.flatMap((c) => conflictsWith(id, c).map((w) => ({ c, w })));
    const takers = [...new Set(taken.map((t) => t.w))];
    if (taken.length && !replace) {
      const first = taken[0];
      return { ok: false, reason: 'conflict', id, combo: first.c, with: first.w, label: keymapEntry(first.w)?.label ?? first.w, conflicts: takers.map(named) };
    }
    for (const { c, w } of taken) put(w, keysOf(w).filter((k) => k !== c));
    put(id, keys);
    store();
    tell();
    return { ok: true, id, keys: keysOf(id), was, ...(takers.length ? { took: takers.map(named) } : {}) };
  };

  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => (readyResolve = r));
  if (o.prefs) {
    const prefs = o.prefs;
    // The person's keybinds, read at the start (a change made here meanwhile stays on top of them),
    // then heard from Settings and other tabs.
    const at = storeCount;
    Promise.resolve()
      .then(() => prefs.get<unknown>(KEYBINDS_PREF))
      .then((v) => {
        // A store that went through meanwhile read the value again and wrote a newer one.
        if (!disposed && storeCount === at) take(v);
      })
      .catch((err) => console.warn('[cad] ws.prefs keybinds not read; the default keys apply (a change is stored only once they are read)', err))
      .finally(readyResolve);
    try {
      offs.push(
        prefs.onChange((key, v) => {
          if (key === KEYBINDS_PREF && !disposed) take(v);
        }),
      );
    } catch {
      /* no change events: the keybinds read at the start apply */
    }
  } else readyResolve();
  if (o.layout !== false)
    void readLayout().then((m) => {
      if (m && !disposed) {
        layout = m;
        tell();
      }
    });

  const via = (id: string) => {
    const v = SHOWN_VIA[id];
    if (!v || keysOf(id).length || !keysOf(v).length) return null;
    return { id: v, label: keymapEntry(v)?.label ?? v, shown: displayCombo(keysOf(v)[0], layout) };
  };
  return {
    ready,
    entries: () => KEYMAP,
    entry: keymapEntry,
    current: keysOf,
    keys: keysOf,
    defaults: defaultKeys,
    isDefault: (id) => !(id in over),
    display: (combo) => displayCombo(combo, layout),
    capture: (ev) => captureCombo(ev, layout),
    shown(id) {
      if (!keymapEntry(id)) return undefined;
      const k = keysOf(id);
      if (k.length) return displayCombo(k[0], layout);
      return via(id)?.shown;
    },
    via,
    owners: (combo) => KEYMAP.filter((x) => keysOf(x.id).includes(combo)).map((x) => x.id),
    conflictsWith: (id, combo) => conflictsWith(id, normaliseCombo(combo)),
    setKeybind: (id, combo) => assign(id, [combo], false),
    replace: (id, combo) => assign(id, [combo], true),
    resetToDefault: (id, opts) => assign(id, defaultKeys(id), opts?.replace === true),
    clear: (id) => assign(id, [], false),
    resetAll() {
      if (!Object.keys(over).length) return;
      dirty.clear();
      resetAllPending = true;
      over = {};
      store();
      tell();
    },
    overrides: () => over,
    conflicts: () => conflictsIn(keysOf),
    flush: () => writing,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      for (const off of offs.splice(0)) off();
      listeners.clear();
    },
  };
}

// ------------------------------------------------------------------ one model per Part

const MODELS = new WeakMap<object, Keybinds>();
let fallback: Keybinds | null = null;

/** The Part's keybinds (bootstrap sets the model; services that never had one get one on their prefs). */
export function keybindsFor(services: AppServices | null | undefined): Keybinds {
  if (!services || typeof services !== 'object') return (fallback ??= createKeybinds({ prefs: null, layout: false }));
  let k = MODELS.get(services);
  if (!k) {
    const prefs = (services as Partial<AppServices>).bridge?.prefs ?? null;
    k = createKeybinds({ prefs });
    MODELS.set(services, k);
  }
  return k;
}

/** Bootstrap: this model is the Part's. */
export function setKeybindsFor(services: AppServices, k: Keybinds): void {
  MODELS.set(services, k);
}

/** The words a tooltip shows for a command's key, or undefined (none). */
export const keyLabel = (services: AppServices, id: string): string | undefined => keybindsFor(services).shown(id);

/** The app's own use of a combo, for messages ("used by Magnusim (the Assistant)"). */
export { appUseOf };

/**
 * A keyboard-only action bound by its registry id: its keys are the person's (looked up on every
 * press, so a change applies at once), and in a context of one mode it passes the key on in the
 * other. `combo` is its first key now (a test's keyboard that reads only combo).
 */
export function bindCommandKeys(services: AppServices, id: string, binding: Omit<KeyBinding, 'combo' | 'keys'>): () => void {
  const kb = keybindsFor(services);
  const context = keymapEntry(id)?.context ?? 'any';
  const run: KeyBinding['run'] = (e) => {
    if (context !== 'any') {
      const m = services.mode?.get().mode ?? 'model';
      if (m !== context) return false;
    }
    return binding.run(e);
  };
  return services.keyboard.bind({ ...binding, run, combo: kb.keys(id)[0] ?? '', keys: () => kb.keys(id) });
}
