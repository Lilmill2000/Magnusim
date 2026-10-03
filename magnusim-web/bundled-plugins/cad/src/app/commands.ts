// The command registry. Owner: INTEGRATE (scaffold version).
// SPDX-License-Identifier: GPL-3.0-or-later
import { GROUP_LABELS, MODEL_GROUPS, SKETCH_GROUPS, type CommandDef, type CommandRegistry, type Mode, type ToolbarGroup } from '../types/commands';
import type { AppServices } from '../types/app';

export function createCommandRegistry(getServices: () => AppServices): CommandRegistry {
  const defs = new Map<string, CommandDef>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  const canRun = (id: string): true | string => {
    const def = defs.get(id);
    if (!def) return `Unknown command ${id}`;
    return def.enabled ? def.enabled(getServices()) : true;
  };
  const registry: CommandRegistry = {
    register(def) {
      if (def.group && !def.icon) throw new Error(`command ${def.id}: a toolbar command needs an icon`);
      if (def.primary && !def.group) throw new Error(`command ${def.id}: a primary command needs a group`);
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
