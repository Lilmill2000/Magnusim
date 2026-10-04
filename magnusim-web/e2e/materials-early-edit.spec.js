import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';

// A viscosity typed in the Materials panel as soon as it shows, right after the project
// opens, saves on the simulation's own fluid within a few seconds. The panel used to show
// the default preset's numbers (Air at 20 C, 1.516e-5) until the simulation's saved fluid
// loaded: a value typed then saved a second "Air" beside the simulation's (which kept
// 1.529e-5), or was wiped by the load landing mid-typing. That window was tens of
// milliseconds, wider on a busier server (the smoke test's edit hit it about one run in
// four once one more project was seeded for every test server). Here every GET
// /api/materials the page makes is held 1.5 s, as on a busy server, so the window is open
// on every run. No WSL.
const PID = 'materials-early-edit-e2e';
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const SLOW_LOAD_MS = 1_500;

test.beforeAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
  seedElbowProject(PROJECTS, PID, 'Materials early edit');
});

test.afterAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
});

test("a viscosity typed as soon as the Materials panel shows saves on the simulation's fluid within 3 s", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fluids = async (sid) => {
    const r = await request.get(`/api/materials?${new URLSearchParams({ project_id: PID, simulation_id: sid })}`);
    expect(r.ok()).toBeTruthy();
    return (await r.json()).materials || [];
  };
  await page.route(/\/api\/materials\?/, async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, SLOW_LOAD_MS));
    await route.continue();
  });

  await page.goto(`/#/p/${encodeURIComponent(PID)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await page.waitForFunction(() => !!(window.__CFD_W17__ && window.__CFD_W17__.activeId), null, { timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  const before = await fluids(sid);
  expect(before.map((m) => [m.name, m.kinematic_viscosity]), 'the seeded simulation has one Air').toEqual([['Air', 1.529e-5]]);
  const airId = before[0].id;

  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  const airRow = study.locator('[data-w18-air="1"] > .tree-row').first();
  if (!(await airRow.isVisible().catch(() => false))) {
    await study.locator('[data-w18-materials="1"] > .tree-row').first().click();
  }
  await airRow.click();
  const panel = page.locator('#panel-air-material .cfd-island');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const nu = panel.getByLabel('Kinematic viscosity');
  await nu.waitFor({ state: 'visible', timeout: 15_000 });
  // The moment the field shows, it shows the simulation's viscosity, never the preset's.
  expect.soft(await nu.inputValue(), 'the field shows the saved viscosity').toBe('1.5290e-5');

  // Typed at once, the way a user who knows the value does.
  await nu.fill('2e-5');
  await nu.press('Enter');
  const typedAt = Date.now();
  await expect
    .poll(async () => ((await fluids(sid)).find((m) => m.id === airId) || {}).kinematic_viscosity, {
      message: "the simulation's Air has the typed viscosity",
      timeout: 3_000,
    })
    .toBe(0.00002);
  test.info().annotations.push({ type: 'saved', description: `${Date.now() - typedAt} ms after Enter` });
  // Still one fluid: no second Air beside it.
  expect((await fluids(sid)).map((m) => [m.id, m.name])).toEqual([[airId, 'Air']]);
  await expect(nu).toHaveValue('2.0000e-5');
});
