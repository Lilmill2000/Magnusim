/**
 * One event stream per tab, for every stream the app follows.
 *
 * The app is served over plain HTTP/1.1, where the browser opens at most 6 connections to
 * it for all of its tabs together, and an event stream holds its connection while it is
 * open. One EventSource per linked geometry, per followed job and per plugin case stream
 * filled those 6 (two tabs on a project with three linked geometries did): every other
 * request of every tab waited, and the app froze without a word. So the tab opens one
 * stream (/api/events, scripts/server/event-hub.ts) and each of those streams is a channel
 * on it: `openChannel(url)` takes the URL the stream had and answers a handle shaped like
 * an EventSource (readyState, addEventListener, onmessage/onerror/onopen, close), whose
 * events are the ones that stream sent, with the same data. The assistant's channel
 * (`/api/assistant/events?role=relay`) never was a stream: that URL is only its name, and it
 * is not pinned unless its caller pins it. Nor is the open project's `ui` channel
 * (`/api/ui/events?project_id=…`, what the Assistant changed there; workbench/uiSync.ts).
 *
 * - The stream opens with the first channel and closes 2 s after the last one goes, so
 *   Home and a project with nothing to follow hold no connection.
 * - Each `hello` (the first, and every reconnect) asks for every channel again, in one
 *   call; their snapshots catch them up, as a reconnecting EventSource's did.
 * - A refused channel is CLOSED and gets `error`, and its `refusal` says the server's status
 *   and words; one the server ended (`_closed`, a job that ended) is CLOSED with no error. A dropped stream: every channel is CONNECTING
 *   and gets `error`, as an EventSource's reconnect does.
 * - `ready()` says when the server has a channel (its subscribe answered, or a first frame
 *   came): a caller whose request starts what the channel reports waits for it first.
 * - A hidden tab lets its stream go after 3 s unless a channel is pinned (a job's are, and
 *   a workspace pins its link while it waits for one): its channels stay, CONNECTING. Shown
 *   again, it opens the stream, and once its channels are asked for again the window hears
 *   `cfd:events-resumed` (what happened meanwhile is read again by those who need it). A
 *   tab that starts hidden opens its stream when it is first shown.
 *
 * The tab's id is new for each page load (never in sessionStorage: a duplicated tab copies
 * it). The census test (eventHub.census.test.ts) keeps `new EventSource(` to this file.
 */

type Listener = (ev: Event) => void;
type Kind = 'link' | 'job' | 'case' | 'assistant' | 'ui';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
/** The stream closes this long after its last channel goes. */
const IDLE_CLOSE_MS = 2000;
/** A hidden tab keeps its stream this long. */
const HIDDEN_GRACE_MS = 3000;
/** After a refusal as stale, a new hello is waited for this long, then the stream opens again. */
const STALE_REOPEN_MS = 3000;
/** A stream the browser gave up on opens again after this long. */
const REOPEN_MS = 2000;

/** What a stream of the app looked like to its callers: an EventSource's shape, and a pin. */
export interface ChannelHandle {
  readonly url: string;
  readonly readyState: number;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSED: 2;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void;
  removeEventListener(type: string, fn: (ev: MessageEvent) => void): void;
  close(): void;
  /** Keep the stream while the tab is hidden (true for a job's channel from the start). */
  pin(on: boolean): void;
  /** True once the server has this channel (OPEN), false once it is closed or refused. */
  ready(): Promise<boolean>;
  /** Why the server refused it (its subscribe answer's status and error); null until it is refused. */
  readonly refusal?: { status: number; error: string } | null;
}

interface HubState {
  tabId: string;
  es: EventSource | null;
  /** The stream's id from its last hello ('' until then, and once it is stale). */
  conn: string;
  channels: Map<string, Channel>;
  counter: number;
  toSubscribe: Set<Channel>;
  toUnsubscribe: Set<string>;
  flushQueued: boolean;
  /** Frame types a channel listens for (registered on each stream). */
  types: Set<string>;
  esTypes: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  hiddenTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  reopenTimer: ReturnType<typeof setTimeout> | null;
  /** The stream was let go (or not opened) because the tab was hidden. */
  heldBack: boolean;
  /** Say `cfd:events-resumed` once the channels are asked for again. */
  resumePending: boolean;
  visibilityWired: boolean;
}

const KEY = Symbol.for('magnusim.eventHub.client');

function newTabId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Not a secure context (the app opened by a LAN address over http): random bytes still.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function freshState(): HubState {
  return {
    tabId: newTabId(),
    es: null,
    conn: '',
    channels: new Map(),
    counter: 0,
    toSubscribe: new Set(),
    toUnsubscribe: new Set(),
    flushQueued: false,
    types: new Set(['message']),
    esTypes: new Set(),
    idleTimer: null,
    hiddenTimer: null,
    staleTimer: null,
    reopenTimer: null,
    heldBack: false,
    resumePending: false,
    visibilityWired: false,
  };
}

function hub(): HubState {
  const g = globalThis as unknown as Record<symbol, HubState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = freshState();
    g[KEY] = s;
  }
  if (!s.visibilityWired && typeof document !== 'undefined') {
    s.visibilityWired = true;
    document.addEventListener('visibilitychange', () => syncStream());
  }
  return s;
}

class Channel implements ChannelHandle {
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  readyState = CONNECTING;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  pinned: boolean;
  refusal: { status: number; error: string } | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readyWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    readonly url: string,
    readonly cid: string,
    readonly kind: Kind,
    readonly params: Record<string, string>,
  ) {
    this.pinned = kind === 'job';
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as Listener);
    wantType(type);
  }

  removeEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn as Listener);
  }

  fire(ev: Event): void {
    for (const fn of [...(this.listeners.get(ev.type) || [])]) {
      try {
        fn(ev);
      } catch (e) {
        console.warn('[CFD] event listener', e);
      }
    }
    const own = ev.type === 'message' ? this.onmessage : ev.type === 'error' ? this.onerror : ev.type === 'open' ? this.onopen : null;
    if (own) {
      try {
        (own as Listener)(ev);
      } catch (e) {
        console.warn('[CFD] event listener', e);
      }
    }
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.settleReady(false);
    dropChannel(this, true);
  }

  pin(on: boolean): void {
    if (this.pinned === !!on) return;
    this.pinned = !!on;
    syncStream();
  }

  ready(): Promise<boolean> {
    if (this.readyState === OPEN) return Promise.resolve(true);
    if (this.readyState === CLOSED) return Promise.resolve(false);
    return new Promise((done) => this.readyWaiters.push(done));
  }

  /** Answer the ready() calls waiting: the channel is on the server (true), or closed (false). */
  settleReady(ok: boolean): void {
    const waiting = this.readyWaiters;
    this.readyWaiters = [];
    for (const done of waiting) done(ok);
  }
}

/** The channel a stream URL of the app stands for: its kind and its query. */
function channelOf(url: string): { kind: Kind; params: Record<string, string> } {
  const u = new URL(url, 'http://app.invalid');
  const params: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  if (u.pathname === '/api/plugin-geometry/events') return { kind: 'link', params };
  if (u.pathname === '/api/plugin-cases/events') return { kind: 'case', params };
  // A channel name only (no such route): `?role=relay` is the page's assistant relay.
  if (u.pathname === '/api/assistant/events') return { kind: 'assistant', params };
  // A channel name only (no such route): what the Assistant changed in a project (workbench/uiSync.ts).
  if (u.pathname === '/api/ui/events') return { kind: 'ui', params };
  const job = /^\/api\/jobs\/([^/]+)\/events$/.exec(u.pathname);
  if (job) return { kind: 'job', params: { ...params, job_id: decodeURIComponent(job[1]) } };
  throw new Error(`no event channel for ${url}`);
}

/**
 * A channel on the tab's stream for what `url` streamed (a link, job or plugin case stream
 * of the app, or the assistant's channel name), shaped like the EventSource that url had.
 */
export function openChannel(url: string): ChannelHandle {
  const s = hub();
  const spec = channelOf(url);
  s.counter += 1;
  const ch = new Channel(url, `${spec.kind}:${s.counter}`, spec.kind, spec.params);
  s.channels.set(ch.cid, ch);
  s.toSubscribe.add(ch);
  syncStream();
  queueFlush();
  return ch;
}

function dropChannel(ch: Channel, unsubscribe: boolean): void {
  const s = hub();
  if (s.channels.get(ch.cid) !== ch) return;
  s.channels.delete(ch.cid);
  if (s.toSubscribe.has(ch)) s.toSubscribe.delete(ch);
  else if (unsubscribe && s.conn) {
    s.toUnsubscribe.add(ch.cid);
    queueFlush();
  }
  syncStream();
}

function wantType(type: string): void {
  const s = hub();
  if (type === 'error' || type === 'open' || type === 'hello' || type === '_closed') return;
  s.types.add(type);
  if (s.es) listenFor(s.es, type);
}

function listenFor(es: EventSource, type: string): void {
  const s = hub();
  if (s.es !== es || s.esTypes.has(type)) return;
  s.esTypes.add(type);
  es.addEventListener(type, (e) => onFrame(es, type, e as MessageEvent));
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function anyPinned(): boolean {
  for (const ch of hub().channels.values()) if (ch.pinned) return true;
  return false;
}

function clearTimer(name: 'idleTimer' | 'hiddenTimer' | 'staleTimer' | 'reopenTimer'): void {
  const s = hub();
  const t = s[name];
  if (t) clearTimeout(t);
  s[name] = null;
}

/** Open, keep or let go of the stream, for the channels there are and whether the tab is shown. */
function syncStream(): void {
  const s = hub();
  if (!s.channels.size) {
    clearTimer('hiddenTimer');
    if (s.es && !s.idleTimer) {
      s.idleTimer = setTimeout(() => {
        s.idleTimer = null;
        if (!hub().channels.size) closeStream();
      }, IDLE_CLOSE_MS);
    }
    return;
  }
  clearTimer('idleTimer');
  if (!hidden() || anyPinned()) {
    clearTimer('hiddenTimer');
    if (!s.es && !s.reopenTimer) openStream();
    return;
  }
  if (!s.es) {
    s.heldBack = true;
    return;
  }
  if (!s.hiddenTimer) {
    s.hiddenTimer = setTimeout(() => {
      s.hiddenTimer = null;
      if (hidden() && !anyPinned() && hub().es) release();
    }, HIDDEN_GRACE_MS);
  }
}

/** The tab is hidden: the stream goes, its channels wait (no error). */
function release(): void {
  const s = hub();
  closeStream();
  s.heldBack = true;
  for (const ch of s.channels.values()) if (ch.readyState === OPEN) ch.readyState = CONNECTING;
}

function closeStream(): void {
  const s = hub();
  if (s.es) s.es.close();
  s.es = null;
  s.conn = '';
  s.esTypes.clear();
  clearTimer('staleTimer');
  clearTimer('reopenTimer');
  // The server forgets a stream's channels when it closes: the next hello asks for them all.
  s.toUnsubscribe.clear();
}

function openStream(): void {
  const s = hub();
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource(`/api/events?tab=${encodeURIComponent(s.tabId)}`);
  s.es = es;
  s.conn = '';
  s.esTypes.clear();
  es.addEventListener('hello', (e) => onHello(es, e as MessageEvent));
  es.addEventListener('_closed', (e) => onClosed(es, e as MessageEvent));
  for (const type of s.types) listenFor(es, type);
  es.onerror = () => onStreamError(es);
}

function onHello(es: EventSource, e: MessageEvent): void {
  const s = hub();
  if (s.es !== es) return;
  let conn = '';
  try {
    conn = String((JSON.parse(String(e.data)) as { conn?: unknown }).conn || '');
  } catch {
    conn = '';
  }
  if (!conn) return;
  s.conn = conn;
  clearTimer('staleTimer');
  s.toUnsubscribe.clear();
  for (const ch of s.channels.values()) if (ch.readyState !== CLOSED) s.toSubscribe.add(ch);
  if (s.heldBack) {
    s.heldBack = false;
    s.resumePending = true;
  }
  queueFlush();
}

function parseFrame(e: MessageEvent): { c: string; d: unknown } | null {
  try {
    const m = JSON.parse(String(e.data)) as { c?: unknown; d?: unknown };
    return typeof m.c === 'string' ? { c: m.c, d: m.d } : null;
  } catch {
    return null;
  }
}

function onFrame(es: EventSource, type: string, e: MessageEvent): void {
  const s = hub();
  if (s.es !== es) return;
  const frame = parseFrame(e);
  const ch = frame ? s.channels.get(frame.c) : undefined;
  if (!frame || !ch || ch.readyState === CLOSED) return;
  opened(ch);
  ch.fire(new MessageEvent(type, { data: JSON.stringify(frame.d === undefined ? null : frame.d) }));
}

/** The server ended a channel (a job that ended): closed, no error. */
function onClosed(es: EventSource, e: MessageEvent): void {
  const s = hub();
  if (s.es !== es) return;
  const frame = parseFrame(e);
  const ch = frame ? s.channels.get(frame.c) : undefined;
  if (!ch) return;
  ch.readyState = CLOSED;
  ch.settleReady(false);
  dropChannel(ch, false);
}

function onStreamError(es: EventSource): void {
  const s = hub();
  if (s.es !== es) return;
  s.conn = '';
  if (es.readyState === CLOSED) {
    // The browser gave up on it (an answer that was not a stream): open it again later.
    s.es = null;
    s.esTypes.clear();
    clearTimer('reopenTimer');
    s.reopenTimer = setTimeout(() => {
      s.reopenTimer = null;
      syncStream();
    }, REOPEN_MS);
  }
  for (const ch of [...s.channels.values()]) {
    if (ch.readyState === CLOSED) continue;
    ch.readyState = CONNECTING;
    ch.fire(new Event('error'));
  }
}

function opened(ch: Channel): void {
  if (ch.readyState !== CONNECTING) return;
  ch.readyState = OPEN;
  ch.settleReady(true);
  ch.fire(new Event('open'));
}

/** Refused by the server: closed, with an error (an EventSource refused its URL did the same). */
function refuse(ch: Channel, status: number, error: string): void {
  if (ch.readyState === CLOSED) return;
  ch.readyState = CLOSED;
  ch.refusal = { status, error };
  ch.settleReady(false);
  dropChannel(ch, false);
  ch.fire(new Event('error'));
}

function queueFlush(): void {
  const s = hub();
  if (s.flushQueued) return;
  s.flushQueued = true;
  queueMicrotask(() => {
    hub().flushQueued = false;
    flush();
  });
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
}

/** Send the unsubscribes and subscribes waiting, once the stream has said hello. */
function flush(): void {
  const s = hub();
  if (!s.conn) return;
  const conn = s.conn;
  if (s.toUnsubscribe.size) {
    const cids = [...s.toUnsubscribe];
    s.toUnsubscribe.clear();
    void post('/api/events/unsubscribe', { tab: s.tabId, conn, cids }).catch(() => undefined);
  }
  const list = [...s.toSubscribe].filter((ch) => ch.readyState !== CLOSED && s.channels.get(ch.cid) === ch);
  s.toSubscribe.clear();
  const resumed = s.resumePending;
  s.resumePending = false;
  if (list.length) void subscribe(conn, list, resumed);
  else if (resumed) announceResumed();
}

type SubscribeAnswer = { results?: Array<{ cid?: string; ok?: boolean; status?: unknown; error?: unknown }> };

async function subscribe(conn: string, list: Channel[], resumed: boolean): Promise<void> {
  const s = hub();
  let r: Response;
  try {
    r = await post('/api/events/subscribe', {
      tab: s.tabId,
      conn,
      channels: list.map((ch) => ({ cid: ch.cid, kind: ch.kind, params: ch.params })),
    });
  } catch {
    // Not sent (the connection dropped): again in a moment on the same stream; a new
    // stream's hello asks for them anyway.
    setTimeout(() => {
      if (hub().conn !== conn) return;
      for (const ch of list) if (ch.readyState !== CLOSED && hub().channels.get(ch.cid) === ch) hub().toSubscribe.add(ch);
      if (resumed) hub().resumePending = true;
      queueFlush();
    }, 1000);
    return;
  }
  if (r.status === 409) {
    // Not this stream's any more: the next hello asks for every channel again.
    if (resumed) s.resumePending = true;
    if (s.conn === conn) {
      s.conn = '';
      clearTimer('staleTimer');
      s.staleTimer = setTimeout(() => {
        s.staleTimer = null;
        if (hub().conn || !hub().es) return;
        closeStream();
        syncStream();
      }, STALE_REOPEN_MS);
    }
    return;
  }
  let body: SubscribeAnswer | null = null;
  try {
    body = (await r.json()) as SubscribeAnswer;
  } catch {
    body = null;
  }
  if (s.conn !== conn) {
    // The stream went meanwhile (hidden, or dropped): the next hello asks for them again.
    if (resumed) s.resumePending = true;
    return;
  }
  const answered = new Map<string, { ok: boolean; status: number; error: string }>();
  for (const res of (body && body.results) || []) {
    if (!res || typeof res.cid !== 'string') continue;
    const status = typeof res.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
    answered.set(res.cid, { ok: !!res.ok, status, error: typeof res.error === 'string' ? res.error : '' });
  }
  const late: string[] = [];
  for (const ch of list) {
    const said = answered.get(ch.cid);
    const ok = r.ok && said?.ok === true;
    if (s.channels.get(ch.cid) !== ch) {
      // Closed while it was asked for: the server has it now, so it is let go there too.
      if (ok) late.push(ch.cid);
      continue;
    }
    if (ok) opened(ch);
    // A subscribe refused as a whole (no results) gives each channel its own status.
    else refuse(ch, said && said.status ? said.status : r.ok ? 0 : r.status, said?.error ?? '');
  }
  if (late.length) {
    for (const cid of late) s.toUnsubscribe.add(cid);
    queueFlush();
  }
  if (resumed) announceResumed();
}

function announceResumed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cfd:events-resumed'));
}

/** Tests: a new tab id, no stream, no channels. */
export function resetEventHubForTests(): void {
  const g = globalThis as unknown as Record<symbol, HubState | undefined>;
  const s = g[KEY];
  if (s) {
    for (const name of ['idleTimer', 'hiddenTimer', 'staleTimer', 'reopenTimer'] as const) {
      const t = s[name];
      if (t) clearTimeout(t);
    }
    if (s.es) s.es.close();
    g[KEY] = { ...freshState(), visibilityWired: s.visibilityWired };
  }
}

/** Tests and diagnostics: the tab's id, whether its stream is open, and its channels. */
export function eventHubState(): { tabId: string; open: boolean; conn: string; channels: number } {
  const s = hub();
  return { tabId: s.tabId, open: !!s.es, conn: s.conn, channels: s.channels.size };
}
