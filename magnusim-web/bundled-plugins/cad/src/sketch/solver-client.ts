// The main-thread client of the sketch solver worker
// (workspace/solver/solver-worker.js, PlaneGCS; src/solver-worker/). Started
// with ws.spawnWorker on first use; calls wait for its ready message and run
// one after the other in the worker (drag moves are coalesced there: only the
// newest is solved). A worker that does not start, or stops answering, is
// ended; the next call starts a fresh one (the caller loads its sketch again:
// sketch mode loads before every solve). The rebuild's re-solve
// (solveFeature) runs on the worker's second solver instance and never
// disturbs the sketch being edited.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SketchFeature, Vec2 } from '../types/doc';
import type { SketchSolverClient, SolverAnalysis, SolverSketch, SolverSolveResult, SolverValues } from '../types/sketch';
import { toSolverSketch } from './model';

export const SOLVER_WORKER_PATH = 'solver/solver-worker.js';

export interface SolverClientOptions {
  spawn: (url: string) => Worker;
  /** Absolute URL of solver-worker.js (default: SOLVER_WORKER_PATH against document.baseURI). */
  url?: string;
  /** How long the worker may take to answer ready (ms). */
  readyTimeoutMs?: number;
  /** How long one call may take (ms); the analysis of an over-defined 1,000-parameter sketch takes about 0.2 s. */
  callTimeoutMs?: number;
}

export interface SolverClient extends SketchSolverClient {
  /** Drag a whole entity: a line translates, a circle's or arc's edge sets its radius. */
  dragStartEntity(entity: string, grab: Vec2, opts?: { freeze?: boolean }): Promise<{ ok: boolean; reason?: string; movable: boolean; at?: Vec2 }>;
  /** Times the worker was started (a restart loses the loaded sketch). */
  readonly starts: number;
}

interface Pending {
  id: number;
  op: string;
  params: unknown[];
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createSolverClient(opts: SolverClientOptions): SolverClient {
  const readyMs = opts.readyTimeoutMs ?? 20_000;
  const callMs = opts.callTimeoutMs ?? 20_000;
  let worker: Worker | null = null;
  let readyP: Promise<void> | null = null;
  let isReady = false;
  let nextId = 1;
  let starts = 0;
  let disposed = false;
  const waiting: Pending[] = [];
  const inflight = new Map<number, Pending>();

  const url = () => opts.url ?? new URL(SOLVER_WORKER_PATH, document.baseURI).href;

  function stop(reason: string) {
    const w = worker;
    worker = null;
    readyP = null;
    isReady = false;
    try {
      w?.terminate();
    } catch {
      /* gone */
    }
    for (const p of [...inflight.values(), ...waiting.splice(0)]) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    inflight.clear();
  }

  function send(p: Pending) {
    inflight.set(p.id, p);
    p.timer = setTimeout(() => stop(`the sketch solver stopped answering (${p.op} took more than ${Math.round(callMs / 1000)} s)`), callMs);
    worker!.postMessage({ type: 'call', id: p.id, op: p.op, params: p.params });
  }

  function start(): Promise<void> {
    if (disposed) return Promise.reject(new Error('the sketch solver was shut down'));
    if (readyP) return readyP;
    starts += 1;
    readyP = new Promise<void>((resolve, reject) => {
      let w: Worker;
      try {
        w = opts.spawn(url());
      } catch (err) {
        readyP = null;
        reject(new Error(`the sketch solver could not start: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      worker = w;
      const timer = setTimeout(() => {
        reject(new Error(`the sketch solver did not start within ${Math.round(readyMs / 1000)} s`));
        stop('the sketch solver did not start');
      }, readyMs);
      w.addEventListener('message', (ev: MessageEvent) => {
        if (w !== worker) return;
        const msg = ev.data as { type: string; id?: number; ok?: boolean; result?: unknown; error?: string };
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          isReady = true;
          resolve();
          for (const p of waiting.splice(0)) send(p);
          return;
        }
        if (msg?.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`the sketch solver could not start: ${msg.error ?? 'unknown error'}`));
          stop(`the sketch solver could not start: ${msg.error ?? 'unknown error'}`);
          return;
        }
        if (msg?.type === 'result' && typeof msg.id === 'number') {
          const p = inflight.get(msg.id);
          if (!p) return;
          inflight.delete(msg.id);
          if (p.timer) clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? 'the sketch solver failed'));
        }
      });
      w.addEventListener('error', (ev: Event) => {
        if (w !== worker) return;
        const m = (ev as ErrorEvent).message || 'the worker failed';
        clearTimeout(timer);
        reject(new Error(`the sketch solver stopped: ${m}`));
        stop(`the sketch solver stopped: ${m}`);
      });
    });
    // A failed start is reported to its callers; the next call tries again.
    readyP.catch(() => {});
    return readyP;
  }

  function call<T>(op: string, ...params: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { id: nextId++, op, params, resolve: resolve as (v: unknown) => void, reject };
      if (isReady && worker) send(p);
      else {
        waiting.push(p);
        start().catch((err: Error) => {
          const i = waiting.indexOf(p);
          if (i >= 0) {
            waiting.splice(i, 1);
            reject(err);
          }
        });
      }
    });
  }

  return {
    get starts() {
      return starts;
    },
    ready: () => start(),
    solveFeature(f: SketchFeature, values: Record<string, number>) {
      return call<SolverSolveResult>('solveOnce', toSolverSketch(f, values));
    },
    load: (sketch: SolverSketch) => call('load', sketch),
    solve: () => call<SolverSolveResult>('solve'),
    analyze: () => call<SolverAnalysis>('analyze'),
    setValue: (constraint: string, value: number | Vec2) => call<SolverSolveResult>('setValue', constraint, value),
    dragStart: (point: string, o?: { freeze?: boolean }) => call('dragStart', point, o ?? {}),
    dragStartEntity: (entity: string, grab: Vec2, o?: { freeze?: boolean }) => call('dragStartEntity', entity, grab, o ?? {}),
    dragMove: (u: number, v: number) => call<{ status: string; values?: SolverValues; superseded?: boolean }>('dragMove', u, v),
    dragEnd: () => call<SolverSolveResult>('dragEnd'),
    dispose() {
      disposed = true;
      stop('the sketch solver was shut down');
    },
  };
}
