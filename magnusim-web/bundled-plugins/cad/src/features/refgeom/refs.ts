// Making stored geometry references from picks (a click in the view, a tree row,
// the selection when a CONSTRUCT command starts): the one re-anchoring point, as
// for faces (src/naming/refs.ts). What a field accepts is checked here with the
// pick's own words ("That face is curved: pick a flat face or a plane"); a
// reference to something made later in the history than the feature being
// edited is refused (it would not be built yet when this feature builds).
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { kernelLookup, splitMerged } from '../../naming';
import type { AppServices } from '../../types/app';
import type { FeatureId, OriginAxisRef, OriginPlaneRef } from '../../types/doc';
import type { GeomRef } from '../../types/references';
import type { SelectionItem } from '../../types/selection';
import { featureOfName, pickFace } from '../p2/refs';
import { constructKind, constructOutput } from './api';
import { pickEdge, pickVertex } from './brep';

/**
 * What a pick field takes:
 *   plane   origin plane, CONSTRUCT plane, flat face
 *   axis    origin axis, CONSTRUCT axis, straight or round edge, cylinder / cone / sphere / torus face (its axis)
 *   point   origin point, CONSTRUCT point, vertex
 *   edge    any edge of a body
 *   curve   any edge of a body, or a line, arc or circle of a sketch (a Sweep path)
 *   round   a cylindrical or conical face (Axis of a cylinder)
 *   center  a round edge (arc, circle) or a spherical face (Point at a centre)
 */
export type Accept = 'plane' | 'axis' | 'point' | 'edge' | 'curve' | 'round' | 'center';

export type PickedRef = { ok: true; ref: GeomRef } | { ok: false; reason: string };

const ORIGIN_PLANES: readonly string[] = ['origin:top', 'origin:front', 'origin:right'];
const ORIGIN_AXES: readonly string[] = ['origin:x', 'origin:y', 'origin:z'];

export const ACCEPT_WORDS: Record<Accept, string> = {
  plane: 'a plane or a flat face',
  axis: 'an axis, a straight or round edge, or a cylindrical face',
  point: 'a point, a vertex or a point of a sketch',
  edge: 'an edge',
  curve: 'an edge or a sketch curve',
  round: 'a cylindrical or conical face',
  center: 'a round edge or a spherical face',
};

const no = (reason: string): PickedRef => ({ ok: false, reason });

/** Feature ids a stored name says made it (each part of a merged name, both faces of an edge, ...). */
function makersOf(name: string): FeatureId[] {
  const out = new Set<FeatureId>();
  const body = name.replace(/^[EV]:/, '');
  for (const part of body.split('&')) for (const p of splitMerged(part)) {
    const f = featureOfName(p);
    if (f) out.add(f);
  }
  return [...out];
}

/** Why `self` cannot use what `makers` made: one of them comes after it in the history (or is it). */
function laterThan(services: AppServices, self: FeatureId | null, makers: readonly FeatureId[]): string | null {
  if (!self) return null;
  const features = services.doc.state.get().doc.features;
  const at = features.findIndex((f) => f.id === self);
  if (at < 0) return null;
  for (const id of makers) {
    if (id === self) return 'That is made by this feature itself';
    const i = features.findIndex((f) => f.id === id);
    if (i > at) return `${features[i].name} comes after ${features[at].name} in the history: move it up, or pick something made before`;
  }
  return null;
}

/** The stored reference for a picked item, if this field takes it; else why not. */
export async function refFromItem(services: AppServices, item: SelectionItem, accept: Accept, self: FeatureId | null): Promise<PickedRef> {
  const wrong = no(`Pick ${ACCEPT_WORDS[accept]}`);
  if (item.kind === 'origin') {
    if (accept === 'plane' && ORIGIN_PLANES.includes(item.ref)) return { ok: true, ref: { kind: 'origin', plane: item.ref as OriginPlaneRef } };
    if (accept === 'axis' && ORIGIN_AXES.includes(item.ref)) return { ok: true, ref: { kind: 'origin', axis: item.ref as OriginAxisRef } };
    if (accept === 'point' && item.ref === 'origin:point') return { ok: true, ref: { kind: 'origin', point: 'origin:point' } };
    return wrong;
  }
  if (item.kind === 'feature') {
    const s = services.doc.state.get();
    const kind = constructKind(s, item.feature);
    const name = s.doc.features.find((f) => f.id === item.feature)?.name ?? 'That feature';
    if (!kind || accept !== kind) return wrong;
    const later = laterThan(services, self, [item.feature]);
    if (later) return no(later);
    if (!constructOutput(s, item.feature)) return no(`${name} is not built: fix it first`);
    return { ok: true, ref: { kind: 'feature', feature: item.feature } };
  }
  if (item.kind === 'sketch') {
    // A point of a sketch drawn in model mode (a line's end, a centre, a point): a point input.
    if (item.what === 'point' && accept === 'point') {
      const s = services.doc.state.get();
      const out = s.rebuild.outputs?.[item.feature];
      if (!out || out.type !== 'sketch' || !out.points[item.id]) return no('That point of the sketch is not built');
      const later = laterThan(services, self, [item.feature]);
      if (later) return no(later);
      return { ok: true, ref: { kind: 'sketch-point', sketch: item.feature, point: item.id } };
    }
    // A curve of a sketch drawn in model mode: a Sweep path's curve (curve), a straight line (axis).
    if (item.what !== 'entity' || (accept !== 'curve' && accept !== 'axis')) return wrong;
    const s = services.doc.state.get();
    const sk = s.doc.features.find((f) => f.id === item.feature);
    const e = sk?.type === 'sketch' ? sk.entities.find((x) => x.id === item.id) : undefined;
    if (!sk || !e || e.kind === 'point') return wrong;
    if (accept === 'axis' && e.kind !== 'line') return no(`That curve is not straight: pick ${ACCEPT_WORDS.axis}`);
    const later = laterThan(services, self, [item.feature]);
    if (later) return no(later);
    return { ok: true, ref: accept === 'axis' ? { kind: 'sketch-line', sketch: item.feature, entity: item.id } : { kind: 'sketch-curve', sketch: item.feature, entity: item.id } };
  }
  if (item.kind !== 'face' && item.kind !== 'edge' && item.kind !== 'vertex') return wrong;
  const body = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
  if (!body) return no('That body is not built');
  if (!body.names) return no(`The faces of ${body.name} have no names, so they cannot be kept by a feature`);
  const lookup = kernelLookup(services.kernel);
  try {
    if (item.kind === 'face') {
      if (accept !== 'plane' && accept !== 'axis' && accept !== 'round' && accept !== 'center') return wrong;
      const [topo] = await lookup.faces(body.shape, [item.index]);
      if (!topo) return no('That face is not there any more');
      const t = topo.type;
      if (accept === 'plane' && t !== 'plane') return no(`That face is curved: pick ${ACCEPT_WORDS.plane}`);
      if (accept === 'axis' && !topo.axis) return no(`That face has no axis (it is ${t === 'plane' ? 'flat' : `a ${t} face`}): pick ${ACCEPT_WORDS.axis}`);
      if (accept === 'round' && t !== 'cylinder' && t !== 'cone') return no(`That face is not a cylinder or a cone: pick ${ACCEPT_WORDS.round}`);
      if (accept === 'center' && t !== 'sphere') return no(`That face is not a sphere: pick ${ACCEPT_WORDS.center}`);
      const r = await pickFace(services, body, item.index, self, lookup);
      if (!r.ok) return no(r.reason);
      const later = laterThan(services, self, makersOf(r.ref.name));
      if (later) return no(later);
      if (accept === 'plane') return { ok: true, ref: { kind: 'face', body: body.id, ref: r.ref } };
      if (accept === 'axis') return { ok: true, ref: { kind: 'face-axis', body: body.id, ref: r.ref } };
      return { ok: true, ref: { kind: 'face', body: body.id, ref: r.ref } };
    }
    if (item.kind === 'edge') {
      if (accept !== 'axis' && accept !== 'edge' && accept !== 'curve' && accept !== 'center') return wrong;
      const [topo] = await lookup.edges!(body.shape, [item.index]);
      if (!topo) return no('That edge is not there any more');
      if (accept === 'axis' && topo.type !== 'line' && topo.type !== 'circle') return no(`That edge is neither straight nor round: pick ${ACCEPT_WORDS.axis}`);
      if (accept === 'center' && topo.type !== 'circle') return no(`That edge is not an arc or a circle: pick ${ACCEPT_WORDS.center}`);
      const ref = await pickEdge(services.kernel, body, item.index);
      const later = laterThan(services, self, makersOf(ref.name));
      if (later) return no(later);
      return { ok: true, ref: { kind: 'edge', body: body.id, ref } };
    }
    if (accept !== 'point') return wrong;
    const ref = await pickVertex(services.kernel, body, item.index);
    const later = laterThan(services, self, makersOf(ref.name));
    if (later) return no(later);
    return { ok: true, ref: { kind: 'vertex', body: body.id, ref } };
  } catch (err) {
    return no(err instanceof Error ? err.message : String(err));
  }
}

/** The selection kinds a field's pick filter lets through in the view. */
export function acceptKinds(accept: Accept): ('face' | 'edge' | 'vertex' | 'origin' | 'feature')[] {
  switch (accept) {
    case 'plane':
      return ['face', 'origin', 'feature'];
    case 'axis':
      return ['edge', 'face', 'feature'];
    case 'point':
      return ['vertex', 'feature'];
    case 'edge':
    case 'curve':
      return ['edge'];
    case 'round':
      return ['face'];
    case 'center':
      return ['edge', 'face'];
  }
}
