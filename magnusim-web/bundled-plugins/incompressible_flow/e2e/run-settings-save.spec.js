import { expect, test } from '@playwright/test';
import { RUN_SETTINGS_PROJECT } from '../../../e2e/prepare-projects.js';

// A steady run's Iterations and Write interval, typed one after the other, are
// both kept: in the Run panel, in the saved run and in what Start sends.
// The bug (found by the H7 e2e): while the first save was still on its way, any
// refresh of the panel (a status poll, a live event, a click on the run in the
// tree) put the run's saved Iterations back, and the Write interval save then
// stored that old value, so the solver ran the old iteration count.
const PROJECT = RUN_SETTINGS_PROJECT;
const SIM = 'sim_1';

async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

async function openProject(page) {
  await page.goto(`/#/p/${PROJECT}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
}

test('typed run settings survive a refresh while they are saving', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const statusUrl = `/api/run/status?project_id=${PROJECT}&simulation_id=${SIM}`;
  const runRow = async (rid) => ((await getJson(request, statusUrl)).runs || []).find((r) => String(r.id) === String(rid)) || {};

  const created = await request.post('/api/run/create', { data: { project_id: PROJECT, simulation_id: SIM, name: 'Settings' } });
  const cj = await created.json();
  expect(created.ok(), JSON.stringify(cj)).toBe(true);
  const rid = cj.run_id || (cj.run && (cj.run.id || cj.run.run_id)) || cj.id;
  const saved = await runRow(rid);
  expect(saved.status).toBe('draft');
  const before = { endTime: Number(saved.endTime), writeInterval: Number(saved.writeInterval) };
  // Values unlike the defaults, so a revert cannot look like a pass.
  const want = { endTime: before.endTime + 37, writeInterval: before.writeInterval + 7 };

  await openProject(page);
  const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
    await folder.locator(':scope > .tree-row .tw').click();
  }
  const runNode = page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first();
  await runNode.click();
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  await expect(runPanel).toHaveAttribute('data-run-id', rid);
  const iterations = runPanel.getByLabel('Iterations', { exact: true });
  const writeInterval = runPanel.getByLabel('Write interval', { exact: true });
  await expect(iterations).toHaveValue(String(before.endTime));

  // Hold the first save on its way to the server.
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  let holdFirst = true;
  await page.route('**/api/run/update', async (route) => {
    if (holdFirst) {
      holdFirst = false;
      await held;
    }
    await route.continue();
  });

  await iterations.fill(String(want.endTime));
  await iterations.press('Enter');
  // A refresh while that save is held: open the study, then the run again.
  await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row`).first().click();
  await expect(page.locator('#panel-incompressible-defaults .cfd-island [data-study-panel="1"]')).toBeVisible();
  await runNode.click();
  await expect(runPanel).toHaveAttribute('data-run-id', rid);
  await expect(iterations, 'the typed Iterations is still shown').toHaveValue(String(want.endTime));
  await writeInterval.fill(String(want.writeInterval));
  await writeInterval.press('Enter');
  await expect(iterations).toHaveValue(String(want.endTime));
  await expect(writeInterval).toHaveValue(String(want.writeInterval));
  release();

  // Both values are saved on the run...
  await expect
    .poll(async () => {
      const r = await runRow(rid);
      return `${r.endTime}/${r.writeInterval}`;
    }, { timeout: 15_000 })
    .toBe(`${want.endTime}/${want.writeInterval}`);
  await page.unroute('**/api/run/update');

  // ...and are what the panel shows after a reload.
  await page.reload();
  await openProject(page);
  const folder2 = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
  if (!(await folder2.evaluate((el) => el.classList.contains('expanded')))) {
    await folder2.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  await expect(runPanel).toHaveAttribute('data-run-id', rid);
  await expect(runPanel.getByLabel('Iterations', { exact: true })).toHaveValue(String(want.endTime));
  await expect(runPanel.getByLabel('Write interval', { exact: true })).toHaveValue(String(want.writeInterval));
});
