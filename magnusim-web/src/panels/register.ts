import { clearIslands } from '../islands';
import { replacePanel } from '../plugin-api';
import { BcPanel } from './bcs/BcPanel';
import { MaterialsPanel } from './materials/MaterialsPanel';
import { GeometryPanel } from './geometry/GeometryPanel';
import { MeshInspect, MeshSettings } from './mesh/MeshPanel';
import { PluginsStep } from './prefs/PluginsStep';
import { RunControl } from './run/RunControl';
import { SimulationDefaults, SimulationHub } from './simulation/SimulationPanel';

/** Host flyouts register through the same function plugins will use. */
export function registerAllIslands(): void {
  clearIslands();
  replacePanel('panel-incompressible-defaults', SimulationDefaults);
  replacePanel('cs-type-list', SimulationHub);
  replacePanel('panel-materials-hub', MaterialsPanel);
  replacePanel('panel-material-picker', MaterialsPanel);
  replacePanel('panel-air-material', MaterialsPanel);
  replacePanel('panel-bcs-hub', BcPanel);
  replacePanel('panel-bc-picker', BcPanel);
  replacePanel('panel-bc-editor', BcPanel);
  replacePanel('panel-mesh-form', MeshSettings);
  replacePanel('panel-mesh-inspect', MeshInspect);
  replacePanel('panel-sim-control', RunControl);
  replacePanel('panel-geometry', GeometryPanel);
  replacePanel('wiz-plugins', PluginsStep);
}

export function mountAllIslands(): void {
  /* Islands mount when the flyout opens, with that study's scope. */
}
