import { expect, test } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The run monitors the page draws come from Incompressible Flow: its monitor quantities
// (labels, units, which ones a plot offers, CSV columns), each row's default quantity,
// its flow balance line, and its monitor types (the Monitors dialog). No WSL: a finished
// run whose case is the committed cavity plus the surfaceFieldValue files a steady solve
// writes for an inlet (area average and flow), an outlet (flow only) and a custom monitor
// saved before monitor types: its result_control.json has no kind and no monitor_type,
// only category "Surface data", and a name of its own ("Outlet probe").
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const RC_ID = 'rc-outlet-probe-e2e';
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

/** Click, wait for the browser download, and return its name and text. */
async function download(page, click) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
}

/** postProcessing/<name>/0/surfaceFieldValue.dat as OpenFOAM writes it. */
function writeDat(caseDir, name, header, rows, area) {
  const dir = join(caseDir, 'postProcessing', name, '0');
  mkdirSync(dir, { recursive: true });
  const text =
    `# Region type : patch ${name}\n# Faces       : 40\n# Area        : ${area}\n# Time        \t${header}\n` +
    rows.map((r) => r + '\n').join('');
  writeFileSync(join(dir, 'surfaceFieldValue.dat'), text);
}

test('run monitors are drawn from the plugin: quantities, defaults, summary, exports and monitor types', async ({
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
    `e2e plugin monitors ${stamp()}`,
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

  const runRows = async () => (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const createRun = async (name) => {
    const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name } })).json();
    const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
    expect(rid, JSON.stringify(made)).toBeTruthy();
    return rid;
  };

  // Run A: finished, with the monitor files a steady solve writes (rho 1.2; p is kinematic).
  const runA = await createRun('Run A');
  const runDir = dirname((await runRows()).find((r) => String(r.id) === runA).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  delete sidecar.plugin;
  delete sidecar.study_id;
  writeFileSync(
    join(caseDir, 'w27-case.json'),
    JSON.stringify(
      {
        ...sidecar,
        app: 'simpleFoam',
        rho: 1.2,
        mapped: [
          { patch: 'inlet', name: 'Inlet', bc_type: 'Velocity inlet', faces: ['face 1@Body1'] },
          { patch: 'outlet', name: 'Outlet', bc_type: 'Pressure', faces: ['face 2@Body1'] },
        ],
        monitors: ['inlet', 'outlet'],
        custom_monitors: [{ id: RC_ID, key: 'rc_outlet_probe', name: 'Outlet probe', faces: ['face 3@Body1'] }],
      },
      null,
      2,
    ),
  );
  writeDat(caseDir, 'mon_inlet', 'areaAverage(p)\tareaAverage(U)', ['1\t0.5\t(2 0 0)', '2\t0.25\t(3 4 0)'], '1.000000e-02');
  writeDat(caseDir, 'flow_inlet', 'sum(phi)', ['1\t-0.002', '2\t-0.004'], '1.000000e-02');
  // The outlet wrote its flow only: it has no pressure to plot.
  writeDat(caseDir, 'flow_outlet', 'sum(phi)', ['1\t0.0021', '2\t0.0044'], '2.000000e-02');
  writeDat(caseDir, 'rc_outlet_probe', 'areaAverage(p)\tareaAverage(U)', ['1\t100\t(1 2 2)', '2\t113.25\t(1 2 2)'], '5.000000e-03');
  // The custom monitor as older versions saved it (a result control folder; kind is never kept).
  const rcDir = join(runDir, 'result_controls', 'RC_Outlet_probe');
  mkdirSync(rcDir, { recursive: true });
  writeFileSync(join(rcDir, 'id.json'), JSON.stringify({ id: RC_ID, name: 'Outlet probe', run_id: runA, kind: 'rc' }, null, 2));
  writeFileSync(
    join(rcDir, 'result_control.json'),
    JSON.stringify(
      { id: RC_ID, name: 'Outlet probe', category: 'Surface data', write_control: 'Time step', faces: ['face 3@Body1'] },
      null,
      2,
    ),
  );
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status: 'done',
        stage: 'done',
        has_results: true,
        n_saved_times: 5,
        iteration: 2,
        last_saved_iteration: 2,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
      },
      null,
      2,
    ),
  );
  // Run B: a draft that gets a monitor from the Monitors dialog.
  const runB = await createRun('Run B');
  await page.reload();
  await ready();

  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: runA }));
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  // The analysis's own answer reaches the page whole.
  expect(answer.analysis_key).toBe('incompressible_steady');
  expect(answer.quantities.map((x) => x.key)).toEqual(['p', 'Umag', 'Ux', 'Uy', 'Uz', 'Un', 'Q', 'mdot']);
  expect(answer.summary.map((x) => x.label)).toEqual(['Flow in', 'out', 'imbalance']);
  expect(answer.summary_warn).toBe(true);
  expect(answer.monitors.map((m) => [m.key, m.default_quantity])).toEqual([
    ['mon_inlet', 'Umag'],
    ['mon_outlet', 'p'],
  ]);
  expect(answer.custom.map((m) => [m.key, m.name, m.default_quantity])).toEqual([['rc_outlet_probe', 'Outlet probe', 'p']]);

  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  const openRun = async (rid) => {
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

  // ---- The Run panel lists each monitor's headline values with the cards' units ----
  await openRun(runA);
  const runList = page.locator('#panel-sim-control [data-run-monitors="1"] li');
  // The Run panel's list keeps its v0.2.0 form (h10-ui-parity): the final pressure
  // and volumetric flow of each monitor that has one.
  const finalLine = (row) => {
    const f = row.final || {};
    if (f.pressure_Pa == null && f.volumetric_flow_m3s == null) return null;
    return `${row.name || row.patch}`
      + (f.pressure_Pa != null ? ` · ${f.pressure_Pa.toFixed(1)} Pa` : '')
      + (f.volumetric_flow_m3s != null ? ` · ${f.volumetric_flow_m3s.toExponential(3)} m³/s` : '');
  };
  const wantLines = [...answer.monitors, ...answer.custom].map(finalLine).filter(Boolean);
  expect(wantLines.length).toBeGreaterThan(1);
  await expect(runList).toHaveText(wantLines, { timeout: 30_000 });

  // ---- Graphs ----
  const results = page.locator(`#left-tree [data-w27-run-results="${runA}"]`).first();
  const graphsRow = page.locator(`[data-w28-key="media:run:${runA}:graphs"] > .tree-row`).first();
  if (!(await graphsRow.isVisible())) await results.locator(':scope > .tree-row .tw').click();
  await graphsRow.click();
  const inlet = page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_inlet"]');
  const outlet = page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_outlet"]');
  const probe = page.locator('#run-graphs-custom-cards .mon-card[data-monitor-key="rc_outlet_probe"]');
  await expect(inlet).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#run-graphs-list .mon-card')).toHaveCount(2);
  await expect(probe.locator('.mon-card-name')).toHaveText('Outlet probe');

  // The plot offers the plugin's plotted quantities; each opens on its row's default.
  const plotted = ['Pressure', 'Mean velocity', 'Velocity X', 'Velocity Y', 'Velocity Z'];
  for (const card of [inlet, outlet, probe]) {
    await expect(card.locator('[data-mon-qty] option')).toHaveText(plotted);
  }
  await expect(inlet.locator('[data-mon-qty] option:checked')).toHaveText('Mean velocity');
  await expect(outlet.locator('[data-mon-qty] option:checked')).toHaveText('Pressure');
  await expect(probe.locator('[data-mon-qty] option:checked')).toHaveText('Pressure');
  await expect(inlet.locator('.mon-card-last')).toHaveText('5.00 m/s');
  await expect(probe.locator('.mon-card-last')).toHaveText('136 Pa');
  await expect(inlet.locator('svg.mon-svg')).toHaveCount(1);
  // The outlet has no pressure at any point: no plot (it used to draw a flat line at 0 Pa).
  await expect(outlet.locator('.mon-card-last')).toHaveCount(0);
  await expect(outlet.locator('svg.mon-svg')).toHaveCount(0);
  await expect(outlet.locator('[data-mon-act="expand"]')).toHaveCount(0);

  // The summary: the plugin's flow balance, warning above 1 %.
  const balance = page.locator('#run-graphs-balance');
  await expect(balance).toHaveText('Flow in 4.00 L/s · out 4.40 L/s · imbalance 10.00 %');
  await expect(balance).toHaveClass(/is-warn/);

  // Details: the plugin's detail quantities in its order, flows in L/s and g/s, with direction.
  const details = async (card) => {
    await card.locator('details.mon-more > summary').click();
    return card.locator('.mon-grid').evaluate((grid) => {
      const cells = [...grid.children].map((el) => el.textContent);
      const out = [];
      for (let i = 0; i < cells.length; i += 2) out.push([cells[i], cells[i + 1]]);
      return out;
    });
  };
  const inletRows = (await details(inlet)).filter(([k]) => k !== 'Area');
  expect(inletRows).toEqual([
    ['Face', 'face 1@Body1'],
    ['Pressure', '0.3 Pa'],
    ['Mean velocity', '5.00 m/s'],
    ['Velocity X', '3.00 m/s'],
    ['Velocity Y', '4.00 m/s'],
    ['Velocity Z', '0 m/s'],
    ['Normal velocity', '0.400 m/s in'],
    ['Flow rate', '4.00 L/s in'],
    ['Mass flow', '4.800 g/s'],
  ]);
  const outletRows = (await details(outlet)).filter(([k]) => k !== 'Area');
  expect(outletRows).toEqual([
    ['Face', 'face 2@Body1'],
    ['Normal velocity', '0.220 m/s out'],
    ['Flow rate', '4.40 L/s out'],
    ['Mass flow', '5.280 g/s'],
  ]);

  // One monitor's CSV: the plugin's columns, signed; the mass flow is the plugin's (rho 1.2).
  const one = await download(page, () => inlet.locator('[data-mon-act="csv"]').click());
  const oneRows = one.text.trim().split(/\r?\n/);
  expect(oneRows[0]).toBe('iteration,pressure_Pa,mean_velocity_m_s,Ux_m_s,Uy_m_s,Uz_m_s,Un_m_s,flow_m3_s,mass_kg_s');
  const last = oneRows[2].split(',').map(Number);
  [2, 0.3, 5, 3, 4, 0, -0.4, -0.004, -0.0048].forEach((v, i) => expect(last[i]).toBeCloseTo(v, 9));

  // Every monitor in one CSV: each monitor's number quantities, as shown (absolute).
  const all = await download(page, () => page.locator('#run-graphs-csv').click());
  expect(all.name).toMatch(/monitors\.csv$/);
  const allRows = all.text.trim().split(/\r?\n/);
  const cols = ['Pressure [Pa]', 'Mean velocity [m/s]', 'Normal velocity [m/s]', 'Flow rate [m³/s]', 'Mass flow [kg/s]'];
  expect(allRows[0]).toBe(
    ['iteration', ...['Inlet', 'Outlet', 'Outlet probe'].flatMap((n) => cols.map((c) => `${n} ${c}`))]
      .map((h) => `"${h}"`)
      .join(','),
  );
  const at2 = allRows[2].split(',');
  expect(at2[0]).toBe('2');
  [0.3, 5, 0.4, 0.004, 0.0048].forEach((v, i) => expect(Number(at2[1 + i])).toBeCloseTo(v, 9));
  expect(at2.slice(6, 8)).toEqual(['', '']);
  [0.22, 0.0044, 0.00528].forEach((v, i) => expect(Number(at2[8 + i])).toBeCloseTo(v, 9));

  // ---- The run's Monitors: the custom monitor saved before monitor types is highlighted ----
  await page.locator(`#left-tree [data-w27-run-rcs="${runA}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#panel-results-hub')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__CFD_W16_STATE__.selectedFaces))
    .toEqual(['face 3@Body1']);

  // ---- The Monitors dialog lists the plugin's monitor types; a new monitor records its type ----
  const registry = await json(request, '/api/registry');
  const areaAverage = (registry.monitor || []).find((m) => m.key === 'area_average');
  expect(areaAverage && areaAverage.user_creatable).toBe(true);
  await openRun(runB);
  await page.locator(`button.rc-plus[data-w27-run-plus="${runB}"]`).click();
  await expect(page.locator('#modal-result-control')).toBeVisible();
  await expect(page.locator('#rc-type-list .cs-group-label')).toHaveText(['SURFACE DATA']);
  const types = page.locator('#rc-type-list [data-rc-type]');
  await expect(types).toHaveCount(1);
  await expect(types).toHaveAttribute('data-rc-type', 'area_average');
  await expect(types).toHaveText('Area average');
  await expect(page.locator('#rc-detail-title')).toHaveText('Area average');
  await expect(page.locator('#rc-detail-hint')).toHaveText(`${areaAverage.description} Add it here, then pick faces in the viewport.`);
  await page.locator('#rc-apply').click();
  await expect(page.locator('#panel-area-average')).toBeVisible();
  await expect
    .poll(async () =>
      ((await runRows()).find((r) => String(r.id) === runB)?.result_controls || []).map((rc) => [rc.name, rc.monitor_type]),
    )
    .toEqual([['Area average 1', 'area_average']]);
});
