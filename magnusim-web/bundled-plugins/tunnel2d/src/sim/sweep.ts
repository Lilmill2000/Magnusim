// The angle sweep: turn one body through a range of angles, at each wait for the flow to
// settle (passes of the flow past the body, in simulated time, so a slow GPU or a pause only
// takes longer), then average its coefficients; put the angle back at the end and keep the
// rows in the scene. It stops when the body goes, the flow becomes unstable, or its angle is
// changed by hand.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Store } from '../app/store';
import { referenceLength } from '../geometry/shapes';
import { LIMITS, type SweepResult, type SweepRow } from '../scene/scene';
import type { Engine } from './engine';

/** Passes of the flow past the body to wait at each angle, then to average over. */
export const SETTLE_PASSES = 8;
export const AVERAGE_PASSES = 4;

/** The angles from `from` to `to` by `step` (both ends kept), or why not. */
export function sweepAngles(from: number, to: number, step: number): number[] | { error: string } {
  if (![from, to, step].every(Number.isFinite)) return { error: 'The angles and the step must be numbers.' };
  if (from < -180 || from > 180 || to < -180 || to > 180) return { error: 'Angles go from −180° to 180°.' };
  const s = Math.abs(step);
  if (s < 0.1) return { error: 'The step must be at least 0.1°.' };
  if (from === to) return [from];
  const dir = to > from ? 1 : -1;
  const n = Math.floor(Math.abs(to - from) / s + 1e-9);
  if (n + 1 > LIMITS.maxSweepAngles) return { error: `That is more than ${LIMITS.maxSweepAngles} angles: take a larger step.` };
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Math.round((from + dir * i * s) * 1e6) / 1e6);
  // The far end too, when the step does not land on it.
  if (Math.abs(out[out.length - 1] - to) > 1e-6) out.push(to);
  if (out.length > LIMITS.maxSweepAngles) return { error: `That is more than ${LIMITS.maxSweepAngles} angles: take a larger step.` };
  return out;
}

/** The mean of samples from `t0` to `t1` (simulated seconds), or null if there are none. */
export function meanBetween(sm: { t: number[]; cl: number[]; cd: number[]; cm: number[] }, t0: number, t1: number): Omit<SweepRow, 'angle'> | null {
  let n = 0;
  let cl = 0;
  let cd = 0;
  let cm = 0;
  for (let i = 0; i < sm.t.length; i++) {
    if (sm.t[i] < t0 || sm.t[i] > t1) continue;
    cl += sm.cl[i];
    cd += sm.cd[i];
    cm += sm.cm[i];
    n++;
  }
  return n ? { cl: cl / n, cd: cd / n, cm: cm / n } : null;
}

export interface SweepState {
  bodyId: string;
  angles: number[];
  /** The angle being run (index), and how far through settling then averaging (0 to 1 each). */
  index: number;
  phase: 'settling' | 'averaging' | 'done' | 'stopped';
  progress: number;
  rows: SweepRow[];
  /** Why it stopped early ('' when it ran through or was stopped by hand). */
  reason: string;
}

type Listener = () => void;

export class SweepRun {
  state: SweepState;
  private engine: Engine;
  private store: Store;
  private original: number;
  private t0 = 0;
  private timer = 0;
  private listeners = new Set<Listener>();

  constructor(engine: Engine, store: Store, bodyId: string, angles: number[]) {
    this.engine = engine;
    this.store = store;
    const b = store.get().scene.bodies.find((x) => x.id === bodyId);
    this.original = b?.angle ?? 0;
    this.state = { bodyId, angles, index: 0, phase: 'settling', progress: 0, rows: [], reason: '' };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.state = { ...this.state };
    for (const fn of this.listeners) fn();
  }

  get running(): boolean {
    return this.state.phase === 'settling' || this.state.phase === 'averaging';
  }

  start() {
    this.goTo(0);
    this.timer = window.setInterval(() => this.tick(), 150);
  }

  /** Stop (by hand, or with the reason): the angle goes back and the rows so far are kept. */
  stop(reason = '') {
    if (!this.running) return;
    window.clearInterval(this.timer);
    this.state.phase = 'stopped';
    this.state.reason = reason;
    this.finish();
  }

  private body() {
    return this.store.get().scene.bodies.find((x) => x.id === this.state.bodyId) ?? null;
  }

  private goTo(i: number) {
    this.state.index = i;
    this.state.phase = 'settling';
    this.state.progress = 0;
    this.store.updateBody(this.state.bodyId, { angle: this.state.angles[i] }, false);
    this.t0 = this.engine.stats.simTime;
    this.emit();
  }

  private tick() {
    const b = this.body();
    if (!b || !b.enabled) return this.stop('The body was removed or taken out of the flow.');
    if (this.engine.stats.state === 'unstable') return this.stop('The flow became unstable.');
    const want = this.state.angles[this.state.index];
    if (Math.abs(b.angle - want) > 1e-6) return this.stop('Its angle was changed by hand.');
    const pass = referenceLength(b.shape) / Math.max(1e-9, this.store.get().scene.flow.speed);
    const t = this.engine.stats.simTime - this.t0;
    const settle = SETTLE_PASSES * pass;
    const avg = AVERAGE_PASSES * pass;
    // A restarted flow (its time went back): settle again from now.
    if (t < 0) {
      this.t0 = this.engine.stats.simTime;
      return;
    }
    if (t < settle) {
      this.state.phase = 'settling';
      this.state.progress = t / settle;
    } else if (t < settle + avg) {
      this.state.phase = 'averaging';
      this.state.progress = (t - settle) / avg;
    } else {
      const m = meanBetween(this.engine.samplesOf(b.id, this.t0 + settle), this.t0 + settle, this.t0 + settle + avg);
      if (m) this.state.rows = [...this.state.rows, { angle: want, ...m }];
      if (this.state.index + 1 < this.state.angles.length) this.goTo(this.state.index + 1);
      else {
        window.clearInterval(this.timer);
        this.state.phase = 'done';
        this.finish();
      }
      return;
    }
    this.emit();
  }

  /** Back to the angle it had, and the rows into the scene (for the plots, and kept with it). */
  private finish() {
    const b = this.body();
    if (b) this.store.updateBody(b.id, { angle: this.original }, false);
    if (b && this.state.rows.length) {
      const re = this.engine.reynoldsFor(b);
      const model = this.engine.flowModel;
      const capped = !!this.engine.lattice?.capped;
      const result: SweepResult = {
        bodyId: b.id,
        bodyName: b.name,
        re: re ? (model === 'sa' ? re.real : re.sim) : 0,
        model,
        exact: model === 'sa' || !capped,
        rows: this.state.rows,
      };
      const s = this.store.get().scene;
      this.store.commit({ ...s, sweep: result }, false);
    }
    this.emit();
  }

  dispose() {
    window.clearInterval(this.timer);
    this.listeners.clear();
  }
}

/** The page's sweep (one at a time), kept while panels come and go. */
export class SweepHost {
  run: SweepRun | null = null;
  version = 0;
  private engine: Engine;
  private store: Store;
  private listeners = new Set<Listener>();
  private off: (() => void) | null = null;

  constructor(engine: Engine, store: Store) {
    this.engine = engine;
    this.store = store;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  start(bodyId: string, angles: number[]) {
    this.run?.stop();
    this.off?.();
    this.run?.dispose();
    const run = new SweepRun(this.engine, this.store, bodyId, angles);
    this.run = run;
    this.off = run.subscribe(() => this.emit());
    run.start();
  }

  stop() {
    this.run?.stop();
  }
}
