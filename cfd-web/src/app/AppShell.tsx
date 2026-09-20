import { useEffect } from 'react';
import { CompareLayout, FiltersPanel, InspectPoint, Legend, SavedViews, Timeline } from '../chrome/FiltersPanel';
import { LeftTree } from '../chrome/LeftTree';
import { TopToolbar } from '../chrome/TopToolbar';
import { Home } from '../home/Home';
import { registerAllIslands } from '../panels/register';
import { useProjectStore } from '../store/project';
import { bindLegacyViewer } from '../viewer/index';
import { SetupWizard } from '../wizard/SetupWizard';

export function AppShell() {
  useEffect(() => {
    registerAllIslands();
    void useProjectStore.getState().loadRegistry().catch((e) => console.warn('[CFD] registry', e));
    bindLegacyViewer();
  }, []);

  return (
    <>
      <Home />
      <SetupWizard />
      <LeftTree />
      <TopToolbar />
      <FiltersPanel />
      <Legend />
      <Timeline />
      <CompareLayout />
      <SavedViews />
      <InspectPoint />
    </>
  );
}
