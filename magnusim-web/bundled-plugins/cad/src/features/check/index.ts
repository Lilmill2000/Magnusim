// Check (proposal §2.11): INSPECT's "Check", a tool panel.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { P2_ICONS } from '../p2/icons';
import { CheckPanel } from './panel';

export const CHECK_TOOL = 'inspect.check';

const module: CadModule = {
  id: 'check',
  tools: [{ id: CHECK_TOOL, label: 'Check', panel: CheckPanel }],
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: CHECK_TOOL,
      label: 'Check',
      group: 'inspect',
      icon: P2_ICONS.check,
      order: 30,
      hint: 'Whether the selected bodies (or all shown bodies) are valid solids, and what is wrong when not',
      activeWhen: { tool: CHECK_TOOL },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.doc.state.get().rebuild.bodies.length ? true : 'No body yet: make or import one'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === CHECK_TOOL) ui.closePanel();
        else ui.openTool(CHECK_TOOL);
      },
    });
  },
};

export default module;
