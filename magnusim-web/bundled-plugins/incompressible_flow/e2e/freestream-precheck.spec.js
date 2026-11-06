// A body in one Freestream (the validation set's cylinder and sphere): the stream's speed is
// the case's, also at 1 m/s and below, and Re is on the study's reference length (the body's).
// - Fake compute (its own server, MAGNUSIM_TEST_COMPUTE=fake: the fake mesher writes the box's
//   real checkMesh report and a one-cell mesh with a Courant rate along z): a transient study of
//   a box whose six faces are one Freestream of 1 m/s along +z, reference length 10 mm, nu 1e-3:
//   Before you start reads "smallest cells at 1 m/s" with a time step, and "Re ≈ 10"; at 0.5 m/s
//   "smallest cells at 0.5 m/s" and "Re ≈ 5". A steady study reads "Re ≈ 10" too.
// Fails on the code before: the stream's speed was taken only above 1 m/s, so the line read "No
// time-step estimate: no inlet speed or pressure difference sets a flow speed", with no Re, and
// below 1 m/s the case (and a blank reference speed, so the force coefficients) used 1 m/s.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eTemp, expect, startHost, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..');
// A 100 mm cube from the origin.
const BOX = join(HERE, 'fixtures', 'lid-box.step');
// The real checkMesh report of that box meshed on Hex-dominant at fineness 2.
const CHECKMESH = join(HERE, 'fixtures', 'lid-box-checkmesh.log');
const STEP = { timeout: 30_000 };
const stamp = () => Date.now().toString(36);
const NO_SPEED = 'no inlet speed or pressure difference sets a flow speed';

/** GET json; a poll can reuse a keep-alive socket just as the server closes it, so retry that. */
async function json(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

async function postOk(request, url, data) {
  const r = await request.post(url, { data });
  const body = await r.json().catch(() => ({}));
  expect(r.ok(), `${url}: ${r.status()} ${JSON.stringify(body).slice(0, 400)}`).toBe(true);
  return body;
}

/**
 * A project with the box, an Incompressible Flow study (laminar, reference length 10 mm), a
 * fluid of kinematic viscosity 1e-3 m²/s and one Freestream "Far" of `speed` m/s along +z on all
 * six faces, its mesh generated (fake). Its ids.
 */
async function streamBox(request, base, { speed, transient }) {
  const made = await postOk(request, `${base}/api/project`, {
    title: `Freestream box ${stamp()}`,
    description: '',
    category: 'Other',
    units: 'Metric',
    folder: 'My Projects',
  });
  const pid = String(made.id || made.project?.id);
  const q = (path, extra = {}) => `${base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const imported = await request.post(q('/api/geometry/import', { filename: 'lid-box.step' }), {
    data: readFileSync(BOX),
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 300_000,
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const imp = await imported.json();
  const gid = String(imp.active_geometry_id || imp.geometry?.id || imp.added?.id);
  let faces = [];
  await expect
    .poll(
      async () => {
        const r = await request.get(q('/api/geometry/cad', { geometry_id: gid, part: 'meta' }));
        faces = r.status() === 200 ? (await r.json()).faces || [] : [];
        return faces.length;
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(6);
  const sim = await postOk(request, `${base}/api/simulation`, {
    project_id: pid,
    geometry_id: gid,
    analysis_type: transient ? 'incompressible_transient' : 'incompressible_steady',
    time_dependency: transient ? 'Transient' : 'Steady-state',
    activate: true,
  });
  const sid = String(sim.simulation?.id || sim.id);
  await postOk(request, `${base}/api/simulation/update`, { project_id: pid, simulation_id: sid, turbulence_model: 'laminar', ref_length: 0.01 });
  await postOk(request, `${base}/api/materials`, {
    project_id: pid,
    simulation_id: sid,
    preset: 'custom',
    name: 'Stream fluid',
    kinematic_viscosity: 1e-3,
    density: 1,
    assigned_volumes: ['Body1'],
  });
  await postOk(request, `${base}/api/bcs`, {
    project_id: pid,
    simulation_id: sid,
    geometry_id: gid,
    name: 'Far',
    bc_type: 'Freestream',
    velocity_input: 'Speed and direction',
    value: speed,
    unit: 'm/s',
    vector: [0, 0, 1],
    freestream_pressure: 0,
    faces: faces.map((f) => `face ${f.id}@Body1`),
  });
  const meshes = (await json(request, q('/api/mesh', { simulation_id: sid }))).meshes || [];
  let mid = meshes[0] && meshes[0].id ? String(meshes[0].id) : '';
  if (!mid) mid = String((await postOk(request, `${base}/api/mesh`, { project_id: pid, simulation_id: sid, create: true, name: 'Mesh 1' })).mesh.id);
  const gen = await request.post(`${base}/api/mesh/generate`, { data: { project_id: pid, simulation_id: sid, mesh_id: mid, queue_if_busy: true } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  let end = 'wait';
  await expect
    .poll(
      async () => {
        const live = (await json(request, q('/api/mesh', { simulation_id: sid, mesh_id: mid }))).mesh?.live_mesh_result || {};
        end = /done|failed|stopped/.test(String(live.status)) ? `${live.status} ${JSON.stringify(live.error || '')}` : 'wait';
        return end;
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .not.toBe('wait');
  expect(end).toBe('done ""');
  const run = await postOk(request, `${base}/api/run/create`, { project_id: pid, simulation_id: sid, name: 'Stream run', mesh_id: mid });
  const rid = String(run.run_id || run.run?.id || run.run?.run_id);
  const extra = transient
    ? { transient: { end_time: 1, write_count: 10, time_step_mode: 'adjustable', max_co: 1, n_outer_correctors: 1, n_correctors: 2 } }
    : { endTime: 400, writeInterval: 400 };
  await postOk(request, `${base}/api/run/update`, { project_id: pid, simulation_id: sid, run_id: rid, ...extra });
  return { pid, sid, gid, mid, rid, q };
}

/** Open run `rid`'s panel from the study's tree, after a reload. */
async function openRunPanel(page, base, s) {
  await page.goto(`${base}/#/p/${encodeURIComponent(s.pid)}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, s.pid, { timeout: 90_000 });
  const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const folder = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] li[data-w27-sim-control="1"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  const answered = page.waitForResponse((r) => r.url().includes('/api/run/ready?') && new URL(r.url()).searchParams.get('run_id') === s.rid, {
    timeout: 60_000,
  });
  await page.locator(`#left-tree [data-w27-run="${s.rid}"] > .tree-row .tl`).first().click();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    (id) => document.querySelector('#panel-sim-control [data-run-control="1"]')?.getAttribute('data-run-id') === id,
    s.rid,
    { timeout: 30_000 },
  );
  await answered;
  return panel;
}

test.describe('a body in one Freestream: Before you start (fake compute)', () => {
  test.describe.configure({ mode: 'serial' });
  let host;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('if-freestream-check');
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    host = await startHost({
      name: 'if-freestream-check',
      tmp,
      projects,
      env: {
        MAGNUSIM_TEST_COMPUTE: 'fake',
        MAGNUSIM_TEST_MESH_SECONDS: '1',
        MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
        MAGNUSIM_TEST_SOLVE_SECONDS: '3',
        PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
      },
    });
  });

  test.afterAll(() => host?.stop());

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  for (const [speed, re] of [
    [1, '10'],
    [0.5, '5'],
  ]) {
    test(`a transient study in a ${speed} m/s stream: a time step from its speed, and Re on the reference length`, async ({ page, request }) => {
      test.setTimeout(300_000);
      const s = await streamBox(request, host.base, { speed, transient: true });
      const panel = await openRunPanel(page, host.base, s);
      const line = panel.locator('[data-run-check="1"] [data-run-check-estimate="1"]');
      await expect(line).toContainText(`smallest cells at ${speed} m/s`, STEP);
      await expect(line).toContainText(/Δt ≈ \S+ s/);
      await expect(line).toContainText(`Re ≈ ${re}`);
      await expect(line).not.toContainText(NO_SPEED);
      // The same check the Assistant reads (the panel's route), and the case's own speed.
      const pre = await postOk(request, `${host.base}/api/run/precheck`, { project_id: s.pid, simulation_id: s.sid, run_id: s.rid });
      const est = pre.estimate || pre.check?.estimate || {};
      expect([est.speed, est.re], JSON.stringify(pre).slice(0, 600)).toEqual([speed, Number(re)]);
      const preview = await postOk(request, `${host.base}/api/run/transient-preview`, { project_id: s.pid, simulation_id: s.sid, run_id: s.rid });
      expect(preview.control.estimate.u_ref).toBe(speed);
    });
  }

  test('a steady study in a 1 m/s stream: Re on the reference length', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await streamBox(request, host.base, { speed: 1, transient: false });
    const panel = await openRunPanel(page, host.base, s);
    const line = panel.locator('[data-run-check="1"] [data-run-check-estimate="1"]');
    await expect(line).toContainText('400 iterations at most', STEP);
    await expect(line).toContainText('Re ≈ 10');
  });
});
