import { createRoot, type Root } from 'react-dom/client';
import { Component, type ComponentType, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export interface IslandProps {
  projectId?: string;
  simId?: string;
  itemId?: string;
  /** ScopeId for this study or mesh. Islands do not read sibling catalogs. */
  scope?: string;
  panelId: string;
}

type IslandComponent = ComponentType<IslandProps>;

export class PanelBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : 'This panel failed to load.' };
  }

  render() {
    if (this.state.error) {
      return <p role="alert" data-panel-boundary="1">{this.state.error}</p>;
    }
    return this.props.children;
  }
}

const registry = new Map<string, IslandComponent>();
const roots = new Map<string, Root>();
const queryClient = new QueryClient();
let mountSerial = 0;

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
  const serial = ++mountSerial;
  root.render(
    <QueryClientProvider client={queryClient}>
      <PanelBoundary key={serial}>
        <Component {...props} panelId={panelId} />
      </PanelBoundary>
    </QueryClientProvider>,
  );
}

export function unmountIsland(panelId: string): void {
  const root = roots.get(panelId);
  if (root) {
    root.unmount();
    roots.delete(panelId);
  }
  const host = document.getElementById(panelId);
  host?.querySelector(':scope > .cfd-island')?.remove();
}

export function dispatchPanelDone(): void {
  window.dispatchEvent(new CustomEvent('cfd:panel-done'));
}
