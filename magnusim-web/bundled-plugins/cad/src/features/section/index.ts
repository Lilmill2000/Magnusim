// Section view (Daniel 2026-10-29: "any plane including constructed reference planes, a draggable
// normal arrow moving the cut, typed offset and flip"): INSPECT's "Section view", a tool panel over
// the view's one section state, and the binding that keeps that state true to the Part (bind.ts:
// follows a construction plane or a face, turns off when its plane is gone, kept in the Part's view).
// The command turns the cut on as it opens the panel (through the middle of the shown bodies on the
// plane it had, as the view tools' button does); run again, it closes the panel and leaves the cut.
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { startOffset } from '../../viewport/ViewportChrome';
import { bindSection } from './bind';
import { SectionPanel } from './panel';
import { SECTION_COMMAND } from './plane';

/** The outline of the view tools' section button: a box cut by a plane. */
const ICON = 'M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9z M3 15.5l18-7';

const module: CadModule = {
  id: 'section',
  tools: [{ id: SECTION_COMMAND, label: 'Section view', panel: SectionPanel }],
  install(services) {
    const ui = uiFor(services);
    const offBind = bindSection(services);
    const offCommand = services.commands.register({
      id: SECTION_COMMAND,
      label: 'Section view',
      group: 'inspect',
      icon: ICON,
      order: 15,
      hint: 'Cut the view on any plane (a construction plane or a flat face too) and drag the cut along its normal',
      activeWhen: { tool: SECTION_COMMAND },
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : services.viewport.get().handle ? true : 'The view is not shown'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'tool' && p.tool === SECTION_COMMAND) {
          ui.closePanel();
          return;
        }
        const h = services.viewport.get().handle;
        const sec = h?.state.get().section;
        if (h && sec && !sec.on) h.setSection({ on: true, offset: startOffset(h, sec) });
        ui.openTool(SECTION_COMMAND);
      },
    });
    return () => {
      offCommand();
      offBind();
    };
  },
};

export default module;
