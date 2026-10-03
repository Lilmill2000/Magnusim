// Mass properties (proposal §2.11): INSPECT's "Mass properties", a tool panel.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { P2_ICONS } from '../p2/icons';
import { MassPanel } from './panel';

export const MASS_TOOL = 'inspect.mass';

const module: CadModule = {
  id: 'mass',
  tools: [{ id: MASS_TOOL, label: 'Mass properties', panel: MassPanel }],
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: MASS_TOOL,
      label: 'Mass properties',
      group: 'inspect',
      icon: P2_ICONS.mass,
      order: 20,
      hint: 'Volume, surface area, centroid and size of the selected bodies, or of all shown bodies',
      activeWhen: { tool: MASS_TOOL },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.doc.state.get().rebuild.bodies.length ? true : 'No body yet: make or import one'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === MASS_TOOL) ui.closePanel();
        else ui.openTool(MASS_TOOL);
      },
    });
  },
};

export default module;
