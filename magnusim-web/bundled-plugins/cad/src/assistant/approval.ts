// "Ask each step" (CAD tools spec §8.3, §7.3): the person's opt-in (ws.prefs `assistant.ask_each`,
// off by default, the chip's toggle) to approve each of the Assistant's edits. With it on, an edit
// call waits once the Part has rebuilt with its change and before the change is sealed into the
// request's undo group: the chip says "Assistant: <step> · keep it?" with Keep and Discard, and
// progress says `waiting` (the turn's minutes stop). Keep goes on; Discard reverts the step and
// the call answers busy step_declined; no answer within the wait (10 minutes, the test handle's
// setHoldS shortens it) counts as Discard. A take-over (Escape on the Assistant's Parameters panel
// too, which changes no model) or a change of the person's while it waits ends the wait at once
// (the step's checkpoint then answers why). A pause on when it ends shows as paused (state.ts).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PrefsApi } from '../lib/bridge';
import type { CallCtx } from '../types/assistant';
import type { AssistantStep } from '../types/doc-service';
import { HEARTBEAT_MS } from './busy';
import type { AssistantRuntime } from './runtime';

/** The person's choice, in ws.prefs. */
export const ASK_EACH_PREF = 'assistant.ask_each';

export interface AskEach {
  get(): boolean;
  /** The person's choice (kept in ws.prefs when the host has them). */
  set(on: boolean): void;
  /** Tests: this choice whatever the person chose, never written to ws.prefs; null gives theirs back. */
  force(on: boolean | null): void;
  subscribe(fn: (on: boolean) => void): () => void;
  dispose(): void;
}

export function createAskEach(o: { prefs: PrefsApi | null }): AskEach {
  let on = false;
  let forced: boolean | null = null;
  let chosen = false;
  let disposed = false;
  const listeners = new Set<(on: boolean) => void>();
  const now = () => forced ?? on;
  const tell = () => {
    for (const fn of [...listeners]) fn(now());
  };
  const take = (v: unknown) => {
    const next = v === true;
    if (next === on) return;
    on = next;
    tell();
  };
  const offs: (() => void)[] = [];
  if (o.prefs) {
    o.prefs
      .get<boolean>(ASK_EACH_PREF)
      .then((v) => {
        if (!disposed && !chosen) take(v);
      })
      .catch(() => undefined);
    offs.push(
      o.prefs.onChange((key, value) => {
        if (key === ASK_EACH_PREF) take(value);
      }),
    );
  }
  return {
    get: now,
    set(next) {
      chosen = true;
      const was = now();
      on = next === true;
      if (now() !== was) tell();
      o.prefs?.set(ASK_EACH_PREF, on).catch(() => undefined);
    },
    force(v) {
      const was = now();
      forced = typeof v === 'boolean' ? v : null;
      if (now() !== was) tell();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      disposed = true;
      for (const off of offs.splice(0)) off();
      listeners.clear();
    },
  };
}

/** The step waiting for the person's Keep or Discard (one at a time: one edit runs at a time). */
export interface Approvals {
  /** The step asked about now: its call and its name ("Extrude Boss"), or null. */
  pending(): { call: string; part: string } | null;
  /** The person's answer (the chip's Keep or Discard); nothing when no step waits. */
  answer(keep: boolean): void;
  /** Ask about a step: `done` hears the answer once. Answers the way to take the question back. */
  open(call: string, part: string, done: (keep: boolean) => void): () => void;
  subscribe(fn: () => void): () => void;
}

export function createApprovals(): Approvals {
  let cur: { call: string; part: string; done: (keep: boolean) => void } | null = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    pending: () => (cur ? { call: cur.call, part: cur.part } : null),
    answer(keep) {
      const c = cur;
      if (!c) return;
      cur = null;
      tell();
      c.done(keep);
    },
    open(call, part, done) {
      const mine = { call, part, done };
      cur = mine;
      tell();
      return () => {
        if (cur !== mine) return;
        cur = null;
        tell();
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** How the person answered: Keep, Discard, no answer in time, or the step changed under the question. */
export type ApprovalOutcome = 'keep' | 'discard' | 'timeout' | 'changed';

/**
 * Ask the person about the step (the chip shows Keep and Discard) and wait for the answer: at most
 * the runtime's waitCapMs (then 'timeout'), 'changed' at once when the step stops being clean or is
 * taken over; rejects when the call's signal aborts. Progress says `waiting` every 5 s meanwhile.
 */
export function waitForApproval(ctx: CallCtx, rt: AssistantRuntime, step: AssistantStep, part: string): Promise<ApprovalOutcome> {
  const label = `Waiting for the person: keep ${part}?`;
  return new Promise<ApprovalOutcome>((resolve, reject) => {
    const offs: (() => void)[] = [];
    let finished = false;
    const finish = (v: ApprovalOutcome | { error: unknown }) => {
      if (finished) return;
      finished = true;
      for (const off of offs.splice(0)) off();
      // The chip goes back to what the facts say (a pause that came meanwhile keeps its own state).
      if (rt.store.get().phase === 'approve') rt.store.set({ phase: 'working', note: null });
      if (typeof v === 'object') {
        reject(v.error);
        return;
      }
      // Not waiting any more: the turn's minutes run again.
      ctx.progress(null, v === 'keep' ? 'The person kept it: going on' : 'The person did not keep it');
      resolve(v);
    };
    offs.push(rt.approvals.open(ctx.call.call, part, (keep) => finish(keep ? 'keep' : 'discard')));
    rt.store.set({ phase: 'approve', call: { tool: ctx.tool, label: part }, note: null });
    ctx.progress(null, label, { waiting: true });
    const changed = () => {
      if (step.takenOver || !step.clean) finish('changed');
    };
    offs.push(ctx.services.doc.state.subscribe(changed), ctx.services.bus.on('assistant:taken-over', changed));
    const cap = setTimeout(() => finish('timeout'), rt.waitCapMs);
    const beat = setInterval(() => ctx.progress(null, label, { waiting: true }), HEARTBEAT_MS);
    const abort = () => finish({ error: ctx.signal.reason ?? new DOMException('The call was stopped', 'AbortError') });
    ctx.signal.addEventListener('abort', abort, { once: true });
    offs.push(
      () => clearTimeout(cap),
      () => clearInterval(beat),
      () => ctx.signal.removeEventListener('abort', abort),
    );
    if (ctx.signal.aborted) abort();
    else if (step.takenOver || !step.clean) finish('changed');
  });
}
