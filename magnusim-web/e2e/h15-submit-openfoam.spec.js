import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEOMETRY_REMOVE_IDS, GEOMETRY_REMOVE_PROJECT, QUEUE_PROJECT_A } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import {
  computeQueue,
  createRun,
  foamRecords,
  getJson,
  killFoamRelays,
  openRunPanel,
  removeTestWslRoot,
  startMesh,
  wslProcessesUnder,
} from './support/compute-slot.js';
import { NO_WSL, wslBash, wslPathExists } from './toolchain.js';

// H15, a plugin's OpenFOAM case as the user meets it (gate:h15-submit-openfoam, and the UI
// half of gate:h15-app-allowlist). The Foam demo workspace writes the lid-driven cavity in
// its study and runs it through the host: refused apps and paths never reach WSL; the case
// waits for a core mesh on the one compute slot, then runs its blockMesh step and solves with
// residuals; while it runs nothing else starts and its project, study and files cannot be
// deleted or changed; a reopened page finds it and stops it with frames saved; a case runs
// once; a parallel span runs with mpirun (or serially on one rank); a failing step says so;
// turning another plugin on stops nothing, turning Foam demo off or reloading plugins stops
// its case once with a notice and drops its queued ones, also during a submit; a finished
// case opens in 3D with no core study active. A second app server with the foam fixture plugins.
const WSL = (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1';
const PROJECT = GEOMETRY_REMOVE_PROJECT;
const KEY = 'foam-demo';
const NAME = 'Foam demo';
const MESH_FINENESS = Number(process.env.MAGNUSIM_E2E_H15_FINENESS || 5);
// A case that runs for minutes (the cavity solves about 10 s of its time a second), a frame every 50.
const LONG = { end: 5000, write: 50 };

test('gate:h15-submit-openfoam and gate:h15-app-allowlist: a plugin case on the one compute slot', async ({ page, browser, request }) => {
  test.skip(!WSL, NO_WSL);
  test.setTimeout(3_600_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const stage = (msg) => console.log(`[h15-submit +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
  const tmp = e2eTemp('h15-submit');
  const wslRoot = `/tmp/magnusim-e2e-h15-submit-${process.pid}/cases`;
  const hookLog = join(tmp, 'hooks.log');
  const host = await startHost({
    name: 'h15-submit',
    tmp,
    pluginsFrom: 'python/tests/fixtures/foam-plugins',
    env: { MAGNUSIM_WSL_PRUNE: '0', MAGNUSIM_WSL_CASE_ROOT: wslRoot, MAGNUSIM_TEST_HOOK_LOG: hookLog },
    log: stage,
  });
  const { base, projects } = host;
  // A second window (its own context, so it is a page of its own in front) for the core
  // project and Home while the workspace stays open in the first.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  page2.setDefaultTimeout(30_000);
  try {
    const queue = () => computeQueue(request, { base });
    const busy = async () => ((await queue()) || {}).busy || null;
    const reload = () => request.post(`${base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
    const plugin = async (key, on) => {
      const r = await request.post(`${base}/api/plugins/${key}/${on ? 'enable' : 'disable'}`);
      expect(r.ok(), await r.text()).toBe(true);
      await reload();
    };

    // 0. Foam idle starts off (step 11 turns it on).
    await plugin('foam-idle', false);

    // 1. A Cavity case study, from the Workspaces menu.
    await page.goto(`${base}/#/p/${PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    await page.locator('#btn-workspaces').click();
    await page.locator(`[data-ws-new="${KEY}:cavity_case"]`).click();
    await expect(page.locator('#pm-input')).toHaveValue('Cavity case 1');
    await page.locator('#pm-confirm').click();
    const overlay = page.locator('#workspace-overlay');
    await expect(overlay).toBeVisible();
    await expect(page).toHaveURL(/\/ws\/foam-demo\/cavity\/st-[a-z0-9-]+$/);
    const sid = /\/ws\/foam-demo\/cavity\/(st-[a-z0-9-]+)$/.exec(page.url())[1];
    const studyDir = join(projects, PROJECT, 'plugins', KEY, 'studies', sid);
    const caseDir = (rel) => join(studyDir, ...rel.split('/'));
    const frame = page.frameLocator('#workspace-frame');
    const inFrame = () => page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
    const ready = async () => {
      await expect(frame.locator('body[data-ready="1"]')).toHaveCount(1, { timeout: 60_000 });
    };
    await ready();
    const cav = () => inFrame().evaluate(() => JSON.parse(JSON.stringify(window.__cavity)));
    const fill = async (o) => {
      const set = { case: o.caseRel, 'end-time': o.end ?? 0.5, 'write-interval': o.write ?? 0.1, app: o.app ?? 'pimpleFoam', 'n-procs': o.nProcs ?? 1, pre: o.pre ?? 'blockMesh' };
      for (const [id, v] of Object.entries(set)) await frame.locator(`#${id}`).fill(String(v));
      await frame.locator('#broken').setChecked(!!o.broken);
    };
    const writeCase = async (o) => {
      await fill(o);
      await frame.locator('#write').click();
      await expect(frame.locator('#status')).toHaveText('written', { timeout: 30_000 });
    };
    // Run: the submit's answer (or refusal) is in window.__cavity.lastSubmit.
    const run = async (o) => {
      await fill(o);
      await inFrame().evaluate(() => {
        window.__cavity.lastSubmit = null;
      });
      await frame.locator('#run').click();
      await expect.poll(async () => (await cav()).lastSubmit, { timeout: 60_000 }).not.toBeNull();
      return (await cav()).lastSubmit;
    };
    const events = async () => (await cav()).events || [];
    const ended = async (timeout) => {
      await expect.poll(async () => (await events()).find((e) => e.event === 'end') || null, { timeout, intervals: [2_000] }).not.toBeNull();
      return (await events()).find((e) => e.event === 'end');
    };
    const waitStage = async (want, timeout = 600_000) => {
      await expect
        .poll(
          async () => {
            const ev = await events();
            if (ev.some((e) => e.event === 'end')) return `ended: ${JSON.stringify(ev.find((e) => e.event === 'end'))}`;
            return ev.some((e) => e.event === 'stage' && e.stage === want) ? want : 'waiting';
          },
          { timeout, intervals: [2_000] },
        )
        .toBe(want);
    };
    const statusOf = async (jobId) =>
      (await getJson(request, `${base}/api/plugin-cases/status?project_id=${PROJECT}&plugin=${KEY}&study_id=${sid}&job_id=${jobId}`)).job || {};
    const noFoamRows = async () => ((await queue()).items || []).filter((r) => r.kind === 'foam');
    stage(`study ${sid} open in its workspace`);

    // 2. Refused before anything is queued or reaches WSL: an app that is not a plain
    // registered solver name, and a case path with a placeholder.
    await writeCase({ caseRel: 'cases/c0' });
    for (const app of ['simpleFoam; rm -rf ~', 'icoFoam']) {
      const r = await run({ caseRel: 'cases/c0', app });
      expect(r.code, JSON.stringify(r)).toBe('app_not_allowed');
      await expect(frame.locator('#error')).toContainText('app_not_allowed');
    }
    const placeholder = await run({ caseRel: 'cases/__APP__' });
    expect(placeholder.code, JSON.stringify(placeholder)).toBe('invalid_path');
    await expect(frame.locator('#error')).toContainText('invalid_path');
    expect(((await queue()).items || []).length).toBe(0);
    expect(await busy()).toBeNull();
    const pfInRoot = () => String(wslBash('ls -1 "$1" 2>/dev/null || true', [wslRoot]).stdout || '').split('\n').filter((n) => n.startsWith('cfddesk-pf-'));
    expect(pfInRoot()).toEqual([]);
    stage('app and path refusals: nothing queued, nothing in WSL');

    // 3. A core mesh in another project holds the slot.
    const meshed = await startMesh(request, QUEUE_PROJECT_A, { base, fineness: MESH_FINENESS });
    expect(meshed.status, JSON.stringify(meshed.body)).toBeLessThan(300);
    await expect.poll(async () => (await busy())?.kind || 'idle', { timeout: 60_000 }).toBe('mesh');
    stage(`a core mesh runs in ${QUEUE_PROJECT_A} (fineness ${MESH_FINENESS})`);

    // 4. The case queues behind it; the Queue menu shows both.
    await writeCase({ caseRel: 'cases/c1', ...LONG });
    const c1 = await run({ caseRel: 'cases/c1', ...LONG });
    expect(c1.id, JSON.stringify(c1)).toMatch(/^fc-/);
    expect(c1.existing).toBe(false);
    expect(c1.ahead).toBeGreaterThanOrEqual(1);
    await expect(frame.locator('#status')).toHaveText('queued');
    expect((await busy())?.kind, 'the mesh must still run for this step to mean anything').toBe('mesh');
    await page.locator('#btn-queue').click();
    await expect(page.locator('#job-queue-now')).toHaveText('Running: Mesh 1 in Queue project A');
    await expect(page.locator('#job-queue-list')).toContainText('Cavity case 1 · c1 · Foam demo');
    await page.keyboard.press('Escape');
    stage(`c1 queued behind the mesh (ahead ${c1.ahead})`);

    // 5. When the mesh ends, the case starts: its blockMesh step, then the solver with residuals.
    await expect.poll(async () => (await busy())?.kind || 'idle', { timeout: 1_200_000, intervals: [3_000] }).toBe('foam');
    stage('the mesh ended; c1 holds the slot');
    await waitStage('solve');
    await expect
      .poll(async () => (await events()).filter((e) => e.event === 'progress' && Object.keys(e.residuals || {}).some((k) => /^U/.test(k))).length, {
        timeout: 300_000,
        intervals: [2_000],
      })
      .toBeGreaterThanOrEqual(3);
    const ev5 = await events();
    const order = ev5.map((e) => (e.event === 'stage' ? `stage:${e.stage}` : e.event === 'pre' ? `pre:${e.tool}:${e.exit_code}` : e.event));
    expect(order.indexOf('start')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stage:pre_copy_in')).toBeGreaterThan(order.indexOf('start'));
    expect(order.indexOf('pre:blockMesh:0')).toBeGreaterThan(order.indexOf('stage:pre_copy_in'));
    expect(order.indexOf('stage:solve')).toBeGreaterThan(order.indexOf('pre:blockMesh:0'));
    expect(existsSync(join(caseDir('cases/c1'), 'constant', 'polyMesh', 'owner'))).toBe(true);
    expect(existsSync(join(caseDir('cases/c1'), 'log.blockMesh.1'))).toBe(true);
    stage('c1 solves: start, pre_copy_in, blockMesh 0, solve, residuals');

    // 6. While it runs: nothing else starts, and its project, study and files stay.
    const draft = await createRun(request, { base, projectId: QUEUE_PROJECT_A, name: 'H15 waits' });
    const runPanel = await openRunPanel(page2, { base, projectId: QUEUE_PROJECT_A, runId: draft });
    await expect(runPanel.locator('[data-run-start]')).toHaveText('Add to queue', { timeout: 30_000 });
    await page2.goto(`${base}/#/`);
    await page2.locator(`.home-card[data-project-id="${PROJECT}"]`).click();
    await page2.locator('#home-delete-project').click();
    await expect(page2.locator('#modal-delete-project')).toBeVisible();
    await page2.locator('#dp-confirm').click();
    await expect(page2.locator('#dp-copy')).toContainText('cannot be undone');
    await page2.locator('#dp-confirm').click();
    await expect(page2.locator('#dp-copy')).toHaveText('A plugin case in this project is running. Stop it before deleting the project.', {
      timeout: 30_000,
    });
    await page2.locator('#dp-cancel').click();
    expect(((await getJson(request, `${base}/api/projects`)).projects || []).some((p) => p.id === PROJECT)).toBe(true);
    await page2.goto(`${base}/#/p/${PROJECT}`);
    await page2.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    await page2.locator(`#plugin-studies-section [data-plugin-study="${sid}"] [data-plugin-study-act="delete"]`).click();
    await expect(page2.locator('#cf-heading')).toHaveText('Delete study?');
    await page2.locator('#cf-confirm').click();
    await expect(page2.locator('#cf-heading')).toHaveText('Delete failed', { timeout: 30_000 });
    await expect(page2.locator('#cf-copy')).toHaveText('A case of this study is running. Stop it before deleting the study.');
    await page2.locator('#cf-confirm').click();
    const busyFiles = await inFrame().evaluate(async (s) => {
      const ws = window.__ws;
      const code = (p) => p.then(() => 'allowed', (e) => e.code);
      return {
        deleteAbove: await code(ws.files.delete(`studies/${s}/cases`, { recursive: true })),
        writeOtherCase: await code(ws.files.write(`studies/${s}/CASES/C1/0/U`, 'x')),
      };
    }, sid);
    expect(busyFiles).toEqual({ deleteAbove: 'busy', writeOtherCase: 'busy' });
    const dataWrite = await request.post(`${base}/api/plugin-data/write`, {
      data: { project_id: PROJECT, plugin: KEY, rel: `studies/${sid}/cases/c1/x.json`, doc: { a: 1 } },
    });
    expect(dataWrite.status()).toBe(409);
    expect((await dataWrite.json()).code).toBe('busy');
    expect(existsSync(caseDir('cases/c1'))).toBe(true);
    stage('while c1 runs: Add to queue, project and study delete refused, its files busy');

    // 7. A reopened page finds its case; Stop saves a frame and ends it, and nothing is left in WSL.
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/cavity/${sid}`);
    await page.reload();
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await ready();
    await expect(frame.locator('#job')).toHaveText(c1.id);
    await expect(frame.locator('#status')).toHaveText('running');
    const listed = await inFrame().evaluate(() => window.__ws.compute.list());
    expect(listed.find((j) => j.id === c1.id)?.status).toBe('running');
    await frame.locator('#stop').click();
    await expect(frame.locator('#stage')).toHaveText('stopping', { timeout: 30_000 });
    await expect.poll(() => page.locator('#btn-queue').getAttribute('title'), { timeout: 30_000 }).toMatch(/\(stopping\)/);
    const end1 = await ended(90_000);
    expect(end1.status, JSON.stringify(end1)).toBe('stopped');
    expect(end1.result.savedTimes.length, JSON.stringify(end1.result)).toBeGreaterThanOrEqual(1);
    expect(Number(end1.result.lastSaved)).toBeLessThan(LONG.end);
    await expect.poll(() => wslProcessesUnder(wslRoot), { timeout: 60_000, intervals: [3_000] }).toEqual([]);
    const hooks = existsSync(hookLog) ? readFileSync(hookLog, 'utf8') : '';
    expect(hooks.split('\n').some((l) => l.startsWith('plugin ') && l.includes('Solving for')), hooks.slice(0, 400)).toBe(true);
    stage(`c1 stopped with ${end1.result.savedTimes.length} saved frames (last ${end1.result.lastSaved}); WSL clean; hook lines seen`);

    // 8. A case runs once.
    const again = await run({ caseRel: 'cases/c1' });
    expect(again.code, JSON.stringify(again)).toBe('has_results');

    // 9. A parallel span (r5's table): decomposePar, renumberMesh in parallel, reconstructParMesh.
    await writeCase({ caseRel: 'cases/c2', end: 0.5, write: 0.1 });
    const c2 = await run({
      caseRel: 'cases/c2',
      end: 0.5,
      write: 0.1,
      nProcs: 2,
      pre: 'blockMesh, decomposePar, renumberMesh*, reconstructParMesh, checkMesh',
    });
    expect(c2.id, JSON.stringify(c2)).toMatch(/^fc-/);
    const end2 = await ended(600_000);
    expect(end2.status, JSON.stringify(end2)).toBe('done');
    expect(end2.result.savedTimes).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    const ev9 = await events();
    const ranks = ev9.find((e) => e.event === 'ranks');
    const pre9 = (tool) => ev9.find((e) => e.event === 'pre' && e.tool === tool) || {};
    if (ranks && ranks.n_procs === 2) {
      expect(pre9('renumberMesh')).toMatchObject({ parallel: true, n_procs: 2, exit_code: 0 });
    } else {
      expect(pre9('decomposePar').skipped).toBe(true);
      expect(pre9('reconstructParMesh').skipped).toBe(true);
    }
    expect(readFileSync(join(caseDir('cases/c2'), '0.5', 'U'), 'utf8')).toMatch(/^\s*format\s+binary;/m);
    expect(existsSync(join(caseDir('cases/c2'), 'log.renumberMesh.3'))).toBe(true);
    expect(readdirSync(caseDir('cases/c2')).filter((n) => n.startsWith('processor'))).toEqual([]);
    const rec2 = foamRecords(projects).find((r) => r.id === c2.id);
    expect(rec2 && rec2.wsl_case).toMatch(/^cfddesk-pf-foam-demo-/);
    expect(wslPathExists(`${wslRoot}/${rec2.wsl_case}`)).toBe(false);
    stage(`c2 done on ${ranks ? ranks.n_procs : '?'} ranks: 5 binary frames, renumberMesh ${JSON.stringify(pre9('renumberMesh'))}`);

    // 10. A step that fails ends the case and names its log.
    await writeCase({ caseRel: 'cases/c5', broken: true });
    await run({ caseRel: 'cases/c5', broken: true });
    const end5 = await ended(300_000);
    expect(end5.status).toBe('failed');
    expect(end5.error).toMatch(/^blockMesh failed \(exit \d+\)\. See log\.blockMesh\.1 in the case folder$/);
    await frame.locator('#broken').setChecked(false);
    stage(`c5 failed: ${end5.error}`);

    // 11. Turning another plugin on stops nothing.
    await writeCase({ caseRel: 'cases/c3', ...LONG });
    const c3 = await run({ caseRel: 'cases/c3', ...LONG });
    await waitStage('solve');
    await page.evaluate(() => {
      // Every text the queue's notice toast shows from here on.
      window.__h15Toasts = [];
      const el = document.getElementById('job-finish-toast');
      const seen = () => {
        if (el && !el.hidden && el.textContent) window.__h15Toasts.push(el.textContent);
      };
      new MutationObserver(seen).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    });
    await page.locator('#wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const idleRow = wizard.locator('[data-plugin-key="foam-idle"]');
    await expect(idleRow).toHaveAttribute('data-plugin-status', 'disabled');
    await idleRow.locator('[data-plugin-toggle="foam-idle"]').click();
    await expect(idleRow).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
    for (let i = 0; i < 15; i++) {
      expect((await statusOf(c3.id)).status, `c3 after Foam idle went on, check ${i}`).toBe('running');
      expect(((await queue()).failed || []).filter((f) => f.kind === 'foam'), `queue notices, check ${i}`).toEqual([]);
      expect(await page.evaluate(() => window.__h15Toasts.length)).toBe(0);
      await page.waitForTimeout(1_000);
    }
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    stage('Foam idle on: c3 kept running, no notice');

    // 12. Turning Foam demo off stops its running case once and drops its queued one.
    await writeCase({ caseRel: 'cases/c4' });
    const c4 = await run({ caseRel: 'cases/c4' });
    expect((await statusOf(c4.id)).status).toBe('queued');
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const demoRow = wizard.locator(`[data-plugin-key="${KEY}"]`);
    await demoRow.locator(`[data-plugin-toggle="${KEY}"]`).click();
    await expect(demoRow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 });
    await expect.poll(async () => (await statusOf(c3.id)).status, { timeout: 120_000, intervals: [2_000] }).toBe('stopped');
    expect((await statusOf(c3.id)).error).toBe(`Stopped: ${NAME} was turned off`);
    expect((await statusOf(c4.id)).status).toBe('stopped');
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    // The toasts the user sees: both notices of this one change, in turn, each once.
    const c3Toast = `Cavity case 1 · c3 · ${NAME} was stopped: ${NAME} was turned off.`;
    const c4Toast = `Cavity case 1 · c4 · ${NAME} was taken off the queue: ${NAME} was turned off.`;
    await expect.poll(() => page.evaluate(() => window.__h15Toasts.slice()), { timeout: 30_000 }).toContain(c4Toast);
    await page.waitForTimeout(3_000);
    const toasts = await page.evaluate(() => window.__h15Toasts.slice());
    expect(toasts.filter((t) => t.includes('· c3 ·')), `exactly one toast for c3: ${JSON.stringify(toasts)}`).toEqual([c3Toast]);
    expect(toasts.filter((t) => t.includes('· c4 ·')), JSON.stringify(toasts)).toEqual([c4Toast]);
    const failed = ((await queue()).failed || []).filter((f) => f.kind === 'foam');
    expect(failed.filter((f) => f.job_id === c3.id).length).toBe(1);
    expect(failed.filter((f) => f.job_id === c4.id).map((f) => f.reason)).toEqual(['dropped']);
    const rec3 = foamRecords(projects).find((r) => r.id === c3.id);
    expect(rec3.stop).toMatchObject({ by: 'plugin_off', level: 'graceful' });
    expect(await noFoamRows()).toEqual([]);
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    expect((await statusOf(c3.id)).status).toBe('stopped');
    stage('Foam demo off: c3 stopped once with its notice, c4 dropped');

    // 13. Turned off during a submit (waiting on the plugin lane): plugin_off, nothing queued.
    await plugin(KEY, true);
    const wrote = await request.post(`${base}/api/plugin/${KEY}/write_cavity`, {
      data: { project_id: PROJECT, case: 'cases/c6', study_id: sid, end_time: 0.5, write_interval: 0.1 },
    });
    expect(wrote.ok(), await wrote.text()).toBe(true);
    const slow = request.post(`${base}/api/plugin/${KEY}/slow`, { data: { project_id: PROJECT, seconds: 20 }, timeout: 60_000 });
    await page.waitForTimeout(500);
    const submit = request.post(`${base}/api/plugin-cases/submit?project_id=${PROJECT}`, {
      data: {
        project_id: PROJECT,
        plugin: KEY,
        study_id: sid,
        case_rel: 'cases/c6',
        app: 'pimpleFoam',
        pre: [{ tool: 'blockMesh' }],
        results: { rho: 1, kinematicFields: ['p'] },
      },
      timeout: 90_000,
    });
    await page.waitForTimeout(1_500);
    const off = await request.post(`${base}/api/plugins/${KEY}/disable`, { timeout: 90_000 });
    expect(off.ok(), await off.text()).toBe(true);
    const answer = await submit;
    const body13 = await answer.json();
    expect([answer.status(), body13.code], JSON.stringify(body13)).toEqual([404, 'plugin_off']);
    await slow.catch(() => undefined);
    expect(await noFoamRows()).toEqual([]);
    expect(foamRecords(projects).some((r) => r.case_rel === 'cases/c6')).toBe(false);
    stage(`turned off during a submit: ${body13.error}`);

    // 14. The Reload button stops the running case.
    await plugin(KEY, true);
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/cavity/${sid}`);
    await page.reload();
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await ready();
    await writeCase({ caseRel: 'cases/c7', ...LONG });
    const c7 = await run({ caseRel: 'cases/c7', ...LONG });
    await waitStage('solve');
    await page.locator('#wb-prefs').click();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    await wizard.locator('[data-plugins-reload]').click();
    await expect.poll(async () => (await statusOf(c7.id)).status, { timeout: 120_000, intervals: [2_000] }).toBe('stopped');
    expect((await statusOf(c7.id)).error).toBe('Stopped: plugins were reloaded');
    await expect(wizard.locator('[data-plugins-reload]')).toHaveText('Reload plugins', { timeout: 60_000 });
    await page.locator('#wiz-next').click();
    await expect(wizard).toBeHidden();
    await expect.poll(() => wslProcessesUnder(wslRoot), { timeout: 120_000, intervals: [3_000] }).toEqual([]);
    stage('Reload plugins stopped c7');

    // 15. A finished case opens in 3D: the workspace closes, no core study is active.
    await expect.poll(busy, { timeout: 120_000 }).toBeNull();
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/cavity/${sid}`);
    await page.reload();
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    await ready();
    await frame.locator('#case').fill('cases/c2');
    await frame.locator('#open3d').click();
    await expect(overlay).toBeHidden({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}$`));
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    for (let i = 0; i < 20; i++) {
      const s = await page.evaluate(() => ({ study: window.__CFD_W17__?.activeId || null, geometry: window.__CFD_W16__?.geometry?.id || null }));
      expect(s, `check ${i}`).toEqual({ study: null, geometry: GEOMETRY_REMOVE_IDS.round });
      await page.waitForTimeout(250);
    }
    await expect
      .poll(() => page.evaluate(() => (window.__CFD_W12__?.available_times || []).map(String)), { timeout: 60_000 })
      .toEqual(['0', '0.1', '0.2', '0.3', '0.4', '0.5']);
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 90_000 });
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__?.activeId || null), { timeout: 60_000 }).toBe(GEOMETRY_REMOVE_IDS.roundStudy);
    expect(await page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true)).toBe(false);
    stage('c2 opened in 3D with no core study; a reload shows none');
  } finally {
    await context2.close().catch(() => {});
    writeFileSync(test.info().outputPath('host.log'), host.log());
    for (const line of killFoamRelays(host.projects)) stage(`relay kill ${line}`);
    host.stop();
    try {
      removeTestWslRoot(wslRoot);
    } catch (e) {
      console.warn(`[h15-submit] WSL root not removed: ${e.message}`);
    }
  }
});
