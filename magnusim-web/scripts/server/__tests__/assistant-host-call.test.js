// The host tools' write path (core host tools spec C1, §3) and host-tool images (C6): a tool
// names an entry of the frozen HOST_ROUTES table, never a path. The denylist (this file's own
// copy of §3.3) holds for the table, for any table a caller brings, and for every call's body.
// Each call carries the turn and tool headers and JSON as application/json; a turn makes at
// most 5 calls and 2 writes a second; a raw body streams the file with its length; a binary
// route answers bytes (or its JSON, when the app answers JSON); the link gate's 503 is tried
// once more after its Retry-After, then fails geometry_updating; a 409 geometry_changed or
// stale_record fails at once with its words; a 4xx's text reaches the tool with paths taken
// out, a 5xx's never.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-host-call-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const hc = await import('../assistant/host-call.ts');
const { HOST_ROUTES, HOST_GET_ALLOWLIST, STARTER_ROUTES, HostCallError, createHostTransport, deniedRoute, checkRouteTable, TOOL_HEADER, HOST_WRITE_RATE, LINK_RETRY_MAX_MS, WORKER_METHODS } = hc;
const { TURN_HEADER } = await import('../assistant/access.ts');
const { HOST_ROUTE_TABLE } = await import('../assistant/host-routes.ts');

/** An app that records every request and answers by path (status, JSON or bytes, headers). */
async function fakeApp() {
  const seen = [];
  const answers = new Map();
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(parts);
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body });
      const answer = answers.get(url.pathname) ?? (() => ({ status: 200, json: { ok: true } }));
      const a = answer(seen.at(-1), seen.filter((s) => s.path === url.pathname).length);
      res.statusCode = a.status ?? 200;
      for (const [k, v] of Object.entries(a.headers ?? {})) res.setHeader(k, v);
      if (a.bytes) {
        res.setHeader('content-type', a.type ?? 'image/png');
        res.end(a.bytes);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(a.json ?? {}));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    seen,
    answers,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

let app;
let clock = 0;
const now = () => clock;
const tick = (ms = 1_000) => (clock += ms);
before(async () => {
  app = await fakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

/** A test table: routes of every kind the tools will have. */
const TABLE = {
  'thing.get': { method: 'GET', path: '/api/thing', query: (a) => ({ project_id: a.project_id, n: a.n }), band: 'read' },
  'thing.save': { method: 'POST', path: '/api/thing/save', body: (a) => ({ project_id: a.project_id, name: a.name }), band: 'write' },
  'thing.patch': { method: 'PATCH', path: '/api/thing/order', body: (a) => ({ ids: a.ids }), band: 'write' },
  'thing.peek': { method: 'POST', path: '/api/thing/peek', body: (a) => ({ project_id: a.project_id }), band: 'read' },
  'env.install': { method: 'POST', path: '/api/plugins/:key/env/install', body: () => ({}), band: 'write' },
  'bcs.save': { method: 'POST', path: '/api/bcs', body: (a) => ({ project_id: a.project_id, delete: a.delete }), band: 'write' },
  'worker.bcs': { method: 'POST', path: '/api/worker', worker: 'bcs.set', body: (a) => ({ method: a.method, params: {} }), band: 'write' },
  'import.path': { method: 'POST', path: '/api/geometry/import', body: (a) => ({ project_id: a.project_id, step_path: a.step_path, ...(a.mode ? { mode: a.mode } : {}) }), timeoutMs: 600_000, band: 'write' },
  'import.raw': {
    method: 'POST',
    path: '/api/geometry/import',
    query: (a) => ({ project_id: a.project_id, filename: a.name }),
    raw: (a) => ({ stream: createReadStream(a.file), bytes: a.bytes, type: 'application/octet-stream' }),
    timeoutMs: 600_000,
    band: 'write',
  },
  'thumb.get': { method: 'GET', path: '/api/geometry/thumb', query: (a) => ({ project_id: a.project_id }), binary: true, maxBytes: 64, band: 'read' },
};

const transport = (o = {}) => createHostTransport({ port: () => app.port, now, routes: TABLE, retryDelayMs: () => 20, ...o });
const opts = (o = {}) => ({ turn: 't-1', tool: 'setup_edit.bc', ...o });

describe('HOST_ROUTES: one frozen table, checked against the denylist', () => {
  it('is frozen, entry by entry; the starter entries are the GET allowlist; every entry passes the check', () => {
    assert.ok(Object.isFrozen(HOST_ROUTES));
    for (const [id, r] of Object.entries(HOST_ROUTES)) {
      assert.ok(Object.isFrozen(r), id);
      assert.equal(deniedRoute(r), null, id);
    }
    assert.throws(() => {
      HOST_ROUTES['x.y'] = { method: 'GET', path: '/api/x', band: 'read' };
    });
    assert.deepEqual([...STARTER_ROUTES], ['queue.get', 'projects.list', 'project.get', 'simulation.get', 'run.ready']);
    assert.deepEqual([...HOST_GET_ALLOWLIST], ['/api/compute-queue', '/api/projects', '/api/project', '/api/simulation', '/api/run/ready']);
    assert.deepEqual(Object.keys(HOST_ROUTES), Object.keys(HOST_ROUTE_TABLE));
    assert.equal(HOST_ROUTES['geometry.thumb'].binary, true, 'host-tool images (C6)');
  });

  // §3.3, written out here: a change to deniedRoute can't quietly allow one of these.
  const DENIED = [
    { method: 'GET', path: '/api/assistant/status', band: 'read' },
    { method: 'POST', path: '/api/assistant/turns', body: () => ({}), band: 'write' },
    { method: 'GET', path: '/api/Assistant/settings', band: 'read' },
    { method: 'POST', path: '/api/plugins/:key/enable', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/plugins/:key/disable', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/plugins/:key/remove', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/plugins/:key/env/remove', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/plugins/package/install', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/plugins/package', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/prefs', body: () => ({}), band: 'write' },
    { method: 'PATCH', path: '/api/prefs', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/project/open', body: () => ({}), band: 'write' },
    { method: 'GET', path: '/api/project/open', band: 'read' },
    { method: 'POST', path: '/api/case/attach', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/mesh/delete', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/worker', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/worker', worker: 'runs.upsert', body: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/test/assistant/reset', body: () => ({}), band: 'write' },
    { method: 'DELETE', path: '/api/materials', band: 'write' },
    { method: 'GET', path: '/api/../assistant/status', band: 'read' },
    { method: 'GET', path: '/api//assistant', band: 'read' },
    { method: 'GET', path: 'http://elsewhere/api/x', band: 'read' },
    { method: 'POST', path: '/api/run/start', raw: () => ({}), band: 'write' },
    { method: 'POST', path: '/api/thing', binary: true, body: () => ({}), band: 'write' },
    { method: 'GET', path: '/api/thing', band: 'write' },
  ];

  it('the denylist: no such entry passes, in the table or in a table a caller brings', () => {
    for (const r of DENIED) {
      assert.notEqual(deniedRoute(r), null, `${r.method} ${r.path}`);
      assert.throws(() => checkRouteTable({ bad: r }), /not allowed/, `${r.method} ${r.path}`);
      assert.throws(() => createHostTransport({ port: () => app.port, routes: { bad: r } }), /not allowed/);
    }
    for (const r of Object.values(HOST_ROUTES)) {
      const p = r.path.toLowerCase();
      assert.ok(!p.startsWith('/api/assistant') && p !== '/api/project/open' && p !== '/api/case/attach' && p !== '/api/mesh/delete', r.path);
      assert.ok(!(p === '/api/prefs' && r.method !== 'GET'), r.path);
      if (p === '/api/worker') assert.ok(WORKER_METHODS.includes(r.worker), r.worker);
    }
    assert.deepEqual([...WORKER_METHODS], ['materials.set', 'bcs.set', 'bc.menu']);
    assert.equal(deniedRoute({ method: 'POST', path: '/api/prefs/hardware-check', body: () => ({}), band: 'write' }), null, 'the hardware check is not a prefs write');
  });

  it('per call: never {delete: true} to the BC or refinement routes, the worker only for its own method, a typed path only, never a replace; nothing is sent', async () => {
    tick();
    const { call } = transport();
    const before = app.seen.length;
    const refused = (e) => e instanceof HostCallError && e.code === 'not_allowed';
    await assert.rejects(call('bcs.save', { project_id: 'p1', delete: true }, opts()), refused);
    await assert.rejects(call('worker.bcs', { method: 'materials.set' }, opts()), refused);
    await assert.rejects(call('import.path', { project_id: 'p1', step_path: 'C:\\parts\\a.step' }, opts({ prompt: 'Import my part please' })), refused);
    await assert.rejects(call('import.path', { project_id: 'p1', step_path: 'C:\\parts\\a.step' }, opts({ prompt: null })), refused, 'MCP and agents have no message');
    await assert.rejects(call('import.path', { project_id: 'p1', step_path: 'C:\\parts\\a.step', mode: 'replace' }, opts({ prompt: 'Import C:\\parts\\a.step' })), refused);
    await assert.rejects(call('nope', {}, opts()), refused, 'an id not in the table');
    assert.equal(app.seen.length, before);
    // The allowed forms go.
    await call('bcs.save', { project_id: 'p1', delete: 'bc-7' }, opts({ turn: 'w-1' }));
    await call('worker.bcs', { method: 'bcs.set' }, opts({ turn: 'w-2' }));
    await call('import.path', { project_id: 'p1', step_path: 'C:\\parts\\a.step' }, opts({ turn: 'w-3', prompt: 'Import C:\\parts\\a.step into this project.' }));
    assert.deepEqual(app.seen.slice(before).map((s) => JSON.parse(s.body.toString())), [{ project_id: 'p1', delete: 'bc-7' }, { method: 'bcs.set', params: {} }, { project_id: 'p1', step_path: 'C:\\parts\\a.step' }]);
  });

  it('`:name` segments are filled from args, each one safe segment', async () => {
    tick();
    const { call } = transport();
    await call('env.install', { key: 'heat_transfer' }, opts());
    assert.equal(app.seen.at(-1).path, '/api/plugins/heat_transfer/env/install');
    for (const key of ['..', '', 'a/b', 'x?y=1', 'k'.repeat(129), null]) {
      await assert.rejects(call('env.install', { key }, opts()), (e) => e.code === 'invalid_args', String(key));
    }
  });
});

describe('a call', () => {
  it('carries the turn and tool headers, on a loopback host with no Origin; JSON bodies as application/json; only named keys', async () => {
    tick();
    const { call } = transport();
    await call('thing.save', { project_id: 'p1', name: 'Inlet', sneaky: 'x' }, opts({ turn: 't-42', tool: 'setup_edit.bc.update' }));
    const r = app.seen.at(-1);
    assert.deepEqual([r.method, r.path], ['POST', '/api/thing/save']);
    assert.equal(r.headers[TURN_HEADER], 't-42');
    assert.equal(r.headers[TOOL_HEADER], 'setup_edit.bc.update');
    assert.equal(TOOL_HEADER, 'x-magnusim-assistant-tool');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers.host, `127.0.0.1:${app.port}`);
    assert.equal(r.headers.origin, undefined);
    assert.deepEqual(JSON.parse(r.body.toString()), { project_id: 'p1', name: 'Inlet' });
    await call('thing.get', { project_id: 'p1', n: 3, extra: 'no' }, opts({ tool: '' }));
    assert.deepEqual(app.seen.at(-1).query, { project_id: 'p1', n: '3' });
    assert.equal(app.seen.at(-1).headers[TOOL_HEADER], undefined, 'no tool named, no header');
    await call('thing.patch', { ids: ['a', 'b'] }, opts());
    assert.deepEqual([app.seen.at(-1).method, JSON.parse(app.seen.at(-1).body.toString())], ['PATCH', { ids: ['a', 'b'] }]);
  });

  it('at most 5 calls and 2 writes a second per turn; a POST in the read band is not a write', async () => {
    tick(5_000);
    const { call, get } = transport();
    await call('thing.save', { project_id: 'p1', name: 'a' }, opts({ turn: 'busy' }));
    await call('thing.save', { project_id: 'p1', name: 'b' }, opts({ turn: 'busy' }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'c' }, opts({ turn: 'busy' })), (e) => e.code === 'rate_limited');
    assert.equal(HOST_WRITE_RATE.calls, 2);
    await call('thing.peek', { project_id: 'p1' }, opts({ turn: 'busy' }));
    await call('thing.get', { project_id: 'p1' }, opts({ turn: 'busy' }));
    // The starter GET shares the turn's 5 a second.
    await get('/api/compute-queue', {}, { turn: 'busy' });
    await assert.rejects(call('thing.get', { project_id: 'p1' }, opts({ turn: 'busy' })), (e) => e.code === 'rate_limited');
    await call('thing.save', { project_id: 'p1', name: 'd' }, opts({ turn: 'other' }));
    tick(1_001);
    await call('thing.save', { project_id: 'p1', name: 'e' }, opts({ turn: 'busy' }));
  });

  it('a raw body streams the file with its length, and the project in the query', async () => {
    tick();
    const file = join(ROOT, 'part.stl');
    const bytes = Buffer.from('solid part\nendsolid part\n');
    writeFileSync(file, bytes);
    const { call } = transport();
    await call('import.raw', { project_id: 'p1', name: 'part.stl', file, bytes: bytes.length }, opts());
    const r = app.seen.at(-1);
    assert.deepEqual(r.query, { project_id: 'p1', filename: 'part.stl' });
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(r.headers['content-length']), bytes.length);
    assert.ok(r.body.equals(bytes));
  });

  it('a binary route answers bytes; a JSON answer (a thumbnail being made) comes back as its object; over maxBytes is refused', async () => {
    tick();
    const { call } = transport();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    app.answers.set('/api/geometry/thumb', () => ({ bytes: png }));
    const got = await call('thumb.get', { project_id: 'p1' }, opts());
    assert.ok(Buffer.isBuffer(got) && got.equals(png));
    app.answers.set('/api/geometry/thumb', () => ({ status: 202, json: { ok: false, pending: true } }));
    assert.deepEqual(await call('thumb.get', { project_id: 'p1' }, opts({ turn: 'b2' })), { ok: false, pending: true });
    app.answers.set('/api/geometry/thumb', () => ({ status: 404, json: { error: 'no thumbnail' } }));
    await assert.rejects(call('thumb.get', { project_id: 'p1' }, opts({ turn: 'b3' })), (e) => e.code === 'http' && e.status === 404 && e.message === 'no thumbnail');
    app.answers.set('/api/geometry/thumb', () => ({ bytes: Buffer.alloc(65) }));
    await assert.rejects(call('thumb.get', { project_id: 'p1' }, opts({ turn: 'b4' })), (e) => e.code === 'too_large');
    app.answers.delete('/api/geometry/thumb');
  });

  it('the link gate: a 503 geometry_updating is tried once more after its Retry-After (capped), then fails geometry_updating; a raw body is read again', async () => {
    tick();
    const waits = [];
    const { call } = transport({ retryDelayMs: (s) => (waits.push(s), 10) });
    let n = 0;
    app.answers.set('/api/thing/save', () => ((n += 1) === 1 ? { status: 503, headers: { 'Retry-After': '2' }, json: { ok: false, code: 'geometry_updating', error: 'The geometry is updating.' } } : { json: { ok: true, rev: 5 } }));
    const before = app.seen.length;
    assert.deepEqual(await call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'g1' })), { ok: true, rev: 5 });
    assert.equal(app.seen.length - before, 2);
    assert.deepEqual(waits, [2]);
    app.answers.set('/api/thing/save', () => ({ status: 503, headers: { 'Retry-After': '2' }, json: { ok: false, code: 'geometry_updating', error: 'The geometry is updating.' } }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'g2' })), (e) => e.code === 'geometry_updating' && e.message === 'The geometry is updating.');
    assert.equal(LINK_RETRY_MAX_MS, 10_000);
    // The raw import's stream is opened again for the retry.
    const file = join(ROOT, 'again.stl');
    writeFileSync(file, 'solid a\nendsolid a\n');
    let m = 0;
    app.answers.set('/api/geometry/import', () => ((m += 1) === 1 ? { status: 503, json: { ok: false, code: 'geometry_updating', error: 'Updating.' } } : { json: { ok: true } }));
    await call('import.raw', { project_id: 'p1', name: 'again.stl', file, bytes: 19 }, opts({ turn: 'g3' }));
    assert.equal(app.seen.at(-1).body.toString(), 'solid a\nendsolid a\n');
    app.answers.delete('/api/thing/save');
    app.answers.delete('/api/geometry/import');
  });

  it('a 409 geometry_changed and a 409 stale_record fail at once, with their words (and the stale record named)', async () => {
    tick();
    const { call } = transport();
    app.answers.set('/api/thing/save', () => ({ status: 409, json: { ok: false, code: 'geometry_changed', error: 'The geometry "Plate" changed.' } }));
    const before = app.seen.length;
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 's1' })), (e) => e.code === 'geometry_changed' && e.status === 409);
    assert.equal(app.seen.length - before, 1, 'not tried again');
    app.answers.set('/api/thing/save', () => ({ status: 409, json: { ok: false, code: 'stale_record', kind: 'bc', id: 'bc-7', rev: 5, error: 'This was changed elsewhere.' } }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 's2' })), (e) => {
      assert.deepEqual([e.code, e.appCode, e.message, e.detail], ['stale_record', 'stale_record', 'This was changed elsewhere.', { kind: 'bc', id: 'bc-7', rev: 5 }]);
      return true;
    });
    // Another refusal keeps the app's word for it.
    app.answers.set('/api/thing/save', () => ({ status: 400, json: { ok: false, code: 'bad_order', error: 'A run cannot sit above the mesh it uses.' } }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 's3' })), (e) => e.code === 'http' && e.appCode === 'bad_order' && e.status === 400);
    app.answers.delete('/api/thing/save');
  });

  it("the worker's numeric codes, as a route passes them on (rpcStatus), are the app's words: -32009/-32012 stale_record, -32004 not_found, -32602 invalid_input; another number none", async () => {
    tick();
    const { call } = transport();
    const answer = (status, code) => app.answers.set('/api/thing/save', () => ({ status, json: { ok: false, code, error: 'Refused.' } }));
    answer(409, -32009);
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'w1' })), (e) => e.code === 'stale_record' && e.appCode === 'stale_record' && e.status === 409);
    answer(409, -32012);
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'w2' })), (e) => e.code === 'stale_record' && e.status === 409);
    answer(404, -32004);
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'w3' })), (e) => e.code === 'http' && e.appCode === 'not_found' && e.status === 404);
    answer(400, -32602);
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'w4' })), (e) => e.code === 'http' && e.appCode === 'invalid_input');
    answer(400, -32099);
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'w5' })), (e) => e.code === 'http' && e.appCode === null);
    app.answers.delete('/api/thing/save');
  });

  it("the app's error text never carries a path: a refusal is scrubbed, a server error is a fixed line", async () => {
    tick();
    const { call } = transport();
    const pathy = "[Errno 2] No such file or directory: 'C:\\Users\\someone\\Documents\\Magnusim Projects\\p1\\simulations.json'";
    app.answers.set('/api/thing/save', () => ({ status: 400, json: { ok: false, error: pathy } }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'p1' })), (e) => {
      assert.ok(!/Users|someone|Magnusim Projects/.test(e.message), e.message);
      assert.match(e.message, /\[path\]/);
      return true;
    });
    app.answers.set('/api/thing/save', () => ({ status: 500, json: { ok: false, error: pathy } }));
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'p2' })), (e) => e.code === 'http' && e.message === 'The app had an error (HTTP 500).' && e.detail === null);
    app.answers.delete('/api/thing/save');
  });

  it('Stop aborts the request; a timeout; an app that is not up', async () => {
    tick();
    const { call } = transport();
    app.answers.set('/api/thing/save', () => ({ json: { ok: true } }));
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(call('thing.save', { project_id: 'p1', name: 'x' }, opts({ turn: 'a1', signal: stop.signal })), (e) => e.code === 'aborted');
    const slow = http.createServer(() => {});
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const t = createHostTransport({ port: () => slow.address().port, now, routes: TABLE });
      await assert.rejects(t.call('thing.get', { project_id: 'p1' }, opts({ turn: 'a2', timeoutMs: 100 })), (e) => e.code === 'timeout');
      const abort = new AbortController();
      const p = t.call('thing.get', { project_id: 'p1' }, opts({ turn: 'a3', signal: abort.signal }));
      setTimeout(() => abort.abort(), 50);
      await assert.rejects(p, (e) => e.code === 'aborted');
    } finally {
      slow.closeAllConnections?.();
      await new Promise((r) => slow.close(r));
    }
    await assert.rejects(createHostTransport({ port: () => 0, routes: TABLE }).call('thing.get', {}, opts()), (e) => e.code === 'not_ready');
    app.answers.delete('/api/thing/save');
  });
});
