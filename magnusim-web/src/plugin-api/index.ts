/** @cfddesk/plugin-ui — host helpers passed to a plugin's register(host). */
import type { ComponentType } from 'react';
import { useProjectStore } from '../store/project';
import { useJobsStore } from '../store/jobs';
import { useUiStore } from '../store/ui';
import { SchemaForm } from '../forms/SchemaForm';
import { registerIsland, type IslandProps } from '../islands';
import { bindLegacyViewer, type ViewerApi } from '../viewer/index';

export type PanelPlace = 'tree' | 'toolbar' | 'filters' | 'results' | 'prefs' | 'geometry';

export interface RegisterPanelOpts {
  key: string;
  title: string;
  place: PanelPlace;
  Component: ComponentType<Record<string, unknown>>;
}

const panels = new Map<string, RegisterPanelOpts>();
const filterWidgets = new Map<string, ComponentType<Record<string, unknown>>>();
const fieldWidgets = new Map<string, ComponentType<Record<string, unknown>>>();

function notifyPanels(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cfd:panels'));
}

export function registerPanel(opts: RegisterPanelOpts): void {
  panels.set(opts.key, opts);
  notifyPanels();
}

export function panelsFor(place: PanelPlace): RegisterPanelOpts[] {
  return [...panels.values()].filter((row) => row.place === place);
}

export function filterWidgetEntries(): Array<[string, ComponentType<Record<string, unknown>>]> {
  return [...filterWidgets.entries()];
}

/** Host setup panels and later plugins mount a flyout through this. */
export function replacePanel(panelId: string, Component: ComponentType<IslandProps>): void {
  registerIsland(panelId, Component);
}

export function registerFilterWidget(key: string, Component: ComponentType<Record<string, unknown>>): void {
  filterWidgets.set(key, Component);
  notifyPanels();
}

export function registerFieldWidget(xWidget: string, Component: ComponentType<Record<string, unknown>>): void {
  fieldWidgets.set(xWidget, Component);
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

const treeTransforms: Array<(nodes: PluginTreeNode[]) => PluginTreeNode[]> = [];

export function registerTreeTransform(fn: (nodes: PluginTreeNode[]) => PluginTreeNode[]): void {
  treeTransforms.push(fn);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cfd:tree-sync'));
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
  for (const fn of treeTransforms) nodes = fn(nodes) || [];
  return nodes.filter((node) => {
    const pid = node.projectId || projectOfScope(node.scope);
    return !!pid && pid === projectId;
  });
}

export const pluginUi = {
  registerPanel,
  replacePanel,
  registerFilterWidget,
  registerFieldWidget,
  useProject,
  useSimulation,
  useJob,
  useRegistry,
  useViewer,
  usePrefs,
  SchemaForm,
  registerTreeTransform,
  panelsFor,
};
