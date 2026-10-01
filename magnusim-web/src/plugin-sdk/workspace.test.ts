import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, SDK_VERSION, type Workspace, type WorkspaceContext } from './workspace';

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
 */
async function open(reply: Reply): Promise<{ ws: Workspace; posts: Post[]; hello: ReturnType<typeof vi.fn> }> {
  const posts: Post[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    start() {},
    postMessage(msg: { id: number; method: string; params: Params }, ...rest: [Transferable[]?]) {
      const transfer = rest[0];
      const handedOver = !!transfer && transfer.includes(msg.params.data as Transferable);
      const got = transfer ? structuredClone(msg, { transfer }) : msg;
      posts.push({ method: got.method, params: got.params, args: 1 + rest.length, transfer, handedOver });
      Promise.resolve()
        .then(() => reply(got.method, got.params))
        .then(
          (result) => port.onmessage?.({ data: { id: got.id, result } }),
          (err: { message?: string; code?: string }) =>
            port.onmessage?.({ data: { id: got.id, error: { message: err.message, code: err.code } } }),
        );
    },
  };
  const parent = {
    postMessage: vi.fn((msg: { magnusim?: string; instance?: string }) => {
      if (msg.magnusim !== 'hello') return;
      const welcome = new Event('message');
      Object.defineProperties(welcome, {
        source: { value: parent },
        data: { value: { magnusim: 'welcome', instance: msg.instance, context: CONTEXT } },
        ports: { value: [port] },
      });
      window.dispatchEvent(welcome);
    }),
  };
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
  const ws = await connect({ timeoutMs: 1000 });
  return { ws, posts, hello: parent.postMessage };
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
    expect(SDK_VERSION).toBe('1.1.0');
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
