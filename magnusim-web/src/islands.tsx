import { createRoot, type Root } from 'react-dom/client';
import { Component, Fragment, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PanelError } from './plugin-ui';

export interface IslandProps {
  projectId?: string;
  simId?: string;
  itemId?: string;
  /** ScopeId for this study or mesh. Islands do not read sibling catalogs. */
  scope?: string;
  panelId: string;
}

type IslandComponent = ComponentType<IslandProps>;

/**
 * A panel that throws shows a card in its place: what failed, Try again (a fresh
 * mount), and Done when it is a panel host's whole content (`chrome`).
 */
export class PanelBoundary extends Component<
  { children: ReactNode; panelId?: string; chrome?: boolean },
  { error: string; tries: number }
> {
  state = { error: '', tries: 0 };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : 'This panel failed to load.' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[panel]', this.props.panelId || '', error, info.componentStack);
  }

  render() {
    const { error, tries } = this.state;
    if (error) {
      return (
        <PanelError
          message={error}
          onRetry={() => this.setState({ error: '', tries: tries + 1 })}
          onDone={this.props.chrome ? dispatchPanelDone : undefined}
          attrs={{ 'data-panel-boundary': '1' }}
        />
      );
    }
    return <Fragment key={tries}>{this.props.children}</Fragment>;
  }
}

const registry = new Map<string, IslandComponent>();
const roots = new Map<string, Root>();
const queryClient = new QueryClient();
let mountSerial = 0;

export function registerIsland(panelId: string, Component: IslandComponent): void {
  registry.set(panelId, Component);
}

/** The component registered for a panel host, if any (plugins restore it on disable). */
export function islandComponent(panelId: string): IslandComponent | undefined {
  return registry.get(panelId);
}

/** Drop a panel host's component and unmount it. */
export function unregisterIsland(panelId: string): void {
  unmountIsland(panelId);
  registry.delete(panelId);
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
      <PanelBoundary key={serial} panelId={panelId} chrome>
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
