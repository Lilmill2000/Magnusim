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
// The app's Assistant panel key is the app's: the published default (Ctrl+/, keymap.ts
// APP_SHORTCUTS) and the one the person chose in the app's Settings (the bridge's assistantKeys,
// live). No new key of a command may be one of them (set, replace, reset, the dialog's capture);
// a stored keybind that is one stays stored (it comes back when the person moves the Assistant's
// key away again: the host's own Change takes it from the command meanwhile) and shows as taken
// (appClashes), and the keyboard leaves its press to the app (keyboard.ts passAssistantKey), so
// no tooltip, menu or hint names it as the command's (shown, via). Reset all still resets every
// command, but a default that is the person's Assistant key stays off its command (resetAll).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge, PrefsApi } from '../lib/bridge';
import type { AppServices } from '../types/app';
import type { KeyBinding } from '../types/commands';
import {
  appClashesIn,
  appUseOf,
  captureCombo,
  comboProblem,
  contextsMeet,
  conflictsIn,
  defaultKeys,
  displayCombo,
  isAssistantCombo,
  keymapEntry,
  keymapFor,
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
  /**
   * Unknown command, a combo it cannot have (reserved, the app's own, no key), or the person's saved
   * keybinds not read yet or unreadable (`unread`: a change worked out from the defaults would name
   * the wrong takers and write over saved keys).
   */
  | { ok: false; reason: 'unknown' | 'refused' | 'unread'; id: string; combo?: string; message: string };

/** The Assistant panel's keys the person chose, live (the bridge has them: Bridge.assistantKeys). */
export type AssistantKeysSource = Pick<Bridge, 'assistantKeys' | 'onAssistantKeys'>;

/**
 * Reset all went through. `kept`: each default kept off its command because it is the Assistant
 * panel's key the person chose (one per key), with the note that says so: "kept off Ctrl+K: the
 * Assistant panel's key", the key as people read it. [] when none was.
 */
export interface ResetAllResult {
  ok: true;
  kept: { id: string; combo: string; note: string }[];
}

export interface Keybinds {
  /** Resolves once the first read of the stored overrides is over (read, or could not be). */
  readonly ready: Promise<void>;
  /**
   * The saved keybinds read: true (or there are none to read: no prefs), else why not. A read that
   * failed is tried again; until one succeeds no change is made (known() says why).
   */
  load(): Promise<true | string>;
  /** true once the saved keybinds are read (or there are none to read), else why changes wait. */
  known(): true | string;
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
  /** Why a combo cannot be a command's key now ('' when it can): comboProblem, with the Assistant panel's keys the person chose. */
  problem(combo: string): string;
  /** The Assistant panel's keys the person chose (as the host sent them, [] none), or null for its default (Ctrl+/). */
  assistantKeys(): readonly string[] | null;
  /** Keys commands have now that no command's key may be (a stored keybind the person's Assistant key took): its press is the app's. */
  appClashes(): { combo: string; id: string; by: string }[];
  /**
   * The words of a command's first key that runs it, for its tooltips, menus and hints (Finish
   * sketch: Place or finish's), or undefined. Never a key the Assistant panel's key the person chose
   * took (appClashes: its press opens the panel); current() still has it.
   */
  shown(id: string): string | undefined;
  /** A command with no key of its own whose tooltip shows another one's (Finish sketch: Enter, through Place or finish; as shown() reads it), or null. */
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
  /**
   * Every command back to its defaults, or why not (the saved keybinds are not read). A default that
   * is the Assistant panel's key the person chose stays off its command (stored as its defaults
   * without it); the result names each one kept off.
   */
  resetAll(): ResetAllResult | string;
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

export function createKeybinds(o: { prefs: PrefsApi | null; layout?: boolean; assistant?: AssistantKeysSource | null; projectLinks?: boolean }): Keybinds {
  // The commands this Part has: in Magnusim CAD (projectLinks false) none of a project's (keymap.ts `projects`).
  const map = keymapFor(o.projectLinks !== false);
  const entryOf = (id: string): KeymapEntry | null => {
    const e = keymapEntry(id);
    return e && (o.projectLinks !== false || !e.projects) ? e : null;
  };
  // The overrides in effect: the stored ones (as last read) with this page's changes on top.
  let over: Record<string, string[]> = {};
  let stored: Record<string, string[]> = {};
  // This page's changes not stored yet (null: back to the default), and a Reset all not stored yet.
  const dirty = new Map<string, string[] | null>();
  let resetAllPending = false;
  // How many Reset alls were made: a store clears only the one it wrote, never one made while it wrote.
  let resetCount = 0;
  // How many stores went through: a read that began before one is older than what it wrote.
  let storeCount = 0;
  // Whether the saved keybinds were read: a change is worked out from them, never from the defaults.
  let readState: 'reading' | 'read' | 'unreadable' | 'none' = o.prefs ? 'reading' : 'none';
  let readError = '';
  let layout: LayoutMap | null = null;
  let disposed = false;
  let writing: Promise<true | string> = Promise.resolve(true);
  const listeners = new Set<() => void>();
  const offs: (() => void)[] = [];
  const tell = () => {
    for (const fn of [...listeners]) fn();
  };
  const keysOf = (id: string): readonly string[] => over[id] ?? defaultKeys(id);
  // The Assistant panel's keys the person chose, read live from the bridge (null: its default).
  const assistantKeys = (): readonly string[] | null => o.assistant?.assistantKeys() ?? null;
  // A command's keys whose press runs it: not one the Assistant panel's key took (its press is the
  // app's), so a tooltip never names a key that opens the panel instead.
  const working = (id: string): readonly string[] => {
    const a = assistantKeys();
    return a?.length ? keysOf(id).filter((c) => !isAssistantCombo(c, a)) : keysOf(id);
  };
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
  // How many stored values were taken: a read that began before one is older than it.
  let takenCount = 0;
  const take = (v: unknown) => {
    takenCount++;
    stored = parseOverrides(v);
    const was = readState;
    readState = o.prefs ? 'read' : 'none';
    show(merged(stored));
    if (was !== readState) tell();
  };
  const known = (): true | string =>
    readState === 'read' || readState === 'none'
      ? true
      : readState === 'reading'
        ? 'your keybinds are still being read: try again in a moment (nothing was changed)'
        : `your keybinds could not be read, so they cannot be changed now (nothing was changed)${readError ? `: ${readError}` : ''}`;
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
      const resets = resetCount;
      const next = merged(base);
      try {
        if (Object.keys(next).length) await prefs.set(KEYBINDS_PREF, JSON.parse(JSON.stringify(next)));
        else await prefs.remove(KEYBINDS_PREF);
      } catch (err) {
        console.warn('[cad] keybinds not stored', err);
        return err instanceof Error && err.message ? err.message : String(err);
      }
      for (const [id, v] of changes) if (dirty.get(id) === v) dirty.delete(id);
      if (all && resetCount === resets) resetAllPending = false;
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
    const me = entryOf(id);
    if (!me) return [];
    return map.filter((x) => x.id !== id && contextsMeet(me.context, x.context) && keysOf(x.id).includes(combo)).map((x) => x.id);
  };
  const named = (id: string) => ({ id, label: entryOf(id)?.label ?? id, name: whereName(id) });
  const assign = (id: string, combos: readonly string[], replace: boolean): KeybindResult => {
    const entry = entryOf(id);
    if (!entry) return { ok: false, reason: 'unknown', id, message: `No command or key action is called ${id}` };
    // Worked out from the saved keybinds only (review: from the defaults a Replace took a saved key
    // from a command nobody named and left a clash). An unreadable read is tried again.
    const k = known();
    if (k !== true) {
      if (readState === 'unreadable') void load();
      return { ok: false, reason: 'unread', id, message: k };
    }
    const was = keysOf(id);
    const keys: string[] = [];
    for (const raw of combos) {
      const p = parseCombo(raw);
      const why = p.ok ? comboProblem(p.combo, layout, assistantKeys()) : p.why;
      if (!p.ok || why) return { ok: false, reason: 'refused', id, combo: p.ok ? p.combo : raw, message: why };
      if (!keys.includes(p.combo)) keys.push(p.combo);
    }
    const taken = keys.flatMap((c) => conflictsWith(id, c).map((w) => ({ c, w })));
    const takers = [...new Set(taken.map((t) => t.w))];
    if (taken.length && !replace) {
      const first = taken[0];
      return { ok: false, reason: 'conflict', id, combo: first.c, with: first.w, label: entryOf(first.w)?.label ?? first.w, conflicts: takers.map(named) };
    }
    for (const { c, w } of taken) put(w, keysOf(w).filter((k) => k !== c));
    put(id, keys);
    store();
    tell();
    return { ok: true, id, keys: keysOf(id), was, ...(takers.length ? { took: takers.map(named) } : {}) };
  };

  let reading: Promise<true | string> = Promise.resolve(true);
  /** Reads the saved keybinds (again, after a failure). */
  const read = (prefs: PrefsApi): Promise<true | string> => {
    readState = 'reading';
    const at = storeCount;
    const taken = takenCount;
    return Promise.resolve()
      .then(() => prefs.get<unknown>(KEYBINDS_PREF))
      .then((v) => {
        // A store that went through meanwhile read the value again and wrote a newer one; a value
        // heard meanwhile (Settings, another tab) is newer than this read.
        if (!disposed && storeCount === at && takenCount === taken) take(v);
        else readState = 'read';
        return true as const;
      })
      .catch((err) => {
        // A value heard while this read was under way is the person's keybinds: a late failure
        // never makes them unknown again (review: changes were refused, the keys called defaults).
        if (takenCount !== taken || storeCount !== at) {
          readState = 'read';
          return true as const;
        }
        console.warn('[cad] ws.prefs keybinds not read; the default keys apply and no change is made until they are read', err);
        readState = 'unreadable';
        readError = err instanceof Error && err.message ? err.message : String(err);
        tell();
        return known() as string;
      });
  };
  const load = (): Promise<true | string> => {
    if (!o.prefs || readState === 'read' || readState === 'none') return Promise.resolve(true);
    if (readState === 'unreadable') reading = read(o.prefs);
    return reading;
  };
  let ready: Promise<void> = Promise.resolve();
  if (o.prefs) {
    const prefs = o.prefs;
    // The person's keybinds, read at the start, then heard from Settings and other tabs.
    reading = read(prefs);
    ready = reading.then(() => undefined);
    try {
      offs.push(
        prefs.onChange((key, v) => {
          if (key === KEYBINDS_PREF && !disposed) take(v);
        }),
      );
    } catch {
      /* no change events: the keybinds read at the start apply */
    }
  }
  if (o.assistant) {
    // The person moved the Assistant panel's key in Settings: what is refused changes, and so may
    // what the dialog says of a command's keys.
    try {
      offs.push(
        o.assistant.onAssistantKeys(() => {
          if (!disposed) tell();
        }),
      );
    } catch {
      /* no change events: the keys the Part opened with apply */
    }
  }
  if (o.layout !== false)
    void readLayout().then((m) => {
      if (m && !disposed) {
        layout = m;
        tell();
      }
    });

  const via = (id: string) => {
    const v = SHOWN_VIA[id];
    // A command with a key of its own never shows another one's, even one the panel's key took.
    if (!v || keysOf(id).length) return null;
    const w = working(v);
    if (!w.length) return null;
    return { id: v, label: entryOf(v)?.label ?? v, shown: displayCombo(w[0], layout) };
  };
  return {
    ready,
    load,
    known,
    entries: () => map,
    entry: entryOf,
    current: keysOf,
    keys: keysOf,
    defaults: defaultKeys,
    isDefault: (id) => !(id in over),
    display: (combo) => displayCombo(combo, layout),
    capture: (ev) => captureCombo(ev, layout, assistantKeys()),
    problem: (combo) => comboProblem(combo, layout, assistantKeys()),
    assistantKeys,
    appClashes: () => appClashesIn(keysOf, assistantKeys(), map),
    shown(id) {
      if (!entryOf(id)) return undefined;
      const k = working(id);
      if (k.length) return displayCombo(k[0], layout);
      return via(id)?.shown;
    },
    via,
    owners: (combo) => map.filter((x) => keysOf(x.id).includes(combo)).map((x) => x.id),
    conflictsWith: (id, combo) => conflictsWith(id, normaliseCombo(combo)),
    setKeybind: (id, combo) => assign(id, [combo], false),
    replace: (id, combo) => assign(id, [combo], true),
    resetToDefault: (id, opts) => assign(id, defaultKeys(id), opts?.replace === true),
    clear: (id) => assign(id, [], false),
    resetAll() {
      const k = known();
      if (k !== true) {
        if (readState === 'unreadable') void load();
        return k;
      }
      // Every command back to its defaults, but a default that is the Assistant panel's key the
      // person chose (isAssistantCombo, as the refusals read it) stays off: that command's override
      // is its defaults without it ([] when none is left), stored like any other, as the host's Reset
      // all does. It stays when the person moves the Assistant's key later: the key does not come
      // back by itself, as it does not after the host's Replace took it.
      const a = assistantKeys();
      const next: Record<string, string[]> = {};
      const kept: ResetAllResult['kept'] = [];
      for (const e of map) {
        const keys = defaultKeys(e.id);
        const off = keys.filter((c) => isAssistantCombo(c, a));
        if (!off.length) continue;
        next[e.id] = keys.filter((c) => !off.includes(c));
        for (const c of off) kept.push({ id: e.id, combo: c, note: `kept off ${displayCombo(c, layout)}: the Assistant panel's key` });
      }
      const ids = Object.keys(next);
      if (ids.length === Object.keys(over).length && ids.every((id) => over[id] && same(over[id], next[id]))) return { ok: true, kept };
      dirty.clear();
      resetAllPending = true;
      resetCount++;
      for (const id of ids) dirty.set(id, next[id]);
      over = next;
      store();
      tell();
      return { ok: true, kept };
    },
    overrides: () => over,
    // Magnusim CAD: a key stored for a project's command (the Enclosure, bound in Magnusim) is no one's here.
    conflicts: () => conflictsIn(keysOf, map),
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
    const bridge = (services as Partial<AppServices>).bridge;
    const prefs = bridge?.prefs ?? null;
    // A test's bridge may be partial: the Assistant panel's keys only when it has them.
    const assistant = typeof bridge?.assistantKeys === 'function' && typeof bridge.onAssistantKeys === 'function' ? bridge : null;
    k = createKeybinds({ prefs, assistant });
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
