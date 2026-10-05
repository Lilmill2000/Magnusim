import { expect, test } from '@playwright/test';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The result fields Incompressible Flow's function objects write (y+, wall shear stress,
// total pressure, vorticity, Q-criterion; the time averages of a transient run) are listed
// in Results with their labels and units. No WSL: a finished run whose case is a copy of
// the committed cavity, with those fields added the way OpenFOAM writes them:
//   - in the saved frames only, not in the 0 folder (the starting fields);
//   - y+ on the walls only (0 inside, one value per wall face): its legend reads the wall values;
//   - the time averages only from 0.3 s on (a later "Average from" time).
// A frame that did not save the field on screen shows the first listed field (velocity), and
// the next frame that saved it shows it again.
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

/** The case's saved frames (time folders after 0). */
const savedFrames = (caseDir) => readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d) && Number(d) > 0);

/** Write field `to` in the given time folders as a copy of `from` (its object renamed). */
function copyField(caseDir, times, from, to) {
  for (const t of times) {
    const text = readFileSync(join(caseDir, t, from), 'utf8');
    writeFileSync(join(caseDir, t, to), text.replace(new RegExp(`(object\\s+)${from};`), `$1${to};`));
  }
}

/** y+ as the yPlus function object writes it: 0 inside, one value per wall face. */
function yPlusFile(movingWall, fixedWalls) {
  const list = (vals) => `nonuniform List<scalar> \n${vals.length}\n(\n${vals.join('\n')}\n)\n`;
  return (
    'FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       volScalarField;\n    object      yPlus;\n}\n\n' +
    'dimensions      [0 0 0 0 0 0 0];\n\ninternalField   uniform 0;\n\nboundaryField\n{\n' +
    `    movingWall\n    {\n        type            calculated;\n        value           ${list(movingWall)};\n    }\n` +
    `    fixedWalls\n    {\n        type            calculated;\n        value           ${list(fixedWalls)};\n    }\n` +
    '    frontAndBack\n    {\n        type            empty;\n    }\n}\n'
  );
}

test('results list y+, wall shear stress, total pressure, vorticity, Q and the time averages', async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e extra result fields ${stamp()}`,
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

  // A finished run whose case is the cavity plus the extra result fields.
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Fields' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runs = (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const runDir = dirname(runs.find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecarPath = join(caseDir, 'w27-case.json');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  delete sidecar.plugin;
  delete sidecar.study_id;
  // What the case writer records: these are stored divided by density, like p.
  sidecar.kinematic_fields = ['p', 'wallShearStress', 'pMean'];
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  const frames = savedFrames(caseDir);
  expect(frames).toEqual(['0.1', '0.2', '0.3', '0.4', '0.5']);
  copyField(caseDir, frames, 'U', 'wallShearStress');
  copyField(caseDir, frames, 'U', 'vorticity');
  copyField(caseDir, frames, 'p', 'pTotal');
  copyField(caseDir, frames, 'p', 'Q');
  const averaged = frames.filter((t) => Number(t) >= 0.3);
  copyField(caseDir, averaged, 'U', 'UMean');
  copyField(caseDir, averaged, 'p', 'pMean');
  const wallYPlus = Array.from({ length: 20 }, (_, i) => 5 + 5 * i); // 5 .. 100 on the lid
  for (const t of frames) writeFileSync(join(caseDir, t, 'yPlus'), yPlusFile(wallYPlus, Array(60).fill(2)));
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

  // Open the run's results.
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
  const title = page.locator('#legend .legend-title');
  const units = page.locator('#legend .legend-units');
  await expect(title).toHaveText('Velocity Magnitude', { timeout: 60_000 });

  // Every field the last frame wrote, in the analysis's order, vectors by their magnitude.
  const optionTexts = () => page.locator('#cp-coloring option:not([hidden])').allTextContents();
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await expect(page.locator('#cp-coloring')).toBeVisible();
  await expect
    .poll(optionTexts, { timeout: 60_000 })
    .toEqual([
      'Velocity Magnitude',
      'Pressure',
      'Total pressure',
      'y+',
      'Wall shear stress magnitude',
      'Vorticity magnitude',
      'Q-criterion',
      'Mean velocity magnitude',
      'Mean pressure',
    ]);

  // Each colours the surface with its own label and unit (y+ has none).
  for (const [value, label, unit] of [
    ['pTotal', 'Total pressure', 'Pa'],
    ['yPlus', 'y+', ''],
    ['magwallShearStress', 'Wall shear stress magnitude', 'Pa'],
    ['magvorticity', 'Vorticity magnitude', '1/s'],
    ['Q', 'Q-criterion', '1/s²'],
    ['pMean', 'Mean pressure', 'Pa'],
    ['magUMean', 'Mean velocity magnitude', 'm/s'],
  ]) {
    await page.locator('#cp-coloring').selectOption(value);
    await expect(title, value).toHaveText(label, { timeout: 60_000 });
    await expect(units, value).toHaveText(unit);
    if (value === 'yPlus') {
      // The wall values (up to 100), not the 0 inside.
      await expect
        .poll(async () => Number((await page.locator('#legend .legend-bar-val-hi').textContent()) || 0), { timeout: 30_000 })
        .toBeGreaterThan(50);
    }
  }

  // 0.2 s saved no averages: that frame shows velocity and does not offer them.
  await page.evaluate(() => window.__CFD_W12_APPLY__({ time: '0.2' }));
  await expect(title).toHaveText('Velocity Magnitude', { timeout: 60_000 });
  await expect.poll(optionTexts, { timeout: 30_000 }).not.toContain('Mean velocity magnitude');
  expect(await optionTexts()).toContain('Vorticity magnitude');
  // 0.4 s saved them again: back on the mean velocity.
  await page.evaluate(() => window.__CFD_W12_APPLY__({ time: '0.4' }));
  await expect(title).toHaveText('Mean velocity magnitude', { timeout: 60_000 });
  await expect(units).toHaveText('m/s');
});
