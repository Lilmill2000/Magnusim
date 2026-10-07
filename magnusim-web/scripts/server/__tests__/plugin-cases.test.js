// H15: the plugin OpenFOAM case routes (scripts/server/plugin-cases.ts) and the host
// stops and study routes around them (routes.ts).
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-plugin-cases-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { Router, dispatch } = await import('../router.ts');
const { registerPhase3Routes } = await import('../routes.ts');
const { JobManager } = await import('../jobs.ts');
const { RpcError } = await import('../worker.ts');
const queue = await import('../compute-queue.ts');
const store = await import('../../foam-store.js');
const runner = await import('../../foam-runner.js');
const slot = await import('../../compute-slot.js');
const registry = await import('../../registry-defaults.js');
const wslEnv = await import('../../wsl-env.js');

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a file Windows still holds */
  }
});

const KEY = 'foam-demo';
const PID = 'p1';
const SID = 's1';
const pluginDir = join(PROJECTS, PID, 'plugins', KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Until ok() holds, for at most `ms` (a loaded PC can take far longer than a fixed sleep); ok()'s last answer.
async function until(ok, ms = 10_000) {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await sleep(10);
  return ok();
}

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.hold = new Map();
    this.check = { ok: true, launch: { app: 'pimpleFoam', keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun', frame_fields: ['U', 'p'], time_dependency: 'transient' }, write_format: 'binary' };
    this.study = { id: SID, title: 'Cavity case 1', plugin_version: '1.0.0' };
    this.maxTotal = 512 * 1024 * 1024;
    this.disableFails = false;
  }

  async call(method, params) {
    this.calls.push([method, params]);
    const held = this.hold.get(method);
    if (held) await held;
    if (method === 'plugins.list') return { plugins: [{ key: KEY, status: 'enabled', files: { max_total_bytes: this.maxTotal } }] };
    if (method === 'plugin_studies.get') {
      if (!this.study || !['s1', 's2'].includes(params.study_id)) throw new RpcError(-32004, 'no such study');
      return { ok: true, study: { ...this.study, id: params.study_id } };
    }
    if (method === 'foam.check_case') return typeof this.check === 'function' ? this.check(params) : this.check;
    if (method === 'plugins.disable' && this.disableFails) throw new RpcError(-32000, 'could not disable');
    if (method === 'plugin_studies.rename') return { ok: true, study: { id: params.study_id, title: params.title } };
    return { ok: true };
  }

  /** The next call of `method` waits until the returned function is called. */
  holdNext(method) {
    let release;
    const p = new Promise((r) => (release = r));
    this.hold.set(method, p);
    return () => {
      this.hold.delete(method);
      release();
    };
  }
}

function listen(handler) {
  return new Promise((done) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

async function serve(worker) {
  const router = new Router();
  registerPhase3Routes(router, {
    worker,
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
    envInstaller: () => ({ get: () => null, start: () => ({ state: 'installing', log: [] }) }),
  });
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
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, body: data };
  };
  return {
    base,
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function makeCase(name, sid = SID) {
  const dir = join(pluginDir, 'studies', sid, 'cases', name);
  mkdirSync(join(dir, 'system'), { recursive: true });
  writeFileSync(join(dir, 'system', 'controlDict'), 'application pimpleFoam;\n');
  return dir;
}

const submitBody = (caseRel = 'cases/c1', extra = {}) => ({
  project_id: PID,
  plugin: KEY,
  study_id: SID,
  case_rel: caseRel,
  app: 'pimpleFoam',
  pre: [{ tool: 'blockMesh' }],
  results: { rho: 1, kinematicFields: ['p'] },
  ...extra,
});
const scopeQs = (extra = {}) => new URLSearchParams({ project_id: PID, plugin: KEY, study_id: SID, ...extra }).toString();

/** @type {any} */
let srv;
/** @type {FakeWorker} */
let worker;

beforeEach(async () => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
  mkdirSync(join(PROJECTS, PID), { recursive: true });
  writeFileSync(join(PROJECTS, PID, 'project.json'), JSON.stringify({ id: PID }));
  for (const sid of [SID, 's2']) {
    mkdirSync(join(pluginDir, 'studies', sid), { recursive: true });
    writeFileSync(join(pluginDir, 'studies', sid, 'study.json'), JSON.stringify({ id: sid }));
  }
  rmSync(join(ROOT, 'foam-cases.json'), { force: true });
  store.resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: { onLeave: runner.onQueueLeave, onChange: runner.onQueueChange } });
  slot.resetComputeSlotForTests();
  runner.resetFoamRunnerForTests();
  registry.setLiveRegistry({
    mesher: [{ key: 'standard' }],
    analysis: [],
    solver: [{ key: 'pimpleFoam', application: 'pimpleFoam', time_dependency: 'transient', parallel: 'mpirun', stop_strategy: 'stopAt_writeNow' }],
    plugins: [{ key: KEY, name: 'Foam demo', version: '1.0.0' }],
  });
  process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
  wslEnv.resetWslSettingsCache();
  worker = new FakeWorker();
  srv = await serve(worker);
});

afterEach(async () => {
  await srv.close();
  const st = globalThis[Symbol.for('magnusim.computeQueue')];
  if (st && st.kickTimer) clearTimeout(st.kickTimer);
  if (st) st.kickTimer = null;
});

/** A case already running (as if the queue started it). */
function runningCase(name, sid = SID) {
  const caseDir = makeCase(name, sid);
  const rec = store.createFoamRecord({
    kind: 'foam',
    project_id: PID,
    plugin: KEY,
    plugin_name: 'Foam demo',
    study_id: sid,
    study_title: 'Cavity case 1',
    case_rel: `cases/${name}`,
    case_parts: ['studies', sid, 'cases', name],
    case_key: `studies/${sid}/cases/${name}`,
    case_dir: caseDir,
    case_base: pluginDir,
    token: '0011aabb',
    wsl_case: `cfddesk-pf-foam-demo-${sid}-0011aabb`,
    wsl_root: '/home/tester/cases',
    app: 'pimpleFoam',
  });
  store.updateFoamRecord(rec.id, { status: 'running' });
  return rec;
}

describe('submit', () => {
  it('queues a case: 202 with its job; the same folder again is that job (200 existing)', async () => {
    makeCase('c1');
    const r = await srv.post('/api/plugin-cases/submit', submitBody());
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.existing, false);
    assert.equal(r.body.ahead, 0);
    const job = r.body.job;
    assert.match(job.id, /^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/);
    assert.deepEqual([job.caseRel, job.app, job.status, job.nProcs, job.stopping], ['cases/c1', 'pimpleFoam', 'queued', 1, false]);
    assert.ok(!JSON.stringify(r.body).includes(PROJECTS.replace(/\\/g, '\\\\')), 'no local path reaches the frame');
    const rec = store.readFoamRecord(job.id);
    assert.equal(rec.wsl_root, '/home/tester/cases');
    assert.deepEqual(rec.case_parts, ['studies', 's1', 'cases', 'c1']);
    assert.equal(rec.case_key, 'studies/s1/cases/c1');
    assert.deepEqual(rec.results, { kinematic_fields: ['p'], frame_fields: ['U', 'p'], rho: 1 });
    assert.equal(rec.launch.write_format, 'binary');
    assert.match(rec.wsl_case, /^cfddesk-pf-foam-demo-s1-[0-9a-f]{8}$/);
    const rows = queue.snapshotComputeQueue().items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Cavity case 1 · c1 · Foam demo');
    assert.equal(rows[0].id, rec.row_id);
    // The check went to the plugin lane with the case's own folder.
    const check = worker.calls.find((c) => c[0] === 'foam.check_case')[1];
    assert.equal(check.app, 'pimpleFoam');
    assert.deepEqual(check.results, { kinematicFields: ['p'], rho: 1 });
    const checks = worker.calls.filter((c) => c[0] === 'foam.check_case').length;
    const again = await srv.post('/api/plugin-cases/submit', submitBody('CASES/C1'.toLowerCase()));
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.job.id, job.id);
    assert.equal(worker.calls.filter((c) => c[0] === 'foam.check_case').length, checks, 'found before the case is checked again');
  });

  it('the codes: shapes, the WSL root, plugin, project, study, path, folder, check', async () => {
    makeCase('c1');
    const code = async (body, want, status) => {
      const r = await srv.post('/api/plugin-cases/submit', body);
      assert.equal(r.body.code, want, JSON.stringify(r.body));
      assert.equal(r.status, status, want);
    };
    await code(submitBody('cases/c1', { plugin: '../x' }), 'bad_request', 400);
    await code(submitBody('cases/c1', { n_procs: 0 }), 'bad_request', 400);
    await code(submitBody('cases/c1', { n_procs: 65 }), 'bad_request', 400);
    await code(submitBody('cases/c1', { pre: Array.from({ length: 17 }, () => ({ tool: 'blockMesh' })) }), 'bad_request', 400);
    await code(submitBody('cases/c1', { pre: [{ tool: 'blockMesh', args: ['a', 'b', 'c', 'd', 'e'] }] }), 'bad_request', 400);
    await code(submitBody('cases/c1', { results: { kinematicFields: ['p__x'] } }), 'bad_request', 400);
    await code(submitBody('cases/c1', { results: { kinematicFields: ['p'], rho: -1 } }), 'bad_request', 400);
    await code(submitBody('cases/c1', { results: {} }), 'bad_request', 400);
    await code(submitBody('cases/__APP__'), 'invalid_path', 400);
    await code(submitBody('cases/../../x'), 'invalid_path', 400);
    await code(submitBody('cases/nope'), 'not_found', 404);
    await code(submitBody('cases/c1', { study_id: 's9' }), 'study_not_found', 404);
    await code(submitBody('cases/c1', { project_id: 'nope' }), 'project_not_found', 404);
    await code(submitBody('cases/c1', { plugin: 'other-plugin' }), 'plugin_off', 404);
    worker.study = { id: SID, title: 'Newer', plugin_version: '2.0.0' };
    await code(submitBody(), 'read_only', 409);
    worker.study = { id: SID, title: 'Cavity case 1', plugin_version: '1.0.0' };
    worker.check = { ok: false, code: 'app_not_allowed', error: 'icoFoam is not a registered solver' };
    await code(submitBody(), 'app_not_allowed', 400);
    worker.check = { ok: false, code: 'has_results', error: 'This case already ran. Write a new case folder for each run.' };
    await code(submitBody(), 'has_results', 400);
    worker.check = () => {
      throw new Error('timeout');
    };
    await code(submitBody(), 'unavailable', 503);
    assert.deepEqual(queue.snapshotComputeQueue().items, [], 'nothing was queued');
    assert.deepEqual(store.listFoamRecords(), []);
  });

  it("a WSL root the scripts cannot take (a ' in it) is refused before anything else", async () => {
    makeCase('c1');
    for (const root of ["/home/o'neil/cases", 'relative/cases', '/home/__APP__/cases', '/home/$x/cases', '/home/../cases']) {
      process.env.MAGNUSIM_WSL_CASE_ROOT = root;
      wslEnv.resetWslSettingsCache();
      const r = await srv.post('/api/plugin-cases/submit', submitBody());
      assert.equal(r.status, 400, root);
      assert.equal(r.body.code, 'invalid_path');
      assert.equal(r.body.error, 'The WSL case folder setting is not usable');
    }
    assert.ok(!worker.calls.some((c) => c[0] === 'foam.check_case'));
  });

  it('at most 20 queued cases per plugin per project; the plugin folder full answers quota', async () => {
    for (let i = 0; i < 20; i += 1) {
      makeCase(`k${i}`);
      assert.equal((await srv.post('/api/plugin-cases/submit', submitBody(`cases/k${i}`))).status, 202);
    }
    makeCase('k20');
    const r = await srv.post('/api/plugin-cases/submit', submitBody('cases/k20'));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'too_many');
    queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
    worker.maxTotal = 10;
    worker.emit('registry-changed');
    writeFileSync(join(pluginDir, 'big.bin'), Buffer.alloc(64));
    const q = await srv.post('/api/plugin-cases/submit', submitBody('cases/k20'));
    assert.equal(q.status, 413);
    assert.equal(q.body.code, 'quota');
    assert.match(q.body.error, /Delete old cases first\.$/);
  });

  it('the epoch is checked after each await: a plugin turned off meanwhile gives plugin_off, never another code', async () => {
    makeCase('c1');
    // Turned off while its study is read, and the read then fails (the plugin is gone);
    // turned off while the case is checked, and the check then refuses the case.
    const answers = {
      'plugin_studies.get': () => (worker.study = null),
      'foam.check_case': () => (worker.check = { ok: false, code: 'not_a_case', error: 'system/controlDict is missing' }),
    };
    for (const [method, meanwhile] of Object.entries(answers)) {
      const release = worker.holdNext(method);
      const pending = srv.post('/api/plugin-cases/submit', submitBody());
      await sleep(50);
      runner.bumpPluginEpoch(KEY);
      meanwhile();
      release();
      const r = await pending;
      assert.equal(r.status, 404, method);
      assert.equal(r.body.code, 'plugin_off', method);
      assert.match(r.body.error, /^Foam demo was turned off or reloaded while the case was checked\. Submit it again\.$/);
      worker.study = { id: SID, title: 'Cavity case 1', plugin_version: '1.0.0' };
    }
    assert.deepEqual(store.listFoamRecords(), []);
  });

  it('the epoch is also checked after the case folder and the room checks: plugin_off, not not_found or quota', async () => {
    makeCase('c1');
    // Turned off while the case folder is resolved (it reads the plugin list), and the folder then goes.
    let release = worker.holdNext('plugins.list');
    let pending = srv.post('/api/plugin-cases/submit', submitBody());
    await sleep(80);
    runner.bumpPluginEpoch(KEY);
    rmSync(join(pluginDir, 'studies', SID, 'cases', 'c1'), { recursive: true, force: true });
    release();
    let r = await pending;
    assert.deepEqual([r.status, r.body.code], [404, 'plugin_off'], JSON.stringify(r.body));
    // Turned off while the room is measured (the plugin list is read again), and the folder is then full.
    makeCase('c1');
    worker.emit('registry-changed');
    const first = worker.holdNext('plugins.list');
    pending = srv.post('/api/plugin-cases/submit', submitBody());
    await sleep(80);
    // Release the folder's list read; the room check then reads the list again (held).
    first();
    release = worker.holdNext('plugins.list');
    worker.emit('registry-changed');
    await sleep(80);
    assert.equal(worker.calls.filter((c) => c[0] === 'plugins.list').length, 3, 'the room check asked again');
    runner.bumpPluginEpoch(KEY);
    worker.maxTotal = 10;
    writeFileSync(join(pluginDir, 'big.bin'), Buffer.alloc(64));
    release();
    r = await pending;
    assert.deepEqual([r.status, r.body.code], [404, 'plugin_off'], JSON.stringify(r.body));
    assert.deepEqual(store.listFoamRecords(), []);
  });

  it('a submit whose check ends while a host stop waits on the worker fails: the epoch is bumped before the worker call', async () => {
    makeCase('c1');
    const stops = [
      ['disable', `/api/plugins/${KEY}/disable`, undefined, 'plugins.disable'],
      ['env remove', `/api/plugins/${KEY}/env/remove`, undefined, 'plugins.env_remove'],
      ['the Reload button', '/api/worker', { method: 'registry.reload', params: { stop_plugin_cases: true } }, 'registry.reload'],
    ];
    for (const [label, path, body, method] of stops) {
      const releaseCheck = worker.holdNext('foam.check_case');
      const submitting = srv.post('/api/plugin-cases/submit', submitBody());
      await sleep(80);
      const releaseStop = worker.holdNext(method);
      const stopping = srv.post(path, body);
      await sleep(80);
      releaseCheck();
      const r = await submitting;
      assert.equal(r.body.code, 'plugin_off', `${label}: ${JSON.stringify(r.body)}`);
      releaseStop();
      await stopping;
      assert.deepEqual(store.listFoamRecords(), [], label);
    }
  });

  it('two submits of one folder at once queue it once (the dedupe runs again after the check)', async () => {
    makeCase('c1');
    const release = worker.holdNext('foam.check_case');
    const a = srv.post('/api/plugin-cases/submit', submitBody());
    const b = srv.post('/api/plugin-cases/submit', submitBody());
    const inCheck = () => worker.calls.filter((c) => c[0] === 'foam.check_case').length;
    assert.ok(await until(() => inCheck() === 2), `both are in the check (${inCheck()} of 2)`);
    release();
    const answers = (await Promise.all([a, b])).map((r) => [r.status, r.body.existing]).sort();
    assert.deepEqual(answers, [[200, true], [202, false]]);
    assert.equal(store.listFoamRecords().length, 1);
    assert.equal(queue.snapshotComputeQueue().items.length, 1);
  });

  it('project ids compare by folder: a submit in another letter case finds the queued case (Windows)', { skip: process.platform !== 'win32' }, async () => {
    makeCase('c1');
    const first = await srv.post('/api/plugin-cases/submit', submitBody());
    assert.equal(first.status, 202);
    const upper = await srv.post('/api/plugin-cases/submit', submitBody('cases/c1', { project_id: PID.toUpperCase() }));
    assert.deepEqual([upper.status, upper.body.existing, upper.body.job.id], [200, true, first.body.job.id]);
    assert.equal(queue.snapshotComputeQueue().items.length, 1);
  });

  it('a submit that read the epoch between the two bumps of a disable still fails', async () => {
    makeCase('c1');
    const releaseDisable = worker.holdNext('plugins.disable');
    const disabling = srv.post(`/api/plugins/${KEY}/disable`);
    await sleep(50);
    const releaseCheck = worker.holdNext('foam.check_case');
    const submitting = srv.post('/api/plugin-cases/submit', submitBody());
    await sleep(50);
    releaseDisable();
    assert.equal((await disabling).status, 200);
    releaseCheck();
    const r = await submitting;
    assert.equal(r.body.code, 'plugin_off');
    assert.deepEqual(queue.snapshotComputeQueue().items, []);
  });
});

describe('list, status, stop', () => {
  it("this study's cases only, kind foam only; another scope's job is not_found", async () => {
    makeCase('c1');
    const a = (await srv.post('/api/plugin-cases/submit', submitBody())).body.job;
    const other = runningCase('o1', 's2');
    store.createFoamRecord({ kind: 'mesh', project_id: PID, plugin: KEY, study_id: SID, case_dir: 'x' });
    const list = await srv.get(`/api/plugin-cases?${scopeQs()}`);
    assert.deepEqual(list.body.jobs.map((j) => j.id), [a.id]);
    assert.equal((await srv.get(`/api/plugin-cases/status?${scopeQs({ job_id: a.id })}`)).body.job.status, 'queued');
    const foreign = await srv.get(`/api/plugin-cases/status?${scopeQs({ job_id: other.id })}`);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.code, 'not_found');
    const stopForeign = await srv.post('/api/plugin-cases/stop', { project_id: PID, plugin: KEY, study_id: SID, job_id: other.id });
    assert.equal(stopForeign.status, 404);
    // Stop of a queued case: off the queue, stopped.
    const stopped = await srv.post('/api/plugin-cases/stop', { project_id: PID, plugin: KEY, study_id: SID, job_id: a.id });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.job.status, 'stopped');
    assert.equal(stopped.body.job.error, 'Removed from the queue before it started');
    assert.deepEqual(queue.snapshotComputeQueue().items, []);
    // Stop of a running case: stopping, by the user.
    const run = runningCase('r1');
    const s = await srv.post('/api/plugin-cases/stop', { project_id: PID, plugin: KEY, study_id: SID, job_id: run.id });
    assert.deepEqual([s.body.job.status, s.body.job.stopping], ['running', true]);
    assert.equal(store.readFoamRecord(run.id).stop.by, 'user');
  });
});

describe('scope: the project too', () => {
  it("another project's case of the same plugin and study id is not_found, not listed, and its events never reach this stream", async () => {
    const theirs = store.createFoamRecord({
      kind: 'foam',
      project_id: 'p2',
      plugin: KEY,
      plugin_name: 'Foam demo',
      study_id: SID,
      study_title: 'Cavity case 1',
      case_rel: 'cases/c1',
      case_parts: ['studies', SID, 'cases', 'c1'],
      case_key: `studies/${SID}/cases/c1`,
      case_dir: join(PROJECTS, 'p2', 'plugins', KEY, 'studies', SID, 'cases', 'c1'),
      case_base: join(PROJECTS, 'p2', 'plugins', KEY),
      token: '0011aacc',
      wsl_case: `cfddesk-pf-foam-demo-${SID}-0011aacc`,
      wsl_root: '/home/tester/cases',
      app: 'pimpleFoam',
    });
    store.updateFoamRecord(theirs.id, { status: 'running' });
    const status = await srv.get(`/api/plugin-cases/status?${scopeQs({ job_id: theirs.id })}`);
    assert.deepEqual([status.status, status.body.code], [404, 'not_found']);
    const stop = await srv.post('/api/plugin-cases/stop', { project_id: PID, plugin: KEY, study_id: SID, job_id: theirs.id });
    assert.deepEqual([stop.status, stop.body.code], [404, 'not_found']);
    assert.ok(!store.readFoamRecord(theirs.id).stop, 'not stopped');
    assert.deepEqual((await srv.get(`/api/plugin-cases?${scopeQs()}`)).body.jobs, []);
    const chunks = [];
    const req = http.get(`${srv.base}/api/plugin-cases/events?${scopeQs()}`);
    const res = await new Promise((r) => req.on('response', r));
    res.setEncoding('utf8');
    res.on('data', (c) => chunks.push(c));
    await sleep(80);
    store.emitFoamEvent(theirs.id, { event: 'stage', stage: 'solve' });
    await sleep(80);
    req.destroy();
    assert.ok(chunks.join('').includes('event: snapshot'));
    assert.ok(!chunks.join('').includes(theirs.id), "another project's case never reaches this stream");
  });
});

describe('host stops (plugin off, environment removed, the Reload button)', () => {
  it('disable: epoch bumped before and after the worker; running cases stop once with a notice; queued ones drop', async () => {
    const run = runningCase('r1');
    makeCase('c2');
    const queued = (await srv.post('/api/plugin-cases/submit', submitBody('cases/c2'))).body.job;
    const e0 = runner.pluginEpoch(KEY);
    const r = await srv.post(`/api/plugins/${KEY}/disable`);
    assert.equal(r.status, 200);
    assert.notEqual(runner.pluginEpoch(KEY), e0);
    const rec = store.readFoamRecord(run.id);
    assert.deepEqual([rec.stop.by, rec.stop.level, rec.stop.reason], ['plugin_off', 'graceful', 'Foam demo was turned off']);
    assert.equal(store.readFoamRecord(queued.id).status, 'stopped');
    const notices = queue.snapshotComputeQueue().failed;
    assert.deepEqual(notices.map((n) => [n.reason, n.error]).sort(), [
      ['dropped', 'Foam demo was turned off'],
      ['stopped', 'Foam demo was turned off'],
    ]);
    // An unflagged reload afterwards stops nothing more.
    await srv.post('/api/worker', { method: 'registry.reload', params: {} });
    assert.equal(queue.snapshotComputeQueue().failed.length, 2);
    assert.equal(store.readFoamRecord(run.id).stop.level, 'graceful');
  });

  it('a disable the worker refuses bumps once and stops nothing', async () => {
    const run = runningCase('r1');
    worker.disableFails = true;
    const e0 = runner.pluginEpoch(KEY);
    const r = await srv.post(`/api/plugins/${KEY}/disable`);
    assert.equal(r.status, 500);
    assert.notEqual(runner.pluginEpoch(KEY), e0, 'bumped before the call');
    assert.equal(store.readFoamRecord(run.id).stop, null);
  });

  it('env remove stops its cases; enable stops nothing; reload only with stop_plugin_cases', async () => {
    const run = runningCase('r1');
    await srv.post(`/api/plugins/${KEY}/enable`);
    assert.equal(store.readFoamRecord(run.id).stop, null);
    const e0 = runner.pluginEpoch(KEY);
    await srv.post('/api/worker', { method: 'registry.reload', params: {} });
    assert.equal(runner.pluginEpoch(KEY), e0, 'an unflagged reload bumps nothing');
    assert.equal(store.readFoamRecord(run.id).stop, null);
    await srv.post('/api/worker', { method: 'registry.reload', params: { stop_plugin_cases: true } });
    assert.notEqual(runner.pluginEpoch(KEY), e0);
    assert.deepEqual([store.readFoamRecord(run.id).stop.by, store.readFoamRecord(run.id).stop.reason], ['reload', 'plugins were reloaded']);
    const reloadCall = worker.calls.filter((c) => c[0] === 'registry.reload').at(-1);
    assert.deepEqual(reloadCall[1], {}, 'the worker never sees the flag');
    const run2 = runningCase('r2', 's2');
    await srv.post(`/api/plugins/${KEY}/env/remove`);
    assert.deepEqual([store.readFoamRecord(run2.id).stop.by, store.readFoamRecord(run2.id).stop.reason], ['env_removed', "Foam demo's environment was removed"]);
  });
});

describe('plugin studies', () => {
  it('delete: a running case refuses (any spelling of the project); queued cases drop at once; the next job starts while the worker deletes', async () => {
    runningCase('r1');
    const busy = await srv.post('/api/plugin-studies/delete', { project_id: PID, plugin: KEY, study_id: SID });
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.body, { ok: false, code: 'busy', error: 'A case of this study is running. Stop it before deleting the study.' });
    if (process.platform === 'win32') {
      const upper = await srv.post('/api/plugin-studies/delete', { project_id: PID.toUpperCase(), plugin: KEY, study_id: SID });
      assert.equal(upper.status, 409);
    }
    // s2: one queued case, then a mesh in another project behind it.
    makeCase('q1', 's2');
    const job = (await srv.post('/api/plugin-cases/submit', submitBody('cases/q1', { study_id: 's2' }))).body.job;
    queue.enqueueComputeJob({ kind: 'mesh', mesh_id: 'm1', project_id: 'other' });
    const started = [];
    queue.configureComputeQueue({ isBusy: () => false, startMesh: (row) => (started.push(row.mesh_id), { ok: true }) });
    const release = worker.holdNext('plugin_studies.delete');
    const deleting = srv.post('/api/plugin-studies/delete', { project_id: PID, plugin: KEY, study_id: 's2' });
    await sleep(80);
    assert.equal(store.readFoamRecord(job.id).status, 'stopped');
    assert.equal(store.readFoamRecord(job.id).error, 'The study was deleted');
    await queue.kickComputeQueue();
    assert.deepEqual(started, ['m1'], 'the queue moved on while the worker still deletes');
    release();
    assert.equal((await deleting).status, 200);
    assert.ok(queue.snapshotComputeQueue().failed.some((f) => f.reason === 'dropped' && f.error === 'The study was deleted'));
  });

  it('delete with no project, or a project that does not exist: refused before anything is dropped', async () => {
    makeCase('q1', 's2');
    const job = (await srv.post('/api/plugin-cases/submit', submitBody('cases/q1', { study_id: 's2' }))).body.job;
    const none = await srv.post('/api/plugin-studies/delete', { plugin: KEY, study_id: 's2' });
    assert.deepEqual([none.status, none.body.code, none.body.error], [400, 'bad_request', 'project_id required']);
    const nope = await srv.post('/api/plugin-studies/delete', { project_id: 'nope', plugin: KEY, study_id: 's2' });
    assert.deepEqual([nope.status, nope.body.code], [404, 'not_found']);
    assert.equal(store.readFoamRecord(job.id).status, 'queued');
    assert.equal(queue.snapshotComputeQueue().items.length, 1);
    assert.ok(!worker.calls.some((c) => c[0] === 'plugin_studies.delete'), 'the worker was not asked');
    // A study id is unique only in its project: the queue drops nothing without one.
    assert.deepEqual(queue.dropFoamJobs({ plugin: KEY, study_id: 's2' }, 'The study was deleted'), []);
    assert.equal(queue.snapshotComputeQueue().items.length, 1);
    if (process.platform === 'win32') {
      // The same project in another letter case is that project: its queued case drops.
      const upper = await srv.post('/api/plugin-studies/delete', { project_id: PID.toUpperCase(), plugin: KEY, study_id: 's2' });
      assert.equal(upper.status, 200);
      assert.deepEqual([store.readFoamRecord(job.id).status, store.readFoamRecord(job.id).error], ['stopped', 'The study was deleted']);
      assert.equal(queue.snapshotComputeQueue().items.length, 0);
    }
  });

  it('rename: queued rows and records carry the new title', async () => {
    makeCase('c1');
    const job = (await srv.post('/api/plugin-cases/submit', submitBody())).body.job;
    const r = await srv.post('/api/plugin-studies/rename', { project_id: PID, plugin: KEY, study_id: SID, title: 'Lid driven', rev: 1 });
    assert.equal(r.status, 200);
    assert.equal(queue.snapshotComputeQueue().items[0].name, 'Lid driven · c1 · Foam demo');
    assert.equal(store.readFoamRecord(job.id).study_title, 'Lid driven');
  });
});

describe('results: resolve', () => {
  it('running while queued or running; no_results without a complete frame; else the case', async () => {
    const dir = makeCase('c1');
    const job = (await srv.post('/api/plugin-cases/submit', submitBody())).body.job;
    const qs = scopeQs({ case_rel: 'cases/c1' });
    const running = await srv.get(`/api/plugin-cases/resolve?${qs}`);
    assert.equal(running.status, 409);
    assert.equal(running.body.code, 'running');
    runner.finishFoam(job.id, 'done', {});
    const none = await srv.get(`/api/plugin-cases/resolve?${qs}`);
    assert.equal(none.status, 404);
    assert.equal(none.body.code, 'no_results');
    for (const t of ['0', '0.1', '0.2']) {
      mkdirSync(join(dir, t), { recursive: true });
      for (const f of ['U', 'p']) writeFileSync(join(dir, t, f), 'x');
    }
    mkdirSync(join(dir, '0.3'), { recursive: true });
    writeFileSync(join(dir, '0.3', 'U'), 'x');
    const ok = await srv.get(`/api/plugin-cases/resolve?${qs}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.key, /^pf-[0-9a-f]{12}$/);
    assert.deepEqual(ok.body.times, ['0.1', '0.2'], 'complete frames after 0 only');
    assert.equal(ok.body.app, 'pimpleFoam');
    assert.equal(ok.body.time_dependency, 'transient');
    assert.deepEqual(ok.body.frame_fields, ['U', 'p']);
    const missing = await srv.get(`/api/plugin-cases/resolve?${scopeQs({ case_rel: 'cases/zz' })}`);
    assert.equal(missing.body.code, 'not_found');
  });
});

describe('events (SSE)', () => {
  it("a snapshot of this study's cases with the running one's points, then its events by seq", async () => {
    makeCase('c1');
    const queued = (await srv.post('/api/plugin-cases/submit', submitBody())).body.job;
    const run = runningCase('r1');
    const otherRun = runningCase('r2', 's2');
    store.emitFoamEvent(run.id, { event: 'progress', time: 0.1, n_steps: 1, residuals: {}, points: [{ t: 0.1, Ux: 0.5 }] });
    const chunks = [];
    const req = http.get(`${srv.base}/api/plugin-cases/events?${scopeQs()}`);
    const res = await new Promise((r) => req.on('response', r));
    res.setEncoding('utf8');
    res.on('data', (c) => chunks.push(c));
    await sleep(80);
    store.emitFoamEvent(otherRun.id, { event: 'stage', stage: 'solve' });
    store.emitFoamEvent(run.id, { event: 'stage', stage: 'solve' });
    await sleep(80);
    req.destroy();
    const text = chunks.join('');
    const blocks = text.split('\n\n').filter((b) => b.startsWith('event:'));
    const parse = (b) => ({ event: b.split('\n')[0].slice(7), data: JSON.parse(b.split('\n')[1].slice(6)) });
    const [snap, ...rest] = blocks.map(parse);
    assert.equal(snap.event, 'snapshot');
    assert.deepEqual(snap.data.jobs.map((j) => j.id).sort(), [queued.id, run.id].sort());
    assert.deepEqual(snap.data.live, { job_id: run.id, points: [{ t: 0.1, Ux: 0.5 }] });
    assert.deepEqual(rest.map((e) => [e.event, e.data.job_id, e.data.seq, e.data.ev.stage]), [['case', run.id, 2, 'solve']]);
    assert.ok(!text.includes(otherRun.id), "another study's case never reaches this stream");
  });
});
