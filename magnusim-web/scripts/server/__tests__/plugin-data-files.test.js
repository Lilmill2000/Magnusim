// G1: a plugin's own binary files in a project (/api/plugin-files/*). Bytes go
// through Node only (never the worker); paths follow the rules shared with
// magnusim_sdk.data.data_rel and are checked again where they really land.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'python', 'tests', 'fixtures', 'plugin-file-paths.json');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-g1-files-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
// Before the catalog loads: projectDir() then resolves inside this root.
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;

const { Router, dispatch } = await import('../router.ts');
const { PluginFiles, registerPluginFileRoutes, pluginFileRel, isStudyRecord, isStudyContainer, UPLOAD_IDLE_MS, DISK_SPARE_BYTES, LIST_MAX } =
  await import('../plugin-files.ts');
const { registerPhase3Routes } = await import('../routes.ts');
const { JobManager } = await import('../jobs.ts');
const { startRegisteredJob } = await import('../registered-tool.js');
const { isFrameAssetRequest } = await import('../workspace-files.ts');
const { projectDir } = await import('../../w17-sim-catalog.js');
const { PYTHON } = await import('../../python-env.js');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a file Windows still holds */
  }
});

const KEY = 'cad-demo';
const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function project(pid) {
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid }));
  return dir;
}

const pluginDir = (pid, key = KEY) => join(PROJECTS, pid, 'plugins', key);

function stagingParts(pid, key = KEY) {
  const dir = join(pluginDir(pid, key), '.magnusim-staging');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.part')) : [];
}

function listen(handler) {
  return new Promise((done) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

async function serve(router) {
  const server = await listen(async (req, res) => {
    try {
      if (!(await dispatch(router, req, res))) {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** PluginFiles on a real Router over HTTP; state.rows is the plugin list. */
async function harness(opts = {}) {
  const state = { rows: opts.rows || [{ key: KEY, status: 'enabled' }] };
  const files = new PluginFiles({
    plugins: async () => state.rows,
    projectDir: (pid) => projectDir(pid),
    fsOps: opts.fsOps,
    now: opts.now,
    maxEntries: opts.maxEntries,
  });
  const router = new Router();
  registerPluginFileRoutes(router, files);
  return { files, state, ...(await serve(router)) };
}

function client(base, pid, key = KEY) {
  const json = async (method, path, body) => {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: r.status, body: data, headers: r.headers };
  };
  const qs = (extra) => new URLSearchParams({ project_id: pid, plugin: key, ...extra }).toString();
  return {
    qs,
    stat: (rel) => json('GET', `/api/plugin-files/stat?${qs({ rel })}`),
    list: (prefix = '') => json('GET', `/api/plugin-files/list?${qs({ prefix })}`),
    async read(rel, headers = {}, method = 'GET') {
      const r = await fetch(`${base}/api/plugin-files/read?${qs({ rel })}`, { method, headers });
      const buf = Buffer.from(await r.arrayBuffer());
      const isJson = String(r.headers.get('content-type') || '').includes('json');
      return { status: r.status, headers: r.headers, buf, body: isJson && buf.length ? JSON.parse(buf.toString('utf8')) : null };
    },
    begin: (rel, size, extra = {}) => json('POST', '/api/plugin-files/uploads', { project_id: pid, plugin: key, rel, size, ...extra }),
    async put(upload, offset, data, ids = {}) {
      const r = await fetch(`${base}/api/plugin-files/uploads/${upload}?${qs({ offset: String(offset), ...ids })}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
      });
      return { status: r.status, body: await r.json() };
    },
    commit: (upload, extra = {}) => json('POST', `/api/plugin-files/uploads/${upload}/commit`, { project_id: pid, plugin: key, ...extra }),
    abort: (upload, extra = {}) => json('POST', `/api/plugin-files/uploads/${upload}/abort`, { project_id: pid, plugin: key, ...extra }),
    del: (rel, recursive = false) =>
      json('POST', '/api/plugin-files/delete', { project_id: pid, plugin: key, rel, ...(recursive ? { recursive: true } : {}) }),
    /** begin, the bytes in chunks of the given sizes, commit (with its checksum). */
    async write(rel, data, opts = {}) {
      const { chunks = data.length ? [data.length] : [], ...extra } = opts;
      const begun = await this.begin(rel, data.length, extra);
      if (begun.status !== 201) return begun;
      let offset = 0;
      for (const n of chunks) {
        const put = await this.put(begun.body.upload, offset, data.subarray(offset, offset + n));
        assert.equal(put.status, 200, JSON.stringify(put.body));
        offset += n;
        assert.equal(put.body.received, offset);
      }
      return this.commit(begun.body.upload, { sha256: sha(data) });
    },
  };
}

/** A PUT whose headers and body the test controls; answer resolves on the response. */
function openPut(base, path, headers) {
  const u = new URL(base + path);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers, agent: false });
  const answer = new Promise((done, fail) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => done({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers }));
      res.on('error', fail);
    });
    req.on('error', fail);
  });
  req.flushHeaders();
  return { req, answer };
}

/** Polls until check() is truthy (a background step finishing). */
async function eventually(check, what) {
  for (let i = 0; i < 100; i += 1) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const STUDY_FOLDER_WRITE = 'only the study calls write directly in the studies folder';

test('every vector in plugin-file-paths.json', () => {
  const vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const [input, want] of vectors.allowed) {
    assert.equal(pluginFileRel(input, { write: false }), want, JSON.stringify(input));
    assert.equal(pluginFileRel(input, { write: true }), want, JSON.stringify(input));
  }
  for (const input of vectors.refused_any) {
    for (const write of [false, true]) {
      assert.throws(() => pluginFileRel(input, { write }), (e) => e.code === 'invalid_path' && e.status === 400, JSON.stringify(input));
    }
  }
  for (const input of vectors.refused_write) {
    assert.throws(
      () => pluginFileRel(input, { write: true }),
      (e) => e.code === 'study_record' && e.message === "a study's record changes only through the study calls",
      input,
    );
    // Readable, never written.
    assert.ok(isStudyRecord(pluginFileRel(input, { write: false }).split('/')), input);
  }
  for (const input of vectors.study_containers) {
    // Readable; no file goes there (it would block a study's folder), none is deleted.
    assert.ok(isStudyContainer(pluginFileRel(input, { write: false }).split('/')), input);
    assert.throws(
      () => pluginFileRel(input, { write: true }),
      (e) => e.code === 'study_record' && e.status === 403 && e.message === STUDY_FOLDER_WRITE,
      input,
    );
  }
  assert.equal(isStudyContainer(['studies', 'st-1', 'x.bin']), false);
  // Only a list prefix may name the plugin's folder itself.
  for (const input of ['', '   ', '.', './.']) assert.equal(pluginFileRel(input, { write: false, allowEmpty: true }), '');
  assert.throws(() => pluginFileRel(42, { write: false }), (e) => e.code === 'invalid_path');
});

test('a round trip: begin, three uneven chunks, commit, full and ranged reads, HEAD, list', async () => {
  const pid = 'p-trip';
  project(pid);
  const h = await harness();
  const c = client(h.base, pid);
  try {
    // Files the list never shows: a JSON writer's old temp file and the app's own.
    mkdirSync(join(pluginDir(pid), 'notes'), { recursive: true });
    writeFileSync(join(pluginDir(pid), 'notes', 'n.json'), '{}');
    writeFileSync(join(pluginDir(pid), 'notes', '.tmp-abc123.json'), '{');
    writeFileSync(join(pluginDir(pid), 'notes', '.magnusim-0f.part'), 'half');

    const data = randomBytes(100_000);
    const begun = await c.begin('models/Part A.step', data.length);
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    assert.match(begun.body.upload, /^[0-9a-f]{32}$/);
    assert.equal(begun.body.chunk_bytes, 16 * 1024 * 1024);
    assert.equal(begun.body.max_chunk_bytes, 32 * 1024 * 1024);
    assert.equal(begun.body.expires_ms, 600_000);
    const up = begun.body.upload;
    assert.deepEqual(stagingParts(pid), [`${up}.part`]);
    let received = 0;
    for (const n of [30_000, 1, 69_999]) {
      const put = await c.put(up, received, data.subarray(received, received + n));
      assert.equal(put.status, 200, JSON.stringify(put.body));
      received += n;
      assert.equal(put.body.received, received);
    }
    // While it is open the list shows neither the staging file nor the target.
    const during = await c.list('');
    assert.deepEqual(
      during.body.files.map((f) => f.rel),
      ['notes/n.json'],
    );
    const done = await c.commit(up, { sha256: sha(data).toUpperCase() });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const file = done.body.file;
    assert.equal(file.rel, 'models/Part A.step');
    assert.equal(file.size, data.length);
    assert.equal(file.sha256, sha(data));
    assert.match(file.etag, /^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
    assert.match(file.mtime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(stagingParts(pid), []);

    const full = await c.read('models/Part A.step');
    assert.equal(full.status, 200);
    assert.ok(full.buf.equals(data));
    assert.equal(full.headers.get('content-type'), 'application/octet-stream');
    assert.equal(full.headers.get('content-length'), String(data.length));
    assert.equal(full.headers.get('etag'), file.etag);
    assert.equal(full.headers.get('x-magnusim-file-size'), String(data.length));
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(full.headers.get('content-disposition'), 'attachment; filename="Part A.step"');
    assert.equal(full.headers.get('content-security-policy'), "sandbox; default-src 'none'");

    const ranged = [
      ['bytes=10-19', 10, 19],
      ['bytes=99990-', 99_990, 99_999],
      ['bytes=-5', 99_995, 99_999],
      ['bytes=99995-200000', 99_995, 99_999],
    ];
    for (const [range, start, end] of ranged) {
      const r = await c.read('models/Part A.step', { range });
      assert.equal(r.status, 206, range);
      assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${data.length}`);
      assert.equal(r.headers.get('content-length'), String(end - start + 1));
      assert.equal(r.headers.get('x-magnusim-file-size'), String(data.length));
      assert.ok(r.buf.equals(data.subarray(start, end + 1)), range);
    }
    for (const range of ['bytes=100000-', 'bytes=0-1,5-6', 'bytes=abc', 'bytes=9-3', 'bytes=-0']) {
      const r = await c.read('models/Part A.step', { range });
      assert.equal(r.status, 416, range);
      assert.equal(r.headers.get('content-range'), `bytes */${data.length}`);
    }
    const head = await c.read('models/Part A.step', {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.buf.length, 0);
    assert.equal(head.headers.get('content-length'), String(data.length));
    assert.equal(head.headers.get('etag'), file.etag);

    // The etag stays while the file does.
    assert.equal((await c.stat('models/Part A.step')).body.file.etag, file.etag);
    assert.deepEqual((await c.stat('models//./Part A.step')).body.file, { rel: file.rel, size: file.size, mtime: file.mtime, etag: file.etag });
    assert.equal((await c.read('models/Part A.step')).headers.get('etag'), file.etag);

    const listed = await c.list('');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.truncated, false);
    assert.deepEqual(
      listed.body.files.map((f) => f.rel),
      ['models/Part A.step', 'notes/n.json'],
    );
    assert.deepEqual(listed.body.files[0], { rel: file.rel, size: file.size, mtime: file.mtime, etag: file.etag });
    assert.deepEqual((await c.list('models')).body.files.map((f) => f.rel), ['models/Part A.step']);
    assert.deepEqual((await c.list('nothing/here')).body, { ok: true, files: [], truncated: false });
    const notFolder = await c.list('models/Part A.step');
    assert.equal(notFolder.status, 400);
    assert.equal(notFolder.body.code, 'not_folder');

    assert.deepEqual((await c.stat('models/none.bin')).body, { ok: true, file: null });
    assert.equal((await c.stat('models')).body.file, null);
    const missing = await c.read('models/none.bin');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');
    assert.equal(missing.body.ok, false);

    // A name beyond ASCII, and an empty file.
    assert.equal((await c.write('dir/\u00f8.bin', Buffer.from('x'))).status, 200);
    assert.equal(
      (await c.read('dir/\u00f8.bin')).headers.get('content-disposition'),
      `attachment; filename="_.bin"; filename*=UTF-8''%C3%B8.bin`,
    );
    const empty = await c.write('empty.bin', Buffer.alloc(0));
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.file.size, 0);
    const emptyRead = await c.read('empty.bin');
    assert.equal(emptyRead.status, 200);
    assert.equal(emptyRead.buf.length, 0);
    // No range fits an empty file; the refusal still says its size and etag (the bridge reads it as empty).
    const emptyRange = await c.read('empty.bin', { range: 'bytes=0-1023' });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.body.code, 'bad_range');
    assert.equal(emptyRange.headers.get('x-magnusim-file-size'), '0');
    assert.equal(emptyRange.headers.get('etag'), empty.body.file.etag);
    assert.equal((await c.read('empty.bin', { range: 'bytes=0-' })).status, 416);

    // Deleting: a file, a folder only with recursive, a missing path.
    assert.deepEqual((await c.del('empty.bin')).body, { ok: true, deleted: 1 });
    const folder = await c.del('models');
    assert.equal(folder.status, 400);
    assert.equal(folder.body.code, 'is_folder');
    assert.deepEqual((await c.del('models', true)).body, { ok: true, deleted: 1 });
    assert.deepEqual((await c.del('models')).body, { ok: true, deleted: 0 });
    assert.equal(existsSync(join(pluginDir(pid), 'models')), false);
    // Writing where a file stands in for a folder, or a folder for a file.
    assert.equal((await c.begin('dir/\u00f8.bin/x.bin', 1)).body.code, 'is_folder');
    assert.equal((await c.begin('dir', 1)).body.code, 'is_folder');
  } finally {
    await h.close();
  }
});

test('caps: file size, quota, a chunk over its bound by Content-Length or mid-stream', async () => {
  const pid = 'p-caps';
  project(pid);
  const h = await harness({ rows: [{ key: KEY, status: 'enabled', files: { max_file_bytes: 1000, max_total_bytes: 2500 } }] });
  const c = client(h.base, pid);
  try {
    const big = await c.begin('huge.bin', 1001);
    assert.equal(big.status, 413);
    assert.equal(big.body.code, 'too_large');
    assert.equal(big.body.limit, 1000);

    assert.equal((await c.write('a.bin', randomBytes(900))).status, 200);
    const b1 = await c.begin('b.bin', 900);
    assert.equal(b1.status, 201);
    // Its bytes in the staging file count once: as reserved, not as used.
    assert.equal((await c.put(b1.body.upload, 0, randomBytes(900))).status, 200);
    // 900 on disk + 900 on the way + 900 more is over 2500.
    const over = await c.begin('c.bin', 900);
    assert.equal(over.status, 413);
    assert.equal(over.body.code, 'quota');
    assert.equal(over.body.limit, 2500);
    assert.equal(over.body.used, 900);
    assert.equal(over.body.reserved, 900);
    // What just fits is taken.
    const fits = await c.begin('c.bin', 700);
    assert.equal(fits.status, 201, JSON.stringify(fits.body));
    assert.equal((await c.abort(fits.body.upload)).body.aborted, true);
    // Replacing a.bin frees what it held.
    const replace = await c.begin('a.bin', 900);
    assert.equal(replace.status, 201, JSON.stringify(replace.body));
    assert.equal((await c.abort(replace.body.upload)).body.aborted, true);
    assert.equal((await c.abort(b1.body.upload)).body.aborted, true);

    // A Content-Length over the chunk's bound is refused before any byte is read.
    const d = (await c.begin('d.bin', 10)).body.upload;
    const declared = openPut(h.base, `/api/plugin-files/uploads/${d}?${c.qs({ offset: '0' })}`, {
      'content-type': 'application/octet-stream',
      'content-length': '11',
    });
    const refused = await declared.answer;
    declared.req.destroy();
    assert.equal(refused.status, 413);
    assert.equal(refused.body.code, 'too_large');
    assert.equal(refused.body.limit, 10);
    assert.equal(statSync(join(pluginDir(pid), '.magnusim-staging', `${d}.part`)).size, 0);
    // The upload goes on.
    assert.equal((await c.put(d, 0, Buffer.alloc(10, 7))).body.received, 10);
    const extra = await c.put(d, 10, Buffer.from('x'));
    assert.equal(extra.status, 413);
    assert.equal(extra.body.limit, 0);
    assert.equal((await c.commit(d)).status, 200);

    // A body without Content-Length that streams past the bound is stopped mid-stream:
    // the upload ends, its staging file goes, and the target is untouched.
    assert.equal((await c.write('e.bin', Buffer.from('old!'))).status, 200);
    const e = (await c.begin('e.bin', 10)).body.upload;
    const streamed = openPut(h.base, `/api/plugin-files/uploads/${e}?${c.qs({ offset: '0' })}`, {
      'content-type': 'application/octet-stream',
    });
    streamed.req.write(Buffer.alloc(6, 1));
    await delay(30);
    streamed.req.write(Buffer.alloc(6, 2));
    streamed.req.end();
    const stopped = await streamed.answer;
    assert.equal(stopped.status, 413);
    assert.equal(stopped.body.code, 'too_large');
    assert.equal(stopped.body.limit, 10);
    assert.ok(!stagingParts(pid).includes(`${e}.part`));
    assert.equal((await c.read('e.bin')).buf.toString(), 'old!');
    assert.equal((await c.put(e, 0, Buffer.from('x'))).body.code, 'upload_not_found');
  } finally {
    await h.close();
  }
});

test('quota: begins at once share it, a commit checks it again, temp files a job left are not counted, files and folders are capped', async () => {
  const pid = 'p-quota';
  project(pid);
  const rows = [{ key: KEY, status: 'enabled', files: { max_file_bytes: 1000, max_total_bytes: 1500 } }];
  let h = await harness({ rows });
  let c = client(h.base, pid);
  const dir = pluginDir(pid);
  try {
    // Two begins at once under a quota that holds one of them: one is refused, every time.
    for (let round = 0; round < 5; round += 1) {
      const both = await Promise.allSettled([0, 1].map((i) => h.files.begin(pid, KEY, { rel: `r${round}-${i}.bin`, size: 1000 })));
      assert.deepEqual(both.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code)).sort(), ['ok', 'quota'], `round ${round}`);
      const taken = both.find((r) => r.status === 'fulfilled');
      assert.equal(await h.files.abort(taken.value.upload, pid, KEY), true);
    }

    // The plugin's own code filled the folder between begin and commit: the commit is refused.
    const up = (await c.begin('late.bin', 1000)).body.upload;
    assert.equal((await c.put(up, 0, randomBytes(1000))).status, 200);
    writeFileSync(join(dir, 'by-its-job.bin'), randomBytes(600));
    const late = await c.commit(up);
    assert.equal(late.status, 413, JSON.stringify(late.body));
    assert.equal(late.body.code, 'quota');
    assert.equal(late.body.used, 600);
    assert.equal((await c.stat('late.bin')).body.file, null);
    assert.equal((await c.put(up, 1000, Buffer.alloc(0))).body.code, 'upload_not_found');
    assert.deepEqual(stagingParts(pid), []);
    rmSync(join(dir, 'by-its-job.bin'));

    // Temp files magnusim_sdk writes (a stopped job can leave one): the plugin can neither
    // see nor remove them, so they are not counted; an hour old, they go at the next begin.
    mkdirSync(join(dir, 'meshes'), { recursive: true });
    const fresh = join(dir, 'meshes', '.magnusim-0123456789abcdef.part');
    const stale = join(dir, 'meshes', '.magnusim-fedcba9876543210.part');
    const staleExt = join(dir, 'meshes', '.magnusim-00112233aabbccdd.part.msh');
    const staleJson = join(dir, '.magnusim-tmp-k3j2h1.json');
    const other = join(dir, 'meshes', '.magnusim-kept');
    for (const path of [fresh, stale, staleExt, staleJson, other]) writeFileSync(path, randomBytes(1400));
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    for (const path of [stale, staleExt, staleJson, other]) utimesSync(path, twoHoursAgo, twoHoursAgo);
    const room = await c.begin('meshes/wing.msh', 1000);
    assert.equal(room.status, 201, JSON.stringify(room.body));
    assert.deepEqual([fresh, stale, staleExt, staleJson, other].map((p) => existsSync(p)), [true, false, false, false, true]);
    assert.equal((await c.abort(room.body.upload)).body.aborted, true);
  } finally {
    await h.close();
  }

  // Empty files take no quota, but a folder holds only so many files and folders.
  h = await harness({ rows, maxEntries: 3 });
  c = client(h.base, 'p-entries');
  project('p-entries');
  try {
    assert.equal((await c.write('a/1.bin', Buffer.alloc(0))).status, 200);
    assert.equal((await c.write('b.bin', Buffer.alloc(0))).status, 200);
    const full = await c.begin('c.bin', 0);
    assert.equal(full.status, 413);
    assert.equal(full.body.code, 'quota');
    assert.equal(full.body.max_entries, 3);
    assert.equal(full.body.error, 'a plugin may keep 3 files and folders in a project');
    // Replacing a file adds none.
    assert.equal((await c.write('b.bin', Buffer.from('x'))).status, 200);
  } finally {
    await h.close();
  }

  // One disk for all: what open uploads still have to write is spoken for.
  h = await harness({ fsOps: { statfs: async () => ({ bavail: DISK_SPARE_BYTES + 100, bsize: 1 }) } });
  c = client(h.base, pid);
  try {
    const first = await c.begin('d1.bin', 60);
    assert.equal(first.status, 201);
    const second = await c.begin('d2.bin', 60);
    assert.equal(second.status, 507);
    assert.equal(second.body.code, 'disk_full');
    assert.equal(second.body.needed, 120 + DISK_SPARE_BYTES);
    // Once written, the bytes are on the disk (and in what it says is free).
    assert.equal((await c.put(first.body.upload, 0, randomBytes(60))).status, 200);
    const third = await c.begin('d3.bin', 60);
    assert.equal(third.status, 201, JSON.stringify(third.body));
    await h.files.abortAll();
  } finally {
    await h.close();
  }
});

test('protocol errors: offset, busy, a dropped chunk, incomplete, checksum, too many, another project or plugin', async () => {
  const pid = 'p-proto';
  project(pid);
  project('p-proto-2');
  const h = await harness({
    rows: [
      { key: KEY, status: 'enabled' },
      { key: 'other-plugin', status: 'enabled' },
    ],
  });
  const c = client(h.base, pid);
  try {
    const up = (await c.begin('p.bin', 20)).body.upload;
    const wrongOffset = await c.put(up, 5, Buffer.from('x'));
    assert.equal(wrongOffset.status, 409);
    assert.equal(wrongOffset.body.code, 'offset');
    assert.equal(wrongOffset.body.received, 0);
    assert.equal((await c.put(up, 'x', Buffer.from('x'))).body.code, 'bad_request');
    const early = await c.commit(up);
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'incomplete');
    assert.equal(early.body.received, 0);
    assert.equal(early.body.size, 20);

    // One chunk at a time.
    const slow = openPut(h.base, `/api/plugin-files/uploads/${up}?${c.qs({ offset: '0' })}`, {
      'content-type': 'application/octet-stream',
      'content-length': '10',
    });
    slow.req.write(Buffer.alloc(5, 1));
    // A commit meanwhile says busy (not incomplete) once the chunk is being taken.
    await eventually(async () => (await c.commit(up)).body.code === 'busy', 'the chunk to start');
    const second = await c.put(up, 0, Buffer.from('abc'));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'busy');
    slow.req.end(Buffer.alloc(5, 2));
    assert.deepEqual((await slow.answer).body, { ok: true, received: 10 });

    // A client that drops mid-chunk: what came before the chunk stays, the upload goes on.
    const dropped = openPut(h.base, `/api/plugin-files/uploads/${up}?${c.qs({ offset: '10' })}`, {
      'content-type': 'application/octet-stream',
      'content-length': '10',
    });
    dropped.answer.catch(() => undefined);
    dropped.req.write(Buffer.alloc(4, 3));
    await eventually(async () => (await c.commit(up)).body.code === 'busy', 'the dropped chunk to start');
    dropped.req.destroy();
    await eventually(async () => (await c.commit(up)).body.code === 'incomplete', 'the dropped chunk to end');
    assert.equal(statSync(join(pluginDir(pid), '.magnusim-staging', `${up}.part`)).size, 10);
    assert.equal((await c.put(up, 10, Buffer.alloc(10, 4))).body.received, 20);

    // A checksum that differs ends the upload.
    const bad = await c.commit(up, { sha256: '0'.repeat(64) });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'checksum');
    assert.equal(bad.body.sha256, sha(Buffer.concat([Buffer.alloc(5, 1), Buffer.alloc(5, 2), Buffer.alloc(10, 4)])));
    assert.equal((await c.put(up, 20, Buffer.alloc(0))).body.code, 'upload_not_found');
    assert.deepEqual(stagingParts(pid), []);
    assert.equal((await c.stat('p.bin')).body.file, null);
    assert.equal((await c.commit(up, { sha256: 'xyz' })).body.code, 'bad_request');

    // At most four open uploads per project and plugin.
    const open = [];
    for (let i = 0; i < 4; i += 1) {
      const b = await c.begin(`m${i}.bin`, 1);
      assert.equal(b.status, 201);
      open.push(b.body.upload);
    }
    const fifth = await c.begin('m4.bin', 1);
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.code, 'too_many_uploads');
    // Another plugin's slots are its own.
    const otherPlugin = client(h.base, pid, 'other-plugin');
    const theirs = await otherPlugin.begin('m.bin', 1);
    assert.equal(theirs.status, 201);

    // An upload id with another project or plugin is an unknown id.
    const mine = open[0];
    const elsewhere = await c.put(mine, 0, Buffer.from('x'), { project_id: 'p-proto-2' });
    assert.equal(elsewhere.status, 404);
    assert.equal(elsewhere.body.code, 'upload_not_found');
    assert.equal((await otherPlugin.put(mine, 0, Buffer.from('x'))).body.code, 'upload_not_found');
    assert.equal((await otherPlugin.commit(mine)).body.code, 'upload_not_found');
    assert.equal((await client(h.base, 'p-proto-2').commit(mine)).body.code, 'upload_not_found');
    assert.equal((await otherPlugin.abort(mine)).body.aborted, false);
    assert.equal((await c.put('f'.repeat(32), 0, Buffer.from('x'))).body.code, 'upload_not_found');
    assert.equal((await c.put(mine, 0, Buffer.from('x'))).body.received, 1);
    for (const id of open) assert.equal((await c.abort(id)).body.aborted, true);
    assert.equal((await c.abort(open[0])).body.aborted, false);
    assert.equal((await otherPlugin.abort(theirs.body.upload)).body.aborted, true);

    // Ids that are not ids, a project that is not there, a plugin that is not on.
    const badProject = await client(h.base, '../x').stat('a.bin');
    assert.equal(badProject.status, 400);
    assert.equal(badProject.body.code, 'bad_request');
    const noProject = await client(h.base, 'no-such-project').stat('a.bin');
    assert.equal(noProject.status, 404);
    assert.equal(noProject.body.code, 'project_not_found');
    assert.equal((await client(h.base, pid, '..').stat('a.bin')).body.code, 'bad_request');
    assert.equal((await client(h.base, pid, 'not-listed').stat('a.bin')).body.code, 'plugin_off');
  } finally {
    await h.close();
  }
});

test('atomic writes: the old file reads during an upload and after an abort; last commit wins; if_match', async () => {
  const pid = 'p-atomic';
  project(pid);
  const h = await harness();
  const c = client(h.base, pid);
  try {
    const v1 = Buffer.from('version one');
    const etag1 = (await c.write('doc.bin', v1)).body.file.etag;

    const replacing = (await c.begin('doc.bin', 5, { if_match: etag1 })).body.upload;
    assert.equal((await c.put(replacing, 0, Buffer.from('ab'))).status, 200);
    let r = await c.read('doc.bin');
    assert.ok(r.buf.equals(v1));
    assert.equal(r.headers.get('etag'), etag1);
    assert.equal((await c.abort(replacing)).body.aborted, true);
    r = await c.read('doc.bin');
    assert.ok(r.buf.equals(v1));
    assert.equal(r.headers.get('etag'), etag1);

    // Two uploads of one file: the one committed last is what stays.
    const first = (await c.begin('doc.bin', 3)).body.upload;
    const secondUp = (await c.begin('doc.bin', 3)).body.upload;
    await c.put(first, 0, Buffer.from('BBB'));
    await c.put(secondUp, 0, Buffer.from('CCC'));
    assert.equal((await c.commit(secondUp)).status, 200);
    assert.equal((await c.commit(first)).status, 200);
    assert.equal((await c.read('doc.bin')).buf.toString(), 'BBB');

    // A stale if_match: refused at begin, and at commit when the file changed in between.
    const current = (await c.stat('doc.bin')).body.file.etag;
    assert.notEqual(current, etag1);
    const stale = await c.begin('doc.bin', 1, { if_match: etag1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'changed');
    assert.equal(stale.body.etag, current);
    const guarded = (await c.begin('doc.bin', 3, { if_match: current })).body.upload;
    await c.put(guarded, 0, Buffer.from('xyz'));
    assert.equal((await c.write('doc.bin', Buffer.from('other'))).status, 200);
    const late = await c.commit(guarded);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'changed');
    assert.equal((await c.read('doc.bin')).buf.toString(), 'other');

    // if_match null: only where there is no file yet.
    const exists = await c.begin('doc.bin', 1, { if_match: null });
    assert.equal(exists.status, 409);
    assert.equal(exists.body.code, 'changed');
    assert.equal((await c.write('new.bin', Buffer.from('n'), { if_match: null })).status, 200);
    assert.equal((await c.begin('gone.bin', 1, { if_match: '"1-1-1"' })).body.code, 'changed');
    assert.equal((await c.begin('x.bin', 1, { if_match: 5 })).body.code, 'bad_request');

    // A read naming an etag the file no longer has.
    const now = (await c.stat('doc.bin')).body.file.etag;
    const old = await c.read('doc.bin', { 'if-match': etag1 });
    assert.equal(old.status, 409);
    assert.equal(old.body.code, 'changed');
    assert.equal(old.body.etag, now);
    assert.equal((await c.read('doc.bin', { 'if-match': now })).status, 200);
    // Compared as sent, as begin and commit compare if_match: "*" and "" match no file.
    for (const tag of ['*', '']) {
      const r = await c.read('doc.bin', { 'if-match': tag });
      assert.equal(r.status, 409, JSON.stringify(tag));
      assert.equal(r.body.code, 'changed');
      assert.equal((await c.begin('doc.bin', 1, { if_match: tag })).body.code, 'changed');
    }
    assert.deepEqual(stagingParts(pid), []);
  } finally {
    await h.close();
  }
});

/** A promise and the function that settles it. */
function gate() {
  let open = () => {};
  const opened = new Promise((done) => (open = done));
  return { open, opened };
}

test('one change at a time in a plugin folder: create-only commits of one file, a delete during a commit', async () => {
  const pid = 'p-lock';
  project(pid);
  // The next rename waits at `reached` until `go` opens (a commit caught mid-rename, in the folder's lock).
  let pause = null;
  const h = await harness({
    fsOps: {
      rename: async (from, to) => {
        const p = pause;
        pause = null;
        if (p) {
          p.reached.open();
          await p.go.opened;
        }
        await fsp.rename(from, to);
      },
    },
  });
  const c = client(h.base, pid);
  const hold = () => (pause = { reached: gate(), go: gate() });
  /** Whether the promise settles within ms (it should be waiting for the lock). */
  const settlesWithin = (p, ms) => Promise.race([p.then(() => true), delay(ms).then(() => false)]);
  try {
    // Two uploads that may only create new.bin: the second commit waits, then finds it made.
    const a = (await c.begin('new.bin', 1, { if_match: null })).body.upload;
    const b = (await c.begin('new.bin', 1, { if_match: null })).body.upload;
    await c.put(a, 0, Buffer.from('A'));
    await c.put(b, 0, Buffer.from('B'));
    const p = hold();
    const first = c.commit(a);
    await p.reached.opened;
    const second = c.commit(b);
    assert.equal(await settlesWithin(second, 150), false);
    p.go.open();
    assert.equal((await first).status, 200);
    const refused = await second;
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'changed');
    assert.equal((await c.read('new.bin')).buf.toString(), 'A');

    // A delete of the folder a commit writes into waits for it, then takes the new file too.
    assert.equal((await c.write('dir-x/old.bin', Buffer.from('old'))).status, 200);
    const up = (await c.begin('dir-x/new.bin', 3)).body.upload;
    await c.put(up, 0, Buffer.from('new'));
    const q = hold();
    const commit = c.commit(up);
    await q.reached.opened;
    const del = c.del('dir-x', true);
    assert.equal(await settlesWithin(del, 150), false);
    q.go.open();
    assert.equal((await commit).status, 200);
    assert.deepEqual((await del).body, { ok: true, deleted: 2 });
    assert.equal(existsSync(join(pluginDir(pid), 'dir-x')), false);

    // A folder another program removed just before the rename is made again.
    const again = (await c.begin('dir-y/z.bin', 1)).body.upload;
    await c.put(again, 0, Buffer.from('z'));
    const r = hold();
    const made = c.commit(again);
    await r.reached.opened;
    rmSync(join(pluginDir(pid), 'dir-y'), { recursive: true, force: true });
    r.go.open();
    assert.equal((await made).status, 200);
    assert.equal((await c.read('dir-y/z.bin')).buf.toString(), 'z');
    assert.deepEqual(stagingParts(pid), []);
  } finally {
    await h.close();
  }
});

test("study rules: a study's record and folders are never written or deleted; files in a removed study are refused", async () => {
  const pid = 'p-study';
  project(pid);
  const h = await harness();
  const c = client(h.base, pid);
  try {
    const studies = join(pluginDir(pid), 'studies');
    const record = join(studies, 'st-1', 'study.json');
    const REC = JSON.stringify({ id: 'st-1', rev: 3 });
    mkdirSync(join(studies, 'st-1'), { recursive: true });
    writeFileSync(record, REC);
    const vectors = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    for (const rel of vectors.refused_write) {
      const b = await c.begin(rel, 1);
      assert.equal(b.status, 403, rel);
      assert.equal(b.body.code, 'study_record');
      assert.equal(b.body.error, "a study's record changes only through the study calls");
      assert.equal((await c.del(rel)).body.code, 'study_record', rel);
    }
    assert.equal(readFileSync(record, 'utf8'), REC);
    // Reading one is allowed.
    assert.equal((await c.stat('studies/st-1/study.json')).body.file.size, REC.length);
    assert.equal((await c.read('Studies/ST-1/study.json')).status, process.platform === 'win32' ? 200 : 404);
    assert.equal((await c.read('studies/st-1/study.json')).buf.toString(), REC);
    for (const rel of vectors.study_containers) {
      const d = await c.del(rel, true);
      assert.equal(d.status, 403, rel);
      assert.equal(d.body.code, 'study_record', rel);
      // Nor is a file written there: it would stand where a study's folder goes.
      const b = await c.begin(rel, 1);
      assert.equal(b.status, 403, rel);
      assert.equal(b.body.code, 'study_record', rel);
      assert.equal(b.body.error, STUDY_FOLDER_WRITE);
    }
    assert.equal(readFileSync(record, 'utf8'), REC);
    assert.deepEqual(readdirSync(studies), ['st-1']);

    // A study's own files: only while the study is there.
    assert.equal((await c.write('studies/st-1/imports/abc/source.step', Buffer.from('solid'))).status, 200);
    const noStudy = await c.begin('studies/st-9/x.bin', 1);
    assert.equal(noStudy.status, 404);
    assert.equal(noStudy.body.code, 'study_not_found');
    assert.equal(existsSync(join(studies, 'st-9')), false);

    // The study removed between begin and commit: refused, and its folder not made again.
    mkdirSync(join(studies, 'st-2'), { recursive: true });
    writeFileSync(join(studies, 'st-2', 'study.json'), '{}');
    const up = (await c.begin('studies/st-2/imports/a.step', 3)).body.upload;
    assert.equal((await c.put(up, 0, Buffer.from('abc'))).status, 200);
    rmSync(join(studies, 'st-2'), { recursive: true, force: true });
    const late = await c.commit(up);
    assert.equal(late.status, 404);
    assert.equal(late.body.code, 'study_not_found');
    assert.equal(existsSync(join(studies, 'st-2')), false);
    assert.deepEqual(stagingParts(pid), []);
  } finally {
    await h.close();
  }
});

test('resolved checks: links to a study or out of the plugin folder are refused, and never followed by a delete', async (t) => {
  const pid = 'p-links';
  project(pid);
  const dir = pluginDir(pid);
  const outside = join(ROOT, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'keep me');
  mkdirSync(join(dir, 'studies', 'st-1'), { recursive: true });
  writeFileSync(join(dir, 'studies', 'st-1', 'study.json'), '{"id":"st-1"}');
  mkdirSync(join(dir, 'box'), { recursive: true });
  writeFileSync(join(dir, 'box', 'own.bin'), 'mine');
  try {
    symlinkSync(join(dir, 'studies', 'st-1'), join(dir, 'lnk'), LINK);
    symlinkSync(join(dir, 'studies'), join(dir, 'alias'), LINK);
    mkdirSync(join(dir, '.magnusim-staging'), { recursive: true });
    writeFileSync(join(dir, '.magnusim-staging', `${'0'.repeat(32)}.part`), 'half');
    symlinkSync(join(dir, '.magnusim-staging'), join(dir, 'st'), LINK);
    symlinkSync(outside, join(dir, 'out'), LINK);
    symlinkSync(outside, join(dir, 'box', 'out'), LINK);
    symlinkSync(join(PROJECTS, pid), join(dir, 'proj'), LINK);
    // A link swapped in for a whole plugin folder.
    project('p-swapped');
    mkdirSync(join(PROJECTS, 'p-swapped', 'plugins'), { recursive: true });
    symlinkSync(outside, pluginDir('p-swapped'), LINK);
  } catch (err) {
    t.skip(`links cannot be made here (${err.code})`);
    return;
  }
  const h = await harness();
  const c = client(h.base, pid);
  try {
    // Through a link to a study: its record stays unwritable.
    const viaLink = await c.begin('lnk/study.json', 1);
    assert.equal(viaLink.status, 403);
    assert.equal(viaLink.body.code, 'study_record');
    assert.equal((await c.del('lnk/study.json')).body.code, 'study_record');
    assert.equal((await c.stat('lnk/study.json')).body.file.rel, 'studies/st-1/study.json');
    // Through a link to the studies folder: a study's folder is not deleted, nor a file put where one goes.
    const viaAlias = await c.del('alias/st-1', true);
    assert.equal(viaAlias.status, 403);
    assert.equal(viaAlias.body.code, 'study_record');
    assert.equal((await c.begin('alias/new.bin', 1)).body.code, 'study_record');
    assert.ok(existsSync(join(dir, 'studies', 'st-1', 'study.json')));
    // Through a link to the app's staging folder: its names are refused where they land.
    const part = `st/${'0'.repeat(32)}.part`;
    for (const res of [await c.stat(part), await c.read(part), await c.begin('st/x.bin', 1), await c.list('st'), await c.del(part)]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'invalid_path');
    }
    assert.equal(readFileSync(join(dir, '.magnusim-staging', `${'0'.repeat(32)}.part`), 'utf8'), 'half');
    // Out of the plugin's folder: refused whatever the call.
    for (const res of [
      await c.stat('out/secret.txt'),
      await c.read('out/secret.txt'),
      await c.begin('out/new.bin', 1),
      await c.list('out'),
      await c.stat('proj/project.json'),
      await c.begin('proj/project.json', 1),
    ]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'invalid_path');
    }
    // The list never follows a link.
    const listed = (await c.list('')).body.files.map((f) => f.rel);
    assert.deepEqual(listed, ['box/own.bin', 'studies/st-1/study.json']);
    // Deleting a folder that holds a link removes the link, never what it leads to.
    assert.deepEqual((await c.del('box', true)).body, { ok: true, deleted: 1 });
    assert.equal(existsSync(join(dir, 'box')), false);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep me');
    // Deleting a link removes the link itself.
    assert.deepEqual((await c.del('out')).body, { ok: true, deleted: 1 });
    assert.deepEqual((await c.del('lnk', true)).body, { ok: true, deleted: 1 });
    assert.equal(existsSync(join(dir, 'out')), false);
    assert.equal(existsSync(join(dir, 'lnk')), false);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep me');
    assert.ok(existsSync(join(dir, 'studies', 'st-1', 'study.json')));

    const swapped = client(h.base, 'p-swapped');
    for (const res of [await swapped.stat('secret.txt'), await swapped.begin('x.bin', 1), await swapped.list(''), await swapped.del('secret.txt')]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'invalid_path');
    }
    assert.deepEqual(readdirSync(outside), ['secret.txt']);
  } finally {
    await h.close();
  }
});

test('names come back as spelled on disk; a plugin folder in another case is still its folder on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const pid = 'p-case';
  project(pid);
  mkdirSync(join(PROJECTS, pid, 'plugins', KEY.toUpperCase(), 'Models'), { recursive: true });
  writeFileSync(join(PROJECTS, pid, 'plugins', KEY.toUpperCase(), 'Models', 'Part.STEP'), 'solid');
  const h = await harness();
  const c = client(h.base, pid);
  try {
    const st = await c.stat('models/part.step');
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.file.rel, 'Models/Part.STEP');
    assert.deepEqual((await c.list('MODELS')).body.files.map((f) => f.rel), ['Models/Part.STEP']);
    const replaced = await c.write('models/part.step', Buffer.from('new'));
    assert.equal(replaced.body.file.rel, 'Models/Part.STEP');
    assert.equal(readFileSync(join(PROJECTS, pid, 'plugins', KEY.toUpperCase(), 'Models', 'Part.STEP'), 'utf8'), 'new');
    // Replaced in place: no second spelling of the file appeared.
    assert.deepEqual(readdirSync(join(PROJECTS, pid, 'plugins')), [KEY.toUpperCase()]);
    assert.deepEqual(readdirSync(join(PROJECTS, pid, 'plugins', KEY.toUpperCase(), 'Models')), ['Part.STEP']);
  } finally {
    await h.close();
  }
});

test('failure injection: a held target, a full disk, idle uploads, stale staging files', async () => {
  const pid = 'p-fail';
  project(pid);
  const held = { fails: 2, calls: 0 };
  const eperm = () => Object.assign(new Error('held by another program'), { code: 'EPERM' });
  let h = await harness({
    fsOps: {
      rename: async (from, to) => {
        held.calls += 1;
        if (held.fails > 0) {
          held.fails -= 1;
          throw eperm();
        }
        await fsp.rename(from, to);
      },
    },
  });
  let c = client(h.base, pid);
  try {
    // Refused twice, then renamed.
    assert.equal((await c.write('r.bin', Buffer.from('one'))).status, 200);
    assert.equal(held.calls, 3);
    // Refused eight times: busy, and the upload stays so the commit can be tried again.
    held.fails = 8;
    held.calls = 0;
    const up = (await c.begin('r.bin', 3)).body.upload;
    await c.put(up, 0, Buffer.from('two'));
    const busy = await c.commit(up);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'busy');
    assert.equal(busy.body.error, 'r.bin is in use by another program');
    assert.equal(held.calls, 8);
    assert.equal((await c.read('r.bin')).buf.toString(), 'one');
    const again = await c.commit(up);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await c.read('r.bin')).buf.toString(), 'two');
  } finally {
    await h.close();
  }

  // A folder on the way that another program holds, and files and folders held while deleting.
  const fail = { mkdir: 0, unlink: 0, rm: 0 };
  const flaky =
    (name, real) =>
    async (...args) => {
      if (fail[name] > 0) {
        fail[name] -= 1;
        throw eperm();
      }
      return real(...args);
    };
  h = await harness({
    fsOps: {
      mkdir: flaky('mkdir', (p, o) => fsp.mkdir(p, o)),
      unlink: flaky('unlink', (p) => fsp.unlink(p)),
      rm: flaky('rm', (p, o) => fsp.rm(p, o)),
    },
  });
  c = client(h.base, pid);
  try {
    // Refused making sub/: busy, and the upload stays for the commit to be tried again.
    const up = (await c.begin('sub/x.bin', 1)).body.upload;
    await c.put(up, 0, Buffer.from('x'));
    fail.mkdir = 1;
    const busy = await c.commit(up);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'busy');
    assert.equal(busy.body.error, 'sub/x.bin is in use by another program');
    assert.equal((await c.commit(up)).status, 200);
    assert.equal((await c.read('sub/x.bin')).buf.toString(), 'x');

    // A file held twice is deleted on the third try; held throughout, it is busy and stays.
    fail.unlink = 2;
    assert.deepEqual((await c.del('sub/x.bin')).body, { ok: true, deleted: 1 });
    assert.equal((await c.write('sub/y.bin', Buffer.from('y'))).status, 200);
    fail.unlink = 8;
    const heldFile = await c.del('sub/y.bin');
    assert.equal(heldFile.status, 409);
    assert.equal(heldFile.body.code, 'busy');
    assert.equal(heldFile.body.error, 'sub/y.bin is in use by another program');
    assert.equal(fail.unlink, 0);
    fail.rm = 1;
    const heldFolder = await c.del('sub', true);
    assert.equal(heldFolder.status, 409);
    assert.equal(heldFolder.body.error, 'sub is in use by another program');
    assert.equal(readFileSync(join(pluginDir(pid), 'sub', 'y.bin'), 'utf8'), 'y');
    assert.deepEqual((await c.del('sub', true)).body, { ok: true, deleted: 1 });
  } finally {
    await h.close();
  }

  // The disk fills mid-chunk: the upload ends and its staging file goes.
  h = await harness({
    fsOps: {
      createWriteStream: () =>
        new Writable({
          write(_chunk, _enc, done) {
            done(Object.assign(new Error('no space left'), { code: 'ENOSPC' }));
          },
        }),
    },
  });
  c = client(h.base, pid);
  try {
    const up = (await c.begin('full.bin', 4)).body.upload;
    const full = await c.put(up, 0, Buffer.from('abcd'));
    assert.equal(full.status, 507);
    assert.equal(full.body.code, 'disk_full');
    assert.ok(!stagingParts(pid).includes(`${up}.part`));
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'upload_not_found');
  } finally {
    await h.close();
  }

  // Too little free space: refused at begin.
  h = await harness({ fsOps: { statfs: async () => ({ bavail: 10, bsize: 4096 }) } });
  c = client(h.base, pid);
  try {
    const low = await c.begin('big.bin', 1000);
    assert.equal(low.status, 507);
    assert.equal(low.body.code, 'disk_full');
    assert.equal(low.body.needed, 1000 + DISK_SPARE_BYTES);
    assert.equal(low.body.free, 40_960);
  } finally {
    await h.close();
  }

  // An upload idle for ten minutes is dropped with its staging file.
  let clock = Date.now();
  h = await harness({ now: () => clock });
  c = client(h.base, pid);
  try {
    const up = (await c.begin('idle.bin', 4)).body.upload;
    assert.equal((await c.put(up, 0, Buffer.from('ab'))).status, 200);
    clock += UPLOAD_IDLE_MS - 1;
    assert.equal((await c.put(up, 2, Buffer.from('c'))).status, 200);
    clock += UPLOAD_IDLE_MS;
    const expired = await c.put(up, 3, Buffer.from('d'));
    assert.equal(expired.status, 404);
    assert.equal(expired.body.code, 'upload_not_found');
    assert.ok(!stagingParts(pid).includes(`${up}.part`));
    assert.equal((await c.stat('idle.bin')).body.file, null);
  } finally {
    await h.close();
  }

  // Staging files an hour old that no upload owns go at the next begin.
  h = await harness();
  c = client(h.base, pid);
  try {
    const staging = join(pluginDir(pid), '.magnusim-staging');
    mkdirSync(staging, { recursive: true });
    const stale = `${'a'.repeat(32)}.part`;
    const fresh = `${'b'.repeat(32)}.part`;
    writeFileSync(join(staging, stale), 'left by a crash');
    writeFileSync(join(staging, fresh), 'another server, just now');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(staging, stale), twoHoursAgo, twoHoursAgo);
    const up = (await c.begin('any.bin', 1)).body.upload;
    assert.equal(existsSync(join(staging, stale)), false);
    assert.equal(existsSync(join(staging, fresh)), true);
    assert.equal((await c.abort(up)).body.aborted, true);
  } finally {
    await h.close();
  }
});

class CountingWorker extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.status = 'enabled';
  }

  async call(method) {
    this.calls.push(method);
    if (method === 'plugins.list') {
      const rows = this.status ? [{ key: KEY, status: this.status, files: { max_file_bytes: 1 << 20, max_total_bytes: 4 << 20 } }] : [];
      return { plugins: rows };
    }
    if (method === 'plugins.env') return { name: 'CAD demo', env: { state: 'ready', service: '' } };
    return { ok: true };
  }
}

test('plugin state through the app routes: only a plugin that is on; turning it off or on, reloading or its environment ends its uploads; no worker call for bytes', async () => {
  const pid = 'p-state';
  project(pid);
  const worker = new CountingWorker();
  const router = new Router();
  // An environment builder that runs nothing: `built` ends the build the test started.
  const installs = [];
  let built = () => {};
  const envInstaller = (onBuilt) => ({
    get: () => null,
    start(key) {
      installs.push(key);
      built = () => onBuilt(key);
      return { state: 'installing', stage: 'start', label: 'Starting', log: [], started_at: new Date().toISOString() };
    },
  });
  registerPhase3Routes(router, {
    worker,
    envInstaller,
    jobs: new JobManager({ cacheDir: join(ROOT, 'jobs-state') }),
    webRoot: ROOT,
    cacheDir: join(ROOT, 'cache'),
    serveLegacyFilter: async () => {},
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
  });
  const srv = await serve(router);
  const c = client(srv.base, pid);
  const post = (path, body = {}) =>
    fetch(srv.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const data = randomBytes(5000);
    const written = await c.write('a.bin', data, { chunks: [1234, 3766] });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    assert.ok((await c.read('a.bin')).buf.equals(data));
    assert.equal((await c.list('')).body.files.length, 1);
    await c.del('a.bin');
    // The bytes never went to the worker: it was only asked for the plugin list.
    assert.ok(worker.calls.length > 0);
    assert.deepEqual([...new Set(worker.calls)], ['plugins.list']);
    // The plugin's own [files] limit.
    const big = await c.begin('big.bin', (1 << 20) + 1);
    assert.equal(big.body.code, 'too_large');
    assert.equal(big.body.limit, 1 << 20);

    // Turned off mid-upload.
    let up = (await c.begin('b.bin', 4)).body.upload;
    assert.equal((await c.put(up, 0, Buffer.from('ab'))).status, 200);
    worker.status = 'disabled';
    assert.equal((await post(`/api/plugins/${KEY}/disable`)).status, 200);
    const off = await c.put(up, 2, Buffer.from('cd'));
    assert.equal(off.status, 404);
    assert.equal(off.body.code, 'plugin_off');
    assert.equal((await c.stat('b.bin')).body.code, 'plugin_off');
    await eventually(() => !stagingParts(pid).includes(`${up}.part`), 'the staging file to go');
    worker.status = 'enabled';
    assert.equal((await post(`/api/plugins/${KEY}/enable`)).status, 200);
    assert.equal((await c.put(up, 2, Buffer.from('cd'))).body.code, 'upload_not_found');
    // Turning it on restarts it: an upload open then ends too.
    up = (await c.begin('b.bin', 4)).body.upload;
    assert.equal((await post(`/api/plugins/${KEY}/enable`)).status, 200);
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'upload_not_found');

    // Its environment rebuilt: the uploads end when the build starts and when it ends,
    // and the plugin list is read again each time (its status may have changed).
    up = (await c.begin('e.bin', 4)).body.upload;
    const install = await post(`/api/plugins/${KEY}/env/install`);
    assert.equal(install.status, 202, await install.text());
    assert.deepEqual(installs, [KEY]);
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'upload_not_found');
    up = (await c.begin('e.bin', 4)).body.upload;
    worker.status = 'disabled';
    assert.equal((await c.stat('e.bin')).status, 200);
    built();
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'plugin_off');
    assert.equal((await c.stat('e.bin')).body.code, 'plugin_off');
    await eventually(() => stagingParts(pid).length === 0, 'the staging file to go');
    worker.status = 'enabled';
    assert.equal((await c.stat('e.bin')).body.code, 'plugin_off');
    assert.equal((await post(`/api/plugins/${KEY}/env/install`)).status, 202);
    assert.equal((await c.stat('e.bin')).status, 200);
    worker.status = 'disabled';
    assert.equal((await c.stat('e.bin')).status, 200);
    assert.equal((await post(`/api/plugins/${KEY}/env/remove`)).status, 200);
    assert.equal((await c.stat('e.bin')).body.code, 'plugin_off');
    worker.status = 'enabled';
    worker.emit('registry-changed');

    // Needs setup, or not listed at all: the same answer (the list refreshes on registry-changed).
    for (const status of ['needs setup', null]) {
      worker.status = status;
      worker.emit('registry-changed');
      const r = await c.stat('b.bin');
      assert.equal(r.status, 404);
      assert.equal(r.body.code, 'plugin_off');
    }
    // The list is cached briefly and dropped on registry-changed.
    worker.status = 'enabled';
    worker.emit('registry-changed');
    assert.equal((await c.stat('b.bin')).status, 200);
    worker.status = 'disabled';
    assert.equal((await c.stat('b.bin')).status, 200);
    worker.emit('registry-changed');
    assert.equal((await c.stat('b.bin')).body.code, 'plugin_off');
    worker.status = 'enabled';
    worker.emit('registry-changed');

    // Its JSON files (ws.data) follow the same rule, refused before any worker call.
    const dataCall = (action, extra = {}) => post(`/api/plugin-data/${action}`, { project_id: pid, plugin: KEY, rel: 'notes/n.json', ...extra });
    let from = worker.calls.length;
    assert.equal((await dataCall('write', { doc: { n: 1 } })).status, 200);
    assert.deepEqual(worker.calls.slice(from).filter((m) => m !== 'plugins.list'), ['plugin_data.write']);
    for (const status of ['disabled', 'needs setup', null]) {
      worker.status = status;
      worker.emit('registry-changed');
      from = worker.calls.length;
      for (const action of ['read', 'write']) {
        const r = await dataCall(action, action === 'write' ? { doc: { n: 2 } } : {});
        assert.equal(r.status, 404, `${status} ${action}`);
        assert.equal((await r.json()).code, 'plugin_off');
      }
      assert.deepEqual(worker.calls.slice(from).filter((m) => m !== 'plugins.list'), [], String(status));
    }
    worker.status = 'enabled';
    worker.emit('registry-changed');

    // Its environment removed, or the plugins reloaded.
    up = (await c.begin('c.bin', 4)).body.upload;
    assert.equal((await post(`/api/plugins/${KEY}/env/remove`)).status, 200);
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'upload_not_found');
    up = (await c.begin('d.bin', 4)).body.upload;
    assert.equal((await post('/api/worker', { method: 'registry.reload' })).status, 200);
    assert.equal((await c.put(up, 0, Buffer.from('abcd'))).body.code, 'upload_not_found');
    await eventually(() => stagingParts(pid).length === 0, 'every staging file to go');
    const allowed = new Set(['plugins.list', 'plugins.enable', 'plugins.disable', 'plugins.env', 'plugins.env_remove', 'registry.reload', 'plugin_data.write']);
    assert.deepEqual(worker.calls.filter((m) => !allowed.has(m)), []);
  } finally {
    await srv.close();
  }
});

test('a list stops at 10000 files, the first in rel order, and says so', async () => {
  const pid = 'p-many';
  project(pid);
  const dir = join(pluginDir(pid), 'many');
  mkdirSync(dir, { recursive: true });
  // "Zz.bin" sorts first by code unit but last on NTFS (no case): the cut comes after the sort.
  for (let i = 0; i < LIST_MAX; i += 1) writeFileSync(join(dir, `f${String(i).padStart(5, '0')}.bin`), '');
  writeFileSync(join(dir, 'Zz.bin'), '');
  const h = await harness();
  const c = client(h.base, pid);
  try {
    const listed = await c.list('many');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.truncated, true);
    assert.equal(listed.body.files.length, LIST_MAX);
    assert.equal(listed.body.files[0].rel, 'many/Zz.bin');
    assert.equal(listed.body.files[1].rel, 'many/f00000.bin');
    assert.equal(listed.body.files.at(-1).rel, 'many/f09998.bin');
    rmSync(join(dir, 'Zz.bin'));
    const exact = await c.list('many');
    assert.equal(exact.body.truncated, false);
    assert.equal(exact.body.files.length, LIST_MAX);
  } finally {
    await h.close();
  }
});

test("Python's file_info gives the host's etag and mtime, before 1970 too", { skip: !existsSync(PYTHON) && 'no Python here' }, async () => {
  const pid = 'p-etag';
  project(pid);
  mkdirSync(pluginDir(pid), { recursive: true });
  const times = {
    'now.bin': null,
    'sub-ms.bin': 1_700_000_000_123_456_700n,
    'epoch.bin': 0n,
    'before-1970.bin': -1_500_000n,
    'long-ago.bin': -946_080_000_123_456_700n,
  };
  for (const name of Object.keys(times)) writeFileSync(join(pluginDir(pid), name), name);
  const script = [
    'import json, os, sys',
    'from magnusim_sdk.data import PluginData',
    'data = PluginData(sys.argv[1], sys.argv[2])',
    'for name, ns in json.loads(sys.argv[3]).items():',
    '    if ns is not None:',
    '        os.utime(data.root / name, ns=(int(ns), int(ns)))',
    'print(json.dumps(data.list_files()))',
  ].join('\n');
  const asText = JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v === null ? null : String(v)])));
  const out = execFileSync(PYTHON, ['-c', script, projectDir(pid), KEY, asText], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: resolve(HERE, '..', '..', '..', 'python', 'sdk') },
  });
  const h = await harness();
  const c = client(h.base, pid);
  try {
    const fromPython = JSON.parse(out);
    const fromHost = (await c.list('')).body.files;
    assert.equal(fromHost.length, 5);
    assert.deepEqual(fromPython, fromHost);
    for (const f of fromHost) assert.deepEqual((await c.stat(f.rel)).body.file, f);
  } finally {
    await h.close();
  }
});

test('a plugin file read is an API request, not a frame asset', () => {
  assert.equal(isFrameAssetRequest('GET', '/api/plugin-files/read?x'), false);
  assert.equal(isFrameAssetRequest('HEAD', '/api/plugin-files/read?project_id=p&plugin=k&rel=a.bin'), false);
  assert.equal(isFrameAssetRequest('GET', '/plugins/k/workspace/../../api/plugin-files/read?rel=a'), false);
});

test('a plugin job is told its plugin, project, study, geometry and job id; a builtin job is not', () => {
  const pid = 'p-job';
  project(pid);
  const seen = [];
  const jobs = { spawnPython: (id, script, args, extra) => seen.push({ id, script, args, extra }), finish() {} };
  const params = { project_id: pid, simulation_id: 'sim-1', geometry_id: 'geo-1' };
  startRegisteredJob(jobs, { tool: 'bake.py', tool_path: join(ROOT, 'bake.py'), plugin: KEY }, params, { id: 'job-1' });
  assert.deepEqual(seen[0].extra.env, {
    MAGNUSIM_PLUGIN_KEY: KEY,
    MAGNUSIM_PROJECT_ID: pid,
    MAGNUSIM_PROJECT_DIR: projectDir(pid),
    MAGNUSIM_SIMULATION_ID: 'sim-1',
    MAGNUSIM_GEOMETRY_ID: 'geo-1',
    MAGNUSIM_JOB_ID: 'job-1',
  });
  // Only what is known.
  startRegisteredJob(jobs, { tool: 'bake.py', tool_path: join(ROOT, 'bake.py'), plugin: KEY }, { project_id: pid }, { id: 'job-2' });
  assert.deepEqual(Object.keys(seen[1].extra.env).sort(), ['MAGNUSIM_JOB_ID', 'MAGNUSIM_PLUGIN_KEY', 'MAGNUSIM_PROJECT_DIR', 'MAGNUSIM_PROJECT_ID']);
  startRegisteredJob(jobs, { tool: 'export_case_field.py', plugin: 'builtin' }, params, { id: 'job-3' });
  assert.equal(seen[2].extra.env, undefined);
});

test('the plugin job process sees those variables', { skip: !existsSync(PYTHON) && 'no Python here' }, async () => {
  const pid = 'p-job';
  project(pid);
  const script = join(ROOT, 'print_env.py');
  // Only the job's own variables (the shell running the tests may set others, such as MAGNUSIM_PYTHON).
  const names = ['PLUGIN_KEY', 'PROJECT_ID', 'PROJECT_DIR', 'SIMULATION_ID', 'GEOMETRY_ID', 'JOB_ID'].map((n) => `MAGNUSIM_${n}`);
  writeFileSync(
    script,
    [
      'import json, os, sys',
      'out = sys.argv[sys.argv.index("--out") + 1]',
      `names = ${JSON.stringify(names)}`,
      'with open(out, "w", encoding="utf-8") as fh:',
      '    json.dump({k: os.environ[k] for k in names if k in os.environ}, fh)',
      '',
    ].join('\n'),
  );
  const jobs = new JobManager({ cacheDir: join(ROOT, 'jobs-env') });
  const params = { project_id: pid, geometry_id: 'geo-2', out: join(ROOT, 'job-env.json') };
  const job = jobs.create('plugin_job', params, pid);
  const ended = new Promise((done) => jobs.onEvents(job.id).once('end', done));
  startRegisteredJob(jobs, { tool: 'print_env.py', tool_path: script, plugin: KEY, args_from_params: ['out'] }, params, job);
  const rec = await ended;
  assert.equal(rec.status, 'done', String(rec.error));
  assert.deepEqual(JSON.parse(readFileSync(params.out, 'utf8')), {
    MAGNUSIM_PLUGIN_KEY: KEY,
    MAGNUSIM_PROJECT_ID: pid,
    MAGNUSIM_PROJECT_DIR: projectDir(pid),
    MAGNUSIM_GEOMETRY_ID: 'geo-2',
    MAGNUSIM_JOB_ID: job.id,
  });
});
