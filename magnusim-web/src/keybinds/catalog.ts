/**
 * Every key the person can see and set, for Settings → Keybinds and the Assistant's keybind tools:
 * the app's own (appCommands.ts: shown, never changed) and each plugin's workspace commands (the
 * catalog row's `workspaces[].commands`, read as commands.ts reads it), with the person's keys from
 * the plugin's prefs key "keybinds" ({ "<command id>": [combo, ...] }, [] for none, a missing id
 * for the defaults). Only a plugin that is on is listed: its prefs are reachable only then.
 *
 * A change follows the CAD plugin's rules (its keybinds.ts), so Settings and the Part agree:
 * - Change gives the command that one key. A key the app, the browser or the system keeps is
 *   refused (refusalOf); a key another command of the same workspace has where the two meet (the
 *   same context, or either is "any") is a conflict, which Replace takes from that command.
 * - Reset puts the defaults back (a default another command took meanwhile is a conflict unless
 *   Replace); Clear leaves the command no key; Reset all drops every one of the person's keys.
 * - No change is worked out from keys that were not read (`unread`): it would name the wrong
 *   takers and write over the saved ones.
 * A write reads the stored value again and changes only the ids it touches (keys set elsewhere
 * meanwhile, and ids this list doesn't know, stay), then announces it on the prefs channel, so an
 * open workspace of that plugin (this tab or another) takes it at once.
 */
import { APP_COMMANDS, APP_KEYS, APP_LOCAL_KEYS, RESERVED_KEYS } from './appCommands';
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
  return { ...out, contexts: file.contexts, commands: file.commands };
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
  const reserved = RESERVED_KEYS.find((c) => c.keys.includes(combo));
  if (reserved) return `${name(combo)} is kept for the browser and the system (${reserved.label})`;
  const local = APP_LOCAL_KEYS.find((c) => c.keys.includes(combo));
  if (local) return `${name(combo)} is the app's own key in dialogs, menus and modes (${local.label}): only a command's own default can be it`;
  return '';
}

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

/** Every command of a plugin back to its defaults: the plugin as stored now, or why not. */
export async function resetAllKeys(p: PluginKeys, from = SETTINGS_FROM): Promise<{ ok: true; plugin: PluginKeys } | { ok: false; message: string }> {
  if (p.unread) return { ok: false, message: p.unread };
  try {
    await store(p.plugin, {}, true, from);
    return { ok: true, plugin: { ...p, overrides: noKeys() } };
  } catch (e) {
    return { ok: false, message: `Could not save the keys: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Whether any command of a plugin has keys of the person's own. */
export const hasOwnKeys = (p: PluginKeys): boolean => Object.keys(p.overrides).some((id) => !isDefault(p, id));

/**
 * Settings → Keybinds' Reset all keybinds: every plugin's commands back to their defaults, after
 * one `ask` naming the plugins it changes (none asked when there is nothing to reset). What it
 * reset, and each plugin it could not, with why in a few words (its keys not read, or the write
 * refused).
 */
export async function resetEveryPlugin(ask: (names: string[]) => Promise<boolean>): Promise<{ asked: boolean; reset: string[]; failed: { name: string; why: string }[]; error: string }> {
  const { plugins, error } = await loadPluginKeys();
  if (error) return { asked: false, reset: [], failed: [], error };
  const unread = plugins.filter((p) => p.unread).map((p) => ({ name: p.name, why: 'its keys could not be read' }));
  const own = plugins.filter((p) => !p.unread && hasOwnKeys(p));
  if (!own.length) return { asked: false, reset: [], failed: unread, error: '' };
  if (!(await ask(own.map((p) => p.name)))) return { asked: true, reset: [], failed: [], error: '' };
  const done = await Promise.all(own.map(async (p) => ({ p, r: await resetAllKeys(p) })));
  return {
    asked: true,
    reset: done.filter((d) => d.r.ok).map((d) => d.p.name),
    failed: [...unread, ...done.flatMap((d) => (d.r.ok ? [] : [{ name: d.p.name, why: d.r.message }]))],
    error: '',
  };
}
