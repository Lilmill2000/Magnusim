// One cell across (2D), a Hex-dominant mesh setting (the validation set's gap G5; Daniel's yes on
// 2026-11-05): a slab (a straight extrusion between two flat end faces with a Symmetry boundary
// condition) is meshed one cell deep, an exact 2D flow at a fraction of the cells.
// - Fake compute (its own server, MAGNUSIM_TEST_COMPUTE=fake: the fake mesher asks the same rule
//   as the real one, tools/mesh_two_d.py): the Hex-dominant Mesh panel offers "One cell across
//   (2D)", Standard does not; turned on it is saved (the mesh's mesher_settings) and still on after
//   a reload. On the slab whose two end faces carry no Symmetry the note under it says why it
//   can't be meshed so, and Generate fails with that reason. On the slab with a Symmetry on both
//   ends the note says how (10 mm deep along z, between its two end faces, the Symmetry's name),
//   and the generated mesh's summary says "one cell across (2D)", after a reload too. Before you
//   start reads Re on the 2D channel's hydraulic diameter (twice the inlet's height, not the
//   circle of its area, which grows with the depth), and says when the ends lost their Symmetry:
//   another BC on them, or none (its BC deleted: then they are solved as the walls with no BC are).
//   The slab as a tunnel round its hole (the cylinder, D 10 mm) at nu 2e-5: Re on the channel's
//   2h with no reference length ("Re ≈ 5,000", turbulent for a channel), and on the study's
//   reference length once it sets one ("Re ≈ 500", no turbulent row: it read "Re ≈ 5,000 is
//   turbulent; a laminar model will not settle" there too, its fix a turbulence model).
// - The Assistant changes the ends' BC while the Mesh panel is open: the note under the setting
//   follows at once (the frame's kind is 'bcs'; the panel listened for 'bc' and kept the old note).
// - The Assistant (a scripted model, through the dock): sets it with setup_edit (the panel shows
//   it on without a reload) and reads the note's answer with read_setup mesh, word for word.
// - With WSL: the slab is meshed one cell across for real (every point on one of its two end
//   planes, checkMesh's 2D check OK in the panel's quality line) and a laminar run on it, started
//   from its Run panel, solves with its two ends empty (nothing solved across the depth): it
//   stops on its residual targets before its limit (the tree's Converged), and Run health finds
//   no stalled residual. As mirror planes the depth's velocity was solved too: its residual
//   stayed at round-off (0.035 to 0.068 in the validation set's cavity), so a steady run never
//   met its targets and Run health said the U residual had stopped falling.
// Fails on the code before G5: Hex-dominant had no such setting (the panel has no such row).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';
import { NO_WSL } from './toolchain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
// A channel 100 x 50 mm, 10 mm deep along z (z = 0 to 10), with a 10 mm hole through it at (30, 25).
const SLAB = join(HERE, 'fixtures', 'slab-2d.step');
// The real v2606 checkMesh report of that slab meshed one cell across (its 2D check): the fake
// mesher writes the mesh's facts from it, as the real one does.
const CHECKMESH_2D = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'one-cell-across-2d.log');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const STEP = { timeout: 30_000 };
const stamp = () => Date.now().toString(36);
const NO_SYMMETRY = "No boundary condition is a Symmetry. Put one Symmetry on the two parallel flat faces at the part's ends (its front and back).";

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
 * The slab in a project of its own: an Incompressible Flow study (laminar), a fluid of
 * kinematic viscosity `nu` (5e-4 m²/s: Re 20 on the hole at 1 m/s), an inlet at x = 0, an outlet at
 * x = 100 mm, and its two end faces (z = 0 and z = 10 mm) on a Symmetry "Sides" (`symmetry`)
 * or on the walls with the rest. Its mesh is Hex-dominant at `fineness`, no boundary layers.
 */
async function slabStudy(request, base, { symmetry, title, fineness = 3, nu = 5e-4 }) {
  const made = await postOk(request, `${base}/api/project`, { title: `${title} ${stamp()}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
  const pid = String(made.id || made.project?.id);
  const q = (path, extra = {}) => `${base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const imported = await request.post(q('/api/geometry/import', { filename: 'slab-2d.step' }), {
    data: readFileSync(SLAB),
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
    .toBe(7);
  const label = (f) => `face ${f.id}@Body1`;
  const at = (k, v) => faces.filter((f) => Math.abs(f.centroid[k] - v) < 0.01 && Math.abs(f.normal?.[k] ?? 0) > 0.99);
  const [front, back, inlet, outlet] = [at(2, 0), at(2, 10), at(0, 0), at(0, 100)];
  expect([front, back, inlet, outlet].map((x) => x.length), JSON.stringify(faces)).toEqual([1, 1, 1, 1]);
  const ends = [front[0], back[0]];
  const named = new Set([...ends, inlet[0], outlet[0]]);
  const rest = faces.filter((f) => !named.has(f));
  const sim = await postOk(request, `${base}/api/simulation`, { project_id: pid, geometry_id: gid, analysis_type: 'incompressible_steady', time_dependency: 'Steady-state', activate: true });
  const sid = String(sim.simulation?.id || sim.id);
  await postOk(request, `${base}/api/simulation/update`, { project_id: pid, simulation_id: sid, turbulence_model: 'laminar' });
  await postOk(request, `${base}/api/materials`, { project_id: pid, simulation_id: sid, preset: 'custom', name: 'Slab fluid', kinematic_viscosity: nu, density: 1, assigned_volumes: ['Body1'] });
  const bc = (data) => postOk(request, `${base}/api/bcs`, { project_id: pid, simulation_id: sid, geometry_id: gid, ...data });
  await bc({ name: 'Inlet', bc_type: 'Velocity inlet', velocity_type: 'Fixed', value: 1, unit: 'm/s', direction: 'Normal to face', faces: [label(inlet[0])] });
  await bc({ name: 'Outlet', bc_type: 'Pressure', pressure_type: 'Fixed value', value: 0, unit: 'Pa', faces: [label(outlet[0])] });
  const sides = symmetry ? await bc({ name: 'Sides', bc_type: 'Symmetry', faces: ends.map(label) }) : null;
  await bc({ name: 'Walls', bc_type: 'Wall', wall_type: 'No-slip', faces: (symmetry ? rest : [...rest, ...ends]).map(label) });
  const meshes = (await json(request, q('/api/mesh', { simulation_id: sid }))).meshes || [];
  let mid = meshes[0] && meshes[0].id ? String(meshes[0].id) : '';
  if (!mid) mid = String((await postOk(request, `${base}/api/mesh`, { project_id: pid, simulation_id: sid, create: true, name: 'Mesh 1' })).mesh.id);
  await postOk(request, `${base}/api/mesh`, {
    project_id: pid,
    simulation_id: sid,
    mesh_id: mid,
    fineness,
    automatic_boundary_layers: false,
    physics_based_meshing: true,
    advanced: { mesh_engine: 'snappy_hexdominant' },
  });
  return {
    pid,
    sid,
    gid,
    mid,
    q,
    front: `Face ${front[0].id}@Body1`,
    back: `Face ${back[0].id}@Body1`,
    ends: ends.map(label),
    outlet: label(outlet[0]),
    outletFace: `Face ${outlet[0].id}@Body1`,
    sidesId: sides ? String(sides.bc?.id || sides.id || '') : '',
  };
}

const meshRecord = async (request, s) => (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh || {};

async function openMeshPanel(page, base, s) {
  await page.goto(`${base}/#/p/${encodeURIComponent(s.pid)}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, s.pid, { timeout: 90_000 });
  await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), s.mid);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible(STEP);
  return form;
}

const field = (form) => form.locator('[data-schema-key="one_cell_across"]');
const toggleOf = (form) => field(form).locator('button.mesh-toggle');
const noteOf = (form) => form.locator('[data-schema-note="one_cell_across"]');

test.describe('One cell across (2D) (fake compute)', () => {
  test.describe.configure({ mode: 'serial' });
  let host;
  let fake;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fake = await startFakeLlm();
    const tmp = e2eTemp('mesh-2d');
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    host = await startHost({
      name: 'mesh-2d',
      tmp,
      projects,
      env: {
        MAGNUSIM_TEST_COMPUTE: 'fake',
        MAGNUSIM_TEST_MESH_SECONDS: '1',
        MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH_2D,
        MAGNUSIM_TEST_ASSISTANT: '1',
        MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
        MAGNUSIM_TEST_EVENT_HUB: '1',
        // This checkout's cfddesk and SDK for the tools the routes run (the venv may name another).
        PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
      },
    });
  });

  test.afterAll(async () => {
    host?.stop();
    if (fake) await fake.stop();
  });

  test.beforeEach(async ({ page, request }) => {
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await request.post(`${host.base}/api/test/assistant/reset`, { data: {} });
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(() => {
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  test('the slab without a Symmetry on its ends: the setting is saved, the note says why, Generate refuses with the reason', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await slabStudy(request, host.base, { symmetry: false, title: 'Slab no symmetry' });
    let form = await openMeshPanel(page, host.base, s);
    await expect(field(form)).toContainText('One cell across (2D)', STEP);
    await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'false');
    await expect(noteOf(form)).toHaveCount(0);
    await toggleOf(form).click();
    await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await meshRecord(request, s)).settings?.mesher_settings?.one_cell_across, STEP).toBe(true);
    const note = noteOf(form).locator('[data-mesh-two-d="unavailable"]');
    await expect(note).toHaveText(`Not available on this part: ${NO_SYMMETRY} Generate refuses until it is.`, STEP);

    await form.locator('[data-mesh-generate="1"]').click();
    const failed = form.locator('[data-mesh-status="failed"] .mesh-finished-line');
    await expect(failed).toHaveText(`One cell across (2D) can't mesh this part: ${NO_SYMMETRY} Or turn One cell across off.`, { timeout: 120_000 });
    const live = (await meshRecord(request, s)).live_mesh_result || {};
    expect([live.status, live.one_cell_across ?? null]).toEqual(['failed', null]);

    // After a reload: still on, and the note again.
    form = await openMeshPanel(page, host.base, s);
    await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'true', STEP);
    await expect(noteOf(form).locator('[data-mesh-two-d="unavailable"]')).toContainText(NO_SYMMETRY, STEP);

    // Standard has no such setting (the engine is picked under Advanced settings).
    await form.locator('details.mesh-advanced > summary').click();
    await form.locator('[data-mesh-engine="1"]').selectOption('standard');
    await expect(field(form)).toHaveCount(0, STEP);
    await expect.poll(async () => (await meshRecord(request, s)).settings?.advanced?.mesh_engine, STEP).toBe('standard');
  });

  test('the slab with a Symmetry on both ends: the Assistant turns it on and reads the note; the 2D mesh says one cell across', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await slabStudy(request, host.base, { symmetry: true, title: 'Slab symmetry' });
    const form = await openMeshPanel(page, host.base, s);
    await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'false', STEP);
    const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
    const seen = {};
    fake.reply(
      { tools: [{ name: 'setup_edit', input: setup({ kind: 'mesh', action: 'update', id: s.mid, values: [{ key: 'mesher_settings.one_cell_across', value: 'true' }] }) }] },
      (body) => {
        seen.edit = resultsIn(body)[0];
        return { tools: [{ name: 'read_setup', input: { project_id: '', simulation_id: '', what: 'mesh', id: s.mid, other_id: '', page: 0 } }] };
      },
      (body) => {
        seen.read = resultsIn(body)[0];
        return { text: 'One cell across is on.' };
      },
    );
    await openDock(page);
    await dockSend(page, 'Mesh this slab one cell across.');
    const card = dockGate(page);
    const ended = dockTurn(page).locator('[data-turn-end="done"]');
    for (let i = 0; i < 3; i++) {
      await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
      if (await ended.isVisible()) break;
      await card.locator('[data-gate-answer="yes"]').click(STEP);
    }
    await expect(ended).toBeVisible({ timeout: 60_000 });
    expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    expect((await meshRecord(request, s)).settings?.mesher_settings?.one_cell_across).toBe(true);
    // The panel shows it on, without a reload, and says how the part is meshed.
    await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'true', STEP);
    const how = `2D: one cell across, 10 mm deep along z, between ${s.front} and ${s.back} (Symmetry "Sides").`;
    await expect(noteOf(form).locator('[data-mesh-two-d="available"]')).toHaveText(how, STEP);
    // The Assistant read the same answer, word for word.
    expect(seen.read.ok, JSON.stringify(seen.read)).toBe(true);
    expect(seen.read.data.settings['mesher_settings.one_cell_across']).toBe(true);
    expect(seen.read.data.two_d).toEqual({
      available: true,
      axis: 'z',
      depth_m: 0.01,
      cells_across: 1,
      front: { faces: [s.front], bc: 'Sides' },
      back: { faces: [s.back], bc: 'Sides' },
      note: how,
    });

    await form.locator('[data-mesh-generate="1"]').click();
    const meta = form.locator('[data-mesh-status="ready"] .mesh-finished-meta');
    await expect(meta).toContainText('Hex-dominant · one cell across (2D)', { timeout: 120_000 });
    const live = (await meshRecord(request, s)).live_mesh_result || {};
    expect([live.status, live.one_cell_across, live.two_d?.axis, live.two_d?.cells_across]).toEqual(['done', true, 'z', 1]);
    const again = await openMeshPanel(page, host.base, s);
    await expect(again.locator('[data-mesh-status="ready"] .mesh-finished-meta')).toContainText('one cell across (2D)', STEP);

    // A run on it: Before you start says nothing of its ends while they are a Symmetry; once
    // their BC is a wall the solve would not be 2D, and it says so.
    const made = await postOk(request, `${host.base}/api/run/create`, { project_id: s.pid, simulation_id: s.sid, name: 'Slab 2D', mesh_id: s.mid });
    const rid = String(made.run_id || made.run?.id || made.run?.run_id);
    let panel = await openRunPanel(page, { base: host.base, projectId: s.pid, simulationId: s.sid, runId: rid });
    const check = panel.locator('[data-run-check="1"]');
    await expect(check.locator('[data-run-check-estimate="1"]')).toBeVisible(STEP);
    await expect(check.locator('[data-run-check-row="two_d_ends"]')).toHaveCount(0);
    // Re on a 2D channel's hydraulic diameter, twice the inlet's 50 mm height: 1 m/s x 0.1 m /
    // 5e-4 m²/s = 200 (the circle of the inlet's 50 x 10 mm read "Re ≈ 50", and more on a deeper slab).
    await expect(check.locator('[data-run-check-estimate="1"]')).toContainText('Re ≈ 200');
    await postOk(request, `${host.base}/api/bcs`, { project_id: s.pid, simulation_id: s.sid, geometry_id: s.gid, id: s.sidesId, name: 'Sides', bc_type: 'Wall', wall_type: 'No-slip', faces: s.ends });
    panel = await openRunPanel(page, { base: host.base, projectId: s.pid, simulationId: s.sid, runId: rid });
    const row = panel.locator('[data-run-check="1"] [data-run-check-row="two_d_ends"]');
    await expect(row).toContainText(
      `This mesh is one cell across (2D), but its end faces (${s.front}, ${s.back}) now have "Sides", not a Symmetry, so the flow would not be 2D. Put a Symmetry back on them, or turn One cell across off and generate the mesh again.`,
      STEP,
    );
    await expect(row).toHaveAttribute('data-level', 'error');
    // Their BC deleted: no BC holds the ends, so the solve treats them as the walls with no BC are.
    await postOk(request, `${host.base}/api/bcs`, { project_id: s.pid, simulation_id: s.sid, delete: true, id: s.sidesId });
    panel = await openRunPanel(page, { base: host.base, projectId: s.pid, simulationId: s.sid, runId: rid });
    const gone = panel.locator('[data-run-check="1"] [data-run-check-row="two_d_ends"]');
    await expect(gone).toContainText(
      `This mesh is one cell across (2D), but its end faces (${s.front}, ${s.back}) now have no boundary condition, so the solve treats them as No-slip walls (the walls with no BC) and the flow would not be 2D. Put a Symmetry back on them, or turn One cell across off and generate the mesh again.`,
      STEP,
    );
    await expect(gone).toHaveAttribute('data-level', 'error');
  });

  test("the slab as a 2D tunnel round its hole: Re on the study's reference length once it sets one, no turbulent row", async ({ page, request }) => {
    test.setTimeout(300_000);
    // nu 2e-5 m²/s at 1 m/s: Re 5,000 on the channel's 2h (2 x 50 mm), Re 500 on the hole's 10 mm.
    const s = await slabStudy(request, host.base, { symmetry: true, title: 'Slab tunnel', nu: 2e-5 });
    await postOk(request, `${host.base}/api/mesh`, { project_id: s.pid, simulation_id: s.sid, mesh_id: s.mid, mesher_settings: { one_cell_across: true } });
    const gen = await request.post(`${host.base}/api/mesh/generate`, { data: { project_id: s.pid, simulation_id: s.sid, mesh_id: s.mid, queue_if_busy: true } });
    expect(gen.status(), await gen.text()).toBeLessThan(300);
    let end = 'wait';
    await expect
      .poll(
        async () => {
          const live = (await meshRecord(request, s)).live_mesh_result || {};
          end = /done|failed|stopped/.test(String(live.status)) ? `${live.status} ${JSON.stringify(live.error || '')} ${live.two_d?.cells_across}` : 'wait';
          return end;
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .not.toBe('wait');
    expect(end).toBe('done "" 1');
    const made = await postOk(request, `${host.base}/api/run/create`, { project_id: s.pid, simulation_id: s.sid, name: 'Tunnel 2D', mesh_id: s.mid });
    const rid = String(made.run_id || made.run?.id || made.run?.run_id);
    // No reference length: the channel's Re, which is turbulent for a channel.
    let panel = await openRunPanel(page, { base: host.base, projectId: s.pid, simulationId: s.sid, runId: rid });
    let check = panel.locator('[data-run-check="1"]');
    await expect(check.locator('[data-run-check-estimate="1"]')).toContainText('Re ≈ 5,000', STEP);
    await expect(check.locator('[data-run-check-row="laminar_turbulent"]')).toContainText('Re ≈ 5,000 is turbulent; a laminar model will not settle.');
    // The study's reference length, the hole's 10 mm: Re on it, and no turbulent row.
    await postOk(request, `${host.base}/api/simulation/update`, { project_id: s.pid, simulation_id: s.sid, ref_length: 0.01 });
    panel = await openRunPanel(page, { base: host.base, projectId: s.pid, simulationId: s.sid, runId: rid });
    check = panel.locator('[data-run-check="1"]');
    await expect(check.locator('[data-run-check-estimate="1"]')).toContainText('Re ≈ 500', STEP);
    await expect(check.locator('[data-run-check-estimate="1"]')).not.toContainText('Re ≈ 5,000');
    await expect(check.locator('[data-run-check-row="laminar_turbulent"]')).toHaveCount(0);
    // The same check the Assistant reads (the panel's route).
    const pre = await postOk(request, `${host.base}/api/run/precheck`, { project_id: s.pid, simulation_id: s.sid, run_id: rid });
    const est = pre.estimate || pre.check?.estimate || {};
    const codes = (pre.checks || pre.check?.checks || []).map((r) => r.code);
    expect([Math.round(est.re), codes.includes('laminar_turbulent')], JSON.stringify(pre).slice(0, 600)).toEqual([500, false]);
  });

  test("the Assistant changes the ends' BC while the Mesh panel is open: the note follows, without a reload", async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await slabStudy(request, host.base, { symmetry: true, title: 'Slab BC edit' });
    await postOk(request, `${host.base}/api/mesh`, { project_id: s.pid, simulation_id: s.sid, mesh_id: s.mid, mesher_settings: { one_cell_across: true } });
    const form = await openMeshPanel(page, host.base, s);
    const how = `2D: one cell across, 10 mm deep along z, between ${s.front} and ${s.back} (Symmetry "Sides").`;
    await expect(noteOf(form).locator('[data-mesh-two-d="available"]')).toHaveText(how, STEP);
    const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
    const asks = async (words, edit) => {
      const seen = {};
      fake.reply({ tools: [{ name: 'setup_edit', input: setup(edit) }] }, (body) => {
        seen.edit = resultsIn(body)[0];
        return { text: 'Done.' };
      });
      await dockSend(page, words);
      const card = dockGate(page);
      const ended = dockTurn(page).locator('[data-turn-end="done"]');
      for (let i = 0; i < 3; i++) {
        await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
        if (await ended.isVisible()) break;
        await card.locator('[data-gate-answer="yes"]').click(STEP);
      }
      await expect(ended).toBeVisible({ timeout: 60_000 });
      expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    };
    await openDock(page);
    // The ends become a wall: the note says it can't be meshed so, as the rule now answers.
    await asks('Make the slab ends walls.', { kind: 'bc', action: 'update', id: s.sidesId, type: 'Wall', values: [{ key: 'wall_type', value: '"No-slip"' }] });
    await expect(noteOf(form).locator('[data-mesh-two-d="unavailable"]')).toHaveText(`Not available on this part: ${NO_SYMMETRY} Generate refuses until it is.`, STEP);
    const answer = await json(request, s.q('/api/mesh/two-d', { simulation_id: s.sid }));
    expect(answer.available).toBe(false);
    // And a Symmetry again: the note says how, again.
    await asks('Make the slab ends a symmetry again.', { kind: 'bc', action: 'update', id: s.sidesId, type: 'Symmetry' });
    await expect(noteOf(form).locator('[data-mesh-two-d="available"]')).toHaveText(how, STEP);
    // The ends' Symmetry also on the outlet face: its patch could not be made empty (the flow
    // solved would not be 2D and never settle), so the note says why and what to do.
    await asks('Put the outlet face on the Sides symmetry too.', { kind: 'bc', action: 'update', id: s.sidesId, faces: [...s.ends, s.outlet] });
    const shared = `"Sides" is also on ${s.outletFace}, off the part's ends along z: give the two end faces a Symmetry of their own, so the solve can make them the 2D ends.`;
    await expect(noteOf(form).locator('[data-mesh-two-d="unavailable"]')).toHaveText(`Not available on this part: ${shared} Generate refuses until it is.`, STEP);
    expect((await json(request, s.q('/api/mesh/two-d', { simulation_id: s.sid }))).available).toBe(false);
  });
});

test('WSL: the slab is meshed one cell across, checkMesh passes it as a 2D mesh, and a laminar run on it solves', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_500_000);
  page.setDefaultTimeout(60_000);
  const s = await slabStudy(request, '', { symmetry: true, title: 'Slab 2D WSL', fineness: 4 });
  await postOk(request, '/api/mesh', { project_id: s.pid, simulation_id: s.sid, mesh_id: s.mid, mesher_settings: { one_cell_across: true } });
  const form = await openMeshPanel(page, '', s);
  await expect(toggleOf(form)).toHaveAttribute('aria-pressed', 'true', STEP);
  await expect(noteOf(form).locator('[data-mesh-two-d="available"]')).toContainText('one cell across, 10 mm deep along z', { timeout: 60_000 });
  await form.locator('[data-mesh-generate="1"]').click();
  const status = form.locator('[data-mesh-status]');
  await expect(status).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_200_000 });
  const live = (await meshRecord(request, s)).live_mesh_result || {};
  expect(live.status, JSON.stringify(live.error || '')).toBe('done');
  console.log(`[mesh 2d wsl] ${live.n_cells} cells, two_d ${JSON.stringify(live.two_d)}`);
  await expect(form.locator('.mesh-finished-meta')).toContainText('one cell across (2D)', STEP);
  // checkMesh's 2D check: no failed check in the panel's quality line.
  await expect(form.locator('[data-mesh-quality="1"]')).toContainText('Worst cells:', STEP);
  await expect(form.locator('[data-mesh-quality="1"]')).not.toContainText('checkMesh failed');
  // One cell across: every point of the mesh is on one of the two end planes (z = 0 or 10 mm).
  const points = readFileSync(join(live.case_dir, 'constant', 'polyMesh', 'points'), 'utf8');
  const zs = new Set();
  for (const m of points.matchAll(/^\(([-+0-9.eE]+) ([-+0-9.eE]+) ([-+0-9.eE]+)\)$/gm)) zs.add(Math.round(Number(m[3]) * 1e9) / 1e9);
  expect([...zs].sort((a, b) => a - b)).toEqual([0, 0.01]);
  const facts = JSON.parse(readFileSync(join(live.case_dir, 'mesh-facts.json'), 'utf8'));
  expect([facts.two_d?.cells_across, facts.two_d?.axis, facts.quality?.ok]).toEqual([1, 'z', true]);
  // The boundary the solve gets: the study's Symmetry patch holds both ends; no temporary patch is left.
  const boundary = readFileSync(join(live.case_dir, 'constant', 'polyMesh', 'boundary'), 'utf8');
  expect(boundary).toMatch(/\bsides\s*\{/);
  expect(boundary).not.toMatch(/magnusim_2d/);

  // A steady laminar run on it, started from its Run panel, solves and stops on its residual
  // targets: the two ends are empty for the solve, so nothing is solved across the depth (as
  // mirror planes the velocity's z component was solved too, its residual stayed at a few
  // hundredths, the run went to its limit, and Run health said the U residual had stopped falling).
  const made = await postOk(request, '/api/run/create', { project_id: s.pid, simulation_id: s.sid, name: 'Slab 2D', mesh_id: s.mid });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  const LIMIT = 2000;
  await postOk(request, '/api/run/update', { project_id: s.pid, simulation_id: s.sid, run_id: rid, endTime: LIMIT, writeInterval: LIMIT, cores: 4 });
  const answered = page.waitForResponse((r) => r.url().includes('/api/run/ready?') && new URL(r.url()).searchParams.get('run_id') === rid, { timeout: 90_000 });
  const panel = await openRunPanel(page, { base: '', projectId: s.pid, simulationId: s.sid, runId: rid });
  await answered;
  const start = panel.locator('[data-run-start="1"]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await expect(panel.locator('[data-run-reason="1"]')).toHaveCount(0);
  await expect(panel.locator('[data-run-check="1"] [data-run-check-row="two_d_ends"]')).toHaveCount(0);
  await start.click();
  const runRow = async () => ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((x) => String(x.id) === rid) || {};
  let end = 'wait';
  await expect
    .poll(
      async () => {
        const r = await runRow();
        end = /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${JSON.stringify(r.error || '')}` : 'wait';
        return end;
      },
      { timeout: 1_000_000, intervals: [10_000] },
    )
    .not.toBe('wait');
  expect(end).toBe('done ""');
  await expect(panel.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done', { timeout: 60_000 });
  const row = await runRow();
  console.log(`[mesh 2d wsl] run done at iteration ${row.iteration} of ${LIMIT}`);
  // The case it solved: both ends on the study's Symmetry patch, empty in its boundary and in U.
  const runCase = String(row.case_dir || '');
  expect(runCase, JSON.stringify(row).slice(0, 400)).not.toBe('');
  expect(readFileSync(join(runCase, 'constant', 'polyMesh', 'boundary'), 'utf8')).toMatch(/\bsides\s*\{\s*type\s+empty;/);
  expect(readFileSync(join(runCase, '0', 'U'), 'utf8')).toMatch(/\bsides\s*\{\s*type\s+empty;/);
  // What the person sees: the run's tree row says Converged (it stopped on its residual
  // targets, before its limit), and Run health finds no stalled residual.
  const converged = page.locator(`#left-tree li[data-w27-run="${rid}"] > .tree-row [data-run-converged="1"]`);
  await expect(converged).toHaveText('Converged', { timeout: 60_000 });
  const title = String(await converged.getAttribute('title'));
  const at = Number((title.match(/after (\d+) iterations/) || [])[1]);
  expect(at, title).toBeLessThan(LIMIT);
  const health = panel.locator('[data-run-health]');
  await expect(health).toBeVisible({ timeout: 120_000 });
  await expect(health).not.toHaveAttribute('data-run-health', /pending/, { timeout: 120_000 });
  console.log(`[mesh 2d wsl] run health: ${await health.getAttribute('data-run-health')}`);
  await expect(panel.locator('[data-run-health-finding="residuals_stalled"]')).toHaveCount(0);
  await expect(health).not.toHaveAttribute('data-run-health', /unhealthy|failed/);
});
