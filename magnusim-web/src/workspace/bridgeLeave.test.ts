// gate:l3-guard, the bridge's side (host API 1.6, LINK proposal 6.2, 6.4 and 6.6): the page's
// exit hook over the port (nav.leaveHook, the events leave and leaveAbort, nav.leaveProgress
// and nav.leaveDone), the probe, what the bridge tells a running leave (calls in flight, the
// link's stages, the host's question, the job accepted, "Keep editing"), a refused link
// failing the leave, and the camera (checked, kept in the app's page, never sent to the server).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyRecord } from '../plugin-sdk/workspace';
import { WorkspaceBridge, WorkspaceCalls, viewState, type BridgeHooks, type BridgeScope, type LeaveActivity } from './bridge';
import { installWorkspaceLeaveGuard, leaveWorkspaceTo, registerOpenWorkspace, type GuardedWorkspace } from './leaveGuard';

const SCOPE: BridgeScope = { plugin: 'link-demo', pluginName: 'Link demo', workspace: 'demo', projectId: 'proj-a', projectTitle: 'Project A', studyId: 'st-1' };
const STUDY = { id: 'st-1', kind: 'demo', title: 'Demo 1', rev: 3 } as unknown as StudyRecord;
const LJOB = 'gl-mg1abc2d-0a1b2c';
const SHA_HEX = 'ab'.repeat(32);
const VIEW = { position: [400, 15, 15], target: [0, 15, 15], up: [0, 0, 1], projection: 'orthographic', height: 100 };
const CALL = { shape: { rel: 'studies/st-1/design/shape.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1 };
const QUESTION = {
  geometry: { id: 'g1', name: 'Demo 1' },
  study: { id: 'st-1', title: 'Demo 1' },
  new_name: 'Demo 1 v2',
  studies: [{ id: 's1', title: 'Study 1', copy: 'ok', checked: true }],
  overwrite: 'ok',
};

class FakeEventSource {
  static CLOSED = 2;
  static made: FakeEventSource[] = [];
  readonly url: string;
  readyState = 1;
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
  close(): void {
    this.readyState = 2;
  }
}

type Answer = { status: number; body: unknown };
let fetched: Array<{ url: string; body: unknown }> = [];
let route: (url: string, body: Record<string, unknown>) => Answer;

function hooks(): BridgeHooks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    back: vi.fn(async () => false),
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
    linkView: vi.fn(),
  };
}

beforeEach(() => {
  fetched = [];
  FakeEventSource.made = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  route = (url) => {
    if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
    if (url.startsWith('/api/plugin-geometry/linked')) return { status: 200, body: { ok: true, linked: { geometryId: 'g1', name: 'Demo 1', rev: 1 } } };
    if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'running', seq: 1 } } };
    return { status: 200, body: { ok: true } };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      fetched.push({ url, body });
      const a = route(url, body);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A bridge on a frame whose page said hello: the frame-side port, every event pushed to it, and calls. */
async function connected() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow as Window;
  const posted: unknown[][] = [];
  (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => void posted.push(a);
  const h = hooks();
  const calls = new WorkspaceCalls(SCOPE, h);
  const bridge = new WorkspaceBridge(frame, calls, h);
  const detach = bridge.attach();
  window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.3.0', instance: 'i1' }, source: win }));
  await vi.waitFor(() => expect(posted.length).toBe(1));
  const port = (posted[0] as [unknown, unknown, MessagePort[]])[2][0];
  const events: Array<Record<string, unknown>> = [];
  const replies = new Map<number, Record<string, unknown>>();
  port.onmessage = (e: MessageEvent) => {
    const d = e.data as Record<string, unknown>;
    if (typeof d.id === 'number') replies.set(d.id, d);
    else events.push(d);
  };
  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    port.postMessage({ id, method, params });
    await vi.waitFor(() => expect(replies.has(id)).toBe(true));
    return replies.get(id) as Record<string, unknown>;
  };
  /** Send without waiting for the answer. */
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    port.postMessage({ id, method, params });
    return () => replies.get(id);
  };
  const end = () => {
    port.close();
    detach();
    frame.remove();
  };
  return { frame, win, posted, h, calls, bridge, port, events, call, send, end };
}

describe('gate:l3-guard viewState: a bad camera is dropped', () => {
  it('keeps a whole view and drops non-finite numbers, position on target, up along the view, bad projection, angle or height', () => {
    expect(viewState(VIEW)).toEqual(VIEW);
    expect(viewState({ ...VIEW, projection: 'perspective', height: undefined, fovDeg: 30 })).toEqual({ ...VIEW, projection: 'perspective', fovDeg: 30, height: undefined } as never);
    expect(viewState({ ...VIEW, position: [1, NaN, 2] })).toBeNull();
    expect(viewState({ ...VIEW, position: [0, 15, 15] })).toBeNull();
    expect(viewState({ ...VIEW, up: [1, 0, 0] })).toBeNull();
    expect(viewState({ ...VIEW, up: [0, 0, 0] })).toBeNull();
    expect(viewState({ ...VIEW, projection: 'fisheye' })).toBeNull();
    expect(viewState({ ...VIEW, height: -1 })).toBeNull();
    expect(viewState({ ...VIEW, projection: 'perspective', fovDeg: 180 })).toBeNull();
    expect(viewState({ ...VIEW, target: [0, 15] })).toBeNull();
    expect(viewState(null)).toBeNull();
    expect(viewState([1, 2, 3])).toBeNull();
  });
});

describe('gate:l3-guard the bridge messages of an exit hook', () => {
  it('nav.leaveHook turns it on; runLeave sends `leave` with each reason; the page\'s progress and its end come back', async () => {
    const t = await connected();
    expect(t.bridge.hookOn()).toBe(false);
    // No hook: a leave has nothing to run.
    await expect(t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined })).resolves.toEqual({ ok: true });
    expect(await t.call('nav.leaveHook', { on: true })).toMatchObject({ result: { ok: true } });
    expect(t.bridge.hookOn()).toBe(true);
    for (const reason of ['back', 'frame-back', 'history', 'project', 'home', 'results'] as const) {
      const seen: LeaveActivity[] = [];
      const done = t.bridge.runLeave(reason, { signal: new AbortController().signal, interactive: true, activity: (a) => seen.push(a) });
      await vi.waitFor(() => expect(t.events.filter((e) => e.event === 'leave')).toHaveLength(1));
      const ev = t.events.pop() as { event: string; data: { leave: string; reason: string } };
      expect(ev.data.reason).toBe(reason);
      await t.call('nav.leaveProgress', { leave: ev.data.leave, fraction: 1.7, label: 'Exporting\nthe design' });
      await t.call('nav.leaveProgress', { leave: 'leave-other', fraction: 0.1, label: 'not this one' });
      await t.call('nav.leaveDone', { leave: ev.data.leave, ok: true, view: VIEW });
      await expect(done).resolves.toEqual({ ok: true });
      expect(seen.filter((a) => a.kind === 'progress')).toEqual([{ kind: 'progress', fraction: 1, label: 'Exporting the design' }]);
    }
    expect(t.h.linkView).toHaveBeenCalledTimes(6);
    expect(t.h.linkView).toHaveBeenLastCalledWith(VIEW);
    // A failed hook says why; a bad camera is dropped.
    const failed = t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    await vi.waitFor(() => expect(t.events.filter((e) => e.event === 'leave')).toHaveLength(1));
    const leave = (t.events.pop() as { data: { leave: string } }).data.leave;
    await t.call('nav.leaveDone', { leave, ok: false, message: 'The export failed', view: { ...VIEW, up: [1, 0, 0] } });
    await expect(failed).resolves.toEqual({ ok: false, message: 'The export failed' });
    expect(t.h.linkView).toHaveBeenCalledTimes(6);
    // null clears it.
    await t.call('nav.leaveHook', { on: false });
    expect(t.bridge.hookOn()).toBe(false);
    t.end();
  });

  it('aborting the signal sends leaveAbort and ends the leave; a late leaveDone changes nothing', async () => {
    const t = await connected();
    await t.call('nav.leaveHook', { on: true });
    const ctl = new AbortController();
    const done = t.bridge.runLeave('back', { signal: ctl.signal, interactive: true, activity: () => undefined });
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    const leave = (t.events[0] as { data: { leave: string } }).data.leave;
    ctl.abort();
    await expect(done).resolves.toEqual({ ok: false, message: 'cancelled' });
    await vi.waitFor(() => expect(t.events[1]).toEqual({ event: 'leaveAbort', data: { leave } }));
    expect(await t.call('nav.leaveDone', { leave, ok: true, view: VIEW })).toMatchObject({ result: { ok: true } });
    expect(t.h.linkView).not.toHaveBeenCalled();
    t.end();
  });

  it('a page that reloads during the hook ends it as not done (and the hook is off for the new page)', async () => {
    const t = await connected();
    await t.call('nav.leaveHook', { on: true });
    const done = t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'hello', sdkVersion: '1.3.0', instance: 'i2' }, source: t.win }));
    await expect(done).resolves.toEqual({ ok: false, message: 'its page closed before it finished' });
    await vi.waitFor(() => expect(t.bridge.connected()).toBe(true));
    expect(t.bridge.hookOn()).toBe(false);
    t.end();
  });

  it('probe: true when the page answers alive, false when it does not answer in time', async () => {
    const t = await connected();
    const yes = t.bridge.probe();
    expect(t.posted[1]).toEqual([{ magnusim: 'probe', instance: 'i1' }, '*']);
    window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'alive', instance: 'i1' }, source: t.win }));
    await expect(yes).resolves.toBe(true);
    vi.useFakeTimers();
    const no = t.bridge.probe();
    vi.advanceTimersByTime(1600);
    await expect(no).resolves.toBe(false);
    vi.useRealTimers();
    t.end();
  });

  it('calls in flight reach a running leave (the stall timer holds while the page works)', async () => {
    const t = await connected();
    await t.call('nav.leaveHook', { on: true });
    const seen: LeaveActivity[] = [];
    let release: () => void = () => undefined;
    route = (url) => {
      if (url.startsWith('/api/plugin-data/write')) {
        return { status: 200, body: { ok: true } };
      }
      if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
      return { status: 200, body: { ok: true } };
    };
    const hold = new Promise<void>((r) => (release = r));
    t.h.toast.mockImplementation(() => undefined);
    t.h.confirm.mockImplementation(async () => {
      await hold;
      return true;
    });
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: (a) => seen.push(a) });
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    const answered = t.send('ui.confirm', { title: 'Sure?' });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'calls', inFlight: 1 }));
    release();
    await vi.waitFor(() => expect(answered()).toBeTruthy());
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual({ kind: 'calls', inFlight: 0 }));
    // The leave's own messages are not the page's work.
    const leave = (t.events[0] as { data: { leave: string } }).data.leave;
    const before = seen.length;
    await t.call('nav.leaveProgress', { leave, fraction: 0.5 });
    expect(seen.slice(before).filter((a) => a.kind === 'calls')).toEqual([]);
    t.end();
  });
});

describe('gate:l3-guard a link inside a leave', () => {
  async function leaveWith(interactive: boolean, h?: Partial<BridgeHooks>) {
    const t = await connected();
    Object.assign(t.h, h || {});
    await t.call('nav.leaveHook', { on: true });
    const seen: LeaveActivity[] = [];
    const done = t.bridge.runLeave('back', { signal: new AbortController().signal, interactive, activity: (a) => seen.push(a) });
    await vi.waitFor(() => expect(t.events.filter((e) => e.event === 'leave')).toHaveLength(1));
    const leave = (t.events.find((e) => e.event === 'leave') as { data: { leave: string } }).data.leave;
    return { t, seen, done, leave };
  }

  it('an overwrite: accepted (queued), its stages; the camera of the call stays here and never reaches the server', async () => {
    route = (url) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'queued', seq: 1 } } };
      return { status: 200, body: { ok: true } };
    };
    const { t, seen, done, leave } = await leaveWith(true);
    const linked = t.send('project.linkGeometry', { ...CALL, view: VIEW, token: 'tk' });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'accepted', jobId: LJOB, create: false, queued: true }));
    expect(t.h.linkView).toHaveBeenCalledWith(VIEW);
    const sent = fetched.find((f) => f.url.startsWith('/api/plugin-geometry/link?'))?.body as Record<string, unknown>;
    expect(sent.view).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('orthographic');
    const es = FakeEventSource.made[0];
    es.emit('link', { job_id: LJOB, seq: 2, ev: { event: 'queued', ahead: 2 } });
    es.emit('link', { job_id: LJOB, seq: 3, ev: { event: 'stage', stage: 'waiting', label: "Waiting for another program to release Demo 1's files" } });
    expect(seen).toContainEqual({ kind: 'link', stage: 'queued', ahead: 2, label: '' });
    expect(seen).toContainEqual({ kind: 'link', stage: 'waiting', ahead: null, label: "Waiting for another program to release Demo 1's files" });
    es.emit('link', { job_id: LJOB, seq: 4, ev: { event: 'end', status: 'done', result: { geometryId: 'g1', name: 'Demo 1', rev: 2, change: 'shape', lost: [], returned: [], claimedTwice: [], match: { byName: 1, byShape: 0, split: 0, merged: 0, movedFar: 0 } } } });
    await vi.waitFor(() => expect(linked()).toMatchObject({ result: { rev: 2 } }));
    // The leave hears that its link went through (its question, if the hook then fails, says so).
    expect(seen).toContainEqual({ kind: 'linked', ok: true, change: 'shape' });
    await t.call('nav.leaveDone', { leave, ok: true });
    await expect(done).resolves.toEqual({ ok: true });
    t.end();
  });

  it("the host's question: choosing open and closed, then accepted as a create (Save as new)", async () => {
    route = (url, body) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false, choosing: QUESTION } };
      if (url.startsWith('/api/plugin-geometry/choose')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g2', created: body.choice === 'new', queued: false } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'choosing', seq: 1 } } };
      return { status: 200, body: { ok: true } };
    };
    const linkChoice = vi.fn(async () => ({ choice: 'new' as const, copy: [] }));
    const { t, seen } = await leaveWith(true, { linkChoice });
    t.send('project.linkGeometry', { ...CALL, token: 'tk' });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'accepted', jobId: LJOB, create: true, queued: false }));
    const kinds = seen.filter((a) => a.kind === 'choosing' || a.kind === 'accepted');
    expect(kinds).toEqual([
      { kind: 'choosing', open: true },
      { kind: 'choosing', open: false },
      { kind: 'accepted', jobId: LJOB, create: true, queued: false },
    ]);
    t.end();
  });

  it('"Keep editing": the leave hears `kept` at once (before the job ends)', async () => {
    route = (url) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false, choosing: QUESTION } };
      if (url.startsWith('/api/plugin-geometry/choose')) return { status: 200, body: { ok: true, job_id: LJOB, cancelled: true } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'choosing', seq: 1 } } };
      return { status: 200, body: { ok: true } };
    };
    const { t, seen } = await leaveWith(true, { linkChoice: vi.fn(async () => ({ choice: 'cancel' as const })) });
    t.send('project.linkGeometry', { ...CALL, token: 'tk' });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'kept' }));
    expect(seen.some((a) => a.kind === 'accepted')).toBe(false);
    t.end();
  });

  it('a caller that cannot ask: "Overwrite" with no dialog, then accepted', async () => {
    route = (url, body) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false, choosing: QUESTION } };
      if (url.startsWith('/api/plugin-geometry/choose')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: body.choice === 'overwrite' } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'choosing', seq: 1 } } };
      return { status: 200, body: { ok: true } };
    };
    const linkChoice = vi.fn(async () => ({ choice: 'new' as const, copy: [] }));
    const { t, seen } = await leaveWith(false, { linkChoice });
    t.send('project.linkGeometry', { ...CALL, token: 'tk' });
    await vi.waitFor(() => expect(seen).toContainEqual({ kind: 'accepted', jobId: LJOB, create: false, queued: true }));
    expect(linkChoice).not.toHaveBeenCalled();
    expect(fetched.find((f) => f.url.startsWith('/api/plugin-geometry/choose'))?.body).toMatchObject({ choice: 'overwrite' });
    expect(seen.some((a) => a.kind === 'choosing')).toBe(false);
    t.end();
  });

  it('a link refused inside the leave (unsaved) fails the leave even when the hook returns ok', async () => {
    const { t, done, leave, seen } = await leaveWith(true);
    await t.call('nav.setDirty', { dirty: true, message: 'Design v2 is not saved' });
    const refused = await t.call('project.linkGeometry', { ...CALL, token: 'tk' });
    expect(refused).toMatchObject({ error: { code: 'unsaved' } });
    expect(seen).toContainEqual({ kind: 'linked', ok: false, change: '' });
    await t.call('nav.leaveDone', { leave, ok: true });
    await expect(done).resolves.toEqual({ ok: false, message: 'Save the design before linking it: the page has unsaved work.' });
    t.end();
  });

  it('a nothing-to-do link (none) is accepted at once with no job', async () => {
    route = (url) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 200, body: { ok: true, result: { geometryId: 'g1', name: 'Demo 1', rev: 1, change: 'none' } } };
      return { status: 200, body: { ok: true } };
    };
    const { t, seen } = await leaveWith(true);
    await t.call('project.linkGeometry', { ...CALL, token: 'tk' });
    expect(seen).toContainEqual({ kind: 'accepted', jobId: null, create: false, queued: false });
    t.end();
  });

  it("the geometry's name for the leave's question comes from the app", async () => {
    const t = await connected();
    await expect(t.bridge.geometryName()).resolves.toBe('Demo 1');
    t.end();
  });
});

describe('gate:l3-guard what counts as the hook working, and how a leave ends (review fixes)', () => {
  it('a call begun before the leave is no work of its hook: only calls made during it count', async () => {
    const t = await connected();
    await t.call('nav.leaveHook', { on: true });
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    t.h.confirm.mockImplementation(async () => {
      await hold;
      return true;
    });
    // A dialog of the page that is still open when the leave starts.
    const early = t.send('ui.confirm', { title: 'Sure?' });
    await vi.waitFor(() => expect(t.h.confirm).toHaveBeenCalled());
    const seen: LeaveActivity[] = [];
    void t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: (a) => seen.push(a) });
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    expect(seen).toEqual([{ kind: 'calls', inFlight: 0 }]);
    release();
    await vi.waitFor(() => expect(early()).toBeTruthy());
    // Its answer changes nothing for this leave.
    expect(seen.filter((a) => a.kind === 'calls')).toEqual([{ kind: 'calls', inFlight: 0 }]);
    t.end();
  });

  it('a leave that ends (here a scripted one) gives the page its questions back: its next link asks', async () => {
    route = (url) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false, choosing: QUESTION } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'choosing', seq: 1 } } };
      if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
      return { status: 200, body: { ok: true } };
    };
    const t = await connected();
    const linkChoice = vi.fn(async () => null);
    Object.assign(t.h, { linkChoice });
    await t.call('nav.leaveHook', { on: true });
    const done = t.bridge.runLeave('project', { signal: new AbortController().signal, interactive: false, activity: () => undefined });
    await vi.waitFor(() => expect(t.events).toHaveLength(1));
    const leave = (t.events[0] as { data: { leave: string } }).data.leave;
    await t.call('nav.leaveDone', { leave, ok: true });
    await expect(done).resolves.toEqual({ ok: true });
    // The user stays (the scripted switch did not go): the page's own link shows the question.
    t.send('project.linkGeometry', { ...CALL, token: 'tk' });
    await vi.waitFor(() => expect(linkChoice).toHaveBeenCalledTimes(1));
    expect(fetched.some((f) => f.url.startsWith('/api/plugin-geometry/choose'))).toBe(false);
    t.end();
  });

  it('a late leaveDone of a cancelled leave does not end the next one', async () => {
    const t = await connected();
    await t.call('nav.leaveHook', { on: true });
    const first = new AbortController();
    const one = t.bridge.runLeave('back', { signal: first.signal, interactive: true, activity: () => undefined });
    await vi.waitFor(() => expect(t.events.filter((e) => e.event === 'leave')).toHaveLength(1));
    const leave1 = (t.events.find((e) => e.event === 'leave') as { data: { leave: string } }).data.leave;
    first.abort();
    await expect(one).resolves.toEqual({ ok: false, message: 'cancelled' });
    let settled = false;
    const two = t.bridge.runLeave('back', { signal: new AbortController().signal, interactive: true, activity: () => undefined });
    void two.then(() => (settled = true));
    await vi.waitFor(() => expect(t.events.filter((e) => e.event === 'leave')).toHaveLength(2));
    const leave2 = (t.events.filter((e) => e.event === 'leave')[1] as { data: { leave: string } }).data.leave;
    expect(leave2).not.toBe(leave1);
    await t.call('nav.leaveDone', { leave: leave1, ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    await t.call('nav.leaveDone', { leave: leave2, ok: false, message: 'second' });
    await expect(two).resolves.toEqual({ ok: false, message: 'second' });
    t.end();
  });

  it('the same design linked again joins the job: both calls are answered when it ends', async () => {
    route = (url) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'queued', seq: 1 } } };
      if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
      return { status: 200, body: { ok: true } };
    };
    const t = await connected();
    const first = t.send('project.linkGeometry', { ...CALL, token: 'a' });
    await vi.waitFor(() => expect(fetched.filter((f) => f.url.startsWith('/api/plugin-geometry/status'))).toHaveLength(1));
    const second = t.send('project.linkGeometry', { ...CALL, token: 'b' });
    await vi.waitFor(() => expect(fetched.filter((f) => f.url.startsWith('/api/plugin-geometry/status'))).toHaveLength(2));
    FakeEventSource.made[0].emit('link', {
      job_id: LJOB,
      seq: 5,
      ev: { event: 'end', status: 'done', result: { geometryId: 'g1', name: 'Demo 1', rev: 2, change: 'shape', lost: [], returned: [], claimedTwice: [], match: { byName: 1, byShape: 0, split: 1, merged: 0, movedFar: 0 } } },
    });
    await vi.waitFor(() => expect(second()).toMatchObject({ result: { rev: 2 } }));
    await vi.waitFor(() => expect(first()).toMatchObject({ result: { rev: 2 } }));
    // One job, one report.
    expect(t.h.linkReport).toHaveBeenCalledTimes(1);
    t.end();
  });

  it("the name of the study's geometry as last heard is there at once", async () => {
    const t = await connected();
    expect(t.bridge.lastGeometryName()).toBe('');
    await t.bridge.geometryName();
    expect(t.bridge.lastGeometryName()).toBe('Demo 1');
    t.end();
  });
});

describe('gate:l3-guard the stall timer with the real bridge: every way out the page starts can stall', () => {
  afterEach(() => {
    location.hash = '';
  });

  /** The bridge and the real leave guard: the page answers probes; its hook never answers. */
  async function guarded() {
    const t = await connected();
    (t.win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => {
      t.posted.push(a);
      const m = a[0] as { magnusim?: string; instance?: string };
      if (m && m.magnusim === 'probe') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { magnusim: 'alive', instance: m.instance }, source: t.win })), 0);
    };
    installWorkspaceLeaveGuard();
    const ws: GuardedWorkspace = {
      route: { projectId: 'proj-a', plugin: 'link-demo', workspace: 'demo', studyId: 'st-1' },
      pluginName: () => 'Link demo',
      studyTitle: () => 'Demo 1',
      frame: () => t.frame,
      hook: {
        on: () => t.bridge.hookOn(),
        probe: () => t.bridge.probe(),
        run: (reason, o) => t.bridge.runLeave(reason, o),
        geometryName: () => t.bridge.geometryName(),
        lastGeometryName: () => t.bridge.lastGeometryName(),
      },
    };
    const unregister = registerOpenWorkspace(ws);
    const asked: Array<{ title: string; copy: string }> = [];
    window.__CFD_CONFIRM__ = vi.fn(async (q: { title: string; copy: string }) => {
      asked.push({ title: q.title, copy: q.copy });
      return false;
    }) as unknown as typeof window.__CFD_CONFIRM__;
    t.h.back.mockImplementation(() => leaveWorkspaceTo('#/p/proj-a', 'frame-back'));
    t.h.openResults.mockImplementation(() => leaveWorkspaceTo('#/p/proj-a', 'results'));
    await t.call('nav.leaveHook', { on: true });
    return { t, asked, unregister };
  }

  /** Let real messages through and move the guard's clocks by `ms`. */
  async function waitClock(ms: number) {
    for (let left = ms; left > 0; left -= 500) {
      await vi.advanceTimersByTimeAsync(Math.min(500, left));
      await new Promise((r) => setImmediate(r));
    }
  }

  for (const [method, params] of [
    ['nav.back', {}],
    ['results.openIn3D', { caseRel: 'cases/fixture' }],
  ] as const) {
    it(`a hook that never answers, started by the page's ${method}: the question after 30 s`, async () => {
      const g = await guarded();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      try {
        const answered = g.t.send(method, params);
        for (let i = 0; i < 20 && !g.t.events.some((e) => e.event === 'leave'); i++) await waitClock(100);
        expect(g.t.events.some((e) => e.event === 'leave')).toBe(true);
        await waitClock(29_000);
        expect(g.asked).toEqual([]);
        await waitClock(4_000);
        expect(g.asked).toEqual([{ title: "Couldn't update the project", copy: 'Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.' }]);
        // Stay: the page's call is answered (it did not leave).
        for (let i = 0; i < 20 && !answered(); i++) await waitClock(100);
        expect(answered()).toMatchObject({ result: method === 'nav.back' ? { left: false } : { opened: false } });
      } finally {
        vi.useRealTimers();
        g.unregister();
        g.t.end();
        delete window.__CFD_CONFIRM__;
      }
    });
  }
});
