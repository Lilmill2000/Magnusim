// DocService.settled(): it resolves once the rebuild of the current model and
// view has finished, and never on a result that only looks done. Each window is
// forced with the toy kernel held at a named call or respawn (held-kernel.ts),
// never with sleeps:
//   - an old result published just before the next request (rebuild.ts pump);
//   - an undo back to the shown model while another rebuild runs;
//   - asked for inside the change, before its rebuild is requested (model, bar,
//     a new Part before its first rebuild);
//   - a bodiesAtEnd build holding the engine with no onStart;
//   - a sketch's isolated build while its session is open;
//   - a respawn mid-build, and a respawn while idle (the shown shapes died);
//   - abort, a new load, an unreadable part and dispose reject; no timer is needed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { ParamId } from '../../src/types/doc';
import type { DocService, RebuildState } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, registerSolidFeatures } from './blocks';
import { HeldKernel } from './held-kernel';

const services: DocService[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of services.splice(0)) s.dispose();
});

async function open() {
  const ws = createFakeWorkspace();
  const kernel = new HeldKernel();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  services.push(doc);
  await doc.load();
  return { ws, kernel, doc };
}

/** Whether (and how) a promise has settled, without awaiting it. */
function watch<T>(p: Promise<T>) {
  const w: { done: boolean; value: T | null; error: unknown } = { done: false, value: null, error: null };
  p.then(
    (v) => {
      w.done = true;
      w.value = v;
    },
    (e: unknown) => {
      w.done = true;
      w.error = e;
    },
  );
  return w;
}

/**
 * Let every queued microtask and one macrotask turn run. Used once the kernel is held
 * (or the answer is synchronous): nothing else moves, so a wrong early resolve shows.
 */
const drain = () => new Promise((r) => setTimeout(r, 0));

const BLIND = (distance: string) => ({ extrude: { extent: { kind: 'blind', distance } } }) as const;
const volumes = (r: RebuildState) => r.bodies.map((b) => b.volume);
const exprOf = (doc: DocService, id: ParamId) => doc.state.get().doc.params.find((p) => p.id === id)?.expr;

describe('DocService.settled', () => {
  it('resolves with the shown rebuild once the model is built', async () => {
    const { doc } = await open();
    block(doc);
    const r = await doc.settled();
    expect(r).toBe(doc.state.get().rebuild);
    expect(r.status).toBe('done');
    expect(volumes(r)).toEqual([8000]);
    // Built and idle: at once.
    expect(await doc.settled()).toBe(r);
  });

  it('an old result published just before the next request does not resolve it', async () => {
    const { doc, kernel } = await open();
    const h = doc.addParam({ name: 'h', expr: '20', quantity: 'length' }) as ParamId;
    block(doc, BLIND('h'));
    await doc.settled();
    // The rebuild for h = 30 is held at its tessellation: its features are built...
    const first = kernel.hold('tessellate');
    expect(doc.updateParam(h, { expr: '30' })).toEqual({ ok: true });
    await first.reached;
    // ...and h = 40 is asked for meanwhile (held at its own tessellation).
    const second = kernel.hold('tessellate');
    expect(doc.updateParam(h, { expr: '40' })).toEqual({ ok: true });
    // The h = 30 result is published as "done" while the model already says 40.
    let staleDone = false;
    const off = doc.state.subscribe((s) => {
      if (s.rebuild.status === 'done' && s.rebuild.bodies[0]?.volume === 20 * 20 * 30 && exprOf(doc, h) === '40') staleDone = true;
    });
    const w = watch(doc.settled());
    first.release();
    await second.reached;
    await drain();
    off();
    expect(staleDone).toBe(true);
    expect(w.done).toBe(false);
    second.release();
    await vi.waitFor(() => expect(w.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(w.error).toBeNull();
    expect(w.value!.status).toBe('done');
    expect(volumes(w.value!)).toEqual([20 * 20 * 40]);
  });

  it('an undo back to the shown model while a rebuild runs: it waits until the engine is idle', async () => {
    const { doc, kernel } = await open();
    const h = doc.addParam({ name: 'h', expr: '20', quantity: 'length' }) as ParamId;
    block(doc, BLIND('h'));
    const shown = await doc.settled();
    const held = kernel.hold('tessellate');
    expect(doc.updateParam(h, { expr: '30' })).toEqual({ ok: true });
    await held.reached;
    // Undo puts back the very document the shown result was built from, while h = 30 still builds.
    doc.undo();
    expect(exprOf(doc, h)).toBe('20');
    const w = watch(doc.settled());
    await drain();
    expect(doc.state.get().rebuild.status).toBe('running');
    expect(w.done).toBe(false);
    held.release();
    await vi.waitFor(() => expect(w.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(w.error).toBeNull();
    expect(w.value!.status).toBe('done');
    expect(w.value!.seq).toBeGreaterThan(shown.seq + 1);
    expect(volumes(w.value!)).toEqual([8000]);
  });

  it('asked for in the change itself, before its rebuild is requested: the old result does not count', async () => {
    const { doc } = await open();
    const h = doc.addParam({ name: 'h', expr: '20', quantity: 'length' }) as ParamId;
    const { extrude } = block(doc, BLIND('h'));
    await doc.settled();
    // A listener of the model asks while the new model is set and the engine is idle.
    let onModel: ReturnType<typeof watch<RebuildState>> | null = null;
    let onBar: ReturnType<typeof watch<RebuildState>> | null = null;
    const off = doc.state.subscribe((s, prev) => {
      if (s.doc !== prev.doc && !onModel) onModel = watch(doc.settled());
      if (s.view.rollback !== prev.view.rollback && !onBar) onBar = watch(doc.settled());
    });
    expect(doc.updateParam(h, { expr: '30' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(onModel?.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(volumes(onModel!.value!)).toEqual([20 * 20 * 30]);
    // The rollback bar moves (the view is set, then its rebuild requested).
    doc.setRollback(1);
    await vi.waitFor(() => expect(onBar?.done).toBe(true), { timeout: 10_000, interval: 5 });
    off();
    expect(onBar!.value!.features[extrude]).toEqual({ state: 'rolled-back' });
    expect(onBar!.value!.bodies).toEqual([]);
  });

  it('a new Part: asked for once it is ready, before its first rebuild, it waits for that rebuild', async () => {
    const ws = createFakeWorkspace();
    const doc = createDocService({ bridge: createBridge(ws), kernel: new HeldKernel(), bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
    registerSolidFeatures(doc);
    services.push(doc);
    // A new Part is stored first (an await), then rebuilt: ready with nothing built yet.
    let early: ReturnType<typeof watch<RebuildState>> | null = null;
    const off = doc.state.subscribe((s, prev) => {
      if (s.status === 'ready' && prev.status !== 'ready' && !early) early = watch(doc.settled());
    });
    await doc.load();
    off();
    await vi.waitFor(() => expect(early?.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(early!.error).toBeNull();
    expect(early!.value!.status).toBe('done');
  });

  it('a bodiesAtEnd build holding the engine: it waits for the rebuild of the model itself', async () => {
    const { doc, kernel } = await open();
    const h1 = doc.addParam({ name: 'h1', expr: '20', quantity: 'length' }) as ParamId;
    const h2 = doc.addParam({ name: 'h2', expr: '20', quantity: 'length' }) as ParamId;
    block(doc, BLIND('h1'));
    block(doc, { at: [50, 0, 0], ...BLIND('h2') });
    await doc.settled();
    // Block 2 rolled back, then made taller: the shown rebuild has nothing to build for it.
    doc.setRollback(2);
    expect(doc.updateParam(h2, { expr: '30' })).toEqual({ ok: true });
    expect(volumes(await doc.settled())).toEqual([8000]);
    // The export's build of the whole history makes block 2 at h2 = 30: held there.
    const held = kernel.hold('extrude_regions');
    const end = doc.bodiesAtEnd();
    await held.reached;
    expect(doc.updateParam(h1, { expr: '30' })).toEqual({ ok: true });
    const w = watch(doc.settled());
    await drain();
    // No onStart while bodiesAtEnd holds the engine: the old "done" is still shown.
    expect(doc.state.get().rebuild.status).toBe('done');
    expect(volumes(doc.state.get().rebuild)).toEqual([8000]);
    expect(w.done).toBe(false);
    held.release();
    expect((await end).bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    await vi.waitFor(() => expect(w.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(w.error).toBeNull();
    expect(volumes(w.value!)).toEqual([20 * 20 * 30]);
  });

  it('while a sketch is edited it resolves on the isolated build, after it on the whole one', async () => {
    const { doc } = await open();
    const { sketch, extrude } = block(doc);
    await doc.settled();
    const s = doc.beginEdit(sketch);
    const iso = await doc.settled();
    expect(iso.features[sketch]).toMatchObject({ state: 'ok' });
    expect(iso.features[extrude]).toEqual({ state: 'rolled-back' });
    expect(iso.bodies).toEqual([]);
    s.commit();
    const whole = await doc.settled();
    expect(whole.features[extrude]).toMatchObject({ state: 'ok' });
    expect(volumes(whole)).toEqual([8000]);
  });

  it('a respawn mid-build: it resolves after the rebuild that follows, on live shapes', async () => {
    const { doc, kernel } = await open();
    const h = doc.addParam({ name: 'h', expr: '20', quantity: 'length' }) as ParamId;
    block(doc, BLIND('h'));
    await doc.settled();
    const call = kernel.hold('extrude_regions');
    expect(doc.updateParam(h, { expr: '30' })).toEqual({ ok: true });
    await call.reached;
    // The worker dies under the build; the new one is held before it is ready.
    const restart = kernel.holdRespawn();
    void kernel.restart('crash: test');
    await restart.reached;
    const w = watch(doc.settled());
    // The held call finds its worker gone: the build is cut short and the engine goes idle.
    call.release();
    await drain();
    expect(w.done).toBe(false);
    restart.release();
    await vi.waitFor(() => expect(w.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(w.error).toBeNull();
    expect(kernel.status.get().respawns).toBe(1);
    expect(volumes(w.value!)).toEqual([20 * 20 * 30]);
    expect(kernel.live()).toContain(w.value!.bodies[0].shape);
  });

  it('a respawn while idle: the shown shapes died, so it waits for the rebuild that follows', async () => {
    const { doc, kernel } = await open();
    block(doc);
    const before = await doc.settled();
    const restart = kernel.holdRespawn();
    void kernel.restart('memory recycle');
    await restart.reached;
    const w = watch(doc.settled());
    await drain();
    // Nothing rebuilds and the model did not change, but every shape id of the shown result died.
    expect(kernel.live()).not.toContain(before.bodies[0].shape);
    expect(w.done).toBe(false);
    restart.release();
    await vi.waitFor(() => expect(w.done).toBe(true), { timeout: 10_000, interval: 5 });
    expect(w.error).toBeNull();
    expect(w.value!.seq).toBeGreaterThan(before.seq);
    expect(kernel.live()).toContain(w.value!.bodies[0].shape);
  });

  it('rejects when its signal aborts, at once when it already did; the rebuild goes on', async () => {
    const { doc, kernel } = await open();
    block(doc);
    await doc.settled();
    const held = kernel.hold('extrude_regions');
    block(doc, { at: [50, 0, 0] });
    await held.reached;
    const ac = new AbortController();
    const w = watch(doc.settled(ac.signal));
    ac.abort();
    await drain();
    expect(w.done).toBe(true);
    expect(w.error).toBe(ac.signal.reason);
    await expect(doc.settled(ac.signal)).rejects.toBe(ac.signal.reason);
    held.release();
    expect(volumes(await doc.settled())).toEqual([8000, 8000]);
  });

  it('rejects when the part is loaded again, or closed', async () => {
    const { doc } = await open();
    block(doc);
    // The rebuild of that block has not run yet (it is asked for, not built).
    const reloaded = watch(doc.settled());
    const load = doc.load();
    await drain();
    expect(reloaded.error).toBeInstanceOf(Error);
    expect((reloaded.error as Error).message).toBe('the part was loaded again');
    await load;
    await doc.settled();
    block(doc, { at: [50, 0, 0] });
    const closed = watch(doc.settled());
    doc.dispose();
    await drain();
    expect((closed.error as Error).message).toBe('the part was closed');
    await expect(doc.settled()).rejects.toThrow('the part was closed');
  });

  it('rejects at once on a part that could not be read', async () => {
    const ws = createFakeWorkspace({ study: { doc: { rel: 'studies/st-test/model.json', schema: 1, store: 'data', view: 'studies/st-test/view.json' } } });
    ws.folder.putJson('studies/st-test/model.json', { format: 'magnusim-cad/model', etag: '3.x', saved_at: '', doc: { schema: 3, units: {}, features: [] } });
    const doc = createDocService({ bridge: createBridge(ws), kernel: new HeldKernel(), bus: createBus<CadEvents>(), saveIntervalMs: 20, log: () => {} });
    services.push(doc);
    const during = watch(doc.settled());
    await doc.load();
    expect(doc.state.get().status).toBe('error');
    // A wait begun before the load began ends with it ("loaded again"); one begun after, with the reason.
    expect((during.error as Error).message).toBe('the part was loaded again');
    await expect(doc.settled()).rejects.toThrow(/newer Magnusim CAD/);
  });

  it('needs no timer: with the clock frozen it still resolves', async () => {
    const { doc } = await open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date'] });
    block(doc);
    const r = await doc.settled();
    expect(volumes(r)).toEqual([8000]);
  });
});
