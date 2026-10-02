import { expect, test } from '@playwright/test';
import { QUEUE_PROJECT_A, QUEUE_PROJECT_B } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';
import {
  clickGenerate,
  computeQueue,
  createRun,
  meshRow,
  openRunPanel,
  runRow,
  startMesh,
  stopMesh,
  waitSlotFree,
} from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// H15, one compute slot across kinds and projects (gate:h15-slot-one): while a mesh
// generates in one project, a run in another project cannot start beside it. Its Start
// reads "Add to queue" (also after a reload), the Queue button names what runs, and a Start
// sent straight to the server is refused with "Another job is already running" and leaves
// the run a draft. Queued, it can be taken off the queue again. A second app server.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const B = QUEUE_PROJECT_B;

test('gate:h15-slot-one: a run waits while another project meshes', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(2_400_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-slot +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const host = await startHost({ name: 'h15-slot', env: { MAGNUSIM_WSL_PRUNE: '0' }, log: stage });
  const { base } = host;
  try {
    const busy = async () => ((await computeQueue(request, { base })) || {}).busy || null;
    // B gets a quick mesh and a draft run first.
    const quick = await startMesh(request, B, { base, fineness: 1, quick: true });
    expect(quick.status, JSON.stringify(quick.body)).toBeLessThan(300);
    await expect
      .poll(async () => ((await meshRow(request, B, { base })).live_mesh_result || {}).status || 'wait', { timeout: 900_000, intervals: [3_000] })
      .toBe('done');
    await waitSlotFree(request, { base });
    const run = await createRun(request, { base, projectId: B, name: 'Waits for A' });
    stage(`B meshed; draft run ${run}`);

    // 1. A fine mesh in A (as compute-queue.spec.js), running.
    const label = await clickGenerate(page, A, { base, fineness: 7, quick: false });
    expect(label).toBe('Generate');
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.project_id}` : 'idle';
    }, { timeout: 60_000 }).toBe(`mesh/running/${A}`);
    stage('A meshes');

    // 2. B's run: Start reads "Add to queue", and the Queue button says what runs.
    let panel = await openRunPanel(page, { base, projectId: B, runId: run });
    const start = panel.locator('[data-run-start]');
    await expect(start).toHaveText('Add to queue', { timeout: 30_000 });
    await expect.poll(() => page.locator('#btn-queue').getAttribute('title'), { timeout: 30_000 }).toBe('Running: Mesh 1 in Queue project A.');

    // 3. A Start sent straight to the server is refused; the run stays a draft.
    const direct = await request.post(`${base}/api/run/start`, { data: { project_id: B, simulation_id: 'sim_1', run_id: run } });
    const body = await direct.json();
    expect([direct.status(), body.error, body.code]).toEqual([409, 'Another job is already running', 'busy']);
    const q = await computeQueue(request, { base });
    expect(q.busy).toMatchObject({ kind: 'mesh', project_id: A });
    expect(((await runRow(request, { base, projectId: B, runId: run })).status || 'draft')).not.toMatch(/running|failed/);
    stage('a direct Start is refused while A meshes');

    // 4. After a reload, still "Add to queue".
    panel = await openRunPanel(page, { base, projectId: B, runId: run });
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    expect((await busy())?.kind, 'A must still mesh for this step to mean anything').toBe('mesh');

    // 5. Queue it, take it off again; stop A's mesh; the slot frees.
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });
    await expect.poll(async () => ((await computeQueue(request, { base })).items || []).map((r) => r.run_id)).toEqual([run]);
    await page.waitForTimeout(1_000);
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 15_000 });
    await expect.poll(async () => ((await computeQueue(request, { base })).items || []).length).toBe(0);
    expect(await stopMesh(request, A, { base })).not.toEqual([]);
    await waitSlotFree(request, { base, timeoutMs: 120_000 });
    expect(((await runRow(request, { base, projectId: B, runId: run })).status || 'draft')).not.toMatch(/running|failed/);
    stage('queued and removed; A stopped; the slot is free');
  } finally {
    host.stop();
  }
});
