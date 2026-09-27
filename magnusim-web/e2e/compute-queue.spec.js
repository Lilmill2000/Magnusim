import { test, expect } from '@playwright/test';
import { NO_WSL } from './toolchain.js';

const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
// Its own projects (prepare-projects.js): meshing the shared sample would change what later specs read.
const A = 'queue-project-a-e2e';
const B = 'queue-project-b-e2e';

/** Server queue as project `id` sees it: its rows, and whatever job holds the slot (any project). */
async function queueFor(request, id) {
  const r = await request.get(`/api/compute-queue?project_id=${encodeURIComponent(id)}`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function busyProject(request) {
  const q = await queueFor(request, A);
  return (q.busy && q.busy.project_id) || 'idle';
}

/** Open the project (hash route, so a same-tab project switch) and its Mesh 1 settings form. */
async function openMeshForm(page, projectId) {
  await page.goto(`/#/p/${encodeURIComponent(projectId)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText(/Mesh/i, { timeout: 30_000 });
  const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
  if (!(await meshRow.isVisible().catch(() => false))) {
    await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first().click();
  }
  await meshRow.click();
  const settingsBtn = page.locator('#mesh-inspect-settings');
  if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) await settingsBtn.click();
  await expect(page.locator('#panel-mesh-form')).toBeVisible({ timeout: 30_000 });
  return page.locator('#panel-mesh-form [data-mesh-generate="1"]');
}

test.describe('compute queue across projects', () => {
  test('a mesh started while another project meshes is queued, survives switch and reload, then runs', async ({
    page,
    request,
  }) => {
    test.skip(!WSL, NO_WSL);

    // A: a fine mesh so it is still running while B is queued behind it.
    let gen = await openMeshForm(page, A);
    await page.locator('#panel-mesh-form .cfd-island [data-schema-key="fineness"] input').fill('7');
    await expect(gen).toHaveText(/^Generate$/);
    await gen.click();
    await expect(page.locator('#panel-mesh-form [data-mesh-status]')).toHaveAttribute('data-mesh-status', 'generating', {
      timeout: 30_000,
    });
    await expect.poll(() => busyProject(request), { timeout: 30_000 }).toBe(A);

    // B, same tab: the server is busy with A, so Generate becomes "Add to queue", and the
    // panel never shows A's progress as B's own (both meshes are mesh_1).
    gen = await openMeshForm(page, B);
    await expect(gen).toHaveText('Add to queue', { timeout: 15_000 });
    await expect(page.locator('#panel-mesh-form [data-mesh-status="generating"]')).toHaveCount(0);
    expect(await busyProject(request), 'A must still be meshing for this test to mean anything').toBe(A);
    await gen.click();

    const status = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(status).toHaveAttribute('data-mesh-status', 'queued', { timeout: 15_000 });
    await expect(status).toContainText('Waiting for Mesh 1 in Queue project A to finish.');
    await expect(gen).toHaveText('Remove from queue');
    await expect(gen).toBeEnabled();
    let q = await queueFor(request, B);
    expect(q.items.map((r) => [r.project_id, r.mesh_id])).toEqual([[B, 'mesh_1']]);

    // Cancel, then queue again.
    await gen.click();
    await expect(gen).toHaveText('Add to queue', { timeout: 10_000 });
    await expect.poll(async () => (await queueFor(request, B)).items.length).toBe(0);
    await gen.click();
    await expect(status).toHaveAttribute('data-mesh-status', 'queued', { timeout: 15_000 });

    // Reload: the queue lives on the server, not in the tab.
    await page.reload();
    gen = await openMeshForm(page, B);
    await expect(page.locator('#panel-mesh-form [data-mesh-status]')).toHaveAttribute('data-mesh-status', 'queued', {
      timeout: 15_000,
    });
    await expect(gen).toHaveText('Remove from queue');

    // A second mesh in A queues behind B's. A's tree numbers it by its place in the
    // whole queue (2), not among A's own queued jobs (where it is the first).
    await openMeshForm(page, A);
    await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tl').first().click();
    await page.locator('#mesh-new-name').fill('Mesh 2');
    await page.locator('#btn-create-mesh').click();
    const meshesA = async () => (await (await request.get(`/api/mesh?project_id=${A}`)).json()).meshes || [];
    await expect.poll(async () => (await meshesA()).map((m) => m.name)).toContain('Mesh 2');
    const mesh2 = (await meshesA()).find((m) => m.name === 'Mesh 2').id;
    const gen2 = page.locator('#panel-mesh-form [data-mesh-generate="1"]');
    await expect(gen2).toHaveText('Add to queue', { timeout: 15_000 });
    expect(await busyProject(request), 'A must still be meshing for this step to mean anything').toBe(A);
    await gen2.click();
    await expect
      .poll(async () => (await queueFor(request, A)).items.map((r) => [r.mesh_id, r.position]))
      .toEqual([[mesh2, 2]]);
    await expect(page.locator(`#left-tree [data-w20-mesh-item="${mesh2}"] > .tree-row .tree-queue`)).toHaveText('2', {
      timeout: 15_000,
    });
    // A click right after "Add to queue" is ignored (700 ms, so a double-click does not undo it).
    await page.waitForTimeout(1_000);
    await gen2.click();
    await expect(gen2).toHaveText('Add to queue', { timeout: 10_000 });
    await expect.poll(async () => (await queueFor(request, A)).items.length).toBe(0);

    // Switch away to A. No tab is on B when A finishes; the server starts B by itself.
    await openMeshForm(page, A);
    await expect.poll(() => busyProject(request), { timeout: 850_000, intervals: [2_000] }).toBe(B);
    // /api/case follows the active case (now B's), so read A's result from its mesh record.
    const meshA = await (await request.get(`/api/mesh?project_id=${A}`)).json();
    expect(meshA.mesh.live_mesh_result.status).toBe('done');
    expect(meshA.mesh.live_mesh_result.n_cells).toBeGreaterThan(0);
    q = await queueFor(request, B);
    expect(q.items).toEqual([]);

    // Back on B: the panel follows the job the server started, then shows the result.
    await openMeshForm(page, B);
    const statusB = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(statusB).toHaveAttribute('data-mesh-status', /generating|finishing|ready/, { timeout: 30_000 });
    await expect.poll(() => busyProject(request), { timeout: 850_000, intervals: [2_000] }).toBe('idle');
    const caseB = await (await request.get(`/api/case?project_id=${B}`)).json();
    expect(caseB.status).toBe('done');
    expect(caseB.n_cells).toBeGreaterThan(0);
    await expect(statusB).toHaveAttribute('data-mesh-status', 'ready', { timeout: 60_000 });

    // Nothing left to run B a second time.
    await page.waitForTimeout(3_000);
    q = await queueFor(request, B);
    expect(q.items).toEqual([]);
    expect(q.busy).toBeNull();
  });
});
