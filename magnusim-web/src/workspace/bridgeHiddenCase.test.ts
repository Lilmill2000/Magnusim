import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventHubState, resetEventHubForTests } from '../api/eventHub';
import { WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';

// A plugin page follows its case (compute.events) through the bridge, on the tab's one event
// stream: here the real hub (src/api/eventHub.ts) with a fake EventSource. A hidden tab lets
// its stream go after 3 s unless a channel is pinned; a case's channel was not, so a tab
// hidden while its case ran lost every event meanwhile (Airfoil's residual plot had a gap
// for good, and a case that started meanwhile stayed "queued"). A followed case that has not
// ended pins it now; a stream that really dropped is caught up by the reconnect's snapshot.

class FakeEventSource {
  static made: FakeEventSource[] = [];
  static CLOSED = 2;
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
  drop(): void {
    this.readyState = 0;
    this.onerror?.();
  }
  close(): void {
    this.readyState = 2;
  }
}

const SCOPE: BridgeScope = {
  plugin: 'ws-demo',
  pluginName: 'Workspace demo',
  workspace: 'bench',
  projectId: 'proj-a',
  projectTitle: 'Project A',
  studyId: 'st-1',
};
const JOB = 'fc-mg1abc2d-0a1b2c';

function hooks(): BridgeHooks {
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
    linkReport: vi.fn(),
    linkStarted: vi.fn(),
  } as unknown as BridgeHooks;
}

let visibility: 'visible' | 'hidden' = 'visible';
let subscribes: Array<{ conn: string; channels: Array<{ cid: string; kind: string }> }> = [];
let status: Record<string, unknown> = {};
let pushed: Array<{ jobId?: string; data?: Record<string, unknown> }> = [];

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const setVisibility = (v: 'visible' | 'hidden') => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const heard = () => pushed.filter((m) => m.jobId === JOB).map((m) => m.data);
/** The case channel's id, as the last subscribe asked for it. */
const caseCid = () => subscribes.at(-1)!.channels.find((c) => c.kind === 'case')!.cid;
const stream = () => FakeEventSource.made.at(-1)!;
const frame = (type: string, d: unknown) => stream().emit(type, { c: caseCid(), d });

function running(seq: number) {
  return { id: JOB, caseRel: 'cases/c1', app: 'simpleFoam', nProcs: 1, status: 'running', stage: 'solve', stopping: false, ahead: null, seq };
}

beforeEach(() => {
  resetEventHubForTests();
  FakeEventSource.made = [];
  subscribes = [];
  pushed = [];
  visibility = 'visible';
  status = { ...running(5), status: 'queued', stage: null, ahead: 1, seq: 1 };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (url === '/api/events/subscribe') {
        subscribes.push(body);
        return new Response(JSON.stringify({ ok: true, results: body.channels.map((c: { cid: string }) => ({ cid: c.cid, ok: true })) }));
      }
      if (url.startsWith('/api/plugin-cases/status')) return new Response(JSON.stringify({ ok: true, job: status }));
      return new Response('{"ok":true}');
    }),
  );
});

afterEach(() => {
  resetEventHubForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

/** The page follows the queued case; the stream says hello and the case's snapshot comes. */
async function follow(): Promise<WorkspaceCalls> {
  const c = new WorkspaceCalls(SCOPE, hooks());
  c.setPush((m) => pushed.push(m as never));
  const following = c.handle('compute.events', { jobId: JOB });
  await settle();
  stream().hello('c1');
  await following;
  await settle();
  frame('snapshot', { jobs: [status], live: null });
  expect(heard()).toEqual([{ event: 'queued', ahead: 1 }]);
  return c;
}

describe('a followed plugin case in a hidden tab (the real event hub)', () => {
  it('keeps the stream while its case runs: every event sent while the tab is hidden reaches the page', async () => {
    const c = await follow();
    vi.useFakeTimers();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eventHubState().open, 'the stream is kept while the case has not ended').toBe(true);
    expect(FakeEventSource.made).toHaveLength(1);
    expect(stream().readyState).toBe(1);
    // The case starts and runs while the tab is hidden.
    frame('case', { job_id: JOB, seq: 2, ev: { event: 'start' } });
    frame('case', { job_id: JOB, seq: 3, ev: { event: 'stage', stage: 'solve' } });
    for (let i = 1; i <= 3; i++) frame('case', { job_id: JOB, seq: 3 + i, ev: { event: 'progress', points: [{ t: i }] } });
    frame('case', { job_id: JOB, seq: 7, ev: { event: 'time_saved', t: 3 } });
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(100);
    frame('case', { job_id: JOB, seq: 8, ev: { event: 'progress', points: [{ t: 4 }] } });
    expect(heard()).toEqual([
      { event: 'queued', ahead: 1 },
      { event: 'start' },
      { event: 'stage', stage: 'solve' },
      { event: 'progress', points: [{ t: 1 }] },
      { event: 'progress', points: [{ t: 2 }] },
      { event: 'progress', points: [{ t: 3 }] },
      { event: 'time_saved', t: 3 },
      { event: 'progress', points: [{ t: 4 }] },
    ]);
    // Once it has ended nothing pins the stream: hidden, it goes after the grace.
    frame('case', { job_id: JOB, seq: 9, ev: { event: 'end', status: 'done', error: null, code: null, result: null } });
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(3_500);
    expect(eventHubState().open, 'no case left running: the hidden tab lets its stream go').toBe(false);
    expect(eventHubState().channels).toBe(1);
    c.close();
  });

  it('a stream that dropped meanwhile: the reconnect catches the page up with the start and the live points it missed', async () => {
    const c = await follow();
    stream().drop();
    // Meanwhile the case started and ran; the reconnect's snapshot says where it is now.
    stream().hello('c2');
    await settle();
    frame('snapshot', { jobs: [running(12)], live: { job_id: JOB, points: [{ t: 1 }, { t: 2 }, { t: 3 }] } });
    frame('case', { job_id: JOB, seq: 12, ev: { event: 'progress', points: [{ t: 3 }] } });
    frame('case', { job_id: JOB, seq: 13, ev: { event: 'progress', points: [{ t: 4 }] } });
    expect(heard()).toEqual([
      { event: 'queued', ahead: 1 },
      { event: 'start' },
      { event: 'progress', points: [{ t: 1 }, { t: 2 }, { t: 3 }] },
      { event: 'progress', points: [{ t: 4 }] },
    ]);
    c.close();
  });
});
