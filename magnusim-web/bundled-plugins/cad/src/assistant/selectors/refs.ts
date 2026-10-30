// From what a selector named to what a feature keeps (CAD tools spec §5.4 rule 6), by the rules
// the person's own picks follow, with their words:
//   faces              pickFace (features/p2/refs.ts): a body with no face names, and a face the
//                      feature being made or edited made itself, are refused
//   edges, vertices    refOfEdge / refOfVertex (naming/edges.ts)
//   planes, axes       the GeomRef a CONSTRUCT field keeps (features/refgeom/refs.ts refFromItem's
//                      kinds), refusing what this feature or a later one made
//   sketch lines       {kind: 'sketch-line'}; origins {kind: 'origin'}
//   regions            refOfRegion (features/extrude/profiles.ts)
// The references are made on the scene's bodies (the bodies before the feature for an edit), from
// the selectors' topo cache: the same calls and options as a pick.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { featureOfName, pickFace } from '../../features/p2/refs';
import { refOfEdge, refOfVertex } from '../../naming/edges';
import { splitMerged } from '../../naming/names';
import type { BodyId, BodyRef, FeatureId, PersistentRef, RegionRef } from '../../types/doc';
import type { BodyInfo } from '../../types/kernel';
import type { AxisRef, PlaneRef } from '../../types/references';
import { ToolError } from '../errors';
import type { AxisHit, EdgeHit, FaceHit, Hit, PlaneHit, RegionHit, Scene, VertexHit } from './resolve';
import { faceLabel, hitWords } from './resolve';

/** The features a stored name says made it (every part of a merged name, both faces of an edge). */
function makersOf(name: string): FeatureId[] {
  const out = new Set<FeatureId>();
  for (const part of name.replace(/^[EV]:/, '').split('&')) for (const p of splitMerged(part)) {
    const f = featureOfName(p);
    if (f) out.add(f);
  }
  return [...out];
}

/** Why `self` cannot keep what `makers` made (refgeom's rule): this feature made it, or a later one did. */
function laterThan(sc: Scene, makers: readonly FeatureId[]): ToolError | null {
  const self = sc.self;
  if (!self) return null;
  const features = sc.state.doc.features;
  const at = features.findIndex((f) => f.id === self);
  if (at < 0) return null;
  for (const id of makers) {
    if (id === self) return new ToolError('self_reference', 'That is made by this feature itself.', { detail: { feature: features[at].name } });
    const i = features.findIndex((f) => f.id === id);
    if (i > at) return new ToolError('later_feature', `${features[i].name} comes after ${features[at].name} in the history: pick something made before it.`, { detail: { feature: features[i].name } });
  }
  return null;
}

const unnamed = (sc: Scene, body: { name: string }) => new ToolError('not_named', `The faces of ${body.name} have no names, so a feature cannot keep them.`, { detail: { body: body.name } });

/** A face a feature keeps: {body, ref}. */
export async function faceRefOf(sc: Scene, h: FaceHit): Promise<{ body: BodyId; ref: PersistentRef }> {
  if (!h.body.names) throw unnamed(sc, h.body);
  // Its placement too: the reference keeps where Move/copy body features had taken the body.
  const r = await pickFace(sc.services, { id: h.body.id, name: h.body.name, shape: h.body.shape, names: h.body.names, placement: h.body.placement } as BodyInfo, h.index, sc.self, sc.cache.lookup);
  if (!r.ok) {
    if (/made by this feature itself/.test(r.reason)) throw new ToolError('self_reference', `${faceLabel(sc, h) ?? hitWords(sc, h)}: ${r.reason}.`, { detail: { face: faceLabel(sc, h) ?? hitWords(sc, h) } });
    throw new ToolError('not_named', r.reason, { detail: { body: h.body.name } });
  }
  const later = laterThan(sc, makersOf(r.ref.name));
  if (later) throw later;
  return { body: r.body, ref: r.ref };
}

/** An edge a feature keeps. */
export async function edgeRefOf(sc: Scene, h: EdgeHit): Promise<{ body: BodyId; ref: PersistentRef }> {
  if (!h.body.names) throw unnamed(sc, h.body);
  let ref: PersistentRef;
  try {
    ref = await refOfEdge(sc.cache.lookup, h.body, h.index);
  } catch (e) {
    throw new ToolError('not_named', `${hitWords(sc, h)}: ${e instanceof Error ? e.message : String(e)}.`, { detail: { body: h.body.name } });
  }
  const later = laterThan(sc, makersOf(ref.name));
  if (later) throw later;
  return { body: h.body.id, ref };
}

/** A vertex a feature keeps. */
export async function vertexRefOf(sc: Scene, h: VertexHit): Promise<{ body: BodyId; ref: PersistentRef }> {
  if (!h.body.names) throw unnamed(sc, h.body);
  let ref: PersistentRef;
  try {
    ref = await refOfVertex(sc.cache.lookup, h.body, h.index);
  } catch (e) {
    throw new ToolError('not_named', `${hitWords(sc, h)}: ${e instanceof Error ? e.message : String(e)}.`, { detail: { body: h.body.name } });
  }
  const later = laterThan(sc, makersOf(ref.name));
  if (later) throw later;
  return { body: h.body.id, ref };
}

/** A face or vertex an extent goes up to (Extrude "to"): a BodyRef. */
export async function targetRefOf(sc: Scene, h: Hit): Promise<BodyRef> {
  if (h.kind === 'face') return faceRefOf(sc, h);
  if (h.kind === 'vertex') return vertexRefOf(sc, h);
  throw new ToolError('bad_selector', `${hitWords(sc, h)} is ${h.kind === 'edge' ? 'an edge' : `a ${h.kind}`}: this field takes one face or one vertex.`);
}

/** A plane a feature keeps (a mirror's plane, a construction plane's base). The offset, if any, is the caller's (PlaneHit.offset). */
export async function planeRefOf(sc: Scene, h: PlaneHit): Promise<PlaneRef> {
  const s = h.source;
  if (s.s === 'origin') return { kind: 'origin', plane: s.plane };
  if (s.s === 'feature') {
    const later = laterThan(sc, [s.feature.id]);
    if (later) throw later;
    return { kind: 'feature', feature: s.feature.id };
  }
  const r = await faceRefOf(sc, s.face);
  return { kind: 'face', body: r.body, ref: r.ref };
}

/** An axis a feature keeps (a revolve's axis, a pattern's direction). */
export async function axisRefOf(sc: Scene, h: AxisHit): Promise<AxisRef> {
  const s = h.source;
  switch (s.s) {
    case 'origin':
      return { kind: 'origin', axis: s.axis };
    case 'feature': {
      const later = laterThan(sc, [s.feature.id]);
      if (later) throw later;
      return { kind: 'feature', feature: s.feature.id };
    }
    case 'sketch-line': {
      const later = laterThan(sc, [s.sketch.id]);
      if (later) throw later;
      return { kind: 'sketch-line', sketch: s.sketch.id, entity: s.entity };
    }
    case 'edge': {
      const r = await edgeRefOf(sc, s.edge);
      return { kind: 'edge', body: r.body, ref: r.ref };
    }
    case 'face-axis': {
      const r = await faceRefOf(sc, s.face);
      return { kind: 'face-axis', body: r.body, ref: r.ref };
    }
    case 'normal':
      return { kind: 'normal', plane: await planeRefOf(sc, s.plane) };
  }
}

/** A region an extrude, revolve or sweep keeps. */
export function regionRefOf(sc: Scene, h: RegionHit): RegionRef {
  const later = laterThan(sc, [h.sketch.id]);
  if (later) throw later;
  return h.ref;
}
