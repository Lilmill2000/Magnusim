import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from '../../../e2e/toolchain.js';
import { waitSlotFree } from '../../../e2e/support/compute-slot.js';
import { PYTHON } from '../../../scripts/python-env.js';

// Post-processing on a real solve, through the UI: cutting planes (add, second plane,
// axis, vectors, delete), coloring by pressure, the legend's typed range and reset,
// particle trace, animation, saved views, inspect point; then a second run that copies
// the first's settings and gets an area-average monitor on the outlet (picked in the
// viewport) that reports values, and a third run that is stopped while it solves.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const ROUND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'python');

// Surface pressure range in Pa from a fresh read of the case, the way a spawned exporter
// does it (no worker cache): extract_surface of the volume, point p x rho.
function pressureTruth(caseDir, time) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'import numpy as np',
    'from pathlib import Path',
    'from case_volume import load_volume',
    'from case_units import case_density',
    'case = Path(sys.argv[1])',
    'mesh, _ = load_volume(case, sys.argv[2])',
    'surf = mesh.extract_surface()',
    'if "p" in surf.cell_data and "p" not in surf.point_data:',
    '    surf = surf.cell_data_to_point_data(pass_cell_data=True)',
    'rho = case_density(case)',
    'p = np.asarray(surf.point_data["p"], dtype=float) * rho',
    'print(json.dumps({"min": float(p.min()), "max": float(p.max()), "rho": rho}))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, caseDir, time], { cwd: PY_DIR, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`pressure truth failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

// A point certainly inside the fluid: the centre of the volume's middle cell.
function interiorPoint(caseDir, time) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'from pathlib import Path',
    'from case_volume import load_volume',
    'mesh, _ = load_volume(Path(sys.argv[1]), sys.argv[2])',
    'c = mesh.cell_centers().points[mesh.n_cells // 2]',
    'print(json.dumps([float(v) for v in c]))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, caseDir, time], { cwd: PY_DIR, encoding: 'utf8', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`interior point failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

// magU and p (Pa) at a case point from a fresh read of the volume (no worker cache).
function probeTruth(caseDir, time, [x, y, z]) {
  const code = [
    'import json, sys',
    'sys.path.insert(0, "tools")',
    'import numpy as np, pyvista as pv',
    'from pathlib import Path',
    'from case_volume import load_volume',
    'from case_units import case_density',
    'case = Path(sys.argv[1])',
    'mesh, _ = load_volume(case, sys.argv[2])',
    'if "p" not in mesh.point_data or "U" not in mesh.point_data:',
    '    mesh = mesh.cell_data_to_point_data(pass_cell_data=True)',
    'mesh.point_data["magU"] = np.linalg.norm(np.asarray(mesh.point_data["U"])[:, :3], axis=1)',
    'pt = [float(v) for v in sys.argv[3:6]]',
    's = pv.PolyData(np.asarray([pt])).sample(mesh)',
    'hit = bool(int(np.asarray(s.point_data["vtkValidPointMask"])[0]))',
    'mag = float(np.asarray(s.point_data["magU"])[0])',
    'p = float(np.asarray(s.point_data["p"])[0]) * case_density(case)',
    'print(json.dumps({"hit": hit, "magU": mag, "p": p}))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, caseDir, time, String(x), String(y), String(z)], {
    cwd: PY_DIR,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`probe truth failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

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
  // The pressure the viewport shows is Pa exactly once: its range matches a fresh,
  // independent read of the case (kinematic p x rho). The worker path used to show
  // p x rho^2 (20% high for Air) and compound on every export.
  await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.fingerprint?.umax ?? null), { timeout: 60_000 }).not.toBeNull();
  const shown = await page.evaluate(() => ({
    case_dir: window.__CFD_W6__.case_dir,
    time: String(window.__CFD_W6__.time),
    lo: window.__CFD_W6__.fingerprint.umin,
    hi: window.__CFD_W6__.fingerprint.umax,
  }));
  const truth = pressureTruth(shown.case_dir, shown.time);
  stage(`pressure shown ${shown.lo}..${shown.hi} Pa; independent ${truth.min}..${truth.max} Pa (rho ${truth.rho})`);
  expect(truth.rho, 'Air density in w27-case.json').toBeGreaterThan(1.1);
  const span = Math.max(Math.abs(truth.max), Math.abs(truth.min), 1e-9);
  expect(Math.abs(shown.hi - truth.max) / span).toBeLessThan(0.005);
  expect(Math.abs(shown.lo - truth.min) / span).toBeLessThan(0.005);
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
    .poll(() => page.evaluate(() => (window.__CFD_W13__?.points || []).some((p) => p.hit && p.values?.magU != null)), { timeout: 60_000 })
    .toBe(true);
  await shot('results-tools');
  // The values shown match a fresh, independent probe of the case at that point.
  const picked = await page.evaluate(() => {
    const w = window.__CFD_W13__;
    const pt = (w.points || []).filter((q) => q.hit).pop();
    return { casePos: pt.casePos, magU: pt.values.magU, p: pt.values.p ?? null, time: String(w.time), case_dir: window.__CFD_W6__.case_dir };
  });
  const truthAt = probeTruth(picked.case_dir, picked.time, picked.casePos);
  stage(`inspect shows magU ${picked.magU} p ${picked.p}; independent magU ${truthAt.magU} p ${truthAt.p}`);
  expect(truthAt.hit).toBe(true);
  const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-6);
  expect(close(picked.magU, truthAt.magU, 0.02), 'shown magU vs probe').toBe(true);
  if (picked.p != null) expect(close(picked.p, truthAt.p, 0.02), 'shown p vs probe').toBe(true);
  // The server probe (used when the clicked surface lacks a value) runs on the worker's
  // cached volume, not a new Python process, and gives the same values exactly.
  const probeAt = interiorPoint(picked.case_dir, picked.time);
  const apiT0 = Date.now();
  const api = await page.evaluate(async ([c, t, x, y, z]) => {
    const q = new URLSearchParams({ case: c, time: t, x: String(x), y: String(y), z: String(z) });
    return (await fetch(`/api/inspect?${q}`, { cache: 'no-store' })).json();
  }, [picked.case_dir, picked.time, ...probeAt]);
  const apiMs = Date.now() - apiT0;
  const truthApi = probeTruth(picked.case_dir, picked.time, probeAt);
  stage(`inspect API ${apiMs} ms via ${api.volume_from}: magU ${api.values.magU} p ${api.values.p}`);
  expect(api.hit).toBe(true);
  expect(api.volume_from).toBe('worker-cache');
  expect(close(api.values.magU, truthApi.magU, 1e-6)).toBe(true);
  expect(close(api.values.p, truthApi.p, 1e-6)).toBe(true);
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
  await waitSlotFree(request);
  stage('run 3 stopped');
});
