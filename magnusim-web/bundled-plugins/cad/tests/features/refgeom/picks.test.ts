// Picks as stored references (refs.ts) and the Sketch command's support (sketch/commands.ts)
// for CONSTRUCT items: origin planes and axes, a reference Plane / Axis / Point selected as a
// feature, refusals in the field's words, and a feature later in the history refused.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { constructOf } from '../../../src/features/refgeom/api';
import { planeInit, axisInit } from '../../../src/features/refgeom/index';
import { refFromItem } from '../../../src/features/refgeom/refs';
import { refBodies, refParents, refWords, resolveAxis } from '../../../src/features/refgeom/resolve';
import { supportFromSelection } from '../../../src/sketch/commands';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices } from '../../../src/types/app';
import type { SketchFeature } from '../../../src/types/doc';

function services(extra: { outputs?: Record<string, unknown> } = {}) {
  const features = [
    { id: 'f_p1', type: 'ref_plane', name: 'Plane 1' },
    { id: 'f_a1', type: 'ref_axis', name: 'Axis 1' },
    { id: 'f_q1', type: 'ref_point', name: 'Point 1' },
    { id: 'f_p2', type: 'ref_plane', name: 'Plane 2' },
    { id: 'f_sk', type: 'sketch', name: 'Sketch 1', entities: [] },
  ];
  const outputs = extra.outputs ?? {
    f_p1: { type: 'plane', frame: { origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] } },
    f_a1: { type: 'axis', origin: [0, 0, 0], dir: [0, 0, 1] },
    f_q1: { type: 'point', p: [1, 2, 3] },
  };
  const state = createStateStore({ doc: { features }, rebuild: { outputs, bodies: [] }, view: {} });
  return {
    doc: { state, editable: () => true },
    selection: createStateStore({ items: [], filter: [] }),
    viewport: createStateStore({ handle: null }),
  } as unknown as AppServices;
}

describe('picks as references', () => {
  it('origin planes and axes, and reference features of the right kind', async () => {
    const s = services();
    expect(await refFromItem(s, { kind: 'origin', ref: 'origin:top' }, 'plane', null)).toEqual({ ok: true, ref: { kind: 'origin', plane: 'origin:top' } });
    expect(await refFromItem(s, { kind: 'origin', ref: 'origin:top' }, 'axis', null)).toEqual({ ok: false, reason: 'Pick an axis, a straight or round edge, or a cylindrical face' });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_p1' }, 'plane', null)).toEqual({ ok: true, ref: { kind: 'feature', feature: 'f_p1' } });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_a1' }, 'axis', null)).toEqual({ ok: true, ref: { kind: 'feature', feature: 'f_a1' } });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_q1' }, 'point', null)).toEqual({ ok: true, ref: { kind: 'feature', feature: 'f_q1' } });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_q1' }, 'plane', null)).toEqual({ ok: false, reason: 'Pick a plane or a flat face' });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_sk' }, 'plane', null)).toEqual({ ok: false, reason: 'Pick a plane or a flat face' });
  });

  it('refuses itself, a feature after it, and one that did not build', async () => {
    const s = services();
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_p1' }, 'plane', 'f_p1')).toEqual({ ok: false, reason: 'That is made by this feature itself' });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_p2' }, 'plane', 'f_p1')).toEqual({ ok: false, reason: 'Plane 2 comes after Plane 1 in the history: move it up, or pick something made before' });
    expect(await refFromItem(s, { kind: 'feature', feature: 'f_p2' }, 'plane', null)).toEqual({ ok: false, reason: 'Plane 2 is not built: fix it first' });
  });

  it('words for every kind of reference', () => {
    const names: Record<string, string> = { f_p1: 'Plane 1', f_sk: 'Sketch 1', f_x: 'Extrude 1' };
    const fn = (id: string) => names[id] ?? null;
    expect(refWords({ kind: 'origin', plane: 'origin:front' }, fn)).toBe('Front plane');
    expect(refWords({ kind: 'origin', axis: 'origin:z' }, fn)).toBe('Z axis');
    expect(refWords({ kind: 'origin', point: 'origin:point' }, fn)).toBe('Origin');
    expect(refWords({ kind: 'feature', feature: 'f_p1' }, fn)).toBe('Plane 1');
    expect(refWords({ kind: 'feature', feature: 'f_gone' }, fn)).toBe('A deleted feature');
    expect(refWords({ kind: 'face', body: 'b_1', ref: { name: 'F:f_x:end', signature: { kind: 'face', type: 'plane', at: [0, 0, 0] } } }, fn)).toBe('End face of Extrude 1');
    expect(refWords({ kind: 'sketch-line', sketch: 'f_sk', entity: 'e_1' }, fn)).toBe('Line of Sketch 1');
    // P4a integration: Extrude "Along" a plane (its normal); a sketch point as a point input.
    expect(refWords({ kind: 'normal', plane: { kind: 'feature', feature: 'f_p1' } }, fn)).toBe('Normal to Plane 1');
    expect(refWords({ kind: 'normal', plane: { kind: 'origin', plane: 'origin:top' } }, fn)).toBe('Normal to Top plane');
    expect(refWords({ kind: 'sketch-point', sketch: 'f_sk', point: 'p1' }, fn)).toBe('A point of Sketch 1');
    // P4a review: a sketch point says which one, by the curves that meet there; a side has its number.
    const sk = {
      id: 'f_sk',
      type: 'sketch',
      name: 'Sketch 1',
      points: { p1: [0, 0], p2: [10, 0], p3: [10, 10], c: [5, 5] },
      entities: [
        { id: 'l1', kind: 'line', p: ['p1', 'p2'] },
        { id: 'l2', kind: 'line', p: ['p2', 'p3'] },
        { id: 'k1', kind: 'circle', c: 'c', r: 2 },
      ],
    } as unknown as SketchFeature;
    const of = () => sk;
    expect(refWords({ kind: 'sketch-point', sketch: 'f_sk', point: 'p2' }, fn, undefined, of)).toBe('Corner of Line 1 and Line 2 of Sketch 1');
    expect(refWords({ kind: 'sketch-point', sketch: 'f_sk', point: 'p1' }, fn, undefined, of)).toBe('End of Line 1 of Sketch 1');
    expect(refWords({ kind: 'sketch-point', sketch: 'f_sk', point: 'c' }, fn, undefined, of)).toBe('Centre of Circle 1 of Sketch 1');
    const faces = ['F:f_x:end', 'F:f_x:side:e_9zz[p:a>p:b]', 'F:f_x:side:e_6cctu2upm20i[p:b>p:c]'];
    const side = { kind: 'face' as const, body: 'b_1', ref: { name: 'F:f_x:side:e_9zz[p:a>p:b]', signature: { kind: 'face' as const, type: 'plane', at: [0, 0, 0] as [number, number, number] } } };
    expect(refWords(side, fn, undefined, undefined, () => faces)).toBe('Side 2 of Extrude 1');
    expect(refWords(side, fn)).not.toMatch(/e_|pt_/);
    // An import's face is named as Measure and Delete faces name it: its number on the body shown (P4a review).
    const imp = { kind: 'face' as const, body: 'b_9', ref: { name: 'F:f_imp:import:0:7', signature: { kind: 'face' as const, type: 'plane', at: [0, 0, 0] as [number, number, number] } } };
    const flangeFaces = ['F:f_imp:import:0:0', 'F:f_imp:import:0:3', 'F:f_imp:import:0:5', 'F:f_imp:import:0:7'];
    expect(refWords(imp, (id) => (id === 'f_imp' ? 'Imported 1 (flange.step)' : null), () => 'flange', undefined, () => flangeFaces)).toBe('Face 4 of flange');
  });

  it('P4a integration: a plane normal resolves to an axis through the origin of the plane; its parents and bodies are those of the plane', async () => {
    const outputs = new Map<string, unknown>([['f_p1', { type: 'plane', frame: { origin: [0, 0, 20], normal: [0, 0, 2], xdir: [1, 0, 0] } }]]);
    const ctx = { outputs, doc: { features: [{ id: 'f_p1', type: 'ref_plane', name: 'Plane 1' }] }, bodies: new Map(), featureName: (id: string) => (id === 'f_p1' ? 'Plane 1' : id), bodyName: () => 'Body 1' } as never;
    expect(await resolveAxis({ kind: 'normal', plane: { kind: 'feature', feature: 'f_p1' } }, ctx)).toEqual({ ok: true, value: { origin: [0, 0, 20], dir: [0, 0, 1] } });
    expect(await resolveAxis({ kind: 'normal', plane: { kind: 'origin', plane: 'origin:front' } }, ctx)).toEqual({ ok: true, value: { origin: [0, 0, 0], dir: [0, -1, 0] } });
    expect(await resolveAxis({ kind: 'normal', plane: { kind: 'feature', feature: 'f_gone' } }, ctx)).toEqual({ ok: false, message: 'it uses a feature that was deleted' });
    const face = { kind: 'face' as const, body: 'b_1', ref: { name: 'F:f_x:end', signature: { kind: 'face' as const, type: 'plane', at: [0, 0, 0] as [number, number, number] } } };
    expect(refParents([{ kind: 'normal', plane: { kind: 'feature', feature: 'f_p1' } }])).toEqual(['f_p1']);
    expect(refBodies([{ kind: 'normal', plane: face }])).toEqual(['b_1']);
    expect(refBodies([{ kind: 'normal', plane: { kind: 'feature', feature: 'f_p1' } }])).toEqual([]);
  });

  it('P4a integration: a point of a built sketch is a point input; a curve is not, nor a point of a sketch after the feature', async () => {
    const s = services({ outputs: { f_sk: { type: 'sketch', points: { p1: [1, 2] }, plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] } } } });
    expect(await refFromItem(s, { kind: 'sketch', feature: 'f_sk', id: 'p1', what: 'point' }, 'point', null)).toEqual({ ok: true, ref: { kind: 'sketch-point', sketch: 'f_sk', point: 'p1' } });
    expect(await refFromItem(s, { kind: 'sketch', feature: 'f_sk', id: 'p9', what: 'point' }, 'point', null)).toEqual({ ok: false, reason: 'That point of the sketch is not built' });
    expect(await refFromItem(s, { kind: 'sketch', feature: 'f_sk', id: 'p1', what: 'point' }, 'plane', null)).toEqual({ ok: false, reason: 'Pick a plane or a flat face' });
    expect(await refFromItem(s, { kind: 'sketch', feature: 'f_sk', id: 'p1', what: 'point' }, 'point', 'f_p1')).toEqual({ ok: false, reason: 'Sketch 1 comes after Plane 1 in the history: move it up, or pick something made before' });
  });

  it('a reference Plane selected is a sketch support; one that did not build says so', () => {
    const s = services();
    expect(constructOf(s, { kind: 'feature', feature: 'f_p1' })).toEqual({ feature: 'f_p1', kind: 'plane' });
    expect(supportFromSelection(s, [{ kind: 'feature', feature: 'f_p1' }])).toEqual({ kind: 'feature', feature: 'f_p1' });
    expect(supportFromSelection(s, [{ kind: 'feature', feature: 'f_p2' }])).toBe('Plane 2 is not built: fix it or roll forward first');
    // An axis is not a sketch plane.
    expect(supportFromSelection(s, [{ kind: 'feature', feature: 'f_a1' }])).toBe('Select a plane or a flat face, then Sketch');
  });

  it('the CONSTRUCT commands start from the selection', async () => {
    const s = services();
    expect(await planeInit(s, [{ kind: 'origin', ref: 'origin:top' }])).toEqual({ method: 'offset', plane: { kind: 'origin', plane: 'origin:top' } });
    expect(await planeInit(s, [{ kind: 'origin', ref: 'origin:top' }, { kind: 'feature', feature: 'f_p1' }])).toEqual({ method: 'midplane', plane: { kind: 'origin', plane: 'origin:top' }, plane2: { kind: 'feature', feature: 'f_p1' } });
    expect(await planeInit(s, [{ kind: 'origin', ref: 'origin:top' }, { kind: 'feature', feature: 'f_a1' }])).toEqual({ method: 'angle', plane: { kind: 'origin', plane: 'origin:top' }, axis: { kind: 'feature', feature: 'f_a1' } });
    expect(await axisInit(s, [{ kind: 'origin', ref: 'origin:front' }, { kind: 'origin', ref: 'origin:right' }])).toEqual({ method: 'two_planes', planes: [{ kind: 'origin', plane: 'origin:front' }, { kind: 'origin', plane: 'origin:right' }] });
    expect(await planeInit(s, [])).toEqual({});
  });
});
