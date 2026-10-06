// Two geometries in one project, set up alike to compare them: the round-hole and the
// teardrop-hole test plates (same box, flow in one short end and out the other).
// Shared by the core's e2e/multi-geometry.spec.js (studies, switching, copies) and
// Incompressible Flow's multi-geometry-solve.spec.js (both meshed, solved and compared).
import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'python', 'tests', 'fixtures', 'geometry');
const ROUND = join(GEOM, 'transient-test.step');
const TEARDROP = join(GEOM, 'transient-test-teardrop.step');

export async function setup(page, request, title) {
  const t0 = Date.now();
  const stage = (msg) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${msg}`);
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) }).catch(() => {});
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(async (t) => {
    const out = await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
    return out && out.project && out.project.id;
  }, title);
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  const q = (path, extra = {}) =>
    `${path}?${new URLSearchParams({ project_id: pid, ...extra }).toString()}`;
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
  // The tree reads (GET /api/project/tree) the page has sent, and the ones still out (each by
  // its request: a read sent before these listeners only ends here, and is not counted).
  const treeReads = { sent: 0, open: new Set(), last: Date.now() };
  const isTreeRead = (r) => new URL(r.url()).pathname === '/api/project/tree';
  page.on('request', (r) => {
    if (!isTreeRead(r)) return;
    treeReads.sent += 1;
    treeReads.open.add(r);
    treeReads.last = Date.now();
  });
  const treeReadDone = (r) => {
    if (!isTreeRead(r)) return;
    treeReads.open.delete(r);
    treeReads.last = Date.now();
  };
  page.on('requestfinished', treeReadDone);
  page.on('requestfailed', treeReadDone);
  // Once no tree read is out and none has come or gone for a second: the count so far.
  const treeReadsSettled = async () => {
    await expect
      .poll(() => treeReads.open.size === 0 && Date.now() - treeReads.last > 1000, { timeout: 30_000 })
      .toBe(true);
    return treeReads.sent;
  };
  const shown = () => page.evaluate(() => window.__CFD_W16__?.geometry?.id || null);
  const study = () =>
    page.evaluate(() => {
      const s = window.__CFD_W17__;
      return { id: s?.activeId || null, geom: s?.simulation?.geometry_id || null };
    });

  // Import both plates: the second is added to the same project.
  for (const file of [ROUND, TEARDROP]) {
    const before = (await json(q('/api/project'))).project?.geometries?.length || 0;
    await page.locator('#geometry-file-input').setInputFiles(file);
    await expect
      .poll(async () => (await json(q('/api/project'))).project?.geometries?.length || 0, { timeout: 120_000 })
      .toBe(before + 1);
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  }
  const geoms = (await json(q('/api/project'))).project.geometries;
  const byName = (n) => geoms.find((g) => g.name === n);
  const round = byName('transient-test');
  const tear = byName('transient-test-teardrop');
  expect(round && tear, JSON.stringify(geoms.map((g) => g.name))).toBeTruthy();
  stage(`imported ${round.id} and ${tear.id}`);
  // The plates' ends: in at y = 0, out at y = 1500 mm. Face numbers differ per plate.
  const ends = async (gid) => {
    const meta = await json(q('/api/geometry/cad', { geometry_id: gid, part: 'preview' }));
    const near = (a, b) => Math.abs(a - b) < 0.5;
    const inlet = meta.faces.find((f) => near(f.centroid[1], 0) && near(f.normal[1], -1));
    const outlet = meta.faces.find((f) => near(f.centroid[1], 1500) && near(f.normal[1], 1));
    return { inlet: `face ${inlet.id}@Body1`, outlet: `face ${outlet.id}@Body1` };
  };
  round.ends = await ends(round.id);
  tear.ends = await ends(tear.id);
  expect(round.ends.inlet).not.toBe(tear.ends.inlet);
  const pickGeometry = async (g) => {
    await page.locator(`#geometries-list .geo-item[data-geom-id="${g.id}"]`).click();
    await expect.poll(shown, { timeout: 30_000 }).toBe(g.id);
  };
  // Switching is quick: the geometry and its own study (or none) within a moment.
  const timedSwitch = async (g) => {
    const t0 = Date.now();
    await page.locator(`#geometries-list .geo-item[data-geom-id="${g.id}"]`).click();
    await page
      .waitForFunction(
        (id) => {
          const sim = window.__CFD_W17__ && window.__CFD_W17__.simulation;
          return window.__CFD_W16__?.geometry?.id === id && (!sim || sim.geometry_id === id);
        },
        g.id,
        { timeout: 30_000 },
      )
      .catch(async (e) => {
        // Say what the page shows instead: which plate, and which study.
        const now = await page.evaluate(() => ({
          shown: window.__CFD_W16__?.geometry?.id || null,
          study: window.__CFD_W17__?.simulation?.id || null,
          studyGeometry: window.__CFD_W17__?.simulation?.geometry_id || null,
        }));
        throw new Error(`switch to ${g.name} (${g.id}) did not settle: ${JSON.stringify(now)}\n${e.message}`);
      });
    return Date.now() - t0;
  };
  return { pid, q, json, shown, study, stage, shot, round, tear, pickGeometry, timedSwitch, treeReadsSettled };
}

export async function createStudy(page, { geometryId, copyFrom } = {}) {
  await page.locator('#btn-create-simulation').click();
  const modal = page.locator('#modal-create-simulation');
  await expect(modal).toBeVisible();
  if (geometryId) await page.locator('#cs-geometry').selectOption(geometryId);
  if (copyFrom) await page.locator('#cs-copy-from').selectOption(copyFrom);
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
}

export async function addBc(page, json, url, { kind, face, value, unit }) {
  const saved = async () => (await json(url())).boundary_conditions || [];
  await page.locator('#btn-bcs-plus').click();
  const picker = page.locator('#panel-bc-picker .cfd-island');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-bc-key="${kind}"]`).click();
  await picker.locator('[data-bc-add="1"]').click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const name = ((await editor.locator('[data-bc-title="1"]').textContent()) || '').trim();
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await expect.poll(async () => (await saved()).some((b) => b.name === name), { timeout: 15_000 }).toBe(true);
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), face);
  await expect.poll(async () => ((await saved()).find((b) => b.name === name) || {}).faces || []).toEqual([face]);
  await page.evaluate(([bcId, v, u]) => window.__CFD_BC_UPDATE__(bcId, { value: v, unit: u }), [id, value, unit]);
  await expect.poll(async () => String(((await saved()).find((b) => b.name === name) || {}).value)).toBe(String(value));
  return { name, editor };
}

export async function addAir(page, json, url) {
  await page.locator('#left-tree #btn-materials-plus').first().click();
  const matPanel = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(matPanel).toBeVisible({ timeout: 15_000 });
  await matPanel.locator('[data-volume="Body1"] button').first().click();
  await expect
    .poll(async () => (((await json(url())).materials || []).find((m) => /air/i.test(String(m.name || ''))) || {}).assigned_volumes || [])
    .toEqual(['Body1']);
}
