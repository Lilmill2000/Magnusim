// The Extrude command (solid.extrude, E). Select first, then act (proposal
// §3.4): the panel opens with the selected profiles, or every profile of a
// selected sketch (Fusion: picking the sketch picks its profiles), or the
// only profile there is; otherwise empty, to pick in the view. Unavailable,
// with the reason, until some sketch has a closed profile or a body exists.
// P4a (Daniel's item 8): one flat face selected opens it with that face as
// the profile (no sketch), as a Join.
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { BodyRef, FeatureId, RegionRef } from '../../types/doc';
import { pickFace } from '../p2/refs';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { drawnSketches, profilesView, sketchOutput } from '../sketch/view';
import { EXTRUDE_ICON } from './def';
import { refOfRegion } from './profiles';
import { userItems } from '../../lib/selection';

export const NO_PROFILES = 'Draw a closed profile in a sketch first';
/** One flat face selected (and nothing else): Extrude takes it as the profile. */
export const FACE_NOT_FLAT = 'the selected face is curved; pick a flat face or a sketch profile';

/** Whether any built sketch (before the rollback bar) has a closed profile. */
export function anyProfiles(services: AppServices): boolean {
  const outs = services.doc.state.get().rebuild.outputs ?? {};
  return Object.values(outs).some((o) => o.type === 'sketch' && o.regions.length > 0);
}

/** The profiles Extrude starts with, from the selection (or the only one there is), or why it cannot start. */
/** The one flat face selected, as the reference Extrude keeps, or why it cannot be taken; null when no face alone is selected. */
export async function preselectedFace(services: AppServices): Promise<{ face: BodyRef } | { refused: string } | null> {
  const items = userItems(services.selection);
  if (items.length !== 1 || items[0].kind !== 'face') return null;
  const item = items[0];
  const h = services.viewport.get().handle;
  if (h && !h.planeNormal(item)) return { refused: FACE_NOT_FLAT };
  const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
  if (!info) return null;
  const r = await pickFace(services, info, item.index, null);
  return r.ok ? { face: { body: r.body, ref: r.ref } } : { refused: r.reason };
}

export function preselectedProfiles(services: AppServices): { profiles: RegionRef[] } | { refused: string } {
  const s = services.doc.state.get();
  const items = userItems(services.selection);
  const regions = items.flatMap((it) => (it.kind === 'region' ? [it] : []));
  if (regions.length) {
    const sketches = new Set(regions.map((r) => r.feature));
    if (sketches.size > 1) return { refused: 'Pick profiles from one sketch' };
    const profiles: RegionRef[] = [];
    for (const it of regions) {
      const r = sketchOutput(s, it.feature)?.regions.find((x) => x.key === it.key);
      if (r) profiles.push(refOfRegion(it.feature, r));
    }
    return { profiles };
  }
  const sketch = items.find((it): it is { kind: 'feature'; feature: FeatureId } => it.kind === 'feature' && s.doc.features.some((f) => f.id === it.feature && f.type === 'sketch'));
  if (sketch) {
    const out = sketchOutput(s, sketch.feature);
    return { profiles: (out?.regions ?? []).map((r) => refOfRegion(sketch.feature, r)) };
  }
  const shown = drawnSketches(s, services.mode.get().mode, profilesView(services).get(), services.doc.features);
  const all = shown.flatMap(({ feature, output }) => output.regions.map((r) => refOfRegion(feature.id, r)));
  return { profiles: all.length === 1 ? all : [] };
}

export function extrudeCommand(services: AppServices): CommandDef {
  const ui = uiFor(services);
  return {
    id: WELL_KNOWN_COMMANDS.extrude,
    label: 'Extrude',
    group: 'solid',
    icon: EXTRUDE_ICON,
    shortcut: 'E',
    order: 30,
    hint: 'A solid from closed profiles of a sketch: pick shaded regions, then set the distance',
    explainRefusal: true,
    activeWhen: { featureType: 'extrude' },
    enabled: () => ui.editBlock() ?? (anyProfiles(services) || services.doc.state.get().rebuild.bodies.length ? true : NO_PROFILES),
    run: () => {
      const p = ui.state.get().panel;
      // The new extrude being edited stays open.
      if (p?.kind === 'feature' && p.isNew && p.type === 'extrude') return;
      const sel = userItems(services.selection);
      // A face picked where a shown sketch's profiles are is about those profiles (a sketch on that face):
      // the face itself is taken only when no shown sketch offers a profile.
      const s = services.doc.state.get();
      const shownProfiles = drawnSketches(s, services.mode.get().mode, profilesView(services).get(), services.doc.features).some((d) => d.output.regions.length > 0);
      if (sel.length === 1 && sel[0].kind === 'face' && !shownProfiles) {
        return preselectedFace(services).then((face) => {
          if (face && 'refused' in face) services.bridge.toast(`Extrude: ${face.refused}`, 'info');
          else if (face) ui.openNew('extrude', { face: face.face, op: 'join', creates: null });
          else ui.openNew('extrude');
        });
      }
      const pre = preselectedProfiles(services);
      if ('refused' in pre) {
        services.bridge.toast(`Extrude: ${pre.refused}`, 'info');
        return;
      }
      ui.openNew('extrude', pre.profiles.length ? { profiles: pre.profiles } : undefined);
    },
  };
}
