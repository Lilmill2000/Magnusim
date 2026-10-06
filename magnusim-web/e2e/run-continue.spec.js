import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRunPanel } from './support/compute-slot.js';

// F6: Continue a finished run. The Run panel of a finished run offers Continue with its
// input: a steady run "Run N more iterations" (its last iteration count by default) and a
// transient run "Run on to t = ..." (its end plus the span it ran), each saying where it
// continues from; a bad amount turns Continue off and says why. A run whose case folder
// lost its saved results cannot continue: the panel says so and the server refuses it,
// leaving the run as it ended. No WSL: a finished run whose case is a copy of the cavity.
// Fails on the code before F6: a finished run had no Continue.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const stamp = () => Date.now().toString(36);

const json = async (request, url) => {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
};

test('Continue on a finished run: offered with its input, and refused when its case has no saved result', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e run continue ${stamp()}`,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect
    .poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 })
    .toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();

  // A finished steady run, solved to iteration 100, saving every 50 (frames 50 and 100).
  const runRows = async () => (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run 1' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const side = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete side.plugin;
  delete side.study_id;
  writeFileSync(sidecar, JSON.stringify(side, null, 2));
  /** The case's saved times become `names` (the cavity's last frames, renamed). */
  const savedTimes = (names) => {
    const from = ['0.4', '0.5'];
    names.forEach((name, i) => renameSync(join(caseDir, from[i]), join(caseDir, name)));
    for (const t of ['0.1', '0.2', '0.3']) rmSync(join(caseDir, t), { recursive: true, force: true });
  };
  savedTimes(['50', '100']);
  const runJson = join(runDir, 'run.json');
  const original = JSON.parse(readFileSync(runJson, 'utf8'));
  const finished = {
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
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    case_dir: caseDir,
  };
  writeFileSync(runJson, JSON.stringify(finished, null, 2));
  await page.reload();
  await ready();

  // Steady: "Run [100] more iterations", from the last saved result.
  let panel = await openRunPanel(page, { projectId: pid, simulationId: sid, runId: rid, reload: false });
  await expect(panel.locator('[data-run-status]')).toHaveAttribute('data-run-status', 'done');
  await expect(panel.locator('[data-run-start]')).toHaveCount(0);
  const box = panel.locator('[data-run-continue="1"]');
  const amount = box.locator('#run-continue-amount');
  const go = box.locator('[data-run-continue-go="1"]');
  const hint = box.locator('[data-run-continue-hint="1"]');
  await expect(box).toBeVisible();
  await expect(box.locator('label[for="run-continue-amount"]')).toHaveText('Run');
  await expect(box.locator('.bc-unit-label')).toHaveText('more iterations');
  await expect(amount).toHaveValue('100');
  await expect(hint).toHaveText('Continues from the last saved result, iteration 100, to iteration 200.');
  await expect(go).toHaveText('Continue');
  await expect(go).toBeEnabled();
  await amount.fill('30');
  await expect(hint).toHaveText('Continues from the last saved result, iteration 100, to iteration 130.');
  await amount.fill('120');
  await expect(hint).toHaveText(
    'Continues from the last saved result, iteration 100, to iteration 220. Results are saved every 50 iterations, so the last one saved is iteration 200.',
  );
  await amount.fill('0');
  await expect(box.locator('[data-run-continue-invalid="1"]')).toHaveText('Enter a whole number of iterations, 1 or more.');
  await expect(go).toBeDisabled();

  // Transient: "Run on to t = [2] s" (its end, 1 s, plus the span it ran).
  rmSync(join(caseDir, '50'), { recursive: true, force: true });
  rmSync(join(caseDir, '100'), { recursive: true, force: true });
  cpSync(join(CAVITY, '0.5'), join(caseDir, '0.5'), { recursive: true });
  cpSync(join(CAVITY, '0.5'), join(caseDir, '1'), { recursive: true });
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...finished,
        time_dependency: 'Transient',
        analysis_key: 'incompressible_transient',
        path_kind: 'pimpleFoam',
        last_saved_iteration: 1,
        iteration: 1,
        sim_time: 1,
        transient: { end_time: 1, write_count: 2, write_interval: 0.5 },
        residuals: [
          { t: 0.5, U: 0.01, p: 0.02 },
          { t: 1, U: 0.001, p: 0.002 },
        ],
      },
      null,
      2,
    ),
  );
  panel = await openRunPanel(page, { projectId: pid, simulationId: sid, runId: rid });
  await expect(box.locator('label[for="run-continue-amount"]')).toHaveText('Run on to t =');
  await expect(box.locator('.bc-unit-label')).toHaveText('s');
  await expect(amount).toHaveValue('2');
  await expect(hint).toHaveText('Continues from the last saved result, t = 1 s.');
  await expect(go).toBeEnabled();
  await amount.fill('0.75');
  await expect(box.locator('[data-run-continue-invalid="1"]')).toHaveText('Enter an end time after t = 1 s.');
  await expect(go).toBeDisabled();

  // Its saved results deleted: it cannot continue; the panel and the server say why.
  for (const t of ['0.5', '1']) rmSync(join(caseDir, t), { recursive: true, force: true });
  const why = "This run can't continue: its case folder has no saved result. Add a run to solve again.";
  panel = await openRunPanel(page, { projectId: pid, simulationId: sid, runId: rid });
  await expect(box.locator('[data-run-continue-reason="1"]')).toHaveText(why);
  await expect(go).toBeDisabled();
  const refused = await request.post('/api/run/continue', { data: { project_id: pid, simulation_id: sid, run_id: rid, end_time: 2 } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ ok: false, code: 'no_saved_time', error: why });
  const after = (await runRows()).find((r) => String(r.id) === rid);
  expect(after.status, 'the run is as it ended').toBe('done');
});
