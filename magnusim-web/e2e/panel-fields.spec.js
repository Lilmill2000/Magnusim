import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// Panels show what is real and keep what was saved:
// - a mesher's panel lists only the settings its run reads (Hex-dominant showed
//   three advanced fields its run never got; cfMesh showed none of the fields
//   its run used), and says when cfMesh hands the mesh to Standard;
// - a boundary condition keeps every field it was saved with (the save kept only
//   ten Incompressible Flow fields, so another analysis's BC settings were lost).
// Its own server (own projects copy), so the shared sample project is untouched.
const FIXTURE = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';
let host;

test.beforeAll(async () => {
  host = await startHost({ name: 'panel-fields' });
});

test.afterAll(() => {
  if (host) host.stop();
});

async function openProject(page) {
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
}

test('a mesher shows the settings its run uses', async ({ page, request }) => {
  test.setTimeout(240_000);
  const form = page.locator('#panel-mesh-form .cfd-island');
  const field = (key) => form.locator(`[data-schema-key="${key}"]`);
  const algorithm = form.locator('[data-mesh-algorithm="1"]');
  const openMesh = async () => {
    await page.locator('#left-tree [data-w20-mesh-item="mesh_1"] > .tree-row .tl').first().click();
    await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
  };
  const savedMesh = async () =>
    (await (await request.get(`${host.base}/api/mesh?project_id=${FIXTURE}&simulation_id=${SIM}&mesh_id=mesh_1`)).json()).mesh || {};

  await openProject(page);
  await openMesh();
  await form.locator('details.mesh-advanced > summary').click();
  // Standard's run reads its advanced settings.
  await expect(field('gap_refinement_factor')).toBeVisible();
  const engine = form.locator('select[data-mesh-engine="1"]');

  // Hex-dominant reads fineness, layers and physics-based only.
  await engine.selectOption('snappy_hexdominant');
  await expect(algorithm).toHaveText('Hex-dominant');
  await expect(field('fineness')).toBeVisible();
  for (const key of ['small_feature_suppression', 'gap_refinement_factor', 'global_gradation_rate']) {
    await expect(field(key)).toHaveCount(0);
  }

  // cfMesh shows what its run uses (it showed nothing).
  await engine.selectOption('cfmesh');
  await expect(algorithm).toHaveText('cfMesh cartesianMesh (legacy)');
  for (const key of ['fineness', 'add_layers', 'physics_based', 'hex_element_core']) {
    await expect(field(key)).toBeVisible();
  }
  await expect(field('gap_refinement_factor')).toHaveCount(0);

  // Without a hex core, cfMesh hands the mesh to Standard: the panel says so.
  const hexCore = form.locator('button[aria-label="Hex element core"]');
  await expect(hexCore).toHaveAttribute('aria-pressed', 'true');
  await hexCore.click();
  await expect(algorithm).toHaveText('Standard (cfMesh needs Hex element core)');
  await expect
    .poll(async () => {
      const m = await savedMesh();
      return `${m.settings?.advanced?.mesh_engine}/${m.settings?.hex_element_core}`;
    })
    .toBe('cfmesh/false');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await openMesh();
  await expect(algorithm).toHaveText('Standard (cfMesh needs Hex element core)');
  await expect(form.locator('button[aria-label="Hex element core"]')).toHaveAttribute('aria-pressed', 'false');
});

test('a boundary condition keeps fields the core does not know', async ({ page, request }) => {
  test.setTimeout(180_000);
  const bcsNow = async () =>
    (await (await request.get(`${host.base}/api/bcs?project_id=${FIXTURE}&simulation_id=${SIM}`)).json()).boundary_conditions || [];
  const hotWall = async () => (await bcsNow()).find((b) => b.id === 'bc-hot-wall') || {};

  // Saved the way the page saves BCs, with a field another analysis would add.
  const hot = {
    id: 'bc-hot-wall',
    name: 'Hot wall',
    bc_type: 'Wall',
    wall_type: 'No-slip',
    heat_flux_W_m2: 120.5,
    faces: [],
    simulation_id: SIM,
    project_id: FIXTURE,
  };
  const saved = await request.post(`${host.base}/api/worker`, {
    data: {
      method: 'bcs.set',
      params: { project_id: FIXTURE, sim_id: SIM, body: { boundary_conditions: [...(await bcsNow()), hot], simulation_id: SIM } },
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  expect((await hotWall()).heat_flux_W_m2).toBe(120.5);

  // Edited in the BC panel (the page sends back the records it read): still there,
  // after the edit and after a reload.
  await openProject(page);
  await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
  await page.locator('#panel-bcs-hub .cfd-island [data-open-bc="bc-hot-wall"]').click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor.locator('[data-bc-title="1"]')).toHaveText('Hot wall');
  await editor.getByLabel('Wall type').selectOption('Slip');
  await expect.poll(async () => (await hotWall()).wall_type).toBe('Slip');
  expect((await hotWall()).heat_flux_W_m2).toBe(120.5);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
  await page.locator('#panel-bcs-hub .cfd-island [data-open-bc="bc-hot-wall"]').click();
  await expect(editor.getByLabel('Wall type')).toHaveValue('Slip');
  expect((await hotWall()).heat_flux_W_m2).toBe(120.5);
});
