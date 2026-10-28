import React, { useEffect, useLayoutEffect } from 'react';
import { RequiredPluginError } from './RequiredPluginError';
import { ToastHost } from './ToastHost';
import ReactDOM from 'react-dom/client';
import { AssistantDock } from '../assistant/dock/AssistantDock';
import { dockShortcut } from '../assistant/dock/toggle';
import { startCoreTools } from '../assistant/coreTools';
import { startAssistantRelay } from '../assistant/relay';
import { FiltersPanel } from '../chrome/FiltersPanel';
import { LeftTree } from '../chrome/LeftTree';
import { VtkExport } from '../chrome/VtkExport';
import { Home } from '../home/Home';
import { mountIsland } from '../islands';
import { pluginUi, registerPanel, registerTreeTransform, replacePanel } from '../plugin-api';
import { loadOnePlugin, loadPluginUi } from '../plugins/loader';
import { registerAllIslands } from '../panels/register';
import { useProjectStore } from '../store/project';
import { bindLegacyViewer } from '../viewer/index';
import { SetupWizard } from '../wizard/SetupWizard';
import { setWorkspaceDock } from '../workspace/assistantTools';
import { WorkspaceOverlay } from '../workspace/WorkspaceOverlay';
import { WorkspacesMenu } from '../workspace/WorkspacesMenu';

export function AppShell() {
  // The dock registers with the workspaces before any opens (a layout effect runs before every
  // component's effects): a frame's welcome says it is docked, and its Ctrl+/ (assistant.dock)
  // is the same key in the app's page.
  useLayoutEffect(() => setWorkspaceDock({ key: () => dockShortcut() }), []);
  useEffect(() => {
    registerAllIslands();
    window.__CFD_PLUGIN_UI__ = pluginUi;
    window.__CFD_TREE_TRANSFORM__ = registerTreeTransform;
    window.__CFD_REPLACE_PANEL__ = (panelId, mode) => {
      const Probe =
        mode === 'throw'
          ? function Boom() {
              throw new Error('panel failed');
            }
          : function Ok() {
              return <div data-plugin-panel="probe">Probe panel</div>;
            };
      replacePanel(panelId, Probe);
      const host = document.getElementById(panelId);
      if (host && !host.hidden) {
        mountIsland(panelId, { scope: window.__CFD_RUN_SCOPE__ || '', itemId: '' });
      }
    };
    window.__CFD_REGISTER_FILTER__ = (title) => {
      registerPanel({
        key: 'h4-probe',
        title,
        place: 'filters',
        Component: function ProbeFilter() {
          return <section data-filter-plugin="1">{title}</section>;
        },
      });
    };
    window.__CFD_REACT__ = React;
    window.__CFD_REACT_DOM__ = ReactDOM;
    window.__CFD_LOAD_PLUGIN_UI__ = (plugin) => loadOnePlugin(plugin, window.__CFD_RUN_SCOPE__ || '');
    const projectId = useProjectStore.getState().projectId || '';
    void useProjectStore.getState().loadRegistry().catch((e) => console.warn('[CFD] registry', e));
    void loadPluginUi(projectId ? `p:${projectId}` : '')
      .catch(() => undefined)
      .finally(() => {
        window.__CFD_PLUGINS_READY__ = true;
        window.dispatchEvent(new Event('cfd:plugins-ready'));
      });
    bindLegacyViewer();
    // Plugins register with the open project's scope; re-run them when it changes
    // (loadOnePlugin removes each plugin's previous registrations first).
    let lastProject = projectId;
    const unsubscribe = useProjectStore.subscribe((state) => {
      const next = state.projectId || '';
      if (next === lastProject) return;
      lastProject = next;
      void loadPluginUi(next ? `p:${next}` : '').catch(() => undefined);
    });
    // The app page's own tools and where this tab is (core host tools spec C7): every app tab on
    // this PC offers them, so the Assistant's turns bind to their window from Home and the workbench.
    const stopCore = startCoreTools();
    // The open workspace's tools and the core page's reach the Assistant through this tab.
    const stopRelay = startAssistantRelay();
    return () => {
      unsubscribe();
      stopCore();
      stopRelay();
    };
  }, []);

  return (
    <>
      {/* App toasts (a plugin UI that failed, pluginUi.toast), above an open workspace. */}
      <ToastHost />
      {/* The Assistant's dock, bottom right: a portal into #assistant-dock-root, outside #app. */}
      <AssistantDock />
      <RequiredPluginError />
      <Home />
      <SetupWizard />
      <LeftTree />
      {/* Export to ParaView (VTK) and Open case folder, for the results on screen. */}
      <VtkExport />
      {/* Legend, timeline, compare, saved views and inspect point are owned by the
          FILTERS panel and viewport chrome; only plugin filter sections mount here. */}
      <FiltersPanel />
      {/* After <LeftTree />: sibling effects run in order, so the menu joins the tree's
          first read (followProjectTree) instead of queueing a second one (h11 stale-rev). */}
      <WorkspacesMenu />
      <WorkspaceOverlay />
    </>
  );
}
