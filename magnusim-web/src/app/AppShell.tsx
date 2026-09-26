import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { FiltersPanel } from '../chrome/FiltersPanel';
import { LeftTree } from '../chrome/LeftTree';
import { TopToolbar } from '../chrome/TopToolbar';
import { Home } from '../home/Home';
import { mountIsland } from '../islands';
import { pluginUi, registerPanel, registerTreeTransform, replacePanel } from '../plugin-api';
import { loadOnePlugin, loadPluginUi } from '../plugins/loader';
import { registerAllIslands } from '../panels/register';
import { useProjectStore } from '../store/project';
import { bindLegacyViewer } from '../viewer/index';
import { SetupWizard } from '../wizard/SetupWizard';

export function AppShell() {
  const [toast, setToast] = useState('');

  useEffect(() => {
    const onToast = (event: Event) => {
      setToast(String((event as CustomEvent<string>).detail || ''));
    };
    window.addEventListener('cfd:plugin-toast', onToast);
    return () => window.removeEventListener('cfd:plugin-toast', onToast);
  }, []);

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
      });
    bindLegacyViewer();
  }, []);

  return (
    <>
      <div data-plugin-toast role="status" hidden={!toast}>
        {toast}
      </div>
      <Home />
      <SetupWizard />
      <LeftTree />
      <TopToolbar />
      {/* Legend, timeline, compare, saved views and inspect point are owned by the
          FILTERS panel and viewport chrome; only plugin filter sections mount here. */}
      <FiltersPanel />
    </>
  );
}
