// The mesh's Stop (Assistant phase 5 spec 8.4, finding 1). Nobody could stop a mesh: the
// Mesh panel had no Stop, and POST /api/jobs/:id/stop of a mesh job killed nothing (the
// mesh starters gave the job manager a plain {pid}), then the mesher's later end wrote
// "done" over "stopped". Now POST /api/mesh/stop ends the generate and deletes nothing,
// a queued mesh leaves the queue, and the job manager's stop goes through w21 too.
//
// The real routes and router in this process, a seeded elbow project, and the fake
// mesher (MAGNUSIM_TEST_COMPUTE=fake: python/tools/fake_mesh_generate.py, no WSL).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-meshstop-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
const LOCAL = join(ROOT, 'local.json');
writeFileSync(LOCAL, '{}');
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = LOCAL;
process.env.CFDDESK_LOCAL_JSON = LOCAL;
process.env.MAGNUSIM_QUEUE_QUIET = '1';
process.env.MAGNUSIM_TEST_COMPUTE = 'fake';
// Long enough that every stop here finds it running.
process.env.MAGNUSIM_TEST_MESH_SECONDS = '60';

const { JobManager } = await import('../jobs.ts');
const { pidIsAlive } = await import('../../w21-mesh-generate.js');
const PID = 'mesh-stop-node';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('JobManager: a job ends once', () => {
  const cache = join(ROOT, 'jm');
  it("a job's stop function ends it, and the process's later end does not overwrite stopped", () => {
    const jobs = new JobManager({ cacheDir: cache });
    const job = jobs.create('mesh', { project_id: 'p', simulation_id: 's', mesh_id: 'm' }, 'p');
    let stopped = 0;
    jobs.attachChild(job.id, { pid: 123 }, { stop: () => (stopped += 1) });
    assert.equal(jobs.get(job.id).status, 'running');
    jobs.stop(job.id, 'p');
    assert.equal(stopped, 1, 'the owner was asked to stop it');
    assert.equal(jobs.get(job.id).status, 'stopped');
    // The generator closes later and its handler reports how it ended.
    jobs.finish(job.id, 'done', { n_cells: 9 });
    assert.equal(jobs.get(job.id).status, 'stopped');
    assert.equal(jobs.get(job.id).result, null);
    jobs.finish(job.id, 'failed', null, 'exit 1');
    assert.equal(jobs.get(job.id).status, 'stopped');
    // A second stop calls nothing again.
    jobs.stop(job.id, 'p');
    assert.equal(stopped, 1);
  });

  it('a job that ended before its process was attached stays ended', () => {
    const jobs = new JobManager({ cacheDir: cache });
    const job = jobs.create('mesh', { project_id: 'p', simulation_id: 's' }, 'p');
    jobs.finish(job.id, 'failed', null, 'mesh failed');
    jobs.attachChild(job.id, { pid: 7 });
    assert.equal(jobs.get(job.id).status, 'failed');
  });

  it('the first end counts: done then failed stays done', () => {
    const jobs = new JobManager({ cacheDir: cache });
    const job = jobs.create('mesh', { project_id: 'p', simulation_id: 's' }, 'p');
    jobs.attachChild(job.id, { pid: 7 });
    jobs.finish(job.id, 'done', { ok: true });
    jobs.finish(job.id, 'failed', null, 'late');
    assert.equal(jobs.get(job.id).status, 'done');
    assert.equal(jobs.get(job.id).error, null);
  });
});

describe('POST /api/mesh/stop and a mesh job stop', () => {
  let server;
  let base;
  let jobs;
  let sim;
  let meshId;

  before(async () => {
    const { seedElbowProject } = await import('../../../e2e/prepare-projects.js');
    seedElbowProject(PROJECTS, PID, 'Mesh stop');
    const { Router, dispatch } = await import('../router.ts');
    const { registerLiveRoutes } = await import('../live-routes.js');
    const { registerPhase3Routes } = await import('../routes.ts');
    const router = new Router();
    jobs = new JobManager({ cacheDir: join(ROOT, 'jobs') });
    const worker = { on() {}, call: async () => ({}), stop() {} };
    registerLiveRoutes(router, { worker, jobs, services: null });
    registerPhase3Routes(router, {
      worker,
      jobs,
      webRoot: ROOT,
      cacheDir: join(ROOT, 'cache'),
      serveLegacyFilter: async (ctx) => ctx.sendJson(200, { ok: true }),
      startMeshJob() {},
      startSolveJob() {},
      startCadImportJob() {},
      caseSnapshot: () => ({}),
      attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
      resetCaseIdle() {},
      envInstaller: () => ({ get: () => null, start: () => ({ state: 'installing', log: [] }) }),
    });
    server = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const doc = await get(`/api/mesh?project_id=${PID}`);
    sim = doc.simulation_id;
    meshId = doc.mesh.id;
    assert.ok(sim && meshId, 'the seeded study and mesh');
  });

  after(async () => {
    await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: meshId }).catch(() => {});
    server?.close();
    await sleep(500);
    rmSync(ROOT, { recursive: true, force: true });
  });

  async function get(path) {
    const r = await fetch(base + path);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  const meshRec = async (id = meshId) => (await get(`/api/mesh?project_id=${PID}&simulation_id=${sim}&mesh_id=${id}`)).mesh;
  /** The generator's pid once its process is up (the record says running). */
  async function generating(id = meshId) {
    for (let i = 0; i < 100; i += 1) {
      const live = (await meshRec(id))?.live_mesh_result;
      if (live && live.status === 'running' && live.pid) return Number(live.pid);
      await sleep(100);
    }
    throw new Error('the mesh never started generating');
  }
  async function gone(pid) {
    for (let i = 0; i < 100; i += 1) {
      if (!pidIsAlive(pid)) return true;
      await sleep(100);
    }
    return false;
  }

  it('stops a generating mesh: the generator dies, the mesh says stopped, nothing is deleted', async () => {
    const before = await meshRec();
    const started = await post('/api/mesh/generate', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const pid = await generating();
    assert.ok(pidIsAlive(pid));

    const stop = await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.stopped, true);
    assert.equal(stop.body.name, 'Mesh 1');
    assert.ok(await gone(pid), 'the generator process is gone');
    const rec = await meshRec();
    assert.equal(rec.live_mesh_result.status, 'stopped');
    assert.equal(rec.generated, false);
    // The record, its name and settings stay (Stop is not Delete).
    assert.equal(rec.id, meshId);
    assert.equal(rec.name, before.name);
    assert.deepEqual(rec.settings, before.settings);
    // The slot is free: another generate may start.
    const queue = await get('/api/compute-queue');
    assert.equal(queue.live, null);

    const again = await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'not_running');
    assert.match(again.body.error, /Mesh 1 is not generating/);
  });

  it('an unknown mesh is 404; a missing mesh_id is 400', async () => {
    assert.equal((await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: 'nope' })).status, 404);
    assert.equal((await post('/api/mesh/stop', { project_id: PID, simulation_id: sim })).status, 400);
  });

  it('POST /api/jobs/:id/stop of a mesh job now stops the mesher, and its end stays stopped', async () => {
    const started = await post('/api/mesh/generate', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const jobId = started.body.job_id;
    assert.match(String(jobId), /^job-/);
    const pid = await generating();
    const stop = await post(`/api/jobs/${jobId}/stop?project_id=${PID}`, {});
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.ok(await gone(pid), 'the generator process is gone');
    // Its close comes after the kill; then the job and the mesh both still say stopped.
    await sleep(1500);
    assert.equal(jobs.get(jobId).status, 'stopped');
    assert.equal((await meshRec()).live_mesh_result.status, 'stopped');
  });

  it('a queued mesh leaves the queue; the running one keeps running', async () => {
    const made = await post('/api/mesh', { project_id: PID, simulation_id: sim, create: true, name: 'Mesh 2' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const second = String(made.body.mesh.id);
    assert.notEqual(second, meshId);
    const started = await post('/api/mesh/generate', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(started.status, 202);
    const pid = await generating();
    const queued = await post('/api/mesh/generate', { project_id: PID, simulation_id: sim, mesh_id: second, queue_if_busy: true, name: 'Mesh 2' });
    assert.ok(queued.status < 300, JSON.stringify(queued.body));
    const rows = async () => (await get(`/api/compute-queue?project_id=${PID}`)).items.filter((r) => r.kind === 'mesh' && r.mesh_id === second);
    assert.equal((await rows()).length, 1, 'Mesh 2 waits in the queue');

    const stop = await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: second });
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.unqueued, true);
    assert.equal((await rows()).length, 0);
    assert.ok(pidIsAlive(pid), 'Mesh 1 still generates');

    const stop1 = await post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: meshId });
    assert.equal(stop1.status, 200);
    assert.ok(await gone(pid));
  });

  // The search for a mesh's leftover generators ran PowerShell with spawnSync for up to 15 s on
  // every mesh stop and delete: the whole server (every page, every SSE heartbeat) waited.
  it("the server answers other requests while a stop and a delete search for the mesh's leftover generators", async () => {
    const { setStaleGeneratorFinderForTests } = await import('../../w21-mesh-generate.js');
    const searches = [];
    // A search that takes as long as a slow PowerShell does, until the test lets it end.
    setStaleGeneratorFinderForTests((caseDir) => new Promise((resolve) => searches.push({ caseDir, end: () => resolve([]) })));
    try {
      for (const how of ['stop', 'delete']) {
        searches.length = 0;
        const started = await post('/api/mesh/generate', { project_id: PID, simulation_id: sim, mesh_id: meshId });
        assert.equal(started.status, 202, JSON.stringify(started.body));
        const pid = await generating();
        let settled = false;
        const asked =
          how === 'stop'
            ? post('/api/mesh/stop', { project_id: PID, simulation_id: sim, mesh_id: meshId })
            : post('/api/mesh', { project_id: PID, simulation_id: sim, mesh_id: meshId, delete_generated: true });
        void asked.then(() => (settled = true));
        for (let i = 0; i < 100 && !searches.length; i += 1) await sleep(50);
        assert.ok(searches.length > 0, `${how}: the leftovers are searched for`);
        // Meanwhile another request is answered at once.
        const t0 = Date.now();
        const queue = await get(`/api/compute-queue?project_id=${PID}`);
        assert.ok(Array.isArray(queue.items));
        assert.ok(Date.now() - t0 < 2_000, `${how}: answered in ${Date.now() - t0} ms while the search ran`);
        assert.equal(settled, false, `${how}: it waits for the search before it answers (a delete removes files after it)`);
        for (const s of searches) s.end();
        const r = await asked;
        assert.equal(r.status, 200, `${how}: ${JSON.stringify(r.body)}`);
        assert.ok(await gone(pid), `${how}: the generator is gone`);
      }
    } finally {
      setStaleGeneratorFinderForTests(null);
    }
  });
});
