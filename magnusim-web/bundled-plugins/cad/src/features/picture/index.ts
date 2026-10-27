// Picture (FILE): the person's labelled pictures, the Assistant's view tool. Pictures of the Part
// from fixed directions (iso, back iso, the six standard views; one to four on one sheet), drawn
// off screen, so the person's own view never moves: bodies left out, a section cut, labels (body
// names, or face handles the Find panel reads), small or large, display and projection. The
// picture is shown in the panel and saved as a PNG with a click. A tool panel: nothing is undoable.
// Owner: ASSISTANT (the person's side of view).
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { PicturePanel } from './panel';

export const PICTURE_TOOL = 'file.picture';

/** A picture frame with a mountain and a sun (24 viewBox outline). */
export const PICTURE_ICON = 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M16 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0';

const module: CadModule = {
  id: 'picture',
  tools: [{ id: PICTURE_TOOL, label: 'Picture', panel: PicturePanel, wide: true }],
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: PICTURE_TOOL,
      label: 'Picture',
      group: 'file',
      icon: PICTURE_ICON,
      order: 30,
      hint: 'A picture of the part from set directions, with body names or face labels, saved as a PNG',
      activeWhen: { tool: PICTURE_TOOL },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.viewport.get().handle ? true : 'The 3D view is not ready'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === PICTURE_TOOL) ui.closePanel();
        else ui.openTool(PICTURE_TOOL);
      },
    });
  },
};

export default module;
