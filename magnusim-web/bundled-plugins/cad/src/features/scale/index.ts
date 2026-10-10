// SCALE MODELS (ux010, Daniel 2026-10-09: "a banana for scale. it shouldn't be 'counted' as a body
// or have any effect on the simulation, but just be a tool to help people see the scale of things
// they are making ... next to the geometry, always be able to be dragged around, and yellow").
// One command, "Banana for scale", a toggle in the model toolbar's SCALE MODELS group (right after
// VIEW, Toolbar.tsx AFTER_VIEW): pressed while the banana is shown; a click adds it beside the
// bodies (placement.ts), another removes it. The banana itself: view.ts; its mesh, our own model
// made with our own kernel: scripts/make-banana.mjs.
// Owner: TOOLBAR builder (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadModule } from '../../types/modules';
import { loadBanana } from './banana-mesh';
import { placeBeside } from './placement';
import { installSketchBanana, placeTaped, sketchPoints } from './sketch-banana';
import { bodyBoxes, installBananaView } from './view';
import { modeFor } from '../../sketch/mode';

export const BANANA_COMMAND = 'scale.banana';
/** Sketch mode's SCALE MODELS: the taped banana picture in the edited sketch (sketch-banana.ts). */
export const SKETCH_BANANA_COMMAND = 'scale.sketch-banana';

/** A little yellow banana, lying like a smile with its stem up on the right (24 viewBox; drawn filled). */
export const BANANA_ICON = 'M3 11.2C5.5 18 15.5 20.5 20.4 10.4L21.8 5.2L20.6 4.8L19 9.6C15.5 14.6 8 15.4 3 11.2Z';
export const BANANA_ICON_COLORS = { fill: '#F5CF2A', stroke: '#8A6416' };

const module: CadModule = {
  id: 'scale',
  install(services) {
    const offView = installBananaView(services);
    const offSketch = installSketchBanana(services);
    const sketchShown = () => {
      const f = modeFor(services)?.feature;
      return !!f && !!services.doc.state.get().view.scaleModels?.sketch?.[f];
    };
    const offSketchCmd = services.commands.register({
      id: SKETCH_BANANA_COMMAND,
      label: 'Banana for scale',
      group: 'scale',
      mode: 'sketch',
      icon: BANANA_ICON,
      iconColors: BANANA_ICON_COLORS,
      order: 10,
      hint: "Show a banana taped to the sketch's plane at its real size; move it with the Select tool. It's not part of the sketch",
      pressed: sketchShown,
      enabled: () => (modeFor(services)?.feature ? true : 'Edit a sketch first'),
      run: () => {
        const f = modeFor(services)?.feature;
        if (!f) return;
        services.doc.setSketchBanana(f, sketchShown() ? null : placeTaped(sketchPoints(services)));
      },
    });
    const shown = () => !!services.doc.state.get().view.scaleModels?.banana;
    const offCmd = services.commands.register({
      id: BANANA_COMMAND,
      label: 'Banana for scale',
      group: 'scale',
      mode: 'model',
      icon: BANANA_ICON,
      iconColors: BANANA_ICON_COLORS,
      order: 10,
      hint: "Show a banana for scale. It's not part of the model or the simulation",
      pressed: shown,
      enabled: () => (services.doc.state.get().status !== 'ready' ? 'The part is still loading' : true),
      run: async () => {
        if (shown()) {
          services.doc.setScaleModel('banana', null);
          return;
        }
        let mesh;
        try {
          mesh = await loadBanana();
        } catch (err) {
          services.bridge.toast(`The banana could not be shown: ${err instanceof Error ? err.message : String(err)}`, 'error');
          return;
        }
        // Beside the shown bodies (all of them when none is shown); at the origin with none.
        services.doc.setScaleModel('banana', placeBeside(bodyBoxes(services), mesh));
        // Into view when the camera still frames the part as it was framed last.
        requestAnimationFrame(() => requestAnimationFrame(() => services.viewport.get().handle?.refitIfOffScreen?.()));
      },
    });
    return () => {
      offCmd();
      offView();
      offSketchCmd();
      offSketch();
    };
  },
};

export default module;
