// The rebuild engine over a fake kernel: operations, cache (rebuild from the
// first changed feature), failures as no-ops with downstream still trying,
// validity and repair, suppression, rollback, watchdog stops, respawns.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../../src/doc/features/registry';
import { RebuildEngine, type RebuildOutput } from '../../src/doc/rebuild';
import { deepFreeze, emptyDoc, emptyView } from '../../src/doc/schema';
import type { BodyOp, BoxFeature, CadDoc, CadView, CylinderFeature, Feature, Param } from '../../src/types/doc';
import { FakeKernel } from './fake-kernel';

function box(n: number, op: BodyOp, at: [number, number, number], size = 20, extra: Partial<BoxFeature> = {}): BoxFeature {
  return {
    id: `f_box${n}`,
    type: 'box',
    name: `Box ${n}`,
    op,
    creates: op === 'new' ? `b_${n}` : null,
    scope: [],
    origin: at.map(String) as [string, string, string],
    size: [`${size}`, `${size}`, `${size}`],
    ...extra,
  };
}

function cyl(n: number, op: BodyOp, extra: Partial<CylinderFeature> = {}): CylinderFeature {
  return { id: `f_cyl${n}`, type: 'cylinder', name: `Cylinder ${n}`, op, creates: op === 'new' ? `b_c${n}` : null, scope: [], origin: ['10', '10', '0'], axis: 'origin:z', diameter: '10', height: '40', ...extra };
}

function docOf(features: Feature[], params: Param[] = []): CadDoc {
  const bodies: CadDoc['bodies'] = {};
  let i = 1;
  for (const f of features) if ('creates' in f && f.creates) bodies[f.creates] = { name: `Body ${i++}`, color: '#bdc9db' };
  return deepFreeze({ ...emptyDoc('metric'), features, params, bodies });
}

function setup() {
  const kernel = new FakeKernel();
  const outs: RebuildOutput[] = [];
  const respawns: string[] = [];
  const engine = new RebuildEngine({ kernel, registry: createBuiltinRegistry(), onResult: (o) => outs.push(o), onRespawn: (r) => respawns.push(r) });
  async function run(doc: CadDoc, view: CadView = emptyView()): Promise<RebuildOutput> {
    const before = outs.length;
    engine.request({ doc, view });
    await engine.whenIdle();
    // A respawn queues another rebuild: wait for it too.
    for (let i = 0; i < 5 && (outs.length === before || kernel.status.get().state !== 'ready'); i++) {
      await new Promise((r) => setTimeout(r, 0));
      await engine.whenIdle();
    }
    return outs[outs.length - 1];
  }
  return { kernel, engine, outs, run, respawns };
}

describe('rebuild engine', () => {
  it('builds a box as a new body, with tessellation and exact properties', async () => {
    const { kernel, run } = setup();
    const out = await run(docOf([box(1, 'new', [0, 0, 0])]));
    expect(out.message).toBeNull();
    expect(out.features.f_box1).toMatchObject({ state: 'ok' });
    expect(out.bodies).toHaveLength(1);
    expect(out.bodies[0]).toMatchObject({ id: 'b_1', name: 'Body 1', color: '#bdc9db', feature: 'f_box1', volume: 8000, faces: 6, edges: 12, visible: true });
    expect(out.bodies[0].tess?.faceRanges.length).toBe(12);
    expect(kernel.ops()).toEqual(['box', 'tessellate', 'props']);
  });

  it('caches: an unchanged prefix is not rebuilt, a rename rebuilds nothing', async () => {
    const { kernel, run } = setup();
    const d1 = docOf([box(1, 'new', [0, 0, 0]), box(2, 'new', [50, 0, 0])]);
    const o1 = await run(d1);
    const key1 = o1.bodies.map((b) => b.tessKey);
    kernel.calls = [];
    // Edit Box 2 only: Box 1 comes from the cache.
    const d2 = docOf([d1.features[0], { ...(d1.features[1] as BoxFeature), size: ['30', '30', '30'] }]);
    const o2 = await run(d2);
    expect(kernel.ops(['box'])).toEqual(['box']);
    expect(kernel.calls.find((c) => c.op === 'box')?.params).toMatchObject({ dx: 30, origin: [50, 0, 0] });
    expect(o2.bodies[0].tessKey).toBe(key1[0]);
    expect(o2.bodies[1].tessKey).not.toBe(key1[1]);
    // Rename: no kernel call at all.
    kernel.calls = [];
    const o3 = await run(docOf([{ ...d2.features[0], name: 'Base block' }, d2.features[1]]));
    expect(kernel.calls).toEqual([]);
    expect(o3.bodies.map((b) => b.tessKey)).toEqual(o2.bodies.map((b) => b.tessKey));
    // Back to the first version (undo): cache hit.
    kernel.calls = [];
    await run(d1);
    expect(kernel.ops(['box', 'boolean'])).toEqual([]);
  });

  it('cut, join and intersect change the bodies the tool touches and release the tool', async () => {
    const { kernel, run } = setup();
    const cut = await run(docOf([box(1, 'new', [0, 0, 0]), box(2, 'cut', [10, 10, 10])]));
    expect(cut.features.f_box2).toMatchObject({ state: 'ok' });
    expect(cut.bodies).toHaveLength(1);
    expect(cut.bodies[0]).toMatchObject({ id: 'b_1', feature: 'f_box2', volume: 8000 - 1000 });
    // Live shapes: only the body (the tool and the touch test result were released).
    expect(kernel.live()).toContain(cut.bodies[0].shape);

    const join = await run(docOf([box(1, 'new', [0, 0, 0]), box(3, 'new', [10, 0, 0]), box(2, 'join', [5, 0, 0])]));
    expect(join.bodies.map((b) => b.id)).toEqual(['b_1']);
    expect(join.bodies[0].volume).toBeCloseTo(30 * 20 * 20, 6);

    const common = await run(docOf([box(1, 'new', [0, 0, 0]), box(2, 'intersect', [10, 10, 10])]));
    expect(common.bodies[0]).toMatchObject({ id: 'b_1', volume: 1000 });

    // Explicit scope: only that body is cut.
    const scoped = await run(docOf([box(1, 'new', [0, 0, 0]), box(3, 'new', [0, 0, 0]), box(2, 'cut', [10, 10, 10], 20, { scope: ['b_3'] })]));
    expect(scoped.bodies.map((b) => [b.id, b.volume])).toEqual([
      ['b_1', 8000],
      ['b_3', 7000],
    ]);
  });

  it('a cylinder cut from a box', async () => {
    const { run } = setup();
    const out = await run(docOf([box(1, 'new', [0, 0, 0]), cyl(1, 'cut', { origin: ['10', '10', '-5'] })]));
    expect(out.features.f_cyl1).toMatchObject({ state: 'ok' });
    expect(out.bodies).toHaveLength(1);
  });

  it('a failed feature is a no-op; later features still build', async () => {
    const { kernel, run } = setup();
    kernel.script.fail = (op, p) => (op === 'box' && p.dx === 7 ? { kind: 'occt', message: 'BRepPrimAPI_MakeBox: Standard_DomainError' } : null);
    const out = await run(docOf([box(1, 'new', [0, 0, 0], 7), box(2, 'cut', [100, 100, 100]), box(3, 'new', [50, 0, 0])]));
    // A bare OCCT exception is said in plain words (review round 1), with the class kept for bug reports.
    expect(out.features.f_box1).toMatchObject({ state: 'error', message: 'Box 1 failed: the geometry kernel could not build it (Standard_DomainError)' });
    expect(out.features.f_box2).toMatchObject({ state: 'error', message: 'Nothing to cut: Box 2 does not overlap any body made before it (touching is not enough)' });
    expect(out.features.f_box3).toMatchObject({ state: 'ok' });
    expect(out.bodies.map((b) => b.id)).toEqual(['b_3']);
    expect(out.failed).toEqual(['f_box1', 'f_box2']);
  });

  it('bad expressions are feature errors that name the field', async () => {
    const { run } = setup();
    const out = await run(docOf([box(1, 'new', [0, 0, 0], 20, { size: ['w', '10', '0'] }), box(2, 'new', [0, 0, 0], 20, { size: ['10', '10', '-1'] })], []));
    expect(out.features.f_box1).toMatchObject({ state: 'error', message: 'Box 1: Length: Unknown parameter "w"' });
    expect(out.features.f_box2).toMatchObject({ state: 'error', message: 'Box 2: Height must be more than 0' });
    // With the parameter it builds, in the display unit.
    const ok = await run(docOf([box(1, 'new', [0, 0, 0], 20, { size: ['w', 'w / 2', '1 cm'] })], [{ id: 'p_w', name: 'w', expr: '40', quantity: 'length' }]));
    expect(ok.bodies[0].volume).toBe(40 * 20 * 10);
  });

  it('an invalid result is an error with Try repair, never a silent pass', async () => {
    const { kernel, run } = setup();
    kernel.script.valid = (op) => op !== 'boolean';
    const f1 = box(1, 'new', [0, 0, 0]);
    const out = await run(docOf([f1, box(2, 'cut', [10, 10, 10])]));
    expect(out.features.f_box2).toMatchObject({ state: 'error', message: 'Box 2 failed: the result is not a valid solid', actions: ['repair'] });
    // The body stays as it was before the cut (a no-op).
    expect(out.bodies[0]).toMatchObject({ feature: 'f_box1', volume: 8000 });
    const r1 = await run(docOf([f1, box(2, 'cut', [10, 10, 10], 20, { repair: { fuzzy: 0.001 } })]));
    expect(r1.features.f_box2).toMatchObject({ message: 'Box 2 failed: the result is not a valid solid (repair with a 0.001 mm tolerance did not fix it)', actions: ['repair'] });
    expect(kernel.calls.filter((c) => c.op === 'boolean').at(-1)?.params).toMatchObject({ fuzzy: 0.001 });
    const r2 = await run(docOf([f1, box(2, 'cut', [10, 10, 10], 20, { repair: { fuzzy: 0.01 } })]));
    expect(r2.features.f_box2.actions).toBeUndefined();
    // A kernel for which the tolerance helps: the repaired feature builds.
    const b = setup();
    b.kernel.script.valid = (op, p) => op !== 'boolean' || p.op === 'common' || (p as { fuzzy?: number }).fuzzy === 0.001;
    const fixed = await b.run(docOf([f1, box(2, 'cut', [10, 10, 10], 20, { repair: { fuzzy: 0.001 } })]));
    expect(fixed.features.f_box2).toMatchObject({ state: 'ok' });
    expect(fixed.bodies[0]).toMatchObject({ feature: 'f_box2', volume: 7000 });
  });

  it('Try repair falls back to the kernel ShapeFix repair, kept only when the volume holds', async () => {
    const f1 = box(1, 'new', [0, 0, 0]);
    const cut = box(2, 'cut', [10, 10, 10], 20, { repair: { fuzzy: 0.001 } });
    const good = setup();
    good.kernel.script.valid = (op, p) => !(op === 'boolean' && p.op === 'cut');
    good.kernel.script.repair = (t) => ({ shape: { ...t }, valid: true });
    const ok = await good.run(docOf([f1, cut]));
    expect(ok.features.f_box2).toMatchObject({ state: 'warning', message: 'Body 1 was repaired: check the result' });
    expect(ok.bodies[0]).toMatchObject({ feature: 'f_box2', volume: 7000, valid: true });
    // A "repair" that changes the volume is refused: still an error.
    const bad = setup();
    bad.kernel.script.valid = good.kernel.script.valid;
    bad.kernel.script.repair = (t) => ({ shape: { ...t, volume: t.volume / 2 }, valid: true });
    const no = await bad.run(docOf([f1, cut]));
    expect(no.features.f_box2).toMatchObject({ state: 'error', actions: ['repair'] });
    expect(no.bodies[0]).toMatchObject({ feature: 'f_box1', volume: 8000 });
  });

  it('booleans on large bodies get the long kernel timeout; small ones the default', async () => {
    const { kernel, run } = setup();
    await run(docOf([box(1, 'new', [0, 0, 0]), box(2, 'cut', [10, 10, 10])]));
    expect(kernel.calls.filter((c) => c.op === 'boolean').map((c) => c.timeoutMs)).toEqual([undefined, undefined]);
    const big = setup();
    big.kernel.facesOf = (id) => (id === 1 ? 11_776 : 6);
    await big.run(docOf([box(1, 'new', [0, 0, 0]), box(2, 'cut', [10, 10, 10])]));
    expect(big.kernel.calls.filter((c) => c.op === 'boolean').map((c) => c.timeoutMs)).toEqual([120_000, 120_000]);
  });

  it('a kernel that keeps stopping is not respawned in a loop', async () => {
    const { kernel, outs, run, respawns } = setup();
    // Every tessellation stops the worker: each body is skipped once, then the part shows without it.
    kernel.script.fail = (op) => (op === 'tessellate' ? { kind: 'crash', message: 'worker error' } : null);
    await run(docOf([box(1, 'new', [0, 0, 0])]));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(respawns.length).toBeLessThanOrEqual(2);
    const out = outs.at(-1)!;
    expect(out.features.f_box1).toMatchObject({ state: 'warning', message: 'Body 1 could not be displayed: worker error', actions: ['retry'] });
    expect(out.bodies[0].tess).toBeNull();
  });

  it('suppressed and rolled-back features are not built', async () => {
    const { run } = setup();
    const doc = docOf([box(1, 'new', [0, 0, 0]), { ...box(2, 'new', [50, 0, 0]), suppressed: true }, box(3, 'new', [100, 0, 0])]);
    const out = await run(doc);
    expect(out.features.f_box2).toEqual({ state: 'suppressed', bodiesBefore: 1 });
    // Box 3 comes after Box 1 (Box 2 is suppressed): one body before it.
    expect(out.features.f_box3).toMatchObject({ state: 'ok', bodiesBefore: 1 });
    expect(out.features.f_box1).toMatchObject({ state: 'ok', bodiesBefore: 0 });
    expect(out.bodies.map((b) => b.id)).toEqual(['b_1', 'b_3']);
    const rolled = await run(doc, { ...emptyView(), rollback: 1 });
    expect(rolled.features.f_box3).toEqual({ state: 'rolled-back' });
    expect(rolled.bodies.map((b) => b.id)).toEqual(['b_1']);
    const hidden = await run(doc, { ...emptyView(), hiddenBodies: ['b_3'] });
    expect(hidden.bodies.find((b) => b.id === 'b_3')?.visible).toBe(false);
  });

  it('a watchdog stop respawns, rebuilds the rest transparently, and skips the feature until Retry', async () => {
    const { kernel, engine, run, respawns } = setup();
    let hang = true;
    kernel.script.fail = (op, p) => (hang && op === 'box' && p.dx === 13 ? { kind: 'watchdog', message: 'box was stopped after 20.0 s' } : null);
    const doc = docOf([box(1, 'new', [0, 0, 0]), box(2, 'new', [50, 0, 0], 13), box(3, 'new', [100, 0, 0])]);
    const out = await run(doc);
    expect(respawns).toEqual(['box was stopped after 20.0 s']);
    expect(out.features.f_box2).toMatchObject({ state: 'error', message: 'Box 2 was stopped after 20.0 s', actions: ['retry'] });
    expect(out.features.f_box1).toMatchObject({ state: 'ok' });
    expect(out.features.f_box3).toMatchObject({ state: 'ok' });
    expect(out.bodies.map((b) => b.id)).toEqual(['b_1', 'b_3']);
    // Every body lives in the new worker.
    for (const b of out.bodies) expect(kernel.live()).toContain(b.shape);
    // Retry builds it again.
    hang = false;
    expect(engine.retry('f_box2')).toBe(true);
    await engine.whenIdle();
    const again = await run(doc);
    expect(again.features.f_box2).toMatchObject({ state: 'ok' });
    expect(again.bodies).toHaveLength(3);
  });

  it('after any respawn the whole history rebuilds with new shape ids and the same geometry keys', async () => {
    const { kernel, outs, run } = setup();
    const doc = docOf([box(1, 'new', [0, 0, 0]), box(2, 'cut', [10, 10, 10])]);
    const before = await run(doc);
    const n = outs.length;
    await kernel.respawn('crash: test');
    for (let i = 0; i < 10 && outs.length === n; i++) await new Promise((r) => setTimeout(r, 0));
    const after = outs[outs.length - 1];
    expect(outs.length).toBe(n + 1);
    expect(after.bodies[0].volume).toBe(7000);
    expect(after.bodies[0].tessKey).toBe(before.bodies[0].tessKey);
    expect(kernel.live()).toContain(after.bodies[0].shape);
  });

  it('an out-of-memory result stops the feature (the worker respawns) without looping', async () => {
    const { kernel, run, respawns } = setup();
    kernel.script.fail = (op, p) => (op === 'box' && p.dx === 11 ? { kind: 'internal', message: 'out of memory', oom: true } : null);
    const out = await run(docOf([box(1, 'new', [0, 0, 0], 11), box(2, 'new', [50, 0, 0])]));
    expect(respawns).toHaveLength(1);
    expect(out.features.f_box1).toMatchObject({ state: 'error', message: 'Box 1 ran out of memory: out of memory', actions: ['retry'] });
    expect(out.features.f_box2).toMatchObject({ state: 'ok' });
  });

  it('recycles an oversized worker at idle, once', async () => {
    const { kernel, outs, run } = setup();
    kernel.heap = 1.3e9;
    await run(docOf([box(1, 'new', [0, 0, 0])]));
    for (let i = 0; i < 10 && kernel.status.get().respawns === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(kernel.recycles).toBe(1);
    expect(kernel.status.get().respawns).toBe(1);
    // It rebuilt after the recycle.
    expect(outs.at(-1)?.bodies).toHaveLength(1);
  });
});
