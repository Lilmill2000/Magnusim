import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// Mesh features, each proven on the generated mesh: settings copied from another mesh,
// a surface sizing refinement (more cells, its face in standard-meta.json), an inflate
// refinement, the cfMesh engine, mesh inspect and its cutting plane, deleting a
// generated mesh, stopping a mesh that is running, and copying a mesh with its
// refinement to a mesh on another geometry (onto the matching face).
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const ROUND = join(GEOM, 'transient-test.step');
const TEARDROP = join(GEOM, 'transient-test-teardrop.step');

test('mesh settings, refinements, engines, inspect, delete and stop, and copy across geometries', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (m) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${m}`);
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) }).catch(() => {});

  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async () =>
      (await window.__CFD_W16_CREATE__({ title: 'e2e mesh features', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const json = async (url) => {
    // A poll can reuse a keep-alive socket just as the server closes it (5 s idle): retry
    // the read, as a browser does.
    for (let i = 0; ; i++) {
      try {
        return await (await request.get(url)).json();
      } catch (e) {
        if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
      }
    }
  };
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  for (const file of [ROUND, TEARDROP]) {
    const n = ((await json(q('/api/project'))).project?.geometries || []).length;
    await page.locator('#geometry-file-input').setInputFiles(file);
    await expect.poll(async () => ((await json(q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 }).toBe(n + 1);
  }
  const geoms = (await json(q('/api/project'))).project.geometries;
  const round = geoms.find((g) => g.name === 'transient-test');
  const tear = geoms.find((g) => g.name === 'transient-test-teardrop');
  const faceOf = async (gid, pickFn) => {
    const meta = await json(q('/api/geometry/cad', { geometry_id: gid, part: 'preview' }));
    const f = meta.faces.find(pickFn);
    return `face ${f.id}@Body1`;
  };
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const roundInlet = await faceOf(round.id, (f) => near(f.centroid[1], 0) && near(f.normal[1], -1));
  const roundHole = await faceOf(round.id, (f) => f.surface_type === 'Cylinder');
  const tearInlet = await faceOf(tear.id, (f) => near(f.centroid[1], 0) && near(f.normal[1], -1));

  const pick = async (g) => {
    await page.locator(`#geometries-list .geo-item[data-geom-id="${g.id}"]`).click();
    await page.waitForFunction((id) => window.__CFD_W16__?.geometry?.id === id, g.id);
  };
  const createStudy = async (g) => {
    await pick(g);
    await page.locator('#btn-create-simulation').click();
    await page.locator('#cs-geometry').selectOption(g.id);
    await page.locator('#cs-create').click();
    await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
    return page.evaluate(() => window.__CFD_W17__.activeId);
  };
  const roundStudy = await createStudy(round);
  const form = page.locator('#panel-mesh-form .cfd-island');
  const treeMesh = async (sid, mid) => {
    const tree = await json(q('/api/project/tree'));
    const study = (tree.geometries || []).flatMap((g) => g.studies || []).find((s) => s.id === sid) || {};
    return (study.meshes || []).find((m) => m.id === mid) || {};
  };
  const addMesh = async (sid, name) => {
    await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#mesh-new-name').fill(name);
    await page.locator('#btn-create-mesh').click();
    await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible();
    return page.evaluate(() => window.__CFD_W20__.active_id);
  };
  const generate = async (sid, mid, label) => {
    await form.locator('[data-mesh-generate="1"]').click();
    let last = '';
    await expect
      .poll(async () => {
        const m = await treeMesh(sid, mid);
        const st = m.live_status || (m.generated ? 'done' : 'none');
        if (st !== last) stage(`${label}: ${st}`);
        last = st;
        return /done|failed|stopped/.test(st) ? st : 'waiting';
      }, { timeout: 1_200_000, intervals: [5_000] })
      .not.toBe('waiting');
    // A failed mesh fails the test now, with its reason.
    const done = await treeMesh(sid, mid);
    expect(done.live_status || (done.generated ? 'done' : 'none'), JSON.stringify((await json(q('/api/mesh', { simulation_id: sid, mesh_id: mid }))).mesh?.live_mesh_result?.error || '')).toBe('done');
    const rec = (await json(q('/api/mesh', { simulation_id: sid, mesh_id: mid }))).mesh || {};
    const live = rec.live_mesh_result || {};
    return { cells: Number(live.n_cells || (await treeMesh(sid, mid)).n_cells), caseDir: live.case_dir, live };
  };

  // 1. A plain Standard mesh.
  const base = await addMesh(roundStudy, 'Base');
  const b = await generate(roundStudy, base, 'Base');
  expect(b.cells).toBeGreaterThan(1000);
  await expect(form.locator('.mesh-finished-meta')).toContainText('Standard');
  stage(`Base: ${b.cells} cells`);

  // 2. A second mesh copies Base's settings, then gets a fine surface sizing on the hole
  //    and an inflate layer on the inlet: more cells, both refinements in standard-meta.json.
  const refined = await addMesh(roundStudy, 'Refined');
  await form.getByRole('button', { name: 'Copy from another mesh' }).click();
  await form.locator('#mesh-copy-source').selectOption(base);
  await expect(form).toContainText('Copied from');
  const refs = async () => ((await json(q('/api/mesh/refinements', { simulation_id: roundStudy }))).refinements || []).filter((r) => r.mesh_id === refined);
  const addRef = async (type, face) => {
    // Unfold the mesh row (its Refinements row holds the +) only if it is folded.
    const meshLi = page.locator(`#left-tree li[data-w20-mesh-item="${refined}"]`).first();
    if (!(await meshLi.evaluate((el) => el.classList.contains('expanded')))) {
      await meshLi.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`[data-refs-plus="${refined}"]`).first().click();
    await expect(page.locator('#panel-ref-picker')).toBeVisible();
    await page.locator(`#panel-ref-picker .ml-type[data-ref-type="${type}"]`).click();
    // The face the user has picked in the viewport when they press Add.
    await page.evaluate((f) => { window.__CFD_W16_STATE__.selectedFaces = [f]; }, face);
    await page.locator('#ref-picker-apply').click();
    await expect(page.locator('#panel-ref-editor')).toBeVisible();
    await expect.poll(async () => (await refs()).filter((r) => r.type === type).map((r) => r.faces)).toEqual([[face]]);
  };
  await addRef('Surface custom sizing', roundHole);
  await page.locator('#ref-default-size').fill('3');
  await page.locator('#ref-default-size').press('Tab');
  await expect.poll(async () => (await refs()).find((r) => r.type === 'Surface custom sizing')?.default_size).toBe(3);
  await addRef('Inflate boundary layer', roundInlet);
  await page.locator(`#left-tree [data-w20-mesh-item="${refined}"] > .tree-row .tl`).first().click();
  const r = await generate(roundStudy, refined, 'Refined');
  stage(`Refined: ${r.cells} cells`);
  expect(r.cells).toBeGreaterThan(b.cells);
  const meta = JSON.parse(readFileSync(join(r.caseDir, 'standard-meta.json'), 'utf8'));
  expect(JSON.stringify(meta.surface_custom_sizing || [])).toContain(roundHole);
  expect(JSON.stringify(meta.inflate_boundary_layer || [])).toContain(roundInlet);

  // 3. Inspect it: counts in the chip, and a mesh cutting plane.
  // Clicking the selected mesh again closes the view, so click only when it is not open.
  if (!(await page.evaluate(() => window.__CFD_MESH_INSPECT__ === true))) {
    await page.locator(`#left-tree [data-w20-mesh-item="${refined}"] > .tree-row .tl`).first().click();
  }
  await expect.poll(() => page.evaluate(() => window.__CFD_MESH_INSPECT__ === true), { timeout: 60_000 }).toBe(true);
  await expect(page.locator('#mesh-inspect-line')).toContainText('cells', { timeout: 60_000 });
  const section = page.waitForResponse((res) => /\/api\/mesh-section/.test(res.url()) && res.ok(), { timeout: 120_000 });
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await section;
  await expect(page.locator('#mesh-plane-list .mesh-plane-card')).toHaveCount(1);
  await shot('mesh-inspect');

  // 4. cfMesh (with Hex element core on, which it needs).
  const cf = await addMesh(roundStudy, 'Cartesian');
  await form.locator('details.mesh-advanced > summary').click();
  await form.locator('select[data-mesh-engine="1"]').selectOption('cfmesh');
  await expect.poll(async () => ((await json(q('/api/mesh', { simulation_id: roundStudy, mesh_id: cf }))).mesh?.settings?.advanced?.mesh_engine)).toBe('cfmesh');
  const c = await generate(roundStudy, cf, 'cfMesh');
  expect(existsSync(join(c.caseDir, 'log.cartesianMesh'))).toBe(true);
  await expect(form.locator('.mesh-finished-meta')).toContainText('cfMesh');
  stage(`cfMesh: ${c.cells} cells`);

  // 5. Delete a generated mesh: the mesh goes, its settings stay.
  // Its settings panel is still open from Generate (clicking the selected mesh would close it).
  await page.locator('#panel-mesh-form button.mat-clear-link[title="Delete mesh"]:visible, #panel-mesh-inspect .mat-clear-link:visible').first().click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await treeMesh(roundStudy, cf)).generated === true || (await treeMesh(roundStudy, cf)).live_status === 'done').toBe(false);

  // 6. Stop a mesh while it runs: its Delete stops the mesher (there is no separate Stop).
  const stopMe = await addMesh(roundStudy, 'Stop me');
  await form.locator('[data-mesh-generate="1"]').click();
  await expect.poll(() => page.evaluate(() => window.__CFD_MESH_JOB__?.phase), { timeout: 60_000 }).toBe('generating');
  await form.locator('button.mat-clear-link[title="Delete mesh"]').click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => ((await json(q('/api/mesh', { simulation_id: roundStudy }))).meshes || []).some((m) => m.id === stopMe), { timeout: 60_000 }).toBe(false);
  await expect.poll(async () => (await json(q('/api/compute-queue'))).live?.kind || 'none', { timeout: 120_000 }).toBe('none');
  stage('running mesh stopped');

  // 7. A mesh on the teardrop copies Refined, refinements included, onto its own faces.
  const tearStudy = await createStudy(tear);
  const tearMesh = await addMesh(tearStudy, 'From round');
  await form.getByRole('button', { name: 'Copy from another mesh' }).click();
  await form.locator('#mesh-copy-source').selectOption(refined);
  await expect(form).toContainText('Copied from');
  const tearRefs = async () =>
    ((await json(q('/api/mesh/refinements', { simulation_id: tearStudy }))).refinements || []).filter((x) => x.mesh_id === tearMesh);
  await expect.poll(async () => (await tearRefs()).find((x) => x.type === 'Inflate boundary layer')?.faces).toEqual([tearInlet]);
  // The round plate's hole has no match on the teardrop: that refinement keeps no face, and the note says so.
  expect((await tearRefs()).find((x) => x.type === 'Surface custom sizing')?.faces).toEqual([]);
  await expect(form).toContainText('No matching face');
  const copiedSettings = (await json(q('/api/mesh', { simulation_id: tearStudy, mesh_id: tearMesh }))).mesh?.settings || {};
  const baseSettings = (await json(q('/api/mesh', { simulation_id: roundStudy, mesh_id: refined }))).mesh?.settings || {};
  expect(copiedSettings.fineness).toBe(baseSettings.fineness);
  await shot('copied-across');
});
