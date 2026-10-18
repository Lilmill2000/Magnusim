// Parts the edit tools' tests start from, made as the person makes them (one undo step each, on
// the real kernel of the Assistant's harness):
//   plate   parameters w, d, t; a w x d rectangle on Top centred on the origin; Extrude t (Body 1)
//   fillet  a Fillet of every edge of the plate's top face, radius `radius` (an expression)
// SPDX-License-Identifier: GPL-3.0-or-later
import { pickFace } from '../../src/features/p2/refs';
import type { RegionRef } from '../../src/types/doc';
import type { SketchOutput } from '../../src/types/sketch';
import { rectangle, type AssistantHarness } from './harness';

export interface Plate {
  sketch: string;
  extrude: string;
  body: string;
  /** The rectangle's region, as an extrude keeps it. */
  profile: RegionRef;
}

export async function plate(h: AssistantHarness, o: { w?: number; d?: number; t?: number } = {}): Promise<Plate> {
  const w = o.w ?? 60;
  const d = o.d ?? 40;
  const t = o.t ?? 6;
  h.doc.addParam({ name: 'w', expr: `${w} mm`, quantity: 'length' });
  h.doc.addParam({ name: 'd', expr: `${d} mm`, quantity: 'length' });
  h.doc.addParam({ name: 't', expr: `${t} mm`, quantity: 'length' });
  const rect = rectangle(w, d, -w / 2, -d / 2);
  const sketch = await h.add('sketch', { points: rect.points, entities: rect.entities });
  const out = h.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const r = out.regions[0];
  const profile: RegionRef = { sketch, region: r.key, entities: [...r.entities].sort(), sample: r.sample };
  const extrude = await h.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: 't' }, op: 'new' });
  const body = h.doc.state.get().rebuild.bodies[0].id;
  return { sketch, extrude, body, profile };
}

/** A Fillet of the plate's top face (all its edges), radius `radius`. */
export async function fillet(h: AssistantHarness, p: Plate, radius: string): Promise<string> {
  const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === p.body)!;
  const index = b.names!.faces.indexOf(`F:${p.extrude}:end`);
  const picked = await pickFace(h.services, b, index, null);
  if (!picked.ok) throw new Error(picked.reason);
  return h.add('fillet', { body: p.body, edges: [], faces: [picked.ref], radius });
}

/** A feature's state now. */
export const stateOf = (h: AssistantHarness, id: string) => h.doc.state.get().rebuild.features[id]?.state ?? null;

/** The Part's undo label now. */
export const undoLabel = (h: AssistantHarness) => h.doc.state.get().history.undoLabel;
