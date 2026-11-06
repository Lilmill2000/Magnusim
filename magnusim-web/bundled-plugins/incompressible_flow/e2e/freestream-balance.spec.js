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
// keep theirs (monitors-plugin-owned.spec.js). No WSL: a finished run whose case is the
// committed cavity plus the two monitor files that run wrote for its far field.
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

test('a Freestream all round a body: no "imbalance 100 %" from its round-off net flow', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e freestream balance ${stamp()}`,
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

  // A finished run with what the cylinder's run wrote for its one Freestream ("Far field").
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
        mapped: [{ patch: 'far_field', name: 'Far field', bc_type: 'Freestream', faces: ['face 1@Body1', 'face 2@Body1'] }],
        monitors: ['far_field'],
      },
      null,
      2,
    ),
  );
  writeDat(caseDir, 'mon_far_field', 'areaAverage(p)\tareaAverage(U)', ['868\t0.0057530\t(0.99781626 -4.6808847e-09 0)', '869\t0.0057529782\t(0.99781626 -4.6808847e-09 0)'], '8.500000e-03');
  writeDat(caseDir, 'flow_far_field', 'sum(phi)', ['868\t-4.02e-13', '869\t-3.91048955e-13'], '8.500000e-03');
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
