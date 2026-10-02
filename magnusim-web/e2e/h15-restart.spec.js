import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_GEOMETRY_PROJECT, QUEUE_PROJECT_B, prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, killTree, startHost } from './support/host-server.mjs';
import {
  computeQueue,
  createRun,
  foamRecords,
  foamRelayAlive,
  getJson,
  killFoamRelays,
  meshRow,
  openRunPanel,
  plantCaseHolder,
  removeTestWslRoot,
  startMesh,
  wslProcessesUnder,
} from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// H15, plugin cases across app restarts (gate:h15-restart). The relay is not in the app's
// process tree, so ending the app (taskkill /T, as stop.bat does) leaves the case running in
// WSL. The next server checks for jobs left running before it starts anything, adopts the
// case (the slot stays held, nothing else starts) and finishes it with all its frames. A
// Stop sent just before the restart is kept: the case ends stopped. A case whose relay dies
// while its WSL processes live on is followed until they are gone ("finishing"), and its Stop
// ends them. Every server shares one temp folder, projects root, plugins folder and WSL root.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const P = NO_GEOMETRY_PROJECT;
const KEY = 'foam-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:h15-restart: plugin cases outlive the app and are found again', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-restart +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('h15-restart');
  const projects = join(tmp, 'projects');
  const pluginsDir = join(tmp, 'plugins');
  prepareE2eProjectsRoot(projects);
  mkdirSync(pluginsDir, { recursive: true });
  const wslRoot = `/tmp/magnusim-e2e-h15-restart-${process.pid}/cases`;
  const env = { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot };
  const boot = (first) =>
    startHost({ name: 'h15-restart', tmp, projects, pluginsDir, seed: false, env, log: stage, ...(first ? { pluginsFrom: 'python/tests/fixtures/foam-plugins' } : {}) });
  let host = await boot(true);
  try {
    const base = () => host.base;
    const queue = async () => (await computeQueue(request, { base: base() })) || { items: [], busy: null };
    const busy = async () => (await queue()).busy || null;
    const post = async (url, data) => {
      const r = await request.post(`${base()}${url}`, { data, timeout: 90_000 });
      return { status: r.status(), body: await r.json().catch(() => ({})) };
    };
    const restart = async (why) => {
      killTree(host.pid);
      stage(`server ended (${why})`);
      host = await boot(false);
      stage(`server up again at ${host.base}`);
    };

    // A core run with a ready mesh in another project (a quick mesh), for "Add to queue".
    const meshed = await startMesh(request, QUEUE_PROJECT_B, { base: base(), fineness: 1, quick: true });
    expect(meshed.status, JSON.stringify(meshed.body)).toBeLessThan(300);
    await expect
      .poll(async () => ((await meshRow(request, QUEUE_PROJECT_B, { base: base() })).live_mesh_result || {}).status || 'wait', {
        timeout: 900_000,
        intervals: [3_000],
      })
      .toBe('done');
    await expect.poll(busy, { timeout: 60_000 }).toBeNull();
    const draft = await createRun(request, { base: base(), projectId: QUEUE_PROJECT_B, name: 'Waits for the case' });
    stage('a quick mesh in queue project B and a draft run');

    const sid = (await post('/api/plugin-studies/create', { project_id: P, plugin: KEY, kind: 'cavity_case', title: 'Restart case' })).body.study.id;
    const caseDir = (rel) => join(projects, P, 'plugins', KEY, 'studies', sid, ...rel.split('/'));
    const savedFrames = (rel) =>
      existsSync(caseDir(rel)) ? readdirSync(caseDir(rel)).filter((n) => /^[0-9.]+$/.test(n) && Number(n) > 0 && existsSync(join(caseDir(rel), n, 'U'))) : [];
    const submitCase = async (rel, end, write) => {
      const w = await post(`/api/plugin/${KEY}/write_cavity`, { project_id: P, case: rel, study_id: sid, end_time: end, write_interval: write });
      expect(w.status, JSON.stringify(w.body)).toBe(200);
      const s = await post(`/api/plugin-cases/submit?project_id=${P}`, {
        project_id: P,
        plugin: KEY,
        study_id: sid,
        case_rel: rel,
        app: 'pimpleFoam',
        pre: [{ tool: 'blockMesh' }],
        results: { rho: 1, kinematicFields: ['p'] },
      });
      expect(s.status, JSON.stringify(s.body)).toBe(202);
      return s.body.job.id;
    };
    const job = async (id) =>
      (await getJson(request, `${base()}/api/plugin-cases/status?project_id=${P}&plugin=${KEY}&study_id=${sid}&job_id=${id}`)).job || {};
    const solving = async (id, rel, timeout = 600_000) => {
      await expect
        .poll(
          async () => {
            const j = await job(id);
            if (/done|failed|stopped|lost/.test(j.status || '')) return `ended ${j.status}: ${j.error}`;
            return j.stage === 'solve' && savedFrames(rel).length >= 1 ? 'solving' : `${j.status}/${j.stage}`;
          },
          { timeout, intervals: [2_000] },
        )
        .toBe('solving');
    };
    const queueTitle = () => page.locator('#btn-queue').getAttribute('title');

    // 1. A long case A (about 90 s; the cavity solves about 10 s of its time a second), solving with a saved frame.
    const A = await submitCase('cases/a', 900, 60);
    await solving(A, 'cases/a');
    const framesBefore = savedFrames('cases/a').length;
    stage(`case A ${A} solves (${framesBefore} frames)`);

    // 2-3. End the app (its process tree) and start it again: A is found and keeps the slot.
    await restart('A runs');
    const firstBusy = await busy();
    expect(['check', 'foam'], JSON.stringify(firstBusy)).toContain(firstBusy?.kind);
    await expect.poll(async () => (await busy())?.kind || 'idle', { timeout: 30_000 }).toBe('foam');
    expect((await busy()).job_id).toBe(A);
    const runPanel = await openRunPanel(page, { base: base(), projectId: QUEUE_PROJECT_B, runId: draft });
    await expect(runPanel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    const listed = (await getJson(request, `${base()}/api/plugin-cases?project_id=${P}&plugin=${KEY}&study_id=${sid}`)).jobs || [];
    expect(listed.find((j) => j.id === A)?.status).toBe('running');
    await expect.poll(() => savedFrames('cases/a').length, { timeout: 120_000, intervals: [2_000] }).toBeGreaterThan(framesBefore);
    stage(`after the restart: A adopted (first answer ${firstBusy?.kind}), Start reads Add to queue, frames grow`);

    // 4. A ends done with all its frames, and the slot frees.
    await expect.poll(async () => (await job(A)).status, { timeout: 900_000, intervals: [3_000] }).toBe('done');
    const doneA = await job(A);
    expect(doneA.result.savedTimes.length).toBe(15);
    expect(Number(doneA.result.lastSaved)).toBe(900);
    await expect.poll(busy, { timeout: 120_000 }).toBeNull();
    stage('A done with all 15 frames; the slot is free');

    // 5. A Stop sent right before the app ends is kept: B ends stopped.
    const B = await submitCase('cases/b', 5000, 50);
    await solving(B, 'cases/b');
    const stopB = await post(`/api/plugin-cases/stop?project_id=${P}`, { project_id: P, plugin: KEY, study_id: sid, job_id: B });
    expect(stopB.status, JSON.stringify(stopB.body)).toBe(200);
    expect(stopB.body.job.stopping).toBe(true);
    await expect.poll(async () => (await job(B)).stage, { timeout: 10_000, intervals: [200] }).toBe('stopping');
    await restart('B stopping');
    await expect.poll(async () => (await job(B)).status, { timeout: 90_000, intervals: [2_000] }).toBe('stopped');
    const endB = await job(B);
    expect(Number(endB.result.lastSaved)).toBeLessThan(5000);
    stage(`B stopped across the restart (last saved ${endB.result.lastSaved})`);

    // 6. A relay that dies while its WSL processes live on: followed until they are gone.
    await expect.poll(busy, { timeout: 120_000 }).toBeNull();
    const C = await submitCase('cases/c', 5000, 50);
    await solving(C, 'cases/c');
    const D = await submitCase('cases/d', 0.5, 0.1);
    const recC = foamRecords(projects).find((r) => r.id === C);
    expect(recC && recC.wsl_case).toMatch(/^cfddesk-pf-/);
    plantCaseHolder(wslRoot, recC.wsl_case);
    const ctl = killFoamRelays(projects).filter((l) => l.startsWith(C));
    stage(`C's relay ended: ${ctl.join(' ')}`);
    expect(foamRelayAlive(C).alive).toBe(false);
    await page.goto(`${base()}/#/p/${P}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, P, { timeout: 90_000 });
    await expect
      .poll(async () => {
        const b = await busy();
        return b ? `${b.kind}/${b.phase}/${b.job_id === C}` : 'idle';
      }, { timeout: 20_000, intervals: [500] })
      .toBe('foam/draining/true');
    await expect.poll(queueTitle, { timeout: 30_000 }).toMatch(/\(finishing\)/);
    for (let i = 0; i < 10; i++) {
      const b = await busy();
      expect(b && b.job_id, `the slot is held while C's WSL processes live, check ${i}`).toBe(C);
      await sleep(1_000);
    }
    const stopC = await post(`/api/plugin-cases/stop?project_id=${P}`, { project_id: P, plugin: KEY, study_id: sid, job_id: C });
    expect(stopC.status, JSON.stringify(stopC.body)).toBe(200);
    await expect.poll(() => wslProcessesUnder(`${wslRoot}/${recC.wsl_case}`), { timeout: 40_000, intervals: [2_000] }).toEqual([]);
    await expect.poll(async () => (await job(C)).status, { timeout: 60_000, intervals: [2_000] }).toBe('stopped');
    await expect.poll(async () => (await busy())?.job_id || 'idle', { timeout: 60_000, intervals: [1_000] }).toBe(D);
    stage('C followed while its WSL processes lived; its Stop ended them; D started next');
    await expect.poll(async () => (await job(D)).status, { timeout: 600_000, intervals: [3_000] }).toBe('done');
  } finally {
    for (const line of killFoamRelays(projects)) stage(`relay kill ${line}`);
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-restart] WSL root not removed: ${e.message}`);
    }
  }
});
