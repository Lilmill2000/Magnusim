// The Assistant's test handle (window.__CAD__.assistant, src/app/debug.ts) and its named hold
// points (CAD tools spec §2.1, §12.4): a call stops at a point a test holds until the test
// releases it, so a race is forced, never slept for. Points: 'after-open', 'after-plan',
// 'between-opens', 'sketch-step:<n>', 'before-commit', 'after-settled' (a read holds there once
// the Part has settled). Inert unless a test holds one.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantTool } from '@magnusim/workspace';
import type { AssistantUiState, TurnFacts } from '../types/assistant';
import type { Pause } from './busy';
import type { EvalAsk, EvalFacts } from './eval-types';
import type { Pace } from './pace';

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
  /** An edit call: how long it waited at its pace points (ms; 0 at the fast pace or with the window hidden). */
  paced?: number;
  /** The images its answer carried (a view's picture, an edit's picture), when any. */
  images?: number;
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
  /**
   * The tools as this page last registered them, whole (name, description, input schema): what the
   * model is told (Magnusim CAD's have no simulation or Enclosure fields). [] before the first.
   */
  readonly registered: AssistantTool[];
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
  /** How long an edit waits for the person before it answers busy, in seconds (null: the 10 minutes). */
  setHoldS(s: number | null): void;
  /** The pace whatever the person chose (never written to their preferences; null: theirs), and a scale for its delays (0: no waits; null: as they are). */
  setPace(pace: Pace | null, scale?: number | null): void;
  /** "Ask each step" whatever the person chose (never written to their preferences; null: theirs). */
  setAskEach(on: boolean | null): void;
  /** The edits' pictures whatever the person chose (never written to their preferences; null: theirs). */
  setPictures(v: 'each' | 'off' | null): void;
  /** The step waiting for the person's Keep or Discard ("Ask each step"), or null. */
  approving(): { call: string; part: string } | null;
  /** The pause in this Part, or null. */
  paused(): Pause | null;
  /** The eval's A/B runs: offer every tool, or the 13-tool core set (registers again). */
  setToolset(set: 'all' | 'core'): Promise<{ available: boolean; accepted: string[]; reason?: string }>;
  /** The eval's runs (and the e2e) with or without the review rounds the Part asks for (registers again). */
  setReview(on: boolean): Promise<{ available: boolean; accepted: string[]; reason?: string }>;
  /** The eval's facts of the Part now (eval-facts.ts), with what `ask` asks for. */
  evalFacts(ask?: EvalAsk): Promise<EvalFacts>;
  /** The eval's parameter walk: one parameter set as the person's Parameters panel sets it, the rebuild caught up. */
  evalSetParam(name: string, expr: string): Promise<{ ok: boolean; reason?: string }>;
  /** The eval run's last picture (iso, drawn off screen), or null without a 3D view. */
  evalPicture(): Promise<{ mediaType: string; base64: string } | null>;
}
