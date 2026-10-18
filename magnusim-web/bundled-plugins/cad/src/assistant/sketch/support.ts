// Where a sketch of the sketch tool lies (CAD tools spec §6.2), checked before anything changes:
//   Top, Front, Right (XY, XZ, YZ)   an origin plane
//   a construction plane's name      that plane, built
//   one flat face ("Base.end")       the face's stored reference (the person's pick rules), its frame
//                                    the one sketch mode gives (u along model X projected; v = n x u)
//   "<plane or face> offset <length> [flip]"
//                                    a construction plane made in the same step ("<sketch> plane"),
//                                    or an identical one the Part has (a mirror's too: both tools
//                                    use offsetPlaneLike); editing a sketch whose own
//                                    plane only it uses moves that plane instead
//   "" with edit                     where it lies now
// The selectors read the shown bodies for a new sketch, and the bodies before the sketch for an edit.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dependencies } from '../../doc/features/hooks';
import type { CallCtx } from '../../types/assistant';
import type { Feature, FeatureId, PlaneFrame, RefPlaneFeature, SketchFeature, SketchSupport } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { PlaneRef } from '../../types/references';
import { ToolError } from '../errors';
import { runtimeOf } from '../runtime';
import { planeRefOf } from '../selectors/refs';
import { selectOne, withScene, type PlaneHit } from '../selectors/resolve';
import { storeExpr } from './compile';

export type SupportPlan =
  | { kind: 'keep'; words: string; warnings: string[] }
  | { kind: 'direct'; support: SketchSupport; frame: PlaneFrame; words: string; warnings: string[] }
  | {
      kind: 'offset';
      /** The plane it is offset from, as a construction plane keeps it. */
      plane: PlaneRef;
      distance: string;
      flip: boolean;
      frame: PlaneFrame;
      words: string;
      warnings: string[];
      /** An identical construction plane the Part has: the sketch goes on it. */
      reuse: FeatureId | null;
      /** The edited sketch's own plane, moved to the new offset. */
      update: FeatureId | null;
      /** The new plane's name ("Plate sketch plane"). */
      planeName: string;
    };

const samePlaneRef = (a: PlaneRef | null, b: PlaneRef): boolean => {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'origin' && b.kind === 'origin') return a.plane === b.plane;
  if (a.kind === 'feature' && b.kind === 'feature') return a.feature === b.feature;
  if (a.kind === 'face' && b.kind === 'face') return a.body === b.body && a.ref.name === b.ref.name;
  return false;
};

const sameExpr = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

const isOffsetPlane = (f: Feature): f is RefPlaneFeature => f.type === 'ref_plane' && (f as RefPlaneFeature).method === 'offset';

/** A built construction plane `distance` (as storeExpr stores it) from `base`, flipped as asked,
 *  among the Part's first `limit` features, or null. The sketch tool and a mirror both look here,
 *  so one "<plane> offset <length>" is one plane whichever tool made it. */
export function offsetPlaneLike(s: DocState, o: { base: PlaneRef; distance: string; flip: boolean }, limit: number): RefPlaneFeature | null {
  for (const f of s.doc.features.slice(0, Math.max(0, limit))) {
    if (!isOffsetPlane(f) || f.suppressed || !!f.flip !== o.flip) continue;
    if (samePlaneRef(f.plane, o.base) && sameExpr(f.distance, o.distance) && s.rebuild.outputs[f.id]?.type === 'plane') return f;
  }
  return null;
}

/** A name not taken by a feature (any case): `want`, else "<want> 2", ... */
function freeName(names: readonly string[], want: string): string {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (let k = 1; ; k++) {
    const name = k === 1 ? want : `${want} ${k}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Where the sketch goes, from `on` (a plane selector), before anything changes. */
export async function planSupport(ctx: CallCtx, on: string, o: { edit: SketchFeature | null; sketchName: string }): Promise<SupportPlan> {
  const { services } = ctx;
  const text = on.trim();
  if (!text) {
    if (o.edit) return { kind: 'keep', words: 'where it lies now', warnings: [] };
    throw new ToolError('bad_input', 'on: Top, Front, Right, "<plane> offset <length>", a construction plane or one flat face.', { detail: { field: 'on' } });
  }
  const edit = o.edit;
  return withScene(ctx, { before: edit?.id ?? null, self: edit?.id ?? null }, async (sc) => {
    const { hit } = (await selectOne(sc, text, 'plane', 'on')) as { hit: PlaneHit };
    const s = sc.state;
    const warnings = [...hit.warnings];
    if (!hit.offset) {
      const src = hit.source;
      if (src.s === 'origin') return { kind: 'direct', support: { kind: 'plane', plane: src.plane }, frame: hit.frame, words: hit.words, warnings };
      // The person's rules: nothing made later (or by this sketch), a named face.
      const ref = await planeRefOf(sc, hit);
      if (ref.kind === 'feature') return { kind: 'direct', support: { kind: 'feature', feature: ref.feature }, frame: hit.frame, words: hit.words, warnings };
      if (ref.kind === 'face') return { kind: 'direct', support: { kind: 'face', body: ref.body, face: ref.ref }, frame: hit.base, words: hit.words, warnings };
      return { kind: 'direct', support: { kind: 'plane', plane: ref.plane }, frame: hit.frame, words: hit.words, warnings };
    }
    const plane = await planeRefOf(sc, hit);
    const distance = storeExpr(hit.offset.expr, 'length', services.doc.units);
    const flip = hit.flip;
    const features = s.doc.features;
    const at = edit ? features.findIndex((f) => f.id === edit.id) : features.length;
    // The edited sketch's own plane (made by the Assistant for it, used by nothing else) moves.
    let update: FeatureId | null = null;
    if (edit && edit.support.kind === 'feature') {
      const own = features.find((f) => f.id === (edit.support as { feature: FeatureId }).feature);
      const others = features.filter((g) => g.id !== edit.id && g.id !== own?.id && dependencies(services.doc.features, s.doc, g).includes(own?.id ?? ''));
      if (own && isOffsetPlane(own) && runtimeOf(services)?.madeBy.has(own.id) && samePlaneRef(own.plane, plane) && !others.length) {
        if (sameExpr(own.distance, distance) && !!own.flip === flip) return { kind: 'offset', plane, distance, flip, frame: hit.frame, words: hit.words, warnings, reuse: own.id, update: null, planeName: own.name };
        update = own.id;
      }
    }
    if (!update) {
      const same = offsetPlaneLike(s, { base: plane, distance, flip }, at);
      if (same) return { kind: 'offset', plane, distance, flip, frame: hit.frame, words: hit.words, warnings, reuse: same.id, update: null, planeName: same.name };
    }
    const planeName = update ? (features.find((f) => f.id === update)?.name ?? `${o.sketchName} plane`) : freeName(features.map((f) => f.name), `${o.sketchName} plane`);
    return { kind: 'offset', plane, distance, flip, frame: hit.frame, words: hit.words, warnings, reuse: null, update, planeName };
  });
}
