// Following a turn (phase 4 spec 5.1-5.3): a fake hub channel per openChannel, a fetch whose
// answers each test hands out, on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlimTurnSummary, TurnEvent, TurnSummary } from '../wire';
import {
  END_GRACE_MS,
  FAILS_BEFORE_POLL,
  followState,
  followTurn,
  MAX_TURN_CHANNELS,
  POLL_BACKGROUND_MS,
  POLL_RETRY_MS,
  POLL_WAIT_MS,
  resetFollowForTests,
  RETRY_MS,
  setShownTurn,
  turnChannelUrl,
  type FollowSink,
} from './follow';

const hoisted = vi.hoisted(() => {
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
    refusal: { status: number; error: string } | null = null;
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
      this.closed = true;
      this.readyState = 2;
    }
    pin(on: boolean): void {
      this.pinned = on;
    }
    ready(): Promise<boolean> {
      return Promise.resolve(this.readyState === 1);
    }
    frame(type: string, data: unknown): void {
      if (this.closed) return;
      this.readyState = 1;
      for (const fn of [...(this.listeners.get(type) || [])]) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    /** The tab's stream dropped: CONNECTING, with an error. */
    drop(): void {
      this.readyState = 0;
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
    /** The server refused it. */
    refuse(status: number): void {
      this.readyState = 2;
      this.refusal = { status, error: `refused ${status}` };
      for (const fn of [...(this.listeners.get('error') || [])]) fn(new Event('error') as MessageEvent);
    }
  }
  const channels: FakeChannel[] = [];
  return { channels, FakeChannel };
});
const { channels } = hoisted;

vi.mock('../../api/eventHub', () => ({
  openChannel: vi.fn((url: string) => {
    const ch = new hoisted.FakeChannel(url);
    hoisted.channels.push(ch);
    return ch;
  }),
}));

/** A GET the page sent; `answer` hands its answer back. */
interface Sent {
  url: string;
  aborted: boolean;
  answer(status: number, body: unknown): void;
}
let sent: Sent[] = [];
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const ev = (seq: number, body: Record<string, unknown>): TurnEvent => ({ seq, at: seq, ...body }) as TurnEvent;
const summary = (id: string, state: TurnSummary['state'], extra: Partial<TurnSummary> = {}): TurnSummary => ({
  id,
  conversation: 'c1',
  state,
  step: 1,
  started_at: '2026-10-20T10:00:00.000Z',
  ended_at: null,
  usd: 0,
  estimated: false,
  end_reason: null,
  message: null,
  open_gates: [],
  text_so_far: '',
  tab: null,
  project_id: null,
  served_by: null,
  ...extra,
});
/** A `summary` frame's turn, as the server sends it: without text_so_far and prompt. */
const slim = (id: string, state: TurnSummary['state']): SlimTurnSummary => {
  const s: Partial<TurnSummary> = summary(id, state);
  delete s.text_so_far;
  delete s.prompt;
  return s as SlimTurnSummary;
};
const END = (seq: number) => ev(seq, { type: 'end', state: 'done', reason: 'done', message: null });

function sinkLog() {
  const data: Array<{ events: TurnEvent[]; summary?: unknown }> = [];
  const stopped: string[] = [];
  const sink: FollowSink = { data: (d) => data.push(d), stopped: (why) => stopped.push(why) };
  return { sink, data, stopped, seqs: () => data.flatMap((d) => d.events.map((e) => e.seq)) };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFollowForTests();
  channels.length = 0;
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const s: Sent = {
          url,
          aborted: false,
          answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
        };
        init?.signal?.addEventListener('abort', () => {
          s.aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
        sent.push(s);
      });
    }),
  );
});
afterEach(() => {
  resetFollowForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pending = () => sent.filter((s) => !s.aborted && !(s as { done?: boolean }).done);
async function answer(s: Sent, status: number, body: unknown) {
  (s as { done?: boolean }).done = true;
  s.answer(status, body);
  await flush();
}

describe('the turn channel', () => {
  it('opens on the hub from since, hands on what comes, pins while the turn runs and lets go at its end', async () => {
    const { sink, data, stopped } = sinkLog();
    const f = followTurn('t1', sink);
    expect(channels).toHaveLength(1);
    const ch = channels[0];
    expect(ch.url).toBe('/api/assistant/events?role=turn&turn=t1&since=0');
    expect(ch.pinned).toBe(true);
    ch.frame('snapshot', { turn: { ...summary('t1', 'model'), prompt: 'Make a box' }, events: [ev(1, { type: 'state', state: 'starting' }), ev(2, { type: 'state', state: 'model' })], next: 2, ended: false, more: false });
    ch.frame('events', { events: [ev(3, { type: 'text', step: 1, text: 'Hi' })], next: 3 });
    ch.frame('summary', { turn: slim('t1', 'model') });
    expect(data.map((d) => [d.events.map((e) => e.seq), !!d.summary])).toEqual([
      [[1, 2], true],
      [[3], false],
      [[], true],
    ]);
    expect(f.lastSeq).toBe(3);
    expect(ch.pinned).toBe(true);
    // The end: unpinned at once; its last summary (the final counters and cost) still comes.
    ch.frame('events', { events: [END(4)], next: 4 });
    expect(ch.pinned).toBe(false);
    expect(stopped).toEqual([]);
    ch.frame('summary', { turn: { ...slim('t1', 'done'), usd: 0.42 } });
    expect(data.at(-1)?.summary).toMatchObject({ state: 'done', usd: 0.42 });
    expect(stopped).toEqual(['ended']);
    expect(ch.closed).toBe(true);
    expect(f.mode).toBe('done');
    expect(followState().channels).toBe(0);
  });

  it('after the end event, a last summary that never comes: ended after END_GRACE_MS, with no read', async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink);
    const ch = channels[0];
    ch.frame('snapshot', { turn: summary('t1', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    ch.frame('events', { events: [END(2)], next: 2 });
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(stopped).toEqual(['ended']);
    expect(ch.closed).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('an ended turn: its snapshot only, never pinned', () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink, { ended: true });
    const ch = channels[0];
    expect(ch.pinned).toBe(false);
    ch.frame('snapshot', { turn: summary('t1', 'done'), events: [ev(1, { type: 'state', state: 'starting' }), END(9)], next: 9, ended: true, more: false });
    expect(stopped).toEqual(['ended']);
    expect(ch.closed).toBe(true);
    expect(ch.pinned).toBe(false);
  });

  it('a keep pins the channel (a card, a Stop waiting) until released; the end unpins it whatever is held', () => {
    const { sink } = sinkLog();
    const f = followTurn('t1', sink, { ended: true });
    const ch = channels[0];
    const release = f.keep();
    expect(ch.pinned).toBe(true);
    release();
    release();
    expect(ch.pinned).toBe(false);
    f.keep();
    expect(ch.pinned).toBe(true);
    ch.frame('snapshot', { turn: summary('t1', 'done'), events: [END(2)], next: 2, ended: true, more: false });
    expect(ch.pinned).toBe(false);
  });

  it('a dropped stream: the channel is opened again from the newest seq, and what comes twice still comes with its seq', () => {
    const { sink, seqs } = sinkLog();
    const f = followTurn('t1', sink);
    const first = channels[0];
    first.frame('snapshot', { turn: summary('t1', 'model'), events: [ev(1, { type: 'state', state: 'starting' }), ev(5, { type: 'text', step: 1, text: 'a' })], next: 5, ended: false, more: false });
    first.drop();
    expect(first.closed).toBe(true);
    expect(channels).toHaveLength(2);
    expect(channels[1].url).toBe(turnChannelUrl('t1', 5));
    expect(channels[1].pinned).toBe(true);
    // The server's snapshot from 5 may still overlap (a frame in flight): the seq says so.
    channels[1].frame('snapshot', { turn: summary('t1', 'model'), events: [ev(5, { type: 'text', step: 1, text: 'a' }), ev(6, { type: 'text', step: 1, text: 'b' })], next: 6, ended: false, more: false });
    expect(seqs()).toEqual([1, 5, 5, 6]);
    expect(f.lastSeq).toBe(6);
    // A frame of the old channel is never handed on.
    first.frame('events', { events: [ev(7, { type: 'note', text: 'x' })], next: 7 });
    expect(f.lastSeq).toBe(6);
    expect(followState().channels).toBe(1);
  });

  it('a 404 says the record is gone; a 403 stops', () => {
    const a = sinkLog();
    followTurn('t1', a.sink);
    channels[0].refuse(404);
    expect(a.stopped).toEqual(['gone']);
    const b = sinkLog();
    followTurn('t2', b.sink);
    channels[1].refuse(403);
    expect(b.stopped).toEqual(['refused']);
    expect(channels).toHaveLength(2);
    expect(followState().channels).toBe(0);
  });

  it('a refusal is tried again after RETRY_MS from the newest seq; a frame resets the count', () => {
    const { sink } = sinkLog();
    followTurn('t1', sink);
    channels[0].frame('snapshot', { turn: summary('t1', 'model'), events: [ev(3, { type: 'state', state: 'model' })], next: 3, ended: false, more: false });
    channels[0].refuse(429);
    expect(channels).toHaveLength(1);
    vi.advanceTimersByTime(RETRY_MS - 1);
    expect(channels).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(channels).toHaveLength(2);
    expect(channels[1].url).toBe(turnChannelUrl('t1', 3));
    channels[1].refuse(429);
    vi.advanceTimersByTime(RETRY_MS);
    channels[2].frame('events', { events: [], next: 3 });
    channels[2].refuse(429);
    vi.advanceTimersByTime(RETRY_MS);
    channels[3].refuse(429);
    vi.advanceTimersByTime(RETRY_MS);
    // Two in a row since the frame: still the channel.
    expect(channels).toHaveLength(5);
    expect(sent).toHaveLength(0);
  });
});

describe('the long-poll fallback', () => {
  it('a 400 (an older server) takes the long-poll at once: a read, then waits only while the turn is shown', async () => {
    const { sink, seqs, stopped } = sinkLog();
    const f = followTurn('t1', sink);
    channels[0].refuse(400);
    expect(f.mode).toBe('poll');
    await flush();
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/turns/t1?since=0&wait_ms=0']);
    await answer(sent[0], 200, { ok: true, turn: summary('t1', 'model'), events: [ev(1, { type: 'state', state: 'starting' }), ev(2, { type: 'state', state: 'model' })], next: 2, ended: false });
    expect(seqs()).toEqual([1, 2]);
    // Not shown: nothing waits.
    expect(pending()).toHaveLength(0);
    setShownTurn('t1');
    await flush();
    expect(pending().map((s) => s.url)).toEqual([`/api/assistant/turns/t1?since=2&wait_ms=${POLL_WAIT_MS}`]);
    await answer(pending()[0], 200, { ok: true, turn: summary('t1', 'done'), events: [END(3)], next: 3, ended: true });
    expect(stopped).toEqual(['ended']);
    expect(pending()).toHaveLength(0);
    expect(followState().pollers).toBe(0);
  });

  it(`${FAILS_BEFORE_POLL} refusals in a row take the long-poll`, async () => {
    const { sink } = sinkLog();
    const f = followTurn('t1', sink);
    for (let i = 0; i < FAILS_BEFORE_POLL - 1; i++) {
      channels[i].refuse(429);
      vi.advanceTimersByTime(RETRY_MS);
      expect(f.mode).toBe('channel');
    }
    channels[FAILS_BEFORE_POLL - 1].refuse(429);
    expect(f.mode).toBe('poll');
    expect(channels).toHaveLength(FAILS_BEFORE_POLL);
    await flush();
    expect(sent).toHaveLength(1);
    expect(followState().channels).toBe(0);
  });

  it('one request in flight for the whole tab: the shown turn waits, another shown ends that wait', async () => {
    const a = sinkLog();
    const b = sinkLog();
    followTurn('ta', a.sink);
    followTurn('tb', b.sink);
    setShownTurn('ta');
    channels[0].refuse(400);
    channels[1].refuse(400);
    await flush();
    // Each gets its read first, one at a time.
    expect(pending().map((s) => s.url)).toEqual(['/api/assistant/turns/ta?since=0&wait_ms=0']);
    await answer(pending()[0], 200, { ok: true, turn: summary('ta', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false });
    expect(pending().map((s) => s.url)).toEqual(['/api/assistant/turns/tb?since=0&wait_ms=0']);
    await answer(pending()[0], 200, { ok: true, turn: summary('tb', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false });
    expect(pending().map((s) => s.url)).toEqual([`/api/assistant/turns/ta?since=1&wait_ms=${POLL_WAIT_MS}`]);
    const waitA = pending()[0];
    setShownTurn('tb');
    await flush();
    expect(waitA.aborted).toBe(true);
    expect(pending().map((s) => s.url)).toEqual([`/api/assistant/turns/tb?since=1&wait_ms=${POLL_WAIT_MS}`]);
    setShownTurn(null);
    await flush();
    expect(pending()).toHaveLength(0);
  });

  it('a running turn not shown is read again every POLL_BACKGROUND_MS without waiting, so its end comes', async () => {
    const shown = sinkLog();
    const other = sinkLog();
    followTurn('ta', shown.sink);
    followTurn('tb', other.sink);
    setShownTurn('ta');
    channels[0].refuse(400);
    channels[1].refuse(400);
    await flush();
    await answer(pending()[0], 200, { ok: true, turn: summary('ta', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false });
    await answer(pending()[0], 200, { ok: true, turn: summary('tb', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false });
    const waitA = pending()[0];
    expect(waitA.url).toBe(`/api/assistant/turns/ta?since=1&wait_ms=${POLL_WAIT_MS}`);
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS);
    expect(pending().map((s) => s.url)).toEqual(['/api/assistant/turns/tb?since=1&wait_ms=0']);
    await answer(pending()[0], 200, { ok: true, turn: summary('tb', 'done'), events: [END(2)], next: 2, ended: true });
    expect(other.stopped).toEqual(['ended']);
    // The shown one waits again; the ended one is never read again.
    expect(pending().map((s) => s.url)).toEqual([`/api/assistant/turns/ta?since=1&wait_ms=${POLL_WAIT_MS}`]);
    await vi.advanceTimersByTimeAsync(POLL_BACKGROUND_MS * 2);
    expect(sent.filter((s) => s.url.includes('/tb?')).length).toBe(2);
  });

  it('a failed read is sent again after POLL_RETRY_MS; a 404 says gone', async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink);
    setShownTurn('t1');
    channels[0].refuse(400);
    await flush();
    await answer(sent[0], 500, { ok: false, error: 'boom' });
    expect(pending()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(POLL_RETRY_MS);
    expect(pending().map((s) => s.url)).toEqual(['/api/assistant/turns/t1?since=0&wait_ms=0']);
    await answer(pending()[0], 404, { ok: false, code: 'unknown_turn', error: 'No such turn.' });
    expect(stopped).toEqual(['gone']);
  });

  it('a read whose summary says the turn ended ends the follower (the server logs the end in the same step)', async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink);
    setShownTurn('t1');
    channels[0].refuse(400);
    await flush();
    await answer(sent[0], 200, { ok: true, turn: summary('t1', 'done'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false });
    expect(stopped).toEqual(['ended']);
    expect(pending()).toHaveLength(0);
    expect(followState().pollers).toBe(0);
  });

  it('never waits for an ended turn: one read only', async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink, { ended: true });
    setShownTurn('t1');
    channels[0].refuse(400);
    await flush();
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/turns/t1?since=0&wait_ms=0']);
    await answer(sent[0], 200, { ok: true, turn: summary('t1', 'done'), events: [END(4)], next: 4, ended: true });
    expect(stopped).toEqual(['ended']);
    expect(sent).toHaveLength(1);
  });
});

describe('limits and the end', () => {
  it(`at most ${MAX_TURN_CHANNELS} turn channels at once; the next opens when one ends`, () => {
    const sinks = Array.from({ length: MAX_TURN_CHANNELS + 1 }, () => sinkLog());
    const fs = sinks.map((s, i) => followTurn(`t${i}`, s.sink, { ended: true }));
    expect(channels).toHaveLength(MAX_TURN_CHANNELS);
    expect(fs[MAX_TURN_CHANNELS].mode).toBe('queued');
    expect(followState().queued).toBe(1);
    channels[0].frame('snapshot', { turn: summary('t0', 'done'), events: [END(2)], next: 2, ended: true, more: false });
    expect(channels).toHaveLength(MAX_TURN_CHANNELS + 1);
    expect(channels[MAX_TURN_CHANNELS].url).toBe(turnChannelUrl(`t${MAX_TURN_CHANNELS}`, 0));
    expect(fs[MAX_TURN_CHANNELS].mode).toBe('channel');
    // A queued follower closed before its turn never opens one.
    const extra = followTurn('tx', sinkLog().sink);
    expect(extra.mode).toBe('queued');
    extra.close();
    fs[1].close();
    expect(channels).toHaveLength(MAX_TURN_CHANNELS + 1);
    expect(followState()).toMatchObject({ channels: MAX_TURN_CHANNELS - 1, queued: 0 });
  });

  it('a summary that says the end before its end event: one read after END_GRACE_MS, then ended', async () => {
    const { sink, stopped, seqs } = sinkLog();
    const f = followTurn('t1', sink);
    const ch = channels[0];
    ch.frame('snapshot', { turn: summary('t1', 'model'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: false, more: false });
    ch.frame('summary', { turn: slim('t1', 'done') });
    expect(ch.pinned).toBe(false);
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(sent.map((s) => s.url)).toEqual(['/api/assistant/turns/t1?since=1&wait_ms=0']);
    await answer(sent[0], 200, { ok: true, turn: summary('t1', 'done'), events: [END(2)], next: 2, ended: true });
    expect(seqs()).toEqual([1, 2]);
    expect(stopped).toEqual(['ended']);
    expect(f.mode).toBe('done');
  });

  it("an ended turn's snapshot with more to come: unpinned, ended by the end event in the next frame", async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink);
    const ch = channels[0];
    ch.frame('snapshot', { turn: summary('t1', 'done'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: true, more: true });
    expect(ch.pinned).toBe(false);
    expect(stopped).toEqual([]);
    ch.frame('events', { events: [END(2)], next: 2 });
    expect(stopped).toEqual(['ended']);
    await vi.advanceTimersByTimeAsync(END_GRACE_MS * 2);
    expect(sent).toHaveLength(0);
    // Its frames lost (the server ended the channel): one read after the grace.
    const other = sinkLog();
    followTurn('t2', other.sink);
    channels[1].frame('snapshot', { turn: summary('t2', 'done'), events: [ev(1, { type: 'state', state: 'model' })], next: 1, ended: true, more: true });
    await vi.advanceTimersByTimeAsync(END_GRACE_MS);
    expect(sent.map((x) => x.url)).toEqual(['/api/assistant/turns/t2?since=1&wait_ms=0']);
    await answer(sent[0], 200, { ok: true, turn: summary('t2', 'done'), events: [END(2)], next: 2, ended: true });
    expect(other.stopped).toEqual(['ended']);
  });

  it('the end event in time: no read', async () => {
    const { sink, stopped } = sinkLog();
    followTurn('t1', sink);
    const ch = channels[0];
    ch.frame('summary', { turn: slim('t1', 'done') });
    ch.frame('events', { events: [END(2)], next: 2 });
    await vi.advanceTimersByTimeAsync(END_GRACE_MS * 2);
    expect(sent).toHaveLength(0);
    expect(stopped).toEqual(['ended']);
  });
});
