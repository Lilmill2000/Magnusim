// The camera latch (CAD tools spec §8.5, §12.1 camera.test.ts): the Assistant's own sketch turns
// the view Normal to its plane on entry (auto: true) at the watch pace, until the person moves the
// camera during the turn; then automatic moves stay off for the rest of the turn, and the next
// turn takes a new baseline when it starts running (the host's turn events) or at its first call
// (an outside client). Off at the fast pace, while the window is hidden and while a pointer is
// held; always on for the person's own sessions. After a kept edit the view frames again when
// bodies left it (refitIfOffScreen with auto), under the same rule. On the REAL kernel and solver
// through sketch mode, with a recording viewport handle.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCameraLatch } from '../../src/assistant/camera';
import { runtimeOf } from '../../src/assistant/runtime';
import { createStateStore } from '../../src/lib/store';
import type { ViewportHandle } from '../../src/types/viewport';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** A viewport handle that records its camera calls; `moves` is the person's camera moves so far. */
function recordingHandle() {
  const calls: { call: string; auto: boolean }[] = [];
  const handle = {
    moves: 0,
    userCameraMoves() {
      return handle.moves;
    },
    lookAt: (_n: unknown, _u: unknown, o?: { auto?: boolean }) => void calls.push({ call: 'lookAt', auto: !!o?.auto }),
    reframe: (o?: { auto?: boolean }) => {
      calls.push({ call: 'reframe', auto: !!o?.auto });
      return true;
    },
    refitIfOffScreen: (o?: { auto?: boolean }) => {
      calls.push({ call: 'refit', auto: !!o?.auto });
      return false;
    },
    calls,
  };
  return handle;
}

const square = (name: string) =>
  SK({ name, entities: [E('r', 'center_rect', [0, 0, 20, 20])], constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '20 mm'), C('dh', 'distance', ['r.left'], '20 mm')] });

describe('the latch on a sketch the Assistant draws', () => {
  it(
    'turns the view on entry until the person moves the camera in the turn; a new turn starts again; refits after a kept edit',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      const vh = recordingHandle();
      h.services.viewport.set({ handle: vh as unknown as ViewportHandle });
      const entries = () => vh.calls.filter((c) => c.call === 'lookAt').length;
      // Turn 1 runs: its baseline is taken now.
      h.fake.emitTurn({ id: 't1', title: 'Squares' });
      expect((await h.call('sketch', square('A'), { turn: 't1' })).ok).toBe(true);
      expect(entries()).toBe(1);
      expect(vh.calls.every((c) => c.auto)).toBe(true);
      expect(vh.calls.some((c) => c.call === 'refit')).toBe(true);
      // The person drags the view: the rest of turn 1 keeps the camera still (no entry turn, no refit).
      vh.moves += 1;
      vh.calls.length = 0;
      expect((await h.call('sketch', square('B'), { turn: 't1' })).ok).toBe(true);
      expect(vh.calls).toEqual([]);
      expect(runtimeOf(h.services)!.camera.latched('turn:t1')).toBe(true);
      // Turn 2: a new baseline when it starts running; the view turns again.
      h.fake.emitTurn({ id: 't1', title: 'Squares', state: 'ended', end: { state: 'done', reason: 'done' } });
      h.fake.emitTurn({ id: 't2', title: 'More squares' });
      expect((await h.call('sketch', square('C'), { turn: 't2' })).ok).toBe(true);
      expect(entries()).toBe(1);
      // An outside client's calls (no turn): the baseline at its first call.
      vh.calls.length = 0;
      expect((await h.call('sketch', square('D'), { turn: '' })).ok).toBe(true);
      expect(entries()).toBe(1);
      vh.moves += 1;
      vh.calls.length = 0;
      expect((await h.call('sketch', square('E'), { turn: '' })).ok).toBe(true);
      expect(entries()).toBe(0);
    },
    REAL_KERNEL_MS,
  );

  it(
    'never at the fast pace; the person\'s own sketch always turns the view',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'fast' });
      const vh = recordingHandle();
      h.services.viewport.set({ handle: vh as unknown as ViewportHandle });
      h.fake.emitTurn({ id: 't1' });
      expect((await h.call('sketch', square('A'), { turn: 't1' })).ok).toBe(true);
      expect(vh.calls).toEqual([]);
      // The person's own New sketch: Normal to as always (with auto: the app's move, not theirs).
      h.mode!.newSketch({ kind: 'plane', plane: 'origin:top' });
      await vi.waitFor(() => expect(h!.mode!.active).toBe(true));
      expect(vh.calls).toEqual([{ call: 'lookAt', auto: true }]);
    },
    REAL_KERNEL_MS,
  );
});

describe('createCameraLatch', () => {
  it('allows only at the watch pace, with the window shown, no pointer held and the key not latched', () => {
    const handle = { moves: 0, userCameraMoves: () => handle.moves };
    const viewport = createStateStore<{ handle: ViewportHandle | null }>({ handle: handle as unknown as ViewportHandle });
    const state = { pace: 'watch' as 'watch' | 'fast', hidden: false, held: false };
    const latch = createCameraLatch({ viewport, pace: { get: () => state.pace, hidden: () => state.hidden }, soft: { held: () => state.held } });
    latch.turnRuns('turn:a');
    expect(latch.allows('turn:a')).toBe(true);
    // A key with no baseline yet is not latched; its first call takes one.
    expect(latch.allows('ext:1')).toBe(true);
    latch.callStarts('ext:1');
    state.pace = 'fast';
    expect(latch.allows('turn:a')).toBe(false);
    state.pace = 'watch';
    state.hidden = true;
    expect(latch.allows('turn:a')).toBe(false);
    state.hidden = false;
    state.held = true;
    expect(latch.allows('turn:a')).toBe(false);
    state.held = false;
    handle.moves = 3;
    expect(latch.allows('turn:a')).toBe(false);
    expect(latch.allows('ext:1')).toBe(false);
    // Latched for good, even if the count were to read the same again; a later baseline is free.
    handle.moves = 0;
    expect(latch.latched('turn:a')).toBe(true);
    latch.turnRuns('turn:b');
    expect(latch.allows('turn:b')).toBe(true);
    // A viewport without the count never latches.
    viewport.set({ handle: {} as ViewportHandle });
    latch.turnRuns('turn:c');
    expect(latch.allows('turn:c')).toBe(true);
  });
});
