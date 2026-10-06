// The extrude module (P3-PROFILES, docs/p2p3-plan.md §1.8): the `extrude`
// feature type, its panel (profiles, extent, flip, Operation; the distance
// arrow in the view), the Extrude command (E) and "Extrude" on selected
// profiles in the viewport's context menu.
// Owner: P3-PROFILES.
// SPDX-License-Identifier: GPL-3.0-or-later
import './extrude.css';
import type { AppServices } from '../../types/app';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { extrudeCommand } from './command';
import { extrudeDef } from './def';
import { ExtrudePanel } from './ExtrudePanel';

const extrudeModule: CadModule = {
  id: 'extrude',
  features: [extrudeDef as unknown as FeatureTypeDef],
  panels: { extrude: ExtrudePanel },
  contextMenu(services: AppServices, pick) {
    const regions = services.selection.get().items.filter((it) => it.kind === 'region');
    // P4a: "Extrude face" on a flat face of a body (no sketch needed).
    if (!regions.length && pick?.item.kind === 'face') {
      const h = services.viewport.get().handle;
      const flat = !h || !!h.planeNormal(pick.item);
      const block = uiFor(services).editBlock();
      return [{ id: 'extrude-face', label: 'Extrude face', disabled: block ?? (flat ? null : 'Extrude takes a flat face: this face is curved'), run: () => void services.commands.run(WELL_KNOWN_COMMANDS.extrude) }];
    }
    if (!regions.length) return [];
    const can = services.commands.canRun(WELL_KNOWN_COMMANDS.extrude);
    return [{ id: 'extrude', label: regions.length === 1 ? 'Extrude profile' : `Extrude ${regions.length} profiles`, disabled: can === true ? null : can, run: () => void services.commands.run(WELL_KNOWN_COMMANDS.extrude) }];
  },
  install(services: AppServices) {
    return services.commands.register(extrudeCommand(services));
  },
};

export default extrudeModule;
