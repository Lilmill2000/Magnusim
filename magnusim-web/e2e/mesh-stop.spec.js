// The mesh's Stop (Assistant phase 5 spec 8.4): nobody could stop a mesh before. While a
// mesh generates, the Mesh panel and the tree's mesh row have Stop. It asks first ("Stop
// meshing "Mesh 1"?", Stop / Keep meshing); Stop ends the generate (its process is gone),
// and the panel and the tree say Stopped, never Mesh ready or done. Nothing is deleted:
// the mesh, its name and settings stay, and after a reload it still says Stopped.
// Its own server with the fake mesher (MAGNUSIM_TEST_COMPUTE=fake: no WSL, no OpenFOAM;
// the generator is python/tools/fake_mesh_generate.py, which "meshes" for a minute).
// What only a real mesher shows (its WSL side ended by the stop) is not checked here.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

const PID = 'mesh-stop-e2e';
let host;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const tmp = e2eTemp('mesh-stop');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Mesh stop');
  host = await startHost({ name: 'mesh-stop', tmp, projects, env: { MAGNUSIM_TEST_COMPUTE: 'fake', MAGNUSIM_TEST_MESH_SECONDS: '90' } });
});

test.afterAll(() => {
  host?.stop();
});

const api = (path) => `${host.base}${path}`;

async function meshRow(request, meshId) {
  const doc = await (await request.get(api(`/api/mesh?project_id=${PID}&mesh_id=${meshId}`))).json();
  return doc.mesh;
}

/** The generator's pid once the mesh's record says it runs. */
async function generatorPid(request, meshId) {
  let pid = 0;
  await expect
    .poll(async () => {
      const live = (await meshRow(request, meshId))?.live_mesh_result;
      pid = live && live.status === 'running' ? Number(live.pid) || 0 : 0;
      return pid > 0;
    }, { timeout: 60_000 })
    .toBe(true);
  return pid;
}

async function openProject(page) {
  await page.goto(api(`/#/p/${PID}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
}

test('Stop on a generating mesh asks, ends the mesher, and the panel and the tree say Stopped', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const doc = await (await request.get(api(`/api/mesh?project_id=${PID}`))).json();
  const meshId = String(doc.mesh.id);
  await openProject(page);
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await form.locator('[data-mesh-generate="1"]').click();
  await expect(form.locator('.mesh-finished[data-mesh-status="generating"]')).toBeVisible({ timeout: 60_000 });
  const pid = await generatorPid(request, meshId);
  expect(alive(pid)).toBe(true);
  // As Generate saved them (the panel saves its settings first).
  const settingsBefore = (await meshRow(request, meshId)).settings;

  // The panel's Stop: the app asks first; Keep meshing changes nothing.
  const stop = form.locator('[data-mesh-stop="1"]');
  await expect(stop).toBeVisible();
  await expect(stop).toHaveText('Stop');
  const tree = page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
  await expect(tree.locator('[data-mesh-stop]')).toHaveText('Stop', { timeout: 30_000 });
  await stop.click();
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible();
  await expect(page.locator('#cf-heading')).toHaveText('Stop meshing "Mesh 1"?');
  await expect(page.locator('#cf-copy')).toHaveText('What it made so far is discarded.');
  await expect(page.locator('#cf-confirm')).toHaveText('Stop');
  await expect(page.locator('#cf-cancel')).toHaveText('Keep meshing');
  await page.locator('#cf-cancel').click();
  await expect(modal).toBeHidden();
  await page.waitForTimeout(1_000);
  await expect(form.locator('.mesh-finished[data-mesh-status="generating"]')).toBeVisible();
  expect(alive(pid), 'Keep meshing keeps it running').toBe(true);

  // Stop.
  await stop.click();
  await expect(modal).toBeVisible();
  await page.locator('#cf-confirm').click();
  const status = form.locator('.mesh-finished[data-mesh-status="stopped"]');
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(status.locator('.mat-k')).toHaveText('Stopped');
  await expect(status.locator('.mesh-finished-line')).toHaveText('Meshing was stopped before it finished. Generate to mesh again.');
  await expect(form.getByText('Mesh ready')).toHaveCount(0);
  await expect(form.locator('[data-mesh-stop="1"]')).toHaveCount(0);
  await expect(form.locator('[data-mesh-generate="1"]')).toHaveText('Generate');
  await expect(tree.locator('[data-mesh-stopped="1"]')).toHaveText('Stopped', { timeout: 30_000 });
  await expect(tree.locator('.tree-spin')).toHaveCount(0);
  await expect(tree.locator('.tree-check')).toHaveCount(0);
  await expect.poll(() => alive(pid), { timeout: 15_000, message: 'the generator process is gone' }).toBe(false);
  // Nothing was deleted: the mesh and its settings stay; the record says stopped.
  const after = await meshRow(request, meshId);
  expect(after.live_mesh_result.status).toBe('stopped');
  expect(after.generated).toBe(false);
  expect(after.settings).toEqual(settingsBefore);

  // After a reload the panel still says Stopped (from the record), and so does the tree.
  await openProject(page);
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  await expect(page.locator('#panel-mesh-form .cfd-island .mesh-finished[data-mesh-status="stopped"] .mat-k')).toHaveText('Stopped', { timeout: 30_000 });
  await expect(page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row [data-mesh-stopped="1"]`)).toHaveText('Stopped');
});

test("the tree row's Stop stops a generating mesh", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const doc = await (await request.get(api(`/api/mesh?project_id=${PID}`))).json();
  const meshId = String(doc.mesh.id);
  await openProject(page);
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await form.locator('[data-mesh-generate="1"]').click();
  const pid = await generatorPid(request, meshId);
  const tree = page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
  const stop = tree.locator('[data-mesh-stop]');
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(tree.locator('.tree-spin')).toBeVisible();
  await stop.click();
  await expect(page.locator('#cf-heading')).toHaveText('Stop meshing "Mesh 1"?');
  await page.locator('#cf-confirm').click();
  await expect(tree.locator('[data-mesh-stopped="1"]')).toHaveText('Stopped', { timeout: 30_000 });
  await expect(tree.locator('[data-mesh-stop]')).toHaveCount(0);
  await expect(form.locator('.mesh-finished[data-mesh-status="stopped"] .mat-k')).toHaveText('Stopped', { timeout: 30_000 });
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  expect((await meshRow(request, meshId)).live_mesh_result.status).toBe('stopped');
});
