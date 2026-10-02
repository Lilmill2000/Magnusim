import { expect, test } from '@playwright/test';
import { QUEUE_PROJECT_A, QUEUE_PROJECT_B } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';
import { clickGenerate, computeQueue, getJson, startMesh, stopMesh, waitSlotFree } from './support/compute-slot.js';
import { NO_WSL } from './toolchain.js';

// H15, project and folder delete beside the compute slot (gate:h15-project-delete-queue):
// a project whose mesh generates cannot be deleted (Home says why, by folder name in any
// spelling), nor the folder that holds it; deleting a project with a queued job drops that
// job from the queue, also after a reload. A second app server.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const B = QUEUE_PROJECT_B;
const FOLDER = 'H15 busy';

test('gate:h15-project-delete-queue: a busy project stays, a deleted one leaves the queue', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(2_400_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-delete +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const host = await startHost({ name: 'h15-delete', env: { MAGNUSIM_WSL_PRUNE: '0' }, log: stage });
  const { base } = host;
  try {
    const queue = async () => (await computeQueue(request, { base })) || { items: [], busy: null };
    const projectIds = async () => ((await getJson(request, `${base}/api/projects`)).projects || []).map((p) => p.id);

    // 1. A meshes (fine); B's mesh is queued behind it from its form.
    const gen = await startMesh(request, A, { base, fineness: 7 });
    expect(gen.status, JSON.stringify(gen.body)).toBeLessThan(300);
    await expect.poll(async () => (await queue()).busy?.project_id || 'idle', { timeout: 60_000 }).toBe(A);
    const label = await clickGenerate(page, B, { base, fineness: 1, quick: true, want: 'Add to queue' });
    expect(label).toBe('Add to queue');
    await expect.poll(async () => (await queue()).items.map((r) => [r.kind, r.project_id]), { timeout: 15_000 }).toEqual([['mesh', B]]);
    stage('A meshes; B queued');

    // 2. Home: A cannot be deleted while it meshes; in upper case neither.
    const home = async () => {
      await page.goto(`${base}/#/`);
      await page.locator('.home-card').first().waitFor({ state: 'visible', timeout: 60_000 });
    };
    // Home's two confirmations: the second step says it cannot be undone.
    const deleteFromHome = async () => {
      await page.locator('#home-delete-project').click();
      await expect(page.locator('#modal-delete-project')).toBeVisible();
      await page.locator('#dp-confirm').click();
      await expect(page.locator('#dp-copy')).toContainText('cannot be undone');
      await page.locator('#dp-confirm').click();
    };
    await home();
    await page.locator(`.home-card[data-project-id="${A}"]`).click();
    await deleteFromHome();
    // The answer can take seconds while Home renders its thumbnails.
    await expect(page.locator('#dp-copy')).toHaveText('A mesh in this project is generating. Stop it before deleting the project.', {
      timeout: 30_000,
    });
    await page.locator('#dp-cancel').click();
    expect(await projectIds()).toContain(A);
    const upper = await request.post(`${base}/api/project/delete`, { data: { project_id: A.toUpperCase() } });
    expect(upper.status()).toBe(409);
    expect((await upper.json()).error).toBe('A mesh in this project is generating. Stop it before deleting the project.');
    expect(await projectIds()).toContain(A);
    stage('A cannot be deleted while it meshes, by any spelling');

    // 3. Nor the folder that holds it.
    const made = await request.post(`${base}/api/folders`, { data: { name: FOLDER } });
    expect(made.ok(), await made.text()).toBe(true);
    const moved = await request.post(`${base}/api/project/move`, { data: { project_id: A, folder: FOLDER } });
    expect(moved.ok(), await moved.text()).toBe(true);
    await home();
    await page.locator(`.home-nav-child[data-filter="folder:${FOLDER}"]`).click();
    await expect(page.locator('#home-delete-project')).toHaveAttribute('aria-label', 'Delete folder');
    await deleteFromHome();
    await expect(page.locator('#dp-copy')).toHaveText('A job in Queue project A is running. Stop it before deleting the folder.', { timeout: 30_000 });
    await page.locator('#dp-cancel').click();
    expect(await projectIds()).toContain(A);
    expect(JSON.stringify((await getJson(request, `${base}/api/folders`)).folders)).toContain(FOLDER);
    expect((await queue()).busy?.project_id, 'A must still mesh for this step to mean anything').toBe(A);
    stage('the folder holding A cannot be deleted');

    // 4. B is deleted from Home: its queued mesh leaves the queue (and stays gone after a reload).
    // The Queue menu counts the open project's rows: B's shows 1 before.
    await page.goto(`${base}/#/p/${B}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, B, { timeout: 90_000 });
    await expect(page.locator('#queue-count')).toHaveText('1', { timeout: 30_000 });
    await home();
    await page.locator(`.home-card[data-project-id="${B}"]`).click();
    await deleteFromHome();
    await expect.poll(projectIds, { timeout: 30_000 }).not.toContain(B);
    expect((await queue()).items).toEqual([]);
    const queueMenuEmpty = async () => {
      await page.goto(`${base}/#/p/${A}`);
      await page.reload();
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, A, { timeout: 90_000 });
      await page.locator('#btn-queue').click();
      await expect(page.locator('#job-queue-now')).toHaveText('Running: Mesh 1', { timeout: 30_000 });
      await expect(page.locator('#job-queue-list li')).toHaveCount(0);
      await expect(page.locator('#queue-count')).toBeHidden();
      await page.keyboard.press('Escape');
    };
    await queueMenuEmpty();
    expect((await queue()).items).toEqual([]);
    stage('B deleted: its queued mesh is gone, also after a reload');

    // 5. Stop A's mesh.
    expect(await stopMesh(request, A, { base })).not.toEqual([]);
    await waitSlotFree(request, { base, timeoutMs: 120_000 });
    stage("A's mesh stopped; the slot is free");
  } finally {
    host.stop();
  }
});
