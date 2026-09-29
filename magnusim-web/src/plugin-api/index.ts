/** @cfddesk/plugin-api — host helpers passed to a plugin's register(host). */
import type { ComponentType } from 'react';
import { useProjectStore } from '../store/project';
import { useJobsStore } from '../store/jobs';
import { useUiStore } from '../store/ui';
import { SchemaForm } from '../forms/SchemaForm';
import { islandComponent, registerIsland, unregisterIsland, type IslandProps } from '../islands';
import { bindLegacyViewer, type ViewerApi } from '../viewer/index';
import { deleteFieldWidget, setFieldWidget } from './fieldWidgets';
import { SciNumberInput } from '../forms/SciNumberInput';
import { mergeObjectSchemas, pickSchemaValues } from '../panels/scope';
import { registerSlotFor, unregisterSlot, type RunSettingsProps, type StudySettingsProps } from './slots';

export type { RunSettingsProps, StudySettingsProps } from './slots';

/**
 * Places the host actually renders: the Filters panel and the plugin's row in
 * Settings → Plugins. API 1.0 also named tree, toolbar, results and geometry,
 * but nothing ever drew them; registering there is now an error (see
 * docs/plugins/compatibility.md), never a panel that silently does not appear.
 */
export type PanelPlace = 'filters' | 'prefs';
const RENDERED_PLACES: readonly string[] = ['filters', 'prefs'];

export interface RegisterPanelOpts {
  key: string;
  title: string;
  place: PanelPlace;
  Component: ComponentType<Record<string, unknown>>;
}

/** Who registered what, so disabling or reloading a plugin removes exactly its UI. */
interface Ledger {
  panels: Set<string>;
  filterWidgets: Set<string>;
  fieldWidgets: Set<string>;
  islands: Map<string, ComponentType<IslandProps> | undefined>;
  slots: Set<string>;
}

const HOST = '';
const panels = new Map<string, RegisterPanelOpts & { owner: string }>();
const filterWidgets = new Map<string, ComponentType<Record<string, unknown>>>();
const treeTransforms: Array<{ owner: string; fn: (nodes: PluginTreeNode[]) => PluginTreeNode[] }> = [];
const ledgers = new Map<string, Ledger>();

function ledgerFor(owner: string): Ledger {
  let ledger = ledgers.get(owner);
  if (!ledger) {
    ledger = { panels: new Set(), filterWidgets: new Set(), fieldWidgets: new Set(), islands: new Map(), slots: new Set() };
    ledgers.set(owner, ledger);
  }
  return ledger;
}

function notifyPanels(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cfd:panels'));
}

function notifyTree(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cfd:tree-sync'));
}

function registerPanelFor(owner: string, opts: RegisterPanelOpts): void {
  if (!RENDERED_PLACES.includes(String(opts.place))) {
    throw new Error(
      `panel place "${String(opts.place)}" is not rendered in plugin API 1.1; use "filters" or "prefs"`,
    );
  }
  panels.set(opts.key, { ...opts, owner });
  ledgerFor(owner).panels.add(opts.key);
  notifyPanels();
}

function replacePanelFor(owner: string, panelId: string, Component: ComponentType<IslandProps>): void {
  const ledger = ledgerFor(owner);
  // Remember the host's own component the first time, to restore it on disable.
  if (owner !== HOST && !ledger.islands.has(panelId)) ledger.islands.set(panelId, islandComponent(panelId));
  registerIsland(panelId, Component);
}

function registerFilterWidgetFor(
  owner: string,
  key: string,
  Component: ComponentType<Record<string, unknown>>,
): void {
  filterWidgets.set(key, Component);
  ledgerFor(owner).filterWidgets.add(key);
  notifyPanels();
}

function registerFieldWidgetFor(
  owner: string,
  xWidget: string,
  Component: ComponentType<Record<string, unknown>>,
): void {
  setFieldWidget(xWidget, Component);
  ledgerFor(owner).fieldWidgets.add(xWidget);
  notifyPanels();
}

function registerTreeTransformFor(owner: string, fn: (nodes: PluginTreeNode[]) => PluginTreeNode[]): void {
  treeTransforms.push({ owner, fn });
  notifyTree();
}

/** Remove everything one plugin registered (disable, reload, or a second register()). */
export function unregisterPlugin(owner: string): void {
  const ledger = ledgers.get(owner);
  let changed = false;
  if (ledger) {
    for (const key of ledger.panels) {
      if (panels.get(key)?.owner === owner) panels.delete(key);
    }
    for (const key of ledger.filterWidgets) filterWidgets.delete(key);
    for (const name of ledger.fieldWidgets) deleteFieldWidget(name);
    for (const key of ledger.slots) unregisterSlot(key, owner);
    for (const [panelId, previous] of ledger.islands) {
      if (previous) registerIsland(panelId, previous);
      else unregisterIsland(panelId);
    }
    ledgers.delete(owner);
    changed = true;
  }
  const before = treeTransforms.length;
  for (let i = treeTransforms.length - 1; i >= 0; i -= 1) {
    if (treeTransforms[i].owner === owner) treeTransforms.splice(i, 1);
  }
  if (changed) notifyPanels();
  if (treeTransforms.length !== before) notifyTree();
}

/** Plugin keys that currently have UI registered. */
export function registeredPluginKeys(): string[] {
  return [...ledgers.keys()].filter((key) => key !== HOST);
}

export function registerPanel(opts: RegisterPanelOpts): void {
  registerPanelFor(HOST, opts);
}

export function panelsFor(place: PanelPlace): RegisterPanelOpts[] {
  return [...panels.values()].filter((row) => row.place === place);
}

export function filterWidgetEntries(): Array<[string, ComponentType<Record<string, unknown>>]> {
  return [...filterWidgets.entries()];
}

/** Host setup panels and later plugins mount a flyout through this. */
export function replacePanel(panelId: string, Component: ComponentType<IslandProps>): void {
  replacePanelFor(HOST, panelId, Component);
}

export function registerFilterWidget(key: string, Component: ComponentType<Record<string, unknown>>): void {
  registerFilterWidgetFor(HOST, key, Component);
}

/** A schema field whose x-cfddesk.widget equals `xWidget` renders with this component. */
export function registerFieldWidget(xWidget: string, Component: ComponentType<Record<string, unknown>>): void {
  registerFieldWidgetFor(HOST, xWidget, Component);
}

export function useProject() {
  return useProjectStore((s) => s.hydrate);
}

export function useSimulation() {
  return useProjectStore((s) => (s.hydrate as { simulation?: unknown } | null)?.simulation);
}

export function useJob(id: string) {
  return useJobsStore((s) => s.jobs[id]);
}

export function useRegistry(kind?: string) {
  return useProjectStore((s) => {
    if (!kind) return s.registry;
    return s.registry ? (s.registry as Record<string, unknown>)[kind] : null;
  });
}

export function useViewer(): ViewerApi {
  return window.__cfdViewer || bindLegacyViewer();
}

export function usePrefs() {
  return window.__CFD_PREFS__ || {};
}

export { SchemaForm };
export { useUiStore };

export interface PluginTreeNode {
  label: string;
  scope?: string;
  projectId?: string;
}

export function registerTreeTransform(fn: (nodes: PluginTreeNode[]) => PluginTreeNode[]): void {
  registerTreeTransformFor(HOST, fn);
}

export function clearTreeTransforms(): void {
  treeTransforms.length = 0;
}

function projectOfScope(scope: string | undefined): string {
  const part = String(scope || '')
    .split('/')
    .find((piece) => piece.startsWith('p:'));
  return part ? part.slice(2) : '';
}

/** Keep plugin tree rows that belong to the open project. */
export function pluginTreeNodes(projectId: string): PluginTreeNode[] {
  let nodes: PluginTreeNode[] = [];
  for (const { fn } of treeTransforms) nodes = fn(nodes) || [];
  return nodes.filter((node) => {
    const pid = node.projectId || projectOfScope(node.scope);
    return !!pid && pid === projectId;
  });
}

/** An analysis's study settings, drawn in the study panel (its contract's ui.study_settings). */
function registerStudySettingsFor(owner: string, name: string, Component: ComponentType<StudySettingsProps>): void {
  ledgerFor(owner).slots.add(registerSlotFor(owner, 'study-settings', name, Component as ComponentType<never>));
}

/** An analysis's run settings, drawn in the run panel (its contract's ui.run_settings). */
function registerRunSettingsFor(owner: string, name: string, Component: ComponentType<RunSettingsProps>): void {
  ledgerFor(owner).slots.add(registerSlotFor(owner, 'run-settings', name, Component as ComponentType<never>));
}

/** The API object one plugin's register(host) receives; its registrations are recorded under its key. */
export function pluginUiFor(owner: string) {
  return {
    registerStudySettings: (name: string, Component: ComponentType<StudySettingsProps>) =>
      registerStudySettingsFor(owner, name, Component),
    registerRunSettings: (name: string, Component: ComponentType<RunSettingsProps>) =>
      registerRunSettingsFor(owner, name, Component),
    SciNumberInput,
    schema: { mergeObjectSchemas, pickSchemaValues },
    registerPanel: (opts: RegisterPanelOpts) => registerPanelFor(owner, opts),
    replacePanel: (panelId: string, Component: ComponentType<IslandProps>) => replacePanelFor(owner, panelId, Component),
    registerFilterWidget: (key: string, Component: ComponentType<Record<string, unknown>>) =>
      registerFilterWidgetFor(owner, key, Component),
    registerFieldWidget: (xWidget: string, Component: ComponentType<Record<string, unknown>>) =>
      registerFieldWidgetFor(owner, xWidget, Component),
    useProject,
    useSimulation,
    useJob,
    useRegistry,
    useViewer,
    usePrefs,
    SchemaForm,
    registerTreeTransform: (fn: (nodes: PluginTreeNode[]) => PluginTreeNode[]) => registerTreeTransformFor(owner, fn),
    panelsFor,
  };
}

/** Host-owned API (dev probes and tests); plugins get pluginUiFor(theirKey). */
export const pluginUi = pluginUiFor(HOST);
