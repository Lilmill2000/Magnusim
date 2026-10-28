/**
 * The Assistant's keybind tools on the core page (coreToolDefs.ts): what Settings → Keybinds shows
 * and does, through the same catalog (src/keybinds/catalog.ts), so the person and the Assistant see
 * and change the same keys.
 *
 * - core__keybinds reads them any time: the app's own keys, and each plugin's commands with their
 *   keys now, defaults and where each works.
 * - core__set_keybind changes one only when the person explicitly asked for that change in this
 *   request (person_asked; else `not_asked`), and then only after the person's Yes in the app's own
 *   confirm, every time (No: `step_declined`, nothing changes; Daniel, 2026-10-27: the AI can read
 *   keybinds but changes them only when the person asks). Its rules are Settings': refused keys,
 *   `key_taken` unless replace, nothing worked out from keys that could not be read (`unavailable`), and
 *   after the Yes the change is worked out again from the keys as they are then: one that differs
 *   from what the person was asked is `changed`, and nothing is written (as the CAD Part's own tools do).
 * - The Assistant panel's own key is plugin "app", command "app.assistant" (Daniel, 2026-10-27: it
 *   changes as a command does, under the same rule): a key any plugin command has is `key_taken`
 *   unless replace, and the question names each command it takes the key from.
 * - plugin "" with reset_all is Settings' Reset all keybinds: the panel's key and every plugin's
 *   commands back to their defaults, on one question in the same words.
 */
import { APP_COMMANDS, APP_LOCAL_KEYS, RESERVED_KEYS } from '../keybinds/appCommands';
import { refreshAppKeys } from '../keybinds/appKeys';
import {
  appKeyRows,
  appName,
  applyAppChange,
  applyChange,
  ASSISTANT_FROM,
  canResetAll,
  commandOf,
  commandsOf,
  contextLabel,
  isDefault,
  keptOffFor,
  keptOffText,
  keysOf,
  loadPluginKeys,
  planAppChange,
  planChange,
  resetAllKeys,
  resetEveryPlugin,
  resetEveryQuestion,
  type AppKeyChange,
  type AppKeyRow,
  type KeyChange,
  type PluginKeys,
  type Taker,
} from '../keybinds/catalog';
import { displayCombo, parseCombo } from '../keybinds/combo';
import type { Command } from '../keybinds/commands';
import type { AssistantCallOutcome, AssistantInvoke } from '../workspace/bridge';
import { confirmAction } from '../workbench/dialogs';
import { KEYBIND_ACTIONS } from './coreToolDefs';

type Outcome = AssistantCallOutcome;

const fail = (code: string, message: string, hint?: string): Outcome => ({ ok: false, code, message: message.slice(0, 400), ...(hint ? { hint } : {}) });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Where the person changes a key themselves. */
export const SET_IN =
  "Settings → Keybinds: Change, Reset or Clear on the command's row (Reset all per plugin, Reset all keybinds for every key), the Assistant panel's key on its row among the app's. In a workspace that has its own, also a right-click on the command's toolbar button: Set keybind.";

/** What the tools reach in the page: injected so the tests drive them without the app. */
export interface KeysRuntime {
  load(): Promise<{ plugins: PluginKeys[]; error: string }>;
  /** Reads the app's keys as stored and takes them on the page (the panel's key). */
  refreshApp(): Promise<void>;
  /** The app's confirm dialog: true on the person's Yes. */
  confirm(o: { title: string; copy: string; yes: string; signal: AbortSignal }): Promise<boolean>;
}

export const pageKeysRuntime = (): KeysRuntime => ({
  load: loadPluginKeys,
  refreshApp: refreshAppKeys,
  // A guarded Yes (a deliberate click only) that Enter never answers; its No is the app's Cancel.
  confirm: (o) => confirmAction({ ...o, guard: true, safe: true }),
});

const lower = (s: string) => s.toLowerCase();

/** A plugin named by key or name (any case). */
function pluginNamed(list: PluginKeys[], name: string): PluginKeys | null {
  const n = lower(name);
  return list.find((p) => lower(p.plugin) === n) ?? list.find((p) => lower(p.name) === n) ?? null;
}

/** The commands a target names: its id, else every command with that label (any case). */
function commandsNamed(p: PluginKeys, target: string): Command[] {
  const all = commandsOf(p);
  const byId = all.find((c) => c.id === target);
  if (byId) return [byId];
  const t = lower(target);
  return all.filter((c) => lower(c.id) === t || lower(c.label) === t);
}

function commandRow(p: PluginKeys, c: Command) {
  // By id: the command may be from an earlier read of the plugin.
  const ws = commandOf(p, c.id)?.ws ?? p.workspaces[0];
  const keys = keysOf(p, c.id);
  return {
    id: c.id,
    label: c.label,
    group: c.group,
    workspace: ws.workspace,
    where: contextLabel(ws, c.context),
    keys,
    shown: keys.map(displayCombo),
    defaults: c.keys,
    is_default: isDefault(p, c.id),
  };
}

const appRow = (c: { id: string; label: string; keys: readonly string[] }) => ({ id: c.id, label: c.label, keys: [...c.keys], shown: [...new Set(c.keys.map(displayCombo))] });

/** Keys as people read them, Cmd's own forms left out (Cmd counts as Ctrl). */
const appShown = (keys: readonly string[]) => [...new Set(keys.filter((k) => !k.includes('Meta')).map(displayCombo))];

/** The app's changeable key as core__keybinds lists it. */
const appKeyListed = (a: AppKeyRow) => ({
  id: a.id,
  label: a.label,
  where: 'Everywhere',
  keys: a.keys,
  shown: appShown(a.keys),
  defaults: a.defaults,
  is_default: a.isDefault,
  changeable: true,
});

/** The app's keys: the panel's as it is now (changeable), the others as published. */
function appKeysListed() {
  const own = appKeyRows();
  return [...APP_COMMANDS, ...APP_LOCAL_KEYS].map((c) => {
    const a = own.find((x) => x.id === c.id);
    return a ? appKeyListed(a) : appRow(c);
  });
}

/** Whether a plugin name names the app: "app" only (in Magnusim CAD the app's name is a plugin's too). */
const isApp = (name: string) => lower(name) === 'app';

/** core__keybinds. */
export async function coreKeybinds(input: Record<string, unknown>, rt: KeysRuntime): Promise<Outcome> {
  const plugin = str(input.plugin);
  const target = str(input.target);
  // The panel's key as stored (another tab, Settings): a failed read leaves the page's copy.
  await rt.refreshApp().catch(() => {});
  if (plugin && isApp(plugin)) {
    const t = lower(target);
    const keys = appKeysListed().filter((k) => !t || lower(k.id) === t || lower(k.label) === t);
    if (target && !keys.length) return fail('not_found', `${appName()} has no key "${target.slice(0, 120)}".`, "core__keybinds with plugin 'app' and target '' lists them.");
    return { ok: true, result: { data: { app: { name: appName(), keys }, set_in: SET_IN }, summary: `Keys of ${appName()}` } };
  }
  const { plugins, error } = await rt.load();
  if (error) return fail('unavailable', error, 'Try again in a moment.');
  let list = plugins;
  if (plugin) {
    const p = pluginNamed(plugins, plugin);
    if (!p) return fail('not_found', `No plugin that is on has keys named "${plugin.slice(0, 80)}".`, `On, with keys: ${plugins.map((x) => `${x.plugin} (${x.name})`).join(', ') || 'none'}.`);
    list = [p];
  }
  const rows = list.map((p) => {
    const commands = target ? commandsNamed(p, target) : commandsOf(p);
    return {
      plugin: p.plugin,
      name: p.name,
      ...(p.unread ? { unread: p.unread } : {}),
      workspaces: p.workspaces.map((w) => ({
        workspace: w.workspace,
        title: w.title,
        ...(w.error ? { error: w.error } : {}),
        commands: commands.filter((c) => w.commands.includes(c)).map((c) => commandRow(p, c)),
      })),
    };
  });
  const found = rows.reduce((n, r) => n + r.workspaces.reduce((m, w) => m + w.commands.length, 0), 0);
  if (target && !found) return fail('not_found', `No command "${target.slice(0, 120)}"${plugin ? ` in ${list[0].name}` : ''}.`, 'core__keybinds with target "" lists them.');
  const data: Record<string, unknown> = { plugins: rows, set_in: SET_IN };
  if (!plugin && !target) {
    data.app = {
      note: "The app's own keys: they work everywhere. Only the Assistant panel's (app.assistant, changeable) can be changed: core__set_keybind with plugin 'app'.",
      keys: appKeysListed(),
    };
    data.reserved = { note: 'Kept for the browser and the system: no command can have them.', keys: RESERVED_KEYS.map(appRow) };
  }
  return { ok: true, result: { data, summary: target ? `Keys of ${found} command${found === 1 ? '' : 's'}` : `Keys of ${list.length} plugin${list.length === 1 ? '' : 's'}` } };
}

/** Keys in the question: as people read them, joined with ", "; "no key" when none. */
const keysAsked = (keys: readonly string[]) => (keys.length ? keys.map(displayCombo).join(', ') : 'no key');

/** A command as the question names it: its label and where it works ("Rectangle (sketch)"). */
function whereName(p: PluginKeys, c: Command): string {
  const ws = commandOf(p, c.id)?.ws;
  return `${c.label} (${ws ? contextLabel(ws, c.context).toLowerCase() : c.context})`;
}

/**
 * The question the person answers, in the words the CAD Part's own keybind tools ask with (its
 * assistant/tools/workspace.ts): "<plugin> · <command>: <keys now> → <keys after>", and each command
 * a Replace takes the key from after "; " in the same form, named with where it works ("Fit
 * (everywhere)"). The command itself is named with where it works too when another command of the
 * plugin has its label (two "Delete"s). Its No is the app's Cancel.
 */
function question(p: PluginKeys, c: Command | null, action: string, keys: string[], took: Command[], after: (t: Command) => string[]): { title: string; copy: string; yes: string } {
  if (action === 'reset_all') {
    const kept = keptOffText(keptOffFor(p), displayCombo);
    return { title: 'Reset keybinds?', copy: `${p.name} · every command: its own keys → its default keys${kept ? ` (${kept.replace(/\.$/, '')})` : ''}`, yes: 'Reset all' };
  }
  const line = (name: string, from: readonly string[], to: readonly string[]) => `${p.name} · ${name}: ${keysAsked(from)} → ${keysAsked(to)}`;
  const shared = commandsOf(p).some((o) => o.id !== c!.id && o.label === c!.label);
  const copy = [line(shared ? whereName(p, c!) : c!.label, keysOf(p, c!.id), keys), ...took.map((t) => line(whereName(p, t), keysOf(p, t.id), after(t)))].join('; ');
  if (action === 'set') return { title: 'Change a keybind?', copy, yes: 'Change' };
  if (action === 'reset') return { title: 'Reset a keybind?', copy, yes: 'Reset' };
  return { title: 'Clear a keybind?', copy, yes: 'Clear' };
}

/**
 * What the question named, to tell the plan the person said Yes to from one made on the keys as
 * they are later: what it writes, the command's keys before and after, and each taker's keys now.
 */
const planKey = (p: PluginKeys, id: string, plan: { patch: Record<string, string[] | null>; keys: string[]; took: Command[] }) =>
  JSON.stringify({ patch: plan.patch, keys: plan.keys, from: keysOf(p, id), took: plan.took.map((t) => [t.id, keysOf(p, t.id)]) });

const CHANGED = 'The keybinds changed while the person was asked (in Settings, a workspace or another tab); nothing changed.';
const CHANGED_HINT = 'Call core__keybinds, then ask the person again with the new wording.';

/** While the person is asked, the call says it waits for them. */
function waiting(req: AssistantInvoke): () => void {
  req.onProgress(null, 'Waiting for you to confirm the keybind change', { waiting: true });
  const t = setInterval(() => req.onAlive?.(), 15_000);
  return () => {
    clearInterval(t);
    req.onProgress(null, '');
  };
}

/** core__set_keybind. */
export async function coreSetKeybind(input: Record<string, unknown>, req: AssistantInvoke, rt: KeysRuntime): Promise<Outcome> {
  const action = str(input.action);
  if (!(KEYBIND_ACTIONS as readonly string[]).includes(action)) return fail('invalid_input', `action is one of ${KEYBIND_ACTIONS.join(', ')}.`);
  if (input.person_asked !== true) {
    return fail('not_asked', 'Only change keybinds when the person explicitly asked for that change in this request; otherwise tell them how to do it themselves.', SET_IN);
  }
  if (isApp(str(input.plugin))) return setAppKeybind(input, action, req, rt);
  if (!str(input.plugin) && action === 'reset_all') return resetEverything(req, rt);
  const { plugins, error } = await rt.load();
  if (error) return fail('unavailable', error, 'Try again in a moment.');
  const p = pluginNamed(plugins, str(input.plugin));
  if (!p) return fail('not_found', `No plugin that is on has keys named "${str(input.plugin).slice(0, 80)}".`, 'core__keybinds lists them.');
  if (p.unread) return fail('unavailable', p.unread, 'Nothing is changed until they can be read: try again in a moment.');

  if (action === 'reset_all') {
    await rt.refreshApp().catch(() => {});
    if (!canResetAll(p)) return { ok: true, result: { data: { plugin: p.plugin, changed: false }, summary: `Every ${p.name} command has its defaults already` } };
    // What the question says stays off the defaults (the panel's key), as it is asked.
    const keptAsked = JSON.stringify(keptOffFor(p).map((k) => [k.command.id, k.keys]));
    const stop = waiting(req);
    let yes = false;
    try {
      yes = await rt.confirm({ ...question(p, null, 'reset_all', [], [], () => []), signal: req.signal });
    } finally {
      stop();
    }
    if (!yes) return fail('step_declined', 'The person said no: nothing changed.');
    // Read again: keys that cannot be read now are never reset.
    const again = await rt.load();
    const now = pluginNamed(again.plugins, p.plugin);
    if (again.error || (now && now.unread)) return fail('unavailable', again.error || now!.unread, 'Nothing is changed until they can be read: try again in a moment.');
    if (!now) return fail('changed', CHANGED, CHANGED_HINT);
    // The panel's key as stored now: what stays off must be what the question said.
    try {
      await rt.refreshApp();
    } catch (e) {
      return fail('unavailable', `The Assistant panel's key could not be read: ${e instanceof Error ? e.message : String(e)}`, 'Nothing is changed until it can be read: try again in a moment.');
    }
    if (JSON.stringify(keptOffFor(now).map((k) => [k.command.id, k.keys])) !== keptAsked) return fail('changed', CHANGED, CHANGED_HINT);
    const r = await resetAllKeys(now, ASSISTANT_FROM);
    if (!r.ok) return fail('failed', r.message);
    const kept = keptOffText(r.keptOff, displayCombo).replace(/\.$/, '');
    const summary = `Every ${p.name} command has its default keys again`;
    return {
      ok: true,
      result: {
        data: { plugin: p.plugin, changed: true, ...(kept ? { kept_off: r.keptOff.map((k) => ({ id: k.command.id, keys: k.keys })) } : {}) },
        // The kept-off words in full, or none (data.kept_off has them).
        summary: kept && summary.length + kept.length + 3 <= 160 ? `${summary} (${kept})` : summary,
      },
    };
  }

  const named = commandsNamed(p, str(input.command));
  if (!named.length) return fail('not_found', `${p.name} has no command "${str(input.command).slice(0, 120)}".`, `core__keybinds {plugin:'${p.plugin}', target:''} lists them.`);
  if (named.length > 1) return fail('invalid_input',`"${str(input.command).slice(0, 120)}" names ${named.length} commands: ${named.map((c) => c.id).join(', ')}.`, 'Pass the command id.');
  const c = named[0];
  let change: KeyChange;
  if (action === 'set') {
    const parsed = parseCombo(str(input.keys));
    if (!parsed.ok) return fail('invalid_input', parsed.why);
    change = { action: 'set', combo: parsed.combo, replace: input.replace === true };
  } else if (action === 'reset') change = { action: 'reset', replace: input.replace === true };
  else if (action === 'clear') change = { action: 'clear' };
  else return fail('invalid_input', `action is one of ${KEYBIND_ACTIONS.join(', ')}.`);

  // A Reset or a refusal reads the panel's key as stored (it may not be a command's).
  await rt.refreshApp().catch(() => {});
  const plan = planChange(p, c.id, change);
  if (!plan.ok) {
    if (plan.code === 'conflict') {
      return fail('key_taken', `${plan.message}.`, 'Ask the person whether to take it from them; with their yes, call again with replace true.');
    }
    // A key the app, the browser or the system keeps is no key this command can have.
    return fail(plan.code === 'unread' ? 'unavailable' : plan.code === 'unknown' ? 'not_found' : 'invalid_input', plan.message);
  }
  // Nothing to ask about: it has those keys already.
  if (!plan.took.length && JSON.stringify(plan.keys) === JSON.stringify(keysOf(p, c.id))) {
    return { ok: true, result: { data: { ...commandRow(p, c), changed: false }, summary: `${c.label} has those keys already` } };
  }
  const after = (t: Command) => (plan.patch[t.id] === null ? t.keys : (plan.patch[t.id] ?? keysOf(p, t.id)));
  const asked = question(p, c, action, plan.keys, plan.took, after);
  const stop = waiting(req);
  let yes = false;
  try {
    yes = await rt.confirm({ ...asked, signal: req.signal });
  } finally {
    stop();
  }
  if (!yes) return fail('step_declined', 'The person said no: nothing changed.');
  // The person said Yes to that question: the change must still be the one it named. The write
  // works it out again from the keys as it reads them, in the same turn (Settings, a workspace or
  // another tab may have changed them while the question was open), and writes nothing if it differs.
  const asKey = planKey(p, c.id, plan);
  // The panel's key as stored now: the key asked about may have become it meanwhile (refused then).
  await rt.refreshApp().catch(() => {});
  const still = (now: PluginKeys) => {
    const again = planChange(now, c.id, change);
    return again.ok && planKey(now, c.id, again) === asKey;
  };
  const { result, plugin } = await applyChange(p, c.id, change, undefined, ASSISTANT_FROM, still);
  if (!result.ok) {
    if (result.code === 'changed') return fail('changed', CHANGED, CHANGED_HINT);
    // Their keys could not be read again (a busy app): nothing written.
    if (result.code === 'unread') return fail('unavailable', result.message, 'Nothing is changed until they can be read: try again in a moment.');
    // The write itself was refused (the plugin's prefs full, the plugin turned off).
    if (result.code === 'failed') return fail('failed', result.message);
    return fail(result.code === 'conflict' ? 'key_taken' : 'invalid_input', result.message);
  }
  const took = result.took.map((t) => ({ id: t.id, label: t.label, keys: keysOf(plugin, t.id) }));
  const shown = result.keys.map(displayCombo).join(', ') || 'no key';
  return {
    ok: true,
    result: {
      data: { ...commandRow(plugin, c), changed: true, ...(took.length ? { took } : {}) },
      summary: `${c.label}: ${shown}`.slice(0, 160),
    },
  };
}

/** The panel's keys in the question: its defaults as Ctrl+/, else as people read them. */
const appKeysAsked = (id: string, keys: readonly string[]) => {
  if (!keys.length) return 'no key';
  const defaults = appKeyRows().find((a) => a.id === id)?.defaults ?? [];
  return keys.length === defaults.length && keys.every((k, i) => k === defaults[i]) ? appShown(keys)[0] : appShown(keys).join(', ');
};

/** What a question about the app's key named, to tell it from a plan made on the keys later. */
const appPlanKey = (id: string, plan: { stored: string[] | null; took: Taker[] }) =>
  JSON.stringify({ stored: plan.stored, from: appKeyRows().find((a) => a.id === id)?.keys ?? [], took: plan.took.map((t) => [t.plugin.plugin, t.command.id, t.before]) });

/** core__set_keybind for the app's own key (plugin "app"): the Assistant panel's. */
async function setAppKeybind(input: Record<string, unknown>, action: string, req: AssistantInvoke, rt: KeysRuntime): Promise<Outcome> {
  await rt.refreshApp().catch(() => {});
  const rows = appKeyRows();
  const target = lower(str(input.command));
  const a = rows.find((r) => lower(r.id) === target || lower(r.label) === target) ?? (target ? null : rows[0]);
  if (!a) return fail('not_found', `${appName()} has no key "${str(input.command).slice(0, 120)}" that can be changed.`, `Only ${rows.map((r) => `${r.id} (${r.label})`).join(', ')} can be.`);
  let change: AppKeyChange;
  if (action === 'set') {
    const parsed = parseCombo(str(input.keys));
    if (!parsed.ok) return fail('invalid_input', parsed.why);
    change = { action: 'set', combo: parsed.combo, replace: input.replace === true };
  } else if (action === 'reset' || action === 'reset_all') change = { action: 'reset' };
  else change = { action: 'clear' };
  // Whether a plugin command has the key: every plugin's keys as read now.
  const { plugins, error } = await rt.load();
  if (error) return fail('unavailable', error, 'Try again in a moment.');
  const plan = planAppChange(plugins, a.id, change);
  if (!plan.ok) {
    if (plan.code === 'conflict') return fail('key_taken', `${plan.message}.`, 'Ask the person whether to take it from them; with their yes, call again with replace true.');
    if (plan.code === 'unread') return fail('unavailable', plan.message, 'Nothing is changed until every plugin\'s keys can be read: try again in a moment.');
    return fail(plan.code === 'unknown' ? 'not_found' : 'invalid_input', plan.message);
  }
  const listed = () => appKeyListed(appKeyRows().find((r) => r.id === a.id) ?? a);
  if (!plan.took.length && JSON.stringify(plan.stored) === JSON.stringify(a.isDefault ? null : a.keys)) {
    return { ok: true, result: { data: { ...listed(), changed: false }, summary: `${a.label} has those keys already` } };
  }
  const line = `${appName()} · ${a.label}: ${appKeysAsked(a.id, a.keys)} → ${appKeysAsked(a.id, plan.keys)}`;
  const takers = plan.took.map((t) => `${t.plugin.name} · ${whereName(t.plugin, t.command)}: ${keysAsked(t.before)} → ${keysAsked(t.after)}`);
  const copy = [line, ...takers].join('; ');
  const asked =
    change.action === 'set'
      ? { title: 'Change a keybind?', copy, yes: 'Change' }
      : change.action === 'reset'
        ? { title: 'Reset a keybind?', copy, yes: 'Reset' }
        : { title: 'Clear a keybind?', copy, yes: 'Clear' };
  // What the question names, as it is asked: a change heard while it is open is not this one.
  const asKey = appPlanKey(a.id, plan);
  const stop = waiting(req);
  let yes = false;
  try {
    yes = await rt.confirm({ ...asked, signal: req.signal });
  } finally {
    stop();
  }
  if (!yes) return fail('step_declined', 'The person said no: nothing changed.');
  // The change must still be the one the person said Yes to: worked out again on the keys as
  // they are now; each write then checks its own keys once more as it reads them.
  await rt.refreshApp().catch(() => {});
  const again = await rt.load();
  if (again.error) return fail('unavailable', again.error, 'Nothing is changed until they can be read: try again in a moment.');
  const replan = planAppChange(again.plugins, a.id, change);
  if (!replan.ok && replan.code === 'unread') return fail('unavailable', replan.message, 'Nothing is changed until every plugin\'s keys can be read: try again in a moment.');
  if (!replan.ok || appPlanKey(a.id, replan) !== asKey) return fail('changed', CHANGED, CHANGED_HINT);
  const { result } = await applyAppChange(again.plugins, a.id, change, undefined, ASSISTANT_FROM, true);
  if (!result.ok) {
    // Stopped part way and a command could not get its key back: say so as it is.
    if ('lost' in result && result.lost?.length) return fail('failed', result.message, "Tell the person which command lost its key; they give it back in Settings → Keybinds.");
    if (result.code === 'changed') return fail('changed', CHANGED, CHANGED_HINT);
    if (result.code === 'unread') return fail('unavailable', result.message, 'Nothing is changed until they can be read: try again in a moment.');
    if (result.code === 'conflict') return fail('key_taken', result.message);
    return fail(result.code === 'failed' ? 'failed' : 'invalid_input', result.message);
  }
  const took = result.took.map((t) => ({ plugin: t.plugin.plugin, id: t.command.id, label: t.command.label, keys: t.after }));
  const shown = appKeysAsked(a.id, result.keys);
  return {
    ok: true,
    result: {
      data: { ...listed(), changed: true, ...(took.length ? { took } : {}) },
      summary: `${a.label}: ${shown}`.slice(0, 160),
    },
  };
}

/**
 * core__set_keybind plugin "" reset_all: Settings' Reset all keybinds (the panel's key and every
 * plugin's commands), on the same question, guarded; after the Yes it is still what was asked, or
 * `changed`.
 */
async function resetEverything(req: AssistantInvoke, rt: KeysRuntime): Promise<Outcome> {
  const out = await resetEveryPlugin(
    async (names) => {
      const stop = waiting(req);
      try {
        return await rt.confirm({ ...resetEveryQuestion(names), signal: req.signal });
      } finally {
        stop();
      }
    },
    displayCombo,
    { from: ASSISTANT_FROM, checked: true },
  );
  if (out.error) return fail('unavailable', out.error, 'Try again in a moment.');
  if (!out.asked) return { ok: true, result: { data: { changed: false, ...(out.failed.length ? { not_read: out.failed } : {}) }, summary: 'Every key is its default already' } };
  if (out.changed) return fail('changed', CHANGED, CHANGED_HINT);
  if (!out.reset.length && !out.failed.length) return fail('step_declined', 'The person said no: nothing changed.');
  const failed = out.failed.map((f) => `${f.name} (${f.why})`).join(', ');
  if (!out.reset.length) return fail('failed', `Not reset: ${failed}${out.keptOff ? `. ${out.keptOff}` : ''}`);
  return {
    ok: true,
    result: {
      data: { changed: true, reset: out.reset, ...(out.failed.length ? { not_reset: out.failed } : {}), ...(out.keptOff ? { kept_off: out.keptOff } : {}) },
      summary: (failed ? `Reset ${out.reset.join(', ')}; not reset: ${failed}` : `Reset ${out.reset.join(', ')}`).slice(0, 160),
    },
  };
}
