import { expect, test } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A body in a box whose sides are all one Freestream (the validation set's cylinder): the
// stream goes in and out through that one boundary, so its flow monitor reads the solve's
// round-off as its net flow (-3.9e-13 m³/s on the 2D cylinder at Re 20). The Graphs panel's
// flow balance line used to read "Flow in 3.910e-10 L/s · out 0 L/s · imbalance 100.00 %", as a
// warning, for a flow that loses nothing. With no opening that carries flow there is no
// balance line, and the boundary's own card still shows its values; a real inlet and outlet
// keep theirs (monitors-plugin-owned.spec.js). A jet blowing into such a box balances what
// leaves through the far field, though that outflow is as small against the far field's own
// speed as round-off (it read "Flow in 0.0200 m³/s · out 0 L/s · imbalance 100.00 %", as a
// warning, when the far field's net flow was taken as round-off on its own). An Area average
// on the body's faces monitors its wall's patch too: a wall is no opening and is left out of the
// balance, so there is still no balance line (its zero flow, not round-off, made the far field's
// round-off count: "Flow in 3.910e-10 L/s · out 0 L/s · imbalance 100.00 %" again). No WSL: a
// finished run whose case is the committed cavity plus the monitor files of its boundaries.
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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

/** postProcessing/<name>/0/surfaceFieldValue.dat as OpenFOAM writes it. */
function writeDat(caseDir, name, header, rows, area) {
  const dir = join(caseDir, 'postProcessing', name, '0');
  mkdirSync(dir, { recursive: true });
  const text =
    `# Region type : patch ${name}\n# Faces       : 576\n# Area        : ${area}\n# Time        \t${header}\n` +
    rows.map((r) => r + '\n').join('');
  writeFileSync(join(dir, 'surfaceFieldValue.dat'), text);
}

/** A project with the round test part, a study and a finished run whose case is the committed
 * cavity with these boundaries (`mapped`, `monitors`) and monitor files (`dats`:
 * [name, header, rows, area]); and how to open its Graphs panel. */
async function finishedRun(page, request, title, mapped, monitors, dats) {
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `${title} ${stamp()}`,
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

  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run A' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runs = (await json(request, q('/api/run/status', { simulation_id: sid }))).runs || [];
  const runDir = dirname(runs.find((r) => String(r.id) === rid).case_dir);
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
        rho: 1,
        mapped,
        monitors,
      },
      null,
      2,
    ),
  );
  for (const [name, header, rows, area] of dats) writeDat(caseDir, name, header, rows, area);
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      { ...rec, status: 'done', stage: 'done', has_results: true, n_saved_times: 1, iteration: 869, last_saved_iteration: 869, finished_at: new Date().toISOString(), case_dir: caseDir },
      null,
      2,
    ),
  );

  const openGraphs = async () => {
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
    const results = page.locator(`#left-tree [data-w27-run-results="${rid}"]`).first();
    const graphsRow = page.locator(`[data-w28-key="media:run:${rid}:graphs"] > .tree-row`).first();
    if (!(await graphsRow.isVisible())) await results.locator(':scope > .tree-row .tw').click();
    await graphsRow.click();
  };
  return { pid, sid, rid, q, ready, openGraphs };
}

const FAR_FIELD = { patch: 'far_field', name: 'Far field', bc_type: 'Freestream', faces: ['face 1@Body1', 'face 2@Body1'] };

test('a Freestream all round a body: no "imbalance 100 %" from its round-off net flow', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // What the cylinder's run wrote for its one Freestream ("Far field").
  const { sid, rid, q, ready, openGraphs } = await finishedRun(page, request, 'e2e freestream balance', [FAR_FIELD], ['far_field'], [
    ['mon_far_field', 'areaAverage(p)\tareaAverage(U)', ['868\t0.0057530\t(0.99781626 -4.6808847e-09 0)', '869\t0.0057529782\t(0.99781626 -4.6808847e-09 0)'], '8.500000e-03'],
    ['flow_far_field', 'sum(phi)', ['868\t-4.02e-13', '869\t-3.91048955e-13'], '8.500000e-03'],
  ]);
  const card = page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_far_field"]');
  const balance = page.locator('#run-graphs-balance');
  const seen = async () => {
    // The far field's card, with its values: the cards and the balance line are drawn together.
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.mon-card-name')).toHaveText('Far field');
    await expect(card.locator('.mon-card-last')).toContainText('m/s');
    expect(await balance.isHidden(), `the balance line reads: ${await balance.textContent()}`).toBe(true);
    expect(await balance.textContent()).toBe('');
    await expect(page.locator('#run-graphs-list')).not.toContainText('imbalance');
  };
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // After a reload, the same.
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // The route's answer: the boundary's net flow as it is, and no balance to judge.
  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: rid }));
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  expect(answer.monitors.map((m) => [m.key, m.last && m.last.Q_m3s])).toEqual([['mon_far_field', -3.91048955e-13]]);
  expect([answer.balance, answer.summary, answer.summary_warn]).toEqual([null, [], false]);
});

test('a jet blowing into a Freestream box: its flow balances what leaves through the far field', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // 0.02 m³/s from a 20 cm² jet leaves through 4000 m² of far field in a 30 m/s stream: 5e-6 m/s
  // across the far field, 1.7e-7 of its own speed.
  const jet = { patch: 'jet', name: 'Jet', bc_type: 'Velocity inlet', faces: ['face 3@Body1'] };
  const { sid, rid, q, ready, openGraphs } = await finishedRun(page, request, 'e2e jet balance', [FAR_FIELD, jet], ['far_field', 'jet'], [
    ['mon_far_field', 'areaAverage(p)\tareaAverage(U)', ['400\t0.0\t(30 0 0)'], '4.000000e+03'],
    ['flow_far_field', 'sum(phi)', ['400\t0.02'], '4.000000e+03'],
    ['mon_jet', 'areaAverage(p)\tareaAverage(U)', ['400\t0.0\t(0 10 0)'], '2.000000e-03'],
    ['flow_jet', 'sum(phi)', ['400\t-0.02'], '2.000000e-03'],
  ]);
  const balance = page.locator('#run-graphs-balance');
  const seen = async () => {
    await expect(page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_far_field"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_jet"]')).toBeVisible();
    await expect(balance).toBeVisible();
    await expect(balance).toHaveText('Flow in 0.0200 m³/s · out 0.0200 m³/s · imbalance < 0.01 %');
    await expect(balance).not.toHaveClass(/is-warn/);
  };
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // After a reload, the same.
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // The route's answer, which the Assistant reads too.
  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: rid }));
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  expect(answer.balance).toEqual({ in_m3s: 0.02, out_m3s: 0.02, imbalance: 0 });
  expect(answer.summary_warn).toBe(false);
});

test('an Area average on the body in a Freestream box: its wall is no opening, still no "imbalance 100 %"', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // The cylinder's run with an Area average monitor on the cylinder's faces: its wall's patch is
  // monitored too (U = 0 and no flow on every face), beside the far field's round-off net flow.
  const wall = { patch: 'cylinder', name: 'Cylinder', bc_type: 'Wall', wall_type: 'No-slip', faces: ['face 3@Body1'] };
  const { sid, rid, q, ready, openGraphs } = await finishedRun(page, request, 'e2e freestream wall balance', [FAR_FIELD, wall], ['far_field', 'cylinder'], [
    ['mon_far_field', 'areaAverage(p)\tareaAverage(U)', ['869\t0.0057529782\t(0.99781626 -4.6808847e-09 0)'], '8.500000e-03'],
    ['flow_far_field', 'sum(phi)', ['869\t-3.91048955e-13'], '8.500000e-03'],
    ['mon_cylinder', 'areaAverage(p)\tareaAverage(U)', ['869\t0.21\t(0 0 0)'], '1.570800e-04'],
    ['flow_cylinder', 'sum(phi)', ['869\t0'], '1.570800e-04'],
  ]);
  const balance = page.locator('#run-graphs-balance');
  const seen = async () => {
    // Both cards, with their values: the cards and the balance line are drawn together.
    await expect(page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_far_field"]')).toBeVisible({ timeout: 30_000 });
    const body = page.locator('#run-graphs-list .mon-card[data-monitor-key="mon_cylinder"]');
    await expect(body).toBeVisible();
    await expect(body.locator('.mon-card-name')).toHaveText('Cylinder');
    expect(await balance.isHidden(), `the balance line reads: ${await balance.textContent()}`).toBe(true);
    expect(await balance.textContent()).toBe('');
    await expect(page.locator('#run-graphs-list')).not.toContainText('imbalance');
  };
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // After a reload, the same.
  await page.reload();
  await ready();
  await openGraphs();
  await seen();
  // The route's answer, which the Assistant reads too.
  const answer = await json(request, q('/api/run/monitors', { simulation_id: sid, run_id: rid }));
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  expect(answer.monitors.map((m) => m.key)).toEqual(['mon_far_field', 'mon_cylinder']);
  expect([answer.balance, answer.summary, answer.summary_warn]).toEqual([null, [], false]);
});
