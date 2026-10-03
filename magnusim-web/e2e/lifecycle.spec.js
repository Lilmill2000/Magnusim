import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEOMETRY_REMOVE_IDS,
  GEOMETRY_REMOVE_PROJECT,
  MISSING_STUDY_ID,
  MISSING_STUDY_PROJECT,
} from './prepare-projects.js';

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

/** The studies Create Simulation offers under "Start from" ("" is "None — empty study"). */
async function startFromChoices(page) {
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  const values = await page.locator('#cs-copy-from option').evaluateAll((opts) => opts.map((o) => o.value));
  await page.locator('#cs-cancel').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden();
  return values;
}
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
  // The app then opens the new folder. Wait for that before leaving: on a slow machine it
  // landed after the next navigation and took the page back into the (empty) folder.
  await page.waitForFunction(() => location.hash.startsWith('#/folder/'), null, { timeout: 30_000 });

  // Rename the project and move it into the folder from its edit dialog.
  await page.goto('/#/');
  const card = page.locator(`.home-card[data-project-id="${pid}"]`);
  if (!(await card.waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
    // Say what the home page showed instead (CI only shows this message, not the page).
    const seen = await page.evaluate((id) => ({
      hash: location.hash,
      cards: [...document.querySelectorAll('.home-card')].map((c) => c.getAttribute('data-project-id')).slice(0, 12),
      filterActive: document.querySelector('.home-nav .is-active')?.textContent?.trim() || null,
      inList: !!document.querySelector(`[data-project-id="${id}"]`),
      loading: document.body.innerText.includes('Loading'),
    }), pid);
    const server = await json(request, '/api/projects');
    throw new Error(`card for ${pid} not shown: page ${JSON.stringify(seen)}; server lists it: ${(server.projects || []).some((p) => p.id === pid)}`);
  }
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
  const studyPanel = page.locator('#panel-study-settings');
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

  // Wall default: Slip in the Defaults panel shows in the tree too.
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-defaults] > .tree-row`).first().click();
  await page.locator('#bc-default-wall-type').selectOption('Slip');
  await page.getByRole('button', { name: 'Done' }).first().click();
  await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-defaults] .tree-sub`)).toHaveText('Slip walls');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-defaults] .tree-sub`)).toHaveText('Slip walls');

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

  // Delete straight after a rename: the rename's run.json write used to land in
  // the folder being deleted (EPERM, or the run came back).
  const post = async (path, data) => (await request.post(q(path), { data: { project_id: pid, simulation_id: clone, ...data } })).json();
  for (let i = 0; i < 3; i++) {
    const made = await post('/api/run/create', { name: `Race ${i}` });
    const rid = made.run && made.run.id;
    expect(rid).toBeTruthy();
    expect((await post('/api/run/rename', { run_id: rid, name: `Race ${i} renamed` })).ok).toBe(true);
    const del = await post('/api/run/delete', { run_id: rid });
    expect(del.ok, JSON.stringify(del)).toBe(true);
  }
  await page.waitForTimeout(1500);
  expect((await runs()).filter((n) => n.startsWith('Race'))).toEqual([]);

  // Delete the clone; the original stays with its BC. The tree's reads are held from the
  // delete on, so the tree keeps its read from before: the clone's row, active, with the
  // BC + on it. That row used to stay until a read landed, and a click on it or its +
  // went back to the deleted study (a BC added then was saved nowhere to be seen).
  await studyRow(page, clone).click();
  await studyPanel.locator('button.mat-clear-link[title="Delete this simulation"]').click();
  const isTreeRead = (url) => url.pathname === '/api/project/tree';
  const heldReads = [];
  let releaseReads = () => {};
  const readsHeld = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const holdRead = async (route) => {
    heldReads.push(route.request().url());
    await readsHeld;
    await route.continue().catch(() => {});
  };
  await page.route(isTreeRead, holdRead);
  const wallEditor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const wallRec = async () => (await bcs(sid)).find((b) => b.bc_type === 'Wall');
  try {
    await page.locator('#cf-confirm').click();
    await expect.poll(async () => (await studies()).map((s) => s.id)).toEqual([sid]);
    expect((await bcs(sid)).length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    // No row of the deleted study; the + is on the study that is left.
    await expect(page.locator(`#left-tree [data-w17-sim-id="${clone}"]`)).toHaveCount(0);
    await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] #btn-bcs-plus`)).toHaveCount(1);
    // Asked for by id (an old button, a queued job), the deleted study is not opened again.
    await page.evaluate((id) => window.__CFD_ADD_BC__(id), clone);
    expect(await page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    await expect(page.locator('#panel-bc-picker')).toBeHidden();

    // A Wall BC has its own wall type: editing it leaves the Slip default alone
    // (it used to overwrite the default with the Wall's No-slip). Added before any
    // tree read lands, it goes to the study that is left.
    await page.locator('#btn-bcs-plus').click();
    await page.locator('#panel-bc-picker .cfd-island [data-bc-key="wall"]').click();
    await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
    await expect(wallEditor).toBeVisible();
    await expect.poll(async () => (await wallRec())?.wall_type).toBe('No-slip');
    expect(await page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    expect(heldReads.length).toBeGreaterThan(0);
  } finally {
    releaseReads();
    await page.unroute(isTreeRead, holdRead);
  }
  await expect(page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-bc]`)).toHaveCount(2);
  await expect(page.locator(`#left-tree [data-w17-sim-id="${clone}"]`)).toHaveCount(0);
  const wallType = wallEditor.getByLabel('Wall type');
  await expect(wallType).toHaveValue('No-slip');
  await wallType.selectOption('Slip');
  await expect.poll(async () => (await wallRec())?.wall_type).toBe('Slip');
  await wallType.selectOption('No-slip');
  await expect.poll(async () => (await wallRec())?.wall_type).toBe('No-slip');
  await wallEditor.getByRole('button', { name: 'Done' }).click();
  const defaultsNow = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).defaults?.wall_type;
  expect(await defaultsNow()).toBe('Slip');
  const defaultsRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-defaults]`);
  await expect(defaultsRow.locator('.tree-sub')).toHaveText('Slip walls');
  await defaultsRow.locator(':scope > .tree-row').first().click();
  await expect(page.locator('#bc-default-wall-type')).toHaveValue('Slip');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await expect(defaultsRow.locator('.tree-sub')).toHaveText('Slip walls');
  await defaultsRow.locator(':scope > .tree-row').first().click();
  await expect(page.locator('#bc-default-wall-type')).toHaveValue('Slip');
  expect((await wallRec())?.wall_type).toBe('No-slip');
});

test('a study deleted before its delete left the index is not counted, offered or opened', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  // Seeded by prepare-projects.js: simulations.json lists a deleted study (no folder) as
  // the active one. Opening the project counted it, offered it under Start from and
  // opened it, with an empty setup, instead of the study that is there.
  const pid = MISSING_STUDY_PROJECT;
  const q = (path) => `${path}?project_id=${encodeURIComponent(pid)}`;
  const shown = async () => {
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#simulations-count-label')).toHaveText('SIMULATIONS (1)');
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe('sim_1');
    await expect(page.locator(`#left-tree [data-w17-sim-id="${MISSING_STUDY_ID}"]`)).toHaveCount(0);
    await expect(page.locator('#left-tree [data-w17-sim-id="sim_1"] #btn-bcs-plus')).toHaveCount(1);
    expect(await startFromChoices(page)).toEqual(['', 'sim_1']);
  };
  await openProject(page, pid);
  await shown();
  // Asked for by id (an old tab, a queued job), it is not opened.
  const activated = await (
    await request.post(q('/api/simulation/activate'), { data: { project_id: pid, simulation_id: MISSING_STUDY_ID } })
  ).json();
  expect(activated.active_id).toBe('sim_1');
  const hydrated = await json(request, q('/api/project/hydrate'));
  expect(hydrated.simulation.simulations.map((s) => s.id)).toEqual(['sim_1']);
  expect(hydrated.simulation.active_id).toBe('sim_1');
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await shown();
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
  const roundStudy = await createStudy(page, { geometryId: round.id });
  const tearStudy = await createStudy(page, { geometryId: tear.id });

  // Showing a geometry renders its Home card thumbnail after the reply, and a geometry
  // deleted while that ran came back as a folder holding only thumb.png. Show the round
  // plate, then the teardrop with no thumbnail (so one renders), and delete it at once.
  const tearDir = dirname(tear.step_path);
  const geomRow = (gid) => page.locator(`#left-tree li[data-w16-geom="${gid}"] > .tree-row`);
  await geomRow(round.id).click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(round.id);
  // Joins the project's thumbnail render, if one runs, so the teardrop gets its own.
  await request.get(q('/api/geometry/thumb'));
  rmSync(join(tearDir, 'thumb.png'), { force: true });
  await geomRow(tear.id).click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(tear.id);
  const geoPanel = page.locator('#panel-geometry');
  await geoPanel.locator('.mat-clear-link', { hasText: 'Delete' }).click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-copy')).toContainText('simulation');
  await expect(page.locator('#cf-copy')).toContainText('removed with it');
  await page.locator('#cf-confirm').click();

  await expect.poll(async () => (await json(request, q('/api/project'))).project.geometries.map((g) => g.id)).toEqual([round.id]);
  // Joins the teardrop's render if it still runs, so it has written what it will.
  await request.get(q('/api/geometry/thumb'));
  expect(existsSync(tearDir)).toBe(false);
  expect(readdirSync(dirname(tearDir))).toEqual([basename(dirname(round.step_path))]);
  const left = (await json(request, q('/api/simulation'))).simulations || [];
  expect(left.map((s) => s.geometry_id)).toEqual([round.id]);
  expect(left.some((s) => s.id === tearStudy)).toBe(false);
  // The round plate is shown with its own study.
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(round.id);
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.simulation?.geometry_id)).toBe(round.id);
  await expect(page.locator('#geometries-list .geo-item')).toHaveCount(1);
  // Nothing of the removed geometry's study is left to count, copy from or open, now or
  // after a reload (hydrate reads simulations.json).
  const onlyRound = async () => {
    await expect(page.locator('#simulations-count-label')).toHaveText('SIMULATIONS (1)');
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.activeId)).toBe(roundStudy);
    expect(await startFromChoices(page)).toEqual(['', roundStudy]);
  };
  await onlyRound();
  const hydrated = await json(request, q('/api/project/hydrate'));
  expect(hydrated.simulation.simulations.map((s) => s.id)).toEqual([roundStudy]);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await onlyRound();
});

test("deleting a geometry keeps another geometry's study that simulations.json does not list", async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  // Seeded by prepare-projects.js: the round plate has two studies, and simulations.json
  // lists only the first; the teardrop has none. Removing the teardrop deleted every study
  // folder the index did not list: "Round fine" left the tree, and the disk, for good.
  const pid = GEOMETRY_REMOVE_PROJECT;
  const ids = GEOMETRY_REMOVE_IDS;
  const q = (path) => `${path}?project_id=${encodeURIComponent(pid)}`;
  const inTree = (sid) => page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  const roundStudies = async () => {
    await expect(inTree(ids.roundStudy)).toHaveCount(1, { timeout: 30_000 });
    await expect(inTree(ids.unlistedStudy)).toHaveCount(1, { timeout: 30_000 });
    await expect(studyRow(page, ids.roundStudy)).toContainText('Round baseline');
    await expect(studyRow(page, ids.unlistedStudy)).toContainText('Round fine');
  };
  await openProject(page, pid);
  await expect(page.locator('#geometries-list .geo-item')).toHaveCount(2, { timeout: 60_000 });
  await roundStudies();
  const folders = Object.fromEntries(
    (await json(request, q('/api/project'))).project.geometries.map((g) => [g.id, dirname(g.step_path)]),
  );

  await page.locator(`#left-tree li[data-w16-geom="${ids.tear}"] > .tree-row`).click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(ids.tear);
  await page.locator('#panel-geometry').locator('.mat-clear-link', { hasText: 'Delete' }).click();
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await expect(page.locator('#cf-copy')).toHaveText('The CAD is removed from this project.');
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await json(request, q('/api/project'))).project.geometries.map((g) => g.id)).toEqual([ids.round]);
  // Showing the teardrop started its Home card thumbnail render; this joins it if it still
  // runs. A render that ended after the delete wrote thumb.png into the removed folder.
  await request.get(q('/api/geometry/thumb'));
  expect(existsSync(folders[ids.tear])).toBe(false);
  expect(readdirSync(dirname(folders[ids.round]))).toEqual([basename(folders[ids.round])]);

  // Only the teardrop went: the round plate is shown with both its studies, now and after
  // a reload (the tree walks the study folders).
  const onlyRound = async () => {
    await expect(page.locator('#geometries-list .geo-item')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(`#left-tree li[data-w16-geom="${ids.tear}"]`)).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id)).toBe(ids.round);
    await roundStudies();
  };
  await onlyRound();
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await onlyRound();
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
