// RH3, numerics as settings (spec 5.1-5.9, part 1: the settings). What the person sees and what
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
// Its own server with the fake compute (MAGNUSIM_TEST_COMPUTE=fake): no WSL.
// Fails on the code before RH3: there were no such settings, no "Numerics as written" and no
// read_setup numerics.
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
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
const PID = 'run-numerics-e2e';
const STEP = { timeout: 30_000 };
const FIRST_ORDER =
  'First-order schemes are more stable but less accurate. Fix the time step or the mesh first; use first order only to get a run started.';
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
