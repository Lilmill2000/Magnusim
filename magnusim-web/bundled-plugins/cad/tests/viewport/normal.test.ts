// P4b SELECT (scope addition B): what "Normal to" looks at (src/viewport/normal.ts): a flat face, an
// origin plane, a CONSTRUCT plane, a sketch (its row, a profile or a curve of it) with the sketch's own
// up; a curved face says so; nothing planar says what to select.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CURVED_REASON, NORMAL_TO_REASON, frameUp, normalTarget, targetOfItem, upFor } from '../../src/viewport/normal';
import type { SelectionItem } from '../../src/types/selection';

const state = {
  doc: {
    features: [
      { id: 'f_s', type: 'sketch', name: 'Sketch 2', plane: { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] } },
      { id: 'f_p', type: 'ref_plane', name: 'Plane 1' },
      { id: 'f_e', type: 'extrude', name: 'Extrude 1' },
    ],
  },
  rebuild: { outputs: { f_p: { type: 'plane', frame: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] } } } },
} as never;
const handle = { planeNormal: (it: SelectionItem) => (it.kind === 'face' && it.index === 0 ? ([0, 0, 1] as [number, number, number]) : it.kind === 'origin' ? ([0, -1, 0] as [number, number, number]) : null) };

describe('Normal to targets', () => {
  it('a sketch by its row, a profile or a curve: its plane and its own up (normal x xdir)', () => {
    for (const it of [{ kind: 'feature', feature: 'f_s' }, { kind: 'region', feature: 'f_s', key: 'k' }, { kind: 'sketch', feature: 'f_s', id: 'e_1', what: 'entity' }] as SelectionItem[]) {
      expect(targetOfItem(state, handle, it)).toEqual({ normal: [1, 0, 0], up: [0, 0, 1], what: 'Sketch 2' });
    }
    expect(frameUp({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] })).toEqual([0, 1, 0]);
  });
  it('a CONSTRUCT plane by its build output; an origin plane and a flat face by the view', () => {
    expect(targetOfItem(state, handle, { kind: 'feature', feature: 'f_p' })).toEqual({ normal: [0, 0, 1], up: [0, 1, 0], what: 'Plane 1' });
    expect(targetOfItem(state, handle, { kind: 'origin', ref: 'origin:front' })).toEqual({ normal: [0, -1, 0], up: [0, 0, 1], what: 'plane' });
    expect(targetOfItem(state, handle, { kind: 'face', body: 'b', index: 0 })).toMatchObject({ normal: [0, 0, 1], what: 'face' });
    expect(upFor([0, 0, -1])).toEqual([0, 1, 0]);
  });
  it('a curved face says so; an origin axis, an edge or another feature is not a plane', () => {
    expect(normalTarget(state, handle, [{ kind: 'face', body: 'b', index: 3 }])).toEqual({ reason: CURVED_REASON });
    expect(normalTarget(state, handle, [{ kind: 'edge', body: 'b', index: 3 }, { kind: 'feature', feature: 'f_e' }, { kind: 'origin', ref: 'origin:x' }])).toEqual({ reason: NORMAL_TO_REASON });
    // The first planar item wins.
    expect(normalTarget(state, handle, [{ kind: 'edge', body: 'b', index: 1 }, { kind: 'feature', feature: 'f_s' }])).toMatchObject({ what: 'Sketch 2' });
  });
});

describe('P4b fix round 1, polish 8: a sketch is never looked at upside down', () => {
  it('a sketch on a bottom face gets the up its face gets', async () => {
    const { sketchUp, upFor } = await import('../../src/viewport/normal');
    // A bottom face's sketch frame: normal -Z, xdir +X, so its own y is -Y; looked at with +Y up, as the face.
    expect(sketchUp({ origin: [0, 0, 0], normal: [0, 0, -1], xdir: [1, 0, 0] })).toEqual([-0, 1, -0]);
    expect(upFor([0, 0, -1])).toEqual([0, 1, 0]);
    // A top face's sketch keeps its own y.
    expect(sketchUp({ origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] })).toEqual([0, 1, 0]);
  });
});
