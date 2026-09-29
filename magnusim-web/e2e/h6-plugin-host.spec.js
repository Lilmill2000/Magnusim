import { expect, test } from '@playwright/test';
import { NO_WSL } from './toolchain.js';

// Plugin host correctness (H6): plugin meshers really run, a missing mesher is
// reported instead of silently meshing with Standard, plugin analyses can be
// created, Settings saves never turn a plugin back on, and a plugin's UI is
// added and removed exactly once. The plugins come from python/tests/fixtures/plugins.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const PROJECT = 'sample-project-steady-state-e2e';

function stage(msg) {
  console.log(`[h6 ${new Date().toISOString()}] ${msg}`);
}

async function openProject(page) {
  await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#left-tree')).toContainText('Elbow', { timeout: 30_000 });
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true);
}

async function openSettingsPlugins(page) {
  await page.locator('#wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await expect(wizard).toBeVisible();
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const step = wizard.locator('.wiz-pane[data-wiz-step="5"]');
  await expect(step).toBeVisible();
  return step;
}

async function setPlugin(request, key, on) {
  const r = await request.post(`/api/plugins/${key}/${on ? 'enable' : 'disable'}`);
  expect(r.ok(), `${on ? 'enable' : 'disable'} ${key}: ${r.status()}`).toBe(true);
}

async function meshes(request) {
  const r = await request.get(`/api/mesh?project_id=${encodeURIComponent(PROJECT)}`);
  const body = await r.json();
  return body.meshes || (body.mesh ? [body.mesh] : []);
}

async function meshEngine(request, meshId) {
  const m = (await meshes(request)).find((row) => String(row.id) === String(meshId)) || {};
  return String(m.ui_mesh_engine || (m.settings && m.settings.advanced && m.settings.advanced.mesh_engine) || '');
}

/** A new mesh of its own, so the fixture's Mesh 1 stays as seeded for later specs. */
async function createMesh(page, request) {
  const before = new Set((await meshes(request)).map((m) => String(m.id)));
  const meshFolder = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first();
  await expect(meshFolder).toBeVisible({ timeout: 15_000 });
  await meshFolder.locator('.tl').click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  let id = '';
  await expect
    .poll(async () => {
      const added = (await meshes(request)).map((m) => String(m.id)).filter((mid) => !before.has(mid));
      id = added[0] || '';
      return id;
    }, { timeout: 15_000 })
    .not.toBe('');
  await form.locator('details.mesh-advanced > summary').click();
  await expect(form.locator('[data-mesh-engine="1"]')).toBeVisible();
  return { form, id };
}

async function deleteMesh(request, meshId) {
  if (!meshId) return;
  await request.post('/api/mesh', { data: { project_id: PROJECT, mesh_id: meshId, delete_record: true } });
}

test('@plugins gate:h6-plugin-analysis-create a plugin analysis can be created as a study', async ({ request }) => {
  const created = await request.post('/api/simulation', {
    data: { project_id: PROJECT, analysis: 'laminar_steady' },
  });
  const body = await created.json();
  expect(created.status(), JSON.stringify(body)).toBeLessThan(300);
  const sim = body.simulation || body.sim || body;
  expect(sim.id, JSON.stringify(body)).toBeTruthy();
  const removed = await request.post('/api/simulation/delete', {
    data: { project_id: PROJECT, simulation_id: sim.id },
  });
  expect(removed.ok()).toBe(true);
});

test('@plugins gate:h6-unknown-key-honest a mesher that is turned off is reported, not replaced by Standard', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  let meshId = '';
  try {
    await openProject(page);
    const created = await createMesh(page, request);
    meshId = created.id;
    await created.form.locator('[data-mesh-engine="1"]').selectOption({ label: 'Extra mesher' });
    await expect.poll(() => meshEngine(request, meshId), { timeout: 15_000 }).toBe('example_extra_mesher');
    stage('extra mesher picked; turning the plugin off');
    await setPlugin(request, 'example-extra-mesher', false);
    // The saved pick survives a reload: it is kept, not rewritten to Standard.
    await page.reload();
    await openProject(page);
    expect(await meshEngine(request, meshId)).toBe('example_extra_mesher');
    await page.locator(`#left-tree [data-w20-mesh-item="${meshId}"]`).first().click();
    const form = page.locator('#panel-mesh-form .cfd-island');
    await form.locator('[data-mesh-generate="1"]').click();
    await expect(page.getByText(/Mesher "example_extra_mesher" is not installed or is turned off/)).toBeVisible({
      timeout: 30_000,
    });
    stage('not-installed message shown');
  } finally {
    await setPlugin(request, 'example-extra-mesher', true);
    await deleteMesh(request, meshId);
  }
});

test('@plugins gate:h6-prefs-single-writer a units save keeps a plugin turned off', async ({ page, request }) => {
  test.setTimeout(120_000);
  try {
    await setPlugin(request, 'example-laminar', false);
    const saved = await request.post('/api/prefs', { data: { units: 'Imperial' } });
    expect(saved.ok()).toBe(true);
    await request.post('/api/prefs', { data: { units: 'Metric' } });
    const listed = await (await request.get('/api/plugins')).json();
    const row = (listed.plugins || []).find((p) => p.key === 'example-laminar');
    expect(row && row.status).toBe('disabled');
    await openProject(page);
    const step = await openSettingsPlugins(page);
    await expect(step.locator('[data-plugin-key="example-laminar"]')).toHaveAttribute('data-plugin-status', 'disabled', {
      timeout: 15_000,
    });
    await page.locator('#wiz-skip').click();
  } finally {
    await setPlugin(request, 'example-laminar', true);
  }
});

test('@plugins gate:h6-ui-ledger turning a plugin off and on shows its panel once, with no reload', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  try {
    await openProject(page);
    const step = await openSettingsPlugins(page);
    const row = step.locator('[data-plugin-key="example-hook-monitor"]');
    const panel = step.locator('[data-plugin-hook="1"]');
    await expect(panel).toHaveCount(1, { timeout: 15_000 });
    for (let i = 0; i < 3; i += 1) {
      await row.locator('[data-plugin-toggle="example-hook-monitor"]').click();
      await expect(row).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 15_000 });
      await expect(panel).toHaveCount(0);
      await row.locator('[data-plugin-toggle="example-hook-monitor"]').click();
      await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 15_000 });
      await expect(panel).toHaveCount(1, { timeout: 15_000 });
    }
    await page.locator('#wiz-skip').click();
  } finally {
    await setPlugin(request, 'example-hook-monitor', true);
  }
});

test('@plugins gate:h6-plugin-mesher-live a plugin mesher runs as picked', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(900_000);
  page.setDefaultTimeout(30_000);
  let meshId = '';
  try {
    await openProject(page);
    const created = await createMesh(page, request);
    meshId = created.id;
    const form = created.form;
    await form.locator('[data-mesh-engine="1"]').selectOption({ label: 'Extra mesher' });
    await expect.poll(() => meshEngine(request, meshId), { timeout: 15_000 }).toBe('example_extra_mesher');
    await form.locator('[data-schema-key="fineness"] input').fill('1');
    for (const label of ['Hex element core', 'Automatic boundary layers']) {
      const toggle = form.locator(`button[aria-label="${label}"]`);
      if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    }
    stage('generate with the plugin mesher');
    const t0 = Date.now();
    await form.locator('[data-mesh-generate="1"]').click();
    // Read this mesh's own record (/api/case reports whichever case is active).
    let result = {};
    let lastStage = '';
    await expect
      .poll(
        async () => {
          const m = (await meshes(request)).find((row) => String(row.id) === String(meshId)) || {};
          result = m.live_mesh_result || {};
          const s = String(result.status || 'wait');
          const st = `${s}/${result.stage || ''}`;
          if (st !== lastStage) {
            lastStage = st;
            stage(`mesh ${meshId}: ${st}`);
          }
          if (Date.now() - t0 > 90_000 && s === 'wait') throw new Error('mesh never started: ' + JSON.stringify(m));
          return s;
        },
        { timeout: 840_000, intervals: [2_000] },
      )
      .toMatch(/done|failed/);
    expect(result.status, JSON.stringify(result.error || '')).toBe('done');
    // It ran through the Standard path under the plugin mesher's own key.
    expect(result.mesh_backend).toBe('example_extra_mesher');
    expect(String(result.path_kind || '')).not.toBe('snappyHexMesh');
    expect(Number(result.n_cells || 0)).toBeGreaterThan(0);
    stage(`meshed ${result.n_cells} cells in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    await deleteMesh(request, meshId);
  }
});
