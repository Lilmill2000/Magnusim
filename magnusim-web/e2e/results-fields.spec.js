import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../scripts/python-env.js';

// Every results tool lists the run's result fields that its frame wrote, with the
// analysis's labels and units; the page names no physics field of its own. No WSL: three
// finished runs in one study, each a copy of the committed cavity case.
//   A  an Incompressible Flow run that also wrote k: every picker lists Velocity
//      Magnitude, Pressure and Turbulent kinetic energy; the iso value's unit follows the
//      iso field; the inspect card has one row per field with its unit; a bound typed on
//      the k legend is saved with the view and comes back (only magU and p were saved).
//   B  a plugin-style case that says its own result fields (T, a temperature in K): the
//      legend reads Temperature / K, nothing offers a velocity, Particle trace is off
//      and says why, inspect shows the temperature in K.
//   C  a case that stores p in Pa (kinematic_fields []): inspect shows p as stored.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PY_DIR = join(WEB, 'python');
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

/** The case's time folders. */
const timeDirs = (caseDir) => readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d));

/** Write field `to` in every time folder as a copy of `from` (its object renamed). */
function copyField(caseDir, from, to) {
  for (const t of timeDirs(caseDir)) {
    const text = readFileSync(join(caseDir, t, from), 'utf8');
    writeFileSync(join(caseDir, t, to), text.replace(new RegExp(`(object\\s+)${from};`), `$1${to};`));
  }
}

function editSidecar(caseDir, change) {
  const path = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  // The fixture names the plugin study it came from; these cases are core runs'.
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(path, JSON.stringify({ ...doc, ...change }, null, 2));
}

/** The case's stored p (no unit change) probed at a point, as the inspect tool probes it. */
function storedPressureAt(caseDir, time, xyz) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'from pathlib import Path',
    'from case_volume import load_volume',
    'from export_inspect_point import _point_grid, probe_point',
    'mesh, _ = load_volume(Path(sys.argv[1]), sys.argv[2])',
    'print(json.dumps(probe_point(_point_grid(mesh), [float(v) for v in sys.argv[3:6]])))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, caseDir, String(time), ...xyz.map(String)], { cwd: PY_DIR, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`stored pressure probe failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

test("results tools list the run's result fields with their units", async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e results fields ${stamp()}`,
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
  /** A finished run whose case is a copy of the cavity, changed by `prepare(caseDir)`. */
  const seedRun = async (name, prepare) => {
    const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name } })).json();
    const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
    expect(rid, JSON.stringify(made)).toBeTruthy();
    const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
    const caseDir = join(runDir, 'case');
    cpSync(CAVITY, caseDir, { recursive: true });
    editSidecar(caseDir, {});
    prepare(caseDir);
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
    return { rid, caseDir };
  };
  // A: the Incompressible Flow run, plus a turbulent kinetic energy field in every frame.
  const runA = await seedRun('Run A', (c) => copyField(c, 'p', 'k'));
  // B: a plugin-style case: T (from p) and its own result fields; U and p are still on disk.
  const runB = await seedRun('Run B', (c) => {
    copyField(c, 'p', 'T');
    editSidecar(c, {
      kinematic_fields: [],
      frame_fields: ['T'],
      result_fields: [{ key: 'T', kind: 'scalar', unit_quantity: 'temperature', label: 'Temperature', unit: 'K' }],
    });
  });
  // C: p stored in Pa (the analysis lists no kinematic fields).
  const runC = await seedRun('Run C', (c) => editSidecar(c, { rho: 1000, kinematic_fields: [] }));
  await page.reload();
  await ready();

  const openResults = async (rid) => {
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
  };
  /** Inspect the middle of the viewport, as a user clicks it; the card's rows by field. */
  const inspectMiddle = async () => {
    await page.locator('#btn-inspect-point').click();
    const box = await page.locator('#viewer').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#inspect-pins .inspect-pin[data-hit="1"]')).toHaveCount(1, { timeout: 60_000 });
    // The clicked surface carries the field on screen; the volume probe fills the others.
    await expect
      .poll(() => page.locator('#inspect-pins .inspect-pin-row b').allTextContents(), { timeout: 60_000 })
      .not.toContain('—');
    expect(await page.locator('#inspect-pins .inspect-pin-row').count()).toBeGreaterThan(0);
    const rows = await page.locator('#inspect-pins .inspect-pin-row').evaluateAll((els) =>
      els.map((el) => ({ field: el.getAttribute('data-field'), label: el.querySelector('span')?.textContent, value: el.querySelector('b')?.textContent })),
    );
    // Where it probed (the inspect hook; the card shows only the values).
    const at = await page.evaluate(() => {
      const w = window.__CFD_W13__;
      return { casePos: (w.points || []).filter((p) => p.hit).pop().casePos, time: String(w.time) };
    });
    await page.locator('#btn-inspect-point').click();
    rows.at = at;
    return rows;
  };
  const optionTexts = (sel) => page.locator(`${sel} option:not([hidden])`).allTextContents();
  const filtersText = () =>
    page.evaluate(() => [...document.querySelectorAll('#filters-panel select option, #legend, #legend-pt, #inspect-pins')].map((el) => el.textContent).join(' | '));

  // ---- A ----
  await openResults(runA.rid);
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 60_000 });
  await expect(page.locator('#legend .legend-units')).toHaveText('m/s');
  const fieldsA = ['Velocity Magnitude', 'Pressure', 'Turbulent kinetic energy'];
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await expect(page.locator('#cp-coloring')).toBeVisible();
  await expect.poll(() => optionTexts('#cp-coloring')).toEqual(fieldsA);
  for (const sel of ['#iso-scalar', '#iso-coloring', '#iv-scalar', '#iv-coloring', '#pop-field-variable']) {
    expect(await optionTexts(sel), sel).toEqual(fieldsA);
  }
  expect(await optionTexts('#pt-coloring')).toEqual([...fieldsA, 'Solid color']);
  const vecColor = page.locator('#result-plane-list select[data-rplane-vec-color]').first();
  expect(await vecColor.locator('option').allTextContents()).toEqual(['Solid color', ...fieldsA]);
  // The iso value is in the iso field's unit. (The Iso Surface block has no toolbar button
  // today; it is shown the way the toolbar would show it.)
  await page.evaluate(() => {
    document.getElementById('iso-block').hidden = false;
  });
  await expect(page.locator('#iso-value-unit')).toHaveText('m/s');
  await page.locator('#iso-scalar').selectOption('p');
  await expect(page.locator('#iso-value-unit')).toHaveText('Pa');
  await page.locator('#iso-scalar').selectOption('k');
  await expect(page.locator('#iso-value-unit')).toHaveText('m²/s²');
  // The inspect card: one row per field, each with its unit.
  const rowsA = await inspectMiddle();
  expect(rowsA.map((r) => [r.field, r.label])).toEqual([
    ['magU', 'Velocity Magnitude'],
    ['p', 'Pressure'],
    ['k', 'Turbulent kinetic energy'],
  ]);
  expect(rowsA[0].value).toMatch(/ m\/s$/);
  expect(rowsA[1].value).toMatch(/ Pa$/);
  expect(rowsA[2].value).toMatch(/ m²\/s²$/);
  // A typed maximum on the k legend is kept by a saved view and comes back on reopening.
  await page.locator('#cp-coloring').selectOption('k');
  await expect(page.locator('#legend .legend-title')).toHaveText('Turbulent kinetic energy', { timeout: 60_000 });
  await expect(page.locator('#legend .legend-units')).toHaveText('m²/s²');
  await page.locator('#legend .legend-bar-val-hi').click();
  const max = page.locator('#legend input[aria-label="Scale maximum"]');
  await max.fill('2');
  await max.press('Enter');
  await expect(page.locator('#legend')).toHaveClass(/is-custom/);
  await expect(page.locator('#legend .legend-bar-val-hi')).toHaveText('2.00');
  if (await page.locator('#views-block').evaluate((el) => el.classList.contains('is-collapsed'))) {
    await page.locator('#views-block .fp-collapse-toggle').click();
  }
  await page.locator('#views-save').click();
  await page.locator('#pm-input').fill('k bound');
  await page.locator('#pm-confirm').click();
  const runARow = async () => (await runRows()).find((r) => String(r.id) === runA.rid) || {};
  await expect.poll(async () => ((await runARow()).views || []).map((v) => v.name), { timeout: 30_000 }).toEqual(['k bound']);
  // The live filters are saved to the run too (debounced): wait for them before reloading.
  await expect.poll(async () => (await runARow()).current_view?.scale?.k?.bounds?.hi ?? null, { timeout: 30_000 }).toBe(2);
  await page.reload();
  await ready();
  await openResults(runA.rid);
  await expect(page.locator('#legend .legend-title')).toHaveText('Turbulent kinetic energy', { timeout: 60_000 });
  await expect(page.locator('#legend')).toHaveClass(/is-custom/, { timeout: 30_000 });
  await expect(page.locator('#legend .legend-bar-val-hi')).toHaveText('2.00');
  // The saved view itself brings it back too, after going back to the data's own range.
  await page.locator('#legend .legend-auto').click();
  await expect(page.locator('#legend')).not.toHaveClass(/is-custom/);
  if (await page.locator('#views-block').evaluate((el) => el.classList.contains('is-collapsed'))) {
    await page.locator('#views-block .fp-collapse-toggle').click();
  }
  // Its summary names the field by its label.
  const vid = ((await runARow()).views || [])[0].id;
  await expect(page.locator(`#views-select option[value="${vid}"]`)).toHaveText(/^k bound — Turbulent kinetic energy/);
  await page.locator('#views-select').selectOption(vid);
  await expect(page.locator('#legend')).toHaveClass(/is-custom/, { timeout: 30_000 });
  await expect(page.locator('#legend .legend-bar-val-hi')).toHaveText('2.00');

  // ---- B ----
  await openResults(runB.rid);
  await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 60_000 });
  await expect(page.locator('#legend .legend-units')).toHaveText('K');
  await expect.poll(() => optionTexts('#cp-coloring')).toEqual(['Temperature']);
  for (const sel of ['#iso-scalar', '#iv-scalar', '#pop-field-variable']) {
    expect(await optionTexts(sel), sel).toEqual(['Temperature']);
  }
  const ptBtn = page.locator('.tb-btn[data-label="Particle Trace"]');
  await expect(ptBtn).toBeDisabled();
  await expect(ptBtn).toHaveAttribute('title', 'This case has no velocity field');
  const rowsB = await inspectMiddle();
  expect(rowsB.map((r) => [r.field, r.label])).toEqual([['T', 'Temperature']]);
  expect(rowsB[0].value).toMatch(/ K$/);
  expect(await filtersText()).not.toMatch(/Velocity|Pressure/);

  // ---- C ----
  await openResults(runC.rid);
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 60_000 });
  await expect(ptBtn).toBeEnabled();
  const rowsC = await inspectMiddle();
  const pRow = rowsC.find((r) => r.field === 'p');
  expect(pRow && pRow.label).toBe('Pressure');
  expect(pRow.value).toMatch(/ Pa$/);
  const shownP = Number(String(pRow.value).replace(/ Pa$/, ''));
  const picked = rowsC.at;
  const stored = storedPressureAt(runC.caseDir, picked.time, picked.casePos);
  expect(stored.hit).toBe(true);
  // As stored: not times rho (1000).
  expect(Math.abs(shownP - stored.p)).toBeLessThanOrEqual(Math.max(1e-6, 0.01 * Math.abs(stored.p)));
});
