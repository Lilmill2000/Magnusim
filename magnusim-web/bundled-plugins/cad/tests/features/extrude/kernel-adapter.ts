// The real kernel behind the real KernelAdapter, in Node (tests/doc/
// inprocess-kernel.ts, with the kernel directory the kernel tests use:
// workspace/kernel, or CAD_KERNEL_DIR for another build, e.g. a kernel
// builder's development build before it ships).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createKernel, KernelError, type Kernel } from '../../../src/kernel-worker/kernel-api';
import { createKernelAdapter } from '../../../src/kernel';
import type { KernelCallMsg, KernelWorkerMsg } from '../../../src/types/kernel-protocol';
import { KERNEL_DIR } from '../../kernel/kernel-lib';

const MODULE = pathToFileURL(join(KERNEL_DIR, 'mk32.mjs')).href;
let wasm: Uint8Array | null = null;

class InProcessWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private kernel: Kernel | null = null;
  private queue: KernelCallMsg[] = [];
  private dead = false;
  /** Every op the page sent (for cache checks). */
  readonly ops: string[] = [];

  constructor() {
    wasm ??= readFileSync(join(KERNEL_DIR, 'mk32.wasm'));
    const t0 = performance.now();
    createKernel({ moduleUrl: MODULE, wasmBinary: wasm }).then(
      (k) => {
        this.kernel = k;
        this.post({ type: 'ready', variant: 'wasm32', occt: k.version.occt, init_ms: performance.now() - t0, heap_bytes: k.heapBytes() });
        for (const m of this.queue.splice(0)) this.handle(m);
      },
      (e: unknown) => this.post({ type: 'fatal', error: String(e) }),
    );
  }

  private post(m: KernelWorkerMsg) {
    setTimeout(() => {
      if (!this.dead) this.onmessage?.({ data: m } as MessageEvent);
    }, 0);
  }

  postMessage(m: KernelCallMsg) {
    if (this.dead) return;
    this.ops.push(m.op);
    if (!this.kernel) this.queue.push(m);
    else setTimeout(() => this.handle(m), 0);
  }

  private handle(msg: KernelCallMsg) {
    if (this.dead) return;
    const k = this.kernel!;
    const t = performance.now();
    const params: Record<string, unknown> = { ...(msg.params || {}) };
    try {
      if (msg.bytes) Object.assign(params, k.putBytes(new Uint8Array(msg.bytes)));
      const r = k.tryCall(msg.op, params);
      if (!r.ok) {
        this.post({ type: 'result', id: msg.id, ok: false, error: { message: r.error ?? 'failed', kind: r.kind ?? 'internal', oom: !!r.oom, low_memory: !!r.low_memory }, ms: performance.now() - t, heap_bytes: k.heapBytes() });
        return;
      }
      const taken = k.takeBuffers(r);
      const buffers: Record<string, ArrayBuffer> = {};
      for (const [name, arr] of Object.entries(taken)) buffers[name] = arr.buffer as ArrayBuffer;
      const { ok: _ok, buffers: _b, ...result } = r;
      this.post({ type: 'result', id: msg.id, ok: true, result, buffers, ms: performance.now() - t, heap_bytes: k.heapBytes() });
    } catch (e) {
      const err = e instanceof KernelError ? e : null;
      this.post({ type: 'result', id: msg.id, ok: false, error: { message: String(e instanceof Error ? e.message : e), kind: err ? err.kind : 'internal', oom: !!err?.oom }, ms: 0, heap_bytes: 0 });
    }
  }

  terminate() {
    this.dead = true;
  }
}

/** A real KernelAdapter over the real kernel, in Node. */
export function realKernelAdapter() {
  const workers: InProcessWorker[] = [];
  const kernel = createKernelAdapter({
    workerUrl: 'file:///kernel-worker.js',
    spawn: () => {
      const w = new InProcessWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
  });
  return { kernel, workers };
}
