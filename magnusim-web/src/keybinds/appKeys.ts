/**
 * The person's keys for the app's own commands: the app prefs key "keybinds" (GET and POST
 * /api/prefs), { "<app command id>": [combo, ...] }, [] for none, a missing id for the defaults.
 * Only the Assistant panel's key (app.assistant) can be changed (CHANGEABLE_APP_KEYS).
 *
 * Its defaults are read by the character "/" (toggle.ts isDockKey; the SDK's forward in a
 * workspace), which no combo can name on every layout, so the page keeps that rule while the
 * person has not changed the key, and reads a changed one as a workspace reads its commands'
 * (comboOf, typedCombo). appCommands.ts (plugin-sdk.json `app_keys`) stays the published default:
 * no command may have one of those keys whatever the person chose.
 *
 * The page reads the value once (startAppKeys) and hears each change made in this tab or another
 * on the prefs channel (plugin APP_PREFS_PLUGIN); an open workspace hears it from its bridge
 * (window event `cfd:assistant-keys`, then the frame's `assistantKeys` event).
 */
import { APP_COMMANDS, APP_LOCAL_KEYS, RESERVED_KEYS } from './appCommands';
import { typedCombo } from './combo';
import { comboOf, isCombo, MAX_KEYS } from './commands';
import { announcePref, onPrefChange } from '../workspace/prefsChannel';

/** The app prefs key that holds the person's keys for the app's own commands. */
export const APP_KEYBINDS_PREF = 'keybinds';
/** The prefs channel's plugin for the app's own prefs (no plugin key is empty). */
export const APP_PREFS_PLUGIN = '';
/** The Assistant panel's key. */
export const ASSISTANT_KEY_ID = 'app.assistant';
/** The app's commands whose keys the person may change. */
export const CHANGEABLE_APP_KEYS: readonly string[] = [ASSISTANT_KEY_ID];
/** The window event that says the Assistant panel's keys changed (an open workspace's bridge passes it on). */
export const ASSISTANT_KEYS_EVENT = 'cfd:assistant-keys';

/** A changeable app command's default keys. */
export function defaultAppKeys(id: string): string[] {
  return [...(APP_COMMANDS.find((c) => c.id === id)?.keys ?? [])];
}

const q = (v: string) => JSON.stringify(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Keys the browser (or a text box) acts on that the panel's key can't be: in a workspace the panel's
 * key reaches the app only after the page had it, too late to stop the browser, and it works while
 * the person types. Combos as commands.ts writes them (Cmd counts as Ctrl).
 */
const BROWSER_KEYS: readonly { label: string; keys: readonly string[] }[] = [
  { label: 'copy, cut, paste, undo, redo and select all', keys: ['Ctrl+KeyC', 'Ctrl+KeyX', 'Ctrl+KeyV', 'Ctrl+Shift+KeyV', 'Ctrl+KeyZ', 'Ctrl+Shift+KeyZ', 'Ctrl+KeyY', 'Ctrl+KeyA'] },
  { label: 'find in the page', keys: ['Ctrl+KeyF', 'Ctrl+KeyG', 'Ctrl+Shift+KeyG', 'F3', 'Shift+F3'] },
  { label: 'back and forward', keys: ['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Home'] },
  { label: 'the address bar and search', keys: ['Ctrl+KeyL', 'Alt+KeyD', 'F6', 'Ctrl+KeyE', 'Ctrl+KeyK'] },
  { label: 'history, downloads and bookmarks', keys: ['Ctrl+KeyH', 'Ctrl+KeyJ', 'Ctrl+KeyD', 'Ctrl+Shift+KeyB', 'Ctrl+Shift+KeyO', 'Ctrl+Shift+Delete'] },
  { label: 'open, save and view the page', keys: ['Ctrl+KeyO', 'Ctrl+KeyS', 'Ctrl+KeyU'] },
  { label: 'help, its menu and caret browsing', keys: ['F1', 'F7', 'F10', 'Alt+KeyF', 'Alt+KeyE'] },
];

/** Keys that move or edit while the person types (and Ctrl+Space, which switches input languages): with any modifier. */
const TYPING_KEYS = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Backspace|Delete|Insert|Enter|Tab|Space)$/;

/**
 * Why the Assistant panel can't have `combo` ('' when it can), naming it with `name`: a key the
 * browser or the system keeps, the key that closes the app's dialogs and modes, a key the browser or
 * a text box acts on, or a key that types text (it works while the person types, so it needs Ctrl or
 * Alt, or is a function key).
 */
export function appKeyRefusal(combo: string, name: (c: string) => string = q): string {
  if (!isCombo(combo)) return `${name(combo)} is not a key`;
  const reserved = RESERVED_KEYS.find((c) => c.keys.includes(combo));
  if (reserved) return `${name(combo)} is kept for the browser and the system (${reserved.label})`;
  const local = APP_LOCAL_KEYS.find((c) => c.keys.includes(combo));
  if (local) return `${name(combo)} is the app's own key in dialogs, menus and modes (${local.label})`;
  const browser = BROWSER_KEYS.find((c) => c.keys.includes(combo));
  if (browser) return `${name(combo)} is the browser's (${browser.label}): the Assistant panel's key needs one the browser leaves alone`;
  const parts = combo.split('+');
  const code = parts.pop() as string;
  if (parts.length && TYPING_KEYS.test(code)) {
    return `${name(combo)} is a key used while typing: the Assistant panel's key needs Ctrl or Alt with a letter, digit or punctuation key, or is a function key (F1 to F24)`;
  }
  if (!parts.includes('Ctrl') && !parts.includes('Alt') && !parts.includes('Meta') && !/^F\d+$/.test(code)) {
    // A key that types something, or one that moves or edits while the person types.
    const types = /^(Key[A-Z]|Digit\d|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|Numpad)/.test(code);
    return `${name(combo)} ${types ? 'types text' : 'is a key used while typing'}: the Assistant panel's key needs Ctrl or Alt, or is a function key (F1 to F24)`;
  }
  return '';
}

/**
 * The person's keys from the app prefs' "keybinds": each changeable id with its valid, distinct
 * combos ([] for none). A combo the Assistant panel can't have is left out, and so is an id whose
 * every combo was (it has its defaults), as readKeybindOverrides reads a plugin's.
 */
export function readAppKeybinds(value: unknown): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  if (!isObject(value)) return out;
  for (const id of CHANGEABLE_APP_KEYS) {
    const keys = value[id];
    if (!Array.isArray(keys)) continue;
    const valid = [...new Set(keys.filter((k): k is string => typeof k === 'string' && !appKeyRefusal(k)))].slice(0, MAX_KEYS);
    if (keys.length && !valid.length) continue;
    out[id] = valid;
  }
  return out;
}

let current: Record<string, string[]> = readAppKeybinds(null);
let stopChannel: (() => void) | null = null;
const listeners = new Set<() => void>();
// One write at a time, so two quick changes never store over each other.
let writing: Promise<unknown> = Promise.resolve();

function put(value: unknown): void {
  const next = readAppKeybinds(value);
  const was = JSON.stringify(current);
  current = next;
  if (JSON.stringify(next) === was) return;
  for (const fn of [...listeners]) fn();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ASSISTANT_KEYS_EVENT));
}

/** The person's keys for the app's commands as last read (no prototype: a missing id has its defaults). */
export function appKeybinds(): Record<string, string[]> {
  return { ...current };
}

/** The Assistant panel's keys the person chose ([] for none), or null while it has its defaults. */
export function assistantKeys(): string[] | null {
  const keys = current[ASSISTANT_KEY_ID];
  return keys ? [...keys] : null;
}

/** Calls `fn` whenever the person's app keys change; returns the stop. */
export function onAppKeys(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether a press is one of `keys`, read as a workspace reads its commands' keys. */
export function pressIs(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, keys: readonly string[]): boolean {
  const combo = comboOf(e);
  if (!combo) return false;
  if (keys.includes(combo)) return true;
  const typed = typedCombo(e, combo);
  return !!typed && keys.includes(typed);
}

/** Reads the person's app keys once and follows their changes (other tabs, Settings). Idempotent. */
export function startAppKeys(): void {
  if (stopChannel || typeof window === 'undefined') return;
  stopChannel = onPrefChange((c) => {
    if (c.plugin === APP_PREFS_PLUGIN && c.key === APP_KEYBINDS_PREF) put(c.value);
  });
  void fetch('/api/prefs', { cache: 'no-store' })
    .then((r) => r.json())
    .then((j: unknown) => {
      if (isObject(j) && j.ok !== false) put(j.keybinds);
    })
    .catch(() => {
      /* the defaults stay */
    });
}

/** The app's keys could not be read again before a write: nothing written. */
export class AppKeysUnread extends Error {}
/** A checked write found the app's keys moved since the change was worked out: nothing written. */
export class AppKeysChanged extends Error {}

/**
 * Stores a change of the app's keys: reads the stored value again, changes only `patch`'s ids
 * (null: back to the defaults), writes it, takes it on this page and announces it. `still`, when
 * given, is asked about the keys just read, in the same turn as the write: false writes nothing
 * (AppKeysChanged). The keys as stored now, or the error.
 */
export function storeAppKeybinds(
  patch: Record<string, string[] | null>,
  from: string,
  still?: (stored: Record<string, string[]>) => boolean,
): Promise<Record<string, string[]>> {
  const done = writing.then(
    () => writeAppKeybinds(patch, from, still),
    () => writeAppKeybinds(patch, from, still),
  );
  writing = done.catch(() => {});
  return done;
}

/** The app's keys as stored now (read again: not the page's copy). */
export async function readStoredAppKeybinds(): Promise<Record<string, string[]>> {
  let r0: Response;
  let was: Record<string, unknown>;
  try {
    r0 = await fetch('/api/prefs', { cache: 'no-store' });
    was = (await r0.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (e) {
    throw new AppKeysUnread(e instanceof Error ? e.message : String(e));
  }
  if (!r0.ok || was.ok === false) throw new AppKeysUnread(String(was.error || `the app answered ${r0.status}`));
  return readAppKeybinds(was.keybinds);
}

async function writeAppKeybinds(
  patch: Record<string, string[] | null>,
  from: string,
  still?: (stored: Record<string, string[]>) => boolean,
): Promise<Record<string, string[]>> {
  const was = await readStoredAppKeybinds();
  if (still && !still(was)) throw new AppKeysChanged('the keys changed meanwhile');
  const next: Record<string, string[]> = { ...was };
  for (const [id, keys] of Object.entries(patch)) {
    if (!CHANGEABLE_APP_KEYS.includes(id)) throw new Error(`${q(id)} is not a key the person can change`);
    if (keys === null) delete next[id];
    else next[id] = keys;
  }
  const r = await fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keybinds: next }),
    cache: 'no-store',
  });
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || out.ok === false) throw new Error(String(out.error || `the app answered ${r.status}`));
  const stored = readAppKeybinds(isObject(out.prefs) ? out.prefs.keybinds : next);
  put(stored);
  announcePref(APP_PREFS_PLUGIN, APP_KEYBINDS_PREF, stored, from);
  return stored;
}

/**
 * Reads the stored app keys again and takes them on this page (Settings as it opens, the
 * Assistant's keybind tools before they read or change one): a page without the dock started
 * nothing that read them. Follows their changes from then on (startAppKeys).
 */
export async function refreshAppKeys(): Promise<void> {
  startAppKeys();
  put(await readStoredAppKeybinds());
}

/** Back to a fresh page: the defaults, not started (tests). */
export function resetAppKeysForTests(value: unknown = null): void {
  current = readAppKeybinds(value);
  stopChannel?.();
  stopChannel = null;
  listeners.clear();
  writing = Promise.resolve();
}
