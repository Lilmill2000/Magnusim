import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// Two boxes that share a face (a conformal two-body part): box 1 is x 0..10 mm, box 2 is
// x 10..30 mm, and the x = 10 face belongs to both (face 2@Body1 and face 7@Body2). Every
// body is meshed as one fluid region, so that face is inside the fluid: flow passes
// through it. Before, all three meshers walled it off or worse: Standard meshed the boxes
// as two regions with a wall between them, cfMesh's cartesianMesh crashed, and
// Hex-dominant kept only box 2 (and dropped box 1's outlet without a word). The BC panel
// let a BC go on it, and the Defaults panel counted it as a wall. Now the face is meshed
// through by each mesher, a BC can't be put on it (the app says why), Generate refuses a
// BC saved on it before, and it is no default wall.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const INSIDE = (face, a = 1, b = 2) =>
  `Face ${face} is inside the part (Body${a} and Body${b} share it), so it can't take a boundary condition.`;
const stamp = () => Date.now().toString(36);

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

async function setup(page, request, title) {
  await page.addInitScript(installViewReaders);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    title,
  );
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  await page.locator('#geometry-file-input').setInputFiles(SHARED);
  await expect.poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 }).toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await waitForCadFaces(page);
  await waitForInsideFaces(page);
  return { pid, q };
}

/** Installed in the page on every load: what the viewport draws. */
function installViewReaders() {
  const drawn = (want) => {
    const view = window.__CFD_VIEW__;
    if (!view) return null;
    let pd = null;
    for (const a of view.renderer.getActors()) {
      const m = a.getMapper && a.getMapper();
      const d = m && m.getInputData && m.getInputData();
      const cd = d && d.getCellData && d.getCellData();
      if (!cd || !a.getVisibility() || !d.getPolys || !d.getPolys().getNumberOfCells()) continue;
      if (!!cd.getArrayByName('faceId') !== want) continue;
      if (!pd || d.getNumberOfCells() > pd.getNumberOfCells()) pd = d;
    }
    if (!pd) return null;
    const pts = pd.getPoints().getData();
    const conn = pd.getPolys().getData();
    const cells = [];
    for (let i = 0; i < conn.length; i += conn[i] + 1) cells.push(Array.from(conn.subarray(i + 1, i + 1 + conn[i])));
    const xs = cells.map((c) => c.map((p) => pts[3 * p]));
    return { pts, cells, xs, cellData: pd.getCellData() };
  };
  // The CAD faces (the polydata with a faceId array).
  window.__e2eCadFaces = () => drawn(true);
  // The mesh the viewport shows: the largest drawn surface that is not the CAD.
  window.__e2eMeshSurface = () => {
    const g = drawn(false);
    if (!g) return null;
    let xmin = Infinity;
    let xmax = -Infinity;
    for (const row of g.xs) for (const x of row) (xmin = Math.min(xmin, x)), (xmax = Math.max(xmax, x));
    // The shared face lies a third of the way along x (10 of 30 mm, in whatever units).
    // Snapped meshes (Hex-dominant) sit a micron or so off the CAD: allow 1e-4 of the
    // length, far below a cell.
    const at = xmin + (xmax - xmin) / 3;
    const tol = 1e-4 * (xmax - xmin);
    const onSharedFace = g.xs.filter((row) => row.every((x) => Math.abs(x - at) < tol)).length;
    return { cells: g.cells.length, xmin, xmax, onSharedFace };
  };
}

async function waitForCadFaces(page) {
  await page.waitForFunction(() => {
    try {
      const g = window.__e2eCadFaces && window.__e2eCadFaces();
      return !!g && g.cells.length > 0;
    } catch (_) {
      return false;
    }
  }, null, { timeout: 60_000 });
}

/** The app knows which faces are inside the part (from the face table) once the part is shown. */
async function waitForInsideFaces(page) {
  await expect
    .poll(() => page.evaluate(() => (window.__CFD_INSIDE_FACES__ ? window.__CFD_INSIDE_FACES__().sort() : [])), { timeout: 30_000 })
    .toEqual(['face 2@Body1', 'face 7@Body2']);
}

/** Clicks the model where it shows a face in the plane x = `x` mm (as a user clicks a face they see). */
async function clickFaceAtX(page, x) {
  const find = () =>
    page.evaluate((want) => {
      const g = window.__e2eCadFaces();
      const box = document.getElementById('viewer').getBoundingClientRect();
      const hits = [];
      for (let y = box.top + 4; y < box.bottom - 4; y += 12) {
        for (let cx = box.left + 4; cx < box.right - 4; cx += 12) {
          const top = document.elementFromPoint(cx, y);
          if (!top || top.tagName !== 'CANVAS' || !top.closest('#viewer')) continue;
          const hit = window.__CFD_PICK_CAD__({ clientX: cx, clientY: y });
          if (!hit || hit.cellId == null || hit.cellId < 0) continue;
          if (g.xs[hit.cellId].every((v) => Math.abs(v - want) < 1e-6)) hits.push([cx, y]);
        }
      }
      if (!hits.length) return null;
      const mx = hits.reduce((s, h) => s + h[0], 0) / hits.length;
      const my = hits.reduce((s, h) => s + h[1], 0) / hits.length;
      hits.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
      return hits[0];
    }, x);
  let at = await find();
  for (const turn of [[90, 0], [90, 0], [90, 0], [0, 60], [0, -120]]) {
    if (at) break;
    await page.evaluate(([az, el]) => {
      const v = window.__CFD_VIEW__;
      const cam = v.renderer.getActiveCamera();
      if (az) cam.azimuth(az);
      if (el) cam.elevation(el);
      cam.orthogonalizeViewUp();
      v.renderer.resetCameraClippingRange();
      v.renderWindow.render();
    }, turn);
    await page.waitForTimeout(300);
    at = await find();
  }
  expect(at, `no face at x = ${x} mm is visible in the viewport`).toBeTruthy();
  await page.mouse.click(at[0], at[1]);
}

/** Zooms the view into box 1, looking at the face the boxes share, the way a user flies
 * the camera through the end of the part to see inside. */
async function lookAtSharedFaceFromInside(page) {
  await page.evaluate(() => {
    const v = window.__CFD_VIEW__;
    const cam = v.renderer.getActiveCamera();
    cam.setPosition(1, 5, 5);
    cam.setFocalPoint(10, 5, 5);
    cam.setViewUp(0, 0, 1);
    cam.setViewAngle(100);
    cam.setClippingRange(0.01, 100);
    v.renderWindow.render();
  });
  await page.waitForTimeout(300);
}

/** Back outside the part, looking at all of it. */
async function lookAtThePartFromOutside(page) {
  await page.evaluate(() => {
    const v = window.__CFD_VIEW__;
    const cam = v.renderer.getActiveCamera();
    cam.setPosition(60, -40, 40);
    cam.setFocalPoint(15, 5, 5);
    cam.setViewUp(0, 0, 1);
    cam.setViewAngle(30);
    v.renderer.resetCamera();
    v.renderer.resetCameraClippingRange();
    v.renderWindow.render();
  });
  await page.waitForTimeout(300);
}

async function createStudy(page) {
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  return page.evaluate(() => window.__CFD_W17__.activeId);
}

/** Adds a BC of this kind through the BC picker and waits until it is saved
 * (`bcs` reads the study's saved BCs); returns its id. */
async function addBc(page, key, bcs) {
  const before = (await bcs()).length;
  await page.locator('#btn-bcs-plus').click();
  await page.locator(`#panel-bc-picker .cfd-island [data-bc-key="${key}"]`).click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
  await expect(page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await bcs()).length).toBe(before + 1);
  return page.evaluate(() => window.__CFD_BC_STATE__().active_id);
}

const toasts = (page) => page.getByRole('region', { name: 'Notifications' });

test('a face two bodies share is inside the part: no BC goes on it, the app says why, and it is no default wall', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { pid, q } = await setup(page, request, `e2e shared face inside ${stamp()}`);

  // The face table says which faces are the shared one, each naming the other.
  const meta = await json(request, q('/api/geometry/cad', { part: 'preview' }));
  expect(meta.faces.filter((f) => f.shared_with).map((f) => [f.id, f.body, f.shared_with])).toEqual([
    [2, 1, 7],
    [7, 2, 2],
  ]);

  const sid = await createStudy(page);
  const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  const defaultsRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w19-defaults] > .tree-row`).first();
  const defaultCount = page.locator('#bc-default-count');
  // 12 face ids, two of them the face inside: 10 faces take the default wall.
  await defaultsRow.click();
  await expect(defaultCount).toHaveText('10', { timeout: 15_000 });

  const id = await addBc(page, 'velocity_inlet', bcs);
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  const chips = editor.locator('[data-face-picker="1"] [data-face-id]');

  // Click the shared face from inside box 1: refused, and a toast says why.
  await lookAtSharedFaceFromInside(page);
  await clickFaceAtX(page, 10);
  await expect(toasts(page)).toContainText(/Face (2@Body1|7@Body2) is inside the part \(Body1 and Body2 share it\), so it can't take a boundary condition\./, {
    timeout: 10_000,
  });
  await expect(chips).toHaveCount(0);
  // Its other visit too (the test hook goes through the same pick as a click).
  await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 7@Body2'));
  await expect(toasts(page)).toContainText(INSIDE('7@Body2'));
  await expect(chips).toHaveCount(0);

  // An outer face still goes on the BC.
  await lookAtThePartFromOutside(page);
  await clickFaceAtX(page, 30);
  await expect(chips).toHaveCount(1, { timeout: 10_000 });
  await expect(chips.first()).toHaveAttribute('data-face-id', 'face 8@Body2');
  await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces).toEqual(['face 8@Body2']);
  await defaultsRow.click();
  await expect(defaultCount).toHaveText('9', { timeout: 15_000 });

  // After a reload: the BC still has only its outer face, the count is the same, and the
  // shared face is still refused.
  await page.reload();
  await page.waitForFunction((p) => window.__CFD_PROJECT_READY__ === p, pid, { timeout: 60_000 });
  await waitForCadFaces(page);
  await waitForInsideFaces(page);
  expect((await bcs()).find((b) => b.id === id)?.faces).toEqual(['face 8@Body2']);
  await defaultsRow.click();
  await expect(defaultCount).toHaveText('9', { timeout: 15_000 });
  await page.locator(`#left-tree [data-w19-bc="${id}"] > .tree-row .tl`).first().click();
  await expect(chips).toHaveCount(1, { timeout: 15_000 });
  await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 2@Body1'));
  await expect(toasts(page)).toContainText(INSIDE('2@Body1'));
  await expect(chips).toHaveCount(1);
  expect((await bcs()).find((b) => b.id === id)?.faces).toEqual(['face 8@Body2']);
});

test('Generate refuses a BC saved on the shared face before, and says why', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { pid, q } = await setup(page, request, `e2e shared face refused ${stamp()}`);
  const sid = await createStudy(page);
  const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  const id = await addBc(page, 'velocity_inlet', bcs);
  // A BC saved on the shared face by the app before it refused that (an older project),
  // through the same save the BC panel uses.
  const old = (await bcs()).map((b) => (b.id === id ? { ...b, faces: ['face 7@Body2'], face: 'face 7@Body2' } : b));
  const saved = await request.post('/api/worker', {
    data: { method: 'bcs.set', params: { project_id: pid, sim_id: sid, body: { boundary_conditions: old, simulation_id: sid } } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces).toEqual(['face 7@Body2']);
  const name = (await bcs()).find((b) => b.id === id).name;

  await page.reload();
  await page.waitForFunction((p) => window.__CFD_PROJECT_READY__ === p, pid, { timeout: 60_000 });
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible({ timeout: 30_000 });
  await form.locator('[data-mesh-generate="1"]').click();

  // The mesh fails at once, before anything is meshed, and says which face and BC.
  const status = page.locator('#panel-mesh-form [data-mesh-status]');
  await expect(status).toHaveAttribute('data-mesh-status', 'failed', { timeout: 120_000 });
  await expect(status.locator('.mat-k')).toHaveText('Mesh failed');
  await expect(status.locator('.mesh-finished-line')).toHaveText(
    `Face 7@Body2 is inside the part (Body1 and Body2 share it), so it can't take a boundary condition. Remove it from "${name}".`,
  );

  // The face can still come off the BC (only putting it on is refused).
  await page.locator(`#left-tree [data-w19-bc="${id}"] > .tree-row .tl`).first().click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor.locator('[data-face-picker="1"] [data-face-id]')).toHaveCount(1, { timeout: 15_000 });
  await editor.getByRole('button', { name: 'Remove face 7@Body2' }).click();
  await expect(editor.locator('[data-face-picker="1"] [data-face-id]')).toHaveCount(0);
  await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces).toEqual([]);
});

/** polyMesh/boundary as {patch: nFaces}. */
function boundaryPatches(caseDir) {
  const text = readFileSync(join(caseDir, 'constant', 'polyMesh', 'boundary'), 'utf8');
  const out = {};
  for (const m of text.matchAll(/(\w+)\s*\{[^}]*?nFaces\s+(\d+);/g)) out[m[1]] = Number(m[2]);
  return out;
}

for (const engine of [
  { label: 'Standard', value: null },
  { label: 'cfMesh', value: 'cfmesh' },
  { label: 'Hex-dominant', value: 'snappy_hexdominant' },
]) {
  test(`${engine.label} meshes a two-body part through the face the bodies share`, async ({ page, request }) => {
    test.skip(!WSL, NO_WSL);
    test.setTimeout(900_000);
    const { q } = await setup(page, request, `e2e shared face ${engine.label} ${stamp()}`);
    const sid = await createStudy(page);
    const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
    // Inlet on box 2's far end, outlet on box 1's: the flow has to cross the shared face.
    const inlet = await addBc(page, 'velocity_inlet', bcs);
    await clickFaceAtX(page, 30);
    await expect.poll(async () => (await bcs()).find((b) => b.id === inlet)?.faces).toEqual(['face 8@Body2']);
    const outlet = await addBc(page, 'pressure_outlet', bcs);
    await clickFaceAtX(page, 0);
    await expect.poll(async () => (await bcs()).find((b) => b.id === outlet)?.faces).toEqual(['face 1@Body1']);

    // A quick mesh: fineness 1, no boundary layers; cfMesh keeps the hex core it needs.
    const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
    if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();
    await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
    const form = page.locator('#panel-mesh-form .cfd-island');
    await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
    const mid = await page.evaluate(() => window.__CFD_W20__.active_id);
    if (engine.value) {
      await form.locator('details.mesh-advanced > summary').click();
      await form.locator('select[data-mesh-engine="1"]').selectOption(engine.value);
      await expect
        .poll(async () => (await json(request, q('/api/mesh', { simulation_id: sid, mesh_id: mid }))).mesh?.settings?.advanced?.mesh_engine)
        .toBe(engine.value);
    }
    await form.locator('[data-schema-key="fineness"] input').fill('1');
    await form.locator('[data-schema-key="fineness"] input').press('Tab');
    const layers = form.locator('button[aria-label="Automatic boundary layers"]');
    if ((await layers.count()) && (await layers.getAttribute('aria-pressed')) === 'true') await layers.click();
    await form.locator('[data-mesh-generate="1"]').click();

    const status = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 840_000 });
    const rec = (await json(request, q('/api/mesh', { simulation_id: sid, mesh_id: mid }))).mesh || {};
    expect(await status.getAttribute('data-mesh-status'), JSON.stringify(rec.live_mesh_result?.error || '')).toBe('ready');
    if (engine.value === 'cfmesh') await expect(form.locator('.mesh-finished-meta')).toContainText('cfMesh');

    // The mesh as the viewport shows it: both boxes, and no surface where they meet.
    if (!(await page.evaluate(() => window.__CFD_MESH_INSPECT__ === true))) {
      await page.locator(`#left-tree [data-w20-mesh-item="${mid}"] > .tree-row .tl`).first().click();
    }
    await expect.poll(() => page.evaluate(() => window.__CFD_MESH_INSPECT__ === true), { timeout: 60_000 }).toBe(true);
    await expect(page.locator('#mesh-inspect-line')).toContainText('cells', { timeout: 120_000 });
    let surface = null;
    await expect
      .poll(async () => {
        surface = await page.evaluate(() => window.__e2eMeshSurface && window.__e2eMeshSurface());
        return surface && surface.cells > 0;
      }, { timeout: 60_000 })
      .toBe(true);
    // x from box 1's outlet end to box 2's inlet end (the mesh is in metres or mm).
    console.log(`${engine.label} mesh as drawn: ${JSON.stringify(surface)}`);
    const length = [0.03, 30].find((x) => Math.abs(surface.xmax - x) < 1e-3 * x);
    expect(length, JSON.stringify(surface)).toBeTruthy();
    expect(Math.abs(surface.xmin), JSON.stringify(surface)).toBeLessThan(1e-4 * length);
    expect(surface.onSharedFace, 'mesh faces lying on the shared face').toBe(0);

    // The solver's mesh has both BC patches (Hex-dominant dropped the outlet) and the walls.
    const patches = boundaryPatches(rec.live_mesh_result.case_dir);
    const bcPatches = Object.entries(patches).filter(([n, nf]) => n !== 'walls' && n !== 'defaultFaces' && nf > 0);
    expect(bcPatches.length, JSON.stringify(patches)).toBe(2);
    expect(patches.walls).toBeGreaterThan(0);
  });
}
