// The per-project gate (host API 1.5, proposal 5.16): which routes pass it (the census of
// every registered route), how a closed gate holds a write (20 s, then 503) and a read (2
// minutes), the drain, /api/worker's project, and the test switches inert unless set.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-link-gate-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';
delete process.env.MAGNUSIM_TEST_SLOT_HOLD;
delete process.env.MAGNUSIM_TEST_LINK_HOOKS;
delete process.env.MAGNUSIM_TEST_LINK_APPLY_TIMEOUT_MS;

const { Router, dispatch } = await import('../router.ts');
const gate = await import('../link-gate.js');
const linkJob = await import('../link-job.js');
const linkRoutes = await import('../link-routes.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const pid of ['pa', 'pb']) {
  mkdirSync(join(PROJECTS, pid), { recursive: true });
  writeFileSync(join(PROJECTS, pid, 'project.json'), JSON.stringify({ id: pid, title: pid }));
}

class FakeWorker {
  on() {}
  async call(method) {
    if (method === 'plugins.list') return { plugins: [] };
    return { ok: true };
  }
}

/** Every route the app registers (live routes and phase 3 routes, links included). */
async function allRoutes() {
  const { registerLiveRoutes } = await import('../live-routes.js');
  const { registerPhase3Routes } = await import('../routes.ts');
  const { JobManager } = await import('../jobs.ts');
  const router = new Router();
  const worker = new FakeWorker();
  const jobs = new JobManager({ cacheDir: join(ROOT, 'jobs') });
  registerLiveRoutes(router, { worker, jobs, services: null });
  registerPhase3Routes(router, {
    worker,
    jobs,
    webRoot: ROOT,
    cacheDir: join(ROOT, 'cache'),
    serveLegacyFilter: async () => {},
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
    envInstaller: () => ({ get: () => null, start: () => ({ state: 'installing', log: [] }) }),
  });
  return router.list();
}

describe('the census: every registered route is gated or reviewed', () => {
  it('no /api/ route is left undecided, and the table says what 5.16 says', async () => {
    const routes = await allRoutes();
    const undecided = routes
      .map((r) => r.path.replace(/:[A-Za-z]+/g, 'x').replace(/\*\*[A-Za-z]*/g, 'x'))
      .filter((p) => p.startsWith('/api/') && gate.gateClassOf(p) === 'unreviewed');
    assert.deepEqual([...new Set(undecided)], [], 'decide these: gate them or review them');
    const paths = new Set(routes.map((r) => r.path));
    for (const p of ['/api/plugin-geometry/link', '/api/plugin-geometry/events', '/api/plugin-geometry/linked', '/api/plugin-geometry/status']) {
      assert.ok(paths.has(p), p);
      assert.equal(gate.gateClassOf(p), 'reviewed', `${p} is not gated: the call writes only its own staging`);
    }
    for (const p of ['/api/project', '/api/project/tree', '/api/geometry/cad', '/api/geometry/remove', '/api/simulation/copy', '/api/bcs', '/api/materials', '/api/mesh', '/api/mesh/delete', '/api/mesh/generate', '/api/mesh-refinements', '/api/mesh_refinements', '/api/result-controls', '/api/area-average', '/api/area_average', '/api/run', '/api/runs/x', '/api/particle-trace', '/api/particle_trace/meta']) {
      assert.equal(gate.gateClassOf(p), 'gated', p);
    }
    for (const p of ['/api/mesh/surface', '/api/mesh/section']) assert.equal(gate.gateClassOf(p), 'exception', p);
    for (const p of ['/api/mesh-surface', '/api/simulation-control', '/api/compute-queue', '/api/case', '/api/jobs/x/events', '/api/plugin/x/y', '/api/projects', '/api/fields/U']) {
      assert.equal(gate.gateClassOf(p), 'reviewed', p);
    }
    // Only a particle trace among the filters; /api/worker but its three plain methods.
    assert.equal(gate.requestIsGated('GET', '/api/filter/streamlines', null), true);
    assert.equal(gate.requestIsGated('GET', '/api/filter/particle-trace/meta', null), true);
    assert.equal(gate.requestIsGated('GET', '/api/filter/cut_plane', null), false);
    assert.equal(gate.requestIsGated('POST', '/api/worker', { method: 'bcs.set' }), true);
    for (const m of ['bc.menu', 'registry.reload', 'sim.get']) assert.equal(gate.requestIsGated('POST', '/api/worker', { method: m }), false, m);
    // The test routes exist only with their switch.
    assert.equal(paths.has('/api/test/slot-hold'), false);
  });

  it('the test switches are inert unless set', () => {
    assert.deepEqual(linkJob.linkTestSwitches(), { hooks: false, applyTimeoutMs: 600_000 });
    assert.equal(linkRoutes.slotHoldRoutesOn(), false);
    let called = false;
    globalThis[Symbol.for('magnusim.linkTestHooks')] = {
      afterMove() {
        called = true;
        throw new Error('a hook must not run');
      },
    };
    try {
      const dir = mkdtempSync(join(ROOT, 'swap-'));
      mkdirSync(join(dir, 'g', 'link'), { recursive: true });
      mkdirSync(join(dir, 's', 'new'), { recursive: true });
      writeFileSync(join(dir, 'g', 'cad_preview.json'), '{}');
      writeFileSync(join(dir, 's', 'new', 'cad_preview.json'), '{"new":1}');
      const out = linkJob.swapOnce({ projectDir: dir, geomDir: join(dir, 'g'), stage: join(dir, 's'), job: 'gl-test00-000000', fromRev: 1, rev: 1, change: 'names' });
      assert.equal(out.ok, true);
      assert.equal(called, false);
    } finally {
      delete globalThis[Symbol.for('magnusim.linkTestHooks')];
    }
  });
});

describe('a closed gate', () => {
  /** @type {any} */
  let server;
  let base = '';
  /** @type {Map<string, Promise<void>>} */
  const holds = new Map();
  before(async () => {
    const router = new Router();
    const answer = (ctx) => (holds.get(ctx.url.searchParams.get('hold') || '') || Promise.resolve()).then(() => ctx.sendJson(200, { ok: true }));
    router.post('/api/bcs', answer);
    router.get('/api/project/tree', answer);
    router.post('/api/worker', answer);
    router.get('/api/mesh/surface', answer);
    router.get('/api/compute-queue', answer);
    server = await new Promise((done) => {
      const s = http.createServer(async (req, res) => {
        if (!(await dispatch(router, req, res))) {
          res.statusCode = 404;
          res.end();
        }
      });
      s.listen(0, '127.0.0.1', () => done(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
  });
  beforeEach(() => gate.resetLinkGateForTests({ writeWaitMs: 400, readWaitMs: 1200, drainMs: 300 }));

  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('holds a write, then answers 503 geometry_updating with Retry-After; another project goes on', async () => {
    assert.equal(await gate.closeGate('pa', 'Demo 1'), true);
    const t0 = Date.now();
    const r = await post('/api/bcs?project_id=pa', { project_id: 'pa' });
    const waited = Date.now() - t0;
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '2');
    assert.deepEqual(await r.json(), { ok: false, code: 'geometry_updating', error: 'Updating Demo 1. Try again in a moment.' });
    assert.ok(waited >= 380, `waited ${waited} ms`);
    const other = await post('/api/bcs?project_id=pb', { project_id: 'pb' });
    assert.equal(other.status, 200);
    const ungated = await fetch(`${base}/api/compute-queue?project_id=pa`);
    assert.equal(ungated.status, 200, 'an ungated route is never held');
    const exception = await fetch(`${base}/api/mesh/surface?project_id=pa`);
    assert.equal(exception.status, 200, 'a reviewed exception is never held');
    gate.openGate('pa');
  });

  it('a read waits longer than a write, and both go through when the gate opens', async () => {
    assert.equal(await gate.closeGate('pa', 'Demo 1'), true);
    const t0 = Date.now();
    const read = fetch(`${base}/api/project/tree?project_id=pa`).then((r) => [r.status, Date.now() - t0]);
    const write = post('/api/bcs?project_id=pa', { project_id: 'pa' }).then((r) => [r.status, Date.now() - t0]);
    await sleep(700);
    gate.openGate('pa');
    const [w, rd] = await Promise.all([write, read]);
    assert.equal(w[0], 503, 'the write gave up at 400 ms');
    assert.deepEqual(rd[0], 200);
    assert.ok(rd[1] >= 650, 'the read waited for the gate');
  });

  it('/api/worker waits by the project in params.id, as the route reads it', async () => {
    assert.equal(await gate.closeGate('pa', 'Demo 1'), true);
    const r = await post('/api/worker', { method: 'bcs.set', params: { id: 'pa', body: {} } });
    assert.equal(r.status, 503);
    const plain = await post('/api/worker', { method: 'bc.menu', params: { id: 'pa' } });
    assert.equal(plain.status, 200);
    gate.openGate('pa');
  });

  it('drains: closing waits for open requests, up to the drain time, else opens again', async () => {
    let release;
    holds.set('h1', new Promise((r) => (release = r)));
    const open = post('/api/bcs?project_id=pa&hold=h1', { project_id: 'pa' });
    await sleep(100);
    assert.equal(gate.gateOpenCount('pa'), 1);
    assert.equal(await gate.closeGate('pa', 'Demo 1'), false, 'still open after the drain time');
    assert.equal(gate.gateIsClosed('pa'), false, 'the gate opened again');
    const closing = gate.closeGate('pa', 'Demo 1');
    await sleep(50);
    release();
    assert.equal(await closing, true, 'drained once the request ended');
    assert.equal((await open).status, 200);
    assert.equal(gate.gateOpenCount('pa'), 0);
    gate.openGate('pa');
    holds.clear();
  });

  it('a request let in when the gate opens is counted, so a close right after waits for it', async () => {
    let release;
    holds.set('h3', new Promise((r) => (release = r)));
    assert.equal(await gate.closeGate('pa', 'Demo 1'), true);
    const waiting = post('/api/bcs?project_id=pa&hold=h3', { project_id: 'pa' });
    await sleep(100);
    gate.openGate('pa');
    await sleep(100);
    assert.equal(gate.gateOpenCount('pa'), 1, 'the admitted save is counted while it runs');
    const t0 = Date.now();
    const closing = gate.closeGate('pa', 'Demo 1', { drainMs: 2000 });
    let closedAt = 0;
    void closing.then(() => (closedAt = Date.now() - t0));
    await sleep(300);
    assert.equal(closedAt, 0, 'the close drains: it does not end while the save runs');
    release();
    assert.equal(await closing, true);
    assert.ok(closedAt >= 280, `drained after the save ended (${closedAt} ms)`);
    assert.equal((await waiting).status, 200);
    gate.openGate('pa');
    holds.clear();
  });

  it('a client that goes away is counted out', async () => {
    let release;
    holds.set('h2', new Promise((r) => (release = r)));
    const ctl = new AbortController();
    const p = fetch(`${base}/api/project/tree?project_id=pa&hold=h2`, { signal: ctl.signal }).catch(() => null);
    await sleep(100);
    assert.equal(gate.gateOpenCount('pa'), 1);
    ctl.abort();
    await p;
    await sleep(100);
    assert.equal(gate.gateOpenCount('pa'), 0);
    release();
    holds.clear();
  });

  it('keys a project by its folder', () => {
    if (process.platform === 'win32') assert.equal(gate.gateKey('PA'), gate.gateKey('pa'));
    assert.notEqual(gate.gateKey('pa'), gate.gateKey('pb'));
  });
});
