/**
 * Combos as people write and read them, for Settings → Keybinds and the Assistant's keybind tools:
 * parseCombo reads one however it is written ("ctrl+shift+r", "Cmd+Z", "Shift+KeyR", "Ctrl+\"),
 * displayCombo shows a stored one ("Ctrl+Shift+KeyR" -> "Ctrl+Shift+R"), typedCombo is the second
 * reading of a punctuation press (by the character it types). The CAD plugin reads keys the same
 * way (its keymap.ts parseCombo, displayCombo and combosOf) and refuses with the same words.
 */
import { isCombo, KEY_CODES } from './commands';

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
/** Modifier words a combo may use, and the modifier each one is (Cmd and Meta count as Ctrl). */
const MOD_WORDS: Readonly<Record<string, (typeof MODS)[number]>> = Object.freeze({
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  mod: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
});
/** Modifier keys a shortcut cannot use (the system or the layout keeps them). */
const NOT_MODS = new Set(['altgr', 'altgraph', 'win', 'windows', 'super', 'hyper', 'fn', 'os', 'capslock']);

/** The US-layout character of each punctuation key, by its code (and back). */
const PUNCT: Readonly<Record<string, string>> = Object.freeze({
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
});
const CODE_OF_CHAR: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(PUNCT).filter(([c]) => c !== 'IntlBackslash').map(([c, ch]) => [ch, c])),
  ' ': 'Space',
});

/** Names people write for keys, by the code they mean. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  esc: 'Escape',
  del: 'Delete',
  spacebar: 'Space',
  return: 'Enter',
  ins: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pgdown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  plus: 'Equal',
});

const q = (v: string) => JSON.stringify(v);
/** The refusal of text that names no combo, word for word the validators'. */
const notAKey = (raw: string) => `${q(raw)} is not a key (modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent.code such as KeyR)`;

/** Every key code by its lower-case name ("keyr" -> "KeyR"). */
const CODES: ReadonlyMap<string, string> = new Map([...KEY_CODES].map((c) => [c.toLowerCase(), c]));

/**
 * The code a key is written as: "r" / "R" / "KeyR" -> "KeyR", "1" / "Digit1" -> "Digit1", "\" ->
 * "Backslash", "esc" -> "Escape", "f2" -> "F2", "pgdn" -> "PageDown". "" for a name that is no key.
 */
export function keyCode(k: string): string {
  const s = String(k ?? '');
  if (!s) return '';
  if (s.length === 1) {
    if (/[a-z]/i.test(s)) return `Key${s.toUpperCase()}`;
    if (/\d/.test(s)) return `Digit${s}`;
    return CODE_OF_CHAR[s] ?? '';
  }
  const l = s.trim().toLowerCase();
  return ALIASES[l] ?? CODES.get(l) ?? '';
}

/** A combo read from text: the stored form, or why it is no combo. */
export type ParsedCombo = { ok: true; combo: string } | { ok: false; why: string };

/**
 * A combo however it is written ("ctrl+shift+r", "Cmd+Z", "Shift+KeyR", "1", "Ctrl+\", "Ctrl+PgDn"),
 * in the stored form ("Ctrl+Shift+KeyR", "Ctrl+KeyZ", "Shift+KeyR", "Digit1", "Ctrl+Backslash",
 * "Ctrl+PageDown"), or why not: a word that is no key, a modifier a shortcut cannot use (AltGr, Win),
 * two keys, no key at all, or a number-pad digit or Enter (a press gives Digit and Enter: the one
 * to write).
 */
export function parseCombo(text: string): ParsedCombo {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, why: notAKey(raw) };
  // "Ctrl++" names the plus key (Equal, shifted); "+" alone too.
  const plus = raw === '+' || raw.endsWith('++');
  const parts = (plus ? raw.slice(0, -1) : raw).split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = plus ? 'Equal' : '';
  let pad = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    const mod = MOD_WORDS[l];
    if (mod) {
      if (mods.has(mod)) return { ok: false, why: notAKey(raw) };
      mods.add(mod);
      continue;
    }
    if (key || NOT_MODS.has(l)) return { ok: false, why: notAKey(raw) };
    const padKey = /^numpad(\d)$/.exec(l) ? `Digit${l.slice(-1)}` : l === 'numpadenter' ? 'Enter' : '';
    if (padKey) {
      key = padKey;
      pad = p;
      continue;
    }
    key = keyCode(p);
    if (!key) return { ok: false, why: notAKey(raw) };
  }
  if (!key) return { ok: false, why: notAKey(raw) };
  const combo = [...MODS.filter((m) => mods.has(m)), key].join('+');
  if (pad) return { ok: false, why: `${q(raw)} never comes from a press: write ${q(combo)}` };
  return isCombo(combo) ? { ok: true, combo } : { ok: false, why: notAKey(raw) };
}

/**
 * A key code as people read it: a letter as itself ("KeyR" -> "R"), a digit as itself, punctuation
 * as on a US keyboard ("Slash" -> "/"), a named key by its name ("Delete", "F2").
 */
export function displayKey(code: string): string {
  const k = /^Key([A-Z])$/.exec(code);
  if (k) return k[1];
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  return PUNCT[code] ?? code;
}

/** A stored combo as people read it: "Ctrl+Shift+KeyR" -> "Ctrl+Shift+R", "Digit1" -> "1". */
export function displayCombo(combo: string): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  return [...parts, displayKey(key)].join('+');
}

/**
 * A punctuation press read by the character it types, when that names another key than its place
 * ("/" typed by a key that is not Slash's place): the app's and the browser's keys go by it too, as
 * the CAD plugin reads them (combosOf). null when there is no second reading.
 */
export function typedCombo(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, placed: string): string | null {
  if (e.key.length !== 1 || /[a-z]/i.test(e.key)) return null;
  const typed = keyCode(e.key);
  if (!typed || /^Key[A-Z]$/.test(typed)) return null;
  const held = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  const combo = [...held, typed].join('+');
  return combo !== placed && isCombo(combo) ? combo : null;
}
