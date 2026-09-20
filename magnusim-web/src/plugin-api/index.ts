/** @cfddesk/plugin-ui — types only in Phase 4. Do not dynamic-import plugins/example. */
import type { ComponentType } from 'react';
import { useProjectStore } from '../store/project';
import { useJobsStore } from '../store/jobs';
import { useUiStore } from '../store/ui';
import { SchemaForm } from '../forms/SchemaForm';
import { bindLegacyViewer, type ViewerApi } from '../viewer/index';

export type PanelPlace = 'tree' | 'toolbar' | 'filters';

export interface RegisterPanelOpts {
  key: string;
  title: string;
  place: PanelPlace;
  Component: ComponentType<Record<string, unknown>>;
}

const panels = new Map<string, RegisterPanelOpts>();
const filterWidgets = new Map<string, ComponentType<Record<string, unknown>>>();
const fieldWidgets = new Map<string, ComponentType<Record<string, unknown>>>();

export function registerPanel(opts: RegisterPanelOpts): void {
  panels.set(opts.key, opts);
}

export function registerFilterWidget(key: string, Component: ComponentType<Record<string, unknown>>): void {
  filterWidgets.set(key, Component);
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

export const pluginUi = {
  registerPanel,
  registerFilterWidget,
  registerFieldWidget,
  useProject,
  useSimulation,
  useJob,
  useRegistry,
  useViewer,
  usePrefs,
  SchemaForm,
};
