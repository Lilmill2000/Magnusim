import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';

// A fluid picked in the Materials panel while the panel's first save of a new study's
// fluid (a body assigned) is still on its way back saves on that same fluid. The second
// save waited in the panel's queue and built its record from the fluid the panel held
// when it ran: the first save's answer had not been rendered yet, so that was still "no
// fluid", and Argon was saved as a second fluid beside the study's Air (CI run #41,
// materials-presets.spec.js:102: the study's first fluid stayed Air for 15 s). And the
// first save's own reload, read before Argon was written, put Air back on screen. Here
// the first save's answer is held at the route until Argon is picked, and Argon's save
// until that reload has answered, so both windows are open on every run. No WSL.
const PID = 'materials-queued-save-e2e';
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');

test.beforeAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
  seedElbowProject(PROJECTS, PID, 'Materials queued save');
});

test.afterAll(() => {
  rmSync(join(PROJECTS, PID), { recursive: true, force: true });
});

function deferred() {
  let resolveIt = () => {};
  const promise = new Promise((r) => {
    resolveIt = r;
  });
  return { promise, resolve: resolveIt };
}

/**
 * Hold the page's materials.set calls, in order: `answer` lets the server write and holds
 * the answer; `request` holds the call before the server sees it. `reached` resolves when
 * the call is held; `release()` lets it go on.
 */
async function holdMaterialsSaves(page, kinds) {
  const holds = kinds.map((kind) => ({ kind, reached: deferred(), gate: deferred() }));
  const queue = holds.slice();
  await page.route(/\/api\/worker$/, async (route) => {
    const req = route.request();
    let method = '';
    try {
      method = String((req.postDataJSON() || {}).method || '');
    } catch {
      method = '';
    }
    const hold = req.method() === 'POST' && method === 'materials.set' ? queue.shift() : undefined;
    if (!hold) {
      await route.fallback();
      return;
    }
    if (hold.kind === 'answer') {
      const response = await route.fetch();
      hold.reached.resolve();
      await hold.gate.promise;
      await route.fulfill({ response });
      return;
    }
    hold.reached.resolve();
    await hold.gate.promise;
    await route.fallback();
  });
  return holds.map((h) => ({ reached: h.reached.promise, release: () => h.gate.resolve() }));
}

test("a fluid picked while the new fluid's first save is on its way back saves on that fluid", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fluids = async (sid) => {
    const r = await request.get(`/api/materials?${new URLSearchParams({ project_id: PID, simulation_id: sid })}`);
    expect(r.ok()).toBeTruthy();
    return (await r.json()).materials || [];
  };

  await page.goto(`/#/p/${encodeURIComponent(PID)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 90_000 });
  await expect(page.locator('#left-tree')).toContainText('Mesh 1', { timeout: 30_000 });
  const first = await page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId);
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  await page.waitForFunction((old) => {
    const id = window.__CFD_W17__ && window.__CFD_W17__.activeId;
    return !!id && id !== old;
  }, first, { timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(await fluids(sid), 'a new study has no fluid saved').toEqual([]);

  await page.locator('#left-tree #btn-materials-plus').first().click();
  const panel = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const fluid = panel.getByLabel('Fluid');
  await expect(fluid).toHaveValue('air', { timeout: 15_000 });

  const [assign, argon] = await holdMaterialsSaves(page, ['answer', 'request']);
  await panel.locator('[data-volume="Body1"] button').first().click();
  await assign.reached;
  // The server has the study's Air on Body1; the page has not heard back yet.
  const air = await fluids(sid);
  expect(air.map((m) => [m.name, m.preset, m.assigned_volumes])).toEqual([['Air', 'air', ['Body1']]]);
  const airId = air[0].id;

  await fluid.selectOption('argon');
  await expect(fluid).toHaveValue('argon');
  // The first save's answer lands; its reload reads the server before Argon is written.
  const reload = page.waitForResponse((r) => /\/api\/materials\?/.test(r.url()) && r.request().method() === 'GET');
  assign.release();
  await argon.reached;
  await reload;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await expect(fluid, 'the pick stays on screen while its save is on its way').toHaveValue('argon');
  argon.release();

  // One fluid, the study's own, now Argon on Body1.
  await expect
    .poll(async () => (await fluids(sid)).map((m) => [m.id, m.name, m.preset, m.assigned_volumes]), {
      message: "the study's one fluid is Argon",
      timeout: 15_000,
    })
    .toEqual([[airId, 'Argon', 'argon', ['Body1']]]);
  await expect(fluid).toHaveValue('argon');
  await expect(panel.locator('.mat-panel-title')).toHaveText('Argon');
  await expect(panel.getByLabel('Density')).toHaveValue('1.661');
});
