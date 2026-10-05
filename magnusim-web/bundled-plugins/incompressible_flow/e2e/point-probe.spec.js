import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Point probe (F4) is placed on points in the fluid: "Add probe here" on an Inspect
// point pin (in a finished run's results) adds a new Point probe at that point to the
// study's run that has not started, and the probe's panel takes typed points in the
// project's length unit (mm), saved in metres. No WSL: the finished run's case is the
// committed cavity. Fails on the code before F4: there was no Point probe type, no
// "Add probe here" on the pin and no points editor.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

test('a Point probe takes typed points and Add probe here from an Inspect pin', async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e point probe ${stamp()}`,
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

  const runRows = async () => (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const createRun = async (name) => {
    const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name } })).json();
    const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
    expect(rid, JSON.stringify(made)).toBeTruthy();
    return rid;
  };
  // Run A: finished, its case the cavity. Run B: a draft the probe goes to.
  const runA = await createRun('Run A');
  const runDir = dirname((await runRows()).find((r) => String(r.id) === runA).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecarPath = join(caseDir, 'w27-case.json');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  delete sidecar.plugin;
  delete sidecar.study_id;
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status: 'done',
        stage: 'done',
        has_results: true,
        n_saved_times: 5,
        last_saved_iteration: 0.5,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
      },
      null,
      2,
    ),
  );
  const runB = await createRun('Run B');
  const rcsOf = async (rid) => (await runRows()).find((r) => String(r.id) === rid)?.result_controls || [];
  await page.reload();
  await ready();

  const openRun = async (rid) => {
    const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
    if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) await studyRow.click();
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
    if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
      await runsFolder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    const li = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
    if (!(await li.evaluate((el) => el.classList.contains('expanded')))) await li.locator(':scope > .tree-row .tw').click();
  };

  // ---- Add probe here: Run A's results, an Inspect pin, its button ----
  await openRun(runA);
  const results = page.locator(`#left-tree [data-w27-run-results="${runA}"] > .tree-row .tl`).first();
  await expect(results).toBeVisible();
  await results.click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
  await page.locator('#btn-inspect-point').click();
  const box = await page.locator('#viewer').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pin = page.locator('#inspect-pins .inspect-pin[data-hit="1"]');
  await expect(pin).toHaveCount(1, { timeout: 60_000 });
  const at = await page.evaluate(() => (window.__CFD_W13__.points || []).filter((p) => p.hit).pop().casePos);
  const add = pin.locator('[data-inspect-probe]');
  await expect(add).toHaveText('Add probe here');
  await add.click();
  // A new Point probe on the run that has not started, at the pin's point (metres).
  await expect
    .poll(async () => (await rcsOf(runB)).map((rc) => [rc.name, rc.monitor_type, (rc.points || []).length]), { timeout: 30_000 })
    .toEqual([['Point probe 1', 'probe', 1]]);
  const probe = (await rcsOf(runB))[0];
  probe.points[0].forEach((v, i) => expect(v).toBeCloseTo(at[i], 9));
  // The finished run got nothing.
  expect(await rcsOf(runA)).toEqual([]);
  await page.locator('#btn-inspect-point').click();

  // ---- Its panel: the point, and a typed one in mm ----
  await page.reload();
  await ready();
  await openRun(runB);
  // The run's Monitors folder, open.
  const rcFolder = page.locator(`#left-tree li[data-w27-run-rcs="${runB}"]`).first();
  if (!(await rcFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await rcFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-aa="${probe.id}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#panel-area-average')).toBeVisible();
  await expect(page.locator('#aa-type-label')).toHaveText('Point probe');
  await expect(page.locator('#aa-face-block')).toBeHidden();
  await expect(page.locator('#aa-point-block')).toBeVisible();
  await expect(page.locator('#aa-point-count')).toHaveText('1');
  await expect(page.locator('#aa-point-unit')).toHaveText('mm');
  await page.locator('#aa-point-x').fill('10');
  await page.locator('#aa-point-y').fill('20');
  await page.locator('#aa-point-z').fill('-5');
  await page.locator('#aa-point-add').click();
  await expect(page.locator('#aa-point-count')).toHaveText('2');
  await expect(page.locator('#aa-point-list .aa-point-text').nth(1)).toHaveText('10, 20, -5 mm');
  await expect.poll(async () => ((await rcsOf(runB))[0]?.points || [])[1]).toEqual([0.01, 0.02, -0.005]);
  // A point with a blank coordinate is not added.
  await page.locator('#aa-point-x').fill('1');
  await page.locator('#aa-point-add').click();
  await expect(page.locator('#aa-point-x')).toHaveValue('1');
  await expect(page.locator('#aa-point-y')).toHaveClass(/is-invalid/);
  await expect(page.locator('#aa-point-count')).toHaveText('2');
  // Remove the first point.
  await page.locator('#aa-point-list [data-aa-point-remove="0"]').click();
  await expect(page.locator('#aa-point-count')).toHaveText('1');
  await expect.poll(async () => (await rcsOf(runB))[0]?.points).toEqual([[0.01, 0.02, -0.005]]);
  await expect(page.locator('#results-hub-list')).toContainText('Point probe 1 · 1 point');
});
