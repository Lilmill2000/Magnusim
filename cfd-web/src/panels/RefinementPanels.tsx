import type { IslandProps } from '../islands';
import { PanelChrome } from './PanelChrome';

export function RefinementsHub(_props: IslandProps) {
  return (
    <PanelChrome title="Refinements">
      <p className="mat-assign-hint">Local and object refinements on the active mesh.</p>
    </PanelChrome>
  );
}

export function RefinementPicker(_props: IslandProps) {
  return (
    <PanelChrome title="Add refinement">
      <p className="mat-assign-hint">Pick a refinement type, then assign faces or a region.</p>
    </PanelChrome>
  );
}

export function RefinementEditor(_props: IslandProps) {
  return (
    <PanelChrome title="Refinement">
      <p className="mat-assign-hint">Settings persist on change.</p>
    </PanelChrome>
  );
}
