// The read and edit tools' way into the app (Core host tools spec 3): one frozen table of
// routes (host-routes.ts) and the loopback call over it (host/route-call.ts). The table
// never holds a route the Assistant must not call (its own routes, plugin switches and
// packages, prefs writes, opening a project, attaching a case, the delete that skips its
// hook, the worker beyond three methods, a delete-everything body), and the call carries
// the turn and tool headers, paces itself, streams a file, reads a picture, asks a
// geometry update once more, and never gives the model a path.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-host-routes-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { HOST_ROUTES, STARTER_ROUTES } = await import('../assistant/host-routes.ts');
const { HOST_GET_ALLOWLIST } = await import('../assistant/host-call.ts');
const { buildRequest, createRouteCaller, RouteCallError, TOOL_HEADER } = await import('../assistant/host/route-call.ts');
const { TURN_HEADER } = await import('../assistant/access.ts');
const { startFakeApp, WIN } = await import('./assistant-host-harness.js');

let app;
before(async () => {
  app = await startFakeApp();
});
after(async () => {
  await app.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

/** Every entry's request for plausible args (a body builder sees every arg it may read). */
function sampleArgs() {
  return {
    project_id: 'p1',
    simulation_id: 's1',
    id: 'x-1',
    key: 'cad',
    field: 'p',
    mesh_id: 'm1',
    run_id: 'r1',
    raw: { stream: null, bytes: 0, type: 'application/octet-stream' },
    fields: { value: 5 },
    settings: { fineness: 3 },
    changes: { endTime: 10 },
    materials: [{ id: 'mat-1' }],
    only_id: 'mat-1',
  };
}

describe('HOST_ROUTES: the frozen table', () => {
  it('is frozen, entries too, and holds the starters (HOST_GET_ALLOWLIST stays for them)', () => {
    assert.ok(Object.isFrozen(HOST_ROUTES));
    for (const [id, r] of Object.entries(HOST_ROUTES)) assert.ok(Object.isFrozen(r), id);
    assert.deepEqual(STARTER_ROUTES.map((id) => HOST_ROUTES[id].path), [...HOST_GET_ALLOWLIST]);
    for (const id of STARTER_ROUTES) assert.equal(HOST_ROUTES[id].method, 'GET');
  });

  it('never a route the Assistant must not call (spec 3.3)', () => {
    for (const [id, r] of Object.entries(HOST_ROUTES)) {
      assert.ok(!r.path.startsWith('/api/assistant'), `${id}: the Assistant's own routes`);
      assert.ok(!/^\/api\/plugins\/:key\/(enable|disable|remove|env\/remove)$/.test(r.path), `${id}: plugin switches`);
      assert.ok(!r.path.startsWith('/api/plugins/package'), `${id}: plugin packages`);
      assert.ok(!(r.path === '/api/prefs' && r.method !== 'GET'), `${id}: prefs writes`);
      assert.notEqual(r.path, '/api/project/open', `${id}: opening a project moves the global active one`);
      assert.notEqual(r.path, '/api/case/attach', `${id}: the server-wide attached case`);
      assert.notEqual(r.path, '/api/mesh/delete', `${id}: it skips onGeneratedMeshDeleted`);
      const req = buildRequest(r, sampleArgs());
      if (r.path === '/api/worker') {
        const body = JSON.parse(req.json);
        assert.ok(['materials.set', 'bcs.set', 'bc.menu'].includes(body.method), `${id}: worker method ${body.method}`);
      }
      if (req.json && (r.path === '/api/bcs' || r.path === '/api/mesh/refinements')) {
        assert.notEqual(JSON.parse(req.json).delete, true, `${id}: {delete:true} deletes every record`);
      }
      if (r.path === '/api/geometry/import') assert.ok(!/mode=replace/.test(req.target) && !(req.json && JSON.parse(req.json).mode), `${id}: never mode=replace`);
      if (r.path === '/api/mesh' && req.json) assert.ok(Object.keys(JSON.parse(req.json)).length > 2, `${id}: never an empty mesh body`);
    }
  });

  it('every write body names project_id; a model input is never spread into one', () => {
    const marker = { injected: 'yes', project_id: 'p9' };
    for (const [id, r] of Object.entries(HOST_ROUTES)) {
      if (!r.body) continue;
      const body = JSON.parse(buildRequest(r, { ...sampleArgs(), ...marker, fields: {}, settings: {}, changes: {} }).json);
      const flat = JSON.stringify(body);
      assert.ok(!flat.includes('"injected"'), `${id}: an unknown arg reached the body`);
      if (!['folders.create', 'folders.delete', 'project.create', 'project.sample', 'bc.menu'].includes(id)) assert.ok(flat.includes('"project_id"'), `${id}: project_id`);
    }
  });

  it('a path segment must be a plain id', () => {
    assert.throws(() => buildRequest(HOST_ROUTES['plugin.env'], { key: '../assistant' }), (e) => e instanceof RouteCallError && e.code === 'not_allowed');
    assert.equal(buildRequest(HOST_ROUTES['plugin.env'], { key: 'cad' }).target, '/api/plugins/cad/env');
  });
});

describe('the loopback call', () => {
  const call = (o = {}) => createRouteCaller({ port: () => app.port, sleep: async () => {}, ...o });

  it('carries the turn and tool headers on a loopback host, JSON as JSON, and refuses what is not in the table', async () => {
    const from = app.seen.length;
    await call()('simulation.update', { project_id: 'p1', simulation_id: 's1', name: 'X' }, { turn: 't-9', tool: 'study_edit.rename' });
    const r = app.seen[from];
    assert.deepEqual([r.method, r.path], ['POST', '/api/simulation/update']);
    assert.equal(r.headers[TURN_HEADER], 't-9');
    assert.equal(r.headers[TOOL_HEADER], 'study_edit.rename');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.headers.host, `127.0.0.1:${app.port}`);
    assert.equal(r.headers.origin, undefined);
    await assert.rejects(call()('assistant.status', {}, { turn: 't' }), (e) => e.code === 'not_allowed');
    await assert.rejects(call()('__proto__', {}, { turn: 't' }), (e) => e.code === 'not_allowed');
  });

  it('paces a turn to 5 calls and 2 writes a second: the next waits for its slot, another turn does not', async () => {
    let clock = 0;
    const waits = [];
    const c = createRouteCaller({ port: () => app.port, now: () => clock, sleep: async (ms) => (waits.push(ms), (clock += ms)) });
    for (let i = 0; i < 2; i += 1) await c('run.rename', { project_id: 'p1', run_id: 'r1', name: 'a', simulation_id: 's1' }, { turn: 'w' });
    assert.deepEqual(waits, []);
    await c('run.rename', { project_id: 'p1', run_id: 'r1', name: 'a', simulation_id: 's1' }, { turn: 'w' });
    assert.equal(waits.length, 1, 'the third write in a second waited');
    await c('run.rename', { project_id: 'p1', run_id: 'r1', name: 'a', simulation_id: 's1' }, { turn: 'other' });
    assert.equal(waits.length, 1, 'another turn has its own slots');
    for (let i = 0; i < 5; i += 1) await c('projects.list', {}, { turn: 'r' });
    await c('projects.list', {}, { turn: 'r' });
    assert.equal(waits.length, 2, 'the sixth read in a second waited');
  });

  it('streams a file as the raw import, with the project in the query and never mode=replace', async () => {
    const file = join(ROOT, 'part.step');
    writeFileSync(file, 'ISO-10303-21;\n'.repeat(200));
    const from = app.seen.length;
    await call()('geometry.import_raw', { project_id: 'p1', filename: 'part.step', length_unit: 'MM', raw: { stream: createReadStream(file), bytes: statSync(file).size, type: 'application/octet-stream' } }, { turn: 't' });
    const r = app.seen[from];
    assert.deepEqual([r.method, r.path, r.query], ['POST', '/api/geometry/import', { project_id: 'p1', filename: 'part.step', length_unit: 'MM' }]);
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.bytes.length, statSync(file).size);
  });

  it('reads a picture as bytes; a picture still being made is JSON', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    app.w.thumb = png;
    const got = await call()('geometry.thumb', { project_id: 'p1' }, { turn: 't' });
    assert.ok(Buffer.isBuffer(got) && got.equals(png));
    app.w.thumb = null;
    const pending = await call()('geometry.thumb', { project_id: 'p1' }, { turn: 't' });
    assert.equal(pending.pending, true);
  });

  it('a 503 geometry_updating is asked once more after its Retry-After; a 409 fails at once with its code', async () => {
    let n = 0;
    app.over = (m, path) => {
      if (path !== '/api/bcs' || m !== 'POST') return undefined;
      n += 1;
      return n === 1 ? { status: 503, body: { ok: false, code: 'geometry_updating', error: 'Updating Plate.' }, headers: { 'retry-after': '1' } } : { ok: true, bc: { id: 'bc-1' } };
    };
    const slept = [];
    const out = await call({ sleep: async (ms) => slept.push(ms) })('bcs.defaults', { project_id: 'p1', simulation_id: 's1', wall_type: 'Slip' }, { turn: 't' });
    assert.equal(out.ok, true);
    assert.deepEqual([n, slept], [2, [1000]]);
    n = 10;
    app.over = (m, path) => (path === '/api/bcs' && m === 'POST' ? { status: 503, body: { ok: false, code: 'geometry_updating', error: 'Updating Plate.' } } : undefined);
    await assert.rejects(call()('bcs.defaults', { project_id: 'p1', simulation_id: 's1', wall_type: 'Slip' }, { turn: 't' }), (e) => e.appCode === 'geometry_updating' && e.status === 503);
    app.over = (m, path) => (path === '/api/bcs' && m === 'POST' ? { status: 409, body: { ok: false, code: 'geometry_changed', error: 'Plate changed.' } } : undefined);
    await assert.rejects(call()('bcs.defaults', { project_id: 'p1', simulation_id: 's1', wall_type: 'Slip' }, { turn: 't' }), (e) => e.appCode === 'geometry_changed' && e.status === 409);
    app.over = null;
  });

  it('a refusal keeps its words with paths taken out; a server error is a fixed line', async () => {
    app.over = (m, path) => (path === '/api/run/rename' ? { status: 400, body: { ok: false, error: `Run not found in ${WIN}\\p1 and /home/someone/x`, path: `${WIN}\\p1` } } : undefined);
    await assert.rejects(call()('run.rename', { project_id: 'p1', run_id: 'r9', name: 'a', simulation_id: 's1' }, { turn: 't' }), (e) => {
      assert.equal(e.message, 'Run not found in [path]');
      assert.ok(!JSON.stringify(e.body).includes('someone'));
      return true;
    });
    app.over = (m, path) => (path === '/api/run/rename' ? { status: 500, body: { error: `boom at ${WIN}` } } : undefined);
    await assert.rejects(call()('run.rename', { project_id: 'p1', run_id: 'r9', name: 'a', simulation_id: 's1' }, { turn: 't' }), (e) => e.message === 'The app had an error (HTTP 500).');
    app.over = null;
  });

  it('a Stop aborts the call; an app that is not up says so', async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(call()('projects.list', {}, { turn: 't', signal: stop.signal }), (e) => e.code === 'aborted');
    await assert.rejects(createRouteCaller({ port: () => 0 })('projects.list', {}, { turn: 't' }), (e) => e.code === 'not_ready');
  });
});
