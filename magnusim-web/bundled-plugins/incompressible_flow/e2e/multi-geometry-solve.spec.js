import { expect, test } from '@playwright/test';
import { NO_HEAVY } from '../../../e2e/toolchain.js';
import { addAir, addBc, createStudy, setup } from '../../../e2e/support/two-plates.js';

// Two geometries in one project (the round-hole and teardrop-hole test plates), each
// meshed and solved, then put side by side in Compare with synced filters. Moved from
// the core's e2e/multi-geometry.spec.js, which keeps the study and switching checks.
const HEAVY = process.env.MAGNUSIM_E2E_HEAVY === '1';
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';

test('two geometries meshed, solved and compared side by side', async ({ page, request }) => {
  test.skip(!HEAVY || !WSL, NO_HEAVY);
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

  // Mesh both: the teardrop's starts, the round plate's waits in the queue. Its panel says
  // Queued (no timer, not the teardrop's progress), and the top-bar Queue lists both.
  const form = page.locator('#panel-mesh-form .cfd-island');
  const startMesh = async (g, sid) => {
    await s.pickGeometry(g);
    await expect.poll(s.study).toEqual({ id: sid, geom: g.id });
    await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#btn-create-mesh').click();
    await form.locator('[data-mesh-generate="1"]').click();
  };
  await startMesh(tear, tearStudy);
  await expect.poll(() => page.evaluate(() => window.__CFD_MESH_JOB__?.phase), { timeout: 30_000 }).toBe('generating');
  await startMesh(round, roundStudy);
  await expect
    .poll(() => page.evaluate(() => {
      const j = window.__CFD_MESH_JOB__ || {};
      return `${j.phase}|${j.started_at == null}|${j.elapsed_ms == null}`;
    }), { timeout: 30_000 })
    .toBe('queued|true|true');
  await expect(form.locator('[data-mesh-status="queued"]')).toContainText('transient-test-teardrop');
  await page.locator('#btn-queue').click();
  await expect(page.locator('#job-queue-now')).toContainText('Running: Mesh 1 on transient-test-teardrop');
  await expect(page.locator('#job-queue-list li')).toHaveCount(1);
  await expect(page.locator('#job-queue-list li').first()).toContainText('transient-test');
  await s.shot('queue');
  await page.keyboard.press('Escape');
  await expect(page.locator('#job-queue-chip')).toBeHidden();
  s.stage('second mesh queued behind the first');
  const meshesDone = async () => {
    const tree = await s.json(s.q('/api/project/tree'));
    const studies = (tree.geometries || []).flatMap((g) => g.studies || []);
    const st = [tearStudy, roundStudy].map((sid) => {
      const m = ((studies.find((x) => x.id === sid) || {}).meshes || [])[0] || {};
      return m.live_status || (m.generated ? 'done' : 'none');
    });
    s.stage(`meshes ${st.join(', ')}`);
    return st.join(',');
  };
  await expect.poll(meshesDone, { timeout: 1_800_000, intervals: [10_000] }).toBe('done,done');

  // Solve each from its own study.
  const runs = {};
  for (const [g, sid] of [[tear, tearStudy], [round, roundStudy]]) {
    await s.pickGeometry(g);
    await expect.poll(s.study).toEqual({ id: sid, geom: g.id });
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
