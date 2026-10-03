// Module discovery (docs/p2p3-plan.md §3.1): every src/features/<name>/index.ts
// and src/sketch/index.ts whose default export is a CadModule. import.meta.glob
// finds them at build time (sorted by path: the build stays reproducible), so a
// new feature never edits a shared list. Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentType } from 'react';
import type { AppServices } from './types/app';
import type { FeatureType } from './types/doc';
import type { FeatureRegistry } from './types/doc-service';
import type { CadModule, FeaturePanelProps, ModuleRegistry, ToolDef } from './types/modules';

type ModuleFile = { default?: CadModule };

/** The modules in the source tree (each folder's index.ts default export). */
export function discoverModules(): CadModule[] {
  const files = {
    ...import.meta.glob<ModuleFile>('./features/*/index.ts', { eager: true }),
    ...import.meta.glob<ModuleFile>('./features/*/index.tsx', { eager: true }),
    ...import.meta.glob<ModuleFile>('./sketch/index.ts', { eager: true }),
    ...import.meta.glob<ModuleFile>('./sketch/index.tsx', { eager: true }),
  };
  const out: CadModule[] = [];
  for (const path of Object.keys(files).sort()) {
    const m = files[path].default;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') throw new Error(`${path}: the default export is not a CadModule`);
    out.push(m);
  }
  return out;
}

/** A registry over a list of modules; refuses two modules with the same id, feature type, panel or tool. */
export function createModuleRegistry(modules: readonly CadModule[]): ModuleRegistry {
  const ids = new Set<string>();
  const panels = new Map<FeatureType, ComponentType<FeaturePanelProps>>();
  const tools = new Map<string, ToolDef>();
  const types = new Set<FeatureType>();
  for (const m of modules) {
    if (ids.has(m.id)) throw new Error(`two modules are called ${m.id}`);
    ids.add(m.id);
    for (const def of m.features ?? []) {
      if (types.has(def.type)) throw new Error(`module ${m.id}: feature type ${def.type} is already registered`);
      types.add(def.type);
    }
    for (const [type, panel] of Object.entries(m.panels ?? {}) as [FeatureType, ComponentType<FeaturePanelProps>][]) {
      if (panels.has(type)) throw new Error(`module ${m.id}: the ${type} panel is already registered`);
      panels.set(type, panel);
    }
    for (const t of m.tools ?? []) {
      if (tools.has(t.id)) throw new Error(`module ${m.id}: tool ${t.id} is already registered`);
      tools.set(t.id, t);
    }
  }
  const list = [...modules];
  return {
    all: () => list,
    panelFor: (type) => panels.get(type) ?? null,
    tool: (id) => tools.get(id) ?? null,
  };
}

/** Register the modules' feature types in the document's registry (before the Part loads). */
export function registerModuleFeatures(registry: FeatureRegistry, modules: readonly CadModule[]): void {
  for (const m of modules) for (const def of m.features ?? []) registry.register(def);
}

/** Install every module (after the UI shell's install). Returns one uninstall for all of them. */
export function installModules(services: AppServices, modules: readonly CadModule[]): () => void {
  const offs: (() => void)[] = [];
  for (const m of modules) if (m.install) offs.push(m.install(services));
  return () => {
    for (const off of offs.reverse()) off();
  };
}
