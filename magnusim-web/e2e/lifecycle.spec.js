import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything a user creates can be renamed, moved and deleted again, through the UI:
// folders and projects on Home; studies (rename, clone, delete), meshes and runs
// (add, rename, delete) in the workbench; a geometry with its studies; an Imperial
// project's units; and the setup wizard on first launch and from Settings.
const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const ROUND = join(GEOM, 'transient-test.step');
const TEARDROP = join(GEOM, 'transient-test-teardrop.step');
const stamp = () => Date.now().toString(36);

async function createProject(page, title, extra = {}) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  return page.evaluate(
    async ([t, e]) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects', ...e }))
        .project.id,
    [title, extra],
  );
}

async function openProject(page, pid) {
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

async function importStep(page, request, pid, file) {
  const count = async () =>
    ((await (await request.get(`/api/project?project_id=${encodeURIComponent(pid)}`)).json()).project?.geometries || []).length;
  const before = await count();
  await page.locator('#geometry-file-input').setInputFiles(file);
  await expect.poll(count, { timeout: 120_000 }).toBe(before + 1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
}

async function createStudy(page, opts = {}) {
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  if (opts.geometryId) await page.locator('#cs-geometry').selectOption(opts.geometryId);
  if (opts.copyFrom) {
    await page.locator('#cs-copy-from').selectOption(opts.copyFrom);
    if (opts.mode) await page.locator(`#cs-copy-mode [data-copy-mode="${opts.mode}"]`).click();
  }
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  return page.evaluate(() => window.__CFD_W17__.activeId);
}

const studyRow = (page, sid) => page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
const json = async (request, url) => {
  // A poll can reuse a keep-alive socket just as the server closes it: retry the read.
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

test('home: a folder, a project renamed and moved into it, then both deleted', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const folder = `E2E folder ${stamp()}`;
  const pid = await createProject(page, `e2e lifecycle home ${stamp()}`);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_OPEN_NEW_PROJECT_MODAL__ === 'function', null, { timeout: 60_000 });

  // New folder.
  await page.locator('#home-new-folder').click();
  await page.locator('#nf-name').fill(folder);
  await page.locator('#nf-create').click();
  await expect.poll(async () => JSON.stringify((await json(request, '/api/folders')).folders)).toContain(folder);

  // Rename the project and move it into the folder from its edit dialog.
  await page.goto('/#/');
  const card = page.locator(`.home-card[data-project-id="${pid}"]`);
  await card.click();
  await page.locator('#home-edit-project').click();
  await expect(page.locator('#np-heading')).toHaveText(/Edit project/);
  await page.locator('#np-title').fill('e2e renamed project');
  await page.locator('#np-folder').selectOption(folder);
  await page.locator('#np-create').click();
  await expect
    .poll(async () => {
      const p = (await json(request, `/api/project?project_id=${encodeURIComponent(pid)}`)).project || {};
      return `${p.title}|${p.folder}`;
    })
    .toBe(`e2e renamed project|${folder}`);

  // Delete the project (two confirmations).
  await page.goto(`/#/folder/${encodeURIComponent(folder)}`);
  await page.locator(`.home-card[data-project-id="${pid}"]`).click();
  await page.locator('#home-delete-project').click();
  await expect(page.locator('#modal-delete-project')).toBeVisible();
  await page.locator('#dp-confirm').click();
  await page.locator('#dp-confirm').click();
  await expect
    .poll(async () => ((await json(request, '/api/projects')).projects || []).some((p) => p.id === pid))
    .toBe(false);

  // A second project in the folder goes with the folder.
  const inFolder = await createProject(page, `e2e in folder ${stamp()}`, { folder });
  await page.goto('/#/');
  await page.locator(`.home-nav-child[data-filter="folder:${folder}"]`).click();
  await expect(page.locator('#home-delete-project')).toHaveAttribute('aria-label', 'Delete folder');
  await page.locator('#home-delete-project').click();
  await page.locator('#dp-confirm').click();
  await page.locator('#dp-confirm').click();
  await expect.poll(async () => JSON.stringify((await json(request, '/api/folders')).folders)).not.toContain(folder);
  expect(((await json(request, '/api/projects')).projects || []).some((p) => p.id === inFolder)).toBe(false);
});

test('workbench: a study renamed, cloned and deleted; meshes and runs added, renamed and deleted', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const pid = await createProject(page, `e2e lifecycle workbench ${stamp()}`);
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  await openProject(page, pid);
  await importStep(page, request, pid, ROUND);
  const sid = await createStudy(page);

  // Rename the study from its panel.
  await studyRow(page, sid).click();
  const studyPanel = page.locator('#panel-incompressible-defaults');
  await studyPanel.locator('button.mesh-rename[aria-label="Rename simulation"]').click();
  await studyPanel.locator('input[aria-label="Simulation name"]').fill('Baseline');
  await studyPanel.locator('input[aria-label="Simulation name"]').press('Enter');
  const studies = async () => (await json(request, q('/api/simulation'))).simulations || [];
  await expect.poll(async () => (await studies()).find((s) => s.id === sid)?.name).toBe('Baseline');

  // A BC on the inlet end, so the clone has something to carry.
  const meta = await json(request, q('/api/geometry/cad', { part: 'preview' }));
  const inlet = meta.faces.find((f) => Math.abs(f.centroid[1]) < 0.5 && Math.abs(f.normal[1] + 1) < 0.01);
  await page.locator('#btn-bcs-plus').click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-key="velocity_inlet"]').click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
  await expect(page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]')).toBeVisible();
  const bcs = async (s) => (await json(request, q('/api/bcs', { simulation_id: s }))).boundary_conditions || [];
  await expect.poll(async () => (await bcs(sid)).length).toBe(1);
  await page.evaluate((id) => window.__CFD_ASSIGN_FACE__(id), inlet.id);
  await expect.poll(async () => (await bcs(sid))[0].faces).toEqual([`face ${inlet.id}@Body1`]);

  // Clone it on the same geometry: the BC comes along on the same face.
  const clone = await createStudy(page, { copyFrom: sid, mode: 'clone' });
  expect(clone).not.toBe(sid);
  await expect.poll(async () => (await bcs(clone)).map((b) => b.faces)).toEqual([[`face ${inlet.id}@Body1`]]);
  expect((await studies()).length).toBe(2);

  // Meshes: add two, rename one, delete the other.
  const meshes = async () => (await json(request, q('/api/mesh', { simulation_id: clone }))).meshes || [];
  const addMesh = async (name) => {
    await page.locator(`#left-tree [data-w17-sim-id="${clone}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#mesh-new-name').fill(name);
    await page.locator('#btn-create-mesh').click();
    await expect.poll(async () => (await meshes()).map((m) => m.name)).toContain(name);
    await expect(page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]')).toBeVisible();
  };
  await addMesh('Coarse');
  const form = page.locator('#panel-mesh-form');
  await form.locator('button.mesh-rename[aria-label="Rename mesh"]').click();
  await form.locator('input[aria-label="Mesh name"]').fill('Coarse A');
  await form.locator('input[aria-label="Mesh name"]').press('Enter');
  await expect.poll(async () => (await meshes()).map((m) => m.name)).toContain('Coarse A');
  await addMesh('Fine');
  await form.locator('button.mat-clear-link[title="Delete mesh"]').click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await meshes()).map((m) => m.name).includes('Fine')).toBe(false);
  expect((await meshes()).map((m) => m.name)).toContain('Coarse A');

  // Runs: add one from the Simulation folder, rename it, delete it.
  const runs = async () => ((await json(request, q('/api/run/status', { simulation_id: clone }))).runs || []).map((r) => r.name);
  await page.locator(`#left-tree [data-w17-sim-id="${clone}"] [data-w27-sim-control="1"] > .tree-row .tl`).first().click();
  await page.locator('#sim-new-run-name').fill('Run B');
  await page.locator('#btn-create-run').click();
  await expect.poll(runs).toContain('Run B');
  const runPanel = page.locator('#panel-sim-control');
  await expect(runPanel.locator('[data-run-title="1"]')).toHaveText('Run B', { timeout: 15_000 });
  await runPanel.locator('button.mesh-rename[aria-label="Rename run"]').click();
  await runPanel.locator('input[aria-label="Run name"]').fill('Run Beta');
  await runPanel.locator('input[aria-label="Run name"]').press('Enter');
  await expect.poll(runs).toContain('Run Beta');
  await runPanel.locator('button.mat-clear-link[title="Delete run"]').click();
  await expect.poll(runs).not.toContain('Run Beta');

  // Delete the clone; the original stays with its BC.
  await studyRow(page, clone).click();
  await studyPanel.locator('button.mat-clear-link[title="Delete this simulation"]').click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await studies()).map((s) => s.id)).toEqual([sid]);
  expect((await bcs(sid)).length).toBe(1);
});

test('deleting a geometry says its studies go too, and removes only those', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const pid = await createProject(page, `e2e lifecycle geometry ${stamp()}`);
  const q = (path) => `${path}?project_id=${encodeURIComponent(pid)}`;
  await openProject(page, pid);
  await importStep(page, request, pid, ROUND);
  await importStep(page, request, pid, TEARDROP);
  const geoms = (await json(request, q('/api/project'))).project.geometries;
  const round = geoms.find((g) => g.name === 'transient-test');
  const tear = geoms.find((g) => g.name === 'transient-test-teardrop');
  await createStudy(page, { geometryId: round.id });
  const tearStudy = await createStudy(page, { geometryId: tear.id });

  await page.locator(`#left-tree li[data-w16-geom="${tear.id}"] > .tree-row`).click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(tear.id);
  const geoPanel = page.locator('#panel-geometry');
  await geoPanel.locator('.mat-clear-link', { hasText: 'Delete' }).click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-copy')).toContainText('simulation');
  await expect(page.locator('#cf-copy')).toContainText('removed with it');
  await page.locator('#cf-confirm').click();

  await expect.poll(async () => (await json(request, q('/api/project'))).project.geometries.map((g) => g.id)).toEqual([round.id]);
  const left = (await json(request, q('/api/simulation'))).simulations || [];
  expect(left.map((s) => s.geometry_id)).toEqual([round.id]);
  expect(left.some((s) => s.id === tearStudy)).toBe(false);
  // The round plate is shown with its own study.
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(round.id);
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.geometry_id)).toBe(round.id);
  await expect(page.locator('#geometries-list .geo-item')).toHaveCount(1);
});

test('an Imperial project shows imperial units', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const pid = await createProject(page, `e2e imperial ${stamp()}`, { units: 'Imperial' });
  expect((await json(request, `/api/project?project_id=${encodeURIComponent(pid)}`)).project.units).toBe('Imperial');
  await openProject(page, pid);
  expect(await page.evaluate(() => window.__CFD_PROJECT_UNITS__ && window.__CFD_PROJECT_UNITS__())).toBe('Imperial');
  await importStep(page, request, pid, ROUND);
  const sid = await createStudy(page);
  // A velocity inlet asks in ft/s, a pressure BC in psi.
  const addBc = async (key) => {
    await page.locator('#btn-bcs-plus').click();
    await page.locator(`#panel-bc-picker .cfd-island [data-bc-key="${key}"]`).click();
    await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
    await expect(page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]')).toBeVisible();
  };
  await addBc('velocity_inlet');
  await expect(page.locator('#panel-bc-editor select[aria-label="Velocity unit"]')).toHaveValue('ft/s');
  await addBc('pressure_outlet');
  await expect(page.locator('#panel-bc-editor select[aria-label="Fixed value unit"]')).toHaveValue('psi');
  expect(await page.evaluate(() => window.__CFD_BCS__ && window.__CFD_BCS__.imperial)).toBe(true);
  expect(sid).toBeTruthy();
});

test('setup wizard: first launch walks every step to Finish; Settings reopens it', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const before = await json(request, '/api/prefs');
  const port = Number(process.env.MAGNUSIM_E2E_PORT || 8083);
  // The PC check wakes WSL; its answer is not what this test is about.
  await page.route('**/api/prefs/hardware-check', (route) =>
    route.fulfill({ json: { ok: true, hardware: { logical_cpus: 8, physical_cores: 4, ram_gb: 16, profile: 'desktop', n_procs: 3, notes: [] } } }),
  );
  try {
    await request.post('/api/prefs', { data: { wizard_completed: false } });
    await page.goto('/#/');
    const wiz = page.locator('#setup-wizard');
    await expect(wiz).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#wiz-skip')).toBeHidden();
    await expect(page.locator('.wiz-pane[data-wiz-step="0"]')).toBeVisible();
    for (let step = 0; step < 5; step++) {
      if (step === 1) await page.locator('[data-wiz-units="Metric"]').click();
      if (step === 3) await page.locator('#wiz-port').fill(String(port));
      await page.locator('#wiz-next').click();
      await expect(page.locator(`.wiz-pane[data-wiz-step="${step + 1}"]`)).toBeVisible();
    }
    await expect(page.locator('#wiz-next')).toHaveText(/Finish/);
    await page.locator('#wiz-next').click();
    await expect(wiz).toBeHidden({ timeout: 30_000 });
    const prefs = await json(request, '/api/prefs');
    expect(prefs.wizard_completed).toBe(true);
    expect(prefs.units).toBe('Metric');

    // Settings opens it again at Workspace, closable.
    await page.locator('#home-prefs').click();
    await expect(wiz).toBeVisible();
    await expect(page.locator('.wiz-pane[data-wiz-step="4"]')).toBeVisible();
    await page.locator('#wiz-skip').click();
    await expect(wiz).toBeHidden();
  } finally {
    await request.post('/api/prefs', {
      data: { wizard_completed: true, units: before.units || 'Metric', port: before.port || port },
    });
  }
});
