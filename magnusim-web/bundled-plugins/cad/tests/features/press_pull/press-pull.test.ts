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
import { ctxOf, scriptKernel } from '../p2/script-kernel';
import { emptyDoc } from '../../../src/doc/schema';

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
    expect(pressPullDef.incomplete(feature({ faces: [], version: 2 }), units)).toBe('Select faces to press-pull');
  });

  it('nothing left is red, never a body that vanished quietly', async () => {
    const k = kernel().on('press_pull', () => ({ ...moved(), empty: true }));
    const r = await pressPullDef.build(feature({ distance: '-30 mm' }), { d: -30 }, ctxOf(k, [body]));
    expect(r).toEqual({ ok: false, message: 'Press-pull 1 failed: press-pull would remove the whole body' });
  });

  it('a Press-pull saved before version 2 keeps the prism path even where it leaves a step: no offset_faces call (fix round 1, B2)', async () => {
    const k = kernel().on('press_pull', () => ({ ...moved(), sides: { '5:3': 1 } }));
    const r = await pressPullDef.build(feature(), { d: 5 }, ctxOf(k, [body]));
    expect(k.ops()).not.toContain('offset_faces');
    expect(r.ok && r.output).toEqual({ type: 'press-pull', method: 'prism', faces: [], tangent: 0, note: null, legacy: true });
    expect(pressPullDef.incomplete(feature({ faces: [] }), units)).toBe('Select flat faces to press-pull');
  });

  it('a new Press-pull is version 2', () => {
    const doc = emptyDoc('metric');
    expect(pressPullDef.create(doc, {})).toMatchObject({ type: 'press_pull', version: 2 });
  });
});

describe('Press-pull version 2 (kernel API 6, fix round 1)', () => {
  const bore = { i: 5, type: 'cylinder' as const, area: 600, centroid: [10, 10, 10] as [number, number, number], radius: 10, bbox: [0, 0, 0, 20, 20, 20] as [number, number, number, number, number, number] };
  const curvedKernel = () =>
    scriptKernel().on('topo', (p) => {
      if (p.faces === 'none') return { faces: [], edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} };
      const want = p.faces === 'all' ? [0, 1, 2, 3, 4, 5] : (p.faces as number[]);
      const all = [...FACES.slice(0, 5), bore];
      return { faces: all.filter((f) => want.includes(f.i)), edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} };
    });
  const about = { face: 5, type: 'cylinder', role: 'bore', convex: false, radius: 10, new_radius: 8, tangent: [] as number[] };
  const boreRef: PersistentRef = { name: names.faces[5], signature: { kind: 'face', type: 'cylinder', size: 600, at: [10, 10, 10], dir: null, radius: 10 } };
  const v2 = (over: Partial<PressPullFeature> = {}) => feature({ faces: [boreRef], version: 2, ...over });
  const refusal = (code: string, extra: Record<string, unknown> = {}) => ({ refused: { code, ...extra }, about: [{ ...about, new_radius: -1 }] });
  const ok = (id: number, method = 'offset', extra: Record<string, unknown> = {}) => ({ ...moved(id), sides: undefined, op: undefined, empty: undefined, moved: [5], about: [about], tangent: [], method, ...extra });

  it('one offset_faces call with chain on: the result, its method and its words go to the panel; the bore keeps its name', async () => {
    const k = curvedKernel().on('offset_faces', () => ok(400, 'cylinder'));
    const r = await pressPullDef.build(v2(), { d: 2 }, ctxOf(k, [body]));
    expect(k.ops()).not.toContain('press_pull');
    expect(k.calls.find((c) => c.op === 'offset_faces')!.params).toEqual({ id: 1, faces: [5], d: 2, chain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bodies[0]).toMatchObject({ shape: 400, valid: true });
    expect(r.bodies[0].names?.faces[5]).toBe(names.faces[5]);
    expect(r.output).toEqual({ type: 'press-pull', method: 'cylinder', faces: [about], tangent: 0, note: null, carried: { fillets: 0, chamfers: 0 } });
  });

  it("a Chamfer feature's faces go to the kernel as `carry` (put back at their size); the panel counts them", async () => {
    const chamfered = { ...body, names: { faces: [...names.faces.slice(0, 4), 'F:f_ch:chamfer:E:a&b', names.faces[5]] } };
    const k = curvedKernel().on('offset_faces', () => ok(401, 'offset', { carried: [4] }));
    const r = await pressPullDef.build(v2(), { d: 2 }, ctxOf(k, [chamfered]));
    expect(k.calls.find((c) => c.op === 'offset_faces')!.params).toEqual({ id: 1, faces: [5], d: 2, chain: true, carry: [4] });
    expect(r.ok && r.output).toMatchObject({ carried: { fillets: 0, chamfers: 1 } });
  });

  it('a hole that would close is red, in words, with the largest distance that works (the kernel bisects every method)', async () => {
    const k = curvedKernel().on('offset_faces', (p) => (p.diagnose ? { ...refusal('radius', { words: 'the hole would close', face: 5 }), max_ok: 9.997 } : refusal('radius', { words: 'the hole would close', face: 5 })));
    const r = await pressPullDef.build(v2({ distance: '11 mm' }), { d: 11 }, ctxOf(k, [body]));
    expect(r).toMatchObject({ ok: false, message: 'Press-pull 1 failed: the hole would close: 9.9 mm or less works' });
    expect(k.calls.filter((c) => c.op === 'offset_faces').map((c) => c.params.diagnose ?? false)).toEqual([false, true]);
  });

  it('a lost face: "could not be moved cleanly by -40 mm (the result would lose a face (…)). Up to -12 mm works"', async () => {
    const k = curvedKernel().on('offset_faces', (p) => (p.diagnose ? { ...refusal('lost', { face: 4 }), max_ok: 12.3 } : refusal('lost', { face: 4 })));
    const r = await pressPullDef.build(v2({ distance: '-40 mm' }), { d: -40 }, ctxOf(k, [body]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^Press-pull 1 failed: the face could not be moved cleanly by -40 mm \(the result would lose a face \(.+\)\)\. Up to -12 mm works$/);
  });

  it("BRepCheck's words never reach the red text: they go to the panel's Details", async () => {
    const detail = 'invalid result (BRepCheck): SelfIntersectingWire x2, UnorientableShape x1';
    const k = curvedKernel().on('offset_faces', (p) => (p.diagnose ? { ...refusal('invalid', { detail }), max_ok: null } : refusal('invalid', { detail })));
    const r = await pressPullDef.build(v2({ distance: '-20 mm' }), { d: -20 }, ctxOf(k, [body]));
    expect(r).toMatchObject({ ok: false, message: 'Press-pull 1 failed: the face could not be moved cleanly by -20 mm (the result would not be a valid solid). No smaller distance works either' });
    if (r.ok) return;
    expect(r.message).not.toMatch(/BRepCheck|SelfIntersecting|Unorientable/);
    expect(r.output).toMatchObject({ type: 'press-pull', detail });
  });

  it('a volume that barely moves and a step say so in words', async () => {
    let k = curvedKernel().on('offset_faces', (p) => ({ ...refusal('volume', { dv: 1.36, expected: -486439 }), ...(p.diagnose ? { max_ok: null } : {}) }));
    let r = await pressPullDef.build(v2({ distance: '-1 mm' }), { d: -1 }, ctxOf(k, [body]));
    expect(r.ok === false && r.message).toBe('Press-pull 1 failed: the face could not be moved cleanly by -1 mm (its volume would change by 1.36 mm³ instead of about -486,439 mm³). No smaller distance works either');
    // A step and no smaller distance works: the step is the limit, said so.
    k = curvedKernel().on('offset_faces', (p) => ({ ...refusal('step', { face: 2 }), ...(p.diagnose ? { max_ok: null } : {}) }));
    r = await pressPullDef.build(v2({ distance: '-8 mm' }), { d: -8 }, ctxOf(k, [body]));
    expect(r.ok === false && r.message).toMatch(/^Press-pull 1 failed: the face could not be moved cleanly by -8 mm \(a face next to it is not square to it, so moving it alone would leave a step \(.+\)\)\. No smaller distance works either$/);
  });

  describe('fu2 (pp final, polish a): a "step" where a smaller move works names the face that goes', () => {
    /** -8 refused as a step beside face 2, -4.47 works (result 500): the areas there say which face shrinks. */
    const kernelWith = (after: { picked: number; side: number } | 'refused') => {
      const k = scriptKernel()
        .on('topo', (p) => {
          const want = p.faces as number[];
          const areas: Record<number, number> = p.id === 500 && after !== 'refused' ? { 5: after.picked, 2: after.side } : { 5: 600, 2: 400 };
          return { faces: want.map((i) => ({ ...(i === 5 ? bore : FACES[i]), area: areas[i] })), edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} };
        })
        .on('offset_faces', (p) => {
          if (p.d === -8) return { ...refusal('step', { face: 2 }), ...(p.diagnose ? { max_ok: 4.47 } : {}) };
          return after === 'refused' ? refusal('occt') : ok(500);
        });
      return k;
    };
    const run = async (after: Parameters<typeof kernelWith>[0]) => {
      const k = kernelWith(after);
      const ctx = ctxOf(k, [body]);
      const r = await pressPullDef.build(v2({ distance: '-8 mm' }), { d: -8 }, ctx);
      return { r, k, ctx };
    };

    it('the neighbour shrinks (the cylinder below a cone at -4.6): "the face next to it would shrink to nothing"', async () => {
      const { r, k, ctx } = await run({ picked: 650, side: 40 });
      expect(r.ok === false && r.message).toMatch(/^Press-pull 1 failed: the face could not be moved cleanly by -8 mm \(the face next to it would shrink to nothing \(.+\)\)\. Up to -4\.4 mm works$/);
      // The move that works was made at the found distance, then let go.
      expect(k.calls.filter((c) => c.op === 'offset_faces').map((c) => c.params.d)).toEqual([-8, -8, -4.47]);
      expect(ctx.releasedByCtx).toContain(500);
    });

    it('the picked face shrinks (a cone swallowed by the cylinder at +9.5): "it would be swallowed by the face next to it"', async () => {
      const { r } = await run({ picked: 60, side: 450 });
      expect(r.ok === false && r.message).toMatch(/^Press-pull 1 failed: the face could not be moved cleanly by -8 mm \(it would be swallowed by the face next to it \(.+\)\)\. Up to -4\.4 mm works$/);
      expect(r.ok === false && r.message).not.toMatch(/step/);
    });

    it('when it cannot be told: "it or the face next to it would shrink to nothing", never the step', async () => {
      const { r } = await run('refused');
      expect(r.ok === false && r.message).toMatch(/^Press-pull 1 failed: the face could not be moved cleanly by -8 mm \(it or the face next to it would shrink to nothing \(.+\)\)\. Up to -4\.4 mm works$/);
    });
  });

  it('the suggestion is rounded in the display unit (review P6: "0.389764 in")', async () => {
    const k = curvedKernel().on('offset_faces', (p) => (p.diagnose ? { ...refusal('radius', { words: 'the hole would close', face: 5 }), max_ok: 9.997 } : refusal('radius', { words: 'the hole would close', face: 5 })));
    const r = await pressPullDef.build(v2({ distance: '0.5 in' }), { d: 12.7 }, ctxOf(k, [body], { doc: emptyDoc('imperial') }));
    expect(r).toMatchObject({ ok: false, message: 'Press-pull 1 failed: the hole would close: 0.39 in or less works' });
  });
});

describe('Press-pull build (more)', () => {
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
