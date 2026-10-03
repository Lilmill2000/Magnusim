// The real kernel behind the real KernelAdapter, in-process, from any test
// environment (jsdom included: its import.meta.url is not a file URL, so the
// paths come from the plugin folder, the test's working directory). The same
// steps as tests/doc/inprocess-kernel.ts. CAD_P2_KERNEL_DIR points at another
// build of mk32.mjs + mk32.wasm (a kernel in development) for these tests only.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKernel, KernelError, type Kernel } from '../../../src/kernel-worker/kernel-api';
import { createKernelAdapter } from '../../../src/kernel';
import type { KernelCallMsg, KernelWorkerMsg } from '../../../src/types/kernel-protocol';

const ROOT = process.cwd();
const DIR = process.env.CAD_P2_KERNEL_DIR ? resolve(process.env.CAD_P2_KERNEL_DIR) : resolve(ROOT, 'workspace/kernel');
const MODULE = pathToFileURL(resolve(DIR, 'mk32.mjs')).href;
let wasm: Uint8Array | null = null;

class Worker0 {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private kernel: Kernel | null = null;
  private queue: KernelCallMsg[] = [];
  private dead = false;

  constructor() {
    wasm ??= readFileSync(resolve(DIR, 'mk32.wasm'));
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

export function realKernelAnywhere() {
  return createKernelAdapter({ workerUrl: 'file:///kernel-worker.js', spawn: () => new Worker0() as unknown as Worker });
}
