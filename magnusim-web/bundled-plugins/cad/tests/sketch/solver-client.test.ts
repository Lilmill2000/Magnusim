// @vitest-environment node
// The solver worker's main-thread client (src/sketch/solver-client.ts): it
// starts the worker on first use, holds calls until "ready", says plainly when
// the worker cannot start, ends a worker that stops answering and starts a
// fresh one for the next call, and sends the rebuild's re-solve as solveOnce
// with the sketch as the solver takes it. The headless analysis
// (analyzeFeature -> the worker's analyzeOnce) runs on the real worker module
// (src/solver-worker/solver-worker.mjs, here in this process over the shipped
// wasm): the free parameters of a sketch apart, and the sketch sketch mode has
// loaded is left as it was.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSolverClient } from '../../src/sketch/solver-client';
import { toSolverSketch } from '../../src/sketch/model';
import type { SketchFeature } from '../../src/types/doc';
import { sketchOf, rectangle } from './fixtures';

// The worker module finds planegcs.mjs next to itself once built (workspace/solver/); from src/ it
// is given the shipped one.
vi.mock('../../src/solver-worker/solver-api.mjs', async (importOriginal) => {
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const real = await importOriginal<{ createSolver(o: { moduleUrl: string }): Promise<unknown> }>();
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../../workspace/solver/planegcs.mjs', import.meta.url))).href;
  return { ...real, createSolver: () => real.createSolver({ moduleUrl }) };
});

type Msg = { type: string; id?: number; op?: string; params?: unknown[] };

class FakeSolverWorker {
  sent: Msg[] = [];
  terminated = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor(private readonly answer: (m: Msg) => unknown | 'hang') {}
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(data: unknown) {
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
  postMessage(m: Msg) {
    this.sent.push(m);
    const r = this.answer(m);
    if (r === 'hang') return;
    queueMicrotask(() => this.emit({ type: 'result', id: m.id, ok: true, result: r }));
  }
  terminate() {
    this.terminated = true;
  }
}

describe('solver client', () => {
  it('starts the worker on first use and holds calls until it is ready', async () => {
    const workers: FakeSolverWorker[] = [];
    const client = createSolverClient({
      url: 'x/solver-worker.js',
      spawn: () => {
        const w = new FakeSolverWorker((m) => ({ op: m.op, params: m.params }));
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    expect(workers).toHaveLength(0);
    const p = client.solve();
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toHaveLength(0);
    workers[0].emit({ type: 'ready', solver: 'planegcs' });
    expect(await p).toEqual({ op: 'solve', params: [] });
    // The rebuild's re-solve: the solver's own sketch, the origin locked, the dimension values given.
    const f = sketchOf({ ...rectangle(0, 0, 40, 20), constraints: [{ id: 'd', kind: 'distance', refs: ['e1'], expr: '40 mm', driving: true }] });
    const r = (await client.solveFeature(f, { d: 50 })) as unknown as { op: string; params: { constraints: { id: string; value?: unknown }[] }[] };
    expect(r.op).toBe('solveOnce');
    expect(r.params[0].constraints.map((c) => [c.id, c.value])).toEqual([
      ['#origin', [0, 0]],
      ['d', 50],
    ]);
    client.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  it('says why when the worker cannot start, and tries again on the next call', async () => {
    const workers: FakeSolverWorker[] = [];
    const client = createSolverClient({
      url: 'x',
      spawn: () => {
        const w = new FakeSolverWorker(() => 'ok');
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    const p = client.analyze();
    workers[0].emit({ type: 'error', error: 'wasm failed to compile' });
    await expect(p).rejects.toThrow('the sketch solver could not start: wasm failed to compile');
    const q = client.analyze();
    expect(workers).toHaveLength(2);
    workers[1].emit({ type: 'ready' });
    await expect(q).resolves.toBe('ok');
    expect(client.starts).toBe(2);
  });

  it('ends a worker that stops answering; the next call gets a fresh one', async () => {
    const workers: FakeSolverWorker[] = [];
    const client = createSolverClient({
      url: 'x',
      callTimeoutMs: 30,
      spawn: () => {
        const w = new FakeSolverWorker((m) => (workers.length === 1 && m.op === 'analyze' ? 'hang' : 'ok'));
        workers.push(w);
        queueMicrotask(() => w.emit({ type: 'ready' }));
        return w as unknown as Worker;
      },
    });
    await expect(client.analyze()).rejects.toThrow('the sketch solver stopped answering (analyze took more than 0 s)');
    expect(workers[0].terminated).toBe(true);
    await expect(client.solve()).resolves.toBe('ok');
    expect(workers).toHaveLength(2);
  });
});

type Listener = (ev: { data: unknown }) => void;

/**
 * The real worker module in this process: `self` is the worker's side of a message channel whose
 * other side is the Worker the client gets (messages are copied both ways, as postMessage does).
 */
function inProcessWorker(): () => Worker {
  const inWorker: Listener[] = [];
  const inPage: Listener[] = [];
  vi.stubGlobal('self', {
    postMessage: (data: unknown) => queueMicrotask(() => inPage.forEach((fn) => fn({ data: structuredClone(data) }))),
    addEventListener: (type: string, fn: Listener) => void (type === 'message' && inWorker.push(fn)),
  });
  return () => {
    const w = {
      postMessage: (data: unknown) => queueMicrotask(() => inWorker.forEach((fn) => fn({ data: structuredClone(data) }))),
      addEventListener: (type: string, fn: Listener) => void (type === 'message' && inPage.push(fn)),
      terminate() {},
    };
    // The module starts the solver and posts ready once it has (the client is listening by then).
    void import('../../src/solver-worker/solver-worker.mjs' as string);
    return w as unknown as Worker;
  };
}

describe('the headless analysis (analyzeOnce)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends analyzeOnce with the sketch as the solver takes it', async () => {
    const sent: Msg[] = [];
    const client = createSolverClient({
      url: 'x',
      spawn: () => {
        const w = new FakeSolverWorker((m) => (sent.push(m), { solve: {}, analysis: {} }));
        queueMicrotask(() => w.emit({ type: 'ready' }));
        return w as unknown as Worker;
      },
    });
    const f = sketchOf({ ...rectangle(0, 0, 40, 20), constraints: [{ id: 'd', kind: 'distance', refs: ['e1'], expr: '40 mm', driving: true }] });
    await client.analyzeFeature(f, { d: 50 });
    expect(sent.map((m) => m.op)).toEqual(['analyzeOnce']);
    expect(sent[0].params).toEqual([toSolverSketch(f, { d: 50 })]);
    client.dispose();
  });

  it('gives the free parameters of a sketch apart, and never changes the sketch sketch mode has loaded', async () => {
    const client = createSolverClient({ url: 'in-process', spawn: inProcessWorker(), readyTimeoutMs: 60_000, callTimeoutMs: 60_000 });
    // Sketch mode's sketch: a 40 x 20 rectangle at the origin, both sides dimensioned (fully defined).
    const dims = (w: number, h: number): SketchFeature['constraints'] => [
      { id: 'dw', kind: 'distance', refs: ['e1'], expr: `${w} mm`, driving: true },
      { id: 'dh', kind: 'distance', refs: ['e2'], expr: `${h} mm`, driving: true },
    ];
    const rect = rectangle(0, 0, 40, 20, { origin: true });
    const edited = sketchOf({ ...rect, constraints: [...rect.constraints, ...dims(40, 20)] });
    await client.load(toSolverSketch(edited, { dw: 40, dh: 20 }));
    const loaded = await client.solve();
    expect(loaded.solved).toBe(true);
    expect((await client.analyze()).dof).toBe(0);

    // Another sketch, apart: a 12 x 8 rectangle anchored at the origin, its sides free (2 DOF).
    const other = sketchOf(rectangle(0, 0, 12, 8, { origin: true }));
    const r = await client.analyzeFeature(other, {});
    expect(r.solve.solved).toBe(true);
    expect(r.analysis.dof).toBe(2);
    expect(r.analysis.dependentParams.length).toBeGreaterThan(0);
    // Every free parameter names a point of that sketch and a coordinate.
    for (const p of r.analysis.dependentParams) expect(p).toMatch(/^p[1-4].[uv]$/);
    expect(r.analysis.perEntity.e1).toBe('under');
    expect(r.analysis.conflicting).toEqual([]);
    // Over-defined apart: an extra horizontal on the bottom is named.
    const over = sketchOf({ ...rect, constraints: [...rect.constraints, { id: 'hx', kind: 'horizontal', refs: ['e1'] }] });
    const o = await client.analyzeFeature(over, {});
    expect([...o.analysis.redundant, ...o.analysis.conflicting, ...o.solve.redundant, ...o.solve.conflicting].some((id) => id === 'hx' || id === 'h1')).toBe(true);

    // Sketch mode's sketch is as it was: still fully defined, and solving it again gives its own corners.
    const again = await client.analyze();
    expect(again.dof).toBe(0);
    expect(again.dependentParams).toEqual([]);
    const s = await client.solve();
    expect(s.values.points.p3[0]).toBeCloseTo(40, 6);
    expect(s.values.points.p3[1]).toBeCloseTo(20, 6);
    client.dispose();
  }, 60_000);
});
