// Sketch mode's Project (P) and Intersect commands (P4b SELECT; kernel API 5's
// project, silhouette and section), and the re-read of every link when a
// sketch is opened.
// Owner: P4b SELECT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import { uiFor } from '../../ui/controller';
import type { SketchMode } from '../mode';
import { refreshLinks } from './tools';
import { sketchCurveTool } from './curve-pick';

/** Outline icons (24 viewBox): a box with an arrow down onto a line (Project); a plane through a box (Intersect). */
export const LINK_ICONS = {
  project: 'M8 3.5h8v6H8z M12 10.5v6 M9.5 14l2.5 2.6 2.5-2.6 M4 20h16',
  intersect: 'M7 4h10v14H7z M3 13l4-2 M17 9l4-2 M3 13l14-4 M7 11.2l10-2.8 M7 15.6l10-2.8',
};

export function registerLinkCommands(services: AppServices, mode: SketchMode): () => void {
  const offs: (() => void)[] = [];
  const ui = uiFor(services);
  const editable = () => ui.editBlock() ?? (mode.active ? true : 'Edit a sketch first');
  const hasBodies = (verb: 'project' | 'intersect') => () => {
    const e = editable();
    if (e !== true) return e;
    return services.doc.state.get().rebuild.bodies.length ? true : `There is no body before this sketch to ${verb}`;
  };
  const reg = (def: CommandDef) => offs.push(services.commands.register(def));

  reg({
    id: 'sketch.project',
    label: 'Project',
    group: 'sketch-modify',
    mode: 'sketch',
    icon: LINK_ICONS.project,
    shortcut: 'P',
    hint: 'Project a vertex, an edge or a face of a body (or its silhouette) onto the sketch, linked to the model',
    // P4b fix round 1 (TOOLBAR, sketch review P1): after the patterns (40-42), together.
    order: 50,
    explainRefusal: true,
    activeWhen: { sketchTool: 'project' },
    enabled: hasBodies('project'),
    run: () => mode.setTool('project'),
  });

  reg({
    id: 'sketch.intersect',
    label: 'Intersect',
    group: 'sketch-modify',
    mode: 'sketch',
    icon: LINK_ICONS.intersect,
    hint: 'The curves where the sketch plane cuts the bodies, linked to the model',
    order: 51,
    explainRefusal: true,
    activeWhen: { sketchTool: 'intersect' },
    enabled: hasBodies('intersect'),
    run: () => mode.setTool('intersect'),
  });

  // Model mode: a shown sketch is picked by its curves (a sketch with no profile too), for its menu's Normal to.
  let popCurve: (() => void) | null = null;
  const attach = (h: ReturnType<typeof services.viewport.get>['handle']) => {
    popCurve?.();
    popCurve = h && typeof h.pushTool === 'function' ? h.pushTool(sketchCurveTool(services)) : null;
  };
  attach(services.viewport.get().handle);
  let seenHandle = services.viewport.get().handle;
  offs.push(
    services.viewport.subscribe((v) => {
      if (v.handle === seenHandle) return;
      seenHandle = v.handle;
      attach(v.handle);
    }),
    () => attach(null),
  );

  // A sketch opened: its links read again (what moved upstream is where it is now).
  offs.push(
    services.bus.on('sketch:mode', (e) => {
      if (e.feature) void refreshLinks(mode);
    }),
  );
  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}
