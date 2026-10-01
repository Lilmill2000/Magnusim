import { expect, test } from '@playwright/test';
import { addAir, addBc, createStudy, setup } from './support/two-plates.js';

// Two geometries in one project, set up alike to compare them: the round-hole and the
// teardrop-hole test plates (same box, flow in one short end and out the other).
// Each geometry keeps its own study; switching never leaves the other one's study,
// editor or face picks active; a study copied across lands its BCs on the faces that
// are the same surface there. Meshing, solving and comparing both is Incompressible
// Flow's test (bundled-plugins/incompressible_flow/e2e/multi-geometry-solve.spec.js).

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

  // Back and forth: each click shows that plate, with its own study (or none), and quickly.
  const times = [];
  for (const g of [tear, round, tear, round]) times.push(await s.timedSwitch(g));
  s.stage(`switch times ${times.join(', ')} ms`);
  // "Near-instant" is measured on a real PC (a few hundred ms). A CI runner has two slow
  // cores and a cold cache, so it only has to stay clearly interactive there.
  expect(Math.max(...times), `switch times ${times.join(', ')} ms`).toBeLessThan(process.env.CI ? 5000 : 1500);

  // A quick second click: the teardrop's setup (GET /api/project/hydrate for its study)
  // is still on its way when the round plate is clicked. Held here until the round plate
  // is up, that late answer must not put the teardrop's study back on the round plate. It
  // did (a full run hit it by chance): the round plate kept the teardrop's study as the
  // active one, and the switch never settled.
  const studyHydrate = /\/api\/project\/hydrate\?.*simulation_id=/;
  let release = () => {};
  const held = new Promise((r) => {
    release = r;
  });
  const heldUrls = [];
  const hold = async (route) => {
    heldUrls.push(route.request().url());
    await held;
    await route.continue().catch(() => {});
  };
  await page.route(studyHydrate, hold);
  await s.timedSwitch(tear);
  await expect.poll(() => heldUrls.length).toBe(1);
  expect(heldUrls[0]).toContain(`simulation_id=${encodeURIComponent(tearStudy)}`);
  await s.timedSwitch(round);
  const landed = page.waitForResponse(studyHydrate);
  release();
  await landed;
  await page.unroute(studyHydrate, hold);
  for (let i = 0; i < 10; i++) {
    expect(await s.study(), `round plate after the late answer, check ${i}`).toEqual({ id: null, geom: null });
    await page.waitForTimeout(150);
  }
  expect(await s.shown()).toBe(round.id);
  await expect(page.locator('#geometries-list .geo-item.is-selected')).toHaveAttribute('data-geom-id', round.id);
  s.stage('a late setup answer leaves the round plate without a study');
  // A switch syncs the tree in three bursts (on the click or the study's activate answer,
  // on the geometry's activate answer, on the hydrate answer); one of them has several
  // syncs. A sync reads the tree at once when no read is out; the syncs that come while one
  // is out share one follow-up when it lands. So one switch reads the tree 4 times at most.
  // It used to send 8-10 reads, each waiting its turn on the one Python worker ahead of the
  // switch's hydrate. Both ways: onto the plate with a study and onto the one without.
  for (const g of [tear, round]) {
    const before = await s.treeReadsSettled();
    await s.pickGeometry(g);
    const reads = (await s.treeReadsSettled()) - before;
    s.stage(`switch to ${g.name}: ${reads} tree reads`);
    expect(reads, `tree reads for one switch to ${g.name}`).toBeGreaterThanOrEqual(1);
    expect(reads, `tree reads for one switch to ${g.name}`).toBeLessThanOrEqual(4);
    // The last read painted: onto the teardrop, its study is the active one in the tree.
    if (g === tear) await expect(page.locator(`#left-tree [data-w17-sim-id="${tearStudy}"] #btn-bcs-plus`)).toHaveCount(1);
  }
  await s.pickGeometry(tear);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  await s.pickGeometry(round);
  await expect.poll(s.study).toEqual({ id: null, geom: null });
  await s.pickGeometry(tear);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  s.stage('switching keeps geometry and study together');

  // gate:h11-multi-geometry-untouched: a plugin study belongs to the project, not a
  // geometry. Clicking it or switching geometry never moves the active core study.
  const made = await request.post('/api/plugin-studies/create', {
    data: { project_id: s.pid, plugin: 'study-demo', kind: 'demo_analysis', title: 'Demo 1' },
  });
  expect(made.ok(), await made.text()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
  const pluginStudy = page.locator('#plugin-studies-section [data-plugin-study] .tl', { hasText: 'Demo 1' });
  await expect(pluginStudy).toBeVisible();
  await pluginStudy.click();
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  await s.pickGeometry(round);
  await expect.poll(s.study).toEqual({ id: null, geom: null });
  await expect(pluginStudy).toBeVisible();
  await s.pickGeometry(tear);
  await expect.poll(s.study).toEqual({ id: tearStudy, geom: tear.id });
  await expect(pluginStudy).toBeVisible();
  s.stage('a plugin study leaves the geometry and study invariant alone');

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
