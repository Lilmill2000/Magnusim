// The fillet module (P4a): the `fillet` feature type, its panel, and MODIFY's
// "Fillet" command (selected edges and faces of one body open in the panel).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import { localCommand } from '../solids/commands';
import { SOLIDS_ICONS } from '../solids/icons';
import { filletDef } from './def';
import { FilletPanel } from './panel';

export const FILLET_COMMAND = 'modify.fillet';

const filletModule: CadModule = {
  id: 'fillet',
  features: [filletDef as unknown as FeatureTypeDef],
  panels: { fillet: FilletPanel },
  install(services) {
    return services.commands.register(
      localCommand(services, { id: FILLET_COMMAND, type: 'fillet', label: 'Fillet', icon: SOLIDS_ICONS.fillet, order: 11, edges: true, hint: 'Round edges of a body with a constant radius (an edge takes its tangent chain; a face, all its edges)' }),
    );
  },
};

export default filletModule;
