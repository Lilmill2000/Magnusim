// The kernel adapter over a scripted worker: ready handshake, queueing,
// watchdog respawn, trap respawn, the `valid` check on shape ops.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelAdapter } from '../../src/kernel';
import { FakeWorker, okHandler, type CallHandler } from '../fakes/fake-worker';

function adapterWith(handler: CallHandler, { autoReady = true } = {}) {
  const workers: FakeWorker[] = [];
  const kernel = createKernelAdapter({
    workerUrl: 'http://x/plugins/cad/workspace/kernel/kernel-worker.js',
    spawn: () => {
      const w = new FakeWorker(handler);
      workers.push(w);
      if (autoReady) w.ready();
      return w as unknown as Worker;
    },
  });
  return { kernel, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('KernelAdapter', () => {
  it('holds calls until the worker says ready, then runs them in order', async () => {
    const { kernel, workers } = adapterWith(okHandler({ version: { occt: '7.9.3', build: 'wasm32' } }), { autoReady: false });
    const started = kernel.start();
    const call = kernel.call('version', {});
    expect(kernel.status.get().state).toBe('starting');
    await Promise.resolve();
    expect(workers[0].received).toHaveLength(0);
    workers[0].ready();
    const info = await started;
    expect(info.occt).toBe('7.9.3');
    expect((await call).result).toEqual({ occt: '7.9.3', build: 'wasm32' });
    expect(kernel.status.get().state).toBe('ready');
  });

  it('checks shape results that do not report valid', async () => {
    const { kernel, workers } = adapterWith(okHandler({ box: { id: 7 }, check: { valid: true, check_ms: 0 } }));
    await kernel.start();
    const r = await kernel.call('box', { dx: 1, dy: 2, dz: 3 });
    expect(r.result).toEqual({ id: 7, valid: true });
    expect(workers[0].received.map((m) => m.op)).toEqual(['box', 'check']);
  });

  it('stops a call at its timeout, respawns the worker and tells listeners', async () => {
    const hang: CallHandler = (msg, reply) => {
      if (msg.op !== 'props') reply({ type: 'result', id: msg.id, ok: true, result: {}, buffers: {}, ms: 1, heap_bytes: 1 });
    };
    const { kernel, workers } = adapterWith(hang);
    await kernel.start();
    const respawned = vi.fn();
    kernel.onRespawn(respawned);
    const err = await kernel.call('props', { id: 1 }, { timeoutMs: 30 }).catch((e) => e);
    expect(err.kind).toBe('watchdog');
    expect(String(err.message)).toMatch(/^props was stopped after \d+\.\d s$/);
    expect(workers[0].terminated).toBe(true);
    await vi.waitFor(() => expect(kernel.status.get().state).toBe('ready'));
    expect(workers).toHaveLength(2);
    expect(respawned).toHaveBeenCalledWith(expect.stringMatching(/props was stopped/));
    expect(kernel.status.get().respawns).toBe(1);
  });

  it('respawns after a trap and rejects the call with kind trap', async () => {
    const trap: CallHandler = (msg, reply) =>
      reply({ type: 'result', id: msg.id, ok: false, error: { message: 'unreachable', kind: 'trap' }, ms: 1, heap_bytes: 1 });
    const { kernel, workers } = adapterWith(trap);
    await kernel.start();
    const err = await kernel.call('box', { dx: 1, dy: 1, dz: 1 }).catch((e) => e);
    expect(err.kind).toBe('trap');
    await vi.waitFor(() => expect(workers).toHaveLength(2));
  });

  it('respawns after an out-of-memory result (the heap never shrinks) and says so', async () => {
    const oom: CallHandler = (msg, reply) =>
      msg.op === 'import_step'
        ? reply({ type: 'result', id: msg.id, ok: false, error: { message: 'out of memory', kind: 'internal', oom: true }, ms: 1, heap_bytes: 4e9 })
        : reply({ type: 'result', id: msg.id, ok: true, result: {}, buffers: {}, ms: 1, heap_bytes: 1 });
    const { kernel, workers } = adapterWith(oom);
    await kernel.start();
    const respawned = vi.fn();
    kernel.onRespawn(respawned);
    const err = await kernel.call('import_step', { name: 'big.step' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'internal', oom: true });
    await vi.waitFor(() => expect(respawned).toHaveBeenCalledWith('the kernel ran out of memory in import_step'));
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
  });

  it('per-op timeouts can be configured; a queued call is dropped with kind restarted on respawn', async () => {
    const hang: CallHandler = (msg, reply) => {
      if (msg.op !== 'box') reply({ type: 'result', id: msg.id, ok: true, result: {}, buffers: {}, ms: 1, heap_bytes: 1 });
    };
    const workers: FakeWorker[] = [];
    const kernel = createKernelAdapter({
      workerUrl: 'http://x/k.js',
      timeouts: { box: 40 },
      spawn: () => {
        const w = new FakeWorker(hang);
        workers.push(w);
        w.ready();
        return w as unknown as Worker;
      },
    });
    await kernel.start();
    const first = kernel.call('box', { dx: 1, dy: 1, dz: 1 }).catch((e) => e);
    const queued = kernel.call('version', {}).catch((e) => e);
    expect((await first).kind).toBe('watchdog');
    expect((await first).message).toMatch(/^box was stopped after 0\.\d s$/);
    expect((await queued).kind).toBe('restarted');
  });

  it('tracks the heap and recycles an oversized worker once (no loop)', async () => {
    let heap = 1.5e9;
    const h: CallHandler = (msg, reply) => reply({ type: 'result', id: msg.id, ok: true, result: {}, buffers: {}, ms: 1, heap_bytes: heap });
    const { kernel, workers } = adapterWith(h);
    await kernel.start();
    await kernel.call('version', {});
    expect(kernel.status.get().heap_bytes).toBe(1.5e9);
    expect(await kernel.recycleIfLarge()).toBe(true);
    await vi.waitFor(() => expect(kernel.status.get().state).toBe('ready'));
    expect(workers).toHaveLength(2);
    // The fresh worker grows past the threshold again: no second recycle, the chip may say why.
    await kernel.call('version', {});
    expect(await kernel.recycleIfLarge()).toBe(false);
    expect(kernel.status.get().memory_high).toBe(true);
    expect(workers).toHaveLength(2);
    heap = 1e8;
    await kernel.call('version', {});
    expect(await kernel.recycleIfLarge()).toBe(false);
    expect(kernel.status.get().memory_high).toBe(false);
  });

  it('reports a worker that fails to start, and restart() tries again', async () => {
    let n = 0;
    const kernel = createKernelAdapter({
      workerUrl: 'http://x/k.js',
      spawn: () => {
        const w = new FakeWorker(okHandler());
        if (n++ === 0) w.send({ type: 'fatal', error: 'CompileError: bad wasm' });
        else w.ready();
        return w as unknown as Worker;
      },
    });
    await expect(kernel.start()).rejects.toThrow(/bad wasm/);
    expect(kernel.status.get()).toMatchObject({ state: 'failed', message: 'The kernel failed to start: CompileError: bad wasm' });
    await kernel.restart('Retry');
    expect(kernel.status.get().state).toBe('ready');
  });
});
