import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';
import { NO_WSL } from './toolchain.js';

// HT3 (host API 1.8): a two-region conjugate heat transfer case solved and shown by
// the core, through a test analysis (python/tests/fixtures/cht-plugins/stub-cht) on its
// own server, so the Create modal's parity stays untouched:
// - a study of a fluid (Body1) and a solid (Body2) material, meshed with one region each;
// - Start: the analysis writes the case, the WSL step splits it (splitMeshRegions) and
//   chtMultiRegionSimpleFoam runs; the residual plot groups its series by region;
// - results: T on a cut plane across both regions, U only in the fluid (grey in the
//   solid, and the legend says so), the Regions filter showing one region at a time;
// - a path through the solid alone, plotted by velocity: the plot says U is not
//   defined there (not "does not pass through the model");
// - the same after a reload;
// - Continue: 20 more iterations from the saved one, on the split mesh (the case still
//   names its split step, which a continued run never runs), a frame at 40 in both regions.
const HERE = dirname(fileURLToPath(import.meta.url));
const PART = join(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'two-boxes-shared-face.brep');
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
let host;

test.beforeAll(async () => {
  if (!WSL) return;
  host = await startHost({ name: 'ht3-cht', pluginsFrom: 'python/tests/fixtures/cht-plugins' });
});

test.afterAll(() => {
  if (host) host.stop();
});

const json = async (request, url) => (await request.get(`${host.base}${url}`)).json();

test('a two-region case solves and shows T across both regions, U in the fluid only, and a region at a time', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(1_500_000);
  page.setDefaultTimeout(30_000);

  // A project with the two-box part and a study of the stub CHT analysis.
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async () =>
      (await window.__CFD_W16_CREATE__({ title: `HT3 ${Date.now().toString(36)}`, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
  );
  await page.goto(`${host.base}/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(PART);
  await expect
    .poll(async () => ((await json(request, `/api/project?project_id=${pid}`)).project?.geometries || []).length, { timeout: 120_000 })
    .toBe(1);
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-type-list [data-analysis-key="stub_cht_steady"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  await expect
    .poll(async () => page.evaluate(() => (window.__CFD_GEOMETRY_BODIES__ ? window.__CFD_GEOMETRY_BODIES__() : [])), { timeout: 60_000 })
    .toEqual(['Body1', 'Body2']);

  // Air on Body1, Aluminium 6061 on Body2.
  const study = page.locator(`#left-tree [data-w17-sim-id="${sid}"]`);
  const picker = page.locator('#panel-material-picker .cfd-island');
  const mats = async () => (await json(request, `/api/materials?project_id=${pid}&simulation_id=${sid}`)).materials || [];
  await study.locator('[data-w18-mat-plus]').click();
  await picker.locator('[data-volume="Body1"] button').click();
  await expect.poll(async () => (await mats()).length).toBe(1);
  await study.locator('[data-w18-mat-plus]').click();
  await picker.getByLabel('Material type').selectOption('stub_cht_solid');
  await picker.locator('[data-volume="Body2"] button').click();
  await expect.poll(async () => (await mats()).map((m) => `${m.material_model}:${(m.assigned_volumes || []).join()}`).sort())
    .toEqual(['stub_cht_fluid:Body1', 'stub_cht_solid:Body2']);

  // A coarse mesh: one cellZone per region.
  const meshesNow = async () => (await json(request, `/api/mesh?project_id=${pid}&simulation_id=${sid}`)).meshes || [];
  await study.locator('[data-w20-mesh="1"] > .tree-row .tl').first().click();
  await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
  const form = page.locator('#panel-mesh-form .cfd-island');
  await expect(form.locator('[data-schema-key="fineness"] input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await meshesNow()).length, { timeout: 15_000 }).toBe(1);
  await form.locator('[data-schema-key="fineness"] input').fill('2');
  for (const label of ['Hex element core', 'Automatic boundary layers']) {
    const toggle = form.locator(`button[aria-label="${label}"]`);
    if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  }
  await form.locator('[data-mesh-generate="1"]').click();
  await expect
    .poll(async () => {
      const r = ((await meshesNow())[0] || {}).live_mesh_result || {};
      return /done|failed|stopped/.test(String(r.status)) ? `${r.status} ${r.error || ''}` : 'wait';
    }, { timeout: 600_000, intervals: [3_000] })
    .toBe('done ');
  const mesh = (await meshesNow())[0];
  expect((mesh.live_mesh_result.regions || []).map((r) => [r.name, r.role])).toEqual([
    ['air', 'fluid'],
    ['aluminium_6061', 'solid'],
  ]);

  // A run, started from its panel.
  const made = await request.post(`${host.base}/api/run/create`, { data: { project_id: pid, simulation_id: sid, name: 'CHT run', mesh_id: mesh.id } });
  const mj = await made.json();
  expect(made.ok(), JSON.stringify(mj)).toBe(true);
  const rid = mj.run_id || (mj.run && (mj.run.id || mj.run.run_id));
  // A run made through the API: the page's tree reads it on its next load (nothing
  // tells an open page about it; the tree may have refreshed for the mesh just before).
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  const runRow = async () =>
    ((await json(request, `/api/run/status?project_id=${pid}&simulation_id=${encodeURIComponent(sid)}`)).runs || []).find((r) => String(r.id) === String(rid)) || {};
  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const openRun = async () => {
    const folder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
    if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
      await folder.locator(':scope > .tree-row .tw').click();
    }
    await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
  };
  await openRun();
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 30_000 });
  await runPanel.locator('[data-run-start]').click();
  await expect
    .poll(async () => {
      const st = (await runRow()).status || 'none';
      return /done|failed|stopped/.test(st) ? st : 'running';
    }, { timeout: 900_000, intervals: [3_000] })
    .toBe('done');
  const caseDir = (await runRow()).case_dir;
  expect(caseDir && existsSync(caseDir), `case_dir ${caseDir}`).toBe(true);
  expect(readFileSync(join(caseDir, 'system', 'controlDict'), 'utf8')).toMatch(/application\s+chtMultiRegionSimpleFoam;/);
  const frames = readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== '0');
  expect(frames).toEqual(['20']);
  expect(existsSync(join(caseDir, '20', 'air', 'U')) && existsSync(join(caseDir, '20', 'aluminium_6061', 'T'))).toBe(true);
  expect(existsSync(join(caseDir, '20', 'aluminium_6061', 'U'))).toBe(false);

  // The residual plot: one group per region, each with the series it solved.
  const legendGroups = async () =>
    runPanel.locator('.sim-residual-legend [data-residual-region]').evaluateAll((els) =>
      els.map((el) => [el.getAttribute('data-residual-region'), [...el.querySelectorAll(':scope > span')].map((s) => s.textContent)]),
    );
  const checkResiduals = async () => {
    await expect(runPanel.locator('[data-residual-plot="1"]')).toBeVisible({ timeout: 60_000 });
    await expect.poll(legendGroups, { timeout: 30_000 }).toEqual([
      ['air', ['U', 'h', 'p_rgh']],
      ['aluminium_6061', ['h']],
    ]);
  };
  await checkResiduals();

  // Results: T on a cut plane across both regions.
  const regionsNow = () => page.evaluate(() => window.__CFD_RESULT_REGIONS__());
  const openResults = async () => {
    await page.locator(`[data-w27-run-results="${rid}"] > .tree-row .tl`).first().click();
    await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 90_000 });
    await expect(page.locator('#legend .legend-units')).toHaveText('K');
    await expect(page.locator('#legend-note')).toBeHidden();
  };
  await openResults();
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  await expect(page.locator('#cp-coloring')).toBeVisible();
  await expect.poll(async () => (await regionsNow()).planes[0] || [], { timeout: 90_000 }).toEqual(['air', 'aluminium_6061']);
  const w6 = await page.evaluate(() => window.__CFD_W6__.foam_proof);
  // T over both regions: the air walls at 300 K, the solid's at 350 K.
  expect(w6.min).toBeLessThan(301);
  expect(w6.max).toBeGreaterThan(349);
  expect((await regionsNow()).surface_regions).toEqual(['air', 'aluminium_6061']);

  // The Regions filter lists both regions.
  const regionsBlock = page.locator('#regions-block');
  await expect(regionsBlock).toBeVisible();
  await expect(page.locator('#region-filter option')).toHaveText(['All regions', 'air (fluid)', 'aluminium_6061 (solid)']);

  // U only in the fluid: grey in the solid, and the legend says so.
  await page.locator('#cp-coloring').selectOption('magU');
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity magnitude', { timeout: 60_000 });
  await expect(page.locator('#legend-note')).toHaveText('No U in solids (shown grey)');
  await expect(page.locator('#legend-note')).toBeVisible();

  // One region at a time: the surface and the cut plane show only its cells. (Opening
  // the cutting plane folded the other blocks: the block's title opens it again.)
  if (await regionsBlock.evaluate((el) => el.classList.contains('is-collapsed'))) {
    await regionsBlock.locator('.fp-collapse-toggle').first().click();
  }
  await expect(page.locator('#region-filter')).toBeVisible();
  await page.locator('#region-filter').selectOption('aluminium_6061');
  await expect.poll(async () => (await regionsNow()).surface_regions, { timeout: 60_000 }).toEqual(['aluminium_6061']);
  await expect.poll(async () => (await regionsNow()).planes[0], { timeout: 60_000 }).toEqual(['aluminium_6061']);
  await page.locator('#region-filter').selectOption('air');
  await expect.poll(async () => (await regionsNow()).surface_regions, { timeout: 60_000 }).toEqual(['air']);
  await page.locator('#region-filter').selectOption('');
  await expect.poll(async () => (await regionsNow()).surface_regions, { timeout: 60_000 }).toEqual(['air', 'aluminium_6061']);
  await page.locator('#cp-coloring').selectOption('T');
  await expect(page.locator('#legend .legend-title')).toHaveText('Temperature', { timeout: 60_000 });
  await expect(page.locator('#legend-note')).toBeHidden();

  // A path through the solid alone, by velocity: U is not defined there, and the plot says so.
  const probe = await (
    await request.get(
      `${host.base}/api/plot-over-path?${new URLSearchParams({ case: caseDir, time: '20', points: '0,0,0;0,0,0.001', subdivisions: '0', field: 'T' })}`,
    )
  ).json();
  const [x0, x1, y0, y1, z0, z1] = probe.bounds;
  // Body2 (the solid) is x 10..30 mm of the part's 0..30 mm.
  const at = (f) => [x0 + f * (x1 - x0), (y0 + y1) / 2, (z0 + z1) / 2].map((v) => v.toPrecision(6)).join(', ');
  await page.locator('.tb-btn[data-label="Plot Over Path"]').click();
  await expect(page.locator('#pop-block')).toBeVisible();
  for (const f of [0.6, 0.9]) {
    await page.locator('#pop-pick').fill(at(f));
    await page.locator('#pop-add-point').click();
  }
  await expect(page.locator('#pop-selected-label')).toHaveText('Selected points (2)');
  await page.locator('#pop-field-variable').selectOption('magU');
  await page.locator('#pop-generate').click();
  await expect(page.locator('#pop-status')).toHaveText('Velocity magnitude is not defined in the regions the path passes through.', {
    timeout: 90_000,
  });
  await expect(page.locator('#pop-chart-wrap')).toBeHidden();
  // T is defined there: the plot is drawn.
  await page.locator('#pop-field-variable').selectOption('T');
  await page.locator('#pop-generate').click();
  await expect(page.locator('#pop-chart-wrap')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#pop-status')).toBeHidden();

  // After a reload: the residual groups and the results' regions are the same.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await openRun();
  await checkResiduals();
  await openResults();
  await expect(page.locator('#region-filter option')).toHaveText(['All regions', 'air (fluid)', 'aluminium_6061 (solid)']);
  await expect.poll(async () => (await regionsNow()).surface_regions, { timeout: 60_000 }).toEqual(['air', 'aluminium_6061']);

  // Continue 20 more iterations: from the saved 20 to 40, both regions solved again.
  const splitLog = join(caseDir, 'log.splitMeshRegions.1');
  const splitAt = statSync(splitLog).mtimeMs;
  await openRun();
  const box = runPanel.locator('[data-run-continue="1"]');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.locator('#run-continue-amount').fill('20');
  await expect(box.locator('[data-run-continue-hint="1"]')).toHaveText(
    'Continues from the last saved result, iteration 20, to iteration 40.',
  );
  await box.locator('[data-run-continue-go="1"]').click();
  await expect
    .poll(async () => {
      const row = await runRow();
      if (!row.continued) return 'not continued yet';
      return /done|failed|stopped/.test(String(row.status)) ? `${row.status} ${row.error || ''}`.trim() : 'running';
    }, { timeout: 900_000, intervals: [3_000] })
    .toBe('done');
  const after = readdirSync(caseDir).filter((d) => /^\d+(\.\d+)?$/.test(d) && d !== '0').sort((a, b) => Number(a) - Number(b));
  expect(after).toEqual(['20', '40']);
  expect(existsSync(join(caseDir, '40', 'air', 'U')) && existsSync(join(caseDir, '40', 'aluminium_6061', 'T'))).toBe(true);
  // The first part's log is kept; the split did not run again (no new split log).
  expect(existsSync(join(caseDir, 'log.chtMultiRegionSimpleFoam.1'))).toBe(true);
  expect(readdirSync(caseDir).filter((f) => f.startsWith('log.splitMeshRegions'))).toEqual(['log.splitMeshRegions.1']);
  expect(statSync(splitLog).mtimeMs).toBe(splitAt);
});
