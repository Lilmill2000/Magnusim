// Picking structures per body: small bodies are built right away on the main
// thread; large ones in the picking worker (ws.spawnWorker), so opening a
// 550k-triangle part never blocks the frame for the BVH. If the worker cannot
// start, the build falls back to the main thread (and says so in the console).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BufferGeometry } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { buildBvhSync, bvhFromBuffers, type BvhReply, type BvhRequest } from './bvh-build';

/** Where the built picking worker lives, relative to the workspace page. */
export const PICK_WORKER_PATH = 'pick/pick-worker.js';
/** Bodies with at least this many triangles build in the worker. */
export const WORKER_TRIANGLES = 40_000;

export interface BvhBuilt {
  bvh: MeshBVH;
  ms: number;
  worker: boolean;
}

export interface BvhClientOptions {
  /** ws.spawnWorker (the host's blob-worker launcher); without it every build runs on the main thread. */
  spawnWorker?: ((url: string) => Worker) | null;
  /** Absolute URL of pick-worker.js (default: PICK_WORKER_PATH against document.baseURI). */
  workerUrl?: string;
  workerTriangles?: number;
}

interface Pending {
  geometry: BufferGeometry;
  done: (r: BvhBuilt) => void;
  fail: (err: Error) => void;
}

export class BvhClient {
  private worker: Worker | null = null;
  private workerBroken: string | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private disposed = false;

  constructor(private readonly opts: BvhClientOptions = {}) {}

  /**
   * Build a BVH for `geometry` (position + index). Calls `done` once, later for
   * worker builds. Returns a cancel function (the result is then dropped).
   */
  build(geometry: BufferGeometry, triangles: number, done: (r: BvhBuilt) => void, fail: (err: Error) => void = () => {}): () => void {
    const threshold = this.opts.workerTriangles ?? WORKER_TRIANGLES;
    let cancelled = false;
    const onDone = (r: BvhBuilt) => {
      if (!cancelled && !this.disposed) done(r);
    };
    const onFail = (e: Error) => {
      if (!cancelled && !this.disposed) fail(e);
    };
    if (triangles < threshold || !this.opts.spawnWorker || this.workerBroken) {
      if (triangles >= threshold && this.workerBroken) console.warn(`[cad] picking worker unavailable (${this.workerBroken}); building on the main thread`);
      const t0 = performance.now();
      try {
        const bvh = buildBvhSync(geometry);
        onDone({ bvh, ms: performance.now() - t0, worker: false });
      } catch (err) {
        onFail(err instanceof Error ? err : new Error(String(err)));
      }
      return () => {
        cancelled = true;
      };
    }
    const w = this.ensureWorker();
    if (!w) return this.build(geometry, triangles, done, fail);
    const id = ++this.seq;
    this.pending.set(id, { geometry, done: onDone, fail: onFail });
    const pos = (geometry.getAttribute('position').array as Float32Array).slice();
    const idx = (geometry.getIndex()!.array as Uint32Array).slice();
    const msg: BvhRequest = { id, positions: pos, indices: idx };
    w.postMessage(msg, [pos.buffer, idx.buffer]);
    return () => {
      cancelled = true;
      this.pending.delete(id);
    };
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const url = this.opts.workerUrl ?? new URL(PICK_WORKER_PATH, document.baseURI).href;
      const w = this.opts.spawnWorker!(url);
      w.onmessage = (e: MessageEvent<BvhReply>) => this.onReply(e.data);
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault?.();
        this.breakWorker(e.message || 'the picking worker failed');
      };
      this.worker = w;
      return w;
    } catch (err) {
      this.workerBroken = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private onReply(r: BvhReply): void {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    if (!r.ok) {
      p.fail(new Error(r.error));
      return;
    }
    const t0 = performance.now();
    try {
      const bvh = bvhFromBuffers(p.geometry, { roots: r.roots, indirect: r.indirect });
      p.done({ bvh, ms: r.ms + (performance.now() - t0), worker: true });
    } catch (err) {
      p.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** The worker died: finish what was waiting on the main thread and stop using it. */
  private breakWorker(reason: string): void {
    this.workerBroken = reason;
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) {
      const tri = (p.geometry.getIndex()?.count ?? 0) / 3;
      this.build(p.geometry, tri, p.done, p.fail);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    try {
      this.worker?.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
  }
}
