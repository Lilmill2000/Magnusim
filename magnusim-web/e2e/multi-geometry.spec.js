import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two geometries in one project, set up alike to compare them: the round-hole and the
// teardrop-hole test plates (same box, flow in one short end and out the other).
// Each geometry keeps its own study; switching never leaves the other one's study,
// editor or face picks active; a study copied across lands its BCs on the faces that
// are the same surface there. With WSL and MAGNUSIM_E2E_HEAVY=1 both are meshed, solved
// and put side by side in Compare.
const HEAVY = process.env.MAGNUSIM_E2E_HEAVY === '1';
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const GEOM = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry');
const ROUND = join(GEOM, 'transient-test.step');
const TEARDROP = join(GEOM, 'transient-test-teardrop.step');

async function setup(page, request, title) {
  const t0 = Date.now();
  const stage = (msg) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${msg}`);
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`) }).catch(() => {});
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(async (t) => {
    const out = await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' });
    return out && out.project && out.project.id;
  }, title);
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await expect(page.locator('#app.workbench')).toBeVisible({ timeout: 60_000 });
  const q = (path, extra = {}) =>
    `${path}?${new URLSearchParams({ project_id: pid, ...extra }).toString()}`;
  const json = async (url) => (await request.get(url)).json();
  const shown = () => page.evaluate(() => window.__CFD_W16__?.geometry?.id || null);
  const study = () =>
    page.evaluate(() => {
      const s = window.__CFD_W17__;
      return { id: s?.activeId || null, geom: s?.simulation?.geometry_id || null };
    });

  // Import both plates: the second is added to the same project.
  for (const file of [ROUND, TEARDROP]) {
    const before = (await json(q('/api/project'))).project?.geometries?.length || 0;
    await page.locator('#geometry-file-input').setInputFiles(file);
    await expect
      .poll(async () => (await json(q('/api/project'))).project?.geometries?.length || 0, { timeout: 120_000 })
      .toBe(before + 1);
    await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  }
  const geoms = (await json(q('/api/project'))).project.geometries;
  const byName = (n) => geoms.find((g) => g.name === n);
  const round = byName('transient-test');
  const tear = byName('transient-test-teardrop');
  expect(round && tear, JSON.stringify(geoms.map((g) => g.name))).toBeTruthy();
  stage(`imported ${round.id} and ${tear.id}`);
  // The plates' ends: in at y = 0, out at y = 1500 mm. Face numbers differ per plate.
  const ends = async (gid) => {
    const meta = await json(q('/api/geometry/cad', { geometry_id: gid, part: 'preview' }));
    const near = (a, b) => Math.abs(a - b) < 0.5;
    const inlet = meta.faces.find((f) => near(f.centroid[1], 0) && near(f.normal[1], -1));
    const outlet = meta.faces.find((f) => near(f.centroid[1], 1500) && near(f.normal[1], 1));
    return { inlet: `face ${inlet.id}@Body1`, outlet: `face ${outlet.id}@Body1` };
  };
  round.ends = await ends(round.id);
  tear.ends = await ends(tear.id);
  expect(round.ends.inlet).not.toBe(tear.ends.inlet);
  const pickGeometry = async (g) => {
    await page.locator(`#geometries-list .geo-item[data-geom-id="${g.id}"]`).click();
    await expect.poll(shown, { timeout: 30_000 }).toBe(g.id);
  };
  return { pid, q, json, shown, study, stage, shot, round, tear, pickGeometry };
}

async function createStudy(page, { geometryId, copyFrom } = {}) {
  await page.locator('#btn-create-simulation').click();
  const modal = page.locator('#modal-create-simulation');
  await expect(modal).toBeVisible();
  if (geometryId) await page.locator('#cs-geometry').selectOption(geometryId);
  if (copyFrom) await page.locator('#cs-copy-from').selectOption(copyFrom);
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
}

async function addBc(page, json, url, { kind, face, value, unit }) {
  const saved = async () => (await json(url())).boundary_conditions || [];
  await page.locator('#btn-bcs-plus').click();
  const picker = page.locator('#panel-bc-picker .cfd-island');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-bc-key="${kind}"]`).click();
  await picker.locator('[data-bc-add="1"]').click();
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const name = ((await editor.locator('[data-bc-title="1"]').textContent()) || '').trim();
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await expect.poll(async () => (await saved()).some((b) => b.name === name), { timeout: 15_000 }).toBe(true);
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), face);
  await expect.poll(async () => ((await saved()).find((b) => b.name === name) || {}).faces || []).toEqual([face]);
  await page.evaluate(([bcId, v, u]) => window.__CFD_BC_UPDATE__(bcId, { value: v, unit: u }), [id, value, unit]);
  await expect.poll(async () => String(((await saved()).find((b) => b.name === name) || {}).value)).toBe(String(value));
  return { name, editor };
}

async function addAir(page, json, url) {
  await page.locator('#left-tree #btn-materials-plus').first().click();
  const matPanel = page.locator('#panel-material-picker .cfd-island, #panel-air-material .cfd-island').first();
  await expect(matPanel).toBeVisible({ timeout: 15_000 });
  await matPanel.locator('[data-volume="Body1"] button').first().click();
  await expect
    .poll(async () => (((await json(url())).materials || []).find((m) => /air/i.test(String(m.name || ''))) || {}).assigned_volumes || [])
    .toEqual(['Body1']);
}

test('two geometries: each keeps its own study, and a copied study lands on the matching faces', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const s = await setup(page, request, 'e2e two geometries');
  const { tear, round } = s;

  // Teardrop study: in at one end, out at the other, Air.
  await s.pickGeometry(tear);
  await createStudy(page, { geometryId: tear.id });
  const tearStudy = (await s.study()).id;
  expect((await s.study()).geom).toBe(tear.id);
  const bcsOf = (sid) => () => s.q('/api/bcs', { simulation_id: sid });
  const inlet = await addBc(page, s.json, bcsOf(tearStudy), { kind: 'velocity_inlet', face: tear.ends.inlet, value: 1, unit: 'm/s' });
  const outlet = await addBc(page, s.json, bcsOf(tearStudy), { kind: 'pressure_outlet', face: tear.ends.outlet, value: 0, unit: 'Pa' });
  await addAir(page, s.json, () => s.q('/api/materials', { simulation_id: tearStudy }));
  s.stage('teardrop study set up');

  // With a BC editor open, switch to the plate that has no study yet: the editor closes,
  // no study stays active, and a face pick cannot reach the teardrop's BCs.
  await page.locator(`#left-tree [data-w19-bc] .tl`, { hasText: inlet.name }).first().click();
  await expect(inlet.editor).toBeVisible();
  await s.pickGeometry(round);
  await expect(inlet.editor).toBeHidden();
  expect(await s.study()).toEqual({ id: null, geom: null });
  const before = JSON.stringify((await s.json(bcsOf(tearStudy)())).boundary_conditions.map((b) => [b.name, b.faces]));
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(Number(f.match(/\d+/)[0])), round.ends.inlet);
  await page.waitForTimeout(1500);
  const after = JSON.stringify((await s.json(bcsOf(tearStudy)())).boundary_conditions.map((b) => [b.name, b.faces]));
  expect(after).toBe(before);

  // Back and forth: each click shows that plate, with its own study (or none).
  await s.pickGeometry(tear);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  await s.pickGeometry(round);
  await expect.poll(s.study).toEqual({ id: null, geom: null });
  await s.pickGeometry(tear);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  s.stage('switching keeps geometry and study together');

  // Copy the teardrop study onto the round plate. Clone is off (its mesh and results
  // belong to the teardrop); the BCs land on the round plate's own end faces.
  await s.pickGeometry(round);
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-geometry').selectOption(round.id);
  await page.locator('#cs-copy-from').selectOption(tearStudy);
  await expect(page.locator('#cs-copy-mode [data-copy-mode="clone"]')).toBeDisabled();
  await expect(page.locator('#cs-copy-geom-note')).toContainText('transient-test-teardrop');
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#cf-heading')).toHaveText('Copied to this geometry');
  await expect(page.locator('#cf-copy')).toContainText('Every face has its match here');
  await page.locator('#cf-confirm').click();
  const roundStudy = await s.study();
  expect(roundStudy.geom).toBe(round.id);
  expect(roundStudy.id).not.toBe(tearStudy);
  const copied = (await s.json(bcsOf(roundStudy.id)())).boundary_conditions;
  const faces = Object.fromEntries(copied.map((b) => [b.name, b.faces]));
  expect(faces[inlet.name]).toEqual([round.ends.inlet]);
  expect(faces[outlet.name]).toEqual([round.ends.outlet]);
  const tearAfter = Object.fromEntries((await s.json(bcsOf(tearStudy)())).boundary_conditions.map((b) => [b.name, b.faces]));
  expect(tearAfter[inlet.name]).toEqual([tear.ends.inlet]);
  expect(tearAfter[outlet.name]).toEqual([tear.ends.outlet]);
  s.stage('copied study on the matching faces');

  // A click anywhere in the other study's tree brings its geometry along.
  await page.locator(`#left-tree [data-w17-sim-id="${tearStudy}"] [data-w19-bcs] > .tree-row .tl`).first().click();
  await expect.poll(s.shown).toBe(tear.id);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });

  // Reopened: the study shown is the one of the geometry in the viewport.
  await page.reload();
  await page.waitForFunction((pid) => window.__CFD_PROJECT_READY__ === pid, s.pid, { timeout: 60_000 });
  const st = await s.study();
  expect(st.geom).toBe(await s.shown());
});

test('two geometries meshed, solved and compared side by side', async ({ page, request }) => {
  test.skip(!HEAVY || !WSL, 'Requires MAGNUSIM_E2E_HEAVY=1 and MAGNUSIM_E2E_WSL=1');
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const s = await setup(page, request, 'e2e two geometries compare');
  const { tear, round } = s;
  await s.pickGeometry(tear);
  await createStudy(page, { geometryId: tear.id });
  const tearStudy = (await s.study()).id;
  const bcsOf = (sid) => () => s.q('/api/bcs', { simulation_id: sid });
  await addBc(page, s.json, bcsOf(tearStudy), { kind: 'velocity_inlet', face: tear.ends.inlet, value: 1, unit: 'm/s' });
  await addBc(page, s.json, bcsOf(tearStudy), { kind: 'pressure_outlet', face: tear.ends.outlet, value: 0, unit: 'Pa' });
  await addAir(page, s.json, () => s.q('/api/materials', { simulation_id: tearStudy }));
  await s.pickGeometry(round);
  await createStudy(page, { geometryId: round.id, copyFrom: tearStudy });
  await page.locator('#cf-confirm').click();
  const roundStudy = (await s.study()).id;
  s.stage('both studies set up');

  // Mesh and solve each, one after the other, from its own study.
  const runs = {};
  for (const [g, sid] of [[tear, tearStudy], [round, roundStudy]]) {
    await s.pickGeometry(g);
    await expect.poll(s.study).toEqual({ id: sid, geom: g.id });
    const meshFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row`).first();
    await meshFolder.locator('.tl').click();
    await page.locator('#btn-create-mesh').click();
    const form = page.locator('#panel-mesh-form .cfd-island');
    await form.locator('[data-mesh-generate="1"]').click();
    const meshOf = async () => (await s.json(s.q('/api/case', { simulation_id: sid })));
    await expect
      .poll(async () => {
        const c = await meshOf();
        const st = c.status || c.live_mesh_result?.status || 'none';
        s.stage(`${g.name} mesh ${st}`);
        return /done|failed/.test(st) ? st : 'waiting';
      }, { timeout: 900_000, intervals: [10_000] })
      .toBe('done');
    const run = page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w27-run] > .tree-row .tl`).first();
    await run.click();
    const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    const simTime = panel.getByLabel('Simulation time', { exact: true });
    await simTime.fill('0.3');
    await simTime.press('Enter');
    const frames = panel.getByLabel('Result frames', { exact: true });
    await frames.fill('3');
    await frames.press('Enter');
    await expect(panel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
    await panel.locator('[data-run-start]').click();
    await expect
      .poll(async () => {
        const j = await s.json(s.q('/api/run/status', { simulation_id: sid }));
        const r = j.run || (j.runs || [])[0] || {};
        s.stage(`${g.name} run ${r.status}`);
        runs[g.id] = r;
        return /done|failed|stopped/.test(r.status || '') ? r.status : 'waiting';
      }, { timeout: 1_800_000, intervals: [15_000] })
      .toBe('done');
  }
  // Each run solved in its own geometry's folder, on its own mesh.
  expect(runs[tear.id].case_dir.toLowerCase()).toContain('teardrop');
  expect(runs[round.id].case_dir.toLowerCase()).not.toContain('teardrop');
  expect(runs[tear.id].case_dir).not.toBe(runs[round.id].case_dir);

  // Compare from the round plate's results: both plates' runs are offered, and the
  // teardrop's opens in the right pane.
  const roundRun = runs[round.id].id || runs[round.id].run_id;
  const tearRun = runs[tear.id].id || runs[tear.id].run_id;
  await page.locator(`#left-tree [data-w27-run="${roundRun}"] > .tree-row .tl`).first().click();
  await page.locator(`#left-tree [data-w27-run-results="${roundRun}"] > .tree-row .tl`).first().click();
  await expect(page.locator('#btn-compare')).toBeVisible({ timeout: 60_000 });
  // Compare works from open results: wait until they are on screen, as a user would.
  await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 180_000 });
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 180_000 });
  await page.locator('#btn-compare').click();
  await expect(page.locator('#compare-bar')).toBeVisible();
  const groups = await page.locator('#compare-mesh-b optgroup').evaluateAll((els) => els.map((e) => e.label));
  s.stage(`compare groups: ${groups.join(' | ')}`);
  expect(groups.some((g) => g.startsWith('transient-test-teardrop'))).toBe(true);
  expect(groups.some((g) => g.startsWith('transient-test ') || g.startsWith('transient-test —'))).toBe(true);
  await page.locator('#compare-mesh-b').selectOption(`${tearRun}|`);
  await expect(page.locator('#compare-pane-b')).toBeVisible({ timeout: 60_000 });
  // The panes say which plate they show (both runs are "Run 1").
  await expect(page.locator('#compare-label-b')).toContainText('transient-test-teardrop /', { timeout: 60_000 });
  await expect(page.locator('#compare-label-a')).toContainText('transient-test /');
  await s.shot('compare');

  // Sync filters: what pane A shows (round plate) is drawn on pane B's run (teardrop):
  // the same cutting plane, and a particle trace seeded from the teardrop's own inlet
  // face (face numbers differ between the plates).
  await page.locator('#compare-sync').check();
  await page.locator('.tb-btn[data-label="Particle Trace"]').click();
  await expect(page.locator('#pt-block')).toBeVisible();
  // A new trace seeds from the run's inlet by itself; switch it on.
  await expect(page.locator('#pt-assign-list [data-pt-face]')).toHaveCount(1);
  await expect(page.locator('#pt-assign-list [data-pt-face]')).toHaveAttribute('data-pt-face', round.ends.inlet);
  // The switch's input sits under its slider: click the input as the slider does.
  await page.evaluate(() => { const el = document.getElementById('pt-enabled'); if (!el.checked) el.click(); });
  await expect(page.locator('#pt-enabled')).toBeChecked();
  await page.locator('.tb-btn[data-label="Cutting Plane"]').click();
  const paneB = () =>
    page.evaluate(() => {
      const R = window.__CFD_COMPARE__?.res;
      return {
        field: R?.field,
        planes: (R?.set?.planes || []).length,
        seeds: R?.set?.pt?.faces || [],
        lost: R?.ptLost || [],
        trace: R?.pt?.pd?.getNumberOfPoints?.() || 0,
        cuts: (R?.planes || []).filter((p) => p?.actor?.getVisibility?.()).length,
      };
    });
  await expect
    .poll(async () => {
      const b = await paneB();
      s.stage(`pane B: ${JSON.stringify(b)}`);
      return b.planes >= 1 && b.cuts >= 1 && b.trace > 0 ? b.seeds : null;
    }, { timeout: 300_000, intervals: [5_000] })
    .toEqual([tear.ends.inlet]);
  expect((await paneB()).lost).toEqual([]);
  await s.shot('compare-synced');
});
