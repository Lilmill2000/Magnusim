import { expect, test } from '@playwright/test';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

// Exit sync as the user meets it, after the CAD session's real-Chrome review of the exits
// (2026-10-04): leaving the design lands "in the exact same state, seamless". The fixture
// plugin link-demo (python/tests/fixtures/link-plugins) registers an exit hook when its
// study's record says `leave_hook`; "Change to v4" is v1 10 mm taller (its tops and boss
// are kept by name but moved far, its bottoms do not move). No WSL.
//   - the update report names only faces a record refers to: an update that moves faces no
//     record holds shows no dialog; one that moves a face a BC holds names the BC and the
//     face; the landing never waits for the report's OK (__CFD_LANDINGS__ counts it at once);
//   - "Queued" shows only for a job that waits (no flash before "Building the part");
//   - Finishing says what it still waits for;
//   - SIMULATIONS (n) counts the studies the tree lists;
//   - Save as new's report does not repeat the copied study's name;
//   - Leave anyway after a refused link: the geometry row says "Not up to date" at once;
//   - the page's camera holds through a slow faces file (a large part's display load);
//   - a stall while the page's save is on its way names the save, not the plugin;
//   - Continue in background: the camera the user moved meanwhile stays, and an update that
//     needs nothing of the user is a toast, not a dialog;
//   - Continue in background, more (the review of the fixes): the part is never framed again
//     while the user works; it gets linkGeometry's view unless they moved the camera, and a
//     click (with a hand's jitter) is not a move; a hook's view cannot arrive once the page
//     has closed, so the camera stays as it is; a face a BC holds that moved far is still a
//     dialog naming it;
//   - browser Back to the project lands with the page's camera.

function stage(t0, msg) {
  console.log(`[link-exit-sync +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

async function newProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  return pj.id;
}

/** A Demo study of link-demo with its page's exit hook on. */
async function demoStudy(request, host, pid, title = 'Demo 1') {
  const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo', kind: 'demo', title } });
  const sj = await s.json();
  expect(s.ok(), JSON.stringify(sj)).toBe(true);
  const u = await request.post(`${host.base}/api/plugin-studies/update`, {
    data: { project_id: pid, plugin: 'link-demo', study_id: sj.study.id, rev: sj.study.rev, patch: { leave_hook: 'sync' } },
  });
  expect(u.ok(), await u.text()).toBe(true);
  return { pid, sid: sj.study.id };
}

async function openProject(page, host, pid) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

async function openWs(page, { pid, sid }) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${pid}/ws/link-demo/demo/${sid}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('body[data-ready="1"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(frame.locator('#hook-on')).toHaveText('on');
  return frame;
}

async function edit(page, frame, version) {
  await frame.locator(`#edit-${version}`).click();
  await expect(page.locator('#workspace-overlay .ws-shell')).toHaveAttribute('data-workspace-dirty', '1');
}

const landings = (page) => page.evaluate(() => window.__CFD_LANDINGS__ || 0);
const lastLanding = (page) => page.evaluate(() => window.__CFD_LAST_LANDING__ || null);

async function linkedOf(request, host, { pid, sid }) {
  return (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo&study_id=${sid}`)).linked;
}

function viewport(page) {
  return page.evaluate(() => ({
    id: window.__CFD_W16__?.geometry?.id || null,
    cells: window.__CFD_W16__?.fingerprint?.nCells || 0,
    stage: window.__CFD_WB_STAGE__ || '',
  }));
}

const geomRow = (page, gid) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);

async function answerQuestion(page, choice) {
  await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
  await page.locator({ new: '#lc-new', overwrite: '#lc-overwrite', cancel: '#lc-cancel' }[choice]).click();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
}

/** A simulation study on the geometry with a BC "Side wall" on `face` (the geometry is in use then). */
async function studyWithBc(request, host, pid, gid, rev, face) {
  const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  const b = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: j.simulation.id, name: 'Side wall', bc_type: 'Wall', faces: [face], geometry_rev: rev } });
  expect(b.ok(), await b.text()).toBe(true);
  return { id: j.simulation.id, name: j.simulation.name };
}

/** Everything the app shows while it runs: dialogs (their titles), and each leave status line. */
async function watchShown(page) {
  await page.evaluate(() => {
    window.__seen = { confirm: [], statuses: [] };
    const look = () => {
      const cf = document.getElementById('modal-confirm');
      const h = document.getElementById('cf-heading');
      if (cf && !cf.hidden && h && !window.__seen.confirm.includes(h.textContent)) window.__seen.confirm.push(h.textContent);
      const st = document.querySelector('[data-ws-leave-status]');
      const text = st ? st.textContent : '';
      if (text && window.__seen.statuses[window.__seen.statuses.length - 1] !== text) window.__seen.statuses.push(text);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  });
}
const seen = (page) => page.evaluate(() => window.__seen);

const camera = (page) => page.evaluate(() => window.__CFD_CAMERA__());
const near = (a, b, tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol);
/** The hook's camera (link-demo's VIEW): orthographic from +x, 100 mm high. */
const isHookView = (cam) => cam.parallel === true && near(cam.pos, [400, 15, 15]) && near(cam.fp, [0, 15, 15]) && Math.abs(cam.scale - 50) < 1e-6;
/** linkGeometry's camera (link-demo's LINK_VIEW): perspective from -y, 30 degrees. */
const isLinkView = (cam) => cam.parallel === false && near(cam.pos, [15, -400, 15]) && near(cam.fp, [15, 0, 15]) && near(cam.vu, [0, 0, 1]) && Math.abs(cam.angle - 30) < 1e-6;
const sameView = (a, b) => near(a.pos, b.pos, 1e-6) && near(a.fp, b.fp, 1e-6) && near(a.vu, b.vu, 1e-6) && a.parallel === b.parallel;

/** Orbit the viewport with the mouse (a left drag across its middle). */
async function orbit(page) {
  const box = await page.locator('#viewer canvas').first().boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 140, y + 50, { steps: 10 });
  await page.mouse.up();
}

let pageErrors = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
});

test.describe('exit sync fixes (the review of the exits, 2026-10-04)', () => {
  /** @type {any} */
  let host;
  let t0 = 0;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    t0 = Date.now();
    const tmp = e2eTemp('link-exit-sync');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'link-exit-sync',
      tmp,
      projects,
      bundledDir: bundledIfOnly(tmp),
      pluginsFrom: 'python/tests/fixtures/link-plugins',
      env: { MAGNUSIM_TEST_SLOT_HOLD: '1' },
    });
    stage(t0, `server up at ${host.base}`);
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('the update report names only faces a record holds and never holds the landing; no "Queued" flash; Finishing says what it waits for; SIMULATIONS counts the listed studies; Save as new names the copy once @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Exit report');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    let before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    stage(t1, `v1 linked (${gid})`);

    // A study made outside this tab (here by the API) on Body 2's bottom face, which v4 does
    // not move: once the tree lists it, SIMULATIONS counts it.
    const floor = await studyWithBc(request, host, pid, gid, 1, 'face 20@Body2');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
    await expect(page.locator(`#left-tree [data-w17-sim-id="${floor.id}"]`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#simulations-count-label')).toHaveText('SIMULATIONS (1)');

    // v4 (taller): six faces kept by name moved far, none of them the BC's. Overwrite: no
    // dialog at all, and the landing is counted with nothing clicked.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v4');
    await watchShown(page);
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(1500);
    let shown = await seen(page);
    expect(shown.confirm, 'no report: no record holds a face that changed').toEqual([]);
    expect((await lastLanding(page)).report).toBe(false);
    expect((await linkedOf(request, host, scope)).rev).toBe(2);
    // The job never waited for the slot: no "Queued" (not even for a moment) before it ran.
    expect(shown.statuses.filter((s) => /Queued/.test(s))).toEqual([]);
    expect(shown.statuses).toContain('Building the part');
    // Finishing named what it still waited for, as the server told it.
    expect(shown.statuses).toContain('Finishing: the centre of mass, the thumbnail and the project file');
    stage(t1, `v4 landed quietly; statuses ${JSON.stringify(shown.statuses)}`);

    // A second study with a BC on the boss end (face 15 at rev 2); back to v1 moves it 10 mm.
    const top = await studyWithBc(request, host, pid, gid, 2, 'face 15@Body1');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
    await expect(page.locator('#simulations-count-label')).toHaveText('SIMULATIONS (2)', { timeout: 30_000 });
    frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    // The landing ends while its report is still on screen (nothing waits for OK).
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    expect((await lastLanding(page)).report).toBe('dialog');
    await expect(page.locator('#cf-heading')).toHaveText('Demo 1 updated');
    await expect(page.locator('#cf-copy')).toHaveText(
      `Boundary conditions, refinements and monitors kept their faces by name.\nKept by name but moved far: ${top.name} › Side wall ('Boss end'). Check it.`,
    );
    await page.screenshot({ path: testInfo.outputPath('report-moved-far.png') });
    await page.locator('#cf-confirm').click();
    await expect(page.locator('#modal-confirm')).toBeHidden();
    stage(t1, 'v1 landed; the report named the BC and its face');

    // Save as new with a copy: the copy's line does not repeat the study's name.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v4');
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
    // Copy the first study's setup only (its copy keeps its title on the new geometry, as in the review).
    await page.locator(`#modal-link-choice input[data-link-copy="${top.id}"]`).uncheck();
    await page.locator(`#modal-link-choice input[data-link-copy="${floor.id}"]`).check();
    await answerQuestion(page, 'new');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#cf-heading')).toHaveText('Demo 1 v2 added');
    const copy = String(await page.locator('#cf-copy').textContent());
    // The copy keeps its study's title on the new geometry: it is named once.
    expect(copy.split('\n')).toContain(`Copied the setup of ${floor.name} onto it.`);
    expect(copy).not.toContain(`(${floor.name})`);
    await page.locator('#cf-confirm').click();
    expect(pageErrors).toEqual([]);
  });

  test('Leave anyway after a refused link: the geometry row says "Not up to date" at once, over the part it still shows @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Exit refused');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    const before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    const v1Cells = (await viewport(page)).cells;
    await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0);
    // Up to date: the row has its ✓.
    await expect(geomRow(page, gid).locator('.tree-check')).toHaveCount(1);
    // v2 saved in the design, then a hook that fails: the design is newer than the geometry.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    await frame.locator('#save').click();
    await expect(frame.locator('#hook-status')).toHaveText(/^saved v2 as \d+$/, { timeout: 30_000 });
    await frame.locator('#hook-mode').fill('throw');
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#cf-heading')).toHaveText("Couldn't update the project");
    await page.locator('#cf-confirm').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    const tree = await getJson(request, `${host.base}/api/project/tree?project_id=${pid}`);
    expect((tree.geometries || []).find((g) => g.id === gid).behind).toBe(true);
    // No reload: the row says so within a few seconds, and the viewport still has v1.
    await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Not up to date with Demo 1.', { timeout: 8_000 });
    // No ✓ beside it: the part is not up to date (the review of the fixes, 2026-10-04).
    await expect(geomRow(page, gid).locator('.tree-check')).toHaveCount(0);
    expect((await viewport(page)).cells).toBe(v1Cells);
    expect((await linkedOf(request, host, scope)).rev).toBe(1);
    // After a reload too.
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
    await expect(geomRow(page, gid).locator('.tree-check')).toHaveCount(0);
  });

  test("the page's camera holds through a slow faces file (a large part's display load arrives after the landing) @plugins", async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Exit camera slow');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    const frame = await openWs(page, scope);
    await frame.locator('#hook-view').check();
    await edit(page, frame, 'v1');
    // The part's faces file takes 4 s, as a large part's display does.
    await page.route(/\/api\/geometry\/cad\?.*part=faces/, async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });
    const before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    // The scenario bites: the landing is over before the part is drawn.
    expect((await viewport(page)).cells).toBe(0);
    expect((await lastLanding(page)).view).toBe(true);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    const cam = await camera(page);
    expect(isHookView(cam), JSON.stringify(cam)).toBe(true);
    await page.unroute(/\/api\/geometry\/cad\?.*part=faces/);
  });

  test("a stall while the page's save is still on its way names the save, not the plugin @plugins", async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Exit stall save');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    let before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    // The app holds the design's save (its data write) until released.
    let release = () => undefined;
    const released = new Promise((r) => (release = r));
    let heldWrites = 0;
    await page.route('**/api/plugin-data/write*', async (route) => {
      if (String(route.request().postData() || '').includes('/design.json')) {
        heldWrites += 1;
        await released;
      }
      await route.continue();
    });
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    await frame.locator('#save').click();
    await expect.poll(() => heldWrites, { timeout: 30_000 }).toBe(1);
    // Monotonic: a wall clock can step back (WSL resyncs its clock under load).
    const t = performance.now();
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 60_000 });
    expect(performance.now() - t).toBeGreaterThan(29_000);
    await expect(page.locator('#cf-heading')).toHaveText("Couldn't update the project");
    await expect(page.locator('#cf-copy')).toHaveText(
      'The save of Demo 1 did not finish in 30 seconds. Demo 1 keeps its last update. Its changes are not saved. Leaving discards them.',
    );
    // Stay; the save goes through; Back then lands on v2.
    await page.keyboard.press('Enter');
    await expect(page.locator('#modal-confirm')).toBeHidden();
    release();
    await expect(frame.locator('#hook-status')).toHaveText(/saved v2/, { timeout: 30_000 });
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 60_000 }).toBe(2);
    await page.unroute('**/api/plugin-data/write*');
  });

  test('Continue in background: the camera the user moved meanwhile stays, and an update that needs nothing of the user is a toast, not a dialog @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Exit background');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    let before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    // A BC on v1's +y face, which v2 splits in two: the record keeps both halves (nothing to do).
    await studyWithBc(request, host, pid, gid, 1, 'face 12@Body1');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    let held = false;
    try {
      const h = await request.post(`${host.base}/api/test/slot-hold`);
      expect(h.ok(), await h.text()).toBe(true);
      held = true;
      frame = await openWs(page, scope);
      await frame.locator('#hook-view').check();
      await edit(page, frame, 'v2');
      await watchShown(page);
      before = await landings(page);
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await answerQuestion(page, 'overwrite');
      await expect(page.locator('[data-ws-leave-status]')).toHaveText(/^Queued( behind \d+ jobs?)? \(see Queue\)$/, { timeout: 60_000 });
      await page.locator('[data-ws-leave-background]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
      await expect(page.locator('#wb-link-wait')).toHaveText('Queued: the update from Demo 1 (see Queue)', { timeout: 30_000 });
      // The user goes on working: they orbit the part.
      const was = await camera(page);
      await orbit(page);
      const mine = await camera(page);
      expect(sameView(was, mine), 'the drag moved the camera').toBe(false);
      await request.post(`${host.base}/api/test/slot-release`);
      held = false;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
      await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 60_000 }).toBe(2);
      await page.waitForTimeout(1500);
      // The camera is the user's, not the page's view nor a new framing.
      const now = await camera(page);
      expect(sameView(now, mine), JSON.stringify({ now, mine })).toBe(true);
      expect(isHookView(now)).toBe(false);
      expect((await lastLanding(page)).cameraKept).toBe(true);
      // The split is said quietly: a toast, no dialog.
      expect((await seen(page)).confirm).toEqual([]);
      await expect.poll(() => page.evaluate(() => window.__CFD_LINK_TOASTS__ || []), { timeout: 10_000 }).toContain(
        'Demo 1 updated. 1 face of your setup changed and stayed on its record.',
      );
      expect((await lastLanding(page)).report).toBe('toast');
    } finally {
      if (held) await request.post(`${host.base}/api/test/slot-release`);
    }
  });

  test("browser Back to the project lands with the page's camera (the same full landing as Back) @plugins", async ({ page, request }) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Exit history');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    let before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    frame = await openWs(page, scope);
    await frame.locator('#hook-view').check();
    await edit(page, frame, 'v2');
    before = await landings(page);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
    const last = await lastLanding(page);
    expect([last.reason, last.landed, last.view]).toEqual(['history', 'reloaded', true]);
    await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 60_000 }).toBe(2);
    await page.waitForTimeout(1000);
    expect(isHookView(await camera(page))).toBe(true);
  });

  test("Continue in background: the part is not framed again; it lands with linkGeometry's view unless the user moved the camera (a click is not a move); a hook's view cannot arrive, so the camera stays; a moved face a BC holds is still a dialog @plugins", async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Exit background view');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    const first = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(first);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    stage(t1, `v1 linked (${gid})`);

    /** A point of the viewport (the canvas, not a panel over it) for a click. */
    const viewerPoint = async () => {
      const box = await page.locator('#viewer canvas').first().boundingBox();
      for (const [fx, fy] of [[0.5, 0.12], [0.5, 0.88], [0.7, 0.15], [0.35, 0.15]]) {
        const x = box.x + box.width * fx;
        const y = box.y + box.height * fy;
        const inViewer = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('#viewer'), [x, y]);
        if (inViewer) return { x, y };
      }
      throw new Error('no point of the viewport is free to click');
    };
    let held = false;
    /** Edit to `version`, Back, Continue in background while the job is queued, `touch` meanwhile, then let it run. */
    const backgroundRound = async (name, { version, linkView = false, hookView = false, question = false, touch = null }) => {
      const h = await request.post(`${host.base}/api/test/slot-hold`);
      expect(h.ok(), await h.text()).toBe(true);
      held = true;
      frame = await openWs(page, scope);
      await frame.locator('#link-view').setChecked(linkView);
      await frame.locator('#hook-view').setChecked(hookView);
      await edit(page, frame, version);
      await watchShown(page);
      const before = await landings(page);
      await page.locator('#workspace-overlay [data-ws-back]').click();
      if (question) await answerQuestion(page, 'overwrite');
      await expect(page.locator('[data-ws-leave-status]')).toHaveText(/^Queued( behind \d+ jobs?)? \(see Queue\)$/, { timeout: 60_000 });
      await page.locator('[data-ws-leave-background]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
      await expect(page.locator('#wb-link-wait')).toHaveText('Queued: the update from Demo 1 (see Queue)', { timeout: 30_000 });
      const cam0 = await camera(page);
      if (touch) await touch();
      const camTouched = await camera(page);
      await request.post(`${host.base}/api/test/slot-release`);
      held = false;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
      await expect.poll(() => landings(page), { timeout: 180_000 }).toBeGreaterThan(before);
      await page.waitForTimeout(1500);
      const last = await lastLanding(page);
      const cam1 = await camera(page);
      stage(t1, `${name}: ${JSON.stringify({ last, cam0, cam1 })}`);
      return { last, cam0, camTouched, cam1 };
    };
    try {
      // A: v4 with linkGeometry's view; while it waits the user clicks in the viewport, the
      // hand moving the mouse 2 px with the button down (the camera turns a hair). Not a move:
      // the part lands with the page's view.
      let r = await backgroundRound('A click with jitter', {
        version: 'v4',
        linkView: true,
        touch: async () => {
          const { x, y } = await viewerPoint();
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 2, y + 1);
          await page.mouse.up();
        },
      });
      expect(sameView(r.cam0, r.camTouched), 'the jitter turned the camera a hair').toBe(false);
      expect((await linkedOf(request, host, scope)).rev).toBe(2);
      expect([r.last.landed, r.last.view, !!r.last.cameraKept]).toEqual(['reloaded', true, false]);
      expect(isLinkView(r.cam1), JSON.stringify(r.cam1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('bg-click-link-view.png') });

      // B: back to v1 the same way, a plain click this time (no motion at all).
      r = await backgroundRound('B plain click', {
        version: 'v1',
        linkView: true,
        touch: async () => {
          const { x, y } = await viewerPoint();
          await page.mouse.click(x, y);
        },
      });
      expect((await linkedOf(request, host, scope)).rev).toBe(3);
      expect([r.last.landed, r.last.view, !!r.last.cameraKept]).toEqual(['reloaded', true, false]);
      expect(isLinkView(r.cam1), JSON.stringify(r.cam1)).toBe(true);

      // C: v4 with only the hook's view. The page closed before its hook could return it, so
      // no view arrives: the camera stays exactly as the user had it (no framing of the
      // taller part).
      r = await backgroundRound('C hook view only', { version: 'v4', hookView: true });
      expect((await linkedOf(request, host, scope)).rev).toBe(4);
      expect(r.last.view).toBeFalsy();
      expect(r.last.cameraKept).toBe(true);
      expect(sameView(r.cam1, r.cam0), JSON.stringify({ cam0: r.cam0, cam1: r.cam1 })).toBe(true);
      expect(isHookView(r.cam1)).toBe(false);
      expect((await seen(page)).confirm).toEqual([]);

      // D: a BC on the boss end (face 15 in v4); back to v1 moves it far. That needs the
      // user: a dialog even after "Continue in background", naming the BC and its face.
      const top = await studyWithBc(request, host, pid, gid, 4, 'face 15@Body1');
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('cfd:tree-sync')));
      await expect(page.locator(`#left-tree [data-w17-sim-id="${top.id}"]`)).toBeVisible({ timeout: 30_000 });
      r = await backgroundRound('D moved far', { version: 'v1', question: true });
      expect((await linkedOf(request, host, scope)).rev).toBe(5);
      expect(r.last.report).toBe('dialog');
      await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#cf-heading')).toHaveText('Demo 1 updated');
      await expect(page.locator('#cf-copy')).toContainText(`Kept by name but moved far: ${top.name} › Side wall ('Boss end'). Check it.`);
      await page.screenshot({ path: testInfo.outputPath('bg-moved-far-dialog.png') });
      await page.locator('#cf-confirm').click();
      await expect(page.locator('#modal-confirm')).toBeHidden();
    } finally {
      if (held) await request.post(`${host.base}/api/test/slot-release`);
    }
    expect(pageErrors).toEqual([]);
  });
});
