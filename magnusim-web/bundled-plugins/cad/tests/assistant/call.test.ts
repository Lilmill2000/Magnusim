// One call of a Part tool from the bridge to the reply (CAD tools spec §2.1 call.ts, §3.0, §3.1, §8.3),
// over the fake host and a toy kernel:
//   - a tool not in this build answers not_ready "not in this build yet", with its reason, hint and
//     detail; on a host without turn events the hint is in the message;
//   - every reply carries rev; a call's key, tool and outcome go to the ledger (__CAD__.assistant.calls)
//     and the 'assistant:call' events;
//   - a read waits for the kernel to start (a sign of life every 5 s) and answers not_ready after 30 s;
//   - the chip's phase: thinking while the turn runs, working during a call, ended when it ended
//     (until the next change of the Part, or 120 s), idle; on a host without turn events, the chip
//     stays 10 s after the last call.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_WAIT_MS } from '../../src/assistant/busy';
import { HINTS } from '../../src/assistant/errors';
import { runtimeOf } from '../../src/assistant/runtime';
import { ENDED_MS, LINGER_MS } from '../../src/assistant/state';
import { TOOL_NAMES } from '../../src/assistant/schemas';
import { FakeKernel } from '../doc/fake-kernel';
import { assistantHarness, type AssistantHarness, type HarnessOptions } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  vi.useRealTimers();
  h?.dispose();
  h = null;
});

const start = (o: HarnessOptions = {}) => assistantHarness({ kernel: new FakeKernel(), ...o });
const phase = (x: AssistantHarness) => runtimeOf(x.services)!.store.get().phase;

const EXTRUDE = { edit: '', name: '', sketch: 'Sketch 1', regions: ['all'], extent: 'blind', distance: '5 mm', distance2: '', to: '', flip: false, op: 'new', bodies: [], body_name: '', color: '' };

describe('tools not in this build', () => {
  it('answer not_ready "not in this build yet", with the reason, its hint and the tool in detail', async () => {
    h = await start();
    const r = await h.call('extrude', EXTRUDE);
    expect(r).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'not_built: extrude is not in this build yet.', hint: HINTS.not_built, detail: { reason: 'not_built', tool: 'extrude' } },
    });
    // Every tool of the 18 is offered; the ones this build answers say so in help features.
    const help = await h.ok('help', { topic: 'features' });
    const rows = (help.data as { rows: { about: string; text: string }[] }).rows;
    expect(rows.map((x) => x.about)).toEqual([...TOOL_NAMES]);
    expect(rows.find((x) => x.about === 'extrude')!.text).toMatch(/Not in this build yet\.$/);
    expect(rows.find((x) => x.about === 'get_model')!.text).not.toMatch(/Not in this build yet/);
  });

  it('on a host without turn events the hint goes in the message', async () => {
    h = await start({ assistant: { turns: false } });
    const r = await h.call('view', { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small' });
    expect(r).toEqual({ ok: false, error: { code: 'not_ready', message: `not_built: view is not in this build yet. Try: ${HINTS.not_built}` } });
  });
});

describe('the reply and the ledger', () => {
  it("carries rev; the ledger and the events name the key, the tool and the outcome", async () => {
    h = await start();
    const events: unknown[] = [];
    h.services.bus.on('assistant:call', (e) => void events.push(e));
    const r = await h.ok('help', { topic: 'parameters' }, { turn: 't-7' });
    expect(r.data.rev).toBe(runtimeOf(h.services)!.rev.current());
    expect(r.text).toBe('help parameters: 4 rows');
    expect(r.summary).toBe('Read help parameters');
    await h.call('extrude', EXTRUDE, { turn: '' });
    const calls = runtimeOf(h.services)!.calls;
    expect(calls.map(({ ms: _ms, call: _c, ...c }) => c)).toEqual([
      { turn: 't-7', key: 'turn:t-7', tool: 'help', ok: true },
      { turn: '', key: 'ext:1', tool: 'extrude', ok: false, code: 'not_ready', reason: 'not_built' },
    ]);
    expect(events).toEqual([
      { turn: 't-7', call: 'c-1', tool: 'help', phase: 'start' },
      { turn: 't-7', call: 'c-1', tool: 'help', phase: 'end', ok: true },
      { turn: '', call: 'c-2', tool: 'extrude', phase: 'start' },
      { turn: '', call: 'c-2', tool: 'extrude', phase: 'end', ok: false },
    ]);
  });

  it('an aborted call answers busy stopped', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    rt.holds.hold('after-settled');
    const ctl = new AbortController();
    const r = h.call('get_model', { detail: 'brief', feature: '' }, { signal: ctl.signal });
    await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-settled']));
    ctl.abort();
    expect(await r).toMatchObject({ ok: false, error: { code: 'busy', message: 'stopped: The call was stopped.', detail: { reason: 'stopped' } } });
    expect(rt.holds.waiting()).toEqual([]);
  });
});

describe('a read and the kernel', () => {
  it('waits for the kernel to start, then answers', async () => {
    const kernel = new FakeKernel();
    h = await start({ kernel });
    // The kernel restarts (its store says so, as a respawn does).
    kernel.status.set({ state: 'restarting' });
    let done = false;
    const r = h.call('get_model', { detail: 'brief', feature: '' }).finally(() => void (done = true));
    await new Promise((res) => setTimeout(res, 30));
    expect(done).toBe(false);
    kernel.status.set({ state: 'ready' });
    expect((await r).ok).toBe(true);
  });

  it('gives a sign of life every 5 s and answers not_ready kernel_starting after 30 s', async () => {
    const kernel = new FakeKernel();
    h = await start({ kernel });
    kernel.status.set({ state: 'starting' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const r = h.call('get_model', { detail: 'brief', feature: '' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.fake.progress.map((p) => p.label)).toEqual(['Waiting for the Part to open']);
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS);
    expect(await r).toMatchObject({ ok: false, error: { code: 'not_ready', message: 'kernel_starting: The geometry kernel is still starting.', hint: HINTS.kernel_starting } });
  });
});

describe("the chip's phase", () => {
  it('thinking while the turn runs, working during a call, ended until the next change of the Part, then idle', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    expect(phase(h)).toBe('idle');
    h.fake.emitTurn({ id: 't-1', title: 'Plate with four holes', used: { steps: 3, stepsCap: 120, usd: 0.2, usdCap: 8 } });
    expect(phase(h)).toBe('thinking');
    expect(rt.store.get().turn).toEqual({ id: 't-1', title: 'Plate with four holes', steps: 3, stepsCap: 120, end: null });
    rt.holds.hold('after-settled');
    const r = h.call('get_model', { detail: 'brief', feature: '' }, { turn: 't-1' });
    await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['after-settled']));
    expect(phase(h)).toBe('working');
    expect(rt.store.get().call).toEqual({ tool: 'get_model', label: 'Read the Part' });
    rt.holds.release('after-settled');
    await r;
    expect(phase(h)).toBe('thinking');
    h.fake.emitTurn({ id: 't-1', title: 'Plate with four holes', state: 'ended', end: { state: 'done', reason: 'done' } });
    expect(phase(h)).toBe('ended');
    expect(rt.store.get().turn?.end).toBe('done');
    // The next change of the Part (the person's) ends the chip's "done".
    h.doc.addParam({ name: 'w', expr: '40 mm', quantity: 'length' });
    expect(phase(h)).toBe('idle');
  });

  it('an ended turn shows for 120 s', async () => {
    h = await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.fake.emitTurn({ id: 't-2', title: 'Bracket' });
    h.fake.emitTurn({ id: 't-2', title: 'Bracket', state: 'ended', end: { state: 'stopped', reason: 'stopped' } });
    expect(phase(h)).toBe('ended');
    await vi.advanceTimersByTimeAsync(ENDED_MS - 10);
    expect(phase(h)).toBe('ended');
    await vi.advanceTimersByTimeAsync(20);
    expect(phase(h)).toBe('idle');
  });

  it('on a host without turn events: working during a call, then thinking for 10 s, then idle', async () => {
    let t = 1_000_000;
    h = await start({ assistant: { turns: false }, now: () => t });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await h.ok('help', { topic: 'errors' }, { turn: 't-3' });
    expect(phase(h)).toBe('thinking');
    t += LINGER_MS + 20;
    await vi.advanceTimersByTimeAsync(LINGER_MS + 20);
    expect(phase(h)).toBe('idle');
  });
});
