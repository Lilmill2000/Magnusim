// Which group a call belongs to (CAD tools spec §1.2, §7.9): the key of its undo group, handle
// table, ledger, camera latch and "what the person changed" baseline.
//   turn:<id>     a call of one of the app's turns (AssistantCall.turn);
//   mcp:<session> an outside client's call that names its session (turn "mcp:<session>");
//   ext:<n>       an outside client's call with no turn (turn ""): one session while its calls
//                 keep coming. n goes up after 5 minutes without such a call, when the person
//                 changed the committed Part between two of them, and on every page load (the
//                 counter lives in this page). A key that went up only because the person
//                 changed the Part is the same session for the pause (sameSession): the
//                 person's own change never lifts their Pause, or a take-over's.
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

/** Sessions remembered for sameSession (the newest). */
const ROOTS_KEPT = 64;

/**
 * `now` is the clock; `committed` the committed Part (DocService.committed): a person's change
 * between two outside calls starts a new outside session. The Assistant's own changes happen
 * inside its calls, and the Part is taken again at each call's end, so they never count.
 */
export function createSessionKeys(o: { now?: () => number; committed: () => CadDoc }): SessionKeys {
  const now = o.now ?? (() => Date.now());
  let n = 1;
  let last: { at: number; doc: CadDoc } | null = null;
  // Each outside key's first key of its session (a new one after 5 minutes without a call).
  const roots = new Map<number, number>([[1, 1]]);
  const rootOf = (key: string): number | null => {
    const m = /^ext:(\d+)$/.exec(key);
    return m ? (roots.get(Number(m[1])) ?? null) : null;
  };
  return {
    keyOf(turn) {
      const t = typeof turn === 'string' ? turn : '';
      if (t.startsWith('mcp:') && t.length > 'mcp:'.length) return t;
      if (t) return `turn:${t}`;
      if (last) {
        const idle = now() - last.at > EXTERNAL_IDLE_MS;
        if (idle || o.committed() !== last.doc) {
          const root = idle ? n + 1 : (roots.get(n) ?? n);
          n += 1;
          roots.set(n, root);
          if (roots.size > ROOTS_KEPT) roots.delete(roots.keys().next().value as number);
        }
      }
      return `ext:${n}`;
    },
    ended(key) {
      if (key.startsWith('ext:')) last = { at: now(), doc: o.committed() };
    },
    sameSession(a, b) {
      const ra = rootOf(a);
      return ra !== null && ra === rootOf(b);
    },
  };
}

/** The key's kind, for labels ("Assistant (other app): ..."). */
export function keyKind(key: string): 'turn' | 'external' {
  return key.startsWith('turn:') ? 'turn' : 'external';
}
