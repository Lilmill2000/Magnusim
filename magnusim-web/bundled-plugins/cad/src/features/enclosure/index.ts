// Enclosure (decision 2026-10-01): CFD PREP's only command, and the only
// place a box or a cylinder is made. A box or a cylinder around the bodies,
// as a new body; the air volume is a separate Combine (Cut, keep tools).
// Offered once a body exists ("Add or import a body first" before that).
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import './enclosure.css';
import '../p2/p2.css';
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { ENCLOSURE_ICON, enclosureDef, isEnclosureBody } from './def';
import { EnclosurePanel } from './EnclosurePanel';

export const ENCLOSURE_COMMAND = 'cfd.enclosure';
export const NO_BODY = 'Add or import a body first';

/** Whether a body the Enclosure can wrap exists at the rollback bar (another enclosure's body does not count). */
export function anyBodyToEnclose(services: AppServices): boolean {
  const s = services.doc.state.get();
  return s.rebuild.bodies.some((b) => !isEnclosureBody(s.doc.features, b.id));
}

export function enclosureCommand(services: AppServices): CommandDef {
  const ui = uiFor(services);
  return {
    id: ENCLOSURE_COMMAND,
    label: 'Enclosure',
    group: 'cfd',
    icon: ENCLOSURE_ICON,
    order: 10,
    hint: 'A box or a cylinder around the bodies, as a new body (for the air around the part: then Combine, Cut)',
    explainRefusal: true,
    activeWhen: { featureType: 'enclosure' },
    enabled: () => ui.editBlock() ?? (anyBodyToEnclose(services) ? true : NO_BODY),
    run: () => {
      const p = ui.state.get().panel;
      // The new enclosure being edited stays open.
      if (p?.kind === 'feature' && p.isNew && p.type === 'enclosure') return;
      ui.openNew('enclosure');
    },
  };
}

const enclosureModule: CadModule = {
  id: 'enclosure',
  features: [enclosureDef as unknown as FeatureTypeDef],
  panels: { enclosure: EnclosurePanel },
  install(services: AppServices) {
    return services.commands.register(enclosureCommand(services));
  },
};

export default enclosureModule;
