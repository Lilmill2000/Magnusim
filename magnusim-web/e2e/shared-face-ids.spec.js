import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// Two boxes that share a face (a conformal two-body part): box 1 is x 0..10 mm, box 2 is
// x 10..30 mm, and the x = 10 face belongs to both. The face list and the mesher number
// that face once per body (face 2 in Body1, face 7 in Body2), but the viewport used to
// number it once, so every later viewport id named the next face along: a BC picked on
// box 2's far end (x = 30, face 8) was saved as face 7, and the mesh put it on the
// shared face. Now the face picked in the viewport is the face the BC names, the face
// list describes and the mesh gets. An old cached preview with the old ids is rebuilt
// when the project opens.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const OLD_PREVIEW = join(HERE, 'fixtures', 'shared-face-preview-v7');
// Same projects root playwright.config.js gives the server.
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const FAR_END = 'face 8@Body2';
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
  await page.addInitScript(installCadReader);
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
  return { pid, q };
}

// --- What the viewport draws, read from the CAD face polydata it renders (mm). ---

/** Installed in the page on every load: the CAD face polydata the viewport draws (the
 * actor with a faceId array), with each triangle's points, x values, ids and colour. */
function installCadReader() {
  window.__e2eCadFaces = () => {
    const view = window.__CFD_VIEW__;
    if (!view) return null;
    let pd = null;
    for (const a of view.renderer.getActors()) {
      const m = a.getMapper && a.getMapper();
      const d = m && m.getInputData && m.getInputData();
      const cd = d && d.getCellData && d.getCellData();
      if (!cd || !cd.getArrayByName('faceId') || !a.getVisibility()) continue;
      if (!pd || d.getNumberOfCells() > pd.getNumberOfCells()) pd = d;
    }
    if (!pd) return null;
    const pts = pd.getPoints().getData();
    const conn = pd.getPolys().getData();
    const cells = [];
    for (let i = 0; i < conn.length; i += conn[i] + 1) cells.push(Array.from(conn.subarray(i + 1, i + 1 + conn[i])));
    const cd = pd.getCellData();
    const arr = (name) => (cd.getArrayByName(name) ? Array.from(cd.getArrayByName(name).getData()) : null);
    const xs = cells.map((c) => c.map((p) => pts[3 * p]));
    return { pts, cells, xs, faceId: arr('faceId'), solidId: arr('solidId'), rgb: arr('bodyRgb') };
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

/** Per viewport face id: its body (solidId) and the area-weighted centroid of its triangles. */
async function viewportFaces(page) {
  return page.evaluate(() => {
    const g = window.__e2eCadFaces();
    const out = {};
    g.cells.forEach((c, k) => {
      const p = c.map((i) => [g.pts[3 * i], g.pts[3 * i + 1], g.pts[3 * i + 2]]);
      const u = [0, 1, 2].map((j) => p[1][j] - p[0][j]);
      const v = [0, 1, 2].map((j) => p[2][j] - p[0][j]);
      const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      const f = (out[g.faceId[k]] ||= { bodies: [], area: 0, sum: [0, 0, 0] });
      if (!f.bodies.includes(g.solidId[k])) f.bodies.push(g.solidId[k]);
      f.area += area;
      for (let j = 0; j < 3; j++) f.sum[j] += (area * (p[0][j] + p[1][j] + p[2][j])) / 3;
    });
    for (const f of Object.values(out)) f.centroid = f.sum.map((s) => s / f.area);
    return out;
  });
}

/** The faces the viewport paints apart from the rest (the open BC's faces), with their x range. */
async function highlightedFaces(page) {
  return page.evaluate(() => {
    const g = window.__e2eCadFaces();
    if (!g.rgb) return [];
    const key = (k) => g.rgb.slice(3 * k, 3 * k + 3).join(',');
    const count = {};
    g.cells.forEach((_c, k) => (count[key(k)] = (count[key(k)] || 0) + 1));
    const rest = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    const out = {};
    g.cells.forEach((_c, k) => {
      if (key(k) === rest) return;
      const f = (out[`face ${g.faceId[k]}@Body${g.solidId[k]}`] ||= { xmin: Infinity, xmax: -Infinity });
      f.xmin = Math.min(f.xmin, ...g.xs[k]);
      f.xmax = Math.max(f.xmax, ...g.xs[k]);
    });
    return Object.entries(out).map(([label, r]) => ({ label, ...r }));
  });
}

/**
 * Clicks the model where it shows the face lying in the plane x = `x` mm, the way a
 * user clicks a face they can see: the spot is chosen by where that face is drawn, not by
 * the face id the viewport gives it. Turns the view first if that face is out of sight.
 */
async function clickFaceAtX(page, x) {
  const find = () =>
    page.evaluate(
      (want) => {
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
      },
      x,
    );
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

/** Every face in the face list is drawn in the viewport under its own number and body. */
async function expectViewportMatchesFaceList(page, request, q) {
  const meta = await json(request, q('/api/geometry/cad', { part: 'preview' }));
  expect(meta.n_solids).toBe(2);
  expect(meta.faces.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const drawn = await viewportFaces(page);
  expect(Object.keys(drawn).map(Number).sort((a, b) => a - b)).toEqual(meta.faces.map((f) => f.id));
  for (const f of meta.faces) {
    const d = drawn[f.id];
    expect(d.bodies, `face ${f.id}`).toEqual([f.body]);
    for (let j = 0; j < 3; j++) expect(d.centroid[j], `face ${f.id} centroid`).toBeCloseTo(f.centroid[j], 3);
  }
  const farEnd = meta.faces.find((f) => Math.abs(f.centroid[0] - 30) < 1e-6);
  expect(`face ${farEnd.id}@Body${farEnd.body}`).toBe(FAR_END);
  return meta;
}

/** Adds a Velocity Inlet and picks box 2's far end for it in the viewport. Returns the BC id. */
async function inletOnFarEnd(page, request, q) {
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  await page.locator('#btn-bcs-plus').click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-key="velocity_inlet"]').click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await bcs()).length).toBe(1);
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await clickFaceAtX(page, 30);
  return { sid, id, bcs, editor };
}

test('a face picked in the viewport of a two-body part is the face its BC names in the face list', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { pid, q } = await setup(page, request, `e2e shared face ids ${stamp()}`);
  const meta = await expectViewportMatchesFaceList(page, request, q);
  const { id, bcs, editor } = await inletOnFarEnd(page, request, q);

  // The editor lists the face the user clicked, the BC saves it, and the face list says
  // it is box 2's far end (x = 30 mm), not the face the boxes share (x = 10 mm).
  const chips = editor.locator('[data-face-picker="1"] [data-face-id]');
  await expect(chips).toHaveCount(1, { timeout: 10_000 });
  await expect(chips.first()).toHaveAttribute('data-face-id', FAR_END);
  await expect(chips.first().locator('.bc-assign-pick')).toHaveText(FAR_END);
  await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces).toEqual([FAR_END]);
  const listed = meta.faces[Number(FAR_END.match(/\d+/)[0]) - 1];
  expect(listed.centroid).toEqual([30, 5, 5]);
  expect(listed.body).toBe(2);
  // The viewport paints that face, and only it, as the BC's face.
  await expect.poll(() => highlightedFaces(page)).toEqual([{ label: FAR_END, xmin: 30, xmax: 30 }]);

  // After a reload the BC still names that face, and the viewport still shows it there.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await waitForCadFaces(page);
  await page.locator('#left-tree [data-w19-bcs="1"] > .tree-row .tl').first().click();
  const card = page.locator('#panel-bcs-hub .cfd-island .hub-item', { hasText: FAR_END });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(editor.locator('[data-face-picker="1"] .bc-assign-pick')).toHaveText([FAR_END]);
  await expect.poll(() => highlightedFaces(page), { timeout: 15_000 }).toEqual([{ label: FAR_END, xmin: 30, xmax: 30 }]);
  await expectViewportMatchesFaceList(page, request, q);
});

test('an old preview with the old viewport face ids is rebuilt when the project opens', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { pid, q } = await setup(page, request, `e2e shared face old preview ${stamp()}`);
  // Put back what the app cached before the fix (made by that code from the same part).
  const root = join(PROJECTS, pid, 'geometries');
  const gdir = readdirSync(root)
    .map((d) => join(root, d))
    .find((d) => existsSync(join(d, 'source.bbrep')));
  expect(gdir, 'geometry folder').toBeTruthy();
  for (const f of ['cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json']) copyFileSync(join(OLD_PREVIEW, f), join(gdir, f));
  expect(JSON.parse(readFileSync(join(gdir, 'cad_preview.json'), 'utf8')).preview_version).toBe(7);

  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await waitForCadFaces(page);
  expect((await json(request, q('/api/geometry/cad', { part: 'preview' }))).preview_version).toBe(8);
  // Every face is drawn under the number the face list gives it again; box 2's far end
  // is face 8 (the old preview drew it as face 7, the shared face's number in Body2).
  await expectViewportMatchesFaceList(page, request, q);
});

/** x range (m) of each named surface patch in the mesher's ASCII MSH 2.2 file. */
function patchX(msh) {
  const lines = readFileSync(msh, 'utf8').split(/\r?\n/);
  const names = {};
  const xOf = {};
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const n = Number(lines[i + 1]);
    if (lines[i] === '$PhysicalNames') {
      for (const row of lines.slice(i + 2, i + 2 + n)) {
        const m = row.match(/^2\s+(\d+)\s+"(.*)"$/);
        if (m) names[m[1]] = m[2];
      }
    } else if (lines[i] === '$Nodes') {
      for (const row of lines.slice(i + 2, i + 2 + n)) {
        const [id, x] = row.split(/\s+/);
        xOf[id] = Number(x);
      }
    } else if (lines[i] === '$Elements') {
      for (const row of lines.slice(i + 2, i + 2 + n)) {
        const v = row.split(/\s+/);
        const type = v[1];
        const name = names[v[3]];
        if ((type !== '2' && type !== '3') || !name) continue;
        const r = (out[name] ||= { xmin: Infinity, xmax: -Infinity });
        for (const node of v.slice(3 + Number(v[2]))) {
          r.xmin = Math.min(r.xmin, xOf[node]);
          r.xmax = Math.max(r.xmax, xOf[node]);
        }
      }
    }
  }
  return out;
}

function findFiles(dir, name, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

test('the mesh puts the BC on the face picked in the viewport of a two-body part', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(900_000);
  const { pid, q } = await setup(page, request, `e2e shared face mesh ${stamp()}`);
  const { id, bcs } = await inletOnFarEnd(page, request, q);
  await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces).toEqual([FAR_END]);
  const inlet = (await bcs()).find((b) => b.id === id);

  // A quick all-tet Standard mesh (no hex core, no layers), as a user sets it up.
  const study = page.locator('#left-tree [data-w17-sim="1"] > .tree-row').first();
  if ((await study.locator('.tw').textContent())?.trim() === '+') await study.locator('.tw').click();
  const meshFolder = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first();
  await expect(meshFolder).toBeVisible({ timeout: 15_000 });
  await meshFolder.locator('.tl').click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await form.locator('[data-schema-key="fineness"] input').fill('1');
  for (const label of ['Hex element core', 'Automatic boundary layers']) {
    const toggle = form.locator(`button[aria-label="${label}"]`);
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  }
  await form.locator('[data-mesh-generate="1"]').click();
  let final;
  await expect
    .poll(
      async () => {
        const r = await request.get(q('/api/case'));
        if (!r.ok()) return 'wait';
        final = await r.json();
        return final.status || final.live_mesh_result?.status || 'wait';
      },
      { timeout: 840_000, intervals: [5_000] },
    )
    .toMatch(/done|failed/);
  expect(final.status || final.live_mesh_result?.status, JSON.stringify(final.error || final.live_mesh_result?.error || '')).toBe('done');
  await expect(page.locator('#panel-mesh-form [data-mesh-status]')).toHaveAttribute('data-mesh-status', 'ready', { timeout: 60_000 });

  // The mesher's own surface mesh: the inlet's patch lies on x = 30 mm, the face the user
  // clicked, and the mesh the solver gets has that patch.
  const [msh] = findFiles(join(PROJECTS, pid), 'geometry.msh');
  expect(msh, 'the mesher wrote constant/triSurface/geometry.msh').toBeTruthy();
  const patches = patchX(msh);
  const name = Object.keys(patches).find((n) => n !== 'walls');
  expect(Object.keys(patches).sort(), `patches for ${inlet.name}`).toEqual([name, 'walls'].sort());
  expect(patches[name].xmin).toBeCloseTo(0.03, 9);
  expect(patches[name].xmax).toBeCloseTo(0.03, 9);
  const boundary = readFileSync(join(dirname(dirname(msh)), 'polyMesh', 'boundary'), 'utf8');
  const nFaces = boundary.match(new RegExp(`\\b${name}\\s*\\{[^}]*?nFaces\\s+(\\d+);`));
  expect(nFaces && Number(nFaces[1]), `${name} in polyMesh/boundary`).toBeGreaterThan(0);
});
