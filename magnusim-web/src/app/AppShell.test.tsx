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

import { AppShell } from './AppShell';

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
