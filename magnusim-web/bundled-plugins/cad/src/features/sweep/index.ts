// The sweep module (P4a): the `sweep` feature type, its panel, and SOLID's "Sweep"
// command (after Revolve). The panel opens with the selected profiles (or a selected
// sketch's); the path is picked in the panel.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import type { SweepFeature } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { anyProfiles, NO_PROFILES, preselectedProfiles } from '../extrude/command';
import { SOLIDS_ICONS } from '../solids/icons';
import { sweepDef } from './def';
import { SweepPanel } from './panel';

export const SWEEP_COMMAND = 'solid.sweep';

const sweepModule: CadModule = {
  id: 'sweep',
  features: [sweepDef as unknown as FeatureTypeDef],
  panels: { sweep: SweepPanel },
  install(services: AppServices) {
    const ui = uiFor(services);
    return services.commands.register({
      id: SWEEP_COMMAND,
      label: 'Sweep',
      group: 'solid',
      icon: SOLIDS_ICONS.sweep,
      order: 32,
      hint: 'A solid from closed profiles of a sketch swept along a path drawn in another sketch',
      explainRefusal: true,
      activeWhen: { featureType: 'sweep' },
      enabled: () => ui.editBlock() ?? (anyProfiles(services) ? true : NO_PROFILES),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'feature' && p.isNew && p.type === 'sweep') return;
        const pre = preselectedProfiles(services);
        if ('refused' in pre) {
          services.bridge.toast(`Sweep: ${pre.refused}`, 'info');
          return;
        }
        ui.openNew('sweep', pre.profiles.length ? ({ profiles: pre.profiles } as Partial<SweepFeature>) : undefined);
      },
    });
  },
};

export default sweepModule;
