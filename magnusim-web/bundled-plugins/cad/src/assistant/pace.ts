// How fast the Assistant's edits go on screen (CAD tools spec §8.2): `watch` (the default) waits a
// moment at each pace point so the person sees the panel open, the values go in and the rebuild
// follow; `fast` never waits. The pace is the person's choice, kept for the plugin in every
// project (ws.prefs `assistant.pace`). A call's waits add up to at most 6 s (each delay is scaled
// down to fit), and there is no wait at all while the window is hidden, when the last rebuild took
// more than 1.5 s, or with the test scale 0. A wait races the call's signal.
// macrotask(): one turn of the event loop through a MessageChannel (no timer, so a hidden tab does
// not throttle it), after which React has drawn what the last open put on screen.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PrefsApi } from '../lib/bridge';
import type { DocService } from '../types/doc-service';

export type Pace = 'watch' | 'fast';

/** The person's pace, in ws.prefs. */
export const PACE_PREF = 'assistant.pace';

/** The delays of watch pace, ms (§8.2). */
export const PACE_DELAYS = Object.freeze({
  /** After a panel opens (its fields filled at once). */
  open: 450,
  /** A sketch entity's rubber band, then its add. */
  preview: 120,
  add: 60,
  relation: 60,
  dimension: 150,
  /** A parameter row. */
  param: 150,
  /** Before the commit. */
  commit: 250,
});
export type PacePoint = keyof typeof PACE_DELAYS;

/** One call's waits add up to at most this. */
export const CALL_PACE_CAP_MS = 6000;
/** A rebuild slower than this switches the waits off (big parts run at fast pace). */
export const SLOW_REBUILD_MS = 1500;
/** An edit's note when the person chose watch but the window was hidden or covered during the call. */
export const HIDDEN_NOTE = 'ran without animation: the window was hidden or covered';

export interface CallPacer {
  /**
   * The call expects to wait this long in all (the sum of its pace points' delays): each delay is
   * scaled down so the call stays within CALL_PACE_CAP_MS.
   */
  plan(totalMs: number): void;
  /** Wait at a pace point (0 ms when the pace is off); rejects when the call's signal aborts. Answers the ms waited. */
  wait(point: PacePoint): Promise<number>;
  /** The ms this call waited so far. */
  spent(): number;
}

export interface PaceControl {
  /** The person's pace now. */
  get(): Pace;
  /** Change it (kept in ws.prefs when the host has them). */
  set(pace: Pace): void;
  /** Tests: every delay times `scale` (0: no waits at all); null goes back to 1. */
  setScale(scale: number | null): void;
  /** Tests: this pace whatever the person chose, never written to ws.prefs; null gives the person's back. */
  force(pace: Pace | null): void;
  /** Whether pace points wait now: watch pace, the window shown, the last rebuild quick, a scale above 0. */
  live(): boolean;
  /**
   * Whether the person watches the build now: watch pace, the window shown, the last rebuild quick
   * (whatever the test scale). A sketch is drawn entity by entity then, and the camera may turn.
   */
  watching(): boolean;
  /** The window is hidden or covered (Chromium on Windows reports a covered window as hidden). */
  hidden(): boolean;
  /** The waits of one call. */
  forCall(signal: AbortSignal): CallPacer;
  subscribe(fn: (pace: Pace) => void): () => void;
  dispose(): void;
}

export interface PaceOptions {
  doc: Pick<DocService, 'state'>;
  prefs: PrefsApi | null;
  document?: Document | null;
  /** The pace before the person's choice is read (watch). */
  initial?: Pace;
}

const isPace = (v: unknown): v is Pace => v === 'watch' || v === 'fast';

export function createPace(o: PaceOptions): PaceControl {
  let pace: Pace = o.initial ?? 'watch';
  let forced: Pace | null = null;
  let scale = 1;
  let disposed = false;
  let chosen = false;
  const listeners = new Set<(p: Pace) => void>();
  const now = (): Pace => forced ?? pace;
  const tell = () => {
    for (const fn of [...listeners]) fn(now());
  };
  const take = (v: unknown) => {
    if (!isPace(v) || v === pace) return;
    pace = v;
    tell();
  };
  const offPrefs: (() => void)[] = [];
  if (o.prefs) {
    // The person's choice, read once (a choice made here meanwhile wins), then heard from other tabs.
    o.prefs
      .get<Pace>(PACE_PREF)
      .then((v) => {
        if (!disposed && !chosen) take(v);
      })
      .catch(() => undefined);
    offPrefs.push(
      o.prefs.onChange((key, value) => {
        if (key === PACE_PREF) take(value === null || value === undefined ? (o.initial ?? 'watch') : value);
      }),
    );
  }
  const hidden = () => !!o.document?.hidden;
  const slow = () => {
    const ms = o.doc.state.get().rebuild.ms;
    return typeof ms === 'number' && ms > SLOW_REBUILD_MS;
  };
  const watching = () => now() === 'watch' && !hidden() && !slow();
  const live = () => watching() && scale > 0;
  return {
    get: now,
    set(next) {
      if (!isPace(next)) return;
      chosen = true;
      if (next !== pace) {
        pace = next;
        tell();
      }
      o.prefs?.set(PACE_PREF, next).catch(() => undefined);
    },
    setScale(s) {
      scale = s === null || !Number.isFinite(s) || s < 0 ? 1 : s;
    },
    force(p) {
      const was = now();
      forced = isPace(p) ? p : null;
      if (now() !== was) tell();
    },
    live,
    watching,
    hidden,
    forCall(signal) {
      let factor = 1;
      let spent = 0;
      return {
        plan(totalMs) {
          factor = totalMs > CALL_PACE_CAP_MS ? CALL_PACE_CAP_MS / totalMs : 1;
        },
        spent: () => spent,
        wait(point) {
          if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The call was stopped', 'AbortError'));
          if (!live()) return Promise.resolve(0);
          const ms = Math.min(Math.round(PACE_DELAYS[point] * factor * scale), Math.max(0, CALL_PACE_CAP_MS - spent));
          if (ms <= 0) return Promise.resolve(0);
          spent += ms;
          return new Promise<number>((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(signal.reason ?? new DOMException('The call was stopped', 'AbortError'));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', stop);
              resolve(ms);
            }, ms);
            signal.addEventListener('abort', stop, { once: true });
          });
        },
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      for (const off of offPrefs.splice(0)) off();
      listeners.clear();
    },
  };
}

/** One turn of the event loop (a MessageChannel message: no timer, so a hidden tab does not throttle it). */
export function macrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}
