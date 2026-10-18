// The Assistant's test handle (window.__CAD__.assistant, src/app/debug.ts) and its named hold
// points (CAD tools spec §2.1, §12.4): a call stops at a point a test holds until the test
// releases it, so a race is forced, never slept for. Points: 'after-open', 'after-plan',
// 'between-opens', 'sketch-step:<n>', 'before-commit', 'after-settled' (a read holds there once
// the Part has settled). Inert unless a test holds one.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantUiState, TurnFacts } from '../types/assistant';

/** One call as the page answered it (the test ledger; the eval harness counts errors by reason). */
export interface CallRecord {
  call: string;
  turn: string;
  key: string;
  tool: string;
  ok: boolean;
  /** The error's code and reason (detail.reason) when it failed. */
  code?: string;
  reason?: string;
  ms: number;
}

export interface HoldPoints {
  /** Calls stop at `point` from now on (until release). */
  hold(point: string): void;
  /** Let every call waiting at `point` go on, and stop holding it. */
  release(point: string): void;
  /** The points held. */
  held(): string[];
  /** The points a call waits at now. */
  waiting(): string[];
  /** A call reaches `point`: resolves at once unless it is held; rejects when `signal` aborts while held. */
  at(point: string, signal?: AbortSignal): Promise<void>;
  /** Release everything (the page's tools withdrawn). */
  clear(): void;
}

export function createHoldPoints(): HoldPoints {
  const held = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const free = (point: string) => {
    const set = waiters.get(point);
    waiters.delete(point);
    for (const go of set ?? []) go();
  };
  return {
    hold: (point) => void held.add(point),
    release(point) {
      held.delete(point);
      free(point);
    },
    held: () => [...held],
    waiting: () => [...waiters.keys()],
    at(point, signal) {
      if (!held.has(point)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let set = waiters.get(point);
        if (!set) waiters.set(point, (set = new Set()));
        const go = () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          set!.delete(go);
          if (!set!.size) waiters.delete(point);
          reject(signal?.reason ?? new DOMException('The call was stopped', 'AbortError'));
        };
        set.add(go);
        signal?.addEventListener('abort', stop, { once: true });
      });
    },
    clear() {
      held.clear();
      for (const p of [...waiters.keys()]) free(p);
    },
  };
}

/** window.__CAD__.assistant: read-mostly, for e2e tests and the eval harness. */
export interface AssistantTestHandle {
  /** The tools this page offers ('cad__' is the app's prefix, not theirs). */
  readonly tools: string[];
  /** The chip's state now. */
  state(): AssistantUiState;
  /** Every call this page answered, oldest first. */
  readonly calls: CallRecord[];
  /** The turns the host told this page of. */
  turns(): TurnFacts[];
  hold(point: string): void;
  release(point: string): void;
  held(): string[];
  waiting(): string[];
  /** The eval's A/B runs: offer every tool, or the 13-tool core set (registers again). */
  setToolset(set: 'all' | 'core'): Promise<{ available: boolean; accepted: string[]; reason?: string }>;
}
