/**
 * Every key the person can see and set, for Settings → Keybinds and the Assistant's keybind tools:
 * the app's own (appCommands.ts: shown; only the Assistant panel's can be changed, appKeys.ts) and
 * each plugin's workspace commands (the
 * catalog row's `workspaces[].commands`, read as commands.ts reads it), with the person's keys from
 * the plugin's prefs key "keybinds" ({ "<command id>": [combo, ...] }, [] for none, a missing id
 * for the defaults). Only a plugin that is on is listed: its prefs are reachable only then.
 *
 * A change follows the CAD plugin's rules (its keybinds.ts), so Settings and the Part agree:
 * - Change gives the command that one key. A key the app, the browser or the system keeps is
 *   refused (refusalOf), and so is the Assistant panel's key the person chose (appKeys.ts); a key
 *   another command of the same workspace has where the two meet (the same context, or either is
 *   "any") is a conflict, which Replace takes from that command.
 * - Reset puts the defaults back (a default another command took meanwhile is a conflict unless
 *   Replace; one that is the Assistant panel's key now is refused); Clear leaves the command no key;
 *   Reset all drops every one of the person's keys, but keeps the Assistant panel's key off the
 *   command whose default it is (keptOffText says which).
 * - The Assistant panel's own key (app.assistant) changes the same way (planAppChange): a key a
 *   plugin command has anywhere is a conflict, as the panel's key works everywhere, and Replace
 *   takes it from each of them before the panel gets it.
 * - No change is worked out from keys that were not read (`unread`): it would name the wrong
 *   takers and write over the saved ones.
 * A write reads the stored value again and changes only the ids it touches (keys set elsewhere
 * meanwhile, and ids this list doesn't know, stay), then announces it on the prefs channel, so an
 * open workspace of that plugin (this tab or another) takes it at once.
 */
import { isCad } from '../app/edition';
import { APP_COMMANDS, APP_KEYS, APP_LOCAL_KEYS, RESERVED_KEYS } from './appCommands';
import {
  AppKeysChanged,
  AppKeysUnread,
  appKeyRefusal,
  appKeybinds,
  ASSISTANT_KEY_ID,
  assistantKeys,
  CHANGEABLE_APP_KEYS,
  defaultAppKeys,
  readStoredAppKeybinds,
  storeAppKeybinds,
} from './appKeys';
import { parseCombo } from './combo';
import { ANY_CONTEXT, readCommandsFile, readKeybindOverrides, type Command, type CommandContext } from './commands';
import { announcePref } from '../workspace/prefsChannel';

/** The plugin prefs key that holds the person's keys. */
export const KEYBINDS_PREF = 'keybinds';
const tag = () => Math.random().toString(36).slice(2, 10);
/**
 * Who this page's Settings changes come from, on the prefs channel: its own (a change it hears
 * with it is one it made), and not a workspace bridge's (each open workspace takes it).
 */
export const SETTINGS_FROM = `settings:${tag()}`;
/** Who this page's Assistant changes (core__set_keybind) come from: an open Settings takes them. */
export const ASSISTANT_FROM = `assistant:${tag()}`;

/** No keys of the person's own: looked up by id, so no prototype answers for one. */
const noKeys = (): Record<string, string[]> => Object.create(null) as Record<string, string[]>;

export interface WorkspaceKeys {
  workspace: string;
  title: string;
  /** Why its commands are not listed ('' when they are). */
  error: string;
  contexts: CommandContext[];
  commands: Command[];
}

export interface PluginKeys {
  plugin: string;
  name: string;
  workspaces: WorkspaceKeys[];
  /** The person's keys as last read, by command id. */
  overrides: Record<string, string[]>;
  /** Why the person's keys could not be read ('' once they were): changes wait until they are. */
  unread: string;
}

/** A catalog row of /api/plugins, as far as keys go. */
interface PluginRow {
  key?: unknown;
  name?: unknown;
  status?: unknown;
  workspaces?: { key?: unknown; title?: unknown; commands?: unknown; commands_error?: unknown }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const q = (v: string) => JSON.stringify(v);

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || out.ok === false) throw new Error(String(out.error || `the app answered ${r.status}`));
  return out;
}

/** The stored value of the plugin's keys, whole (null when it has none). */
async function readStored(plugin: string): Promise<unknown> {
  const out = await postJson('/api/plugin-prefs/get', { plugin, key: KEYBINDS_PREF });
  return out.value ?? null;
}

/** A workspace's commands file, read from the plugin's folder: its commands, or why not. */
async function readWorkspace(plugin: string, ws: NonNullable<PluginRow['workspaces']>[number]): Promise<WorkspaceKeys | null> {
  const path = typeof ws.commands === 'string' ? ws.commands : '';
  const listed = typeof ws.commands_error === 'string' ? ws.commands_error : '';
  if (!path && !listed) return null;
  const out: WorkspaceKeys = { workspace: String(ws.key ?? ''), title: String(ws.title ?? ws.key ?? ''), error: '', contexts: [], commands: [] };
  if (listed) return { ...out, error: listed };
  let doc: unknown;
  try {
    const url = `/plugins/${encodeURIComponent(plugin)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return { ...out, error: `${path} could not be read (the app answered ${r.status})` };
    doc = await r.json();
  } catch {
    return { ...out, error: `${path} is not JSON` };
  }
  const { file, problems } = readCommandsFile(doc);
  if (!file) return { ...out, error: problems.length > 1 ? `${problems[0]} (and ${problems.length - 1} more)` : problems[0] || `${path} lists no commands` };
  // Magnusim CAD has no projects: a command that acts only where the app has them ("projects": true,
  // the CAD Part's Enclosure) is not one the person has there, so it is not listed.
  return { ...out, contexts: file.contexts, commands: isCad() ? file.commands.filter((c) => !c.projects) : file.commands };
}

/** Every command a plugin lists (each id once: a plugin's ids are unique, plugin:check holds it). */
export function commandsOf(p: PluginKeys): Command[] {
  return p.workspaces.flatMap((w) => w.commands);
}

/** One stored key as its combo: written as a combo, or as people write it ("shift+r"), as the CAD plugin reads them. */
const readKey = (k: unknown): string | null => {
  if (typeof k !== 'string') return null;
  const p = parseCombo(k);
  return p.ok ? p.combo : null;
};

/** The person's keys in a stored value, read as the CAD plugin reads them. */
const overridesOf = (stored: unknown, p: PluginKeys) => readKeybindOverrides(stored, commandsOf(p), APP_KEYS, readKey);

/**
 * Reads the person's keys of a plugin again (after a change made elsewhere, or a failed read),
 * once any write of this page's to that plugin is done: a read begun after a write sees it.
 */
export async function refreshOverrides(p: PluginKeys): Promise<PluginKeys> {
  try {
    await (writing.get(p.plugin) ?? Promise.resolve());
    const stored = await readStored(p.plugin);
    return { ...p, overrides: overridesOf(stored, p), unread: '' };
  } catch (e) {
    return { ...p, overrides: noKeys(), unread: `Your keys for ${p.name} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Every plugin that is on and lists commands, with the person's keys. `error`: why there is no list. */
export async function loadPluginKeys(): Promise<{ plugins: PluginKeys[]; error: string }> {
  let rows: PluginRow[];
  try {
    const r = await fetch('/api/plugins', { cache: 'no-store' });
    const body = (await r.json().catch(() => ({}))) as { plugins?: PluginRow[]; error?: unknown };
    // A busy or restarting worker answers with an error, never as "no plugins".
    if (!r.ok || !Array.isArray(body.plugins)) return { plugins: [], error: `Could not read the plugin list: ${String(body.error || `the app answered ${r.status}`)}.` };
    rows = body.plugins;
  } catch {
    return { plugins: [], error: 'Could not read the plugin list.' };
  }
  const plugins = await Promise.all(
    rows
      .filter((row) => typeof row.key === 'string' && row.status === 'enabled' && Array.isArray(row.workspaces))
      .map(async (row): Promise<PluginKeys | null> => {
        const plugin = String(row.key);
        const workspaces = (await Promise.all((row.workspaces || []).map((ws) => readWorkspace(plugin, ws)))).filter((w): w is WorkspaceKeys => !!w);
        if (!workspaces.length) return null;
        return refreshOverrides({ plugin, name: String(row.name || plugin), workspaces, overrides: noKeys(), unread: '' });
      }),
  );
  return { plugins: plugins.filter((p): p is PluginKeys => !!p), error: '' };
}

/** A command and its workspace, by id. */
export function commandOf(p: PluginKeys, id: string): { ws: WorkspaceKeys; command: Command } | null {
  for (const ws of p.workspaces) {
    const command = ws.commands.find((c) => c.id === id);
    if (command) return { ws, command };
  }
  return null;
}

/** The keys a command has now: the person's, else its defaults. */
export function keysOf(p: PluginKeys, id: string): string[] {
  return p.overrides[id] ?? commandOf(p, id)?.command.keys ?? [];
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether a command has its default keys. */
export function isDefault(p: PluginKeys, id: string): boolean {
  return !(id in p.overrides) || same(p.overrides[id], commandOf(p, id)?.command.keys ?? []);
}

/** A command's context as people read it: its label, "Everywhere" for "any". */
export function contextLabel(ws: WorkspaceKeys, context: string): string {
  if (context === ANY_CONTEXT) return 'Everywhere';
  return ws.contexts.find((c) => c.id === context)?.label || context;
}

/** Whether two contexts meet (the same one, or either is "any"), as the CAD plugin reads them. */
export const contextsMeet = (a: string, b: string): boolean => a === b || a === ANY_CONTEXT || b === ANY_CONTEXT;

/**
 * Why a change may not give a command `combo` ('' when it may), naming it with `name` (JSON
 * quotes, as the validators do, by default): the app's own key, a key the browser or the system
 * keeps, or the app's local key (Escape). A workspace may use Escape, and a command's own default
 * may be it (published: plugin-sdk.json app_keys), but no one sets it: a press of Escape cancels
 * Settings' recorder, so the Assistant may not give it either (it can do what the person can).
 */
export function refusalOf(combo: string, name: (c: string) => string = q): string {
  const app = APP_COMMANDS.find((c) => c.keys.includes(combo));
  if (app) return `${name(combo)} is the app's own key (${app.label})`;
  if (assistantKeys()?.includes(combo)) return assistantKeyRefusal(combo, name);
  const reserved = RESERVED_KEYS.find((c) => c.keys.includes(combo));
  if (reserved) return `${name(combo)} is kept for the browser and the system (${reserved.label})`;
  const local = APP_LOCAL_KEYS.find((c) => c.keys.includes(combo));
  if (local) return `${name(combo)} is the app's own key in dialogs, menus and modes (${local.label}): only a command's own default can be it`;
  return '';
}

/** The Assistant panel's command (appCommands.ts). */
const ASSISTANT_APP = APP_COMMANDS.find((c) => c.id === ASSISTANT_KEY_ID)!;

/** Why a command may not have the Assistant panel's key the person chose. */
const assistantKeyRefusal = (combo: string, name: (c: string) => string) => `${name(combo)} is the app's own key (${ASSISTANT_APP.label})`;

/** The app as Settings names it. */
export const appName = (): string => (isCad() ? 'Magnusim CAD' : 'Magnusim');

/** The other commands of `id`'s workspace that have `combo` now where they meet `id`'s context. */
export function conflictsOf(p: PluginKeys, id: string, combo: string): Command[] {
  const at = commandOf(p, id);
  if (!at) return [];
  return at.ws.commands.filter((c) => c.id !== id && contextsMeet(c.context, at.command.context) && keysOf(p, c.id).includes(combo));
}

export type KeyChange = { action: 'set'; combo: string; replace?: boolean } | { action: 'reset'; replace?: boolean } | { action: 'clear' };

export type ChangeResult =
  /** Done: the command's keys now, and the commands a Replace took a key from. */
  | { ok: true; id: string; keys: string[]; took: Command[] }
  /** The key is another command's where the two meet: offer Replace or Cancel. */
  | { ok: false; code: 'conflict'; id: string; combo: string; conflicts: Command[]; message: string }
  /** Unknown command, a key it cannot have, keys not read, the write failed, or the keys moved under a checked change. */
  | { ok: false; code: 'unknown' | 'refused' | 'unread' | 'failed' | 'changed'; id: string; message: string };

/** The ids a change touches and their keys after it (null: back to the defaults). */
type Patch = Record<string, string[] | null>;

/** A command's keys as stored after a change: null when they are its defaults. */
const storedAs = (c: Command, keys: string[]): string[] | null => (same(keys, c.keys) ? null : keys);

/**
 * What a change would do, worked out from the keys as read: the patch to store, or why not.
 * `name` names keys in the words (the person's form in Settings, stored combos for the Assistant).
 */
export function planChange(p: PluginKeys, id: string, change: KeyChange, name: (c: string) => string = q): ({ ok: true; patch: Patch; keys: string[]; took: Command[] }) | Exclude<ChangeResult, { ok: true }> {
  const at = commandOf(p, id);
  if (!at) return { ok: false, code: 'unknown', id, message: `${p.name} has no command ${q(id)}` };
  if (p.unread) return { ok: false, code: 'unread', id, message: p.unread };
  const wanted = change.action === 'set' ? [change.combo] : change.action === 'reset' ? at.command.keys : [];
  if (change.action === 'set') {
    const why = refusalOf(change.combo, name);
    if (why) return { ok: false, code: 'refused', id, message: why };
  }
  if (change.action === 'reset') {
    // A default that is the Assistant panel's key now stays the panel's: move that key first.
    const live = assistantKeys() ?? [];
    const taken = wanted.find((k) => live.includes(k));
    if (taken) return { ok: false, code: 'refused', id, message: assistantKeyRefusal(taken, name) };
  }
  const replace = change.action !== 'clear' && !!change.replace;
  const patch: Patch = { [id]: storedAs(at.command, wanted) };
  // The keys of the commands a Replace takes from, as they will be.
  const left = new Map<Command, string[]>();
  for (const combo of wanted) {
    const others = conflictsOf(p, id, combo);
    if (!others.length) continue;
    if (!replace) {
      const who = others.map((c) => `${c.label} (${contextLabel(at.ws, c.context)})`).join(', ');
      return { ok: false, code: 'conflict', id, combo, conflicts: others, message: `${name(combo)} is already the key of ${who}` };
    }
    for (const c of others) left.set(c, (left.get(c) ?? keysOf(p, c.id)).filter((k) => k !== combo));
  }
  for (const [c, keys] of left) patch[c.id] = storedAs(c, keys);
  return { ok: true, patch, keys: wanted, took: [...left.keys()] };
}

// One write at a time per plugin, so two quick changes never store over each other.
const writing = new Map<string, Promise<unknown>>();

/** A checked change found the keys moved since it was worked out (store's `still`). */
class KeysChanged extends Error {}
/** The stored keys could not be read again before the write: nothing written. */
class KeysUnread extends Error {}

/**
 * Stores a patch: reads the stored value again, changes only the patch's ids (`all`: drops every
 * id), writes it back (or removes the pref when nothing is left) and announces it. `still`, when
 * given, is asked about the value just read, in the same turn as the write: false writes nothing
 * (KeysChanged). The keys as stored, or the error.
 */
function store(plugin: string, patch: Patch, all = false, from = SETTINGS_FROM, still?: (stored: unknown) => boolean): Promise<Record<string, unknown>> {
  const run = async () => {
    let stored: unknown = null;
    if (!all) {
      try {
        stored = await readStored(plugin);
      } catch (e) {
        throw new KeysUnread(e instanceof Error ? e.message : String(e));
      }
    }
    if (still && !still(stored)) throw new KeysChanged('the keys changed meanwhile');
    const next: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
    for (const [id, keys] of Object.entries(patch)) {
      if (keys === null) delete next[id];
      else next[id] = keys;
    }
    const empty = !Object.keys(next).length;
    if (empty) await postJson('/api/plugin-prefs/remove', { plugin, key: KEYBINDS_PREF });
    else await postJson('/api/plugin-prefs/set', { plugin, key: KEYBINDS_PREF, value: next });
    announcePref(plugin, KEYBINDS_PREF, empty ? null : next, from);
    return next;
  };
  const done = (writing.get(plugin) ?? Promise.resolve()).then(run, run);
  writing.set(plugin, done.catch(() => {}));
  return done;
}

/**
 * Makes a change and stores it: what it did (with the plugin's keys as stored now), or why not.
 * `from`: who it is announced as (Settings by default; the Assistant's tools pass ASSISTANT_FROM).
 * `still`: asked about the plugin's keys as read just before the write, in the same turn; false
 * writes nothing and answers `changed` (the Assistant's check that the change is still the one
 * the person said Yes to).
 */
export async function applyChange(
  p: PluginKeys,
  id: string,
  change: KeyChange,
  name?: (c: string) => string,
  from = SETTINGS_FROM,
  still?: (now: PluginKeys) => boolean,
): Promise<{ result: ChangeResult; plugin: PluginKeys }> {
  const plan = planChange(p, id, change, name);
  if (!plan.ok) return { result: plan, plugin: p };
  try {
    const check = still ? (stored: unknown) => still({ ...p, overrides: overridesOf(stored, p), unread: '' }) : undefined;
    const next = await store(p.plugin, plan.patch, false, from, check);
    return { result: { ok: true, id, keys: plan.keys, took: plan.took }, plugin: { ...p, overrides: overridesOf(next, p) } };
  } catch (e) {
    if (e instanceof KeysChanged) return { result: { ok: false, code: 'changed', id, message: 'The keys changed meanwhile; nothing changed.' }, plugin: p };
    if (e instanceof KeysUnread) return { result: { ok: false, code: 'unread', id, message: `Your keys for ${p.name} could not be read: ${e.message}` }, plugin: p };
    return { result: { ok: false, code: 'failed', id, message: `Could not save the keys: ${e instanceof Error ? e.message : String(e)}` }, plugin: p };
  }
}

/** A command whose default is the Assistant panel's key now, kept off it by a Reset all, and those keys. */
export interface KeptOff {
  command: Command;
  keys: string[];
}

/**
 * What a Reset all stores for a plugin: nothing, except that a command whose defaults hold the
 * Assistant panel's key (`live`, the person's; none while it has its defaults) keeps its other
 * defaults, so that key stays the panel's.
 */
function resetAllPatch(p: PluginKeys, live: readonly string[] = assistantKeys() ?? []): { patch: Patch; keptOff: KeptOff[] } {
  const patch: Patch = {};
  const keptOff: KeptOff[] = [];
  for (const c of commandsOf(p)) {
    const off = c.keys.filter((k) => live.includes(k));
    if (!off.length) continue;
    patch[c.id] = c.keys.filter((k) => !live.includes(k));
    keptOff.push({ command: c, keys: off });
  }
  return { patch, keptOff };
}

/** What a Reset all of a plugin would keep the Assistant panel's key off (its question names them). */
export function keptOffFor(p: PluginKeys, live: readonly string[] = assistantKeys() ?? []): KeptOff[] {
  return resetAllPatch(p, live).keptOff;
}

/** The words for the commands a Reset all kept the Assistant panel's key off ('' when none). */
export function keptOffText(keptOff: readonly KeptOff[], name: (c: string) => string = q): string {
  if (!keptOff.length) return '';
  const keys = [...new Set(keptOff.flatMap((k) => k.keys))].map(name).join(', ');
  return `${keys} kept off ${keptOff.map((k) => k.command.label).join(', ')}: the Assistant panel's key.`;
}

/**
 * Every command of a plugin back to its defaults (but the Assistant panel's key: resetAllPatch):
 * the plugin as stored now and the commands that key was kept off, or why not.
 */
export async function resetAllKeys(
  p: PluginKeys,
  from = SETTINGS_FROM,
  live: readonly string[] = assistantKeys() ?? [],
): Promise<{ ok: true; plugin: PluginKeys; keptOff: KeptOff[] } | { ok: false; message: string }> {
  if (p.unread) return { ok: false, message: p.unread };
  const { patch, keptOff } = resetAllPatch(p, live);
  try {
    const next = await store(p.plugin, patch, true, from);
    return { ok: true, plugin: { ...p, overrides: overridesOf(next, p) }, keptOff };
  } catch (e) {
    return { ok: false, message: `Could not save the keys: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Whether any command of a plugin has keys of the person's own. */
export const hasOwnKeys = (p: PluginKeys): boolean => Object.keys(p.overrides).some((id) => !isDefault(p, id));

/**
 * Whether a Reset all would change any of a plugin's keys (`live`: the Assistant panel's key the
 * person chose, which stays off the commands whose default it is).
 */
export function canResetAll(p: PluginKeys, live: readonly string[] = assistantKeys() ?? []): boolean {
  const { patch } = resetAllPatch(p, live);
  const ids = new Set([...Object.keys(p.overrides), ...Object.keys(patch)]);
  for (const id of ids) {
    const at = commandOf(p, id);
    if (!at) continue;
    if (!same(keysOf(p, id), patch[id] ?? at.command.keys)) return true;
  }
  return false;
}

// ---- The app's own key the person can change: the Assistant panel's ----

/** The app's changeable key as Settings and the Assistant show it. */
export interface AppKeyRow {
  id: string;
  label: string;
  group: string;
  /** Its keys now: the person's, else its defaults. */
  keys: string[];
  defaults: string[];
  isDefault: boolean;
}

/** Each app key the person can change, with its keys now. */
export function appKeyRows(): AppKeyRow[] {
  const own = appKeybinds();
  return CHANGEABLE_APP_KEYS.map((id) => {
    const c = APP_COMMANDS.find((x) => x.id === id)!;
    const defaults = defaultAppKeys(id);
    return { id, label: c.label, group: c.group, keys: own[id] ?? defaults, defaults, isDefault: !(id in own) };
  });
}

export type AppKeyChange = { action: 'set'; combo: string; replace?: boolean } | { action: 'reset' } | { action: 'clear' };

/** A plugin command a change of the app's key takes it from: its keys before and after. */
export interface Taker {
  plugin: PluginKeys;
  command: Command;
  before: string[];
  after: string[];
}

export type AppChangeResult =
  /** Done: the panel's keys now, and the plugin commands a Replace took the key from. */
  | { ok: true; id: string; keys: string[]; took: Taker[] }
  /** The key is a plugin command's: offer Replace or Cancel. */
  | { ok: false; code: 'conflict'; id: string; combo: string; takers: Taker[]; message: string }
  /** Not done; `lost`: the commands a Replace took the key from that could not get it back. */
  | { ok: false; code: 'unknown' | 'refused' | 'unread' | 'failed' | 'changed'; id: string; message: string; lost?: Taker[] };

/** A plugin command as a conflict names it: "CAD · Line (Sketch)". */
export function takerName(t: { plugin: PluginKeys; command: Command }): string {
  const ws = commandOf(t.plugin, t.command.id)?.ws;
  return `${t.plugin.name} · ${t.command.label} (${ws ? contextLabel(ws, t.command.context) : t.command.context})`;
}

/**
 * What a change of an app key would do, worked out from the plugins' keys as read: the value to
 * store for it (null: its defaults), its keys after, and the commands it takes the key from (with
 * the patch of each plugin), or why not. A key that types text, or one the browser, the system or
 * the dialogs keep, is refused (appKeyRefusal); one of its own defaults is its defaults; a key any
 * plugin command has is a conflict (the panel's key works everywhere), which Replace takes.
 */
export function planAppChange(
  plugins: readonly PluginKeys[],
  id: string,
  change: AppKeyChange,
  name: (c: string) => string = q,
): { ok: true; stored: string[] | null; keys: string[]; took: Taker[]; patches: Map<string, Patch> } | Exclude<AppChangeResult, { ok: true }> {
  if (!CHANGEABLE_APP_KEYS.includes(id)) return { ok: false, code: 'unknown', id, message: `${appName()} has no key ${q(id)} that can be changed` };
  const defaults = defaultAppKeys(id);
  const none = new Map<string, Patch>();
  if (change.action === 'reset') return { ok: true, stored: null, keys: defaults, took: [], patches: none };
  if (change.action === 'clear') return { ok: true, stored: [], keys: [], took: [], patches: none };
  const combo = change.combo;
  // One of its own defaults: the defaults (they go by the character "/", which no combo names).
  if (defaults.includes(combo)) return { ok: true, stored: null, keys: defaults, took: [], patches: none };
  const why = appKeyRefusal(combo, name);
  if (why) return { ok: false, code: 'refused', id, message: why };
  // Whether a command has it is not known for a plugin whose keys were not read.
  const unread = plugins.find((p) => p.unread);
  if (unread) return { ok: false, code: 'unread', id, message: unread.unread };
  const takers: Taker[] = plugins.flatMap((p) =>
    commandsOf(p)
      .filter((c) => keysOf(p, c.id).includes(combo))
      .map((c) => ({ plugin: p, command: c, before: keysOf(p, c.id), after: keysOf(p, c.id).filter((k) => k !== combo) })),
  );
  if (takers.length && !change.replace) {
    return { ok: false, code: 'conflict', id, combo, takers, message: `${name(combo)} is already the key of ${takers.map(takerName).join(', ')}` };
  }
  const patches = new Map<string, Patch>();
  for (const t of takers) patches.set(t.plugin.plugin, { ...(patches.get(t.plugin.plugin) ?? {}), [t.command.id]: storedAs(t.command, t.after) });
  return { ok: true, stored: [combo], keys: [combo], took: takers, patches };
}

/**
 * Makes a change of an app key and stores it: first each plugin a Replace takes the key from (so
 * the panel has the key only once no command does), then the app's keys. What it did, with the
 * plugins as stored now, or why not. `checked` (the Assistant, after the person's Yes): each write
 * first reads its keys again and writes nothing when they moved since the plan (`changed`).
 */
export async function applyAppChange(
  plugins: readonly PluginKeys[],
  id: string,
  change: AppKeyChange,
  name?: (c: string) => string,
  from = SETTINGS_FROM,
  checked = false,
): Promise<{ result: AppChangeResult; plugins: PluginKeys[] }> {
  const list = [...plugins];
  const plan = planAppChange(list, id, change, name);
  if (!plan.ok) return { result: plan, plugins: list };
  const appBefore = JSON.stringify(appKeybinds()[id] ?? null);
  // The commands whose plugin has been written: what a stop part way gives back.
  const written: Taker[] = [];
  /** A change stopped part way: the key goes back to each command it was taken from, and the words say what is left. */
  const stopped = async (e: unknown, panel: boolean): Promise<{ result: AppChangeResult; plugins: PluginKeys[] }> => {
    const lost = await giveBack(list, written, from);
    const moved = e instanceof KeysChanged || e instanceof AppKeysChanged;
    const why = moved ? (panel ? "the panel's key changed meanwhile" : 'the keys changed meanwhile') : e instanceof Error ? e.message : String(e);
    const what = panel ? "The panel's key was not saved" : 'The keys were not saved';
    const message = lost.length
      ? `${what} (${why}), and ${lost.map(takerName).join(', ')} could not get the key back: change it there.`
      : `${what} (${why}); nothing changed.`;
    const code = moved ? 'changed' : e instanceof KeysUnread || e instanceof AppKeysUnread ? 'unread' : 'failed';
    return { result: { ok: false, code, id, message, ...(lost.length ? { lost } : {}) }, plugins: list };
  };
  for (const [key, patch] of plan.patches) {
    const i = list.findIndex((p) => p.plugin === key);
    const p = list[i];
    const takers = plan.took.filter((t) => t.plugin.plugin === key);
    const still = checked
      ? (stored: unknown) => {
          const now = { ...p, overrides: overridesOf(stored, p), unread: '' };
          return takers.every((t) => same(keysOf(now, t.command.id), t.before));
        }
      : undefined;
    try {
      const next = await store(key, patch, false, from, still);
      list[i] = { ...p, overrides: overridesOf(next, p) };
      written.push(...takers);
    } catch (e) {
      return stopped(e, false);
    }
  }
  const still = checked ? (stored: Record<string, string[]>) => JSON.stringify(stored[id] ?? null) === appBefore : undefined;
  try {
    await storeAppKeybinds({ [id]: plan.stored }, from, still);
  } catch (e) {
    return stopped(e, true);
  }
  return { result: { ok: true, id, keys: plan.keys, took: plan.took }, plugins: list };
}

/**
 * Gives the commands a Replace took the key from their keys back (the panel's own write failed),
 * in `list` too; the ones that could not get it back.
 */
async function giveBack(list: PluginKeys[], took: readonly Taker[], from: string): Promise<Taker[]> {
  const lost: Taker[] = [];
  for (const key of new Set(took.map((t) => t.plugin.plugin))) {
    const mine = took.filter((t) => t.plugin.plugin === key);
    const i = list.findIndex((p) => p.plugin === key);
    try {
      const next = await store(key, Object.fromEntries(mine.map((t) => [t.command.id, storedAs(t.command, t.before)])), false, from);
      if (i >= 0) list[i] = { ...list[i], overrides: overridesOf(next, list[i]) };
    } catch {
      lost.push(...mine);
    }
  }
  return lost;
}

/** The app's keys as stored, read again (a Reset all asks about the stored value, not the page's copy); null when they can't be read. */
async function appKeysStored(): Promise<Record<string, string[]> | null> {
  try {
    return await readStoredAppKeybinds();
  } catch {
    return null;
  }
}

/** How Reset all keybinds names the Assistant panel's key in its question and its word after. */
export const appResetName = (): string => `${appName()} (the Assistant panel's key)`;

/** Reset all keybinds' question, in the person's words (Settings' pane-head button and the Assistant ask the same). */
export function resetEveryQuestion(names: readonly string[]): { title: string; copy: string; yes: string } {
  const app = names.includes(appResetName());
  const plugins = names.filter((n) => n !== appResetName());
  const parts = [
    ...(app ? ["The Assistant panel's key goes back to Ctrl+/."] : []),
    ...(plugins.length ? [`Every command of ${plugins.join(', ')} gets its default keys back.`] : []),
    ...(app ? [] : ["The app's own keys stay as they are."]),
  ];
  return { title: 'Reset all keybinds?', copy: parts.join(' '), yes: 'Reset all' };
}

/**
 * Settings → Keybinds' Reset all keybinds: the Assistant panel's key back to its defaults first
 * (so no plugin default is kept off it), then every plugin's commands, after one `ask` naming
 * what it changes (none asked when there is nothing to reset). What it reset, each one it could
 * not, with why in a few words (its keys not read, or the write refused), and the commands a key
 * the panel still has was kept off (when the panel's own reset failed).
 */
export async function resetEveryPlugin(
  ask: (names: string[]) => Promise<boolean>,
  name: (c: string) => string = q,
  opts: { from?: string; checked?: boolean } = {},
): Promise<{ asked: boolean; reset: string[]; failed: { name: string; why: string }[]; error: string; keptOff: string; changed?: boolean }> {
  const from = opts.from ?? SETTINGS_FROM;
  // What a Reset all would change now: every plugin's keys and the panel's as stored (the page's
  // copy may be behind another tab's change).
  const look = async () => {
    const { plugins, error } = await loadPluginKeys();
    const stored = await appKeysStored();
    const storedLive = stored ? (stored[ASSISTANT_KEY_ID] ?? null) : assistantKeys();
    const app = stored ? Object.keys(stored).length > 0 : assistantKeys() !== null;
    // With the panel's key back to its defaults, every plugin default comes back whole.
    const own = plugins.filter((p) => !p.unread && canResetAll(p, app ? [] : (storedLive ?? [])));
    const names = [...(app ? [appResetName()] : []), ...own.map((p) => p.name)];
    return { plugins, error, storedLive, app, own, names };
  };
  let now = await look();
  if (now.error) return { asked: false, reset: [], failed: [], error: now.error, keptOff: '' };
  const unreadOf = (list: PluginKeys[]) => list.filter((p) => p.unread).map((p) => ({ name: p.name, why: 'its keys could not be read' }));
  if (!now.app && !now.own.length) return { asked: false, reset: [], failed: unreadOf(now.plugins), error: '', keptOff: '' };
  if (!(await ask(now.names))) return { asked: true, reset: [], failed: [], error: '', keptOff: '' };
  if (opts.checked) {
    // The Assistant's: still what the person said Yes to (another tab, a workspace).
    const again = await look();
    if (again.error || JSON.stringify([again.names, again.storedLive]) !== JSON.stringify([now.names, now.storedLive])) {
      return { asked: true, reset: [], failed: [], error: '', keptOff: '', changed: true };
    }
    now = again;
  }
  const { storedLive, app, own } = now;
  const unread = unreadOf(now.plugins);
  const reset: string[] = [];
  const failed = [...unread];
  // The panel's key the plugins' defaults stay off: none once it is back to its defaults.
  let live: readonly string[] = storedLive ?? [];
  if (app) {
    try {
      await storeAppKeybinds(Object.fromEntries(CHANGEABLE_APP_KEYS.map((id) => [id, null])), from);
      reset.push(appResetName());
      live = [];
    } catch (e) {
      failed.push({ name: appResetName(), why: e instanceof Error ? e.message : String(e) });
    }
  }
  const done = await Promise.all(own.map(async (p) => ({ p, r: await resetAllKeys(p, from, live) })));
  reset.push(...done.filter((d) => d.r.ok).map((d) => d.p.name));
  failed.push(...done.flatMap((d) => (d.r.ok ? [] : [{ name: d.p.name, why: d.r.message }])));
  const kept = done.flatMap((d) => (d.r.ok ? d.r.keptOff : []));
  return { asked: true, reset, failed, error: '', keptOff: keptOffText(kept, name) };
}
