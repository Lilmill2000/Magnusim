// Frame keyboard: combos -> handlers, and command shortcuts (their keys from the keybinding
// registry and the person's keybinds: src/app/keymap.ts, src/app/keybinds.ts). Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cycleDialogFocus, openModal } from '../lib/modal';
import type { CommandDef, CommandRegistry, KeyBinding, KeyboardManager, Mode } from '../types/commands';
import { combosOf, normaliseCombo } from './keymap';

// Combos in the registry's form (src/app/keymap.ts); a press means combosOf(e): a Latin letter by
// the letter it types, anything else by the key's place (punctuation by its character too).
export { comboOf, combosOf, normaliseCombo } from './keymap';

/** Whether a key went to a field the person types in (an input, a textarea, a select, editable text). */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/**
 * ux010 (TOOLBAR, review): Enter or Space on a menu item, or on a button the KEYBOARD brought the
 * focus to (Tab, the arrows, a menu handing the keyboard back), is that control's own: it runs the
 * More menu's item or the button, never a shortcut (Enter used to finish the sketch from the More
 * menu). A button the mouse clicked keeps its focus but not the key: Enter after clicking
 * Rectangle and drawing does what it always did (Finish sketch). How the focus came is tracked
 * here (the input before each focus change) rather than read from :focus-visible, which Chromium
 * turns on for a mouse-focused button as soon as a key is pressed.
 */
function controlOf(combo: string, target: EventTarget | null): { el: HTMLElement; menu: boolean } | null {
  if (combo !== 'Enter' && combo !== 'Space') return null;
  const t = target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return null;
  const el = t.closest<HTMLElement>('button, [role="button"], [role^="menuitem"], a[href]');
  return el ? { el, menu: /^menuitem/.test(el.getAttribute('role') ?? '') } : null;
}

export function createKeyboard(doc: Document): KeyboardManager {
  // Every binding in the order bound (newest last): a fixed combo, or keys() read on each press.
  let bindings: KeyBinding[] = [];
  const matches = (b: KeyBinding, combo: string) => (b.keys ? b.keys().includes(combo) : b.combo === combo);
  // The last input (a key or a pointer press), and the element the focus last went to with it.
  let lastInput: 'key' | 'pointer' = 'pointer';
  let focused: { el: EventTarget | null; byKey: boolean } = { el: null, byKey: false };
  const onPress = () => {
    lastInput = 'pointer';
  };
  const onAnyKey = () => {
    lastInput = 'key';
  };
  const onFocus = (e: FocusEvent) => {
    focused = { el: e.target, byKey: lastInput === 'key' };
  };
  const onKey = (e: KeyboardEvent) => {
    // An in-frame modal dialog is open: it alone answers keys. A key that reaches the page
    // outside it (the keyboard came back to the frame's body) runs no shortcut, and Tab
    // goes back into the dialog (review P2/P3 round 2: Finish sketch, the Front view and a
    // second Delete dialog ran behind an open one).
    const modal = openModal(doc);
    if (modal) {
      if (e.key === 'Tab' && !modal.contains(e.target as Node | null)) {
        e.preventDefault();
        cycleDialogFocus(modal, e.shiftKey);
      }
      return;
    }
    // A control that handled the key keeps it (review: Delete on a focused width line of the
    // ribbon reset the width and deleted the selected feature too; Home in an open menu ran a
    // command bound to Home).
    if (e.defaultPrevented) return;
    const combos = combosOf(e);
    const combo = combos[0];
    const list = bindings.filter((b) => combos.some((c) => matches(b, c)));
    if (!list.length) return;
    const control = controlOf(combo, e.target);
    if (control && (control.menu || (focused.byKey && (focused.el === control.el || control.el.contains(focused.el as Node | null))))) return;
    // A panel field after Enter: Ctrl+Z is the app's Undo, not the browser's text undo (review
    // P2/P3 round 3: it put the old text back in the field while the model kept the new value).
    const typing = typingIn(e.target);
    const undoToApp = typing && (e.target as HTMLElement).getAttribute?.('data-undo-to-app') === '1';
    // Newest first; a binding that returns false passes the key on to the next older one.
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (typing && !b.inInputs && !(undoToApp && b.appUndo)) continue;
      if (b.run(e) === false) continue;
      e.preventDefault();
      return;
    }
  };
  doc.addEventListener('pointerdown', onPress, true);
  doc.addEventListener('keydown', onAnyKey, true);
  doc.addEventListener('focusin', onFocus, true);
  doc.addEventListener('keydown', onKey);
  return {
    normalise: normaliseCombo,
    bind(binding) {
      const b = { ...binding, combo: normaliseCombo(binding.combo) };
      bindings.push(b);
      return () => {
        bindings = bindings.filter((x) => x !== b);
      };
    },
    dispose() {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointerdown', onPress, true);
      doc.removeEventListener('keydown', onAnyKey, true);
      doc.removeEventListener('focusin', onFocus, true);
      bindings = [];
    },
  };
}

/** Undo and Redo, of the Part and of a sketch: from a field marked [data-undo-to-app] they are the app's. */
const APP_UNDO = new Set(['edit.undo', 'edit.redo', 'sketch.undo', 'sketch.redo']);

/**
 * Keep one binding per key combo of the commands that have keys (the person's keybinds, else the
 * registry's defaults: CommandRegistry.keys; a command the registry does not list keeps its own
 * shortcut), re-synced when commands or keys change. A key runs the newest command of the current
 * mode (`mode()`, default always 'model'; a command's mode 'any' matches every mode) with that
 * combo; with none for this mode the key passes on to older bindings (the UI shell's own Delete or
 * Escape). A refused command says why through `explain` when it has explainRefusal.
 */
export function bindCommandShortcuts(commands: CommandRegistry, keyboard: KeyboardManager, explain?: (message: string) => void, mode: () => Mode = () => 'model'): () => void {
  let offs: (() => void)[] = [];
  const keysOf = (c: CommandDef): readonly string[] => (commands.keys ? commands.keys(c.id) : c.shortcut ? [c.shortcut] : []);
  const sync = () => {
    for (const off of offs) off();
    const combos = new Map<string, CommandDef[]>();
    for (const c of commands.all()) {
      for (const k of keysOf(c)) {
        const combo = keyboard.normalise(k);
        if (!combo) continue;
        const list = combos.get(combo) ?? [];
        list.push(c);
        combos.set(combo, list);
      }
    }
    offs = [...combos].map(([combo, list]) =>
      keyboard.bind({
        combo,
        // Only Undo and Redo themselves, and only on Ctrl (Cmd) keys, reach the app from an
        // untouched field ([data-undo-to-app]): a letter typed there stays the field's.
        appUndo: combo.startsWith('Ctrl+') && list.some((c) => APP_UNDO.has(c.id)),
        run: (e) => {
          const m = mode();
          const fromField = typingIn(e?.target ?? null);
          const c = [...list].reverse().find((x) => (x.mode === 'any' || (x.mode ?? 'model') === m) && (!fromField || APP_UNDO.has(x.id)));
          if (!c) return false;
          void commands.run(c.id).then((r) => {
            if (r !== true && c.explainRefusal && explain) explain(`${c.label}: ${r}`);
          });
          return true;
        },
      }),
    );
  };
  sync();
  const unsub = commands.subscribe(sync);
  return () => {
    unsub();
    for (const off of offs) off();
  };
}
