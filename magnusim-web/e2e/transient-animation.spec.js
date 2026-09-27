import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_WSL } from './toolchain.js';

// A transient run's Animation steps through its saved time steps: opening it keeps the
// parts coloring (no particle trace, unlike a steady run), Play moves the field frame by
// frame, and while frames are still loading the viewport says so, even while another
// solve holds the job chip.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const ROUND = join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');

test('transient animation: time steps by default, plays while another solve runs, shows loading', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (m) => console.log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${m}`);

  // Requests still open at the end, with their age (a stuck frame shows here).
  const open = new Map();
  page.on('request', (req) => open.set(req, Date.now()));
  page.on('requestfinished', (req) => open.delete(req));
  page.on('requestfailed', (req) => open.delete(req));
  const dumpOpen = () => {
    for (const [req, at] of open) console.log(`OPEN ${Math.round((Date.now() - at) / 1000)}s ${req.method()} ${req.url().replace(/case=[^&]*/, 'case=…')}`);
  };
  await page.goto('/#/');
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async () =>
      (await window.__CFD_W16_CREATE__({ title: 'e2e transient animation', description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
  );
  const q = (path, extra = {}) => `${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const json = async (url) => {
    for (let i = 0; ; i++) {
      try {
        return await (await request.get(url)).json();
      } catch (e) {
        if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
      }
    }
  };
  await page.goto(`/#/p/${encodeURIComponent(pid)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 120_000 });
  const meta = await json(q('/api/geometry/cad', { part: 'preview' }));
  const near = (a, b) => Math.abs(a - b) < 0.5;
  const inlet = meta.faces.find((f) => near(f.centroid[1], 0) && near(f.normal[1], -1));
  const outlet = meta.faces.find((f) => near(f.centroid[1], 1500) && near(f.normal[1], 1));

  // A transient study: inlet 1 m/s, outlet 0 Pa, Air, default mesh.
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-time-dep [data-time-dep="Transient"]').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  const bcs = async () => (await json(q('/api/bcs', { simulation_id: sid }))).boundary_conditions || [];
  for (const [key, face, value, unit] of [['velocity_inlet', inlet.id, 1, 'm/s'], ['pressure_outlet', outlet.id, 0, 'Pa']]) {
    const n = (await bcs()).length;
    await page.locator('#btn-bcs-plus').click();
    await page.locator(`#panel-bc-picker .cfd-island [data-bc-key="${key}"]`).click();
    await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
    await expect.poll(async () => (await bcs()).length).toBe(n + 1);
    const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
    await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(f), face);
    await expect.poll(async () => (await bcs()).find((b) => b.id === id)?.faces, { timeout: 15_000 }).toEqual([`face ${face}@Body1`]);
    await page.evaluate(([bcId, v, u]) => window.__CFD_BC_UPDATE__(bcId, { value: v, unit: u }), [id, value, unit]);
  }
  await page.locator('#left-tree #btn-materials-plus').first().click();
  await page.locator('#panel-material-picker .cfd-island [data-volume="Body1"] button, #panel-air-material .cfd-island [data-volume="Body1"] button').first().click();
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
  await page.locator('#btn-create-mesh').click();
  await page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]').click();
  const meshDone = async () => {
    const tree = await json(q('/api/project/tree'));
    const m = ((tree.geometries || []).flatMap((g) => g.studies || []).find((s) => s.id === sid)?.meshes || [])[0] || {};
    return m.live_status || (m.generated ? 'done' : 'none');
  };
  await expect.poll(async () => (/done|failed|stopped/.test(await meshDone()) ? 'end' : 'waiting'), { timeout: 1_200_000, intervals: [5_000] }).toBe('end');
  expect(await meshDone()).toBe('done');
  stage('mesh done');

  const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const runs = async () => (await json(q('/api/run/status', { simulation_id: sid }))).runs || [];
  const openRun = async (rid) => {
    const row = page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first();
    if (!(await row.isVisible())) {
      const folder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
      if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
        await folder.locator(':scope > .tree-row .tw').click();
      }
    }
    if ((await runPanel.getAttribute('data-run-id').catch(() => null)) !== rid || !(await runPanel.isVisible())) await row.click();
    await expect(runPanel).toHaveAttribute('data-run-id', rid);
  };
  const setTransient = async (simTime, frames) => {
    await expect(runPanel.locator('[data-run-transient]')).toBeVisible();
    const st = runPanel.getByLabel('Simulation time', { exact: true });
    await st.fill(String(simTime));
    await st.press('Enter');
    const fr = runPanel.getByLabel('Result frames', { exact: true });
    await fr.fill(String(frames));
    await fr.press('Enter');
  };
  const runTo = async (rid, want, timeout = 1_800_000) => {
    await expect
      .poll(async () => {
        const st = (await runs()).find((r) => r.id === rid)?.status || 'none';
        return want.test(st) || /done|failed|stopped/.test(st) ? st : 'waiting';
      }, { timeout, intervals: [5_000] })
      .not.toBe('waiting');
    expect((await runs()).find((r) => r.id === rid)?.status).toMatch(want);
  };

  // Run 1: a short transient with 8 saved frames.
  const run1 = (await runs())[0].id;
  await openRun(run1);
  await setTransient(0.04, 8);
  await expect(runPanel.locator('[data-run-transient-hint]')).toContainText('(8 frames)');
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runPanel.locator('[data-run-start]').click();
  await runTo(run1, /^done$/);
  const n1 = (await runs()).find((r) => r.id === run1)?.n_saved_times || 0;
  stage(`run 1 done: ${n1} saved times`);
  expect(n1).toBeGreaterThanOrEqual(4);

  // Run 2 solves (long) in the background, holding the viewport job chip.
  await page.locator(`#left-tree [data-w17-sim-id="${sid}"] [data-w27-sim-control="1"] > .tree-row .tl`).first().click();
  await page.locator('#sim-new-run-name').fill('Run 2');
  await page.locator('#btn-create-run').click();
  // Run creation is a worker round trip, slow right after a solve: allow it time.
  await expect.poll(async () => (await runs()).map((r) => r.name), { timeout: 30_000 }).toContain('Run 2');
  const run2 = (await runs()).find((r) => r.name === 'Run 2').id;
  await openRun(run2);
  await setTransient(10, 20);
  await expect(runPanel.locator('[data-run-start]')).toBeEnabled({ timeout: 60_000 });
  await runPanel.locator('[data-run-start]').click();
  await runTo(run2, /^running$/, 300_000);
  stage('run 2 running');

  // Run 1's results, colored by velocity magnitude on the parts.
  await page.locator(`#left-tree [data-w27-run="${run1}"] > .tree-row .tl`).first().click();
  await page.locator(`#left-tree [data-w27-run-results="${run1}"] > .tree-row .tl`).first().click();
  await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 180_000 });
  await expect.poll(() => page.evaluate(() => window.__CFD_W6__?.field), { timeout: 120_000 }).toBe('magU');
  const partsStyle = page.locator('#parts-style');
  const styleBefore = await partsStyle.inputValue();
  expect(styleBefore).toBe('field');
  stage('results open');

  // Animation on a transient run: Time Step, no particle trace, coloring kept.
  await page.locator('.tb-btn[data-label="Animation"]').click();
  await expect(page.locator('#anim-block')).toBeVisible();
  await expect(page.locator('#anim-type')).toHaveValue('Time Step');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => !!window.__CFD_W8__?.enabled)).toBe(false);
  await expect(page.locator('.tb-btn[data-label="Particle Trace"]')).not.toHaveClass(/is-active/);
  await expect(partsStyle).toHaveValue('field');

  // Play: frames move through the saved times. Until a frame is in, the viewport says
  // frames are loading (the job chip keeps showing Run 2).
  const animChip = page.locator('#viewport-anim-chip');
  const timeline = [];
  const sample = async () => {
    const s = await page.evaluate(() => ({
      t: window.__CFD_W12__?.time,
      playing: !!window.__CFD_W12__?.anim_state?.playing,
      chip: (() => {
        const c = document.getElementById('viewport-anim-chip');
        return c && !c.hidden ? c.textContent.replace(/\s+/g, ' ').trim() : '';
      })(),
      job: (() => {
        const c = document.getElementById('viewport-job-chip');
        return c && !c.hidden ? c.textContent.replace(/\s+/g, ' ').trim() : '';
      })(),
      note: document.getElementById('anim-map-note')?.textContent || '',
    }));
    const last = timeline[timeline.length - 1];
    const key = JSON.stringify({ ...s, job: s.job.replace(/\d+:\d+.*$/, '') });
    if (!last || last.key !== key) timeline.push({ ms: Date.now() - t0, key, ...s });
    return s;
  };
  // Start from a cold cache, as right after opening results.
  await page.evaluate(() => window.__CFD_ANIM_DROP_FRAMES__ && window.__CFD_ANIM_DROP_FRAMES__());
  const playAt = Date.now();
  await page.locator('#anim-play').click();
  const seen = new Set();
  let loadingShown = false;
  while (Date.now() - playAt < 120_000 && seen.size < 4) {
    const s = await sample();
    if (s.chip && /Loading/i.test(s.chip)) loadingShown = true;
    if (s.playing && s.t != null) seen.add(String(s.t));
    await page.waitForTimeout(100);
  }
  for (const e of timeline) console.log(`TL +${Math.round(e.ms / 100) / 10}s t=${e.t} playing=${e.playing} chip="${e.chip}" job="${e.job}" note="${e.note}"`);
  expect(seen.size, 'Play shows several time steps').toBeGreaterThanOrEqual(4);
  const firstMove = timeline.find((e) => e.playing && e.t != null && e.t !== timeline[0].t);
  const waited = firstMove ? firstMove.ms - (playAt - t0) : Infinity;
  stage(`first frame change ${waited} ms after Play; loading chip shown: ${loadingShown}`);
  // Any wait before the first frame is announced in the viewport.
  if (waited > 1000) expect(loadingShown, 'a wait before playing is shown as loading').toBe(true);
  // The job chip still shows the running solve, worded once.
  expect(timeline.some((e) => /Solving|Run 2/.test(e.job))).toBe(true);
  expect(timeline.filter((e) => /Solving Solving/.test(e.job)).map((e) => e.job)).toEqual([]);
  await page.locator('#anim-pause').click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W12__?.anim_state?.playing)).toBe(false);
  // Frames still coming in after Pause keep the chip up until they are all in memory.
  // (A frame request the data worker never received used to hang here for good.)
  const chipGone = await animChip.waitFor({ state: 'hidden', timeout: 60_000 }).then(() => true, () => false);
  if (!chipGone) dumpOpen();
  expect(chipGone, 'every frame loads (the chip goes)').toBe(true);
  await expect(page.locator('#anim-map-note')).toContainText(/frames/);
  await expect(partsStyle).toHaveValue('field');

  // Stop run 2.
  await openRun(run2);
  await runPanel.locator('[data-run-stop="1"]').click();
  await runTo(run2, /^stopped$/, 300_000);
  stage('run 2 stopped');
});
