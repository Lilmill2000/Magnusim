// The page relay (Foundation spec 8.4 and 6.4): a fake hub channel, a fetch whose answers each
// test hands out, the real workspace tools store and the app's real confirm dialog, on fake
// timers. Every race here is forced: a held answer, a released one, a timer moved on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishWorkspaceTools,
  resetWorkspaceToolsForTests,
  workspaceToolsSnapshot,
  type ToolInvoke,
  type WorkspaceToolsScope,
} from '../workspace/assistantTools';
import type { AssistantCallOutcome, AssistantInvoke, CheckedTool } from '../workspace/bridge';
import type { AssistantRegistration } from '../plugin-sdk/workspace';
import { confirmAction, dialogBusy } from '../workbench/dialogs';
import { exitFrameFullscreen } from '../workspace/leaveGuard';
import {
  GATE_RESHOWN_MS,
  NOT_YET_RETRY_MS,
  PROGRESS_INTERVAL_MS,
  RELAY_CHANNEL_URL,
  RESULT_BEFORE_UNREGISTER_MS,
  startAssistantRelay,
  stopAssistantRelay,
} from './relay';
import { resetStatusStore } from './status';
import type { GateView } from './wire';

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
  if (s.path === '/api/assistant/relay/progress' || s.path.startsWith('/api/assistant/gates/')) return [200, { ok: true }];
  return null;
}

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
function register(names: string[], frameId = 'frame-1', guide = 'Counter notes'): Promise<AssistantRegistration> {
  const pub = publishWorkspaceTools(SCOPE, frameId, { tools: names.map(tool), guide }, invoke);
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

  it('after a restart, plugin_off for a frame the server took before is tried again until its plugins are read', async () => {
    await registered();
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    // The new server has not read its plugins yet: the old boot's token counts as fresh there.
    const again = take('/api/assistant/relay/tools');
    expect(again.body).toMatchObject({ link: LINK_B, epoch: 'boot-1:3', tools: [tool('add')] });
    again.answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    await settle();
    expect(workspaceToolsSnapshot().current).toMatchObject({ dead: false });
    await settle(NOT_YET_RETRY_MS[0] - 1);
    expect(toolPosts()).toHaveLength(2);
    await settle(1);
    expect(toolPosts()).toHaveLength(3);
    expect(lastTools().body).toMatchObject({ link: LINK_B, epoch: 'boot-1:3', tools: [tool('add')] });
    lastTools().answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    await settle(NOT_YET_RETRY_MS[1]);
    expect(toolPosts()).toHaveLength(4);
    accept(lastTools(), 'boot-2:3');
    await settle(10 * 60_000);
    expect(toolPosts()).toHaveLength(4);
    // The frame registers again: not refused here, and it carries the new boot's token.
    const later = register(['add', 'reset']);
    await settle();
    expect(lastTools().body).toMatchObject({ link: LINK_B, epoch: 'boot-2:3', tools: [tool('add'), tool('reset')] });
    accept(lastTools(), 'boot-2:3');
    expect(await later).toMatchObject({ available: true, accepted: ['add', 'reset'] });
  });

  it('a plugin still off after a restart: tried for a while, then the frame is dead; a fresh frame is dead at once', async () => {
    await registered();
    channel().drop();
    channel().frame('linked', { link: LINK_B });
    await settle();
    for (const wait of NOT_YET_RETRY_MS) {
      take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
      await settle(wait);
    }
    expect(toolPosts()).toHaveLength(2 + NOT_YET_RETRY_MS.length);
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    await settle(10 * 60_000);
    expect(toolPosts()).toHaveLength(2 + NOT_YET_RETRY_MS.length);
    expect(workspaceToolsSnapshot().current).toMatchObject({ dead: true });
    expect(await register(['add'])).toMatchObject({ available: false, reason: 'plugin_off' });
    // A frame the server never took has no token: its plugin_off is the plugin's state, dead at once.
    const fresh = register(['add'], 'frame-2');
    await settle();
    // Nothing of the page was left on the server: the channel went, a new one opens for it.
    channel().frame('linked', { link: LINK_C });
    await settle();
    expect(lastTools().body).not.toHaveProperty('epoch');
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'plugin_off', error: 'not turned on' });
    expect(await fresh).toMatchObject({ available: false, reason: 'plugin_off' });
    await settle(10 * 60_000);
    expect(toolPosts()).toHaveLength(3 + NOT_YET_RETRY_MS.length);
  });

  it('a 409 not_ready (the server has not read its plugins yet) is tried again, for a fresh frame too', async () => {
    startAssistantRelay();
    const verdict = register(['add']);
    await settle();
    channel().frame('linked', { link: LINK_A });
    await settle();
    take('/api/assistant/relay/tools').answer(409, { ok: false, code: 'not_ready', error: 'starting' });
    await settle(NOT_YET_RETRY_MS[0]);
    expect(toolPosts()).toHaveLength(2);
    accept(take('/api/assistant/relay/tools'));
    expect(await verdict).toMatchObject({ available: true, accepted: ['add'] });
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

  it('every kind is shown safe, out of full screen first, with its detail rows; Allow is a click', async () => {
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
      signal: expect.any(AbortSignal),
    });
    expect($('modal-confirm').hidden).toBe(false);
    expect(document.activeElement).toBe($('cf-cancel'));
    expect(channel().pinned).toBe(true);
    $('cf-confirm').click();
    await settle();
    expect(last('/api/assistant/gates/g-1').body).toEqual({ allow: true });
    channel().frame('gate', { gate: gate({ id: 'g-2', kind: 'privacy', risk: undefined, title: 'Send project "Wing" to the cloud provider?', yes: 'Send', no: "Don't send" }) });
    await settle(10);
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(vi.mocked(confirmAction).mock.lastCall?.[0]).toMatchObject({ title: 'Send project "Wing" to the cloud provider?', yes: 'Send', no: "Don't send", safe: true });
    $('cf-cancel').click();
    await settle();
    expect(last('/api/assistant/gates/g-2').body).toEqual({ allow: false });
  });

  it('Enter right after a gate frame answers No (allow:false)', async () => {
    await registered();
    channel().frame('gate', { gate: gate({}) });
    await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    const answer = last('/api/assistant/gates/g-1');
    expect(answer.method).toBe('POST');
    expect(answer.body).toEqual({ allow: false });
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
    expect(sent.filter((s) => s.path.startsWith('/api/assistant/gates/'))).toHaveLength(0);
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
    expect(sent.filter((s) => s.path.startsWith('/api/assistant/gates/'))).toHaveLength(0);
    expect(ch.pinned).toBe(true);
    $('cf-cancel').click();
    await settle();
    expect(sent.filter((s) => s.path.startsWith('/api/assistant/gates/')).map((s) => [s.path, s.body])).toEqual([['/api/assistant/gates/g-2', { allow: false }]]);
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
    expect(sent.filter((s) => s.path.startsWith('/api/assistant/gates/'))).toHaveLength(0);
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
