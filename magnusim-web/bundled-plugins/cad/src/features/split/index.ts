// Split (proposal §2.7; docs/p2p3-plan.md §1.5): MODIFY's "Split". Bodies
// selected before (or the bodies of selected faces) are taken as the bodies to
// split.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { SplitFeature } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { selectedBodies } from '../../ui/tree/model';
import { P2_ICONS } from '../p2/icons';
import { splitDef } from './feature';
import { SplitPanel } from './panel';

export const SPLIT_COMMAND = 'modify.split';

export function runSplit(services: AppServices): void {
  const ui = uiFor(services);
  const p = ui.state.get().panel;
  if (p?.kind === 'feature' && p.isNew && p.type === 'split') return;
  const built = new Set(services.doc.state.get().rebuild.bodies.map((b) => b.id));
  const picked = [...selectedBodies(services.selection.get())].filter((id) => built.has(id));
  ui.openNew('split', picked.length ? ({ targets: picked } as Partial<SplitFeature>) : undefined);
}

const module: CadModule = {
  id: 'split',
  features: [splitDef],
  panels: { split: SplitPanel },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: SPLIT_COMMAND,
      label: 'Split',
      group: 'modify',
      icon: P2_ICONS.split,
      order: 40,
      hint: 'Cut bodies in pieces with an origin plane, the plane of a flat face, or another body',
      activeWhen: { featureType: 'split' },
      enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length ? true : 'Make or import a body first'),
      run: () => runSplit(services),
    });
  },
};

export default module;
