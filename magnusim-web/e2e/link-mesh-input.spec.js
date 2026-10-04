import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { NO_WSL } from './toolchain.js';

// gate:l4-mesh-input, the e2e half (LINK proposal revision 7, 5.9 and section 9 L4; the
// meshing session's conditions 1 and 3), with a real Hex-dominant mesh in WSL (local tier,
// MAGNUSIM_E2E_WSL=1, under the PC's WSL test lock), on link-demo's geometry:
//   - Generate on a linked geometry: the server builds no Body1.stl; the mesh panel shows
//     "Building the mesh input…" while the mesh job's prepare_input builds it (held there
//     by MAGNUSIM_TEST_PREPARE_INPUT_PAUSE); then the mesh is made (ready); Body1.json
//     records the link's shape hash and cad_quality, and the mesh record the file's hash
//     from the generator;
//   - Generate again: the input is current, prepare_input does not run (the hold file is
//     back, so a run would wait), Body1.stl is untouched; a names-only update keeps it;
//   - a shape update (v2), the server killed during its follow-ups, a new server on the
//     same projects: Generate builds the input in the mesh job, at the --cad-quality
//     triangle count (byte for byte what convert_step_to_stl.py --cad-quality writes),
//     with no synchronous convert on the server.

const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const EXPORTS = resolve('python/tests/fixtures/link-plugins/link-demo/workspace/exports');
const PYTHON = resolve('python/.venv/Scripts/python.exe');
const SHOTS = process.env.MAGNUSIM_L4_SHOTS || '';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function stage(t0, msg) {
  console.log(`[link-mesh-input +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

async function link(request, host, { pid, sid }, version, sourceVersion, basedOnRev, names) {
  const files = {};
  for (const [as, file] of [
    ['shape.bin', `${version}.bbrep`],
    ['names.json', names || `${version}.face_names.json`],
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

async function until(request, host, scope, jobId, ms = 600_000) {
  let j = null;
  await expect
    .poll(async () => ((j = await job(request, host, scope, jobId)) && ['done', 'failed', 'busy', 'gone', 'stale', 'cancelled'].includes(j.status) ? j.status : 'waiting'), {
      timeout: ms,
      intervals: [500],
    })
    .not.toBe('waiting');
  return j;
}

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

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

test.describe('the mesh input of a linked geometry (gate:l4-mesh-input)', () => {
  test('prepare_input builds it in the mesh job and shows in the mesh panel; current inputs are kept; after a kill and a shape change it is built at CAD quality', async ({ page, request }, testInfo) => {
    test.skip(!WSL, NO_WSL);
    test.setTimeout(3_600_000);
    page.setDefaultTimeout(30_000);
    const t1 = Date.now();
    const projects = join(e2eTemp('l4-projects'), 'projects');
    mkdirSync(projects, { recursive: true });
    const holdDir = e2eTemp('l4-hold');
    const hold = join(holdDir, 'hold');
    const start = async (name, env = {}) => {
      const tmp = e2eTemp(name);
      return startHost({ name, tmp, projects, seed: false, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/link-plugins', env });
    };
    let host = await start('l4-mesh-input', { MAGNUSIM_TEST_PREPARE_INPUT_PAUSE: hold });
    try {
      const p = await request.post(`${host.base}/api/project`, { data: { title: 'Link mesh input', folder: 'My Projects', units: 'Metric', category: 'Other' } });
      const pid = (await p.json()).id;
      const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo', kind: 'demo', title: 'Demo 1' } });
      const scope = { pid, sid: (await s.json()).study.id };
      const first = await link(request, host, scope, 'v1', 1, null);
      expect((await until(request, host, scope, first.job_id)).status).toBe('done');
      const gid = first.geometry_id;
      const dir = geomDir(projects, pid, gid);
      const body1 = join(dir, 'Body1.stl');
      const q = (path, extra = {}) => `${host.base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
      const sim = (await (await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid, name: 'Study 1' } })).json()).simulation.id;
      for (const [name, type, faces] of [
        ['Inlet', 'Velocity inlet', ['face 1@Body1', 'face 4@Body1']],
        ['Outlet', 'Pressure', ['face 6@Body1', 'face 14@Body1']],
      ]) {
        const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim, name, bc_type: type, faces, geometry_rev: 1 } });
        expect(r.ok(), await r.text()).toBe(true);
      }
      await page.goto(`${host.base}/#/p/${pid}`);
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
      await page.locator(`#geometries-list .geo-item[data-geom-id="${gid}"]`).click();
      await page.waitForFunction((id) => window.__CFD_W16__?.geometry?.id === id, gid);
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
      const layers = form.locator('button[aria-label="Automatic boundary layers"]');
      if ((await layers.count()) && (await layers.getAttribute('aria-pressed')) === 'true') await layers.click();
      const meshRec = async () => (await getJson(request, q('/api/mesh', { simulation_id: sim, mesh_id: mid }))).mesh || {};
      stage(t1, `Demo 1 (${gid}) linked; Hex-dominant mesh ${mid}`);

      // Generate, held in prepare_input: the panel says so; no file yet.
      writeFileSync(hold, 'hold');
      expect(existsSync(body1)).toBe(false);
      await form.locator('[data-mesh-generate="1"]').click();
      const status = page.locator('#panel-mesh-form [data-mesh-status]');
      await expect(status).toHaveAttribute('data-mesh-status', 'generating', { timeout: 120_000 });
      const line = page.locator('#panel-mesh-form [data-mesh-status="generating"] .mesh-finished-line');
      await expect(line).toHaveText('Building the mesh input…', { timeout: 60_000 });
      expect(existsSync(body1), 'the server built no input').toBe(false);
      await page.screenshot({ path: testInfo.outputPath('l4-building-mesh-input.png') });
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, 'l4-building-mesh-input.png') });
      }
      stage(t1, 'the panel shows "Building the mesh input…"');
      rmSync(hold);
      await expect(line).not.toHaveText('Building the mesh input…', { timeout: 120_000 });
      await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_800_000 });
      const live = (await meshRec()).live_mesh_result || {};
      expect(await status.getAttribute('data-mesh-status'), JSON.stringify(live.error || '')).toBe('ready');
      const state = json(join(dir, 'link', 'state.json'));
      const meta = json(join(dir, 'Body1.json'));
      expect([meta.cad_quality, meta.shape_sha256, meta.prepared_by]).toEqual([true, state.shape_sha256, 'prepare_input']);
      const bytes = readFileSync(body1);
      expect(live.geometry.body1_sha256, 'the generator reports the file it built').toBe(sha256(bytes));
      expect([live.geometry.input_shape_sha256, live.geometry.input_deferred, live.geometry.mesh_input_built]).toEqual([state.shape_sha256, true, true]);
      stage(t1, 'mesh ready; Body1.json names the shape');

      // Generate again: current, so no prepare_input (the hold is back: a run would wait).
      writeFileSync(hold, 'hold');
      const stamp = statSync(body1).mtimeMs;
      const again = await request.post(`${host.base}/api/mesh/generate`, { data: { project_id: pid, simulation_id: sim, mesh_id: mid } });
      expect(again.status(), await again.text()).toBeLessThan(300);
      await expect.poll(async () => (await meshRec()).live_mesh_result?.status, { timeout: 1_800_000, intervals: [2_000] }).toMatch(/done|failed/);
      const live2 = (await meshRec()).live_mesh_result || {};
      expect(live2.status, JSON.stringify(live2.error || '')).toBe('done');
      // The generator found it current: it reports the file's hash, and built nothing.
      expect([live2.geometry.mesh_input_built, live2.geometry.input_deferred, live2.geometry.body1_sha256]).toEqual([false, false, sha256(bytes)]);
      expect(statSync(body1).mtimeMs).toBe(stamp);
      rmSync(hold);
      // A names-only update keeps the shape, so the input stays current.
      const names = await link(request, host, scope, 'v1', 2, 1, 'v1-renamed.face_names.json');
      const nj = names.job_id ? await until(request, host, scope, names.job_id) : names;
      expect(nj.result?.change || nj.change).toBe('names');
      expect(json(join(dir, 'link', 'state.json')).shape_sha256).toBe(meta.shape_sha256);
      expect(readFileSync(body1)).toEqual(bytes);
      stage(t1, 'a current input kept (Generate again, names-only update)');

      // v2 (a shape change, answered "Overwrite"); the server killed in its follow-ups.
      const v2 = await link(request, host, scope, 'v2', 3, 2);
      if (v2.choosing) {
        const c = await request.post(`${host.base}/api/plugin-geometry/choose`, { data: { project_id: pid, plugin: 'link-demo', study_id: scope.sid, job_id: v2.job_id, choice: 'overwrite', copy: [] } });
        expect(c.status(), await c.text()).toBeLessThan(300);
      }
      let seen = '';
      await expect
        .poll(async () => {
          const j = await job(request, host, scope, v2.job_id);
          seen = `${j && j.status}/${j && j.stage}`;
          return j && (j.stage === 'finishing' || j.status === 'done') ? 'there' : 'not yet';
        }, { timeout: 600_000, intervals: [100] })
        .toBe('there');
      host.stop();
      stage(t1, `server killed at ${seen}`);
      expect(existsSync(body1), "v1's input went with v1").toBe(false);
      host = await start('l4-mesh-input-2');
      const st2 = json(join(dir, 'link', 'state.json'));
      expect([st2.rev > state.rev, st2.shape_sha256 !== state.shape_sha256]).toEqual([true, true]);
      const gen = await request.post(`${host.base}/api/mesh/generate`, { data: { project_id: pid, simulation_id: sim, mesh_id: mid } });
      const gj = await gen.json();
      expect(gen.status(), JSON.stringify(gj)).toBeLessThan(300);
      expect(existsSync(body1), 'no synchronous convert on the server').toBe(false);
      await expect.poll(async () => (await meshRec()).live_mesh_result?.status, { timeout: 1_800_000, intervals: [2_000] }).toMatch(/done|failed/);
      const live3 = (await meshRec()).live_mesh_result || {};
      expect(live3.status, JSON.stringify(live3.error || '')).toBe('done');
      const meta3 = json(join(dir, 'Body1.json'));
      expect([meta3.prepared_by, meta3.shape_sha256, meta3.cad_quality]).toEqual(['prepare_input', st2.shape_sha256, true]);
      // At the --cad-quality count: what the CLI writes for this shape, byte for byte.
      const cli = join(holdDir, 'cli.stl');
      const r = spawnSync(PYTHON, ['tools/convert_step_to_stl.py', '--step', join(dir, 'source.step'), '--out', cli, '--cad-quality'], { cwd: resolve('python'), encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(body1).equals(readFileSync(cli))).toBe(true);
      expect(meta3.bounds.ntri).toBe(json(cli.replace(/\.stl$/, '.json')).bounds.ntri);
      stage(t1, 'after the restart: built in the mesh job at CAD quality');
    } catch (e) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' }).catch(() => {});
      throw e;
    } finally {
      host.stop();
    }
  });
});
