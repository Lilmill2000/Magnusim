// Long thin parts on Hex-dominant (F2, 2026-11-07). The background block keeps at least 8 and 12
// cells across a part, and its cell along the part came from the part's diagonal, so on a long
// pipe the cells were needles: a 55 D pipe at fineness 6 had them 6.5 times as long as their side
// across y, and snappyHexMesh snapped them into cells of negative volume (since D1 its Generate
// fails, naming the checks). Now no background cell is more than 3 times as long as the longer of
// its other two sides: the pipe gets 147 cells along it, not 68. The rule is for needles only: a
// flat part (a plate) keeps its block (python/tests/unit/test_snappy_background_aspect.py, W7).
// - With WSL: the 55 D pipe (20 mm across, 1,100 mm long) at fineness 6 ends Mesh ready, its
//   quality line its worst cells only (no failed check), after a reload too; the record says the
//   block and that checkMesh passed. Fails on the code before F2: Mesh failed, 5 failed checks.
// - Fake compute (its own server, MAGNUSIM_TEST_COMPUTE=fake): a pipe 1 mm across and 20 m long
//   is refused before it meshes, at any fineness: its background block alone would have 5,120,064
//   cells, over snappyHexMesh's limit of 4,000,000; the words name the Standard mesher. The fake
//   mesher, standing in for Hex-dominant (MAGNUSIM_TEST_MESH_PART_BOX=1), applies the generator's
//   own rule (cfddesk.mesh.snappy_hexdominant.cell_limit_refusal) to the study's part. The Mesh
//   panel says Mesh failed with those words, the tree says Failed, the same after a reload; the
//   Assistant's read_setup mesh reads the same words (two-way parity). Fails on the code before
//   F2: it "meshed" (the block was 68 cells along, and snappyHexMesh could refine nothing).
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';
import { NO_WSL } from './toolchain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
// Pipes along +x from x = 0: 20 mm across and 1,100 mm long (55 D); 1 mm across and 20 m long.
const PIPE_55D = { file: 'pipe-55d.step', length: 1100 };
const PIPE_20000D = { file: 'pipe-20000d.step', length: 20000 };
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const STEP = { timeout: 30_000 };
const stamp = () => Date.now().toString(36);
// What the person reads, word for word.
const REFUSED =
  "Hex-dominant can't mesh this part at any fineness: it is so long and thin that its background block alone, with no cell more than 3 times as long as wide, would have 5,120,064 cells, over snappyHexMesh's limit of 4,000,000. Try the Standard mesher: it has no background block.";

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
 * A pipe in a project of its own: an Incompressible Flow study (laminar), its inlet the disc at
 * x = 0, its outlet the disc at the far end, its side a wall; its mesh Hex-dominant at `fineness`,
 * no boundary layers.
 */
async function pipeStudy(request, base, pipe, { title, fineness }) {
  const made = await postOk(request, `${base}/api/project`, { title: `${title} ${stamp()}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
  const pid = String(made.id || made.project?.id);
  const q = (path, extra = {}) => `${base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const imported = await request.post(q('/api/geometry/import', { filename: pipe.file }), {
    data: readFileSync(join(HERE, 'fixtures', pipe.file)),
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
    .toBe(3);
  const label = (f) => `face ${f.id}@Body1`;
  const inlet = faces.filter((f) => Math.abs(f.centroid[0]) < 0.01);
  const outlet = faces.filter((f) => Math.abs(f.centroid[0] - pipe.length) < 0.01);
  const side = faces.filter((f) => !inlet.includes(f) && !outlet.includes(f));
  expect([inlet.length, outlet.length, side.length], JSON.stringify(faces)).toEqual([1, 1, 1]);
  const sim = await postOk(request, `${base}/api/simulation`, { project_id: pid, geometry_id: gid, analysis_type: 'incompressible_steady', time_dependency: 'Steady-state', activate: true });
  const sid = String(sim.simulation?.id || sim.id);
  await postOk(request, `${base}/api/simulation/update`, { project_id: pid, simulation_id: sid, turbulence_model: 'laminar' });
  await postOk(request, `${base}/api/materials`, { project_id: pid, simulation_id: sid, preset: 'custom', name: 'Pipe fluid', kinematic_viscosity: 1e-3, density: 1, assigned_volumes: ['Body1'] });
  const bc = (data) => postOk(request, `${base}/api/bcs`, { project_id: pid, simulation_id: sid, geometry_id: gid, ...data });
  await bc({ name: 'Inlet', bc_type: 'Velocity inlet', velocity_type: 'Fixed', value: 0.1, unit: 'm/s', direction: 'Normal to face', faces: [label(inlet[0])] });
  await bc({ name: 'Outlet', bc_type: 'Pressure', pressure_type: 'Fixed value', value: 0, unit: 'Pa', faces: [label(outlet[0])] });
  await bc({ name: 'Wall', bc_type: 'Wall', wall_type: 'No-slip', faces: [label(side[0])] });
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
  return { pid, sid, gid, mid, q };
}

const liveOf = async (request, s) => (await json(request, s.q('/api/mesh', { simulation_id: s.sid, mesh_id: s.mid }))).mesh?.live_mesh_result || {};

/** The project open in the page (after a reload) and its mesh's settings open in the Mesh panel. */
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

/** What the person sees of a mesh that failed with `words`: Mesh failed, the words, the tree's Failed. */
async function expectFailed(page, form, s, words) {
  const status = form.locator('.mesh-finished');
  await expect(status).toHaveAttribute('data-mesh-status', 'failed', { timeout: 90_000 });
  await expect(status.locator('.mat-k')).toHaveText('Mesh failed');
  await expect(status.locator('.mesh-finished-line')).toHaveText(words);
  await expect(form.locator('[data-mesh-status="ready"]')).toHaveCount(0);
  const row = page.locator(`#left-tree li[data-w20-mesh-item="${s.mid}"] > .tree-row`);
  await expect(row.locator('[data-mesh-failed="1"]')).toHaveText('Failed', STEP);
}

test.describe('Hex-dominant on a part too long and thin for its background block (fake compute)', () => {
  test.describe.configure({ mode: 'serial' });
  let host;
  let fake;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fake = await startFakeLlm();
    const tmp = e2eTemp('hex-long-pipe');
    const projects = join(tmp, 'projects');
    mkdirSync(projects, { recursive: true });
    host = await startHost({
      name: 'hex-long-pipe',
      tmp,
      projects,
      env: {
        MAGNUSIM_TEST_COMPUTE: 'fake',
        MAGNUSIM_TEST_MESH_SECONDS: '1',
        MAGNUSIM_TEST_MESH_PART_BOX: '1',
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await request.post(`${host.base}/api/test/assistant/reset`, { data: {} });
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(() => {
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  test('a pipe whose background block alone passes the cell limit is refused before it meshes, with the reason, after a reload too, and the Assistant reads the same', async ({ page, request }) => {
    test.setTimeout(300_000);
    const s = await pipeStudy(request, host.base, PIPE_20000D, { title: 'Pipe 20000 D', fineness: 6 });
    let form = await openMeshPanel(page, host.base, s);
    await form.locator('[data-mesh-generate="1"]').click();
    await expectFailed(page, form, s, REFUSED);
    const live = await liveOf(request, s);
    expect([live.status, live.error]).toEqual(['failed', REFUSED]);

    form = await openMeshPanel(page, host.base, s);
    await expectFailed(page, form, s, REFUSED);

    // The Assistant reads the same words.
    fake.reply({ tools: [{ name: 'read_setup', input: { project_id: '', simulation_id: '', what: 'mesh', id: s.mid, other_id: '', page: 0 } }] }, { text: 'Read it.' });
    await openDock(page);
    await dockSend(page, 'Why did this mesh fail?');
    await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
    const chats = fake.requests().filter((r) => r.kind === 'chat');
    const [read] = resultsIn(chats.at(-1));
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.data.engine).toBe('snappy_hexdominant');
    expect(read.data.generated).toMatchObject({ status: 'failed', error: REFUSED });
  });
});

test('WSL: a 55 D pipe at fineness 6 on Hex-dominant ends Mesh ready with no failed check in its quality line', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_500_000);
  page.setDefaultTimeout(60_000);
  const s = await pipeStudy(request, '', PIPE_55D, { title: 'Pipe 55 D WSL', fineness: 6 });
  let form = await openMeshPanel(page, '', s);
  await form.locator('[data-mesh-generate="1"]').click();
  await expect(form.locator('[data-mesh-status]')).toHaveAttribute('data-mesh-status', /ready|failed/, { timeout: 1_200_000 });
  const live = await liveOf(request, s);
  expect(live.status, JSON.stringify(live.error || '')).toBe('done');
  // The block with the cap (it had 68 cells along the pipe), and checkMesh passed it outright.
  expect(live.block_used).toBe('(147 8 12)');
  expect(live.quality).toMatchObject({ known: true, ok: true, n_failed: 0 });
  expect(live.quality.failed || []).toEqual([]);
  console.log(`[hex long pipe wsl] ${live.n_cells} cells, worst non-orthogonality ${live.quality.max_non_orthogonality}, skewness ${live.quality.max_skewness}`);
  /** Mesh ready, and its quality line is its worst cells only: no failed check named. */
  const expectReady = async (f) => {
    const status = f.locator('.mesh-finished');
    await expect(status).toHaveAttribute('data-mesh-status', 'ready', STEP);
    await expect(status.locator('.mat-k')).toHaveText('Mesh ready');
    const lines = status.locator('[data-mesh-quality] > div');
    await expect(lines).toHaveCount(1, STEP);
    await expect(lines.first()).toHaveText(/^Worst cells: /);
    await expect(status).not.toContainText('checkMesh failed');
  };
  await expectReady(form);
  form = await openMeshPanel(page, '', s);
  await expectReady(form);
});
