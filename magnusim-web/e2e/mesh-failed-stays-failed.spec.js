// A mesh whose generate failed stays failed when the mesh is read again (validation round G5,
// review): every mesher copies its polyMesh back whatever its exit, and the next GET /api/mesh
// (recoverStudyMeshesFromDisk, run on every read) found a whole polyMesh in the case folder and
// recorded the failed generate as done: "Recovered generated mesh from case (N cells)", with no
// quality and no log. Seen on Hex-dominant's "zero explicit feature refinement" (exit 44), and
// it would follow a One cell across (2D) mesh whose createPatch failed after extrudeMesh.
// Its own server with the fake mesher (MAGNUSIM_TEST_COMPUTE=fake,
// MAGNUSIM_TEST_MESH_RESULT=fail-with-mesh: it writes its mesh, then ends failed, exit 44):
// the Mesh panel and the tree say Mesh failed with the reason, and so do they after a reload
// and a later read of the mesh; the mesh is never "Mesh ready".
// Fails on the code before: the first read of the mesh recorded it done ("Recovered generated
// mesh from case (1 cells)"). And with that fixed, the tree still showed the failed mesh ready,
// and the panel after a reload "Generate failed. Open Job / debug for the log.", without its
// reason: both took a record with a case folder and cells for a mesh whatever its status.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

const PID = 'mesh-failed-stays-e2e';
const REASON = 'Fake mesher failed after writing its mesh';
let host;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const tmp = e2eTemp('mesh-failed-stays');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Mesh failed stays');
  host = await startHost({
    name: 'mesh-failed-stays',
    tmp,
    projects,
    env: { MAGNUSIM_TEST_COMPUTE: 'fake', MAGNUSIM_TEST_MESH_SECONDS: '1', MAGNUSIM_TEST_MESH_RESULT: 'fail-with-mesh' },
  });
});

test.afterAll(() => {
  host?.stop();
});

const api = (path) => `${host.base}${path}`;

async function meshRow(request, meshId) {
  const doc = await (await request.get(api(`/api/mesh?project_id=${PID}${meshId ? `&mesh_id=${meshId}` : ''}`))).json();
  return doc.mesh;
}

async function openMeshPanel(page, meshId) {
  await page.goto(api(`/#/p/${PID}`));
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
  return form;
}

/** What the page shows for the failed mesh: the panel's end and reason, the tree's row. */
async function expectFailed(page, form, meshId) {
  const status = form.locator('.mesh-finished');
  await expect(status).toHaveAttribute('data-mesh-status', 'failed', { timeout: 30_000 });
  await expect(status.locator('.mat-k')).toHaveText('Mesh failed');
  await expect(status.locator('.mesh-finished-line')).toHaveText(REASON);
  await expect(form.locator('[data-mesh-status="ready"]')).toHaveCount(0);
  const row = page.locator(`#left-tree li[data-w20-mesh-item="${meshId}"] > .tree-row`);
  await expect(row.locator('[data-mesh-failed="1"]')).toHaveText('Failed', { timeout: 30_000 });
}

test('a generate that failed after writing its mesh says Mesh failed, after a reload and a later read too', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const meshId = String((await meshRow(request, '')).id);
  let form = await openMeshPanel(page, meshId);
  await form.locator('[data-mesh-generate="1"]').click();
  await expectFailed(page, form, meshId);
  const live = (await meshRow(request, meshId)).live_mesh_result || {};
  expect([live.status, live.exit_code, live.error]).toEqual(['failed', 44, REASON]);

  // Read again (each GET /api/mesh looks for a mesh on disk): still the generate's own end.
  for (let i = 0; i < 2; i++) {
    const again = (await meshRow(request, meshId)).live_mesh_result || {};
    expect([again.status, again.error, again.note]).toEqual(['failed', REASON, live.note]);
  }
  form = await openMeshPanel(page, meshId);
  const after = await meshRow(request, meshId);
  expect([after.live_mesh_result?.status, after.live_mesh_result?.error, after.generated ?? false]).toEqual(['failed', REASON, false]);
  await expectFailed(page, form, meshId);
});
