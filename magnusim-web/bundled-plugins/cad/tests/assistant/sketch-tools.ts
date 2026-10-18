// Shared pieces of the sketch tool's tests: the tool's input with every field, the Part's state in
// short (feature names, undo label, the open session and panel), and a block made from a sketch the
// tool drew (its faces labelled Base.start, Base.end, Base.side(r.bottom) ...).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect } from 'vitest';
import { refOfRegion } from '../../src/features/extrude/profiles';
import type { SketchFeature } from '../../src/types/doc';
import type { SketchOutput } from '../../src/types/sketch';
import { uiFor } from '../../src/ui/controller';
import type { AssistantHarness } from './harness';

export type Row = Record<string, unknown>;

/** The sketch tool's input: every field, "" / [] / false when unused. */
export const SK = (o: Row = {}): Row => ({ edit: '', name: '', on: 'Top', entities: [], constraints: [], infer: false, ...o });
export const E = (id: string, kind: string, at: number[], construction = false) => ({ id, kind, at, construction });
export const C = (id: string, kind: string, refs: string[], value = '') => ({ id, kind, refs, value });

/** What a refused call must leave as it was: the features, the undo label, no session and no panel. */
export function partNow(h: AssistantHarness) {
  const s = h.doc.state.get();
  return {
    features: s.doc.features.map((f) => f.name),
    undo: s.history.undoLabel,
    session: h.doc.session() !== null,
    panel: uiFor(h.services).state.get().panel !== null,
    mode: h.services.mode.get().mode,
  };
}

/** A feature by name. */
export function featureNamed<T = SketchFeature>(h: AssistantHarness, name: string): T {
  const f = h.doc.state.get().doc.features.find((x) => x.name === name);
  if (!f) throw new Error(`no feature ${name}: ${h.doc.state.get().doc.features.map((x) => x.name).join(', ')}`);
  return f as T;
}

/** A sketch's built output. */
export function outputOf(h: AssistantHarness, name: string): SketchOutput {
  const out = h.doc.state.get().rebuild.outputs[featureNamed(h, name).id] as SketchOutput | undefined;
  if (out?.type !== 'sketch') throw new Error(`${name} did not build`);
  return out;
}

/** A w x d rectangle sketched by the tool on Top, centred and fully defined. */
export function rectInput(name: string, w: number | string, d: number | string, more: Row = {}): Row {
  const W = typeof w === 'number' ? `${w} mm` : w;
  const D = typeof d === 'number' ? `${d} mm` : d;
  return SK({
    name,
    entities: [E('r', 'center_rect', [0, 0, typeof w === 'number' ? w : 60, typeof d === 'number' ? d : 40])],
    constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], W), C('dh', 'distance', ['r.left'], D)],
    ...more,
  });
}

/** A block: the tool's rectangle extruded `t` mm up as "Base" (the person's Extrude panel, one undo step). */
export async function block(h: AssistantHarness, o: { w?: number; d?: number; t?: number } = {}): Promise<{ sketch: string; extrude: string }> {
  const r = await h.call('sketch', rectInput('Base sketch', o.w ?? 60, o.d ?? 40));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const sketch = featureNamed(h, 'Base sketch').id;
  const region = outputOf(h, 'Base sketch').regions[0];
  const extrude = await h.add('extrude', { name: 'Base', profiles: [refOfRegion(sketch, region)], extent: { kind: 'blind', distance: `${o.t ?? 10} mm` }, op: 'new' });
  return { sketch, extrude };
}
