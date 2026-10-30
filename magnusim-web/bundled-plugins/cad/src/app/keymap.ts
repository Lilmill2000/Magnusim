// The CAD workspace's one command and keybinding registry: every command (the toolbar's, the
// sketch tools', the keyboard-only ones) with its id, label, group, context and default keys. The
// keyboard binds from it (src/app/keyboard.ts bindCommandShortcuts, src/app/keybinds.ts
// bindCommandKeys), the tooltips and menus show it (CommandRegistry fills CommandDef.shortcut),
// the person's overrides change it (src/app/keybinds.ts, ws.prefs "keybinds"), the Assistant reads
// and sets it (workspace keybind_*), and the build writes it as workspace/commands.json for the
// host's Settings (scripts/build.mjs, manifest [workspace] commands, host API 1.9).
// tests/app/keymap.test.ts holds it to the booted app: every registered command has its entry
// (same label, same context), no id twice, no default conflict, none of the app's own keys.
// Combos are written with KeyboardEvent.code names: modifiers in the order Ctrl, Alt, Shift, Meta,
// then the code: "Ctrl+Shift+KeyR", "KeyR", "Digit8", "Delete", "F2", "Enter", "Ctrl+Backslash".
// A press matches the way the app always matched (combosOf): a Latin letter by the letter the key
// types (Ctrl+Z is Undo on QWERTZ and AZERTY too), anything else by the key's place, punctuation
// also by the character it types. Cmd counts as Ctrl, so Meta never reaches a binding. People read
// them as "Shift+R", "Ctrl+\" (displayCombo). A conflict is the same combo in the same context,
// or with either side 'any'; the app's app-wide shortcuts (APP_SHORTCUTS) are 'any' on every screen,
// and so is the Assistant panel's key the person chose in Settings (src/app/keybinds.ts).
// Escape stays built in (cancel, close, let go of the selection, a sketch tool's step back): it is
// the app's, never a command's key.
// No runtime imports: scripts/build.mjs imports this file with Node's type stripping.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Where a key works: the plugin's own contexts (sketch mode, model mode), or 'any' (both). */
export type KeyContext = 'sketch' | 'model' | 'any';

/** The contexts commands.json names, with the words Settings shows for them. */
export const CONTEXTS: readonly { id: Exclude<KeyContext, 'any'>; label: string }[] = Object.freeze([
  { id: 'sketch', label: 'Sketch' },
  { id: 'model', label: 'Model' },
]);

export interface KeymapEntry {
  /** The command id ("sketch.rectangle"), or a keyboard-only action's ("ui.delete"). */
  id: string;
  /** As the command's label (sentence case). */
  label: string;
  /** Where Settings lists it ("Sketch: Draw", "View", "Edit"). */
  group: string;
  context: KeyContext;
  /** Default combos, normalised; [] = none by default (the person can give it one). */
  keys: readonly string[];
  /** A keyboard-only action: no command of the registry runs it (its own handler binds the keys). */
  keyOnly?: true;
  /**
   * Only where the host has projects (Magnusim): Magnusim CAD (the welcome's projectLinks false) has
   * no such command, and neither the Part's keybinds (keymapFor) nor its Settings list it
   * (commands.json carries "projects": true, which that app's Settings leaves out).
   */
  projects?: true;
}

/** Keys the app, the browser or the system keeps, under the words that say what they do. */
export interface AppKeyGroup {
  label: string;
  keys: readonly string[];
}

const group = (label: string, keys: readonly string[]): AppKeyGroup => Object.freeze({ label, keys: Object.freeze([...keys]) });

/** What the app's Assistant panel key does, in the host's words (its refusals name it so). */
export const ASSISTANT_PANEL = 'Open or close the Assistant panel';

/**
 * Magnusim's own keys, exactly as the host's contract has them (src/keybinds/appCommands.ts
 * APP_KEYS, published as docs/plugins/plugin-sdk.json `app_keys`, from the CAD Standalone session).
 * Embedded here until that commit reaches this base; then the build reads plugin-sdk.json app_keys.
 *  - app: keys the app acts on wherever the person is: a conflict in every context. Ctrl+/ (Cmd+/
 *    on macOS, the number pad's / too) opens or closes the Assistant panel; inside the frame the SDK
 *    forwards it unless the page calls preventDefault. No default and no keybind may take one.
 *    These are the published defaults: the panel's key the person chose in Settings → Keybinds
 *    (ws.context.assistantKeys) is refused as well while it is theirs (isAssistantCombo: the
 *    number pad's / when theirs is on /, as here), and its press is the app's (isAssistantPress).
 *  - local: keys the app acts on only while something of its own is open; a page may use them.
 *    Keys typed in the Part never reach the host: Escape is CAD's built-in cancel key
 *    (BUILT_IN_KEYS), never a command's key.
 *  - reserved: keys the browser, the desktop app or the system takes before the page; no default
 *    and no keybind may take one.
 * Like every key check, these read a letter by the letter the key types (combosOf): on AZERTY the
 * key labelled W is Ctrl+W. A press never gives Meta (Cmd counts as Ctrl).
 */
export const APP_SHORTCUTS: Readonly<{ app: readonly AppKeyGroup[]; local: readonly AppKeyGroup[]; reserved: readonly AppKeyGroup[] }> = Object.freeze({
  app: Object.freeze([group(ASSISTANT_PANEL, ['Ctrl+Slash', 'Meta+Slash', 'Ctrl+NumpadDivide', 'Meta+NumpadDivide', 'Ctrl+Meta+Slash', 'Ctrl+Meta+NumpadDivide'])]),
  local: Object.freeze([group('Close the open dialog, menu or mode', ['Escape'])]),
  reserved: Object.freeze([
    group('Close the tab', ['Ctrl+KeyW', 'Ctrl+F4']),
    group('Close the window', ['Ctrl+Shift+KeyW', 'Alt+F4']),
    group('Open a new tab', ['Ctrl+KeyT', 'Ctrl+Shift+KeyT']),
    group('Open a new window', ['Ctrl+KeyN', 'Ctrl+Shift+KeyN']),
    group('Switch tabs', ['Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', ...'123456789'.split('').map((d) => `Ctrl+Digit${d}`)]),
    group('Reload the page', ['Ctrl+KeyR', 'Ctrl+Shift+KeyR', 'F5', 'Ctrl+F5']),
    group('Open the developer tools', ['Ctrl+Shift+KeyI', 'Ctrl+Shift+KeyJ', 'F12']),
    group('Full screen', ['F11']),
    group('Print the page', ['Ctrl+KeyP']),
    group('Zoom the page', ['Ctrl+Equal', 'Ctrl+Shift+Equal', 'Ctrl+Minus', 'Ctrl+Digit0', 'Ctrl+NumpadAdd', 'Ctrl+NumpadSubtract']),
    group('Move between controls', ['Tab', 'Shift+Tab']),
  ]),
});

/** CAD's built-in keys: never a command's (Escape cancels, closes and lets go of the selection in the Part). */
export const BUILT_IN_KEYS: readonly AppKeyGroup[] = Object.freeze([group('it cancels, closes and lets go of the selection', ['Escape'])]);

const e = (id: string, label: string, group: string, context: KeyContext, keys: readonly string[] = [], keyOnly = false): KeymapEntry =>
  Object.freeze({ id, label, group, context, keys: Object.freeze([...keys]), ...(keyOnly ? { keyOnly: true as const } : {}) });

const VIEWS: readonly [string, string][] = [
  ['front', 'Front view'],
  ['back', 'Back view'],
  ['left', 'Left view'],
  ['right', 'Right view'],
  ['top', 'Top view'],
  ['bottom', 'Bottom view'],
  ['iso', 'Isometric view'],
  ['iso_back', 'Back isometric view'],
];

/** Every command and keyboard action, in the order Settings lists them. */
export const KEYMAP: readonly KeymapEntry[] = Object.freeze([
  // ---- both modes, and the model's edit keys
  e('edit.undo', 'Undo', 'Edit', 'model', ['Ctrl+KeyZ']),
  e('edit.redo', 'Redo', 'Edit', 'model', ['Ctrl+KeyY', 'Ctrl+Shift+KeyZ']),
  e('ui.delete', 'Delete selected features or bodies', 'Edit', 'model', ['Delete'], true),
  e('ui.rename', 'Rename the selected feature or body', 'Edit', 'any', ['F2'], true),
  e('ui.toggle-rail', 'Show or hide the tree (the Sketch panel in a sketch)', 'View', 'any', ['Ctrl+Backslash'], true),
  e('view.fit', 'Fit', 'View', 'any', ['KeyF']),
  ...VIEWS.map(([v, label], i) => e(`view.${v}`, label, 'View', 'any', [`Digit${i + 1}`])),
  e('view.normal-to', 'Normal to', 'View', 'model', ['KeyN']),
  // ---- model mode: the toolbar, group by group
  e('sketch.new', 'Sketch', 'Sketch', 'model'),
  e('solid.extrude', 'Extrude', 'Solid', 'model', ['KeyE']),
  e('solid.revolve', 'Revolve', 'Solid', 'model'),
  e('solid.sweep', 'Sweep', 'Solid', 'model'),
  e('solid.loft', 'Loft', 'Solid', 'model'),
  e('solid.hole', 'Hole', 'Solid', 'model'),
  e('pattern.linear', 'Linear pattern', 'Pattern', 'model'),
  e('pattern.circular', 'Circular pattern', 'Pattern', 'model'),
  e('pattern.mirror', 'Mirror', 'Pattern', 'model'),
  e('modify.parameters', 'Parameters', 'Modify', 'model'),
  e('modify.press-pull', 'Press-pull', 'Modify', 'model', ['KeyQ']),
  e('modify.fillet', 'Fillet', 'Modify', 'model'),
  e('modify.chamfer', 'Chamfer', 'Modify', 'model'),
  e('modify.shell', 'Shell', 'Modify', 'model'),
  e('modify.combine', 'Combine', 'Modify', 'model'),
  e('modify.split', 'Split', 'Modify', 'model'),
  e('modify.delete-faces', 'Delete faces', 'Modify', 'model'),
  // Move/copy body: M, as Fusion's Move (free in model mode; M is Mirror only in a sketch).
  e('modify.move-body', 'Move/copy body', 'Modify', 'model', ['KeyM']),
  e('construct.plane', 'Plane', 'Construct', 'model'),
  e('construct.axis', 'Axis', 'Construct', 'model'),
  e('construct.point', 'Point', 'Construct', 'model'),
  // CFD PREP: Magnusim's alone (Magnusim CAD has no simulation, and no Enclosure command).
  Object.freeze({ ...e('cfd.enclosure', 'Enclosure', 'CFD prep', 'model'), projects: true as const }),
  e('inspect.measure', 'Measure', 'Inspect', 'model'),
  // Section view: X, a cross-section (free in model mode; X is Construction only in a sketch).
  e('inspect.section', 'Section view', 'Inspect', 'model', ['KeyX']),
  // See-through: the selected bodies drawn see-through, or opaque again (no default key).
  e('inspect.see-through', 'See-through', 'Inspect', 'model'),
  e('inspect.find', 'Find', 'Inspect', 'model'),
  e('inspect.mass', 'Mass properties', 'Inspect', 'model'),
  e('inspect.check', 'Check', 'Inspect', 'model'),
  e('file.import-step', 'Import STEP', 'File', 'model'),
  e('file.export-step', 'Export STEP', 'File', 'model'),
  e('file.picture', 'Picture', 'File', 'model'),
  e('scale.banana', 'Banana for scale', 'Scale models', 'model'),
  // ---- sketch mode
  e('sketch.enter', 'Place or finish', 'Sketch', 'sketch', ['Enter']),
  e('sketch.finish', 'Finish sketch', 'Sketch', 'sketch'),
  e('sketch.undo', 'Undo', 'Sketch', 'sketch', ['Ctrl+KeyZ']),
  e('sketch.redo', 'Redo', 'Sketch', 'sketch', ['Ctrl+KeyY', 'Ctrl+Shift+KeyZ']),
  e('sketch.delete', 'Delete', 'Sketch', 'sketch', ['Delete']),
  e('sketch.copy', 'Copy', 'Sketch', 'sketch', ['Ctrl+KeyC']),
  e('sketch.paste', 'Paste', 'Sketch', 'sketch', ['Ctrl+KeyV']),
  e('view.sketch-look', 'Normal to', 'Sketch', 'sketch', ['KeyN']),
  e('view.sketch-relations', 'Show relations', 'Sketch', 'sketch', ['Shift+KeyR']),
  e('sketch.line', 'Line', 'Sketch: Draw', 'sketch', ['KeyL']),
  e('sketch.centerline', 'Centerline', 'Sketch: Draw', 'sketch'),
  e('sketch.line-midpoint', 'Midpoint line', 'Sketch: Draw', 'sketch'),
  e('sketch.rectangle', 'Rectangle', 'Sketch: Draw', 'sketch', ['KeyR']),
  e('sketch.rectangle-center', 'Center rectangle', 'Sketch: Draw', 'sketch'),
  e('sketch.rectangle-3pt', '3-point corner rectangle', 'Sketch: Draw', 'sketch'),
  e('sketch.rectangle-center-3pt', '3-point center rectangle', 'Sketch: Draw', 'sketch'),
  e('sketch.parallelogram', 'Parallelogram', 'Sketch: Draw', 'sketch'),
  e('sketch.circle', 'Circle', 'Sketch: Draw', 'sketch', ['KeyC']),
  e('sketch.circle-3pt', 'Perimeter circle', 'Sketch: Draw', 'sketch'),
  e('sketch.arc', '3-point arc', 'Sketch: Draw', 'sketch', ['KeyA']),
  e('sketch.arc-tangent', 'Tangent arc', 'Sketch: Draw', 'sketch'),
  e('sketch.arc-center', 'Centerpoint arc', 'Sketch: Draw', 'sketch'),
  e('sketch.sector', 'Sector', 'Sketch: Draw', 'sketch'),
  e('sketch.slot', 'Center-to-center slot', 'Sketch: Draw', 'sketch'),
  e('sketch.slot-overall', 'Overall slot', 'Sketch: Draw', 'sketch'),
  e('sketch.slot-center-point', 'Center-point slot', 'Sketch: Draw', 'sketch'),
  e('sketch.slot-arc-3pt', '3-point arc slot', 'Sketch: Draw', 'sketch'),
  e('sketch.slot-arc-center', 'Center-point arc slot', 'Sketch: Draw', 'sketch'),
  e('sketch.polygon', 'Polygon', 'Sketch: Draw', 'sketch'),
  e('sketch.spline', 'Spline', 'Sketch: Draw', 'sketch', ['KeyS']),
  e('sketch.spline-control', 'Control-point spline', 'Sketch: Draw', 'sketch'),
  e('sketch.ellipse', 'Ellipse', 'Sketch: Draw', 'sketch'),
  e('sketch.ellipse-partial', 'Partial ellipse', 'Sketch: Draw', 'sketch'),
  e('sketch.parabola', 'Parabola', 'Sketch: Draw', 'sketch'),
  e('sketch.conic', 'Conic', 'Sketch: Draw', 'sketch'),
  e('sketch.point', 'Point', 'Sketch: Draw', 'sketch'),
  e('sketch.construction', 'Construction', 'Sketch: Draw', 'sketch', ['KeyX']),
  e('sketch.trim', 'Trim', 'Sketch: Modify', 'sketch', ['KeyT']),
  e('sketch.extend', 'Extend', 'Sketch: Modify', 'sketch'),
  e('sketch.offset', 'Offset', 'Sketch: Modify', 'sketch', ['KeyO']),
  e('sketch.fillet', 'Fillet', 'Sketch: Modify', 'sketch'),
  e('sketch.chamfer', 'Chamfer', 'Sketch: Modify', 'sketch'),
  e('sketch.mirror', 'Mirror', 'Sketch: Modify', 'sketch', ['KeyM']),
  e('sketch.pattern-linear', 'Linear pattern', 'Sketch: Modify', 'sketch'),
  e('sketch.pattern-circular', 'Circular pattern', 'Sketch: Modify', 'sketch'),
  e('sketch.project', 'Project', 'Sketch: Modify', 'sketch', ['KeyP']),
  e('sketch.intersect', 'Intersect', 'Sketch: Modify', 'sketch'),
  e('sketch.import', 'Import SVG/DXF', 'Sketch: Modify', 'sketch'),
  e('sketch.coincident', 'Coincident', 'Sketch: Constrain', 'sketch'),
  e('sketch.horizontal', 'Horizontal', 'Sketch: Constrain', 'sketch'),
  e('sketch.vertical', 'Vertical', 'Sketch: Constrain', 'sketch'),
  e('sketch.parallel', 'Parallel', 'Sketch: Constrain', 'sketch'),
  e('sketch.perpendicular', 'Perpendicular', 'Sketch: Constrain', 'sketch'),
  e('sketch.tangent', 'Tangent', 'Sketch: Constrain', 'sketch'),
  e('sketch.equal', 'Equal', 'Sketch: Constrain', 'sketch'),
  e('sketch.midpoint', 'Midpoint', 'Sketch: Constrain', 'sketch'),
  e('sketch.symmetric', 'Symmetric', 'Sketch: Constrain', 'sketch'),
  e('sketch.concentric', 'Concentric', 'Sketch: Constrain', 'sketch'),
  e('sketch.collinear', 'Collinear', 'Sketch: Constrain', 'sketch'),
  e('sketch.fix', 'Fix', 'Sketch: Constrain', 'sketch'),
  e('sketch.dimension', 'Dimension', 'Sketch: Dimension', 'sketch', ['KeyD']),
  e('scale.sketch-banana', 'Banana for scale', 'Sketch: Scale models', 'sketch'),
]);

const BY_ID: ReadonlyMap<string, KeymapEntry> = new Map(KEYMAP.map((x) => [x.id, x]));

/** The registry's entry for an id, or null. */
export const keymapEntry = (id: string): KeymapEntry | null => BY_ID.get(id) ?? null;

const WITHOUT_PROJECTS: readonly KeymapEntry[] = Object.freeze(KEYMAP.filter((x) => !x.projects));
/** The registry on this host: every entry where it has projects (Magnusim), none of a project's in Magnusim CAD. */
export const keymapFor = (projectLinks: boolean): readonly KeymapEntry[] => (projectLinks ? KEYMAP : WITHOUT_PROJECTS);

/**
 * A command whose tooltip shows another one's key while it has none of its own: Finish sketch's
 * Enter is Place or finish's (which finishes the sketch when no tool step is open).
 */
export const SHOWN_VIA: Readonly<Record<string, string>> = Object.freeze({ 'sketch.finish': 'sketch.enter' });

/** The default keys of an id ([] for an unknown one). */
export const defaultKeys = (id: string): readonly string[] => BY_ID.get(id)?.keys ?? [];

// ------------------------------------------------------------------ combos

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
/** KeyboardEvent.key of a modifier key (a press of it alone names no combo yet). */
const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock']);
/** KeyboardEvent.code of a modifier key. */
const MOD_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$|^(AltGraph|CapsLock|Fn)$/;
/** Modifier words a combo may use, and the modifier each one is. */
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
const CODE_OF_CHAR: Readonly<Record<string, string>> = Object.freeze({ ...Object.fromEntries(Object.entries(PUNCT).filter(([c]) => c !== 'IntlBackslash').map(([c, ch]) => [ch, c])), ' ': 'Space' });
/**
 * The number pad's keys that type the same character on every layout, and the key that types it on
 * a US keyboard: a press of one is read by that character too (combosOf), so it is that key as well
 * wherever a press counts by the character (the Assistant panel's key: isAssistantCombo). Not the
 * number pad's decimal key: it types "," on many layouts.
 */
const PAD_TYPES: ReadonlyMap<string, string> = new Map([
  ['NumpadDivide', 'Slash'],
  ['NumpadSubtract', 'Minus'],
  ['NumpadEqual', 'Equal'],
]);

/**
 * Every key code a keybind can name: exactly the host's set (its KEY_CODES), the codes a press gives
 * (combosOf). The number pad's digits and Enter are not among them: a press of one is read as
 * Digit0-9 or Enter, and a combo written with one is refused, naming the one to write (padAs).
 */
const NAMED_CODES = [
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEqual',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'Backspace',
  'Enter',
  'Tab',
  'Space',
  'Escape',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
];
const CODES: ReadonlyMap<string, string> = new Map(
  [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
    ...'0123456789'.split('').map((d) => `Digit${d}`),
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ...NAMED_CODES,
  ].map((c) => [c.toLowerCase(), c]),
);

/** A value as the refusals quote it (JSON quotes), as the host's validators word it. */
const q = (v: string) => JSON.stringify(v);

/** The refusal of text that names no combo, word for word the host's. */
const notAKey = (raw: string) => `${q(raw)} is not a key (modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent.code such as KeyR)`;

/** Whether a key code is one a keybind can name ("KeyR", "F2", "PageDown"; not "PgDn" or "?"). */
export const isKeyCode = (code: string): boolean => CODES.get(code.toLowerCase()) === code;

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

/**
 * The code a key is written as: "r" / "R" / "KeyR" -> "KeyR", "1" / "Digit1" -> "Digit1", "\" ->
 * "Backslash", "esc" -> "Escape", "f2" -> "F2", "pgdn" -> "PageDown", a code in any case as itself.
 * "" for a name that is no key a keybind can name ("?", "PgDown2", "Lang1").
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

/** A combo read from text: the registry's form, or why it is no combo. */
export type ParsedCombo = { ok: true; combo: string } | { ok: false; why: string };

/**
 * A combo however it is written ("ctrl+shift+r", "Cmd+Z", "Shift+KeyR", "1", "Ctrl+\", "Ctrl+PgDn"),
 * in the registry's form ("Ctrl+Shift+KeyR", "Ctrl+KeyZ", "Shift+KeyR", "Digit1", "Ctrl+Backslash",
 * "Ctrl+PageDown"), or why not: a word that is no key, a modifier a shortcut cannot use (AltGr, Win),
 * two keys, or no key at all. Cmd and Meta count as Ctrl.
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
      // Each modifier once (Cmd and Meta count as Ctrl).
      if (mods.has(mod)) return { ok: false, why: notAKey(raw) };
      mods.add(mod);
      continue;
    }
    if (key || NOT_MODS.has(l)) return { ok: false, why: notAKey(raw) };
    // The number pad's digits and Enter: a press reads them as Digit and Enter.
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
  return { ok: true, combo };
}

/** The combo in the registry's form, or "" when the text names no combo (parseCombo says why). */
export function normaliseCombo(combo: string): string {
  const p = parseCombo(combo);
  return p.ok ? p.combo : '';
}

/** What a key event carries (a KeyboardEvent, or a test's plain object). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

const isModifierPress = (e: KeyLike) => MOD_KEYS.has(e.key) || MOD_CODE.test(e.code ?? '');

/** The key by its place (KeyboardEvent.code; the number pad's digits and Enter as Digit and Enter), or by its key when the event has no code. */
function placeOf(e: KeyLike): string {
  const code = e.code ?? '';
  if (!code) return keyCode(e.key ?? '');
  const pad = /^Numpad(\d)$/.exec(code);
  if (pad) return `Digit${pad[1]}`;
  if (code === 'NumpadEnter') return 'Enter';
  return code;
}

/**
 * The combos a key event means, the first the one it is stored as. A Latin letter is read by the
 * letter the key types, so Ctrl+Z is Undo on QWERTY, QWERTZ and AZERTY alike (as the browser's own
 * Ctrl+W follows the letter); anything else (digits, punctuation, a non-Latin layout, AltGr or
 * Option letters) by the key's place (KeyboardEvent.code), so the shortcuts stay on their keys.
 * A punctuation key is also read by the character it types, as the app always read it: Ctrl+\ by
 * the key labelled \ (a UK keyboard's) or by the US backslash's place. Cmd counts as Ctrl. A lone
 * modifier gives the modifiers only ("Ctrl+Shift").
 */
export function combosOf(e: KeyLike): string[] {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (isModifierPress(e)) return [mods.join('+')];
  const k = e.key ?? '';
  const letter = k.length === 1 && /[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : '';
  const primary = letter || placeOf(e);
  const out = [primary ? [...mods, primary].join('+') : mods.join('+')];
  if (!letter && k.length === 1) {
    const typed = keyCode(k);
    if (typed && typed !== primary && !/^Key[A-Z]$/.test(typed)) out.push([...mods, typed].join('+'));
  }
  return out;
}

/** The combo a key event is stored as ("Ctrl+KeyZ"): combosOf's first. */
export function comboOf(e: KeyLike): string {
  return combosOf(e)[0];
}

/** The layout's character for a key code (navigator.keyboard.getLayoutMap()), when the browser gives one. */
export type LayoutMap = Pick<ReadonlyMap<string, string>, 'get'>;

/**
 * A key code as people read it: a letter as itself ("KeyR" -> "R": the letter the key types, as it
 * matches), a digit as itself, punctuation through the layout when the browser gives it ("Backslash"
 * -> "#" on a German keyboard) else as on a US keyboard, a named key by its name.
 */
export function displayKey(code: string, layout?: LayoutMap | null): string {
  const k = /^Key([A-Z])$/.exec(code);
  if (k) return k[1];
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  if (PUNCT[code]) {
    const ch = layout?.get(code);
    return ch && ch.length === 1 && ch.trim() ? ch.toUpperCase() : PUNCT[code];
  }
  return code;
}

/** A combo as people read it: "Ctrl+Shift+KeyR" -> "Ctrl+Shift+R", "Digit1" -> "1" (punctuation through the layout when known). */
export function displayCombo(combo: string, layout?: LayoutMap | null): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  return [...parts, displayKey(key, layout)].join('+');
}

/** The combos no keybind may take (APP_SHORTCUTS.reserved), and what the browser or the system does with each. */
export const RESERVED: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(APP_SHORTCUTS.reserved.flatMap((g) => g.keys.map((k) => [k, g.label]))));

/** What the app does with an app-wide key ("Open or close the Assistant panel"), or null. */
export const appUseOf = (combo: string): string | null => APP_SHORTCUTS.app.find((g) => g.keys.includes(combo))?.label ?? null;

/** CAD's built-in use of a combo, or null. */
const builtInUseOf = (combo: string): string | null => BUILT_IN_KEYS.find((g) => g.keys.includes(combo))?.label ?? null;

/**
 * Whether a combo in the registry's form is the Assistant panel's key the person chose (`assistant`:
 * ws.context.assistantKeys; null while it has its default, which APP_SHORTCUTS.app holds, [] none):
 * one of theirs, or a number-pad key typing the same character as one (PAD_TYPES), since the SDK
 * forwards a press by the character it types too: with theirs on Alt+/ the number pad's / with Alt
 * opens the panel, whatever the layout, so a command on Alt+NumpadDivide would never run. Only that
 * way round: the / key may type another character on another layout. And a UK keyboard's \ key by
 * Z (IntlBackslash) is not its Backslash key: with theirs on Ctrl+IntlBackslash, a command on
 * Ctrl+Backslash still runs from its own key.
 */
export function isAssistantCombo(combo: string, assistant: readonly string[] | null): boolean {
  if (!assistant?.length) return false;
  if (assistant.includes(combo)) return true;
  const parts = combo.split('+');
  const typed = PAD_TYPES.get(parts.pop() ?? '');
  return !!typed && assistant.includes([...parts, typed].join('+'));
}

/**
 * Why a combo in the registry's form is the app's, the browser's or CAD's own ("" when it is free to
 * use), in the host contract's words. `assistant`: the Assistant panel's keys the person chose
 * (ws.context.assistantKeys; null while it has its default, [] none), the app's own as well
 * (isAssistantCombo).
 */
function refusal(c: string, assistant: readonly string[] | null = null): string {
  const app = appUseOf(c) ?? (isAssistantCombo(c, assistant) ? ASSISTANT_PANEL : null);
  if (app) return `${q(c)} is the app's own key (${app})`;
  const r = RESERVED[c];
  if (r) return `${q(c)} is kept for the browser and the system (${r})`;
  const own = builtInUseOf(c);
  if (own) return `${q(c)} is CAD's built-in cancel key (${own}), never a command's`;
  return '';
}

/**
 * Why a combo cannot be a keybind ("" when it can), in the words of the host's validators: text that
 * is not a key, a number-pad digit or Enter (never from a press: the one to write), or a key the app,
 * the browser or CAD keeps. `layout` is accepted for the callers' sake; refusals name keys as
 * combos are written. `assistant`: the Assistant panel's keys the person chose (refusal).
 */
export function comboProblem(combo: string, _layout?: LayoutMap | null, assistant: readonly string[] | null = null): string {
  const p = parseCombo(combo);
  return p.ok ? refusal(p.combo, assistant) : p.why;
}

export type Captured =
  /** A combo the person can have. */
  | { kind: 'combo'; combo: string }
  /** Only modifiers so far (waiting for the key): "Ctrl+Shift". */
  | { kind: 'modifier'; partial: string }
  /** A combo the browser, the system or the app keeps (or a key no shortcut can use), and why. */
  | { kind: 'refused'; combo: string; reason: string };

/**
 * A key press in a "press the new keys" field, read as the keyboard reads it (combosOf): the combo,
 * modifiers still held, or a combo it cannot have and why (`assistant`: as comboProblem's).
 */
export function captureCombo(e: KeyLike, _layout?: LayoutMap | null, assistant: readonly string[] | null = null): Captured {
  const combos = combosOf(e);
  const combo = combos[0];
  if (isModifierPress(e) || !combo || combo.split('+').every((p) => (MODS as readonly string[]).includes(p))) return { kind: 'modifier', partial: combo };
  const key = combo.split('+').pop()!;
  if (!isKeyCode(key)) return { kind: 'refused', combo, reason: `"${key}" cannot be a shortcut key` };
  // The browser's and the app's keys go by what the key types too (the Assistant's Ctrl+/ is the key typing /).
  for (const c of combos) {
    const why = refusal(c, assistant);
    if (why) return { kind: 'refused', combo, reason: why };
  }
  return { kind: 'combo', combo };
}

/**
 * Whether a press is the app's Assistant panel key, by the very rule the SDK forwards it with
 * (the host's src/plugin-sdk/workspace.ts isAssistantKey; tests/app/assistant-key.test.ts holds
 * the two to the same answers). `keys`: the person's (ws.context.assistantKeys), [] for none, or
 * null for the default: Ctrl or Cmd (or both), no Alt or Shift, on the key that types "/". The
 * person's are read as combosOf reads a press: Cmd counts as Ctrl, a Latin letter by the letter
 * it types, the number pad's digits and Enter as Digit and Enter, any other key by its place, and
 * punctuation by the character it types too. Composing and held keys are the caller's to judge.
 */
export function isAssistantPress(e: KeyLike, keys: readonly string[] | null): boolean {
  const k = e.key ?? '';
  if (!keys) return !!(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === '/';
  if (!keys.length) return false;
  const held = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean).join('+');
  const named = (code: string) => (held ? `${held}+${code}` : code);
  const code = e.code ?? '';
  const ch = k.length === 1 ? k : '';
  const letter = /[a-z]/i.test(ch);
  const pad = /^Numpad(\d)$/.exec(code);
  const placed = letter ? `Key${ch.toUpperCase()}` : pad ? `Digit${pad[1]}` : code === 'NumpadEnter' ? 'Enter' : code;
  if (keys.includes(named(placed))) return true;
  const typed = !ch || letter ? '' : /\d/.test(ch) ? `Digit${ch}` : CODE_OF_CHAR[ch] || '';
  return !!typed && keys.includes(named(typed));
}

/** Whether two contexts meet (the same one, or either is 'any'). */
export const contextsMeet = (a: KeyContext, b: KeyContext): boolean => a === b || a === 'any' || b === 'any';

/**
 * Every pair of entries whose keys conflict, under `keysOf` (the defaults when left out), among
 * `entries` (the registry; keymapFor(false) in Magnusim CAD, where a project's command is no one's).
 */
export function conflictsIn(keysOf: (id: string) => readonly string[] = defaultKeys, entries: readonly KeymapEntry[] = KEYMAP): { combo: string; ids: [string, string] }[] {
  const out: { combo: string; ids: [string, string] }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    const ka = keysOf(a.id);
    if (!ka.length) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (!contextsMeet(a.context, b.context)) continue;
      for (const c of keysOf(b.id)) if (ka.includes(c)) out.push({ combo: c, ids: [a.id, b.id] });
    }
  }
  return out;
}

/**
 * Every entry whose keys (under `keysOf`) take a key no keybind may have (the app's, the browser's
 * and the system's reserved ones, CAD's built-in Escape) or one a press never gives; `by` says why.
 * `assistant`: the Assistant panel's keys the person chose (a stored keybind may have one of them:
 * it stays stored, but the press is the app's). `entries`: as conflictsIn's.
 */
export function appClashesIn(keysOf: (id: string) => readonly string[] = defaultKeys, assistant: readonly string[] | null = null, entries: readonly KeymapEntry[] = KEYMAP): { combo: string; id: string; by: string }[] {
  return entries.flatMap((x) => keysOf(x.id).flatMap((c) => (refusal(c, assistant) ? [{ combo: c, id: x.id, by: refusal(c, assistant) }] : [])));
}

// ------------------------------------------------------------------ workspace/commands.json

/** The file the build writes (workspace/commands.json): the registry with its default keys. */
export function commandsJson(): string {
  const commands = KEYMAP.map((x) => ({ id: x.id, label: x.label, group: x.group, context: x.context, keys: [...x.keys], ...(x.projects ? { projects: true } : {}) }));
  return `${JSON.stringify({ version: 1, contexts: CONTEXTS, commands }, null, 2)}\n`;
}
