import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventHubState, openChannel, resetEventHubForTests } from './eventHub';

class FakeEventSource {
  static made: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) || []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  hello(conn: string): void {
    this.readyState = 1;
    this.emit('hello', { conn });
  }
  frame(type: string, c: string, d: unknown): void {
    this.emit(type, { c, d });
  }
  drop(): void {
    this.readyState = 0;
    this.onerror?.();
  }
  close(): void {
    this.readyState = 2;
  }
}

type Sent = { path: string; body: { tab: string; conn: string; channels?: Array<{ cid: string; kind: string; params: Record<string, string> }>; cids?: string[] } };

let sent: Sent[] = [];
/** How the server answers a subscribe: by default every channel ok. */
let answer: (body: Sent['body']) => Response;

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const subscribes = () => sent.filter((s) => s.path === '/api/events/subscribe');
const open = () => FakeEventSource.made.filter((es) => es.readyState !== 2);

beforeEach(() => {
  resetEventHubForTests();
  FakeEventSource.made = [];
  sent = [];
  answer = (body) => new Response(JSON.stringify({ ok: true, results: (body.channels || []).map((c) => ({ cid: c.cid, ok: true })) }), { status: 200 });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Sent['body'];
      sent.push({ path, body });
      return path === '/api/events/subscribe' ? answer(body) : new Response('{"ok":true}', { status: 200 });
    }),
  );
});
afterEach(() => {
  resetEventHubForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('one event stream per tab', () => {
  it('six link, three job, one case and one mesh channel use one EventSource, asked for in one call after its hello', async () => {
    const urls = [
      ...Array.from({ length: 6 }, (_, i) => `/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-${i}`),
      ...Array.from({ length: 3 }, (_, i) => `/api/jobs/job-${i}/events?project_id=p1`),
      '/api/plugin-cases/events?project_id=p1&plugin=demo&study_id=st-9',
      '/api/jobs/job-mesh/events?project_id=p1',
    ];
    const handles = urls.map((u) => openChannel(u));
    await settle();
    expect(FakeEventSource.made).toHaveLength(1);
    expect(FakeEventSource.made[0].url).toBe(`/api/events?tab=${encodeURIComponent(eventHubState().tabId)}`);
    // Nothing is asked for before the stream says hello.
    expect(subscribes()).toHaveLength(0);
    FakeEventSource.made[0].hello('c1');
    await settle();
    expect(subscribes()).toHaveLength(1);
    const asked = subscribes()[0].body;
    expect(asked.conn).toBe('c1');
    expect(asked.channels!.map((c) => c.kind)).toEqual([...Array(6).fill('link'), 'job', 'job', 'job', 'case', 'job']);
    expect(asked.channels![0].params).toEqual({ project_id: 'p1', plugin: 'link-demo', study_id: 'st-0' });
    expect(asked.channels![6].params).toEqual({ project_id: 'p1', job_id: 'job-0' });
    expect(new Set(asked.channels!.map((c) => c.cid)).size).toBe(11);
    expect(handles.every((h) => h.readyState === h.OPEN)).toBe(true);
  });

  it('a frame reaches only its own channel, as the event its stream sent, with the same data', async () => {
    const a = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-a');
    const b = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-b');
    const gotA = vi.fn();
    const gotB = vi.fn();
    a.addEventListener('snapshot', gotA);
    b.addEventListener('snapshot', gotB);
    FakeEventSource.made[0].hello('c1');
    await settle();
    const [ca, cb] = subscribes()[0].body.channels!.map((c) => c.cid);
    FakeEventSource.made[0].frame('snapshot', ca, { jobs: [{ id: 'gl-1' }] });
    expect(gotA).toHaveBeenCalledTimes(1);
    expect(gotB).not.toHaveBeenCalled();
    expect(JSON.parse((gotA.mock.calls[0][0] as MessageEvent).data)).toEqual({ jobs: [{ id: 'gl-1' }] });
    expect((gotA.mock.calls[0][0] as MessageEvent).type).toBe('snapshot');
    FakeEventSource.made[0].frame('snapshot', cb, { jobs: [] });
    expect(gotB).toHaveBeenCalledTimes(1);
    expect(gotA).toHaveBeenCalledTimes(1);
  });

  it('a dropped stream: every channel is CONNECTING and gets error; the reconnect asks for them all again in one call', async () => {
    const a = openChannel('/api/jobs/job-1/events?project_id=p1');
    const b = openChannel('/api/plugin-cases/events?project_id=p1&plugin=demo&study_id=st-1');
    const errors = vi.fn();
    a.addEventListener('error', errors);
    b.onerror = errors;
    const es = FakeEventSource.made[0];
    es.hello('c1');
    await settle();
    expect([a.readyState, b.readyState]).toEqual([1, 1]);
    es.drop();
    expect([a.readyState, b.readyState]).toEqual([0, 0]);
    expect(errors).toHaveBeenCalledTimes(2);
    // The browser reconnects the same EventSource; its hello asks again.
    es.hello('c2');
    await settle();
    expect(subscribes()).toHaveLength(2);
    expect(subscribes()[1].body.conn).toBe('c2');
    expect(subscribes()[1].body.channels).toHaveLength(2);
    expect(FakeEventSource.made).toHaveLength(1);
    expect([a.readyState, b.readyState]).toEqual([1, 1]);
  });

  it('a refused channel is CLOSED and gets error; one the server ended is CLOSED with no error', async () => {
    answer = (body) =>
      new Response(
        JSON.stringify({
          ok: true,
          results: (body.channels || []).map((c, i) => (i === 0 ? { cid: c.cid, ok: false, status: 404, error: 'job not found' } : { cid: c.cid, ok: true })),
        }),
        { status: 200 },
      );
    const refused = openChannel('/api/jobs/job-gone/events?project_id=p1');
    const ended = openChannel('/api/jobs/job-done/events?project_id=p1');
    const refusedErr = vi.fn();
    const endedErr = vi.fn();
    const endEvent = vi.fn();
    refused.onerror = refusedErr;
    ended.addEventListener('error', endedErr);
    ended.addEventListener('end', endEvent);
    const es = FakeEventSource.made[0];
    es.hello('c1');
    await settle();
    expect(refused.readyState).toBe(refused.CLOSED);
    expect(refusedErr).toHaveBeenCalledTimes(1);
    const cid = subscribes()[0].body.channels![1].cid;
    es.frame('end', cid, { status: 'done' });
    es.frame('_closed', cid, undefined);
    expect(endEvent).toHaveBeenCalledTimes(1);
    expect(ended.readyState).toBe(ended.CLOSED);
    expect(endedErr).not.toHaveBeenCalled();
    // A later frame for it is dropped; a reconnect does not ask for either again.
    es.frame('end', cid, { status: 'done' });
    expect(endEvent).toHaveBeenCalledTimes(1);
  });

  it('a subscribe refused as stale is asked again after the next hello', async () => {
    let first = true;
    answer = (body) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ ok: false, stale: true }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, results: (body.channels || []).map((c) => ({ cid: c.cid, ok: true })) }), { status: 200 });
    };
    const h = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    const es = FakeEventSource.made[0];
    es.hello('c1');
    await settle();
    expect(subscribes()).toHaveLength(1);
    expect(h.readyState).toBe(h.CONNECTING);
    // A channel opened meanwhile waits for the hello too.
    const h2 = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-2');
    await settle();
    expect(subscribes()).toHaveLength(1);
    es.hello('c2');
    await settle();
    expect(subscribes()).toHaveLength(2);
    expect(subscribes()[1].body.conn).toBe('c2');
    expect(subscribes()[1].body.channels).toHaveLength(2);
    expect([h.readyState, h2.readyState]).toEqual([1, 1]);
  });

  it('closing a channel lets it go on the server; the stream closes 2 s after the last one, so nothing is held', async () => {
    vi.useFakeTimers();
    const a = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    const b = openChannel('/api/jobs/job-1/events?project_id=p1');
    const es = FakeEventSource.made[0];
    es.hello('c1');
    await settle();
    const cids = subscribes()[0].body.channels!.map((c) => c.cid);
    a.close();
    await settle();
    expect(sent.filter((s) => s.path === '/api/events/unsubscribe').map((s) => s.body.cids)).toEqual([[cids[0]]]);
    b.close();
    await settle();
    expect(es.readyState).not.toBe(2);
    vi.advanceTimersByTime(2100);
    expect(es.readyState).toBe(2);
    expect(eventHubState().open).toBe(false);
    // A new channel opens a new stream.
    openChannel('/api/jobs/job-2/events?project_id=p1');
    expect(open()).toHaveLength(1);
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it('only the app\'s own stream URLs become channels', () => {
    expect(() => openChannel('/api/elsewhere/events')).toThrow(/no event channel/);
    expect(() => openChannel('/api/assistant/turns?role=relay')).toThrow(/no event channel/);
  });

  it("the assistant relay's channel name is kind assistant with params {role: 'relay'}, on the tab's one stream", async () => {
    const link = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    const relay = openChannel('/api/assistant/events?role=relay');
    const linked = vi.fn();
    relay.addEventListener('linked', linked);
    FakeEventSource.made[0].hello('c1');
    await settle();
    expect(FakeEventSource.made).toHaveLength(1);
    expect(subscribes()).toHaveLength(1);
    const asked = subscribes()[0].body.channels!;
    expect(asked.map((c) => c.kind)).toEqual(['link', 'assistant']);
    expect(asked[1].params).toEqual({ role: 'relay' });
    // The server's channel ids are [a-z]{1,16}:[0-9]{1,12} (scripts/server/event-hub.ts).
    expect(asked[1].cid).toMatch(/^assistant:[0-9]{1,12}$/);
    expect([link.readyState, relay.readyState]).toEqual([1, 1]);
    FakeEventSource.made[0].frame('linked', asked[1].cid, { link: 'abc' });
    expect(linked).toHaveBeenCalledTimes(1);
    expect(JSON.parse((linked.mock.calls[0][0] as MessageEvent).data)).toEqual({ link: 'abc' });
  });

  it('ready() says when the server has a channel: true once its subscribe is answered, false when it is refused or closed', async () => {
    answer = (body) =>
      new Response(
        JSON.stringify({
          ok: true,
          results: (body.channels || []).map((c, i) => (i === 1 ? { cid: c.cid, ok: false, status: 403, error: 'not this project' } : { cid: c.cid, ok: true })),
        }),
        { status: 200 },
      );
    const link = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    const refused = openChannel('/api/jobs/job-other/events?project_id=p1');
    const closed = openChannel('/api/plugin-cases/events?project_id=p1&plugin=demo&study_id=st-1');
    const said: string[] = [];
    void link.ready().then((ok) => said.push(`link ${ok}`));
    void refused.ready().then((ok) => said.push(`refused ${ok}`));
    void closed.ready().then((ok) => said.push(`closed ${ok}`));
    closed.close();
    await settle();
    // Nothing is on the server before the stream says hello.
    expect(said).toEqual(['closed false']);
    FakeEventSource.made[0].hello('c1');
    await settle();
    expect(said).toEqual(['closed false', 'link true', 'refused false']);
    // Asked again once it is on the server: at once.
    expect(await link.ready()).toBe(true);
  });
});

describe('a tab in the background', () => {
  let state: 'visible' | 'hidden' = 'visible';
  const setVisibility = (next: 'visible' | 'hidden') => {
    state = next;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  beforeEach(() => {
    state = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it('lets its stream go 3 s after it is hidden (its channels wait, no error); shown again, one call asks for them all and the window hears cfd:events-resumed', async () => {
    const a = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    const b = openChannel('/api/plugin-cases/events?project_id=p1&plugin=demo&study_id=st-1');
    const errors = vi.fn();
    a.onerror = errors;
    b.addEventListener('error', errors);
    const resumed = vi.fn();
    window.addEventListener('cfd:events-resumed', resumed);
    try {
      FakeEventSource.made[0].hello('c1');
      await settle();
      setVisibility('hidden');
      vi.advanceTimersByTime(2900);
      expect(FakeEventSource.made[0].readyState).not.toBe(2);
      vi.advanceTimersByTime(200);
      expect(FakeEventSource.made[0].readyState).toBe(2);
      expect(eventHubState().open).toBe(false);
      expect([a.readyState, b.readyState]).toEqual([0, 0]);
      expect(errors).not.toHaveBeenCalled();
      // Shown again: a new stream, and once it says hello, one call for both channels.
      setVisibility('visible');
      expect(FakeEventSource.made).toHaveLength(2);
      FakeEventSource.made[1].hello('c2');
      await settle();
      expect(subscribes()).toHaveLength(2);
      expect(subscribes()[1].body.channels).toHaveLength(2);
      expect(resumed).toHaveBeenCalledTimes(1);
      expect([a.readyState, b.readyState]).toEqual([1, 1]);
    } finally {
      window.removeEventListener('cfd:events-resumed', resumed);
    }
  });

  it('shown again within 3 s: the stream stays and nothing is asked again; hidden for 3 s after that, it goes', async () => {
    openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    FakeEventSource.made[0].hello('c1');
    await settle();
    setVisibility('hidden');
    vi.advanceTimersByTime(2000);
    setVisibility('visible');
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.made).toHaveLength(1);
    expect(FakeEventSource.made[0].readyState).not.toBe(2);
    expect(subscribes()).toHaveLength(1);
    // The grace starts again from the next hide.
    setVisibility('hidden');
    vi.advanceTimersByTime(2900);
    expect(FakeEventSource.made[0].readyState).not.toBe(2);
    vi.advanceTimersByTime(200);
    expect(FakeEventSource.made[0].readyState).toBe(2);
  });

  it("keeps its stream while a channel is pinned (a job's from the start, a link a page waits for); lets it go once none is", async () => {
    const job = openChannel('/api/jobs/job-1/events?project_id=p1');
    const link = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
    FakeEventSource.made[0].hello('c1');
    await settle();
    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.made[0].readyState).not.toBe(2);
    job.close();
    link.pin(true);
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.made[0].readyState).not.toBe(2);
    link.pin(false);
    vi.advanceTimersByTime(3100);
    expect(FakeEventSource.made[0].readyState).toBe(2);
    // A job followed while the tab is hidden opens the stream at once.
    openChannel('/api/jobs/job-2/events?project_id=p1');
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it("does not keep its stream for the assistant's channel unless that is pinned", async () => {
    const relay = openChannel('/api/assistant/events?role=relay');
    FakeEventSource.made[0].hello('c1');
    await settle();
    setVisibility('hidden');
    vi.advanceTimersByTime(3100);
    expect(FakeEventSource.made[0].readyState).toBe(2);
    expect(relay.readyState).toBe(relay.CONNECTING);
    // Pinned (the server says a turn uses this tab), a hidden tab keeps the stream.
    setVisibility('visible');
    FakeEventSource.made[1].hello('c2');
    await settle();
    relay.pin(true);
    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.made[1].readyState).not.toBe(2);
    relay.pin(false);
    vi.advanceTimersByTime(3100);
    expect(FakeEventSource.made[1].readyState).toBe(2);
  });

  it('a tab that starts hidden opens its stream only once it is shown, then hears cfd:events-resumed', async () => {
    state = 'hidden';
    const resumed = vi.fn();
    window.addEventListener('cfd:events-resumed', resumed);
    try {
      const h = openChannel('/api/plugin-geometry/events?project_id=p1&plugin=link-demo&study_id=st-1');
      vi.advanceTimersByTime(10_000);
      await settle();
      expect(FakeEventSource.made).toHaveLength(0);
      expect(h.readyState).toBe(0);
      setVisibility('visible');
      expect(FakeEventSource.made).toHaveLength(1);
      FakeEventSource.made[0].hello('c1');
      await settle();
      expect(subscribes()).toHaveLength(1);
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(h.readyState).toBe(1);
    } finally {
      window.removeEventListener('cfd:events-resumed', resumed);
    }
  });
});
