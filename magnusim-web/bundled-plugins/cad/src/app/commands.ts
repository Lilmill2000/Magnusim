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
  const registry: CommandRegistry = {
    register(def) {
      if (def.group && !def.icon) throw new Error(`command ${def.id}: a toolbar command needs an icon`);
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
        const commands = [...defs.values()]
          .filter((d) => d.group === group && (d.mode === 'any' || (d.mode ?? 'model') === mode))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
        if (commands.length) out.push({ group, label: GROUP_LABELS[group], commands });
      }
      return out;
    },
    async run(id) {
      const def = defs.get(id);
      if (!def) return `Unknown command ${id}`;
      const services = getServices();
      const ok = def.enabled ? def.enabled(services) : true;
      if (ok !== true) return ok;
      await def.run(services);
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
