import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyRecord } from '../plugin-sdk/workspace';
import {
  BridgeError,
  cleanDirtyMessage,
  DIRTY_MESSAGE_MAX,
  THEME,
  WorkspaceBridge,
  WorkspaceCalls,
  type BridgeHooks,
  type BridgeScope,
} from './bridge';

const SCOPE: BridgeScope = {
  plugin: 'ws-demo',
  pluginName: 'Workspace demo',
  workspace: 'bench',
  projectId: 'proj-a',
  projectTitle: 'Project A',
  studyId: 'st-1',
};

const STUDY = { id: 'st-1', kind: 'bench_case', title: 'Wing', rev: 3 } as unknown as StudyRecord;
const UPLOADING = 'A file upload has not finished.';

type Call = { url: string; method: string; body: unknown };
type Answer = { status: number; body: unknown } | Response;
let calls: Call[] = [];
// Each fetch's init, beside its call (headers, keepalive).
let inits: RequestInit[] = [];
let answer: (url: string, method: string, init: RequestInit) => Answer | Promise<Answer> = () => ({ status: 200, body: { ok: true } });

function hooks(): BridgeHooks & Record<string, ReturnType<typeof vi.fn>> {
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
  };
}

beforeEach(() => {
  calls = [];
  inits = [];
  answer = (url) => {
    if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
    if (url === '/api/jobs') return { status: 200, body: { ok: true, job: { id: 'job-1' } } };
    return { status: 200, body: { ok: true } };
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      // JSON bodies are parsed; raw ones (a file's chunk) are kept as they came.
      calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? undefined) });
      inits.push(init);
      const a = await answer(url, method, init);
      return a instanceof Response ? a : new Response(JSON.stringify(a.body), { status: a.status });
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
    expect(await c.handle('nav.back', {})).toEqual({ ok: true, left: true });
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('nav.back tells the page whether the workspace was left', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    h.back.mockResolvedValueOnce(false);
    expect(await c.handle('nav.back', {})).toEqual({ ok: true, left: false });
    expect(await c.handle('nav.back', {})).toEqual({ ok: true, left: true });
    expect(h.back).toHaveBeenCalledTimes(2);
  });
});

describe('cleanDirtyMessage', () => {
  it('turns controls, line separators and bidi controls into spaces, collapses, trims and keeps 200 characters', () => {
    expect(DIRTY_MESSAGE_MAX).toBe(200);
    // C0 (NUL, bell, tab, newline, CR, escape, U+001F), then DEL and C1 (U+0080, NEL, U+009F).
    expect(cleanDirtyMessage('a\u0000b\u0007c\td\ne\r\nf\u001bg\u001fh')).toBe('a b c d e f g h');
    expect(cleanDirtyMessage('a\u007fb\u0080c\u0085d\u009fe')).toBe('a b c d e');
    expect(cleanDirtyMessage('one\u{2028}two\u{2029}three')).toBe('one two three');
    // A bidi control cannot reorder the text around it.
    for (const cp of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(cleanDirtyMessage(`evil${String.fromCodePoint(cp)}txt.exe`)).toBe('evil txt.exe');
    }
    // Other whitespace (no-break and ideographic spaces) collapses too.
    expect(cleanDirtyMessage('  Chord \u{a0}  120 mm\u{3000} is not saved \n')).toBe('Chord 120 mm is not saved');
    expect(cleanDirtyMessage('\u{202e}\n\t \u0000')).toBe('');
    // Other text stays as it is, astral characters too.
    expect(cleanDirtyMessage('Profil “NACA 2412” — 120 mm ✓ 𝄞')).toBe('Profil “NACA 2412” — 120 mm ✓ 𝄞');
    expect(cleanDirtyMessage('x'.repeat(300))).toBe('x'.repeat(200));
    // The 200 are counted after cleaning.
    expect(cleanDirtyMessage(`${' \n\u{202e}'.repeat(100)}${'y'.repeat(250)}`)).toBe('y'.repeat(200));
    expect([cleanDirtyMessage(null), cleanDirtyMessage(undefined), cleanDirtyMessage(42)]).toEqual(['', '', '42']);
  });

  it('never throws: something that is not text becomes no message', () => {
    // As a structured clone over the port can deliver it: an object whose toString is no function.
    expect(cleanDirtyMessage({ toString: 1 })).toBe('');
    expect(
      cleanDirtyMessage({
        toString() {
          throw new Error('no');
        },
      }),
    ).toBe('');
  });
});

describe('WorkspaceCalls: unsaved work', () => {
  it('nav.setDirty is dirty only for true, cleans the message, and has no message when clean', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    for (const dirty of ['yes', 'true', 1, null, undefined, {}]) {
      expect(await c.handle('nav.setDirty', { dirty, message: 'Chord not saved' })).toEqual({ ok: true });
    }
    expect(await c.handle('nav.setDirty', { message: 'no flag' })).toEqual({ ok: true });
    expect(h.setDirty).not.toHaveBeenCalled();
    await c.handle('nav.setDirty', { dirty: true, message: `  Chord\n120 mm\u{202e} ${'x'.repeat(300)}` });
    expect(h.setDirty).toHaveBeenLastCalledWith(true, `Chord 120 mm ${'x'.repeat(187)}`);
    expect((h.setDirty.mock.calls.at(-1) as [boolean, string])[1].length).toBe(200);
    await c.handle('nav.setDirty', { dirty: 1, message: 'still not saved' });
    expect(h.setDirty).toHaveBeenLastCalledWith(false, '');
    await c.handle('nav.setDirty', { dirty: true });
    expect(h.setDirty).toHaveBeenLastCalledWith(true, '');
    expect(h.setDirty).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([]);
  });

  it('tells the host only when the state changes', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    const set = (dirty: unknown, message?: unknown) => c.handle('nav.setDirty', { dirty, message });
    await set(true, 'Chord not saved');
    await set(true, 'Chord not saved');
    // The same message once cleaned.
    await set(true, ' Chord\tnot \n saved ');
    await set(true, 'Span not saved');
    await set(false, 'Span not saved');
    await set(false);
    await set('no', 'Span not saved');
    await set(true, '');
    await set(true);
    expect(h.setDirty.mock.calls).toEqual([
      [true, 'Chord not saved'],
      [true, 'Span not saved'],
      [false, ''],
      [true, ''],
    ]);
  });

  it('nav.setDirty with a message that is not text keeps the flag it asked for', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    expect(await c.handle('nav.setDirty', { dirty: true, message: { toString: 1 } })).toEqual({ ok: true });
    expect(h.setDirty.mock.calls).toEqual([[true, '']]);
    expect(await c.handle('nav.setDirty', { dirty: false, message: { toString: 1 } })).toEqual({ ok: true });
    expect(h.setDirty.mock.calls).toEqual([
      [true, ''],
      [false, ''],
    ]);
  });

  it('close() makes a dirty page clean, once; a clean one says nothing', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    c.close();
    expect(h.setDirty).not.toHaveBeenCalled();
    await c.handle('nav.setDirty', { dirty: true, message: 'Chord not saved' });
    c.close();
    c.close();
    expect(h.setDirty.mock.calls).toEqual([
      [true, 'Chord not saved'],
      [false, ''],
    ]);
  });
});

describe('WorkspaceCalls: files in its own folder', () => {
  const UP = 'a1'.repeat(16);
  const INFO = { rel: 'meshes/wing.stl', size: 20, mtime: '2026-09-30T10:00:00.000Z', etag: '"1f-14-2a"' };
  const SHA = 'ab'.repeat(32);
  const bytesOf = (body: unknown) => (body instanceof Blob ? body.size : body instanceof ArrayBuffer ? body.byteLength : 0);
  let nextUpload = 0;

  /** The app's answers to /api/plugin-files, one upload id per begin after the first. */
  function filesApp(url: string, method: string, init: RequestInit): Answer {
    const path = url.split('?')[0];
    if (path === '/api/plugin-files/stat') return { status: 200, body: { ok: true, file: INFO } };
    if (path === '/api/plugin-files/list') return { status: 200, body: { ok: true, files: [INFO], truncated: false } };
    if (path === '/api/plugin-files/read') {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { ETag: INFO.etag, 'X-Magnusim-File-Size': '3' } });
    }
    if (path === '/api/plugin-files/uploads') {
      const upload = nextUpload++ ? `${UP.slice(0, 30)}${String(nextUpload).padStart(2, '0')}` : UP;
      return { status: 201, body: { ok: true, upload, chunk_bytes: 16, max_chunk_bytes: 32, expires_ms: 600000 } };
    }
    if (method === 'PUT') {
      const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset'));
      return { status: 200, body: { ok: true, received: offset + bytesOf(init.body) } };
    }
    if (path.endsWith('/commit')) return { status: 200, body: { ok: true, file: { ...INFO, sha256: SHA } } };
    if (path.endsWith('/abort')) return { status: 200, body: { ok: true, aborted: true } };
    if (path === '/api/plugin-files/delete') return { status: 200, body: { ok: true, deleted: 2 } };
    return { status: 500, body: { ok: false, error: `unexpected ${method} ${url}` } };
  }

  beforeEach(() => {
    nextUpload = 0;
    answer = filesApp;
  });

  it('are on the allowlist, and every fetch names its own plugin and project', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    const elsewhere = { project_id: 'proj-b' };
    expect(await c.handle('files.stat', { rel: 'meshes/wing.stl', ...elsewhere })).toEqual(INFO);
    expect(await c.handle('files.list', { prefix: 'meshes', plugin: 'ws-demo', ...elsewhere })).toEqual([INFO]);
    const read = (await c.handle('files.read', { rel: 'meshes/wing.stl', ...elsewhere })) as { blob: Blob; size: number; etag: string };
    expect([read.size, read.etag]).toEqual([3, INFO.etag]);
    expect(await c.handle('files.write.begin', { rel: 'meshes/wing.stl', size: 20, ifMatch: null, ...elsewhere })).toEqual({
      upload: UP,
      chunkBytes: 16,
    });
    const first = new ArrayBuffer(16);
    const rest = new Blob([new Uint8Array(4)]);
    expect(await c.handle('files.write.chunk', { upload: UP, offset: 0, data: first, ...elsewhere })).toEqual({ received: 16 });
    expect(await c.handle('files.write.chunk', { upload: UP, offset: 16, data: rest })).toEqual({ received: 20 });
    expect(await c.handle('files.write.commit', { upload: UP, sha256: SHA.toUpperCase(), ...elsewhere })).toEqual({ ...INFO, sha256: SHA });
    const again = (await c.handle('files.write.begin', { rel: 'b.bin', size: 1 })) as { upload: string };
    expect(await c.handle('files.write.abort', { upload: again.upload, ...elsewhere })).toEqual({ ok: true });
    expect(await c.handle('files.delete', { rel: 'meshes', recursive: true, ...elsewhere })).toEqual({ deleted: 2 });

    const scoped = { project_id: 'proj-a', plugin: 'ws-demo' };
    expect(calls).toEqual([
      { url: '/api/plugin-files/stat?project_id=proj-a&plugin=ws-demo&rel=meshes%2Fwing.stl', method: 'GET', body: undefined },
      { url: '/api/plugin-files/list?project_id=proj-a&plugin=ws-demo&prefix=meshes', method: 'GET', body: undefined },
      { url: '/api/plugin-files/read?project_id=proj-a&plugin=ws-demo&rel=meshes%2Fwing.stl', method: 'GET', body: undefined },
      { url: '/api/plugin-files/uploads', method: 'POST', body: { ...scoped, rel: 'meshes/wing.stl', size: 20, if_match: null } },
      { url: `/api/plugin-files/uploads/${UP}?project_id=proj-a&plugin=ws-demo&offset=0`, method: 'PUT', body: first },
      { url: `/api/plugin-files/uploads/${UP}?project_id=proj-a&plugin=ws-demo&offset=16`, method: 'PUT', body: rest },
      { url: `/api/plugin-files/uploads/${UP}/commit`, method: 'POST', body: { ...scoped, sha256: SHA } },
      { url: '/api/plugin-files/uploads', method: 'POST', body: { ...scoped, rel: 'b.bin', size: 1 } },
      { url: `/api/plugin-files/uploads/${again.upload}/abort`, method: 'POST', body: scoped },
      { url: '/api/plugin-files/delete', method: 'POST', body: { ...scoped, rel: 'meshes', recursive: true } },
    ]);
    // The chunks go as they came: the very ArrayBuffer and Blob, as raw bytes.
    expect(calls[4].body).toBe(first);
    expect(calls[5].body).toBe(rest);
    expect(inits[4].headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect((await refused(c.handle('files.move', { rel: 'a' }))).code).toBe('not_allowed');
  });

  it("refuses another plugin's files without a fetch", async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    for (const method of [
      'files.stat',
      'files.list',
      'files.read',
      'files.write.begin',
      'files.write.chunk',
      'files.write.commit',
      'files.write.abort',
      'files.delete',
    ]) {
      const err = await refused(c.handle(method, { rel: 'a.bin', size: 1, plugin: 'other' }));
      expect([err.code, err.message]).toEqual(['not_allowed', "not allowed: another plugin's files"]);
    }
    expect(calls).toEqual([]);
  });

  it('sends chunks only for uploads it began, in order, of the right kind and size', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    const stranger = 'f'.repeat(32);
    for (const method of ['files.write.chunk', 'files.write.commit', 'files.write.abort']) {
      const err = await refused(c.handle(method, { upload: stranger, offset: 0, data: new ArrayBuffer(1) }));
      expect([err.code, err.message]).toEqual(['not_allowed', 'not allowed: an upload this workspace did not begin']);
    }
    expect(calls).toEqual([]);
    await c.handle('files.write.begin', { rel: 'a.bin', size: 20 });
    calls = [];
    const chunk = (offset: unknown, data: unknown) => c.handle('files.write.chunk', { upload: UP, offset, data });
    for (const data of ['bytes', new Uint8Array(4), { byteLength: 4 }, null, [1, 2]]) {
      expect((await refused(chunk(0, data))).code).toBe('bad_request');
    }
    for (const offset of [1.5, '0', undefined, -1]) {
      const err = await refused(chunk(offset, new ArrayBuffer(4)));
      expect(err.code).toBe(offset === -1 ? 'offset' : 'bad_request');
    }
    expect((await refused(chunk(4, new ArrayBuffer(4)))).message).toBe('the next chunk starts at byte 0');
    expect((await refused(chunk(0, new ArrayBuffer(17)))).code).toBe('too_large');
    expect((await refused(c.handle('files.write.commit', { upload: UP, sha256: 'not-a-hash' }))).code).toBe('bad_request');
    expect(calls).toEqual([]);

    // One chunk at a time: a second one while the first is on its way is refused.
    let release: (a: Answer) => void = () => undefined;
    answer = (url, method, init) => (method === 'PUT' ? new Promise<Answer>((r) => (release = r)) : filesApp(url, method, init));
    const firstChunk = chunk(0, new ArrayBuffer(16));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect((await refused(chunk(0, new ArrayBuffer(16)))).code).toBe('busy');
    release({ status: 200, body: { ok: true, received: 16 } });
    expect(await firstChunk).toEqual({ received: 16 });
    answer = filesApp;
    // 4 bytes are left: a full chunk is too much, and the next one starts at 16.
    expect((await refused(chunk(16, new Blob([new Uint8Array(5)])))).message).toBe('this chunk may hold at most 4 bytes');
    expect((await refused(chunk(0, new ArrayBuffer(4)))).code).toBe('offset');
    expect(await chunk(16, new ArrayBuffer(4))).toEqual({ received: 20 });
    expect(calls.filter((x) => x.method === 'PUT').length).toBe(2);
  });

  it('aborts every open upload when it closes, even one whose begin was still on its way', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    const a = (await c.handle('files.write.begin', { rel: 'a.bin', size: 5 })) as { upload: string };
    const b = (await c.handle('files.write.begin', { rel: 'b.bin', size: 5 })) as { upload: string };
    let release: (a: Answer) => void = () => undefined;
    answer = (url, method, init) =>
      url === '/api/plugin-files/uploads' ? new Promise<Answer>((r) => (release = r)) : filesApp(url, method, init);
    const late = c.handle('files.write.begin', { rel: 'c.bin', size: 5 });
    await vi.waitFor(() => expect(calls.length).toBe(3));
    calls = [];
    inits = [];
    c.close();
    const scoped = { project_id: 'proj-a', plugin: 'ws-demo' };
    expect(calls).toEqual([
      { url: `/api/plugin-files/uploads/${a.upload}/abort`, method: 'POST', body: scoped },
      { url: `/api/plugin-files/uploads/${b.upload}/abort`, method: 'POST', body: scoped },
    ]);
    expect(inits.map((i) => i.keepalive)).toEqual([true, true]);
    expect((await refused(c.handle('files.write.chunk', { upload: a.upload, offset: 0, data: new ArrayBuffer(5) }))).code).toBe(
      'not_allowed',
    );
    release({ status: 201, body: { ok: true, upload: 'c'.repeat(32), chunk_bytes: 16 } });
    expect((await refused(late)).message).toBe('the workspace closed');
    expect(calls[2]).toEqual({ url: `/api/plugin-files/uploads/${'c'.repeat(32)}/abort`, method: 'POST', body: scoped });
    expect(inits[2].keepalive).toBe(true);
  });

  it("takes the app's own error code when it names one", async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    answer = () => ({ status: 413, body: { ok: false, error: "over this plugin's 512 MB", code: 'quota', limit: 1, used: 2 } });
    const quota = await refused(c.handle('files.write.begin', { rel: 'a.bin', size: 5 }));
    expect([quota.code, quota.message]).toEqual(['quota', "over this plugin's 512 MB"]);
    answer = () => ({ status: 400, body: { ok: false, error: 'a study record', code: 'study_record' } });
    expect((await refused(c.handle('files.delete', { rel: 'studies/st-1/study.json' }))).code).toBe('study_record');
    // A number is the worker's code, not the app's: the status says what it was.
    answer = () => ({ status: 404, body: { ok: false, error: 'gone', code: -32004 } });
    expect((await refused(c.handle('files.stat', { rel: 'a.bin' }))).code).toBe('not_found');
  });

  it('closes the frame when a file call finds its own study gone, not another one', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    const gone: Answer = { status: 404, body: { ok: false, error: 'study not found', code: 'study_not_found' } };
    answer = () => gone;
    expect((await refused(c.handle('files.write.begin', { rel: 'studies/st-2/mesh.stl', size: 1 }))).code).toBe('study_not_found');
    expect(h.studyGone).not.toHaveBeenCalled();
    await refused(c.handle('files.write.begin', { rel: 'studies\\st-1\\mesh.stl', size: 1 }));
    expect(h.studyGone).toHaveBeenCalledTimes(1);
    // The study went between begin and commit.
    answer = filesApp;
    const { upload } = (await c.handle('files.write.begin', { rel: 'studies/st-1/polar.bin', size: 0 })) as { upload: string };
    answer = () => gone;
    await refused(c.handle('files.write.commit', { upload }));
    expect(h.studyGone).toHaveBeenCalledTimes(2);
  });

  it('reads a Blob with the whole size and etag, a byte range, and null when there is no file', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    answer = () =>
      new Response(new Uint8Array([5, 6, 7]), {
        status: 206,
        headers: { ETag: INFO.etag, 'X-Magnusim-File-Size': '10', 'Content-Range': 'bytes 2-4/10' },
      });
    const r = (await c.handle('files.read', { rel: 'a.bin', offset: 2, length: 3, ifMatch: INFO.etag })) as {
      blob: Blob;
      size: number;
      etag: string;
    };
    expect(r.blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]));
    expect([r.size, r.etag]).toEqual([10, INFO.etag]);
    await c.handle('files.read', { rel: 'a.bin', offset: 2 });
    await c.handle('files.read', { rel: 'a.bin', length: 3 });
    await c.handle('files.read', { rel: 'a.bin', offset: 0 });
    expect(inits.map((i) => i.headers)).toEqual([
      { Range: 'bytes=2-4', 'If-Match': INFO.etag },
      { Range: 'bytes=2-' },
      { Range: 'bytes=0-2' },
      {},
    ]);
    for (const bad of [{ offset: -1 }, { length: 1.5 }, { offset: '2' }, { ifMatch: 7 }]) {
      expect((await refused(c.handle('files.read', { rel: 'a.bin', ...bad }))).code).toBe('bad_request');
    }
    expect(calls.length).toBe(4);

    answer = () => ({ status: 404, body: { ok: false, error: 'a.bin is not there', code: 'not_found' } });
    expect(await c.handle('files.read', { rel: 'a.bin' })).toBeNull();
    answer = () => ({ status: 404, body: { ok: false, error: 'the plugin is off', code: 'plugin_off' } });
    expect((await refused(c.handle('files.read', { rel: 'a.bin' }))).code).toBe('plugin_off');
    answer = () => ({ status: 409, body: { ok: false, error: 'a.bin changed', code: 'changed', etag: '"2"' } });
    expect((await refused(c.handle('files.read', { rel: 'a.bin', ifMatch: INFO.etag }))).code).toBe('changed');

    // Nothing asked for: no byte range can say that, so the answer comes from the file's stat.
    answer = filesApp;
    calls = [];
    const none = (await c.handle('files.read', { rel: 'meshes/wing.stl', offset: 20, length: 0 })) as { blob: Blob; size: number };
    expect([none.blob.size, none.size]).toEqual([0, 20]);
    expect(calls[0].url.startsWith('/api/plugin-files/stat?')).toBe(true);
    expect((await refused(c.handle('files.read', { rel: 'meshes/wing.stl', length: 0, ifMatch: '"old"' }))).code).toBe('changed');
  });

  it('reads an empty file as empty bytes when a length is asked for', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    // The app refuses every byte range of an empty file, with its size and etag.
    answer = () =>
      new Response(JSON.stringify({ ok: false, error: 'that byte range is not in the file', code: 'bad_range', size: 0 }), {
        status: 416,
        headers: { ETag: INFO.etag, 'X-Magnusim-File-Size': '0', 'Content-Range': 'bytes */0' },
      });
    const r = (await c.handle('files.read', { rel: 'empty.bin', length: 1024 })) as { blob: Blob; size: number; etag: string };
    expect([r.blob.size, r.size, r.etag]).toEqual([0, 0, INFO.etag]);
    expect(inits[0].headers).toEqual({ Range: 'bytes=0-1023' });
    // Past the end of it is still past the end.
    expect((await refused(c.handle('files.read', { rel: 'empty.bin', offset: 4, length: 2 }))).code).toBe('bad_range');
  });

  it('forgets an upload once it is committed or aborted', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    const done = (await c.handle('files.write.begin', { rel: 'a.bin', size: 0 })) as { upload: string };
    await c.handle('files.write.commit', { upload: done.upload });
    const dropped = (await c.handle('files.write.begin', { rel: 'b.bin', size: 1 })) as { upload: string };
    await c.handle('files.write.abort', { upload: dropped.upload });
    calls = [];
    for (const upload of [done.upload, dropped.upload]) {
      for (const method of ['files.write.chunk', 'files.write.commit', 'files.write.abort']) {
        const err = await refused(c.handle(method, { upload, offset: 0, data: new ArrayBuffer(1) }));
        expect(err.code).toBe('not_allowed');
      }
    }
    c.close();
    expect(calls).toEqual([]);
  });

  it('is dirty while an upload is open, and clean again once it is committed or aborted', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    // A begin the app refuses opens nothing.
    answer = () => ({ status: 413, body: { ok: false, error: "over this plugin's 512 MB", code: 'quota' } });
    await refused(c.handle('files.write.begin', { rel: 'a.bin', size: 5 }));
    expect(h.setDirty).not.toHaveBeenCalled();
    answer = filesApp;
    const a = (await c.handle('files.write.begin', { rel: 'a.bin', size: 0 })) as { upload: string };
    expect(h.setDirty.mock.calls).toEqual([[true, UPLOADING]]);
    const b = (await c.handle('files.write.begin', { rel: 'b.bin', size: 1 })) as { upload: string };
    await c.handle('files.write.commit', { upload: a.upload });
    expect(h.setDirty).toHaveBeenCalledTimes(1);
    await c.handle('files.write.abort', { upload: b.upload });
    expect(h.setDirty.mock.calls).toEqual([
      [true, UPLOADING],
      [false, ''],
    ]);
    // A refused commit keeps the upload open, and the page dirty, until the page aborts it.
    const d = (await c.handle('files.write.begin', { rel: 'd.bin', size: 0 })) as { upload: string };
    answer = () => ({ status: 409, body: { ok: false, error: 'd.bin changed since it was read', code: 'changed' } });
    await refused(c.handle('files.write.commit', { upload: d.upload }));
    expect(h.setDirty).toHaveBeenLastCalledWith(true, UPLOADING);
    answer = filesApp;
    await c.handle('files.write.abort', { upload: d.upload });
    expect(h.setDirty).toHaveBeenLastCalledWith(false, '');
    expect(h.setDirty).toHaveBeenCalledTimes(4);
  });

  it('a clean page is clean again once its one upload is committed', async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    const up = (await c.handle('files.write.begin', { rel: 'a.bin', size: 0 })) as { upload: string };
    expect(h.setDirty.mock.calls).toEqual([[true, UPLOADING]]);
    await c.handle('files.write.commit', { upload: up.upload });
    expect(h.setDirty).toHaveBeenLastCalledWith(false, '');
    expect(h.setDirty).toHaveBeenCalledTimes(2);
  });

  it("shows the page's own message over the upload's, and the upload's while the page gives none", async () => {
    const h = hooks();
    const c = new WorkspaceCalls(SCOPE, h);
    const set = (dirty: boolean, message?: string) => c.handle('nav.setDirty', { dirty, message });
    await set(true, 'Chord not saved');
    const a = (await c.handle('files.write.begin', { rel: 'a.bin', size: 0 })) as { upload: string };
    // The page's own message stays while the upload is open.
    expect(h.setDirty.mock.calls).toEqual([[true, 'Chord not saved']]);
    await set(true, '');
    expect(h.setDirty).toHaveBeenLastCalledWith(true, UPLOADING);
    await set(false);
    await set(true, 'Span not saved');
    expect(h.setDirty).toHaveBeenLastCalledWith(true, 'Span not saved');
    await c.handle('files.write.commit', { upload: a.upload });
    await set(false);
    // Open when the channel ends: aborted, and the page is clean.
    await c.handle('files.write.begin', { rel: 'b.bin', size: 1 });
    c.close();
    expect(h.setDirty.mock.calls).toEqual([
      [true, 'Chord not saved'],
      [true, UPLOADING],
      [true, 'Span not saved'],
      [false, ''],
      [true, UPLOADING],
      [false, ''],
    ]);
  });

  it('says when a folder holds too many files to list', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    answer = () => ({ status: 200, body: { ok: true, files: [INFO], truncated: true } });
    const err = await refused(c.handle('files.list', {}));
    expect([err.code, err.message]).toEqual(['too_many', "more than 1 files under the plugin's folder: list a smaller folder"]);
    expect(calls[0].url).toBe('/api/plugin-files/list?project_id=proj-a&plugin=ws-demo&prefix=');
  });
});

/** An EventSource the tests drive: `emit` delivers a named event, `fail` closes it as the browser does on a refused stream. */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
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
  fail(): void {
    this.readyState = 2;
    this.onerror?.();
  }
  close(): void {
    this.readyState = 2;
  }
}

const JOB = 'fc-mg1abc2d-0a1b2c';
const JOB2 = 'fc-mg1abc2e-0d0e0f';
/** A case as the app lists it (ComputeJob). */
function caseJob(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    caseRel: 'cases/c1',
    app: 'pimpleFoam',
    nProcs: 1,
    status: 'running',
    stage: 'solve',
    stopping: false,
    ahead: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    code: null,
    result: null,
    seq: 5,
    ...over,
  };
}

describe('WorkspaceCalls: plugin OpenFOAM cases (compute.*, results.openIn3D)', () => {
  const RESULTS = { kinematicFields: ['p'], rho: 1 };
  let pushed: Array<Record<string, unknown>>;
  let statusOf: Record<string, unknown>;

  beforeEach(() => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    pushed = [];
    statusOf = { [JOB]: caseJob(), [JOB2]: caseJob({ id: JOB2, status: 'queued', stage: null, ahead: 2, seq: 1 }) };
    answer = (url) => {
      if (url.startsWith('/api/plugin-cases/status')) {
        const id = new URL(url, 'http://x').searchParams.get('job_id') || '';
        return statusOf[id] ? { status: 200, body: { ok: true, job: statusOf[id] } } : { status: 404, body: { ok: false, code: 'not_found', error: 'No such case in this study' } };
      }
      if (url.startsWith('/api/plugin-cases/submit')) return { status: 202, body: { ok: true, job: caseJob({ status: 'queued', ahead: 1 }), ahead: 1, existing: false } };
      if (url.startsWith('/api/plugin-cases/stop')) return { status: 200, body: { ok: true, job: caseJob({ stopping: true }) } };
      if (url.startsWith('/api/plugin-cases?')) return { status: 200, body: { ok: true, jobs: [caseJob()] } };
      return { status: 200, body: { ok: true } };
    };
  });

  function calls_(h = hooks()) {
    const c = new WorkspaceCalls(SCOPE, h);
    c.setPush((msg) => pushed.push(msg));
    return c;
  }
  const events = (jobId = JOB) => pushed.filter((m) => m.jobId === jobId).map((m) => m.data as Record<string, unknown>);

  it('submits a case in its own study with clean shapes, and answers id, ahead and existing', async () => {
    const c = calls_();
    const r = await c.handle('compute.submitOpenFOAM', {
      caseRel: 'cases/c1',
      app: 'pimpleFoam',
      nProcs: 2,
      pre: [{ tool: 'blockMesh', extra: 1 }, { tool: 'decomposePar' }, { tool: 'renumberMesh', args: ['-overwrite'], parallel: true }],
      results: { kinematicFields: ['p'], rho: 1, frameFields: ['U', 'p'], other: true },
      project_id: 'proj-b',
      plugin: 'other',
      study_id: 'st-9',
    });
    expect(r).toEqual({ id: JOB, ahead: 1, existing: false });
    expect(calls).toEqual([
      {
        url: '/api/plugin-cases/submit?project_id=proj-a',
        method: 'POST',
        body: {
          project_id: 'proj-a',
          plugin: 'ws-demo',
          study_id: 'st-1',
          case_rel: 'cases/c1',
          app: 'pimpleFoam',
          n_procs: 2,
          pre: [{ tool: 'blockMesh' }, { tool: 'decomposePar' }, { tool: 'renumberMesh', args: ['-overwrite'], parallel: true }],
          results: { kinematicFields: ['p'], rho: 1, frameFields: ['U', 'p'] },
        },
      },
    ]);
    // The same folder already queued or running: that case.
    answer = () => ({ status: 200, body: { ok: true, job: caseJob(), ahead: null, existing: true } });
    expect(await c.handle('compute.submitOpenFOAM', { caseRel: 'cases/c1', app: 'pimpleFoam', results: RESULTS })).toEqual({
      id: JOB,
      ahead: 0,
      existing: true,
    });
  });

  it('refuses bad shapes with bad_request before any fetch', async () => {
    const c = calls_();
    const ok = { caseRel: 'cases/c1', app: 'pimpleFoam', results: RESULTS };
    for (const bad of [
      { ...ok, caseRel: '' },
      { ...ok, caseRel: 'c'.repeat(241) },
      { ...ok, caseRel: 7 },
      { ...ok, app: '' },
      { ...ok, app: 'a'.repeat(65) },
      { ...ok, nProcs: 0 },
      { ...ok, nProcs: 65 },
      { ...ok, nProcs: 1.5 },
      { ...ok, nProcs: '2' },
      { ...ok, pre: 'blockMesh' },
      { ...ok, pre: Array.from({ length: 17 }, () => ({ tool: 'checkMesh' })) },
      { ...ok, pre: [{}] },
      { ...ok, pre: [{ tool: 't'.repeat(33) }] },
      { ...ok, pre: [{ tool: 'checkMesh', args: ['-allGeometry', '-allTopology', 'a', 'b', 'c'] }] },
      { ...ok, pre: [{ tool: 'checkMesh', args: ['x'.repeat(121)] }] },
      { ...ok, pre: [{ tool: 'checkMesh', args: [3] }] },
      { ...ok, pre: [{ tool: 'checkMesh', parallel: 'yes' }] },
      { ...ok, results: undefined },
      { ...ok, results: { rho: 1 } },
      { ...ok, results: { kinematicFields: Array.from({ length: 17 }, (_, i) => `f${i}`) } },
      { ...ok, results: { kinematicFields: ['p'], rho: 0 } },
      { ...ok, results: { kinematicFields: ['p'], rho: Infinity } },
      { ...ok, results: { kinematicFields: ['p'], frameFields: 'U' } },
    ]) {
      const err = await refused(c.handle('compute.submitOpenFOAM', bad as Record<string, unknown>));
      expect(err.code, JSON.stringify(bad).slice(0, 80)).toBe('bad_request');
    }
    for (const method of ['compute.stop', 'compute.status', 'compute.events']) {
      for (const jobId of [undefined, '', 'job-1', 'fc-ABC123-0a1b2c', `${JOB}x`]) {
        expect((await refused(c.handle(method, { jobId }))).code).toBe('bad_request');
      }
    }
    expect((await refused(c.handle('results.openIn3D', { caseRel: '' }))).code).toBe('bad_request');
    expect(calls).toEqual([]);
  });

  it("passes the app's refusal code through", async () => {
    const c = calls_();
    answer = () => ({ status: 400, body: { ok: false, code: 'app_not_allowed', error: 'icoFoam is not a registered solver' } });
    const err = await refused(c.handle('compute.submitOpenFOAM', { caseRel: 'cases/c1', app: 'icoFoam', results: RESULTS }));
    expect([err.code, err.message]).toEqual(['app_not_allowed', 'icoFoam is not a registered solver']);
    answer = () => ({ status: 409, body: { ok: false, code: 'busy', error: 'Stop the case first' } });
    expect((await refused(c.handle('compute.submitOpenFOAM', { caseRel: 'cases/c1', app: 'pimpleFoam', results: RESULTS }))).code).toBe('busy');
  });

  it("stops, reads and lists this study's cases only", async () => {
    const c = calls_();
    expect(await c.handle('compute.stop', { jobId: JOB, force: 'yes' })).toEqual({ status: 'running', stopping: true });
    expect(calls[0]).toEqual({
      url: '/api/plugin-cases/stop?project_id=proj-a',
      method: 'POST',
      body: { project_id: 'proj-a', plugin: 'ws-demo', study_id: 'st-1', job_id: JOB, force: false },
    });
    await c.handle('compute.stop', { jobId: JOB, force: true });
    expect((calls[1].body as Record<string, unknown>).force).toBe(true);
    expect(await c.handle('compute.status', { jobId: JOB })).toEqual(caseJob());
    expect(calls[2].url).toBe(`/api/plugin-cases/status?project_id=proj-a&plugin=ws-demo&study_id=st-1&job_id=${JOB}`);
    expect(await c.handle('compute.list', { plugin: 'other', study_id: 'st-9' })).toEqual([caseJob()]);
    expect(calls[3].url).toBe('/api/plugin-cases?project_id=proj-a&plugin=ws-demo&study_id=st-1');
    // Another study's case (the app answers not_found).
    const other = 'fc-mg1abc2f-ffffff';
    expect((await refused(c.handle('compute.status', { jobId: other }))).code).toBe('not_found');
  });

  it('opens one stream per channel; a case not of this study is not followed', async () => {
    const c = calls_();
    expect((await refused(c.handle('compute.events', { jobId: 'fc-mg1abc2f-ffffff' }))).code).toBe('not_found');
    expect(await c.handle('compute.events', { jobId: JOB })).toEqual({ ok: true });
    expect(await c.handle('compute.events', { jobId: JOB2 })).toEqual({ ok: true });
    expect(FakeEventSource.made.map((e) => e.url)).toEqual(['/api/plugin-cases/events?project_id=proj-a&plugin=ws-demo&study_id=st-1']);
    const es = FakeEventSource.made[0];
    es.emit('case', { job_id: 'fc-mg1abc2f-ffffff', seq: 9, ev: { event: 'stage', stage: 'solve' } });
    expect(pushed.filter((m) => m.jobId === 'fc-mg1abc2f-ffffff')).toEqual([]);
    // close() ends the stream and forgets the cases.
    c.close();
    expect(es.readyState).toBe(2);
    es.emit('case', { job_id: JOB, seq: 99, ev: { event: 'stage', stage: 'copy' } });
    expect(events().map((e) => e.event)).not.toContain('stage');
    // The next channel's follow opens a new stream.
    await c.handle('compute.events', { jobId: JOB });
    expect(FakeEventSource.made.length).toBe(2);
  });

  it('catches a case up once from the snapshot (start and the live points), then passes newer events only', async () => {
    const c = calls_();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const plain = answer;
    answer = async (url, method, init) => {
      if (url.startsWith('/api/plugin-cases/status')) await held;
      return plain(url, method, init);
    };
    const following = c.handle('compute.events', { jobId: JOB });
    await vi.waitFor(() => expect(FakeEventSource.made.length).toBe(1));
    const es = FakeEventSource.made[0];
    es.emit('snapshot', { jobs: [caseJob({ seq: 5 })], live: { job_id: JOB, points: [{ t: 0.1 }, { t: 0.2 }] } });
    es.emit('case', { job_id: JOB, seq: 5, ev: { event: 'stage', stage: 'solve' } });
    es.emit('case', { job_id: JOB, seq: 6, ev: { event: 'time_saved', t: 0.1 } });
    es.emit('case', { job_id: JOB, seq: 6, ev: { event: 'time_saved', t: 0.1 } });
    release();
    await following;
    expect(events()).toEqual([{ event: 'start' }, { event: 'progress', points: [{ t: 0.1 }, { t: 0.2 }] }, { event: 'time_saved', t: 0.1 }]);
    // A reconnect: a new snapshot of a case already seen sends nothing more while it runs...
    es.emit('snapshot', { jobs: [caseJob({ seq: 8 })], live: { job_id: JOB, points: [{ t: 0.3 }] } });
    es.emit('case', { job_id: JOB, seq: 8, ev: { event: 'stage', stage: 'copy' } });
    expect(events().length).toBe(3);
    // ...and its end once, in the frame's result shape, also when the snapshot says it first.
    const result = { exit_code: 0, n_procs: 1, phases: { solve: 3 }, saved_times: [0.1, 0.2], last_saved: 0.2, write_format: 'binary' };
    es.emit('case', { job_id: JOB, seq: 9, ev: { event: 'end', status: 'done', error: null, code: null, result } });
    es.emit('snapshot', { jobs: [caseJob({ status: 'done', seq: 9 })], live: null });
    es.emit('case', { job_id: JOB, seq: 10, ev: { event: 'end', status: 'done', error: null, code: null, result } });
    expect(events().slice(3)).toEqual([
      {
        event: 'end',
        status: 'done',
        error: null,
        code: null,
        result: { savedTimes: [0.1, 0.2], lastSaved: 0.2, phases: { solve: 3 }, writeFormat: 'binary' },
      },
    ]);
  });

  it('a snapshot of a seen case that ended while the stream was down sends its end', async () => {
    const c = calls_();
    await c.handle('compute.events', { jobId: JOB });
    const es = FakeEventSource.made[0];
    // The status answered first: the case was caught up from it (start, no points).
    expect(events()).toEqual([{ event: 'start' }]);
    es.emit('snapshot', { jobs: [caseJob({ seq: 5 })], live: { job_id: JOB, points: [{ t: 1 }] } });
    expect(events()).toEqual([{ event: 'start' }]);
    es.emit('snapshot', {
      jobs: [caseJob({ status: 'stopped', seq: 12, result: { savedTimes: [0.1], lastSaved: 0.1, phases: {}, writeFormat: 'binary' } })],
      live: null,
    });
    expect(events()[1]).toEqual({
      event: 'end',
      status: 'stopped',
      error: null,
      code: null,
      result: { savedTimes: [0.1], lastSaved: 0.1, phases: {}, writeFormat: 'binary' },
    });
    // Anything older than what the snapshot said is dropped.
    es.emit('case', { job_id: JOB, seq: 11, ev: { event: 'time_saved', t: 0.2 } });
    expect(events().length).toBe(2);
  });

  it('catches up a queued case with its place, and a finished one with its end', async () => {
    const c = calls_();
    statusOf[JOB] = caseJob({ status: 'failed', stage: null, error: 'blockMesh failed (exit 1). See log.blockMesh.1 in the case folder', seq: 4 });
    await c.handle('compute.events', { jobId: JOB2 });
    await c.handle('compute.events', { jobId: JOB });
    expect(events(JOB2)).toEqual([{ event: 'queued', ahead: 2 }]);
    expect(events(JOB)).toEqual([
      { event: 'end', status: 'failed', error: 'blockMesh failed (exit 1). See log.blockMesh.1 in the case folder', code: null, result: null },
    ]);
    // Following again sends nothing new.
    await c.handle('compute.events', { jobId: JOB });
    expect(events(JOB).length).toBe(1);
    const es = FakeEventSource.made[0];
    es.emit('case', { job_id: JOB2, seq: 2, ev: { event: 'queued', ahead: 1 } });
    es.emit('case', { job_id: JOB2, seq: 3, ev: { event: 'start' } });
    expect(events(JOB2)).toEqual([{ event: 'queued', ahead: 2 }, { event: 'queued', ahead: 1 }, { event: 'start' }]);
  });

  it('events of a newly followed case that come while its status is read are held, then passed once, newer than the status, in seq order', async () => {
    const c = calls_();
    // The study stream is already open and caught up (the page follows JOB).
    await c.handle('compute.events', { jobId: JOB });
    expect(FakeEventSource.made.length).toBe(1);
    const es = FakeEventSource.made[0];
    // The page submits JOB2 and follows it; its status answer is held.
    statusOf[JOB2] = caseJob({ id: JOB2, status: 'running', stage: 'solve', seq: 5 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const plain = answer;
    answer = async (url, method, init) => {
      if (url.startsWith('/api/plugin-cases/status') && url.includes(`job_id=${JOB2}`)) await held;
      return plain(url, method, init);
    };
    const following = c.handle('compute.events', { jobId: JOB2 });
    await vi.waitFor(() => expect(calls.some((x) => x.url.includes(`job_id=${JOB2}`))).toBe(true));
    // Out of order, below, at and above the status's seq, one twice, and the end.
    es.emit('case', { job_id: JOB2, seq: 7, ev: { event: 'time_saved', t: 0.2 } });
    es.emit('case', { job_id: JOB2, seq: 8, ev: { event: 'end', status: 'done', error: null, code: null, result: null } });
    es.emit('case', { job_id: JOB2, seq: 4, ev: { event: 'stage', stage: 'pre_copy_in' } });
    es.emit('case', { job_id: JOB2, seq: 6, ev: { event: 'time_saved', t: 0.1 } });
    es.emit('case', { job_id: JOB2, seq: 5, ev: { event: 'stage', stage: 'solve' } });
    es.emit('case', { job_id: JOB2, seq: 6, ev: { event: 'time_saved', t: 0.1 } });
    expect(events(JOB2), 'nothing before its catch-up').toEqual([]);
    release();
    await following;
    expect(events(JOB2)).toEqual([
      { event: 'start' },
      { event: 'time_saved', t: 0.1 },
      { event: 'time_saved', t: 0.2 },
      { event: 'end', status: 'done', error: null, code: null, result: null },
    ]);
    // The end is not sent again, and the first case was not touched.
    es.emit('case', { job_id: JOB2, seq: 9, ev: { event: 'end', status: 'done', error: null, code: null, result: null } });
    expect(events(JOB2).length).toBe(4);
    expect(events(JOB)).toEqual([{ event: 'start' }]);
  });

  it('a stream the browser closed is opened again by the next follow', async () => {
    const c = calls_();
    await c.handle('compute.events', { jobId: JOB });
    FakeEventSource.made[0].fail();
    await c.handle('compute.events', { jobId: JOB2 });
    expect(FakeEventSource.made.length).toBe(2);
  });

  it('results.openIn3D asks the host and says whether the results opened', async () => {
    const h = hooks();
    const c = calls_(h);
    expect(await c.handle('results.openIn3D', { caseRel: 'cases/c2', plugin: 'other' })).toEqual({ opened: true });
    expect(h.openResults).toHaveBeenCalledWith('cases/c2');
    h.openResults.mockResolvedValueOnce(false);
    expect(await c.handle('results.openIn3D', { caseRel: 'cases/c2' })).toEqual({ opened: false });
    h.openResults.mockRejectedValueOnce(new BridgeError('This case is queued or running. Open its results when it has finished.', 'running'));
    expect((await refused(c.handle('results.openIn3D', { caseRel: 'cases/c2' }))).code).toBe('running');
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
    expect(msg.context).toMatchObject({ plugin: 'ws-demo', workspace: 'bench', project: { id: 'proj-a' }, study: STUDY, hostVersion: '1.5' });
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

  it('refuses a files call naming another plugin, and logs it', async () => {
    const t = setup();
    t.hello({ magnusim: 'hello', sdkVersion: '1.1.0', instance: 'i4' });
    await vi.waitFor(() => expect(t.posted.length).toBe(1));
    const port = (t.posted[0] as [unknown, unknown, MessagePort[]])[2][0];
    const params = { rel: 'meshes/wing.stl', plugin: 'other-plugin' };
    const answered = new Promise<unknown>((resolve) => {
      port.onmessage = (e: MessageEvent) => resolve(e.data);
    });
    port.postMessage({ id: 1, method: 'files.stat', params });
    expect(await answered).toEqual({ id: 1, error: { message: "not allowed: another plugin's files", code: 'not_allowed' } });
    expect(t.h.log).toHaveBeenCalledWith("workspace ws-demo: not allowed: another plugin's files", params);
    expect(calls.filter((x) => x.url.startsWith('/api/plugin-files'))).toEqual([]);
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

  /** Say hello as `instance` and get the port the frame is handed. */
  async function welcome(t: ReturnType<typeof setup>, instance: string): Promise<MessagePort> {
    const n = t.posted.length;
    t.hello({ magnusim: 'hello', sdkVersion: '1.1.0', instance });
    await vi.waitFor(() => expect(t.posted.length).toBe(n + 1));
    return (t.posted[n] as [unknown, unknown, MessagePort[]])[2][0];
  }

  /** Send calls over the port one after the other, without waiting in between; resolves with every answer by id. */
  function send(port: MessagePort, ...msgs: { id: number; method: string; params?: Record<string, unknown> }[]) {
    return new Promise<Record<number, unknown>>((resolve) => {
      const got: Record<number, unknown> = {};
      port.onmessage = (e: MessageEvent) => {
        const d = e.data as { id: number };
        got[d.id] = d;
        if (Object.keys(got).length === msgs.length) resolve(got);
      };
      for (const m of msgs) port.postMessage({ params: {}, ...m });
    });
  }

  const dirty = (id: number, message = 'Chord not saved') => ({ id, method: 'nav.setDirty', params: { dirty: true, message } });

  it('says nothing about unsaved work before the first channel, or when a clean channel ends', async () => {
    const t = setup();
    t.frame.dispatchEvent(new Event('load'));
    t.detach();
    t.frame.remove();
    expect(t.h.setDirty).not.toHaveBeenCalled();
    const u = setup();
    const first = await welcome(u, 'c1');
    const second = await welcome(u, 'c2');
    u.detach();
    expect(u.h.setDirty).not.toHaveBeenCalled();
    first.close();
    second.close();
    u.frame.remove();
  });

  it("gives each channel a signal that ends with it (what an old page load asked is moot)", async () => {
    const t = setup();
    expect(t.bridge.channelSignal()).toBeNull();
    const first = await welcome(t, 's1');
    const one = t.bridge.channelSignal() as AbortSignal;
    expect(one.aborted).toBe(false);
    // The page reloaded and said hello again.
    const second = await welcome(t, 's2');
    const two = t.bridge.channelSignal() as AbortSignal;
    expect(one.aborted).toBe(true);
    expect(two).not.toBe(one);
    expect(two.aborted).toBe(false);
    t.detach();
    expect(two.aborted).toBe(true);
    expect(t.bridge.channelSignal()).toBeNull();
    first.close();
    second.close();
    t.frame.remove();
  });

  it('a second hello (the page reloaded) makes a dirty page clean, once', async () => {
    const t = setup();
    const first = await welcome(t, 'd1');
    expect(await send(first, dirty(1))).toEqual({ 1: { id: 1, result: { ok: true } } });
    expect(t.h.setDirty.mock.calls).toEqual([[true, 'Chord not saved']]);
    const second = await welcome(t, 'd2');
    expect(t.h.setDirty.mock.calls).toEqual([
      [true, 'Chord not saved'],
      [false, ''],
    ]);
    t.detach();
    expect(t.h.setDirty).toHaveBeenCalledTimes(2);
    first.close();
    second.close();
    t.frame.remove();
  });

  it('a failed probe (the page navigated) makes a dirty page clean, once', async () => {
    const t = setup();
    const port = await welcome(t, 'p1');
    await send(port, dirty(1, ''));
    vi.useFakeTimers();
    t.frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(1499);
    expect(t.h.setDirty.mock.calls).toEqual([[true, '']]);
    vi.advanceTimersByTime(1);
    expect(t.bridge.connected()).toBe(false);
    expect(t.h.setDirty.mock.calls).toEqual([
      [true, ''],
      [false, ''],
    ]);
    t.detach();
    expect(t.h.setDirty).toHaveBeenCalledTimes(2);
    port.close();
    t.frame.remove();
  });

  it('detach makes a page with an open upload clean, once, and aborts the upload', async () => {
    answer = (url) => {
      if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
      if (url === '/api/plugin-files/uploads') return { status: 201, body: { ok: true, upload: 'e'.repeat(32), chunk_bytes: 16 } };
      return { status: 200, body: { ok: true } };
    };
    const t = setup();
    const port = await welcome(t, 'u1');
    await send(port, { id: 1, method: 'files.write.begin', params: { rel: 'a.bin', size: 4 } });
    expect(t.h.setDirty.mock.calls).toEqual([[true, UPLOADING]]);
    t.detach();
    expect(t.h.setDirty.mock.calls).toEqual([
      [true, UPLOADING],
      [false, ''],
    ]);
    expect(calls.at(-1)).toEqual({
      url: `/api/plugin-files/uploads/${'e'.repeat(32)}/abort`,
      method: 'POST',
      body: { project_id: 'proj-a', plugin: 'ws-demo' },
    });
    port.close();
    t.frame.remove();
  });

  it('sees nav.setDirty(false) before a nav.back sent right after it, and answers whether the page left', async () => {
    const t = setup();
    const seen: string[] = [];
    let stay = false;
    t.h.setDirty.mockImplementation((d: boolean) => void seen.push(`setDirty ${d}`));
    t.h.back.mockImplementation(async () => {
      seen.push('back');
      return !stay;
    });
    const port = await welcome(t, 'o1');
    await send(port, dirty(1));
    const got = await send(port, { id: 2, method: 'nav.setDirty', params: { dirty: false } }, { id: 3, method: 'nav.back' });
    expect(seen).toEqual(['setDirty true', 'setDirty false', 'back']);
    expect(got[3]).toEqual({ id: 3, result: { ok: true, left: true } });
    // The user chose to stay.
    stay = true;
    expect(await send(port, { id: 4, method: 'nav.back' })).toEqual({ 4: { id: 4, result: { ok: true, left: false } } });
    port.close();
    t.detach();
    t.frame.remove();
  });
});

describe('WorkspaceCalls: linked geometries (project.linkGeometry, API 1.5)', () => {
  const LJOB = 'gl-mg1abc2d-0a1b2c';
  const SHA_HEX = 'ab'.repeat(32);
  const RESULT = {
    geometryId: 'g1',
    name: 'Wing',
    rev: 2,
    fromRev: 1,
    created: false,
    change: 'shape',
    bodies: 1,
    faces: 6,
    named: 6,
    match: { byName: 5, byShape: 0, split: 0, merged: 0, movedFar: 0 },
    lost: [{ studyId: 's1', studyTitle: 'Study 1', kind: 'bc', registryKey: null, item: 'Top', field: 'faces', old: 'face 6@Body1', name: 'F:end', label: 'Boss end', reason: 'gone' }],
    returned: [],
    stillLost: 1,
    claimedTwice: [],
    outOfDate: { meshes: [], runs: 0 },
    seconds: 1,
  };
  const CALL = { shape: { rel: 'studies/st-1/exports/x.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1, token: 't1' };
  let pushed: Array<Record<string, unknown>>;
  let jobStatus: Record<string, unknown>;

  beforeEach(() => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    pushed = [];
    jobStatus = { id: LJOB, status: 'running', seq: 1 };
    answer = (url) => {
      if (url.startsWith('/api/plugin-studies/get')) return { status: 200, body: { ok: true, study: STUDY } };
      if (url.startsWith('/api/plugin-geometry/linked')) return { status: 200, body: { ok: true, linked: { geometryId: 'g1', rev: 2, lostFaces: 1 } } };
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: true } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: jobStatus } };
      return { status: 200, body: { ok: true } };
    };
  });

  function linkCalls(h = hooks()) {
    const c = new WorkspaceCalls(SCOPE, h);
    c.setPush((m) => pushed.push(m));
    return c;
  }

  it("sends the study's design with its scope, follows the job to its end and resolves with the result; its stages reach the page", async () => {
    const h = hooks();
    const c = linkCalls(h);
    const p = c.handle('project.linkGeometry', { ...CALL, plugin: 'other', project_id: 'proj-b' });
    await vi.waitFor(() => expect(c.linkJobs.has(LJOB)).toBe(true));
    expect(calls.find((x) => x.url.startsWith('/api/plugin-geometry/link?'))?.body).toEqual({
      project_id: 'proj-a',
      plugin: 'ws-demo',
      study_id: 'st-1',
      shape: { rel: 'studies/st-1/exports/x.bbrep', format: 'brep', sha256: SHA_HEX },
      face_names: null,
      source_version: 2,
      based_on_rev: 1,
    });
    expect(FakeEventSource.made.map((e) => e.url)).toEqual(['/api/plugin-geometry/events?project_id=proj-a&plugin=ws-demo&study_id=st-1']);
    const es = FakeEventSource.made[0];
    es.emit('link', { job_id: LJOB, seq: 2, ev: { event: 'queued', ahead: 1 } });
    es.emit('link', { job_id: LJOB, seq: 3, ev: { event: 'stage', stage: 'matching', fraction: null } });
    es.emit('link', { job_id: LJOB, seq: 3, ev: { event: 'stage', stage: 'matching', fraction: null } });
    es.emit('link', { job_id: LJOB, seq: 4, ev: { event: 'end', status: 'done', result: RESULT } });
    await expect(p).resolves.toEqual(RESULT);
    expect(pushed).toEqual([
      { event: 'linkProgress', data: { token: 't1', stage: 'queued', fraction: null, ahead: 1 } },
      { event: 'linkProgress', data: { token: 't1', stage: 'matching', fraction: null } },
    ]);
    // Something was lost: the host's report dialog is shown.
    expect(h.linkReport).toHaveBeenCalledWith(RESULT);
  });

  it('keeps link jobs follow-only: nothing a page calls stops one', async () => {
    const c = linkCalls();
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(c.linkJobs.has(LJOB)).toBe(true));
    expect(c.jobs.has(LJOB)).toBe(false);
    const err = await refused(c.handle('jobs.stop', { jobId: LJOB }));
    expect(err.code).toBe('not_allowed');
    expect(calls.some((x) => x.url.includes('/stop'))).toBe(false);
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'done', result: RESULT } });
    await p;
  });

  it('settles from the job status when the job ended before the stream heard of it, and rejects a refused end with its code', async () => {
    jobStatus = { id: LJOB, status: 'cancelled', error: 'Removed from the Queue', code: 'cancelled', seq: 5 };
    const c = linkCalls();
    const err = await refused(c.handle('project.linkGeometry', CALL));
    expect(err.code).toBe('cancelled');
    expect(err.message).toBe('Removed from the Queue');
    expect(c.linkJobs.size).toBe(0);
  });

  it('answers at once when nothing changed (no job), and refuses while the page has unsaved work', async () => {
    answer = (url) => (url.startsWith('/api/plugin-geometry/link?') ? { status: 200, body: { ok: true, result: { ...RESULT, change: 'none', lost: [] } } } : { status: 200, body: { ok: true } });
    const h = hooks();
    const c = linkCalls(h);
    const sync = vi.fn();
    window.addEventListener('cfd:tree-sync', sync);
    try {
      expect(await c.handle('project.linkGeometry', CALL)).toMatchObject({ change: 'none' });
    } finally {
      window.removeEventListener('cfd:tree-sync', sync);
    }
    // The tree is read again: the row's "Not up to date" goes.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(h.linkReport).not.toHaveBeenCalled();
    await c.handle('nav.setDirty', { dirty: true, message: 'Not saved' });
    const err = await refused(c.handle('project.linkGeometry', CALL));
    expect(err.code).toBe('unsaved');
  });

  it('tells the host which geometry the page linked, for the landing when the workspace closes (L2 step 3)', async () => {
    const h = hooks();
    const c = linkCalls(h);
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(h.linkStarted).toHaveBeenCalledWith({ geometryId: 'g1', jobId: LJOB, created: false }));
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'done', result: RESULT } });
    await p;
    // A first link: created.
    answer = (url) =>
      url.startsWith('/api/plugin-geometry/link?')
        ? { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g9', created: true, queued: false } }
        : url.startsWith('/api/plugin-geometry/status')
          ? { status: 200, body: { ok: true, job: { id: LJOB, status: 'done', result: { ...RESULT, geometryId: 'g9', created: true }, seq: 2 } } }
          : { status: 200, body: { ok: true } };
    await c.handle('project.linkGeometry', CALL);
    expect(h.linkStarted).toHaveBeenLastCalledWith({ geometryId: 'g9', jobId: LJOB, created: true });
    // Nothing changed: the geometry it names, with no job.
    answer = (url) => (url.startsWith('/api/plugin-geometry/link?') ? { status: 200, body: { ok: true, result: { ...RESULT, change: 'none', lost: [] } } } : { status: 200, body: { ok: true } });
    await c.handle('project.linkGeometry', CALL);
    expect(h.linkStarted).toHaveBeenLastCalledWith({ geometryId: 'g1', jobId: null, created: false });
  });

  it('checks the call: exactly one of sha256 and etag, whole numbers, a refusal from the app keeps its code', async () => {
    const c = linkCalls();
    for (const bad of [
      { ...CALL, shape: { rel: 'a', format: 'brep' } },
      { ...CALL, shape: { rel: 'a', format: 'brep', sha256: SHA_HEX, etag: '"e"' } },
      { ...CALL, shape: { rel: 'a', format: 'brep', sha256: 'nothex' } },
      { ...CALL, sourceVersion: 1.5 },
      { ...CALL, basedOnRev: -1 },
      { ...CALL, faceNames: { rel: '' } },
    ]) {
      expect((await refused(c.handle('project.linkGeometry', bad))).code).toBe('bad_request');
    }
    answer = (url) =>
      url.startsWith('/api/plugin-geometry/link?') ? { status: 409, body: { ok: false, code: 'stale', error: 'Wing changed in another tab. Reload to continue.' } } : { status: 200, body: { ok: true } };
    const err = await refused(c.handle('project.linkGeometry', CALL));
    expect([err.code, err.message]).toEqual(['stale', 'Wing changed in another tab. Reload to continue.']);
  });

  it("tells the page when its study's geometry changed, once per job, only after it asked; never for a link that changed nothing", async () => {
    const c = linkCalls();
    await c.handle('project.followGeometry', {});
    const es = FakeEventSource.made[0];
    expect(es.url).toBe('/api/plugin-geometry/events?project_id=proj-a&plugin=ws-demo&study_id=st-1');
    // Another tab's link of this study: its end reaches this page as a `geometry` event.
    es.emit('link', { job_id: 'gl-mg1abc2e-0d0e0f', seq: 7, ev: { event: 'end', status: 'done', result: RESULT } });
    es.emit('snapshot', { jobs: [{ id: 'gl-mg1abc2e-0d0e0f', status: 'done', result: RESULT, seq: 7 }] });
    es.emit('link', { job_id: 'gl-mg1abc2f-0d0e0f', seq: 2, ev: { event: 'end', status: 'done', result: { ...RESULT, change: 'none' } } });
    expect(pushed).toEqual([{ event: 'geometry', data: { geometryId: 'g1', rev: 2, fromRev: 1 } }]);
    expect(await c.handle('project.linkedGeometry', {})).toEqual({ geometryId: 'g1', rev: 2, lostFaces: 1 });
    expect(calls.some((x) => x.url === '/api/plugin-geometry/linked?project_id=proj-a&plugin=ws-demo&study_id=st-1')).toBe(true);
    // The stream is this study's alone: the server sends nothing of another study on it.
    c.close();
    expect(es.readyState).toBe(2);
  });
});

describe("WorkspaceCalls: the host's question (API 1.5, LINK 5.0)", () => {
  const LJOB = 'gl-mg1abc2d-0a1b2c';
  const SHA_HEX = 'ab'.repeat(32);
  const QUESTION = {
    geometry: { id: 'g1', name: 'Demo 1' },
    study: { id: 'st-1', title: 'Wing' },
    new_name: 'Demo 1 v2',
    studies: [{ id: 's1', title: 'Study 1', copy: 'ok', checked: true }],
    overwrite: 'ok',
    fenced: false,
  };
  const CREATED = { geometryId: 'g2', name: 'Demo 1 v2', rev: 1, fromRev: null, created: true, change: 'shape', bodies: 2, faces: 17, named: 17,
    match: { byName: 0, byShape: 0, split: 0, merged: 0, movedFar: 0 }, lost: [], returned: [], stillLost: 0, claimedTwice: [], outOfDate: { meshes: [], runs: 0 }, seconds: 1 };
  // A page's own fields are ignored: it never chooses (choice/copy here are the page's).
  const CALL = { shape: { rel: 'studies/st-1/exports/x.bbrep', format: 'brep', sha256: SHA_HEX }, sourceVersion: 2, basedOnRev: 1, choice: 'new', copy: ['s1'] };

  beforeEach(() => {
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    answer = (url, _method, init) => {
      if (url.startsWith('/api/plugin-geometry/link?')) return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: 'g1', created: false, queued: false, choosing: QUESTION } };
      if (url.startsWith('/api/plugin-geometry/status')) return { status: 200, body: { ok: true, job: { id: LJOB, status: 'choosing', seq: 1 } } };
      if (url.startsWith('/api/plugin-geometry/choose')) {
        const b = JSON.parse(String(init.body));
        if (b.choice === 'cancel') return { status: 200, body: { ok: true, job_id: LJOB, cancelled: true } };
        return { status: 202, body: { ok: true, job_id: LJOB, geometry_id: b.choice === 'new' ? 'g2' : 'g1', created: b.choice === 'new', queued: b.choice === 'overwrite' } };
      }
      return { status: 200, body: { ok: true } };
    };
  });

  const chosen = () => calls.filter((x) => x.url.startsWith('/api/plugin-geometry/choose')).map((x) => x.body);

  it('asks through the host hook, sends its answer (never the page\'s), lands on the new geometry and shows the "added" report', async () => {
    const h = hooks();
    const linkChoice = vi.fn(async () => ({ choice: 'new' as const, copy: ['s1'] }));
    const linkSavedAsNew = vi.fn();
    const c = new WorkspaceCalls(SCOPE, { ...h, linkChoice, linkSavedAsNew });
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(chosen().length).toBe(1));
    expect(linkChoice).toHaveBeenCalledWith(QUESTION, expect.any(AbortSignal));
    expect(chosen()).toEqual([{ project_id: 'proj-a', plugin: 'ws-demo', study_id: 'st-1', job_id: LJOB, choice: 'new', copy: ['s1'] }]);
    expect(h.linkStarted).toHaveBeenCalledWith({ geometryId: 'g2', jobId: LJOB, created: true });
    const copies = [{ studyId: 's1', title: 'Study 1', ok: true, lost: [] }];
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'done', result: CREATED, copies } });
    await expect(p).resolves.toEqual(CREATED);
    expect(linkSavedAsNew).toHaveBeenCalledWith({ newName: 'Demo 1 v2', oldName: 'Demo 1', copies });
  });

  it('Keep editing rejects with cancelled once the job ends so', async () => {
    const c = new WorkspaceCalls(SCOPE, { ...hooks(), linkChoice: vi.fn(async () => ({ choice: 'cancel' as const })) });
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(chosen().length).toBe(1));
    expect(chosen()[0]).toMatchObject({ choice: 'cancel', copy: [] });
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'cancelled', code: 'cancelled', error: 'You kept editing. Nothing changed.' } });
    const err = await refused(p);
    expect(err.code).toBe('cancelled');
  });

  it('a caller that cannot ask (interactive:false, the L3 scripted exit) answers Overwrite with no dialog', async () => {
    const linkChoice = vi.fn(async () => ({ choice: 'new' as const, copy: [] }));
    const c = new WorkspaceCalls(SCOPE, { ...hooks(), linkChoice });
    c.setInteractive(false);
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(chosen().length).toBe(1));
    expect(linkChoice).not.toHaveBeenCalled();
    expect(chosen()[0]).toMatchObject({ choice: 'overwrite' });
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'done', result: { ...CREATED, created: false, geometryId: 'g1', rev: 2, fromRev: 1, name: 'Demo 1' } } });
    await expect(p).resolves.toMatchObject({ geometryId: 'g1', rev: 2 });
  });

  it('a question dropped unanswered (the page went away) sends nothing: it stays open for the row\'s Choose…', async () => {
    const c = new WorkspaceCalls(SCOPE, { ...hooks(), linkChoice: vi.fn(async () => null) });
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(c.linkJobs.has(LJOB)).toBe(true));
    c.close();
    await refused(p);
    expect(chosen()).toEqual([]);
  });

  it('the dialog goes when the job ends another way (answered elsewhere, superseded)', async () => {
    let signal: AbortSignal | null = null;
    const linkChoice = vi.fn((_q: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise<null>((r) => s.addEventListener('abort', () => r(null)));
    });
    const c = new WorkspaceCalls(SCOPE, { ...hooks(), linkChoice });
    const p = c.handle('project.linkGeometry', CALL);
    await vi.waitFor(() => expect(linkChoice).toHaveBeenCalled());
    FakeEventSource.made[0].emit('link', { job_id: LJOB, seq: 9, ev: { event: 'end', status: 'superseded', code: 'superseded', error: 'A newer link of this study replaced it' } });
    expect((await refused(p)).code).toBe('superseded');
    expect(signal!.aborted).toBe(true);
    expect(chosen()).toEqual([]);
  });

  it('no call on the allowlist reaches the choose route: only the host answers', async () => {
    const { default: source } = await import('./bridge.ts?raw');
    const cases = [...String(source).matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.filter((name) => /choose|choice/i.test(name))).toEqual([]);
    expect(String(source)).not.toContain('/api/plugin-geometry/choose');
    // The only sender is the host's own answer (linkChoice.ts sendLinkChoice), called after its dialog.
    const c = new WorkspaceCalls(SCOPE, hooks());
    for (const name of ['project.choose', 'project.chooseLink', 'project.answer', 'link.choose']) {
      expect((await refused(c.handle(name, { jobId: LJOB, choice: 'overwrite' }))).code).toBe('not_allowed');
    }
    expect(chosen()).toEqual([]);
  });
});
