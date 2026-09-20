import { registerIsland, mountIsland, clearIslands } from '../islands';
import { MeshForm } from './MeshPanels';

/** Live panels already have HTML chrome. Only mount islands that do not dump a second form. */
const MAP: Record<string, Parameters<typeof registerIsland>[1]> = {
  'panel-mesh-form': MeshForm,
};

export function registerAllIslands(): void {
  clearIslands();
  for (const [id, Component] of Object.entries(MAP)) {
    registerIsland(id, Component);
  }
}

export function mountAllIslands(): void {
  for (const id of Object.keys(MAP)) {
    if (document.getElementById(id)) mountIsland(id, {});
  }
}
