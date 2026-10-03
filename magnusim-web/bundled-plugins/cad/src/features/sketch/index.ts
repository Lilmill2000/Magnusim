// The sketch feature module (P3-PROFILES, docs/p2p3-plan.md §1.7, §4): the
// `sketch` feature type (plane, geometry, profile regions), the profile
// overlay in both modes, region picking in model mode and the open-profile
// chip. Sketch mode (src/sketch/, P3-SKETCH) gives the sketch's panel, tools
// and commands; without it a Part still builds and shows its sketches.
// Owner: P3-PROFILES.
// SPDX-License-Identifier: GPL-3.0-or-later
import './sketch.css';
import type { AppServices } from '../../types/app';
import type { FeatureTypeDef } from '../../types/doc-service';
import type { CadModule } from '../../types/modules';
import type { ViewportHandle } from '../../types/viewport';
import { sketchDef } from './def';
import { OpenProfileChip } from './OpenProfileChip';
import { ProfileOverlay } from './overlay';
import { regionTool } from './tool';
import { profilesView } from './view';

/** The overlay of the app's current viewport (tests and the Extrude module read it). */
const overlays = new WeakMap<AppServices, ProfileOverlay>();
export function overlayOf(services: AppServices): ProfileOverlay | null {
  return overlays.get(services) ?? null;
}

function install(services: AppServices): () => void {
  let handle: ViewportHandle | null = null;
  let overlay: ProfileOverlay | null = null;
  let popTool: (() => void) | null = null;
  const attach = (next: ViewportHandle | null) => {
    if (next === handle) return;
    popTool?.();
    popTool = null;
    overlay?.dispose();
    overlay = null;
    overlays.delete(services);
    handle = next;
    if (!handle || typeof handle.addLayer !== 'function') return;
    overlay = new ProfileOverlay(services, handle);
    overlays.set(services, overlay);
    popTool = handle.pushTool(regionTool(services));
  };
  attach(services.viewport.get().handle);
  const off = services.viewport.subscribe((s) => attach(s.handle));
  return () => {
    off();
    attach(null);
    profilesView(services).set({ hover: null, used: [], forced: [], ignoreUser: null });
  };
}

const sketchModule: CadModule = {
  id: 'sketch',
  features: [sketchDef as unknown as FeatureTypeDef],
  chips: [OpenProfileChip],
  install,
};

export default sketchModule;
