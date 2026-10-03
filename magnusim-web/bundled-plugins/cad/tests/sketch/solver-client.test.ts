// The solver worker's main-thread client (src/sketch/solver-client.ts): it
// starts the worker on first use, holds calls until "ready", says plainly when
// the worker cannot start, ends a worker that stops answering and starts a
// fresh one for the next call, and sends the rebuild's re-solve as solveOnce
// with the sketch as the solver takes it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createSolverClient } from '../../src/sketch/solver-client';
import { sketchOf, rectangle } from './fixtures';

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
