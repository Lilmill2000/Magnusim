// Export STEP (proposal §2.13, §4.10): FILE's "Export STEP", a tool panel.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { filesFor } from '../../files/transfer';
import { P2_ICONS } from '../p2/icons';
import { ExportPanel } from './panel';

const module: CadModule = {
  id: 'export',
  tools: [{ id: WELL_KNOWN_COMMANDS.exportStep, label: 'Export STEP', panel: ExportPanel }],
  install(services) {
    const ui = uiFor(services);
    filesFor(services);
    return services.commands.register({
      id: WELL_KNOWN_COMMANDS.exportStep,
      label: 'Export STEP',
      group: 'file',
      icon: P2_ICONS.exportStep,
      order: 20,
      hint: 'Save bodies as a STEP file (AP214 or AP242) with their names and colours',
      activeWhen: { tool: WELL_KNOWN_COMMANDS.exportStep },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.doc.state.get().rebuild.bodies.length ? true : 'Nothing to export yet: make or import a body'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === WELL_KNOWN_COMMANDS.exportStep) ui.closePanel();
        else ui.openTool(WELL_KNOWN_COMMANDS.exportStep);
      },
    });
  },
};

export default module;
