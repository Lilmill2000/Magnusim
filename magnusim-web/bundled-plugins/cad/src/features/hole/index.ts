// Hole (SOLID): round holes drilled into one flat face in one step, the Assistant's hole tool on the
// person's side: a sketch of circles and a cut extrude, the same two features. A tool panel (it
// makes ordinary features, so it has no feature type of its own); "Hole" in a flat face's context
// menu opens it with that face.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { selectItem } from '../../lib/selection';
import { HolePanel } from './panel';

export const HOLE_TOOL = 'solid.hole';

/** A block with two drilled holes (24 viewBox outline). */
export const HOLE_ICON = 'M3 9l9-4 9 4v7l-9 4-9-4z M3 9l9 4 9-4 M12 13v7 M8 9m-1.6 0a1.6 0.8 0 1 0 3.2 0a1.6 0.8 0 1 0 -3.2 0 M14.5 8m-1.6 0a1.6 0.8 0 1 0 3.2 0a1.6 0.8 0 1 0 -3.2 0';

const module: CadModule = {
  id: 'hole',
  tools: [{ id: HOLE_TOOL, label: 'Hole', panel: HolePanel }],
  contextMenu(services, pick) {
    if (!pick || pick.item.kind !== 'face') return [];
    const item = pick.item;
    const ui = uiFor(services);
    return [
      {
        id: 'hole',
        label: 'Hole',
        disabled: ui.editBlock(),
        run: () => {
          selectItem(services.selection, item, false);
          ui.openTool(HOLE_TOOL);
        },
      },
    ];
  },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: HOLE_TOOL,
      label: 'Hole',
      group: 'solid',
      icon: HOLE_ICON,
      order: 34,
      hint: 'Round holes into a flat face: pick the face, click the centres, set the diameter and depth',
      activeWhen: { tool: HOLE_TOOL },
      enabled: () => {
        const s = services.doc.state.get();
        if (s.status !== 'ready') return 'The part is still loading';
        const block = ui.editBlock();
        if (block) return block;
        return s.rebuild.bodies.length ? true : 'No body to drill yet: make or import one';
      },
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === HOLE_TOOL) ui.closePanel();
        else ui.openTool(HOLE_TOOL);
      },
    });
  },
};

export default module;
