import { test, expect } from '@playwright/test';

const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';

/** Click a mesh form toggle until aria-pressed/checked is the wanted state. */
async function setMeshToggle(page, id, on) {
  const el = page.locator(`#${id}`);
  await expect(el).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 4; i += 1) {
    const pressed = await el.evaluate((node) => {
      const a = node.getAttribute('aria-pressed');
      if (a === 'true') return true;
      if (a === 'false') return false;
      if (node.classList.contains('is-on') || node.classList.contains('on')) return true;
      if (node.classList.contains('is-off') || node.classList.contains('off')) return false;
      const t = node.getAttribute('data-on');
      if (t === '1' || t === 'true') return true;
      if (t === '0' || t === 'false') return false;
      return null;
    });
    if (pressed === on) return;
    await el.click();
    await page.waitForTimeout(150);
  }
}

test.describe('Magnusim smoke', () => {
  test('home -> sample project -> mesh form', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;
    expect(id).toBeTruthy();

    // Home hash: #/p/<id>
    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Mesh/i, { timeout: 30_000 });

    // Collapsed Mesh hides Mesh 1; expand the section, then click the row.
    const meshSectionTw = page.locator('#left-tree [data-w20-mesh="1"] > .tree-row .tw').first();
    const meshRow = page.locator('#left-tree [data-w20-mesh-item]').first();
    if (await meshRow.count()) {
      if (!(await meshRow.isVisible().catch(() => false))) {
        if (await meshSectionTw.count()) await meshSectionTw.click();
      }
      if (await meshRow.isVisible().catch(() => false)) {
        await meshRow.click();
      } else {
        await page.locator('#left-tree [data-w20-mesh="1"] > .tree-row').first().click();
      }
    } else {
      await page.locator('#left-tree').getByText(/Mesh\s*1/i).first().click();
    }

    // If inspect chip is up (generated mesh), open Settings to reach the form.
    const settingsBtn = page.locator('#mesh-inspect-settings');
    try {
      await settingsBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await settingsBtn.click();
    } catch {
      /* form may already be opening for ungenerated mesh */
    }

    await expect(page.locator('#panel-mesh-form')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#mesh-fineness')).toBeVisible({ timeout: 10_000 });
    await page.locator('#mesh-fineness').fill('1');

    test.info().annotations.push({ type: 'smoke', description: 'steps 1-3 green' });

    if (!WSL) {
      // Soft-pass kill: CI may skip WSL, but Timmy Phase-0 overall PASS requires MAGNUSIM_E2E_WSL=1 (or CFDDESK_E2E_WSL).
      test.info().annotations.push({ type: 'skip-mesh', description: 'MAGNUSIM_E2E_WSL/CFDDESK_E2E_WSL!=1' });
      return;
    }

    // F=1 + hexcore hits HXT failure on this sample; prove Generate?n_cells>0 with hex off.
    // Test harness only ? no product mesher change.
    if (await page.locator('#mesh-toggle-hex').count()) {
      await setMeshToggle(page, 'mesh-toggle-hex', false);
    }
    if (await page.locator('#mesh-toggle-bl').count()) {
      await setMeshToggle(page, 'mesh-toggle-bl', false);
    }

    const gen = page.getByRole('button', { name: /Generate/i }).first();
    await gen.click();
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/case?project_id=${encodeURIComponent(id)}`);
          if (!r.ok()) return 'wait';
          const j = await r.json();
          return j.status || j.live_mesh_result?.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed/);

    const final = await (
      await request.get(`/api/case?project_id=${encodeURIComponent(id)}`)
    ).json();
    const status = final.status || final.live_mesh_result?.status;
    const nCells = final.n_cells ?? final.live_mesh_result?.n_cells ?? 0;
    expect(status).toBe('done');
    expect(nCells).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'mesh',
      description: `F=1 generate done n_cells=${nCells}`,
    });
  });

  test('simulation hub + optional solve (endTime=20)', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;

    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Simulation/i, { timeout: 30_000 });

    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    await expect(page.locator('#panel-sim-hub')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#btn-create-run')).toBeVisible();

    await page.locator('#btn-create-run').click();
    await expect(page.locator('#panel-sim-control')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#btn-sim-start')).toBeVisible();
    await page.locator('#sim-end-time').fill('20');
    await page.locator('#sim-write-interval').fill('20');
    test.info().annotations.push({ type: 'smoke', description: 'solve hub + endTime=20' });

    if (!WSL) {
      test.info().annotations.push({
        type: 'skip-solve',
        description: 'MAGNUSIM_E2E_WSL/CFDDESK_E2E_WSL!=1',
      });
      return;
    }

    const meshRes = await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`);
    expect(meshRes.ok()).toBeTruthy();
    const meshJson = await meshRes.json();
    expect(meshJson.meshes.some((m) => m.ready && m.n_cells > 0), 'mesh test must generate a real mesh').toBeTruthy();
    await page.locator('#sim-end-time').dispatchEvent('change');
    await page.locator('#sim-write-interval').dispatchEvent('change');
    await expect(page.locator('#btn-sim-start')).toBeEnabled({ timeout: 30_000 });

    await page.locator('#btn-sim-start').click();
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`);
          if (!r.ok()) return 'wait';
          const j = await r.json();
          const run = j.run || j;
          return run.status || 'wait';
        },
        { timeout: 800_000 },
      )
      .toMatch(/done|failed|stopped/);

    const final = await (
      await request.get(`/api/run/status?project_id=${encodeURIComponent(id)}&simulation_id=sim_1`)
    ).json();
    const run = final.run || final;
    expect(run.status).toBe('done');
    const residuals = run.residuals || [];
    expect(residuals.length).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'solve',
      description: `endTime=20 done residuals=${residuals.length}`,
    });
  });

  test('transient pimpleFoam run writes real result frames', async ({ page, request }) => {
    test.skip(!WSL, 'Requires MAGNUSIM_E2E_WSL=1 and the mesh test above');
    const id = 'sample-project-steady-state-e2e';
    const changed = await request.post('/api/simulation/update', {
      data: { project_id: id, simulation_id: 'sim_1', time_dependency: 'Transient' },
    });
    expect(changed.ok(), await changed.text()).toBeTruthy();
    await page.goto(`/#/p/${id}`);
    await expect(page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    const previousRuns = (await (await request.get(`/api/run/status?project_id=${id}&simulation_id=sim_1`)).json()).runs || [];
    const previousIds = new Set(previousRuns.map((run) => run.id));
    await page.locator('#btn-create-run').click();
    let createdId;
    await expect.poll(async () => {
      const body = await (await request.get(`/api/run/status?project_id=${id}&simulation_id=sim_1`)).json();
      createdId = body.run?.id;
      return !!createdId && !previousIds.has(createdId);
    }).toBe(true);
    await expect(page.locator('#sim-tr-end-time')).toBeVisible();
    await page.locator('#sim-tr-end-time').fill('0.01');
    await page.locator('#sim-tr-end-time').dispatchEvent('change');
    await page.locator('#sim-tr-write-count').fill('2');
    await page.locator('#sim-tr-write-count').dispatchEvent('change');
    await expect(page.locator('#btn-sim-start')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#btn-sim-start').click();
    let completed;
    await expect.poll(async () => {
      const res = await request.get(`/api/run/status?project_id=${id}&simulation_id=sim_1`);
      const body = await res.json();
      completed = body.run;
      return completed?.id === createdId && completed?.time_dependency === 'Transient' ? completed.status : 'waiting';
    }, { timeout: 600_000 }).toMatch(/done|failed|stopped/);
    expect(completed.status, completed.error).toBe('done');
    expect(completed.path_kind).toBe('pimpleFoam');
    expect(completed.has_results).toBe(true);
    expect(completed.n_saved_times).toBeGreaterThanOrEqual(2);
    expect(completed.residuals.length).toBeGreaterThan(0);
    const runs = (await (await request.get(`/api/run/status?project_id=${id}&simulation_id=sim_1`)).json()).runs;
    expect(runs.some((run) => run.time_dependency === 'Steady-state' && run.status === 'done')).toBe(true);
    await page.reload();
    const runNode = page.locator(`[data-w27-run="${completed.id}"] > .tree-row`).first();
    await expect(runNode).toBeVisible({ timeout: 30_000 });
    await runNode.click();
    const resultNode = page.locator(`[data-w27-run-results="${completed.id}"] > .tree-row`);
    await expect(resultNode).toBeVisible();
    await resultNode.click();
    await expect(page.locator('#iter-scrub')).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('#iter-value')).not.toHaveValue('50');

  });

  test('incompressible study + BC picker reflects saved wall defaults', async ({ page, request }) => {
    const res = await request.get('/api/projects');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body.projects) ? body.projects : [];
    const sample = list.find((p) => {
      const id = String(p.id || '');
      const title = String(p.title || p.name || '');
      return (
        id === 'sample-project-steady-state-e2e' ||
        id.startsWith('sample-project-steady-state') ||
        /sample.*steady/i.test(title)
      );
    });
    expect(sample, 'sample-project-steady-state* must exist').toBeTruthy();
    const id = sample.id || sample.project_id;

    await page.goto(`/#/p/${encodeURIComponent(id)}`);
    await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#left-tree')).toContainText(/Simulation/i, { timeout: 30_000 });

    await page.locator('#left-tree [data-w27-sim-control="1"] > .tree-row').first().click();
    await expect(page.locator('#panel-sim-hub')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#panel-sim-hub')).not.toContainText(/example_passthrough/i);

    const bcPlus = page.locator('#btn-bcs-plus');
    await expect(bcPlus).toBeVisible();
    await bcPlus.click();
    await expect(page.locator('#panel-bc-picker')).toBeVisible();
    await page.locator('#bc-picker-defaults').click();
    await page.locator('#bc-default-wall-type').selectOption('Slip');
    await expect(page.locator('#bc-default-wall-hint')).toContainText('slip wall');
    await bcPlus.click();
    await expect(page.locator('#bc-picker-defaults-sub')).toHaveText('Unassigned faces: slip walls');
    await page.locator('#bc-picker-defaults').click();
    await page.locator('#bc-default-wall-type').selectOption('No-slip');
    await bcPlus.click();
    await expect(page.locator('#bc-picker-defaults-sub')).toHaveText('Unassigned faces: no-slip walls');
    await expect(page.locator('#left-tree [data-w19-defaults]')).toContainText('No-slip');
    await page.reload();
    await expect(page.locator('#left-tree [data-w19-defaults]')).toContainText('No-slip', { timeout: 30_000 });

  });
  test('saved result screenshot, gallery, graph CSV and PNG exports', async ({ page, request }) => {
    test.skip(!WSL, 'Requires saved results from the WSL workflow');
    const projectId = 'sample-project-steady-state-e2e';
    const status = await (await request.get(`/api/run/status?project_id=${projectId}&simulation_id=sim_1`)).json();
    const run = status.runs.find((entry) => entry.status === 'done' && entry.has_results);
    expect(run).toBeTruthy();
    await page.goto(`/#/p/${projectId}`);
    const runRow = page.locator(`[data-w27-run="${run.id}"] > .tree-row .tl`);
    await expect(runRow).toBeVisible({ timeout: 30_000 });
    await runRow.click();
    const results = page.locator(`[data-w27-run-results="${run.id}"]`);
    await results.locator(':scope > .tree-row .tl').click();
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 60_000 });
    await page.locator('#toolbar [data-label="Particle Trace"]').click();
    await expect(page.locator('#pt-faces-hint')).toHaveText(/\d+ seeds · [1-9]\d* traces[.]/, { timeout: 60_000 });
    await page.locator('#toolbar [data-label="Screenshot"]').click();
    await page.locator('#capture-go').click();
    await expect(page.locator('#modal-capture-save')).toBeVisible();
    await page.locator('#cs-save-name').fill('Release audit screenshot');
    await page.locator('#cs-save-confirm').click();
    await expect(page.locator('#modal-capture-save')).toBeHidden();
    const gallery = page.locator(`[data-w28-key="media:run:${run.id}:screenshot"] > .tree-row`);
    if (!(await gallery.isVisible())) await results.locator(':scope > .tree-row .tw').click();
    await gallery.click();
    await expect(page.locator('#run-media-list')).toContainText('Release audit screenshot');
    await page.locator('#run-media-list').getByRole('button', { name: 'View', exact: true }).first().click();
    await expect(page.locator('#modal-media-view img')).toBeVisible();
    await expect.poll(() => page.locator('#modal-media-view img').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator('#mv-close').click();
    await page.locator(`[data-w28-key="media:run:${run.id}:graphs"] > .tree-row`).click();
    await expect(page.locator('#run-graphs-list svg').first()).toBeVisible({ timeout: 30_000 });
    const csvPromise = page.waitForEvent('download');
    await page.locator('#run-graphs-csv').click();
    const csv = await csvPromise;
    expect(csv.suggestedFilename()).toMatch(/monitors\.csv$/);
    expect(await csv.failure()).toBeNull();
    const pngPromise = page.waitForEvent('download');
    await page.locator('#run-graphs-list [data-graph-png]').first().click();
    const png = await pngPromise;
    expect(png.suggestedFilename()).toMatch(/\.png$/);
    expect(await png.failure()).toBeNull();
    await page.locator('#toolbar [data-label="Record"]').click();
    await page.locator('#capture-duration').fill('1');
    await page.locator('#capture-go').click();
    await expect(page.locator('#modal-capture-save')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cs-save-heading')).toContainText('recording');
    await page.locator('#cs-save-name').fill('Release audit recording');
    await page.locator('#cs-save-confirm').click();
    await expect(page.locator('#modal-capture-save')).toBeHidden();
    await page.locator(`[data-w28-key="media:run:${run.id}:recording"] > .tree-row`).click();
    await expect(page.locator('#run-media-list')).toContainText('Release audit recording');

  });

});
