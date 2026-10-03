import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_PROJECT_A, prepareE2eProjectsRoot } from './prepare-projects.js';
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
  postJson,
  removeTestWslRoot,
  runRow,
  startMesh,
  waitSlotFree,
  wslProcessesUnder,
} from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// IF Item 7, core solves across app restarts (gate:core-solve-restart). A core solve runs on
// the step-list runner: its relay is not in the app's process tree, so ending the app
// (taskkill /T, as stop.bat does) leaves the run solving in WSL. The next server checks for
// jobs left running before it starts anything and follows the run again: it stays running,
// the slot is held by it as a run (never "a plugin case"), and its stage, time and saved
// frames keep updating; its Stop ends it stopped with its frames and frees the slot. A run
// that ended while no server ran is shown ended after the restart, also when its run doc
// still said running (the server stopped between the runner's end and the doc's).
// Every server shares one temp folder, projects root and WSL root. The study's residual
// targets are set out of reach so the steady run never ends on its own.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const SIM = 'sim_1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:core-solve-restart: a core solve outlives the app and is followed again', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[core-restart +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('core-restart');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  neverConverge(projects, A);
  const wslRoot = `/tmp/magnusim-e2e-core-restart-${process.pid}/cases`;
  const env = { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot };
  const boot = () => startHost({ name: 'core-restart', tmp, projects, seed: false, env, log: stage });
  let host = await boot();
  try {
    const base = () => host.base;
    const queue = async () => (await computeQueue(request, { base: base() })) || { items: [], busy: null };
    const busy = async () => (await queue()).busy || null;
    const row = (runId) => runRow(request, { base: base(), projectId: A, runId });
    /** The run as the Run panel reads it (/api/run/status's `run`: live stage, time and residuals). */
    const runDoc = async (runId) =>
      (await getJson(request, `${base()}/api/run/status?project_id=${A}&simulation_id=${SIM}&run_id=${encodeURIComponent(runId)}`)).run || {};
    const restart = async (why) => {
      killTree(host.pid);
      stage(`server ended (${why})`);
      host = await boot();
      stage(`server up again at ${host.base}`);
    };
    const newRun = async (name, endTime, writeInterval) => {
      const rid = await createRun(request, { base: base(), projectId: A, name });
      const u = await postJson(request, `${base()}/api/run/update`, { project_id: A, simulation_id: SIM, run_id: rid, endTime, writeInterval });
      expect(u.ok(), await u.text()).toBe(true);
      return rid;
    };
    const start = async (rid) => {
      const r = await postJson(request, `${base()}/api/run/start`, { project_id: A, simulation_id: SIM, run_id: rid }, { timeout: 120_000 });
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(202);
      expect(body.runner_job_id, 'the run is on the runner').toMatch(/^fc-/);
      return body.runner_job_id;
    };
    const record = (job) => foamRecords(projects).find((r) => r.id === job) || {};
    const caseCopy = (rid) => `${wslRoot}/cfddesk-w27-${rid}`;

    // A quick mesh in A, and a draft run that waits.
    const meshed = await startMesh(request, A, { base: base(), fineness: 1, quick: true });
    expect(meshed.status, JSON.stringify(meshed.body)).toBeLessThan(300);
    await expect
      .poll(async () => ((await meshRow(request, A, { base: base() })).live_mesh_result || {}).status || 'wait', { timeout: 900_000, intervals: [3_000] })
      .toBe('done');
    await waitSlotFree(request, { base: base() });
    const waiting = await createRun(request, { base: base(), projectId: A, name: 'Waits for R' });
    stage('A meshed; a draft run waits');

    // 1. A long steady run R, solving with a saved frame.
    const R = await newRun('Restart R', 100000, 100);
    const job = await start(R);
    expect(record(job)).toMatchObject({ kind: 'solve', run_id: R, wsl_case: `cfddesk-w27-${R}` });
    await expect
      .poll(
        async () => {
          const r = await row(R);
          if (/done|failed|stopped/.test(r.status || '')) return `ended ${r.status}: ${r.error || r.note || ''}`;
          return r.stage === 'solve' && Number(r.last_saved_iteration) > 0 ? 'solving' : `${r.status}/${r.stage}/${r.last_saved_iteration}`;
        },
        { timeout: 600_000, intervals: [2_000] },
      )
      .toBe('solving');
    const before = { iteration: Number((await runDoc(R)).iteration) || 0, saved: Number((await row(R)).last_saved_iteration) || 0 };
    expect(before.iteration).toBeGreaterThan(0);
    stage(`R ${R} (job ${job}) solves: iteration ${before.iteration}, saved up to ${before.saved}`);

    // 2. End the app (its process tree): the run keeps solving in WSL.
    await restart('R solves');
    expect(foamRelayAlive(job).alive, "R's relay outlived the app").toBe(true);
    const firstBusy = await busy();
    expect(['check', 'solve'], JSON.stringify(firstBusy)).toContain(firstBusy?.kind);

    // 3. The run is followed again: running, the slot held by it as a run.
    await expect
      .poll(async () => {
        const b = await busy();
        return b ? `${b.kind}/${b.phase}/${b.run_id}/${b.job_id}/${b.name}` : 'idle';
      }, { timeout: 60_000, intervals: [500] })
      .toBe(`solve/running/${R}/${job}/Restart R`);
    expect((await row(R)).status).toBe('running');
    const panelWaiting = await openRunPanel(page, { base: base(), projectId: A, runId: waiting });
    await expect(panelWaiting.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await expect.poll(() => page.locator('#btn-queue').getAttribute('title'), { timeout: 30_000 }).toBe('Running: Restart R.');
    const panel = await openRunPanel(page, { base: base(), projectId: A, runId: R });
    await expect(panel.locator('[data-run-stop="1"]')).toBeVisible({ timeout: 30_000 });
    stage(`after the restart: R followed (first answer ${firstBusy?.kind}); Queue "Running: Restart R."; the draft reads Add to queue`);

    // 4. Its stage, time and saved frames keep updating.
    await expect
      .poll(
        async () => {
          const d = await runDoc(R);
          const r = await row(R);
          return d.status === 'running' && d.stage === 'solve' && Number(d.iteration) > before.iteration && Number(r.last_saved_iteration) > before.saved;
        },
        { timeout: 300_000, intervals: [2_000] },
      )
      .toBe(true);
    const after = { iteration: Number((await runDoc(R)).iteration) || 0, saved: Number((await row(R)).last_saved_iteration) || 0 };
    await expect.poll(async () => Number((await runDoc(R)).iteration) || 0, { timeout: 120_000, intervals: [2_000] }).toBeGreaterThan(after.iteration);
    stage(`R keeps updating: iteration ${before.iteration} -> ${after.iteration}+, saved up to ${before.saved} -> ${after.saved}`);

    // 5. Stop (graceful): it ends stopped with its frames, and the slot frees.
    await panel.locator('[data-run-stop="1"]').click();
    await expect.poll(async () => (await row(R)).status, { timeout: 180_000, intervals: [2_000] }).toBe('stopped');
    const stopped = await runDoc(R);
    expect(stopped.has_results).toBe(true);
    expect(Number(stopped.last_saved_iteration)).toBeGreaterThanOrEqual(after.saved);
    expect(stopped.note).toBe(`Run stopped. Results up to iteration ${stopped.last_saved_iteration} are available.`);
    expect(record(job).status).toBe('stopped');
    await waitSlotFree(request, { base: base(), timeoutMs: 180_000 });
    await expect.poll(() => wslProcessesUnder(caseCopy(R)), { timeout: 60_000, intervals: [2_000] }).toEqual([]);
    stage(`R stopped with results up to iteration ${stopped.last_saved_iteration}; the slot is free`);

    // 6. A short run that ends while no server runs: shown ended after the restart.
    const R2 = await newRun('Ends while down', 500, 250);
    const job2 = await start(R2);
    await expect.poll(() => foamRelayAlive(job2).alive, { timeout: 60_000, intervals: [500] }).toBe(true);
    killTree(host.pid);
    stage(`server ended while R2 ${R2} (job ${job2}) runs`);
    await expect.poll(() => foamRelayAlive(job2).alive, { timeout: 900_000, intervals: [3_000] }).toBe(false);
    expect(record(job2).status, 'no server finished the record').toBe('running');
    expect(readRunJson(projects, A, R2).status, 'the run doc still says running').toBe('running');
    host = await boot();
    stage(`R2's relay ended while the server was down; server up again at ${host.base}`);
    await expect.poll(async () => (await row(R2)).status, { timeout: 120_000, intervals: [1_000] }).toBe('done');
    const done2 = await runDoc(R2);
    expect(done2.note).toBe('simpleFoam finished. Results are in the run folder.');
    expect(done2.has_results).toBe(true);
    expect(record(job2).status).toBe('done');
    await waitSlotFree(request, { base: base(), timeoutMs: 120_000 });
    stage('R2 is shown done after the restart');

    // 7. A run doc that says running while its record has ended (the server stopped between
    //    the two writes): after the restart it shows the ended status.
    killTree(host.pid);
    writeRunJson(projects, A, R2, { status: 'running', stage: 'solve', finished_at: null, note: 'simpleFoam serial' });
    expect(readRunJson(projects, A, R2).status).toBe('running');
    host = await boot();
    stage('R2 doc set back to running while no server ran; server up again');
    expect(await busy(), 'nothing is followed: its record has ended').toBeNull();
    await expect.poll(async () => (await row(R2)).status, { timeout: 30_000, intervals: [500] }).toBe('done');
    expect((await runDoc(R2)).note).toBe('simpleFoam finished. Results are in the run folder.');
    await expect.poll(() => readRunJson(projects, A, R2).status, { timeout: 15_000, intervals: [500] }).toBe('done');
    stage('the doc that said running is written done from its record');
  } finally {
    for (const line of killFoamRelays(projects)) stage(`relay kill ${line}`);
    writeFileSync(test.info().outputPath('host.log'), host.log());
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[core-restart] WSL root not removed: ${e.message}`);
    }
  }
});

/** Residual targets no steady run reaches (the study's residual_u / residual_p). */
function neverConverge(projects, projectId) {
  const file = join(projects, projectId, 'simulations.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  for (const sim of doc.simulations || []) Object.assign(sim, { residual_u: 1e-12, residual_p: 1e-12 });
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

/** A run's folder on Windows (simulation_runs/<Run>, found by its id.json). */
function runFolder(projects, projectId, runId) {
  const geoms = join(projects, projectId, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const runs = join(sims, s, 'simulation_runs');
      if (!existsSync(runs)) continue;
      for (const r of readdirSync(runs)) {
        const idp = join(runs, r, 'id.json');
        if (existsSync(idp) && JSON.parse(readFileSync(idp, 'utf8')).id === runId) return join(runs, r);
      }
    }
  }
  throw new Error(`no run folder for ${runId}`);
}

function readRunJson(projects, projectId, runId) {
  return JSON.parse(readFileSync(join(runFolder(projects, projectId, runId), 'run.json'), 'utf8').replace(/^\uFEFF/, ''));
}

function writeRunJson(projects, projectId, runId, patch) {
  const file = join(runFolder(projects, projectId, runId), 'run.json');
  writeFileSync(file, JSON.stringify({ ...readRunJson(projects, projectId, runId), ...patch }, null, 2));
}
