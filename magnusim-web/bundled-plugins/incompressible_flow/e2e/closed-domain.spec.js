// A closed box driven by a moving wall (a lid-driven cavity, a stirred tank): nothing flows
// in or out, the lid alone moves the fluid. Validation set gap G1.
// - Its Run panel (fake compute: its own server with MAGNUSIM_TEST_COMPUTE=fake, the fake
//   mesher writing the facts of the box's real checkMesh report): Start is on and no reason
//   asks for an inlet or a pressure boundary; "Before you start" reads the lid's speed (Re on
//   the box's length along the lid) and says nothing of an inlet, a pressure boundary or a
//   flow-through; the run starts and ends, also after a reload. A transient study: its time
//   step is calculated from the lid's speed ("smallest cells at 2 m/s") and its hint asks for
//   no boundary conditions. A box whose only wall "moves" at 0 m/s is refused, and says why.
//   A lid whose velocity goes through its own face: Before you start says the solve would stop
//   on its first iteration (a continuity error nothing can flow out to remove), and why.
// - With WSL: the box is meshed and solved through the app; the run ends done and its point
//   probes read the lid's flow: along the lid near the top, back the other way below the
//   middle (the Graphs panel's Velocity X).
// Fails on the code before G1: the readiness check asked for "a velocity inlet or outlet, a
// freestream, or two pressure boundaries" (Start off), the transient preview had "no
// flow-driving boundary condition", and the SIMPLE/PIMPLE dictionaries had no pRefCell, so
// simpleFoam stopped with "Unable to set reference cell for field p".
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL, e2eTemp, expect, startHost, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..');
// A 100 mm cube from the origin; the lid is its top face (y = 100 mm, outward normal +y).
const BOX = join(HERE, 'fixtures', 'lid-box.step');
// The real checkMesh report of that box meshed on Hex-dominant at fineness 2 (the WSL test's mesh).
const CHECKMESH = join(HERE, 'fixtures', 'lid-box-checkmesh.log');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const STEP = { timeout: 30_000 };
const stamp = () => Date.now().toString(36);

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
 * A project with the box, an Incompressible Flow study (laminar), a fluid of kinematic
 * viscosity `nu` and two walls: "Lid" moving at `lid` m/s along `along` (x, or z: both lie
 * in the top face; y: through it) on the top face, and "Walls" No-slip on the other five. Its
 * ids, mesh and the lid's face.
 */
async function closedBox(request, base, { nu, lid, along = 'x', transient = false, title = 'Closed box' }) {
  const made = await postOk(request, `${base}/api/project`, {
    title: `${title} ${stamp()}`,
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
  // The app's own face table: the top face is the lid.
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
  const label = (f) => `face ${f.id}@Body1`;
  const top = faces.find((f) => Math.abs(f.centroid[1] - 100) < 0.5 && f.normal[1] > 0.5);
  expect(top, JSON.stringify(faces)).toBeTruthy();
  const others = faces.filter((f) => f !== top).map(label);
  const sim = await postOk(request, `${base}/api/simulation`, {
    project_id: pid,
    geometry_id: gid,
    analysis_type: transient ? 'incompressible_transient' : 'incompressible_steady',
    time_dependency: transient ? 'Transient' : 'Steady-state',
    activate: true,
  });
  const sid = String(sim.simulation?.id || sim.id);
  await postOk(request, `${base}/api/simulation/update`, { project_id: pid, simulation_id: sid, turbulence_model: 'laminar' });
  await postOk(request, `${base}/api/materials`, {
    project_id: pid,
    simulation_id: sid,
    preset: 'custom',
    name: 'Cavity fluid',
    kinematic_viscosity: nu,
    density: 1,
    assigned_volumes: ['Body1'],
  });
  const lidBc = await postOk(request, `${base}/api/bcs`, {
    project_id: pid,
    simulation_id: sid,
    geometry_id: gid,
    name: 'Lid',
    bc_type: 'Wall',
    wall_type: 'Moving',
    // Along x or z: in the top face. Along y: straight through it.
    wall_velocity: along === 'z' ? [0, 0, lid] : along === 'y' ? [0, lid, 0] : [lid, 0, 0],
    faces: [label(top)],
  });
  await postOk(request, `${base}/api/bcs`, {
    project_id: pid,
    simulation_id: sid,
    geometry_id: gid,
    name: 'Walls',
    bc_type: 'Wall',
    wall_type: 'No-slip',
    faces: others,
  });
  const stored = (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  expect(stored.map((b) => [b.name, b.wall_type])).toEqual([
    ['Lid', 'Moving'],
    ['Walls', 'No-slip'],
  ]);
  const meshes = (await json(request, q('/api/mesh', { simulation_id: sid }))).meshes || [];
  let mid = meshes[0] && meshes[0].id ? String(meshes[0].id) : '';
  if (!mid) mid = String((await postOk(request, `${base}/api/mesh`, { project_id: pid, simulation_id: sid, create: true, name: 'Mesh 1' })).mesh.id);
  return { pid, sid, gid, mid, q, lidId: String(lidBc.bc?.id || lidBc.id || ''), lidFace: `Face ${top.id}@Body1` };
}

/** Generate the box's mesh and wait for it (`timeout` ms). */
async function generate(request, base, s, timeout) {
  const gen = await request.post(`${base}/api/mesh/generate`, {
    data: { project_id: s.pid, simulation_id: s.sid, mesh_id: s.mid, queue_if_busy: true },
  });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  let end = 'wait';
  await expect
    .poll(
      async () => {
        const live = (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh?.live_mesh_result || {};
        end = /done|failed|stopped/.test(String(live.status)) ? `${live.status} ${JSON.stringify(live.error || '')}` : 'wait';
        return end;
      },
      { timeout, intervals: [2_000] },
    )
    .not.toBe('wait');
  expect(end).toBe('done ""');
}

async function newRun(request, base, s, name, extra = {}) {
  const made = await postOk(request, `${base}/api/run/create`, { project_id: s.pid, simulation_id: s.sid, name, mesh_id: s.mid });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  if (Object.keys(extra).length) await postOk(request, `${base}/api/run/update`, { project_id: s.pid, simulation_id: s.sid, run_id: rid, ...extra });
  return rid;
}

const runRow = async (request, s, rid) =>
  ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((r) => String(r.id) === rid) || {};

/** Open run `rid`'s panel from the study's tree, after a reload (as e2e/support/compute-slot.js openRunPanel). */
async function openRunPanel(page, base, s, rid) {
  await page.goto(`${base}/#/p/${encodeURIComponent(s.pid)}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, s.pid, { timeout: 90_000 });
  const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const folder = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] li[data-w27-sim-control="1"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  // The run's readiness answer (GET /api/run/ready, asked once the run is selected): Start is
  // read after it, never in the moment before it lands.
  const answered = page.waitForResponse((r) => r.url().includes('/api/run/ready?') && new URL(r.url()).searchParams.get('run_id') === rid, {
    timeout: 60_000,
  });
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    (id) => document.querySelector('#panel-sim-control [data-run-control="1"]')?.getAttribute('data-run-id') === id,
    rid,
    { timeout: 30_000 },
  );
  await answered;
  return panel;
}

// What the readiness, Before you start and the transient hint must not speak of in a closed box.
// (The Stop when settled row's hint, "Add a monitor (Monitors +) or an inlet or outlet to stop
// on.", lists what a stop can read; it claims nothing about this box.)
const FALSE_FOR_A_CLOSED_BOX = /inlet|outlet|pressure boundar|freestream|flow-through/i;

test.describe('a closed box driven by its lid (fake compute)', () => {
  test.describe.configure({ mode: 'serial' });
  let host;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('if-closed-box');
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    host = await startHost({
      name: 'if-closed-box',
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

  test('a steady study: Start is on, Before you start reads the lid, and the run starts and ends', async ({ page, request }) => {
    test.setTimeout(300_000);
    // Re = U L / nu = 2 m/s x 0.1 m / 2e-3 m^2/s = 100.
    const s = await closedBox(request, host.base, { nu: 2e-3, lid: 2 });
    await generate(request, host.base, s, 120_000);
    const rid = await newRun(request, host.base, s, 'Lid run', { endTime: 400, writeInterval: 400 });
    // The readiness the panel and the Assistant read: nothing blocks it.
    const ready = await json(request, s.q('/api/run/ready', { simulation_id: s.sid, run_id: rid, mesh_id: s.mid }));
    expect(ready.issues || [], JSON.stringify(ready)).toEqual([]);

    const panel = await openRunPanel(page, host.base, s, rid);
    const start = panel.locator('[data-run-start="1"]');
    await expect(start).toBeEnabled(STEP);
    await expect(panel.locator('[data-run-reason="1"]')).toHaveCount(0);
    // Before you start: the lid's Reynolds number, nothing of an inlet or a pressure boundary.
    const check = panel.locator('[data-run-check="1"]');
    const line = check.locator('[data-run-check-estimate="1"]');
    await expect(line).toContainText('400 iterations at most', STEP);
    await expect(line).toContainText('Re ≈ 100');
    await expect(check).not.toContainText(FALSE_FOR_A_CLOSED_BOX);
    await expect(panel.locator('[data-run-numerics="1"]')).not.toContainText(FALSE_FOR_A_CLOSED_BOX);
    // The lid slides along its face: nothing says it moves through it.
    await expect(check.locator('[data-run-check-row="wall_through"]')).toHaveCount(0);

    await start.click();
    await expect.poll(async () => (await runRow(request, s, rid)).status, { timeout: 120_000 }).toBe('done');
    await expect(panel.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done', { timeout: 60_000 });
    // After a reload too.
    const again = await openRunPanel(page, host.base, s, rid);
    await expect(again.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done', STEP);
    // A finished run's panel says it is finished; nothing asks for an inlet or a pressure boundary.
    await expect(again).not.toContainText(/Add a velocity inlet|Add a pressure boundary/);
  });

  test("a transient study: the time step is calculated from the lid's speed, and nothing asks for an inlet", async ({ page, request }) => {
    test.setTimeout(300_000);
    // The lid slides along z here: the fake mesher's one-cell mesh has a Courant rate along z only.
    const s = await closedBox(request, host.base, { nu: 2e-3, lid: 2, along: 'z', transient: true, title: 'Closed box transient' });
    await generate(request, host.base, s, 120_000);
    const rid = await newRun(request, host.base, s, 'Lid transient', {
      transient: { end_time: 1, write_count: 10, time_step_mode: 'adjustable', max_co: 1, n_outer_correctors: 1, n_correctors: 2 },
    });
    const panel = await openRunPanel(page, host.base, s, rid);
    await expect(panel.locator('[data-run-start="1"]')).toBeEnabled(STEP);
    await expect(panel.locator('[data-run-reason="1"]')).toHaveCount(0);
    const line = panel.locator('[data-run-check="1"] [data-run-check-estimate="1"]');
    // The Courant estimate at the lid's 2 m/s, not the 1 m/s a case without a speed gets.
    await expect(line).toContainText('smallest cells at 2 m/s', STEP);
    await expect(line).toContainText('Re ≈ 100');
    const hint = panel.locator('[data-run-transient-hint="1"]');
    await expect(hint).toContainText('starting Δt ≈', STEP);
    await expect(hint).not.toContainText('Assign a mesh and boundary conditions');
    await expect(hint).not.toContainText(FALSE_FOR_A_CLOSED_BOX);
    await expect(panel.locator('[data-run-check="1"]')).not.toContainText(FALSE_FOR_A_CLOSED_BOX);
    // The preview the hint is made from: whole (not "no flow-driving boundary condition"), at
    // the lid's speed, and no flow-through time for a domain nothing flows through.
    const preview = await postOk(request, `${host.base}/api/run/transient-preview`, { project_id: s.pid, simulation_id: s.sid, run_id: rid });
    expect([preview.partial, preview.reason ?? null], JSON.stringify(preview).slice(0, 400)).toEqual([false, null]);
    expect(preview.control.estimate.u_ref).toBe(2);
    expect(preview.control.estimate.flow_through_s).toBeNull();
  });

  test('a lid that moves through its own face: Before you start says the solve would stop at once, and why', async ({ page, request }) => {
    test.setTimeout(300_000);
    // Before G1 this box was refused (no inlet); after it, Start was on with nothing said, and
    // simpleFoam stopped on its first iteration ("Continuity error cannot be removed").
    const s = await closedBox(request, host.base, { nu: 2e-3, lid: 2, along: 'y', title: 'Closed box lid through' });
    await generate(request, host.base, s, 120_000);
    const rid = await newRun(request, host.base, s, 'Lid through', { endTime: 400, writeInterval: 400 });
    const panel = await openRunPanel(page, host.base, s, rid);
    const row = panel.locator('[data-run-check="1"] [data-run-check-row="wall_through"]');
    await expect(row).toContainText(
      `Wall "Lid" moves through its own faces (${s.lidFace}): its velocity (0, 2, 0) m/s has a part across them. Nothing flows in or out of this box, so the solver stops on its first iteration ("Continuity error cannot be removed by adjusting the outflow"). Give it a velocity along the wall.`,
      STEP,
    );
    await expect(row).toHaveAttribute('data-level', 'error');
  });

  test('a box whose only moving wall stands still is refused, and the reason says why', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await closedBox(request, host.base, { nu: 2e-3, lid: 0, title: 'Closed box still lid' });
    await generate(request, host.base, s, 120_000);
    const rid = await newRun(request, host.base, s, 'Still lid');
    const panel = await openRunPanel(page, host.base, s, rid);
    await expect(panel.locator('[data-run-start="1"]')).toBeDisabled(STEP);
    await expect(panel.locator('[data-run-reason="1"]')).toContainText(
      'Wall "Lid" does not move (its velocity is 0), so nothing drives the flow. Give it a velocity, or add an inlet and an outlet.',
      STEP,
    );
  });
});

test('WSL: the lid drives the flow in the closed box; the run solves and its probes read the circulation', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_200_000);
  page.setDefaultTimeout(60_000);
  // Re 100: lid 1 m/s, box 0.1 m, nu 1e-3.
  const s = await closedBox(request, '', { nu: 1e-3, lid: 1, title: 'Closed box WSL' });
  // Hex-dominant at fineness 2, no layers: a coarse mesh of the cube.
  await postOk(request, '/api/mesh', {
    project_id: s.pid,
    simulation_id: s.sid,
    mesh_id: s.mid,
    fineness: 2,
    automatic_boundary_layers: false,
    physics_based_meshing: true,
    hex_element_core: true,
    advanced: { mesh_engine: 'snappy_hexdominant' },
  });
  await generate(request, '', s, 900_000);
  const live = (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh.live_mesh_result;
  console.log(`[closed box wsl] mesh: ${live.n_cells} cells`);
  // Two probes on the box's vertical centre line (metres): 0.9 L (under the lid) and 0.3 L.
  const probe = {
    id: 'rc-centre',
    name: 'Centre line',
    monitor_type: 'probe',
    kind: 'Point probe',
    category: 'Point data',
    write_control: 'Time step',
    faces: [],
    results: null,
    series: null,
    chart_values: null,
    results_available: false,
    points: [
      [0.05, 0.03, 0.05],
      [0.05, 0.09, 0.05],
    ],
  };
  const rid = await newRun(request, '', s, 'Lid', { endTime: 1500, writeInterval: 1500, cores: 4, result_controls: [probe] });
  const panel = await openRunPanel(page, '', s, rid);
  const start = panel.locator('[data-run-start="1"]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await expect(panel.locator('[data-run-reason="1"]')).toHaveCount(0);
  await start.click();
  let end = 'wait';
  await expect
    .poll(
      async () => {
        const r = await runRow(request, s, rid);
        end = /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${JSON.stringify(r.error || '')}` : 'wait';
        return end;
      },
      { timeout: 1_000_000, intervals: [10_000] },
    )
    .not.toBe('wait');
  expect(end).toBe('done ""');
  // The case it solved: the pressure reference a closed domain needs.
  const row = await runRow(request, s, rid);
  console.log(`[closed box wsl] run done at iteration ${row.iteration}`);
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  const keys = (answer.custom || []).map((m) => m.key);
  expect(keys).toEqual(['probes_centre_line_1', 'probes_centre_line_2']);

  // The Graphs panel: each probe point's Velocity X, as a person reads it.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, s.pid, { timeout: 90_000 });
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"]`).first();
  const runLi = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  const folder = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) await runLi.locator(':scope > .tree-row .tw').click();
  const graphsRow = page.locator(`[data-w28-key="media:run:${rid}:graphs"] > .tree-row`).first();
  if (!(await graphsRow.isVisible())) await results.locator(':scope > .tree-row .tw').click();
  await graphsRow.click();
  const velocityX = async (key) => {
    const card = page.locator(`#run-graphs-custom-cards .mon-card[data-monitor-key="${key}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.locator('[data-mon-qty]').selectOption({ label: 'Velocity X' });
    const text = (await card.locator('.mon-card-last').textContent()) || '';
    const v = Number(text.replace(/[^0-9eE+\-.]/g, ''));
    expect(Number.isFinite(v), text).toBe(true);
    return v;
  };
  const low = await velocityX('probes_centre_line_1');
  const high = await velocityX('probes_centre_line_2');
  console.log(`[closed box wsl] Ux at 0.3 L: ${low} m/s, at 0.9 L: ${high} m/s`);
  // Under the lid the fluid goes with it; below the middle it comes back.
  expect(high).toBeGreaterThan(0.1);
  expect(low).toBeLessThan(-0.05);
});
