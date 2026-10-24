import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// Routes that once answered as if they worked and changed the wrong thing, seen in the
// tree after a reload (the Assistant, a plugin or another tab sends these bodies):
//  - {delete: true, id} on a BC or a refinement deleted every one of the study
//  - POST /api/materials with a new id renamed and reassigned the study's first material
//  - POST /api/simulation dropped the name it was sent
//  - an import over the size cap was read whole (no cap); it now says the file is too large
// Its own server (own projects copy, a 1 MB import cap). No WSL: nothing is meshed or solved.
const FIXTURE = 'sample-project-steady-state-e2e';
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'route-scope-fixes', env: { MAGNUSIM_IMPORT_MAX_MB: '1' } });
});

test.afterAll(() => {
  if (host) host.stop();
});

test.describe.configure({ mode: 'serial' });

const api = (path, extra = {}) => `${host.base}${path}?${new URLSearchParams({ project_id: FIXTURE, ...extra })}`;

/** Open (or reload: a goto to the same #/p/ URL changes nothing) the project; the tree as saved. */
async function openProject(page, pid = FIXTURE) {
  const url = `${host.base}/#/p/${encodeURIComponent(pid)}`;
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
}

test('deleting one BC by {delete: true, id} leaves the other in the tree', async ({ page, request }) => {
  test.setTimeout(180_000);
  const listed = async () => (await (await request.get(api('/api/bcs', { simulation_id: 'sim_1' }))).json()).boundary_conditions;
  const before = (await listed()).length;
  const made = [];
  for (const face of ['face 3@Body1', 'face 4@Body1']) {
    const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: FIXTURE, simulation_id: 'sim_1', bc_type: 'Wall', faces: [face] } });
    expect(r.status(), await r.text()).toBe(200);
    made.push((await listed()).find((b) => (b.faces || []).includes(face)).id);
  }
  await openProject(page);
  const rows = page.locator('#left-tree [data-w19-bc]');
  await expect(rows).toHaveCount(before + 2, { timeout: 30_000 });
  const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: FIXTURE, simulation_id: 'sim_1', delete: true, id: made[0] } });
  expect(r.status()).toBe(200);
  await openProject(page);
  await expect(rows).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(page.locator(`#left-tree [data-w19-bc="${made[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`#left-tree [data-w19-bc="${made[1]}"]`)).toHaveCount(1);
});

test('deleting one refinement by {delete: true, id} leaves the other in the tree', async ({ page, request }) => {
  test.setTimeout(180_000);
  const ids = [];
  for (const face of ['face 1@Body1', 'face 2@Body1']) {
    const r = await request.post(`${host.base}/api/mesh/refinements`, {
      data: { project_id: FIXTURE, simulation_id: 'sim_1', mesh_id: 'mesh_1', type: 'Surface custom sizing', faces: [face] },
    });
    expect(r.status(), await r.text()).toBe(200);
    ids.push((await r.json()).refinement.id);
  }
  await openProject(page);
  const rows = page.locator('#left-tree [data-w26-ref]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  const r = await request.post(`${host.base}/api/mesh/refinements`, { data: { project_id: FIXTURE, simulation_id: 'sim_1', delete: true, id: ids[0] } });
  expect(r.status()).toBe(200);
  await openProject(page);
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(`#left-tree [data-w26-ref="${ids[1]}"]`)).toHaveCount(1);
});

test('a material saved with a new id is added; the study material keeps its name', async ({ page, request }) => {
  test.setTimeout(180_000);
  await openProject(page);
  const air = page.locator('#left-tree [data-w18-air="1"] > .tree-row .tl').first();
  await expect(air).toHaveText('Air', { timeout: 30_000 });
  const r = await request.post(`${host.base}/api/materials`, {
    data: { project_id: FIXTURE, simulation_id: 'sim_1', id: 'mat-water', name: 'Water', assigned_volumes: ['Body1'] },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const mats = (await (await request.get(api('/api/materials', { simulation_id: 'sim_1' }))).json()).materials;
  expect(mats.map((m) => m.name).sort()).toEqual(['Air', 'Water']);
  await openProject(page);
  await expect(air).toHaveText('Air', { timeout: 30_000 });
});

test('a study created with a name shows that name in the tree', async ({ page, request }) => {
  test.setTimeout(180_000);
  const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: FIXTURE, geometry_id: 'geom-e2e', name: 'Elbow at 30 m/s' } });
  expect(r.status(), await r.text()).toBe(201);
  const sid = (await r.json()).simulation.id;
  await openProject(page);
  await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first()).toContainText('Elbow at 30 m/s', { timeout: 30_000 });
});

test('a geometry file over the import cap says it is too large', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async () =>
      (await window.__CFD_W16_CREATE__({ title: `e2e import cap ${Date.now().toString(36)}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
  );
  await openProject(page, pid);
  await page.locator('#geometry-file-input').setInputFiles({
    name: 'big.step',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024 * 1024 + 64 * 1024, 0x20),
  });
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  await expect(modal.locator('#cf-heading')).toHaveText('Could not import big.step');
  await expect(modal.locator('#cf-copy')).toContainText('File too large: an import takes up to 1 MB');
});
