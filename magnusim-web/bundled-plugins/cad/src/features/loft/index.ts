// The loft module (P4a): the `loft` feature type, its panel, and SOLID's "Loft"
// command (after Sweep). Regions selected before (one in each sketch) open as its
// profiles, in the order they were selected.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import type { LoftFeature, RegionRef } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { refOfRegion } from '../extrude/profiles';
import { sketchOutput } from '../sketch/view';
import { SOLIDS_ICONS } from '../solids/icons';
import { loftDef } from './def';
import { LoftPanel } from './panel';
import { userItems } from '../../lib/selection';

export const LOFT_COMMAND = 'solid.loft';

/** How many built sketches have a closed profile. */
function sketchesWithProfiles(services: AppServices): number {
  const outs = services.doc.state.get().rebuild.outputs ?? {};
  return Object.values(outs).filter((o) => o.type === 'sketch' && o.regions.length > 0).length;
}

const loftModule: CadModule = {
  id: 'loft',
  features: [loftDef as unknown as FeatureTypeDef],
  panels: { loft: LoftPanel },
  install(services: AppServices) {
    const ui = uiFor(services);
    return services.commands.register({
      id: LOFT_COMMAND,
      label: 'Loft',
      group: 'solid',
      icon: SOLIDS_ICONS.loft,
      order: 33,
      hint: 'A solid through closed profiles of two or more sketches, in order',
      explainRefusal: true,
      activeWhen: { featureType: 'loft' },
      enabled: () => ui.editBlock() ?? (sketchesWithProfiles(services) >= 2 ? true : 'Draw closed profiles in two sketches first (on two planes)'),
      run: () => {
        const p = ui.state.get().panel;
        if (p?.kind === 'feature' && p.isNew && p.type === 'loft') return;
        const s = services.doc.state.get();
        const sections: RegionRef[] = [];
        for (const it of userItems(services.selection)) {
          if (it.kind !== 'region') continue;
          if (sections.some((x) => x.sketch === it.feature)) {
            services.bridge.toast('Loft: pick one profile per sketch', 'info');
            ui.openNew('loft');
            return;
          }
          const r = sketchOutput(s, it.feature)?.regions.find((x) => x.key === it.key);
          if (r) sections.push(refOfRegion(it.feature, r));
        }
        ui.openNew('loft', sections.length ? ({ sections } as Partial<LoftFeature>) : undefined);
      },
    });
  },
};

export default loftModule;
