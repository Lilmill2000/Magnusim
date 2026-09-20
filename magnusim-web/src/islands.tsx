import { createRoot, type Root } from 'react-dom/client';
import type { ComponentType } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export interface IslandProps {
  projectId?: string;
  simId?: string;
  itemId?: string;
  panelId: string;
}

type IslandComponent = ComponentType<IslandProps>;

const registry = new Map<string, IslandComponent>();
const roots = new Map<string, Root>();
const queryClient = new QueryClient();

export function registerIsland(panelId: string, Component: IslandComponent): void {
  registry.set(panelId, Component);
}

export function clearIslands(): void {
  for (const panelId of [...roots.keys()]) {
    unmountIsland(panelId);
  }
  registry.clear();
}

export function isIsland(panelId: string): boolean {
  return registry.has(panelId);
}

export function mountIsland(panelId: string, props: Omit<IslandProps, 'panelId'>): void {
  const Component = registry.get(panelId);
  const host = document.getElementById(panelId);
  if (!Component || !host) return;
  let slot = host.querySelector<HTMLElement>(':scope > .cfd-island');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'cfd-island';
    host.appendChild(slot);
  }
  let root = roots.get(panelId);
  if (!root) {
    root = createRoot(slot);
    roots.set(panelId, root);
  }
  root.render(
    <QueryClientProvider client={queryClient}>
      <Component {...props} panelId={panelId} />
    </QueryClientProvider>,
  );
}

export function unmountIsland(panelId: string): void {
  const root = roots.get(panelId);
  if (root) {
    root.unmount();
    roots.delete(panelId);
  }
  document.getElementById(panelId)?.querySelector(':scope > .cfd-island')?.remove();
}

export function dispatchPanelDone(): void {
  window.dispatchEvent(new CustomEvent('cfd:panel-done'));
}
