// Leaving a run's Results leaves nothing of them in the 3D view (Daniel, 2026-11-03): after
// he looked at a steady run's Results with a particle trace, went to another study and
// started its Run 2 (solving, 0 frames), the view showed the gray geometry with the steady
// run's trace tubes still drawn. Leaving Results kept the trace switched on, and the
// background results prefetch then attached the finished steady run again and drew the trace
// on the setup view, where nothing took it away. Iso and iso-volume arrows, the plot path and
// a seed region's outline stayed up the same way.
//
// What the person sees is checked three ways: the actors the view draws
// (window.__CFD_VIEW_ACTORS__), the view's pixels with the camera on where the trace was (a
// forced render), and a screenshot of the canvas as the screen shows it (no render forced).
// Late answers are forced by holding the trace and iso requests: one asked for on a run the
// person left draws nothing, on the setup view or on the next run's Results. Leaving a run's
// Results and reopening them brings its trace back by itself, and a transient run's Results
// still follow its new frames.
//
// No WSL: the steady runs are copies of the committed cavity case (with an inlet row, so
// the trace has seeds), the transient study's mesh and solves are the fake compute's.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { createRun, openRunPanel, postJson, runRow, waitSlotFree } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PID = 'results-leave-e2e';
const PID2 = 'results-leave-other-e2e';
const SIM_A = 'sim_1';
const STEP = { timeout: 30_000 };
// The cavity's lid as a velocity inlet: the trace seeds there ("40 seeds · 32 traces.").
const LID = { patch: 'movingWall', name: 'Lid', bc_type: 'Velocity inlet' };
const TRACE_HINT = /^40 seeds . 32 traces\.$/;
// A run's own drawings; the CAD, its edges, the mesh view and the orbit flash are not.
const RESULT_ACTOR = '^(results-surface|cut|cut-plane|cut-plane-vectors|particle-trace|particle-seeds|plot-path|iso|iso-volume|iso-vectors|iso-volume-vectors|inspect-marker|pt-face-overlay|pt-region-outline)$|^b:';

let host;
let simB;
let runA;
let runA2;
let runRegion;
let run1;
let run2;
let runOther;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await postJson(request, api(path), data);
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}
const t0 = Date.now();
const stage = (msg) => console.log(`[results-leave +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A filter set with the particle trace on (seeded from the lid), as a run's saved view keeps it. */
function traceView(pt = {}) {
  return {
    v: 1,
    field: '',
    parts: { on: true, style: 'solid', solid: '#9aa3ad', opacity: 0.3 },
    planesOn: true,
    planes: [],
    pt: {
      open: true,
      enabled: true,
      seed_mode: 'faces',
      faces: ['Lid'],
      quantity_mode: 'count',
      n_seeds: 40,
      representation: 'Cylinders',
      size: 0.0037,
      highlightOpenings: true,
      ...pt,
    },
    anim: { open: false, type: 'Time Step' },
    collapsed: [],
    scale: {},
    camera: null,
  };
}

/** The cavity case in a run's case folder: core sidecar, the lid as an inlet; `frames` kept. */
function copyCavity(caseDir, frames) {
  mkdirSync(caseDir, { recursive: true });
  for (const part of ['0', 'constant', 'system', 'w27-case.json', ...frames]) {
    cpSync(join(CAVITY, part), join(caseDir, part), { recursive: true });
  }
  const sidecar = join(caseDir, 'w27-case.json');
  const side = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete side.plugin;
  delete side.study_id;
  side.mapped = [LID];
  writeFileSync(sidecar, JSON.stringify(side, null, 2));
}

/** A finished steady run whose case is the cavity's last two frames as iterations 50 and 100. */
async function seedSteadyRun(request, { pid, sim, name, finishedAt, view }) {
  const rid = await createRun(request, { base: host.base, projectId: pid, simulationId: sim, name });
  const row = await runRow(request, { base: host.base, projectId: pid, simulationId: sim, runId: rid });
  const runDir = dirname(row.case_dir);
  const caseDir = join(runDir, 'case');
  copyCavity(caseDir, ['0.4', '0.5']);
  renameSync(join(caseDir, '0.4'), join(caseDir, '50'));
  renameSync(join(caseDir, '0.5'), join(caseDir, '100'));
  const runJson = join(runDir, 'run.json');
  const original = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...original,
        status: 'done',
        stage: 'done',
        time_dependency: 'Steady-state',
        analysis_key: 'incompressible_steady',
        path_kind: 'simpleFoam',
        solve_protocol: 'runner',
        has_results: true,
        n_saved_times: 2,
        last_saved_iteration: 100,
        iteration: 100,
        sim_time: 100,
        n_steps: 100,
        endTime: 100,
        writeInterval: 50,
        residuals: [
          { t: 1, U: 1, p: 1 },
          { t: 50, U: 0.01, p: 0.02 },
          { t: 100, U: 0.001, p: 0.002 },
        ],
        started_at: new Date(Date.parse(finishedAt) - 60_000).toISOString(),
        finished_at: finishedAt,
        case_dir: caseDir,
        ...(view ? { current_view: view } : {}),
      },
      null,
      2,
    ),
  );
  return { rid, runDir, caseDir, runJson };
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000);
  const tmp = e2eTemp('results-leave');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Results leave');
  seedElbowProject(projects, PID2, 'Results leave, other');
  host = await startHost({
    name: 'results-leave',
    tmp,
    projects,
    env: { MAGNUSIM_TEST_COMPUTE: 'fake', MAGNUSIM_TEST_MESH_SECONDS: '1', MAGNUSIM_TEST_SOLVE_SECONDS: '600' },
  });
  const now = Date.now();
  const at = (ago) => new Date(now - ago).toISOString();
  // The steady study's runs: A (newest, no saved view: its trace is switched on by hand),
  // A2 (a saved view with the trace on) and one whose saved view seeds from a region.
  runA = await seedSteadyRun(request, { pid: PID, sim: SIM_A, name: 'Run A', finishedAt: at(60_000) });
  runA2 = await seedSteadyRun(request, { pid: PID, sim: SIM_A, name: 'Second steady run', finishedAt: at(3_600_000), view: traceView() });
  runRegion = await seedSteadyRun(request, {
    pid: PID,
    sim: SIM_A,
    name: 'Region seeded run',
    finishedAt: at(7_200_000),
    view: traceView({
      seed_mode: 'region',
      regionShape: 'box',
      region: { face: 'Lid', shape: 'box', origin: [0.03, 0.1, 0.002], u: [0.04, 0, 0], v: [0, 0, 0.006], radius: 0 },
    }),
  });
  // Another project whose newest run has the same patch names (a project switch).
  runOther = await seedSteadyRun(request, { pid: PID2, sim: SIM_A, name: 'Run other', finishedAt: at(60_000) });

  // Study B: a transient copy of the steady study (its runs are not copied), meshed by the
  // fake mesher, with two draft runs.
  const geoms = (await getJson(request, `/api/project?project_id=${PID}`)).project?.geometries || [];
  const made = await postOk(request, '/api/simulation', {
    project_id: PID,
    analysis: 'Incompressible',
    time_dependency: 'Transient',
    geometry_id: geoms[0]?.id,
    copy_from: SIM_A,
  });
  simB = String(made.simulation?.id || '');
  expect(simB, JSON.stringify(made)).toBeTruthy();
  const doc = await getJson(request, `/api/mesh?project_id=${PID}&simulation_id=${simB}`);
  const meshId = String(doc.mesh?.id || '');
  expect(meshId, JSON.stringify(doc)).toBeTruthy();
  await postOk(request, '/api/mesh/generate', { project_id: PID, simulation_id: simB, mesh_id: meshId });
  await expect
    .poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&simulation_id=${simB}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 120_000 })
    .toBe('done');
  await waitSlotFree(request, { base: host.base });
  const draft = async (name) => {
    const j = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: simB, name, mesh_id: meshId });
    return String(j.run_id || j.run?.id || j.run?.run_id);
  };
  run1 = await draft('Run 1');
  run2 = await draft('Run 2');
  // The page opens on the steady study, where Daniel was.
  await postOk(request, '/api/simulation/activate', { project_id: PID, simulation_id: SIM_A });
  stage(`seeded: A ${runA.rid}, A2 ${runA2.rid}, region ${runRegion.rid}, B ${simB} (${run1}, ${run2}), other ${runOther.rid}`);
});

test.afterAll(async ({ request }) => {
  for (const rid of [run1, run2]) {
    if (rid) await request.post(api('/api/run/stop'), { data: { project_id: PID, simulation_id: simB, run_id: rid } }).catch(() => {});
  }
  host?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

/** What the view draws now (window.__CFD_VIEW_ACTORS__), and its result actors by name. */
const viewActors = (page) =>
  page.evaluate((re) => {
    const v = window.__CFD_VIEW_ACTORS__();
    const rx = new RegExp(re);
    const shown = [...v.main, ...v.compare.map((a) => ({ ...a, name: a.name.startsWith('b:') ? a.name : 'b:' + a.name }))];
    return { ...v, results: shown.filter((a) => rx.test(a.name)).map((a) => a.name) };
  }, RESULT_ACTOR);
const resultActors = async (page) => (await viewActors(page)).results;

/** The view is done loading (the chip may still say a run solves). */
async function viewSettled(page) {
  await page.waitForFunction(() => {
    const chip = document.getElementById('viewport-job-chip');
    if (!chip || chip.hidden) return true;
    const label = document.getElementById('viewport-job-label')?.textContent || '';
    return !/^(Opening project|Preparing|Loading)/.test(label);
  }, null, { timeout: 180_000 });
}

async function openProject(page, pid = PID) {
  await page.goto(api(`/#/p/${pid}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  await viewSettled(page);
}

/** The case the page has attached ('' when none). */
const attachedCase = async (page) => norm(await page.evaluate(() => String(window.__CFD_RESULTS_ON_SCREEN__?.().case_dir || '')));

/** Expand a tree item by its twisty (no click on its label: that would open its panel). */
async function expand(li) {
  await expect(li).toBeVisible(STEP);
  if (!(await li.evaluate((el) => el.classList.contains('expanded')))) await li.locator(':scope > .tree-row .tw').click();
}

/** Click a study's row in the tree, as the person does. */
async function clickStudy(page, sim) {
  await page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row .tl`).first().click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId), STEP).toBe(sim);
  // A study shown for the first time opens folded: its twisty shows its runs.
  await expand(page.locator(`#left-tree li[data-w17-sim-id="${sim}"]`).first());
}

/** Open a run's Results from the tree (its study first when another is shown). */
async function openResults(page, sim, rid) {
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sim) await clickStudy(page, sim);
  await expand(page.locator(`#left-tree [data-w17-sim-id="${sim}"] li[data-w27-sim-control="1"]`).first());
  await expand(page.locator(`#left-tree li[data-w27-run="${rid}"]`).first());
  await page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
  await expect.poll(async () => (await viewActors(page)).results_view, STEP).toBe(true);
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await viewSettled(page);
}

/** The trace on and drawn (switched on with its toolbar button when the run's view has it off). */
async function ensureTrace(page) {
  const btn = page.locator('#filters-toolbar-group .tb-btn[data-label="Particle Trace"]');
  await expect(btn).toBeVisible(STEP);
  // A saved view brings it back by itself; give its restore a moment before switching it on.
  await expect.poll(async () => (await viewActors(page)).pt.enabled, { timeout: 5_000 }).toBe(true).catch(() => {});
  if (!(await viewActors(page)).pt.enabled) await btn.click();
  await expect(page.locator('#pt-faces-hint')).toHaveText(TRACE_HINT, { timeout: 90_000 });
  await expect.poll(async () => (await viewActors(page)).main.find((a) => a.name === 'particle-trace')?.points || 0, STEP).toBeGreaterThan(0);
  return (await viewActors(page)).main.find((a) => a.name === 'particle-trace').bounds;
}

/** The trace of a run's saved view back by itself, nothing clicked, and drawn. */
async function traceRestored(page, label) {
  await expect
    .poll(async () => (await viewActors(page)).pt.enabled, { timeout: 30_000, message: `${label}: the saved view switches the trace on` })
    .toBe(true);
  await expect(page.locator('#pt-faces-hint')).toHaveText(TRACE_HINT, { timeout: 90_000 });
  await expect.poll(async () => (await viewActors(page)).main.find((a) => a.name === 'particle-trace')?.points || 0, STEP).toBeGreaterThan(0);
  return (await viewActors(page)).main.find((a) => a.name === 'particle-trace').bounds;
}

/** Run A's view as the server keeps it. */
const savedViewOfA = async (request) =>
  (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${SIM_A}`)).runs?.find((r) => String(r.id) === runA.rid)?.current_view;

/**
 * Coloured pixels in the view (max - min channel > 80: the trace's velocity colours; the CAD,
 * its edges and the background are greys), outside the axes triad. With `tb` the camera
 * first looks at those bounds from +z (a forced render, as __CFD_THEME__.screenBox does).
 */
const colouredPixels = (page, tb) =>
  page.evaluate((b) => {
    const ren = window.__CFD_VIEW__.renderer;
    if (b) {
      const cam = ren.getActiveCamera();
      const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
      const d = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) || 1;
      cam.setParallelProjection(false);
      cam.setFocalPoint(c[0], c[1], c[2]);
      cam.setPosition(c[0], c[1], c[2] + 2.6 * d);
      cam.setViewUp(0, 1, 0);
      ren.resetCameraClippingRange();
    }
    const canvas = document.querySelector('#viewer canvas');
    const W = canvas.width;
    const H = canvas.height;
    const rgb = window.__CFD_THEME__.screenBox(0, 0, W, H);
    const cr = canvas.getBoundingClientRect();
    const k = W / cr.width;
    const slot = document.getElementById('viewport-triad-slot');
    const sr = slot ? slot.getBoundingClientRect() : null;
    const tri = sr && sr.width ? [(sr.left - cr.left) * k, (sr.top - cr.top) * k, (sr.right - cr.left) * k, (sr.bottom - cr.top) * k] : null;
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (tri && x >= tri[0] && x < tri[2] && y >= tri[1] && y < tri[3]) continue;
        const i = (y * W + x) * 3;
        const r = rgb[i];
        const g = rgb[i + 1];
        const bl = rgb[i + 2];
        if (Math.max(r, g, bl) - Math.min(r, g, bl) > 80) n++;
      }
    }
    return n;
  }, tb || null);

/**
 * Coloured pixels in a screenshot of the canvas as the screen shows it (no render forced;
 * the overlays over the view masked grey), with their bounding box. A screenshot that has
 * any is kept with the test's output.
 */
let shots = 0;
async function colouredOnScreen(page) {
  const canvas = page.locator('#viewer canvas');
  const masks = ['#viewport-triad-slot', '#viewport-axes-key', '#viewport-job-chip', '.legend', '#tree-detail', '#filters-panel', '.viewport-chip', '#compare-bar'].map((s) => page.locator(s));
  const png = await canvas.screenshot({ mask: masks, maskColor: '#808080', animations: 'disabled' });
  // The axes triad the canvas draws (it reaches a little past its slot) and its key are not counted.
  const skip = await page.evaluate(() => {
    const cr = document.querySelector('#viewer canvas').getBoundingClientRect();
    return ['viewport-triad-slot', 'viewport-axes-key']
      .map((id) => document.getElementById(id)?.getBoundingClientRect())
      .filter((r) => r && r.width)
      .map((r) => [r.left - cr.left - 16, r.top - cr.top - 16, r.right - cr.left + 16, r.bottom - cr.top + 16]);
  });
  const found = await page.evaluate(async ({ b64, skip }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    const box = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < d.length; i += 4) {
      if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 80) {
        const x = (i / 4) % c.width;
        const y = Math.floor(i / 4 / c.width);
        if (skip.some((r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3])) continue;
        n++;
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
    }
    return { n, box };
  }, { b64: png.toString('base64'), skip });
  if (found.n) {
    const file = test.info().outputPath(`coloured-${++shots}.png`);
    writeFileSync(file, png);
    stage(`coloured pixels ${found.n} in box ${found.box.join(',')}: ${file}`);
  }
  return found.n;
}

/** For `ms`, every sample: no result actor drawn, no trace legend, no coloured pixel on screen. */
async function staysClear(page, ms, label) {
  const until = Date.now() + ms;
  let samples = 0;
  do {
    const v = await viewActors(page);
    const onScreen = await colouredOnScreen(page);
    if (v.results.length || onScreen) stage(`${label}: sample ${samples} draws ${JSON.stringify(v.results)}, ${onScreen} coloured pixels on screen`);
    expect(v.results, `${label}: result actors drawn (sample ${samples})`).toEqual([]);
    expect(v.results_view, `${label}: Results are closed`).toBe(false);
    await expect(page.locator('#legend-pt')).toBeHidden();
    expect(onScreen, `${label}: coloured pixels on screen (sample ${samples})`).toBe(0);
    samples += 1;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  return samples;
}

test("Daniel's flow: a steady run's trace, then another study's Run 2 started: the solving run's view shows no trace, before and after a reload", async ({ page, request }) => {
  test.setTimeout(360_000);
  // As for a run that finished in this session, the background prefetch has not warmed Run A
  // yet: its attach of A's case at the project's open (when it comes) fails.
  let refusing = true;
  const refuse = async (route) => {
    let ofA = false;
    try {
      ofA = norm(JSON.parse(route.request().postData() || '{}').case_dir) === norm(runA.caseDir);
    } catch {
      ofA = false;
    }
    if (refusing && ofA) await route.abort().catch(() => {});
    else await route.continue().catch(() => {});
  };
  await page.route('**/api/case/attach', refuse);
  await openProject(page);
  await page.waitForTimeout(3_000);
  refusing = false;
  await openResults(page, SIM_A, runA.rid);
  const tb = await ensureTrace(page);
  stage(`A's trace drawn, bounds ${tb.map((x) => x.toFixed(3)).join(' ')}`);
  // A steady run's Animation is the particle trace's.
  await page.locator('#filters-toolbar-group .tb-btn[data-label="Animation"]').click();
  await expect.poll(async () => (await viewActors(page)).anim_type, STEP).toBe('Particle Trace');
  const before = await colouredPixels(page, tb);
  expect(before, 'the trace shows in its Results').toBeGreaterThanOrEqual(500);
  await expect.poll(async () => (await savedViewOfA(request))?.pt?.enabled, { timeout: 15_000, message: "A's view is saved with its trace" }).toBe(true);

  // To study B, its Run 2, Start.
  await clickStudy(page, simB);
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: simB, runId: run2, reload: false });
  await panel.locator('[data-run-start]').click();
  await expect(panel.locator('[data-run-stop="1"]')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await runRow(request, { base: host.base, projectId: PID, simulationId: simB, runId: run2 })).status, STEP).toBe('running');
  stage('Run 2 solving');
  const samples = await staysClear(page, 4_000, 'Run 2 solving');
  expect(await colouredPixels(page, tb), 'nothing where the trace was').toBe(0);
  stage(`clear over ${samples} samples`);
  // Leaving switched the trace off in the page only: A's saved view still has it.
  expect((await savedViewOfA(request))?.pt?.enabled, "A's saved view keeps its trace after leaving").toBe(true);

  // After a reload: the same, and the detector reads 0 here too (it sees no false colour).
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: simB, runId: run2, reload: false });
  expect(await colouredPixels(page, tb), 'baseline after a reload').toBe(0);
  await staysClear(page, 2_000, 'after a reload');
  await postOk(request, '/api/run/stop', { project_id: PID, simulation_id: simB, run_id: run2 });
  await waitSlotFree(request, { base: host.base });
});

test('Home and back, and a switch to another project: the setup view shows no trace (the project-open prefetch draws none)', async ({ page }) => {
  test.setTimeout(300_000);
  await openProject(page);
  await openResults(page, SIM_A, runA.rid);
  const tb = await ensureTrace(page);

  // Home, then the project again from its card.
  await page.locator('#wb-home').click();
  const card = page.locator(`.home-card[data-project-id="${PID}"]`);
  await expect(card).toBeVisible(STEP);
  await card.dblclick();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await viewSettled(page);
  // A run's panel: the background prefetch attaches the newest finished run (A) meanwhile.
  await openRunPanel(page, { base: host.base, projectId: PID, simulationId: SIM_A, runId: runA2.rid, reload: false });
  await expect.poll(() => attachedCase(page), { timeout: 30_000, message: 'the prefetch attaches Run A' }).toBe(norm(runA.caseDir));
  await staysClear(page, 3_000, 'Home and back');
  expect(await colouredPixels(page, tb), 'nothing where the trace was').toBe(0);

  // From A's Results straight to the other project (its newest run has the same patches).
  await openResults(page, SIM_A, runA.rid);
  await ensureTrace(page);
  await page.goto(api(`/#/p/${PID2}`));
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID2, { timeout: 90_000 });
  await viewSettled(page);
  await openRunPanel(page, { base: host.base, projectId: PID2, simulationId: SIM_A, runId: runOther.rid, reload: false });
  await expect.poll(() => attachedCase(page), { timeout: 30_000, message: "the prefetch attaches the other project's run" }).toBe(norm(runOther.caseDir));
  await staysClear(page, 3_000, 'another project');
  expect(await colouredPixels(page, tb), 'nothing where the trace was').toBe(0);
});

test("late trace answers: one asked before leaving never draws on the setup view, and A's never lands on A2's Results", async ({ page }) => {
  test.setTimeout(300_000);
  // A's trace at iteration 50 is held from the start (its Results warm the other frame too):
  // the person moves to 50, then leaves; then it answers.
  const holdA = [];
  let holding = true;
  const ofA50 = (url) => {
    const q = new URL(url).searchParams;
    return norm(q.get('case')) === norm(runA.caseDir) && q.get('time') === '50';
  };
  const hold = async (route) => {
    if (holding && ofA50(route.request().url())) holdA.push(route);
    else await route.continue().catch(() => {});
  };
  await page.route('**/api/particle-trace**', hold);
  await openProject(page);
  await openResults(page, SIM_A, runA.rid);
  const tb = await ensureTrace(page);
  await page.evaluate(() => { void window.__CFD_W12_APPLY__({ time: '50' }); });
  await expect.poll(() => holdA.length, STEP).toBeGreaterThan(0);
  await clickStudy(page, simB);
  holding = false;
  for (const r of holdA.splice(0)) await r.continue().catch(() => {});
  await page.waitForTimeout(1_500);
  await staysClear(page, 3_000, 'a late answer after leaving');
  expect(await colouredPixels(page, tb), 'nothing where the trace was').toBe(0);

  // Inside Results, A to A2 (whose saved view has its own trace): A's late answer stays out.
  // (A fresh page: the answer above is in this one's frame cache now.)
  holding = true;
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await viewSettled(page);
  await openResults(page, SIM_A, runA.rid);
  await ensureTrace(page);
  await page.evaluate(() => { void window.__CFD_W12_APPLY__({ time: '50' }); });
  await expect.poll(() => holdA.length, STEP).toBeGreaterThan(0);
  await expand(page.locator(`#left-tree li[data-w27-run="${runA2.rid}"]`).first());
  await page.locator(`#left-tree [data-w27-run-results="${runA2.rid}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#pt-faces-hint')).toHaveText(TRACE_HINT, { timeout: 90_000 });
  const frame = async () => (await page.evaluate(() => window.__CFD_VIEW_ACTORS__().pt.frame)) || {};
  await expect.poll(async () => norm((await frame()).case), STEP).toBe(norm(runA2.caseDir));
  holding = false;
  for (const r of holdA.splice(0)) await r.continue().catch(() => {});
  await page.waitForTimeout(2_000);
  const shown = await frame();
  expect(norm(shown.case), "the trace drawn is A2's").toBe(norm(runA2.caseDir));
  expect(String(shown.time)).toBe('100');
  await page.unroute('**/api/particle-trace**', hold);
});

test("late iso answers: A's iso surface and iso volume still loading when A2's Results open never draw on them", async ({ page }) => {
  test.setTimeout(300_000);
  // The drawings (not their meta) of A's iso surface and iso volume are held: the person
  // turns both on in A's Results and opens A2's before they answer.
  const held = { '/api/iso-surface': [], '/api/iso-volume': [] };
  let holding = true;
  const ofA = (url) => url.pathname in held && norm(url.searchParams.get('case')) === norm(runA.caseDir);
  const hold = async (route) => {
    if (holding) held[new URL(route.request().url()).pathname].push(route);
    else await route.continue().catch(() => {});
  };
  await page.route(ofA, hold);
  await openProject(page);
  await openResults(page, SIM_A, runA.rid);
  const filters = page.locator('#filters-toolbar-group');
  await filters.locator('.tb-btn[data-label="Iso Surface"]').click();
  await expect.poll(() => held['/api/iso-surface'].length, { timeout: 90_000, message: "A's iso surface is asked for" }).toBeGreaterThan(0);
  await filters.locator('.tb-btn[data-label="Iso Volume"]').click();
  await expect.poll(() => held['/api/iso-volume'].length, { timeout: 90_000, message: "A's iso volume is asked for" }).toBeGreaterThan(0);

  // A2's Results from the tree (its saved view has the trace on), then A's answers land.
  await expand(page.locator(`#left-tree li[data-w27-run="${runA2.rid}"]`).first());
  await page.locator(`#left-tree [data-w27-run-results="${runA2.rid}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#pt-faces-hint')).toHaveText(TRACE_HINT, { timeout: 90_000 });
  await expect.poll(async () => norm(((await viewActors(page)).pt.frame || {}).case), STEP).toBe(norm(runA2.caseDir));
  holding = false;
  const late = [...held['/api/iso-surface'].splice(0), ...held['/api/iso-volume'].splice(0)];
  for (const r of late) await r.continue().catch(() => {});
  stage(`released ${late.length} held iso answers of A on A2's Results`);
  await page.waitForTimeout(1_500);
  const until = Date.now() + 3_000;
  let samples = 0;
  do {
    const names = (await viewActors(page)).main.map((a) => a.name);
    expect(names.filter((n) => /^iso/.test(n)), `A's iso drawings on A2's Results (sample ${samples})`).toEqual([]);
    expect(names, "A2's own trace stays").toContain('particle-trace');
    samples += 1;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  // A2's Results show neither filter switched on.
  await expect(filters.locator('.tb-btn[data-label="Iso Surface"]')).not.toHaveClass(/is-active/);
  await expect(filters.locator('.tb-btn[data-label="Iso Volume"]')).not.toHaveClass(/is-active/);
  await expect(page.locator('#iso-block')).toBeHidden();
  await expect(page.locator('#iv-block')).toBeHidden();
  await page.unroute(ofA, hold);
});

test('iso surface and iso volume with arrows, a plot path and a seed region: none stays after leaving Results', async ({ page }) => {
  test.setTimeout(300_000);
  await openProject(page);
  await openResults(page, SIM_A, runA.rid);
  await ensureTrace(page);
  const filters = page.locator('#filters-toolbar-group');
  const named = async (name) => (await viewActors(page)).main.some((a) => a.name === name);

  await filters.locator('.tb-btn[data-label="Iso Surface"]').click();
  await expect.poll(() => named('iso'), { timeout: 90_000 }).toBe(true);
  await page.locator('#iso-vectors + .slider').click();
  await expect(page.locator('#iso-vectors')).toBeChecked();
  await expect.poll(() => named('iso-vectors'), { timeout: 90_000 }).toBe(true);
  await filters.locator('.tb-btn[data-label="Iso Volume"]').click();
  await expect.poll(() => named('iso-volume'), { timeout: 90_000 }).toBe(true);
  await page.locator('#iv-vectors + .slider').click();
  await expect(page.locator('#iv-vectors')).toBeChecked();
  await expect.poll(() => named('iso-volume-vectors'), { timeout: 90_000 }).toBe(true);
  await filters.locator('.tb-btn[data-label="Plot Over Path"]').click();
  for (const p of ['0.005, 0.05, 0.005', '0.095, 0.05, 0.005']) {
    await page.locator('#pop-pick').fill(p);
    await page.locator('#pop-add-point').click();
  }
  await page.locator('#pop-generate').click();
  await expect(page.locator('#pop-chart-wrap')).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => named('plot-path'), STEP).toBe(true);
  stage('iso, iso volume, their arrows and the path drawn');

  // Leave by clicking the other study: none of them stays.
  await clickStudy(page, simB);
  await staysClear(page, 3_000, 'after iso, iso volume and the path');

  // A saved view seeding from a region: its outline goes with the Results.
  await openResults(page, SIM_A, runRegion.rid);
  await expect.poll(() => named('pt-region-outline'), { timeout: 90_000 }).toBe(true);
  await clickStudy(page, simB);
  await staysClear(page, 3_000, 'after a seed region');
});

test("no over-correction: leaving A's Results and reopening them brings its trace back by itself, and a transient run's Results follow its new frames", async ({ page, request }) => {
  test.setTimeout(300_000);
  await waitSlotFree(request, { base: host.base });
  // A's saved view has the trace on, as the person left it (whatever ran before).
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: SIM_A, run_id: runA.rid, current_view: traceView() });
  await openProject(page);
  await openResults(page, SIM_A, runA.rid);
  const tb = await traceRestored(page, "opening A's Results");
  // The person opens the Animation (a change the live view saves 0.7 s later) and leaves for
  // the other study before that, so the view is saved on the way out: it still has the trace.
  // Back in the same page, the trace and the animation return with nothing clicked.
  const anim = page.locator('#filters-toolbar-group .tb-btn[data-label="Animation"]');
  await page.evaluate((sim) => {
    document.querySelector('#filters-toolbar-group .tb-btn[data-label="Animation"]').click();
    document.querySelector(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row .tl`).click();
  }, simB);
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId), STEP).toBe(simB);
  await expand(page.locator(`#left-tree li[data-w17-sim-id="${simB}"]`).first());
  await staysClear(page, 1_000, 'left A');
  await expect
    .poll(async () => {
      const v = await savedViewOfA(request);
      return `trace ${v?.pt?.enabled}, animation ${v?.anim?.open} ${v?.anim?.type}`;
    }, { timeout: 15_000, message: "A's saved view as the person left it" })
    .toBe('trace true, animation true Particle Trace');
  await openResults(page, SIM_A, runA.rid);
  await traceRestored(page, "reopening A's Results");
  expect(await colouredPixels(page, tb), 'the trace shows again').toBeGreaterThanOrEqual(500);
  await expect(anim).toHaveClass(/is-active/);
  await expect.poll(async () => (await viewActors(page)).anim_type, STEP).toBe('Particle Trace');

  // To study B, Run 1, Start (the fake solve); the solver writes its first two frames.
  await clickStudy(page, simB);
  const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: simB, runId: run1, reload: false });
  await panel.locator('[data-run-start]').click();
  await expect(panel.locator('[data-run-stop="1"]')).toBeVisible({ timeout: 60_000 });
  const row = () => runRow(request, { base: host.base, projectId: PID, simulationId: simB, runId: run1 });
  await expect.poll(async () => (await row()).status, STEP).toBe('running');
  await staysClear(page, 1_000, 'Run 1 solving');
  const caseDir = (await row()).case_dir;
  copyCavity(caseDir, ['0.1', '0.2']);
  await expect.poll(async () => Number((await row()).n_saved_times) || 0, STEP).toBe(2);

  // Its live Results open on the newest frame...
  await openResults(page, simB, run1);
  const shownTime = () => page.evaluate(() => String(window.__CFD_W12__?.time || ''));
  await expect.poll(shownTime, { timeout: 60_000 }).toBe('0.2');
  // ...and follow the next one the solver writes (a Particle Trace animation left over from
  // A would hold them still).
  cpSync(join(CAVITY, '0.3'), join(caseDir, '0.3'), { recursive: true });
  try {
    await expect.poll(shownTime, { timeout: 60_000, message: 'the view follows the new frame' }).toBe('0.3');
  } catch (e) {
    const r = await row();
    const v = await viewActors(page);
    const w12 = await page.evaluate(() => ({ anim: window.__CFD_W12__?.anim_state, times: window.__CFD_W12__?.available_times }));
    stage(`follow: server ${r.status} n=${r.n_saved_times}; results ${v.results_view}, animation ${v.anim_type}; ${JSON.stringify(w12)}`);
    throw e;
  }
  await expect(page.locator('#iter-current')).toContainText('0.3');
  await postOk(request, '/api/run/stop', { project_id: PID, simulation_id: simB, run_id: run1 });
  await waitSlotFree(request, { base: host.base });
});
