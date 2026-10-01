// The kernel worker module (built to workspace/kernel/kernel-worker.js).
// Started with ws.spawnWorker(url), which runs a classic blob worker that
// import()s this module; import.meta.url is this file's real URL, so the
// Emscripten module and its .wasm load from the same folder.
// Protocol: src/types/kernel-protocol.ts. One call at a time, in order.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createKernel, KernelError, type Kernel } from './kernel-api';
import type { KernelCallMsg, KernelErrorInfo, KernelResultMsg, KernelWorkerMsg } from '../types/kernel-protocol';

declare const self: {
  postMessage(msg: KernelWorkerMsg, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void;
};

const t0 = performance.now();
const queue: KernelCallMsg[] = [];
let kernel: Kernel | null = null;

function heap(): number {
  try {
    return kernel ? kernel.heapBytes() : 0;
  } catch {
    return 0;
  }
}

function fail(id: number, started: number, error: KernelErrorInfo) {
  const msg: KernelResultMsg = { type: 'result', id, ok: false, error, ms: performance.now() - started, heap_bytes: heap() };
  self.postMessage(msg);
}

function handle(msg: KernelCallMsg) {
  const started = performance.now();
  const k = kernel!;
  const params: Record<string, unknown> = { ...(msg.params || {}) };
  try {
    if (msg.bytes) {
      const { ptr, len } = k.putBytes(new Uint8Array(msg.bytes));
      params.ptr = ptr;
      params.len = len;
    }
    const r = k.tryCall(msg.op, params);
    if (!r.ok) {
      fail(msg.id, started, { message: r.error ?? 'failed', kind: r.kind ?? 'internal', oom: !!r.oom, low_memory: !!r.low_memory });
      return;
    }
    const taken = k.takeBuffers(r);
    const buffers: Record<string, ArrayBuffer> = {};
    const transfer: ArrayBuffer[] = [];
    for (const [name, arr] of Object.entries(taken)) {
      buffers[name] = arr.buffer as ArrayBuffer;
      transfer.push(arr.buffer as ArrayBuffer);
    }
    const { ok: _ok, buffers: _b, ...result } = r;
    const reply: KernelResultMsg = { type: 'result', id: msg.id, ok: true, result, buffers, ms: performance.now() - started, heap_bytes: heap() };
    self.postMessage(reply, transfer);
  } catch (e) {
    const err = e instanceof KernelError ? e : null;
    fail(msg.id, started, {
      message: String(e instanceof Error ? e.message : e),
      kind: err ? err.kind : 'internal',
      oom: !!(err && err.oom),
    });
  }
}

// Listen at once; calls wait in `queue` until the kernel is ready.
self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as KernelCallMsg | null;
  if (!msg || msg.type !== 'call') return;
  if (kernel) handle(msg);
  else queue.push(msg);
});

// The Emscripten module sits next to this file (workspace/kernel/). A variable,
// not a literal, so the bundler leaves the URL to be resolved at run time.
const EM_MODULE = 'mk32.mjs';
createKernel({ moduleUrl: new URL(EM_MODULE, import.meta.url).href })
  .then((k) => {
    kernel = k;
    self.postMessage({ type: 'ready', variant: 'wasm32', occt: k.version.occt, init_ms: performance.now() - t0, heap_bytes: heap() });
    while (queue.length) handle(queue.shift()!);
  })
  .catch((e: unknown) => {
    self.postMessage({ type: 'fatal', error: String(e instanceof Error ? e.message : e) });
  });
