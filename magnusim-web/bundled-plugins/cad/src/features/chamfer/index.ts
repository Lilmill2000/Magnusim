// The chamfer module (P4a): the `chamfer` feature type, its panel, and MODIFY's
// "Chamfer" command (selected edges and faces of one body open in the panel).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import '../p2/p2.css';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import { localCommand } from '../solids/commands';
import { SOLIDS_ICONS } from '../solids/icons';
import { chamferDef } from './def';
import { ChamferPanel } from './panel';

export const CHAMFER_COMMAND = 'modify.chamfer';

const chamferModule: CadModule = {
  id: 'chamfer',
  features: [chamferDef as unknown as FeatureTypeDef],
  panels: { chamfer: ChamferPanel },
  install(services) {
    return services.commands.register(
      localCommand(services, { id: CHAMFER_COMMAND, type: 'chamfer', label: 'Chamfer', icon: SOLIDS_ICONS.chamfer, order: 12, edges: true, hint: 'Bevel edges of a body by a distance, or two distances (an edge takes its tangent chain; a face, all its edges)' }),
    );
  },
};

export default chamferModule;
