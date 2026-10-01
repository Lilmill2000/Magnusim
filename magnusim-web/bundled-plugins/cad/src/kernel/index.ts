// KernelAdapter: the main thread's only way to the kernel worker.
// Owner: DOC-CORE. Public surface: createKernelAdapter + the KernelAdapter type.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../lib/store';
import { KERNEL_RECYCLE_BYTES, type KernelAdapter, type KernelReadyInfo, type KernelReply, type KernelStatus } from '../types/kernel';
import type { KernelOp, KernelParams, KernelResult } from '../types/kernel-protocol';
import { BOOT_TIMEOUT_MS, timeoutFor } from './timeouts';
import { WorkerClient } from './worker-client';

/** Where the built kernel worker lives, relative to the workspace page (workspace/index.html). */
export const KERNEL_WORKER_PATH = 'kernel/kernel-worker.js';

/** Ops that make a shape and must report `valid` (decision: every op checks its result). */
const SHAPE_OPS = new Set<KernelOp>(['box', 'cylinder', 'sphere', 'extrude', 'revolve', 'boolean', 'split', 'fillet', 'chamfer', 'defeature', 'shell', 'repair']);

export interface KernelAdapterOptions {
  spawn: (url: string) => Worker;
  /** Absolute URL of kernel-worker.js (default: KERNEL_WORKER_PATH against document.baseURI). */
  workerUrl?: string;
  bootTimeoutMs?: number;
  /** Per-op wall-clock limits (ms) over the defaults in timeouts.ts. */
  timeouts?: Partial<Record<KernelOp, number>>;
  /** Heap above which an idle worker is recycled (default KERNEL_RECYCLE_BYTES). */
  recycleBytes?: number;
}

export function createKernelAdapter(opts: KernelAdapterOptions): KernelAdapter {
  const status = createStateStore<KernelStatus>({ state: 'idle', info: null, message: null, respawns: 0, busy: null, heap_bytes: null, memory_high: false });
  const respawnListeners = new Set<(reason: string) => void>();
  let pendingRespawn: string | null = null;
  const url = opts.workerUrl ?? new URL(KERNEL_WORKER_PATH, document.baseURI).href;
  const overrides = opts.timeouts ?? {};
  const recycleBytes = opts.recycleBytes ?? KERNEL_RECYCLE_BYTES;
  let recycled = false;
  let inflight = 0;

  const client = new WorkerClient({
    name: 'kernel',
    spawn: opts.spawn,
    url,
    timeoutFor: (op) => overrides[op] ?? timeoutFor(op),
    bootTimeoutMs: opts.bootTimeoutMs ?? BOOT_TIMEOUT_MS,
    onEvent(ev) {
      switch (ev.type) {
        case 'starting':
          status.set({ state: status.get().respawns > 0 ? 'restarting' : 'starting', busy: null });
          break;
        case 'ready':
          status.set({ state: 'ready', info: ev.info, heap_bytes: ev.info.heap_bytes, message: pendingRespawn ? status.get().message : null });
          if (pendingRespawn) {
            const reason = pendingRespawn;
            pendingRespawn = null;
            for (const fn of [...respawnListeners]) {
              try {
                fn(reason);
              } catch (err) {
                console.error('[cad] respawn listener failed', err);
              }
            }
          }
          break;
        case 'failed':
          status.set({ state: 'failed', message: ev.message, busy: null });
          break;
        case 'respawn':
          pendingRespawn = ev.reason;
          status.set({ state: 'restarting', message: ev.reason, respawns: ev.count });
          break;
        case 'busy':
          status.set({ busy: ev.op });
          break;
      }
    },
  });

  async function call<Op extends KernelOp>(op: Op, params: KernelParams<Op>, callOpts: { bytes?: ArrayBuffer; timeoutMs?: number } = {}): Promise<KernelReply<Op>> {
    inflight++;
    try {
      const r = await client.call(op, params as Record<string, unknown>, callOpts);
      status.set({ heap_bytes: r.heap_bytes });
      const result = r.result as KernelResult<Op> & { id?: number; valid?: boolean };
      // Until every facade op reports `valid`, check the result here (never a silent pass).
      if (SHAPE_OPS.has(op) && typeof result.valid !== 'boolean' && typeof result.id === 'number') {
        const chk = await client.call('check', { id: result.id });
        result.valid = !!(chk.result as { valid?: boolean }).valid;
      }
      return { result, buffers: r.buffers, ms: r.ms, wall_ms: r.wall_ms, heap_bytes: r.heap_bytes };
    } finally {
      inflight--;
    }
  }

  return {
    status,
    start: () => client.start(),
    call,
    onRespawn(fn) {
      respawnListeners.add(fn);
      return () => {
        respawnListeners.delete(fn);
      };
    },
    restart: (reason: string): Promise<KernelReadyInfo> => client.respawn(reason),
    async recycleIfLarge() {
      const s = status.get();
      if (s.state !== 'ready' || inflight > 0) return false;
      const heap = s.heap_bytes ?? 0;
      if (heap <= recycleBytes) {
        if (s.memory_high) status.set({ memory_high: false });
        recycled = false;
        return false;
      }
      if (recycled) {
        // A fresh worker is above the threshold again: the model needs it. No loop.
        if (!s.memory_high) status.set({ memory_high: true });
        return false;
      }
      recycled = true;
      const gb = (heap / 1e9).toFixed(1);
      await client.respawn(`memory recycle at ${gb} GB`).catch(() => {});
      return true;
    },
    dispose() {
      client.dispose();
      status.set({ state: 'closed', busy: null });
    },
  };
}
