// The pace of the Assistant's edits (CAD tools spec §8.2, §12.1 pace.test.ts), on fake timers:
//   - watch pace waits each pace point's delay; fast never waits;
//   - no wait while the window is hidden, after a rebuild over 1.5 s, or with the test scale 0;
//     a scale stretches or shrinks every delay;
//   - a call's waits add up to at most 6 s: a planned call longer than that is scaled down, and the
//     budget caps the rest;
//   - a Stop mid-delay rejects at once; one before the wait never starts it;
//   - the person's choice is read from ws.prefs, written there, and heard from another tab; a
//     test's override wins and is never written;
//   - macrotask() needs no timer;
//   - an edit call in watch pace waits at its pace points; in fast pace it does not.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrefsApi } from '../../src/lib/bridge';
import { CALL_PACE_CAP_MS, createPace, macrotask, PACE_DELAYS, PACE_PREF, SLOW_REBUILD_MS, type Pace } from '../../src/assistant/pace';
import { createStateStore } from '../../src/lib/store';
import type { DocState } from '../../src/types/doc-service';
import { BlockKernel } from '../doc/blocks';
import { assistantHarness } from './harness';

afterEach(() => {
  vi.useRealTimers();
});

const docOf = (ms: number | null = 20) => ({ state: createStateStore({ rebuild: { ms } } as unknown as DocState) });
const page = (hidden = false) => ({ hidden }) as unknown as Document;
const signal = () => new AbortController().signal;

/** How long a wait takes on the fake clock, in ms (null when it never ends within `max`). */
async function took(p: Promise<number>, max = 20_000): Promise<number | null> {
  let done = false;
  void p.then(() => void (done = true));
  const t0 = Date.now();
  for (let i = 0; i < max && !done; i += 1) await vi.advanceTimersByTimeAsync(1);
  return done ? Date.now() - t0 : null;
}

describe('the delays', () => {
  it('watch waits each pace point; fast never does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pace = createPace({ doc: docOf(), prefs: null, document: page() });
    expect(pace.get()).toBe('watch');
    const call = pace.forCall(signal());
    expect(await took(call.wait('open'))).toBe(PACE_DELAYS.open);
    expect(await took(call.wait('commit'))).toBe(PACE_DELAYS.commit);
    expect(call.spent()).toBe(PACE_DELAYS.open + PACE_DELAYS.commit);
    pace.set('fast');
    expect(pace.live()).toBe(false);
    expect(await pace.forCall(signal()).wait('open')).toBe(0);
  });

  it('none while hidden, after a slow rebuild or with the scale 0; the scale stretches the rest', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(createPace({ doc: docOf(), prefs: null, document: page(true) }).live()).toBe(false);
    expect(createPace({ doc: docOf(SLOW_REBUILD_MS + 1), prefs: null, document: page() }).live()).toBe(false);
    expect(createPace({ doc: docOf(SLOW_REBUILD_MS), prefs: null, document: page() }).live()).toBe(true);
    const pace = createPace({ doc: docOf(), prefs: null, document: page() });
    pace.setScale(0);
    expect(await pace.forCall(signal()).wait('open')).toBe(0);
    pace.setScale(0.5);
    expect(await took(pace.forCall(signal()).wait('open'))).toBe(Math.round(PACE_DELAYS.open * 0.5));
    pace.setScale(null);
    expect(await took(pace.forCall(signal()).wait('dimension'))).toBe(PACE_DELAYS.dimension);
  });

  it("caps a call's waits at 6 s: a long plan is scaled down, and the budget caps the rest", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pace = createPace({ doc: docOf(), prefs: null, document: page() });
    const call = pace.forCall(signal());
    // 40 dimensions of 150 ms and 10 opens of 450 ms: 10.5 s planned.
    call.plan(40 * PACE_DELAYS.dimension + 10 * PACE_DELAYS.open);
    expect(await took(call.wait('open'))).toBe(Math.round(PACE_DELAYS.open * (CALL_PACE_CAP_MS / 10_500)));
    // An unplanned call: each delay as it is until the budget runs out.
    const greedy = pace.forCall(signal());
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const w = greedy.wait('open');
      await vi.advanceTimersByTimeAsync(PACE_DELAYS.open);
      total += await w;
    }
    expect(total).toBe(CALL_PACE_CAP_MS);
    expect(greedy.spent()).toBe(CALL_PACE_CAP_MS);
    expect(await greedy.wait('open')).toBe(0);
  });

  it('a Stop mid-delay rejects at once; one before never starts it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pace = createPace({ doc: docOf(), prefs: null, document: page() });
    const ctl = new AbortController();
    const call = pace.forCall(ctl.signal);
    const w = call.wait('open');
    const caught = w.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort(new DOMException('stopped', 'AbortError'));
    expect(await caught).toMatchObject({ name: 'AbortError' });
    await expect(call.wait('open')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe("the person's choice", () => {
  it('is read from ws.prefs, written there, and heard from another tab', async () => {
    const stored = new Map<string, unknown>([[PACE_PREF, 'fast']]);
    let hear: ((key: string, value: unknown) => void) | null = null;
    const prefs: PrefsApi = {
      get: async <T,>(k: string) => (stored.get(k) ?? null) as T | null,
      set: async (k, v) => void stored.set(k, v),
      remove: async (k) => void stored.delete(k),
      onChange: (fn) => {
        hear = fn;
        return () => (hear = null);
      },
    };
    const pace = createPace({ doc: docOf(), prefs, document: page() });
    const heard: Pace[] = [];
    pace.subscribe((p) => void heard.push(p));
    await vi.waitFor(() => expect(pace.get()).toBe('fast'), { timeout: 10_000 });
    pace.set('watch');
    expect(stored.get(PACE_PREF)).toBe('watch');
    hear!(PACE_PREF, 'fast');
    expect(pace.get()).toBe('fast');
    hear!('other', 'watch');
    expect(heard).toEqual(['fast', 'watch', 'fast']);
    // A test's override wins and is never written; null gives the person's back.
    pace.force('watch');
    expect(pace.get()).toBe('watch');
    expect(stored.get(PACE_PREF)).toBe('watch');
    stored.set(PACE_PREF, 'fast');
    pace.force('watch');
    expect(stored.get(PACE_PREF)).toBe('fast');
    pace.force(null);
    expect(pace.get()).toBe('fast');
    pace.dispose();
    expect(hear).toBeNull();
  });

  it('macrotask needs no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    let done = false;
    void macrotask().then(() => void (done = true));
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
  });
});

describe('an edit call', () => {
  it('waits at its pace points in watch pace, and not in fast pace', async () => {
    const PARAM = (name: string) => ({ set: [{ name, kind: 'length', expr: '1 mm', comment: '', rename_to: '' }], remove: [] });
    const watch = await assistantHarness({ kernel: new BlockKernel(), solver: false, pace: 'watch', paceScale: 1 });
    try {
      const t0 = Date.now();
      expect((await watch.call('set_params', PARAM('a'))).ok).toBe(true);
      // The parameter row, then the commit (a lower bound: never a race).
      expect(Date.now() - t0).toBeGreaterThanOrEqual(PACE_DELAYS.param + PACE_DELAYS.commit - 20);
    } finally {
      watch.dispose();
    }
    const fast = await assistantHarness({ kernel: new BlockKernel(), solver: false });
    try {
      const t1 = Date.now();
      expect((await fast.call('set_params', PARAM('a'))).ok).toBe(true);
      expect(Date.now() - t1).toBeLessThan(5_000);
    } finally {
      fast.dispose();
    }
  });
});
