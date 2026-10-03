// Frame keyboard: combos -> handlers, and command shortcuts. Owner: INTEGRATE (scaffold version).
// SPDX-License-Identifier: GPL-3.0-or-later
import { cycleDialogFocus, openModal } from '../lib/modal';
import type { CommandDef, CommandRegistry, KeyBinding, KeyboardManager, Mode } from '../types/commands';

const MODS = ['Ctrl', 'Alt', 'Shift'] as const;

/** "ctrl+shift+z" / "Cmd+Z" / "Shift+f" -> "Ctrl+Shift+Z" / "Ctrl+Z" / "Shift+F". */
export function normaliseCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'meta' || l === 'mod') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else key = keyName(p);
  }
  return [...MODS.filter((m) => mods.has(m)), key].filter(Boolean).join('+');
}

function keyName(k: string): string {
  if (k.length === 1) return k.toUpperCase();
  const l = k.toLowerCase();
  if (l === 'esc') return 'Escape';
  if (l === 'del') return 'Delete';
  if (l === 'space' || k === ' ') return 'Space';
  return k[0].toUpperCase() + k.slice(1);
}

/** The combo a key event means ("Ctrl+Z"); Cmd counts as Ctrl. */
export function comboOf(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = e.key === ' ' ? 'Space' : keyName(e.key);
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return mods.join('+');
  return [...mods, key].join('+');
}

/** Undo and redo: a field marked [data-undo-to-app] (nothing typed in it to take back) hands them to the app. */
const UNDO_COMBOS = new Set(['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z']);

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function createKeyboard(doc: Document): KeyboardManager {
  const bindings = new Map<string, KeyBinding[]>();
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
    const combo = comboOf(e);
    const list = bindings.get(combo);
    if (!list || !list.length) return;
    // A panel field after Enter: Ctrl+Z is the app's Undo, not the browser's text undo (review
    // P2/P3 round 3: it put the old text back in the field while the model kept the new value).
    const typing = typingIn(e.target) && !(UNDO_COMBOS.has(combo) && (e.target as HTMLElement).getAttribute?.('data-undo-to-app') === '1');
    // Newest first; a binding that returns false passes the key on to the next older one.
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (typing && !b.inInputs) continue;
      if (b.run(e) === false) continue;
      e.preventDefault();
      return;
    }
  };
  doc.addEventListener('keydown', onKey);
  return {
    normalise: normaliseCombo,
    bind(binding) {
      const combo = normaliseCombo(binding.combo);
      const b = { ...binding, combo };
      const list = bindings.get(combo) ?? [];
      list.push(b);
      bindings.set(combo, list);
      return () => {
        const l = bindings.get(combo);
        if (l) bindings.set(combo, l.filter((x) => x !== b));
      };
    },
    dispose() {
      doc.removeEventListener('keydown', onKey);
      bindings.clear();
    },
  };
}

/**
 * Keep one binding per shortcut combo for the commands that have it (re-synced
 * when commands change). A key runs the newest command of the current mode
 * (`mode()`, default always 'model'; a command's mode 'any' matches every mode)
 * with that shortcut; with none for this mode the key passes on to older
 * bindings (the UI shell's own Delete or Escape). A refused command says why
 * through `explain` when it has explainRefusal.
 */
export function bindCommandShortcuts(commands: CommandRegistry, keyboard: KeyboardManager, explain?: (message: string) => void, mode: () => Mode = () => 'model'): () => void {
  let offs: (() => void)[] = [];
  const sync = () => {
    for (const off of offs) off();
    const combos = new Map<string, CommandDef[]>();
    for (const c of commands.all()) {
      if (!c.shortcut) continue;
      const combo = keyboard.normalise(c.shortcut);
      const list = combos.get(combo) ?? [];
      list.push(c);
      combos.set(combo, list);
    }
    offs = [...combos].map(([combo, list]) =>
      keyboard.bind({
        combo,
        run: () => {
          const m = mode();
          const c = [...list].reverse().find((x) => x.mode === 'any' || (x.mode ?? 'model') === m);
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
