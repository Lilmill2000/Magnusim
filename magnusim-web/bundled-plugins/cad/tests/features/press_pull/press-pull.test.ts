// Press-pull's build against the kernel contract (docs/p2p3-plan.md §1.4,
// §2.4) with a scripted kernel until the real press_pull lands: stored
// references resolve to the body's faces, the distance goes to the kernel as
// d, the moved face keeps its name, a side face is named by the edge it was
// swept from (F:<feature>:side:E:<a>&<b>), an empty or invalid result is red
// (Try repair: fuzzy, then ShapeFix), and the distance must not be 0.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { indexedNames } from '../../../src/naming/names';
import { pressPullDef } from '../../../src/features/press_pull/feature';
import { createUnitsService } from '../../../src/doc/units';
import type { PersistentRef, PressPullFeature } from '../../../src/types/doc';
import type { BuiltBody } from '../../../src/types/doc-service';
import { ctxOf, kernelError, scriptKernel } from '../p2/script-kernel';

const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
const names = indexedNames('f_box', 'primitive', 6);
const body: BuiltBody = { id: 'b_1', shape: 1, valid: true, feature: 'f_box', names };
const plane = (i: number, n: [number, number, number], at: [number, number, number]) => ({ i, type: 'plane' as const, area: 400, centroid: at, normal: n, bbox: [0, 0, 0, 20, 20, 20] as [number, number, number, number, number, number] });
// A 20 mm box: face 5 is the top (z = 20).
const FACES = [plane(0, [-1, 0, 0], [0, 10, 10]), plane(1, [1, 0, 0], [20, 10, 10]), plane(2, [0, -1, 0], [10, 0, 10]), plane(3, [0, 1, 0], [10, 20, 10]), plane(4, [0, 0, -1], [10, 10, 0]), plane(5, [0, 0, 1], [10, 10, 20])];
const top: PersistentRef = { name: names.faces[5], signature: { kind: 'face', type: 'plane', size: 400, at: [10, 10, 20], dir: [0, 0, 1], radius: null } };

function feature(over: Partial<PressPullFeature> = {}): PressPullFeature {
  return { id: 'f_pp', type: 'press_pull', name: 'Press-pull 1', body: 'b_1', faces: [top], distance: '5 mm', ...over };
}

function kernel() {
  return scriptKernel().on('topo', (p) => {
    if (p.faces === 'none') return { faces: [], edges: (p.edges as number[]).map((i) => ({ i, type: 'line', faces: i === 3 ? [1, 5] : [0, 5] })), vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} };
    const want = p.faces === 'all' ? FACES.map((f) => f.i) : (p.faces as number[]);
    return { faces: FACES.filter((f) => want.includes(f.i)), edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} };
  });
}

/** A press-pull result: the top moved (out 5), four sides swept from the top's edges, the others the same. */
function moved(id = 100, over: Record<string, unknown> = {}) {
  return {
    id,
    valid: true,
    faces: 6,
    moved: [5],
    sides: {},
    op: 'fuse',
    empty: false,
    solids: 1,
    history: {
      faces: [
        { out: 0, from: [{ shape: 1, face: 0, how: 'modified' }] },
        { out: 1, from: [{ shape: 1, face: 1, how: 'modified' }, { shape: 1, edge: 3, how: 'generated' }] },
        { out: 2, from: [{ shape: 1, face: 2, how: 'modified' }] },
        { out: 3, from: [{ shape: 1, face: 3, how: 'modified' }] },
        { out: 4, from: [{ shape: 1, face: 4, how: 'same' }] },
        { out: 5, from: [{ shape: 1, face: 5, how: 'modified' }] },
      ],
      edges: [],
      deleted: [],
    },
    ...over,
  };
}

describe('Press-pull build', () => {
  it('moves the face by d along its normal; names follow the history', async () => {
    const k = kernel().on('press_pull', () => moved());
    const r = await pressPullDef.build(feature(), { d: 5 }, ctxOf(k, [body]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const call = k.calls.find((c) => c.op === 'press_pull')!;
    expect(call.params).toEqual({ id: 1, faces: [5], d: 5 });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]).toMatchObject({ id: 'b_1', shape: 100, valid: true });
    // Same / modified faces keep their names (a face both modified and swept keeps the modified name).
    expect(r.bodies[0].names?.faces).toEqual(names.faces);
  });

  it('names a face only swept from an edge by that edge: F:<feature>:side:E:<a>&<b>', async () => {
    const res = moved(101, {
      faces: 7,
      history: { ...moved().history, faces: [...moved().history.faces, { out: 6, from: [{ shape: 1, edge: 3, how: 'generated' }] }] },
    });
    const k = kernel().on('press_pull', () => res);
    const r = await pressPullDef.build(feature(), { d: 5 }, ctxOf(k, [body]));
    expect(r.ok && r.bodies[0].names?.faces[6]).toBe(`F:f_pp:side:E:${[names.faces[1], names.faces[5]].sort().join('&')}`);
    // The edge's faces came from one topo call on the input, for the swept edges only.
    const topoEdges = k.calls.filter((c) => c.op === 'topo' && c.params.faces === 'none');
    expect(topoEdges).toHaveLength(1);
    expect(topoEdges[0].params.edges).toEqual([3]);
  });

  it('a negative distance removes material: the kernel gets d < 0', async () => {
    const k = kernel().on('press_pull', () => ({ ...moved(), op: 'cut' }));
    await pressPullDef.build(feature({ distance: '-5 mm' }), { d: -5 }, ctxOf(k, [body]));
    expect(k.calls.find((c) => c.op === 'press_pull')!.params.d).toBe(-5);
  });

  it('the distance must not be 0', () => {
    expect(pressPullDef.resolve(feature({ distance: '0 mm' }), units)).toEqual({ ok: false, message: 'Distance must not be 0' });
    expect(pressPullDef.incomplete(feature({ distance: '0' }), units)).toBe('Distance must not be 0');
    expect(pressPullDef.incomplete(feature({ faces: [] }), units)).toBe('Select flat faces to press-pull');
  });

  it('nothing left is red, never a body that vanished quietly', async () => {
    const k = kernel().on('press_pull', () => ({ ...moved(), empty: true }));
    const r = await pressPullDef.build(feature({ distance: '-30 mm' }), { d: -30 }, ctxOf(k, [body]));
    expect(r).toEqual({ ok: false, message: 'Press-pull 1 failed: press-pull would remove the whole body' });
  });

  it("the kernel's refusal of a curved face is said", async () => {
    const k = kernel().on('press_pull', () => {
      throw kernelError('press_pull needs planar faces: face 3 is a cylinder', 'input', 'press_pull');
    });
    const r = await pressPullDef.build(feature(), { d: 5 }, ctxOf(k, [body]));
    expect(r).toEqual({ ok: false, message: 'Press-pull 1 failed: press_pull needs planar faces: face 3 is a cylinder' });
  });

  it('an invalid result is red with Try repair; repair runs with the fuzzy tolerance, then ShapeFix', async () => {
    const bad = () => ({ ...moved(), valid: false, reason: 'invalid result (BRepCheck): NotClosed x1' });
    let k = kernel().on('press_pull', bad);
    const first = ctxOf(k, [body]);
    let r = await pressPullDef.build(feature(), { d: 5 }, first);
    expect(r).toEqual({ ok: false, message: 'Press-pull 1 failed: the result is not a valid solid: (BRepCheck): NotClosed x1', actions: ['repair'] });
    expect(first.releasedByCtx).toContain(100);
    // Try repair: fuzzy 0.001 goes to the kernel, ShapeFix fixes it with the volume kept.
    k = kernel()
      .on('press_pull', bad)
      .on('repair', () => ({ id: 200, valid: true, fixed: true, before: { faces: 6, edges: 12, vertices: 8 }, after: { faces: 6, edges: 12, vertices: 8 } }))
      .on('props', () => ({ faces: 6, edges: 12, vertices: 8, solids: 1, shells: 1, volume: 10000, bbox_mode: 'none', timings: {} }));
    const ctx = ctxOf(k, [body]);
    r = await pressPullDef.build(feature({ repair: { fuzzy: 0.001 } }), { d: 5 }, ctx);
    expect(k.calls.find((c) => c.op === 'press_pull')!.params.fuzzy).toBe(0.001);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bodies[0]).toMatchObject({ shape: 200, valid: true, names: null });
      expect(r.warning).toBe('a deleted body was repaired: check the result');
    }
  });

  it('a face reference that is gone fails the feature (no partial press-pull)', async () => {
    const k = kernel().on('press_pull', () => moved());
    const lost: PersistentRef = { name: 'F:f_x:primitive:9', signature: { kind: 'face', type: 'cylinder', at: [99, 99, 99], radius: 3 } };
    const r = await pressPullDef.build(feature({ faces: [top, lost] }), { d: 5 }, ctxOf(k, [body]));
    expect(r).toEqual({ ok: false, message: 'Press-pull 1 failed: Face 10 of a deleted feature not found on a deleted body after rebuild' });
    expect(k.ops()).not.toContain('press_pull');
  });

  it('declares its body and its one expression', () => {
    const f = feature({ distance: 'h / 2' });
    expect(pressPullDef.uses!(f)).toEqual(['b_1']);
    expect(pressPullDef.exprs!(f)).toEqual([{ path: 'distance', expr: 'h / 2' }]);
    expect(pressPullDef.mapExprs!(f, (e) => e.replace('h', 'height')).distance).toBe('height / 2');
    // References are never rewritten by a parameter rename.
    expect(pressPullDef.mapExprs!(f, (e) => e + '!').faces).toEqual(f.faces);
  });
});
