// RH3, numerics as settings (spec 5.1-5.9). What the person sees and what
// the Assistant reads and changes of a study's numerics and a run's PIMPLE outer loops, both ways.
// - The Run panel: Max Courant and the new outer relaxation changed in its Advanced settings are
//   what "Numerics as written" ([data-run-numerics]) shows and what the Assistant reads through
//   read_setup {what:'numerics'} (row R35), word for word; the Assistant's setup_edit of the same
//   keys is what the panel then shows, without a reload.
// - The Study panel: the numerics under Advanced settings' sub-heads (Schemes, Linear solvers,
//   Limiters); a first-order scheme shows its caution under the field, and the Assistant's
//   study_edit of it asks first with the same words (a card); the preset note counts the terms
//   changed and "Use the preset for all" clears them.
// - Bounds apply only to the key being edited: a stored value outside its range shows "Saved as
//   …, outside … It is used as saved.", stays on an edit of another field, is listed by Before
//   you start (setting_out_of_range) and blocks no Start; an edit outside the range is refused
//   with why, by the panel and by the Assistant alike.
// - Numerics at Continue (spec 5.3): a Start records what numerics the run started with
//   (numerics_used). After a study numerics change (steady relaxation p 0.3 -> 0.2) the stopped
//   run's Continue box says what changed, and Continue asks one question (#modal-run-continue):
//   "Continue with the new numerics", "Continue as it was" or Cancel (focused; Enter and Escape
//   answer it, and nothing is posted). The new numerics: it goes on with 0.2, records them, and
//   its Health block's earlier part names the change. A run whose saved results are from after
//   it became unhealthy gets the same one question, its health first. The Assistant's
//   run_continue without numerics is refused with the choice to make (no card); with "as_was" its
//   card lists the same differences, and it goes on as it started. A Heat Transfer steady run
//   gets the same question after a change of its energy relaxation.
// - A study whose numerics were never set (a new one): one change in the Study panel saves only
//   that change, and Continue names it alone, from its default ("Relaxation p 0.3 → 0.2"); set
//   back to the default, nothing differs. An unhealthy run's Continue box and the Assistant's card
//   with the new numerics say only Health on the continued part can tell, never that its settings
//   have not changed. "Numerics as written" of a started run names the preset it started with.
// - What stays fixed (the validation set's pipes, 2026-11-06): "Numerics as written" says the velocity
//   gradient and the flux are skew-corrected, that the limiter is on that velocity gradient (as on the
//   turbulence fields'), and what each model's walls are written with (k-omega SST: Spalding's law, stepwise
//   omega; k-epsilon: nutkWallFunction), as the Assistant reads it; the Study panel's model help gives
//   what k-omega SST's walls read at the y+ that were tested, not "any y+" or "below about 0.5", and
//   no y+ for Spalart-Allmaras, whose walls were not tested, and the Assistant reads that whole help
//   (catalog), word for word. Fails on the code before it: there were no such rows, the limiter was on
//   grad(U), and the Assistant read only the help's first 160 characters.
// - What a run was written with: a started run shows the rows its Start (or a Continue with the new
//   numerics) recorded when its case was written (numerics_used.written). After the study turns to
//   k-epsilon, a started k-omega SST run still shows SST's walls while a draft shows k-epsilon's
//   (Heat Transfer's Wall treatment row too), and rows an earlier writer recorded show as written; a
//   run started before the rows were recorded shows one row saying so, and so does a run whose
//   analysis reported none (its record false: "did not report"). The Assistant reads the same.
//   Fails on the code before it: a started run's rows were rebuilt from its numerics with today's
//   writer and the study's model now, and a run whose plan reported none read "started before".
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake): no WSL. Its fake solve
// replays a healthy steady log through the real health tracker (MAGNUSIM_TEST_SOLVE_LOG).
// Fails on the code before RH3: there were no such settings, no "Numerics as written" and no
// read_setup numerics; before its Continue part, a run recorded no numerics and Continue used
// the study's numerics without a word.
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { dockGate, dockSend, dockTurn, openDock, resultsIn, useScriptedModel } from './support/assistant.js';
import { openRunPanel } from './support/compute-slot.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKMESH = join(WEB, 'python', 'tests', 'fixtures', 'mesh-facts', 'checkmesh', 'ok-hex-2d.log');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const STEADY_LOG = join(WEB, 'python', 'tests', 'fixtures', 'health', 'calib', 'bfs-steady.log.gz');
const REGISTRY = JSON.parse(readFileSync(join(WEB, 'scripts', 'generated', 'registry.json'), 'utf8'));
const numericsKeys = (analysis) => Object.keys(REGISTRY.analysis.find((a) => a.key === analysis).numerics_schema.properties).sort();
const PID = 'run-numerics-e2e';
const STEP = { timeout: 30_000 };
const FIRST_ORDER =
  'First-order schemes are more stable but less accurate. Fix the time step or the mesh first; use first order only to get a run started.';
const LIMIT_OFF = 'Nothing caps the velocity. An unstable run stops with an error instead of running on with clipped cells. Fix the cause (the time step or the mesh).';
let host;
let fake;
let sim;
let meshId;

const api = (path) => `${host.base}${path}`;
const getJson = async (request, path) => (await request.get(api(path))).json();
async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}
const readSetup = (o) => ({ project_id: '', simulation_id: '', what: '', id: '', other_id: '', page: 0, ...o });
const study = (o) => ({ project_id: '', action: '', id: '', ids: [], analysis: '', geometry_id: '', copy_from: '', copy_mode: '', time_dependency: '', name: '', plugin: '', kind: '', values: [], ...o });
const setup = (o) => ({ project_id: '', simulation_id: '', kind: '', action: '', id: '', other_id: '', name: '', type: '', faces: [], bodies: [], values: [], rev: 0, ...o });
const runRow = async (request, id) => (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${sim}`)).runs.find((r) => String(r.id) === id) || {};
const studyRec = async (request) => (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${sim}`)).simulation;
const lastResults = () => resultsIn(fake.requests().at(-1));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  fake = await startFakeLlm();
  const tmp = e2eTemp('run-numerics');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'Numerics project');
  host = await startHost({
    name: 'run-numerics',
    tmp,
    projects,
    env: {
      MAGNUSIM_TEST_ASSISTANT: '1',
      MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base,
      MAGNUSIM_TEST_COMPUTE: 'fake',
      MAGNUSIM_TEST_MESH_SECONDS: '1',
      MAGNUSIM_TEST_MESH_CHECKMESH: CHECKMESH,
      MAGNUSIM_TEST_SOLVE_SECONDS: '600',
      MAGNUSIM_TEST_SOLVE_LOG: STEADY_LOG,
      MAGNUSIM_TEST_SOLVE_PACE_MS: '5',
      PYTHONPATH: [join(WEB, 'python'), join(WEB, 'python', 'sdk'), process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter),
    },
  });
  const doc = await getJson(request, `/api/mesh?project_id=${PID}`);
  sim = doc.simulation_id;
  meshId = String(doc.mesh.id);
  const gen = await request.post(api('/api/mesh/generate'), { data: { project_id: PID, simulation_id: sim, mesh_id: meshId } });
  expect(gen.status(), await gen.text()).toBeLessThan(300);
  await expect.poll(async () => (await getJson(request, `/api/mesh?project_id=${PID}&mesh_id=${meshId}`)).mesh?.live_mesh_result?.status, { timeout: 90_000 }).toBe('done');
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient' });
});

test.afterAll(async () => {
  host?.stop();
  await fake?.stop();
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
});

async function draft(request, name, transient = { end_time: 1, write_count: 10, max_co: 1, n_outer_correctors: 1, n_correctors: 2 }) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: sim, name, mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/update', { project_id: PID, simulation_id: sim, run_id: rid, transient });
  return rid;
}

/** "Numerics as written", opened; its rows by label. */
async function numericsOf(panel) {
  const box = panel.locator('[data-run-numerics="1"]');
  await expect(box).toBeVisible(STEP);
  if (!(await box.evaluate((el) => el.open))) await box.locator('summary').click();
  return (label) => box.locator(`[data-run-numerics-row="${label}"] .run-numerics-value`);
}

/** The Run panel's Advanced settings, opened. */
async function advanced(panel) {
  const box = panel.locator('[data-run-transient="1"] details.mesh-advanced').first();
  if (!(await box.evaluate((el) => el.open))) await box.locator('summary').first().click();
  return box;
}

/** A number typed into a field and committed (Enter). */
async function typeNumber(scope, label, value) {
  const input = scope.getByLabel(label, { exact: true });
  await input.click();
  await input.fill(String(value));
  await input.press('Enter');
}

async function openStudyPanel(page) {
  await page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row`).first().click();
  const panel = page.locator('#panel-study-settings .cfd-island');
  await expect(panel.locator('[data-study-panel="1"]')).toBeVisible(STEP);
  const numerics = panel.locator('.sim-study-numerics');
  const adv = numerics.locator('details.mesh-advanced').first();
  if (!(await adv.evaluate((el) => el.open))) await adv.locator('summary').first().click();
  return numerics;
}

test.describe('the person and the Assistant', () => {
  test.beforeEach(async ({ request }) => {
    await postOk(request, '/api/test/assistant/reset', {});
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(async () => {
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  /** Runs one dock turn and allows any card it raises (returns each card's title and copy). */
  async function turn(page, text) {
    await dockSend(page, text);
    const card = dockGate(page);
    const ended = dockTurn(page).locator('[data-turn-end="done"]');
    const cards = [];
    for (let i = 0; i < 3; i++) {
      await expect(card.or(ended)).toBeVisible({ timeout: 60_000 });
      if (await ended.isVisible()) break;
      cards.push({ title: await card.locator('.dock-gate-title').textContent(), copy: await card.locator('.dock-gate-copy').textContent() });
      await card.locator('[data-gate-answer="yes"]').click(STEP);
    }
    await expect(ended).toBeVisible({ timeout: 60_000 });
    return cards;
  }

  test('Max Courant and the outer relaxation changed in the Run panel are what the Assistant reads (read_setup numerics), and the reverse', async ({ page, request }) => {
    test.setTimeout(240_000);
    const rid = await draft(request, 'Run_numerics');
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = await advanced(panel);
    // The person: 3 outer correctors, Max Courant 4, outer relaxation of p 0.4.
    await typeNumber(box, 'Outer correctors', 3);
    await expect.poll(async () => (await runRow(request, rid)).transient?.n_outer_correctors, STEP).toBe(3);
    await typeNumber(box, 'Max Courant number', 4);
    await expect.poll(async () => (await runRow(request, rid)).transient?.max_co, STEP).toBe(4);
    await typeNumber(box, 'Outer relaxation p', 0.4);
    await expect.poll(async () => (await runRow(request, rid)).transient?.outer_relax_p, STEP).toBe(0.4);
    const row = await numericsOf(panel);
    await expect(row('Max Courant')).toHaveText('4', STEP);
    await expect(row('Outer correctors')).toHaveText('3 (PIMPLE)', STEP);
    await expect(row('Outer relaxation')).toHaveText('p 0.4, equations 0.7; the final outer loop 1', STEP);
    await expect(row('Velocity limit')).toHaveText(/^\d+(\.\d+)? m\/s (= 10 × [0-9.]+ m\/s|\(at least 50 m\/s; 10 × [0-9.]+ m\/s is less\))( \(inlet .+\))?$/);
    const shown = {
      max_co: await row('Max Courant').textContent(),
      outer: await row('Outer relaxation').textContent(),
      limit: await row('Velocity limit').textContent(),
    };
    // The Assistant reads the same rows (R35), then changes Max Courant and the outer relaxation.
    const seen = {};
    fake.reply(
      { tools: [{ name: 'read_setup', input: readSetup({ what: 'numerics', id: rid }) }] },
      () => {
        seen.read = lastResults()[0];
        return {
          tools: [
            {
              name: 'setup_edit',
              input: setup({ kind: 'run', action: 'update', id: rid, values: [{ key: 'transient.max_co', value: '2' }, { key: 'transient.outer_relax_p', value: '0.5' }] }),
            },
          ],
        };
      },
      () => {
        seen.edit = lastResults()[0];
        return { tools: [{ name: 'read_setup', input: readSetup({ what: 'numerics', id: rid }) }] };
      },
      () => {
        seen.again = lastResults()[0];
        return { text: 'Max Courant 2 and outer relaxation 0.5 are set.' };
      },
    );
    await openDock(page);
    await turn(page, 'Read the numerics of Run_numerics, then set Max Courant 2 and outer relaxation of p 0.5.');
    expect(seen.read.ok, JSON.stringify(seen.read)).toBe(true);
    const rows = (r) => Object.fromEntries(r.data.rows.map((x) => [`${x.group}/${x.label}`, x.value]));
    expect(seen.read.data.shown_in).toBe('Run panel → Numerics as written');
    expect(rows(seen.read)['PIMPLE/Max Courant']).toBe(shown.max_co);
    expect(rows(seen.read)['PIMPLE/Outer relaxation']).toBe(shown.outer);
    expect(rows(seen.read)['Limiters/Velocity limit']).toBe(shown.limit);
    expect(seen.edit.ok, JSON.stringify(seen.edit)).toBe(true);
    expect(rows(seen.again)['PIMPLE/Outer relaxation']).toBe('p 0.5, equations 0.7; the final outer loop 1');
    // The person sees the Assistant's change without a reload: the fields and Numerics as written.
    await expect(box.getByLabel('Max Courant number', { exact: true })).toHaveValue('2', STEP);
    await expect(box.getByLabel('Outer relaxation p', { exact: true })).toHaveValue('0.5', STEP);
    await expect(row('Max Courant')).toHaveText('2', STEP);
    await expect(row('Outer relaxation')).toHaveText('p 0.5, equations 0.7; the final outer loop 1', STEP);
    // After a reload too.
    const again = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const row2 = await numericsOf(again);
    await expect(row2('Outer relaxation')).toHaveText('p 0.5, equations 0.7; the final outer loop 1', STEP);
  });

  test('a first-order scheme shows its caution under the field, and the Assistant asks first with the same words', async ({ page, request }) => {
    test.setTimeout(240_000);
    const rid = await draft(request, 'Run_caution');
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    const numerics = await openStudyPanel(page);
    // The sub-heads of Advanced settings.
    await expect(numerics.locator('[data-schema-subhead="schemes"]')).toHaveText('Schemes');
    await expect(numerics.locator('[data-schema-subhead="linear_solvers"]')).toHaveText('Linear solvers');
    await expect(numerics.locator('[data-schema-subhead="limiters"]')).toHaveText('Limiters');
    // The person: momentum first order, and its caution under the field.
    await numerics.locator('[data-schema-key="momentum_convection"] select').selectOption({ label: 'First order (upwind)' });
    await expect(numerics.locator('[data-schema-caution="momentum_convection"]')).toHaveText(FIRST_ORDER, STEP);
    await expect.poll(async () => (await studyRec(request)).momentum_convection, STEP).toBe('first_order');
    // The run's Numerics as written follows the study.
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const row = await numericsOf(panel);
    await expect(row('Momentum convection')).toHaveText('Gauss upwind', STEP);
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, momentum_convection: 'second_order' });
    // The Assistant: the same caution on its card, asked first; after Allow the study has it.
    fake.reply(
      { tools: [{ name: 'study_edit', input: study({ action: 'set', id: sim, values: [{ key: 'turbulence_convection', value: '"first_order"' }] }) }] },
      () => ({ text: 'Turbulence convection is first order.' }),
    );
    await openDock(page);
    const cards = await turn(page, 'Make the turbulence convection first order.');
    expect(cards.length).toBe(1);
    expect(cards[0].copy).toContain(FIRST_ORDER);
    await expect.poll(async () => (await studyRec(request)).turbulence_convection, STEP).toBe('first_order');
    const back = await openStudyPanel(page);
    await expect(back.locator('[data-schema-caution="turbulence_convection"]')).toHaveText(FIRST_ORDER, STEP);
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, turbulence_convection: null });
  });

  test('the velocity limit Off shows its caution where it is a choice (Incompressible Flow: Automatic by default)', async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    const numerics = await openStudyPanel(page);
    const limit = numerics.locator('[data-schema-key="velocity_limit"] select');
    await expect(limit.locator('option:checked')).toHaveText('Automatic', STEP);
    await expect(numerics.locator('[data-schema-caution="velocity_limit"]')).toHaveCount(0);
    await limit.selectOption({ label: 'Off' }, STEP);
    await expect(numerics.locator('[data-schema-caution="velocity_limit"]')).toHaveText(LIMIT_OFF, STEP);
    await expect.poll(async () => (await studyRec(request)).velocity_limit, STEP).toBe('off');
    // Back to Automatic: the caution goes.
    await limit.selectOption({ label: 'Automatic' }, STEP);
    await expect(numerics.locator('[data-schema-caution="velocity_limit"]')).toHaveCount(0, STEP);
    await expect.poll(async () => (await studyRec(request)).velocity_limit ?? 'auto', STEP).toBe('auto');
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, velocity_limit: null });
  });
});

test('a stored value outside its range is used as saved, kept on another edit, listed and never blocks Start; an edit outside it is refused', async ({ page, request }) => {
  test.setTimeout(240_000);
  // Saved outside its range (by an older bound or by hand): p tolerance 1e-2 (1e-12 to 1e-3).
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, p_tolerance: 0.01 });
  const rid = await draft(request, 'Run_range');
  try {
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    let numerics = await openStudyPanel(page);
    await expect(numerics.locator('[data-schema-saved-outside="p_tolerance"]')).toHaveText('Saved as 1e-2, outside 1e-12 to 1e-3. It is used as saved.', STEP);
    // Another field's edit keeps it.
    await typeNumber(numerics, 'p max iterations', 300);
    await expect.poll(async () => (await studyRec(request)).p_max_iter, STEP).toBe(300);
    expect((await studyRec(request)).p_tolerance).toBe(0.01);
    // An edit outside its range is refused, with why; nothing is saved.
    await typeNumber(numerics, 'p relative tolerance', 0.9);
    await expect(numerics.locator('[data-schema-refused="p_rel_tol"]')).toHaveText('Not saved: 0.9 is outside 0 to 0.5.', STEP);
    await page.waitForTimeout(800);
    expect((await studyRec(request)).p_rel_tol ?? 0.01).toBe(0.01);
    // Before you start lists it; Start stays enabled.
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const check = panel.locator('[data-run-check="1"]');
    await expect(check.locator('[data-run-check-row="setting_out_of_range"] [data-run-check-text="1"]')).toHaveText('Saved p tolerance 1e-2 is outside 1e-12 to 1e-3.', STEP);
    await expect(panel.locator('[data-run-start="1"]')).toBeEnabled();
    const row = await numericsOf(panel);
    await expect(row('p')).toHaveText('GAMG, tolerance 0.01, relTol 0.01, maxIter 300', STEP);
    // After a reload the study still has it as saved.
    numerics = await openStudyPanel(page);
    await expect(numerics.locator('[data-schema-saved-outside="p_tolerance"]')).toBeVisible(STEP);
    expect((await studyRec(request)).p_tolerance).toBe(0.01);
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, p_tolerance: null, p_max_iter: null, p_rel_tol: null });
  }
});

test('the preset note counts the terms changed, and "Use the preset for all" clears them', async ({ page, request }) => {
  test.setTimeout(180_000);
  // The steady study: its preset (Robust) with two of its terms changed.
  await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
  try {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, grad_limiter: 'light', non_orth_correction: 'full' });
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    const numerics = await openStudyPanel(page);
    const panel = page.locator('#panel-study-settings .cfd-island');
    const note = panel.locator('[data-study-preset-note="1"]');
    await expect(note).toContainText('Robust, 2 terms changed', STEP);
    await note.locator('[data-study-preset-reset="1"]').click();
    await expect.poll(async () => {
      const s = await studyRec(request);
      return [s.grad_limiter ?? null, s.non_orth_correction ?? null];
    }, STEP).toEqual([null, null]);
    await expect(note).toHaveCount(0, STEP);
    // Blank again: the select says so, not its first choice.
    const grad = numerics.locator('[data-schema-key="grad_limiter"] select');
    await expect(grad.locator('option:checked')).toHaveText('Not set', STEP);
    // And the person can set a choice back to blank ("Not set" saves null).
    await grad.selectOption({ label: 'Light (cellMDLimited 0.5)' });
    await expect.poll(async () => (await studyRec(request)).grad_limiter, STEP).toBe('light');
    await grad.selectOption({ label: 'Not set' });
    await expect.poll(async () => (await studyRec(request)).grad_limiter ?? null, STEP).toBeNull();
  } finally {
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Transient', grad_limiter: null, non_orth_correction: null });
  }
});

// ---------------------------------------------------------------- numerics at Continue (spec 5.3)

const compute = (o) => ({ project_id: '', simulation_id: '', action: '', mesh_id: '', run_id: '', extra_iterations: 0, end_time: 0, frames: '', time: -1, plugin: '', chain: [], estimate_minutes: 0, numerics: '', ...o });
const changedLine = (name, list) => `The study's numerics changed after "${name}" started: ${list}.`;

/**
 * A run of the study started (its Start records what numerics it starts with), then stopped, its
 * result saved at iteration 50 (the cavity's last frame), as a steady solve stopped there leaves it.
 */
async function stoppedRun(request, name, study = sim) {
  const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: study, name, mesh_id: meshId });
  const rid = String(made.run_id || made.run?.id || made.run?.run_id);
  await postOk(request, '/api/run/start', { project_id: PID, simulation_id: study, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
  await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
  await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  const caseDir = (await runRow(request, rid)).case_dir;
  cpSync(join(CAVITY, '0.5'), join(caseDir, '50'), { recursive: true });
  const runJson = join(dirname(caseDir), 'run.json');
  patchRun(runJson, { time_dependency: 'Steady-state', has_results: true, n_saved_times: 1, last_saved_iteration: 50, iteration: 50, n_steps: 50 });
  return { rid, caseDir, runJson };
}

function patchRun(runJson, more) {
  writeFileSync(runJson, JSON.stringify({ ...JSON.parse(readFileSync(runJson, 'utf8')), ...more }, null, 2));
}

/** What the page posts to start or continue a run, or to queue one (not the queue's kicks). */
function postsOf(page) {
  const posted = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/(run\/(continue|start|reopen)|compute-queue)(\?|$)/.test(r.url())) posted.push({ url: r.url(), body: r.postDataJSON() });
  });
  return posted;
}

test.describe('numerics at Continue', () => {
  test.beforeAll(async ({ request }) => {
    // A steady study with relaxation p 0.3 saved.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.3 });
  });

  test.beforeEach(async ({ request }) => {
    await postOk(request, '/api/test/assistant/reset', {});
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(async () => {
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  test('the Continue box says what changed; Continue asks first, Cancel posts nothing; the new numerics go on with 0.2 and the run records them', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { rid } = await stoppedRun(request, 'Run_cn');
    // Its Start recorded what it started with: every numerics key of its analysis, blanks included.
    let row = await runRow(request, rid);
    expect(row.numerics_used).toMatchObject({ analysis: 'incompressible_steady', mode: 'steady' });
    expect(Object.keys(row.numerics_used.values).sort()).toEqual(numericsKeys('incompressible_steady'));
    const saved = await studyRec(request);
    expect(row.numerics_used.values).toEqual(Object.fromEntries(numericsKeys('incompressible_steady').map((k) => [k, saved[k] ?? null])));
    expect(row.numerics_used.values.relax_p).toBe(0.3);
    // The person lowers the study's relaxation of p.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.2 });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = panel.locator('[data-run-continue="1"]');
    const said = changedLine('Run_cn', 'Relaxation p 0.3 → 0.2');
    await expect(box.locator('[data-run-continue-numerics]')).toHaveText(said, STEP);
    const posted = postsOf(page);
    const dialog = page.locator('#modal-run-continue');
    const go = box.locator('[data-run-continue-go="1"]');

    // The question: three answers, Cancel focused; Escape answers Cancel.
    await go.click();
    await expect(dialog).toBeVisible(STEP);
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await expect(page.locator('#rcn-heading')).toHaveText('Continue "Run_cn"?');
    await expect(page.locator('#rcn-health')).toBeHidden();
    await expect(page.locator('#rcn-copy')).toHaveText(said);
    await expect(page.locator('#rcn-new')).toHaveText('Continue with the new numerics');
    await expect(page.locator('#rcn-new-line')).toHaveText("Goes on from iteration 50 with the study's numerics now. The run records the change.");
    await expect(page.locator('#rcn-as-was')).toHaveText('Continue as it was');
    await expect(page.locator('#rcn-as-was-line')).toHaveText('Goes on with the numerics it started with. The study keeps the new values for new runs.');
    await expect(page.locator('#rcn-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Enter answers Cancel too, and so does the Cancel button.
    await go.click();
    await expect(dialog).toBeVisible(STEP);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await go.click();
    await expect(dialog).toBeVisible(STEP);
    await page.locator('#rcn-cancel').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(800);
    expect(posted).toEqual([]);
    row = await runRow(request, rid);
    expect([row.status, row.numerics_used.values.relax_p]).toEqual(['stopped', 0.3]);

    // "Continue with the new numerics": it goes on with 0.2, and records them.
    await go.click();
    await expect(dialog).toBeVisible(STEP);
    await page.locator('#rcn-new').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => posted.length, STEP).toBe(1);
    expect([posted[0].url.endsWith('/api/run/continue'), posted[0].body.numerics]).toEqual([true, 'new']);
    await expect.poll(async () => (await runRow(request, rid)).numerics_used?.values?.relax_p, STEP).toBe(0.2);
    row = await runRow(request, rid);
    const entry = (row.continue_changes || []).find((e) => e.kind === 'numerics');
    expect(entry).toMatchObject({ by: 'person', from_iteration: 50, changes: [{ key: 'relax_p', label: 'Relaxation p', from: 0.3, to: 0.2 }] });
    expect(typeof entry.applied_at).toBe('string');
    // The Health block's earlier part names the change.
    await expect(panel.locator('[data-run-health-earlier="1"]').first()).toContainText('Then Relaxation p 0.3 → 0.2 from iteration 50.', { timeout: 60_000 });
    // "Numerics as written" shows what it goes on with, as the Assistant reads it (R35).
    const written = panel.locator('[data-run-numerics="1"]');
    await expect(written).toBeVisible(STEP);
    if (!(await written.evaluate((el) => el.open))) await written.locator('summary').click();
    await expect(written.locator('[data-run-numerics-group="Relaxation"] [data-run-numerics-row="p"] .run-numerics-value')).toHaveText('0.2', STEP);
    const read = await postOk(request, '/api/run/precheck', { project_id: PID, simulation_id: sim, run_id: rid });
    expect(read.numerics.find((n) => n.group === 'Relaxation' && n.label === 'p').value).toBe('0.2');
    await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
    await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
    // Nothing differs now: the line is gone and Continue asks nothing.
    await expect(box.locator('[data-run-continue-numerics]')).toHaveCount(0, STEP);
  });

  test('a run whose saved results are from after it became unhealthy gets one question, its health first', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { rid, runJson } = await stoppedRun(request, 'Run_fz');
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.25 });
    patchRun(runJson, {
      health_checked: true,
      health: {
        v: 1,
        verdict: 'unhealthy',
        at: new Date().toISOString(),
        step: 40,
        t: 40,
        unit: 'iteration',
        window: 25,
        live: false,
        checked: ['residuals_stalled'],
        skipped: [],
        findings: [{ code: 'residuals_stalled', level: 'error', text: 'The residuals stopped falling.', evidence: null, since_t: 10, fix: [] }],
        timeline: [{ t: 10, verdict: 'unhealthy' }],
        first_unhealthy: { t: 10, step: 10, wall_s: 5 },
        restart: 'from_zero',
      },
    });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = panel.locator('[data-run-continue="1"]');
    const health = box.locator('[data-run-continue-health="1"]');
    await expect(health).toBeVisible(STEP);
    await expect(box.locator('[data-run-continue-numerics]')).toHaveText(changedLine('Run_fz', 'Relaxation p 0.2 → 0.25'));
    const posted = postsOf(page);
    await box.locator('[data-run-continue-go="1"]').click();
    // One dialog, never two: the health copy first, then the numerics and the three answers.
    await expect(page.locator('#modal-run-continue')).toBeVisible(STEP);
    await expect(page.locator('#modal-confirm')).toBeHidden();
    // The box adds that only Health on the continued part can tell (the numerics changed); the
    // question's health is the from_zero copy alone.
    const fromZero = 'Its saved results (iteration 50) are from after it became unhealthy (iteration 10); continuing carries that on. A new run from t = 0 is safer.';
    await expect(health).toHaveText(`${fromZero} Health checks the continued part from iteration 50; whether the change is enough shows only there.`);
    await expect(page.locator('#rcn-health')).toHaveText(fromZero);
    await expect(page.locator('#rcn-copy')).toHaveText(changedLine('Run_fz', 'Relaxation p 0.2 → 0.25'));
    expect(await page.locator('#rcn-health').evaluate((el) => !!(el.compareDocumentPosition(document.getElementById('rcn-copy')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await expect(page.locator('#rcn-new')).toBeVisible();
    await expect(page.locator('#rcn-as-was')).toBeVisible();
    await expect(page.locator('#rcn-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-run-continue')).toBeHidden();
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await page.waitForTimeout(800);
    expect(posted).toEqual([]);
    expect((await runRow(request, rid)).status).toBe('stopped');
  });

  test('the Assistant: run_continue without numerics is refused with the choice, then "as_was" asks with the same differences and goes on as it started', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { rid } = await stoppedRun(request, 'Run_ai');
    expect((await runRow(request, rid)).numerics_used.values.relax_p).toBe(0.25);
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.15 });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const list = 'Relaxation p 0.25 → 0.15';
    await expect(panel.locator('[data-run-continue-numerics]')).toHaveText(changedLine('Run_ai', list), STEP);
    const seen = {};
    fake.reply(
      { tools: [{ name: 'compute', input: compute({ action: 'run_continue', run_id: rid, extra_iterations: 20 }) }] },
      () => {
        seen.none = lastResults()[0];
        return { tools: [{ name: 'compute', input: compute({ action: 'run_continue', run_id: rid, extra_iterations: 20, numerics: 'as_was' }) }] };
      },
      () => {
        seen.asWas = lastResults()[0];
        return { text: 'It goes on as it started.' };
      },
    );
    await openDock(page);
    await dockSend(page, 'Continue Run_ai for 20 more iterations.');
    const card = dockGate(page);
    await expect(card.locator('.dock-gate-copy')).toContainText(
      `Continues "Run_ai" with the numerics it started with; the study's newer values (${list}) are not used.`,
      { timeout: 60_000 },
    );
    // The call with no numerics was refused with the choice to make, and asked nothing.
    expect([seen.none.ok, seen.none.error.code]).toEqual([false, 'choose_numerics']);
    expect(seen.none.error.message).toBe(`The study's numerics changed after "Run_ai" started (${list}).`);
    expect(seen.none.error.hint).toBe('Pass numerics "as_was" to continue with the numerics it started with, or "new" to use the study\'s numerics now. Ask the person which.');
    await expect(page.locator('#modal-run-continue'), 'the person is asked nothing').toBeHidden();
    await card.locator('[data-gate-answer="yes"]').click(STEP);
    await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 90_000 });
    expect(seen.asWas.ok, JSON.stringify(seen.asWas)).toBe(true);
    // It went on with what it started with: its record and "Numerics as written" keep 0.25.
    await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
    const row = await runRow(request, rid);
    expect(row.numerics_used.values.relax_p).toBe(0.25);
    expect((row.continue_changes || []).some((e) => e.kind === 'numerics')).toBe(false);
    const read = await postOk(request, '/api/run/precheck', { project_id: PID, simulation_id: sim, run_id: rid });
    expect(read.numerics.find((n) => n.group === 'Relaxation' && n.label === 'p').value).toBe('0.25');
    await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
    await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
  });

  test('the study changed where the page did not see it: nothing starts, the box then says what changed, and Continue asks', async ({ page, request }) => {
    test.setTimeout(240_000);
    const { rid } = await stoppedRun(request, 'Run_race');
    const was = (await runRow(request, rid)).numerics_used.values.relax_p;
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = panel.locator('[data-run-continue="1"]');
    const go = box.locator('[data-run-continue-go="1"]');
    await expect(go).toBeEnabled(STEP);
    await expect(box.locator('[data-run-continue-numerics]')).toHaveCount(0);
    // Saved elsewhere (another window): this page still has the study as it was.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.12 });
    const posted = postsOf(page);
    await go.click();
    const said = changedLine('Run_race', `Relaxation p ${was} → 0.12`);
    await expect(panel.locator('[data-run-reason="1"]')).toContainText(`${said} Continue again to choose which numerics it goes on with.`, STEP);
    await expect(box.locator('[data-run-continue-numerics]')).toHaveText(said, STEP);
    expect(posted.map((x) => x.body.numerics ?? null)).toEqual([null]);
    expect((await runRow(request, rid)).status).toBe('stopped');
    // Continue now asks.
    await go.click();
    await expect(page.locator('#modal-run-continue')).toBeVisible(STEP);
    await expect(page.locator('#rcn-copy')).toHaveText(said);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-run-continue')).toBeHidden();
    await page.waitForTimeout(500);
    expect(posted.length).toBe(1);
  });

  test('a Heat Transfer steady run gets the same question after a change of its energy relaxation', async ({ page, request }) => {
    test.setTimeout(240_000);
    const ht = (await postOk(request, '/api/simulation', { project_id: PID, analysis_type: 'heat_transfer_steady', activate: true })).simulation.id;
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: ht, relax_h: 0.5 });
    const study = (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${ht}`)).simulation;
    // A run started with energy relaxation 0.5 (as a Start records it), stopped at iteration 50.
    const made = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: ht, name: 'Run_ht' });
    const rid = String(made.run_id || made.run?.id || made.run?.run_id);
    const caseDir = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${ht}`)).runs.find((r) => String(r.id) === rid).case_dir;
    cpSync(join(CAVITY, '0.5'), join(caseDir, '50'), { recursive: true });
    const values = Object.fromEntries(numericsKeys('heat_transfer_steady').map((k) => [k, study[k] ?? null]));
    expect(values.relax_h).toBe(0.5);
    patchRun(join(dirname(caseDir), 'run.json'), {
      status: 'stopped',
      stage: 'stopped',
      time_dependency: 'Steady-state',
      analysis_key: 'heat_transfer_steady',
      path_kind: 'buoyantSimpleFoam',
      has_results: true,
      n_saved_times: 1,
      last_saved_iteration: 50,
      iteration: 50,
      n_steps: 50,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      case_dir: caseDir,
      numerics_used: { analysis: 'heat_transfer_steady', mode: 'steady', at: new Date().toISOString(), values },
    });
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: ht, relax_h: 0.3 });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: ht, runId: rid });
    const box = panel.locator('[data-run-continue="1"]');
    const said = changedLine('Run_ht', 'Relaxation energy 0.5 → 0.3');
    await expect(box.locator('[data-run-continue-numerics]')).toHaveText(said, STEP);
    const posted = postsOf(page);
    await box.locator('[data-run-continue-go="1"]').click();
    await expect(page.locator('#modal-run-continue')).toBeVisible(STEP);
    await expect(page.locator('#rcn-heading')).toHaveText('Continue "Run_ht"?');
    await expect(page.locator('#rcn-copy')).toHaveText(said);
    await expect(page.locator('#rcn-new-line')).toHaveText("Goes on from iteration 50 with the study's numerics now. The run records the change.");
    await expect(page.locator('#rcn-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-run-continue')).toBeHidden();
    await page.waitForTimeout(800);
    expect(posted).toEqual([]);
    // The route refuses a Continue that does not say which, and queues nothing.
    const refused = await request.post(api('/api/run/continue'), { data: { project_id: PID, simulation_id: ht, run_id: rid, extra_iterations: 10 } });
    expect(refused.status()).toBe(409);
    const j = await refused.json();
    expect([j.code, j.error, j.differences.map((d) => d.key)]).toEqual(['choose_numerics', said, ['relax_h']]);
    expect((await getJson(request, `/api/compute-queue?project_id=${PID}`)).items || []).toEqual([]);
  });

  test('a study whose numerics were never set: one change in the Study panel is the one difference Continue names, and setting it back asks nothing', async ({ page, request }) => {
    test.setTimeout(240_000);
    // The study as a new one holds it: no numerics saved (blank: their defaults and the preset).
    const keys = numericsKeys('incompressible_steady');
    const setKeys = (rec) => keys.filter((k) => rec[k] !== undefined && rec[k] !== null);
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, ...Object.fromEntries(keys.map((k) => [k, null])) });
    expect(setKeys(await studyRec(request))).toEqual([]);
    const { rid } = await stoppedRun(request, 'Run_fresh');
    expect(setKeys((await runRow(request, rid)).numerics_used.values)).toEqual([]);
    // The person lowers Relaxation p in the Study panel, where it shows its default, 0.3.
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    let numerics = await openStudyPanel(page);
    await expect(numerics.getByLabel('Relaxation p', { exact: true })).toHaveValue('0.3', STEP);
    await typeNumber(numerics, 'Relaxation p', 0.2);
    await expect.poll(async () => (await studyRec(request)).relax_p, STEP).toBe(0.2);
    // Only what the person changed is saved: the defaults the form shows stay blank.
    await page.waitForTimeout(800);
    expect(setKeys(await studyRec(request))).toEqual(['relax_p']);
    // The Continue box, the question and the route name that one change, from its default.
    const said = changedLine('Run_fresh', 'Relaxation p 0.3 → 0.2');
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const go = panel.locator('[data-run-continue="1"] [data-run-continue-go="1"]');
    await expect(panel.locator('[data-run-continue-numerics]')).toHaveText(said, STEP);
    const posted = postsOf(page);
    await go.click();
    await expect(page.locator('#modal-run-continue')).toBeVisible(STEP);
    await expect(page.locator('#rcn-copy')).toHaveText(said);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-run-continue')).toBeHidden();
    const refused = await request.post(api('/api/run/continue'), { data: { project_id: PID, simulation_id: sim, run_id: rid, extra_iterations: 10 } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).differences.map((d) => d.text)).toEqual(['Relaxation p 0.3 → 0.2']);
    // Set back to 0.3, what the run started with (its default): nothing differs and nothing is asked.
    numerics = await openStudyPanel(page);
    await typeNumber(numerics, 'Relaxation p', 0.3);
    await expect.poll(async () => (await studyRec(request)).relax_p, STEP).toBe(0.3);
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(panel.locator('[data-run-continue="1"] [data-run-continue-go="1"]')).toBeEnabled(STEP);
    await expect(panel.locator('[data-run-continue-numerics]')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
  });

  test("an unhealthy run after a study numerics change: the Continue box and the Assistant's card say only Health on the continued part can tell, never that nothing changed", async ({ page, request }) => {
    test.setTimeout(240_000);
    const { rid, runJson } = await stoppedRun(request, 'Run_uh');
    const was = (await runRow(request, rid)).numerics_used.values.relax_p;
    patchRun(runJson, {
      health_checked: true,
      health: {
        v: 1,
        verdict: 'unhealthy',
        at: new Date().toISOString(),
        step: 40,
        t: 40,
        unit: 'iteration',
        window: 25,
        live: false,
        checked: ['residuals_stalled'],
        skipped: [],
        findings: [{ code: 'residuals_stalled', level: 'error', text: 'The residuals stopped falling.', evidence: null, since_t: 10, fix: [] }],
        timeline: [{ t: 10, verdict: 'unhealthy' }],
        first_unhealthy: { t: 10, step: 10, wall_s: 5 },
        // The start of its log is gone: where Continue goes on from against the onset is unknown.
        head_missing: true,
        restart: null,
      },
    });
    // Nothing changed yet: Continue will likely repeat it.
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const health = panel.locator('[data-run-continue="1"] [data-run-continue-health="1"]');
    await expect(health).toHaveText(/its settings have not changed since, so Continue will likely repeat the problem\.$/, STEP);
    // The study's relaxation of p is lowered: the box no longer says nothing changed.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, relax_p: 0.22 });
    const list = `Relaxation p ${was} → 0.22`;
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    await expect(panel.locator('[data-run-continue-numerics]')).toHaveText(changedLine('Run_uh', list), STEP);
    await expect(health).toHaveText('Health checks the continued part from iteration 50; whether the change is enough shows only there.', STEP);
    // The Assistant's run_continue with the new numerics says the same; as it was, it will likely repeat.
    fake.reply(
      { tools: [{ name: 'compute', input: compute({ action: 'run_continue', run_id: rid, extra_iterations: 20, numerics: 'new' }) }] },
      () => ({ text: 'Not continued.' }),
    );
    await openDock(page);
    await dockSend(page, 'Continue Run_uh with the new numerics.');
    const card = dockGate(page);
    await expect(card.locator('.dock-gate-copy')).toHaveText(
      `Runs "Run_uh" for 20 more iterations. Continues "Run_uh" with the study's new numerics (${list}). Health checks the continued part from iteration 50; whether the change is enough shows only there.`,
      { timeout: 60_000 },
    );
    await card.locator('[data-gate-answer="no"]').click(STEP);
    await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 60_000 });
    expect((await runRow(request, rid)).status).toBe('stopped');
  });

  test('"Numerics as written" of a started run names the preset it started with, not the study\'s now, as the Assistant reads it', async ({ page, request }) => {
    test.setTimeout(240_000);
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, numerics_preset: null, grad_limiter: null });
    const { rid } = await stoppedRun(request, 'Run_preset');
    try {
      // Started on Robust (blank); the study then switched to Accurate.
      await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, numerics_preset: 'accurate' });
      const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
      await numericsOf(panel);
      const grad = panel.locator('[data-run-numerics="1"] [data-run-numerics-row="Gradient limiter"]');
      await expect(grad.locator('.run-numerics-source')).toHaveText(' (Robust preset)', STEP);
      const read = await postOk(request, '/api/run/precheck', { project_id: PID, simulation_id: sim, run_id: rid });
      expect(read.numerics.find((n) => n.label === 'Gradient limiter')).toMatchObject({ source: 'preset', preset: 'Robust' });
    } finally {
      await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, numerics_preset: null });
    }
  });
});

// What a run was written with (the validation set's pipes, 2026-11-06, changed the writer): a draft's
// "Numerics as written" is its study's; a started run's is what its case was written with, recorded
// then (numerics_used.written), so its rows (its wall treatment too) follow the run, not the study's
// model now or today's writer; a run started before they were recorded says so. Cleanup in afterEach,
// with the page closed first (a test's finally is skipped on a timeout).
test.describe('what a run was written with', () => {
  const IF_SST = {
    'Gradient limiter': 'grad(U) cellLimited Gauss skewCorrected linear 1; grad(k), grad(omega) cellLimited Gauss linear 1',
    'Momentum convection': 'bounded Gauss linearUpwind grad(U)',
    'Velocity gradient': 'grad(U) skew-corrected (Gauss skewCorrected linear) inside the gradient limiter; linearUpwind, the viscous terms and turbulence production read it',
    'Flux interpolation': 'flux(HbyA) skewCorrected linear; the rest linear',
    'Wall treatment': 'nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise)',
  };
  const IF_KE_WALLS = 'nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction';
  const HT_SST_WALLS = `${IF_SST['Wall treatment']}, alphat compressible::alphatJayatillekeWallFunction (Prt 0.85)`;
  const NOT_RECORDED =
    'This run started before the app recorded what its case was written with, so it is not shown here: its case folder (system/fvSchemes and the fields it saved) holds what it solved with.';
  const NOT_REPORTED =
    "This run's analysis did not report what its case was written with, so it is not shown here: its case folder (system/fvSchemes and the fields it saved) holds what it solved with.";
  /** Runs a test made ({study, rid}) and study fields to put back ({study, values}), undone in afterEach. */
  let made = [];
  let restore = [];

  test.beforeAll(async ({ request }) => {
    // A steady study (as numerics at Continue leaves it; this describe may run alone).
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, time_dependency: 'Steady-state' });
  });

  test.beforeEach(async ({ request }) => {
    made = [];
    restore = [];
    await postOk(request, '/api/test/assistant/reset', {});
    await useScriptedModel(request, host.base, fake, 'cloud');
  });

  test.afterEach(async ({ page, request }) => {
    await page.close();
    for (const { study: s, rid } of made) {
      await request.post(api('/api/run/stop'), { data: { project_id: PID, simulation_id: s, run_id: rid } }).catch(() => {});
      await expect
        .poll(async () => ((await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${s}`)).runs || []).find((r) => String(r.id) === rid)?.status ?? 'gone', STEP)
        .not.toBe('running');
      await postOk(request, '/api/run/delete', { project_id: PID, simulation_id: s, run_id: rid });
    }
    for (const { study: s, values } of restore.reverse()) await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: s, ...values });
    expect(fake.pending(), 'scripted answers left unused').toBe(0);
  });

  /** Sets study fields for this test, keeping what they were for afterEach. */
  async function studyFields(request, s, values) {
    const was = (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${s}`)).simulation;
    restore.push({ study: s, values: Object.fromEntries(Object.keys(values).map((k) => [k, was[k] ?? null])) });
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: s, ...values });
  }

  async function newRun(request, name, s = sim) {
    const out = await postOk(request, '/api/run/create', { project_id: PID, simulation_id: s, name, ...(s === sim ? { mesh_id: meshId } : {}) });
    const rid = String(out.run_id || out.run?.id || out.run?.run_id);
    made.push({ study: s, rid });
    return rid;
  }

  /** A run started (the fake compute) once its Start recorded the rows its case is written with, then stopped. */
  async function startedRun(request, name) {
    const rid = await newRun(request, name);
    await postOk(request, '/api/run/start', { project_id: PID, simulation_id: sim, run_id: rid });
    await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('running');
    await expect.poll(async () => ((await runRow(request, rid)).numerics_used?.written || []).length, STEP).toBeGreaterThan(5);
    await postOk(request, '/api/run/stop', { project_id: PID, run_id: rid });
    await expect.poll(async () => (await runRow(request, rid)).status, STEP).toBe('stopped');
    return { rid, runJson: join(dirname((await runRow(request, rid)).case_dir), 'run.json') };
  }

  /** The Assistant's read_setup numerics of `rid`, from a dock turn in `page`. */
  async function assistantReads(page, rid, name) {
    const seen = {};
    fake.reply(
      { tools: [{ name: 'read_setup', input: readSetup({ what: 'numerics', id: rid }) }] },
      () => {
        seen.read = lastResults()[0];
        return { text: 'Read.' };
      },
    );
    await openDock(page);
    await dockSend(page, `Read the numerics of ${name}.`);
    await expect(dockTurn(page).locator('[data-turn-end="done"]').last()).toBeVisible({ timeout: 60_000 });
    expect(seen.read.ok, JSON.stringify(seen.read)).toBe(true);
    return seen.read.data;
  }

  test('"Numerics as written" says the velocity gradient and the flux are skew-corrected, the limiter is on the velocity gradient, and what each model\'s walls are written with, as the Assistant reads it', async ({ page, request }) => {
    test.setTimeout(240_000);
    await studyFields(request, sim, { numerics_preset: null, grad_limiter: null, turbulence_model: 'kOmegaSST' });
    const rid = await newRun(request, 'Run_fixed');
    // The person: a steady k-omega SST draft on the Robust preset.
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    let row = await numericsOf(panel);
    for (const [label, value] of Object.entries(IF_SST)) await expect(row(label), label).toHaveText(value, STEP);
    // The Assistant reads the same rows (read_setup numerics, R35).
    const read = Object.fromEntries((await assistantReads(page, rid, 'Run_fixed')).rows.map((x) => [x.label, x.value]));
    for (const [label, value] of Object.entries(IF_SST)) expect(read[label], label).toBe(value);
    // A draft follows its study: k-epsilon keeps the k-based log law at the wall; after a reload the panel shows it.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, turbulence_model: 'kEpsilon' });
    await page.reload();
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(IF_KE_WALLS, STEP);
    await expect(row('Velocity gradient')).toHaveText(IF_SST['Velocity gradient'], STEP);
    // The Study panel's model help gives only the y+ that were tested.
    await page.goto(`${host.base}/#/p/${PID}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] > .tree-row`).first().click();
    const help = page.locator('#panel-study-settings [data-schema-key="turbulence_model"] [role="tooltip"]');
    await expect(help).toContainText("within about 2 % with the first cell's centre at y+ 5 to 15 and within 4.5 % up to y+ 100, but 6 to 9 % low at y+ 1 to 3; below y+ 1 only y+ 0.3 was tested (1.5 % low)", STEP);
    await expect(help).toContainText('Spalart-Allmaras solves one equation and suits flow around wings and bodies in a freestream; how its walls read was not tested.');
    await expect(help).not.toContainText('below about 0.5');
    await expect(help).not.toContainText('any y+');
    await expect(help).toContainText("A pipe from a uniform inlet read its friction within about 4 % on Hex-dominant, but on Standard's tetrahedra 11 to 18 % low with wall layers and up to about 31 % low with none (0 to 10 % with the Robust preset)", STEP);
    await expect(help).toContainText('developed on Standard it read about 14 % low');
    await expect(help).not.toContainText('about 9 % low');
    await expect(help).not.toContainText('uneven strain rate');
    await expect(help).not.toContainText('SST is the general-purpose default and handles walls at any y+');
    // The Assistant reads the same whole help (catalog analyses), word for word, not its first 160
    // characters: what the person is told of where k-omega SST reads off, it is told too.
    const shown = String(await help.textContent()).replace(/\s+/g, ' ').trim();
    expect(shown.length).toBeGreaterThan(160);
    const seen = {};
    fake.reply({ tools: [{ name: 'catalog', input: { kind: 'analyses', key: 'incompressible_steady' } }] }, () => {
      seen.cat = lastResults()[0];
      return { text: 'Read.' };
    });
    await openDock(page);
    await dockSend(page, 'What does the turbulence model help say?');
    await expect(dockTurn(page).locator('[data-turn-end="done"]').last()).toBeVisible({ timeout: 60_000 });
    expect(seen.cat.ok, JSON.stringify(seen.cat)).toBe(true);
    expect(seen.cat.data.settings.find((f) => f.key === 'turbulence_model').description).toBe(shown);
  });

  test("a started run shows what its case was written with: its walls stay its model's after the study's changes, and an earlier writer's rows stay as they were written, as the Assistant reads them", async ({ page, request }) => {
    test.setTimeout(240_000);
    await studyFields(request, sim, { numerics_preset: null, grad_limiter: null, turbulence_model: 'kOmegaSST' });
    // A k-omega SST run is started (and stopped): its Start records the rows its case is written with.
    const { rid, runJson } = await startedRun(request, 'Run_written');
    const written = (await runRow(request, rid)).numerics_used.written;
    expect(Object.fromEntries(written.map((x) => [x.label, x.value]))).toMatchObject(IF_SST);
    // The study turns to k-epsilon: a new draft follows it, the started run keeps its own walls.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: sim, turbulence_model: 'kEpsilon' });
    const draft = await newRun(request, 'Run_draft_ke');
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: draft });
    let row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(IF_KE_WALLS, STEP);
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(IF_SST['Wall treatment'], STEP);
    for (const [label, value] of Object.entries(IF_SST)) await expect(row(label), label).toHaveText(value, STEP);
    let read = await assistantReads(page, rid, 'Run_written');
    expect([read.from, 'recorded' in read]).toEqual(['numerics_used', false]);
    expect(Object.fromEntries(read.rows.map((x) => [x.label, x.value]))['Wall treatment']).toBe(IF_SST['Wall treatment']);
    // A run whose case an earlier writer wrote: its record holds that writer's rows, which it shows as
    // they were written (not what today's writer would write from its numerics), after a reload too.
    const earlier = written.map((x) =>
      x.label === 'Velocity gradient' ? { ...x, value: 'grad(U) cellLimited Gauss linear 1 (as an earlier writer wrote it)' } : x.label === 'Flux interpolation' ? null : x,
    ).filter(Boolean);
    const doc = JSON.parse(readFileSync(runJson, 'utf8'));
    patchRun(runJson, { numerics_used: { ...doc.numerics_used, at: new Date().toISOString(), written: earlier } });
    await page.reload();
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    row = await numericsOf(panel);
    await expect(row('Velocity gradient')).toHaveText('grad(U) cellLimited Gauss linear 1 (as an earlier writer wrote it)', STEP);
    await expect(row('Flux interpolation')).toHaveCount(0);
    read = await assistantReads(page, rid, 'Run_written');
    expect(read.rows.map((x) => [x.label, x.value])).toEqual(earlier.map((x) => [x.label, x.value]));
  });

  test('a run started before its rows were recorded says so, in the Run panel and to the Assistant, never with what today\'s writer would write', async ({ page, request }) => {
    test.setTimeout(240_000);
    await studyFields(request, sim, { numerics_preset: null, grad_limiter: null, turbulence_model: 'kOmegaSST' });
    const { rid, runJson } = await startedRun(request, 'Run_older');
    // As a run started before the rows were recorded holds it: what it started with, no rows.
    const doc = JSON.parse(readFileSync(runJson, 'utf8'));
    const { written: _w, ...older } = doc.numerics_used;
    patchRun(runJson, { numerics_used: { ...older, at: new Date().toISOString() } });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = panel.locator('[data-run-numerics="1"]');
    await expect(box).toBeVisible(STEP);
    if (!(await box.evaluate((el) => el.open))) await box.locator('summary').click();
    await expect(box.locator('[data-run-numerics-group="Not recorded"] [data-run-numerics-row="Numerics as written"] .run-numerics-value')).toHaveText(NOT_RECORDED, STEP);
    await expect(box.locator('[data-run-numerics-row]')).toHaveCount(1);
    await expect(box.locator('[data-run-numerics-row="Velocity gradient"]')).toHaveCount(0);
    const read = await assistantReads(page, rid, 'Run_older');
    expect([read.recorded, read.rows]).toEqual([false, [{ group: 'Not recorded', label: 'Numerics as written', value: NOT_RECORDED }]]);
    expect(read.note).toBe(`"Run_older" started before what its case was written with was recorded: its case folder holds it; read_setup {what:'study'} has the study's numerics now.`);
  });

  test("a run whose analysis reported no rows says so, in the Run panel and to the Assistant, never with what today's writer would write", async ({ page, request }) => {
    test.setTimeout(240_000);
    await studyFields(request, sim, { numerics_preset: null, grad_limiter: null, turbulence_model: 'kOmegaSST' });
    const { rid, runJson } = await startedRun(request, 'Run_unreported');
    // As the core records a Start whose plan reported none (an analysis without them, or one whose rows failed).
    const doc = JSON.parse(readFileSync(runJson, 'utf8'));
    patchRun(runJson, { numerics_used: { ...doc.numerics_used, at: new Date().toISOString(), written: false } });
    const panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: sim, runId: rid });
    const box = panel.locator('[data-run-numerics="1"]');
    await expect(box).toBeVisible(STEP);
    if (!(await box.evaluate((el) => el.open))) await box.locator('summary').click();
    await expect(box.locator('[data-run-numerics-group="Not recorded"] [data-run-numerics-row="Numerics as written"] .run-numerics-value')).toHaveText(NOT_REPORTED, STEP);
    await expect(box.locator('[data-run-numerics-row]')).toHaveCount(1);
    await expect(box.locator('[data-run-numerics-row="Velocity gradient"]')).toHaveCount(0);
    const read = await assistantReads(page, rid, 'Run_unreported');
    expect([read.recorded, read.rows]).toEqual([false, [{ group: 'Not recorded', label: 'Numerics as written', value: NOT_REPORTED }]]);
    expect(read.note).toBe(`"Run_unreported"'s analysis did not report what its case was written with: its case folder holds it; read_setup {what:'study'} has the study's numerics now.`);
  });

  test("Heat Transfer's Wall treatment row: a draft's follows its study, a started run's stays what its case was written with, as the Assistant reads it", async ({ page, request }) => {
    test.setTimeout(240_000);
    const ht = (await postOk(request, '/api/simulation', { project_id: PID, analysis_type: 'heat_transfer_steady', activate: true })).simulation.id;
    await studyFields(request, ht, { turbulence_model: 'kOmegaSST' });
    const draft = await newRun(request, 'Run_ht_walls', ht);
    let panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: ht, runId: draft });
    let row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(HT_SST_WALLS, STEP);
    let read = await assistantReads(page, draft, 'Run_ht_walls');
    expect(Object.fromEntries(read.rows.map((x) => [x.label, x.value]))['Wall treatment']).toBe(HT_SST_WALLS);
    // A started Heat Transfer run, with the rows its Start recorded (the draft's, as written then).
    const check = await postOk(request, '/api/run/precheck', { project_id: PID, simulation_id: ht, run_id: draft });
    const started = await newRun(request, 'Run_ht_started', ht);
    const caseDir = (await getJson(request, `/api/run/status?project_id=${PID}&simulation_id=${ht}`)).runs.find((r) => String(r.id) === started).case_dir;
    const study = (await getJson(request, `/api/simulation?project_id=${PID}&simulation_id=${ht}`)).simulation;
    const values = Object.fromEntries(numericsKeys('heat_transfer_steady').map((k) => [k, study[k] ?? null]));
    patchRun(join(dirname(caseDir), 'run.json'), {
      status: 'stopped',
      stage: 'stopped',
      time_dependency: 'Steady-state',
      analysis_key: 'heat_transfer_steady',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: new Date().toISOString(),
      numerics_used: { analysis: 'heat_transfer_steady', mode: 'steady', at: new Date().toISOString(), values, written: check.numerics },
    });
    // The study turns to k-epsilon: the draft follows it, the started run keeps k-omega SST's walls.
    await postOk(request, '/api/simulation/update', { project_id: PID, simulation_id: ht, turbulence_model: 'kEpsilon' });
    await page.reload();
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: ht, runId: draft });
    row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(/^nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction, alphat compressible::alphatJayatillekeWallFunction/, STEP);
    panel = await openRunPanel(page, { base: host.base, projectId: PID, simulationId: ht, runId: started });
    row = await numericsOf(panel);
    await expect(row('Wall treatment')).toHaveText(HT_SST_WALLS, STEP);
    read = await assistantReads(page, started, 'Run_ht_started');
    expect(Object.fromEntries(read.rows.map((x) => [x.label, x.value]))['Wall treatment']).toBe(HT_SST_WALLS);
  });
});
