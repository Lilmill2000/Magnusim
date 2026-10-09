// ux010 (DRAW): one async read at a time, the newest waiting one next. A read asked for while
// another runs replaces the one waiting (that one is dropped and told so), so reads for where the
// pointer was never hold back the read for where it is now. The snaps on the model use it: each
// edge or vertex the pointer crosses needs a few kernel calls, and a fast sweep across a part
// queued them all, so the snap under a pointer that had stopped came last (Daniel: the dot "lags
// behind" the crosshair).
// Owner: DRAW (ux010).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface LatestQueue {
  /**
   * Run `job` now if nothing runs, else after the running one; `low` waits only when nothing else
   * waits (it never replaces a waiting job). `dropped` is called when a newer job replaces it.
   */
  ask(job: () => Promise<void>, opts?: { dropped?: () => void; low?: boolean }): void;
  /** A job runs. */
  readonly busy: boolean;
  /** Forget the waiting job (dropped is called). */
  clear(): void;
}

export function latestQueue(): LatestQueue {
  let running = false;
  let waiting: { job: () => Promise<void>; dropped?: () => void } | null = null;
  const run = (job: () => Promise<void>) => {
    running = true;
    let p: Promise<void>;
    try {
      p = job();
    } catch {
      p = Promise.resolve();
    }
    void p
      .catch(() => {})
      .then(() => {
        running = false;
        const w = waiting;
        waiting = null;
        if (w) run(w.job);
      });
  };
  return {
    ask(job, opts = {}) {
      if (!running) {
        run(job);
        return;
      }
      if (opts.low && waiting) {
        opts.dropped?.();
        return;
      }
      waiting?.dropped?.();
      waiting = { job, dropped: opts.dropped };
    },
    get busy() {
      return running;
    },
    clear() {
      waiting?.dropped?.();
      waiting = null;
    },
  };
}
