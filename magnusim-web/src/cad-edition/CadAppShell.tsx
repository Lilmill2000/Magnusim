/**
 * Magnusim CAD's app shell: Magnusim's AppShell less the workbench (its tree, toolbar,
 * filters, results export and workspaces menu): Home, Settings, the Part workspace over
 * the project page, the toasts and the Assistant's dock with its page tools and relay.
 */
import { useEffect, useLayoutEffect } from 'react';
import { ToastHost } from '../app/ToastHost';
import { AssistantDock } from '../assistant/dock/AssistantDock';
import { dockShortcut } from '../assistant/dock/toggle';
import { startCoreTools } from '../assistant/coreTools';
import { startAssistantRelay } from '../assistant/relay';
import { Home } from '../home/Home';
import { clearIslands } from '../islands';
import { placeHostOnlyPanel, replacePanel } from '../plugin-api';
import { AssistantStep } from '../panels/prefs/AssistantStep';
import { KeybindsStep } from '../panels/prefs/KeybindsStep';
import { PluginsStep } from '../panels/prefs/PluginsStep';
import { useProjectStore } from '../store/project';
import { SetupWizard } from '../wizard/SetupWizard';
import { setWorkspaceDock } from '../workspace/assistantTools';
import { WorkspaceOverlay } from '../workspace/WorkspaceOverlay';
import { ProjectPage } from './ProjectPage';
import { openHashProjectAtStart } from './shell';

export function CadAppShell() {
  useLayoutEffect(() => setWorkspaceDock({ key: () => dockShortcut() }), []);
  useEffect(() => {
    // Settings' island sections, as panels/register.ts places them; none of the
    // workbench's flyouts (they would bring the simulation panels and the viewer).
    clearIslands();
    replacePanel('wiz-plugins', PluginsStep);
    placeHostOnlyPanel('wiz-assistant', AssistantStep);
    placeHostOnlyPanel('wiz-keybinds', KeybindsStep);
    void useProjectStore.getState().loadRegistry().catch((e) => console.warn('[CAD] registry', e));
    // After Home's own start (a child's effect runs first): a project address opens its page.
    openHashProjectAtStart();
    const stopCore = startCoreTools();
    const stopRelay = startAssistantRelay();
    return () => {
      stopCore();
      stopRelay();
    };
  }, []);
  const host = typeof document !== 'undefined' ? document.getElementById('cad-project') : null;
  return (
    <>
      <ToastHost />
      <AssistantDock />
      <Home />
      <SetupWizard />
      {host ? <ProjectPage host={host} /> : null}
      <WorkspaceOverlay />
    </>
  );
}
