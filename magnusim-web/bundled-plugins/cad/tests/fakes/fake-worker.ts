// A scripted stand-in for the kernel worker (tests of the main-thread client).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelCallMsg, KernelWorkerMsg } from '../../src/types/kernel-protocol';

export type CallHandler = (msg: KernelCallMsg, reply: (m: KernelWorkerMsg) => void) => void;

export class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  received: KernelCallMsg[] = [];

  constructor(private readonly handler: CallHandler) {}

  /** Deliver a worker -> main message (async, like a real worker). */
  send(m: KernelWorkerMsg) {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: m } as MessageEvent);
    });
  }

  ready(occt = '7.9.3') {
    this.send({ type: 'ready', variant: 'wasm32', occt, init_ms: 1, heap_bytes: 64 << 20 });
  }

  postMessage(m: KernelCallMsg) {
    if (this.terminated) return;
    this.received.push(m);
    this.handler(m, (r) => this.send(r));
  }

  terminate() {
    this.terminated = true;
  }

  crash(message = 'boom') {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

/** A handler that answers every call ok with `result` (or per-op results). */
export function okHandler(results: Record<string, Record<string, unknown>> = {}): CallHandler {
  return (msg, reply) => reply({ type: 'result', id: msg.id, ok: true, result: results[msg.op] ?? {}, buffers: {}, ms: 1, heap_bytes: 1 });
}
