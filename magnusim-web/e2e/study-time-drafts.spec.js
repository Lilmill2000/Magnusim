import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { findRun } from '../scripts/project-layout.js';

// A study's Time dependency carries its draft runs (core host tools spec 4.16): the person
// switches the study to Transient in the Study panel and a draft run of it is Transient too
// (its Run panel shows the transient settings); a run that already ran keeps what it ran with.
// The study route saves the drafts now (the page did, one save per run), so the Assistant's
// study_edit set_time does the same. No WSL.
const PROJECT = 'sample-project-steady-state-e2e';
const SIM = 'sim_1';

test.describe('study time dependency and its draft runs', () => {
  /** @type {any} */
  let host;

  test.beforeAll(async () => {
    host = await startHost({ name: 'study-time-drafts', tmp: e2eTemp('study-time-drafts'), env: { MAGNUSIM_WSL_PRUNE: '0' } });
  });

  test.afterAll(() => {
    if (host) host.stop();
  });

  const record = (rid) => findRun(join(host.projects, PROJECT), rid, SIM);

  test('switching the study to Transient makes its draft run Transient; a run that ran keeps Steady-state', async ({ page, request }) => {
    test.setTimeout(180_000);
    const runs = await (await request.get(`${host.base}/api/run/status?project_id=${PROJECT}&simulation_id=${SIM}`)).json();
    const ran = (runs.runs || []).find((r) => r.status && r.status !== 'draft');
    const made = await request.post(`${host.base}/api/run/create`, { data: { project_id: PROJECT, simulation_id: SIM, name: 'Draft follows' } });
    const mj = await made.json();
    expect(made.ok(), JSON.stringify(mj)).toBe(true);
    const draft = String(mj.run.id);
    expect(record(draft).time_dependency).toBe('Steady-state');

    await page.goto(`${host.base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row .tl`).first().click();
    // The Study panel's own switch (the Create study dialog has one too, hidden here).
    const td = page.getByRole('complementary', { name: 'Setup details' }).getByLabel('Time dependency');
    await expect(td).toBeVisible({ timeout: 30_000 });
    const saved = page.waitForResponse((r) => r.url().includes('/api/simulation/update') && r.request().method() === 'POST');
    await td.selectOption('Transient');
    const answer = await (await saved).json();
    expect(answer.runs_followed).toContain(draft);
    await expect.poll(() => record(draft)?.time_dependency).toBe('Transient');
    if (ran) expect(record(String(ran.id))?.time_dependency || 'Steady-state').not.toBe('Transient');

    // The Run panel of the draft shows the transient settings.
    const folder = page.locator(`#left-tree [data-w17-sim-id="${SIM}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) await folder.locator(':scope > .tree-row .tw').click();
    await page.locator(`#left-tree [data-w27-run="${draft}"] > .tree-row .tl`).first().click();
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await expect(runPanel).toHaveAttribute('data-run-id', draft);
    await expect(runPanel).toContainText('Simulation time', { timeout: 30_000 });

    // Back to Steady-state: the draft follows again.
    await page.locator(`#left-tree [data-w17-sim-id="${SIM}"] > .tree-row .tl`).first().click();
    await page.getByRole('complementary', { name: 'Setup details' }).getByLabel('Time dependency').selectOption('Steady-state');
    await expect.poll(() => record(draft)?.time_dependency).toBe('Steady-state');
  });
});
