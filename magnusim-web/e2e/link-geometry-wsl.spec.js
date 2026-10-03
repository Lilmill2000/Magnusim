import { expect, test } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { NO_WSL } from './toolchain.js';

// gate:l2-wsl, linked geometries (host API 1.5) with a real mesher and solver in WSL (the
// local tier: MAGNUSIM_E2E_WSL=1, under the PC's WSL test lock). With the test plugin
// link-demo (python/tests/fixtures/link-plugins) and Incompressible Flow:
//   - a real Hex-dominant mesh on a linked geometry; v2 linked while it meshes and answered
//     "Overwrite": the update waits in the Queue for the mesh;
//   - "Save as new" of another linked geometry while that mesh runs lands at once;
//   - the mesh ends out of date ("Out of date" in the tree), its Body1.stl gone with v1;
//     Start is refused ("Generate Mesh 1 again first"); Generate again rebuilds Body1.stl
//     for v2; Start runs to the end;
//   - D26: once v3 lands, that run is on an older geometry: its results view's particle
//     trace says so and its face seeds and highlights are off.

const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const EXPORTS = resolve('python/tests/fixtures/link-plugins/link-demo/workspace/exports');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function stage(t0, msg) {
  console.log(`[link-geometry-wsl +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

/** The plugin writes its export into its study's folder, then links it; the route's answer. */
async function link(request, host, { pid, sid }, version, sourceVersion, basedOnRev) {
  const files = {};
  for (const [as, file] of [
    ['shape.bin', `${version}.bbrep`],
    ['names.json', `${version}.face_names.json`],
  ]) {
    const rel = `studies/${sid}/exports/${as}`;
    const dest = join(host.projects, pid, 'plugins', 'link-demo', rel);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = readFileSync(join(EXPORTS, file));
    writeFileSync(dest, buf);
    files[as] = { rel, sha256: sha256(buf) };
  }
  const r = await request.post(`${host.base}/api/plugin-geometry/link`, {
    data: { project_id: pid, plugin: 'link-demo', study_id: sid, shape: { ...files['shape.bin'], format: 'brep' }, face_names: files['names.json'], source_version: sourceVersion, based_on_rev: basedOnRev },
  });
  const body = await r.json();
  expect(r.status(), JSON.stringify(body)).toBeLessThan(300);
  return body;
}

async function job(request, host, { pid, sid }, jobId) {
  return (await getJson(request, `${host.base}/api/plugin-geometry/status?project_id=${pid}&plugin=link-demo&study_id=${sid}&job_id=${jobId}`)).job;
}

async function until(request, host, scope, jobId, ms = 1_800_000) {
  let j = null;
  await expect
    .poll(async () => ((j = await job(request, host, scope, jobId)) && ['done', 'failed', 'busy', 'gone', 'stale', 'cancelled'].includes(j.status) ? j.status : 'waiting'), {
      timeout: ms,
      intervals: [1000],
    })
    .not.toBe('waiting');
  return j;
}

async function choose(request, host, { pid, sid }, jobId, choice) {
  const r = await request.post(`${host.base}/api/plugin-geometry/choose`, { data: { project_id: pid, plugin: 'link-demo', study_id: sid, job_id: jobId, choice, copy: [] } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

/** Link a design with a shape change on a geometry in use: the host asks; answer it. */
async function linkAnswered(request, host, scope, version, sv, based, choice) {
  const asked = await link(request, host, scope, version, sv, based);
  expect(asked.choosing, JSON.stringify(asked)).toBeTruthy();
  await choose(request, host, scope, asked.job_id, choice);
  return asked.job_id;
}

async function demoStudy(request, host, pid, title) {
  const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo', kind: 'demo', title } });
  const j = await s.json();
  expect(s.ok(), JSON.stringify(j)).toBe(true);
  return { pid, sid: j.study.id };
}

async function bc(request, host, pid, sim, name, bcType, faces, rev) {
  const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim, name, bc_type: bcType, faces, geometry_rev: rev } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.bc.id;
}

/** A geometry's folder by its id. */
function geomDir(projects, pid, gid) {
  const root = join(projects, pid, 'geometries');
  for (const name of readdirSync(root)) {
    try {
      if (JSON.parse(readFileSync(join(root, name, 'id.json'), 'utf8')).id === gid) return join(root, name);
    } catch {
      /* not a geometry */
    }
  }
  throw new Error(`no geometry folder ${gid}`);
}

test.describe('linked geometries with a real mesher and solver (gate:l2-wsl)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.skip(!WSL, NO_WSL);
    test.setTimeout(240_000);
    const tmp = e2eTemp('link-wsl');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({ name: 'link-wsl', tmp, projects, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/link-plugins' });
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-wsl Hex-dominant on a linked geometry: an overwrite waits for the mesh, Save as new does not; out of date, Start refused, Generate again, Start runs; D26 in the results view', async ({ page, request }, testInfo) => {
    test.skip(!WSL, NO_WSL);
    test.setTimeout(3_600_000);
    page.setDefaultTimeout(30_000);
    const t1 = Date.now();
    const p = await request.post(`${host.base}/api/project`, { data: { title: 'Link WSL', folder: 'My Projects', units: 'Metric', category: 'Other' } });
    const pid = (await p.json()).id;
    const a = await demoStudy(request, host, pid, 'Demo 1');
    const b = await demoStudy(request, host, pid, 'Demo 2');
    const firstA = await link(request, host, a, 'v1', 1, null);
    const firstB = await link(request, host, b, 'v1', 1, null);
    expect((await until(request, host, a, firstA.job_id)).status).toBe('done');
    expect((await until(request, host, b, firstB.job_id)).status).toBe('done');
    const gid = firstA.geometry_id;
    const gidB = firstB.geometry_id;
    const q = (path, extra = {}) => `${host.base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
    // Demo 2's geometry in use too (a study with a BC), so its next shape asks.
    const simB = (await (await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gidB, name: 'Study B' } })).json()).simulation.id;
    await bc(request, host, pid, simB, 'Wall B', 'Wall', ['face 12@Body1'], 1);

    // Study 1 on Demo 1: the inlet on both halves of -x (v1 faces 1 and 4; v2 face 1), the
    // outlet on both halves of +x (6 and 14; v2 face 10).
    const sim = (await (await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid, name: 'Study 1' } })).json()).simulation.id;
    await bc(request, host, pid, sim, 'Inlet', 'Velocity inlet', ['face 1@Body1', 'face 4@Body1'], 1);
    await bc(request, host, pid, sim, 'Outlet', 'Pressure', ['face 6@Body1', 'face 14@Body1'], 1);
    const mat = await request.post(`${host.base}/api/materials`, { data: { project_id: pid, simulation_id: sim, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 } });
    expect(mat.ok(), await mat.text()).toBe(true);
    await page.goto(`${host.base}/#/p/${pid}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await page.locator(`#geometries-list .geo-item[data-geom-id="${gid}"]`).click();
    await page.waitForFunction((id) => window.__CFD_W16__?.geometry?.id === id, gid);
    stage(t1, `Demo 1 (${gid}) and Demo 2 (${gidB}) linked and in use`);

    // A Hex-dominant mesh, fineness 8 (it runs long enough to link twice meanwhile), no layers: Generate.
    const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row`).first();
    if ((await studyRow.locator('.tw').textContent())?.trim() === '+') await studyRow.locator('.tw').click();
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
    const form = page.locator('#panel-mesh-form .cfd-island');
    await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
    const mid = await page.evaluate(() => window.__CFD_W20__.active_id);
    await form.locator('details.mesh-advanced > summary').click();
    await form.locator('select[data-mesh-engine="1"]').selectOption('snappy_hexdominant');
    await expect.poll(async () => (await getJson(request, q('/api/mesh', { simulation_id: sim, mesh_id: mid }))).mesh?.settings?.advanced?.mesh_engine).toBe('snappy_hexdominant');
    await form.locator('[data-schema-key="fineness"] input').fill('8');
    await form.locator('[data-schema-key="fineness"] input').press('Tab');
    await expect.poll(async () => (await getJson(request, q('/api/mesh', { simulation_id: sim, mesh_id: mid }))).mesh?.settings?.fineness).toBe(8);
    const layers = form.locator('button[aria-label="Automatic boundary layers"]');
    if ((await layers.count()) && (await layers.getAttribute('aria-pressed')) === 'true') await layers.click();
    await form.locator('[data-mesh-generate="1"]').click();
    const status = page.locator('#panel-mesh-form [data-mesh-status]');
    await expect(status).toHaveAttribute('data-mesh-status', 'generating', { timeout: 120_000 });
    const meshRunning = async () => (await status.getAttribute('data-mesh-status')) === 'generating';
    stage(t1, 'Hex-dominant mesh generating');

    // v2 while it meshes, answered "Overwrite": the update waits in the Queue.
    const upd = await linkAnswered(request, host, a, 'v2', 2, 1, 'overwrite');
    await expect.poll(async () => (await job(request, host, a, upd)).status, { timeout: 30_000 }).toBe('queued');
    const geomRow = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
    await expect(geomRow.locator('[data-geom-link-status]')).toHaveText('Queued', { timeout: 30_000 });
    // "Save as new" of Demo 2 while the mesh runs: it needs no slot and lands at once.
    const asNew = await linkAnswered(request, host, b, 'v2', 2, 1, 'new');
    const made = await until(request, host, b, asNew, 300_000);
    expect([made.status, made.result && made.result.created]).toEqual(['done', true]);
    expect(await meshRunning(), 'the mesh was still running when Save as new landed').toBe(true);
    expect((await job(request, host, a, upd)).status, 'the overwrite still waits').toBe('queued');
    stage(t1, 'overwrite queued, Save as new landed, mesh still running');

    // The mesh finishes on v1; then the overwrite runs.
    await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_800_000 });
    const rec = (await getJson(request, q('/api/mesh', { simulation_id: sim, mesh_id: mid }))).mesh || {};
    expect(await status.getAttribute('data-mesh-status'), JSON.stringify(rec.live_mesh_result?.error || '')).toBe('ready');
    const body1 = join(geomDir(host.projects, pid, gid), 'Body1.stl');
    expect(existsSync(body1), 'the mesh input made from v1').toBe(true);
    const done = await until(request, host, a, upd);
    expect([done.status, done.result.rev, done.result.change]).toEqual(['done', 2, 'shape']);
    const updatedAt = Date.now();
    stage(t1, 'mesh done on v1, then v2 landed');

    // Out of date; its Body1.stl went with v1.
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    const meshRow = page.locator(`#left-tree [data-w20-mesh-item="${mid}"] > .tree-row`);
    await expect(meshRow.locator('[data-mesh-out-of-date]')).toHaveText('Out of date', { timeout: 60_000 });
    expect(existsSync(body1), "v1's mesh input is not left for v2").toBe(false);

    // Start on it is refused, in the run panel.
    const runMade = await request.post(`${host.base}/api/run/create`, { data: { project_id: pid, simulation_id: sim, name: 'Run 1', mesh_id: mid } });
    const rj = await runMade.json();
    expect(runMade.ok(), JSON.stringify(rj)).toBe(true);
    const rid = String(rj.run_id || (rj.run && (rj.run.id || rj.run.run_id)));
    const set = await request.post(`${host.base}/api/run/update`, { data: { project_id: pid, simulation_id: sim, run_id: rid, endTime: 5, writeInterval: 5, geometry_rev: 2 } });
    expect(set.ok(), await set.text()).toBe(true);
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    const openRun = async () => {
      const folder = page.locator(`#left-tree [data-w17-sim-id="${sim}"] li[data-w27-sim-control="1"]`).first();
      if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
      await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
      await expect(runPanel).toHaveAttribute('data-run-id', rid, { timeout: 15_000 });
    };
    await openRun();
    // Start is on (else the poll shows the panel's reason), and the server refuses it.
    await expect
      .poll(async () => ((await runPanel.locator('[data-run-start]').isEnabled()) ? 'enabled' : await runPanel.textContent()), { timeout: 60_000 })
      .toBe('enabled');
    await runPanel.locator('[data-run-start]').click();
    await expect(runPanel).toContainText('Generate Mesh 1 again first. It was made from an older version of Demo 1.', { timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath('start-refused.png') }).catch(() => {});
    stage(t1, 'Start refused on the out-of-date mesh');

    // Generate again: Body1.stl is made for v2, the mesh is current.
    await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), mid);
    await form.locator('[data-mesh-generate="1"]').click();
    await expect(status).toHaveAttribute('data-mesh-status', 'generating', { timeout: 120_000 });
    await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_800_000 });
    expect(await status.getAttribute('data-mesh-status')).toBe('ready');
    expect(existsSync(body1), 'Generate rebuilt the mesh input').toBe(true);
    expect(statSync(body1).mtimeMs).toBeGreaterThan(updatedAt);
    await expect(meshRow.locator('[data-mesh-out-of-date]')).toHaveCount(0, { timeout: 60_000 });
    stage(t1, 'regenerated on v2');

    // Start runs to its end.
    await openRun();
    await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 30_000 });
    await runPanel.locator('[data-run-start]').click();
    const runRow = async () => ((await getJson(request, q('/api/run/status', { simulation_id: sim }))).runs || []).find((r) => String(r.id) === rid) || {};
    await expect
      .poll(async () => {
        const st = (await runRow()).status || 'none';
        return /done|failed|stopped/.test(st) ? st : 'running';
      }, { timeout: 1_800_000, intervals: [3_000] })
      .toBe('done');
    stage(t1, 'the run on v2 is done');

    // D26: v3 lands; the run is on an older geometry. Its results view's particle trace
    // says so, and its face seeds and highlights are off.
    const v3 = await linkAnswered(request, host, a, 'v3', 3, 2, 'overwrite');
    expect((await until(request, host, a, v3)).status).toBe('done');
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await expect(page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row [data-run-older-geometry]`)).toHaveText('Older geometry', { timeout: 60_000 });
    await openRun();
    const runLi = page.locator(`#left-tree [data-w27-run="${rid}"]`).first();
    if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) await runLi.locator(':scope > .tree-row .tw').click();
    await page.locator(`[data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    // The case is attached (its parts and legend are in) before the particle trace.
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 300_000 });
    await page.locator('.tb-btn[data-label="Particle Trace"]').click();
    await expect(page.locator('#pt-block')).toBeVisible({ timeout: 60_000 });
    const older = 'This run was made on an older version of Demo 1. Face seeds and highlights are off for it.';
    await expect(page.locator('#pt-older-geometry')).toHaveText(older, { timeout: 30_000 });
    await expect(page.locator('#pt-older-geometry')).toBeVisible();
    await expect(page.locator('#pt-highlight-openings')).toBeDisabled();
    await expect(page.locator('#pt-clear-assign')).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('older-run-particle-trace.png') }).catch(() => {});
    stage(t1, 'done');
  });
});
