import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Export to ParaView (VTK): from a finished run's results, the toolbar's EXPORT > Export VTK
// opens a dialog that exports the frame on screen (or every saved frame) as a zip of VTK
// files and downloads it. The zip's .vtm names the internal mesh and each boundary patch;
// the mesh .vtu has the case's 400 cells and the pressure as p_Pa, 1000 x the case's
// kinematic p (the range in its header). Open case folder asks the server to show the
// run's case folder (answered here, so no Explorer window opens). No WSL: a finished
// run whose case is a copy of the committed cavity case.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
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

/** name -> Buffer of every entry of a zip (stored or deflated), from its central directory. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd, 'zip end record').toBeGreaterThanOrEqual(0);
  const out = new Map();
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i += 1) {
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

/** min / max of an ascii OpenFOAM scalar field's internalField (uniform or a list). */
function foamScalarRange(path) {
  const text = readFileSync(path, 'utf8');
  const uniform = /internalField\s+uniform\s+([^\s;]+)/.exec(text);
  if (uniform) return [Number(uniform[1]), Number(uniform[1])];
  const m =/internalField\s+nonuniform\s+List<scalar>\s*(\d+)\s*\(([^)]*)\)/.exec(text);
  const values = m[2].trim().split(/\s+/).map(Number);
  expect(values.length).toBe(Number(m[1]));
  return [Math.min(...values), Math.max(...values)];
}

const attr = (tag, name) => Number(new RegExp(`${name}="([^"]+)"`).exec(tag)[1]);

test('Export VTK downloads the frame on screen and all frames as ParaView files with pressure in Pa', async ({ page, request }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e export vtk ${stamp()}`,
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

  // A finished run whose case is a copy of the cavity (U and p, saved times 0.1 ... 0.5).
  const runRows = async () => (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run 1' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(sidecar, JSON.stringify(doc, null, 2));
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
        last_saved_iteration: 0.5,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
      },
      null,
      2,
    ),
  );
  await page.reload();
  await ready();

  // Open the run's results from the tree, as a user does.
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) await studyRow.click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await runsFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first();
  await expect(results).toBeVisible();
  await results.click();
  await expect(page.locator('#parts-block')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
  await expect(page.locator('#legend .legend-title')).toHaveText('Velocity Magnitude', { timeout: 60_000 });

  // The run's Results panel offers the export and the case folder while its results are shown.
  await expect(page.locator('#panel-run-results')).toBeVisible();
  await expect(page.locator('#run-results-export-vtk')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#run-results-open-folder')).toBeVisible();

  const onScreen = await page.evaluate(() => window.__CFD_RESULTS_ON_SCREEN__());
  expect(onScreen.case_dir.toLowerCase()).toBe(caseDir.toLowerCase());
  expect(onScreen.times).toContain(onScreen.time);
  const time = onScreen.time;

  // ---- EXPORT > Export VTK: the frame on screen.
  const btn = page.locator('.tb-group[data-group="EXPORT"] #btn-export-vtk');
  await expect(btn).toBeVisible();
  await expect(btn.locator('.tb-txt')).toHaveText('Export VTK');
  await btn.click();
  const dialog = page.locator('#modal-vtk-export');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#vtk-heading')).toHaveText('Export to ParaView (VTK)');
  await expect(page.locator('#vtk-frames-current')).toBeChecked();
  await expect(dialog.locator('label', { has: page.locator('#vtk-frames-current') })).toContainText(`The frame on screen (`);
  await expect(dialog.locator('label', { has: page.locator('#vtk-frames-all') })).toHaveText(
    `All saved frames (${onScreen.times.length})`,
  );
  await expect(page.locator('#vtk-export-copy')).toContainText('Pressure is in Pa');

  const [one] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#vtk-export-go').click()]);
  expect(one.suggestedFilename()).toBe(`Run_1-vtk-${time}.zip`);
  await expect(page.locator('#vtk-export-done')).toContainText(`Saved Run_1-vtk-${time}.zip`);
  await expect(page.locator('#vtk-export-done')).toContainText('x density 1000 kg/m^3, in Pa');
  await expect(page.locator('#vtk-export-error')).toHaveCount(0);
  const entries = unzip(readFileSync(await one.path()));
  const vtm = entries.get(`Run_1_${time}.vtm`).toString('utf8');
  expect(vtm).toMatch(/^<\?xml version="1.0"\?>\s*<VTKFile type="vtkMultiBlockDataSet"/);
  expect(vtm).toContain(`name="internalMesh" file="Run_1/${time}/internalMesh.vtu"`);
  for (const patch of ['movingWall', 'fixedWalls', 'frontAndBack']) {
    expect(vtm).toContain(`name="${patch}" file="Run_1/${time}/boundary/${patch}.vtp"`);
    expect(entries.get(`Run_1/${time}/boundary/${patch}.vtp`).toString('latin1')).toMatch(/^<VTKFile type="PolyData"/);
  }
  const vtu = entries.get(`Run_1/${time}/internalMesh.vtu`).toString('latin1');
  const head = vtu.slice(0, vtu.indexOf('<AppendedData'));
  expect(head).toMatch(/^<VTKFile type="UnstructuredGrid"/);
  expect(head).toContain('NumberOfCells="400"');
  expect(head).toMatch(/<CellData[^>]*>\s*<DataArray type="Float32" Name="U" NumberOfComponents="3"/);
  expect(head).not.toContain('Name="p" ');
  const pTag = /<DataArray[^>]*Name="p_Pa"[^>]*>/.exec(head)[0];
  const [lo, hi] = foamScalarRange(join(caseDir, time, 'p'));
  expect(attr(pTag, 'RangeMin')).toBeCloseTo(lo * 1000, 0);
  expect(attr(pTag, 'RangeMax')).toBeCloseTo(hi * 1000, 0);
  expect(entries.get('README.txt').toString('utf8')).toContain(`Open Run_1_${time}.vtm in ParaView`);

  // ---- All saved frames: a .pvd time series over a .vtm per frame.
  await page.locator('#vtk-frames-all').check();
  const [all] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#vtk-export-go').click()]);
  expect(all.suggestedFilename()).toBe('Run_1-vtk-all-frames.zip');
  const allEntries = unzip(readFileSync(await all.path()));
  const pvd = allEntries.get('Run_1.pvd').toString('utf8');
  expect(pvd).toMatch(/<VTKFile type="Collection"/);
  for (const t of onScreen.times) {
    expect(pvd).toContain(`timestep="${t}" group="" part="0" file="Run_1_${t}.vtm"`);
    expect(allEntries.has(`Run_1/${t}/internalMesh.vtu`)).toBe(true);
  }

  // ---- Open case folder: the server is asked for this run's case (answered here).
  const asked = [];
  await page.route('**/api/results/open-folder', async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.locator('#vtk-open-folder').click();
  await expect(page.locator('#vtk-folder-note')).toHaveText(
    "The run's case folder is open in File Explorer. In ParaView, open case.foam there (File > Open).",
  );
  expect(asked).toEqual([{ project_id: pid, case: onScreen.case_dir }]);
  await page.locator('#vtk-export-close').click();
  await expect(dialog).toBeHidden();
});
