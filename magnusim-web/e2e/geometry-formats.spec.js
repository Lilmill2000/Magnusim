import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every extension the Add geometry picker lists must import, show its faces, and
// (with WSL) mesh. Fixtures come from python/tools/gen_geometry_fixtures.py: the
// same vortex part written once per format (304.8 x 304.8 x 812.8 mm).
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const FORMATS = ['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', 'ply'];
const MESH_KINDS = new Set(['stl', 'obj', 'ply']);
// One mesh per loader: .stp/.igs/.brp read through the same code as .step/.iges/.brep.
const MESHED = new Set(['step', 'iges', 'brep', 'stl', 'obj', 'ply']);
const REPR = {
  step: 'STEP (CAD)',
  stp: 'STEP (CAD)',
  iges: 'IGES (CAD)',
  igs: 'IGES (CAD)',
  brep: 'BREP (CAD)',
  brp: 'BREP (CAD)',
  stl: 'STL (mm)',
  obj: 'OBJ (mm)',
  ply: 'PLY (mm)',
};

test('the picker lists exactly the formats this spec covers', async ({ page }) => {
  await page.goto('/#/');
  await page.waitForFunction(() => !!document.getElementById('geometry-file-input'));
  const accept = await page.locator('#geometry-file-input').getAttribute('accept');
  const listed = String(accept)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'))
    .map((s) => s.slice(1));
  expect(listed.sort()).toEqual([...FORMATS].sort());
});

for (const ext of FORMATS) {
  const meshes = WSL && MESHED.has(ext);
  test(`.${ext} imports, shows its faces${meshes ? ' and meshes' : ''}`, async ({ page, request }) => {
    test.setTimeout(meshes ? 600_000 : 150_000);
    await page.goto('/#/');
    await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
    const pid = await page.evaluate(async (title) => {
      const out = await window.__CFD_W16_CREATE__({ title, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
      return out && out.project && out.project.id;
    }, `e2e format ${ext}`);
    expect(pid).toBeTruthy();
    await page.goto(`/#/p/${encodeURIComponent(pid)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });

    // The picked file goes up as raw bytes, never as base64 inside JSON.
    const uploads = [];
    page.on('request', (r) => {
      if (/\/api\/geometry\/import/.test(r.url())) uploads.push(r.headers()['content-type'] || '');
    });
    await page.locator('#geometry-file-input').setInputFiles(join(FIXTURES, `elbow.${ext}`));
    if (MESH_KINDS.has(ext)) {
      // Mesh files carry no length unit; the app asks, and these fixtures are in mm.
      await expect(page.locator('#gu-unit')).toBeVisible({ timeout: 15_000 });
      await page.locator('#gu-unit').selectOption('MM');
      await page.locator('#gu-import').click();
    }
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#left-tree')).toContainText('elbow');
    expect(uploads).toEqual(['application/octet-stream']);

    const meta = await (await request.get(`/api/geometry/cad?project_id=${encodeURIComponent(pid)}&part=preview`)).json();
    expect(meta.n_solids).toBe(1);
    expect(meta.faces.length).toBeGreaterThan(0);
    if (MESH_KINDS.has(ext)) {
      // Facets are grouped into surfaces: 4,004 triangles, 10 selectable faces.
      expect(meta.n_display_tris).toBe(4004);
      expect(meta.faces.length).toBe(10);
    }
    const b = meta.bounds;
    const scale = meta.faces_length_unit === 'm' ? 1000 : 1;
    expect((b.zmax - b.zmin) * scale).toBeCloseTo(812.8, 0);
    expect((b.xmax - b.xmin) * scale).toBeCloseTo(304.8, 0);
    const faces = await request.get(`/api/geometry/cad?project_id=${encodeURIComponent(pid)}&part=faces`);
    expect(faces.ok()).toBeTruthy();
    expect((await faces.body()).length).toBeGreaterThan(1000);

    // The Geometry panel names the format the way V0.1.0 did.
    await page.locator('#geometries-list .geo-item[data-geom-id]').first().click();
    const geo = page.locator('#panel-geometry .cfd-island');
    await expect(geo).toBeVisible({ timeout: 15_000 });
    await expect(geo.locator('[data-geometry-repr]')).toHaveText(REPR[ext]);
    await expect(geo.locator('[data-geometry-volume]')).toHaveText('Body1');

    if (ext === 'brp') {
      // Delete asks first, then removes the geometry and its viewport faces.
      await geo.getByRole('button', { name: 'Delete' }).click();
      const confirm = page.locator('#modal-confirm');
      await expect(confirm).toContainText('Remove this geometry?');
      await confirm.getByRole('button', { name: 'Remove' }).click();
      await expect(page.locator('#geometries-list .geo-item[data-geom-id]')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('#btn-create-simulation')).toBeHidden();
      return;
    }
    await geo.getByRole('button', { name: 'Done' }).click();

    if (!meshes) return;
    await page.locator('#btn-create-simulation').click();
    await page.locator('#cs-create').click();
    await expect(page.locator('#panel-sim-control .cfd-island [data-run-control="1"]')).toBeVisible({ timeout: 30_000 });
    // A new study lands on Run 1 with the study folded; unfold it and the Mesh folder like a user.
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
          const r = await request.get(`/api/case?project_id=${encodeURIComponent(pid)}`);
          if (!r.ok()) return 'wait';
          final = await r.json();
          return final.status || final.live_mesh_result?.status || 'wait';
        },
        { timeout: 540_000 },
      )
      .toMatch(/done|failed/);
    const status = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(status, JSON.stringify(final.error || final.live_mesh_result?.error || '')).toBe('done');
    expect(nCells).toBeGreaterThan(0);
    await expect(page.locator('#panel-mesh-form [data-mesh-status]')).toHaveAttribute('data-mesh-status', 'ready', { timeout: 60_000 });
  });
}

test('an STL over the old 2 MB upload cap imports (raw bytes, no base64)', async ({ page, request }) => {
  test.setTimeout(240_000);
  // Closed 100 mm box, each side a 40 x 40 grid: 19,200 triangles, ~4.5 MB ASCII.
  const n = 40;
  const lines = ['solid box'];
  const quad = (a, b, c, d) => {
    for (const t of [[a, b, c], [a, c, d]]) {
      lines.push('facet normal 0 0 0', 'outer loop', ...t.map((p) => `vertex ${p[0]} ${p[1]} ${p[2]}`), 'endloop', 'endfacet');
    }
  };
  const s = 100 / n;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const u0 = i * s, u1 = (i + 1) * s, v0 = j * s, v1 = (j + 1) * s;
      quad([u0, v0, 0], [u0, v1, 0], [u1, v1, 0], [u1, v0, 0]); // z = 0, outward -z
      quad([u0, v0, 100], [u1, v0, 100], [u1, v1, 100], [u0, v1, 100]); // z = 100
      quad([u0, 0, v0], [u1, 0, v0], [u1, 0, v1], [u0, 0, v1]); // y = 0
      quad([u0, 100, v0], [u0, 100, v1], [u1, 100, v1], [u1, 100, v0]); // y = 100
      quad([0, u0, v0], [0, u0, v1], [0, u1, v1], [0, u1, v0]); // x = 0
      quad([100, u0, v0], [100, u1, v0], [100, u1, v1], [100, u0, v1]); // x = 100
    }
  }
  lines.push('endsolid box');
  const file = join(mkdtempSync(join(tmpdir(), 'magnusim-e2e-')), 'big-box.stl');
  writeFileSync(file, `${lines.join('\n')}\n`);

  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(async () => {
    const out = await window.__CFD_W16_CREATE__({ title: 'e2e big stl', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
    return out && out.project && out.project.id;
  });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  const uploads = [];
  page.on('request', (r) => {
    if (/\/api\/geometry\/import/.test(r.url())) uploads.push(r.headers()['content-type'] || '');
  });
  await page.locator('#geometry-file-input').setInputFiles(file);
  await page.locator('#gu-unit').selectOption('MM');
  await page.locator('#gu-import').click();
  // The user can see an import is running.
  await expect(page.locator('#btn-import-geometry')).toHaveText('Importing…');
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 200_000 });
  expect(uploads).toEqual(['application/octet-stream']);
  const meta = await (await request.get(`/api/geometry/cad?project_id=${encodeURIComponent(pid)}&part=preview`)).json();
  expect(meta.n_solids).toBe(1);
  expect(meta.bounds.xmax - meta.bounds.xmin).toBeCloseTo(100, 0);
});

test('a file that cannot be read says so instead of failing silently', async ({ page }) => {
  test.setTimeout(120_000);
  const file = join(mkdtempSync(join(tmpdir(), 'magnusim-e2e-')), 'broken.step');
  writeFileSync(file, 'this is not a STEP file, just text pretending to be one\n'.repeat(4));
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(async () => {
    const out = await window.__CFD_W16_CREATE__({ title: 'e2e broken file', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
    return out && out.project && out.project.id;
  });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(file);
  const dialog = page.locator('#modal-confirm');
  await expect(dialog).toContainText('Could not import broken.step', { timeout: 90_000 });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeHidden();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#btn-import-geometry')).toBeEnabled();
  await expect(page.locator('#btn-create-simulation')).toBeHidden();
});
