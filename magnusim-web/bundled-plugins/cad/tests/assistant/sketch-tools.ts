// Shared pieces of the sketch tool's tests: the tool's input with every field, the Part's state in
// short (feature names, undo label, the open session and panel), a block made from a sketch the
// tool drew (its faces labelled Base.start, Base.end, Base.side(r.bottom) ...), a sketch's regions
// in full, and a 96-tooth wheel as the model draws one (many small regions of one size).
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

/** A sketch's regions in full (get_model feature <name> regions full): each with its place, depth, box and bounds. */
export async function fullRegions(h: AssistantHarness, name: string): Promise<Row[]> {
  const r = await h.ok('get_model', { detail: 'brief', feature: name, regions: 'full' });
  return (r.data.feature as Row).regions as Row[];
}

const polar = (r: number, deg: number) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)].map((x) => Number(x.toFixed(4)));

/**
 * A 96-tooth wheel on Top as a model draws a clock's great wheel, every point fixed: the tip
 * circle (r 31.5), a bore (r 5), four spoke windows (a sector, patterned), and one tooth gap (a
 * closed 4-sided polyline across the tip circle, patterned 96 times). 198 regions: r1 the wheel
 * with its teeth (largest), r2..r5 the windows, r6 the bore, r7..r102 the gaps inside the tip
 * circle, r103..r198 their ends outside it.
 */
export function gearInput(name = 'Gear sketch'): Row {
  const gap = [polar(29, -0.9), polar(33, -1.3), polar(33, 1.3), polar(29, 0.9), polar(29, -0.9)].flat();
  return SK({
    name,
    entities: [E('o', 'circle', [0, 0, 31.5]), E('b', 'circle', [0, 0, 5]), E('w', 'sector', [0, 0, 10, 22, 10, 80]), E('g', 'polyline', gap)],
    constraints: [
      C('fo', 'fix', ['o']),
      C('fb', 'fix', ['b']),
      C('fw', 'fix', ['w.inner']),
      C('fv', 'fix', ['w.outer']),
      ...[0, 1, 2, 3].map((k) => C(`f${k}`, 'fix', [`g.p${k}`])),
      C('pw', 'circular_pattern', ['origin', 'w'], 'count 4'),
      C('pg', 'circular_pattern', ['origin', 'g'], 'count 96'),
    ],
  });
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
