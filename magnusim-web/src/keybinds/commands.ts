/**
 * A workspace's commands file (manifest `[[workspaces]] commands`, unreleased 1.9; authoring.md,
 * "Workspace commands"): the commands a workspace has, their default keys and the contexts they
 * act in, which Settings → Keybinds lists and lets the person change.
 *
 *   { "version": 1,
 *     "contexts": [{ "id": "sketch", "label": "Sketch" }],
 *     "commands": [{ "id": "sketch.rectangle", "label": "Rectangle", "group": "Draw",
 *                    "context": "sketch", "keys": ["KeyR"] }] }
 *
 * A key is a combo: the modifiers held, in the order Ctrl, Alt, Shift, Meta, then a
 * KeyboardEvent.code: "Ctrl+Shift+KeyR", "Delete", "F2", "Digit8". A press is read as the CAD
 * plugin reads it (comboOf): Cmd counts as Ctrl, a Latin letter by the letter it types (Ctrl+Z is
 * Undo on QWERTZ too), the number pad's digits and Enter as Digit and Enter, anything else by its
 * place. A command's context is one the file declares or "any" (every context). The person's own
 * keys are the plugin's prefs key "keybinds": { "<command id>": [combo, ...] }, [] for none, a
 * missing id for the defaults. The app's own keys (appCommands.ts): its "app" and "reserved" keys
 * are no command's; its "local" ones (Escape) a workspace may use.
 *
 * python/tools/workspace_commands.py checks the same rules for plugin:check, with the same
 * words: scripts/__tests__/fixtures/workspace-commands-cases.json holds the cases both pass.
 * Read a file with Response.json() (UTF-8, a BOM dropped, no NaN), as plugin:check reads it.
 */
import { APP_KEYS } from './appCommands';

export const COMMANDS_FORMAT = 1;
/** The context of a command that acts everywhere in its workspace. */
export const ANY_CONTEXT = 'any';
export const MAX_CONTEXTS = 32;
export const MAX_COMMANDS = 512;
export const MAX_KEYS = 4;

const CONTEXT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const COMMAND_ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

export interface CommandContext {
  id: string;
  label: string;
}

export interface Command {
  id: string;
  label: string;
  group: string;
  context: string;
  keys: string[];
  /** The file's `"projects": true`: the command acts only where the app has projects (Magnusim CAD lists none of them). */
  projects?: true;
}

export interface CommandsFile {
  version: number;
  contexts: CommandContext[];
  commands: Command[];
}

/**
 * Every KeyboardEvent.code a combo may end with: the codes a press can give (comboOf). The number
 * pad's digits and Enter are not among them: a press of one is read as Digit0…9 or Enter.
 */
export const KEY_CODES: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEqual',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
  'Backspace', 'Enter', 'Tab', 'Space', 'Escape',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma',
  'Period', 'Slash', 'IntlBackslash',
]);

/** Whether `s` is a combo: modifiers in the order Ctrl, Alt, Shift, Meta (each once), then a code. */
export function isCombo(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const parts = s.split('+');
  const code = parts.pop() as string;
  if (!KEY_CODES.has(code)) return false;
  let at = 0;
  for (const m of parts) {
    const i = MODIFIERS.indexOf(m as (typeof MODIFIERS)[number], at);
    if (i < 0) return false;
    at = i + 1;
  }
  return true;
}

/** The combo a number-pad digit or Enter key in `s` is read as ("Ctrl+Numpad5" -> "Ctrl+Digit5"), or null. */
function padAs(s: string): string | null {
  const fixed = s.replace(/(^|\+)Numpad(\d)$/, '$1Digit$2').replace(/(^|\+)NumpadEnter$/, '$1Enter');
  return fixed !== s && isCombo(fixed) ? fixed : null;
}

/**
 * The combo a key press is kept as, or null for a key no combo names (a modifier alone, say): Cmd
 * counts as Ctrl, a Latin letter is named by the letter it types, the number pad's digits and Enter
 * are Digit and Enter, anything else is its place (KeyboardEvent.code). The CAD plugin reads its
 * keys the same way (its keymap.ts combosOf), so a key Settings takes is one the page answers to.
 */
export function comboOf(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const letter = e.key.length === 1 && /[a-z]/i.test(e.key) ? `Key${e.key.toUpperCase()}` : '';
  const pad = /^Numpad(\d)$/.exec(e.code);
  const code = letter || (pad ? `Digit${pad[1]}` : e.code === 'NumpadEnter' ? 'Enter' : e.code);
  if (!KEY_CODES.has(code)) return null;
  const held = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...held, code].join('+');
}

/**
 * A value as the problems name it: text in JSON quotes, anything else by its kind. Both validators
 * word it alike (numbers would not print alike in JavaScript and Python).
 */
function q(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return 'a number';
  return Array.isArray(v) ? 'a list' : 'an object';
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// JavaScript's trim; workspace_commands.py strips the same characters.
const textOf = (v: unknown) => (typeof v === 'string' ? v.trim() : null);
/** Characters as a person counts them (code points, not UTF-16 units). */
const lengthOf = (s: string) => [...s].length;

type KeyHolder = { label: string; keys: readonly string[] };

/** The app's keys in its three groups (appCommands.ts APP_KEYS; plugin-sdk.json app_keys). */
export interface AppKeys {
  app: readonly KeyHolder[];
  local: readonly KeyHolder[];
  reserved: readonly KeyHolder[];
}

/** The keys no command may have, each with the words that say whose it is. */
function takenKeys(keys: AppKeys): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of keys.reserved) for (const k of c.keys) out.set(k, `is kept for the browser and the system (${c.label})`);
  for (const c of keys.app) for (const k of c.keys) out.set(k, `is the app's own key (${c.label})`);
  return out;
}

/**
 * Reads a commands file. Every problem is listed, in the file's order; with any, `file` is null
 * (Settings shows none of its commands and says why). Fields the format doesn't know are ignored.
 */
export function readCommandsFile(doc: unknown, appKeys: AppKeys = APP_KEYS): { file: CommandsFile | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(doc)) return { file: null, problems: ['the file is not a JSON object'] };
  if (doc.version !== COMMANDS_FORMAT) problems.push(`version must be ${COMMANDS_FORMAT}, the format this host reads`);
  const contexts: CommandContext[] = [];
  if (!Array.isArray(doc.contexts)) problems.push('contexts must be a list');
  else {
    if (doc.contexts.length > MAX_CONTEXTS) problems.push(`contexts: at most ${MAX_CONTEXTS}`);
    doc.contexts.forEach((c, i) => {
      if (!isObject(c)) return void problems.push(`contexts[${i}] is not an object`);
      const id = c.id;
      const valid = typeof id === 'string' && CONTEXT_ID_RE.test(id) && id !== ANY_CONTEXT;
      if (typeof id !== 'string' || !CONTEXT_ID_RE.test(id)) problems.push(`contexts[${i}].id ${q(id)} must be 1 to 32 of a-z, 0-9, _ and -, starting with a letter`);
      else if (id === ANY_CONTEXT) problems.push(`contexts[${i}].id "any" is reserved: it means every context`);
      else if (contexts.some((x) => x.id === id)) problems.push(`contexts[${i}].id ${q(id)} is declared twice`);
      const label = textOf(c.label);
      if (!label || lengthOf(label) > 40) problems.push(`contexts[${i}].label must be 1 to 40 characters`);
      if (valid) contexts.push({ id, label: label ?? '' });
    });
  }
  const declared = new Set(contexts.map((c) => c.id));
  const commands: Command[] = [];
  // Each command's name in a problem: its id, or its place when the id is not one.
  const names: string[] = [];
  const taken = takenKeys(appKeys);
  if (!Array.isArray(doc.commands) || !doc.commands.length || doc.commands.length > MAX_COMMANDS) {
    problems.push(`commands must be a list of 1 to ${MAX_COMMANDS} commands`);
  } else {
    doc.commands.forEach((c, i) => {
      if (!isObject(c)) return void problems.push(`commands[${i}] is not an object`);
      const id = c.id;
      const valid = typeof id === 'string' && COMMAND_ID_RE.test(id);
      if (!valid) problems.push(`commands[${i}].id ${q(id)} must be 1 to 64 of a-z, 0-9, _, - and ., starting with a letter`);
      else if (names.includes(id)) problems.push(`commands[${i}].id ${q(id)} is declared twice`);
      const label = textOf(c.label);
      if (!label || lengthOf(label) > 60) problems.push(`commands[${i}].label must be 1 to 60 characters`);
      const group = c.group === undefined ? '' : textOf(c.group);
      if (group === null || lengthOf(group) > 40) problems.push(`commands[${i}].group must be text of at most 40 characters`);
      const context = c.context;
      if (context !== ANY_CONTEXT && (typeof context !== 'string' || !declared.has(context))) {
        problems.push(`commands[${i}].context ${q(context)} is not a declared context or "any"`);
      }
      const keys: string[] = [];
      if (!Array.isArray(c.keys) || c.keys.length > MAX_KEYS) problems.push(`commands[${i}].keys must be a list of at most ${MAX_KEYS} keys`);
      else {
        for (const k of c.keys) {
          const pad = typeof k === 'string' ? padAs(k) : null;
          if (pad) problems.push(`commands[${i}].keys: ${q(k)} never comes from a press: write ${q(pad)}`);
          else if (!isCombo(k)) problems.push(`commands[${i}].keys: ${q(k)} is not a key (modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent.code such as KeyR)`);
          else if (keys.includes(k)) problems.push(`commands[${i}].keys: ${q(k)} is listed twice`);
          else if (taken.has(k)) problems.push(`commands[${i}].keys: ${q(k)} ${taken.get(k)}`);
          else keys.push(k);
        }
      }
      commands.push({ id: valid ? id : '', label: label ?? '', group: group ?? '', context: typeof context === 'string' ? context : '', keys, ...(c.projects === true ? { projects: true as const } : {}) });
      names.push(valid ? id : `commands[${i}]`);
    });
    // A key is one command's in a context: two commands whose contexts meet (the same, or either "any").
    commands.forEach((a, i) => {
      commands.slice(0, i).forEach((b, j) => {
        if (a.context !== b.context && a.context !== ANY_CONTEXT && b.context !== ANY_CONTEXT) return;
        for (const k of a.keys) if (b.keys.includes(k)) problems.push(`${q(k)} is the default key of both ${names[j]} and ${names[i]}, whose contexts meet`);
      });
    });
  }
  return problems.length ? { file: null, problems } : { file: { version: COMMANDS_FORMAT, contexts, commands }, problems };
}

/**
 * Command ids one plugin's workspaces both use. The person's keys are kept per plugin (its prefs key
 * "keybinds"), so a plugin's command ids are one set; plugin:check says the same.
 */
export function sharedCommandIds(workspaces: readonly { key: string; file: CommandsFile }[]): string[] {
  const owner = new Map<string, string>();
  const problems: string[] = [];
  for (const w of workspaces) {
    for (const c of w.file.commands) {
      const first = owner.get(c.id);
      if (first === undefined) owner.set(c.id, w.key);
      else if (first !== w.key) problems.push(`workspace ${q(w.key)}: command ${q(c.id)} is also workspace ${q(first)}'s: a plugin's command ids are one set, since the person's keys are kept per plugin`);
    }
  }
  return problems;
}

/**
 * The person's keys from the plugin's prefs key "keybinds": each known command id with its valid,
 * distinct combos ([] for none). `read` takes one stored key to its combo, or null: by default a
 * key must already be a combo; Settings passes one that also reads a key as people write it
 * ("shift+r"), as the CAD plugin's parseOverrides does. A combo no command may have (the app's "app" and "reserved" keys;
 * its "local" ones, Escape, are a workspace's to use) is left out, and so is an id whose every combo
 * was (it has its defaults). Anything else is left out too, so a stale or
 * hand-edited value never stops the rest. The result has no prototype: look ids up in it, a
 * missing one has its defaults.
 */
export function readKeybindOverrides(
  value: unknown,
  commands: readonly Pick<Command, 'id'>[],
  appKeys: AppKeys = APP_KEYS,
  read: (key: unknown) => string | null = (k) => (isCombo(k) ? k : null),
): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  if (!isObject(value)) return out;
  const known = new Set(commands.map((c) => c.id));
  const taken = takenKeys(appKeys);
  for (const [id, keys] of Object.entries(value)) {
    if (!known.has(id) || !Array.isArray(keys)) continue;
    const valid = [...new Set(keys.map(read).filter((k): k is string => !!k && !taken.has(k)))].slice(0, MAX_KEYS);
    if (keys.length && !valid.length) continue;
    out[id] = valid;
  }
  return out;
}
