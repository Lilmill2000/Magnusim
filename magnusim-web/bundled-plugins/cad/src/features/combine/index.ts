// Combine (decision 2026-09-30; docs/p2p3-plan.md §1.6): MODIFY's "Combine".
// Bodies selected before: the first is the target, the others the tools.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { CombineFeature } from '../../types/doc';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { selectedBodies } from '../../ui/tree/model';
import { P2_ICONS } from '../p2/icons';
import { combineDef } from './feature';
import { CombinePanel } from './panel';

export const COMBINE_COMMAND = 'modify.combine';

export function runCombine(services: AppServices): void {
  const ui = uiFor(services);
  const p = ui.state.get().panel;
  if (p?.kind === 'feature' && p.isNew && p.type === 'combine') return;
  const built = new Set(services.doc.state.get().rebuild.bodies.map((b) => b.id));
  const picked = [...selectedBodies(services.selection.get())].filter((id) => built.has(id));
  const init: Partial<CombineFeature> | undefined = picked.length ? { targets: picked.slice(0, 1), tools: picked.slice(1) } : undefined;
  ui.openNew('combine', init);
}

const module: CadModule = {
  id: 'combine',
  features: [combineDef],
  panels: { combine: CombinePanel },
  install(services) {
    const ui = uiFor(services);
    return services.commands.register({
      id: COMBINE_COMMAND,
      label: 'Combine',
      group: 'modify',
      icon: P2_ICONS.combine,
      order: 50,
      hint: 'Join, cut or intersect bodies (several targets and tools; tools can be kept)',
      activeWhen: { featureType: 'combine' },
      enabled: () => ui.editBlock() ?? (services.doc.state.get().rebuild.bodies.length >= 2 ? true : 'Combine needs two bodies'),
      run: () => runCombine(services),
    });
  },
};

export default module;
