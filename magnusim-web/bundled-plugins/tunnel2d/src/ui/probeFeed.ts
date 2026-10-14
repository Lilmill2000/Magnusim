// The probes' readings: every probe read five times a second (one pass for all of them),
// each with its history over simulated time for its plot. A probe that moves, or a flow that
// starts again, begins a new history.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Store } from '../app/store';
import type { Engine, FlowReading } from '../sim/engine';

export interface ProbeSample extends FlowReading {
  /** Simulated time (s). */
  t: number;
}

/** Samples kept per probe (at five a second: five minutes). */
const KEEP = 1500;

type Listener = () => void;

export class ProbeFeed {
  version = 0;
  private engine: Engine;
  private store: Store;
  private hist = new Map<string, { at: string; samples: ProbeSample[] }>();
  private timer = 0;
  private busy = false;
  private listeners = new Set<Listener>();

  constructor(engine: Engine, store: Store) {
    this.engine = engine;
    this.store = store;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    this.timer = window.setInterval(() => void this.read(), 200);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  latest(id: string): ProbeSample | null {
    const h = this.hist.get(id)?.samples;
    return h && h.length ? h[h.length - 1] : null;
  }

  history(id: string): ProbeSample[] {
    return this.hist.get(id)?.samples ?? [];
  }

  private async read() {
    const probes = this.store.get().scene.probes;
    for (const id of [...this.hist.keys()]) if (!probes.some((p) => p.id === id)) this.hist.delete(id);
    if (!probes.length || this.busy) return;
    this.busy = true;
    try {
      const t = this.engine.stats.simTime;
      const r = await this.engine.readAt(probes);
      if (!r) return;
      probes.forEach((p, i) => {
        const at = `${p.x}:${p.y}`;
        let h = this.hist.get(p.id);
        if (!h || h.at !== at || (h.samples.length && t < h.samples[h.samples.length - 1].t)) this.hist.set(p.id, (h = { at, samples: [] }));
        if (h.samples.length && h.samples[h.samples.length - 1].t === t) return;
        h.samples.push({ ...r[i], t });
        if (h.samples.length > KEEP) h.samples.splice(0, h.samples.length - KEEP);
      });
      this.version++;
      for (const fn of this.listeners) fn();
    } finally {
      this.busy = false;
    }
  }
}
