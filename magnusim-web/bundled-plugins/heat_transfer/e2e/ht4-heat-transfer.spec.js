// Heat Transfer (HT4): buoyant flow of one fluid, as a user sets it up and reads it.
// - A study from the Create modal: the study panel says which solver runs, shows the
//   physics in the project's temperature unit (°C metric, °F imperial) and saves K;
//   a fluid material from the Materials "+"; a wall's Thermal fields; all after a reload.
// - A finished run (a committed case: tests/test_ht_wsl_proofs.py's cavity, coarse):
//   the results legend shows Temperature in °C (°F imperial), the Run panel lists the
//   monitors and the energy balance.
// - New BCs in a Heat Transfer study: an untouched inlet shows (and solves at) 20 °C
//   whatever the reference temperature; a new Wall starts No-slip.
// - A run whose solver died of a cause its parser names: the Run panel's failure line
//   shows the reason (long errors end with an ellipsis).
// - With WSL: a heated cavity meshed and solved through the app, its wall heat flux and
//   energy balance read back; a channel's case written from BCs set only through the
//   panels (the untouched inlet's 0/T, the new wall's 0/U).
// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL, expect, test } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLAB = join(HERE, 'fixtures', 'cavity-slab.step');
const CASE = join(HERE, 'fixtures', 'cavity-case');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const stamp = () => Date.now().toString(36);

async function json(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** A new project with `part`, and a Heat Transfer study on it: its ids and helpers. */
async function heatStudy(page, request, { units = 'Metric', part = SLAB, transient = false } = {}) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async ([t, u]) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: u, folder: 'My Projects' })).project.id,
    [`HT4 ${units} ${stamp()}`, units],
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(part);
  await expect.poll(async () => ((await json(request, q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 }).toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  const row = page.locator('#cs-type-list [data-analysis-key="heat_transfer_steady"]');
  await expect(row).toHaveText('Heat Transfer');
  await row.click();
  if (transient) await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();
  const study = async () => (await json(request, q('/api/simulation', { simulation_id: sid }))).simulation || {};
  const mats = async () => (await json(request, q('/api/materials', { simulation_id: sid }))).materials || [];
  const bcs = async () => (await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  const faces = async () => {
    const gid = (await json(request, q('/api/project'))).project.geometries[0].id;
    return (await json(request, q('/api/geometry/cad', { geometry_id: gid, part: 'preview' }))).faces || [];
  };
  return { pid, sid, q, ready, study, mats, bcs, faces };
}

/** The face whose centroid has `axis` = `value` (mm) and outward normal sign `sign` along it. */
function faceAt(list, axis, value, sign) {
  const i = { x: 0, y: 1, z: 2 }[axis];
  const hit = list.find((f) => Math.abs(f.centroid[i] - value) < 0.5 && Math.sign(f.normal[i]) === sign);
  if (!hit) throw new Error(`no face at ${axis} = ${value}`);
  return `face ${hit.id}@Body1`;
}

/** Add a BC of family `kind` from the "+" picker, on `face`; its id and editor. */
async function addBc(page, s, kind, face) {
  const picker = page.locator('#panel-bc-picker .cfd-island');
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await page.locator('#left-tree [data-w19-bcs="1"] .bc-plus').first().click();
  await picker.locator(`[data-bc-key="${kind}"]`).click();
  await picker.locator('[data-bc-add="1"]').click();
  await expect(editor.locator('[data-bc-title="1"]')).toBeVisible({ timeout: 15_000 });
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  // Faces go to a BC once it is saved.
  await expect.poll(async () => (await s.bcs()).some((b) => b.id === id), { timeout: 15_000 }).toBe(true);
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), face);
  await expect.poll(async () => ((await s.bcs()).find((b) => b.id === id) || {}).faces || []).toEqual([face]);
  return { id, editor };
}

/** Run `rid`'s case: the committed finished cavity, its run record done. */
async function finishedRun(request, s, title) {
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: title } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  const rows = (await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || [];
  const runDir = dirname(rows.find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CASE, caseDir, { recursive: true });
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
        n_saved_times: 1,
        last_saved_iteration: 400,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
        analysis_key: 'heat_transfer_steady',
      },
      null,
      2,
    ),
  );
  return rid;
}

/** Run `rid`'s record as the core writes a run whose solver died: `error` and `note`. */
async function failedRun(request, s, title, error, note) {
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: title } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  const rows = (await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || [];
  const runJson = join(dirname(rows.find((r) => String(r.id) === rid).case_dir), 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      { ...rec, status: 'failed', stage: 'failed', error, note, exit_code: 136, finished_at: new Date().toISOString(), analysis_key: 'heat_transfer_steady' },
      null,
      2,
    ),
  );
  return rid;
}

async function openRun(page, sid, rid) {
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) await runsFolder.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
}

async function openResults(page, rid) {
  const li = page.locator(`#left-tree li[data-w27-run="${rid}"]`).first();
  if (!(await li.evaluate((el) => el.classList.contains('expanded')))) await li.locator(':scope > .tree-row .tw').click();
  await page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
}

/** The main legend: its title, unit and tick numbers. */
async function legend(page) {
  const el = page.locator('#legend');
  await expect(el.locator('.legend-title')).toHaveText('Temperature', { timeout: 60_000 });
  const ticks = (await el.locator('.legend-ticks span').allTextContents()).map(Number);
  return { unit: (await el.locator('.legend-units').textContent()).trim(), ticks };
}

test('a Heat Transfer study: its physics, a fluid and a wall’s temperature in °C, saved in K, after a reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const panel = page.locator('#panel-study-settings .cfd-island');
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] > .tree-row`).first().click();
  await expect(panel.locator('[data-ht-solver="1"]')).toHaveText(/Solves buoyant flow of one fluid with buoyantSimpleFoam/);
  const gravity = panel.locator('[data-schema-key="gravity"] select');
  await expect(gravity.locator('option:checked')).toHaveText('−Z (down along Z)');
  await expect(panel.locator('[data-schema-key="gravity_magnitude"]')).toBeVisible();
  // Reference temperature: 20 °C shown, 25 °C typed, 298.15 K saved.
  const tref = panel.getByLabel('Reference temperature', { exact: true });
  await expect(panel.getByLabel('Reference temperature unit')).toHaveValue('°C');
  await expect(tref).toHaveValue('20');
  await tref.fill('25');
  await tref.press('Enter');
  await expect.poll(async () => Number((await s.study()).reference_temperature).toFixed(2)).toBe('298.15');
  // Gravity off: its magnitude row goes (it would do nothing).
  await gravity.selectOption({ label: 'Off' });
  await expect.poll(async () => (await s.study()).gravity).toBe('off');
  await expect(panel.locator('[data-schema-key="gravity_magnitude"]')).toHaveCount(0);
  await gravity.selectOption({ label: '−Y (down along Y)' });
  await expect.poll(async () => (await s.study()).gravity).toBe('-y');

  // A fluid material: the Materials "+" opens the thermal fluid, Air first; the Material
  // type offers the thermal solid too (HT5: a solid body makes it conjugate heat transfer).
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"]`);
  await studyRow.locator('[data-w18-mat-plus]').click();
  const picker = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker.getByLabel('Fluid')).toHaveValue('air');
  await expect(picker.getByLabel('Thermal expansion')).toBeVisible();
  await expect(picker.getByLabel('Material type').locator('option')).toHaveText(['Fluid (thermal)', 'Solid (thermal)']);
  await expect(picker.getByLabel('Material type')).toHaveValue('thermo_fluid');
  await picker.locator('[data-volume="Body1"] button').first().click();
  await expect.poll(async () => (await s.mats()).map((m) => [m.name, m.material_model, m.assigned_volumes])).toEqual([
    ['Air', 'thermo_fluid', ['Body1']],
  ]);
  const air = (await s.mats())[0];
  expect([air.density, air.specific_heat, air.thermal_conductivity]).toEqual([1.204, 1007, 0.02514]);

  // A wall at a fixed 30 °C.
  const list = await s.faces();
  const hotFace = faceAt(list, 'x', 0, -1);
  const { id, editor } = await addBc(page, s, 'wall', hotFace);
  const group = editor.locator('[data-bc-field-group="ht_wall_thermal"]');
  await expect(group).toContainText('Heat through the wall.');
  await group.getByLabel('Thermal', { exact: true }).selectOption({ label: 'Fixed temperature' });
  const wallT = group.getByLabel('Wall temperature', { exact: true });
  await expect(group.getByLabel('Wall temperature unit')).toHaveValue('°C');
  await expect(wallT).toHaveValue('20');
  await wallT.fill('30');
  await wallT.press('Enter');
  const saved = async () => (await s.bcs()).find((b) => b.id === id) || {};
  await expect.poll(async () => Number((await saved()).wall_temperature).toFixed(2)).toBe('303.15');
  expect((await saved()).thermal_condition).toBe('temperature');

  // After a reload: every value as saved, in °C.
  await page.reload();
  await s.ready();
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] > .tree-row`).first().click();
  await expect(panel.getByLabel('Reference temperature', { exact: true })).toHaveValue('25', { timeout: 30_000 });
  await expect(panel.locator('[data-schema-key="gravity"] select option:checked')).toHaveText('−Y (down along Y)');
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] [data-w19-bcs="1"] > .tree-row .tl`).first().click();
  await page.locator(`#panel-bcs-hub .cfd-island [data-open-bc="${id}"]`).click();
  const after = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"] [data-bc-field-group="ht_wall_thermal"]');
  await expect(after.getByLabel('Thermal', { exact: true }).locator('option:checked')).toHaveText('Fixed temperature');
  await expect(after.getByLabel('Wall temperature', { exact: true })).toHaveValue('30');
});

test('a finished run: Temperature legend in °C, the monitors and the energy balance, after a reload', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const rid = await finishedRun(request, s, 'Finished');
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  // The Run panel: each monitor's line and the energy balance's.
  const monitors = page.locator('#panel-sim-control .cfd-island [data-run-monitors="1"]');
  await expect(monitors).toContainText('Energy balance · Heat in 0.017 W · Heat out 0.017 W', { timeout: 60_000 });
  await expect(monitors).toContainText('Hot wall · Heat flow 0.017 W');
  await expect(monitors).toContainText('TC · point 1 · Temperature 24.5 °C');
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  expect(answer.summary.map((i) => i.label)).toEqual(['Heat in', 'out', 'imbalance']);
  expect(answer.summary_warn).toBe(false);

  await openResults(page, rid);
  const shown = await legend(page);
  expect(shown.unit).toBe('°C');
  // The cavity's temperatures, 20 to 30 °C (293.15 to 303.15 K): ticks in °C.
  expect(Math.min(...shown.ticks)).toBeGreaterThanOrEqual(19.9);
  expect(Math.max(...shown.ticks)).toBeLessThanOrEqual(30.1);
  expect(Math.max(...shown.ticks) - Math.min(...shown.ticks)).toBeGreaterThan(5);

  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  await openResults(page, rid);
  expect((await legend(page)).unit).toBe('°C');
});

test('the Monitors dialog of a Heat Transfer run offers its own monitor types, none of Incompressible Flow’s', async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await heatStudy(page, request);
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: 'Monitors' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  await page.locator(`button.rc-plus[data-w27-run-plus="${rid}"]`).click();
  await expect(page.locator('#modal-result-control')).toBeVisible();
  await expect(page.locator('#rc-type-list .cs-group-label')).toHaveText(['BOUNDARY DATA', 'POINT DATA']);
  await expect(page.locator('#rc-type-list [data-rc-type] .ml-type-name')).toHaveText(['Wall heat flux', 'Surface temperature', 'Thermocouple']);
});

test('the results tools of a finished run read temperatures in °C: plot over path, iso surface, iso volume', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const rid = await finishedRun(request, s, 'Tools');
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  await openResults(page, rid);
  await legend(page);
  const filters = page.locator('#filters-toolbar-group');
  const inRange = (text, re) => {
    const m = String(text).match(re);
    expect(m, String(text)).toBeTruthy();
    return [Number(m[1]), Number(m[2])];
  };
  // Plot over path across the cavity: the title and the values in °C (20 to 30 °C, not 293 to 303 K).
  await filters.locator('.tb-btn[data-label="Plot Over Path"]').click();
  await page.locator('#pop-field-variable').selectOption('T');
  for (const p of ['0.005, 0.05, 0.005', '0.095, 0.05, 0.005']) {
    await page.locator('#pop-pick').fill(p);
    await page.locator('#pop-add-point').click();
  }
  await page.locator('#pop-generate').click();
  await expect(page.locator('#pop-chart')).toContainText('Temperature (°C)', { timeout: 90_000 });
  const [plo, phi] = inRange(await page.locator('#pop-chart-meta').textContent(), /from (\S+) to (\S+) °C$/);
  expect(plo).toBeGreaterThanOrEqual(19.9);
  expect(phi).toBeLessThanOrEqual(30.1);
  await filters.locator('.tb-btn[data-label="Plot Over Path"]').click();
  // Iso surface: its value box in °C, centred in the range; a typed 25 (°C) draws a surface.
  const isoBtn = filters.locator('.tb-btn[data-label="Iso Surface"]');
  await isoBtn.click();
  await page.locator('#iso-scalar').selectOption('T');
  await expect(page.locator('#iso-value-unit')).toHaveText('°C');
  const iso = () => page.evaluate(() => window.__CFD_W10__?.iso_fingerprint || {});
  await expect.poll(async () => (await iso()).n_cells || 0, { timeout: 90_000 }).toBeGreaterThan(0);
  const centred = Number(await page.locator('#iso-value').inputValue());
  expect(centred).toBeGreaterThan(20);
  expect(centred).toBeLessThan(30);
  await page.locator('#iso-value').fill('50');
  const [slo, shi] = inRange(
    await expect(page.locator('#iso-status')).toHaveText(/goes from \S+ to \S+ °C at this time\.$/, { timeout: 90_000 }).then(() =>
      page.locator('#iso-status').textContent(),
    ),
    /Temperature goes from (\S+) to (\S+) °C/,
  );
  expect(slo).toBeGreaterThanOrEqual(19.9);
  expect(shi).toBeLessThanOrEqual(30.1);
  await page.locator('#iso-value').fill('25');
  await expect.poll(async () => (await iso()).actor_present, { timeout: 90_000 }).toBe(true);
  await isoBtn.click();
  // Iso volume: its range in °C.
  const ivBtn = filters.locator('.tb-btn[data-label="Iso Volume"]');
  await ivBtn.click();
  await page.locator('#iv-scalar').selectOption('T');
  const range = page.locator('#iv-range-val');
  await expect(range).toHaveText(/^From \S+ to \S+ °C$/, { timeout: 90_000 });
  const [vlo, vhi] = inRange(await range.textContent(), /^From (\S+) to (\S+) °C$/);
  expect(vlo).toBeGreaterThanOrEqual(19.9);
  expect(vhi).toBeLessThanOrEqual(30.1);
  await ivBtn.click();
});

test('an imperial project: the study and the legend show °F, saved in K', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request, { units: 'Imperial' });
  const panel = page.locator('#panel-study-settings .cfd-island');
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] > .tree-row`).first().click();
  await expect(panel.getByLabel('Reference temperature unit')).toHaveValue('°F');
  const tref = panel.getByLabel('Reference temperature', { exact: true });
  await expect(tref).toHaveValue('68');
  await tref.fill('77');
  await tref.press('Enter');
  await expect.poll(async () => Number((await s.study()).reference_temperature).toFixed(2)).toBe('298.15');
  const rid = await finishedRun(request, s, 'Finished');
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  await openResults(page, rid);
  const shown = await legend(page);
  expect(shown.unit).toBe('°F');
  expect(Math.min(...shown.ticks)).toBeGreaterThanOrEqual(67.9);
  expect(Math.max(...shown.ticks)).toBeLessThanOrEqual(86.1);
});

test('new BCs in a Heat Transfer study: an untouched inlet shows 20 °C whatever the reference, a new Wall starts No-slip', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const panel = page.locator('#panel-study-settings .cfd-island');
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] > .tree-row`).first().click();
  const tref = panel.getByLabel('Reference temperature', { exact: true });
  await tref.fill('50');
  await tref.press('Enter');
  await expect.poll(async () => Number((await s.study()).reference_temperature).toFixed(2)).toBe('323.15');
  const list = await s.faces();
  // A velocity inlet, its Thermal group never touched: it shows the field's own 20 °C,
  // which is what the case solves (heat_transfer.bcs: what the editor shows is what is written).
  const inlet = await addBc(page, s, 'velocity_inlet', faceAt(list, 'x', 0, -1));
  const thermal = inlet.editor.locator('[data-bc-field-group="ht_inlet_thermal"]');
  await expect(thermal.getByLabel('Inlet temperature unit')).toHaveValue('°C');
  await expect(thermal.getByLabel('Inlet temperature', { exact: true })).toHaveValue('20');
  const savedIn = ((await s.bcs()).find((b) => b.id === inlet.id) || {}).inlet_temperature;
  expect(savedIn === undefined || Math.abs(Number(savedIn) - 293.15) < 1e-9).toBe(true);
  // A new Wall from the picker: No-slip (a heat transfer study adds a wall for its heat;
  // Incompressible Flow's own new Wall still starts Slip).
  const wall = await addBc(page, s, 'wall', faceAt(list, 'y', 0, -1));
  await expect(wall.editor.getByLabel('Wall type')).toHaveValue('No-slip');
  await expect.poll(async () => ((await s.bcs()).find((b) => b.id === wall.id) || {}).wall_type).toBe('No-slip');
  // After a reload, both as shown.
  await page.reload();
  await s.ready();
  await page.locator(`#left-tree [data-w17-sim-id="${s.sid}"] [data-w19-bcs="1"] > .tree-row .tl`).first().click();
  await page.locator(`#panel-bcs-hub .cfd-island [data-open-bc="${inlet.id}"]`).click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor.locator('[data-bc-field-group="ht_inlet_thermal"]').getByLabel('Inlet temperature', { exact: true })).toHaveValue('20');

  // An Incompressible Flow study on the same part: its new Wall starts Slip (its default
  // walls are no-slip, so a Wall added face by face is there to differ). Same picker, same family.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="incompressible_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const ifSid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(ifSid).toBeTruthy();
  expect(ifSid).not.toBe(s.sid);
  const ifBcs = async () => (await json(request, s.q('/api/bcs', { simulation_id: ifSid }))).boundary_conditions || [];
  await page.locator(`#left-tree [data-w17-sim-id="${ifSid}"] [data-w19-bcs="1"] .bc-plus`).first().click();
  const picker = page.locator('#panel-bc-picker .cfd-island');
  await picker.locator('[data-bc-key="wall"]').click();
  await picker.locator('[data-bc-add="1"]').click();
  await expect(editor.locator('[data-bc-title="1"]')).toBeVisible({ timeout: 15_000 });
  const ifWall = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await expect(editor.getByLabel('Wall type')).toHaveValue('Slip');
  await expect.poll(async () => ((await ifBcs()).find((b) => b.id === ifWall) || {}).wall_type).toBe('Slip');
  // The Heat Transfer study's wall is still No-slip.
  expect(((await s.bcs()).find((b) => b.id === wall.id) || {}).wall_type).toBe('No-slip');
});

test('a run whose solver died of a cause its parser names: the Run panel says the reason', async ({ page, request }) => {
  test.setTimeout(300_000);
  const s = await heatStudy(page, request);
  const reason = 'Boussinesq density reached zero: use incompressible perfect gas';
  const rid = await failedRun(request, s, 'Died', reason, `${reason}. buoyantSimpleFoam failed (exit 136).`);
  const long = 'x'.repeat(170) + ' tail';
  const rid2 = await failedRun(request, s, 'Long error', long, long);
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  await expect(panel.locator('[data-run-status="failed"] .mat-k')).toHaveText('Run failed', { timeout: 30_000 });
  await expect(panel.locator('[data-run-line="1"]')).toHaveText(reason);
  // Any error's first line shows up to 160 characters, an ellipsis when it is cut.
  await openRun(page, s.sid, rid2);
  await expect(panel.locator('[data-run-line="1"]')).toHaveText('x'.repeat(159) + '\u2026', { timeout: 30_000 });
});

test('WSL: a heated cavity meshed and solved through the app; its heat flux, energy balance and Nusselt number', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_500_000);
  const s = await heatStudy(page, request);
  // Ra = 1e5, Pr = 0.71: L = 0.1 m, ΔT = 10 K, β = 1e-3 (the de Vahl Davis cavity).
  const fluid = { density: 1, dynamic_viscosity: 2.639e-5, specific_heat: 1000, thermal_conductivity: 0.03717, thermal_expansion: 1e-3, molar_mass: 28.97 };
  const made = await request.post('/api/materials', {
    data: { project_id: s.pid, simulation_id: s.sid, id: 'm-cavity', material_model: 'thermo_fluid', preset: 'custom', name: 'Cavity fluid', ...fluid, assigned_volumes: ['Body1'] },
  });
  expect(made.ok()).toBeTruthy();
  await request.post('/api/simulation/update', {
    data: {
      project_id: s.pid,
      simulation_id: s.sid,
      gravity: '-y',
      density_model: 'boussinesq',
      reference_temperature: 298.15,
      turbulence_model: 'laminar',
      numerics_preset: 'accurate',
      residual_target: 1e-6,
      // A closed natural-convection case settles sooner with the energy relaxed less.
      relax_h: 0.9,
    },
  });
  await page.reload();
  await s.ready();
  const list = await s.faces();
  const hot = await addBc(page, s, 'wall', faceAt(list, 'x', 0, -1));
  const cold = await addBc(page, s, 'wall', faceAt(list, 'x', 100, 1));
  for (const [bc, t] of [[hot, 303.15], [cold, 293.15]]) {
    // A new Wall in a Heat Transfer study is No-slip already (no wall_type set here).
    await expect.poll(async () => ((await s.bcs()).find((b) => b.id === bc.id) || {}).wall_type).toBe('No-slip');
    await page.evaluate(([id, k]) => window.__CFD_BC_UPDATE__(id, { thermal_condition: 'temperature', wall_temperature: k }), [bc.id, t]);
  }
  const sym = await addBc(page, s, 'symmetry', faceAt(list, 'z', 0, -1));
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), faceAt(list, 'z', 2, 1));
  await expect.poll(async () => (((await s.bcs()).find((b) => b.id === sym.id) || {}).faces || []).length).toBe(2);

  // A mesh: Standard at fineness 4 (about 50,000 cells on this 2 mm slab), with layers.
  const meshesNow = async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"]`);
  await studyRow.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await form.locator('[data-schema-key="fineness"] input').fill('4');
  await form.locator('[data-schema-key="fineness"] input').press('Enter');
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 900_000, intervals: [5_000] })
    .toBe('done ');
  const cells = ((await meshesNow())[0].live_mesh_result || {}).n_cells;
  console.log(`[ht4 wsl] cavity mesh: ${cells} cells`);

  // A run with a Wall heat flux monitor on the hot wall, 5000 iterations at most (the flow settles in about 4000), on 8 cores.
  const made2 = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: 'Cavity' } })).json();
  const rid = String(made2.run_id || (made2.run && (made2.run.id || made2.run.run_id)));
  await request.post('/api/run/update', {
    data: {
      project_id: s.pid,
      simulation_id: s.sid,
      run_id: rid,
      endTime: 5000,
      writeInterval: 5000,
      cores: 8,
      result_controls: [{ id: 'mon-hot', name: 'Hot wall', monitor_type: 'ht_wall_heat_flux', boundaries: [hot.id] }],
    },
  });
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  const start = page.locator('#panel-sim-control .cfd-island [data-run-control="1"] [data-run-start]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const runRow = async () => ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((r) => String(r.id) === rid) || {};
  await expect
    .poll(async () => {
      const r = await runRow();
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 1_200_000, intervals: [10_000] })
    .toBe('done ');
  const answer = await json(request, s.q('/api/run/monitors', { simulation_id: s.sid, run_id: rid }));
  const q = answer.custom.find((r) => r.name === 'Hot wall').last;
  // Nu = q L / (k ΔT): the hot wall's mean flux, L = 0.1 m, k = 0.03717 W/(m·K), ΔT = 10 K.
  const nu = (q.q_avg_W_m2 * 0.1) / (0.03717 * 10);
  const imbalance = answer.summary.find((i) => i.label === 'imbalance').value;
  console.log(`[ht4 wsl] de Vahl Davis Ra 1e5: Nu_avg = ${nu.toFixed(4)} (reference 4.519, ${((100 * (nu - 4.519)) / 4.519).toFixed(2)} %), energy imbalance ${imbalance.toFixed(4)} %`);
  expect(Math.abs(nu - 4.519) / 4.519).toBeLessThan(0.05);
  expect(imbalance).toBeLessThan(1);
  // The run's panel is still open from Start (clicking its row again would close it).
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  if (!(await runPanel.isVisible())) await openRun(page, s.sid, rid);
  await expect(runPanel.locator('[data-run-monitors="1"]').first()).toContainText('Energy balance · Heat in', { timeout: 60_000 });
  await openResults(page, rid);
  expect((await legend(page)).unit).toBe('°C');
});

test('WSL: a channel set up only through the panels writes the case the panels show', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_200_000);
  const s = await heatStudy(page, request);
  const panel = page.locator('#panel-study-settings .cfd-island');
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${s.sid}"]`);
  await studyRow.locator(':scope > .tree-row').first().click();
  // Forced convection: gravity off, the reference temperature 50 °C.
  await panel.locator('[data-schema-key="gravity"] select').selectOption({ label: 'Off' });
  await expect.poll(async () => (await s.study()).gravity).toBe('off');
  const tref = panel.getByLabel('Reference temperature', { exact: true });
  await tref.fill('50');
  await tref.press('Enter');
  await expect.poll(async () => Number((await s.study()).reference_temperature).toFixed(2)).toBe('323.15');
  // Air on the body.
  await studyRow.locator('[data-w18-mat-plus]').click();
  await page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first().locator('[data-volume="Body1"] button').first().click();
  await expect.poll(async () => (await s.mats()).length).toBe(1);
  // Inlet (its Thermal never touched), outlet, a new Wall at a fixed 40 °C, symmetry front and back.
  const list = await s.faces();
  const inlet = await addBc(page, s, 'velocity_inlet', faceAt(list, 'x', 0, -1));
  await expect(inlet.editor.locator('[data-bc-field-group="ht_inlet_thermal"]').getByLabel('Inlet temperature', { exact: true })).toHaveValue('20');
  const outlet = await addBc(page, s, 'pressure_outlet', faceAt(list, 'x', 100, 1));
  const floor = await addBc(page, s, 'wall', faceAt(list, 'y', 0, -1));
  await expect(floor.editor.getByLabel('Wall type')).toHaveValue('No-slip');
  const group = floor.editor.locator('[data-bc-field-group="ht_wall_thermal"]');
  await group.getByLabel('Thermal', { exact: true }).selectOption({ label: 'Fixed temperature' });
  const wallT = group.getByLabel('Wall temperature', { exact: true });
  await wallT.fill('40');
  await wallT.press('Enter');
  await expect.poll(async () => Number(((await s.bcs()).find((b) => b.id === floor.id) || {}).wall_temperature).toFixed(2)).toBe('313.15');
  const sym = await addBc(page, s, 'symmetry', faceAt(list, 'z', 0, -1));
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), faceAt(list, 'z', 2, 1));
  await expect.poll(async () => (((await s.bcs()).find((b) => b.id === sym.id) || {}).faces || []).length).toBe(2);

  // A coarse mesh, then a short run started from the Run panel.
  const meshesNow = async () => (await json(request, s.q('/api/mesh', { simulation_id: s.sid }))).meshes || [];
  await studyRow.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await form.locator('[data-schema-key="fineness"] input').fill('2');
  await form.locator('[data-schema-key="fineness"] input').press('Enter');
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 900_000, intervals: [5_000] })
    .toBe('done ');
  const made = await (await request.post(s.q('/api/run/create'), { data: { project_id: s.pid, simulation_id: s.sid, name: 'Channel' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  await request.post('/api/run/update', { data: { project_id: s.pid, simulation_id: s.sid, run_id: rid, endTime: 20, writeInterval: 20 } });
  await page.reload();
  await s.ready();
  await openRun(page, s.sid, rid);
  const start = page.locator('#panel-sim-control .cfd-island [data-run-control="1"] [data-run-start]');
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const runRow = async () => ((await json(request, s.q('/api/run/status', { simulation_id: s.sid }))).runs || []).find((r) => String(r.id) === rid) || {};
  await expect
    .poll(async () => {
      const r = await runRow();
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 900_000, intervals: [5_000] })
    .toBe('done ');

  // The written case: the inlet at the 20 °C its editor showed (not the 50 °C reference),
  // the new wall no-slip at 40 °C; the fluid starts at the reference.
  const caseDir = (await runRow()).case_dir;
  const sidecar = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  const patchOf = (id) => sidecar.mapped.find((m) => m.id === id).patch;
  const entry = (field, patch) => {
    const text = readFileSync(join(caseDir, '0', field), 'utf8');
    const m = text.match(new RegExp(`\\n    ${patch}\\n    \\{\\n([\\s\\S]*?)\\n    \\}`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  expect(entry('T', patchOf(inlet.id))).toBe('type fixedValue; value uniform 293.15;');
  expect(entry('T', patchOf(floor.id))).toBe('type fixedValue; value uniform 313.15;');
  expect(entry('U', patchOf(floor.id))).toBe('type noSlip;');
  expect(entry('T', patchOf(outlet.id))).toBe('type inletOutlet; inletValue uniform 293.15; value uniform 293.15;');
  expect(readFileSync(join(caseDir, '0', 'T'), 'utf8')).toMatch(/internalField\s+uniform 323\.15;/);
  console.log(`[ht4 wsl] channel case written from the panels: inlet ${entry('T', patchOf(inlet.id))} floor U ${entry('U', patchOf(floor.id))}`);
});
