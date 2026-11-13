// Refine out to, on Surface custom sizing (the validation set's gap G4; Daniel's yes on
// 2026-11-05): how far from its faces a custom size's cells keep that size, so a wake or a band
// of reversed flow can be refined. Empty keeps the default band (about three cells of the size).
// - Fake compute (its own server, MAGNUSIM_TEST_COMPUTE=fake): the refinement editor shows the
//   field (empty: Auto); a distance typed is saved with its unit and still there after a reload;
//   a negative one is not saved and the editor says why; emptied, it is cleared. On a Hex-dominant
//   mesh nothing is said under it; once the mesh's mesher is Standard, the editor says Standard
//   ignores it (it sizes the faces only).
// - The Assistant (a scripted model, through the dock): sets it with setup_edit (the editor shows
//   it without a reload, and the Assistant's answer carries the editor's note), and reads it with
//   read_setup refinements, with the same note word for word.
// - With WSL: the slab meshed one cell across with a 1.2 mm size on its hole, Refine out to
//   15 mm: the mesh's cells keep the size out to about 15 mm from the hole and are coarser
//   beyond (three cells, the default band, would end near 4 mm).
// Fails on the code before G4: the editor has no Refine out to. Also checks what a reload
// showed wrongly before this change: no refinements at all (hydrate read a file the
// refinements route no longer writes), in the tree or the editor.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';
import { NO_WSL } from './toolchain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
// A channel 100 x 50 mm, 10 mm deep along z (z = 0 to 10), with a 10 mm hole through it at (30, 25).
const SLAB = join(HERE, 'fixtures', 'slab-2d.step');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const STEP = { timeout: 30_000 };
const stamp = () => Date.now().toString(36);
const STANDARD_NOTE = 'Standard ignores Refine out to: it sizes these faces only. Hex-dominant refines the cells out to this distance.';
const REFUSED = 'Not saved: Refine out to must be a distance above 0, or empty for about three cells of the size.';

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
 * The slab in a project of its own: an Incompressible Flow study (laminar), an inlet at x = 0, an
 * outlet at x = 100 mm, its two end faces on a Symmetry "Sides", the rest walls. Its mesh is
 * `engine` at `fineness`, no boundary layers; a Surface custom sizing "Hole" of `size` mm on the
 * hole's face (no Refine out to).
 */
async function slabStudy(request, base, { title, engine = 'snappy_hexdominant', fineness = 3, size = 1.2, oneCellAcross = false }) {
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
  const hole = faces.filter((f) => Math.abs(f.centroid[0] - 30) < 0.01 && Math.abs(f.centroid[1] - 25) < 0.01);
  expect([front, back, inlet, outlet, hole].map((x) => x.length), JSON.stringify(faces)).toEqual([1, 1, 1, 1, 1]);
  const named = new Set([front[0], back[0], inlet[0], outlet[0]]);
  const sim = await postOk(request, `${base}/api/simulation`, { project_id: pid, geometry_id: gid, analysis_type: 'incompressible_steady', time_dependency: 'Steady-state', activate: true });
  const sid = String(sim.simulation?.id || sim.id);
  await postOk(request, `${base}/api/simulation/update`, { project_id: pid, simulation_id: sid, turbulence_model: 'laminar' });
  await postOk(request, `${base}/api/materials`, { project_id: pid, simulation_id: sid, preset: 'custom', name: 'Slab fluid', kinematic_viscosity: 5e-4, density: 1, assigned_volumes: ['Body1'] });
  const bc = (data) => postOk(request, `${base}/api/bcs`, { project_id: pid, simulation_id: sid, geometry_id: gid, ...data });
  await bc({ name: 'Inlet', bc_type: 'Velocity inlet', velocity_type: 'Fixed', value: 1, unit: 'm/s', direction: 'Normal to face', faces: [label(inlet[0])] });
  await bc({ name: 'Outlet', bc_type: 'Pressure', pressure_type: 'Fixed value', value: 0, unit: 'Pa', faces: [label(outlet[0])] });
  await bc({ name: 'Sides', bc_type: 'Symmetry', faces: [label(front[0]), label(back[0])] });
  await bc({ name: 'Walls', bc_type: 'Wall', wall_type: 'No-slip', faces: faces.filter((f) => !named.has(f)).map(label) });
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
    advanced: { mesh_engine: engine },
    ...(oneCellAcross ? { mesher_settings: { one_cell_across: true } } : {}),
  });
  const ref = await postOk(request, `${base}/api/mesh/refinements`, {
    project_id: pid,
    simulation_id: sid,
    mesh_id: mid,
    name: 'Hole',
    type: 'Surface custom sizing',
    faces: [label(hole[0])],
    faces_explicit: true,
    sizing: 'Custom',
    default_size: size,
    default_size_unit: 'mm',
  });
  return { pid, sid, gid, mid, q, refId: String(ref.refinement.id) };
}

const refRecord = async (request, s) =>
  ((await json(request, s.q('/api/mesh/refinements', { simulation_id: s.sid }))).refinements || []).find((r) => r.id === s.refId) || {};

/** The project open in the page (after a reload), and the refinement's editor open, as its tree row opens it (showRefEditor). */
async function openRefEditor(page, base, s) {
  await page.goto(`${base}/#/p/${encodeURIComponent(s.pid)}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, s.pid, { timeout: 90_000 });
  // Its refinements as the project's read gave them, and the tree lists it under its mesh (a
  // reopened project's refinements were lost: hydrate read none).
  await page.waitForFunction((id) => typeof window.__CFD_SHOW_REF__ === 'function' && (window.__CFD_W26__?.refinements || []).some((r) => r.id === id), s.refId, { timeout: 30_000 });
  await expect(page.locator(`#left-tree [data-w26-ref="${s.refId}"]`)).toHaveCount(1, STEP);
  await page.evaluate((id) => window.__CFD_SHOW_REF__(window.__CFD_W26__.refinements.find((r) => r.id === id)), s.refId);
  const editor = page.locator('#panel-ref-editor');
  await expect(editor).toBeVisible(STEP);
  await expect(editor.locator('#ref-editor-title')).toHaveText('Hole', STEP);
  return editor;
}

test.describe('Refine out to (fake compute)', () => {
  test.describe.configure({ mode: 'serial' });
  let host;
  let fake;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fake = await startFakeLlm();
    const tmp = e2eTemp('refine-reach');
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    host = await startHost({
      name: 'refine-reach',
      tmp,
      projects,
      env: {
        MAGNUSIM_TEST_COMPUTE: 'fake',
        MAGNUSIM_TEST_MESH_SECONDS: '1',
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

  test('the editor saves Refine out to with its unit, keeps it after a reload, refuses a negative one, and says Standard ignores it', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await slabStudy(request, host.base, { title: 'Refine out to' });
    let editor = await openRefEditor(page, host.base, s);
    const reach = editor.locator('#ref-reach');
    const unit = editor.locator('#ref-reach-unit');
    const note = editor.locator('#ref-reach-note');
    // A new custom size has none: the default band.
    await expect(editor.locator('#ref-reach-row')).toContainText('Refine out to');
    await expect(reach).toHaveValue('');
    await expect(reach).toHaveAttribute('placeholder', 'Auto');
    await expect(unit).toHaveValue('mm');
    // Hex-dominant refines out to it: nothing is said under it.
    await expect(note).toBeHidden();
    expect((await refRecord(request, s)).reach ?? null).toBeNull();

    await reach.fill('30');
    await reach.press('Tab');
    await expect.poll(async () => { const r = await refRecord(request, s); return [r.reach, r.reach_unit]; }, STEP).toEqual([30, 'mm']);
    await unit.selectOption('m');
    // The unit saves at once (30 m); type the new distance once that save has landed, as its
    // panel refresh puts the saved value back in the field.
    await expect.poll(async () => { const r = await refRecord(request, s); return [r.reach, r.reach_unit]; }, STEP).toEqual([30, 'm']);
    await expect(reach).toHaveValue('30');
    await reach.fill('0.025');
    await reach.press('Tab');
    await expect.poll(async () => { const r = await refRecord(request, s); return [r.reach, r.reach_unit]; }, STEP).toEqual([0.025, 'm']);
    await expect(note).toBeHidden();

    // A negative distance: not saved, and the editor says why (the value stays as typed).
    await reach.fill('-5');
    await reach.press('Tab');
    await expect(note).toHaveText(REFUSED, STEP);
    await expect(note).toHaveAttribute('data-ref-reach-note', 'refused');
    await expect(reach).toHaveValue('-5');
    await page.waitForTimeout(800);
    expect((await refRecord(request, s)).reach).toBe(0.025);
    await reach.fill('25');
    await unit.selectOption('mm');
    await reach.press('Tab');
    await expect.poll(async () => { const r = await refRecord(request, s); return [r.reach, r.reach_unit]; }, STEP).toEqual([25, 'mm']);
    await expect(note).toBeHidden();

    // After a reload: still there.
    editor = await openRefEditor(page, host.base, s);
    await expect(editor.locator('#ref-reach')).toHaveValue('25');
    await expect(editor.locator('#ref-reach-unit')).toHaveValue('mm');
    await expect(editor.locator('#ref-reach-note')).toBeHidden();

    // The mesh on Standard (picked under the mesh's Advanced settings): the editor says it ignores it.
    await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), s.mid);
    const form = page.locator('#panel-mesh-form .cfd-island');
    await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible(STEP);
    await form.locator('details.mesh-advanced > summary').click();
    await form.locator('[data-mesh-engine="1"]').selectOption('standard');
    await expect.poll(async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh?.settings?.advanced?.mesh_engine, STEP).toBe('standard');
    editor = await openRefEditor(page, host.base, s);
    await expect(editor.locator('#ref-reach')).toHaveValue('25');
    await expect(editor.locator('#ref-reach-note')).toHaveText(STANDARD_NOTE, STEP);
    await expect(editor.locator('#ref-reach-note')).toHaveAttribute('data-ref-reach-note', 'ignored');

    // Emptied: cleared (the default band), and empty after a reload.
    await editor.locator('#ref-reach').fill('');
    await editor.locator('#ref-reach').press('Tab');
    await expect.poll(async () => (await refRecord(request, s)).reach, STEP).toBeNull();
    editor = await openRefEditor(page, host.base, s);
    await expect(editor.locator('#ref-reach')).toHaveValue('');
  });

  test('the Assistant sets Refine out to and reads it with the note the editor shows', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await slabStudy(request, host.base, { title: 'Refine out to Assistant', engine: 'standard' });
    const editor = await openRefEditor(page, host.base, s);
    await expect(editor.locator('#ref-reach')).toHaveValue('');
    await expect(editor.locator('#ref-reach-note')).toHaveText(STANDARD_NOTE, STEP);
    const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
    const seen = {};
    fake.reply(
      {
        tools: [
          {
            name: 'setup_edit',
            input: setup({ kind: 'refinement', action: 'update', id: s.refId, values: [{ key: 'reach', value: '40' }, { key: 'reach_unit', value: '"mm"' }] }),
          },
        ],
      },
      (body) => {
        seen.edit = resultsIn(body)[0];
        return { tools: [{ name: 'read_setup', input: { project_id: '', simulation_id: '', what: 'refinements', id: s.mid, other_id: '', page: 0 } }] };
      },
      (body) => {
        seen.read = resultsIn(body)[0];
        return { text: 'The hole refines out to 40 mm.' };
      },
    );
    await openDock(page);
    await dockSend(page, 'Refine the hole out to 40 mm.');
    const card = dockGate(page);
    const ended = dockTurn(page).locator('[data-turn-end="done"]');
    for (let i = 0; i < 3; i++) {
      await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
      if (await ended.isVisible()) break;
      await card.locator('[data-gate-answer="yes"]').click(STEP);
    }
    await expect(ended).toBeVisible({ timeout: 60_000 });
    expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    // Its answer carries what the editor says under the field.
    expect(seen.edit.data.done).toContain(STANDARD_NOTE);
    const rec = await refRecord(request, s);
    expect([rec.reach, rec.reach_unit, rec.default_size]).toEqual([40, 'mm', 1.2]);
    // The editor shows it, without a reload.
    await expect(editor.locator('#ref-reach')).toHaveValue('40', STEP);
    await expect(editor.locator('#ref-reach-unit')).toHaveValue('mm');
    // The Assistant read it, and the editor's note word for word.
    expect(seen.read.ok, JSON.stringify(seen.read)).toBe(true);
    const row = seen.read.data.refinements.find((r) => r.id === s.refId);
    expect(row.values).toMatchObject({ default_size: 1.2, default_size_unit: 'mm', reach: 40, reach_unit: 'mm' });
    expect(row.note).toBe(STANDARD_NOTE);
  });
});

/** The 2D mesh's points on its z = 0 plane (mm), from its points file. */
function planePoints(caseDir) {
  const text = readFileSync(join(caseDir, 'constant', 'polyMesh', 'points'), 'utf8');
  const out = [];
  for (const m of text.matchAll(/^\(([-+0-9.eE]+) ([-+0-9.eE]+) ([-+0-9.eE]+)\)$/gm)) {
    if (Math.abs(Number(m[3])) < 1e-9) out.push([Number(m[1]) * 1000, Number(m[2]) * 1000]);
  }
  return out;
}

/** The median spacing (mm) of the points whose distance from the hole's surface is in [lo, hi] mm, away from the walls. */
function spacing(points, lo, hi) {
  const near = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const d = Math.hypot(x - 30, y - 25) - 5;
    if (d < lo || d > hi || y < 7 || y > 43 || x < 7 || x > 93) continue;
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j !== i) best = Math.min(best, Math.hypot(points[j][0] - x, points[j][1] - y));
    }
    near.push(best);
  }
  near.sort((a, b) => a - b);
  return { n: near.length, median: near.length ? near[Math.floor(near.length / 2)] : NaN };
}

test('WSL: a slab meshed one cell across keeps the hole\'s size out to its Refine out to, and is coarser beyond', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_500_000);
  page.setDefaultTimeout(60_000);
  const s = await slabStudy(request, '', { title: 'Refine out to WSL', fineness: 3, size: 1.2, oneCellAcross: true });
  // Typed in the editor, as the person does.
  const editor = await openRefEditor(page, '', s);
  await editor.locator('#ref-reach').fill('15');
  await editor.locator('#ref-reach').press('Tab');
  await expect.poll(async () => { const r = await refRecord(request, s); return [r.reach, r.reach_unit]; }, STEP).toEqual([15, 'mm']);
  await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), s.mid);
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-mesh-generate="1"]')).toBeVisible(STEP);
  await form.locator('[data-mesh-generate="1"]').click();
  await expect(form.locator('[data-mesh-status]')).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_200_000 });
  const live = (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh?.live_mesh_result || {};
  expect(live.status, JSON.stringify(live.error || '')).toBe('done');
  await expect(form.locator('.mesh-finished-meta')).toContainText('one cell across (2D)', STEP);
  // The band as the mesher wrote it (the mesh's facts): out to 15 mm at the size's level.
  const facts = JSON.parse(readFileSync(join(live.case_dir, 'mesh-facts.json'), 'utf8'));
  expect(facts.refined, JSON.stringify(facts)).toHaveLength(1);
  const band = facts.refined[0];
  expect([band.distance_m, band.reach_m]).toEqual([0.015, 0.015]);
  const cell = band.cell_m * 1000;
  expect(cell).toBeLessThanOrEqual(1.2);
  // The mesh itself: the hole's cell size 7 to 12 mm from it (three cells of the size would end
  // near 4 mm, then twice as coarse) and on to 15 mm, and coarser 22 mm out and beyond. The first
  // run (2026-11-05, F3, 1,443 cells): 1.10 mm to 17 mm out (the band and snappy's two buffer
  // cells), 2.21 mm from 17 to 22 mm, 4.41 mm (the background) beyond.
  const pts = planePoints(live.case_dir);
  const inner = spacing(pts, 7, 12);
  const edge = spacing(pts, 12, 15);
  const outer = spacing(pts, 22, 34);
  console.log(
    `[refine reach wsl] ${live.n_cells} cells, size cell ${cell.toFixed(3)} mm; 7-12 mm out: ${inner.median.toFixed(3)} mm (${inner.n} points); ` +
      `12-15 mm: ${edge.median.toFixed(3)} mm (${edge.n}); 22-34 mm: ${outer.median.toFixed(3)} mm (${outer.n})`,
  );
  expect([inner.n > 30, edge.n > 30, outer.n > 10]).toEqual([true, true, true]);
  expect(inner.median).toBeLessThanOrEqual(cell * 1.1);
  expect(edge.median).toBeLessThanOrEqual(cell * 1.1);
  expect(outer.median).toBeGreaterThanOrEqual(cell * 1.8);
});
