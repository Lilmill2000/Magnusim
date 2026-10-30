// Which group a call belongs to (CAD tools spec §1.2, §7.9): the key of its undo group, handle
// table, ledger, camera latch and "what the person changed" baseline.
//   turn:<id>     a call of one of the app's turns (AssistantCall.turn);
//   ext:<n>       an outside client's call with no turn (turn ""): one session while its calls
//                 keep coming. n goes up after 5 minutes without such a call, when the person
//                 changed the committed Part between two of them, and on every page load (the
//                 counter lives in this page). A key that went up only because the person
//                 changed the Part is the same session for the pause (sameSession): the
//                 person's own change never lifts their Pause, or a take-over's.
//   mcp:<session> another app's call over MCP: the app tells it the turn "mcp:<connection id>",
//                 the same for every call on that connection, which may stay open as long as
//                 the app runs. Its calls are grouped by the same rules as ext:<n>, per
//                 connection: mcp:<session> first, then mcp:<session>#2, #3, ...
// "What the person changed" is kept per conversation when the call's turn names its conversation
// (TurnFacts.conversation, turn-info.ts), else per key as above.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CadDoc } from '../types/doc';

/** An outside session ends after this long without a call. */
export const EXTERNAL_IDLE_MS = 5 * 60_000;

export interface SessionKeys {
  /** The key of a call that starts now (its turn as the SDK gave it). */
  keyOf(turn: string): string;
  /** A call under `key` ended: an outside session's clock and its Part start again from here. */
  ended(key: string): void;
  /** Two outside keys of one session: the later one came only because the person changed the Part (no 5-minute gap, no page load). */
  sameSession(a: string, b: string): boolean;
}

/** Sessions remembered for sameSession (the newest), per outside source. */
const ROOTS_KEPT = 64;

/** One outside source: the calls with no turn (''), or one app's connection ('mcp:<session>'). */
interface Source {
  n: number;
  last: { at: number; doc: CadDoc } | null;
  /** Each of its keys' first key of its session (a new one after 5 minutes without a call). */
  roots: Map<number, number>;
}

/**
 * `now` is the clock; `committed` the committed Part (DocService.committed): a person's change
 * between two outside calls starts a new outside session. The Assistant's own changes happen
 * inside its calls, and the Part is taken again at each call's end, so they never count.
 */
export function createSessionKeys(o: { now?: () => number; committed: () => CadDoc }): SessionKeys {
  const now = o.now ?? (() => Date.now());
  // Every source this page heard (never forgotten: a source seen again must not reuse a key).
  const sources = new Map<string, Source>();
  /** The keys given out lately: their source and number (sameSession reads them). */
  const given = new Map<string, { source: string; n: number }>();
  const sourceOf = (id: string): Source => {
    let s = sources.get(id);
    if (!s) {
      s = { n: 1, last: null, roots: new Map([[1, 1]]) };
      sources.set(id, s);
    }
    return s;
  };
  const keyFor = (id: string, n: number) => (id === '' ? `ext:${n}` : n === 1 ? id : `${id}#${n}`);
  const rootOf = (key: string): { source: string; root: number } | null => {
    const g = given.get(key);
    const root = g ? sources.get(g.source)?.roots.get(g.n) : undefined;
    return g && root !== undefined ? { source: g.source, root } : null;
  };
  return {
    keyOf(turn) {
      const t = typeof turn === 'string' ? turn : '';
      if (t && !(t.startsWith('mcp:') && t.length > 'mcp:'.length)) return `turn:${t}`;
      const s = sourceOf(t);
      if (s.last) {
        const idle = now() - s.last.at > EXTERNAL_IDLE_MS;
        if (idle || o.committed() !== s.last.doc) {
          const root = idle ? s.n + 1 : (s.roots.get(s.n) ?? s.n);
          s.n += 1;
          s.roots.set(s.n, root);
          if (s.roots.size > ROOTS_KEPT) s.roots.delete(s.roots.keys().next().value as number);
        }
      }
      const key = keyFor(t, s.n);
      given.delete(key);
      given.set(key, { source: t, n: s.n });
      // Only the newest keys are remembered. A key evicted here no longer matches sameSession,
      // so a pause tied to it would not hold for its session; that takes 256 newer outside keys
      // first, far beyond any real use.
      if (given.size > ROOTS_KEPT * 4) given.delete(given.keys().next().value as string);
      return key;
    },
    ended(key) {
      const g = given.get(key);
      if (g) sourceOf(g.source).last = { at: now(), doc: o.committed() };
    },
    sameSession(a, b) {
      const ra = rootOf(a);
      const rb = rootOf(b);
      return ra !== null && rb !== null && ra.source === rb.source && ra.root === rb.root;
    },
  };
}

/** The key's kind, for labels ("Assistant (other app): ..."). */
export function keyKind(key: string): 'turn' | 'external' {
  return key.startsWith('turn:') ? 'turn' : 'external';
}
