// The sketch solver for the tunnel: CAD's PlaneGCS worker (a copy in workspace/solver/,
// started through ws.spawnWorker) behind CAD's client. A solve loads the sketch with its
// dimensions' values, solves, diagnoses (what is under- or over-defined, what conflicts) and
// returns the sketch with the solved coordinates; a drag loads the sketch, then moves one
// point while the solver keeps every relation and dimension. One call at a time.
// SPDX-License-Identifier: GPL-3.0-or-later
import { SOLVER_WORKER, createSolverClient, statusOf, toSolverSketch, withSolved, type SolverAnalysis, type SolverClient, type SolverSolveResult } from './cad';
import { dimensionValues, type SketchData } from './model';

export interface SketchStatus {
  state: 'under' | 'fully' | 'over' | 'unsolved';
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export interface Solved {
  sketch: SketchData;
  status: SketchStatus;
  analysis: SolverAnalysis | null;
  /** Why it could not be solved (a dimension's value that does not read, a relation the solver refuses). */
  error?: string;
}

export class SketchSolver {
  private client: SolverClient;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(spawn: (url: string) => Worker) {
    this.client = createSolverClient({ spawn, url: new URL(SOLVER_WORKER, document.baseURI).href });
  }

  /** Run `fn` after every call queued before it. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async loadAndSolve(s: SketchData): Promise<Solved> {
    const { values, errors } = dimensionValues(s);
    const bad = Object.values(errors)[0];
    if (bad) return { sketch: s, status: { state: 'unsolved', dof: 0, conflicting: [], redundant: [] }, analysis: null, error: bad };
    await this.client.load(toSolverSketch(s, values));
    const r: SolverSolveResult = await this.client.solve();
    const analysis = await this.client.analyze().catch(() => null);
    const status = statusOf(r, analysis ?? undefined) as SketchStatus;
    return { sketch: r.solved ? withSolved(s, r.values) : s, status, analysis };
  }

  /** Solve a sketch (its geometry where its relations and dimensions put it). */
  solve(s: SketchData): Promise<Solved> {
    return this.queue(async () => {
      try {
        return await this.loadAndSolve(s);
      } catch (e) {
        return { sketch: s, status: { state: 'unsolved', dof: 0, conflicting: [], redundant: [] }, analysis: null, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /** Begin dragging a point (false: it cannot move, e.g. fixed or fully defined). */
  dragStart(s: SketchData, point: string): Promise<boolean> {
    return this.queue(async () => {
      try {
        await this.loadAndSolve(s);
        const r = await this.client.dragStart(point, { freeze: true });
        return r.ok && r.movable;
      } catch {
        return false;
      }
    });
  }

  /** The newest drag position not yet sent, and whether one is in flight. */
  private dragWant: { s: SketchData; u: number; v: number; resolve: (s: SketchData | null) => void } | null = null;
  private dragBusy = false;

  /**
   * Move the dragged point toward (u, v) mm: the sketch with the solved geometry, or null when
   * a newer move replaced this one (only one is ever in flight: a slow solve never queues up
   * a trail of stale positions behind the pointer).
   */
  dragMove(s: SketchData, u: number, v: number): Promise<SketchData | null> {
    return new Promise((resolve) => {
      this.dragWant?.resolve(null);
      this.dragWant = { s, u, v, resolve };
      this.pumpDrag();
    });
  }

  private pumpDrag() {
    if (this.dragBusy || !this.dragWant) return;
    const w = this.dragWant;
    this.dragWant = null;
    this.dragBusy = true;
    void this.queue(async () => {
      try {
        const r = await this.client.dragMove(w.u, w.v);
        w.resolve(r.superseded || !r.values ? null : withSolved(w.s, r.values));
      } catch {
        w.resolve(null);
      }
    }).finally(() => {
      this.dragBusy = false;
      this.pumpDrag();
    });
  }

  /** End the drag: the final solve and its status. */
  dragEnd(s: SketchData): Promise<Solved> {
    return this.queue(async () => {
      try {
        const r = await this.client.dragEnd();
        const analysis = await this.client.analyze().catch(() => null);
        return { sketch: r.solved ? withSolved(s, r.values) : s, status: statusOf(r, analysis ?? undefined) as SketchStatus, analysis };
      } catch (e) {
        return { sketch: s, status: { state: 'unsolved', dof: 0, conflicting: [], redundant: [] }, analysis: null, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  dispose() {
    this.client.dispose();
  }
}
