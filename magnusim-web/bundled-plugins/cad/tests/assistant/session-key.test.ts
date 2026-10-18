// @vitest-environment node
// Which group a call belongs to (CAD tools spec §1.2, §7.9; session-key.ts), on a fake clock: a
// turn's calls key by the turn; an outside client's calls with no turn share ext:<n> while they
// keep coming within 5 minutes and the person changed nothing between them; a change by the person
// or 5 idle minutes starts a new one; "mcp:<session>" turns key by their session, by the same
// rules (#2, #3, …); a new page starts again; keys that went up only because the person changed
// the Part are one session for the pause (sameSession), 5 idle minutes are not. And the reply
// budgets by key (turn-info.ts): local turns get the smaller ones.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createSessionKeys, EXTERNAL_IDLE_MS, keyKind } from '../../src/assistant/session-key';
import { BUDGETS, createTurnInfo } from '../../src/assistant/turn-info';
import type { CadDoc } from '../../src/types/doc';

const doc = (n: number) => ({ n }) as unknown as CadDoc;

function keys() {
  let t = 1_000_000;
  let committed = doc(1);
  const k = createSessionKeys({ now: () => t, committed: () => committed });
  return {
    k,
    later: (ms: number) => void (t += ms),
    change: () => void (committed = doc(Math.random())),
    /** A call under its key, start to end, as call.ts runs it. */
    call(turn: string) {
      const key = k.keyOf(turn);
      k.ended(key);
      return key;
    },
  };
}

describe('session keys', () => {
  it("a turn's calls key by the turn", () => {
    const { call } = keys();
    expect(call('t-abc')).toBe('turn:t-abc');
    expect(call('t-abc')).toBe('turn:t-abc');
    expect(call('t-def')).toBe('turn:t-def');
    expect(keyKind('turn:t-abc')).toBe('turn');
  });

  it("outside calls share ext:<n> within 5 minutes with no change of the person's between them", () => {
    const { call, later } = keys();
    expect(call('')).toBe('ext:1');
    later(EXTERNAL_IDLE_MS - 1);
    expect(call('')).toBe('ext:1');
    later(EXTERNAL_IDLE_MS - 1);
    expect(call('')).toBe('ext:1');
    expect(keyKind('ext:1')).toBe('external');
  });

  it('5 idle minutes start a new outside session', () => {
    const { call, later } = keys();
    expect(call('')).toBe('ext:1');
    later(EXTERNAL_IDLE_MS + 1);
    expect(call('')).toBe('ext:2');
    expect(call('')).toBe('ext:2');
  });

  it("the person's change of the committed Part between outside calls starts a new one; a change inside a call does not", () => {
    const { k, call, change } = keys();
    expect(call('')).toBe('ext:1');
    change();
    expect(call('')).toBe('ext:2');
    // The Assistant's own change happens inside its call: the Part is taken again at its end.
    const key = k.keyOf('');
    change();
    k.ended(key);
    expect(key).toBe('ext:2');
    expect(call('')).toBe('ext:2');
  });

  it("keys that went up only because the person changed the Part are one session for the pause; 5 idle minutes start another", () => {
    const { k, call, change, later } = keys();
    expect(call('')).toBe('ext:1');
    change();
    expect(call('')).toBe('ext:2');
    change();
    expect(call('')).toBe('ext:3');
    expect(k.sameSession('ext:1', 'ext:3')).toBe(true);
    expect(k.sameSession('ext:2', 'ext:3')).toBe(true);
    later(EXTERNAL_IDLE_MS + 1);
    expect(call('')).toBe('ext:4');
    expect(k.sameSession('ext:3', 'ext:4')).toBe(false);
    change();
    expect(call('')).toBe('ext:5');
    expect(k.sameSession('ext:4', 'ext:5')).toBe(true);
    expect(k.sameSession('ext:1', 'ext:5')).toBe(false);
    // Turn keys, mcp keys and unknown ext keys are no session of an outside client's.
    expect(k.sameSession('turn:t-1', 'turn:t-1')).toBe(false);
    expect(k.sameSession('mcp:a', 'mcp:a')).toBe(false);
    expect(k.sameSession('ext:9', 'ext:9')).toBe(false);
  });

  it('"mcp:<session>" turns key by their session; a new page starts at ext:1 again', () => {
    const { call } = keys();
    expect(call('mcp:abc')).toBe('mcp:abc');
    expect(call('mcp:abc')).toBe('mcp:abc');
    expect(call('mcp:')).toBe('turn:mcp:');
    expect(keyKind('mcp:abc')).toBe('external');
    expect(keys().call('')).toBe('ext:1');
  });

  it("another app's connection (turn \"mcp:<connection>\", open as long as the app runs) is grouped as outside calls are: mcp:<session> while its calls keep coming, then #2 after 5 idle minutes and #3 after the person's change, one session for the pause with #2; another connection and calls with no turn keep their own", () => {
    const { k, call, change, later } = keys();
    expect(call('mcp:m-1')).toBe('mcp:m-1');
    later(EXTERNAL_IDLE_MS - 1);
    expect(call('mcp:m-1')).toBe('mcp:m-1');
    later(EXTERNAL_IDLE_MS + 1);
    expect(call('mcp:m-1')).toBe('mcp:m-1#2');
    expect(call('mcp:m-2')).toBe('mcp:m-2');
    expect(call('mcp:m-1')).toBe('mcp:m-1#2');
    change();
    expect(call('mcp:m-1')).toBe('mcp:m-1#3');
    expect(k.sameSession('mcp:m-1#2', 'mcp:m-1#3')).toBe(true);
    expect(k.sameSession('mcp:m-1', 'mcp:m-1#2')).toBe(false);
    expect(k.sameSession('mcp:m-1#3', 'mcp:m-2')).toBe(false);
    expect(k.sameSession('mcp:m-1#3', 'ext:1')).toBe(false);
    expect(call('')).toBe('ext:1');
    expect(keyKind('mcp:m-1#3')).toBe('external');
  });
});

describe('reply budgets', () => {
  it('a local turn gets the local budgets; cloud turns, outside calls and unknown turns the cloud ones', () => {
    const t = createTurnInfo();
    t.take({ id: 't-local', state: 'running', title: 'Plate', local: true, contextTokens: 32768, images: false, used: { steps: 1, stepsCap: 120, usd: 0, usdCap: 8 } });
    t.take({ id: 't-cloud', state: 'running', title: 'Plate', local: false, contextTokens: null, images: true, used: { steps: 1, stepsCap: 120, usd: 0.1, usdCap: 8 } });
    expect(t.budgets('turn:t-local')).toBe(BUDGETS.local);
    expect(t.budgets('turn:t-cloud')).toBe(BUDGETS.cloud);
    expect(t.budgets('turn:t-unknown')).toBe(BUDGETS.cloud);
    expect(t.budgets('ext:1')).toBe(BUDGETS.cloud);
    expect(BUDGETS.local).toMatchObject({ brief: 3072, briefCollapse: 30, full: 12288, sketch: 8192, viewSize: 'small' });
    expect(BUDGETS.cloud).toMatchObject({ brief: 8192, briefCollapse: 80, full: 24576, sketch: 16384 });
  });
});
