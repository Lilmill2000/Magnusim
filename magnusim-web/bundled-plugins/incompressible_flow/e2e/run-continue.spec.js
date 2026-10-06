import { expect, test } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_WSL, waitSlotFree, wslPathExists } from '../../../e2e/support/plugin-suite.js';

// F6, solved for real (WSL): a steady run solves 20 iterations, then Continue in its Run
// panel runs 10 more from its last saved result. The run keeps its frames and gains new
// ones, its residual plot runs on from where it was (one series over both parts, the
// panel's plot drawing all of it), its steps count on from the first part's total, and
// its case keeps the first part's solver log as log.simpleFoam.1. Its WSL copy goes once
// the results are back, as for any solve.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const ID = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';

/** GET json; a poll can reuse a keep-alive socket just as the server closes it, so retry that. */
const getJson = async (request, url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};
const postJson = (request, url, data) => request.post(url, { data, timeout: 120_000 });

/** Open a run's panel from the tree (after a fresh load); returns the panel. */
async function openRunPanel(page, runId) {
  await page.goto(`/#/p/${encodeURIComponent(ID)}`);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, ID, { timeout: 90_000 });
  const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run="${runId}"] > .tree-row .tl`).first().click();
  await expect(panel).toHaveAttribute('data-run-id', runId, { timeout: 30_000 });
  return panel;
}

test('Continue +10 on a finished steady run: the residual plot is continuous and the frame count grows', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(2_400_000);
  page.setDefaultTimeout(30_000);
  const status = (rid) => getJson(request, `/api/run/status?project_id=${ID}&simulation_id=${SIM}&run_id=${encodeURIComponent(rid)}`);
  const run = async (rid) => (await status(rid)).run || {};
  const ended = async (rid) => {
    await expect
      .poll(async () => {
        const r = await run(rid);
        return String(r.run_id || r.id) === rid ? r.status : 'wait';
      }, { timeout: 900_000, intervals: [3_000] })
      .toMatch(/done|failed|stopped/);
    return run(rid);
  };

  // A steady study with a mesh (the smoke's mesh when it is there, else a quick one).
  const steady = await postJson(request, '/api/simulation/update', { project_id: ID, simulation_id: SIM, time_dependency: 'Steady-state' });
  expect(steady.ok(), await steady.text()).toBe(true);
  const meshes = async () => (await getJson(request, `/api/run/status?project_id=${ID}&simulation_id=${SIM}`)).meshes || [];
  if (!(await meshes()).some((m) => m.ready && m.n_cells > 0)) {
    await waitSlotFree(request, { timeoutMs: 900_000 });
    const made = await postJson(request, '/api/mesh/generate', {
      project_id: ID,
      simulation_id: SIM,
      mesh_id: 'mesh_1',
      name: 'Mesh 1',
      settings: { fineness: 1, hex_element_core: false, automatic_boundary_layers: false },
    });
    expect(made.status(), await made.text()).toBeLessThan(300);
    await expect.poll(async () => (await meshes()).some((m) => m.ready && m.n_cells > 0), { timeout: 900_000, intervals: [3_000] }).toBe(true);
  }
  await waitSlotFree(request, { timeoutMs: 900_000 });

  // 20 iterations, saving every 10.
  const created = await (await postJson(request, '/api/run/create', { project_id: ID, simulation_id: SIM, name: 'Continue me' })).json();
  const rid = String(created.run_id || (created.run && (created.run.id || created.run.run_id)) || created.id);
  expect(rid, JSON.stringify(created)).toBeTruthy();
  const set = await postJson(request, '/api/run/update', { project_id: ID, simulation_id: SIM, run_id: rid, endTime: 20, writeInterval: 10 });
  expect(set.ok(), await set.text()).toBe(true);
  let panel = await openRunPanel(page, rid);
  await expect(panel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await panel.locator('[data-run-start]').click();
  const first = await ended(rid);
  expect(first.status, first.error || first.note).toBe('done');
  const from = Number(first.last_saved_iteration);
  expect(from).toBeGreaterThan(0);
  expect(first.residuals.length).toBeGreaterThan(1);
  const framesBefore = Number(first.n_saved_times);

  // Continue: 10 more iterations from the last saved result.
  panel = await openRunPanel(page, rid);
  const box = panel.locator('[data-run-continue="1"]');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-run-continue-hint="1"]')).toHaveText(`Continues from the last saved result, iteration ${from}, to iteration ${from + 20}.`);
  await box.locator('#run-continue-amount').fill('10');
  await box.locator('[data-run-continue-go="1"]').click();
  await expect(panel.locator('[data-run-status]')).toHaveAttribute('data-run-status', /running|done/, { timeout: 120_000 });
  const second = await ended(rid);
  expect(second.status, second.error || second.note).toBe('done');

  // The frames: the first part's are kept, the new ones added.
  expect(Number(second.last_saved_iteration)).toBeGreaterThan(from);
  expect(Number(second.n_saved_times)).toBeGreaterThan(framesBefore);
  const caseTimes = readdirSync(second.case_dir).filter((n) => /^\d+$/.test(n) && n !== '0').map(Number).sort((a, b) => a - b);
  expect(caseTimes).toContain(from);
  expect(caseTimes[caseTimes.length - 1]).toBe(Number(second.last_saved_iteration));
  // The residuals: one series over both parts, iteration after iteration, no gap at the restart.
  const ts = second.residuals.map((r) => Number(r.t));
  for (let i = 1; i < ts.length; i++) expect(ts[i], `residual ${i} after ${ts[i - 1]}`).toBeGreaterThan(ts[i - 1]);
  expect(ts.filter((t) => t <= from).length, 'the first part stays').toBeGreaterThanOrEqual(first.residuals.filter((r) => r.t <= from).length);
  expect(ts).toContain(from + 1);
  expect(ts[ts.length - 1]).toBe(Number(second.iteration));
  // Its steps count on from the first part's total.
  expect(Number(second.n_steps)).toBe(Number(first.n_steps) + (Number(second.iteration) - from));
  expect(second.continued).toMatchObject({ from_time: from, steps_before: Number(first.n_steps) });
  expect(second.attempts.map((a) => a.status)).toEqual(['done']);
  // The case keeps the first part's solver log, and the WSL copy went.
  expect(existsSync(join(second.case_dir, 'log.simpleFoam.1'))).toBe(true);
  expect(existsSync(join(second.case_dir, 'log.simpleFoam'))).toBe(true);
  expect(wslPathExists(second.wsl_case_path), `${second.wsl_case_path} removed after the solve`).toBe(false);

  // The panel's plot draws both parts as one line per series, to the new end.
  panel = await openRunPanel(page, rid);
  const plot = panel.locator('[data-residual-plot="1"]');
  await expect(plot).toBeVisible();
  const counts = await plot.locator('polyline').evaluateAll((els) => els.map((el) => (el.getAttribute('points') || '').trim().split(/\s+/).length));
  expect(Math.max(...counts)).toBe(second.residuals.length);
  await expect(plot.locator('text').last()).toHaveText(String(second.endTime));
  await expect(panel.locator('[data-run-line="1"]')).toHaveText(`${second.iteration} iterations`);
});
