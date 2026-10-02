import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_GEOMETRY_PROJECT, QUEUE_PROJECT_A, QUEUE_PROJECT_B, prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import {
  computeQueue,
  foamRecords,
  foamStoreFileFor,
  getJson,
  plantNamedProcess,
  queueFileFor,
  removeTestWslRoot,
  runRow,
  stopMesh,
  waitSlotFree,
  wslProcessesUnder,
} from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';
import { persistRunAt } from '../scripts/study-io.js';

// H15, a core solve left running by an app that stopped (gate:h15-core-orphan): before the
// first request the new server checks for jobs left running. A run whose doc says running
// and whose case copy still has a process in WSL (here reconstructPar) holds the slot as
// "finishing": the queued mesh waits, its project cannot be deleted, and its Stop kills its
// WSL processes (never answered "stopped" without a kill). Then the mesh starts with no tab
// open. The run doc, the WSL process and the queue file are made before any server starts.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const B = QUEUE_PROJECT_B;
const RUN = 'h15orphan1';
const CHECK_LABEL = 'Checking for jobs left running';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:h15-core-orphan: a solve left running holds the slot until its Stop', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_800_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-orphan +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('h15-orphan');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const wslRoot = `/tmp/magnusim-e2e-h15-orphan-${process.pid}/cases`;
  const wslCase = `cfddesk-w27-${RUN}`;

  // 1. Before any server: a run doc left "running" (its relay pid long gone), a process in
  // its case copy, and a queued mesh for B.
  const dead = spawnSync(process.platform === 'win32' ? 'cmd' : 'true', process.platform === 'win32' ? ['/c', 'exit'] : [], { windowsHide: true }).pid;
  const doc = persistRunAt(join(projects, A), 'sim_1', {
    id: RUN,
    run_id: RUN,
    name: 'Left running',
    status: 'running',
    stage: 'solve',
    pid: dead,
    wsl_case: wslCase,
    mesh_id: 'mesh_1',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    has_results: false,
  });
  expect(doc.status).toBe('running');
  plantNamedProcess(`${wslRoot}/${wslCase}`, 'reconstructPar');
  writeFileSync(
    queueFileFor(projects),
    JSON.stringify({
      items: [
        {
          id: 'q-h15orphanmesh',
          kind: 'mesh',
          project_id: B,
          mesh_id: 'mesh_1',
          simulation_id: 'sim_1',
          name: 'Mesh 1',
          settings: { fineness: 1, hex_element_core: false, automatic_boundary_layers: false },
        },
      ],
    }),
  );
  stage(`run ${RUN} left running (pid ${dead} gone), reconstructPar in ${wslCase}, B's mesh queued`);

  const host = await startHost({ name: 'h15-orphan', tmp, projects, seed: false, env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot }, log: stage });
  const { base } = host;
  try {
    const queue = async () => (await computeQueue(request, { base })) || { items: [], busy: null };
    // 2. From the first answer on: a check, then the run as a draining solve; A cannot be deleted.
    const first = await queue();
    const del = await request.post(`${base}/api/project/delete`, { data: { project_id: A } });
    const delBody = await del.json();
    expect(del.status(), JSON.stringify(delBody)).toBe(409);
    expect([
      'The app is checking this project for jobs left running. Try again in a few seconds.',
      'A job in this project is still stopping. Try again when it has stopped.',
    ]).toContain(delBody.error);
    expect(first.busy && ['check', 'solve'].includes(first.busy.kind), JSON.stringify(first.busy)).toBe(true);
    if (first.busy.kind === 'check') {
      expect([first.busy.phase, first.busy.name, first.busy.project_id]).toEqual(['checking', CHECK_LABEL, null]);
    }
    stage(`first answer: ${first.busy.kind}; delete refused: ${delBody.error}`);
    await page.goto(`${base}/#/p/${A}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, A, { timeout: 90_000 });
    // What the page itself holds: its last queue answer's busy job and the Queue button title.
    const pageQueue = () =>
      page.evaluate(() => {
        const q = /** @type {any} */ (window).__CFD_JOB_QUEUE__;
        return { kind: (q && q.busy && q.busy.kind) || null, title: document.getElementById('btn-queue')?.getAttribute('title') || '' };
      });
    let sawSolve = false;
    let sawFinishing = false;
    let sawCheckTitle = false;
    for (let i = 0; i < 25; i++) {
      const q = await queue();
      const b = q.busy;
      expect(b && (b.kind === 'check' || (b.kind === 'solve' && b.run_id === RUN)), `poll ${i}: ${JSON.stringify(b)}`).toBe(true);
      if (b.kind === 'solve') {
        sawSolve = true;
        expect(b.phase).toBe('draining');
      }
      expect(q.items.map((r) => [r.kind, r.project_id]), `the mesh waits, poll ${i}`).toEqual([['mesh', B]]);
      const pq = await pageQueue();
      if (pq.kind === 'check') {
        expect(pq.title, `poll ${i}: the check's title`).toContain(`Running: ${CHECK_LABEL}`);
        sawCheckTitle = true;
      }
      if (/\(finishing\)/.test(pq.title)) sawFinishing = true;
      expect((await runRow(request, { base, projectId: A, runId: RUN })).status).toBe('running');
      await sleep(1_000);
    }
    expect(sawSolve, 'the check handed the slot to the run').toBe(true);
    expect(sawFinishing, 'the Queue title said (finishing)').toBe(true);
    if (!sawCheckTitle) {
      // The check ended before this page first asked (it takes a second or two here): give the
      // page the server's answer for a check (its shape as above, `live` null as for any other
      // project) and read the title it shows.
      const asCheck = async (route) => {
        const real = await route.fetch();
        const body = await real.json();
        await route.fulfill({ response: real, json: { ...body, live: null, busy: { kind: 'check', phase: 'checking', name: CHECK_LABEL, stopping: false, project_id: null } } });
      };
      await page.route('**/api/compute-queue?*', asCheck);
      await expect.poll(async () => (await pageQueue()).title, { timeout: 15_000, intervals: [500] }).toContain(`Running: ${CHECK_LABEL}`);
      await page.unroute('**/api/compute-queue?*', asCheck);
      await expect.poll(async () => (await pageQueue()).title, { timeout: 15_000, intervals: [500] }).toMatch(/\(finishing\)/);
    }
    stage(`the Queue title read "${CHECK_LABEL}" ${sawCheckTitle ? 'during the check' : 'for a check answer given to the page'}`);
    expect(((await getJson(request, `${base}/api/projects`)).projects || []).some((p) => p.id === A)).toBe(true);
    stage('the run left running holds the slot as finishing for 25 s; the mesh waits');

    // 3. Its Stop kills it in WSL (no "stopped" without a kill); then B's mesh starts with no tab open.
    await page.goto('about:blank');
    const stop = await request.post(`${base}/api/run/stop`, { data: { project_id: A, run_id: RUN } });
    const stopBody = await stop.json();
    expect(stop.status(), JSON.stringify(stopBody)).toBe(200);
    expect(stopBody.stopping).toBe(true);
    expect(stopBody.stale).not.toBe(true);
    await expect.poll(() => wslProcessesUnder(`${wslRoot}/${wslCase}`), { timeout: 15_000, intervals: [1_000] }).toEqual([]);
    await expect.poll(async () => (await queue()).busy?.kind || 'idle', { timeout: 60_000, intervals: [1_000] }).toBe('mesh');
    expect((await queue()).busy.project_id).toBe(B);
    expect(['stopped', 'failed']).toContain((await runRow(request, { base, projectId: A, runId: RUN })).status);
    const onDisk = JSON.parse(readFileSync(join(doc.dir, 'run.json'), 'utf8'));
    expect(['stopped', 'failed']).toContain(onDisk.status);
    stage(`stopped in WSL; B's mesh started; the run doc says ${onDisk.status}`);
    await stopMesh(request, B, { base });
    await waitSlotFree(request, { base, timeoutMs: 120_000 });
  } finally {
    writeFileSync(test.info().outputPath('host.log'), host.log());
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-orphan] WSL root not removed: ${e.message}`);
    }
  }
});

// Two jobs left running at once (a build before H15 could leave them, or two servers on one
// projects root): a core run in A and a plugin case in C. The boot check follows both on its
// one claim: neither project can be deleted while its job runs, and once the run has ended
// the Queue names the plugin case (kind foam), never "a run".
test('gate:h15-boot-two-jobs: a run and a plugin case left running are each held, named and stopped in turn', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(900_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-boot2 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('h15-boot2');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const wslRoot = `/tmp/magnusim-e2e-h15-boot2-${process.pid}/cases`;
  const C = NO_GEOMETRY_PROJECT;
  const RUN2 = 'h15boot2run';
  const coreCase = `cfddesk-w27-${RUN2}`;
  const SID = 'st-0b0b0b0b';
  const TOKEN = '0b0b0b0b';
  const JOB = 'fc-h15boot2-0b0b0b';
  const foamCase = `cfddesk-pf-foam-demo-${SID}-${TOKEN}`;
  const CASE_NAME = 'Left case · c1 · Foam demo';
  const LEFT_RUNNING = 'A job left running in this project has not ended yet. Try again when it has ended.';

  // 1. Before any server: the run doc and the plugin case record left "running", a process
  // in each case copy.
  const dead = spawnSync(process.platform === 'win32' ? 'cmd' : 'true', process.platform === 'win32' ? ['/c', 'exit'] : [], { windowsHide: true }).pid;
  persistRunAt(join(projects, A), 'sim_1', {
    id: RUN2,
    run_id: RUN2,
    name: 'Left running',
    status: 'running',
    stage: 'solve',
    pid: dead,
    wsl_case: coreCase,
    mesh_id: 'mesh_1',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    has_results: false,
  });
  const base_ = join(projects, C, 'plugins', 'foam-demo');
  const caseDir = join(base_, 'studies', SID, 'cases', 'c1');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    foamStoreFileFor(projects),
    JSON.stringify({
      records: [
        {
          id: JOB,
          kind: 'foam',
          projects_root: resolve(projects).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
          project_id: C,
          plugin: 'foam-demo',
          plugin_name: 'Foam demo',
          study_id: SID,
          study_title: 'Left case',
          case_rel: 'cases/c1',
          case_parts: ['studies', SID, 'cases', 'c1'],
          case_key: `studies/${SID}/cases/c1`,
          case_dir: caseDir,
          case_base: base_,
          token: TOKEN,
          wsl_case: foamCase,
          wsl_root: wslRoot,
          prepare: null,
          app: 'pimpleFoam',
          n_procs: 1,
          pre: [{ tool: 'blockMesh', args: [], parallel: false }],
          results: { kinematic_fields: ['p'], frame_fields: ['U', 'p'], rho: 1 },
          launch: { keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', parallel: 'mpirun', time_dependency: 'transient' },
          spec_path: null,
          status: 'running',
          stage: 'solve',
          row_id: null,
          stop: null,
          node_pid: null,
          created_at: new Date(Date.now() - 120_000).toISOString(),
          started_at: new Date(Date.now() - 110_000).toISOString(),
          finished_at: null,
          error: null,
          code: null,
          result: null,
          seq: 3,
        },
      ],
    }),
  );
  plantNamedProcess(`${wslRoot}/${coreCase}`, 'reconstructPar');
  plantNamedProcess(`${wslRoot}/${foamCase}`, 'pimpleFoam');
  stage(`run ${RUN2} in A and plugin case ${JOB} in C left running, a process in each case copy`);

  const host = await startHost({ name: 'h15-boot2', tmp, projects, seed: false, env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot }, log: stage });
  const { base } = host;
  try {
    const busy = async () => ((await computeQueue(request, { base })) || {}).busy || null;
    const del = async (id) => {
      const r = await request.post(`${base}/api/project/delete`, { data: { project_id: id } });
      return { status: r.status(), error: (await r.json()).error || '' };
    };
    // 2. The run is followed first; C is named too: it cannot be deleted under its case.
    const firstDel = await del(C);
    expect(firstDel.status, JSON.stringify(firstDel)).toBe(409);
    expect([`The app is checking this project for jobs left running. Try again in a few seconds.`, LEFT_RUNNING]).toContain(firstDel.error);
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 30_000, intervals: [500] }).toBe(`solve/draining/${RUN2}`);
    expect(await del(C)).toEqual({ status: 409, error: LEFT_RUNNING });
    expect(((await getJson(request, `${base}/api/projects`)).projects || []).some((p) => p.id === C)).toBe(true);
    stage('the run is followed first; C cannot be deleted under its plugin case');

    // 3. Stop the run: once its WSL processes are gone, the claim is the plugin case's.
    const stop = await request.post(`${base}/api/run/stop`, { data: { project_id: A, run_id: RUN2 } });
    expect((await stop.json()).stopping).toBe(true);
    await expect.poll(() => wslProcessesUnder(`${wslRoot}/${coreCase}`), { timeout: 15_000, intervals: [1_000] }).toEqual([]);
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.job_id}/${b.run_id}` : 'idle';
    }, { timeout: 30_000, intervals: [500] }).toBe(`foam/draining/${JOB}/null`);
    expect(wslProcessesUnder(`${wslRoot}/${foamCase}`).length, 'the case still runs in WSL').toBeGreaterThan(0);
    await page.goto(`${base}/#/p/${C}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, C, { timeout: 90_000 });
    await expect.poll(() => page.locator('#btn-queue').getAttribute('title'), { timeout: 30_000 }).toContain(`Running: ${CASE_NAME} (finishing)`);
    expect(await page.evaluate(() => window.__CFD_JOB_QUEUE__ && window.__CFD_JOB_QUEUE__.busy && window.__CFD_JOB_QUEUE__.busy.kind)).toBe('foam');
    expect((await del(C)).status).toBe(409);
    expect((await del(A)).status, 'A has no job left: it can go').toBe(200);
    stage('the run stopped; the Queue names the plugin case (finishing); C still cannot be deleted, A can');

    // 4. Stop the plugin case: its WSL processes end, it ends stopped, the slot is free.
    await page.goto('about:blank');
    const stopCase = await request.post(`${base}/api/plugin-cases/stop`, { data: { project_id: C, plugin: 'foam-demo', study_id: SID, job_id: JOB } });
    expect(stopCase.status(), await stopCase.text()).toBe(200);
    await expect.poll(() => wslProcessesUnder(`${wslRoot}/${foamCase}`), { timeout: 60_000, intervals: [2_000] }).toEqual([]);
    await expect.poll(busy, { timeout: 30_000 }).toBeNull();
    expect(foamRecords(projects).find((r) => r.id === JOB)?.status).toBe('stopped');
    stage('the plugin case stopped in WSL; the slot is free');
  } finally {
    writeFileSync(test.info().outputPath('host.log'), host.log());
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-boot2] WSL root not removed: ${e.message}`);
    }
  }
});
