import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The shell's other parts need the workbench page; only the toast region is under test here.
vi.mock('./RequiredPluginError', () => ({ RequiredPluginError: () => null }));
vi.mock('../chrome/FiltersPanel', () => ({ FiltersPanel: () => null }));
vi.mock('../chrome/LeftTree', () => ({ LeftTree: () => null }));
vi.mock('../chrome/TopToolbar', () => ({ TopToolbar: () => null }));
vi.mock('../home/Home', () => ({ Home: () => null }));
vi.mock('../plugins/loader', () => ({ loadOnePlugin: () => Promise.resolve(), loadPluginUi: () => Promise.resolve() }));
vi.mock('../panels/register', () => ({ registerAllIslands: () => undefined }));
vi.mock('../store/project', () => ({
  useProjectStore: {
    getState: () => ({ projectId: '', loadRegistry: () => Promise.resolve() }),
    subscribe: () => () => undefined,
  },
}));
vi.mock('../viewer/index', () => ({ bindLegacyViewer: () => undefined }));
vi.mock('../wizard/SetupWizard', () => ({ SetupWizard: () => null }));
vi.mock('../workspace/WorkspaceOverlay', () => ({ WorkspaceOverlay: () => null }));
vi.mock('../workspace/WorkspacesMenu', () => ({ WorkspacesMenu: () => null }));
// The Assistant's page relay (its own tests: src/assistant/relay.test.ts).
const relay = vi.hoisted(() => {
  const stop = vi.fn();
  return { stop, start: vi.fn(() => stop) };
});
vi.mock('../assistant/relay', () => ({ startAssistantRelay: relay.start }));

import { AppShell } from './AppShell';

describe("AppShell and the Assistant's page relay", () => {
  it('starts it once with the shell and stops it when the shell goes', () => {
    relay.start.mockClear();
    relay.stop.mockClear();
    const view = render(<AppShell />);
    expect(relay.start).toHaveBeenCalledTimes(1);
    expect(relay.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(relay.stop).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell and the Assistant's dock", () => {
  it('portals the dock into #assistant-dock-root, a child of body outside #app, kept across renders', () => {
    document.body.innerHTML = '<div id="app"><header id="top-header"></header></div><div id="react-root"></div>';
    const view = render(<AppShell />);
    const root = document.getElementById('assistant-dock-root') as HTMLElement;
    expect(root.parentElement).toBe(document.body);
    expect(document.body.lastElementChild).toBe(root);
    const dock = document.getElementById('assistant-dock') as HTMLElement;
    expect(root.contains(dock)).toBe(true);
    expect(document.getElementById('app')?.contains(dock)).toBe(false);
    expect(dock).toHaveAttribute('hidden');
    expect(root.querySelector('[data-assistant-pill]')).not.toBeNull();
    view.rerender(<AppShell />);
    expect(document.getElementById('assistant-dock')).toBe(dock);
    view.unmount();
    expect(document.getElementById('assistant-dock')).toBeNull();
  });

  it('uses the root main.tsx made', () => {
    document.body.innerHTML = '<div id="app"></div><div id="react-root"></div><div id="assistant-dock-root"></div>';
    const made = document.getElementById('assistant-dock-root');
    render(<AppShell />);
    expect(document.querySelectorAll('#assistant-dock-root')).toHaveLength(1);
    expect(made?.querySelector('#assistant-dock')).not.toBeNull();
  });
});

describe('AppShell', () => {
  it("draws the app toast region, and an in-page plugin's toast shows in it", () => {
    render(<AppShell />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveClass('app-toasts');
    act(() => {
      window.__CFD_PLUGIN_UI__?.toast('Saved', { kind: 'success' });
    });
    const toast = region.querySelector('.mgk-toast') as HTMLElement;
    expect(toast).toHaveClass('mgk-toast--success');
    expect(toast).toHaveTextContent('Saved');
  });
});
