import { expect, test } from '@playwright/test';
import { QUEUE_PROJECT_A } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';
import { computeQueue, createRun, meshRow, postJson, removeTestWslRoot, runRow, startMesh, waitSlotFree } from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// IF Item 7 (gate:core-start-free): a core Start no longer holds the server while its
// case is planned and written. Before, Start ran prepare_run (and a run-doc write through
// Python) inside the request, and every other request (the Queue's poll, the Run panel's,
// Home's) waited seconds for it. Now the analysis plans the run on the worker and the
// runner's relay writes the case: the compute queue answers within 1 s all the way from
// the Start to the solver's first step.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:core-start-free: the server answers while a core Start plans and writes its case', async ({ request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_800_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[core-start-free +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const wslRoot = `/tmp/magnusim-e2e-core-start-free-${process.pid}/cases`;
  const host = await startHost({ name: 'core-start-free', env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot }, log: stage });
  const { base } = host;
  try {
    const meshed = await startMesh(request, A, { base, fineness: 1, quick: true });
    expect(meshed.status, JSON.stringify(meshed.body)).toBeLessThan(300);
    await expect
      .poll(async () => ((await meshRow(request, A, { base })).live_mesh_result || {}).status || 'wait', { timeout: 900_000, intervals: [3_000] })
      .toBe('done');
    await waitSlotFree(request, { base });
    stage('A meshed');

    const rid = await createRun(request, { base, projectId: A, name: 'Start free' });
    const u = await postJson(request, `${base}/api/run/update`, { project_id: A, simulation_id: 'sim_1', run_id: rid, endTime: 100000, writeInterval: 100000 });
    expect(u.ok(), await u.text()).toBe(true);

    // The Queue's poll, every 100 ms, from just before the Start until the solver steps.
    const answers = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const at = Date.now();
        await computeQueue(request, { base });
        answers.push(Date.now() - at);
        await sleep(100);
      }
    })();
    await sleep(300);
    const started = await postJson(request, `${base}/api/run/start`, { project_id: A, simulation_id: 'sim_1', run_id: rid }, { timeout: 120_000 });
    expect(started.ok(), await started.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const r = await runRow(request, { base, projectId: A, runId: rid });
          if (/done|failed|stopped/.test(r.status || '')) return `ended ${r.status}: ${r.error || r.note || ''}`;
          return r.stage === 'solve' || Number(r.iteration || 0) > 0 ? 'solving' : `${r.status}/${r.stage}`;
        },
        { timeout: 600_000, intervals: [1_000] },
      )
      .toBe('solving');
    polling = false;
    await poller;
    const slowest = Math.max(...answers);
    stage(`${answers.length} queue polls from the Start to the first step, slowest ${slowest} ms`);
    expect(answers.length).toBeGreaterThan(5);
    expect(slowest, 'the compute queue answered within 1 s while the run was planned and written').toBeLessThan(1_000);

    await postJson(request, `${base}/api/run/stop`, { project_id: A, run_id: rid, force: true });
    await waitSlotFree(request, { base, timeoutMs: 180_000 });
  } finally {
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[core-start-free] WSL root not removed: ${e.message}`);
    }
  }
});
