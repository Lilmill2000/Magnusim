import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_PROJECT_A, QUEUE_PROJECT_B } from './prepare-projects.js';
import { startHost } from './support/host-server.mjs';
import {
  computeQueue,
  createRun,
  getJson,
  meshRow,
  openRunPanel,
  plantCaseHolder,
  postJson,
  removeTestWslRoot,
  runRow,
  startMesh,
  waitSlotFree,
  wslProcessesUnder,
} from './support/compute-slot.js';
import { NO_WSL, wslBash } from './toolchain.js';

// H15, a core solve on the one compute slot (gate:h15-core-drain): Stop while the server
// starts a run (and before its Start was even sent) keeps it a draft; a Start right after
// starts normally; a forced stop holds the slot until the run's WSL processes are gone, and
// a Start of that run meanwhile is queued, never run beside them; a run whose relay died is
// "finishing" until its Stop ends it in WSL; a queued start that throws is tried three more
// times, then leaves the queue with a notice; a start the queue makes can be cancelled from
// the Run panel, a Start right after that cancel runs, and a cancel that reaches a run that
// had already started stops it without saying it never started. Its server holds every
// start 4 s (MAGNUSIM_TEST_START_HOLD_MS) so the starting phase can be seen.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const A = QUEUE_PROJECT_A;
const B = QUEUE_PROJECT_B;
const SIM = 'sim_1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('gate:h15-core-drain: core Stop while starting, draining and after a relay crash', async ({ page, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-drain +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const wslRoot = `/tmp/magnusim-e2e-h15-drain-${process.pid}/cases`;
  const host = await startHost({
    name: 'h15-drain',
    env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot, MAGNUSIM_TEST_START_HOLD_MS: '4000' },
    log: stage,
  });
  const { base, projects } = host;
  try {
    const queue = async () => (await computeQueue(request, { base })) || { items: [], busy: null, failed: [] };
    const busy = async () => (await queue()).busy || null;
    const row = (runId) => runRow(request, { base, projectId: A, runId });
    const queueTitle = () => page.locator('#btn-queue').getAttribute('title');
    const longRun = async (name) => {
      const rid = await createRun(request, { base, projectId: A, name });
      const u = await postJson(request, `${base}/api/run/update`, { project_id: A, simulation_id: SIM, run_id: rid, endTime: 100000, writeInterval: 100000 });
      expect(u.ok(), await u.text()).toBe(true);
      return rid;
    };
    const panelOf = (runId) => openRunPanel(page, { base, projectId: A, runId });
    const solving = async (runId, timeout = 600_000) => {
      await expect
        .poll(
          async () => {
            const r = await row(runId);
            if (/done|failed|stopped/.test(r.status || '')) return `ended ${r.status}: ${r.error || r.note || ''}`;
            return r.stage === 'solve' || Number(r.iteration || 0) > 0 ? 'solving' : `${r.status}/${r.stage}`;
          },
          { timeout, intervals: [2_000] },
        )
        .toBe('solving');
    };
    const caseCopy = (runId) => `${wslRoot}/cfddesk-w27-${runId}`;
    const notDraft = (r) => /running|failed|stopped|done/.test(String(r.status || ''));

    // A quick mesh in A.
    const meshed = await startMesh(request, A, { base, fineness: 1, quick: true });
    expect(meshed.status, JSON.stringify(meshed.body)).toBeLessThan(300);
    await expect
      .poll(async () => ((await meshRow(request, A, { base })).live_mesh_result || {}).status || 'wait', { timeout: 900_000, intervals: [3_000] })
      .toBe('done');
    await waitSlotFree(request, { base });
    stage('A meshed');

    // 1. Stop while the server starts it: a draft, not failed; nothing in WSL.
    const R = await longRun('Drain R');
    let panel = await panelOf(R);
    await panel.locator('[data-run-start]').click();
    const stopBtn = panel.locator('[data-run-stop="1"]');
    await expect(stopBtn).toBeVisible({ timeout: 2_000 });
    await expect(stopBtn).toHaveAttribute('title', 'Cancel this start');
    await stopBtn.click();
    await expect(panel).toContainText('Stopped before it started.', { timeout: 15_000 });
    await expect.poll(busy, { timeout: 3_000, intervals: [250] }).toBeNull();
    panel = await panelOf(R);
    expect(notDraft(await row(R)), JSON.stringify(await row(R))).toBe(false);
    expect(wslPathExistsSafe(caseCopy(R))).toBe(false);
    stage('1: stopped while the server started it; still a draft');

    // 1b. Stop before the Start is even sent (its settings save is held 3 s): no Start request.
    const starts = [];
    const onRequest = (r) => {
      if (new URL(r.url()).pathname === '/api/run/start') starts.push(r.url());
    };
    page.on('request', onRequest);
    const holdUpdate = async (route) => {
      await sleep(3_000);
      await route.continue().catch(() => {});
    };
    await page.route('**/api/run/update*', holdUpdate);
    await panel.locator('[data-run-start]').click();
    await sleep(300);
    await panel.locator('[data-run-stop="1"]').click({ timeout: 1_000 });
    const cancelledAt = Date.now();
    await expect(panel).toContainText('Stopped before it started.', { timeout: 15_000 });
    await sleep(1_000);
    expect(starts).toEqual([]);
    expect(await busy()).toBeNull();
    await page.unroute('**/api/run/update*', holdUpdate);
    page.off('request', onRequest);
    // Still a draft on the server (what a reload shows); the panel is not reopened, so the
    // next Start is clicked at once.
    expect(notDraft(await row(R))).toBe(false);
    stage('1b: stopped before the Start was sent; no Start request');

    // 2. Start again at once: it starts. Queue a mesh in B behind it.
    await panel.locator('[data-run-start]').click();
    // Inside the 10 s a server keeps a cancel that came before its Start (compute-slot.js).
    expect(Date.now() - cancelledAt, 'the second Start within 10 s of the cancel').toBeLessThan(10_000);
    await expect.poll(async () => (await busy())?.run_id || 'idle', { timeout: 30_000 }).toBe(R);
    await solving(R);
    await expect(panel).not.toContainText('Stopped before it started.');
    const queuedMesh = await startMesh(request, B, { base, fineness: 1, quick: true, queueIfBusy: true });
    expect(queuedMesh.status, JSON.stringify(queuedMesh.body)).toBeLessThan(300);
    await expect.poll(async () => (await queue()).items.map((r) => [r.kind, r.project_id])).toEqual([['mesh', B]]);
    stage('2: R solves; B mesh queued');

    // 3. Forced stop: the slot stays held (draining, "(stopping)") until R's WSL processes are gone.
    await panel.locator('[data-run-stop="1"]').click();
    await sleep(1_000);
    await panel.locator('[data-run-stop="1"]').click();
    let sawDraining = false;
    let sawStoppingTitle = false;
    for (let i = 0; i < 600; i++) {
      const q = await queue();
      const live = wslProcessesUnder(caseCopy(R));
      if (!live.length && q.busy?.kind !== 'solve') break;
      if (live.length) {
        expect(q.busy?.kind, `while R's processes live, poll ${i}`).toBe('solve');
        expect(q.items.map((r) => r.kind), `the mesh waits, poll ${i}`).toContain('mesh');
      }
      if (q.busy?.kind === 'solve' && q.busy.phase === 'draining') sawDraining = true;
      if (/\(stopping\)/.test(String(await queueTitle()))) sawStoppingTitle = true;
      await sleep(250);
    }
    expect(sawDraining, 'a poll saw the solve draining').toBe(true);
    expect(sawStoppingTitle, 'the Queue title said (stopping)').toBe(true);
    stage('3: the forced stop drained before the slot moved on');

    // While the mesh holds the slot, R's Start reads "Add to queue".
    panel = await panelOf(R);
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });

    // 4. The mesh runs with nothing of R left; then R runs once (one solve script).
    await expect.poll(async () => (await busy())?.kind || 'idle', { timeout: 120_000 }).toBe('mesh');
    expect(wslProcessesUnder(caseCopy(R))).toEqual([]);
    await expect.poll(async () => (await busy())?.run_id || (await busy())?.kind || 'idle', { timeout: 900_000, intervals: [3_000] }).toBe(R);
    await solving(R);
    expect(solveScripts(R)).toBe(1);
    panel = await panelOf(R);
    await panel.locator('[data-run-stop="1"]').click();
    await sleep(1_000);
    await panel.locator('[data-run-stop="1"]').click();
    await waitSlotFree(request, { base, timeoutMs: 180_000 });
    stage('4: R ran again after the mesh, one solve script; stopped');

    // 5. Relay crash, then Stop: "finishing" while the case copy lives, Stop ends it.
    const R5 = await longRun('Drain R5');
    panel = await panelOf(R5);
    await panel.locator('[data-run-start]').click();
    await solving(R5);
    plantCaseHolder(wslRoot, `cfddesk-w27-${R5}`);
    const pid = Number((await row(R5)).pid);
    expect(pid, JSON.stringify(await row(R5))).toBeGreaterThan(0);
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 10_000, intervals: [500] }).toBe(`solve/draining/${R5}`);
    await expect.poll(queueTitle, { timeout: 15_000 }).toMatch(/\(finishing\)/);
    await expect(panel.locator('[data-run-stop="1"]')).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < 10; i++) {
      expect((await busy())?.run_id, `held while R5's case copy lives, check ${i}`).toBe(R5);
      await sleep(1_000);
    }
    await panel.locator('[data-run-stop="1"]').click();
    await expect.poll(queueTitle, { timeout: 15_000 }).toMatch(/\(stopping\)/);
    await expect.poll(() => wslProcessesUnder(caseCopy(R5)), { timeout: 40_000, intervals: [2_000] }).toEqual([]);
    await expect.poll(busy, { timeout: 30_000 }).toBeNull();
    stage('5: R5 finishing after its relay died; its Stop ended it in WSL');

    // 6. A queued start that throws: three more tries, then it leaves the queue with a notice.
    const R6 = await longRun('Drain R6');
    const R7 = await longRun('Drain R7');
    panel = await panelOf(R7);
    await panel.locator('[data-run-start]').click();
    await solving(R7);
    const r6Folder = runFolder(projects, A, R6);
    expect(r6Folder, 'R6 run folder').toBeTruthy();
    const blocker = join(r6Folder, 'case');
    rmSync(blocker, { recursive: true, force: true });
    writeFileSync(blocker, 'not a folder\n');
    panel = await panelOf(R6);
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });
    await stopTwice(page, A, R7, { stayOn: R6 });
    // Every text the queue's notice toast shows from here on (this page load stays).
    await page.evaluate(() => {
      window.__h15Toasts = [];
      const el = document.getElementById('job-finish-toast');
      new MutationObserver(() => {
        if (el && !el.hidden && el.textContent) window.__h15Toasts.push(el.textContent);
      }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    });
    await waitSlotFreeAfter(R7);
    const freeAt = Date.now();
    const r6Name = (await row(R6)).name || 'Drain R6';
    await expect
      .poll(async () => (await queue()).items.some((r) => r.run_id === R6), { timeout: 60_000, intervals: [1_000] })
      .toBe(false);
    const fails = ((await queue()).failed || []).filter((f) => f.run_id === R6);
    expect(fails.map((f) => f.error)).toEqual(['Start failed on the server. See the server log']);
    const toast = `${r6Name} could not start from the queue: Start failed on the server. See the server log.`;
    await expect.poll(() => page.evaluate(() => window.__h15Toasts.slice()), { timeout: 20_000 }).toContain(toast);
    expect(Date.now() - freeAt).toBeLessThan(60_000);
    rmSync(blocker, { force: true });
    await waitSlotFree(request, { base, timeoutMs: 60_000 });
    stage('6: the start that threw was tried, then left the queue with its notice');

    // 7. Cancel a start the queue makes, from the Run panel.
    const R8 = await longRun('Drain R8');
    const R9 = await longRun('Drain R9');
    panel = await panelOf(R8);
    await panel.locator('[data-run-start]').click();
    await solving(R8);
    panel = await panelOf(R9);
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });
    await stopTwice(page, A, R8, { stayOn: R9 });
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 180_000, intervals: [250] }).toBe(`solve/starting/${R9}`);
    const cancel = panel.locator('[data-run-stop="1"][title="Cancel this start"]');
    await expect(cancel).toBeVisible({ timeout: 4_000 });
    await cancel.click();
    await expect(panel).toContainText('Stopped before it started.', { timeout: 5_000 });
    await expect.poll(busy, { timeout: 5_000, intervals: [250] }).toBeNull();
    const r9 = await row(R9);
    expect(notDraft(r9), JSON.stringify(r9)).toBe(false);
    expect((await queue()).items.some((r) => r.run_id === R9)).toBe(false);
    await page.locator('#btn-queue').click();
    await expect(page.locator('#job-queue-list li')).toHaveCount(0);
    await page.keyboard.press('Escape');
    panel = await panelOf(R9);
    expect(notDraft(await row(R9))).toBe(false);
    expect((await queue()).items.some((r) => r.run_id === R9)).toBe(false);
    await expect(panel.locator('[data-run-start]')).toHaveText('Start');
    stage('7: the queue start of R9 was cancelled from its panel; R9 is a draft');

    // 8. A Start clicked right after "Cancel this start", while the cancelled start still ends
    //    (the test hold), is queued behind it and then runs: never "This run is already solving.".
    const R10 = await longRun('Drain R10');
    const R11 = await longRun('Drain R11');
    panel = await panelOf(R10);
    await panel.locator('[data-run-start]').click();
    await solving(R10);
    panel = await panelOf(R11);
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });
    await stopTwice(page, A, R10, { stayOn: R11 });
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 180_000, intervals: [250] }).toBe(`solve/starting/${R11}`);
    const cancel11 = panel.locator('[data-run-stop="1"][title="Cancel this start"]');
    await expect(cancel11).toBeVisible({ timeout: 4_000 });
    await cancel11.click();
    await expect(panel).toContainText('Stopped before it started.', { timeout: 5_000 });
    const heldAtClick = await busy();
    const startAnswer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/run/start', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    const started = await startAnswer;
    const startBody = await started.json().catch(() => ({}));
    if (started.status() === 409) {
      // The cancelled start still held the slot: the server answers busy and the panel queues the Start.
      expect(startBody.code, JSON.stringify(startBody)).toBe('busy');
    }
    await expect.poll(async () => (await busy())?.run_id || 'idle', { timeout: 60_000, intervals: [500] }).toBe(R11);
    await solving(R11);
    await expect(panel).not.toContainText('This run is already solving.');
    stage(
      `8: Start right after the cancel ${started.status() === 409 ? 'was queued behind the cancelled start (409 busy)' : 'started at once'}` +
        ` (slot at the click: ${heldAtClick ? `${heldAtClick.kind}/${heldAtClick.phase}, stopping ${heldAtClick.stopping}` : 'free'}); R11 solves`,
    );

    // 9. "Cancel this start" that reaches the server after the run started (the panel's
    //    queue poll was old): it stops the run, and the panel never says it stopped before it
    //    started. The page is kept on the queue answer of R12's start until its Stop is sent.
    const R12 = await longRun('Drain R12');
    panel = await panelOf(R12);
    await expect(panel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await panel.locator('[data-run-start]').click();
    await expect(panel.locator('[data-run-start]')).toHaveText('Remove from queue', { timeout: 15_000 });
    let frozen = null;
    const freeze = async (route) => (frozen ? route.fulfill({ json: frozen }) : route.continue());
    await page.route('**/api/compute-queue?*', freeze);
    const unfreeze = (r) => {
      if (new URL(r.url()).pathname === '/api/run/stop') frozen = null;
    };
    page.on('request', unfreeze);
    await stopTwice(page, A, R11, { stayOn: R12 });
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 180_000, intervals: [250] }).toBe(`solve/starting/${R12}`);
    frozen = await getJson(request, `${base}/api/compute-queue?project_id=${encodeURIComponent(A)}`);
    expect(frozen.busy && frozen.busy.phase, JSON.stringify(frozen.busy)).toBe('starting');
    const cancel12 = panel.locator('[data-run-stop="1"][title="Cancel this start"]');
    await expect(cancel12).toBeVisible({ timeout: 10_000 });
    // The run starts on the server meanwhile (and solves, so its Stop is a clean one).
    await expect.poll(async () => {
      const b = await busy();
      return b ? `${b.kind}/${b.phase}/${b.run_id}` : 'idle';
    }, { timeout: 120_000, intervals: [500] }).toBe(`solve/running/${R12}`);
    await solving(R12);
    await expect(cancel12, 'the page still shows the start it saw').toBeVisible();
    const stopAnswer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/run/stop', { timeout: 30_000 });
    await cancel12.click();
    const stopBody = await (await stopAnswer).json();
    expect([stopBody.stopping, stopBody.cancelled], JSON.stringify(stopBody)).toEqual([true, undefined]);
    page.off('request', unfreeze);
    await page.unroute('**/api/compute-queue?*', freeze);
    // While it ends, the slot names it as stopping (the Queue title's "(stopping)").
    const b12 = await busy();
    if (b12 && b12.run_id === R12) expect(b12.stopping, JSON.stringify(b12)).toBe(true);
    await sleep(3_000);
    await expect(panel).not.toContainText('Stopped before it started.');
    // It ends stopped (the current step written), not a draft; still no "before it started".
    await expect.poll(async () => (await row(R12)).status, { timeout: 120_000, intervals: [2_000] }).toBe('stopped');
    await expect(panel).not.toContainText('Stopped before it started.');
    panel = await panelOf(R12);
    await expect(panel).not.toContainText('Stopped before it started.');
    await waitSlotFree(request, { base, timeoutMs: 180_000 });
    stage('9: a cancel that reached a started run stopped it; the panel said nothing about a start that never ran');

    async function waitSlotFreeAfter(runId) {
      await expect.poll(async () => (await busy())?.run_id === runId, { timeout: 180_000, intervals: [500] }).toBe(false);
    }
  } finally {
    writeFileSync(test.info().outputPath('host.log'), host.log());
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-drain] WSL root not removed: ${e.message}`);
    }
  }

  /** Click Stop twice on a run's panel (a forced stop). */
  async function stopTwice(p, projectId, runId, { stayOn = null } = {}) {
    const panel = await openRunPanel(p, { base, projectId, runId });
    await panel.locator('[data-run-stop="1"]').click();
    await sleep(1_000);
    await panel.locator('[data-run-stop="1"]').click();
    if (stayOn) await openRunPanel(p, { base, projectId, runId: stayOn, reload: false });
  }

  function wslPathExistsSafe(path) {
    const r = wslBash('[ -e "$1" ] && echo YES || echo NO', [path]);
    return String(r.stdout || '').trim() === 'YES';
  }

  /** How many top-level solve-<runId>.sh shells run in WSL (forked subshells not counted). */
  function solveScripts(runId) {
    const script = [
      'n=0',
      'for p in /proc/[0-9]*; do',
      '  c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue',
      '  case "$c" in *solve-scripts-count*) continue ;; esac',
      '  case "$c" in *"/solve-$1.sh"*) ;; *) continue ;; esac',
      '  pp=$(awk \'/^PPid:/ {print $2}\' "$p/status" 2>/dev/null)',
      '  pc=$(tr "\\0" " " < "/proc/$pp/cmdline" 2>/dev/null) || pc=""',
      '  case "$pc" in *"/solve-$1.sh"*) continue ;; esac',
      '  n=$((n+1))',
      'done',
      'echo "$n"',
    ].join('\n');
    const r = wslBash(script, [runId, 'solve-scripts-count'], 30_000);
    return Number(String(r.stdout || '').trim());
  }
});

/** A run's folder on Windows (simulation_runs/<Run>, found by its id.json). */
function runFolder(projects, projectId, runId) {
  const geoms = join(projects, projectId, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const runs = join(sims, s, 'simulation_runs');
      if (!existsSync(runs)) continue;
      for (const r of readdirSync(runs)) {
        const idp = join(runs, r, 'id.json');
        if (existsSync(idp) && JSON.parse(readFileSync(idp, 'utf8')).id === runId) return join(runs, r);
      }
    }
  }
  return null;
}
