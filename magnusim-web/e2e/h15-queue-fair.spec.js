import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_GEOMETRY_PROJECT, QUEUE_PROJECT_A } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { computeQueue, createRun, getJson, killFoamRelays, meshRow, removeTestWslRoot, runRow } from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// H15, one compute slot shared fairly (gate:h15-queue-fair), with no page open: a core mesh,
// two core runs and two plugin cases of two studies run one at a time, first come first
// served across kinds and projects. A study deleted while its case waits at the head drops
// that case at once (the delete itself waits on the plugin lane), and the next job starts
// while the plugin lane is held by a slow plugin call: the queue never waits on the worker.
// Core runs fire the plugin's solve.parse_line hook ("core" lines). A second app server.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const P = NO_GEOMETRY_PROJECT;
const KEY = 'foam-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:h15-queue-fair: mesh, runs and plugin cases take turns on one slot', async ({ request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-fair +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('h15-fair');
  const wslRoot = `/tmp/magnusim-e2e-h15-fair-${process.pid}/cases`;
  const hookLog = join(tmp, 'hooks.log');
  const host = await startHost({
    name: 'h15-fair',
    tmp,
    pluginsFrom: 'python/tests/fixtures/foam-plugins',
    env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot, MAGNUSIM_TEST_HOOK_LOG: hookLog },
    log: stage,
  });
  const { base } = host;
  let holdLane = true;
  let laneLoop = Promise.resolve();
  try {
    const queue = async () => (await computeQueue(request, { base })) || { items: [], busy: null, failed: [] };
    const post = async (url, data, timeout = 60_000) => {
      const r = await request.post(`${base}${url}`, { data, timeout });
      const j = await r.json().catch(() => ({}));
      return { status: r.status(), body: j };
    };

    // 1. A core mesh in project A holds the slot.
    const gen = await post('/api/mesh/generate', { project_id: A, simulation_id: 'sim_1', mesh_id: 'mesh_1' });
    expect(gen.status, JSON.stringify(gen.body)).toBeLessThan(300);
    await expect.poll(async () => (await queue()).busy?.kind || 'idle', { timeout: 60_000 }).toBe('mesh');
    stage('M (mesh in A) runs');

    // 2. Two Foam demo studies; X's case is submitted first.
    const study = async (title) => {
      const r = await post('/api/plugin-studies/create', { project_id: P, plugin: KEY, kind: 'cavity_case', title });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.study.id;
    };
    const X = await study('Study X');
    const Y = await study('Study Y');
    for (const sid of [X, Y]) {
      const w = await post(`/api/plugin/${KEY}/write_cavity`, { project_id: P, case: 'cases/c1', study_id: sid, end_time: 0.5, write_interval: 0.1 });
      expect(w.status, JSON.stringify(w.body)).toBe(200);
    }
    const submit = async (sid) => {
      const r = await post(`/api/plugin-cases/submit?project_id=${P}`, {
        project_id: P,
        plugin: KEY,
        study_id: sid,
        case_rel: 'cases/c1',
        app: 'pimpleFoam',
        pre: [{ tool: 'blockMesh' }],
        results: { rho: 1, kinematicFields: ['p'] },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return r.body.job.id;
    };
    const F1 = await submit(X);
    stage(`F1 ${F1} (study X) queued`);

    // 3. S1 (a 10-iteration run in A), F2 (study Y), S2: in that order.
    const queueRun = async (name) => {
      const rid = await createRun(request, { base, projectId: A, name });
      const u = await post('/api/run/update', { project_id: A, simulation_id: 'sim_1', run_id: rid, endTime: 10, writeInterval: 10 });
      expect(u.status, JSON.stringify(u.body)).toBe(200);
      const q = await post('/api/compute-queue', { item: { kind: 'solve', project_id: A, run_id: rid, simulation_id: 'sim_1', name }, mesh_generating: true });
      expect(q.status, JSON.stringify(q.body)).toBe(200);
      return rid;
    };
    const S1 = await queueRun('Fair S1');
    const F2 = await submit(Y);
    const S2 = await queueRun('Fair S2');
    const rows = (await queue()).items.map((r) => (r.kind === 'foam' ? r.job_id : r.run_id));
    expect(rows).toEqual([F1, S1, F2, S2]);
    expect((await queue()).busy?.kind, 'M must still run for the order to mean anything').toBe('mesh');
    stage(`queued F1, S1 ${S1}, F2 ${F2}, S2 ${S2}`);

    // 4. Hold the plugin lane: one slow call after another (each under the lane's 30 s timeout).
    laneLoop = (async () => {
      while (holdLane) {
        await request.post(`${base}/api/plugin/${KEY}/slow`, { data: { project_id: P, seconds: 25 }, timeout: 60_000 }).catch(() => undefined);
      }
    })();
    await sleep(1_000);

    // 5. Delete study X while F1 waits at the head: F1 leaves the queue at once.
    const deleting = post('/api/plugin-studies/delete', { project_id: P, plugin: KEY, study_id: X }, 120_000);
    const asked = Date.now();
    await expect
      .poll(async () => (await queue()).items.some((r) => r.job_id === F1), { timeout: 2_000, intervals: [200] })
      .toBe(false);
    const dropped = ((await queue()).failed || []).filter((f) => f.job_id === F1);
    expect(dropped.map((f) => [f.reason, f.error])).toEqual([['dropped', 'The study was deleted']]);
    stage(`F1 dropped ${Date.now() - asked} ms after the study delete was sent`);

    // 6. M, then S1, F2 and S2, one at a time; each hand-off within 15 s.
    const live = async () => {
      const [m, s1, s2, f2] = await Promise.all([
        meshRow(request, A, { base }),
        runRow(request, { base, projectId: A, runId: S1 }),
        runRow(request, { base, projectId: A, runId: S2 }),
        getJson(request, `${base}/api/plugin-cases/status?project_id=${P}&plugin=${KEY}&study_id=${Y}&job_id=${F2}`),
      ]);
      const running = [];
      if ((m.live_mesh_result || {}).status === 'running') running.push('M');
      if (s1.status === 'running') running.push('S1');
      if ((f2.job || {}).status === 'running') running.push('F2');
      if (s2.status === 'running') running.push('S2');
      const out = { running, s1: s1.status, s2: s2.status, f2: (f2.job || {}).status, mesh: (m.live_mesh_result || {}).status };
      // A job that failed says why (its own error), so the report names the cause.
      for (const [name, row] of [['s1', s1], ['s2', s2], ['f2', f2.job || {}]]) {
        if (/failed|stopped/.test(String(row.status || ''))) out[`${name}_error`] = row.error || row.message || row.stage || '(none given)';
      }
      return out;
    };
    const holderOf = (b) => {
      if (!b) return null;
      if (b.kind === 'mesh') return 'M';
      if (b.kind === 'solve') return b.run_id === S1 ? 'S1' : b.run_id === S2 ? 'S2' : `solve:${b.run_id}`;
      if (b.kind === 'foam') return b.job_id === F2 ? 'F2' : `foam:${b.job_id}`;
      return b.kind;
    };
    const seen = ['M'];
    let freeSince = null;
    const until = Date.now() + 3_000_000;
    let last = '';
    for (;;) {
      const q = await queue();
      const h = holderOf(q.busy);
      const l = await live();
      expect(l.running.length, `never two live: ${JSON.stringify(l)}`).toBeLessThanOrEqual(1);
      if (h && h !== seen[seen.length - 1]) {
        seen.push(h);
        if (freeSince) stage(`hand-off to ${h} after ${Date.now() - freeSince} ms`);
        expect(freeSince === null || Date.now() - freeSince <= 15_000, `hand-off to ${h} took over 15 s`).toBe(true);
        freeSince = null;
      }
      if (!h && freeSince === null) freeSince = Date.now();
      if (h === null && freeSince && Date.now() - freeSince > 15_000) {
        throw new Error(`the slot stayed free over 15 s after ${seen.join(' -> ')}: ${JSON.stringify(q.items)}`);
      }
      const now = `${seen.join(' -> ')} | ${JSON.stringify(l)}`;
      if (now !== last) stage(now);
      last = now;
      if (seen.length >= 4 && l.s2 === 'done' && !h) break;
      if (/failed|stopped/.test(`${l.s1} ${l.s2} ${l.f2}`)) throw new Error(`a job did not finish: ${JSON.stringify(l)}`);
      if (Date.now() > until) throw new Error(`the queue did not run through: ${now}`);
      if (seen.length >= 4 && holdLane) {
        holdLane = false;
        stage('S2 started: the plugin lane is let go');
      }
      await sleep(1_000);
    }
    expect(seen).toEqual(['M', 'S1', 'F2', 'S2']);
    expect((await live()).f2).toBe('done');
    const del = await deleting;
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.ok).toBe(true);
    const hooks = existsSync(hookLog) ? readFileSync(hookLog, 'utf8') : '';
    expect(hooks.split('\n').some((l) => l.startsWith('core ')), hooks.slice(0, 400)).toBe(true);
    stage('M -> S1 -> F2 -> S2, one at a time; core hook lines seen; the study delete answered ok');
  } finally {
    holdLane = false;
    await laneLoop.catch(() => undefined);
    for (const line of killFoamRelays(host.projects)) stage(`relay kill ${line}`);
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-fair] WSL root not removed: ${e.message}`);
    }
  }
});
