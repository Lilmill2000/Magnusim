// Move/copy body: MODIFY's "Move/copy body" (key M), and "Move/copy Body 1…" in a body's menu
// (the tree's and the view's, above its Delete). Bodies selected before (or the bodies of
// selected faces, edges or points) are the bodies it moves; the panel takes more.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import { userSelection } from '../../lib/selection';
import type { AppServices } from '../../types/app';
import type { MoveBodyFeature } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { selectedBodies } from '../../ui/tree/model';
import { MOVE_BODY_ICON, moveBodyDef } from './feature';
import { MoveBodyPanel } from './panel';

export const MOVE_BODY_COMMAND = 'modify.move-body';

export function runMoveBody(services: AppServices): void {
  const ui = uiFor(services);
  const p = ui.state.get().panel;
  if (p?.kind === 'feature' && p.owner === 'person' && p.isNew && p.type === 'move_body') return;
  const built = new Set(services.doc.state.get().rebuild.bodies.map((b) => b.id));
  const picked = [...selectedBodies(userSelection(services.selection.get()))].filter((id) => built.has(id));
  ui.openNew('move_body', picked.length ? ({ bodies: picked } as Partial<MoveBodyFeature>) : undefined);
}

const module: CadModule = {
  id: 'move_body',
  features: [moveBodyDef],
  panels: { move_body: MoveBodyPanel },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: MOVE_BODY_COMMAND,
      label: 'Move/copy body',
      group: 'modify',
      icon: MOVE_BODY_ICON,
      order: 45,
      hint: 'Move and turn bodies, or copies of them',
      activeWhen: { featureType: 'move_body' },
      enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : 'Make or import a body first'),
      run: () => runMoveBody(services),
    });
  },
};

export default module;
