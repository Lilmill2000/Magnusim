import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, SDK_VERSION, type AssistantTool, type Workspace, type WorkspaceContext } from './workspace';

const MiB = 1024 * 1024;
const SHA = 'ab'.repeat(32);
const WRITTEN = { rel: 'meshes/wing.stl', size: 40 * MiB, mtime: '2026-09-30T10:00:00.000Z', etag: '"1f-2800000-2a"', sha256: SHA };
const CONTEXT = {
  plugin: 'ws-demo',
  workspace: 'bench',
  project: { id: 'proj-a', title: 'Project A' },
  study: { id: 'st-1' },
  units: 'metric',
  theme: { name: 'light', stylesheet: '/plugin-sdk/theme.css' },
  hostVersion: '1.2',
} as unknown as WorkspaceContext;

type Params = Record<string, unknown>;
/** One call as the host got it: `args` is how many arguments postMessage had, `handedOver` whether its data was in the transfer list. */
type Post = { method: string; params: Params; args: number; transfer?: Transferable[]; handedOver: boolean };
type Reply = (method: string, params: Params) => unknown;

/**
 * Connect to a host behind a fake port. The port clones what it is sent with
 * its transfer list, as a real one does (so a transferred buffer is detached
 * on the frame's side), records it and answers from `reply` (a throw is a refusal).
 * With `clone`, it clones every message as a real port does (what cannot be copied
 * throws a DataCloneError, and is never sent).
 */
async function open(
  reply: Reply,
  opts: { clone?: boolean; context?: Partial<WorkspaceContext> } = {},
): Promise<{ ws: Workspace; posts: Post[]; hello: ReturnType<typeof vi.fn>; push: (msg: Record<string, unknown>) => void }> {
  const posts: Post[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    start() {},
    postMessage(msg: { id: number; method: string; params: Params }, ...rest: [Transferable[]?]) {
      const transfer = rest[0];
      const handedOver = !!transfer && transfer.includes(msg.params.data as Transferable);
      const got = transfer ? structuredClone(msg, { transfer }) : opts.clone ? structuredClone(msg) : msg;
      posts.push({ method: got.method, params: got.params, args: 1 + rest.length, transfer, handedOver });
      Promise.resolve()
        .then(() => reply(got.method, got.params))
        .then(
          (result) => port.onmessage?.({ data: { id: got.id, result } }),
          (err: { message?: string; code?: string; retryAfter?: number }) =>
            port.onmessage?.({
              data: { id: got.id, error: { message: err.message, code: err.code, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) } },
            }),
        );
    },
  };
  const parent = {
    postMessage: vi.fn((msg: { magnusim?: string; instance?: string }) => {
      if (msg.magnusim !== 'hello') return;
      const welcome = new Event('message');
      Object.defineProperties(welcome, {
        source: { value: parent },
        data: { value: { magnusim: 'welcome', instance: msg.instance, context: { ...CONTEXT, ...opts.context } } },
        ports: { value: [port] },
      });
      window.dispatchEvent(welcome);
    }),
  };
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  const ws = await connect({ timeoutMs: 1000 });
  // What the host pushes without being asked (job events, study changes).
  const push = (msg: Record<string, unknown>) => port.onmessage?.({ data: msg });
  return { ws, posts, hello: parent.postMessage, push };
}

/** A host that takes uploads: chunks count up to what was sent, the commit answers WRITTEN. */
function uploads(extra: Reply = () => undefined): Reply {
  return (method, params) => {
    if (method === 'files.write.begin') return { upload: 'u1', chunkBytes: 16 * MiB };
    if (method === 'files.write.chunk') {
      const data = params.data as ArrayBuffer | Blob;
      return { received: (params.offset as number) + (data instanceof Blob ? data.size : data.byteLength) };
    }
    if (method === 'files.write.commit') return WRITTEN;
    if (method === 'files.write.abort') return { ok: true };
    return extra(method, params);
  };
}

const methods = (posts: Post[]) => posts.map((p) => p.method);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ws.files: writing', () => {
  it("sends an ArrayBuffer in chunks it hands over, leaving the caller's buffer as it was", async () => {
    const { ws, posts, hello } = await open(uploads());
    expect(hello).toHaveBeenCalledWith({ magnusim: 'hello', sdkVersion: SDK_VERSION, instance: expect.any(String) }, '*');
    expect(SDK_VERSION).toBe('1.4.0');
    const data = new Uint8Array(40 * MiB);
    data[0] = 1;
    data[16 * MiB] = 2;
    data[32 * MiB] = 3;
    data[40 * MiB - 1] = 4;
    const progress: number[][] = [];
    const r = await ws.files.write('meshes/wing.stl', data.buffer, {
      ifMatch: null,
      sha256: SHA,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(r).toEqual(WRITTEN);
    expect(methods(posts)).toEqual([
      'files.write.begin',
      'files.write.chunk',
      'files.write.chunk',
      'files.write.chunk',
      'files.write.commit',
    ]);
    expect(posts[0].params).toEqual({ rel: 'meshes/wing.stl', size: 40 * MiB, ifMatch: null });
    const chunks = posts.slice(1, 4);
    // Each chunk is its own buffer, in the transfer list of its post.
    expect(chunks.map((c) => [c.args, c.transfer?.length, c.handedOver])).toEqual([
      [2, 1, true],
      [2, 1, true],
      [2, 1, true],
    ]);
    expect(chunks.map((c) => [c.params.upload, c.params.offset, (c.params.data as ArrayBuffer).byteLength])).toEqual([
      ['u1', 0, 16 * MiB],
      ['u1', 16 * MiB, 16 * MiB],
      ['u1', 32 * MiB, 8 * MiB],
    ]);
    const first = chunks.map((c) => new Uint8Array(c.params.data as ArrayBuffer)[0]);
    expect(first).toEqual([1, 2, 3]);
    expect(new Uint8Array(chunks[2].params.data as ArrayBuffer)[8 * MiB - 1]).toBe(4);
    // The caller's buffer was copied from, not handed over.
    expect(data.buffer.byteLength).toBe(40 * MiB);
    expect([data[0], data[16 * MiB], data[32 * MiB], data[40 * MiB - 1]]).toEqual([1, 2, 3, 4]);
    expect(progress).toEqual([
      [16 * MiB, 40 * MiB],
      [32 * MiB, 40 * MiB],
      [40 * MiB, 40 * MiB],
    ]);
    expect(posts[4].params).toEqual({ upload: 'u1', sha256: SHA });
  });

  it('sends only the bytes a typed array views', async () => {
    const { ws, posts } = await open((method, params) =>
      method === 'files.write.begin' ? { upload: 'u1', chunkBytes: 16 } : uploads()(method, params),
    );
    const whole = Uint8Array.from({ length: 40 }, (_, i) => i);
    await ws.files.write('a.bin', whole.subarray(3, 23));
    expect(posts[0].params.size).toBe(20);
    const sent = posts.filter((p) => p.method === 'files.write.chunk').map((p) => Array.from(new Uint8Array(p.params.data as ArrayBuffer)));
    expect(sent).toEqual([Array.from({ length: 16 }, (_, i) => i + 3), [19, 20, 21, 22]]);
    expect(whole.length).toBe(40);
  });

  it('sends a Blob in Blob slices, with nothing transferred', async () => {
    const { ws, posts } = await open((method, params) =>
      method === 'files.write.begin' ? { upload: 'u1', chunkBytes: 16 } : uploads()(method, params),
    );
    const blob = new Blob([new Uint8Array(40)]);
    await ws.files.write('a.bin', blob);
    const chunks = posts.filter((p) => p.method === 'files.write.chunk');
    expect(chunks.map((c) => [c.args, c.transfer, c.params.data instanceof Blob, (c.params.data as Blob).size, c.params.offset])).toEqual([
      [1, undefined, true, 16, 0],
      [1, undefined, true, 16, 16],
      [1, undefined, true, 8, 32],
    ]);
  });

  it('writes an empty file with a begin and a commit', async () => {
    const { ws, posts } = await open(uploads());
    const onProgress = vi.fn();
    await ws.files.write('empty.bin', new ArrayBuffer(0), { onProgress });
    expect(methods(posts)).toEqual(['files.write.begin', 'files.write.commit']);
    expect(posts[0].params).toEqual({ rel: 'empty.bin', size: 0 });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('stops when its signal aborts: the upload is aborted and the write rejects', async () => {
    let chunks = 0;
    const { ws, posts } = await open((method, params) =>
      // The second chunk never comes back: the abort must not wait for it.
      method === 'files.write.chunk' && ++chunks === 2 ? new Promise(() => undefined) : uploads()(method, params),
    );
    const stop = new AbortController();
    const write = ws.files.write('a.bin', new ArrayBuffer(40 * MiB), { signal: stop.signal });
    await vi.waitFor(() => expect(chunks).toBe(2));
    stop.abort();
    await expect(write).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(methods(posts).at(-1)).toBe('files.write.abort'));
    expect(posts.at(-1)?.params).toEqual({ upload: 'u1' });
    expect(methods(posts)).not.toContain('files.write.commit');

    // Aborted before it starts: nothing is sent at all.
    const n = posts.length;
    await expect(ws.files.write('b.bin', new ArrayBuffer(4), { signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(posts.length).toBe(n);
  });

  it('aborts the upload when a chunk is refused, and rejects with the code', async () => {
    const { ws, posts } = await open((method, params) => {
      if (method === 'files.write.chunk' && params.offset === 16 * MiB) throw { message: 'over the quota', code: 'quota' };
      return uploads()(method, params);
    });
    await expect(ws.files.write('a.bin', new ArrayBuffer(40 * MiB))).rejects.toMatchObject({ message: 'over the quota', code: 'quota' });
    await vi.waitFor(() =>
      expect(methods(posts)).toEqual(['files.write.begin', 'files.write.chunk', 'files.write.chunk', 'files.write.abort']),
    );
  });

  it('tries a commit refused as busy again, 1 s apart, up to 3 times', async () => {
    let commits = 0;
    let busyFor = 2;
    const { ws, posts } = await open((method, params) => {
      if (method === 'files.write.commit' && commits++ < busyFor) throw { message: 'a.bin is in use by another program', code: 'busy' };
      return uploads()(method, params);
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const write = ws.files.write('a.bin', new ArrayBuffer(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(commits).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(commits).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(commits).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(commits).toBe(3);
    expect(await write).toEqual(WRITTEN);
    expect(methods(posts)).not.toContain('files.write.abort');

    // Busy every time: after the third retry it gives up and aborts.
    commits = 0;
    busyFor = 99;
    const failed = ws.files.write('a.bin', new ArrayBuffer(4)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await failed).toMatchObject({ code: 'busy', message: 'a.bin is in use by another program' });
    expect(commits).toBe(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(methods(posts).at(-1)).toBe('files.write.abort');
  });

  it('gives up at once on a commit refused for any other reason, and aborts the upload', async () => {
    let commits = 0;
    const { ws, posts } = await open((method, params) => {
      if (method === 'files.write.commit') {
        commits++;
        throw { message: 'the file changed since it was read', code: 'changed' };
      }
      return uploads()(method, params);
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const failed = ws.files.write('a.bin', new ArrayBuffer(4), { ifMatch: '"old"' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await failed).toMatchObject({ code: 'changed', message: 'the file changed since it was read' });
    expect(commits).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(commits).toBe(1);
    expect(methods(posts)).toEqual(['files.write.begin', 'files.write.chunk', 'files.write.commit', 'files.write.abort']);
  });

  it('writes a string as its UTF-8 bytes, sized in bytes, in chunks it hands over', async () => {
    const { ws, posts } = await open((method, params) =>
      method === 'files.write.begin' ? { upload: 'u1', chunkBytes: 5 } : uploads()(method, params),
    );
    // 11 UTF-16 code units, 17 bytes: ü and ß take 2, ✓ 3 and 𝄞 4.
    const text = 'Grüße ✓ 𝄞\n';
    const utf8 = [0x47, 0x72, 0xc3, 0xbc, 0xc3, 0x9f, 0x65, 0x20, 0xe2, 0x9c, 0x93, 0x20, 0xf0, 0x9d, 0x84, 0x9e, 0x0a];
    expect(await ws.files.write('notes/readme.txt', text, { ifMatch: null })).toEqual(WRITTEN);
    expect(posts[0].params).toEqual({ rel: 'notes/readme.txt', size: 17, ifMatch: null });
    const chunks = posts.filter((p) => p.method === 'files.write.chunk');
    // Chunks split bytes, not characters: the pieces join to the whole encoding.
    expect(chunks.map((c) => [c.params.offset, (c.params.data as ArrayBuffer).byteLength, c.handedOver])).toEqual([
      [0, 5, true],
      [5, 5, true],
      [10, 5, true],
      [15, 2, true],
    ]);
    expect(chunks.flatMap((c) => Array.from(new Uint8Array(c.params.data as ArrayBuffer)))).toEqual(utf8);
    expect(methods(posts).at(-1)).toBe('files.write.commit');

    posts.length = 0;
    await ws.files.write('notes/empty.txt', '');
    expect(methods(posts)).toEqual(['files.write.begin', 'files.write.commit']);
    expect(posts[0].params).toEqual({ rel: 'notes/empty.txt', size: 0 });
  });

  it('refuses data that is neither bytes nor text without calling the host', async () => {
    const { ws, posts } = await open(uploads());
    for (const data of [42, null, { byteLength: 4 }, [1, 2]]) {
      await expect(ws.files.write('a.bin', data as unknown as ArrayBuffer)).rejects.toBeInstanceOf(TypeError);
    }
    expect(posts).toEqual([]);
  });
});

describe("ws.prefs: the user's prefs of this plugin (host 1.7)", () => {
  it('gets, sets and removes by name; null when there is none; a refusal keeps its code', async () => {
    const { ws, posts } = await open((method, params) => {
      if (method === 'prefs.get') return params.key === 'toolbar-layout' ? { order: ['sketch'] } : null;
      if (method === 'prefs.set' && params.key === 'big') throw { message: 'A plugin keeps at most 64 KB of prefs', code: 'too_large' };
      return { ok: true };
    });
    expect(await ws.prefs.get('toolbar-layout')).toEqual({ order: ['sketch'] });
    expect(await ws.prefs.get('none')).toBeNull();
    expect(await ws.prefs.set('toolbar-layout', { order: [] })).toBeUndefined();
    await ws.prefs.set('cleared', undefined);
    await ws.prefs.remove('toolbar-layout');
    await expect(ws.prefs.set('big', 'x')).rejects.toMatchObject({ code: 'too_large' });
    expect(posts.map((p) => [p.method, p.params])).toEqual([
      ['prefs.get', { key: 'toolbar-layout' }],
      ['prefs.get', { key: 'none' }],
      ['prefs.set', { key: 'toolbar-layout', value: { order: [] } }],
      ['prefs.set', { key: 'cleared', value: null }],
      ['prefs.remove', { key: 'toolbar-layout' }],
      ['prefs.set', { key: 'big', value: 'x' }],
    ]);
  });

  it("onChange hears another tab's change as (key, value), until it is stopped", async () => {
    const { ws, push } = await open(() => null);
    const heard: unknown[] = [];
    const stop = ws.prefs.onChange((key, value) => heard.push([key, value]));
    push({ event: 'prefs', data: { key: 'toolbar-layout', value: { order: ['a'] } } });
    push({ event: 'prefs', data: { key: 'toolbar-layout', value: null } });
    stop();
    push({ event: 'prefs', data: { key: 'toolbar-layout', value: 1 } });
    expect(heard).toEqual([
      ['toolbar-layout', { order: ['a'] }],
      ['toolbar-layout', null],
    ]);
  });
});

describe('ws.nav: Back and unsaved work', () => {
  it('setDirty sends a strict flag and the message as a string', async () => {
    const { ws, posts } = await open(() => ({ ok: true }));
    expect(await ws.nav.setDirty(true, 'Chord 120 mm is not saved')).toBeUndefined();
    await ws.nav.setDirty(false);
    await ws.nav.setDirty('yes' as unknown as boolean, 42 as unknown as string);
    await ws.nav.setDirty(true, null as unknown as string);
    expect(posts.map((p) => [p.method, p.params, p.args])).toEqual([
      ['nav.setDirty', { dirty: true, message: 'Chord 120 mm is not saved' }, 1],
      ['nav.setDirty', { dirty: false, message: '' }, 1],
      ['nav.setDirty', { dirty: false, message: '42' }, 1],
      ['nav.setDirty', { dirty: true, message: '' }, 1],
    ]);
  });

  it('an older host refuses setDirty with code "not_allowed"', async () => {
    const { ws } = await open((method) => {
      if (method === 'nav.setDirty') throw { message: 'not allowed: "nav.setDirty"', code: 'not_allowed' };
      return null;
    });
    await expect(ws.nav.setDirty(true)).rejects.toMatchObject({ code: 'not_allowed', message: 'not allowed: "nav.setDirty"' });
  });

  it('back resolves false when the user stays, and true when the workspace was left', async () => {
    let answer: unknown = { ok: true, left: false };
    const { ws, posts } = await open(() => answer);
    expect(await ws.nav.back()).toBe(false);
    answer = { ok: true, left: true };
    expect(await ws.nav.back()).toBe(true);
    // A 1.1 host answers without `left`: it always left.
    answer = { ok: true };
    expect(await ws.nav.back()).toBe(true);
    expect(posts.map((p) => [p.method, p.params])).toEqual([
      ['nav.back', {}],
      ['nav.back', {}],
      ['nav.back', {}],
    ]);
  });
});

describe('ws.compute and ws.results: plugin OpenFOAM cases (host 1.3)', () => {
  const JOB = 'fc-mg1abc2d-0a1b2c';
  const JOB_ROW = { id: JOB, caseRel: 'cases/c1', app: 'pimpleFoam', status: 'queued', seq: 1 };

  it('submits a case and answers what the host says', async () => {
    const { ws, posts } = await open((method) => (method === 'compute.submitOpenFOAM' ? { id: JOB, ahead: 1, existing: false } : null));
    const opts = {
      caseRel: 'cases/c1',
      app: 'pimpleFoam',
      nProcs: 2,
      pre: [{ tool: 'blockMesh' as const }, { tool: 'decomposePar' as const }, { tool: 'renumberMesh' as const, parallel: true }, { tool: 'reconstructParMesh' as const }],
      results: { kinematicFields: ['p'], rho: 1 },
    };
    expect(await ws.compute.submitOpenFOAM(opts)).toEqual({ id: JOB, ahead: 1, existing: false });
    expect(posts.map((p) => [p.method, p.params])).toEqual([['compute.submitOpenFOAM', opts]]);
  });

  it('stops, reads and lists, and an older host refuses with code "not_allowed"', async () => {
    const { ws, posts } = await open((method) => {
      if (method === 'compute.stop') return { status: 'running', stopping: true };
      if (method === 'compute.status') return JOB_ROW;
      if (method === 'compute.list') return [JOB_ROW];
      throw { message: `not allowed: "${method}"`, code: 'not_allowed' };
    });
    expect(await ws.compute.stop(JOB)).toEqual({ status: 'running', stopping: true });
    await ws.compute.stop(JOB, { force: true });
    expect(await ws.compute.status(JOB)).toEqual(JOB_ROW);
    expect(await ws.compute.list()).toEqual([JOB_ROW]);
    expect(posts.map((p) => [p.method, p.params])).toEqual([
      ['compute.stop', { jobId: JOB, force: false }],
      ['compute.stop', { jobId: JOB, force: true }],
      ['compute.status', { jobId: JOB }],
      ['compute.list', {}],
    ]);
    await expect(ws.compute.submitOpenFOAM({ caseRel: 'c', app: 'pimpleFoam', results: { kinematicFields: [] } })).rejects.toMatchObject({
      code: 'not_allowed',
    });
  });

  it("follows a case once, hands its events to that case's listeners only, and stops on unsubscribe", async () => {
    const { ws, posts, push } = await open(() => ({ ok: true }));
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = ws.compute.events(JOB, (ev) => a.push(ev));
    ws.compute.events(JOB, (ev) => b.push(ev));
    await Promise.resolve();
    expect(posts.map((p) => [p.method, p.params])).toEqual([['compute.events', { jobId: JOB }]]);
    push({ event: 'job', jobId: JOB, data: { event: 'start' } });
    push({ event: 'job', jobId: 'fc-other00-ffffff', data: { event: 'start' } });
    offA();
    push({ event: 'job', jobId: JOB, data: { event: 'stage', stage: 'solve' } });
    expect(a).toEqual([{ event: 'start' }]);
    expect(b).toEqual([{ event: 'start' }, { event: 'stage', stage: 'solve' }]);
    // A job of the jobs.* kind with the same id is asked for with its own call.
    ws.jobs.events(JOB, () => undefined);
    await Promise.resolve();
    expect(posts.map((p) => p.method)).toEqual(['compute.events', 'jobs.events']);
  });

  it('a refused follow reaches the listener as an error event with its code', async () => {
    const { ws } = await open(() => {
      throw { message: 'No such case in this study', code: 'not_found' };
    });
    const got = await new Promise((resolve) => ws.compute.events(JOB, resolve));
    expect(got).toEqual({ event: 'error', message: 'No such case in this study', code: 'not_found' });
  });

  it('results.openIn3D resolves whether the results opened', async () => {
    let answer: unknown = { opened: true };
    const { ws, posts } = await open(() => answer);
    expect(await ws.results.openIn3D('cases/c2')).toEqual({ opened: true });
    answer = { opened: false };
    expect(await ws.results.openIn3D('cases/c2')).toEqual({ opened: false });
    answer = null;
    expect(await ws.results.openIn3D('cases/c2')).toEqual({ opened: false });
    expect(posts.map((p) => [p.method, p.params])).toEqual([
      ['results.openIn3D', { caseRel: 'cases/c2' }],
      ['results.openIn3D', { caseRel: 'cases/c2' }],
      ['results.openIn3D', { caseRel: 'cases/c2' }],
    ]);
  });
});

describe('ws.files: reading, listing and deleting', () => {
  it('reads bytes, a Blob or null when there is no file', async () => {
    const { ws, posts } = await open((method, params) => {
      if (method !== 'files.read') return null;
      return params.rel === 'missing.bin' ? null : { blob: new Blob([new Uint8Array([7, 8])]), size: 10, etag: '"e"' };
    });
    expect(await ws.files.read('missing.bin')).toBeNull();
    expect(await ws.files.readBlob('missing.bin')).toBeNull();
    const buf = await ws.files.read('a.bin', { offset: 1, length: 2, ifMatch: '"e"' });
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(buf as ArrayBuffer))).toEqual([7, 8]);
    expect(posts.at(-1)?.params).toEqual({ rel: 'a.bin', offset: 1, length: 2, ifMatch: '"e"' });
    const blob = await ws.files.readBlob('a.bin');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.size).toBe(2);
    expect(posts.at(-1)?.params).toEqual({ rel: 'a.bin' });
  });

  it('stats, lists and deletes, and a refusal carries its code', async () => {
    const info = { rel: 'meshes/wing.stl', size: 20, mtime: '2026-09-30T10:00:00.000Z', etag: '"e"' };
    const { ws, posts } = await open((method, params) => {
      if (method === 'files.stat') return params.rel === 'missing.bin' ? null : info;
      if (method === 'files.list') {
        if (params.prefix === 'big') throw { message: 'more than 10000 files under big: list a smaller folder', code: 'too_many' };
        return [info];
      }
      if (method === 'files.delete') return { deleted: params.recursive ? 3 : 1 };
      return null;
    });
    expect(await ws.files.stat('meshes/wing.stl')).toEqual(info);
    expect(await ws.files.stat('missing.bin')).toBeNull();
    expect(await ws.files.list()).toEqual([info]);
    expect(posts.at(-1)?.params).toEqual({ prefix: '' });
    await expect(ws.files.list('big')).rejects.toMatchObject({
      code: 'too_many',
      message: 'more than 10000 files under big: list a smaller folder',
    });
    expect(await ws.files.delete('meshes', { recursive: true })).toEqual({ deleted: 3 });
    expect(posts.at(-1)?.params).toEqual({ rel: 'meshes', recursive: true });
    expect(await ws.files.delete('a.bin')).toEqual({ deleted: 1 });
    expect(posts.at(-1)?.params).toEqual({ rel: 'a.bin', recursive: false });
  });
});

describe('ws.project.linkGeometry and linkedGeometry (host 1.5)', () => {
  it('sends the call with a token and the camera (1.6: the host keeps it in its page), keeps the callback in the page, and gives the page its progress', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const { ws, posts, push } = await open((method) => {
      if (method === 'project.linkGeometry') return new Promise((r) => (finish = r));
      if (method === 'project.linkedGeometry') return null;
      return undefined;
    });
    const stages: string[] = [];
    const p = ws.project.linkGeometry({
      shape: { rel: 'studies/st-1/x.bbrep', format: 'brep', sha256: SHA },
      sourceVersion: 3,
      basedOnRev: 1,
      view: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 },
      onProgress: (pr) => stages.push(`${pr.stage}${pr.ahead !== undefined ? `:${pr.ahead}` : ''}`),
    });
    await vi.waitFor(() => expect(methods(posts)).toContain('project.linkGeometry'));
    const sent = posts.find((q) => q.method === 'project.linkGeometry')!.params;
    expect(sent).toMatchObject({ shape: { rel: 'studies/st-1/x.bbrep', format: 'brep', sha256: SHA }, sourceVersion: 3, basedOnRev: 1 });
    expect(sent.view).toEqual({ position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 });
    expect(sent.onProgress).toBeUndefined();
    expect(typeof sent.token).toBe('string');
    push({ event: 'linkProgress', data: { token: sent.token, stage: 'queued', ahead: 2 } });
    push({ event: 'linkProgress', data: { token: 'another-call', stage: 'meshing' } });
    push({ event: 'linkProgress', data: { token: sent.token, stage: 'saving' } });
    finish({ geometryId: 'g1', rev: 2, change: 'shape' });
    await expect(p).resolves.toMatchObject({ geometryId: 'g1', rev: 2 });
    expect(stages).toEqual(['queued:2', 'saving']);
    expect(await ws.project.linkedGeometry()).toBeNull();
  });

  it("asks the host for this study's geometry events once, when the page first listens", async () => {
    const { ws, posts, push } = await open(() => ({ ok: true }));
    const seen: unknown[] = [];
    ws.on('geometry', (g) => seen.push(g));
    ws.on('geometry', () => undefined);
    await vi.waitFor(() => expect(methods(posts).filter((m) => m === 'project.followGeometry')).toHaveLength(1));
    push({ event: 'geometry', data: { geometryId: 'g1', rev: 4, fromRev: 3 } });
    expect(seen).toEqual([{ geometryId: 'g1', rev: 4, fromRev: 3 }]);
  });
});

describe('ws.nav.onLeave (host 1.6, gate:l3-guard)', () => {
  const VIEW = { position: [400, 15, 15], target: [0, 15, 15], up: [0, 0, 1], projection: 'orthographic', height: 100 } as const;

  it('registers the hook; on `leave` it runs with the reason, a signal and progress, and sends its end with the camera', async () => {
    const { ws, posts, push } = await open(() => ({ ok: true }));
    const seen: string[] = [];
    await ws.nav.onLeave(async ({ reason, signal, progress }) => {
      seen.push(reason);
      expect(signal.aborted).toBe(false);
      progress(0.25, 'Exporting the design');
      progress(Number.NaN);
      return { view: { ...VIEW, position: [400, 15, 15] } };
    });
    expect(posts.find((p) => p.method === 'nav.leaveHook')?.params).toEqual({ on: true });
    push({ event: 'leave', data: { leave: 'leave-1', reason: 'frame-back' } });
    await vi.waitFor(() => expect(methods(posts)).toContain('nav.leaveDone'));
    expect(seen).toEqual(['frame-back']);
    expect(posts.filter((p) => p.method === 'nav.leaveProgress').map((p) => p.params)).toEqual([
      { leave: 'leave-1', fraction: 0.25, label: 'Exporting the design' },
      { leave: 'leave-1', fraction: null },
    ]);
    expect(posts.find((p) => p.method === 'nav.leaveDone')?.params).toEqual({ leave: 'leave-1', ok: true, view: { ...VIEW, position: [400, 15, 15] } });
  });

  it('a throw ends the leave ok:false with its message; leaveAbort aborts the signal; null clears the hook', async () => {
    const { ws, posts, push } = await open(() => ({ ok: true }));
    let aborted: AbortSignal | null = null;
    await ws.nav.onLeave(async ({ reason, signal }) => {
      if (reason === 'home') throw new Error('The export failed');
      aborted = signal;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
      return undefined;
    });
    push({ event: 'leave', data: { leave: 'leave-1', reason: 'home' } });
    await vi.waitFor(() => expect(posts.filter((p) => p.method === 'nav.leaveDone')).toHaveLength(1));
    expect(posts.filter((p) => p.method === 'nav.leaveDone')[0].params).toEqual({ leave: 'leave-1', ok: false, message: 'The export failed' });
    push({ event: 'leave', data: { leave: 'leave-2', reason: 'back' } });
    await vi.waitFor(() => expect(aborted).not.toBeNull());
    push({ event: 'leaveAbort', data: { leave: 'leave-2' } });
    await vi.waitFor(() => expect(posts.filter((p) => p.method === 'nav.leaveDone')).toHaveLength(2));
    expect((aborted as unknown as AbortSignal).aborted).toBe(true);
    await ws.nav.onLeave(null);
    expect(posts.filter((p) => p.method === 'nav.leaveHook').map((p) => p.params)).toEqual([{ on: true }, { on: false }]);
    // With no hook a leave is done at once.
    push({ event: 'leave', data: { leave: 'leave-3', reason: 'back' } });
    await vi.waitFor(() => expect(posts.filter((p) => p.method === 'nav.leaveDone')).toHaveLength(3));
    expect(posts.filter((p) => p.method === 'nav.leaveDone')[2].params).toEqual({ leave: 'leave-3', ok: true });
  });

  it('a host before 1.6 refuses it with not_allowed, and nothing is registered', async () => {
    const { ws, posts, push } = await open((method) => {
      if (method === 'nav.leaveHook') throw Object.assign(new Error('not allowed: "nav.leaveHook"'), { code: 'not_allowed' });
      return { ok: true };
    });
    const handler = vi.fn();
    await expect(ws.nav.onLeave(handler)).rejects.toMatchObject({ code: 'not_allowed' });
    push({ event: 'leave', data: { leave: 'leave-1', reason: 'back' } });
    await vi.waitFor(() => expect(methods(posts)).toContain('nav.leaveDone'));
    expect(handler).not.toHaveBeenCalled();
    await expect(ws.nav.onLeave('nope' as never)).rejects.toThrow(TypeError);
  });
});

describe('ws.project.geometrySource and geometryFaces (host 1.7)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the file as a File with its name, hands the host a token, and gives the page its progress', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    let pushProgress: ((msg: Record<string, unknown>) => void) | null = null;
    const { ws, posts, push } = await open(async (method, params) => {
      if (method !== 'project.geometrySource') return undefined;
      pushProgress?.({ event: 'sourceProgress', data: { token: params.token, done: 2, total: 4 } });
      pushProgress?.({ event: 'sourceProgress', data: { token: 'someone-else', done: 9, total: 9 } });
      return { geometryId: 'g1', blob, fileName: 'box.step', format: 'step', size: 4, sha256: SHA, adopted: false };
    });
    pushProgress = push;
    const seen: Array<[number, number]> = [];
    const src = await ws.project.geometrySource({ onProgress: (done, total) => seen.push([done, total]) });
    expect(src.file).toBeInstanceOf(File);
    expect(src.file.name).toBe('box.step');
    expect(new Uint8Array(await src.file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(src).toMatchObject({ geometryId: 'g1', format: 'step', size: 4, sha256: SHA, adopted: false });
    expect(posts[0].method).toBe('project.geometrySource');
    expect(posts[0].params).toMatchObject({ formats: ['step'] });
    expect(typeof posts[0].params.token).toBe('string');
    expect(seen).toEqual([[2, 4]]);
  });

  it('a refusal keeps its code and retryAfter; an abort stops the host read and rejects at once', async () => {
    const { ws, posts } = await open((method) => {
      if (method === 'project.geometrySource') throw Object.assign(new Error('Magnusim is still storing box.'), { code: 'not_ready', retryAfter: 3 });
      return { ok: true };
    });
    const err = (await ws.project.geometrySource().catch((e) => e)) as Error & { code?: string; retryAfter?: number };
    expect(err.message).toBe('Magnusim is still storing box.');
    expect(err.code).toBe('not_ready');
    expect(err.retryAfter).toBe(3);
    const ctl = new AbortController();
    ctl.abort(new DOMException('stop', 'AbortError'));
    await expect(ws.project.geometrySource({ signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // Already aborted: nothing was asked of the host.
    expect(posts.filter((p) => p.method === 'project.geometrySource')).toHaveLength(1);
    const late = new AbortController();
    const { ws: ws2, posts: posts2 } = await open((method) => (method === 'project.geometrySource' ? new Promise(() => undefined) : { ok: true }));
    const p = ws2.project.geometrySource({ signal: late.signal });
    late.abort();
    await expect(p).rejects.toBeTruthy();
    await vi.waitFor(() => expect(posts2.map((x) => x.method)).toContain('project.geometrySourceAbort'));
    expect(posts2.find((x) => x.method === 'project.geometrySourceAbort')?.params.token).toBe(posts2[0].params.token);
  });

  it('geometryFaces answers the host; linkGeometry passes originalNames as given', async () => {
    const table = { geometryId: 'g1', rev: 0, lengthUnit: 'mm', sourceSha256: SHA, bodies: [], faces: [] };
    const { ws, posts } = await open((method) => (method === 'project.geometryFaces' ? table : method === 'project.linkGeometry' ? { change: 'shape' } : undefined));
    expect(await ws.project.geometryFaces()).toEqual(table);
    await ws.project.linkGeometry({
      shape: { rel: 'studies/st-1/a.bbrep', format: 'brep', sha256: SHA },
      originalNames: { rel: 'studies/st-1/original_names.json', sha256: SHA },
      sourceVersion: 1,
      basedOnRev: null,
    });
    expect(posts[1].params).toMatchObject({ originalNames: { rel: 'studies/st-1/original_names.json', sha256: SHA } });
  });

  it('the SDK says 1.4.0', () => {
    expect(SDK_VERSION).toBe('1.4.0');
  });
});

describe('ws.assistant (unreleased, next host minor 1.9)', () => {
  const SCHEMA = { type: 'object', properties: { by: { type: 'integer', minimum: -100, maximum: 100 } }, required: ['by'], additionalProperties: false } as const;
  const ADD: AssistantTool = { name: 'add', description: 'Adds `by` to the counter.', inputSchema: SCHEMA, risk: 'edit' };
  const RESET: AssistantTool = { name: 'reset', description: 'Sets the counter to 0.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, risk: 'destructive' };
  const results = (posts: Post[]) => posts.filter((p) => p.method === 'assistant.result').map((p) => p.params);
  /** The results by call id (calls end in any order). */
  const byCall = (posts: Post[]) => Object.fromEntries(results(posts).map((r) => [String(r.call), r]));
  /** A host that takes every tool it is offered. */
  const accepting: Reply = (method, params) =>
    method === 'assistant.register' ? { available: true, accepted: (params.tools as Array<{ name: string }>).map((t) => t.name), refused: [] } : { ok: true };
  const invoke = (push: (msg: Record<string, unknown>) => void, call: string, tool = 'add', input: unknown = { by: 2 }) =>
    push({ event: 'assistantInvoke', data: { call, turn: 'turn-1', tool, input } });

  it('is there (feature-detect it), and the SDK still says 1.4.0', async () => {
    const { ws } = await open(accepting);
    expect(typeof ws.assistant?.register).toBe('function');
    expect(SDK_VERSION).toBe('1.4.0');
  });

  it('register sends only the fields the host reads, and awaits the host before it keeps the handler', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const { ws, posts, push } = await open((method) => (method === 'assistant.register' ? new Promise((r) => (answer = r)) : { ok: true }));
    const handler = vi.fn(async () => 'Counter is 2');
    const mine = { ...ADD, title: 'Add to the counter', timeoutS: 30, draw: () => 1 } as AssistantTool;
    const reg = ws.assistant!.register([mine], handler, { guide: 'Counter notes' });
    await vi.waitFor(() => expect(methods(posts)).toContain('assistant.register'));
    expect(posts[0].params).toEqual({
      tools: [{ name: 'add', description: 'Adds `by` to the counter.', inputSchema: SCHEMA, risk: 'edit', title: 'Add to the counter', timeoutS: 30 }],
      guide: 'Counter notes',
    });
    // The host has not answered: a call meanwhile finds no tool.
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toEqual({ call: 'ai-1', ok: false, error: { code: 'no_tool', message: 'This page has no tool named "add".' } });
    expect(handler).not.toHaveBeenCalled();
    answer({ available: true, accepted: ['add'], refused: [] });
    await expect(reg).resolves.toEqual({ available: true, accepted: ['add'], refused: [] });
    invoke(push, 'ai-2');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(2));
    expect(results(posts)[1]).toEqual({ call: 'ai-2', ok: true, result: { text: 'Counter is 2' } });
  });

  it('register sends a review (rounds and prompt only) when asked for one, and none otherwise', async () => {
    const { ws, posts } = await open(accepting);
    await ws.assistant!.register([ADD], vi.fn(), { guide: 'g', review: { rounds: 3, prompt: 'Look again.', extra: true } as unknown as { rounds: number; prompt: string } });
    await ws.assistant!.register([ADD], vi.fn(), { guide: 'g' });
    const sent = posts.filter((p) => p.method === 'assistant.register').map((p) => p.params);
    expect(sent[0].review).toEqual({ rounds: 3, prompt: 'Look again.' });
    expect(Object.hasOwn(sent[1], 'review')).toBe(false);
  });

  it("register sends a tool's confirm note (what the app's question says a destructive call does) only when it has one", async () => {
    const { ws, posts } = await open(accepting);
    const note = 'Sets the counter to 0; add can bring it back.';
    await ws.assistant!.register([{ ...RESET, confirm: note }, ADD], vi.fn());
    const sent = posts.find((p) => p.method === 'assistant.register')!.params.tools as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({ ...RESET, confirm: note });
    expect(Object.hasOwn(sent[1], 'confirm')).toBe(false);
  });

  it('the handler gets the call, turn, tool, input, a signal and progress; its result goes back as {text, data, images}', async () => {
    const { ws, posts, push } = await open(accepting);
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const seen: Array<Record<string, unknown>> = [];
    await ws.assistant!.register([ADD, RESET], async (c) => {
      seen.push({ call: c.call, turn: c.turn, tool: c.tool, input: c.input, aborted: c.signal.aborted });
      if (c.tool === 'reset') return undefined;
      c.progress(1.7, 'Adding');
      c.progress(Number.NaN);
      return { text: 'Counter is 2', data: { count: 2 }, images: [{ mediaType: 'image/png', data: png }], extra: 'left out' } as never;
    });
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(seen).toEqual([{ call: 'ai-1', turn: 'turn-1', tool: 'add', input: { by: 2 }, aborted: false }]);
    expect(posts.filter((p) => p.method === 'assistant.progress').map((p) => p.params)).toEqual([
      { call: 'ai-1', fraction: 1, label: 'Adding' },
      { call: 'ai-1', fraction: null },
    ]);
    expect(results(posts)[0]).toEqual({ call: 'ai-1', ok: true, result: { text: 'Counter is 2', data: { count: 2 }, images: [{ mediaType: 'image/png', data: png }] } });
    // Nothing returned: an empty result; an input that is not an object: {}. The same id
    // again while it runs runs once.
    invoke(push, 'ai-2', 'reset', 'junk');
    invoke(push, 'ai-2', 'reset', 'junk');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(2));
    expect(seen[1]).toMatchObject({ tool: 'reset', input: {} });
    expect(results(posts)[1]).toEqual({ call: 'ai-2', ok: true, result: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(2);
    expect(results(posts)).toHaveLength(2);
  });

  it('progress(…, {waiting: true}) says the call waits for the person: assistant.progress carries waiting only then', async () => {
    const { ws, posts, push } = await open(accepting);
    await ws.assistant!.register([ADD], async (c) => {
      c.progress(null, 'Waiting for you to close the panel', { waiting: true });
      c.progress(null, '', { waiting: true });
      c.progress(0.5, 'Adding', { waiting: false });
      c.progress(0.6, 'Adding', { waiting: 'yes' } as never);
      c.progress(0.7, 'Adding', null as never);
      c.progress(0.8);
      return 'Counter is 2';
    });
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(posts.filter((p) => p.method === 'assistant.progress').map((p) => p.params)).toEqual([
      { call: 'ai-1', fraction: null, label: 'Waiting for you to close the panel', waiting: true },
      { call: 'ai-1', fraction: null, waiting: true },
      { call: 'ai-1', fraction: 0.5, label: 'Adding' },
      { call: 'ai-1', fraction: 0.6, label: 'Adding' },
      { call: 'ai-1', fraction: 0.7, label: 'Adding' },
      { call: 'ai-1', fraction: 0.8 },
    ]);
  });

  it('assistantAbort aborts the signal; progress after it is not sent', async () => {
    const { ws, posts, push } = await open(accepting);
    let signal: AbortSignal | null = null;
    let progress: ((f: number | null, l?: string) => void) | null = null;
    await ws.assistant!.register([ADD], (c) => {
      signal = c.signal;
      progress = c.progress;
      return new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    });
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(signal).not.toBeNull());
    push({ event: 'assistantAbort', data: { call: 'ai-other' } });
    expect((signal as unknown as AbortSignal).aborted).toBe(false);
    push({ event: 'assistantAbort', data: { call: 'ai-1' } });
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    (progress as unknown as (f: number | null, l?: string) => void)(0.5, 'too late');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toEqual({ call: 'ai-1', ok: false, error: { code: 'failed', message: 'The call was stopped' } });
    expect(methods(posts)).not.toContain('assistant.progress');
  });

  it('available:false commits nothing: the earlier tools and handler stay; [] with null withdraws them', async () => {
    let next: unknown = null;
    const { ws, posts, push } = await open((method, params) => (method === 'assistant.register' && next ? next : accepting(method, params)));
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    await ws.assistant!.register([ADD], first);
    next = { available: false, accepted: [], refused: [], reason: 'not_connected' };
    expect(await ws.assistant!.register([RESET], second)).toEqual({ available: false, accepted: [], refused: [], reason: 'not_connected' });
    invoke(push, 'ai-1');
    invoke(push, 'ai-2', 'reset', {});
    await vi.waitFor(() => expect(results(posts)).toHaveLength(2));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(byCall(posts)).toEqual({
      'ai-1': { call: 'ai-1', ok: true, result: { text: 'first' } },
      'ai-2': { call: 'ai-2', ok: false, error: { code: 'no_tool', message: 'This page has no tool named "reset".' } },
    });
    next = null;
    expect(await ws.assistant!.register([], null)).toEqual({ available: true, accepted: [], refused: [] });
    invoke(push, 'ai-3');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(3));
    expect(byCall(posts)['ai-3']).toMatchObject({ ok: false, error: { code: 'no_tool' } });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("a tool the host refused, or no handler at all, answers no_tool; only the last register's answer is kept", async () => {
    const answers: Array<(v: unknown) => void> = [];
    const { ws, posts, push } = await open((method) => (method === 'assistant.register' ? new Promise((r) => answers.push(r)) : { ok: true }));
    // No register yet.
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toMatchObject({ ok: false, error: { code: 'no_tool' } });
    const older = vi.fn(async () => 'older');
    const newer = vi.fn(async () => 'newer');
    const one = ws.assistant!.register([ADD, RESET], older);
    const two = ws.assistant!.register([ADD, RESET], newer);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]({ available: true, accepted: ['add'], refused: [{ name: 'reset', code: 'schema', message: 'no properties' }] });
    await two;
    // The first answer comes last: it is returned, not kept.
    answers[0]({ available: true, accepted: ['add', 'reset'], refused: [] });
    expect((await one).accepted).toEqual(['add', 'reset']);
    invoke(push, 'ai-2');
    invoke(push, 'ai-3', 'reset', {});
    await vi.waitFor(() => expect(results(posts)).toHaveLength(3));
    expect(byCall(posts)['ai-2']).toEqual({ call: 'ai-2', ok: true, result: { text: 'newer' } });
    expect(byCall(posts)['ai-3']).toEqual({ call: 'ai-3', ok: false, error: { code: 'no_tool', message: 'This page has no tool named "reset".' } });
    expect(older).not.toHaveBeenCalled();
  });

  it('a register that could not be copied never reached the host: the one before it is still the last one', async () => {
    const answers: Array<(v: unknown) => void> = [];
    const { ws, posts, push } = await open((method) => (method === 'assistant.register' ? new Promise((r) => answers.push(r)) : { ok: true }), { clone: true });
    const first = vi.fn(async () => 'first');
    const one = ws.assistant!.register([ADD], first);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const uncopyable = { ...ADD, inputSchema: { ...SCHEMA, check: () => true } } as unknown as AssistantTool;
    const err = await ws.assistant!.register([uncopyable], vi.fn()).catch((e: unknown) => e);
    expect((err as Error).name).toBe('DataCloneError');
    expect(methods(posts)).toEqual(['assistant.register']);
    answers[0]({ available: true, accepted: ['add'], refused: [] });
    await one;
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toEqual({ call: 'ai-1', ok: true, result: { text: 'first' } });
  });

  it('a host without it refuses with not_allowed: register rejects and nothing is kept', async () => {
    const { ws, posts, push } = await open((method) => {
      if (method === 'assistant.register') throw Object.assign(new Error('not allowed: "assistant.register"'), { code: 'not_allowed' });
      return { ok: true };
    });
    const handler = vi.fn();
    await expect(ws.assistant!.register([ADD], handler)).rejects.toMatchObject({ code: 'not_allowed' });
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toMatchObject({ ok: false, error: { code: 'no_tool' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses wrong arguments with a TypeError before asking the host', async () => {
    const { ws, posts } = await open(accepting);
    await expect(ws.assistant!.register('add' as never, vi.fn())).rejects.toThrow(TypeError);
    await expect(ws.assistant!.register([ADD], null)).rejects.toThrow(TypeError);
    await expect(ws.assistant!.register([ADD], 'run' as never)).rejects.toThrow(TypeError);
    expect(() => ws.assistant!.onTurn('listen' as never)).toThrow(TypeError);
    await expect(ws.assistant!.stop('' as never)).rejects.toThrow(TypeError);
    await expect(ws.assistant!.stop(5 as never)).rejects.toThrow(TypeError);
    expect(methods(posts)).toEqual([]);
  });

  it("onTurn hears the host's assistantTurn events until it is stopped: each listener its own copy, one that throws leaves the others", async () => {
    const { ws, push } = await open(accepting);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const turn = {
      id: 't-1',
      state: 'running',
      title: 'Add 2 to the counter',
      local: true,
      contextTokens: 32768,
      images: false,
      used: { steps: 1, stepsCap: 50, changes: 0, changesCap: 0, usd: 0, usdCap: 3 },
    };
    const first: unknown[] = [];
    const second: unknown[] = [];
    const off = ws.assistant!.onTurn((t) => {
      first.push(t);
      t.used.steps = 99;
      throw new Error('a listener broke');
    });
    ws.assistant!.onTurn((t) => second.push(t));
    push({ event: 'assistantTurn', data: turn });
    expect(first).toHaveLength(1);
    expect(second).toEqual([turn]);
    expect(warn).toHaveBeenCalledWith('[workspace] assistant.onTurn', expect.any(Error));
    off();
    const ended = { ...turn, state: 'ended', end: { state: 'done', reason: 'end_turn' } };
    push({ event: 'assistantTurn', data: ended });
    // Not a turn at all: nobody hears it.
    push({ event: 'assistantTurn', data: 'turn' });
    expect(first).toHaveLength(1);
    expect(second).toEqual([turn, ended]);
  });

  it('stop asks the host for that turn and answers {stopped} or {stopped:false, reason}; a host without the call answers not_allowed; another refusal rejects', async () => {
    const answers: Record<string, unknown> = { 't-1': { stopped: true }, 't-2': { stopped: false, reason: 'not_this_tab' }, 't-3': { stopped: false } };
    const { ws, posts } = await open((method, params) => {
      if (method !== 'assistant.stop') return accepting(method, params);
      if (params.turn === 't-4') throw Object.assign(new Error('bad parameter: turn'), { code: 'bad_request' });
      return answers[String(params.turn)];
    });
    expect(await ws.assistant!.stop('t-1')).toEqual({ stopped: true });
    expect(await ws.assistant!.stop('t-2')).toEqual({ stopped: false, reason: 'not_this_tab' });
    expect(await ws.assistant!.stop('t-3')).toEqual({ stopped: false, reason: 'failed' });
    await expect(ws.assistant!.stop('t-4')).rejects.toMatchObject({ code: 'bad_request' });
    expect(posts.filter((p) => p.method === 'assistant.stop').map((p) => p.params)).toEqual([{ turn: 't-1' }, { turn: 't-2' }, { turn: 't-3' }, { turn: 't-4' }]);
    const older = await open((method) => {
      throw Object.assign(new Error(`not allowed: ${JSON.stringify(method)}`), { code: 'not_allowed' });
    });
    expect(await older.ws.assistant!.stop('t-1')).toEqual({ stopped: false, reason: 'not_allowed' });
  });

  it('docked says whether the host has its Assistant panel: false on a host whose welcome says nothing', async () => {
    expect((await open(accepting)).ws.assistant!.docked).toBe(false);
    expect((await open(accepting, { context: { assistantDock: false } })).ws.assistant!.docked).toBe(false);
    expect((await open(accepting, { context: { assistantDock: true } })).ws.assistant!.docked).toBe(true);
  });

  it('setUndo sends {turn, label} and answers {offered} or {offered:false, reason}; a host without the call answers not_allowed; it checks its arguments', async () => {
    const { ws, posts } = await open((method, params) => {
      if (method !== 'assistant.undoable') return accepting(method, params);
      if (params.turn === 't-9') throw Object.assign(new Error('bad parameter: turn'), { code: 'bad_request' });
      if (params.label === null) return { offered: false };
      return params.turn === 't-1' ? { offered: true } : { offered: false, reason: 'not_this_tab' };
    });
    expect(await ws.assistant!.setUndo('t-1', 'Assistant: add 2')).toEqual({ offered: true });
    expect(await ws.assistant!.setUndo('t-2', 'Assistant: add 3')).toEqual({ offered: false, reason: 'not_this_tab' });
    expect(await ws.assistant!.setUndo('t-1', null)).toEqual({ offered: false });
    await expect(ws.assistant!.setUndo('t-9', 'x')).rejects.toMatchObject({ code: 'bad_request' });
    expect(posts.filter((p) => p.method === 'assistant.undoable').map((p) => p.params)).toEqual([
      { turn: 't-1', label: 'Assistant: add 2' },
      { turn: 't-2', label: 'Assistant: add 3' },
      { turn: 't-1', label: null },
      { turn: 't-9', label: 'x' },
    ]);
    await expect(ws.assistant!.setUndo('' as never, 'x')).rejects.toThrow(TypeError);
    await expect(ws.assistant!.setUndo('t-1', 5 as never)).rejects.toThrow(TypeError);
    await expect(ws.assistant!.setUndo('t-1', undefined as never)).rejects.toThrow(TypeError);
    expect(posts.filter((p) => p.method === 'assistant.undoable')).toHaveLength(4);
    const older = await open((method) => {
      throw Object.assign(new Error(`not allowed: ${JSON.stringify(method)}`), { code: 'not_allowed' });
    });
    expect(await older.ws.assistant!.setUndo('t-1', 'x')).toEqual({ offered: false, reason: 'not_allowed' });
  });

  it("onUndo: the host's assistantUndo runs the handler and its answer goes back as assistant.undone; no handler, a throw and a bad answer say so; a newer handler replaces it, and its off clears only itself", async () => {
    const { ws, posts, push } = await open(accepting);
    const undone = () => posts.filter((p) => p.method === 'assistant.undone').map((p) => p.params);
    const ask = (req: string, turn = 't-1') => push({ event: 'assistantUndo', data: { req, turn } });
    ask('undo-1');
    await vi.waitFor(() => expect(undone()).toHaveLength(1));
    expect(undone()[0]).toEqual({ req: 'undo-1', undone: false, reason: 'no_handler' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers: unknown[] = [{ undone: true }, { undone: false, reason: 'not_newest' }, { undone: false }, 'yes', null];
    let i = 0;
    const first = vi.fn(async () => answers[i++]);
    const offFirst = ws.assistant!.onUndo(first);
    for (let n = 2; n <= 6; n++) ask(`undo-${n}`);
    await vi.waitFor(() => expect(undone()).toHaveLength(6));
    expect(first.mock.calls).toEqual([['t-1'], ['t-1'], ['t-1'], ['t-1'], ['t-1']]);
    const byReq = Object.fromEntries(undone().map((u) => [u.req, u]));
    expect([2, 3, 4, 5, 6].map((n) => byReq[`undo-${n}`])).toEqual([
      { req: 'undo-2', undone: true },
      { req: 'undo-3', undone: false, reason: 'not_newest' },
      { req: 'undo-4', undone: false, reason: 'failed' },
      { req: 'undo-5', undone: false, reason: 'failed' },
      { req: 'undo-6', undone: false, reason: 'failed' },
    ]);
    // A throw (sync too) is failed; a newer handler replaces it, and the older one's off leaves it.
    const second = vi.fn((): never => {
      throw new Error('the undo broke');
    });
    ws.assistant!.onUndo(second);
    offFirst();
    ask('undo-7');
    await vi.waitFor(() => expect(undone()).toHaveLength(7));
    expect(undone()[6]).toEqual({ req: 'undo-7', undone: false, reason: 'failed' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[workspace] assistant.onUndo', expect.any(Error));
    // Not an ask: nothing runs; null clears the handler.
    push({ event: 'assistantUndo', data: { turn: 't-1' } });
    push({ event: 'assistantUndo', data: { req: 'undo-8' } });
    ws.assistant!.onUndo(null);
    ask('undo-9');
    await vi.waitFor(() => expect(undone()).toHaveLength(8));
    expect(undone()[7]).toEqual({ req: 'undo-9', undone: false, reason: 'no_handler' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(() => ws.assistant!.onUndo('undo' as never)).toThrow(TypeError);
  });

  it('onUndo: a handler that does not answer within 10 s answers no_answer', async () => {
    const { ws, posts, push } = await open(accepting);
    ws.assistant!.onUndo(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    push({ event: 'assistantUndo', data: { req: 'undo-1', turn: 't-1' } });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(posts.filter((p) => p.method === 'assistant.undone')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(posts.filter((p) => p.method === 'assistant.undone').map((p) => p.params)).toEqual([{ req: 'undo-1', undone: false, reason: 'no_answer' }]));
  });

  it("Ctrl+/ (Cmd+/) in the page goes to the app's panel as assistant.dock, once the key is through: not when the page kept it (preventDefault), not with other keys, and not on a host without the panel", async () => {
    const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };
    const plain = await open(accepting);
    const docked = await open(accepting, { context: { assistantDock: true } });
    const docks = (p: { posts: Post[] }) => p.posts.filter((x) => x.method === 'assistant.dock');
    key({ key: '/', code: 'Slash', ctrlKey: true });
    await vi.waitFor(() => expect(docks(docked)).toHaveLength(1));
    expect(docks(docked)[0].params).toEqual({});
    key({ key: '/', code: 'Slash', metaKey: true });
    await vi.waitFor(() => expect(docks(docked)).toHaveLength(2));
    // A page that keeps the key for itself keeps it.
    const own = (e: KeyboardEvent) => e.preventDefault();
    document.body.addEventListener('keydown', own);
    key({ key: '/', code: 'Slash', ctrlKey: true });
    document.body.removeEventListener('keydown', own);
    // Not Ctrl+/: a slash alone, Ctrl+Shift+/, Ctrl+Alt+/, Ctrl+Z, a held key, a key while composing.
    key({ key: '/', code: 'Slash' });
    key({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true });
    key({ key: '/', code: 'Slash', ctrlKey: true, altKey: true });
    key({ key: 'z', code: 'KeyZ', ctrlKey: true });
    key({ key: '/', code: 'Slash', ctrlKey: true, repeat: true });
    key({ key: '/', code: 'Slash', ctrlKey: true, isComposing: true });
    // The key that types "/" counts, wherever it is; another layout's Slash key that types "-" does not (Ctrl+- zooms).
    key({ key: '-', code: 'Slash', ctrlKey: true });
    key({ key: '/', code: 'Digit7', ctrlKey: true });
    await vi.waitFor(() => expect(docks(docked)).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(docks(docked)).toHaveLength(3);
    expect(docks(plain)).toHaveLength(0);
  });

  it('a throw keeps its code only from the page list (invalid_input, busy, not_ready, failed); anything else is failed', async () => {
    const { ws, posts, push } = await open(accepting);
    const thrown: unknown[] = [
      Object.assign(new Error('by must not be 0'), { code: 'invalid_input' }),
      Object.assign(new Error('A sketch is open'), { code: 'busy' }),
      Object.assign(new Error('Still loading'), { code: 'not_ready' }),
      Object.assign(new Error('Spoofed'), { code: 'plugin_off' }),
      Object.assign(new Error('Also spoofed'), { code: 'capped' }),
      'a plain string',
      undefined,
    ];
    let i = 0;
    await ws.assistant!.register([ADD], () => {
      throw thrown[i++];
    });
    for (let n = 1; n <= thrown.length; n++) invoke(push, `ai-${n}`);
    await vi.waitFor(() => expect(results(posts)).toHaveLength(thrown.length));
    expect(Array.from({ length: thrown.length }, (_, k) => byCall(posts)[`ai-${k + 1}`].error)).toEqual([
      { code: 'invalid_input', message: 'by must not be 0' },
      { code: 'busy', message: 'A sketch is open' },
      { code: 'not_ready', message: 'Still loading' },
      { code: 'failed', message: 'Spoofed' },
      { code: 'failed', message: 'Also spoofed' },
      { code: 'failed', message: 'a plain string' },
      { code: 'failed', message: 'The tool failed.' },
    ]);
  });

  it("a throw's hint (text, cut to 500) and detail (as JSON makes it) go with its error; a result's summary goes with the result", async () => {
    const { ws, posts, push } = await open(accepting, { clone: true });
    const detail = { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3] };
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const getterThrows = Object.defineProperty(new Error('Odd'), 'hint', {
      get() {
        throw new Error('no hint');
      },
    });
    const thrown: unknown[] = [
      Object.assign(new Error('step_too_big: at most 3.'), { code: 'invalid_input', hint: 'Use 1, 2 or 3.', detail }),
      Object.assign(new Error('Long'), { hint: 'h'.repeat(600) }),
      // Only text is a hint; a detail with no JSON form (a cycle, a function), or null, goes without.
      Object.assign(new Error('Not text'), { hint: 42, detail: cycle }),
      Object.assign(new Error('No form'), { hint: '', detail: () => 1 }),
      Object.assign(new Error('Null'), { detail: null }),
      // What JSON makes of it: a Date as its text, a function and undefined left out, NaN as null.
      Object.assign(new Error('Copied'), { detail: { at: new Date(0), f: () => 1, u: undefined, n: Number.NaN } }),
      getterThrows,
    ];
    let i = 0;
    await ws.assistant!.register([ADD, RESET], (c) => {
      if (c.tool === 'reset') return { text: 'Counter is 0', summary: 'Reset: the counter is 0' };
      throw thrown[i++];
    });
    for (let n = 1; n <= thrown.length; n++) invoke(push, `ai-${n}`);
    invoke(push, 'ai-ok', 'reset', {});
    await vi.waitFor(() => expect(results(posts)).toHaveLength(thrown.length + 1));
    expect(Array.from({ length: thrown.length }, (_, k) => byCall(posts)[`ai-${k + 1}`].error)).toEqual([
      { code: 'invalid_input', message: 'step_too_big: at most 3.', hint: 'Use 1, 2 or 3.', detail },
      { code: 'failed', message: 'Long', hint: 'h'.repeat(500) },
      { code: 'failed', message: 'Not text' },
      { code: 'failed', message: 'No form' },
      { code: 'failed', message: 'Null' },
      { code: 'failed', message: 'Copied', detail: { at: '1970-01-01T00:00:00.000Z', n: null } },
      { code: 'failed', message: 'Odd' },
    ]);
    // Every error reached the host as a copy (none failed to clone).
    expect(byCall(posts)['ai-ok']).toEqual({ call: 'ai-ok', ok: true, result: { text: 'Counter is 0', summary: 'Reset: the counter is 0' } });
  });

  it('a result that cannot be copied to the host (DataCloneError) fails the call instead of never ending, and leaves no call waiting', async () => {
    const { ws, posts, push } = await open(accepting, { clone: true });
    // The SDK's calls waiting for the host's answer: the map that register's call goes into (the
    // only map given a number key while register runs up to its first await).
    const maps = new Set<Map<unknown, unknown>>();
    const set = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === 'number') maps.add(this);
      return set.call(this, key, value);
    });
    const registered = ws.assistant!.register([ADD], () => ({ text: 'ok', data: { redo: () => 1 } }));
    spy.mockRestore();
    expect(maps.size).toBe(1);
    const [waiting] = maps;
    expect(waiting.size).toBe(1);
    await registered;
    expect(waiting.size).toBe(0);
    invoke(push, 'ai-1');
    await vi.waitFor(() => expect(results(posts)).toHaveLength(1));
    expect(results(posts)[0]).toEqual({ call: 'ai-1', ok: false, error: { code: 'failed', message: expect.stringContaining('The result could not be sent to the app') } });
    // The copy that failed is not waiting for an answer that never comes; the one sent instead was answered.
    await vi.waitFor(() => expect(waiting.size).toBe(0));
  });
});
