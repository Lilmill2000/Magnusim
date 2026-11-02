// Find (INSPECT): the person's select-by-query, the Assistant's find with the same selector
// language ("Body 1 faces >Z", "largest", "%cylinder", "hole", "fillet <= 2 mm", "hole <= 6 mm",
// "face at (x, y, z)", "edges of Base.end", "Plate sketch regions", "bodies"). A tool panel: the
// matches are listed, lit in the view, and selected with a click; nothing is undoable or saved.
// Owner: ASSISTANT (the person's side of find).
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { FindPanel } from './panel';

export const FIND_TOOL = 'inspect.find';

/** A magnifier over a list (24 viewBox outline). */
export const FIND_ICON = 'M10 10m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0 M14.5 14.5L20 20 M7.5 8.5h5 M7.5 11.5h3.5';

const module: CadModule = {
  id: 'find',
  tools: [{ id: FIND_TOOL, label: 'Find', panel: FindPanel, wide: true }],
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: FIND_TOOL,
      label: 'Find',
      group: 'inspect',
      icon: FIND_ICON,
      order: 40,
      hint: 'Find and select faces, edges, bodies or sketch regions by a query: "Body 1 faces >Z", "largest", "hole", "fillet <= 2 mm"',
      activeWhen: { tool: FIND_TOOL },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : true),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === FIND_TOOL) ui.closePanel();
        else ui.openTool(FIND_TOOL);
      },
    });
  },
};

export default module;
