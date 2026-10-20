// The Part's link to the app's Assistant (CAD tools spec §2.2 bridge.ts, §2.1 install.ts), over the
// fake host (tests/fakes/assistant-sdk.ts):
//   - the bridge's guard: no ws.assistant -> null; a host without turn events -> onTurn and stop
//     null; an older host's not_allowed -> {available: false, reason: 'not_allowed'};
//   - one registration of the 18 tools with the guide, the turns heard before it;
//   - the eval's core set (setToolset('core')): its 13 tools with the guide that names only them,
//     help's guide topic that guide and help features marking the 5 not offered; 'all' brings
//     the 18 and the guide back;
//   - after not_connected the tools are offered again when the tab shows (not while hidden), and
//     never again after remote, no_assistant or not_allowed;
//   - a call's progress keeps `waiting` on its way to the host;
//   - uninstall withdraws the tools.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantCall, AssistantRegistration, Workspace } from '@magnusim/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCallHandler } from '../../src/assistant/call';
import { GUIDE, guideWithout, namedInGuide, notOfferedLine } from '../../src/assistant/guide';
import { HELP, HELP_TOPIC_BYTES, NOT_OFFERED } from '../../src/assistant/help';
import { assistantTestHandle } from '../../src/assistant/install';
import { REVIEW_PROMPT } from '../../src/assistant/review';
import { runtimeOf } from '../../src/assistant/runtime';
import { CORE_TOOLSET, TOOL_NAMES } from '../../src/assistant/schemas';
import { assistantOf } from '../../src/lib/bridge';
import type { ToolImpl } from '../../src/types/assistant';
import { FakeKernel } from '../doc/fake-kernel';
import { createFakeAssistant } from '../fakes/assistant-sdk';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { assistantHarness, type AssistantHarness } from './harness';
import { resultAsSent } from './sanitize-copy';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  setVisibility('visible');
});

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
}

const stateOf = (x: AssistantHarness) => runtimeOf(x.services)!.store.get();
const refused = (reason: string): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason });
const start = (o: { verdicts?: AssistantRegistration[]; turns?: boolean } = {}) => assistantHarness({ kernel: new FakeKernel(), verdicts: o.verdicts, assistant: { turns: o.turns } });

describe("the bridge's guard", () => {
  it('no ws.assistant (or one without register): null', () => {
    expect(assistantOf(createFakeWorkspace())).toBeNull();
    expect(assistantOf({ assistant: { register: 'no' } } as unknown as Workspace)).toBeNull();
  });

  it('a host with turn events: register, onTurn and stop; without them onTurn and stop are null', async () => {
    const full = assistantOf(createFakeWorkspace({ assistant: {} }))!;
    expect(typeof full.onTurn).toBe('function');
    expect(typeof full.stop).toBe('function');
    expect(await full.stop!('t-1')).toEqual({ stopped: true });
    const older = assistantOf(createFakeWorkspace({ assistant: { turns: false } }))!;
    expect(older.onTurn).toBeNull();
    expect(older.stop).toBeNull();
    expect((await older.register([], null)).available).toBe(true);
  });

  it("an older host's not_allowed answers not available; any other rejection stays one", async () => {
    const refusing = assistantOf(createFakeWorkspace({ assistant: { refuse: 'not_allowed' } }))!;
    expect(await refusing.register([], null)).toEqual(refused('not_allowed'));
    const broken = assistantOf({ assistant: createFakeAssistant({ refuse: 'bad_request' }) } as unknown as Workspace)!;
    await expect(broken.register([], null)).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('the registration', () => {
  it('offers the 18 tools with the guide once, after listening to the turns', async () => {
    h = await start();
    expect(h.fake.registrations).toHaveLength(1);
    const reg = h.fake.registrations[0];
    expect(reg.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(reg.guide).toBe(GUIDE);
    // The review rounds the app runs at the end of a turn that edited the Part.
    expect(reg.review).toEqual({ rounds: 3, prompt: REVIEW_PROMPT });
    expect(stateOf(h)).toMatchObject({ registration: 'on', reason: null, phase: 'idle' });
    h.fake.emitTurn({ id: 't-9', title: 'Plate' });
    expect(runtimeOf(h.services)!.turns.get('t-9')?.title).toBe('Plate');
    expect(stateOf(h).phase).toBe('thinking');
  });

  it('the eval can leave the review rounds out (setReview(false)) and ask for them again', async () => {
    h = await start();
    const handle = assistantTestHandle(h.services)!;
    expect(await handle.setReview(false)).toMatchObject({ available: true });
    expect(h.fake.registrations.at(-1)!.review).toBeUndefined();
    expect(h.fake.registrations.at(-1)!.guide).toBe(GUIDE);
    expect(await handle.setReview(true)).toMatchObject({ available: true });
    expect(h.fake.registrations.at(-1)!.review).toEqual({ rounds: 3, prompt: REVIEW_PROMPT });
  });

  it("an older host's refusal leaves the Assistant off, for good", async () => {
    h = await assistantHarness({ kernel: new FakeKernel(), assistant: { refuse: 'not_allowed' } });
    expect(stateOf(h)).toMatchObject({ registration: 'off', reason: 'not_allowed', phase: 'off' });
  });

  it('after not_connected: offered again when the tab shows, not while it is hidden', async () => {
    setVisibility('hidden');
    h = await start({ verdicts: [refused('not_connected')] });
    expect(stateOf(h)).toMatchObject({ registration: 'off', reason: 'not_connected', phase: 'off' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(h.fake.registrations).toHaveLength(1);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(stateOf(h!).registration).toBe('on'));
    expect(h.fake.registrations).toHaveLength(2);
    // Once on, a visibility change offers nothing more.
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(h.fake.registrations).toHaveLength(2);
  });

  it.each(['remote', 'no_assistant', 'not_allowed'])('after %s: never offered again', async (reason) => {
    h = await start({ verdicts: [refused(reason)] });
    expect(stateOf(h)).toMatchObject({ registration: 'off', reason });
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(h.fake.registrations).toHaveLength(1);
  });

  it("the eval's core set: its 13 tools with a guide that names only them; help says which are not offered; 'all' brings back the 18", async () => {
    h = await start();
    const handle = assistantTestHandle(h.services)!;
    const missing = TOOL_NAMES.filter((n) => !CORE_TOOLSET.includes(n));
    expect(missing).toEqual(['body', 'construct', 'delete', 'direct', 'edit_feature', 'sweep_loft', 'view']);
    expect(await handle.setToolset('core')).toMatchObject({ available: true });
    const reg = h.fake.registrations.at(-1)!;
    expect(reg.tools.map((t) => t.name)).toEqual(TOOL_NAMES.filter((n) => CORE_TOOLSET.includes(n)));
    expect(handle.tools).toEqual([...CORE_TOOLSET]);
    // The guide it registers sends the model to none of the 5, and says they are not offered.
    expect(reg.guide).toBe(guideWithout(missing));
    expect(reg.guide).toContain(notOfferedLine(namedInGuide(missing)));
    expect(reg.guide).not.toMatch(/view at milestones|edit_feature;|delete asks/);
    // help guide is that guide; help features marks the 5 (and only them); both whole through the app's rules.
    const guide = await h.ok('help', { topic: 'guide' });
    expect((guide.data.rows as { text: string }[]).map((r) => r.text).join('\n\n')).toBe(reg.guide);
    const features = await h.ok('help', { topic: 'features' });
    const rows = features.data.rows as { about: string; text: string }[];
    expect(rows.filter((r) => r.text.endsWith(` ${NOT_OFFERED}`)).map((r) => r.about)).toEqual(missing);
    for (const r of rows) if (!missing.includes(r.about)) expect(r.text, r.about).toBe(HELP.features.find((x) => x.about === r.about)!.text);
    expect(Buffer.byteLength(JSON.stringify({ topic: 'features', rows }))).toBeLessThanOrEqual(HELP_TOPIC_BYTES);
    for (const r of [guide, features]) expect(resultAsSent('cad__help', r).truncated).toBeUndefined();
    // Back to every tool: the 18, the guide, help as it is.
    expect(await handle.setToolset('all')).toMatchObject({ available: true });
    expect(h.fake.registrations.at(-1)!.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(h.fake.registrations.at(-1)!.guide).toBe(GUIDE);
    expect((await h.ok('help', { topic: 'features' })).data.rows).toEqual(HELP.features);
    expect((await h.ok('help', { topic: 'guide' })).data.rows).toEqual(HELP.guide);
  });

  it('uninstall withdraws the tools (register([], null))', async () => {
    h = await start();
    const fake = h.fake;
    h.dispose();
    h = null;
    await vi.waitFor(() => expect(fake.registrations).toHaveLength(2));
    expect(fake.registrations[1].tools).toEqual([]);
  });
});

describe("a call's progress", () => {
  it('reaches the host with waiting kept, and a plain one without it', async () => {
    h = await start();
    const probe: ToolImpl = {
      kind: 'edit',
      async run(ctx) {
        ctx.progress(0.25, 'Waiting for you: close the Fillet 2 panel', { waiting: true });
        ctx.progress(0.5, 'Extrude Boss');
        return { text: 'ok', data: {} };
      },
    };
    const handler = createCallHandler(runtimeOf(h.services)!, { extrude: probe });
    const sent: unknown[][] = [];
    const call: AssistantCall = { call: 'c-1', turn: 't-1', tool: 'extrude', input: {}, signal: new AbortController().signal, progress: (...a: unknown[]) => void sent.push(a) };
    await handler(call);
    expect(sent).toEqual([
      [0.25, 'Waiting for you: close the Fillet 2 panel', { waiting: true }],
      [0.5, 'Extrude Boss', undefined],
    ]);
  });
});
