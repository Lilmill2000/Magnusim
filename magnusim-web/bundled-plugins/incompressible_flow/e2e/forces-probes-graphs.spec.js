import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Graphs panel draws a run's Forces monitor and Point probe (F4) from what
// OpenFOAM wrote: the committed real v2606 output (tests/fixtures/pitzdaily-monitors:
// force.dat, moment.dat, coefficient.dat, probes p and U, and the sidecar the writer
// wrote) copied into a finished run's case. The Forces card plots drag (N) and offers
// only force quantities, its note names the wall the mesh had no patch for; each probe
// point is a card; the point outside the mesh says so instead of plotting; the CSVs
// carry the forces' columns; the Run panel lists the headline values. No WSL.
// Fails on the code before F4: the run's monitors had no forces or probe rows.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PITZ = join(WEB, 'bundled-plugins', 'incompressible_flow', 'tests', 'fixtures', 'pitzdaily-monitors');
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

async function download(page, click) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
}

test("Graphs show a run's forces and point probe series from what OpenFOAM wrote", async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e forces probes graphs ${stamp()}`,
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
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run A' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  // A finished case (the cavity's frames) with the pitzDaily run's monitor files and sidecar.
  cpSync(CAVITY, caseDir, { recursive: true });
  cpSync(join(PITZ, 'postProcessing'), join(caseDir, 'postProcessing'), { recursive: true });
  const cavitySide = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  delete cavitySide.plugin;
  delete cavitySide.study_id;
  const pitzSide = JSON.parse(readFileSync(join(PITZ, 'w27-case.json'), 'utf8'));
  writeFileSync(join(caseDir, 'w27-case.json'), JSON.stringify({ ...cavitySide, ...pitzSide, app: 'simpleFoam' }, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  const base = { write_control: 'Time step', faces: [], results: null, series: null, chart_values: null, results_available: false };
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status: 'done',
        stage: 'done',
        has_results: true,
        n_saved_times: 5,
        iteration: 8,
        last_saved_iteration: 8,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
        result_controls: [
          { ...base, id: 'rc-f1', name: 'Forces 1', monitor_type: 'forces', kind: 'Forces', category: 'Boundary data', boundaries: ['bc-low', 'bc-up', 'bc-wing', '@walls'] },
          { ...base, id: 'rc-p1', name: 'Probe 1', monitor_type: 'probe', kind: 'Point probe', category: 'Point data', points: [[0.1, 0, 0], [5, 5, 5], [0.2, 0.01, 0]] },
        ],
      },
      null,
      2,
    ),
  );
  await page.reload();
  await ready();

  // ---- The answer: a forces row and one row per probe point ----
  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: rid }));
  expect(answer.ok, JSON.stringify(answer).slice(0, 500)).toBe(true);
  expect(answer.custom.map((m) => [m.key, m.type])).toEqual([
    ['forces_forces_1', 'forces'],
    ['probes_probe_1_1', 'probe'],
    ['probes_probe_1_2', 'probe'],
    ['probes_probe_1_3', 'probe'],
  ]);

  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) await studyRow.click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await runsFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const li = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  if (!(await li.evaluate((el) => el.classList.contains('expanded')))) await li.locator(':scope > .tree-row .tw').click();

  // ---- The Run panel: each one's headline values ----
  const runList = page.locator('#panel-sim-control [data-run-monitors="1"] li');
  await expect(runList.filter({ hasText: 'Forces 1' })).toHaveText(
    'Forces 1 · Drag force -0.014 N · Lift force 0.003 N · Drag coefficient -0.241 · Lift coefficient 0.057',
    { timeout: 30_000 },
  );
  await expect(runList.filter({ hasText: 'Probe 1 · point 1' })).toHaveText(
    'Probe 1 · point 1 · Pressure 357 Pa · Velocity magnitude 6.84 m/s',
  );
  await expect(runList.filter({ hasText: 'point 2' })).toHaveCount(0);

  // ---- Graphs ----
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"]`).first();
  const graphsRow = page.locator(`[data-w28-key="media:run:${rid}:graphs"] > .tree-row`).first();
  if (!(await graphsRow.isVisible())) await results.locator(':scope > .tree-row .tw').click();
  await graphsRow.click();
  const cards = page.locator('#run-graphs-custom-cards .mon-card');
  const forces = page.locator('#run-graphs-custom-cards .mon-card[data-monitor-key="forces_forces_1"]');
  await expect(forces).toBeVisible({ timeout: 30_000 });
  await expect(cards.locator('.mon-card-name')).toHaveText([
    'Forces 1',
    'Probe 1 · point 1',
    'Probe 1 · point 2',
    'Probe 1 · point 3',
  ]);
  // Forces: drag first, only force quantities, a line of 8 iterations.
  await expect(forces.locator('[data-mon-qty] option')).toHaveText([
    'Drag force',
    'Lift force',
    'Side force',
    'Pressure drag',
    'Viscous drag',
    'Force X',
    'Force Y',
    'Force Z',
    'Moment X',
    'Moment Y',
    'Moment Z',
    'Drag coefficient',
    'Lift coefficient',
    'Side force coefficient',
    'Pitching moment coefficient',
  ]);
  await expect(forces.locator('[data-mon-qty] option:checked')).toHaveText('Drag force');
  await expect(forces.locator('.mon-card-last')).toHaveText('-0.014 N');
  await expect(forces.locator('svg.mon-svg')).toHaveCount(1);
  await expect(forces.locator('[data-mon-note]')).toContainText("Re-mesh to give 'Wing' its own boundary");
  await forces.locator('[data-mon-qty]').selectOption({ label: 'Drag coefficient' });
  await expect(forces.locator('.mon-card-last')).toHaveText('-0.241');
  await forces.locator('details.mon-more > summary').click();
  const forceDetails = await forces.locator('.mon-grid').evaluate((grid) => [...grid.children].map((el) => el.textContent));
  expect(forceDetails.slice(0, 6)).toEqual(['Walls', 'lowerWall, upperWall', 'Drag direction', '(1, 0, 0)', 'Lift direction', '(0, 1, 0)']);
  expect(forceDetails).not.toContain('Pressure');

  // Probes: pressure in Pa; the point outside the mesh says so and draws nothing.
  const p1 = page.locator('#run-graphs-custom-cards .mon-card[data-monitor-key="probes_probe_1_1"]');
  const p2 = page.locator('#run-graphs-custom-cards .mon-card[data-monitor-key="probes_probe_1_2"]');
  await expect(p1.locator('[data-mon-qty] option')).toHaveText(['Pressure', 'Velocity X', 'Velocity Y', 'Velocity Z', 'Velocity magnitude']);
  await expect(p1.locator('.mon-card-last')).toHaveText('357 Pa');
  await expect(p1.locator('svg.mon-svg')).toHaveCount(1);
  await expect(p2.locator('svg.mon-svg')).toHaveCount(0);
  await expect(p2.locator('[data-mon-note]')).toHaveText('(5, 5, 5) m is outside the fluid: there are no values there.');

  // ---- CSV: the forces card's own columns; every monitor's, with the coefficients unitless ----
  const one = await download(page, () => forces.locator('[data-mon-act="csv"]').click());
  const rows = one.text.trim().split(/\r?\n/);
  expect(rows[0]).toBe(
    'iteration,drag_N,lift_N,side_N,pressure_drag_N,viscous_drag_N,Fx_N,Fy_N,Fz_N,Fpx_N,Fpy_N,Fpz_N,Fvx_N,Fvy_N,Fvz_N,Mx_Nm,My_Nm,Mz_Nm,Cd,Cl,Cs,Cm_pitch',
  );
  expect(rows).toHaveLength(9);
  const last = rows[8].split(',').map(Number);
  expect(last[0]).toBe(8);
  expect(last[1]).toBeCloseTo(-0.0144669208, 9);
  expect(last[18]).toBeCloseTo(-0.241115347, 9);
  const all = await download(page, () => page.locator('#run-graphs-csv').click());
  const head = all.text.trim().split(/\r?\n/)[0];
  expect(head).toContain('"Forces 1 Drag force [N]"');
  expect(head).toContain('"Forces 1 Drag coefficient"');
  expect(head).toContain('"Probe 1 · point 1 Pressure [Pa]"');
  expect(head).not.toContain('"Forces 1 Pressure [Pa]"');
});
