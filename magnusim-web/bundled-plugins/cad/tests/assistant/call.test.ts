// One call of a Part tool from the bridge to the reply (CAD tools spec §2.1 call.ts, §3.0, §3.1, §8.3),
// over the fake host and a toy kernel:
//   - this build answers all 18 tools; a build without one (a tools table without it) answers
//     not_ready "not in this build yet", with its reason, hint and detail, and help features marks
//     its row; on a host without turn events the hint is in the message;
//   - every reply carries rev; a call's key, tool and outcome go to the ledger (__CAD__.assistant.calls)
//     and the 'assistant:call' events; a step's edits told their place get one picture, on the last;
//   - a read waits for the kernel to start (a sign of life every 5 s) and answers not_ready after 30 s;
//   - the chip's phase: thinking while the turn runs, working during a call, ended when it ended
//     (until the next change of the Part, or 120 s), idle; on a host without turn events, the chip
//     stays 10 s after the last call.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall } from '@magnusim/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_WAIT_MS } from '../../src/assistant/busy';
import { createCallHandler, isBuilt } from '../../src/assistant/call';
import { HINTS } from '../../src/assistant/errors';
import { PICTURE_LATER } from '../../src/assistant/pictures';
import { runtimeOf } from '../../src/assistant/runtime';
import { ENDED_MS, LINGER_MS } from '../../src/assistant/state';
import { TOOL_NAMES } from '../../src/assistant/schemas';
import * as BUILT from '../../src/assistant/tools';
import { setViewRaster } from '../../src/assistant/view';
import type { ToolImpl } from '../../src/types/assistant';
import { FakeKernel } from '../doc/fake-kernel';
import { assistantHarness, type AssistantHarness, type HarnessOptions } from './harness';
import { call as stubCall, fakeRaster, fakeViewport, placesOf, STUBS, type Answer } from './picture-fakes';

let h: AssistantHarness | null = null;
afterEach(() => {
  vi.useRealTimers();
  h?.dispose();
  h = null;
});

const start = (o: HarnessOptions = {}) => assistantHarness({ kernel: new FakeKernel(), ...o });
const phase = (x: AssistantHarness) => runtimeOf(x.services)!.store.get().phase;

const SWEEP = { edit: '', name: '', kind: 'sweep', profiles: ['Sketch 1'], path: 'Sketch 2', orientation: 'follow', ruled: false, op: 'new', bodies: [], body_name: '', color: '' };
const HOLE = { name: '', face: 'Extrude 1.end', centers: [{ x: '0 mm', y: '0 mm', z: '' }], diameter: '5 mm', depth: 'through', distance: '' };

/** This build's tools table without `name`: a build that tool has not reached yet. */
const without = (name: string): Record<string, ToolImpl> => Object.fromEntries(Object.entries(BUILT as unknown as Record<string, ToolImpl>).filter(([k]) => k !== name));

/** One call straight to a handler, as the bridge sends it; its error as the host reads it. */
async function errorOf(handler: (c: AssistantCall) => Promise<unknown>, tool: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const call: AssistantCall = { call: 'c-1', turn: 't-test', tool, input, signal: new AbortController().signal, progress: () => {} };
  try {
    await handler(call);
    return null;
  } catch (e) {
    const x = e as { code?: string; message?: string; hint?: string; detail?: unknown };
    return { code: x.code, message: x.message, ...(x.hint !== undefined ? { hint: x.hint } : {}), ...(x.detail !== undefined ? { detail: x.detail } : {}) };
  }
}

describe('tools not in this build', () => {
  it('this build answers all 18: help features marks none of them', async () => {
    h = await start();
    for (const name of TOOL_NAMES) expect(isBuilt(name), name).toBe(true);
    const help = await h.ok('help', { topic: 'features' });
    const rows = (help.data as { rows: { about: string; text: string }[] }).rows;
    expect(rows.map((x) => x.about)).toEqual([...TOOL_NAMES]);
    expect(rows.filter((x) => /Not in this build yet/.test(x.text)).map((x) => x.about)).toEqual([]);
  });

  it('a build without a tool answers not_ready "not in this build yet", with the reason, its hint and the tool in detail', async () => {
    h = await start();
    const rt = runtimeOf(h.services)!;
    expect(await errorOf(createCallHandler(rt, without('sweep_loft')), 'sweep_loft', SWEEP)).toEqual({
      code: 'not_ready',
      message: 'not_built: sweep_loft is not in this build yet.',
      hint: HINTS.not_built,
      detail: { reason: 'not_built', tool: 'sweep_loft' },
    });
    // The ledger records it as any other call.
    expect(rt.calls.at(-1)).toMatchObject({ tool: 'sweep_loft', ok: false, code: 'not_ready', reason: 'not_built' });
    // help features marks the row of a tool the build does not answer, and only that one.
    rt.isBuilt = (name) => name !== 'sweep_loft';
    const help = await h.ok('help', { topic: 'features' });
    const rows = (help.data as { rows: { about: string; text: string }[] }).rows;
    expect(rows.find((x) => x.about === 'sweep_loft')!.text).toMatch(/Not in this build yet\.$/);
    expect(rows.filter((x) => /Not in this build yet/.test(x.text)).map((x) => x.about)).toEqual(['sweep_loft']);
  });

  it('on a host without turn events the hint goes in the message', async () => {
    h = await start({ assistant: { turns: false } });
    expect(await errorOf(createCallHandler(runtimeOf(h.services)!, without('hole')), 'hole', HOLE)).toEqual({
      code: 'not_ready',
      message: `not_built: hole is not in this build yet. Try: ${HINTS.not_built}`,
    });
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
    await h.call('help', { topic: 'nothing' }, { turn: '' });
    const calls = runtimeOf(h.services)!.calls;
    expect(calls.map(({ ms: _ms, call: _c, ...c }) => c)).toEqual([
      { turn: 't-7', key: 'turn:t-7', tool: 'help', ok: true },
      { turn: '', key: 'ext:1', tool: 'help', ok: false, code: 'invalid_input', reason: 'bad_input' },
    ]);
    expect(events).toEqual([
      { turn: 't-7', call: 'c-1', tool: 'help', phase: 'start' },
      { turn: 't-7', call: 'c-1', tool: 'help', phase: 'end', ok: true },
      { turn: '', call: 'c-2', tool: 'help', phase: 'start' },
      { turn: '', call: 'c-2', tool: 'help', phase: 'end', ok: false },
    ]);
  });

  it("a step of 5 extrudes told editsLeftInStep 4..0: one picture, on the 5th; the first 4 say picture: see this step's last edit; reads between them change nothing; without the place, 5 pictures as before", async () => {
    h = await start();
    const fv = fakeViewport(h);
    fakeRaster();
    try {
      const rt = runtimeOf(h.services)!;
      const run = async (tools: string[], turn: string, place: boolean) => {
        const places = placesOf(tools);
        const out: Answer[] = [];
        for (const [i, tool] of tools.entries()) out.push(await stubCall(h!, tool, turn, STUBS, place ? places[i] : {}));
        return out;
      };
      const images = (rs: Answer[]) => rs.map((r) => (r.ok ? (r.result.images?.length ?? 0) : -1));
      const CAPTION = expect.stringMatching(/^Picture: iso view of the Part/);
      const FIVE = ['extrude', 'extrude', 'extrude', 'extrude', 'extrude'];
      expect(placesOf(FIVE).map((p) => p.editsLeftInStep)).toEqual([4, 3, 2, 1, 0]);
      const step = await run(FIVE, 't-step', true);
      expect(images(step)).toEqual([0, 0, 0, 0, 1]);
      expect(step.map((r) => r.ok && r.result.data.picture)).toEqual([...Array(4).fill(PICTURE_LATER), CAPTION]);
      expect(PICTURE_LATER).toBe("see this step's last edit");
      expect(fv.shots).toHaveLength(1);
      expect(rt.calls.slice(-5).map((c) => c.images ?? 0)).toEqual([0, 0, 0, 0, 1]);
      // Reads between the edits: still one picture, on the last edit.
      const mixed = await run(['extrude', 'get_model', 'extrude', 'find', 'extrude', 'measure'], 't-mixed', true);
      expect(images(mixed)).toEqual([0, 0, 0, 0, 1, 0]);
      expect(mixed.map((r) => r.ok && r.result.data.picture)).toEqual([PICTURE_LATER, undefined, PICTURE_LATER, undefined, CAPTION, undefined]);
      expect(fv.shots).toHaveLength(2);
      // A host that says no place: each extrude gets its own.
      const each = await run(FIVE, 't-each', false);
      expect(images(each)).toEqual([1, 1, 1, 1, 1]);
      expect(fv.shots).toHaveLength(7);
    } finally {
      setViewRaster(null);
    }
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
    h.fake.emitTurn({ id: 't-1', title: 'Plate with four holes', used: { steps: 3, stepsCap: 120, changes: 0, changesCap: 0, usd: 0.2, usdCap: 8 } });
    expect(phase(h)).toBe('thinking');
    expect(rt.store.get().turn).toEqual({ id: 't-1', title: 'Plate with four holes', steps: 3, stepsCap: 120, changes: null, changesCap: null, end: null });
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

describe("get_model's limits", () => {
  it("what is left of the turn's steps and dollars; a coding agent's turn (no dollars counted: usdCap 0) says its steps and what is left of its change limit, which its edits meet long before its call limit", async () => {
    h = await start();
    h.fake.emitTurn({ id: 't-key', title: 'Plate', used: { steps: 3, stepsCap: 120, changes: 0, changesCap: 0, usd: 0.2, usdCap: 8 } });
    expect((await h.ok('get_model', { detail: 'brief', feature: '' }, { turn: 't-key' })).data.limits).toEqual({ steps_left: 117, usd_left: 7.8 });
    h.fake.emitTurn({ id: 't-agent', title: 'Plate', images: null, used: { steps: 5, stepsCap: 400, changes: 3, changesCap: 24, usd: 0, usdCap: 0 } });
    expect((await h.ok('get_model', { detail: 'brief', feature: '' }, { turn: 't-agent' })).data.limits).toEqual({ steps_left: 395, changes_left: 21 });
    // Every change made: none left (never below 0), its reads still go on.
    h.fake.emitTurn({ id: 't-agent', title: 'Plate', images: null, used: { steps: 40, stepsCap: 400, changes: 24, changesCap: 24, usd: 0, usdCap: 0 } });
    expect((await h.ok('get_model', { detail: 'brief', feature: '' }, { turn: 't-agent' })).data.limits).toEqual({ steps_left: 360, changes_left: 0 });
  });
});
