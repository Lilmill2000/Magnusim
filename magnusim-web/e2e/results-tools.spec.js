import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// Post-processing on a real solve, through the UI: cutting planes (add, second plane,
// axis, vectors, delete), coloring by pressure, the legend's typed range and reset,
// particle trace, animation, saved views, inspect point; then a second run that copies
// the first's settings and gets an area-average monitor on the outlet (picked in the
// viewport) that reports values, and a third run that is stopped while it solves.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const ROUND = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');

test('results tools on a solved run, monitors, copied run settings, and stopping a solve', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (m) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${m}`);
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) }).catch(() => {});

  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async () =>
      (await window.__CFD_W16_CREATE__({ title: 'e2e results tools', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const json = async (url) => {
    // A poll can reuse a keep-alive socket just as the server closes it (5 s idle): retry
    // the read, as a browser does.
    for (let i = 0; ; i++) {
      try {
        return await (await request.get(url)).json();
      } catch (e) {
        if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
      }
    }
  };
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });
  const meta = await json(q('/api/geometry/cad', { part: 'preview' }));
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const inlet = meta.faces.find((f) => near(f.centroid[1], 0) && near(f.normal[1], -1));
  const outlet = meta.faces.find((f) => near(f.centroid[1], 1500) && near(f.normal[1], 1));

  // Clicks the CAD face with this id where it shows in the viewport, like a user; if it
  // faces away, turns the view around first (as a user would orbit to it).
  const clickFace = async (faceId) => {
    const find = () => page.evaluate((want) => {
      const box = document.getElementById('viewer').getBoundingClientRect();
      const hits = [];
      for (let y = box.top + 4; y < box.bottom - 4; y += 6) {
        for (let x = box.left + 4; x < box.right - 4; x += 6) {
          // Only where the 3D view is on top (not under a panel), as a user sees it.
          const top = document.elementFromPoint(x, y);
          if (!top || top.tagName !== 'CANVAS' || !top.closest('#viewer')) continue;
          const p = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
          if (p && Number(p.faceId) === want) hits.push([x, y]);
        }
      }
      if (!hits.length) return null;
      const cx = hits.reduce((s, h) => s + h[0], 0) / hits.length;
      const cy = hits.reduce((s, h) => s + h[1], 0) / hits.length;
      hits.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
      return hits[0];
    }, faceId);
    let at = await find();
    for (const turn of [[180, 0], [90, 0], [180, 0], [0, 60], [0, -120]]) {
      if (at) break;
      await page.evaluate(([az, el]) => {
        const v = window.__CFD_VIEW__;
        const cam = v.renderer.getActiveCamera();
        if (az) cam.azimuth(az);
        if (el) cam.elevation(el);
        cam.orthogonalizeViewUp();
        v.renderer.resetCameraClippingRange();
        v.renderWindow.render();
      }, turn);
      await page.waitForTimeout(300);
      at = await find();
    }
    expect(at, `face ${faceId} is not visible in the viewport`).toBeTruthy();
    await page.mouse.click(at[0], at[1]);
  };

  // Study: velocity inlet 1 m/s, pressure outlet 0 Pa, Air, default mesh.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  const bcs = async () => (await json(q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  for (const [key, face, value, unit] of [['velocity_inlet', inlet.id, 1, 'm/s'], ['pressure_outlet', outlet.id, 0, 'Pa']]) {
    const n = (await bcs()).length;
    await page.locator('#btn-bcs-plus').click();
    await page.locator(`#panel-bc-picker .cfd-island [data-bc-key="${key}"]`).click();
    await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
    await expect.poll(async () => (await bcs()).length).toBe(n + 1);
    const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
    await clickFace(face);
    await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces, { timeout: 15_000 }).toEqual([`face ${face}@Body1`]);
    await page.evaluate(([bcId, v, u]) => window.__CFD_BC_UPDATE__(bcId, { value: v, unit: u }), [id, value, unit]);
  }
  await page.locator('#left-tree #btn-materials-plus').first().click();
  await page.locator('#panel-material-picker .cfd-island [data-volume="Body1"] button, #panel-air-material .cfd-island [data-volume="Body1"] button').first().click();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click();
  await page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]').click();
  const meshDone = async () => {
    const tree = await json(q('/api/project/tree'));
    const m = ((tree.geometries || []).flatMap((g) => g.studies || []).find((s) => s.id === sid)?.meshes || [])[0] || {};
    return m.live_status || (m.generated ? 'done' : 'none');
  };
  await expect.poll(async () => (/done|failed|stopped/.test(await meshDone()) ? 'end' : 'waiting'), { timeout: 1_200_000, intervals: [5_000] }).toBe('end');
  expect(await meshDone()).toBe('done');
  stage('mesh done');

  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const runs = async () => (await json(q('/api/run/status', { simulation_id: sid }))).runs || [];
  const openRun = async (rid) => {
    if ((await runPanel.getAttribute('data-run-id').catch(() => null)) === rid && (await runPanel.isVisible())) return;
    // Unfold the Simulation folder if the run's row is folded away.
    const row = page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first();
    if (!(await row.isVisible())) {
      const folder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
      if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
        await folder.locator(':scope > .tree-row .tw').click();
      }
    }
    await row.click();
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
  };
  const setIterations = async (n) => {
    const it = runPanel.getByLabel('Iterations', { exact: true });
    await it.fill(String(n));
    await it.press('Enter');
  };
  // Waits for the wanted status; a run that ends otherwise fails at once, not at the timeout.
  const runTo = async (rid, want, timeout = 1_800_000) => {
    await expect
      .poll(async () => {
        const st = (await runs()).find((r) => r.id === rid)?.status || 'none';
        return want.test(st) || /done|failed|stopped/.test(st) ? st : 'waiting';
      }, { timeout, intervals: [5_000] })
      .not.toBe('waiting');
    expect((await runs()).find((r) => r.id === rid)?.status).toMatch(want);
  };
  const run1 = (await runs())[0].id;
  await openRun(run1);
  await setIterations(40);
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runPanel.locator('[data-run-start]').click();
  await runTo(run1, /^done$/);
  stage('run 1 done');

  // Results.
  await page.locator(`#left-tree [data-w27-run="${run1}"] > .tree-row .tl`).first().click();
  await page.locator(`#left-tree [data-w27-run-results="${run1}"] > .tree-row .tl`).first().click();
  await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 180_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 180_000 });
  const cut = () =>
    page.evaluate(() => {
      const c = window.__CFD_W7_CUT__ || {};
      return { planes: Array.isArray(c.planes) ? c.planes.length : Number(c.planes || 0), n: window.__CFD_W7__?.cut_mapper_dump?.nPoints || 0 };
    });
  const savedView = async () => (await runs()).find((r) => r.id === run1)?.current_view || {};

  // Cutting planes.
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await expect.poll(async () => (await cut()).planes).toBe(1);
  await expect.poll(async () => (await cut()).n, { timeout: 60_000 }).toBeGreaterThan(0);
  await page.locator('#btn-add-result-plane').click();
  await expect(page.locator('#result-plane-list li.mesh-plane-card')).toHaveCount(2);
  const second = await page.locator('#result-plane-list li.mesh-plane-card').nth(1).getAttribute('data-result-plane');
  await page.locator(`button[data-rplane-axis="${second}"][data-axis="X"]`).click();
  await expect.poll(async () => ((await savedView()).planes || [])[1]?.axis, { timeout: 30_000 }).toBe('X');
  const first = await page.locator('#result-plane-list li.mesh-plane-card').first().getAttribute('data-result-plane');
  await page.evaluate((id) => document.querySelector(`input[data-rplane-vec="${id}"]`).click(), first);
  await expect.poll(() => page.evaluate(() => window.__CFD_W7__?.vectors_live === true), { timeout: 60_000 }).toBe(true);
  await page.locator(`[data-del-rplane="${second}"]`).click();
  await page.locator('#cf-confirm').click();
  await expect(page.locator('#result-plane-list li.mesh-plane-card')).toHaveCount(1);
  stage('cutting planes');

  // Pressure coloring, then a typed legend maximum and back to auto.
  await page.locator('#cp-coloring').selectOption('p');
  await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.field), { timeout: 60_000 }).toBe('p');
  await expect(page.locator('#legend .legend-title')).toContainText('Pressure');
  await page.locator('#legend .legend-bar-val-hi').click();
  const max = page.locator('#legend input[aria-label="Scale maximum"]');
  await max.fill('0.5');
  await max.press('Enter');
  await expect(page.locator('#legend')).toHaveClass(/is-custom/);
  await page.locator('#legend .legend-auto').click();
  await expect(page.locator('#legend')).not.toHaveClass(/is-custom/);
  await page.locator('#cp-coloring').selectOption('magU');
  stage('coloring and legend');

  // Particle trace from the inlet.
  await page.locator('.tb-btn[data-label="Particle Trace"]').click();
  await expect(page.locator('#pt-faces-hint')).toContainText(/\d+ seeds · \d+ traces/, { timeout: 180_000 });
  expect(await page.evaluate(() => window.__CFD_W8__?.n_seeds || 0)).toBeGreaterThan(0);
  stage('particle trace');

  // Animation (a steady run animates the trace) plays and pauses.
  await page.locator('.tb-btn[data-label="Animation"]').click();
  await expect(page.locator('#anim-block')).toBeVisible();
  await page.locator('#anim-play').click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W12__?.anim_state?.playing), { timeout: 30_000 }).toBe(true);
  await page.locator('#anim-pause').click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W12__?.anim_state?.playing)).toBe(false);
  stage('animation');

  // Saved views: save, select, delete; the filters autosave to the run.
  await expect.poll(async () => ((await savedView()).planes || []).length, { timeout: 30_000 }).toBe(1);
  const viewsState = await page.evaluate(() => ({
    results: window.__CFD_RESULTS_VIEW__,
    mode: window.__CFD_FILTERS_MODE__,
    blockHidden: document.getElementById('views-block')?.hidden,
    panelHidden: document.getElementById('filters-panel')?.hidden,
    collapsed: document.getElementById('views-block')?.classList.contains('is-collapsed'),
  }));
  // The Views block starts folded: open it from its header, as a user does.
  if (viewsState.collapsed) await page.locator('#views-block .fp-collapse-toggle').click();
  await expect(page.locator('#views-save'), JSON.stringify(viewsState)).toBeVisible();
  await page.locator('#views-save').click();
  await page.locator('#pm-input').fill('Plane and trace');
  await page.locator('#pm-confirm').click();
  const views = async () => (await runs()).find((r) => r.id === run1)?.views || [];
  await expect.poll(async () => (await views()).map((v) => v.name)).toEqual(['Plane and trace']);
  const vid = (await views())[0].id;
  await page.locator('#views-select').selectOption(vid);
  await expect(page.locator('#views-delete')).toBeVisible();
  await page.locator('#views-delete').click();
  await page.locator('#cf-confirm').click();
  await expect.poll(async () => (await views()).length).toBe(0);
  stage('saved views');

  // Inspect point in the middle of the plate.
  await page.locator('#btn-inspect-point').click();
  const box = await page.locator('#viewer').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect
    .poll(() => page.evaluate(() => (window.__CFD_W13__?.points || []).some((p) => p.hit && p.magU != null)), { timeout: 60_000 })
    .toBe(true);
  await shot('results-tools');
  await page.locator('#btn-inspect-point').click();
  stage('inspect point');

  // Run 2 copies run 1's settings and gets an outlet monitor, picked in the viewport.
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w27-sim-control="1"] > .tree-row .tl`).first().click();
  await page.locator('#sim-new-run-name').fill('Run 2');
  await page.locator('#btn-create-run').click();
  await expect.poll(async () => (await runs()).map((r) => r.name)).toContain('Run 2');
  const run2 = (await runs()).find((r) => r.name === 'Run 2').id;
  await openRun(run2);
  await runPanel.getByRole('button', { name: 'Copy from previous run' }).click();
  await page.locator('#run-copy-source').selectOption(run1);
  await expect(runPanel).toContainText('Copied from');
  await expect.poll(async () => (await runs()).find((r) => r.id === run2)?.endTime).toBe((await runs()).find((r) => r.id === run1)?.endTime);
  // The Monitors row (with its +) is inside the run's row: unfold it if it is folded.
  const run2Li = page.locator(`#left-tree li[data-w27-run="${run2}"]`).first();
  if (!(await run2Li.evaluate((el) => el.classList.contains('expanded')))) {
    await run2Li.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`button.rc-plus[data-w27-run-plus="${run2}"]`).click();
  await page.locator('#rc-apply').click();
  await expect(page.locator('#panel-area-average')).toBeVisible();
  await clickFace(outlet.id);
  await expect
    .poll(async () => ((await runs()).find((r) => r.id === run2)?.result_controls || []).map((rc) => rc.faces))
    .toEqual([[`face ${outlet.id}@Body1`]]);
  await openRun(run2);
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runPanel.locator('[data-run-start]').click();
  await runTo(run2, /^done$/);
  const mon = await json(q('/api/run/monitors', { run_id: run2 }));
  const custom = (mon.custom || [])[0] || {};
  stage(`monitor ${custom.name}: ${(custom.series || []).length} points, final ${JSON.stringify(custom.final)}`);
  expect((custom.series || []).length).toBeGreaterThan(0);
  expect(JSON.stringify(custom.faces || [])).toContain(`face ${outlet.id}@Body1`);

  // Run 3 runs long and is stopped from its panel.
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w27-sim-control="1"] > .tree-row .tl`).first().click();
  await page.locator('#sim-new-run-name').fill('Run 3');
  await page.locator('#btn-create-run').click();
  await expect.poll(async () => (await runs()).map((r) => r.name)).toContain('Run 3');
  const run3 = (await runs()).find((r) => r.name === 'Run 3').id;
  await openRun(run3);
  await setIterations(5000);
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runPanel.locator('[data-run-start]').click();
  await runTo(run3, /^running$/, 300_000);
  await runPanel.locator('[data-run-stop="1"]').click();
  await runTo(run3, /^stopped$/, 300_000);
  stage('run 3 stopped');
});
