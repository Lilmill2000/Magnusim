// The Extrude command (solid.extrude, E). Select first, then act (proposal
// §3.4): the panel opens with the selected profiles, or every profile of a
// selected sketch (Fusion: picking the sketch picks its profiles), or the
// only profile there is; otherwise empty, to pick in the view. Unavailable,
// with the reason, until some sketch has a closed profile.
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { FeatureId, RegionRef } from '../../types/doc';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { drawnSketches, profilesView, sketchOutput } from '../sketch/view';
import { EXTRUDE_ICON } from './def';
import { refOfRegion } from './profiles';

export const NO_PROFILES = 'Draw a closed profile in a sketch first';

/** Whether any built sketch (before the rollback bar) has a closed profile. */
export function anyProfiles(services: AppServices): boolean {
  const outs = services.doc.state.get().rebuild.outputs ?? {};
  return Object.values(outs).some((o) => o.type === 'sketch' && o.regions.length > 0);
}

/** The profiles Extrude starts with, from the selection (or the only one there is), or why it cannot start. */
export function preselectedProfiles(services: AppServices): { profiles: RegionRef[] } | { refused: string } {
  const s = services.doc.state.get();
  const items = services.selection.get().items;
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
    enabled: () => ui.editBlock() ?? (anyProfiles(services) ? true : NO_PROFILES),
    run: () => {
      const p = ui.state.get().panel;
      // The new extrude being edited stays open.
      if (p?.kind === 'feature' && p.isNew && p.type === 'extrude') return;
      const pre = preselectedProfiles(services);
      if ('refused' in pre) {
        services.bridge.toast(`Extrude: ${pre.refused}`, 'info');
        return;
      }
      ui.openNew('extrude', pre.profiles.length ? { profiles: pre.profiles } : undefined);
    },
  };
}
