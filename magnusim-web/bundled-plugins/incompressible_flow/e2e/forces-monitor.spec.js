import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Forces monitor (F4) is placed on whole walls: the Monitors dialog adds one on
// every wall the study has (each wall BC by its name, and the walls no BC claims),
// its panel lists them with tick boxes (not the inlet), an unticked wall stays
// unticked after a reload, and the panel points at the study's reference values
// (Edit opens the study panel's Reference values). No WSL.
// Fails on the code before F4: the dialog had no Forces type.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
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

test("a Forces monitor offers the study's walls, keeps the ticked ones and points at the reference values", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e forces monitor ${stamp()}`,
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

  // An inlet, a wall BC ("Wing") and a symmetry plane ("Mirror", meshed like a
  // wall but not one: forces leave it out); the other faces are the walls no BC claims.
  for (const [name, bcType, face] of [
    ['Inlet', 'Velocity inlet', 'face 1@Body1'],
    ['Wing', 'Wall', 'face 2@Body1'],
    ['Mirror', 'Symmetry', 'face 3@Body1'],
  ]) {
    const r = await request.post(q('/api/bcs'), { data: { project_id: pid, simulation_id: sid, name, bc_type: bcType, faces: [face] } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  const bcs = (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  const wing = bcs.find((b) => b.name === 'Wing');
  expect(wing).toBeTruthy();
  const wingToken = wing.id != null && String(wing.id) ? String(wing.id) : 'Wing';

  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run 1' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runRc = async () =>
    (((await json(request, q('/api/run/status', { simulation_id: sid }))).runs || []).find((r) => String(r.id) === rid)
      ?.result_controls || [])[0] || null;
  await page.reload();
  await ready();

  const openRun = async () => {
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

  // ---- The Monitors dialog offers Forces, on boundaries ----
  await openRun();
  await page.locator(`button.rc-plus[data-w27-run-plus="${rid}"]`).click();
  await expect(page.locator('#modal-result-control')).toBeVisible();
  await expect(page.locator('#rc-type-list .cs-group-label')).toContainText(['SURFACE DATA', 'BOUNDARY DATA']);
  await page.locator('#rc-type-list [data-rc-type="forces"]').click();
  await expect(page.locator('#rc-detail-title')).toHaveText('Forces');
  await expect(page.locator('#rc-detail-hint')).toContainText('Add it here, then tick what it measures in its panel.');
  await page.locator('#rc-apply').click();
  await expect(page.locator('#modal-result-control')).toBeHidden();

  // ---- Its panel: every wall, ticked; not the inlet; no face picking ----
  const panel = page.locator('#panel-area-average');
  await expect(panel).toBeVisible();
  await expect(page.locator('#aa-panel-title')).toHaveText('Forces 1');
  await expect(page.locator('#aa-type-label')).toHaveText('Forces');
  await expect(page.locator('#aa-face-block')).toBeHidden();
  await expect(page.locator('#aa-boundary-block')).toBeVisible();
  await expect(page.locator('#aa-boundary-word')).toHaveText('Walls');
  const items = page.locator('#aa-boundary-list .aa-boundary-item');
  await expect(items).toHaveText(['Wing', 'Walls with no boundary condition']);
  await expect(page.locator('#aa-boundary-list input[type="checkbox"]:checked')).toHaveCount(2);
  await expect(page.locator('#aa-boundary-count')).toHaveText('2');
  await expect.poll(async () => (await runRc())?.boundaries).toEqual([wingToken, '@walls']);
  const saved = await runRc();
  // The run keeps a result control's type as monitor_type (not its kind).
  expect([saved.name, saved.monitor_type]).toEqual(['Forces 1', 'forces']);
  // The panel says what it measures against.
  await expect(page.locator('#aa-study-note')).toBeVisible();
  await expect(page.locator('#aa-study-note-text')).toContainText("Uses the study's reference values");

  // ---- Untick Wing: saved, and still unticked after a reload ----
  await page.locator(`#aa-boundary-list [data-aa-boundary="${wingToken}"]`).uncheck();
  await expect(page.locator('#aa-boundary-count')).toHaveText('1');
  await expect.poll(async () => (await runRc())?.boundaries).toEqual(['@walls']);
  // The Monitors hub says what it is placed on.
  await expect(page.locator('#results-hub-list')).toContainText('Forces 1 · 1 wall');
  await page.reload();
  await ready();
  await openRun();
  const rcFolder = page.locator(`#left-tree li[data-w27-run-rcs="${rid}"]`).first();
  if (!(await rcFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await rcFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-aa="${saved.id}"] > .tree-row .tl`).first().click();
  await expect(panel).toBeVisible();
  await expect(page.locator(`#aa-boundary-list [data-aa-boundary="${wingToken}"]`)).not.toBeChecked();
  await expect(page.locator('#aa-boundary-list [data-aa-boundary="@walls"]')).toBeChecked();

  // ---- Edit: the study panel's Reference values ----
  await page.locator('#aa-study-edit').click();
  const study = page.locator('#panel-study-settings');
  await expect(study).toBeVisible();
  await expect(study.locator('[data-study-reference="1"]')).toBeVisible();
  await expect(study.getByLabel('Reference area')).toHaveAttribute('placeholder', 'Not set');
});
