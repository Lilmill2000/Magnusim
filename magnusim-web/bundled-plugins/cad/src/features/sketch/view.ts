// Which sketches the viewport draws, and the profile overlay's shared state.
// Model mode: a built sketch is drawn while it is shown (the tree's eye:
// CadView.sketches), and with no choice until a later feature uses it
// (Fusion); the open Extrude panel also draws the sketch its profiles come
// from, and does not count as a user while it picks. Sketch mode: only the
// sketch being edited (its region shading; sketch mode draws its geometry).
// Owner: P3-PROFILES (src/features/sketch/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { Mode } from '../../types/commands';
import type { CadDoc, CadView, Feature, FeatureId, SketchFeature } from '../../types/doc';
import type { DocState, FeatureRegistry } from '../../types/doc-service';
import type { SketchOutput } from '../../types/sketch';
import type { StateStore } from '../../types/state';

/** A region by its sketch and key (hover, highlight). */
export interface RegionKey {
  feature: FeatureId;
  key: string;
}

export interface ProfilesViewState {
  /** The region under the pointer (pre-highlight), or null. */
  hover: RegionKey | null;
  /** Regions drawn as picked although they are not in the selection (the open Extrude panel's profiles). */
  used: RegionKey[];
  /** Sketches drawn although hidden (the open Extrude panel's sketch). */
  forced: FeatureId[];
  /** A feature that does not count as a user of sketches (the Extrude being edited picks from them). */
  ignoreUser: FeatureId | null;
}

const views = new WeakMap<AppServices, StateStore<ProfilesViewState>>();

/** The profile overlay's state for these services (one per app). */
export function profilesView(services: AppServices): StateStore<ProfilesViewState> {
  let s = views.get(services);
  if (!s) {
    s = createStateStore<ProfilesViewState>({ hover: null, used: [], forced: [], ignoreUser: null });
    views.set(services, s);
  }
  return s;
}

/** Whether any feature but `ignore` uses sketch `id` (its parents name it). */
export function sketchUsed(doc: Pick<CadDoc, 'features'>, registry: Pick<FeatureRegistry, 'get'>, id: FeatureId, ignore: FeatureId | null = null): boolean {
  return doc.features.some((g) => g.id !== id && g.id !== ignore && (registry.get(g.type)?.parents(g) ?? []).includes(id));
}

/** Whether a sketch is shown in model mode (the eye in the tree). */
export function sketchShown(doc: Pick<CadDoc, 'features'>, view: Pick<CadView, 'sketches'>, registry: Pick<FeatureRegistry, 'get'>, id: FeatureId, ignore: FeatureId | null = null): boolean {
  const choice = view.sketches?.[id];
  if (choice === 'shown') return true;
  if (choice === 'hidden') return false;
  return !sketchUsed(doc, registry, id, ignore);
}

/** A built sketch's output (null when it did not build: failed, suppressed, rolled back). */
export function sketchOutput(s: Pick<DocState, 'rebuild'>, id: FeatureId): SketchOutput | null {
  const out = s.rebuild.outputs?.[id];
  return out && out.type === 'sketch' ? out : null;
}

export const isSketch = (f: Feature): f is SketchFeature => f.type === 'sketch';

/** The sketch being edited (sketch mode, or any open panel session on a sketch), or null. */
export function editedSketch(s: Pick<DocState, 'session' | 'doc'>): SketchFeature | null {
  const id = s.session?.feature;
  if (!id) return null;
  const f = s.doc.features.find((g) => g.id === id);
  return f && isSketch(f) ? f : null;
}

/** The sketches the viewport draws now, in history order. */
export function drawnSketches(s: Pick<DocState, 'doc' | 'view' | 'rebuild' | 'session'>, mode: Mode, v: Pick<ProfilesViewState, 'forced' | 'ignoreUser'>, registry: Pick<FeatureRegistry, 'get'>): { feature: SketchFeature; output: SketchOutput }[] {
  const edited = editedSketch(s);
  if (mode === 'sketch' || edited) {
    // Sketch mode (or a sketch's panel open before sketch mode turns on): only the edited sketch, shaded.
    const out = edited ? sketchOutput(s, edited.id) : null;
    return edited && out ? [{ feature: edited, output: out }] : [];
  }
  const outs: { feature: SketchFeature; output: SketchOutput }[] = [];
  for (const f of s.doc.features) {
    if (!isSketch(f)) continue;
    const out = sketchOutput(s, f.id);
    if (!out) continue;
    if (v.forced.includes(f.id) || sketchShown(s.doc, s.view, registry, f.id, v.ignoreUser)) outs.push({ feature: f, output: out });
  }
  return outs;
}
