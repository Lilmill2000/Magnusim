// See-through bodies (Daniel 2026-10-29: "per-body see-through as a VIEW state, like hiddenBodies:
// Inspect -> Transparent for the selected bodies, and the body tree menu toggles it back"): INSPECT's
// "See-through", a toggle over the bodies the person's selection touches (rule.ts). It makes them
// see-through, or opaque again when all of them already are; a mix all turn see-through. The Part
// keeps the list with its view (CadView.seeThroughBodies, no undo step); the view draws those bodies
// translucent with their edges, a click passes through them to an opaque face behind, a section
// caps them translucent (viewport.ts, section.ts), pictures draw them so too. The body's menu (tree
// and view) has Make <body> see-through / opaque; the Assistant has workspace see_through / opaque.
// Owner: VIEWPORT (see-through bodies).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadModule } from '../../types/modules';
import { userItems } from '../../lib/selection';
import { uiFor } from '../../ui/controller';
import { ICONS } from '../../ui/Icon';
import { allSeeThrough, seeThroughTarget, selectedEntries, SEE_THROUGH_COMMAND } from './rule';

const module: CadModule = {
  id: 'see_through',
  install(services) {
    const ui = uiFor(services);
    const entries = () => selectedEntries(services.doc.state.get(), services, userItems(services.selection));
    return services.commands.register({
      id: SEE_THROUGH_COMMAND,
      label: 'See-through',
      group: 'inspect',
      icon: ICONS.seeThrough,
      order: 17,
      hint: 'Draw the selected bodies see-through, so what is inside and behind them shows (a selected face counts for its body); again, when all of them are, makes them opaque. A mix of the two all turn see-through. Kept with the Part, no undo step',
      explainRefusal: true,
      enabled: () => {
        if (services.doc.state.get().status !== 'ready') return 'The part is still loading';
        const t = seeThroughTarget(entries());
        return typeof t === 'string' ? t : true;
      },
      pressed: () => allSeeThrough(entries()),
      run: () => {
        const t = seeThroughTarget(entries());
        if (typeof t === 'string') return;
        const why = ui.setBodiesSeeThrough(t.ids, t.on);
        if (why) ui.fail(t.on ? 'See-through' : 'Opaque', why);
      },
    });
  },
};

export default module;
