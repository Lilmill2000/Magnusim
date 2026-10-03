import { expect, test } from '@playwright/test';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two studies whose names make the same folder name ("Run A" and "Run A?" are both
// Run_A): the second is in Run_A_2. Every catalog save renames each study's folder to
// its name, and the second study's folder moved to Run_A_3, then back to Run_A_2, on
// each one; an open run's results, plugin data and anything else holding its path
// lost it. Its folder, and its run's results, stay where they are across saves (a study
// added and renamed, the active study switched, a reload). No WSL: the run's case is the
// committed finished cavity case.
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

test('a study named like another keeps its folder and results across saves', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e study folder clash ${stamp()}`,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect
    .poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 })
    .toBe(1);
  const geom = (await json(request, q('/api/project'))).project.geometries[0];
  const simsRoot = join(dirname(geom.step_path), 'simulations');

  const studyRow = (sid) => page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  const studyPanel = page.locator('#panel-study-settings');
  const studies = async () => (await json(request, q('/api/simulation'))).simulations || [];
  const createStudy = async () => {
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
    await page.locator('#btn-create-simulation').click();
    await expect(page.locator('#modal-create-simulation')).toBeVisible();
    await page.locator('#cs-create').click();
    await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
    if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
    return page.evaluate(() => window.__CFD_W17__.activeId);
  };
  const rename = async (sid, name) => {
    // A click on the row of the study whose panel is open closes the panel.
    const open = (await studyPanel.isVisible()) && (await page.evaluate(() => window.__CFD_W17__.activeId)) === sid;
    if (!open) await studyRow(sid).click();
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
    // A switch draws the panel again when its replies land (activate, hydrate), which wipes
    // a rename box opened before that. Two switches in quick succession also closed the new
    // study's panel (study-switch-panel.spec.js), so reopen the panel if it is closed. Retry
    // until the server has the name.
    const input = studyPanel.locator('input[aria-label="Simulation name"]');
    await expect(async () => {
      if (!(await studyPanel.isVisible())) await studyRow(sid).click({ timeout: 5_000 });
      await expect(studyPanel).toBeVisible({ timeout: 2_000 });
      if (!(await input.isVisible())) {
        await studyPanel.locator('button.mesh-rename[aria-label="Rename simulation"]').click({ timeout: 5_000 });
      }
      await input.fill(name, { timeout: 5_000 });
      await input.press('Enter', { timeout: 5_000 });
      // Hidden is not enough: a panel that closes hides an unsaved box too.
      await expect.poll(async () => (await studies()).find((s) => s.id === sid)?.name, { timeout: 5_000 }).toBe(name);
    }).toPass({ timeout: 90_000 });
    await expect(studyRow(sid)).toContainText(name);
  };
  const folderOf = (sid) =>
    readdirSync(simsRoot).find((name) => {
      try {
        return JSON.parse(readFileSync(join(simsRoot, name, 'id.json'), 'utf8')).id === sid;
      } catch {
        return false;
      }
    });

  const a = await createStudy();
  await rename(a, 'Run A');
  const b = await createStudy();
  await rename(b, 'Run A?');
  expect(folderOf(a)).toBe('Run_A');
  expect(folderOf(b)).toBe('Run_A_2');

  // A finished run in the second study: its case is the cavity's, results at 0.1 .. 0.5.
  const made = await (
    await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: b, name: 'Run 1' } })
  ).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runRow = async () =>
    ((await json(request, q('/api/run/status', { simulation_id: b }))).runs || []).find((r) => String(r.id) === rid);
  const runDir = dirname((await runRow()).case_dir);
  expect(basename(dirname(dirname(runDir)))).toBe('Run_A_2');
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  // The fixture's sidecar names the plugin study it came from; this case is the core run's.
  const sidecar = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  delete sidecar.plugin;
  delete sidecar.study_id;
  writeFileSync(join(caseDir, 'w27-case.json'), JSON.stringify(sidecar, null, 2));
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

  // Its results, as the user opens them: the case in Run_A_2, five frames.
  const openResults = async () => {
    await studyRow(b).click();
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(b);
    const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${b}"] li[data-w27-sim-control="1"]`).first();
    if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
      await runsFolder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    const results = page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first();
    await expect(results).toBeVisible();
    await results.click();
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => window.__CFD_W6__ && window.__CFD_W6__.case_dir), { timeout: 60_000 })
      .toBeTruthy();
    const shown = await page.evaluate(() => ({
      caseDir: window.__CFD_W6__.case_dir,
      proof: window.__CFD_W6__.foam_proof || null,
    }));
    expect(shown.proof && shown.proof.min != null && shown.proof.max != null, JSON.stringify(shown.proof)).toBe(true);
    return shown.caseDir;
  };
  const sameDir = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  const attached = await openResults();
  expect(sameDir(attached)).toBe(sameDir(caseDir));

  // Saves: each one writes every study's folder name.
  const c = await createStudy();
  expect(folderOf(b)).toBe('Run_A_2');
  await rename(c, 'Other study');
  expect(folderOf(b)).toBe('Run_A_2');
  // A rename also makes its study the active one (a click on its row). The first study
  // leaves Run_A and comes back: the second keeps Run_A_2 meanwhile.
  await rename(a, 'Run A plain');
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(a);
  expect(folderOf(b)).toBe('Run_A_2');
  await rename(a, 'Run A');
  await studyRow(b).click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(b);
  await rename(c, 'Other study 2');
  await rename(b, 'Run A?');
  expect(readdirSync(simsRoot).filter((n) => n.startsWith('Run_A')).sort()).toEqual(['Run_A', 'Run_A_2']);
  expect(folderOf(a)).toBe('Run_A');
  expect(folderOf(b)).toBe('Run_A_2');
  // The case the viewer opened is still there, and the run still points at it.
  expect(existsSync(join(attached, '0.5', 'U'))).toBe(true);
  expect(sameDir((await runRow()).case_dir)).toBe(sameDir(caseDir));

  await page.reload();
  await ready();
  await expect(studyRow(b)).toContainText('Run A?');
  expect(sameDir(await openResults())).toBe(sameDir(caseDir));
  expect(folderOf(b)).toBe('Run_A_2');
});
