import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Force on picked faces (Result control > Surface data > Force): the force, its
// pressure and viscous parts, the moment and the coefficients on exactly the faces
// the user picks in the 3D view, as Area average picks them, with no wall BC needed.
// 1. The Monitors dialog offers Force under SURFACE DATA, next to Area average; added
//    to a run that already has "Forces 1", it is "Force 1" and records its type; a
//    face clicked in the viewport is saved on it.
// 2. A finished run (the committed real v2606 output of a plates channel whose bottom
//    wall was picked as two faces and its top wall as a third: tests/fixtures/
//    force-faces/plates-run) shows each Force in the Run panel, as a Graphs card that
//    names its faces, in its own panel, and in both CSVs. No WSL.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
const PLATES = join(WEB, 'bundled-plugins', 'incompressible_flow', 'tests', 'fixtures', 'force-faces', 'plates-run');
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

async function study(page, request) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e force on faces ${stamp()}`,
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
  return { pid, sid, rid, q, ready, runRows };
}

async function openRun(page, sid, rid) {
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
}

// Clicks the CAD face with this id where it shows in the viewport, like a user: a point
// of a coarse grid on that face, clear of its edges (a click near an edge picks the edge).
// Coarse, so it stays quick on CI's software rendering; turns the view if the face faces away.
async function clickFace(page, faceId) {
  const find = () =>
    page.evaluate((want) => {
      const canvas = document.querySelector('#viewer canvas');
      const r = canvas.getBoundingClientRect();
      const faceAt = (x, y) => {
        const top = document.elementFromPoint(x, y);
        if (!top || top.tagName !== 'CANVAS' || !top.closest('#viewer')) return 0;
        const hit = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
        return hit ? Number(hit.faceId) : 0;
      };
      const ring = [[8, 0], [-8, 0], [0, 8], [0, -8]];
      for (let fy = 0.15; fy <= 0.85; fy += 0.035) {
        for (let fx = 0.15; fx <= 0.85; fx += 0.035) {
          const x = Math.round(r.left + r.width * fx);
          const y = Math.round(r.top + r.height * fy);
          if (faceAt(x, y) !== want) continue;
          if (ring.some(([dx, dy]) => faceAt(x + dx, y + dy) !== want)) continue;
          return [x, y];
        }
      }
      return null;
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
}

test('Force is added from the Monitors dialog and takes the faces clicked in the 3D view', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const { pid, sid, rid, q, runRows } = await study(page, request);
  // A Forces monitor already on the run: the new Force is still "Force 1".
  const forcesRc = { id: 'rc-walls', name: 'Forces 1', monitor_type: 'forces', kind: 'Forces', category: 'Boundary data', boundaries: ['@walls'] };
  const saved = await (
    await request.post('/api/run/update', { data: { project_id: pid, simulation_id: sid, run_id: rid, result_controls: [forcesRc] } })
  ).json();
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__CFD_PROJECT_READY__, null, { timeout: 60_000 });
  await openRun(page, sid, rid);

  await page.locator(`button.rc-plus[data-w27-run-plus="${rid}"]`).click();
  await expect(page.locator('#modal-result-control')).toBeVisible();
  await expect(page.locator('#rc-type-list .cs-group-label')).toHaveText(['SURFACE DATA', 'BOUNDARY DATA', 'POINT DATA']);
  const types = page.locator('#rc-type-list [data-rc-type]');
  await expect(types).toHaveText(['Area average', 'Force', 'Forces', 'Point probe']);
  const registry = await json(request, '/api/registry');
  const force = (registry.monitor || []).find((m) => m.key === 'force');
  expect(force && force.user_creatable && force.target).toEqual('patch');
  await page.locator('#rc-type-list [data-rc-type="force"]').click();
  await expect(page.locator('#rc-detail-title')).toHaveText('Force');
  await expect(page.locator('#rc-detail-hint')).toHaveText(`${force.description} Add it here, then pick faces in the viewport.`);
  await page.locator('#rc-apply').click();
  await expect(page.locator('#panel-area-average')).toBeVisible();
  await expect(page.locator('#aa-panel-title')).toHaveText('Force 1');
  await expect(page.locator('#aa-study-note')).toContainText("Uses the study's reference values");
  await expect
    .poll(async () =>
      ((await runRows()).find((r) => String(r.id) === rid)?.result_controls || []).map((rc) => `${rc.name}:${rc.monitor_type}`).sort(),
    )
    .toEqual(['Force 1:force', 'Forces 1:forces']);

  // A wall face clicked in the viewport is the Force's.
  const meta = await json(request, q('/api/geometry/cad', { part: 'preview' }));
  const bcFaces = new Set(((await json(request, q('/api/bcs', { simulation_id: sid }))).boundary_conditions || []).flatMap((b) => b.faces || []));
  // The largest face no BC claims (a wall, and big enough to click in the default view).
  const wall = meta.faces
    .filter((f) => !bcFaces.has(`face ${f.id}@Body1`))
    .sort((a, b) => Number(b.area || 0) - Number(a.area || 0))[0];
  expect(Number(wall.area || 0), JSON.stringify(meta.faces[0])).toBeGreaterThan(0);
  await clickFace(page, wall.id);
  await expect
    .poll(async () => ((await runRows()).find((r) => String(r.id) === rid)?.result_controls || []).find((rc) => rc.name === 'Force 1')?.faces)
    .toEqual([`face ${wall.id}@Body1`]);
  await expect(page.locator('#aa-assign-list')).toContainText(`face ${wall.id}`);
  await expect(page.locator(`#left-tree li[data-w27-run="${rid}"]`).first()).toContainText('Force 1');
});

test("A finished run shows each Force's values, graph, faces and CSV", async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const { sid, rid, q, ready, runRows } = await study(page, request);
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  // A finished case (the cavity's frames) with the plates run's force files and sidecar.
  cpSync(CAVITY, caseDir, { recursive: true });
  cpSync(join(PLATES, 'postProcessing'), join(caseDir, 'postProcessing'), { recursive: true });
  const cavitySide = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
  delete cavitySide.plugin;
  delete cavitySide.study_id;
  const platesSide = JSON.parse(readFileSync(join(PLATES, 'w27-case.json'), 'utf8'));
  writeFileSync(join(caseDir, 'w27-case.json'), JSON.stringify({ ...cavitySide, ...platesSide, app: 'simpleFoam' }, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  const base = { kind: 'Force', category: 'Surface data', write_control: 'Time step', results: null, series: null, chart_values: null, results_available: false };
  const force = (id, name, face) => ({ ...base, id, name, monitor_type: 'force', faces: [`face ${face}@Body1`] });
  writeFileSync(
    runJson,
    JSON.stringify(
      {
        ...rec,
        status: 'done',
        stage: 'done',
        has_results: true,
        n_saved_times: 5,
        iteration: 40,
        last_saved_iteration: 40,
        finished_at: new Date().toISOString(),
        case_dir: caseDir,
        result_controls: [force('entrance', 'Entrance', 11), force('developed', 'Developed', 12), force('top', 'Top', 13)],
      },
      null,
      2,
    ),
  );
  await page.reload();
  await ready();

  // ---- The answer: a force row per Force, naming its faces ----
  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: rid }));
  expect(answer.ok, JSON.stringify(answer).slice(0, 500)).toBe(true);
  const rows = answer.custom.filter((m) => m.type === 'force');
  expect(rows.map((m) => [m.id, m.key, m.faces])).toEqual([
    ['entrance', 'force_entrance', ['face 11@Body1']],
    ['developed', 'force_developed', ['face 12@Body1']],
    ['top', 'force_top', ['face 13@Body1']],
  ]);
  // The faces' drags add up to the whole walls' (the Forces monitor the run also had).
  const walls = answer.custom.find((m) => m.key === 'forces_walls');
  const sum = rows.reduce((s, r) => s + r.last.Fd_N, 0);
  expect(Math.abs(sum - walls.last.Fd_N)).toBeLessThan(1e-12);

  await openRun(page, sid, rid);
  // ---- The Run panel: each Force's headline values ----
  const runList = page.locator('#panel-sim-control [data-run-monitors="1"] li');
  await expect(runList.filter({ hasText: 'Developed' })).toHaveText(
    'Developed · Drag force 3.28e-7 N · Lift force -9.99e-6 N · Drag coefficient 0.055 · Lift coefficient -1.67',
    { timeout: 30_000 },
  );

  // ---- Graphs: a card per Force, drag first, its faces in the details ----
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"]`).first();
  const graphsRow = page.locator(`[data-w28-key="media:run:${rid}:graphs"] > .tree-row`).first();
  if (!(await graphsRow.isVisible())) await results.locator(':scope > .tree-row .tw').click();
  await graphsRow.click();
  const card = page.locator('#run-graphs-custom-cards .mon-card[data-monitor-key="force_developed"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#run-graphs-custom-cards .mon-card-name')).toHaveText(['Entrance', 'Developed', 'Top']);
  await expect(card.locator('[data-mon-qty] option:checked')).toHaveText('Drag force');
  await expect(card.locator('[data-mon-qty] option')).toContainText(['Pressure drag', 'Viscous drag', 'Moment Z', 'Drag coefficient']);
  await expect(card.locator('svg.mon-svg')).toHaveCount(1);
  await card.locator('[data-mon-qty]').selectOption({ label: 'Drag coefficient' });
  await expect(card.locator('.mon-card-last')).toHaveText('0.055');
  await card.locator('details.mon-more > summary').click();
  const details = await card.locator('.mon-grid').evaluate((grid) => [...grid.children].map((el) => el.textContent));
  expect(details.slice(0, 6)).toEqual(['Faces', 'face 12@Body1', 'Drag direction', '(1, 0, 0)', 'Lift direction', '(0, 1, 0)']);

  // ---- CSV: the card's own columns; every monitor's ----
  const one = await download(page, () => card.locator('[data-mon-act="csv"]').click());
  const csv = one.text.trim().split(/\r?\n/);
  expect(csv[0]).toBe(
    'iteration,drag_N,lift_N,side_N,pressure_drag_N,viscous_drag_N,Fx_N,Fy_N,Fz_N,Fpx_N,Fpy_N,Fpz_N,Fvx_N,Fvy_N,Fvz_N,Mx_Nm,My_Nm,Mz_Nm,Cd,Cl,Cs,Cm_pitch',
  );
  expect(csv).toHaveLength(41);
  const last = csv[40].split(',').map(Number);
  expect(last[0]).toBe(40);
  expect(last[1]).toBeCloseTo(3.28373052e-7, 14);
  expect(last[18]).toBeCloseTo(0.0549118815, 9);
  const all = await download(page, () => page.locator('#run-graphs-csv').click());
  const head = all.text.trim().split(/\r?\n/)[0];
  expect(head).toContain('"Developed Drag force [N]"');
  expect(head).toContain('"Top Drag coefficient"');

  // ---- The Force's own panel shows its own values, not its faces' boundaries ----
  const rcsFolder = page.locator(`#left-tree li[data-w27-run-rcs="${rid}"]`).first();
  if (!(await rcsFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await rcsFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-aa="developed"] > .tree-row .tl`).first().click();
  await expect(page.locator('#panel-area-average')).toBeVisible();
  await expect(page.locator('#aa-panel-title')).toHaveText('Developed');
  const own = page.locator('#aa-monitor-values .mon-card');
  await expect(own).toHaveCount(1, { timeout: 30_000 });
  await expect(own.locator('.mon-card-name')).toHaveText('Developed');
});
