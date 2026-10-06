import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { findRun } from '../scripts/project-layout.js';

// F10, a run's Cores as the user meets it in the Run panel (no WSL):
// - Cores offers Auto and 1 up to what this PC gives a run (the server's own cap,
//   here Settings → Hardware's 3 cores or fewer);
// - choosing a number saves it on the run record and it is still chosen after a reload;
// - Copy from previous run carries it to another run.
const PROJECT = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';

test.describe('run cores', () => {
  /** @type {any} */
  let host;

  test.beforeAll(async () => {
    const tmp = e2eTemp('run-cores');
    host = await startHost({
      name: 'run-cores',
      tmp,
      prefs: { hardware: { n_procs: 3 } },
      env: { MAGNUSIM_WSL_PRUNE: '0' },
    });
  });

  test.afterAll(() => {
    if (host) host.stop();
  });

  async function openProject(page) {
    await page.goto(`${host.base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
  }

  async function openRun(page, rid) {
    const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
    return runPanel;
  }

  async function makeRun(request, name) {
    const made = await request.post(`${host.base}/api/run/create`, { data: { project_id: PROJECT, simulation_id: SIM, name } });
    const mj = await made.json();
    expect(made.ok(), JSON.stringify(mj)).toBe(true);
    return String(mj.run_id || (mj.run && (mj.run.id || mj.run.run_id)));
  }

  /** The run's record on disk (run.json). */
  const record = (rid) => findRun(join(host.projects, PROJECT), rid, SIM);

  test('the Run panel offers Auto and 1 up to the PC cap; a chosen count is saved on the run and survives a reload', async ({ page, request }) => {
    test.setTimeout(180_000);
    const prefs = await (await request.get(`${host.base}/api/prefs`)).json();
    const cap = Number(prefs.rank_cap);
    // Settings → Hardware says 3; a PC with fewer physical cores gives fewer (never below 2).
    expect(cap).toBeGreaterThanOrEqual(2);
    expect(cap).toBeLessThanOrEqual(3);
    const rid = await makeRun(request, 'Cores run');

    await openProject(page);
    let runPanel = await openRun(page, rid);
    const cores = runPanel.getByLabel('Cores', { exact: true });
    await expect(cores).toHaveValue('auto');
    const labels = await cores.locator('option').allTextContents();
    expect(labels).toEqual(['Auto', ...Array.from({ length: cap }, (_, i) => String(i + 1))]);
    await expect(runPanel.locator('[data-run-cores-hint="1"]')).toHaveText(
      `Auto: a small mesh runs on 1 core, a larger one on ${cap} cores.`,
    );

    const saved = page.waitForResponse((r) => r.url().includes('/api/run/update') && r.request().method() === 'POST');
    await cores.selectOption('2');
    expect((await saved).ok()).toBe(true);
    await expect(cores).toHaveValue('2');
    await expect(runPanel.locator('[data-run-cores-hint="1"]')).toHaveText('Runs on 2 cores, whatever the mesh size.');
    await expect.poll(() => record(rid)?.cores).toBe(2);

    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    runPanel = await openRun(page, rid);
    await expect(runPanel.getByLabel('Cores', { exact: true })).toHaveValue('2');

    // Back to Auto: saved as Auto (null), not as a number.
    const back = page.waitForResponse((r) => r.url().includes('/api/run/update') && r.request().method() === 'POST');
    await runPanel.getByLabel('Cores', { exact: true }).selectOption('auto');
    expect((await back).ok()).toBe(true);
    await expect.poll(() => record(rid)?.cores).toBeNull();
  });

  test('Copy from previous run carries the Cores choice', async ({ page, request }) => {
    test.setTimeout(180_000);
    const src = await makeRun(request, 'Cores source');
    const set = await request.post(`${host.base}/api/run/update`, { data: { project_id: PROJECT, simulation_id: SIM, run_id: src, cores: 2 } });
    expect(set.ok(), await set.text()).toBe(true);
    expect(record(src)?.cores).toBe(2);
    const dest = await makeRun(request, 'Cores copy');

    await openProject(page);
    let runPanel = await openRun(page, dest);
    await expect(runPanel.getByLabel('Cores', { exact: true })).toHaveValue('auto');
    await runPanel.getByRole('button', { name: 'Copy from previous run' }).click();
    await runPanel.locator('#run-copy-source').selectOption(src);
    await expect(runPanel.locator('[data-run-copy="1"]')).toContainText('Copied from Cores source.');
    await expect(runPanel.getByLabel('Cores', { exact: true })).toHaveValue('2');
    await expect.poll(() => record(dest)?.cores).toBe(2);

    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    runPanel = await openRun(page, dest);
    await expect(runPanel.getByLabel('Cores', { exact: true })).toHaveValue('2');
  });
});
