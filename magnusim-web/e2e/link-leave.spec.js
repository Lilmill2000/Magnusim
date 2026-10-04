import { expect, test } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

// gate:l3-exits, exit sync (host API 1.6, LINK proposal section 6) as the user meets it, in the
// g7 style: the fixture plugin link-demo (python/tests/fixtures/link-plugins) registers an exit
// hook (ws.nav.onLeave) when its study's record says `leave_hook`; the hook saves the design on
// screen and links the saved one when it is newer than the geometry's. link-demo-2 has no hook.
// No WSL: meshes are made "generated" on disk, as their generate would leave them.
//   - every way out the host owns runs the hook with its reason and lands on the new rev:
//     Back, the page's own Done (nav.back), browser Back, another project, Home, and
//     results.openIn3D; all of it after a reload too; with no change nothing is drawn and the
//     faces file is not loaded again;
//   - the host's question inside an exit: over the covered workspace, "Waiting for your
//     choice" in the header, no stall question after 30 s; Keep editing stays with nothing
//     changed; Overwrite lands on the new rev (its mesh "Out of date", Start refused);
//     Save as new lands on "Demo 1 v2" (stage setup with the copied study) and, without a
//     copy, on "Demo 1 v3" (stage geometry); "Demo 1" stays as it was;
//   - exits that cannot ask: another project by script (askToLeave:false) overwrites in place
//     with no dialog; turning link-demo off in Settings, and a tab reload, link nothing (the
//     row says "Not up to date with Demo 1.") and the next Back asks;
//   - a stall offers Stay and "Leave anyway"; a hook that throws; a page reload during the
//     hook; a double Back runs one hook; nav.back() inside the hook answers false; a dirty
//     page whose hook links without saving gets one question and Leave keeps the last sync;
//   - queued (MAGNUSIM_TEST_SLOT_HOLD): "Continue in background" not before the job exists,
//     at once when it is queued; the workbench shows it queued, then the part; a newer link
//     that supersedes it shows no error; Save as new under the hold lands with no queue row;
//     another project by script while it is queued leaves at once and the update lands later;
//   - link-demo-2 (no hook): Back leaves at once with no progress; its own button links and
//     the landing is the same;
//   - entering from the results, a names-only change (no faces file loaded), face picks off
//     while the landing loads the part (also a viewport pick), and the page's camera (also
//     when the hook linked nothing);
//   - the browser-Back, project and Home exits land with data only (no camera, no dialog);
//     a shape change clears hidden and picked faces and Compare, a names-only one keeps them;
//   - a stall started by the page's own Done or Open in 3D asks too; Back looks disabled while
//     the hook runs; turning the plugin off meanwhile says why it waits; a stall after the link
//     went through says the geometry was updated;
//   - queued: "Stay here" keeps the workspace while the update goes on; Back again joins the
//     same job; a page reload while it waits says the update goes on; a stall still asks;
//   - a part that waited under the results loads however they close (a mesh row), and picks
//     wait until it does.

const SHOTS = process.env.MAGNUSIM_L3_SHOTS || '';
const CAVITY = resolve('python/tests/fixtures/foam-results/cavity-2d');

function stage(t0, msg) {
  console.log(`[link-leave +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

/** A screenshot beside the test's output, and in MAGNUSIM_L3_SHOTS when set (the handoff's). */
async function shot(page, testInfo, name) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, timeout: 15_000 }).catch(() => {});
  if (SHOTS && existsSync(path)) {
    mkdirSync(SHOTS, { recursive: true });
    cpSync(path, join(SHOTS, name));
  }
}

async function newProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  return pj.id;
}

/** A Demo study of link-demo; `hook` ('sync', 'stall', ...) turns its page's exit hook on. */
async function demoStudy(request, host, pid, title = 'Demo 1', hook = 'sync') {
  const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo', kind: 'demo', title } });
  const sj = await s.json();
  expect(s.ok(), JSON.stringify(sj)).toBe(true);
  if (hook) {
    const u = await request.post(`${host.base}/api/plugin-studies/update`, {
      data: { project_id: pid, plugin: 'link-demo', study_id: sj.study.id, rev: sj.study.rev, patch: { leave_hook: hook } },
    });
    expect(u.ok(), await u.text()).toBe(true);
  }
  return { pid, sid: sj.study.id };
}

async function openProject(page, host, pid) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

async function reloadProject(page, pid) {
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

/** The Demo study's workspace with its hook registered; its page's frame. */
async function openWs(page, { pid, sid }, hook = true) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${pid}/ws/link-demo/demo/${sid}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('body[data-ready="1"]')).toHaveCount(1, { timeout: 30_000 });
  if (hook) await expect(frame.locator('#hook-on')).toHaveText('on');
  return frame;
}

/** Change the design on screen (the page is dirty then). */
async function edit(page, frame, version) {
  await frame.locator(`#edit-${version}`).click();
  await expect(page.locator('#workspace-overlay .ws-shell')).toHaveAttribute('data-workspace-dirty', '1');
}

const landings = (page) => page.evaluate(() => window.__CFD_LANDINGS__ || 0);

/**
 * Wait for the landing after the workspace closed (`before`: the count of landings before),
 * answering the update's report on the way (its titles are returned).
 */
async function awaitLanding(page, before, opts = {}) {
  const reports = [];
  const answer = async () => {
    reports.push(String(await page.locator('#cf-heading').textContent()));
    // What was on screen when the report showed (for a results exit: its case attached).
    if (opts.results) opts.results.push(await page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true && /fixture/.test(String(window.__CFD_W6__?.case_dir || ''))));
    await page.locator('#cf-confirm').click();
  };
  await expect
    .poll(
      async () => {
        if (await page.locator('#modal-confirm').isVisible()) {
          await answer();
          return 'report';
        }
        return (await landings(page)) > before ? 'done' : 'waiting';
      },
      { timeout: 180_000, intervals: [250] },
    )
    .toBe('done');
  // The report never holds the landing up: it shows as the landing ends.
  const last = await page.evaluate(() => window.__CFD_LAST_LANDING__ || {});
  if (last.report === 'dialog' && !reports.length) {
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 15_000 });
    await answer();
    await expect(page.locator('#modal-confirm')).toBeHidden();
  }
  return reports;
}

/** Back from the workspace to the project, and the landing. */
async function backAndLand(page, pid) {
  const before = await landings(page);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
  return awaitLanding(page, before);
}

async function linkedOf(request, host, { pid, sid }, plugin = 'link-demo') {
  return (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=${plugin}&study_id=${sid}`)).linked;
}

/** Each run of the page's hook, as it logged it (its reason). */
function hookLog(host, { pid, sid }) {
  const f = join(host.projects, pid, 'plugins', 'link-demo', 'studies', sid, 'hook-log.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).map((e) => e.reason) : [];
}

/** What the viewport shows: the geometry, its drawn cells and the stage. */
function viewport(page) {
  return page.evaluate(() => ({
    id: window.__CFD_W16__?.geometry?.id || null,
    cells: window.__CFD_W16__?.fingerprint?.nCells || 0,
    stage: window.__CFD_WB_STAGE__ || '',
  }));
}

const geomRow = (page, gid) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);

async function treeOf(request, host, pid) {
  return (await getJson(request, `${host.base}/api/project/tree?project_id=${pid}`)).geometries || [];
}

/** The host's question over the workspace, answered: 'new', 'overwrite' or 'cancel' (Keep editing). */
async function answerQuestion(page, choice) {
  await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
  await page.locator({ new: '#lc-new', overwrite: '#lc-overwrite', cancel: '#lc-cancel' }[choice]).click();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
}

/** A simulation study on a geometry with a BC on one face (the geometry is in use then); `air` adds its fluid. */
async function studyWithBc(request, host, pid, gid, rev, face = 'face 17@Body2', air = false) {
  const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  const sim = { id: j.simulation.id, name: j.simulation.name };
  const b = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim.id, name: 'Side wall', bc_type: 'Wall', faces: [face], geometry_rev: rev } });
  const bj = await b.json();
  expect(b.ok(), JSON.stringify(bj)).toBe(true);
  if (air) {
    const m = await request.post(`${host.base}/api/materials`, { data: { project_id: pid, simulation_id: sim.id, name: 'Air', assigned_volumes: ['Body1', 'Body2'], geometry_rev: rev } });
    expect(m.ok(), await m.text()).toBe(true);
  }
  return { ...sim, bc: bj.bc.id };
}

function recordDir(projects, pid, kind, id) {
  const geoms = join(projects, pid, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      const root = join(sims, s, kind === 'mesh' ? 'meshes' : 'simulation_runs');
      if (!existsSync(root)) continue;
      for (const f of readdirSync(root)) {
        try {
          if (JSON.parse(readFileSync(join(root, f, 'id.json'), 'utf8')).id === id) return join(root, f);
        } catch {
          /* not a record */
        }
      }
    }
  }
  throw new Error(`no ${kind} ${id}`);
}

/** A mesh of the study as its generate leaves it at `rev` (a whole polyMesh), and a run on it. */
async function generatedMeshAndRun(request, host, pid, simId, rev) {
  const m = await request.post(`${host.base}/api/mesh`, { data: { project_id: pid, simulation_id: simId, name: 'Mesh 1' } });
  const mj = await m.json();
  expect(m.ok(), JSON.stringify(mj)).toBe(true);
  const meshId = mj.mesh.id;
  const meshDir = recordDir(host.projects, pid, 'mesh', meshId);
  const caseDir = join(meshDir, 'case');
  mkdirSync(join(caseDir, 'constant', 'polyMesh'), { recursive: true });
  for (const n of ['points', 'faces', 'owner', 'neighbour']) writeFileSync(join(caseDir, 'constant', 'polyMesh', n), `${n}\n`);
  writeFileSync(
    join(caseDir, 'constant', 'polyMesh', 'boundary'),
    [
      'FoamFile { version 2.0; format ascii; class polyBoundaryMesh; location "constant/polyMesh"; object boundary; }',
      '2',
      '(',
      ...[
        ['side_wall', 'wall'],
        ['wall', 'wall'],
      ].flatMap(([name, type], i) => [`    ${name}`, '    {', `        type            ${type};`, '        nFaces          1;', `        startFace       ${i};`, '    }']),
      ')',
      '',
    ].join('\n'),
  );
  const meshFile = join(meshDir, 'mesh.json');
  writeFileSync(
    meshFile,
    JSON.stringify({
      ...JSON.parse(readFileSync(meshFile, 'utf8')),
      generated: true,
      live_mesh_result: { status: 'done', generate_id: 'g-e2e', built_from_rev: rev, n_cells: 8, n_points: 27, case_dir: caseDir, mesh_path: join(caseDir, 'constant', 'polyMesh') },
    }),
  );
  const r = await request.post(`${host.base}/api/run/create`, { data: { project_id: pid, simulation_id: simId, name: 'Run 1', mesh_id: meshId } });
  const rj = await r.json();
  expect(r.ok(), JSON.stringify(rj)).toBe(true);
  return { meshId, runId: String(rj.run_id || (rj.run && (rj.run.id || rj.run.run_id)) || rj.id) };
}

/** A linked geometry's face by its label, as its preview names it ("face <id>@Body<n>"). */
async function faceOf(request, host, pid, gid, label) {
  const meta = await getJson(request, `${host.base}/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=preview&t=${Date.now()}`);
  const f = (meta.faces || []).find((x) => x.label === label);
  expect(f, `a face labelled ${label}`).toBeTruthy();
  return `face ${f.id}@Body${f.body || 1}`;
}

/** Delete a simulation study (the geometry is no longer in use by it). */
async function deleteStudy(request, host, pid, simId) {
  const r = await request.post(`${host.base}/api/simulation/delete`, { data: { project_id: pid, simulation_id: simId } });
  expect(r.ok(), await r.text()).toBe(true);
}

/** Watch for anything the app shows that a test says must not show (a dialog, a safe question). */
async function watchShown(page) {
  await page.evaluate(() => {
    window.__seen = { choice: false, confirm: [], status: false };
    const look = () => {
      const lc = document.getElementById('modal-link-choice');
      if (lc && !lc.hidden) window.__seen.choice = true;
      const cf = document.getElementById('modal-confirm');
      const h = document.getElementById('cf-heading');
      if (cf && !cf.hidden && h && !window.__seen.confirm.includes(h.textContent)) window.__seen.confirm.push(h.textContent);
      if (document.querySelector('[data-ws-leave-status]')) window.__seen.status = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  });
}
const seen = (page) => page.evaluate(() => window.__seen);

/** The viewport's camera, and whether it is the hook's (orthographic from +x, 100 mm high). */
const camera = (page) => page.evaluate(() => window.__CFD_CAMERA__());
const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
const isHookView = (cam) => cam.parallel === true && near(cam.pos, [400, 15, 15]) && near(cam.fp, [0, 15, 15]);

/** Points of the viewport's canvas on the part (distinct faces), as the viewport's own pick finds them (once it is drawn). */
async function partPoints(page, want = 2) {
  let found = [];
  await expect
    .poll(
      async () => {
        found = await pointsNow(page, want);
        return found.length;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(want);
  return found;
}

function pointsNow(page, want) {
  return page.evaluate((n) => {
    const canvas = document.querySelector('#viewer canvas');
    const r = canvas.getBoundingClientRect();
    const out = [];
    const faces = new Set();
    for (let fy = 0.3; fy <= 0.7 && out.length < n; fy += 0.04) {
      for (let fx = 0.3; fx <= 0.7 && out.length < n; fx += 0.04) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        const top = document.elementFromPoint(x, y);
        if (!top || !top.closest('#viewer')) continue;
        const hit = window.__CFD_PICK_CAD__({ clientX: x, clientY: y });
        const key = hit && hit.faceId ? `${hit.solidId || 1}:${hit.faceId}` : '';
        if (key && !faces.has(key)) {
          faces.add(key);
          out.push({ x, y, faceId: hit.faceId, solidId: hit.solidId || 1 });
        }
      }
    }
    return out;
  }, want);
}

/** One face hidden (right-click, Hide face), another picked (a click), and Compare on. */
async function faceState(page) {
  const [a, b] = await partPoints(page, 2);
  expect(b, 'two faces of the part on screen').toBeTruthy();
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await expect(page.locator('#face-ctx-menu')).toBeVisible();
  await page.locator('#face-ctx-hide').click();
  await expect(page.locator('#hidden-faces-chip')).toBeVisible();
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => page.evaluate(() => window.__CFD_VIEWPORT_FACES__().selected.length)).toBeGreaterThan(0);
  await page.evaluate(() => document.getElementById('btn-compare').click());
  await expect(page.locator('#compare-bar')).toBeVisible();
}

/** How Back looks: disabled while the hook runs must look disabled. */
const backLook = (page) =>
  page.locator('#workspace-overlay [data-ws-back]').evaluate((b) => ({ opacity: getComputedStyle(b).opacity, cursor: getComputedStyle(b).cursor }));

/** The safe question after a hook that did not finish: its words, then Stay or Leave anyway. */
async function hookFailed(page, leave) {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const q = {
    title: await page.locator('#cf-heading').textContent(),
    copy: await page.locator('#cf-copy').textContent(),
    yes: await page.locator('#cf-confirm').textContent(),
    no: await page.locator('#cf-cancel').textContent(),
    focus: await page.evaluate(() => document.activeElement && document.activeElement.id),
  };
  if (leave) await page.locator('#cf-confirm').click();
  else await page.keyboard.press('Enter');
  await expect(modal).toBeHidden();
  return q;
}

let t0 = 0;
let refusals = [];
// Uncaught errors and console errors of the app's page (its frames too), in order.
let pageErrors = [];
test.beforeEach(async ({ page }) => {
  refusals = [];
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() !== 409) return;
    void r
      .json()
      .then((j) => {
        if (j && j.code === 'geometry_changed') refusals.push(`${r.request().method()} ${r.url()}`);
      })
      .catch(() => {});
  });
});
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) expect(refusals, 'no save refused as drawn at an old rev').toEqual([]);
});

test.describe('exit sync (host API 1.6)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    t0 = Date.now();
    const tmp = e2eTemp('link-leave');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'link-leave',
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

  test('gate:l3-exits every way out the host owns runs the hook with its reason and lands on the new rev, also after a reload @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave exits');
    const other = await newProject(request, host, 'Leave elsewhere');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    const cells = {};

    // Back with nothing saved: the hook has nothing to link; nothing is drawn.
    let frame = await openWs(page, scope);
    await watchShown(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    expect((await seen(page)).status).toBe(false);
    expect(hookLog(host, scope)).toEqual(['back']);
    expect(await linkedOf(request, host, scope)).toBeNull();

    // Back with design v1 changed on screen (not saved): the hook saves it and links it; the
    // first link creates the geometry and the landing shows it.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    let linked = await linkedOf(request, host, scope);
    expect([linked.name, linked.rev]).toEqual(['Demo 1', 1]);
    const gid = linked.geometryId;
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
    cells.v1 = (await viewport(page)).cells;
    expect(cells.v1).toBeGreaterThan(0);
    stage(t1, `v1 created on Back (${gid}, ${cells.v1} cells)`);

    // Back with no change (the fast path): nothing is drawn, nothing is linked.
    frame = await openWs(page, scope);
    await watchShown(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 30_000 });
    expect((await seen(page)).status).toBe(false);
    expect(hookLog(host, scope).slice(-1)).toEqual(['back']);
    // Back with a link that changes nothing (`none`): the landing loads no faces file again.
    const faces = [];
    const onFaces = (r) => {
      if (r.url().includes('/api/geometry/cad') && r.url().includes('part=faces')) faces.push(r.url());
    };
    frame = await openWs(page, scope);
    await frame.locator('#link-always').check();
    page.on('request', onFaces);
    await backAndLand(page, pid);
    await page.waitForTimeout(1500);
    page.off('request', onFaces);
    expect(faces).toEqual([]);
    expect(await page.evaluate(() => window.__CFD_LAST_LANDING__ && window.__CFD_LAST_LANDING__.landed)).toBe('none');
    expect((await linkedOf(request, host, scope)).rev).toBe(1);
    expect(hookLog(host, scope).slice(-1)).toEqual(['back']);

    // Each way out, with a new design each time: the hook runs with its reason, and the part
    // shown is the new rev's.
    const exits = [
      { reason: 'back', version: 'v2', go: () => page.locator('#workspace-overlay [data-ws-back]').click() },
      { reason: 'frame-back', version: 'v3', go: () => page.frameLocator('#workspace-frame').locator('#done').click() },
      { reason: 'history', version: 'v2', go: () => page.evaluate(() => history.back()) },
      { reason: 'project', version: 'v3', go: () => page.evaluate((id) => window.__CFD_HOME__.open(id), other) },
      { reason: 'home', version: 'v2', go: () => page.evaluate(() => document.getElementById('wb-home').click()) },
    ];
    let rev = 1;
    for (const exit of exits) {
      // The ways out that leave the project land with data only: the hook's camera is not
      // applied and no dialog shows (LINK 6.5). Browser Back to the project is a way back to
      // it, like Back: the full landing with the hook's camera (the review of 2026-10-04).
      const dataOnly = ['project', 'home'].includes(exit.reason);
      frame = await openWs(page, scope);
      if (dataOnly || exit.reason === 'history') await frame.locator('#hook-view').check();
      await edit(page, frame, exit.version);
      await watchShown(page);
      const before = await landings(page);
      await exit.go();
      if (exit.reason === 'project') await expect.poll(() => page.evaluate(() => window.__CFD_PROJECT_READY__), { timeout: 120_000 }).toBe(other);
      else if (exit.reason === 'home') await expect.poll(() => page.evaluate(() => document.body.classList.contains('on-home')), { timeout: 120_000 }).toBe(true);
      else await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
      const reports = await awaitLanding(page, before);
      // The landing knew the way out (Back lands fully; the others refresh data only).
      const last = await page.evaluate(() => window.__CFD_LAST_LANDING__);
      expect(last && last.reason).toBe(exit.reason);
      if (dataOnly) {
        expect(reports).toEqual([]);
        expect((await seen(page)).confirm).toEqual([]);
        expect(last.view).toBeUndefined();
      }
      // Browser Back lands with the hook's camera, as Back does.
      if (exit.reason === 'history') {
        expect(last.view).toBe(true);
        expect(isHookView(await camera(page))).toBe(true);
      }
      rev += 1;
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(rev);
      expect(hookLog(host, scope).slice(-1)).toEqual([exit.reason]);
      if (exit.reason === 'project' || exit.reason === 'home') await openProject(page, host, pid);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
      // The viewport has the new rev's part: as a fresh load of the project draws it.
      const shown = (await viewport(page)).cells;
      await reloadProject(page, pid);
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(shown);
      cells[exit.version] = shown;
      await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
      await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0);
      stage(t1, `${exit.reason}: rev ${rev} (${shown} cells)`);
    }
    expect(cells.v2).not.toBe(cells.v1);
    expect(hookLog(host, scope)).toEqual(['back', 'back', 'back', 'back', 'back', 'frame-back', 'history', 'project', 'home']);
    await shot(page, testInfo, 'l3-exits-landed.png');
  });

  test("gate:l3-exits the host's question inside an exit: Waiting for your choice, no stall, Keep editing, Overwrite, Save as new @plugins", async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave question');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    // In use: a study with a BC on Body 2's side face, a mesh generated at rev 1 and a run on it.
    const sim = await studyWithBc(request, host, pid, gid, 1, 'face 17@Body2', true);
    const { meshId, runId } = await generatedMeshAndRun(request, host, pid, sim.id, 1);
    await reloadProject(page, pid);
    stage(t1, `Demo 1 in use (${gid})`);
    // A face hidden, another picked and Compare on: the new shape's landing clears them (LINK 6.5 step 3).
    await faceState(page);

    // Back after a shape change: the dialog over the covered workspace, "Waiting for your choice".
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    await watchShown(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('[data-ws-leave-status]')).toHaveText('Waiting for your choice');
    await expect(page.locator('[data-ws-leave-cancel]')).toHaveCount(0);
    await expect(page.locator('[data-ws-leave-cover]')).toHaveCount(1);
    await expect(page.locator('[data-ws-back]')).toBeDisabled();
    await shot(page, testInfo, 'l3-question-in-exit.png');
    // No stall question while the user chooses (30 s and more).
    await page.waitForTimeout(32_000);
    await expect(page.locator('#modal-link-choice')).toBeVisible();
    expect((await seen(page)).confirm).toEqual([]);
    // Keep editing: the workspace stays, with no question, and nothing changed.
    const errorsBefore = pageErrors.length;
    await answerQuestion(page, 'cancel');
    await expect(frame.locator('#hook-status')).toHaveText('Kept editing', { timeout: 30_000 });
    await expect(page.locator('[data-ws-leave-status]')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));
    expect((await seen(page)).confirm).toEqual([]);
    expect((await linkedOf(request, host, scope)).rev).toBe(1);
    // Nothing uncaught (the link call's "You kept editing" rejection) and no console error.
    await page.waitForTimeout(1_000);
    expect(pageErrors.slice(errorsBefore), 'no page error or console error after Keep editing').toEqual([]);
    stage(t1, 'kept editing');

    // Overwrite: lands on rev 2; the mesh is out of date and Start refuses on it.
    let before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    const reports = await awaitLanding(page, before);
    // The BC's face did not change and nothing else of the setup was touched: no dialog (the
    // review of 2026-10-04); the mesh made at rev 1 is said quietly.
    expect(reports).toEqual([]);
    await expect
      .poll(() => page.evaluate(() => window.__CFD_LINK_TOASTS__ || []), { timeout: 10_000 })
      .toContain('Demo 1 updated. Out of date: Mesh 1. Generate it again before you run.');
    expect((await linkedOf(request, host, scope)).rev).toBe(2);
    expect((await viewport(page)).id).toBe(gid);
    await expect(page.locator('#hidden-faces-chip')).toBeHidden();
    expect(await page.evaluate(() => window.__CFD_VIEWPORT_FACES__())).toEqual({ selected: [], hidden: [] });
    await expect(page.locator('#compare-bar')).toBeHidden();
    const meshRow = page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
    await expect(meshRow.locator('[data-mesh-out-of-date]')).toHaveText('Out of date', { timeout: 30_000 });
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    await page.locator(`#left-tree [data-w27-run="${runId}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', runId, { timeout: 15_000 });
    await expect
      .poll(async () => ((await runPanel.locator('[data-run-start]').isEnabled()) ? 'enabled' : await runPanel.textContent()), { timeout: 30_000 })
      .toBe('enabled');
    await runPanel.locator('[data-run-start]').click();
    await expect(runPanel).toContainText('Generate Mesh 1 again first. It was made from an older version of Demo 1.', { timeout: 30_000 });
    await shot(page, testInfo, 'l3-overwrite-landed.png');
    stage(t1, 'overwrite landed');

    // Save as new with the copy: "Demo 1 v2" with the copied study, on setup; "Demo 1" as it was.
    const oldFiles = await treeOf(request, host, pid);
    frame = await openWs(page, scope);
    await edit(page, frame, 'v3');
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#lc-copies input[type="checkbox"]')).toBeChecked();
    await answerQuestion(page, 'new');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    expect(await awaitLanding(page, before)).toEqual(['Demo 1 v2 added']);
    let linked = await linkedOf(request, host, scope);
    expect([linked.name, linked.rev]).toEqual(['Demo 1 v2', 1]);
    const v2Id = linked.geometryId;
    const tree = await treeOf(request, host, pid);
    const copied = tree.find((g) => g.id === v2Id).studies[0].id;
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(v2Id);
    expect((await viewport(page)).stage).toBe('setup');
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId), { timeout: 60_000 }).toBe(copied);
    // "Demo 1": a plain row, its study and mesh as they were (rev 2, the mesh still out of date).
    const old = tree.find((g) => g.id === gid);
    expect([old.unlinked, old.rev]).toEqual([true, 2]);
    expect(old.studies.map((s) => s.id)).toEqual(oldFiles.find((g) => g.id === gid).studies.map((s) => s.id));
    await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveCount(0);
    await shot(page, testInfo, 'l3-save-as-new-landed.png');
    stage(t1, `saved as new with the copy (${v2Id})`);

    // Save as new without the copy: "Demo 1 v3", on stage geometry (no study yet).
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
    await page.locator('#lc-copies input[type="checkbox"]').uncheck();
    await answerQuestion(page, 'new');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    expect(await awaitLanding(page, before)).toEqual(['Demo 1 v3 added']);
    linked = await linkedOf(request, host, scope);
    expect(linked.name).toBe('Demo 1 v3');
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(linked.geometryId);
    expect((await viewport(page)).stage).toBe('geometry');
    // After a reload too.
    await reloadProject(page, pid);
    await expect(geomRow(page, linked.geometryId).locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
    await expect(geomRow(page, v2Id).locator('[data-geom-from]')).toHaveCount(0);
    await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveCount(0);
    stage(t1, 'saved as new without a copy');
  });

  test('gate:l3-exits exits that cannot ask: a scripted project switch overwrites with no dialog; plugin off and a tab reload link nothing, and the next Back asks @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave scripted');
    const other = await newProject(request, host, 'Leave scripted elsewhere');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const sim = await studyWithBc(request, host, pid, gid, 1);
    const { meshId } = await generatedMeshAndRun(request, host, pid, sim.id, 1);
    await reloadProject(page, pid);

    // Another project by script, askToLeave:false: the hook runs, the question is answered
    // "Overwrite" with no dialog, and the app opens the other project.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    await watchShown(page);
    const opened = await page.evaluate((id) => window.__CFD_HOME__.open(id, { askToLeave: false }), other);
    expect(opened).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.__CFD_PROJECT_READY__)).toBe(other);
    expect(await seen(page)).toMatchObject({ choice: false, confirm: [] });
    await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 180_000 }).toBe(2);
    expect(hookLog(host, scope).slice(-1)).toEqual(['project']);
    const mesh = (await treeOf(request, host, pid)).find((g) => g.id === gid);
    expect(mesh.id).toBe(gid);
    await openProject(page, host, pid);
    await expect(page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row [data-mesh-out-of-date]`)).toHaveText('Out of date', { timeout: 30_000 });
    stage(t1, 'scripted switch overwrote in place');

    // Turning link-demo off in Settings with a saved newer design: no hook, no question, no link.
    frame = await openWs(page, scope);
    await edit(page, frame, 'v3');
    await frame.locator('#save').click();
    await expect(page.locator('#workspace-overlay .ws-shell')).not.toHaveAttribute('data-workspace-dirty', '1');
    const runsBefore = hookLog(host, scope).length;
    await watchShown(page);
    await page.locator('#workspace-overlay .ws-header-right #wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await expect(wizard).toBeVisible();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const prow = wizard.locator('[data-plugin-key="link-demo"]');
    await prow.locator('[data-plugin-toggle="link-demo"]').click();
    try {
      await expect(prow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
      await wizard.locator('#wiz-skip').click();
      await expect(page.locator('#workspace-overlay [data-ws-error] h2')).toHaveText('Link demo is off.');
      expect(await seen(page)).toMatchObject({ choice: false, confirm: [], status: false });
      expect(hookLog(host, scope)).toHaveLength(runsBefore);
      expect((await linkedOf(request, host, scope)).rev).toBe(2);
      await page.locator('#workspace-overlay [data-ws-error-back], #workspace-overlay [data-ws-back]').first().click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
      await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
      await shot(page, testInfo, 'l3-plugin-off-not-up-to-date.png');
    } finally {
      const on = await request.post(`${host.base}/api/plugins/link-demo/enable`, { data: {} });
      expect(on.ok()).toBe(true);
    }
    stage(t1, 'plugin off: nothing linked');

    // On again: the next Back asks (the saved design is newer); Keep editing.
    await reloadProject(page, pid);
    frame = await openWs(page, scope);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'cancel');
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));

    // A tab reload with a saved newer design: no hook, no question, nothing linked.
    await edit(page, frame, 'v2');
    await frame.locator('#save').click();
    await expect(page.locator('#workspace-overlay .ws-shell')).not.toHaveAttribute('data-workspace-dirty', '1');
    const runsNow = hookLog(host, scope).length;
    await page.reload();
    await expect(page.frameLocator('#workspace-frame').locator('body[data-ready="1"]')).toHaveCount(1, { timeout: 60_000 });
    expect(hookLog(host, scope)).toHaveLength(runsNow);
    expect((await linkedOf(request, host, scope)).rev).toBe(2);
    // A fresh load of the project (a hash change here would be a way out that runs the hook).
    await page.goto('about:blank');
    await openProject(page, host, pid);
    await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
    stage(t1, 'tab reload: nothing linked');
  });

  test('gate:l3-exits a stall, a throw, a page reload during the hook, a double Back, nav.back() inside the hook, and a dirty page that links without saving @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave errors');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    expect((await linkedOf(request, host, scope)).rev).toBe(1);

    // A hook that stalls: after 30 s, "Couldn't update the project"; Stay (Enter) keeps the workspace.
    frame = await openWs(page, scope);
    await frame.locator('#hook-mode').fill('stall');
    const enabledLook = await backLook(page);
    expect(enabledLook).toEqual({ opacity: '1', cursor: 'pointer' });
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('[data-ws-leave-status]')).toHaveText('Updating the project from Demo 1…', { timeout: 5_000 });
    // Back is disabled while the hook runs, and looks it.
    await expect(page.locator('[data-ws-back]')).toBeDisabled();
    expect(await backLook(page)).toEqual({ opacity: '0.5', cursor: 'default' });
    await shot(page, testInfo, 'l3-progress.png');
    const stalled = await hookFailed(page, false);
    expect(stalled).toEqual({
      title: "Couldn't update the project",
      copy: 'Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.',
      yes: 'Leave anyway',
      no: 'Stay',
      focus: 'cf-cancel',
    });
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));
    await expect(page.locator('[data-ws-back]')).toBeEnabled();
    expect(await backLook(page)).toEqual(enabledLook);
    stage(t1, 'stall: stayed');

    // The page's own Done with a hook that stalls: the same question after 30 s (the call
    // that started the leave waits for it; it is not the hook's work). Meanwhile turning the
    // plugin off in Settings says why it waits.
    await frame.locator('#done').click();
    await expect(page.locator('[data-ws-leave-status]')).toHaveText('Updating the project from Demo 1…', { timeout: 5_000 });
    await page.locator('#workspace-overlay .ws-header-right #wb-prefs').click();
    const wizard = page.locator('#setup-wizard');
    await expect(wizard).toBeVisible();
    await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
    const prow = wizard.locator('[data-plugin-key="link-demo"]');
    await prow.locator('[data-plugin-toggle="link-demo"]').click();
    await expect(wizard.locator('.wiz-plugin-note')).toHaveText('Wait until the workspace has finished updating the project, then turn it off.');
    await expect(prow).toHaveAttribute('data-plugin-status', 'enabled');
    await wizard.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    await expect(page.locator('[data-ws-leave-status]')).toHaveText('Updating the project from Demo 1…');
    const fromDone = await hookFailed(page, false);
    expect(fromDone.copy).toBe('Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.');
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));
    expect(hookLog(host, scope).slice(-2)).toEqual(['back', 'frame-back']);
    stage(t1, "stall from the page's Done: stayed");

    // A hook that throws: Leave anyway leaves; the geometry keeps its last update.
    await frame.locator('#hook-mode').fill('throw');
    await page.locator('#workspace-overlay [data-ws-back]').click();
    const thrown = await hookFailed(page, true);
    expect(thrown.copy).toBe('Link demo: The export failed. Demo 1 keeps its last update.');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
    expect((await linkedOf(request, host, scope)).rev).toBe(1);

    // The page reloads during the hook: the same question (its page closed); Stay.
    frame = await openWs(page, scope);
    await frame.locator('#hook-mode').fill('reload');
    await page.locator('#workspace-overlay [data-ws-back]').click();
    const reloaded = await hookFailed(page, false);
    expect(reloaded.copy).toBe('Link demo: its page closed before it finished. Demo 1 keeps its last update.');
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));
    await expect(frame.locator('#hook-on')).toHaveText('on', { timeout: 30_000 });
    stage(t1, 'throw and reload');

    // A double Back: one hook run, one landing.
    await edit(page, frame, 'v2');
    await frame.locator('#hook-delay').fill('1500');
    let runs = hookLog(host, scope).length;
    let before = await landings(page);
    await page.evaluate(() => {
      const b = document.querySelector('#workspace-overlay [data-ws-back]');
      b.click();
      b.click();
    });
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 120_000 });
    await awaitLanding(page, before);
    expect(hookLog(host, scope).slice(runs)).toEqual(['back']);
    expect((await linkedOf(request, host, scope)).rev).toBe(2);

    // nav.back() inside the hook answers false; the leave goes on.
    frame = await openWs(page, scope);
    await frame.locator('#hook-mode').fill('back-inside');
    await edit(page, frame, 'v3');
    runs = hookLog(host, scope).length;
    await backAndLand(page, pid);
    expect(hookLog(host, scope).slice(runs)).toEqual(['back', 'nav.back:false']);
    expect((await linkedOf(request, host, scope)).rev).toBe(3);
    stage(t1, 'double Back and nav.back inside');

    // A dirty page whose hook links without saving: refused (unsaved), then one question; Leave
    // keeps the last saved sync.
    frame = await openWs(page, scope);
    await frame.locator('#hook-mode').fill('nosave');
    await edit(page, frame, 'v2');
    await watchShown(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    const unsaved = await hookFailed(page, true);
    expect(unsaved.copy).toBe(
      'Link demo: Save the design before linking it: the page has unsaved work. Demo 1 keeps its last update. Its changes are not saved. Leaving discards them.',
    );
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
    expect((await seen(page)).confirm).toEqual(["Couldn't update the project"]);
    expect((await linkedOf(request, host, scope)).rev).toBe(3);
    stage(t1, 'unsaved: one question');

    // A hook that stalls after its link went through: the question says the geometry was updated.
    // A BC on v3's -x face, which v1 splits in two: the update touches the setup, so its report is due.
    const g3 = (await linkedOf(request, host, scope)).geometryId;
    await studyWithBc(request, host, pid, g3, 3, await faceOf(request, host, pid, g3, 'Box -x'));
    frame = await openWs(page, scope);
    await frame.locator('#hook-after').fill('45000');
    await edit(page, frame, 'v1');
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'overwrite');
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#cf-heading')).toHaveText("Couldn't update the project");
    expect(await page.locator('#cf-copy').textContent()).toBe('Link demo: it did not answer for 30 seconds. Demo 1 was updated.');
    await page.keyboard.press('Enter');
    // Stay: the update's report, held back for the landing, shows here now.
    await expect(page.locator('#cf-heading')).toHaveText('Demo 1 updated', { timeout: 30_000 });
    await page.locator('#cf-confirm').click();
    await expect(page.locator('#modal-confirm')).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/ws/link-demo/demo/${scope.sid}$`));
    expect((await linkedOf(request, host, scope)).rev).toBe(4);
    await frame.locator('#hook-after').fill('0');
    // Back (nothing newer to link): the part shown is rev 4's, also after a reload.
    await backAndLand(page, pid);
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe((await linkedOf(request, host, scope)).geometryId);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    const shown = (await viewport(page)).cells;
    await reloadProject(page, pid);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(shown);
    stage(t1, 'stall after the link: was updated; after a reload');
  });

  test('gate:l3-exits queued: Continue in background (not before the job, at once when queued), a superseded one quietly, Save as new with no queue row, a scripted switch while queued @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave queued');
    const other = await newProject(request, host, 'Leave queued elsewhere');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    let held = false;
    const hold = async () => {
      const r = await request.post(`${host.base}/api/test/slot-hold`);
      expect(r.ok(), await r.text()).toBe(true);
      held = true;
    };
    const release = async () => {
      await request.post(`${host.base}/api/test/slot-release`);
      held = false;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
    };
    try {
      await hold();
      // Exporting (before the link): no "Continue in background".
      frame = await openWs(page, scope);
      await frame.locator('#hook-delay').fill('3000');
      await edit(page, frame, 'v2');
      await watchShown(page);
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await expect(page.locator('[data-ws-leave-status]')).toHaveText('Exporting the design', { timeout: 5_000 });
      await expect(page.locator('[data-ws-leave-background]')).toHaveCount(0);
      // Queued: offered at once.
      await expect(page.locator('[data-ws-leave-status]')).toHaveText(/^Queued( behind \d+ jobs?)? \(see Queue\)$/, { timeout: 60_000 });
      await expect(page.locator('[data-ws-leave-background]')).toBeVisible();
      // The job goes on whatever happens: the other button only keeps the workspace open.
      await expect(page.locator('[data-ws-leave-cancel]')).toHaveText('Stay here');
      await shot(page, testInfo, 'l3-queued-background.png');
      await page.locator('[data-ws-leave-background]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
      // The workbench shows the job on the geometry row and in the viewport.
      await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveText('Queued', { timeout: 30_000 });
      await expect(page.locator('#wb-link-wait')).toHaveText('Queued: the update from Demo 1 (see Queue)', { timeout: 30_000 });
      await shot(page, testInfo, 'l3-queued-row.png');
      stage(t1, 'continued in background');

      // A newer design while that one waits: it supersedes it, quietly.
      frame = await openWs(page, scope);
      await edit(page, frame, 'v3');
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await expect(page.locator('[data-ws-leave-background]')).toBeVisible({ timeout: 60_000 });
      const before = await landings(page);
      await page.locator('[data-ws-leave-background]').click();
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
      await release();
      await awaitLanding(page, before);
      await expect(page.locator('#wb-link-wait')).toBeHidden();
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(2);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(gid);
      // Nothing about the one it replaced, and no dialog for the newer one either: it touched
      // none of the setup, and it landed while the user worked (the review of 2026-10-04).
      expect((await seen(page)).confirm).toEqual([]);
      expect(await page.evaluate(() => (window.__CFD_LINK_TOASTS__ || []).join(' '))).not.toMatch(/superseded|replaced/i);
      await expect(page.locator('.app-toasts')).not.toContainText(/fail|error|couldn|superseded|replaced/i);
      expect(hookLog(host, scope).slice(-2)).toEqual(['back', 'back']);
      // After a reload too: the part shown is the same, the row has no queue status.
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
      const v3Shown = (await viewport(page)).cells;
      await reloadProject(page, pid);
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(v3Shown);
      await expect(geomRow(page, gid).locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
      await expect(geomRow(page, gid).locator('[data-geom-link-status]')).toHaveCount(0);
      stage(t1, 'superseded quietly; v3 landed');

      // Save as new under the hold: lands with no queue row.
      await studyWithBc(request, host, pid, gid, 2, 'face 1@Body1');
      await reloadProject(page, pid);
      await hold();
      frame = await openWs(page, scope);
      await edit(page, frame, 'v2');
      let landed = await landings(page);
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await answerQuestion(page, 'new');
      await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
      expect(await awaitLanding(page, landed)).toEqual(['Demo 1 v2 added']);
      const v2 = await linkedOf(request, host, scope);
      expect(v2.name).toBe('Demo 1 v2');
      expect(((await getJson(request, `${host.base}/api/compute-queue?project_id=${pid}`)).items || []).filter((r) => r.kind === 'geometry')).toEqual([]);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(v2.geometryId);
      stage(t1, 'save as new under the hold');

      // A scripted switch while the update waits in the queue: it leaves at once; the update lands later.
      frame = await openWs(page, scope);
      await edit(page, frame, 'v3');
      const t2 = Date.now();
      const opened = await page.evaluate((id) => window.__CFD_HOME__.open(id, { askToLeave: false }), other);
      expect(opened).toMatchObject({ ok: true });
      expect(Date.now() - t2).toBeLessThan(60_000);
      expect((await linkedOf(request, host, scope)).rev).toBe(1);
      await release();
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(2);
      // The project again: the update has landed (no queue status on its row).
      await openProject(page, host, pid);
      await expect(geomRow(page, v2.geometryId).locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
      await expect(geomRow(page, v2.geometryId).locator('[data-geom-link-status]')).toHaveCount(0);
      stage(t1, 'scripted switch while queued');
    } finally {
      if (held) await request.post(`${host.base}/api/test/slot-release`);
    }
  });

  test('gate:l3-exits link-demo-2 (no hook): Back leaves at once with no progress; its own button links and lands the same way; a first link left running shows in the viewport @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const pid = await newProject(request, host, 'Leave no hook');
    const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo-2', kind: 'demo', title: 'Demo 1' } });
    const sid = (await s.json()).study.id;
    await openProject(page, host, pid);
    const open2 = async () => {
      await page.evaluate((h) => {
        window.location.hash = h;
      }, `#/p/${pid}/ws/link-demo-2/demo2/${sid}`);
      const frame = page.frameLocator('#workspace-frame');
      await expect(frame.locator('#link2-title')).toHaveText('Demo 1', { timeout: 30_000 });
      return frame;
    };
    await open2();
    await watchShown(page);
    const t2 = Date.now();
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
    expect(Date.now() - t2).toBeLessThan(5_000);
    expect((await seen(page)).status).toBe(false);
    // Its own button links; Back lands on the new geometry.
    const frame = await open2();
    await frame.locator('#link2-send').click();
    await expect(frame.locator('#link2-status')).toHaveText('shape rev 1 created', { timeout: 180_000 });
    await backAndLand(page, pid);
    const linked = await linkedOf(request, host, { pid, sid }, 'link-demo-2');
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(linked.geometryId);
    const row = geomRow(page, linked.geometryId);
    await expect(row.locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
    expect(String(await row.textContent())).not.toMatch(/leav/i);

    // A first link left running (Back while its job runs): the viewport says so in place of
    // the empty-project buttons. (The job's status reads "running" for a few seconds here,
    // so the wait can be seen: the real create takes about two.)
    const pid2 = await newProject(request, host, 'Leave first sync');
    const s2 = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid2, plugin: 'link-demo-2', kind: 'demo', title: 'Demo 1' } });
    const sid2 = (await s2.json()).study.id;
    await openProject(page, host, pid2);
    await expect(page.locator('#wb-empty-cta')).toBeVisible({ timeout: 30_000 });
    let slow = true;
    await page.route('**/api/plugin-geometry/status**', async (route) => {
      if (!slow) return route.continue();
      const u = new URL(route.request().url());
      return route.fulfill({ json: { ok: true, job: { id: u.searchParams.get('job_id'), op: 'create', status: 'running', stage: 'reading', seq: 1 } } });
    });
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${pid2}/ws/link-demo-2/demo2/${sid2}`);
    const f2 = page.frameLocator('#workspace-frame');
    await expect(f2.locator('#link2-title')).toHaveText('Demo 1', { timeout: 30_000 });
    const accepted = page.waitForResponse((r) => r.url().includes('/api/plugin-geometry/link?'), { timeout: 120_000 });
    await f2.locator('#link2-send').click();
    await accepted;
    const before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page).toHaveURL(new RegExp(`#/p/${pid2}$`));
    await expect(page.locator('#wb-link-wait')).toHaveText('Adding a geometry from Demo 1…', { timeout: 30_000 });
    await expect(page.locator('#wb-empty-cta')).toBeHidden();
    await shot(page, testInfo, 'l3-first-sync-background.png');
    slow = false;
    await awaitLanding(page, before);
    await expect(page.locator('#wb-link-wait')).toBeHidden();
    const first = await linkedOf(request, host, { pid: pid2, sid: sid2 }, 'link-demo-2');
    await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe(first.geometryId);
    await page.unroute('**/api/plugin-geometry/status**');
  });

  test('gate:l3-exits results.openIn3D after a change: the results open and stay, the report after them, the new rev when shown next; from the results a change lands on the new part @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave results');
    const scope = await demoStudy(request, host, pid);
    // A finished case in the study's folder (the committed cavity case).
    const caseDir = join(host.projects, pid, 'plugins', 'link-demo', 'studies', scope.sid, 'cases', 'fixture');
    mkdirSync(caseDir, { recursive: true });
    cpSync(CAVITY, caseDir, { recursive: true });
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const v1Cells = (await viewport(page)).cells;

    // A hook that stalls on Open in 3D: the question after 30 s (the page's call waits for the
    // leave; it is not the hook's work). Stay: the results do not open.
    frame = await openWs(page, scope);
    await frame.locator('#hook-mode').fill('stall');
    await frame.locator('#open3d').click();
    await expect(page.locator('[data-ws-leave-status]')).toHaveText('Updating the project from Demo 1…', { timeout: 5_000 });
    const stalled = await hookFailed(page, false);
    expect(stalled.copy).toBe('Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.');
    await expect(frame.locator('#hook-status')).toHaveText('openIn3D: false', { timeout: 30_000 });
    expect(await page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true)).toBe(false);
    await frame.locator('#hook-mode').fill('sync');
    stage(t1, 'a stall from Open in 3D asked');

    // A change, then Open in 3D: the hook runs with `results`; the results open and stay open.
    // A BC on v1's +y face, which v2 splits: the update touches the setup, so its report is due.
    const bcStudy = await studyWithBc(request, host, pid, gid, 1, 'face 12@Body1');
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    const before = await landings(page);
    // The case attaches slowly here, so the landing is done well before the results show.
    await page.route('**/api/case/attach**', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    });
    await frame.locator('#open3d').click();
    await answerQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    const atReport = [];
    const reports = await awaitLanding(page, before, { results: atReport });
    expect(reports).toEqual(['Demo 1 updated']);
    // The report waited for the results to show.
    expect(atReport).toEqual([true]);
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await page.unroute('**/api/case/attach**');
    expect(hookLog(host, scope).slice(-1)).toEqual(['results']);
    expect(await page.evaluate(() => window.__CFD_LAST_LANDING__ && window.__CFD_LAST_LANDING__.reason)).toBe('results');
    for (let i = 0; i < 10; i++) {
      expect(await page.evaluate(() => window.__CFD_RESULTS_VIEW__)).toBe(true);
      await page.waitForTimeout(300);
    }
    expect((await viewport(page)).stage).toBe('results');
    await shot(page, testInfo, 'l3-results-after-change.png');
    expect((await linkedOf(request, host, scope)).rev).toBe(2);
    // The study goes: the updates below meet no question.
    await deleteStudy(request, host, pid, bcStudy.id);
    stage(t1, 'results opened, report after');

    // An update that lands while the results show (queued, "Continue in background", then the
    // slot frees): no part is loaded over the results (a CAD load fades the results surface
    // to 0.15); the part waits until they close.
    const updateUnderResults = async (version, rev, shotName) => {
      const hold = await request.post(`${host.base}/api/test/slot-hold`);
      expect(hold.ok(), await hold.text()).toBe(true);
      let held = true;
      try {
        await geomRow(page, gid).locator('[data-geom-edit]').click();
        frame = page.frameLocator('#workspace-frame');
        await expect(frame.locator('#hook-on')).toHaveText('on', { timeout: 30_000 });
        await edit(page, frame, version);
        const queuedBefore = await landings(page);
        await frame.locator('#open3d').click();
        // Results show already: H15 asks before replacing them, before the leave.
        await expect(page.locator('#cf-heading')).toHaveText('Open these results?', { timeout: 30_000 });
        await page.locator('#cf-confirm').click();
        await expect(page.locator('[data-ws-leave-background]')).toBeVisible({ timeout: 60_000 });
        await page.locator('[data-ws-leave-background]').click();
        await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
        await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_SURFACE_OPACITY__()), { timeout: 30_000 }).toBe(1);
        await request.post(`${host.base}/api/test/slot-release`);
        held = false;
        await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
        await awaitLanding(page, queuedBefore);
        await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(rev);
        for (let i = 0; i < 10; i++) {
          expect(await page.evaluate(() => window.__CFD_RESULTS_VIEW__)).toBe(true);
          expect(await page.evaluate(() => window.__CFD_RESULTS_SURFACE_OPACITY__())).toBe(1);
          await page.waitForTimeout(300);
        }
        await expect.poll(() => page.evaluate(() => window.__CFD_LINK_CAD_PENDING__()), { timeout: 60_000 }).toBe(gid);
        if (shotName) await shot(page, testInfo, shotName);
      } finally {
        if (held) await request.post(`${host.base}/api/test/slot-release`);
      }
    };
    await updateUnderResults('v1', 3, 'l3-results-update-while-shown.png');
    stage(t1, 'an update landed under the results without touching them');
    // Picking the geometry closes the results: the part that waited loads now (rev 3, v1's part).
    await page.locator(`#geometries-list .geo-item[data-geom-id="${gid}"]`).click();
    await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__CFD_LINK_CAD_PENDING__()), { timeout: 30_000 }).toBe('');
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(v1Cells);
    stage(t1, 'the waiting part loaded when the results closed');
    // The results again (no change: the hook links nothing), and another update under them.
    frame = await openWs(page, scope);
    await frame.locator('#open3d').click();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await updateUnderResults('v2', 4, '');

    // Entering the workspace from the results and changing the part: Back lands on the new part.
    await geomRow(page, gid).locator('[data-geom-edit]').click();
    frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#hook-on')).toHaveText('on', { timeout: 30_000 });
    // The hook stays a moment after its link: the tree read of the update (results still under
    // the workspace) has set the part aside before the landing, which must load it.
    await frame.locator('#hook-after').fill('3000');
    await edit(page, frame, 'v3');
    await backAndLand(page, pid);
    expect((await linkedOf(request, host, scope)).rev).toBe(5);
    await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true), { timeout: 30_000 }).toBe(false);
    expect((await viewport(page)).id).toBe(gid);
    expect((await viewport(page)).stage).toBe('geometry');
    expect(await page.evaluate(() => window.__CFD_LINK_CAD_PENDING__())).toBe('');
    const v3Cells = (await viewport(page)).cells;
    expect(v3Cells).not.toBe(v1Cells);
    await reloadProject(page, pid);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(v3Cells);
    stage(t1, 'from the results to the new part');
  });

  test('gate:l3-exits a names-only change redraws the names without the faces file; picks wait while the landing loads; the camera is applied @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave names');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;

    // The camera: the hook's view (orthographic from +x, 100 mm high).
    frame = await openWs(page, scope);
    await frame.locator('#hook-view').check();
    await edit(page, frame, 'v2');
    await backAndLand(page, pid);
    let cam = await camera(page);
    expect(near(cam.pos, [400, 15, 15]) && near(cam.fp, [0, 15, 15]) && near(cam.vu, [0, 0, 1])).toBe(true);
    expect([cam.parallel, cam.scale]).toEqual([true, 50]);
    await shot(page, testInfo, 'l3-camera-hook.png');
    // The link's view alone (perspective from -y, 30 degrees).
    frame = await openWs(page, scope);
    await frame.locator('#link-view').check();
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    cam = await camera(page);
    expect(near(cam.pos, [15, -400, 15]) && near(cam.fp, [15, 0, 15])).toBe(true);
    expect([cam.parallel, cam.angle]).toEqual([false, 30]);
    // Both: the hook's comes later and wins.
    frame = await openWs(page, scope);
    await frame.locator('#link-view').check();
    await frame.locator('#hook-view').check();
    await edit(page, frame, 'v2');
    await backAndLand(page, pid);
    cam = await camera(page);
    expect(near(cam.pos, [400, 15, 15])).toBe(true);
    expect(cam.parallel).toBe(true);
    // The hook's camera when nothing changed (the hook links nothing): applied all the same.
    await reloadProject(page, pid);
    expect(isHookView(await camera(page))).toBe(false);
    frame = await openWs(page, scope);
    await frame.locator('#hook-view').check();
    const runs = hookLog(host, scope).length;
    expect(await backAndLand(page, pid)).toEqual([]);
    expect(hookLog(host, scope).slice(runs)).toEqual(['back']);
    expect(await page.evaluate(() => window.__CFD_LAST_LANDING__ && window.__CFD_LAST_LANDING__.landed)).toBe('none');
    expect(isHookView(await camera(page))).toBe(true);
    stage(t1, 'camera applied');

    // Back to v1, with a study whose BC sits on the boss end (face 15 in v1).
    frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const rev = (await linkedOf(request, host, scope)).rev;
    const sim = await studyWithBc(request, host, pid, gid, rev, 'face 15@Body1');
    await reloadProject(page, pid);
    // A face hidden and Compare on: a names-only landing keeps them (only a new shape clears them).
    await faceState(page);
    await page.evaluate((x) => window.__CFD_OPEN_BC__(x), sim.bc);
    const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Boss end (face 15)'], { timeout: 30_000 });

    // A names-only change: the names redraw; the faces file is not loaded again; the rev stays.
    const faces = [];
    const onFaces = (r) => {
      if (r.url().includes('/api/geometry/cad') && r.url().includes('part=faces')) faces.push(r.url());
    };
    frame = await openWs(page, scope);
    await edit(page, frame, 'v1-renamed');
    page.on('request', onFaces);
    await backAndLand(page, pid);
    await page.evaluate((x) => window.__CFD_OPEN_BC__(x), sim.bc);
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Renamed Boss end (face 15)'], { timeout: 30_000 });
    page.off('request', onFaces);
    expect(faces).toEqual([]);
    expect((await linkedOf(request, host, scope)).rev).toBe(rev);
    expect(await page.evaluate(() => window.__CFD_LAST_LANDING__ && window.__CFD_LAST_LANDING__.landed)).toBe('names');
    await expect(page.locator('#hidden-faces-chip')).toBeVisible();
    expect((await page.evaluate(() => window.__CFD_VIEWPORT_FACES__())).hidden).toHaveLength(1);
    await expect(page.locator('#compare-bar')).toBeVisible();
    await shot(page, testInfo, 'l3-names-only.png');
    // After a reload too: the new names, the same rev.
    await reloadProject(page, pid);
    await page.evaluate((x) => window.__CFD_OPEN_BC__(x), sim.bc);
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Renamed Boss end (face 15)'], { timeout: 30_000 });
    expect((await linkedOf(request, host, scope)).rev).toBe(rev);
    stage(t1, 'names only');

    // A shape change: while the landing reads the setup again, face picks wait (a pick is dropped).
    let releaseHydrate = () => undefined;
    const holding = new Promise((r) => (releaseHydrate = r));
    let held = 0;
    await page.route('**/api/project/hydrate**', async (route) => {
      held += 1;
      await holding;
      await route.continue();
    });
    frame = await openWs(page, scope);
    await edit(page, frame, 'v2');
    const before = await landings(page);
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await answerQuestion(page, 'overwrite');
    await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 180_000 });
    await expect.poll(() => held, { timeout: 120_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__CFD_FACE_PICKS_PAUSED__())).toBe(true);
    // The BC is open (its records still drawn at the old rev); a face picked now is dropped:
    // not even in the BC's draft.
    expect(await page.evaluate((x) => window.__CFD_OPEN_BC__(x), sim.bc)).toBe(true);
    expect(await page.evaluate(() => window.__CFD_BC_STATE__().active_id)).toBe(sim.bc);
    expect(await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 1@Body1'))).not.toContain('face 1@Body1');
    // A body picked in the viewport for a material now is dropped too.
    await page.evaluate(() => {
      window.__bodies = [];
      document.addEventListener('cfd:bodies', (e) => window.__bodies.push(e.detail.bodies));
      window.__CFD_OPEN_TREE_DETAIL__('air', { toggle: false });
    });
    const [onPart] = await partPoints(page, 1);
    expect(onPart).toBeTruthy();
    await page.mouse.click(onPart.x, onPart.y);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__bodies)).toEqual([]);
    releaseHydrate();
    await awaitLanding(page, before);
    await page.unroute('**/api/project/hydrate**');
    expect(await page.evaluate(() => window.__CFD_FACE_PICKS_PAUSED__())).toBe(false);
    await page.waitForTimeout(1500);
    const bcAfter = (await getJson(request, `${host.base}/api/bcs?project_id=${pid}&simulation_id=${sim.id}`)).boundary_conditions.find((b) => b.id === sim.bc);
    expect(bcAfter.faces).not.toContain('face 1@Body1');
    expect(bcAfter.geometry_rev).toBe(rev + 1);
    // Once the part is loaded the same viewport pick lands.
    await page.evaluate(() => window.__CFD_OPEN_TREE_DETAIL__('air', { toggle: false }));
    const [onNew] = await partPoints(page, 1);
    await page.mouse.click(onNew.x, onNew.y);
    await expect.poll(() => page.evaluate(() => window.__bodies.length), { timeout: 10_000 }).toBe(1);
    stage(t1, 'picks waited for the landing');
    // After a reload too: the part shown is the new rev's.
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    const shown = (await viewport(page)).cells;
    await reloadProject(page, pid);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(shown);
  });

  test('gate:l3-exits queued: "Stay here" keeps the workspace and the update goes on; Back again joins the same job; a stall then still asks; a page reload while queued says the update goes on @plugins', async ({ page, request }) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave stay here');
    const scope = await demoStudy(request, host, pid);
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const wsUrl = new RegExp(`/ws/link-demo/demo/${scope.sid}$`);
    const status = page.locator('[data-ws-leave-status]');
    let held = false;
    const hold = async () => {
      const r = await request.post(`${host.base}/api/test/slot-hold`);
      expect(r.ok(), await r.text()).toBe(true);
      held = true;
    };
    const release = async () => {
      await request.post(`${host.base}/api/test/slot-release`);
      held = false;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: pid } });
    };
    try {
      // A BC on v1's +y face, which v2 splits: the update touches the setup, so its report is due.
      const gid1 = (await linkedOf(request, host, scope)).geometryId;
      const bcStudy = await studyWithBc(request, host, pid, gid1, 1, 'face 12@Body1');
      // Queued, then "Stay here" (twice: the second Back links the same saved design and joins its job).
      await hold();
      frame = await openWs(page, scope);
      await edit(page, frame, 'v2');
      for (let i = 0; i < 2; i++) {
        await page.locator('#workspace-overlay [data-ws-back]').click();
        if (i === 0) await answerQuestion(page, 'overwrite');
        await expect(status).toHaveText(/^Queued( behind \d+ jobs?)? \(see Queue\)$/, { timeout: 60_000 });
        const stay = page.locator('[data-ws-leave-cancel]');
        await expect(stay).toHaveText('Stay here');
        await expect(stay).toHaveAttribute('title', 'The update goes on; the workspace stays open');
        await stay.click();
        await expect(status).toHaveCount(0);
        await expect(page).toHaveURL(wsUrl);
      }
      const queuedRows = ((await getJson(request, `${host.base}/api/compute-queue?project_id=${pid}`)).items || []).filter((r) => r.kind === 'geometry');
      expect(queuedRows).toHaveLength(1);
      // The update goes on, as the button said: it lands while the workspace stays open.
      await release();
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(2);
      // Its report shows over the workspace, which stays open.
      await expect(page.locator('#cf-heading')).toHaveText('Demo 1 updated', { timeout: 60_000 });
      await page.locator('#cf-confirm').click();
      await expect(page.locator('#modal-confirm')).toBeHidden();
      await expect(page).toHaveURL(wsUrl);
      // The study goes: the links below meet no question.
      await deleteStudy(request, host, pid, bcStudy.id);
      stage(t1, 'stayed twice; the joined update landed');

      // A hook that stalls now still asks after 30 s (nothing of the earlier leaves holds it off).
      await frame.locator('#hook-mode').fill('stall');
      await page.locator('#workspace-overlay [data-ws-back]').click();
      const stalled = await hookFailed(page, false);
      expect(stalled.copy).toBe('Link demo: it did not answer for 30 seconds. Demo 1 keeps its last update.');
      await frame.locator('#hook-mode').fill('sync');
      stage(t1, 'a stall after the joined job asked');

      // The page reloads while its link waits in the queue: the question says the update goes on.
      await hold();
      await edit(page, frame, 'v3');
      await page.locator('#workspace-overlay [data-ws-back]').click();
      await expect(status).toHaveText(/^Queued/, { timeout: 60_000 });
      const inner = page.frames().find((f) => f.url().includes('/plugins/link-demo/'));
      expect(inner).toBeTruthy();
      await inner.evaluate(() => location.reload());
      const lost = await hookFailed(page, false);
      expect(lost.copy).toBe('Link demo: its page closed before it finished. The update of Demo 1 goes on.');
      await expect(page).toHaveURL(wsUrl);
      await expect(frame.locator('#hook-on')).toHaveText('on', { timeout: 30_000 });
      await release();
      await expect.poll(async () => (await linkedOf(request, host, scope)).rev, { timeout: 120_000 }).toBe(3);
      // Back: the project shows the update the reloaded page started.
      await backAndLand(page, pid);
      await expect.poll(async () => (await viewport(page)).id, { timeout: 60_000 }).toBe((await linkedOf(request, host, scope)).geometryId);
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
      const shown = (await viewport(page)).cells;
      await reloadProject(page, pid);
      await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(shown);
      stage(t1, 'a reload while queued: the update went on');
    } finally {
      if (held) await request.post(`${host.base}/api/test/slot-release`);
    }
  });

  test('gate:l3-exits a part that waited under the results loads however they close (a mesh row), and picks wait until it does @plugins', async ({ page, request, context }) => {
    test.setTimeout(900_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Leave results closed');
    const scope = await demoStudy(request, host, pid);
    const caseDir = join(host.projects, pid, 'plugins', 'link-demo', 'studies', scope.sid, 'cases', 'fixture');
    mkdirSync(caseDir, { recursive: true });
    cpSync(CAVITY, caseDir, { recursive: true });
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const sim = await studyWithBc(request, host, pid, gid, 1);
    const { meshId } = await generatedMeshAndRun(request, host, pid, sim.id, 1);
    await reloadProject(page, pid);
    const v1Cells = (await viewport(page)).cells;

    // The case's results, opened from the page (nothing changed: nothing is linked).
    frame = await openWs(page, scope);
    await frame.locator('#open3d').click();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    // Another tab overwrites the design from the page's own button.
    const tab2 = await context.newPage();
    try {
      await openProject(tab2, host, pid);
      const f2 = await openWs(tab2, scope);
      await f2.locator('#link-v2').click();
      await answerQuestion(tab2, 'overwrite');
      await expect(f2.locator('#link-status')).toHaveText(/ rev 2$/, { timeout: 180_000 });
    } finally {
      await tab2.close();
    }
    // This tab sets the new part aside under the results; its setup is at rev 2 already, so picks wait.
    await expect.poll(() => page.evaluate(() => window.__CFD_LINK_CAD_PENDING__()), { timeout: 120_000 }).toBe(gid);
    expect(await page.evaluate(() => window.__CFD_FACE_PICKS_PAUSED__())).toBe(true);
    stage(t1, 'the part waits under the results');

    // The results close through a mesh row (no Back, no geometry pick): the part loads.
    await page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`).dispatchEvent('click');
    await expect.poll(() => page.evaluate(() => window.__CFD_RESULTS_VIEW__ === true), { timeout: 30_000 }).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__CFD_LINK_CAD_PENDING__()), { timeout: 30_000 }).toBe('');
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).not.toBe(v1Cells);
    await expect.poll(() => page.evaluate(() => window.__CFD_FACE_PICKS_PAUSED__()), { timeout: 30_000 }).toBe(false);
    // The study again: the part shown is the one a fresh load draws.
    await page.locator(`#left-tree [data-w17-sim-id="${sim.id}"] > .tree-row`).dispatchEvent('click');
    await expect.poll(async () => (await viewport(page)).stage, { timeout: 30_000 }).not.toBe('mesh');
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBeGreaterThan(0);
    const shown = (await viewport(page)).cells;
    await reloadProject(page, pid);
    await expect.poll(async () => (await viewport(page)).cells, { timeout: 60_000 }).toBe(shown);
    stage(t1, 'the results closed by a mesh row: the new part loaded');
  });

  test('gate:l3-exits a study row clicked while a mesh row opens its mesh wins, and over the open mesh it leaves the mesh stage @plugins', async ({ page, request }) => {
    test.setTimeout(300_000);
    const t1 = Date.now();
    const pid = await newProject(request, host, 'Study row over the mesh');
    const scope = await demoStudy(request, host, pid);
    const caseDir = join(host.projects, pid, 'plugins', 'link-demo', 'studies', scope.sid, 'cases', 'fixture');
    mkdirSync(caseDir, { recursive: true });
    cpSync(CAVITY, caseDir, { recursive: true });
    await openProject(page, host, pid);
    let frame = await openWs(page, scope);
    await edit(page, frame, 'v1');
    await backAndLand(page, pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const sim = await studyWithBc(request, host, pid, gid, 1);
    const { meshId } = await generatedMeshAndRun(request, host, pid, sim.id, 1);
    await reloadProject(page, pid);
    const meshRow = page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
    const studyRow = (id) => page.locator(`#left-tree [data-w17-sim-id="${id}"] > .tree-row`);
    const shownStudy = () => page.evaluate(() => String(window.__CFD_W17__?.simulation?.id || ''));
    const inspect = () => page.evaluate(() => window.__CFD_MESH_INSPECT__ === true);
    const stageNow = async () => (await viewport(page)).stage;
    // The mesh's activation held until the study row is clicked (no switch then: it is the study shown).
    const isActivate = (r) => r.method() === 'POST' && /\/api\/mesh$/.test(r.url()) && /"activate"/.test(r.postData() || '');
    let release = () => {};
    await page.route('**/api/mesh', async (route) => {
      if (isActivate(route.request())) await new Promise((r) => (release = r));
      await route.continue();
    });
    const heldClick = async () => {
      const activating = page.waitForRequest(isActivate, { timeout: 30_000 });
      await meshRow.dispatchEvent('click');
      await activating;
      expect(await shownStudy()).toBe(sim.id);
      await studyRow(sim.id).dispatchEvent('click');
      const answered = page.waitForResponse((r) => isActivate(r.request()), { timeout: 30_000 });
      release();
      await answered;
      await page.waitForTimeout(1_500);
      expect(await inspect(), 'the mesh opened after the study row').toBe(false);
      expect(await stageNow()).toBe('setup');
    };

    // From the case's results (no study shown): the mesh row closes them, shows its study, then activates the mesh.
    frame = await openWs(page, scope);
    await frame.locator('#open3d').click();
    await page.waitForFunction(() => window.__CFD_RESULTS_VIEW__ === true, null, { timeout: 120_000 });
    await heldClick();
    stage(t1, 'the study row won over a mesh row clicked from the results');
    // The study's own mesh row, the same way.
    await heldClick();
    stage(t1, 'the study row won over its own mesh row');
    await page.unroute('**/api/mesh');
    // Over the open mesh: the mesh closes and the stage follows.
    await meshRow.dispatchEvent('click');
    await expect.poll(inspect, { timeout: 30_000 }).toBe(true);
    await expect.poll(stageNow).toBe('mesh');
    await studyRow(sim.id).dispatchEvent('click');
    await expect.poll(inspect).toBe(false);
    await expect.poll(stageNow, { timeout: 10_000 }).toBe('setup');
    stage(t1, 'the study row over the open mesh left the mesh stage');
  });
});
