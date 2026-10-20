// Tools for the app's assistant, the bridge's side (unreleased, next host minor 1.9): the page's
// assistant.register (shape checks, the app's verdict, the 5 s bound and abandon()), invokeTool
// (refusals, the stall window that progress and the page's calls in flight hold open, Stop with
// its 2 s wait, the result's checks and caps, images read to base64), a leave and a closed
// channel ending the call, and what the allowlist does with the new messages; then the real SDK
// against this bridge, so both sides keep the same tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type AssistantTool, type AssistantTurn, type StudyRecord } from '../plugin-sdk/workspace';
import {
  ASSISTANT_ABORT_WAIT_MS,
  ASSISTANT_ALIVE_MS,
  ASSISTANT_CONFIRM_MAX,
  ASSISTANT_DATA_BYTES,
  ASSISTANT_DETAIL_BYTES,
  ASSISTANT_HINT_MAX,
  ASSISTANT_IMAGE_BYTES,
  ASSISTANT_REGISTER_MS,
  ASSISTANT_SUMMARY_MAX,
  ASSISTANT_TEXT_BYTES,
  BridgeError,
  HOST_API_VERSION,
  WorkspaceBridge,
  WorkspaceCalls,
  assistantCallOutcome,
  checkAssistantTools,
  type AssistantCallOutcome,
  type AssistantInvoke,
  type AssistantPublication,
  type BridgeHooks,
  type BridgeScope,
  type CheckedTool,
  type LeaveActivity,
} from './bridge';

vi.mock('../api/eventHub', () => ({
  openChannel: () => ({ addEventListener: () => undefined, close: () => undefined, pin: () => undefined, readyState: 1, onerror: null }),
}));

const SCOPE: BridgeScope = { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'counter', projectId: 'proj-a', projectTitle: 'Project A', studyId: 'st-1' };
const STUDY = { id: 'st-1', kind: 'counter_case', title: 'Counter', rev: 1 } as unknown as StudyRecord;
const SCHEMA = { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['by'], additionalProperties: false };
const ADD = { name: 'add', title: 'Add to the counter', description: 'Adds `by` to the counter.', inputSchema: SCHEMA, risk: 'edit' };
const SLOW = { name: 'slow_add', description: 'Adds slowly, with progress.', inputSchema: SCHEMA, risk: 'edit', timeoutS: 2 };
const KB = 1024;
// Controls written by code, so this file holds none: BEL, a bidi override, a line separator.
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);

/**
 * A MessageChannel whose ports hand each message over in a microtask, uncopied: the tests run on
 * fake timers without waiting for the event loop, and Blobs cross as they are.
 */
class FakePort {
  other: FakePort | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(data: unknown): void {
    const to = this.other;
    if (this.closed || !to) return;
    queueMicrotask(() => {
      if (!to.closed) to.onmessage?.({ data });
    });
  }
  start(): void {}
  close(): void {
    this.closed = true;
    if (this.other) this.other.closed = true;
  }
}

class FakeChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/** A port that copies what it is sent, as a real one does: what cannot be copied throws a DataCloneError and is not sent. */
class CopyingPort extends FakePort {
  postMessage(data: unknown): void {
    super.postMessage(structuredClone(data));
  }
}

/** A channel whose page side (port2) copies what the page sends. */
class PageCopyingChannel {
  readonly port1 = new FakePort();
  readonly port2 = new CopyingPort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/** A verdict that takes every tool. */
const acceptAll = (reg: { tools: CheckedTool[]; guide: string } | null): AssistantPublication =>
  Object.assign(Promise.resolve({ available: true, accepted: reg ? reg.tools.map((t) => t.name) : [], refused: [] }), { abandon: vi.fn() });

function hooks(): BridgeHooks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    back: vi.fn(async () => true),
    setDirty: vi.fn(),
    connected: vi.fn(),
    studyChanged: vi.fn(),
    studyGone: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => 'Named'),
    units: vi.fn(() => 'metric' as const),
    log: vi.fn(),
    openResults: vi.fn(async () => true),
    assistantTools: vi.fn(acceptAll),
  };
}

beforeEach(() => {
  vi.stubGlobal('MessageChannel', FakeChannel);
  // The context's reads (the study, the geometry it edits), answered at once.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/plugin-studies/get') ? { ok: true, study: STUDY } : { ok: true, geometry: null };
      return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

/** Microtasks run until `until` holds (the fake ports and the bridge's answers need only those). */
async function settle(until: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (until()) return;
    await Promise.resolve();
  }
  throw new Error(`${what}: not yet`);
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

type Event = { event: string; data: Record<string, unknown> };

/** A bridge whose page said hello: the page's port, every event pushed to it, its calls, and the app's hooks. */
async function connected(h = hooks()) {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window;
  const posted: unknown[][] = [];
  (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => void posted.push(a);
  const calls = new WorkspaceCalls(SCOPE, h);
  const bridge = new WorkspaceBridge(frame, calls, h);
  const detach = bridge.attach();
  window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.4.0', instance: 'i1' }, source: win }));
  await vi.waitFor(() => expect(posted.length).toBe(1));
  const welcome = posted[0][0] as { context: { hostVersion: string } };
  const port = (posted[0] as [unknown, unknown, FakePort[]])[2][0];
  const events: Event[] = [];
  const replies = new Map<number, Record<string, unknown>>();
  port.onmessage = (e) => {
    const d = e.data as Record<string, unknown>;
    if (typeof d.id === 'number') replies.set(d.id, d);
    else events.push(d as Event);
  };
  let nextId = 1;
  /** Send a call of the page; the returned function gives its answer once it came. */
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    port.postMessage({ id, method, params });
    return () => replies.get(id);
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const answer = send(method, params);
    await settle(() => !!answer(), `the answer to ${method}`);
    return answer() as { result?: unknown; error?: { code: string; message: string } };
  };
  const end = () => {
    port.close();
    detach();
    frame.remove();
  };
  return { frame, win, posted, welcome, h, calls, bridge, port, events, send, call, end };
}

/** One call of a tool, its outcome as soon as it is known, and the progress it heard. */
function invoke(t: Awaited<ReturnType<typeof connected>>, over: Partial<AssistantInvoke> = {}) {
  const ctl = new AbortController();
  const progress: Array<[number | null, string]> = [];
  const state: { out: AssistantCallOutcome | null } = { out: null };
  const p = t.bridge.invokeTool({
    call: 'srv-1',
    turn: 'turn-1',
    tool: 'add',
    input: { by: 2 },
    timeoutS: 60,
    signal: ctl.signal,
    onProgress: (f, l) => void progress.push([f, l]),
    ...over,
  });
  void p.then((o) => {
    state.out = o;
  });
  return { p, ctl, progress, state };
}

const of = (events: Event[], name: string) => events.filter((e) => e.event === name);

/** A call's outcome, once its promise has settled (microtasks only). */
async function outcomeOf(x: { state: { out: AssistantCallOutcome | null } }): Promise<AssistantCallOutcome | null> {
  await settle(() => x.state.out !== null, 'the outcome');
  return x.state.out;
}

describe('assistant.register (1.9, unreleased)', () => {
  it('the host stays 1.8 while it is unreleased', async () => {
    const t = await connected();
    expect(HOST_API_VERSION).toBe('1.8');
    expect(t.welcome.context.hostVersion).toBe('1.8');
    t.end();
  });

  it('checks the shape: a list of at most 32 tools, each {name, description, inputSchema} of plain JSON; bad_request otherwise', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    const refused = async (params: Record<string, unknown>) => {
      const err = await c.handle('assistant.register', params).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BridgeError);
      return err as BridgeError;
    };
    for (const params of [
      {},
      { tools: 'add' },
      { tools: Array.from({ length: 33 }, (_, i) => ({ ...ADD, name: `t${i}` })) },
      { tools: [null] },
      { tools: [[ADD]] },
      { tools: [{ ...ADD, name: '' }] },
      { tools: [{ ...ADD, name: 'a'.repeat(65) }] },
      { tools: [{ ...ADD, name: 7 }] },
      { tools: [{ ...ADD, description: undefined }] },
      { tools: [{ ...ADD, title: 3 }] },
      { tools: [{ ...ADD, confirm: 3 }] },
      { tools: [{ ...ADD, confirm: { text: 'Undoable.' } }] },
      { tools: [{ ...ADD, inputSchema: [SCHEMA] }] },
      { tools: [{ ...ADD, inputSchema: undefined }] },
      { tools: [{ ...ADD, inputSchema: { ...SCHEMA, made: new Date(0) } }] },
      { tools: [{ ...ADD, inputSchema: { ...SCHEMA, bad: Number.NaN } }] },
      { tools: [{ ...ADD, inputSchema: new Map([['type', 'object']]) }] },
      { tools: [ADD], guide: 7 },
    ]) {
      expect((await refused(params)).code).toBe('bad_request');
    }
    // Past 512 KB in all: too_large.
    const big = { ...ADD, inputSchema: { ...SCHEMA, description: 'x'.repeat(600 * KB) } };
    expect((await refused({ tools: [big] })).code).toBe('too_large');
    expect(c.assistantTool('add')).toBeNull();
  });

  it("cleans and caps the texts, makes an unknown risk destructive, and rounds timeoutS into 1..600 (60 when not a number)", () => {
    const checked = checkAssistantTools({
      tools: [
        { ...ADD, title: `Add${LS}to the${RLO} counter${BEL}`, description: 'd'.repeat(1500) },
        { ...SLOW, risk: 'nuke', timeoutS: 0 },
        { ...ADD, name: 'b', risk: undefined, timeoutS: 1e9 },
        { ...ADD, name: 'c', risk: 'read', timeoutS: 2.4 },
        { ...ADD, name: 'd', risk: 'compute', timeoutS: '30' },
        { ...ADD, name: 'e', risk: 'destructive', timeoutS: Number.POSITIVE_INFINITY },
      ],
      guide: `  Counter notes:\r\n- add moves it${BEL}\r- reset sets 0\n`,
    });
    expect(checked.tools.map((x) => [x.name, x.risk, x.timeoutS])).toEqual([
      ['add', 'edit', 60],
      ['slow_add', 'destructive', 1],
      ['b', 'destructive', 600],
      ['c', 'read', 2],
      ['d', 'compute', 60],
      ['e', 'destructive', 60],
    ]);
    expect(checked.tools[0].title).toBe('Add to the counter');
    expect(checked.tools[0].description).toBe('d'.repeat(1024));
    expect(checked.tools[1].title).toBe('');
    expect(checked.tools[0].inputSchema).toEqual(SCHEMA);
    // The guide keeps its lines; other controls go.
    expect(checked.guide).toBe('Counter notes:\n- add moves it \n- reset sets 0');
    expect(checkAssistantTools({ tools: [] })).toEqual({ tools: [], guide: '' });
    expect(checkAssistantTools({ tools: [], guide: 'g'.repeat(5000) }).guide).toHaveLength(4000);
  });

  it('a review (1.9, unreleased): {rounds 1 to 5, prompt}, its prompt keeps its lines; absent when none; any other shape is bad_request', () => {
    expect(checkAssistantTools({ tools: [], review: { rounds: 3, prompt: ' Look again.\r\n\u0007Fix it. ', extra: 1 } })).toEqual({
      tools: [],
      guide: '',
      review: { rounds: 3, prompt: 'Look again.\n Fix it.' },
    });
    expect(checkAssistantTools({ tools: [], review: null })).toEqual({ tools: [], guide: '' });
    expect(checkAssistantTools({ tools: [], review: { rounds: 5, prompt: 'p'.repeat(1500) } }).review?.prompt).toHaveLength(1500);
    for (const review of ['look', [], { rounds: 0, prompt: 'x' }, { rounds: 6, prompt: 'x' }, { rounds: 2.5, prompt: 'x' }, { rounds: '2', prompt: 'x' }, { rounds: 2 }, { rounds: 2, prompt: '  ' }, { rounds: 2, prompt: 'p'.repeat(1501) }]) {
      expect(() => checkAssistantTools({ tools: [], review }), JSON.stringify(review)).toThrow(expect.objectContaining({ code: 'bad_request' }));
    }
  });

  it("a tool's confirm note (CAD tools spec H10): text, cleaned and cut to 120 characters, handed to the app; absent when the page gave none or it cleans to nothing", async () => {
    const RESET = { name: 'reset', title: 'Reset the counter', description: 'Sets the counter to 0.', inputSchema: SCHEMA, risk: 'destructive' };
    const checked = checkAssistantTools({
      tools: [
        { ...RESET, confirm: `Sets the${LS} counter to 0;${RLO} add${BEL} brings it back.` },
        { ...RESET, name: 'long', confirm: 'c'.repeat(300) },
        { ...RESET, name: 'blank', confirm: ` ${BEL} ` },
        { ...RESET, name: 'nulled', confirm: null },
        { ...RESET, name: 'none' },
      ],
    });
    expect(ASSISTANT_CONFIRM_MAX).toBe(120);
    expect(checked.tools[0].confirm).toBe('Sets the counter to 0; add brings it back.');
    expect(checked.tools[1].confirm).toBe('c'.repeat(ASSISTANT_CONFIRM_MAX));
    for (const t of checked.tools.slice(2)) expect(Object.hasOwn(t, 'confirm'), t.name).toBe(false);
    // It reaches the app with the rest of the tool.
    const h = hooks();
    const t = await connected(h);
    const r = await t.call('assistant.register', { tools: [{ ...RESET, confirm: 'Sets the counter to 0; add brings it back.' }] });
    expect(r.result).toEqual({ available: true, accepted: ['reset'], refused: [] });
    const reg = h.assistantTools.mock.calls[0][0] as { tools: CheckedTool[] };
    expect(reg.tools).toEqual([{ ...RESET, title: 'Reset the counter', timeoutS: 60, confirm: 'Sets the counter to 0; add brings it back.' }]);
    t.end();
  });

  it("hands the checked list to the app and answers its verdict: only names the page offered, texts cleaned", async () => {
    const h = hooks();
    h.assistantTools.mockImplementation((reg: { tools: CheckedTool[] } | null) =>
      Object.assign(
        Promise.resolve({
          available: true,
          accepted: ['add', 'ghost', 'add'],
          refused: [{ name: 'slow_add', code: 'schema', message: `pattern is not allowed${BEL}` }, 'junk'],
          extra: reg,
        }),
        { abandon: vi.fn() },
      ),
    );
    const t = await connected(h);
    const r = await t.call('assistant.register', { tools: [ADD, SLOW], guide: 'Counter notes' });
    expect(r.result).toEqual({ available: true, accepted: ['add'], refused: [{ name: 'slow_add', code: 'schema', message: 'pattern is not allowed' }] });
    expect(h.assistantTools).toHaveBeenCalledTimes(1);
    const reg = h.assistantTools.mock.calls[0][0] as { tools: CheckedTool[]; guide: string };
    expect(reg.guide).toBe('Counter notes');
    expect(reg.tools).toEqual([
      { name: 'add', title: 'Add to the counter', description: 'Adds `by` to the counter.', inputSchema: SCHEMA, risk: 'edit', timeoutS: 60 },
      { name: 'slow_add', title: '', description: 'Adds slowly, with progress.', inputSchema: SCHEMA, risk: 'edit', timeoutS: 2 },
    ]);
    // Only the accepted tool can be called.
    expect(await t.bridge.invokeTool({ call: 's', turn: 't', tool: 'slow_add', input: {}, timeoutS: 60, signal: new AbortController().signal, onProgress: () => undefined })).toMatchObject({
      ok: false,
      code: 'no_tool',
    });
    const a = invoke(t);
    await settle(() => of(t.events, 'assistantInvoke').length === 1, 'the invoke');
    expect(of(t.events, 'assistantInvoke')[0].data).toEqual({ call: 'ai-1', turn: 'turn-1', tool: 'add', input: { by: 2 } });
    a.ctl.abort();
    t.end();
  });

  it('with no hook the page hears no_assistant; a verdict of available:false keeps nothing', async () => {
    const h = hooks();
    delete (h as Partial<BridgeHooks>).assistantTools;
    const t = await connected(h);
    expect((await t.call('assistant.register', { tools: [ADD] })).result).toEqual({ available: false, accepted: [], refused: [], reason: 'no_assistant' });
    t.end();
    const h2 = hooks();
    h2.assistantTools.mockImplementation(() =>
      Object.assign(Promise.resolve({ available: false, accepted: ['add'], refused: [], reason: 'remote' }), { abandon: vi.fn() }),
    );
    const t2 = await connected(h2);
    expect((await t2.call('assistant.register', { tools: [ADD] })).result).toEqual({ available: false, accepted: [], refused: [], reason: 'remote' });
    expect(t2.calls.assistantTool('add')).toBeNull();
    t2.end();
  });

  it('5 s bound: past it the page hears not_connected, abandon() is called once, and the earlier tools stay', async () => {
    const h = hooks();
    const t = await connected(h);
    expect((await t.call('assistant.register', { tools: [ADD] })).result).toMatchObject({ available: true, accepted: ['add'] });
    let late: (v: unknown) => void = () => undefined;
    const abandon = vi.fn();
    h.assistantTools.mockImplementation(() => Object.assign(new Promise((r) => (late = r)), { abandon }));
    fakeTimers();
    const answer = t.send('assistant.register', { tools: [SLOW] });
    await vi.advanceTimersByTimeAsync(ASSISTANT_REGISTER_MS - 1);
    expect(answer()).toBeUndefined();
    expect(abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => !!answer(), 'the answer');
    expect(answer()?.result).toEqual({ available: false, accepted: [], refused: [], reason: 'not_connected' });
    expect(abandon).toHaveBeenCalledTimes(1);
    // Its verdict comes after all: nothing changes.
    late({ available: true, accepted: ['slow_add'], refused: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.assistantTool('slow_add')).toBeNull();
    expect(t.calls.assistantTool('add')).not.toBeNull();
    expect(abandon).toHaveBeenCalledTimes(1);
    t.end();
  });

  it("a hook that throws or rejects answers not_connected; only the last register's verdict is kept", async () => {
    const h = hooks();
    const t = await connected(h);
    h.assistantTools.mockImplementationOnce(() => {
      throw new Error('no relay');
    });
    expect((await t.call('assistant.register', { tools: [ADD] })).result).toMatchObject({ available: false, reason: 'not_connected' });
    h.assistantTools.mockImplementationOnce(() => Object.assign(Promise.reject(new Error('lost')), { abandon: vi.fn() }));
    expect((await t.call('assistant.register', { tools: [ADD] })).result).toMatchObject({ available: false, reason: 'not_connected' });
    expect(t.calls.assistantTool('add')).toBeNull();
    // Two registers: the first one's verdict comes last and is not kept.
    let first: (v: unknown) => void = () => undefined;
    h.assistantTools.mockImplementationOnce(() => Object.assign(new Promise((r) => (first = r)), { abandon: vi.fn() }));
    const one = t.send('assistant.register', { tools: [ADD] });
    await settle(() => h.assistantTools.mock.calls.length === 3, 'the first list');
    expect((await t.call('assistant.register', { tools: [SLOW] })).result).toMatchObject({ available: true, accepted: ['slow_add'] });
    first({ available: true, accepted: ['add'], refused: [] });
    await settle(() => !!one(), 'the first answer');
    expect(one()?.result).toMatchObject({ available: true, accepted: ['add'] });
    expect(t.calls.assistantTool('add')).toBeNull();
    expect(t.calls.assistantTool('slow_add')).not.toBeNull();
    // [] withdraws them.
    expect((await t.call('assistant.register', { tools: [] })).result).toEqual({ available: true, accepted: [], refused: [] });
    expect(t.calls.assistantTool('slow_add')).toBeNull();
    t.end();
  });

  it('a register refused here (bad_request, too_large) is still the last one: a list still waiting for its verdict is not kept', async () => {
    const h = hooks();
    const t = await connected(h);
    const verdicts: Array<(v: unknown) => void> = [];
    h.assistantTools.mockImplementation(() => Object.assign(new Promise((r) => verdicts.push(r)), { abandon: vi.fn() }));
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ tools: [{ ...ADD, name: 'a'.repeat(65) }] }, 'bad_request'],
      [{ tools: [{ ...ADD, inputSchema: { ...SCHEMA, description: 'x'.repeat(600 * KB) } }] }, 'too_large'],
    ];
    for (const [i, [params, code]] of refused.entries()) {
      const waiting = t.send('assistant.register', { tools: [ADD] });
      await settle(() => verdicts.length === i + 1, 'the list');
      expect((await t.call('assistant.register', params)).error?.code).toBe(code);
      verdicts[i]({ available: true, accepted: ['add'], refused: [] });
      await settle(() => !!waiting(), 'its verdict');
      // The page hears it; neither side keeps it (the SDK counted the refused register as its last one).
      expect(waiting()?.result).toMatchObject({ available: true, accepted: ['add'] });
      expect(t.calls.assistantTool('add')).toBeNull();
    }
    expect(h.assistantTools).toHaveBeenCalledTimes(2);
    t.end();
  });
});

describe('invokeTool (1.9, unreleased)', () => {
  it('refuses at once: closed with no page, no_tool, busy (covered frame, a call running), leaving, aborted', async () => {
    // A frame whose page never said hello.
    const frame = document.createElement('iframe');
    const h0 = hooks();
    const lone = new WorkspaceBridge(frame, new WorkspaceCalls(SCOPE, h0), h0);
    const req = { call: 's', turn: 't', tool: 'add', input: {}, timeoutS: 60, signal: new AbortController().signal, onProgress: () => undefined };
    expect(await lone.invokeTool(req)).toMatchObject({ ok: false, code: 'closed' });
    const t = await connected();
    expect(await t.bridge.invokeTool(req)).toMatchObject({ ok: false, code: 'no_tool' });
    await t.call('assistant.register', { tools: [ADD] });
    t.frame.inert = true;
    expect(await t.bridge.invokeTool(req)).toMatchObject({ ok: false, code: 'busy' });
    t.frame.inert = false;
    const stopped = new AbortController();
    stopped.abort();
    expect(await t.bridge.invokeTool({ ...req, signal: stopped.signal })).toMatchObject({ ok: false, code: 'aborted' });
    const first = invoke(t);
    expect(await t.bridge.invokeTool(req)).toMatchObject({ ok: false, code: 'busy' });
    first.ctl.abort();
    await settle(() => of(t.events, 'assistantAbort').length === 1, 'the abort');
    await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'done anyway' } });
    expect(await outcomeOf(first)).toEqual({ ok: true, result: { text: 'done anyway' } });
    // While a leave runs its exit hook.
    await t.call('nav.leaveHook', { on: true });
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    expect(await t.bridge.invokeTool(req)).toMatchObject({ ok: false, code: 'leaving' });
    // Only one invoke was ever sent.
    expect(of(t.events, 'assistantInvoke')).toHaveLength(1);
    t.end();
  });

  it("sends assistantInvoke with the bridge's id; the page's progress (clamped, cleaned) and its result come back; stale ids are ignored", async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    const a = invoke(t);
    await settle(() => of(t.events, 'assistantInvoke').length === 1, 'the invoke');
    expect(of(t.events, 'assistantInvoke')[0].data).toEqual({ call: 'ai-1', turn: 'turn-1', tool: 'add', input: { by: 2 } });
    expect((await t.call('assistant.progress', { call: 'ai-1', fraction: 1.5, label: `Adding${LS}now` })).result).toEqual({ ok: true });
    await t.call('assistant.progress', { call: 'ai-1', fraction: Number.NaN });
    await t.call('assistant.progress', { call: 'ai-9', fraction: 0.5, label: 'not this one' });
    expect(a.progress).toEqual([
      [1, 'Adding now'],
      [null, ''],
    ]);
    expect((await t.call('assistant.result', { call: 'ai-9', ok: true, result: { text: 'stale' } })).result).toEqual({ ok: true });
    expect(a.state.out).toBeNull();
    expect((await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'Counter is 2', data: { count: 2 }, other: 'dropped' } })).result).toEqual({
      ok: true,
    });
    expect(await a.p).toEqual({ ok: true, result: { text: 'Counter is 2', data: { count: 2 } } });
    // A second answer to the same call changes nothing; the next call has the next id.
    await t.call('assistant.result', { call: 'ai-1', ok: false, error: { message: 'late' } });
    const b = invoke(t, { input: { by: -1 } });
    await settle(() => of(t.events, 'assistantInvoke').length === 2, 'the second invoke');
    expect(of(t.events, 'assistantInvoke')[1].data.call).toBe('ai-2');
    await t.call('assistant.result', { call: 'ai-2', ok: true });
    expect(await b.p).toEqual({ ok: true, result: {} });
    t.end();
  });

  it("the page's error keeps a code from its own list (invalid_input, busy, not_ready, failed) or the SDK's no_tool, else failed", async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    const cases: Array<[Record<string, unknown> | undefined, string, string]> = [
      [{ code: 'busy', message: `The sketch is open${BEL}` }, 'busy', 'The sketch is open'],
      [{ code: 'invalid_input', message: 'by must not be 0' }, 'invalid_input', 'by must not be 0'],
      [{ code: 'not_ready', message: 'Still loading' }, 'not_ready', 'Still loading'],
      // The SDK's answer for a tool it holds no handler for.
      [{ code: 'no_tool', message: 'This page has no tool named "add".' }, 'no_tool', 'This page has no tool named "add".'],
      [{ code: 'plugin_off', message: 'Spoofed' }, 'failed', 'Spoofed'],
      [{ code: 'stalled' }, 'failed', 'The tool failed.'],
      [undefined, 'failed', 'The tool failed.'],
    ];
    for (const [i, [error, code, message]] of cases.entries()) {
      const a = invoke(t);
      await settle(() => of(t.events, 'assistantInvoke').length === i + 1, 'the call');
      await t.call('assistant.result', { call: `ai-${i + 1}`, ok: false, error });
      expect(await a.p).toEqual({ ok: false, code, message });
    }
    t.end();
  });

  it("the page's error keeps its hint (cleaned, 500 characters) and its detail (plain JSON, 4 KB), else drops the detail and says so in the message", async () => {
    const error = (e: Record<string, unknown>) => assistantCallOutcome({ call: 'ai-1', ok: false, error: e });
    const detail = { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3], nested: { ok: true, none: null } };
    expect(await error({ code: 'invalid_input', message: 'Too big.', hint: `Use 1,${RLO} 2${LS}or 3.`, detail })).toEqual({
      ok: false,
      code: 'invalid_input',
      message: 'Too big.',
      hint: 'Use 1, 2 or 3.',
      detail,
    });
    expect(await error({ message: 'No.', hint: 'h'.repeat(600) })).toEqual({ ok: false, code: 'failed', message: 'No.', hint: 'h'.repeat(ASSISTANT_HINT_MAX) });
    // A hint that is not text, or is only spaces, and a null detail: left out.
    for (const hint of [5, '   ', null, { text: 'x' }]) expect(await error({ message: 'No.', hint, detail: null })).toEqual({ ok: false, code: 'failed', message: 'No.' });
    // At 4 KB as JSON (UTF-8 bytes) the detail is kept; past it, dropped, and the message says so.
    const at = { s: 'x'.repeat(ASSISTANT_DETAIL_BYTES - 8) };
    expect(new TextEncoder().encode(JSON.stringify(at)).length).toBe(ASSISTANT_DETAIL_BYTES);
    expect(await error({ message: 'No.', detail: at })).toMatchObject({ detail: at });
    expect(await error({ code: 'busy', message: 'No.', hint: 'Wait.', detail: { s: 'é'.repeat(ASSISTANT_DETAIL_BYTES / 2) } })).toEqual({
      ok: false,
      code: 'busy',
      message: 'No. (detail too large)',
      hint: 'Wait.',
    });
    // Not plain JSON (a Date, a Map, a function, NaN): dropped, and said.
    for (const bad of [new Date(0), new Map(), { f: () => 1 }, { n: Number.NaN }]) {
      expect(await error({ message: 'No.', detail: bad })).toEqual({ ok: false, code: 'failed', message: 'No. (detail not plain JSON)' });
    }
    // The note fits inside the message's 2000 characters; with no message, the default's.
    const long = await error({ message: 'm'.repeat(2500), detail: { s: 'x'.repeat(5000) } });
    expect(!long.ok && long.message.length).toBe(2000);
    expect(!long.ok && long.message.endsWith('m (detail too large)')).toBe(true);
    expect(await error({ detail: { s: 'x'.repeat(5000) } })).toEqual({ ok: false, code: 'failed', message: 'The tool failed. (detail too large)' });
    // A copy: the page's object is not the outcome's.
    const kept = await error({ message: 'No.', detail });
    expect(!kept.ok && kept.detail).not.toBe(detail);
  });

  it("a result's summary is cleaned and cut to 160 characters; one that is not text fails the call bad_result", async () => {
    const result = (r: unknown) => assistantCallOutcome({ call: 'ai-1', ok: true, result: r });
    expect(await result({ text: 'Now 2', data: { count: 2 }, summary: `Added 2:${BEL} the counter is 2` })).toEqual({
      ok: true,
      result: { text: 'Now 2', data: { count: 2 }, summary: 'Added 2: the counter is 2' },
    });
    expect(await result({ summary: 's'.repeat(300) })).toEqual({ ok: true, result: { summary: 's'.repeat(ASSISTANT_SUMMARY_MAX) } });
    // Empty or null: none.
    expect(await result({ text: 'x', summary: '  ' })).toEqual({ ok: true, result: { text: 'x' } });
    expect(await result({ text: 'x', summary: null })).toEqual({ ok: true, result: { text: 'x' } });
    expect(await result({ summary: 42 })).toEqual({ ok: false, code: 'bad_result', message: "The tool's result was refused: its summary is not text." });
  });

  it('stalls after timeoutS with no progress: assistantAbort, then stalled (with the hint when the tab is hidden)', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD, SLOW] });
    fakeTimers();
    const a = invoke(t, { tool: 'slow_add', timeoutS: 2 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(a.state.out).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // It ran until then: the model is told it may have finished.
    expect(await outcomeOf(a)).toEqual({ ok: false, code: 'stalled', message: 'it sent no progress for 2 s and was stopped; it may or may not have finished' });
    await settle(() => of(t.events, 'assistantAbort').length === 1, 'the abort');
    expect(of(t.events, 'assistantAbort')[0].data).toEqual({ call: 'ai-1' });
    // In a hidden tab the model is told why it may have stalled.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const b = invoke(t, { tool: 'slow_add', timeoutS: Number.NaN });
    // No timeoutS from the caller: the tool's own (2 s).
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcomeOf(b)).toEqual({
      ok: false,
      code: 'stalled',
      message: 'it sent no progress for 2 s and was stopped (its tab is in the background); it may or may not have finished',
    });
    t.end();
  });

  it('progress resets the stall window: steady progress for 3x timeoutS never stalls (no total limit)', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [SLOW] });
    fakeTimers();
    const a = invoke(t, { tool: 'slow_add', timeoutS: 2 });
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      await t.call('assistant.progress', { call: 'ai-1', fraction: i / 8, label: `step ${i}` });
    }
    // 12 s went by, six times the window.
    expect(a.state.out).toBeNull();
    expect(a.progress).toHaveLength(8);
    expect(of(t.events, 'assistantAbort')).toHaveLength(0);
    await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'added' } });
    expect(await outcomeOf(a)).toEqual({ ok: true, result: { text: 'added' } });
    t.end();
  });

  it('a progress that waits for the person reaches the caller as onProgress(…, {waiting: true}), only for waiting true; it resets the stall window too', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [SLOW] });
    fakeTimers();
    const heard: unknown[][] = [];
    const a = invoke(t, { tool: 'slow_add', timeoutS: 2, onProgress: (...args: unknown[]) => void heard.push(args) });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      await t.call('assistant.progress', { call: 'ai-1', fraction: null, label: 'Waiting for you', waiting: true });
    }
    // 9 s of waiting, four times the window: never stalled.
    expect(a.state.out).toBeNull();
    expect(of(t.events, 'assistantAbort')).toHaveLength(0);
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.5, label: 'Adding', waiting: 'yes' });
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.6, label: 'Adding', waiting: false });
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.7 });
    expect(heard).toEqual([
      ...Array.from({ length: 6 }, () => [null, 'Waiting for you', { waiting: true }]),
      [0.5, 'Adding'],
      [0.6, 'Adding'],
      [0.7, ''],
    ]);
    await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'added' } });
    expect(await outcomeOf(a)).toEqual({ ok: true, result: { text: 'added' } });
    t.end();
  });

  it("a call of the page in flight holds the window open, and it restarts once answered; the assistant's own messages do not", async () => {
    const h = hooks();
    let release: (v: boolean) => void = () => undefined;
    h.confirm.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
    const t = await connected(h);
    await t.call('assistant.register', { tools: [SLOW] });
    fakeTimers();
    const a = invoke(t, { tool: 'slow_add', timeoutS: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    const asked = t.send('ui.confirm', { title: 'Reset the counter?' });
    await settle(() => h.confirm.mock.calls.length === 1, 'the question');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.state.out).toBeNull();
    release(true);
    await settle(() => !!asked(), 'its answer');
    await vi.advanceTimersByTimeAsync(1999);
    expect(a.state.out).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcomeOf(a)).toMatchObject({ ok: false, code: 'stalled' });
    // A register of the page that waits for its verdict is no work of a call.
    let verdict: (v: unknown) => void = () => undefined;
    h.assistantTools.mockImplementation(() => Object.assign(new Promise((r) => (verdict = r)), { abandon: vi.fn() }));
    const b = invoke(t, { tool: 'slow_add', timeoutS: 2 });
    t.send('assistant.register', { tools: [SLOW] });
    await settle(() => h.assistantTools.mock.calls.length === 2, 'the list');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcomeOf(b)).toMatchObject({ ok: false, code: 'stalled' });
    verdict({ available: true, accepted: ['slow_add'], refused: [] });
    t.end();
  });

  it('a call of the page in flight: the caller hears onAlive as it starts, every ASSISTANT_ALIVE_MS while it waits and as it ends; never after Stop or the end', async () => {
    const h = hooks();
    const answers: Array<(v: boolean) => void> = [];
    h.confirm.mockImplementation(() => new Promise<boolean>((r) => answers.push(r)));
    const t = await connected(h);
    await t.call('assistant.register', { tools: [SLOW] });
    fakeTimers();
    const alive = vi.fn();
    const a = invoke(t, { tool: 'slow_add', timeoutS: 2, onAlive: alive });
    await vi.advanceTimersByTimeAsync(1000);
    // Progress is progress, not a call of the page.
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.1, label: 'step 1' });
    expect(alive).not.toHaveBeenCalled();
    const asked = t.send('ui.confirm', { title: 'Reset the counter?' });
    await settle(() => h.confirm.mock.calls.length === 1, 'the question');
    expect(alive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ASSISTANT_ALIVE_MS - 1);
    expect(alive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(alive).toHaveBeenCalledTimes(2);
    // Far past the call's own 2 s window, and the server's (timeoutS + 10 s): alive all along.
    await vi.advanceTimersByTimeAsync(ASSISTANT_ALIVE_MS * 4);
    expect(alive).toHaveBeenCalledTimes(6);
    expect(a.state.out).toBeNull();
    answers[0](true);
    await settle(() => !!asked(), 'its answer');
    expect(alive).toHaveBeenCalledTimes(7);
    await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'added' } });
    expect(await outcomeOf(a)).toEqual({ ok: true, result: { text: 'added' } });
    await vi.advanceTimersByTimeAsync(ASSISTANT_ALIVE_MS * 2);
    expect(alive).toHaveBeenCalledTimes(7);
    // Stopped while a call of the page waits: nothing more from it.
    const later = vi.fn();
    const b = invoke(t, { tool: 'slow_add', timeoutS: 2, onAlive: later });
    await settle(() => of(t.events, 'assistantInvoke').length === 2, 'the second invoke');
    t.send('ui.confirm', { title: 'Again?' });
    await settle(() => h.confirm.mock.calls.length === 2, 'the second question');
    expect(later).toHaveBeenCalledTimes(1);
    b.ctl.abort();
    await vi.advanceTimersByTimeAsync(ASSISTANT_ALIVE_MS * 2);
    expect(await outcomeOf(b)).toMatchObject({ ok: false, code: 'aborted' });
    expect(later).toHaveBeenCalledTimes(1);
    answers[1](false);
    // A listener that throws is logged; the call goes on.
    const c = invoke(t, { tool: 'slow_add', timeoutS: 2, onAlive: () => { throw new Error('boom'); } });
    await settle(() => of(t.events, 'assistantInvoke').length === 3, 'the third invoke');
    const third = t.send('ui.confirm', { title: 'Once more?' });
    await settle(() => h.confirm.mock.calls.length === 3, 'the third question');
    expect(h.log).toHaveBeenCalledWith('assistant call: alive listener failed', expect.any(Error));
    answers[2](true);
    await settle(() => !!third(), 'its answer');
    await t.call('assistant.result', { call: 'ai-3', ok: true });
    expect(await outcomeOf(c)).toEqual({ ok: true, result: {} });
    t.end();
  });

  it('Stop: assistantAbort, then aborted after 2 s without an answer; a result within 2 s is kept, an error within 2 s reads aborted', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    fakeTimers();
    const a = invoke(t);
    a.ctl.abort();
    await settle(() => of(t.events, 'assistantAbort').length === 1, 'the abort');
    expect(of(t.events, 'assistantAbort')[0].data).toEqual({ call: 'ai-1' });
    // Progress after Stop is not passed on, and does not restart a window.
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.5, label: 'still going' });
    expect(a.progress).toEqual([]);
    await vi.advanceTimersByTimeAsync(ASSISTANT_ABORT_WAIT_MS - 1);
    expect(a.state.out).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcomeOf(a)).toEqual({ ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' });
    // The page finished before it heard Stop: its result is the truth.
    const b = invoke(t);
    b.ctl.abort();
    await vi.advanceTimersByTimeAsync(500);
    await t.call('assistant.result', { call: 'ai-2', ok: true, result: { text: 'Counter is 4' } });
    expect(await outcomeOf(b)).toEqual({ ok: true, result: { text: 'Counter is 4' } });
    const c = invoke(t);
    c.ctl.abort();
    await t.call('assistant.result', { call: 'ai-3', ok: false, error: { code: 'failed', message: 'AbortError' } });
    expect(await outcomeOf(c)).toMatchObject({ ok: false, code: 'aborted' });
    expect(of(t.events, 'assistantAbort')).toHaveLength(3);
    t.end();
  });

  it('checks and caps the result: bad_result for a wrong shape, too_large past 64 KB text, 256 KB data, 4 images or 1.5 MB each', async () => {
    const png = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/png' });
    const outcome = (result: unknown) => assistantCallOutcome({ call: 'ai-1', ok: true, result });
    for (const result of [
      42,
      'plain text',
      [1, 2],
      { text: 5 },
      { data: new Map() },
      { data: { at: new Date(0) } },
      { data: { n: Number.POSITIVE_INFINITY } },
      { images: 'a.png' },
      { images: [{ mediaType: 'image/gif', data: png(4) }] },
      { images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
      { images: [null] },
    ]) {
      const o = await outcome(result);
      expect(o.ok ? 'ok' : o.code).toBe('bad_result');
    }
    expect(await assistantCallOutcome({ call: 'ai-1', ok: 'yes' })).toMatchObject({ ok: false, code: 'bad_result' });
    for (const result of [
      { text: 'x'.repeat(ASSISTANT_TEXT_BYTES + 1) },
      // Bytes, not characters: 32 K two-byte characters and one more.
      { text: 'é'.repeat(ASSISTANT_TEXT_BYTES / 2 + 1) },
      { data: { blob: 'x'.repeat(ASSISTANT_DATA_BYTES) } },
      { images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: png(8) })) },
      { images: [{ mediaType: 'image/webp', data: png(ASSISTANT_IMAGE_BYTES + 1) }] },
    ]) {
      expect(await outcome(result)).toMatchObject({ ok: false, code: 'too_large' });
    }
    // At the caps it passes.
    expect(await outcome({ text: 'x'.repeat(ASSISTANT_TEXT_BYTES), data: { s: 'y'.repeat(ASSISTANT_DATA_BYTES - 10) } })).toMatchObject({ ok: true });
    const four = await outcome({ images: Array.from({ length: 4 }, () => ({ mediaType: 'image/jpeg', data: png(ASSISTANT_IMAGE_BYTES) })) });
    expect(four.ok && four.result.images?.length).toBe(4);
    // Nothing or undefined fields: an empty result.
    expect(await outcome(undefined)).toEqual({ ok: true, result: {} });
    expect(await outcome({ text: null, images: null })).toEqual({ ok: true, result: {} });
  });

  it('reads images to base64 in this page, and a result over the caps fails the call too_large', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 250, 251]);
    const a = invoke(t);
    await settle(() => t.calls.invoking(), 'the call');
    await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'snap', images: [{ mediaType: 'image/png', data: new Blob([bytes], { type: 'image/png' }) }] } });
    expect(await a.p).toEqual({ ok: true, result: { text: 'snap', images: [{ mediaType: 'image/png', data: btoa(String.fromCharCode(...bytes)) }] } });
    const b = invoke(t);
    await settle(() => t.calls.invoking(), 'the call');
    await t.call('assistant.result', { call: 'ai-2', ok: true, result: { text: 'z'.repeat(ASSISTANT_TEXT_BYTES + 1) } });
    expect(await b.p).toEqual({ ok: false, code: 'too_large', message: "The tool's result is too large: its text is over 64 KB." });
    t.end();
  });
});

describe('a leave and a closed channel end the call (1.9, unreleased)', () => {
  it('beginLeave aborts the call with leaving before the page hears `leave`; its late result is ignored', async () => {
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    await t.call('nav.leaveHook', { on: true });
    const a = invoke(t);
    await settle(() => of(t.events, 'assistantInvoke').length === 1, 'the invoke');
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    // It ran until the leave: the model is told it may have finished.
    expect(await a.p).toEqual({ ok: false, code: 'leaving', message: 'its page is closing (the user is leaving the workspace) and it was stopped; it may or may not have finished' });
    await settle(() => of(t.events, 'leave').length === 1, 'the leave');
    expect(t.events.map((e) => e.event)).toEqual(['assistantInvoke', 'assistantAbort', 'leave']);
    expect((await t.call('assistant.result', { call: 'ai-1', ok: true, result: { text: 'late' } })).result).toEqual({ ok: true });
    expect(a.state.out).toMatchObject({ code: 'leaving' });
    t.end();
  });

  it('close() resolves the call `closed`, then the app hears assistantTools(null); a list still waiting is abandoned', async () => {
    const h = hooks();
    const t = await connected(h);
    await t.call('assistant.register', { tools: [ADD] });
    const a = invoke(t);
    await settle(() => t.calls.invoking(), 'the call');
    // A newer list still waits for its verdict when the page goes.
    const abandon = vi.fn();
    h.assistantTools.mockImplementationOnce(() => Object.assign(new Promise(() => undefined), { abandon }));
    t.send('assistant.register', { tools: [ADD, SLOW] });
    await settle(() => h.assistantTools.mock.calls.length === 2, 'the newer list');
    // Was the call already settled when the app heard null? (A settled promise's reaction runs first.)
    let atNull: Promise<string> | null = null;
    h.assistantTools.mockImplementation((reg: unknown) => {
      if (reg === null) atNull = Promise.race([a.p.then(() => 'settled'), Promise.resolve().then(() => 'pending')]);
      return acceptAll(null);
    });
    t.end();
    // The server's own words when the page's answer misses its grace: it may have run.
    expect(await a.p).toEqual({ ok: false, code: 'closed', message: 'its page closed before the tool finished; it may or may not have finished' });
    expect(h.assistantTools).toHaveBeenCalledTimes(3);
    expect(h.assistantTools.mock.calls[2][0]).toBeNull();
    expect(await atNull).toBe('settled');
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(t.calls.assistantTool('add')).toBeNull();
  });

  it("a verdict that comes after its page's channel closed is not kept in the next page's channel", async () => {
    const h = hooks();
    const t = await connected(h);
    let verdict: (v: unknown) => void = () => undefined;
    h.assistantTools.mockImplementationOnce(() => Object.assign(new Promise((r) => (verdict = r)), { abandon: vi.fn() }));
    t.send('assistant.register', { tools: [ADD] });
    await settle(() => h.assistantTools.mock.calls.length === 1, 'the list');
    // The page loads again (a new hello) while its list still waits.
    window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.4.0', instance: 'i2' }, source: t.win }));
    await vi.waitFor(() => expect(t.posted.length).toBe(2));
    expect(h.assistantTools).toHaveBeenLastCalledWith(null);
    // Its verdict comes after all, once every microtask of the register has run.
    verdict({ available: true, accepted: ['add'], refused: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls.assistantTool('add')).toBeNull();
    expect(await t.bridge.invokeTool({ call: 's', turn: 't', tool: 'add', input: {}, timeoutS: 60, signal: new AbortController().signal, onProgress: () => undefined })).toMatchObject({
      ok: false,
      code: 'no_tool',
    });
    t.end();
  });

  it('a list close() abandoned is not abandoned again when its 5 s run out', async () => {
    const h = hooks();
    const t = await connected(h);
    const abandon = vi.fn();
    h.assistantTools.mockImplementationOnce(() => Object.assign(new Promise(() => undefined), { abandon }));
    fakeTimers();
    t.send('assistant.register', { tools: [ADD] });
    await settle(() => h.assistantTools.mock.calls.length === 1, 'the list');
    t.end();
    expect(abandon).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ASSISTANT_REGISTER_MS);
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('Stop, then a leave or a closed channel within its 2 s: the call reads aborted, as stopped', async () => {
    const stopped = { ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' };
    const t = await connected();
    await t.call('assistant.register', { tools: [ADD] });
    await t.call('nav.leaveHook', { on: true });
    const a = invoke(t);
    await settle(() => of(t.events, 'assistantInvoke').length === 1, 'the invoke');
    a.ctl.abort();
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    expect(await outcomeOf(a)).toEqual(stopped);
    await settle(() => of(t.events, 'leave').length === 1, 'the leave');
    t.end();
    const t2 = await connected();
    await t2.call('assistant.register', { tools: [ADD] });
    const b = invoke(t2);
    await settle(() => of(t2.events, 'assistantInvoke').length === 1, 'the invoke');
    b.ctl.abort();
    t2.end();
    expect(await outcomeOf(b)).toEqual(stopped);
  });

  it('a page that offered nothing: closing tells the app nothing; a reload must register again', async () => {
    const h = hooks();
    const t = await connected(h);
    t.end();
    expect(h.assistantTools).not.toHaveBeenCalled();
    const t2 = await connected();
    await t2.call('assistant.register', { tools: [ADD] });
    // The page loads again (a new hello): its tools went with the old channel.
    window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.4.0', instance: 'i2' }, source: t2.win }));
    await vi.waitFor(() => expect(t2.posted.length).toBe(2));
    expect(t2.h.assistantTools).toHaveBeenLastCalledWith(null);
    expect(t2.calls.assistantTool('add')).toBeNull();
    expect(await t2.bridge.invokeTool({ call: 's', turn: 't', tool: 'add', input: {}, timeoutS: 60, signal: new AbortController().signal, onProgress: () => undefined })).toMatchObject({
      code: 'no_tool',
    });
    t2.end();
  });
});

describe('the allowlist and the assistant (1.9, unreleased)', () => {
  it("a running leave's stall timer does not count the assistant's messages as its hook's work (NOT_HOOK_WORK)", async () => {
    const h = hooks();
    let verdict: (v: unknown) => void = () => undefined;
    const t = await connected(h);
    await t.call('nav.leaveHook', { on: true });
    const seen: LeaveActivity[] = [];
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: (x) => seen.push(x) });
    await settle(() => of(t.events, 'leave').length === 1, 'the leave');
    h.assistantTools.mockImplementation(() => Object.assign(new Promise((r) => (verdict = r)), { abandon: vi.fn() }));
    const reg = t.send('assistant.register', { tools: [ADD] });
    await settle(() => h.assistantTools.mock.calls.length === 1, 'the list');
    await t.call('assistant.progress', { call: 'ai-1', fraction: 0.5 });
    await t.call('assistant.result', { call: 'ai-1', ok: true });
    expect(seen.filter((x) => x.kind === 'calls')).toEqual([{ kind: 'calls', inFlight: 0 }]);
    verdict({ available: true, accepted: ['add'], refused: [] });
    await settle(() => !!reg(), 'the verdict');
    expect(seen.filter((x) => x.kind === 'calls')).toEqual([{ kind: 'calls', inFlight: 0 }]);
    // Another call is the hook's work, as before.
    await t.call('prefs.units');
    expect(seen.filter((x) => x.kind === 'calls')).toContainEqual({ kind: 'calls', inFlight: 1 });
    t.end();
  });

  it("the page's Stop of a turn is no work of a running leave's hook (NOT_HOOK_WORK) either", async () => {
    const h = hooks();
    h.assistantStop = vi.fn(async () => ({ stopped: true }));
    const t = await connected(h);
    await t.call('nav.leaveHook', { on: true });
    const seen: LeaveActivity[] = [];
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: (x) => seen.push(x) });
    await settle(() => of(t.events, 'leave').length === 1, 'the leave');
    expect((await t.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: true });
    expect(seen.filter((x) => x.kind === 'calls')).toEqual([{ kind: 'calls', inFlight: 0 }]);
    t.end();
  });

  it('a call the bridge does not have is not_allowed, as for any other', async () => {
    const t = await connected();
    for (const method of ['assistant.invoke', 'assistant.unregister', 'assistant.tools', 'assistant']) {
      const r = await t.call(method, { tools: [] });
      expect(r.error).toEqual({ message: `not allowed: ${JSON.stringify(method)}`, code: 'not_allowed' });
    }
    expect(t.h.log).toHaveBeenCalledWith(expect.stringContaining('not allowed: "assistant.invoke"'), { tools: [] });
    t.end();
  });
});

describe("the assistant's turns and the page's Stop (1.9, unreleased)", () => {
  const TURN: AssistantTurn = {
    id: 't-1',
    state: 'running',
    title: 'Add 2 to the counter',
    local: false,
    contextTokens: null,
    images: null,
    used: { steps: 1, stepsCap: 50, changes: 0, changesCap: 0, usd: 0.01, usdCap: 3 },
  };

  it('assistantTurn() reaches the page as the event `assistantTurn`; nothing goes on a channel not welcomed yet (a new hello waiting for its context), or once there is none (detached, or no hello)', async () => {
    // Every port the bridge handed an assistantTurn, in order (the bridge's own side of a channel).
    const posts = vi.spyOn(FakePort.prototype, 'postMessage');
    const turnPorts = () => posts.mock.calls.flatMap((c, i) => ((c[0] as { event?: unknown } | null)?.event === 'assistantTurn' ? [posts.mock.contexts[i]] : []));
    try {
      const t = await connected();
      const first = t.port.other;
      t.bridge.assistantTurn(TURN);
      t.bridge.assistantTurn({ ...TURN, state: 'ended', end: { state: 'done', reason: 'end_turn' } });
      await settle(() => of(t.events, 'assistantTurn').length === 2, 'the turn events');
      expect(of(t.events, 'assistantTurn').map((e) => e.data)).toEqual([TURN, { ...TURN, state: 'ended', end: { state: 'done', reason: 'end_turn' } }]);
      expect(turnPorts()).toEqual([first, first]);
      // The page loads again: its hello replaces the channel at once, and the new one is not
      // welcomed until the page has its context.
      window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.4.0', instance: 'i2' }, source: t.win }));
      expect(t.bridge.connected()).toBe(false);
      t.bridge.assistantTurn(TURN);
      expect(turnPorts(), 'neither on the old channel nor on the new one before its welcome').toEqual([first, first]);
      await vi.waitFor(() => expect(t.posted.length).toBe(2));
      const next = (t.posted[1] as [unknown, unknown, FakePort[]])[2][0];
      expect(t.bridge.connected()).toBe(true);
      t.bridge.assistantTurn(TURN);
      expect(turnPorts()).toEqual([first, first, next.other]);
      // Detached: no channel.
      t.end();
      t.bridge.assistantTurn(TURN);
      // A bridge whose page never said hello: none either.
      const h = hooks();
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const lone = new WorkspaceBridge(frame, new WorkspaceCalls(SCOPE, h), h);
      lone.assistantTurn(TURN);
      expect(turnPorts()).toHaveLength(3);
      expect(h.log).not.toHaveBeenCalled();
      frame.remove();
    } finally {
      posts.mockRestore();
    }
  });

  it('assistant.stop {turn} asks hooks.assistantStop and answers {stopped} or {stopped:false, reason}; no hook: no_assistant; a hook that fails: failed; a turn that is no id: bad_request', async () => {
    const h = hooks();
    h.assistantStop = vi.fn(async (turn: string) => (turn === 't-1' ? { stopped: true } : { stopped: false, reason: 'not_this_tab' }));
    const t = await connected(h);
    expect((await t.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: true });
    expect((await t.call('assistant.stop', { turn: 't-9' })).result).toEqual({ stopped: false, reason: 'not_this_tab' });
    expect(h.assistantStop.mock.calls).toEqual([['t-1'], ['t-9']]);
    for (const turn of [undefined, '', 5, 'x'.repeat(129)]) {
      expect((await t.call('assistant.stop', { turn })).error, String(turn)).toMatchObject({ code: 'bad_request' });
    }
    expect(h.assistantStop).toHaveBeenCalledTimes(2);
    // What the hook answers is cleaned; a failure is `failed`, and so is a refusal with no reason.
    h.assistantStop.mockResolvedValueOnce({ stopped: false, reason: `ended${BEL}${RLO}` });
    expect((await t.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: false, reason: 'ended' });
    h.assistantStop.mockResolvedValueOnce({ stopped: false });
    expect((await t.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: false, reason: 'failed' });
    h.assistantStop.mockRejectedValueOnce(new Error('the relay broke'));
    expect((await t.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: false, reason: 'failed' });
    expect(h.log).toHaveBeenCalledWith('assistant stop: the app did not take it', expect.any(Error));
    t.end();
    const bare = await connected();
    expect((await bare.call('assistant.stop', { turn: 't-1' })).result).toEqual({ stopped: false, reason: 'no_assistant' });
    bare.end();
  });

  it("through the real SDK: onTurn hears assistantTurn (each listener its own copy, one that throws leaves the others, off stops it); stop reaches the app's hook", async () => {
    const h = hooks();
    h.assistantStop = vi.fn(async () => ({ stopped: true }));
    const t = await sdkConnected(h);
    const assistant = t.ws.assistant!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a: AssistantTurn[] = [];
    const b: AssistantTurn[] = [];
    const offA = assistant.onTurn((turn) => {
      a.push(turn);
      turn.title = 'changed here';
      throw new Error('a listener broke');
    });
    assistant.onTurn((turn) => b.push(turn));
    t.bridge.assistantTurn(TURN);
    await settle(() => b.length === 1, 'the turn');
    expect(a).toHaveLength(1);
    expect(b).toEqual([TURN]);
    expect(warn).toHaveBeenCalledWith('[workspace] assistant.onTurn', expect.any(Error));
    offA();
    const ended: AssistantTurn = { ...TURN, state: 'ended', end: { state: 'stopped', reason: 'user' } };
    t.bridge.assistantTurn(ended);
    await settle(() => b.length === 2, 'its end');
    expect(a).toHaveLength(1);
    expect(b[1]).toEqual(ended);
    expect(await assistant.stop('t-1')).toEqual({ stopped: true });
    expect(h.assistantStop).toHaveBeenCalledWith('t-1');
    warn.mockRestore();
    t.end();
  });
});

/**
 * The real SDK (connect()) in a page talking to this bridge: what the SDK posts to its parent reaches
 * the bridge as the frame's message, the bridge's welcome reaches the SDK with its port, and what the
 * page sends on the port is copied, as a real port does.
 */
async function sdkConnected(h = hooks()) {
  vi.stubGlobal('MessageChannel', PageCopyingChannel);
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window;
  const parent = { postMessage: (data: unknown) => void window.dispatchEvent(new MessageEvent('message', { data, source: win })) };
  const parentOf = vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (data: unknown, _origin: unknown, ports: unknown[] = []) => {
    const ev = new Event('message');
    Object.defineProperties(ev, { source: { value: parent }, data: { value: data }, ports: { value: ports } });
    window.dispatchEvent(ev);
  };
  const calls = new WorkspaceCalls(SCOPE, h);
  const bridge = new WorkspaceBridge(frame, calls, h);
  const detach = bridge.attach();
  try {
    const ws = await connect({ timeoutMs: 1000 });
    const end = () => {
      detach();
      frame.remove();
      parentOf.mockRestore();
    };
    return { ws, h, calls, bridge, end };
  } catch (e) {
    detach();
    parentOf.mockRestore();
    throw e;
  }
}

describe('the SDK and the bridge together (1.9, unreleased)', () => {
  const TOOL = ADD as AssistantTool;
  const call = (bridge: WorkspaceBridge) =>
    bridge.invokeTool({ call: 's', turn: 't', tool: 'add', input: { by: 2 }, timeoutS: 60, signal: new AbortController().signal, onProgress: () => undefined });

  it("a register the host refuses, or one that never left the page, keeps both sides' tools the same", async () => {
    const h = hooks();
    const verdicts: Array<(v: unknown) => void> = [];
    h.assistantTools.mockImplementation((reg: { tools: CheckedTool[] } | null) =>
      reg === null ? acceptAll(null) : Object.assign(new Promise((r) => verdicts.push(r)), { abandon: vi.fn() }),
    );
    const t = await sdkConnected(h);
    const assistant = t.ws.assistant!;
    const handler = vi.fn(async () => 'Counter is 2');
    // A list waits for its verdict; a newer one the host refuses (a name too long) is the last one, on both sides.
    const one = assistant.register([TOOL], handler);
    await settle(() => verdicts.length === 1, 'the first list');
    await expect(assistant.register([{ ...TOOL, name: 'a'.repeat(65) }], handler)).rejects.toMatchObject({ code: 'bad_request' });
    verdicts[0]({ available: true, accepted: ['add'], refused: [] });
    expect(await one).toMatchObject({ available: true, accepted: ['add'] });
    expect(t.calls.assistantTool('add')).toBeNull();
    expect(await call(t.bridge)).toEqual({ ok: false, code: 'no_tool', message: 'the workspace has no tool named "add"' });
    // A list that cannot be copied never reaches the host: the one before it is still the last one, on both sides.
    const two = assistant.register([TOOL], handler);
    await settle(() => verdicts.length === 2, 'the second list');
    const uncopyable = { ...TOOL, inputSchema: { ...TOOL.inputSchema, check: () => true } } as AssistantTool;
    const err = await assistant.register([uncopyable], handler).catch((e: unknown) => e);
    expect((err as Error).name).toBe('DataCloneError');
    expect(verdicts).toHaveLength(2);
    verdicts[1]({ available: true, accepted: ['add'], refused: [] });
    expect(await two).toMatchObject({ available: true, accepted: ['add'] });
    expect(t.calls.assistantTool('add')).not.toBeNull();
    expect(await call(t.bridge)).toEqual({ ok: true, result: { text: 'Counter is 2' } });
    expect(handler).toHaveBeenCalledTimes(1);
    t.end();
  });

  it("a handler's thrown hint and detail, and its result's summary, reach the call's outcome through the real SDK", async () => {
    const t = await sdkConnected();
    const detail = { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3] };
    let n = 0;
    await t.ws.assistant!.register([TOOL], async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('step_too_big: at most 3 at a time.'), { code: 'invalid_input', hint: 'Call add with by 1, 2 or 3.', detail });
      // A detail JSON can't hold all of: the SDK sends what JSON makes of it.
      if (n === 2) throw Object.assign(new Error('No.'), { hint: 'Wait.', detail: { at: new Date(0), skip: () => 1 } });
      return { text: 'Now 2', data: { count: 2 }, summary: 'Added 2: the counter is 2' };
    });
    expect(await call(t.bridge)).toEqual({ ok: false, code: 'invalid_input', message: 'step_too_big: at most 3 at a time.', hint: 'Call add with by 1, 2 or 3.', detail });
    expect(await call(t.bridge)).toEqual({ ok: false, code: 'failed', message: 'No.', hint: 'Wait.', detail: { at: '1970-01-01T00:00:00.000Z' } });
    expect(await call(t.bridge)).toEqual({ ok: true, result: { text: 'Now 2', data: { count: 2 }, summary: 'Added 2: the counter is 2' } });
    t.end();
  });
});
