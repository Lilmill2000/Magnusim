import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The results toolbar's FILTERS group has Plot Over Path, Iso Surface and Iso Volume next to
// Cutting Plane and Particle Trace. Each opens its block with the run's result fields, and
// each draws a real result from the case: a plot along a typed path (with its values and
// unit), an iso surface at the middle of the field's range (and a plain note when the value
// is outside the range), and an iso volume with its range in the field's unit. No WSL: a
// finished run whose case is a copy of the committed cavity case.
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

test('Plot Over Path, Iso Surface and Iso Volume open from the results toolbar and draw the run', async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e results tools ${stamp()}`,
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

  // A finished run whose case is a copy of the cavity (U and p, five saved times).
  const runRows = async () => (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run 1' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(sidecar, 'utf8'));
  // The fixture names the plugin study it came from; this case is a core run's.
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(sidecar, JSON.stringify(doc, null, 2));
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
  await page.reload();
  await ready();

  // Open the run's results from the tree, as a user does.
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) await studyRow.click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await runsFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first();
  await expect(results).toBeVisible();
  await results.click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 60_000 });

  // The FILTERS group shows the three tools beside Cutting Plane and Particle Trace.
  const filters = page.locator('#filters-toolbar-group');
  const popBtn = filters.locator('.tb-btn[data-label="Plot Over Path"]');
  const isoBtn = filters.locator('.tb-btn[data-label="Iso Surface"]');
  const ivBtn = filters.locator('.tb-btn[data-label="Iso Volume"]');
  await expect(filters.locator('.tb-btn[data-label="Particle Trace"]')).toBeVisible();
  for (const [btn, text] of [[popBtn, 'Plot Over Path'], [isoBtn, 'Iso Surface'], [ivBtn, 'Iso Volume']]) {
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn.locator('.tb-txt')).toHaveText(text);
  }
  const fields = ['Velocity Magnitude', 'Pressure'];
  const optionTexts = (sel) => page.locator(`${sel} option:not([hidden])`).allTextContents();

  // ---- Plot Over Path: two typed points and Generate plot draw the field along the path.
  await popBtn.click();
  await expect(popBtn).toHaveClass(/is-active/);
  await expect(page.locator('#pop-block')).toBeVisible();
  await expect(page.locator('#pop-block .fp-block-head')).toContainText('Plot Over Path 1');
  expect(await optionTexts('#pop-field-variable')).toEqual(fields);
  const gen = page.locator('#pop-generate');
  const popStatus = page.locator('#pop-status');
  await expect(popStatus).toHaveText(/Type a point as x, y, z in metres/);
  await expect(gen).toBeDisabled();
  await page.locator('#pop-pick').fill('0.005, 0.05, 0.005');
  await page.locator('#pop-add-point').click();
  await expect(page.locator('#pop-selected-label')).toHaveText('Selected points (1)');
  await expect(popStatus).toHaveText('Add a second point to make a path.');
  await expect(gen).toBeDisabled();
  await page.locator('#pop-pick').fill('0.095, 0.05, 0.005');
  await page.locator('#pop-add-point').click();
  await expect(page.locator('#pop-selected-label')).toHaveText('Selected points (2)');
  await page.locator('#pop-subdivisions').fill('20');
  await page.locator('#pop-subdivisions').press('Tab');
  await expect(gen).toBeEnabled();
  await gen.click();
  await expect(page.locator('#pop-chart-wrap')).toBeVisible({ timeout: 90_000 });
  await expect(popStatus).toBeHidden();
  await expect(page.locator('#pop-chart')).toContainText('Velocity Magnitude (m/s)');
  await expect(page.locator('#pop-chart')).toContainText('Distance along the path (m)');
  await expect(page.locator('#pop-chart-meta')).toHaveText(/^\d+ samples, from \S+ to \S+ m\/s$/);
  const samples = Number((await page.locator('#pop-chart-meta').textContent()).split(' ')[0]);
  expect(samples).toBeGreaterThanOrEqual(10);
  const linePoints = (await page.locator('#pop-chart polyline').getAttribute('points')).trim().split(/\s+/);
  expect(linePoints.length).toBe(samples);
  // Pressure along the same path, in Pa.
  await page.locator('#pop-field-variable').selectOption('p');
  await gen.click();
  await expect(page.locator('#pop-chart')).toContainText('Pressure (Pa)', { timeout: 90_000 });
  await expect(page.locator('#pop-chart-meta')).toHaveText(/ Pa$/);

  // ---- Iso Surface: drawn at the middle of the field's range; the parts turn see-through.
  await isoBtn.click();
  await expect(isoBtn).toHaveClass(/is-active/);
  await expect(page.locator('#iso-block')).toBeVisible();
  expect(await optionTexts('#iso-scalar')).toEqual(fields);
  await expect(page.locator('#iso-value-unit')).toHaveText('m/s');
  const iso = () => page.evaluate(() => window.__CFD_W10__?.iso_fingerprint || {});
  await expect.poll(async () => (await iso()).n_cells || 0, { timeout: 90_000 }).toBeGreaterThan(0);
  expect((await iso()).actor_present).toBe(true);
  const isoValue = Number(await page.locator('#iso-value').inputValue());
  expect(isoValue).toBeGreaterThan(0);
  expect(isoValue).toBeLessThan(1);
  await expect(page.locator('#iso-status')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_SURFACE_OPACITY__())).toBe(0.3);
  // A typed value outside the field's range draws nothing and says why.
  await page.locator('#iso-value').fill('50');
  await expect(page.locator('#iso-status')).toHaveText(
    /^No surface at this value\. Velocity Magnitude goes from \S+ to \S+ m\/s at this time\.$/,
    { timeout: 90_000 },
  );
  await expect.poll(async () => (await iso()).actor_present).toBe(false);
  await expect(page.locator('#iso-value')).toHaveValue('50');

  // ---- Iso Volume: the region between two values, its range shown in the field's unit.
  await ivBtn.click();
  await expect(ivBtn).toHaveClass(/is-active/);
  await expect(page.locator('#iv-block')).toBeVisible();
  expect(await optionTexts('#iv-scalar')).toEqual(fields);
  const iv = () => page.evaluate(() => window.__CFD_W11__?.iv_fingerprint || {});
  await expect.poll(async () => (await iv()).n_cells || 0, { timeout: 90_000 }).toBeGreaterThan(0);
  expect((await iv()).actor_present).toBe(true);
  await expect(page.locator('#iv-range-val')).toHaveText(/^From \S+ to \S+ m\/s$/);
  await expect(page.locator('#iv-status')).toBeHidden();

  // Each button turns its tool off again; with both iso tools off the parts come back.
  await ivBtn.click();
  await expect(ivBtn).not.toHaveClass(/is-active/);
  await expect.poll(async () => (await iv()).actor_present).toBe(false);
  await isoBtn.click();
  await expect(isoBtn).not.toHaveClass(/is-active/);
  await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_SURFACE_OPACITY__())).toBe(1);
  await popBtn.click();
  await expect(popBtn).not.toHaveClass(/is-active/);
});
