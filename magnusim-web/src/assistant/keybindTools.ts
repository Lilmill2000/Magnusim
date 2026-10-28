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
 *   `key_taken` unless replace, nothing worked out from keys that could not be read (`unavailable`).
 */
import { APP_COMMANDS, APP_LOCAL_KEYS, RESERVED_KEYS } from '../keybinds/appCommands';
import {
  applyChange,
  commandsOf,
  contextLabel,
  isDefault,
  keysOf,
  loadPluginKeys,
  planChange,
  resetAllKeys,
  type KeyChange,
  type PluginKeys,
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
  "Settings → Keybinds: Change, Reset or Clear on the command's row (Reset all per plugin). In a workspace that has its own, also a right-click on the command's toolbar button: Set keybind.";

/** What the tools reach in the page: injected so the tests drive them without the app. */
export interface KeysRuntime {
  load(): Promise<{ plugins: PluginKeys[]; error: string }>;
  /** The app's confirm dialog: true on the person's Yes. */
  confirm(o: { title: string; copy: string; yes: string; no: string; signal: AbortSignal }): Promise<boolean>;
}

export const pageKeysRuntime = (): KeysRuntime => ({
  load: loadPluginKeys,
  // A guarded Yes (a deliberate click only) that Enter never answers.
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
  const ws = p.workspaces.find((w) => w.commands.includes(c))!;
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

/** core__keybinds. */
export async function coreKeybinds(input: Record<string, unknown>, rt: KeysRuntime): Promise<Outcome> {
  const plugin = str(input.plugin);
  const target = str(input.target);
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
    data.app = { note: "The app's own keys: they work everywhere and are never changed.", keys: [...APP_COMMANDS, ...APP_LOCAL_KEYS].map(appRow) };
    data.reserved = { note: 'Kept for the browser and the system: no command can have them.', keys: RESERVED_KEYS.map(appRow) };
  }
  return { ok: true, result: { data, summary: target ? `Keys of ${found} command${found === 1 ? '' : 's'}` : `Keys of ${list.length} plugin${list.length === 1 ? '' : 's'}` } };
}

/** The question the person answers, in their words. */
function question(p: PluginKeys, c: Command | null, change: KeyChange | { action: 'reset_all' }, took: Command[]): { title: string; copy: string; yes: string } {
  if (change.action === 'reset_all') return { title: 'Reset keybinds?', copy: `The Assistant asks to put every ${p.name} command back to its default keys.`, yes: 'Reset all' };
  const what = `${c!.label} (${p.name})`;
  const from = took.length ? `, taking it from ${took.map((t) => t.label).join(', ')}` : '';
  if (change.action === 'set') return { title: 'Change a keybind?', copy: `The Assistant asks to give ${what} the key ${displayCombo(change.combo)}${from}.`, yes: 'Change' };
  if (change.action === 'reset') {
    const keys = c!.keys.map(displayCombo).join(', ') || 'no key';
    return { title: 'Reset a keybind?', copy: `The Assistant asks to put ${what} back to its default: ${keys}${from}.`, yes: 'Reset' };
  }
  return { title: 'Clear a keybind?', copy: `The Assistant asks to leave ${what} with no key.`, yes: 'Clear' };
}

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
  const { plugins, error } = await rt.load();
  if (error) return fail('unavailable', error, 'Try again in a moment.');
  const p = pluginNamed(plugins, str(input.plugin));
  if (!p) return fail('not_found', `No plugin that is on has keys named "${str(input.plugin).slice(0, 80)}".`, 'core__keybinds lists them.');
  if (p.unread) return fail('unavailable', p.unread, 'Nothing is changed until they can be read: try again in a moment.');

  if (action === 'reset_all') {
    if (!Object.keys(p.overrides).some((id) => !isDefault(p, id))) return { ok: true, result: { data: { plugin: p.plugin, changed: false }, summary: `Every ${p.name} command has its defaults already` } };
    const stop = waiting(req);
    let yes = false;
    try {
      yes = await rt.confirm({ ...question(p, null, { action: 'reset_all' }, []), no: 'Keep them', signal: req.signal });
    } finally {
      stop();
    }
    if (!yes) return fail('step_declined', 'The person said no: nothing changed.');
    const r = await resetAllKeys(p);
    if (!r.ok) return fail('failed', r.message);
    return { ok: true, result: { data: { plugin: p.plugin, changed: true }, summary: `Every ${p.name} command has its default keys again` } };
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
  const stop = waiting(req);
  let yes = false;
  try {
    yes = await rt.confirm({ ...question(p, c, change, plan.took), no: 'Keep it', signal: req.signal });
  } finally {
    stop();
  }
  if (!yes) return fail('step_declined', 'The person said no: nothing changed.');
  const { result, plugin } = await applyChange(p, c.id, change);
  if (!result.ok) return fail(result.code === 'conflict' ? 'key_taken' : result.code === 'failed' ? 'failed' : 'invalid_input', result.message);
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
