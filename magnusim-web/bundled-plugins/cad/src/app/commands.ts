// The command registry. A command the keybinding registry lists (src/app/keymap.ts) gets its keys
// from it: `shortcut` (what tooltips and menus show) and keys(id) (what the keyboard binds) follow
// the person's keybinds live (src/app/keybinds.ts), and a change of them notifies subscribers.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { keybindsFor, type Keybinds } from './keybinds';
import { keymapEntry, normaliseCombo } from './keymap';
import { GROUP_LABELS, MODEL_GROUPS, SKETCH_GROUPS, type CommandDef, type CommandRegistry, type Mode, type ToolbarGroup } from '../types/commands';
import type { AppServices } from '../types/app';

/**
 * `keybinds`: the Part's keybinds (bootstrap); left out, the services' own (keybindsFor), found
 * when first needed.
 */
export function createCommandRegistry(getServices: () => AppServices, keybinds?: Keybinds): CommandRegistry {
  const defs = new Map<string, CommandDef>();
  const listeners = new Set<() => void>();
  // Commands whose keys are the keybinding registry's (no shortcut of their own).
  const managed = new WeakSet<CommandDef>();
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  let kb: Keybinds | null = keybinds ?? null;
  let heard: Keybinds | null = null;
  const binds = (): Keybinds => {
    if (!kb) {
      let s: AppServices | null = null;
      try {
        s = getServices();
      } catch {
        s = null; // not made yet (bootstrap's services are declared after the registry)
      }
      if (!s) return keybindsFor(null);
      kb = keybindsFor(s);
    }
    if (heard !== kb) {
      heard = kb;
      kb.subscribe(changed);
    }
    return kb;
  };
  if (kb) binds();
  const canRun = (id: string): true | string => {
    const def = defs.get(id);
    if (!def) return `Unknown command ${id}`;
    return def.enabled ? def.enabled(getServices()) : true;
  };
  const registry: CommandRegistry = {
    register(def) {
      if (def.group && !def.icon) throw new Error(`command ${def.id}: a toolbar command needs an icon`);
      if (def.primary && !def.group) throw new Error(`command ${def.id}: a primary command needs a group`);
      if (def.shortcut == null && keymapEntry(def.id)) {
        managed.add(def);
        Object.defineProperty(def, 'shortcut', { get: () => binds().shown(def.id), enumerable: true, configurable: true });
      }
      defs.set(def.id, def);
      changed();
      return () => {
        if (defs.get(def.id) === def) {
          defs.delete(def.id);
          changed();
        }
      };
    },
    get: (id) => defs.get(id),
    keys(id) {
      const def = defs.get(id);
      if (!def) return [];
      if (managed.has(def)) return binds().keys(id);
      const own = def.shortcut ? normaliseCombo(def.shortcut) : '';
      return own ? [own] : [];
    },
    all: () => [...defs.values()],
    toolbar(mode: Mode) {
      const order: ToolbarGroup[] = mode === 'sketch' ? SKETCH_GROUPS : MODEL_GROUPS;
      const out: { group: ToolbarGroup; label: string; commands: CommandDef[] }[] = [];
      for (const group of order) {
        // The mode's primary command (Finish sketch) is drawn on its own at the end.
        const commands = [...defs.values()]
          .filter((d) => d.group === group && !d.primary && (d.mode === 'any' || (d.mode ?? 'model') === mode))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
        if (commands.length) out.push({ group, label: GROUP_LABELS[group], commands });
      }
      return out;
    },
    canRun,
    async run(id) {
      const ok = canRun(id);
      if (ok !== true) return ok;
      await defs.get(id)!.run(getServices());
      return true;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return registry;
}
