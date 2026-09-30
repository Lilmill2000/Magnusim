import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyRecord } from '../plugin-sdk/workspace';
import { BridgeError, THEME, WorkspaceBridge, WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';

const SCOPE: BridgeScope = {
  plugin: 'ws-demo',
  pluginName: 'Workspace demo',
  workspace: 'bench',
  projectId: 'proj-a',
  projectTitle: 'Project A',
  studyId: 'st-1',
};

const STUDY = { id: 'st-1', kind: 'bench_case', title: 'Wing', rev: 3 } as unknown as StudyRecord;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

function hooks(): BridgeHooks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    back: vi.fn(),
    connected: vi.fn(),
    studyChanged: vi.fn(),
    studyGone: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => 'Named'),
    units: vi.fn(() => 'metric' as const),
    log: vi.fn(),
  };
}

beforeEach(() => {
  calls = [];
  answer = (url) => {
    if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
    if (url === '/api/jobs') return { status: 200, body: { ok: true, job: { id: 'job-1' } } };
    return { status: 200, body: { ok: true } };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answer(url, method);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function refused(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error('the call was allowed');
}

describe('WorkspaceCalls: the allowlist', () => {
  it('refuses anything not on it, and logs nothing by itself', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    for (const [method, message] of [
      ['fs.read', 'not allowed: "fs.read"'],
      ['plugins.enable', 'not allowed: "plugins.enable"'],
      ['', 'not allowed: an unnamed call'],
      ['__proto__', 'not allowed: "__proto__"'],
    ] as const) {
      const err = await refused(c.handle(method, {}));
      expect(err.code).toBe('not_allowed');
      expect(err.message).toBe(message);
    }
    expect(calls).toEqual([]);
  });

  it("calls only its own plugin's service, with a clean method name, in its project", async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    expect((await refused(c.handle('service.call', { plugin: 'other', method: 'echo' }))).message).toBe("not allowed: another plugin's service");
    for (const bad of ['', '../admin', 'a/../b', 'x y', '/abs', 'a'.repeat(200)]) {
      expect((await refused(c.handle('service.call', { method: bad }))).code).toBe('not_allowed');
    }
    expect(calls).toEqual([]);
    await c.handle('service.call', { method: 'polar/run', params: { alpha: 4, project_id: 'proj-b' } });
    expect(calls).toEqual([
      { url: '/api/plugin/ws-demo/polar/run?project_id=proj-a', method: 'POST', body: { alpha: 4, project_id: 'proj-a' } },
    ]);
  });

  it('follows and stops only the jobs it started', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    expect((await refused(c.handle('jobs.stop', { jobId: 'job-other' }))).message).toBe('not allowed: a job this workspace did not start');
    expect((await refused(c.handle('jobs.events', { jobId: 'job-other' }))).code).toBe('not_allowed');
    expect(await c.handle('jobs.start', { kind: 'xfoil_polar', params: { re: 1e6, project_id: 'proj-b' } })).toEqual({ id: 'job-1' });
    expect(calls[0]).toEqual({
      url: '/api/jobs',
      method: 'POST',
      body: { kind: 'xfoil_polar', plugin: 'ws-demo', params: { re: 1e6, project_id: 'proj-a' } },
    });
    await c.handle('jobs.stop', { jobId: 'job-1' });
    expect(calls[1]).toMatchObject({ url: '/api/jobs/job-1/stop?project_id=proj-a', method: 'POST' });
  });

  it('reads and saves its own study, and says when the study is gone', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    expect(await c.handle('study.get', {})).toEqual(STUDY);
    expect(calls[0].url).toBe('/api/plugin-studies/get?project_id=proj-a&plugin=ws-demo&study_id=st-1');
    answer = () => ({ status: 200, body: { ok: true, study: { ...STUDY, rev: 4 } } });
    await c.handle('study.update', { patch: { chord: 1 }, rev: 3, study_id: 'st-other' });
    expect(calls[1].body).toEqual({ project_id: 'proj-a', plugin: 'ws-demo', study_id: 'st-1', rev: 3, patch: { chord: 1 } });
    expect(h.studyChanged).toHaveBeenCalledWith({ ...STUDY, rev: 4 });
    answer = () => ({ status: 409, body: { error: 'This study changed in another tab. Reload to continue.' } });
    expect((await refused(c.handle('study.update', { patch: {}, rev: 3 }))).code).toBe('conflict');
    expect(h.studyGone).not.toHaveBeenCalled();
    answer = () => ({ status: 404, body: { error: 'study not found' } });
    const gone = await refused(c.handle('study.get', {}));
    expect([gone.code, gone.message]).toEqual(['not_found', 'study not found']);
    expect(h.studyGone).toHaveBeenCalledTimes(1);
  });

  it('reads and writes data in its own folder of its project', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    answer = () => ({ status: 200, body: { ok: true, doc: { n: 1 } } });
    expect(await c.handle('data.read', { rel: 'notes/n.json', project_id: 'proj-b', plugin: 'other' })).toEqual({ n: 1 });
    await c.handle('data.write', { rel: 'notes/n.json', doc: { n: 2 }, plugin: 'other' });
    expect(calls.map((x) => [x.url, x.body])).toEqual([
      ['/api/plugin-data/read', { project_id: 'proj-a', plugin: 'ws-demo', rel: 'notes/n.json' }],
      ['/api/plugin-data/write', { project_id: 'proj-a', plugin: 'ws-demo', rel: 'notes/n.json', doc: { n: 2 } }],
    ]);
  });

  it('answers project, units and theme from the host, and drives its dialogs and Back', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    expect(await c.handle('project.info', {})).toEqual({ id: 'proj-a', title: 'Project A', units: 'metric' });
    expect(await c.handle('prefs.units', {})).toBe('metric');
    expect(await c.handle('theme', {})).toEqual(THEME);
    await c.handle('ui.toast', { message: 'x'.repeat(400), kind: 'alarm' });
    expect(h.toast).toHaveBeenCalledWith('x'.repeat(300), 'info');
    expect(await c.handle('ui.confirm', { title: 'Replace?', message: 'The polar is replaced.', confirmLabel: 'Replace' })).toBe(true);
    expect(h.confirm).toHaveBeenCalledWith({ title: 'Replace?', copy: 'The polar is replaced.', yes: 'Replace' });
    expect(await c.handle('ui.prompt', { title: 'Name the airfoil' })).toBe('Named');
    await c.handle('nav.back', {});
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

describe('WorkspaceBridge: the handshake', () => {
  function setup() {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const win = frame.contentWindow as Window;
    const posted: unknown[][] = [];
    (win as unknown as { postMessage: (...a: unknown[]) => void }).postMessage = (...a: unknown[]) => void posted.push(a);
    const h = hooks();
    const bridge = new WorkspaceBridge(frame, new WorkspaceCalls(SCOPE, h), h);
    const detach = bridge.attach();
    const hello = (data: Record<string, unknown>, source: Window = win) =>
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    return { frame, win, posted, h, bridge, detach, hello };
  }

  it('answers a hello from its frame only, for SDK major 1', async () => {
    const t = setup();
    t.hello({ magnusim: 'hello', sdkVersion: '1.0.0', instance: 'i1' }, window);
    t.hello({ magnusim: 'hello', sdkVersion: '2.0.0', instance: 'i1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.posted).toEqual([]);
    expect(t.bridge.connected()).toBe(false);
    expect(t.h.log).toHaveBeenCalledWith('workspace hello refused (SDK version)', expect.anything());
    t.detach();
    t.frame.remove();
  });

  it('hands the frame a private port; calls over it meet the allowlist; a new document ends it', async () => {
    const t = setup();
    t.hello({ magnusim: 'hello', sdkVersion: '1.0.0', instance: 'i1' });
    await vi.waitFor(() => expect(t.posted.length).toBe(1));
    const [msg, origin, transfer] = t.posted[0] as [Record<string, unknown>, string, MessagePort[]];
    expect(origin).toBe('*');
    expect(msg).toMatchObject({ magnusim: 'welcome', instance: 'i1' });
    expect(msg.context).toMatchObject({ plugin: 'ws-demo', workspace: 'bench', project: { id: 'proj-a' }, study: STUDY, hostVersion: '1.1' });
    expect(t.bridge.connected()).toBe(true);
    expect(t.h.connected).toHaveBeenCalledTimes(1);

    const port = transfer[0];
    const reply = (id: number, method: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        port.onmessage = (e: MessageEvent) => resolve(e.data as Record<string, unknown>);
        port.postMessage({ id, method, params: {} });
      });
    expect(await reply(1, 'fs.read')).toEqual({ id: 1, error: { message: 'not allowed: "fs.read"', code: 'not_allowed' } });
    expect(t.h.log).toHaveBeenCalledWith('workspace ws-demo: not allowed: "fs.read"', {});
    expect(await reply(2, 'prefs.units')).toEqual({ id: 2, result: 'metric' });
    // A study change the host saw (a rename in its header) is pushed to the frame.
    const pushed = new Promise<unknown>((resolve) => {
      port.onmessage = (e: MessageEvent) => resolve(e.data);
    });
    t.bridge.pushStudy({ ...STUDY, title: 'Renamed', rev: 4 });
    expect(await pushed).toEqual({ event: 'study', data: { ...STUDY, title: 'Renamed', rev: 4 } });

    // A reload of the frame: the probe gets no "alive" from a connected page, so the channel ends.
    vi.useFakeTimers();
    t.frame.dispatchEvent(new Event('load'));
    expect(t.posted[1]).toEqual([{ magnusim: 'probe', instance: 'i1' }, '*']);
    vi.advanceTimersByTime(1600);
    expect(t.bridge.connected()).toBe(false);
    port.close();
    t.detach();
    t.frame.remove();
  });

  it('is not connected until the frame has its welcome (a slow study read keeps the 5 s error card armed)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const t = setup();
    t.hello({ magnusim: 'hello', sdkVersion: '1.0.0', instance: 'i3' });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.posted).toEqual([]);
    expect(t.bridge.connected()).toBe(false);
    expect(t.h.connected).not.toHaveBeenCalled();
    t.detach();
    t.frame.remove();
  });

  it('keeps the channel when the same page answers the probe', async () => {
    const t = setup();
    t.hello({ magnusim: 'hello', sdkVersion: '1.2.0', instance: 'i2' });
    await vi.waitFor(() => expect(t.bridge.connected()).toBe(true));
    vi.useFakeTimers();
    t.frame.dispatchEvent(new Event('load'));
    t.hello({ magnusim: 'alive', instance: 'i2' });
    vi.advanceTimersByTime(1600);
    expect(t.bridge.connected()).toBe(true);
    const port = (t.posted[0] as [unknown, unknown, MessagePort[]])[2][0];
    port.close();
    t.detach();
    expect(t.bridge.connected()).toBe(false);
    t.frame.remove();
  });
});
