// Measure (proposal §2.11): INSPECT's "Measure", a tool panel (not a feature).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { P2_ICONS } from '../p2/icons';
import { MeasurePanel } from './panel';

const module: CadModule = {
  id: 'measure',
  tools: [{ id: WELL_KNOWN_COMMANDS.measure, label: 'Measure', panel: MeasurePanel }],
  contextMenu(services, pick) {
    if (!pick || (pick.item.kind !== 'face' && pick.item.kind !== 'edge' && pick.item.kind !== 'vertex')) return [];
    return [{ id: 'measure', label: 'Measure', run: () => uiFor(services).openTool(WELL_KNOWN_COMMANDS.measure) }];
  },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: WELL_KNOWN_COMMANDS.measure,
      label: 'Measure',
      group: 'inspect',
      icon: P2_ICONS.measure,
      order: 10,
      hint: 'Distance, angle, length, area and radius of what you pick',
      activeWhen: { tool: WELL_KNOWN_COMMANDS.measure },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.doc.state.get().rebuild.bodies.length ? true : 'Nothing to measure yet: make or import a body'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === WELL_KNOWN_COMMANDS.measure) ui.closePanel();
        else ui.openTool(WELL_KNOWN_COMMANDS.measure);
      },
    });
  },
};

export default module;
