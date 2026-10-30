// What the host tells this page of the Assistant's turns bound to its tab (ws.assistant.onTurn,
// CAD tools spec H3): each turn's title, whether it runs on a local server, its model's context
// and image reading, what it used, its review round, its conversation and how it ended, kept per
// turn id. And the reply budgets of a
// call (§3.1): smaller on a local turn; external calls (no turn) and hosts without turn events
// count as cloud.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantTurn } from '@magnusim/workspace';
import type { ReplyBudgets, TurnFacts } from '../types/assistant';

/** The budgets of a cloud turn and of a local one (bytes of `data` as JSON). */
export const BUDGETS: Readonly<Record<'cloud' | 'local', ReplyBudgets>> = Object.freeze({
  cloud: Object.freeze({ kind: 'cloud', brief: 8 * 1024, briefCollapse: 80, full: 24 * 1024, sketch: 16 * 1024, viewSize: 'large' }),
  local: Object.freeze({ kind: 'local', brief: 3 * 1024, briefCollapse: 30, full: 12 * 1024, sketch: 8 * 1024, viewSize: 'small' }),
}) as Readonly<Record<'cloud' | 'local', ReplyBudgets>>;

/** A whole-Part brief never goes past this, however the older features collapse. */
export const BRIEF_HARD_CAP = 24 * 1024;

/** Below this many tokens a local model's context cannot hold the CAD tools and a build (not_ready small_context). */
export const MIN_LOCAL_CONTEXT = 24_000;

/** Ended turns kept (the newest), so a late call or the chip still finds its title. */
const KEEP_ENDED = 16;

export interface TurnInfo {
  /** Take one turn event from the host. */
  take(t: AssistantTurn): void;
  get(id: string): TurnFacts | null;
  /** The turns running now (normally one: one turn per tab). */
  running(): TurnFacts[];
  /** Every turn kept: the running ones and the newest ended ones, oldest first. */
  all(): TurnFacts[];
  /** The facts behind a call's key ("turn:<id>"), or null (external calls, no turn events). */
  forKey(key: string): TurnFacts | null;
  budgets(key: string): ReplyBudgets;
  /** Listen to every change (a turn started, changed or ended). */
  subscribe(fn: (t: TurnFacts) => void): () => void;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** One turn event as kept facts (what an older or odd host leaves out reads as unknown). */
export function factsOf(t: AssistantTurn): TurnFacts {
  const u = (t.used ?? {}) as Partial<AssistantTurn['used']>;
  const end = t.end && typeof t.end === 'object' ? t.end : null;
  return {
    id: String(t.id),
    state: t.state === 'ended' ? 'ended' : 'running',
    title: typeof t.title === 'string' ? t.title : '',
    local: t.local === true,
    contextTokens: typeof t.contextTokens === 'number' && Number.isFinite(t.contextTokens) ? t.contextTokens : null,
    images: typeof t.images === 'boolean' ? t.images : null,
    used: { steps: num(u.steps), stepsCap: num(u.stepsCap), changes: num(u.changes), changesCap: num(u.changesCap), usd: num(u.usd), usdCap: num(u.usdCap) },
    end: end && ['done', 'stopped', 'failed', 'capped'].includes(end.state) ? { state: end.state, reason: String(end.reason ?? '') } : null,
    ...reviewOf(t.review),
    conversation: conversationOf(t),
  };
}

/**
 * The conversation a turn runs in: AssistantTurn.conversation, the same for every turn of one chat
 * (unreleased 1.9, not in the SDK's types yet: read defensively), or null when the host names none.
 */
export function conversationOf(t: AssistantTurn): string | null {
  const c = (t as { conversation?: unknown }).conversation;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
}

/** A turn event's review round, kept only when it reads as one (1 <= round <= of). */
function reviewOf(v: unknown): { review?: { round: number; of: number } } {
  const r = v && typeof v === 'object' ? (v as { round?: unknown; of?: unknown }) : null;
  if (!r || !Number.isInteger(r.round) || !Number.isInteger(r.of)) return {};
  const round = r.round as number;
  const of = r.of as number;
  return round >= 1 && round <= of ? { review: { round, of } } : {};
}

export function createTurnInfo(): TurnInfo {
  const turns = new Map<string, TurnFacts>();
  const listeners = new Set<(t: TurnFacts) => void>();
  const get = (id: string) => turns.get(id) ?? null;
  return {
    take(t) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) return;
      const facts = factsOf(t);
      // An ended turn stays ended (a late running event of it changes nothing).
      if (turns.get(facts.id)?.state === 'ended' && facts.state === 'running') return;
      turns.delete(facts.id);
      turns.set(facts.id, facts);
      const ended = [...turns.values()].filter((x) => x.state === 'ended');
      for (const old of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) turns.delete(old.id);
      for (const fn of [...listeners]) fn(facts);
    },
    get,
    running: () => [...turns.values()].filter((t) => t.state === 'running'),
    all: () => [...turns.values()],
    forKey: (key) => (key.startsWith('turn:') ? get(key.slice('turn:'.length)) : null),
    budgets(key) {
      const facts = key.startsWith('turn:') ? get(key.slice('turn:'.length)) : null;
      return facts?.local ? BUDGETS.local : BUDGETS.cloud;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
