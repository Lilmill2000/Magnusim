// Main-thread side of the kernel worker: ready handshake, one call in flight at
// a time (so the watchdog times the call, not its wait), wall-clock watchdog,
// terminate + respawn. Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelCallMsg, KernelOp, KernelReadyMsg, KernelWorkerMsg } from '../types/kernel-protocol';
import type { KernelCallError, KernelCallErrorKind, KernelReadyInfo } from '../types/kernel';

export interface WorkerClientOptions {
  name: string;
  /** ws.spawnWorker (through the bridge). */
  spawn: (url: string) => Worker;
  url: string;
  timeoutFor: (op: KernelOp) => number;
  bootTimeoutMs: number;
  /** Lifecycle notifications (state changes, respawns, busy op). */
  onEvent?: (ev: WorkerClientEvent) => void;
}

export type WorkerClientEvent =
  | { type: 'starting'; gen: number }
  | { type: 'ready'; info: KernelReadyInfo }
  | { type: 'failed'; message: string }
  | { type: 'respawn'; reason: string; count: number }
  | { type: 'busy'; op: KernelOp | null };

interface Pending {
  id: number;
  op: KernelOp;
  params: Record<string, unknown>;
  bytes: ArrayBuffer | null;
  timeoutMs: number;
  resolve: (v: { result: Record<string, unknown>; buffers: Record<string, ArrayBuffer>; ms: number; wall_ms: number; heap_bytes: number }) => void;
  reject: (e: KernelCallError) => void;
  sentAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

function cancelError(op: KernelOp): KernelCallError {
  const e = callError(`${op} was cancelled`, 'cancelled', op);
  e.name = 'AbortError';
  return e;
}

function callError(message: string, kind: KernelCallErrorKind, op: KernelOp, extra: Partial<KernelCallError> = {}): KernelCallError {
  return Object.assign(new Error(message), { kind, op, ...extra }) as KernelCallError;
}

export class WorkerClient {
  private gen = 0;
  private nextId = 0;
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private worker: Worker | null = null;
  private ready = false;
  private boot: { resolve: (i: KernelReadyInfo) => void; reject: (e: Error) => void; gen: number } | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private failed: string | null = null;
  private disposed = false;
  respawns = 0;
  readyInfo: KernelReadyInfo | null = null;
  private startP: Promise<KernelReadyInfo> | null = null;

  constructor(private readonly opts: WorkerClientOptions) {}

  private emit(ev: WorkerClientEvent) {
    try {
      this.opts.onEvent?.(ev);
    } catch (err) {
      console.error('[cad] kernel event handler failed', err);
    }
  }

  /** Spawn (once); resolves on `ready`. */
  start(): Promise<KernelReadyInfo> {
    if (this.startP && !this.failed) return this.startP;
    this.startP = this.spawn();
    return this.startP;
  }

  private spawn(): Promise<KernelReadyInfo> {
    const gen = ++this.gen;
    this.ready = false;
    this.failed = null;
    this.readyInfo = null;
    const t0 = performance.now();
    this.emit({ type: 'starting', gen });
    const p = new Promise<KernelReadyInfo>((resolve, reject) => {
      this.boot = { resolve, reject, gen };
    });
    p.catch(() => {});
    this.bootTimer = setTimeout(() => {
      if (gen === this.gen && !this.ready) this.failBoot(gen, `The kernel did not start within ${Math.round(this.opts.bootTimeoutMs / 1000)} s`);
    }, this.opts.bootTimeoutMs);
    let w: Worker;
    try {
      w = this.opts.spawn(this.opts.url);
    } catch (e) {
      this.failBoot(gen, `The kernel could not be started: ${e instanceof Error ? e.message : String(e)}`);
      return p;
    }
    this.worker = w;
    w.onmessage = (e: MessageEvent) => this.onMessage(gen, e.data as KernelWorkerMsg, t0);
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      this.onCrash(gen, e.message || 'worker error');
    };
    w.onmessageerror = () => this.onCrash(gen, 'a message could not be read');
    return p;
  }

  private failBoot(gen: number, message: string) {
    if (gen !== this.gen) return;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.failed = message;
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    if (this.boot && this.boot.gen === gen) this.boot.reject(Object.assign(new Error(message), { kind: 'boot' }));
    for (const q of this.queue.splice(0)) q.reject(callError(message, 'boot', q.op));
    this.emit({ type: 'failed', message });
  }

  private onMessage(gen: number, m: KernelWorkerMsg, t0: number) {
    if (gen !== this.gen || !m || typeof m !== 'object') return;
    if (m.type === 'ready') {
      if (this.bootTimer) clearTimeout(this.bootTimer);
      this.ready = true;
      const r = m as KernelReadyMsg;
      this.readyInfo = { occt: r.occt, variant: r.variant, init_ms: r.init_ms, heap_bytes: r.heap_bytes, ready_ms: performance.now() - t0 };
      if (this.boot && this.boot.gen === gen) this.boot.resolve(this.readyInfo);
      this.emit({ type: 'ready', info: this.readyInfo });
      this.pump();
      return;
    }
    if (m.type === 'fatal') {
      this.failBoot(gen, `The kernel failed to start: ${m.error}`);
      return;
    }
    if (m.type === 'result') {
      const req = this.inflight;
      if (!req || req.id !== m.id) return;
      if (req.timer) clearTimeout(req.timer);
      this.inflight = null;
      this.emit({ type: 'busy', op: null });
      const wall = performance.now() - (req.sentAt ?? performance.now());
      if (m.ok) {
        req.resolve({ result: m.result, buffers: m.buffers ?? {}, ms: m.ms, wall_ms: wall, heap_bytes: m.heap_bytes });
        this.pump();
      } else {
        const oom = !!(m.error.oom || m.error.low_memory);
        req.reject(callError(m.error.message, m.error.kind, req.op, { oom }));
        // A trap leaves the wasm instance unusable, and after an allocation
        // failure its heap is at the ceiling (it never shrinks): start over.
        if (m.error.kind === 'trap') void this.respawn(`the kernel stopped in ${req.op}: ${m.error.message}`);
        else if (oom) void this.respawn(`the kernel ran out of memory in ${req.op}`);
        else this.pump();
      }
    }
  }

  private onCrash(gen: number, message: string) {
    if (gen !== this.gen) return;
    if (!this.ready) {
      this.failBoot(gen, `The kernel failed to start: ${message}`);
      return;
    }
    const req = this.inflight;
    this.inflight = null;
    if (req) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(callError(`The kernel crashed during ${req.op}: ${message}`, 'crash', req.op));
    }
    void this.respawn(`crash: ${message}`);
  }

  call(op: KernelOp, params: Record<string, unknown>, opts: { bytes?: ArrayBuffer; timeoutMs?: number; signal?: AbortSignal } = {}) {
    return new Promise<{ result: Record<string, unknown>; buffers: Record<string, ArrayBuffer>; ms: number; wall_ms: number; heap_bytes: number }>((resolve, reject) => {
      if (this.disposed) {
        reject(callError('The kernel is closed', 'restarted', op));
        return;
      }
      if (this.failed) {
        reject(callError(`The kernel is not running: ${this.failed}`, 'boot', op));
        return;
      }
      const signal = opts.signal;
      if (signal?.aborted) {
        reject(cancelError(op));
        return;
      }
      let off = () => {};
      const req: Pending = {
        id: ++this.nextId,
        op,
        params,
        bytes: opts.bytes ?? null,
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutFor(op),
        resolve: (v) => {
          off();
          resolve(v);
        },
        reject: (e) => {
          off();
          reject(e);
        },
      };
      if (signal) {
        const onAbort = () => this.cancel(req);
        signal.addEventListener('abort', onAbort, { once: true });
        off = () => signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(req);
      this.pump();
    });
  }

  /**
   * The caller gave up on `req` (its AbortSignal): a queued call is dropped; the call in
   * flight cannot be interrupted inside the worker, so the worker is terminated and a fresh
   * one started (review P2/P3 round 1: an import's Cancel left the kernel reading a 113 MB
   * file, and the next action waited 36 s for it).
   */
  private cancel(req: Pending) {
    const i = this.queue.indexOf(req);
    if (i >= 0) {
      this.queue.splice(i, 1);
      req.reject(cancelError(req.op));
      return;
    }
    if (this.inflight !== req) return;
    if (req.timer) clearTimeout(req.timer);
    this.inflight = null;
    req.reject(cancelError(req.op));
    void this.respawn(`${req.op} was cancelled`);
  }

  private pump() {
    if (!this.ready || this.inflight || !this.queue.length || !this.worker) return;
    const req = this.queue.shift()!;
    this.inflight = req;
    req.sentAt = performance.now();
    const msg: KernelCallMsg = { type: 'call', id: req.id, op: req.op, params: req.params };
    const transfer: Transferable[] = [];
    if (req.bytes) {
      msg.bytes = req.bytes;
      transfer.push(req.bytes);
    }
    try {
      this.worker.postMessage(msg, transfer);
    } catch (e) {
      this.inflight = null;
      req.reject(callError(`Could not send ${req.op}: ${e instanceof Error ? e.message : String(e)}`, 'internal', req.op));
      this.pump();
      return;
    }
    this.emit({ type: 'busy', op: req.op });
    req.timer = setTimeout(() => this.expire(req), req.timeoutMs);
  }

  private expire(req: Pending) {
    if (this.inflight !== req) return;
    const secs = (performance.now() - (req.sentAt ?? performance.now())) / 1000;
    this.inflight = null;
    const text = `${req.op} was stopped after ${secs.toFixed(1)} s`;
    req.reject(callError(text, 'watchdog', req.op, { seconds: secs }));
    void this.respawn(text);
  }

  /** Terminate and start a fresh worker. Queued calls are dropped (their shape ids died too). */
  respawn(reason: string): Promise<KernelReadyInfo> {
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.respawns += 1;
    for (const q of this.queue.splice(0)) q.reject(callError(`The kernel restarted (${reason}); ${q.op} was dropped`, 'restarted', q.op));
    this.emit({ type: 'busy', op: null });
    this.emit({ type: 'respawn', reason, count: this.respawns });
    this.startP = this.spawn();
    return this.startP;
  }

  dispose() {
    this.disposed = true;
    this.gen++;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.inflight) {
      if (this.inflight.timer) clearTimeout(this.inflight.timer);
      this.inflight.reject(callError('The kernel is closed', 'restarted', this.inflight.op));
      this.inflight = null;
    }
    for (const q of this.queue.splice(0)) q.reject(callError('The kernel is closed', 'restarted', q.op));
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
  }
}
