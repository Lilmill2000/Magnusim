import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEventHubForTests } from '../api/eventHub';
import { WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';

// project.linkGeometry follows the job it starts on the study's link channel, a channel on
// the tab's one event stream (the real hub, src/api/eventHub.ts, with a fake EventSource).
// The channel is asked for in a batch, once the stream has said hello, so the link POST went
// out first and the job's first events could come before the server had the channel. The
// link now waits until the server has it (pinned meanwhile, so a hidden tab opens it too),
// and goes anyway after a few seconds if the stream never comes.

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
const LJOB = 'gl-mg1abc2d-0a1b2c';
const CALL = { shape: { rel: 'studies/st-1/exports/x.bbrep', format: 'brep', sha256: 'ab'.repeat(32) }, sourceVersion: 2, basedOnRev: 1, token: 't1' };
const RESULT = { geometryId: 'g1', name: 'Wing', rev: 2, fromRev: 1, created: false, change: 'shape', lost: [], returned: [] };

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
/** What reached the server, in order: 'subscribe <kinds>' and 'link'. */
let order: string[] = [];
let subscribes: Array<{ channels: Array<{ cid: string; kind: string }> }> = [];

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const stream = () => FakeEventSource.made.at(-1)!;

beforeEach(() => {
  resetEventHubForTests();
  FakeEventSource.made = [];
  order = [];
  subscribes = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (url === '/api/events/subscribe') {
        subscribes.push(body);
        order.push(`subscribe ${body.channels.map((c: { kind: string }) => c.kind).join(',')}`);
        return new Response(JSON.stringify({ ok: true, results: body.channels.map((c: { cid: string }) => ({ cid: c.cid, ok: true })) }));
      }
      if (url.startsWith('/api/plugin-geometry/link?')) {
        order.push('link');
        return new Response(JSON.stringify({ ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true }), { status: 202 });
      }
      if (url.startsWith('/api/plugin-geometry/status')) return new Response(JSON.stringify({ ok: true, job: { id: LJOB, status: 'running', seq: 1 } }));
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

/** The link's end on its channel (the last subscribe's link channel). */
function linkEnds(): void {
  const cid = subscribes.at(-1)!.channels.find((c) => c.kind === 'link')!.cid;
  stream().emit('link', { c: cid, d: { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'done', result: RESULT } } });
}

describe("a page's link and its channel on the tab's one event stream", () => {
  it('the link is sent only once the server has the study\'s link channel', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    c.setPush(() => undefined);
    const linking = c.handle('project.linkGeometry', CALL);
    await settle();
    expect(order, 'nothing is sent before the stream says hello').toEqual([]);
    stream().hello('c1');
    await vi.waitFor(() => expect(order).toEqual(['subscribe link', 'link']));
    linkEnds();
    await expect(linking).resolves.toMatchObject({ geometryId: 'g1', rev: 2 });
  });

  it('a hidden tab opens its stream for the link (pinned while it is sent), and asks for the channel first', async () => {
    visibility = 'hidden';
    const c = new WorkspaceCalls(SCOPE, hooks());
    c.setPush(() => undefined);
    const linking = c.handle('project.linkGeometry', CALL);
    await settle();
    expect(FakeEventSource.made, 'the stream opens though the tab is hidden').toHaveLength(1);
    stream().hello('c1');
    await vi.waitFor(() => expect(order).toEqual(['subscribe link', 'link']));
    linkEnds();
    await linking;
  });

  it('a stream that never says hello does not hold the link: it is sent after a few seconds', async () => {
    vi.useFakeTimers();
    const c = new WorkspaceCalls(SCOPE, hooks());
    c.setPush(() => undefined);
    const linking = c.handle('project.linkGeometry', CALL);
    linking.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(order).toEqual(['link']);
    c.close();
  });
});
