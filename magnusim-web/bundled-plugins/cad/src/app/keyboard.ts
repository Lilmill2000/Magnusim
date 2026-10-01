// Frame keyboard: combos -> handlers, and command shortcuts. Owner: INTEGRATE (scaffold version).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRegistry, KeyBinding, KeyboardManager } from '../types/commands';

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

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function createKeyboard(doc: Document): KeyboardManager {
  const bindings = new Map<string, KeyBinding[]>();
  const onKey = (e: KeyboardEvent) => {
    const combo = comboOf(e);
    const list = bindings.get(combo);
    if (!list || !list.length) return;
    const b = list[list.length - 1];
    if (typingIn(e.target) && !b.inInputs) return;
    e.preventDefault();
    b.run(e);
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

/** Keep a binding for every command that has a shortcut (re-synced when commands change). `explain` shows a refusal (a toast). */
export function bindCommandShortcuts(commands: CommandRegistry, keyboard: KeyboardManager, explain?: (message: string) => void): () => void {
  let offs: (() => void)[] = [];
  const sync = () => {
    for (const off of offs) off();
    offs = commands
      .all()
      .filter((c) => c.shortcut)
      .map((c) =>
        keyboard.bind({
          combo: c.shortcut!,
          run: () => {
            void commands.run(c.id).then((r) => {
              if (r !== true && c.explainRefusal && explain) explain(`${c.label}: ${r}`);
            });
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
