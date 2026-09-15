import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Opt-in: hits public URL. Default skip so CI / npm test stay local-only. */
const PUBLIC_E2E = (process.env.MAGNUSIM_PUBLIC_E2E || process.env.CFDDESK_PUBLIC_E2E) === '1';

const PUBLIC = process.env.MAGNUSIM_PUBLIC_URL || 'https://simulation.lilmill2000.com';
const LOCAL = process.env.MAGNUSIM_LOCAL_URL || 'http://127.0.0.1:8082';
const STUDY_WITH_MESH = 'sim-mu1sn0hz-7ce276';
const COPY_FROM_RUN = 'fee30c54'; // known done run with mesh
const EVIDENCE = path.join('runs', 'phase1-land9', 'ui-solve-evidence.json');

test.describe('Phase1 land9 UI Solve (public)', () => {
  test.skip(!PUBLIC_E2E, 'Set MAGNUSIM_PUBLIC_E2E=1 to run public URL Solve smoke');
  test('public Start click -> done with residuals', async ({ page, request }) => {
    expect((await request.get(LOCAL + '/')).status(), 'local :8082 must be HTTP 200').toBe(200);
    expect((await request.get(PUBLIC + '/')).status(), 'public URL must be HTTP 200').toBe(200);

    const projects = await (await request.get(PUBLIC + '/api/projects')).json();
    const sample = (projects.projects || []).find((p) =>
      String(p.id || '').startsWith('sample-project-steady-state'),
    );
    expect(sample, 'sample-project-steady-state*').toBeTruthy();
    const projectId = sample.id;

    await request.post(PUBLIC + '/api/simulation', {
      data: { project_id: projectId, activate: STUDY_WITH_MESH, simulation_id: STUDY_WITH_MESH },
    });

    await page.goto(`${PUBLIC}/#/p/${encodeURIComponent(projectId)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#simulations-tree')).toBeVisible({ timeout: 60_000 });

    const study = page.locator(`#simulations-tree [data-w17-sim-id="${STUDY_WITH_MESH}"]`).first();
    if (await study.count()) {
      await study.click();
      await page.waitForTimeout(500);
    }

    const simHub = page.locator('#simulations-tree [data-w27-sim-control="1"]').first();
    await expect(simHub).toBeVisible({ timeout: 30_000 });
    await simHub.click();
    await expect(page.locator('#panel-sim-hub')).toBeVisible({ timeout: 15_000 });

    const runName = `land9-ui-${Date.now().toString(36)}`;
    await page.locator('#sim-new-run-name').fill(runName);
    await page.locator('#btn-create-run').click();
    await expect(page.locator('#panel-sim-control')).toBeVisible({ timeout: 30_000 });

    const runId = await page.evaluate(() => {
      const s = window.__CFD_W27_STATE__ || {};
      return s.selected_run_id || s.active_run_id || (s.run && (s.run.id || s.run.run_id)) || null;
    });
    expect(runId, 'new run id').toBeTruthy();

    // Copy mesh/settings from a prior done run (UI path).
    const copyFrom = page.locator('#sim-copy-from');
    await expect(copyFrom).toBeVisible({ timeout: 15_000 });
    // createRunClient already starts pick mode; ensure picker visible
    if (await page.locator('#sim-copy-open').isVisible()) {
      await page.locator('#sim-copy-open').click();
    }
    await expect(page.locator('#sim-copy-picker')).toBeVisible({ timeout: 10_000 });
    await page.locator('#sim-copy-run').selectOption(COPY_FROM_RUN);
    await page.waitForTimeout(1000);

    // Confirm mesh landed on the draft run via status API
    await expect
      .poll(async () => {
        const st = await (
          await request.get(
            `${PUBLIC}/api/run/status?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}&simulation_id=${encodeURIComponent(STUDY_WITH_MESH)}`,
          )
        ).json();
        const run = (st.runs || []).find((r) => String(r.id) === String(runId)) || st.run;
        return (run && run.mesh_id) || '';
      }, { timeout: 30_000 })
      .not.toEqual('');

    await page.locator('#sim-end-time').fill('20');
    await page.locator('#sim-end-time').dispatchEvent('change');
    await page.locator('#sim-write-interval').fill('10');
    await page.locator('#sim-write-interval').dispatchEvent('change');
    await page.waitForTimeout(500);

    const startBtn = page.locator('#btn-sim-start');
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await expect(startBtn).toBeEnabled({ timeout: 60_000 });
    await startBtn.click();

    await expect
      .poll(
        async () => {
          const st = await (
            await request.get(
              `${PUBLIC}/api/run/status?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}&simulation_id=${encodeURIComponent(STUDY_WITH_MESH)}`,
            )
          ).json();
          const run = (st.runs || []).find((r) => String(r.id) === String(runId)) || st.run;
          return (run && run.status) || 'wait';
        },
        { timeout: 800_000, intervals: [2000, 3000, 5000] },
      )
      .toMatch(/done|failed|error|stopped/);

    const final = await (
      await request.get(
        `${PUBLIC}/api/run/status?project_id=${encodeURIComponent(projectId)}&run_id=${encodeURIComponent(runId)}&simulation_id=${encodeURIComponent(STUDY_WITH_MESH)}`,
      )
    ).json();
    const run = (final.runs || []).find((r) => String(r.id) === String(runId)) || final.run;
    expect(run).toBeTruthy();
    expect(run.status).toBe('done');
    expect(Number(run.exit_code || 0)).toBe(0);
    const residuals = run.residuals || [];
    const nSaved = run.n_saved_times || (run.saved_times || []).length || 0;
    expect(residuals.length).toBeGreaterThan(0);
    expect(nSaved).toBeGreaterThan(0);

    const evidence = {
      public: PUBLIC,
      local_8082: 200,
      project_id: projectId,
      simulation_id: STUDY_WITH_MESH,
      run_id: runId,
      run_name: runName,
      copied_from: COPY_FROM_RUN,
      mesh_id: run.mesh_id,
      status: run.status,
      exit_code: run.exit_code,
      iteration: run.iteration,
      residuals: residuals.length,
      n_saved_times: nSaved,
      solve_protocol: run.solve_protocol,
      prepare_run_ok: !!(run.prepare_run && run.prepare_run.ok),
      clicked: '#btn-sim-start',
      ui_copy: '#sim-copy-run',
    };
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    test.info().annotations.push({ type: 'land9-ui-solve', description: JSON.stringify(evidence) });
  });
});
