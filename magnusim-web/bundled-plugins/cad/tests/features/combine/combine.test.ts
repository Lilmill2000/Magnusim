// Combine's build against the kernel contract (docs/p2p3-plan.md §1.6, §2.6)
// with a scripted kernel: one combine call with every target and tool; Join
// keeps the first target and removes the others; Cut/Intersect per target; an
// empty result removes its target with an amber word; tools go unless kept;
// an invalid result is red with Try repair (0.001, 0.01, then ShapeFix, and
// no further offer once the steps are used); large inputs get the long
// timeout; validation words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { indexedNames } from '../../../src/naming/names';
import { combineDef } from '../../../src/features/combine/feature';
import { emptyDoc } from '../../../src/doc/schema';
import { createUnitsService } from '../../../src/doc/units';
import type { CadDoc, CombineFeature } from '../../../src/types/doc';
import type { BuiltBody } from '../../../src/types/doc-service';
import { ctxOf, scriptKernel } from '../p2/script-kernel';

const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
const b = (id: string, shape: number): BuiltBody => ({ id, shape, valid: true, feature: `f_${id}`, names: indexedNames(`f_${id}`, 'primitive', 6) });
const BODIES = [b('b_1', 1), b('b_2', 2), b('b_3', 3)];
const doc: CadDoc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Body 1', color: '#bdc9db' }, b_2: { name: 'Body 2', color: '#bdc9db' }, b_3: { name: 'Body 3', color: '#bdc9db' } } };

const f = (over: Partial<CombineFeature> = {}): CombineFeature => ({ id: 'f_c', type: 'combine', name: 'Combine 1', op: 'cut', targets: ['b_1'], tools: ['b_2'], keepTools: false, ...over });
const result = (target: number, id: number, over: Record<string, unknown> = {}) => ({
  target,
  id,
  empty: false,
  solids: 1,
  valid: true,
  faces: 6,
  history: { faces: [0, 1, 2, 3, 4, 5].map((i) => ({ out: i, from: [{ shape: target, face: i, how: 'modified' }] })), edges: [], deleted: [] },
  ...over,
});

describe('Combine build', () => {
  it('one kernel call with every target and tool; Cut keeps each target, the tools go', async () => {
    const k = scriptKernel().on('combine', (p) => ({ results: (p.targets as number[]).map((t, i) => result(t, 100 + i)), timings: {} }));
    const r = await combineDef.build(f({ targets: ['b_1', 'b_3'], tools: ['b_2'] }), {}, ctxOf(k, BODIES, { doc }));
    expect(k.calls.filter((c) => c.op === 'combine')).toHaveLength(1);
    expect(k.calls.find((c) => c.op === 'combine')!.params).toEqual({ op: 'cut', targets: [1, 3], tools: [2] });
    expect(r).toMatchObject({ ok: true, removed: ['b_2'] });
    if (r.ok) {
      expect(r.bodies.map((x) => [x.id, x.shape])).toEqual([
        ['b_1', 100],
        ['b_3', 101],
      ]);
      // Faces keep the target's names through the history.
      expect(r.bodies[0].names?.faces).toEqual(BODIES[0].names!.faces);
    }
  });

  it('Join keeps the first target; the other targets and the tools go; Keep tools keeps them', async () => {
    const k = scriptKernel().on('combine', () => ({ results: [result(1, 100)], timings: {} }));
    let r = await combineDef.build(f({ op: 'join', targets: ['b_1', 'b_3'], tools: ['b_2'] }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, removed: ['b_3', 'b_2'] });
    r = await combineDef.build(f({ op: 'join', targets: ['b_1', 'b_3'], tools: ['b_2'], keepTools: true }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, removed: ['b_3'] });
  });

  it('a target cut away completely goes, and that is said in amber', async () => {
    const k = scriptKernel().on('combine', () => ({ results: [result(1, 100, { empty: true }), result(3, 101)], timings: {} }));
    const ctx = ctxOf(k, BODIES, { doc });
    const r = await combineDef.build(f({ targets: ['b_1', 'b_3'] }), {}, ctx);
    expect(r).toMatchObject({ ok: true, removed: ['b_1', 'b_2'], warning: 'Body 1 was removed completely' });
    if (r.ok) expect(r.bodies.map((x) => x.id)).toEqual(['b_3']);
    // The empty result's shape is freed.
    expect(ctx.releasedByCtx).toContain(100);
  });

  it('an invalid result: Try repair with 0.001 mm, then 0.01 mm, then ShapeFix; then no more offers', async () => {
    const bad = () => ({ results: [result(1, 100, { valid: false, reason: 'invalid result (BRepCheck): UnorientableShape x1' })], timings: {} });
    let k = scriptKernel().on('combine', bad);
    let r = await combineDef.build(f(), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toEqual({ ok: false, message: 'Combine 1 failed: the result is not a valid solid: (BRepCheck): UnorientableShape x1', actions: ['repair'] });
    // With 0.001 mm the kernel gets fuzzy; ShapeFix is tried (refused here: no repair op), 0.01 is still offered.
    k = scriptKernel().on('combine', bad);
    r = await combineDef.build(f({ repair: { fuzzy: 0.001 } }), {}, ctxOf(k, BODIES, { doc }));
    expect(k.calls.find((c) => c.op === 'combine')!.params.fuzzy).toBe(0.001);
    expect(r).toMatchObject({ ok: false, actions: ['repair'] });
    expect((r as { message: string }).message).toContain('(repair with a 0.001 mm tolerance did not fix it)');
    // At 0.01 mm nothing more is offered.
    r = await combineDef.build(f({ repair: { fuzzy: 0.01 } }), {}, ctxOf(scriptKernel().on('combine', bad), BODIES, { doc }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { actions?: unknown }).actions).toBeUndefined();
    // ShapeFix that keeps the volume is taken, unnamed, with a warning.
    k = scriptKernel()
      .on('combine', bad)
      .on('repair', () => ({ id: 300, valid: true, fixed: true, before: { faces: 6, edges: 12, vertices: 8 }, after: { faces: 6, edges: 12, vertices: 8 } }))
      // The target (shape 1) before the cut is bigger than the repaired result (the cut removed something).
      .on('props', (p) => ({ faces: 6, edges: 12, vertices: 8, solids: 1, shells: 1, volume: p.id === 1 ? 8000 : 5000, bbox_mode: 'none', timings: {} }));
    r = await combineDef.build(f({ repair: { fuzzy: 0.001 } }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'Body 1 was repaired: check the result' });
    if (r.ok) expect(r.bodies[0]).toMatchObject({ id: 'b_1', shape: 300, names: null });
  });

  // Review P2/P3 round 1: a Cut whose tool only touches the target, or a Join with the tool inside it,
  // passed with nothing changed and no word.
  it('a Cut that removes nothing fails with the words an Extrude uses; a Join that adds nothing or stays apart says so', async () => {
    const same = (p: Record<string, unknown>) => ({ faces: 6, edges: 12, vertices: 8, solids: 1, shells: 1, volume: 8000, bbox_mode: 'none', timings: {}, id: p.id });
    let k = scriptKernel().on('combine', () => ({ results: [result(1, 100)], timings: {} })).on('props', same);
    let r = await combineDef.build(f(), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toEqual({ ok: false, message: 'Combine 1 failed: Nothing to cut: Body 2 does not overlap Body 1 (touching is not enough)' });
    // Two targets, one cut and one not: amber, and the cut one is kept.
    k = scriptKernel()
      .on('combine', () => ({ results: [result(1, 100), result(3, 101)], timings: {} }))
      .on('props', (p) => ({ ...same(p), volume: p.id === 101 ? 6000 : 8000 }));
    r = await combineDef.build(f({ targets: ['b_1', 'b_3'] }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'nothing was cut from Body 1: Body 2 does not overlap it (touching is not enough)' });
    k = scriptKernel().on('combine', () => ({ results: [result(1, 100)], timings: {} })).on('props', same);
    r = await combineDef.build(f({ op: 'join' }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'Body 2 lies inside Body 1: joining adds nothing' });
    k = scriptKernel().on('combine', () => ({ results: [result(1, 100, { solids: 2 })], timings: {} })).on('props', (p) => ({ ...same(p), volume: p.id === 100 ? 9000 : 8000 }));
    r = await combineDef.build(f({ op: 'join' }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'Body 1 is now 2 separate solids: the tool does not touch it' });
  });

  // Review P2/P3 round 2: an Intersect of two bodies that only touch was amber "Body 1 was removed
  // completely" (the target gone), while the same Cut was red "Nothing to cut ... (touching is not enough)".
  it('an Intersect with nothing in common fails in the words a Cut uses; with two targets the empty one goes, said in those words', async () => {
    let k = scriptKernel().on('combine', () => ({ results: [result(1, 100, { empty: true })], timings: {} }));
    let ctx = ctxOf(k, BODIES, { doc });
    let r = await combineDef.build(f({ op: 'intersect' }), {}, ctx);
    expect(r).toEqual({ ok: false, message: 'Combine 1 failed: Nothing in common: Body 2 does not overlap Body 1 (touching is not enough)' });
    expect(ctx.releasedByCtx).toContain(100);
    k = scriptKernel().on('combine', () => ({ results: [result(1, 100, { empty: true }), result(3, 101)], timings: {} }));
    ctx = ctxOf(k, BODIES, { doc });
    r = await combineDef.build(f({ op: 'intersect', targets: ['b_1', 'b_3'] }), {}, ctx);
    expect(r).toMatchObject({ ok: true, removed: ['b_1', 'b_2'], warning: 'Body 1 had nothing in common with Body 2 (touching is not enough) and was removed' });
    if (r.ok) expect(r.bodies.map((x) => x.id)).toEqual(['b_3']);
  });

  it('large inputs get the long kernel timeout', async () => {
    const k = scriptKernel().on('combine', () => ({ results: [result(1, 100)], timings: {} }));
    await combineDef.build(f(), {}, ctxOf(k, BODIES, { doc, faces: (s) => (s === 1 ? 11776 : 6) }));
    expect(k.calls.find((c) => c.op === 'combine')!.timeoutMs).toBe(120_000);
  });

  it('says what is missing, and a body cannot be a target and a tool', () => {
    expect(combineDef.incomplete(f({ targets: [] }), units)).toBe('Pick at least one target');
    expect(combineDef.incomplete(f({ tools: [] }), units)).toBe('Pick at least one tool');
    expect(combineDef.incomplete(f({ targets: ['b_1'], tools: ['b_1'] }), units)).toBe('A body cannot be a target and a tool');
    expect(combineDef.uses!(f({ targets: ['b_1', 'b_3'], tools: ['b_2'] }))).toEqual(['b_1', 'b_3', 'b_2']);
  });

  // Review P2/P3 round 4: with two tools Intersect kept what the target shared with either tool
  // (target ∩ (tool 1 ∪ tool 2)); SOLIDWORKS' Common and Fusion's Intersect keep what all share.
  it('Intersect with several tools keeps what the target shares with every tool: what the tools share first', async () => {
    const k = scriptKernel().on('combine', (p) => {
      const t = (p.targets as number[])[0];
      return { results: [result(t, t === 2 ? 50 : 100)], timings: {} };
    });
    const ctx = ctxOf(k, BODIES, { doc });
    const r = await combineDef.build(f({ op: 'intersect', tools: ['b_2', 'b_3'] }), {}, ctx);
    const calls = k.calls.filter((c) => c.op === 'combine').map((c) => c.params);
    expect(calls).toEqual([
      { op: 'intersect', targets: [2], tools: [3] },
      { op: 'intersect', targets: [1], tools: [50] },
    ]);
    expect(r).toMatchObject({ ok: true, removed: ['b_2', 'b_3'] });
    if (r.ok) expect(r.bodies.map((x) => [x.id, x.shape])).toEqual([['b_1', 100]]);
    // What the tools share is a step on the way: released.
    expect(ctx.releasedByCtx).toContain(50);
    // Tools that share nothing: said, and nothing else is asked of the kernel.
    const k2 = scriptKernel().on('combine', () => ({ results: [result(2, 60, { empty: true })], timings: {} }));
    const ctx2 = ctxOf(k2, BODIES, { doc });
    const r2 = await combineDef.build(f({ op: 'intersect', tools: ['b_2', 'b_3'] }), {}, ctx2);
    expect(r2).toEqual({ ok: false, message: 'Combine 1 failed: Nothing in common: the tools Body 2 and Body 3 have no volume that all of them share (touching is not enough)' });
    expect(k2.calls.filter((c) => c.op === 'combine')).toHaveLength(1);
    expect(ctx2.releasedByCtx).toContain(60);
    // One tool: one call, as before.
    const k3 = scriptKernel().on('combine', () => ({ results: [result(1, 100)], timings: {} }));
    await combineDef.build(f({ op: 'intersect' }), {}, ctxOf(k3, BODIES, { doc }));
    expect(k3.calls.filter((c) => c.op === 'combine').map((c) => c.params)).toEqual([{ op: 'intersect', targets: [1], tools: [2] }]);
  });

  // Review P2/P3 round 4: two cubes meeting at a corner read as one body with no word of the pieces.
  it('a Cut or Intersect that leaves a target in more pieces than it had says so', async () => {
    const props = (solidsOf: (id: number) => number) => (p: Record<string, unknown>) => ({ faces: 6, edges: 12, vertices: 8, solids: solidsOf(p.id as number), shells: 1, volume: p.id === 100 ? 2000 : 8000, bbox_mode: 'none', timings: {}, id: p.id });
    let k = scriptKernel()
      .on('combine', () => ({ results: [result(1, 100, { solids: 2 })], timings: {} }))
      .on('props', props(() => 1));
    let r = await combineDef.build(f(), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'Body 1 is now in 2 separate pieces' });
    k = scriptKernel()
      .on('combine', () => ({ results: [result(1, 100, { solids: 2 })], timings: {} }))
      .on('props', props(() => 1));
    r = await combineDef.build(f({ op: 'intersect' }), {}, ctxOf(k, BODIES, { doc }));
    expect(r).toMatchObject({ ok: true, warning: 'Body 1 is now in 2 separate pieces' });
    // A target that was in 2 pieces already: nothing new to say.
    k = scriptKernel()
      .on('combine', () => ({ results: [result(1, 100, { solids: 2 })], timings: {} }))
      .on('props', props(() => 2));
    r = await combineDef.build(f(), {}, ctxOf(k, BODIES, { doc }));
    expect(r.ok && r.warning).toBeFalsy();
  });

  it('a body that is not there at this point is said', async () => {
    const r = await combineDef.build(f({ tools: ['b_9'] }), {}, ctxOf(scriptKernel(), BODIES, { doc }));
    expect(r).toEqual({ ok: false, message: 'Combine 1 failed: a deleted body is not there at this point' });
  });
});
