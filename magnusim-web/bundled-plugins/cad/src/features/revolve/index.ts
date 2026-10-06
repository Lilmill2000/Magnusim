// The revolve module (P4a): the `revolve` feature type, its panel, and SOLID's
// "Revolve" command (beside Extrude). Select first, then act: the panel opens with
// the selected profiles (or a selected sketch's, or the only one there is), and with
// the sketch's centerline as the axis when it has exactly one.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import type { RevolveFeature } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { anyProfiles, NO_PROFILES, preselectedProfiles } from '../extrude/command';
import { soleCenterline } from '../solids/centerline';
import { SOLIDS_ICONS } from '../solids/icons';
import { revolveDef } from './def';
import { RevolvePanel } from './panel';

export const REVOLVE_COMMAND = 'solid.revolve';

const revolveModule: CadModule = {
  id: 'revolve',
  features: [revolveDef as unknown as FeatureTypeDef],
  panels: { revolve: RevolvePanel },
  install(services: AppServices) {
    const ui = uiFor(services);
    return services.commands.register({
      id: REVOLVE_COMMAND,
      label: 'Revolve',
      group: 'solid',
      icon: SOLIDS_ICONS.revolve,
      order: 31,
      hint: 'A solid turned from closed profiles of a sketch about an axis (a centerline, an edge or an axis)',
      explainRefusal: true,
      activeWhen: { featureType: 'revolve' },
      enabled: () => ui.editBlock() ?? (anyProfiles(services) ? true : NO_PROFILES),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'feature' && p.isNew && p.type === 'revolve') return;
        const pre = preselectedProfiles(services);
        if ('refused' in pre) {
          services.bridge.toast(`Revolve: ${pre.refused}`, 'info');
          return;
        }
        const axis = pre.profiles[0] ? soleCenterline(services.doc.state.get().doc, pre.profiles[0].sketch) : null;
        ui.openNew('revolve', pre.profiles.length ? ({ profiles: pre.profiles, ...(axis ? { axis } : {}) } as Partial<RevolveFeature>) : undefined);
      },
    });
  },
};

export default revolveModule;
