// Sketch mode's module (docs/p2p3-plan.md §3.1, §3.4, §3.5): the Sketch panel
// for the `sketch` feature type (P3-PROFILES builds the type: regions, plane
// resolution; this module edits it), the status chips, "New sketch on ..." in
// the viewport's context menu, and install(): the solver worker client
// (apis.solver, also the rebuild's re-solve), sketch mode (apis.sketch), its
// commands and keys, its overlay layers and pointer tool while it is on.
// Honest UI: with no `sketch` feature type in this build, nothing is registered.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import './sketch.css';
import type { AppServices } from '../types/app';
import type { CadModule, ContextMenuContribution } from '../types/modules';
import type { PickResult } from '../types/selection';
import { ORIGIN_PLANES } from '../types/doc';
import { uiFor } from '../ui/controller';
import { SketchStatusChip } from './chip';
import { registerSketchCommands } from './commands';
import { modeFor, SketchMode } from './mode';
import { attachOverlay } from './overlay';
import { SketchPanel } from './panel';
import { createSolverClient } from './solver-client';
import { makeTool } from './tools';

function contextMenu(services: AppServices, pick: PickResult | null): ContextMenuContribution[] {
  const mode = modeFor(services);
  if (!mode || mode.active || !pick || !services.doc.features.get('sketch')) return [];
  const block = uiFor(services).editBlock();
  const item = pick.item;
  if (item.kind === 'origin' && (item.ref === 'origin:top' || item.ref === 'origin:front' || item.ref === 'origin:right')) {
    const plane = item.ref;
    return [{ id: 'new-sketch', label: `New sketch on ${ORIGIN_PLANES[plane].label}`, disabled: block, run: () => mode.newSketch({ kind: 'plane', plane }) }];
  }
  if (item.kind === 'face') {
    const flat = !!services.viewport.get().handle?.planeNormal(item);
    const { body, index } = item;
    return [
      {
        id: 'new-sketch',
        label: 'New sketch on this face',
        disabled: block ?? (flat ? null : 'Sketches go on flat faces'),
        run: () =>
          void mode.startSketch({ kind: 'pick', body, index }).then((r) => {
            if (r !== true) uiFor(services).fail('New sketch', r);
          }),
      },
    ];
  }
  return [];
}

const sketchModule: CadModule = {
  id: 'sketch-mode',
  panels: { sketch: SketchPanel },
  chips: [SketchStatusChip],
  contextMenu,
  install(services) {
    if (!services.doc.features.get('sketch')) return () => {};
    const solver = createSolverClient({ spawn: (url) => services.bridge.spawnWorker(url) });
    const mode = new SketchMode(services, solver, makeTool);
    mode.onAttach = (handle) => attachOverlay(mode, handle);
    services.apis.set({ sketch: mode, solver });
    const offCommands = registerSketchCommands(services, mode);
    return () => {
      offCommands();
      mode.dispose();
      solver.dispose();
      services.apis.set({ sketch: null, solver: null });
    };
  },
};

export default sketchModule;
