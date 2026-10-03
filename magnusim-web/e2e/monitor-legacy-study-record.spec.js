import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findStudy, studyResultControlsPath, writeJsonAtomic } from '../scripts/project-layout.js';
import { seedElbowProject } from './prepare-projects.js';

// A study saved before monitors moved onto the run keeps a lone study-level monitor
// (result_controls.json's area_average_1). The page's boot hydrate loads it into the
// monitor editor's state, and the run monitor save falls back to that record's id and
// name when no monitor is being edited. A monitor added to a run from the Monitors
// dialog must still get its own id and name (not the older record's), and saving it
// again (Clear) must keep them. Seeded here and removed after.
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const PROJECT = 'legacy-study-monitor-e2e';
const SIM = 'sim_1';
const LEGACY = {
  id: 'aa-legacy-study-e2e',
  name: 'Legacy outlet monitor',
  kind: 'Area average',
  category: 'Surface data',
  write_control: 'Time step',
  faces: ['Face 2'],
  simulation_id: SIM,
};

test('a monitor added to a run gets its own id and name when the study has an older study-level monitor', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const dir = join(PROJECTS, PROJECT);
  rmSync(dir, { recursive: true, force: true });
  seedElbowProject(PROJECTS, PROJECT, 'Legacy study monitor');
  const study = findStudy(dir, SIM);
  expect(study, 'the seeded study folder').toBeTruthy();
  writeJsonAtomic(studyResultControlsPath(study.dir), { area_average_1: LEGACY, result_controls: [] });
  try {
    const rc = await (await request.get(`/api/result-controls?${new URLSearchParams({ project_id: PROJECT, simulation_id: SIM })}`)).json();
    expect(rc.area_average_1 && rc.area_average_1.id, 'the server serves the older record').toBe(LEGACY.id);

    const made = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: SIM, name: 'Monitor run' } });
    const mj = await made.json();
    expect(made.ok(), JSON.stringify(mj)).toBe(true);
    const rid = String(mj.run_id || (mj.run && (mj.run.id || mj.run.run_id)));

    // Every run settings save the page posts: the monitors it writes onto the run.
    const posted = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/api/run/update') return;
      try {
        const body = JSON.parse(r.postData() || '{}');
        if (String(body.run_id) === rid && Array.isArray(body.result_controls)) posted.push(body.result_controls);
      } catch (_) {}
    });

    await page.goto(`/#/p/${encodeURIComponent(PROJECT)}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    // Whether the boot hydrate put the older record in the editor's state (the case under test).
    await page.waitForTimeout(1_500);
    const seeded = await page.evaluate(() => {
      const aa = window.__CFD_W22__ && window.__CFD_W22__.area_average_1;
      return aa ? String(aa.id) : null;
    });
    test.info().annotations.push({ type: 'hydrated study monitor', description: String(seeded) });

    const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
    await expect(folder).toBeVisible();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
      await folder.locator(':scope > .tree-row .tw').click();
    }
    const runLi = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
    await expect(runLi).toBeVisible();
    if (!(await runLi.evaluate((el) => el.classList.contains('expanded')))) {
      await runLi.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`button.rc-plus[data-w27-run-plus="${rid}"]`).click();
    await expect(page.locator('#modal-result-control')).toBeVisible();
    await expect(page.locator('#rc-apply')).toBeEnabled();
    const typeLabel = (await page.locator('#rc-type-list [data-rc-type].is-selected').innerText()).trim();
    await page.locator('#rc-apply').click();
    await expect(page.locator('#modal-result-control')).toBeHidden();

    // The saved monitor is a new one: its own id and the next name of its type.
    await expect.poll(() => posted.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const first = posted[posted.length - 1];
    expect(first).toHaveLength(1);
    expect(first[0].id).not.toBe(LEGACY.id);
    expect(first[0].name).toBe(`${typeLabel} 1`);
    expect(first[0].faces).toEqual([]);
    const ownId = first[0].id;
    // What the user sees: the monitor's panel and the run's tree row carry its own name.
    await expect(page.locator('#aa-panel-title')).toHaveText(`${typeLabel} 1`);
    await expect(page.locator(`#left-tree [data-w27-aa="${ownId}"]`).first()).toBeVisible();
    await expect(page.locator('#left-tree')).not.toContainText(LEGACY.name);

    // Saving it again (Clear) keeps its id and name and adds nothing.
    const before = posted.length;
    await page.locator('#aa-clear-assign').click();
    await expect.poll(() => posted.length, { timeout: 15_000 }).toBeGreaterThan(before);
    const again = posted[posted.length - 1];
    expect(again.map((r) => [r.id, r.name])).toEqual([[ownId, `${typeLabel} 1`]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
