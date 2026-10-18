// The page relay (Foundation spec 8.4 and 6.4): a fake hub channel, a fetch whose answers each
// test hands out, the real workspace tools store and the app's real confirm dialog, on fake
// timers. Every race here is forced: a held answer, a released one, a timer moved on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishWorkspaceTools,
  resetWorkspaceToolsForTests,
  workspaceToolsSnapshot,
  type ToolInvoke,
  type TurnTell,
  type WorkspaceToolsScope,
} from '../workspace/assistantTools';
import type { AssistantCallOutcome, AssistantInvoke, CheckedTool } from '../workspace/bridge';
import type { AssistantRegistration, AssistantTurn } from '../plugin-sdk/workspace';
import { confirmAction, dialogBusy, YES_GUARD_MS } from '../workbench/dialogs';
import { exitFrameFullscreen } from '../workspace/leaveGuard';
import {
  GATE_RESHOWN_MS,
  PROGRESS_INTERVAL_MS,
  PROOF_KEEP_MS,
  PROOF_WAIT_MS,
  RELAY_CHANNEL_URL,
  RESULT_BEFORE_UNREGISTER_MS,
  startAssistantRelay,
  stopAnnouncedTurn,
  stopAssistantRelay,
} from './relay';
import { allowAgent, checkAgent, RemoteError } from './api';
import { resetStatusStore } from './status';
import type { GateView, RelayTurnFrame } from './wire';

/** What happened, in order: requests sent and answered, frames, the channel's pins and close. */
const hoisted = vi.hoisted(() => {
  const log: string[] = [];
  class FakeChannel {
    readonly CONNECTING = 0 as const;
    readonly OPEN = 1 as const;
    readonly CLOSED = 2 as const;
    readyState = 0;
    onmessage = null;
    onerror = null;
    onopen = null;
    pinned = false;
    closed = false;
    private readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
    constructor(readonly url: string) {}
    addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(fn);
    }
    removeEventListener(type: string, fn: (ev: MessageEvent) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 2;
      log.push('channel closed');
    }
    pin(on: boolean): void {
      this.pinned = on;
    }
    ready(): Promise<boolean> {
      return Promise.resolve(this.readyState === 1);
    }
    /** A frame from the server, as the hub hands it over. */
    frame(type: string, data: unknown): void {
      if (this.closed) return;
      this.readyState = 1;
      for (const fn of [...(this.listeners.get(type) || [])]) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    /** The tab's stream dropped (the hub reconnects; the server ends this page's calls). */
    drop(): void {
      this.readyState = 0;
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
    /** The server refused the channel (403 not this PC, 400 another role): closed, with an error. */
    refuse(): void {
      this.readyState = 2;
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
  }
  const channels: FakeChannel[] = [];
  return { log, channels, FakeChannel };
});
const { log, channels } = hoisted;

vi.mock('../api/eventHub', () => ({
  openChannel: vi.fn((url: string) => {
    const ch = new hoisted.FakeChannel(url);
    hoisted.channels.push(ch);
    return ch;
  }),
}));
vi.mock('../workspace/leaveGuard', () => ({
  exitFrameFullscreen: vi.fn(async () => {
    hoisted.log.push('out of full screen');
  }),
}));
// The app's real dialog, watched.
vi.mock('../workbench/dialogs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workbench/dialogs')>();
  return { ...real, confirmAction: vi.fn((opts) => real.confirmAction(opts)) };
});

const SCOPE: WorkspaceToolsScope = { project_id: 'proj-a', plugin: 'ai-demo', workspace: 'counter', study_id: 'st-1' };
const SCHEMA = { type: 'object', properties: { by: { type: 'integer' } }, required: ['by'], additionalProperties: false };
const tool = (name: string): CheckedTool => ({ name, title: name, description: `Does ${name}.`, inputSchema: SCHEMA, risk: 'edit', timeoutS: 30 });
const LINK_A = 'a'.repeat(24);
const LINK_B = 'b'.repeat(24);
const LINK_C = 'c'.repeat(24);

/** A request the page sent; `answer` hands its answer back. */
interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown>;
  answered: boolean;
  answer(status: number, body?: unknown): void;
  /** No answer comes (the connection failed). */
  fail(): void;
}
let sent: Sent[] = [];
/** Answers given at once (the rest wait for the test): null holds the request. */
let auto: (s: Sent) => [number, unknown] | null;

const short = (s: Sent): string => {
  const p = s.path.replace('/api/assistant/', '');
  if (p === 'relay/tools') return `tools[${((s.body.tools as Array<{ name: string }>) || []).map((t) => t.name).join(',')}]`;
  if (p === 'relay/progress') return s.body.ack ? 'ack' : 'progress';
  if (p === 'relay/result') return 'result';
  return p;
};

function defaultAuto(s: Sent): [number, unknown] | null {
  if (s.path === '/api/assistant/status') return [200, { ok: true, available: true, provider: 'off' }];
  if (s.path === '/api/assistant/relay/progress' || s.path === '/api/assistant/relay/gate') return [200, { ok: true }];
  return null;
}

/** The answers to questions (POST /relay/gate), oldest first. */
const gateAnswers = () => sent.filter((s) => s.path === '/api/assistant/relay/gate' || s.path.startsWith('/api/assistant/gates/'));

/** The tools POSTs, oldest first. */
const toolPosts = () => sent.filter((s) => s.path === '/api/assistant/relay/tools');
const lastTools = () => toolPosts().at(-1) as Sent;
const take = (path: string): Sent => {
  const s = sent.find((x) => x.path === path && !x.answered);
  if (!s) throw new Error(`nothing waits at ${path} (${sent.map(short).join(' ')})`);
  return s;
};
/** The last request sent to `path` (answered or not). */
const last = (path: string): Sent => {
  const s = sent.filter((x) => x.path === path).at(-1);
  if (!s) throw new Error(`nothing sent to ${path} (${sent.map(short).join(' ')})`);
  return s;
};
const accept = (s: Sent, epoch = 'boot-1:3') =>
  s.answer(200, { ok: true, available: true, accepted: (s.body.tools as Array<{ name: string }>).map((t) => t.name), refused: [], epoch });

/** Lets queued work run (microtasks, and timers due by now). */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A tool call of the frame, held until the test ends it. */
interface Running {
  req: AssistantInvoke;
  end(out: AssistantCallOutcome): void;
}
let running: Running[] = [];
const invoke: ToolInvoke = vi.fn(
  (req: AssistantInvoke) =>
    new Promise<AssistantCallOutcome>((resolve) => {
      log.push(`invoke ${req.tool}`);
      running.push({ req, end: resolve });
    }),
);

/**
 * The frame's ws.assistant.register as the bridge runs it: the store's verdict, or after 5 s
 * `not_connected` and abandon() (bridge.ts registerAssistantTools).
 */
function register(names: string[], frameId = 'frame-1', guide = 'Counter notes', tell: TurnTell | null = null): Promise<AssistantRegistration> {
  const pub = publishWorkspaceTools(SCOPE, frameId, { tools: names.map(tool), guide }, invoke, tell);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((done) => {
    timer = setTimeout(() => done('late'), 5000);
  });
  return Promise.race([pub, late]).then((answer) => {
    clearTimeout(timer);
    if (answer === 'late') {
      pub.abandon?.();
      return { available: false, accepted: [], refused: [], reason: 'not_connected' };
    }
    return answer;
  });
}

const channel = () => channels.at(-1) as InstanceType<typeof hoisted.FakeChannel>;

/** A relay with one list accepted on LINK_A. */
async function registered(names = ['add']): Promise<void> {
  startAssistantRelay();
  const verdict = register(names);
  await settle();
  channel().frame('linked', { link: LINK_A });
  await settle();
  accept(take('/api/assistant/relay/tools'));
  await settle();
  expect(await verdict).toMatchObject({ available: true, accepted: names });
}

const MODAL = `
  <div id="modal-confirm" hidden>
    <div id="cf-backdrop"></div>
    <h2 id="cf-heading"></h2><p id="cf-copy"></p>
    <button type="button" id="cf-cancel">Cancel</button>
    <button type="button" id="cf-confirm">Delete</button>
  </div>`;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = MODAL;
  resetStatusStore();
  resetWorkspaceToolsForTests();
  log.length = 0;
  channels.length = 0;
  sent = [];
  running = [];
  auto = defaultAuto;
  vi.mocked(invoke).mockClear();
  vi.mocked(confirmAction).mockClear();
  vi.mocked(exitFrameFullscreen).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((resolve, reject) => {
          const s: Sent = {
            path: String(input),
            method: init?.method || 'GET',
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
            answered: false,
            answer: (status, body = {}) => {
              if (s.answered) throw new Error(`answered twice: ${short(s)}`);
              s.answered = true;
              log.push(`${short(s)} answered`);
              resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
            },
            fail: () => {
              s.answered = true;
              log.push(`${short(s)} failed`);
              reject(new TypeError('Failed to fetch'));
            },
          };
          sent.push(s);
          log.push(`${short(s)} sent`);
          const now = auto(s);
          if (now) s.answer(now[0], now[1]);
        }),
    ),
  );
});

afterEach(async () => {
  stopAssistantRelay();
  // No dialog left open for the next test.
  for (let i = 0; i < 20 && dialogBusy(); i++) {
    const modal = document.getElementById('modal-confirm');
    if (modal && !modal.hidden) document.getElementById('cf-cancel')?.click();
    await vi.advanceTimersByTimeAsync(10);
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the page relay opens nothing until a workspace offers tools', () => {
  it('no channel and no request before a list; then the status once, then one channel', async () => {
    startAssistantRelay();
    await settle(60_000);
    expect(channels).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // An empty list (a page withdrawing nothing) needs no request either.
    expect(await publishWorkspaceTools(SCOPE, 'frame-1', { tools: [], guide: '' }, invoke)).toEqual({ available: true, accepted: [], refused: [] });
    await settle();
    expect(sent).toHaveLength(0);
    expect(channels).toHaveLength(0);
    void register(['add']);
    await settle();
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /api/assistant/status']);
    expect(channels.map((c) => c.url)).toEqual([RELAY_CHANNEL_URL]);
    expect(RELAY_CHANNEL_URL).toBe('/api/assistant/events?role=relay');
    // A second start does not make a second relay.
    startAssistantRelay();
    void register(['add', 'reset']);
    await settle();
    expect(channels).toHaveLength(1);
  });

  it('a page from another PC answers remote and opens nothing for its lifetime', async () => {
    auto = (s) => (s.path === '/api/assistant/status' ? [403, { ok: false, reason: 'remote', error: 'remote' }] : defaultAuto(s));
    startAssistantRelay();
    expect(await register(['add'])).toEqual({ available: false, accepted: [], refused: [], reason: 'remote' });
    expect(await register(['add', 'reset'])).toMatchObject({ available: false, reason: 'remote' });
    await settle(60_000);
    expect(channels).toHaveLength(0);
    // The status was read once; nothing else went out.
    expect(sent.map((s) => s.path)).toEqual(['/api/assistant/status']);
  });
});

describe("the window's proof: this tab's live link in a Settings call (a tab with no workspace opens its channel for it)", () => {
  const ALLOW = '/api/assistant/agents/allow';
  const TEST = '/api/assistant/agents/test';
  const FP = 'f'.repeat(64);
  const CHECKED = { ok: true, agent: 'Agent', version: '1.0.0', ms: 5, signed_in: 'yes', own_tools: 'off', images: false, modes: [], models: [], tools: null };

  it('Allow sends the link of a channel opened for it alone (the status first; nothing registered, not pinned); off sends none; the channel goes a minute after', async () => {
    startAssistantRelay();
    await settle(60_000);
    expect(channels).toHaveLength(0);
    auto = (s) => (s.path === ALLOW ? [200, { ok: true, agent: null }] : defaultAuto(s));
    const on = allowAgent('custom-abc123', true, FP);
    await settle();
    expect(sent.map((s) => s.path)).toEqual(['/api/assistant/status']);
    expect(channels.map((c) => c.url)).toEqual([RELAY_CHANNEL_URL]);
    channel().frame('linked', { link: LINK_A });
    await settle();
    await on;
    expect(last(ALLOW).body).toEqual({ id: 'custom-abc123', allow: true, fingerprint: FP, link: LINK_A });
    expect(toolPosts()).toEqual([]);
    expect(channel().pinned).toBe(false);
    // Off is the kill switch: no proof, no link.
    await allowAgent('custom-abc123', false, null);
    expect(last(ALLOW).body).toEqual({ id: 'custom-abc123', allow: false });
    // Kept for the next call, then let go.
    await settle(PROOF_KEEP_MS - 1000);
    expect(channel().closed).toBe(false);
    await settle(2000);
    expect(channel().closed).toBe(true);
    expect(channels).toHaveLength(1);
  });

  it('kept while the call is out; a link the server refused as gone is sent once more with the next one, then the answer stands', async () => {
    startAssistantRelay();
    const check = checkAgent('claude', false);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    // A long check: the channel stays open past the keep time while it is out.
    await settle(PROOF_KEEP_MS * 2);
    expect(channel().closed).toBe(false);
    take(TEST).answer(403, { ok: false, code: 'launch_proof', error: 'gone' });
    await settle(1000);
    // Not the refused link again: it waits for the next.
    expect(sent.filter((s) => s.path === TEST)).toHaveLength(1);
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    const again = take(TEST);
    expect(again.body).toEqual({ id: 'claude', message: false, link: LINK_B });
    again.answer(200, CHECKED);
    expect(await check).toMatchObject({ ok: true, agent: 'Agent' });
    // Refused twice: that is the answer (one retry).
    const twice = checkAgent('claude', true);
    await settle();
    take(TEST).answer(403, { ok: false, code: 'launch_proof', error: 'still no' });
    await settle();
    channel().drop();
    channel().frame('linked', { link: LINK_C });
    await settle();
    take(TEST).answer(403, { ok: false, code: 'launch_proof', error: 'still no' });
    expect(await twice).toEqual({ ok: false, code: 'launch_proof', error: 'still no' });
    expect(sent.filter((s) => s.path === TEST).map((s) => s.body.link)).toEqual([LINK_A, LINK_B, LINK_B, LINK_C]);
  });

  it('a channel refused: the call goes without a link after the wait, and the channel is not asked again in a loop', async () => {
    startAssistantRelay();
    const check = checkAgent('claude', false);
    await settle();
    channel().refuse();
    await settle(PROOF_WAIT_MS - 100);
    expect(sent.filter((s) => s.path === TEST)).toHaveLength(0);
    await settle(200);
    const s = take(TEST);
    expect(s.body).toEqual({ id: 'claude', message: false });
    s.answer(403, { ok: false, code: 'launch_proof', error: 'no proof' });
    expect(await check).toEqual({ ok: false, code: 'launch_proof', error: 'no proof' });
    expect(channels).toHaveLength(1);
  });

  it('another PC: no channel, and the call goes at once without a link; with no relay started, too', async () => {
    auto = (s) => (s.path === '/api/assistant/status' || s.path === TEST ? [403, { ok: false, reason: 'remote', error: 'remote' }] : defaultAuto(s));
    startAssistantRelay();
    await expect(checkAgent('claude', false)).rejects.toBeInstanceOf(RemoteError);
    expect(channels).toHaveLength(0);
    expect(last(TEST).body).toEqual({ id: 'claude', message: false });
    stopAssistantRelay();
    auto = (x) => (x.path === TEST ? [200, CHECKED] : defaultAuto(x));
    expect(await checkAgent('claude', true)).toMatchObject({ ok: true });
    expect(last(TEST).body).toEqual({ id: 'claude', message: true });
    expect(channels).toHaveLength(0);
  });
});

describe('registrations', () => {
  it('POSTs only after `linked`, with that link and the route scope; a new `linked` sends it again', async () => {
    startAssistantRelay();
    const verdict = register(['add', 'reset']);
    await settle(1000);
    expect(toolPosts()).toHaveLength(0);
    channel().frame('linked', { link: LINK_A });
    await settle();
    const first = take('/api/assistant/relay/tools');
    expect(first.body).toEqual({
      link: LINK_A,
      rev: expect.any(Number),
      workspace: { project_id: 'proj-a', plugin: 'ai-demo', workspace: 'counter', study_id: 'st-1' },
      tools: [tool('add'), tool('reset')],
      guide: 'Counter notes',
    });
    accept(first, 'boot-1:3');
    expect(await verdict).toEqual({ available: true, accepted: ['add', 'reset'], refused: [] });
    // A reconnect: the stream drops, the server says `linked` with a new link.
    channel().drop();
    await settle();
    expect(toolPosts()).toHaveLength(1);
    channel().frame('linked', { link: LINK_B });
    await settle();
    const again = take('/api/assistant/relay/tools');
    // The same list, the frame's pinned epoch, a rev above every one sent before.
    expect(again.body).toMatchObject({ link: LINK_B, epoch: 'boot-1:3', tools: [tool('add'), tool('reset')] });
    expect(again.body.rev as number).toBeGreaterThan(first.body.rev as number);
    accept(again);
    await settle();
    // The same link again is not a new one.
    channel().frame('linked', { link: LINK_B });
    await settle();
    expect(toolPosts()).toHaveLength(2);
  });

  it("a tool's confirm note goes with it to the server (CAD tools spec H10); a tool without one sends none", async () => {
    startAssistantRelay();
    const note = 'Sets the counter to 0; add can bring it back.';
    const pub = publishWorkspaceTools(SCOPE, 'frame-1', { tools: [{ ...tool('reset'), risk: 'destructive', confirm: note }, tool('add')], guide: '' }, invoke);
    await settle(1000);
    channel().frame('linked', { link: LINK_A });
    await settle();
    const post = take('/api/assistant/relay/tools');
    const tools = post.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ ...tool('reset'), risk: 'destructive', confirm: note });
    expect(Object.hasOwn(tools[1], 'confirm')).toBe(false);
    accept(post);
    expect(await pub).toEqual({ available: true, accepted: ['reset', 'add'], refused: [] });
  });

  it('a link that went before the POST arrived (409 no_channel): sent again on the next `linked`', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'no_channel' });
    await settle(1000);
    expect(toolPosts()).toHaveLength(1);
    channel().frame('linked', { link: LINK_B });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    expect(lastTools().body.link).toBe(LINK_B);
    expect(await verdict).toMatchObject({ available: true, accepted: ['add'] });
  });

  it('hidden at load: the list times out at 5 s, is abandoned and never POSTed once shown; a later register POSTs', async () => {
    startAssistantRelay();
    // Hidden: the tab's stream waits, so no `linked` comes.
    const verdict = register(['add']);
    await settle(4999);
    expect(toolPosts()).toHaveLength(0);
    await settle(1);
    expect(await verdict).toEqual({ available: false, accepted: [], refused: [], reason: 'not_connected' });
    expect(workspaceToolsSnapshot().current).toMatchObject({ abandoned: true });
    const hidden = channel();
    // Shown: the stream opens and the server links the channel.
    hidden.frame('linked', { link: LINK_A });
    await settle(60_000);
    expect(toolPosts()).toHaveLength(0);
    // The page registers again (its last answer was not_connected): this one goes.
    const later = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_B });
    await settle();
    expect(toolPosts()).toHaveLength(1);
    expect(lastTools().body).toMatchObject({ link: LINK_B, tools: [tool('add')] });
    accept(lastTools());
    expect(await later).toMatchObject({ available: true, accepted: ['add'] });
  });

  it('a late accepted verdict for an abandoned list withdraws it at once (tools: [])', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    const out = take('/api/assistant/relay/tools');
    // The server is slow: the bridge's 5 s bound runs out first.
    await settle(5000);
    expect(await verdict).toMatchObject({ available: false, reason: 'not_connected' });
    expect(toolPosts()).toHaveLength(1);
    accept(out);
    await settle();
    expect(toolPosts()).toHaveLength(2);
    const withdraw = lastTools();
    expect(withdraw.body).toMatchObject({ link: LINK_A, tools: [], workspace: SCOPE, epoch: 'boot-1:3' });
    expect(withdraw.body.rev as number).toBeGreaterThan(out.body.rev as number);
    withdraw.answer(200, { ok: true, available: true, accepted: [], refused: [], epoch: 'boot-1:3' });
    await settle();
    // Nothing of the page is on the server, nothing offered: the channel goes.
    expect(channel().closed).toBe(true);
  });

  it('two quick lists: one POST in flight, the newest sent next', async () => {
    startAssistantRelay();
    const first = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    const second = register(['add', 'reset']);
    const third = register(['add', 'reset', 'mystery']);
    await settle(1000);
    expect(toolPosts().map(short)).toEqual(['tools[add]']);
    // The older lists are no one's now: neither side keeps them.
    expect(await second).toMatchObject({ available: false, reason: 'superseded' });
    accept(take('/api/assistant/relay/tools'));
    await settle();
    expect(await first).toMatchObject({ available: false, reason: 'superseded' });
    expect(toolPosts().map(short)).toEqual(['tools[add]', 'tools[add,reset,mystery]']);
    accept(take('/api/assistant/relay/tools'));
    expect(await third).toEqual({ available: true, accepted: ['add', 'reset', 'mystery'], refused: [] });
    await settle();
    expect(toolPosts()).toHaveLength(2);
  });

  it('`unregistered` marks the list dead: never sent again, not on the next `linked` nor by its frame', async () => {
    await registered();
    channel().frame('unregistered', { reason: 'plugin_off' });
    await settle();
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle(60_000);
    expect(toolPosts()).toHaveLength(1);
    // The same frame registering again is refused here; only a new frame registers that plugin again.
    expect(await register(['add'])).toMatchObject({ available: false, reason: 'plugin_off' });
    await settle();
    expect(toolPosts()).toHaveLength(1);
    const fresh = register(['add'], 'frame-2');
    await settle();
    channel().frame('linked', { link: LINK_C });
    await settle();
    expect(toolPosts()).toHaveLength(2);
    // A new frame has no pinned epoch.
    expect(lastTools().body).not.toHaveProperty('epoch');
    accept(lastTools());
    expect(await fresh).toMatchObject({ available: true });
  });

  it('a refused channel answers not_connected at once and opens again only for a newer list', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().refuse();
    expect(await verdict).toMatchObject({ available: false, reason: 'not_connected' });
    await settle(60_000);
    expect(channels).toHaveLength(1);
    expect(toolPosts()).toHaveLength(0);
    const again = register(['add']);
    await settle();
    expect(channels).toHaveLength(2);
    channel().frame('linked', { link: LINK_A });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    expect(await again).toMatchObject({ available: true });
  });

  it('a 409 plugin_changed marks the frame dead too', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'plugin_changed', error: 'replaced' });
    expect(await verdict).toMatchObject({ available: false, reason: 'plugin_changed' });
    expect(await register(['add'])).toMatchObject({ available: false, reason: 'plugin_changed' });
    await settle();
    expect(toolPosts()).toHaveLength(1);
  });

  it('a list the server refused is never sent again (not on a new link); the frame registers again', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    take('/api/assistant/relay/tools').answer(400, { ok: false, code: 'invalid', error: 'bad list' });
    expect(await verdict).toEqual({ available: false, accepted: [], refused: [], reason: 'invalid' });
    await settle();
    // Nothing of the page on the server, nothing to send: the channel goes.
    expect(channel().closed).toBe(true);
    channel().frame('linked', { link: LINK_B });
    await settle(60_000);
    expect(toolPosts()).toHaveLength(1);
    const again = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_B });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    expect(await again).toMatchObject({ available: true, accepted: ['add'] });
  });

  it('a registration with no answer: the frame hears not_connected and the list is withdrawn in a moment', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    take('/api/assistant/relay/tools').fail();
    expect(await verdict).toMatchObject({ available: false, reason: 'not_connected' });
    await settle();
    // The server may have taken it: withdrawn, and tried again a second later when that has no answer either.
    expect(lastTools().body).toMatchObject({ link: LINK_A, tools: [] });
    lastTools().fail();
    await settle(999);
    expect(toolPosts()).toHaveLength(2);
    await settle(1);
    expect(toolPosts()).toHaveLength(3);
    lastTools().answer(200, { ok: true, available: true, accepted: [], refused: [], epoch: 'boot-1:3' });
    await settle();
    expect(channel().closed).toBe(true);
  });

  it('plugin_off is final, after a restart too (a server that has not read its plugins keeps a list instead): the frame is dead at once and nothing waits behind it', async () => {
    await registered();
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    // The restarted server read its plugins, and this one is off (the old boot's token counts as fresh there).
    const again = take('/api/assistant/relay/tools');
    expect(again.body).toMatchObject({ link: LINK_B, epoch: 'boot-1:3', tools: [tool('add')] });
    again.answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    await settle();
    expect(workspaceToolsSnapshot().current).toMatchObject({ dead: true });
    expect(await register(['add'])).toMatchObject({ available: false, reason: 'plugin_off' });
    await settle(10 * 60_000);
    expect(toolPosts()).toHaveLength(2);
    // Another workspace's list is not held back by any wait: it goes as soon as its channel links.
    const other = register(['ytool'], 'frame-2');
    await settle();
    channel().frame('linked', { link: LINK_C });
    await settle();
    expect(toolPosts().map(short)).toEqual(['tools[add]', 'tools[add]', 'tools[ytool]']);
    expect(lastTools().body).not.toHaveProperty('epoch');
    accept(lastTools());
    expect(await other).toMatchObject({ available: true, accepted: ['ytool'] });
    // A fresh frame refused plugin_off is dead at once too.
    const fresh = register(['ztool'], 'frame-3');
    await settle();
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    expect(await fresh).toMatchObject({ available: false, reason: 'plugin_off' });
    await settle(10 * 60_000);
    expect(toolPosts()).toHaveLength(4);
  });

  it('a newer list answered after its 5 s ran out, or not at all: the frame keeps its earlier list, and so does the server (it goes again, never tools: [])', async () => {
    await registered(['add']);
    const y = register(['add', 'reset']);
    await settle();
    const yPost = take('/api/assistant/relay/tools');
    // The server is slow: the bridge's 5 s bound runs out first, and the frame keeps add.
    await settle(5000);
    expect(await y).toMatchObject({ available: false, reason: 'not_connected' });
    accept(yPost);
    await settle();
    // The server took the newer list late: the kept one goes again in its place, not tools: [].
    expect(toolPosts().map(short)).toEqual(['tools[add]', 'tools[add,reset]', 'tools[add]']);
    expect(lastTools().body).toMatchObject({ link: LINK_A, epoch: 'boot-1:3' });
    accept(lastTools());
    await settle(60_000);
    expect(toolPosts()).toHaveLength(3);
    expect(channel().closed).toBe(false);
    // A newer list with no answer at all: the same.
    const z = register(['add', 'mystery']);
    await settle();
    take('/api/assistant/relay/tools').fail();
    expect(await z).toMatchObject({ available: false, reason: 'not_connected' });
    await settle();
    expect(toolPosts().map(short).slice(3)).toEqual(['tools[add,mystery]', 'tools[add]']);
    // The kept list gets no answer either: it is tried again a second later.
    lastTools().fail();
    await settle(999);
    expect(toolPosts()).toHaveLength(5);
    await settle(1);
    expect(toolPosts().map(short).slice(5)).toEqual(['tools[add]']);
    accept(lastTools());
    await settle(60_000);
    expect(toolPosts()).toHaveLength(6);
    expect(channel().closed).toBe(false);
    expect(workspaceToolsSnapshot().current).toMatchObject({ dead: false });
  });

  it('a newer list sent while the hidden tab had no stream (409 no_channel, then its 5 s ran out): once shown, the earlier list the frame keeps goes on the new link', async () => {
    await registered(['add']);
    // The hub let the hidden tab's stream go (no error here): the server's link A is gone.
    const y = register(['add', 'reset']);
    await settle();
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'no_channel', error: 'gone' });
    await settle(5000);
    expect(await y).toMatchObject({ available: false, reason: 'not_connected' });
    // Shown again: a new link. The server's copy of add is dormant on A; it comes back only by a POST on B.
    channel().frame('linked', { link: LINK_B });
    await settle();
    expect(toolPosts().map((s) => [short(s), s.body.link])).toEqual([
      ['tools[add]', LINK_A],
      ['tools[add,reset]', LINK_A],
      ['tools[add]', LINK_B],
    ]);
    expect(lastTools().body).toMatchObject({ epoch: 'boot-1:3', tools: [tool('add')] });
    accept(lastTools());
    await settle(60_000);
    expect(toolPosts()).toHaveLength(3);
  });

  it('a newer list refused: nothing more on that link (the server kept the earlier one); after a reconnect the earlier list goes on the new link', async () => {
    await registered(['add']);
    const y = register(['add', 'reset']);
    await settle();
    take('/api/assistant/relay/tools').answer(413, { ok: false, code: 'too_large', error: 'too large' });
    expect(await y).toMatchObject({ available: false, reason: 'too_large' });
    await settle(60_000);
    expect(toolPosts()).toHaveLength(2);
    expect(channel().closed).toBe(false);
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    expect(toolPosts().map((s) => [short(s), s.body.link]).slice(2)).toEqual([['tools[add]', LINK_B]]);
    // Refused again (the server changed its mind): not sent again on that link.
    lastTools().answer(400, { ok: false, code: 'bad_request', error: 'no' });
    await settle(60_000);
    expect(toolPosts()).toHaveLength(3);
    channel().drop();
    channel().frame('linked', { link: LINK_C });
    await settle();
    expect(toolPosts().map((s) => [short(s), s.body.link]).slice(3)).toEqual([['tools[add]', LINK_C]]);
    accept(lastTools());
    await settle();
  });

  it("every accepted registration's token is the frame's from then on (a restart's new one replaces the old)", async () => {
    await registered();
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    expect(lastTools().body).toMatchObject({ epoch: 'boot-1:3' });
    accept(take('/api/assistant/relay/tools'), 'boot-2:3');
    await settle();
    channel().drop();
    channel().frame('linked', { link: LINK_C });
    await settle();
    expect(lastTools().body).toMatchObject({ link: LINK_C, epoch: 'boot-2:3' });
  });

  it('[] unpublishes (tools: []) and closes the channel', async () => {
    await registered();
    const ch = channel();
    const verdict = publishWorkspaceTools(SCOPE, 'frame-1', { tools: [], guide: '' }, invoke);
    await settle();
    const withdraw = take('/api/assistant/relay/tools');
    expect(withdraw.body).toMatchObject({ link: LINK_A, tools: [], workspace: SCOPE });
    expect(ch.closed).toBe(false);
    withdraw.answer(200, { ok: true, available: true, accepted: [], refused: [], epoch: 'boot-1:3' });
    expect(await verdict).toEqual({ available: true, accepted: [], refused: [] });
    await settle();
    expect(ch.closed).toBe(true);
    expect(log.slice(-2)).toEqual(['tools[] answered', 'channel closed']);
  });
});

describe('tool calls', () => {
  it('invoke: the ack first, from the frame handler, then the frame; progress at most 4 a second; then the result', async () => {
    await registered();
    log.length = 0;
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    // From the handler: the ack is sent before the frame is asked.
    expect(log).toEqual(['ack sent', 'ack answered', 'invoke add']);
    expect(last('/api/assistant/relay/progress').body).toEqual({ link: LINK_A, call: 'call-1', ack: true });
    expect(sent.at(-1)?.body).toEqual({ link: LINK_A, call: 'call-1', ack: true });
    const run = running[0];
    expect(run.req).toMatchObject({ call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeoutS: 30 });
    // A running call keeps the tab's stream while it is hidden.
    await settle();
    expect(channel().pinned).toBe(true);
    for (let i = 1; i <= 10; i++) run.req.onProgress(i / 10, `step ${i}`);
    await settle();
    const progress = () => sent.filter((s) => s.path === '/api/assistant/relay/progress' && !s.body.ack).map((s) => s.body);
    expect(progress()).toEqual([{ link: LINK_A, call: 'call-1', fraction: 0.1, label: 'step 1' }]);
    await settle(PROGRESS_INTERVAL_MS - 1);
    expect(progress()).toHaveLength(1);
    await settle(1);
    // The newest only.
    expect(progress()).toEqual([
      { link: LINK_A, call: 'call-1', fraction: 0.1, label: 'step 1' },
      { link: LINK_A, call: 'call-1', fraction: 1, label: 'step 10' },
    ]);
    // A bare progress (no fraction, no label) is a sign of life too: it goes, fraction null (the
    // server counts a POST as progress only when it carries a fraction or a label).
    await settle(PROGRESS_INTERVAL_MS);
    run.req.onProgress(null, '');
    await settle();
    expect(progress().at(-1)).toEqual({ link: LINK_A, call: 'call-1', fraction: null });
    run.req.onProgress(null, '');
    run.end({ ok: true, result: { text: 'Counter is 3.', data: { count: 3 } } });
    await settle(PROGRESS_INTERVAL_MS * 4);
    expect(take('/api/assistant/relay/result').body).toEqual({ link: LINK_A, call: 'call-1', ok: true, result: { text: 'Counter is 3.', data: { count: 3 } } });
    // Nothing after the result.
    expect(progress()).toHaveLength(3);
    take('/api/assistant/relay/result').answer(200, { ok: true });
    await settle();
    expect(channel().pinned).toBe(false);
  });

  it('the frame waiting on a call to the app (onAlive): a bare progress, never in place of one waiting to go, none after the end', async () => {
    await registered();
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    const run = running[0];
    const progress = () => sent.filter((s) => s.path === '/api/assistant/relay/progress' && !s.body.ack).map((s) => s.body);
    // The server's stall window counts it: it carries the fraction, as null.
    run.req.onAlive?.();
    await settle();
    expect(progress()).toEqual([{ link: LINK_A, call: 'call-1', fraction: null }]);
    // Within the 4 a second, a labelled progress waits its turn; a sign of life meanwhile does not replace it.
    run.req.onProgress(0.5, 'half');
    run.req.onAlive?.();
    await settle(PROGRESS_INTERVAL_MS);
    expect(progress()).toEqual([
      { link: LINK_A, call: 'call-1', fraction: null },
      { link: LINK_A, call: 'call-1', fraction: 0.5, label: 'half' },
    ]);
    // Alone, it waits its turn too.
    run.req.onAlive?.();
    await settle(PROGRESS_INTERVAL_MS - 1);
    expect(progress()).toHaveLength(2);
    await settle(1);
    expect(progress().at(-1)).toEqual({ link: LINK_A, call: 'call-1', fraction: null });
    run.end({ ok: true, result: { text: 'Counter is 2.' } });
    await settle();
    run.req.onAlive?.();
    await settle(PROGRESS_INTERVAL_MS * 2);
    expect(progress()).toHaveLength(3);
    take('/api/assistant/relay/result').answer(200, { ok: true });
    await settle();
  });

  it('a progress that waits for the person goes waiting: true, and so does each sign of life after it, until a progress that does not wait', async () => {
    await registered();
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    const run = running[0];
    const progress = () => sent.filter((s) => s.path === '/api/assistant/relay/progress' && !s.body.ack).map((s) => s.body);
    const at = { link: LINK_A, call: 'call-1' };
    run.req.onProgress(null, 'Waiting for you', { waiting: true });
    await settle();
    expect(progress()).toEqual([{ ...at, fraction: null, label: 'Waiting for you', waiting: true }]);
    // A call of the frame in flight meanwhile: its sign of life waits too (the turn's minutes stay stopped).
    await settle(PROGRESS_INTERVAL_MS);
    run.req.onAlive?.();
    await settle();
    expect(progress().at(-1)).toEqual({ ...at, fraction: null, waiting: true });
    // A progress that does not wait ends it. Within the 4 a second the newest goes: a waiting
    // one replaced by one that does not wait goes without it.
    await settle(PROGRESS_INTERVAL_MS);
    run.req.onProgress(0.1, 'Building');
    run.req.onProgress(0.15, 'Waiting again', { waiting: true });
    run.req.onProgress(0.2, 'Building on');
    await settle(PROGRESS_INTERVAL_MS);
    // And the signs of life after it do not wait either.
    await settle(PROGRESS_INTERVAL_MS);
    run.req.onAlive?.();
    await settle();
    expect(progress()).toEqual([
      { ...at, fraction: null, label: 'Waiting for you', waiting: true },
      { ...at, fraction: null, waiting: true },
      { ...at, fraction: 0.1, label: 'Building' },
      { ...at, fraction: 0.2, label: 'Building on' },
      { ...at, fraction: null },
    ]);
    run.end({ ok: true, result: { text: 'Counter is 2.' } });
    await settle();
    take('/api/assistant/relay/result').answer(200, { ok: true });
    await settle();
  });

  it('abort stops the call in the frame; its end goes back as the result', async () => {
    await registered();
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    const run = running[0];
    expect(run.req.signal.aborted).toBe(false);
    channel().frame('abort', { call: 'call-other' });
    expect(run.req.signal.aborted).toBe(false);
    channel().frame('abort', { call: 'call-1' });
    expect(run.req.signal.aborted).toBe(true);
    run.end({ ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' });
    await settle();
    expect(take('/api/assistant/relay/result').body).toEqual({
      link: LINK_A,
      call: 'call-1',
      ok: false,
      error: { code: 'aborted', message: 'it was stopped before its page said it finished' },
    });
  });

  it("a page error's hint and detail, and a result's summary, go to the server as the bridge kept them", async () => {
    await registered();
    const detail = { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3] };
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 9 }, timeout_s: 30 });
    running[0].end({ ok: false, code: 'invalid_input', message: 'step_too_big: at most 3.', hint: 'Use 1, 2 or 3.', detail });
    await settle();
    const failed = take('/api/assistant/relay/result');
    expect(failed.body).toEqual({ link: LINK_A, call: 'call-1', ok: false, error: { code: 'invalid_input', message: 'step_too_big: at most 3.', hint: 'Use 1, 2 or 3.', detail } });
    failed.answer(200, { ok: true });
    await settle();
    channel().frame('invoke', { call: 'call-2', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    running[1].end({ ok: true, result: { text: 'Now 2', data: { count: 2 }, summary: 'Added 2: the counter is 2' } });
    await settle();
    expect(take('/api/assistant/relay/result').body).toEqual({
      link: LINK_A,
      call: 'call-2',
      ok: true,
      result: { text: 'Now 2', data: { count: 2 }, summary: 'Added 2: the counter is 2' },
    });
  });

  it('`unregistered` stops the running call (the server failed it plugin_off): it changes nothing more in the frame', async () => {
    await registered();
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, timeout_s: 30 });
    const run = running[0];
    expect(run.req.signal.aborted).toBe(false);
    channel().frame('unregistered', { reason: 'plugin_off' });
    expect(run.req.signal.aborted).toBe(true);
    run.end({ ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' });
    await settle();
    // Its end still goes back (the server answers it stale); nothing is withdrawn (the server dropped the
    // list), and with nothing of this page left on the server the channel went at once.
    const result = take('/api/assistant/relay/result');
    expect(result.body).toMatchObject({ link: LINK_A, call: 'call-1', ok: false, error: { code: 'aborted' } });
    result.answer(200, { ok: true, stale: true });
    await settle();
    expect(toolPosts()).toHaveLength(1);
    expect(log.slice(log.indexOf('invoke add'))).toEqual(['invoke add', 'channel closed', 'result sent', 'result answered']);
  });

  it('a dropped stream stops the running call (the server failed it at once)', async () => {
    await registered();
    channel().frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: {}, timeout_s: 30 });
    channel().drop();
    expect(running[0].req.signal.aborted).toBe(true);
  });

  it('a new `linked` with no stream error first stops the calls of the earlier link; their result goes on that link', async () => {
    await registered();
    const ch = channel();
    ch.frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 1 }, timeout_s: 30 });
    const run = running[0];
    // The hub moved the tab to a new stream: the channel stayed open and fired no error.
    ch.frame('linked', { link: LINK_B });
    expect(run.req.signal.aborted).toBe(true);
    run.end({ ok: false, code: 'aborted', message: 'it was stopped before its page said it finished' });
    await settle();
    expect(take('/api/assistant/relay/result').body).toMatchObject({ link: LINK_A, call: 'call-1', ok: false, error: { code: 'aborted' } });
  });

  it('a list that goes while a call runs: the result POST resolves before tools: [] is sent, and that before the channel closes', async () => {
    await registered();
    const ch = channel();
    ch.frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 1 }, timeout_s: 30 });
    log.length = 0;
    // The bridge's close(): the call ends `closed`, then hooks.assistantTools(null).
    running[0].end({ ok: false, code: 'closed', message: 'its page closed before the tool finished; it may or may not have finished' });
    publishWorkspaceTools(SCOPE, 'frame-1', null, invoke);
    await settle(RESULT_BEFORE_UNREGISTER_MS - 1);
    expect(log).toEqual(['result sent']);
    expect(take('/api/assistant/relay/result').body).toMatchObject({ ok: false, error: { code: 'closed' } });
    take('/api/assistant/relay/result').answer(200, { ok: true });
    await settle();
    expect(log).toEqual(['result sent', 'result answered', 'tools[] sent']);
    expect(ch.closed).toBe(false);
    take('/api/assistant/relay/tools').answer(200, { ok: true, available: true, accepted: [], refused: [], epoch: 'boot-1:3' });
    await settle();
    expect(log).toEqual(['result sent', 'result answered', 'tools[] sent', 'tools[] answered', 'channel closed']);
  });

  it('a result that never comes holds the withdrawal 3 s at most', async () => {
    await registered();
    const ch = channel();
    ch.frame('invoke', { call: 'call-1', turn: 'turn-1', tool: 'add', input: { by: 1 }, timeout_s: 30 });
    publishWorkspaceTools(SCOPE, 'frame-1', null, invoke);
    await settle(RESULT_BEFORE_UNREGISTER_MS - 1);
    expect(toolPosts()).toHaveLength(1);
    await settle(1);
    expect(lastTools().body).toMatchObject({ tools: [] });
    lastTools().answer(200, { ok: true, available: true, accepted: [], refused: [], epoch: 'boot-1:3' });
    await settle();
    expect(ch.closed).toBe(true);
  });
});

describe('questions (gates) as the app confirm dialog', () => {
  const gate = (over: Partial<GateView>): GateView => ({
    id: 'g-1',
    kind: 'confirm',
    turn: 'turn-1',
    title: 'Allow the Assistant to Reset the counter?',
    copy: 'Workspace demo · can\'t be undone. Nothing runs until you choose.',
    yes: 'Allow',
    no: "Don't",
    risk: 'destructive',
    opened_at: '2026-10-16T10:00:00Z',
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...over,
  });
  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  it('every kind is shown safe and guarded, out of full screen first, with its detail rows; Allow is a deliberate click', async () => {
    await registered();
    // Leaving full screen takes a while: the dialog waits for it.
    let outOfFullScreen: () => void = () => undefined;
    vi.mocked(exitFrameFullscreen).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          outOfFullScreen = () => {
            log.push('out of full screen');
            done();
          };
        }),
    );
    channel().frame('gate', { gate: gate({ detail: [{ label: 'Cells', value: '1.2 M' }, { label: 'Time', value: 'about 4 min' }] }) });
    await settle(1000);
    expect(exitFrameFullscreen).toHaveBeenCalledTimes(1);
    expect(confirmAction).not.toHaveBeenCalled();
    expect($('modal-confirm').hidden).toBe(true);
    outOfFullScreen();
    await settle();
    expect(log.indexOf('out of full screen')).toBeGreaterThan(-1);
    expect(vi.mocked(exitFrameFullscreen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(confirmAction).mock.invocationCallOrder[0]);
    expect(confirmAction).toHaveBeenLastCalledWith({
      title: 'Allow the Assistant to Reset the counter?',
      copy: "Workspace demo · can't be undone. Nothing runs until you choose. · Cells: 1.2 M · Time: about 4 min",
      yes: 'Allow',
      no: "Don't",
      safe: true,
      guard: true,
      signal: expect.any(AbortSignal),
    });
    expect($('modal-confirm').hidden).toBe(false);
    expect(document.activeElement).toBe($('cf-cancel'));
    expect(channel().pinned).toBe(true);
    // Allow is off for its first moment on screen: a click then is no answer.
    expect(($('cf-confirm') as HTMLButtonElement).disabled).toBe(true);
    $('cf-confirm').click();
    await settle();
    expect(gateAnswers()).toHaveLength(0);
    await settle(YES_GUARD_MS);
    $('cf-confirm').click();
    await settle();
    expect(gateAnswers().map((a) => [a.path, a.body])).toEqual([['/api/assistant/relay/gate', { link: LINK_A, gate: 'g-1', allow: true }]]);
    channel().frame('gate', { gate: gate({ id: 'g-2', kind: 'privacy', risk: undefined, title: 'Send project "Wing" to the cloud provider?', yes: 'Send', no: "Don't send" }) });
    await settle(10);
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(confirmAction).mock.lastCall?.[0]).toMatchObject({ title: 'Send project "Wing" to the cloud provider?', yes: 'Send', no: "Don't send", safe: true, guard: true });
    $('cf-cancel').click();
    await settle();
    expect(gateAnswers().at(-1)?.body).toEqual({ link: LINK_A, gate: 'g-2', allow: false });
  });

  it('Enter right after a gate frame answers No (allow:false)', async () => {
    await registered();
    channel().frame('gate', { gate: gate({}) });
    await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    const answer = gateAnswers().at(-1) as Sent;
    expect([answer.method, answer.path]).toEqual(['POST', '/api/assistant/relay/gate']);
    expect(answer.body).toEqual({ link: LINK_A, gate: 'g-1', allow: false });
    expect($('modal-confirm').hidden).toBe(true);
  });

  it('gate_closed closes the dialog with no POST; a gate shown again (a reconnect) is one dialog', async () => {
    await registered();
    channel().frame('gate', { gate: gate({}) });
    channel().frame('gate', { gate: gate({}) });
    await settle();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect($('modal-confirm').hidden).toBe(false);
    channel().frame('gate_closed', { gate: 'g-1', answer: 'deny', by: 'timeout' });
    await settle(100);
    expect($('modal-confirm').hidden).toBe(true);
    expect(gateAnswers()).toHaveLength(0);
    expect(channel().pinned).toBe(false);
  });
});

describe('questions the server can no longer close', () => {
  const view = (id: string, title: string, expiresInMs = 10 * 60_000): GateView => ({
    id,
    kind: 'confirm',
    turn: 'turn-1',
    title,
    copy: 'Nothing runs until you choose.',
    yes: 'Allow',
    no: "Don't",
    risk: 'edit',
    opened_at: new Date(Date.now()).toISOString(),
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  });
  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  it('a question not shown again on a new link closes unanswered; one shown again stays', async () => {
    await registered();
    const ch = channel();
    ch.frame('gate', { gate: view('g-1', 'First question?') });
    ch.frame('gate', { gate: view('g-2', 'Second question?') });
    await settle();
    expect($('cf-heading').textContent).toBe('First question?');
    // The link drops; g-1 is answered elsewhere meanwhile, so the new link shows only g-2 again.
    ch.drop();
    await settle();
    ch.frame('linked', { link: LINK_B });
    ch.frame('gate', { gate: view('g-2', 'Second question?') });
    await settle(GATE_RESHOWN_MS - 1);
    expect($('cf-heading').textContent).toBe('First question?');
    expect($('modal-confirm').hidden).toBe(false);
    await settle(1);
    await settle(10);
    // g-1 closed with no answer sent; g-2 is the dialog now, still on screen.
    expect($('cf-heading').textContent).toBe('Second question?');
    expect($('modal-confirm').hidden).toBe(false);
    expect(gateAnswers()).toHaveLength(0);
    expect(ch.pinned).toBe(true);
    $('cf-cancel').click();
    await settle();
    // Answered on the link it was shown on again, not the one it first came on.
    expect(gateAnswers().map((s) => [s.path, s.body])).toEqual([['/api/assistant/relay/gate', { link: LINK_B, gate: 'g-2', allow: false }]]);
    expect(ch.pinned).toBe(false);
  });

  it('a question closes unanswered at its expires_at when the link stays down', async () => {
    await registered();
    const ch = channel();
    ch.frame('gate', { gate: view('g-1', 'First question?', 60_000) });
    await settle();
    expect($('modal-confirm').hidden).toBe(false);
    ch.drop();
    await settle(60_000 - 1);
    expect($('modal-confirm').hidden).toBe(false);
    expect(ch.pinned).toBe(true);
    await settle(1);
    expect($('modal-confirm').hidden).toBe(true);
    expect(gateAnswers()).toHaveLength(0);
    expect(ch.pinned).toBe(false);
  });
});

describe('the hold (pinning the tab stream)', () => {
  it('active {turns:1} pins; hold_until keeps it after the turn; it goes at hold_until', async () => {
    await registered();
    const ch = channel();
    expect(ch.pinned).toBe(false);
    ch.frame('active', { turns: 1, hold_until: null });
    expect(ch.pinned).toBe(true);
    const until = Date.now() + 10 * 60_000;
    ch.frame('active', { turns: 0, hold_until: new Date(until).toISOString() });
    expect(ch.pinned).toBe(true);
    await settle(10 * 60_000 - 1);
    expect(ch.pinned).toBe(true);
    await settle(1);
    expect(ch.pinned).toBe(false);
    // A hold as ms since 1970 works the same.
    ch.frame('active', { turns: 0, hold_until: Date.now() + 2000 });
    expect(ch.pinned).toBe(true);
    await settle(2000);
    expect(ch.pinned).toBe(false);
  });

  it("a new link starts with no turns and no hold: only that link's `active` pins again", async () => {
    await registered();
    const ch = channel();
    ch.frame('active', { turns: 1, hold_until: null });
    expect(ch.pinned).toBe(true);
    // The stream drops: the pin stays, so a hidden tab gets its link back.
    ch.drop();
    await settle();
    expect(ch.pinned).toBe(true);
    // A restarted server (or one whose hold ran out while the PC slept) has no turns for it: no `active` follows.
    ch.frame('linked', { link: LINK_B });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle(60 * 60_000);
    expect(ch.pinned).toBe(false);
    // A server with a turn still bound to the tab says so right after `linked`.
    ch.drop();
    ch.frame('linked', { link: LINK_C });
    ch.frame('active', { turns: 1, hold_until: null });
    await settle();
    expect(ch.pinned).toBe(true);
    accept(take('/api/assistant/relay/tools'));
    await settle(60 * 60_000);
    expect(ch.pinned).toBe(true);
  });
});

describe('turns bound to this tab (CAD tools spec H3)', () => {
  const USED = { steps: 0, steps_cap: 50, usd: 0, usd_cap: 3 };
  const turnFrame = (id: string, over: Partial<RelayTurnFrame> = {}): RelayTurnFrame => ({
    id,
    state: 'running',
    title: 'Add 2 to the counter',
    local: true,
    context_tokens: null,
    images: null,
    used: USED,
    ...over,
  });
  const told = (id: string, over: Partial<AssistantTurn> = {}): AssistantTurn => ({
    id,
    state: 'running',
    title: 'Add 2 to the counter',
    local: true,
    contextTokens: null,
    images: null,
    used: { steps: 0, stepsCap: 50, usd: 0, usdCap: 3 },
    ...over,
  });

  /** A relay with frame-1's list accepted on LINK_A; the turns that frame is told of. */
  async function heard(): Promise<AssistantTurn[]> {
    const turns: AssistantTurn[] = [];
    startAssistantRelay();
    const verdict = register(['add'], 'frame-1', 'Counter notes', (t) => turns.push(t));
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    expect(await verdict).toMatchObject({ available: true });
    return turns;
  }

  it("each start, change and end goes to the open frame in the SDK's words; a frame that is not a turn is dropped", async () => {
    const turns = await heard();
    const ch = channel();
    ch.frame('turn', turnFrame('t-1'));
    ch.frame('turn', turnFrame('t-1', { context_tokens: 32768, images: false, used: { steps: 1, steps_cap: 50, usd: 0.0125, usd_cap: 3 } }));
    ch.frame('turn', turnFrame('t-1', { state: 'ended', used: { steps: 2, steps_cap: 50, usd: 0.02, usd_cap: 3 }, end: { state: 'stopped', reason: 'user' } }));
    // An end in words it does not know is left out; anything that is not a turn goes nowhere.
    ch.frame('turn', turnFrame('t-3', { state: 'ended', end: { state: 'paused' as never, reason: 'x' } }));
    for (const bad of [{}, { id: 't-2', state: 'paused' }, { id: '', state: 'running' }, { id: 'x'.repeat(129), state: 'running' }, 5, 'turn']) ch.frame('turn', bad);
    expect(turns).toEqual([
      told('t-1'),
      told('t-1', { contextTokens: 32768, images: false, used: { steps: 1, stepsCap: 50, usd: 0.0125, usdCap: 3 } }),
      told('t-1', { state: 'ended', used: { steps: 2, stepsCap: 50, usd: 0.02, usdCap: 3 }, end: { state: 'stopped', reason: 'user' } }),
      told('t-3', { state: 'ended' }),
    ]);
    expect(Object.hasOwn(turns[3], 'end')).toBe(false);
  });

  it('a new frame hears the running turns once as it offers its tools; a dead frame hears nothing', async () => {
    const turns = await heard();
    const ch = channel();
    ch.frame('turn', turnFrame('t-1'));
    ch.frame('turn', turnFrame('t-0', { state: 'ended', end: { state: 'done', reason: 'end_turn' } }));
    expect(turns.map((t) => t.id)).toEqual(['t-1', 't-0']);
    // Another frame offers its tools: it hears the running one at once, before its verdict.
    const next: AssistantTurn[] = [];
    const verdict = register(['add'], 'frame-2', 'Counter notes', (t) => next.push(t));
    await settle();
    expect(next).toEqual([told('t-1')]);
    accept(take('/api/assistant/relay/tools'));
    await settle();
    expect(await verdict).toMatchObject({ available: true });
    // Its own list again: not told again. Its changes go to it alone.
    void register(['add', 'reset'], 'frame-2', 'Counter notes', (t) => next.push(t));
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    ch.frame('turn', turnFrame('t-1', { used: { ...USED, steps: 1 } }));
    expect(next.map((t) => t.used.steps)).toEqual([0, 1]);
    expect(turns).toHaveLength(2);
    // Its plugin went: the dead frame hears nothing more.
    ch.frame('unregistered', { reason: 'plugin_off' });
    await settle();
    ch.frame('turn', turnFrame('t-1', { state: 'ended', end: { state: 'done', reason: 'end_turn' } }));
    expect(next).toHaveLength(2);
  });

  it("the frame's own page loaded again (a reload keeps the frame and its id) hears the running turns once more as it offers its tools again, its withdrawal still out", async () => {
    const turns = await heard();
    const ch = channel();
    ch.frame('turn', turnFrame('t-1'));
    expect(turns).toEqual([told('t-1')]);
    // The page goes (the bridge's close at the new page's hello): its list is withdrawn, and
    // that POST is held, so the channel stays.
    void publishWorkspaceTools(SCOPE, 'frame-1', null, invoke);
    await settle();
    const withdrawal = take('/api/assistant/relay/tools');
    expect(withdrawal.body.tools).toEqual([]);
    // The new page, under the same frame id: it hears the running turn at once, before its verdict.
    const again: AssistantTurn[] = [];
    const verdict = register(['add'], 'frame-1', 'Counter notes', (t) => again.push(t));
    await settle();
    expect(again).toEqual([told('t-1')]);
    expect(turns, 'the page that went hears nothing more').toHaveLength(1);
    withdrawal.answer(200, { ok: true, available: true, accepted: [], refused: [] });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    expect(await verdict).toMatchObject({ available: true });
    expect(channels).toHaveLength(1);
    // Told once: its own list again is not told again; changes go to it.
    void register(['add', 'reset'], 'frame-1', 'Counter notes', (t) => again.push(t));
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    ch.frame('turn', turnFrame('t-1', { used: { ...USED, steps: 1 } }));
    expect(again.map((t) => [t.state, t.used.steps])).toEqual([
      ['running', 0],
      ['running', 1],
    ]);
    expect(turns).toHaveLength(1);
  });

  it('while no link says which turns run (the channel went with nothing offered, then a new one before its `active`), a new page hears nothing; then only those that still run, never one that ended meanwhile', async () => {
    const turns = await heard();
    const first = channel();
    first.frame('turn', turnFrame('t-1'));
    first.frame('turn', turnFrame('t-2', { title: 'Second' }));
    // Back: the list is withdrawn, and with nothing offered the channel goes (the turns run on).
    void publishWorkspaceTools(SCOPE, 'frame-1', null, invoke);
    await settle();
    take('/api/assistant/relay/tools').answer(200, { ok: true, available: true, accepted: [], refused: [] });
    await settle();
    expect(first.closed).toBe(true);
    // t-1 ends while there is no channel. A workspace opens again: a new channel, no link yet.
    const next: AssistantTurn[] = [];
    const verdict = register(['add'], 'frame-2', 'Counter notes', (t) => next.push(t));
    await settle();
    const second = channel();
    expect(second).not.toBe(first);
    expect(next, 'no link: nothing is known of the turns').toEqual([]);
    second.frame('linked', { link: LINK_B });
    await settle();
    expect(next, 'a new link, before its `active`').toEqual([]);
    second.frame('active', { turns: 1, hold_until: null });
    await settle();
    expect(next, 'until the one it says runs came again').toEqual([]);
    second.frame('turn', turnFrame('t-2', { title: 'Second' }));
    await settle();
    expect(next).toEqual([told('t-2', { title: 'Second' })]);
    expect(turns, 'the page that went hears nothing more').toHaveLength(2);
    expect(await stopAnnouncedTurn('t-1')).toEqual({ stopped: false, reason: 'ended' });
    accept(take('/api/assistant/relay/tools'));
    await settle();
    expect(await verdict).toMatchObject({ available: true });
    // Its changes from then on go to it.
    second.frame('turn', turnFrame('t-2', { title: 'Second', state: 'ended', end: { state: 'done', reason: 'end_turn' } }));
    expect(next.map((t) => [t.id, t.state])).toEqual([
      ['t-2', 'running'],
      ['t-2', 'ended'],
    ]);
  });

  it("a frame's Stop goes to the turn's own Stop route only for a running turn told to this tab: stopped once that answers; `ended` for one it heard end, `not_this_tab` for any other", async () => {
    await heard();
    const ch = channel();
    ch.frame('turn', turnFrame('t-1'));
    ch.frame('turn', turnFrame('t-0', { state: 'ended', end: { state: 'done', reason: 'end_turn' } }));
    expect(await stopAnnouncedTurn('t-9')).toEqual({ stopped: false, reason: 'not_this_tab' });
    expect(await stopAnnouncedTurn('t-0')).toEqual({ stopped: false, reason: 'ended' });
    expect(sent.filter((s) => s.path.includes('/turns/'))).toEqual([]);
    const stopping = stopAnnouncedTurn('t-1');
    await settle();
    const post = take('/api/assistant/turns/t-1/stop');
    expect([post.method, post.body]).toEqual(['POST', {}]);
    let done = false;
    void stopping.then(() => (done = true));
    await settle(10_000);
    expect(done, 'it waits for the route, which answers once the turn ended').toBe(false);
    post.answer(200, { ok: true, turn: { id: 't-1', state: 'stopped' } });
    expect(await stopping).toEqual({ stopped: true });
    // No answer; a refusal keeps its code.
    const lost = stopAnnouncedTurn('t-1');
    await settle();
    take('/api/assistant/turns/t-1/stop').fail();
    expect(await lost).toEqual({ stopped: false, reason: 'not_connected' });
    const gone = stopAnnouncedTurn('t-1');
    await settle();
    take('/api/assistant/turns/t-1/stop').answer(404, { ok: false, code: 'unknown_turn', error: 'No such turn.' });
    expect(await gone).toEqual({ stopped: false, reason: 'unknown_turn' });
    // No relay: not connected.
    stopAssistantRelay();
    expect(await stopAnnouncedTurn('t-1')).toEqual({ stopped: false, reason: 'not_connected' });
  });

  it("a Stop that reaches a turn which ended another way first (its end still on its way here) answers `ended`; one still stopping after the route's 5 s is stopped", async () => {
    await heard();
    channel().frame('turn', turnFrame('t-1'));
    // The route answers 200 for any turn that ended: it read done, failed or capped, not stopped.
    for (const state of ['done', 'failed', 'capped']) {
      const asked = stopAnnouncedTurn('t-1');
      await settle();
      take('/api/assistant/turns/t-1/stop').answer(200, { ok: true, turn: { id: 't-1', state } });
      expect(await asked, state).toEqual({ stopped: false, reason: 'ended' });
    }
    // Still stopping when the route's 5 s ran out: it goes on to stopped.
    const slow = stopAnnouncedTurn('t-1');
    await settle();
    take('/api/assistant/turns/t-1/stop').answer(200, { ok: true, stopping: true, turn: { id: 't-1', state: 'running' } });
    expect(await slow).toEqual({ stopped: true });
    // An answer that says nothing of the turn: not stopped as far as this page can tell.
    const bare = stopAnnouncedTurn('t-1');
    await settle();
    take('/api/assistant/turns/t-1/stop').answer(200, { ok: true });
    expect(await bare).toEqual({ stopped: false, reason: 'ended' });
  });

  it('a new link: the running turns it knew of come again after `active`; one that does not ended while the link was down (told with no `end`); `active {turns: 0}` ends them all', async () => {
    const turns = await heard();
    const ch = channel();
    ch.frame('turn', turnFrame('t-1'));
    ch.frame('turn', turnFrame('t-2', { title: 'Second' }));
    turns.length = 0;
    ch.drop();
    ch.frame('linked', { link: LINK_B });
    ch.frame('active', { turns: 1, hold_until: null });
    expect(turns, 'until the one the server says runs came again').toEqual([]);
    ch.frame('turn', turnFrame('t-2', { title: 'Second' }));
    expect(turns).toEqual([told('t-2', { title: 'Second' }), told('t-1', { state: 'ended' })]);
    expect(Object.hasOwn(turns[1], 'end')).toBe(false);
    expect(await stopAnnouncedTurn('t-1')).toEqual({ stopped: false, reason: 'ended' });
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    // The next link: none run any more.
    turns.length = 0;
    ch.drop();
    ch.frame('linked', { link: LINK_C });
    ch.frame('active', { turns: 0, hold_until: null });
    expect(turns.map((t) => [t.id, t.state])).toEqual([['t-2', 'ended']]);
    await settle();
    accept(take('/api/assistant/relay/tools'));
    await settle();
    // A link with nothing known waits for nothing: a turn that starts later is just told.
    ch.frame('turn', turnFrame('t-4'));
    expect(turns.map((t) => [t.id, t.state])).toEqual([
      ['t-2', 'ended'],
      ['t-4', 'running'],
    ]);
  });
});
