import { expect, test } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, killTree, startHost } from './support/host-server.mjs';

// gate:l2-e2e, linked geometries (host API 1.5) as the user meets them. L2 step 1, "the
// job and the files": a plugin study links its export through the host's link route (the
// workspace bridge's linkGeometry comes with step 2), with the test plugin link-demo
// (python/tests/fixtures/link-plugins) and no bundled plugin but Incompressible Flow:
//   - the first link adds the geometry: its row in the geometry list, the part in the
//     viewport, also after a reload;
//   - Queued: with the compute slot held (MAGNUSIM_TEST_SLOT_HOLD), the update waits in the
//     Queue as "Update <Geometry> from <Study>", and lands when the slot is free;
//   - crash and fence: on a host whose every apply fails (MAGNUSIM_TEST_LINK_FAIL_APPLY),
//     the update stops half way: the geometry's part reads answer "Updating …" at once;
//     after a restart without the switch the recovery finishes it and the part is the new one,
//     also on the page that stayed open through the restart (the recovery's event clears its row).
// L2 step 2, "labels" (the link-demo page links through the bridge, ws.project.linkGeometry):
//   - the row says "from Demo 1" and Edit opens the study; a BC picked after the link and
//     Water on the material save with no 409;
//   - an update keeps BC faces by name (a split keeps both halves); the host's report names
//     the lost face and the face two BCs claimed by their labels; the BC panel, the geometry
//     panel and the tree list them; faces show "Label (face N)" and bodies "Fluid (Body1)";
//     v3 brings the face back; Forget and Forget all clear what stays; all after a reload;
//   - a second tab whose labels are older is told "Demo 1 was updated. This change was not
//     saved.", loads v2, and its next edit saves;
//   - with two Demo studies open, the geometry event reaches only the page that linked.
// L2 step 3, "build stamps and starts":
//   - Back from the page lands on the linked part (a first link and an update), no reload;
//   - a mesh made before an update shows "Out of date" in the tree and its panel; a run
//     started before it "Older geometry", and its panel says face seeds and highlights are
//     off; Generate is refused while a face is claimed twice, and Start on the out-of-date
//     mesh says "Generate Mesh 1 again first"; all also after a reload.
// L2 step 4, "the question and Save as new" (the overwrites above answer the host's question
// "Overwrite <Geometry>"):
//   - v2 on a geometry in use: the host's dialog lists the study under "Copy the setup of
//     <study> onto it"; Save as new keeps "Demo 1" as a plain row with its study, BC and
//     mesh as they were, and adds "Demo 1 v2" (from Demo 1, Edit) with the copied study
//     holding the v2 face; the plugin row says "→ Demo 1 v2"; Keep editing changes nothing
//     and the next link asks again; an unused geometry gets no question;
//   - link-demo-2 (no exit hook, a text BREP its backend wrote, linked by etag) meets the
//     same question from its own button; with its page gone the row says "Waiting for your
//     choice: Demo 3 changed", and Choose… answers it and lands the part;
//   - plugin_needed: with bc-demo off, Overwrite and that study's copy are disabled with the
//     record named; Keep editing leaves "Not up to date"; with bc-demo on, Overwrite commits
//     and the BC family's own face field follows the faces.
// Rows and plugins (gate:l2-e2e):
//   - two plugins in one project (Demo 1 and Demo 2 of link-demo, Demo 3 of link-demo-2):
//     each row's Edit opens its own workspace; both plugins' overwrites wait as "Queued" and
//     run one at a time;
//   - "Not up to date" from a newer saved design, cleared by a link with no change;
//   - the linking plugin off: Edit greyed, the reason and "Open Settings → Plugins", which
//     turns it on again; uninstalled: "from Demo 3 (plugin not installed)" with no Edit;
//   - remove the geometry, then link: a new geometry; delete the study: a plain geometry;
//   - "Adding Demo 1 v2…" while Save as new runs; a stopped run's monitor follows the update.
// Every test: no save of the page is refused as drawn at an old rev (409 geometry_changed).

const EXPORTS = resolve('python/tests/fixtures/link-plugins/link-demo/workspace/exports');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function stage(t0, msg) {
  console.log(`[link-geometry +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

function bundledIfOnly(tmp) {
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  return bundled;
}

/** A project with one Demo study of link-demo: {pid, sid}. */
async function demoProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pj.id, plugin: 'link-demo', kind: 'demo', title: 'Demo 1' } });
  const sj = await s.json();
  expect(s.ok(), JSON.stringify(sj)).toBe(true);
  return { pid: pj.id, sid: sj.study.id };
}

/** The plugin (link-demo unless the scope names another) writes its export into its study's folder, then links it. */
async function link(request, host, { pid, sid, plugin = 'link-demo' }, version, sourceVersion, basedOnRev) {
  const files = {};
  for (const [as, file] of [
    ['shape.bin', `${version}.bbrep`],
    ['names.json', `${version}.face_names.json`],
  ]) {
    const rel = `studies/${sid}/exports/${as}`;
    const dest = join(host.projects, pid, 'plugins', plugin, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = readFileSync(join(EXPORTS, file));
    writeFileSync(dest, buf);
    files[as] = { rel, sha256: sha256(buf) };
  }
  const r = await request.post(`${host.base}/api/plugin-geometry/link`, {
    data: {
      project_id: pid,
      plugin,
      study_id: sid,
      shape: { ...files['shape.bin'], format: 'brep' },
      face_names: files['names.json'],
      source_version: sourceVersion,
      based_on_rev: basedOnRev,
    },
  });
  const body = await r.json();
  expect(r.status(), JSON.stringify(body)).toBeLessThan(300);
  return body;
}

async function jobStatus(request, host, { pid, sid, plugin = 'link-demo' }, jobId) {
  return (await getJson(request, `${host.base}/api/plugin-geometry/status?project_id=${pid}&plugin=${plugin}&study_id=${sid}&job_id=${jobId}`)).job;
}

/** The user's answer to the host's question, through the route the dialog uses. */
async function chooseApi(request, host, { pid, sid, plugin = 'link-demo' }, jobId, choice) {
  const r = await request.post(`${host.base}/api/plugin-geometry/choose`, { data: { project_id: pid, plugin, study_id: sid, job_id: jobId, choice, copy: [] } });
  const j = await r.json();
  expect(r.status(), JSON.stringify(j)).toBeLessThan(300);
  return j;
}

async function until(request, host, scope, jobId, statuses = ['done', 'failed', 'busy', 'gone', 'stale', 'cancelled']) {
  let job = null;
  await expect
    .poll(
      async () => {
        job = await jobStatus(request, host, scope, jobId);
        return statuses.includes(job && job.status) ? job.status : `${job && job.status} ${job && job.stage}`;
      },
      { timeout: 180_000, intervals: [250] },
    )
    .toMatch(new RegExp(`^(${statuses.join('|')})$`));
  return job;
}

async function openProject(page, host, pid) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

/** The geometry the viewport shows, and its faces as the viewport loaded them. */
async function shownPart(page, host, pid, gid) {
  await expect.poll(() => page.evaluate(() => window.__CFD_W16__?.geometry?.id || null), { timeout: 60_000 }).toBe(gid);
  return page.evaluate(
    async ([base, p, g]) => {
      const r = await fetch(`${base}/api/geometry/cad?project_id=${p}&geometry_id=${g}&part=meta`);
      const meta = r.ok ? await r.json() : null;
      return { status: r.status, zmax: meta ? Math.round(meta.bounds.zmax) : null, faces: meta ? meta.n_faces : null };
    },
    [host.base, pid, gid],
  );
}

let t0 = 0;

// Every test: no save the page makes is refused as drawn at an old rev. A test that means to
// meet that refusal does so in a second page, which this does not watch.
/** @type {string[]} */
let refusals = [];
test.beforeEach(async ({ page }) => {
  refusals = [];
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

test.describe('linked geometries', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    t0 = Date.now();
    const tmp = e2eTemp('link-geometry');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'link-geometry',
      tmp,
      projects,
      bundledDir: bundledIfOnly(tmp),
      pluginsFrom: 'python/tests/fixtures/link-plugins',
      env: { MAGNUSIM_TEST_SLOT_HOLD: '1' },
    });
    stage(t0, `server up at ${host.base}`);
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-e2e first link: the geometry is in the list and its part in the viewport, also after a reload @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const scope = await demoProject(request, host, 'Link first');
    const r = await link(request, host, scope, 'v1', 1, null);
    expect([r.created, r.queued]).toEqual([true, false]);
    const job = await until(request, host, scope, r.job_id);
    expect(job.status, job.error).toBe('done');
    stage(t0, `linked ${r.geometry_id}`);
    await openProject(page, host, scope.pid);
    const row = page.locator(`#geometries-list .geo-item[data-geom-id="${r.geometry_id}"]`);
    await expect(row).toContainText('Demo 1');
    expect(await shownPart(page, host, scope.pid, r.geometry_id)).toEqual({ status: 200, zmax: 35, faces: 21 });
    await page.screenshot({ path: testInfo.outputPath('first-link.png'), timeout: 15_000 }).catch(() => {});
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, scope.pid, { timeout: 60_000 });
    await expect(row).toContainText('Demo 1');
    expect(await shownPart(page, host, scope.pid, r.geometry_id)).toEqual({ status: 200, zmax: 35, faces: 21 });
  });

  test('gate:l2-e2e queued: with the slot held the Queue shows "Update Demo 1 from Demo 1"; the part lands when it frees @plugins', async ({ page, request }) => {
    test.setTimeout(240_000);
    const scope = await demoProject(request, host, 'Link queued');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const hold = await request.post(`${host.base}/api/test/slot-hold`);
    expect(hold.ok(), await hold.text()).toBe(true);
    let released = false;
    try {
      const r = await link(request, host, scope, 'v2', 2, 1);
      expect([r.created, r.queued, r.geometry_id]).toEqual([false, true, first.geometry_id]);
      await openProject(page, host, scope.pid);
      await page.locator('#btn-queue').click();
      await expect(page.locator('#job-queue-list li')).toHaveCount(1);
      await expect(page.locator('#job-queue-list li').first()).toContainText('Update Demo 1 from Demo 1');
      await expect(page.locator('#job-queue-now')).toContainText('Checking for jobs left running');
      expect((await jobStatus(request, host, scope, r.job_id)).status).toBe('queued');
      await page.keyboard.press('Escape');
      const rel = await request.post(`${host.base}/api/test/slot-release`);
      expect(rel.ok()).toBe(true);
      released = true;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: scope.pid } });
      const job = await until(request, host, scope, r.job_id);
      expect(job.status, job.error).toBe('done');
      expect([job.result.change, job.result.rev, job.result.fromRev]).toEqual(['shape', 2, 1]);
      await page.locator('#btn-queue').click();
      await expect(page.locator('#job-queue-list li')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.reload();
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, scope.pid, { timeout: 60_000 });
      expect(await shownPart(page, host, scope.pid, first.geometry_id)).toEqual({ status: 200, zmax: 30, faces: 17 });
    } finally {
      if (!released) await request.post(`${host.base}/api/test/slot-release`);
    }
  });
});

test('gate:l2-e2e crash and fence: an update that cannot finish fences its geometry; a restart finishes it @plugins', async ({ page, request }) => {
  test.setTimeout(420_000);
  const t1 = Date.now();
  const tmp = e2eTemp('link-fence');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const bundledDir = bundledIfOnly(tmp);
  const pluginsDir = join(tmp, 'plugins');
  cpSync(resolve('python/tests/fixtures/link-plugins'), pluginsDir, { recursive: true });
  const boot = (env, port = 0) => startHost({ name: 'link-fence', tmp, projects, pluginsDir, bundledDir, seed: false, env, ...(port ? { port } : {}) });
  let host = await boot({ MAGNUSIM_TEST_LINK_FAIL_APPLY: '1' });
  try {
    const scope = await demoProject(request, host, 'Link fence');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const gid = first.geometry_id;
    // A study with a BC on it, and the project open on v1 before the update.
    const sim = await apiStudy(request, host, scope.pid, gid);
    const bcId = await apiBc(request, host, scope.pid, sim.id, 'Wall 1', ['face 12@Body1'], 1);
    await openProject(page, host, scope.pid);
    expect(await shownPart(page, host, scope.pid, gid)).toEqual({ status: 200, zmax: 35, faces: 21 });
    const shownNow = () => page.evaluate(() => ({ id: window.__CFD_W16__?.geometry?.id || null, ready: !!window.__CFD_W16__?.ready, cells: window.__CFD_W16__?.fingerprint?.nCells || 0 }));
    const before = await shownNow();
    expect(before.cells).toBeGreaterThan(0);
    const r = await link(request, host, scope, 'v2', 2, 1);
    expect(r.choosing, 'the geometry is in use: the host asks').toBeTruthy();
    await chooseApi(request, host, scope, r.job_id, 'overwrite');
    await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: scope.pid } });
    const job = await until(request, host, scope, r.job_id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe("Couldn't finish updating Demo 1. The app will finish it.");
    stage(t1, 'the update stopped half way');
    // The open page: the row says so, the viewport keeps the part, a face picked into the
    // BC is not saved and says why, and no error toast shows.
    const row = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
    await expect(row.locator('[data-geom-link-status]')).toHaveText("Couldn't finish updating Demo 1", { timeout: 60_000 });
    expect(await shownNow()).toEqual(before);
    await openBcPanel(page, bcId);
    await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 1@Body1'));
    await expect(page.locator('#modal-confirm')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#cf-copy')).toHaveText('Updating Demo 1. Try again in a moment.');
    await page.locator('#cf-confirm').click();
    const onDisk = JSON.parse(readFileSync(join(recordDirOf(host.projects, scope.pid, sim.id, 'boundary_conditions', bcId), 'bc.json'), 'utf8'));
    expect(onDisk.faces).toEqual(['face 12@Body1']);
    await expect(page.locator('.app-toasts > *')).toHaveCount(0);
    await expect(page.locator('#job-finish-toast')).toBeHidden();
    expect(await shownNow()).toEqual(before);
    // Its part reads answer at once with "Updating …"; the tree marks it updating.
    const reads = await page.evaluate(
      async ([base, p, g]) => {
        const out = {};
        for (const part of ['meta', 'faces']) {
          const t = Date.now();
          const res = await fetch(`${base}/api/geometry/cad?project_id=${p}&geometry_id=${g}&part=${part}`);
          out[part] = { status: res.status, ms: Date.now() - t, error: (await res.json()).error };
        }
        const tree = await (await fetch(`${base}/api/project/tree?project_id=${p}`)).json();
        out.updating = tree.geometries.find((x) => x.id === g).updating;
        return out;
      },
      [host.base, scope.pid, gid],
    );
    expect(reads.meta).toMatchObject({ status: 503, error: 'Updating Demo 1. Try again in a moment.' });
    expect(reads.faces.status).toBe(503);
    expect(reads.meta.ms).toBeLessThan(5000);
    expect(reads.updating).toBe(true);
    // A restart without the switch: the recovery finishes the update before anything else.
    // The page stays on screen through it, on the same port. (The dev server's client would
    // reload it once the server answers, before or after the recovery; that is off here, so
    // this is the page that showed "Couldn't finish updating" and read the tree while fenced.)
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    const facesAgain = page.waitForResponse((res) => /\/api\/geometry\/cad\?/.test(res.url()) && res.url().includes(`geometry_id=${gid}`) && res.url().includes('part=faces') && res.status() === 200, { timeout: 180_000 })
      .then(() => true, () => false);
    const port = host.port;
    killTree(host.pid);
    host = await boot({}, port);
    stage(t1, `restarted at ${host.base}`);
    await expect
      .poll(
        async () => {
          const tree = await getJson(request, `${host.base}/api/project/tree?project_id=${scope.pid}`);
          const g = tree.geometries.find((x) => x.id === gid);
          return `${g.rev} ${g.updating}`;
        },
        { timeout: 120_000 },
      )
      .toBe('2 false');
    // The open page hears the fence end: its row clears and the viewport loads the new part.
    await expect(row.locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 60_000 });
    expect(await facesAgain, 'the open page loads the part again').toBe(true);
    expect(await shownPart(page, host, scope.pid, gid)).toEqual({ status: 200, zmax: 30, faces: 17 });
    // A fresh load shows the new part and no status.
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, scope.pid, { timeout: 60_000 });
    expect(await shownPart(page, host, scope.pid, gid)).toEqual({ status: 200, zmax: 30, faces: 17 });
    await expect.poll(async () => (await shownNow()).cells, { timeout: 60_000 }).not.toBe(before.cells);
    await expect(row.locator('[data-geom-link-status]')).toHaveCount(0);
  } finally {
    host.stop();
  }
});

// ---- L2 step 2, labels: linking from the plugin's page through the bridge -------------------

/** The Demo study's workspace, and its page's frame. */
async function openWorkspace(page, host, { pid, sid }) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${pid}/ws/link-demo/demo/${sid}`);
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/ws/link-demo/demo/${sid}$`));
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('#link-title')).toHaveText('Demo 1', { timeout: 30_000 });
  return frame;
}

/** Click the page's own link button and wait for the result it shows. */
async function linkFromPage(frame, version, status) {
  await frame.locator(`#link-${version}`).click();
  await expect(frame.locator('#link-status')).toHaveText(status, { timeout: 180_000 });
}

/** Back from the workspace to the project. */
async function back(page, pid) {
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
}

async function linkedOf(request, host, { pid, sid }) {
  return (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo&study_id=${sid}`)).linked;
}

async function createStudy(page) {
  await page.locator('#btn-create-simulation').click();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  return page.evaluate(() => window.__CFD_W17__.activeId);
}

/** A BC of this kind through the picker, its face picked (the pick hook goes through the click's path); its id. */
async function addBcWithFace(page, request, host, pid, sid, key, face) {
  const bcs = async () => ((await getJson(request, `${host.base}/api/bcs?project_id=${pid}&simulation_id=${sid}`)).boundary_conditions || []);
  const before = (await bcs()).length;
  await page.locator('#btn-bcs-plus').click();
  await page.locator(`#panel-bc-picker .cfd-island [data-bc-key="${key}"]`).click();
  await page.locator('#panel-bc-picker .cfd-island [data-bc-add="1"]').click();
  await expect(page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await bcs()).length).toBe(before + 1);
  const id = await page.evaluate(() => window.__CFD_BC_STATE__().active_id);
  await page.evaluate((f) => window.__CFD_ASSIGN_FACE__(f), face);
  await expect.poll(async () => ((await bcs()).find((b) => b.id === id) || {}).faces, { timeout: 15_000 }).toEqual([face]);
  return id;
}

async function bcOnDisk(request, host, pid, sid, id) {
  return ((await getJson(request, `${host.base}/api/bcs?project_id=${pid}&simulation_id=${sid}`)).boundary_conditions || []).find((b) => b.id === id);
}

async function openBcPanel(page, id) {
  await page.evaluate((x) => window.__CFD_OPEN_BC__(x), id);
  const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
  await expect(editor).toHaveAttribute('data-bc-id', id, { timeout: 15_000 });
  return editor;
}

/** The report the host shows after an update the page made, then OK. */
async function readReport(page, shot = '') {
  const modal = page.locator('#modal-confirm');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const out = { title: await page.locator('#cf-heading').textContent(), copy: await page.locator('#cf-copy').textContent() };
  if (shot) await page.screenshot({ path: shot }).catch(() => {});
  await page.locator('#cf-confirm').click();
  await expect(modal).toBeHidden();
  return out;
}

async function reloadProject(page, pid) {
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

test.describe('linked geometries: labels (L2 step 2)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('link-labels');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({ name: 'link-labels', tmp, projects, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/link-plugins' });
  });
  // A failed test keeps the server's output beside its trace.
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-e2e an update keeps BC faces by name, shows a lost face by its label until it comes back, and Forget clears what stays @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const t1 = Date.now();
    // Every save on the way must pass the stamp check: no 409 for a missing stamp.
    const refused = [];
    page.on('response', (r) => {
      if (r.status() === 409 && /\/api\/(bcs|materials|worker|mesh|run|geometry)/.test(r.url())) refused.push(r.url());
    });
    const scope = await demoProject(request, host, 'Link labels');
    await openProject(page, host, scope.pid);
    // The first link, from the plugin's own page.
    let frame = await openWorkspace(page, host, scope);
    await linkFromPage(frame, 'v1', 'shape rev 1');
    await back(page, scope.pid);
    // Opened again here (the landing itself is the step 3 test's).
    await reloadProject(page, scope.pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const geomRow = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
    await expect(geomRow.locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
    // Edit opens the study in its workspace.
    await geomRow.locator('[data-geom-edit]').click();
    frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#link-title')).toHaveText('Demo 1', { timeout: 30_000 });
    await back(page, scope.pid);
    stage(t1, `linked ${gid}`);

    // A simulation study on it (the BCs keep their default names): top (Wall 1) on the boss end, side (Wall 2)
    // on the +y face, inlet (Velocity inlet 1) and outlet (Pressure 1) on the two +x halves.
    const sim = await createStudy(page);
    const top = await addBcWithFace(page, request, host, scope.pid, sim, 'wall', 'face 15@Body1');
    const side = await addBcWithFace(page, request, host, scope.pid, sim, 'wall', 'face 12@Body1');
    const inlet = await addBcWithFace(page, request, host, scope.pid, sim, 'velocity_inlet', 'face 6@Body1');
    const outlet = await addBcWithFace(page, request, host, scope.pid, sim, 'pressure_outlet', 'face 14@Body1');
    // A BC added after the link keeps its face across a reload, with no 409.
    await reloadProject(page, scope.pid);
    expect((await bcOnDisk(request, host, scope.pid, sim, top)).faces).toEqual(['face 15@Body1']);
    expect((await bcOnDisk(request, host, scope.pid, sim, top)).geometry_rev).toBe(1);
    let editor = await openBcPanel(page, top);
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Boss end (face 15)']);
    stage(t1, 'BCs set');

    // Water onto the study's material, through the Materials panel: saved, and still Water after a reload.
    const mat = await request.post(`${host.base}/api/materials`, { data: { project_id: scope.pid, simulation_id: sim, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 } });
    expect(mat.ok(), await mat.text()).toBe(true);
    await reloadProject(page, scope.pid);
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w18-air="1"] > .tree-row`).first().click();
    const fluid = page.locator('#panel-air-material .cfd-island select[aria-label="Fluid"]');
    // The panel has loaded the study's material (Body1 assigned) before the pick: a pick made
    // earlier would be a new material, not this one.
    await expect(page.locator('#panel-air-material [data-material-volumes="1"] [data-volume="Body1"] .mat-assign-state')).toHaveText('Assigned', { timeout: 15_000 });
    await fluid.selectOption('Water');
    await expect.poll(async () => (await getJson(request, `${host.base}/api/materials?project_id=${scope.pid}&simulation_id=${sim}`)).air?.name, { timeout: 15_000 }).toBe('Water');
    await expect(page.locator('#panel-air-material [data-material-volumes="1"] [data-volume="Body1"] button')).toHaveText('Body 1 (Body1)');
    await reloadProject(page, scope.pid);
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w18-air="1"] > .tree-row`).first().click();
    // (The option's value is the material model's key since 18443ac; the user reads its label.)
    await expect(page.locator('#panel-air-material .cfd-island select[aria-label="Fluid"] option:checked')).toHaveText('Water');

    // v2, from the page: the report names the lost face and the face two BCs claimed by their labels.
    frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    await answerQuestion(page, 'overwrite');
    const r2 = await readReport(page, testInfo.outputPath('report-v2.png'));
    await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 60_000 });
    expect(r2.title).toBe('Demo 1 updated');
    expect(r2.copy).toContain("These faces are gone. Each one stays listed on its record and comes back if the face does:");
    expect(r2.copy).toMatch(/› Wall 1: 'Boss end'/);
    expect(r2.copy).toContain("Pick one: 'Box +x' was in Pressure 1 and Velocity inlet 1.");
    await back(page, scope.pid);
    // The same geometry and study; the BC lists its lost face by label; Side keeps both halves of +y.
    expect((await linkedOf(request, host, scope)).geometryId).toBe(gid);
    editor = await openBcPanel(page, top);
    await expect(editor.locator('[data-bc-lost="1"] [data-lost-face]')).toHaveText(['Boss endForget']);
    editor = await openBcPanel(page, side);
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Box +y (face 4)', 'Box +y (face 8)']);
    await expect(geomRow.locator('[data-geom-lost]')).toHaveText('3 lost faces', { timeout: 30_000 });
    // Body labels: the design renamed Body 1 "Fluid" (same id): the tree and the Materials panel.
    await expect(page.locator(`#left-tree [data-w16-geom="${gid}"] [data-w16-body="1"][data-body-index="1"] > .tree-row .tl`)).toHaveText('Fluid (Body1)');
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w18-air="1"] > .tree-row`).first().click();
    await expect(page.locator('#panel-air-material [data-material-volumes="1"] [data-volume="Body1"] button')).toHaveText('Fluid (Body1)');
    // The geometry panel: its source, its last update and every lost face.
    await geomRow.locator('.tl').click();
    const panel = page.locator('#panel-geometry .cfd-island');
    await expect(panel.locator('[data-geometry-source]')).toHaveText('from Demo 1', { timeout: 15_000 });
    await expect(panel.locator('[data-geometry-last-update]')).toHaveText('Rev 2 (from rev 1): 3 faces lost.');
    await expect(panel.locator('[data-geometry-lost] [data-lost-face]')).toHaveCount(3);
    await expect(panel.locator('[data-geometry-lost]')).toContainText("Wall 1: Boss end");
    // All of it after a reload too.
    await reloadProject(page, scope.pid);
    await expect(geomRow.locator('[data-geom-lost]')).toHaveText('3 lost faces', { timeout: 30_000 });
    stage(t1, 'v2 landed');

    // v3 brings the boss back: the report says so and Top has its face again.
    frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v3').click();
    await answerQuestion(page, 'overwrite');
    const r3 = await readReport(page);
    expect(r3.copy).toContain('These came back:');
    expect(r3.copy).toMatch(/› Wall 1: 'Boss end'/);
    await expect(frame.locator('#link-status')).toHaveText('shape rev 3', { timeout: 60_000 });
    // The same design again: no change, no job and no geometry event; the rev stays.
    await expect(frame.locator('#link-events')).toContainText('rev 3');
    const eventsBefore = await frame.locator('#link-events').textContent();
    await frame.locator('#link-v3').click();
    await expect(frame.locator('#link-status')).toHaveText('none rev 3', { timeout: 60_000 });
    expect((await linkedOf(request, host, scope)).rev).toBe(3);
    await expect(frame.locator('#link-events')).toHaveText(eventsBefore || '');
    await back(page, scope.pid);
    expect((await bcOnDisk(request, host, scope.pid, sim, top)).lost_faces).toEqual([]);
    editor = await openBcPanel(page, top);
    await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Boss end (face 3)']);
    await expect(editor.locator('[data-bc-lost="1"]')).toHaveCount(0);

    // Forget: one entry from its BC, then every entry from the geometry panel; both stay gone after a reload.
    editor = await openBcPanel(page, inlet);
    await expect(editor.locator('[data-bc-lost="1"] [data-lost-face]')).toHaveCount(1);
    await editor.locator('[data-bc-lost="1"]').getByRole('button', { name: 'Forget' }).click();
    await expect(editor.locator('[data-bc-lost="1"]')).toHaveCount(0, { timeout: 15_000 });
    await reloadProject(page, scope.pid);
    expect((await bcOnDisk(request, host, scope.pid, sim, inlet)).lost_faces).toEqual([]);
    await geomRow.locator('.tl').click();
    await expect(panel.locator('[data-geometry-lost] [data-lost-face]')).toHaveCount(1, { timeout: 15_000 });
    await panel.getByRole('button', { name: 'Forget all' }).click();
    await expect(panel.locator('[data-geometry-lost]')).toHaveCount(0, { timeout: 15_000 });
    await reloadProject(page, scope.pid);
    expect((await bcOnDisk(request, host, scope.pid, sim, outlet)).lost_faces).toEqual([]);
    await expect(geomRow.locator('[data-geom-lost]')).toHaveCount(0);
    expect(refused, 'no save was refused for a missing stamp').toEqual([]);
    stage(t1, 'done');
  });

  test('gate:l2-e2e a second tab: its BC edit drawn at the old rev is not saved, it says why and loads v2, and the next edit saves @plugins', async ({ page, browser, request }) => {
    test.setTimeout(420_000);
    const scope = await demoProject(request, host, 'Link second tab');
    await openProject(page, host, scope.pid);
    let frame = await openWorkspace(page, host, scope);
    await linkFromPage(frame, 'v1', 'shape rev 1');
    await back(page, scope.pid);
    await reloadProject(page, scope.pid);
    const sim = await createStudy(page);
    const side = await addBcWithFace(page, request, host, scope.pid, sim, 'wall', 'face 12@Body1');
    // The second tab loads the project at rev 1 and hears nothing of the update (its link
    // events are cut, as for a tab whose connection dropped).
    const ctx2 = await browser.newContext();
    const tab2 = await ctx2.newPage();
    try {
      await tab2.route('**/api/plugin-geometry/events**', (r) => r.abort());
      await openProject(tab2, host, scope.pid);
      await tab2.evaluate((x) => window.__CFD_OPEN_BC__(x), side);
      await expect(tab2.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]')).toHaveAttribute('data-bc-id', side, { timeout: 15_000 });
      // v2 from the first tab.
      frame = await openWorkspace(page, host, scope);
      await frame.locator('#link-v2').click();
      await answerQuestion(page, 'overwrite');
      await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 180_000 });
      // The second tab picks a face drawn at rev 1: refused, said, and the tab loads v2.
      await tab2.evaluate(() => window.__CFD_ASSIGN_FACE__('face 1@Body1'));
      await expect(tab2.locator('#modal-confirm')).toBeVisible({ timeout: 30_000 });
      await expect(tab2.locator('#cf-copy')).toHaveText('Demo 1 was updated. This change was not saved.');
      await tab2.locator('#cf-confirm').click();
      const ed2 = tab2.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
      expect((await bcOnDisk(request, host, scope.pid, sim, side)).faces.slice().sort()).toEqual(['face 4@Body1', 'face 8@Body1']);
      await expect(ed2.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Box +y (face 4)', 'Box +y (face 8)'], { timeout: 30_000 });
      // The next edit saves.
      await tab2.evaluate(() => window.__CFD_ASSIGN_FACE__('face 1@Body1'));
      await expect.poll(async () => (await bcOnDisk(request, host, scope.pid, sim, side)).faces.slice().sort(), { timeout: 15_000 }).toEqual([
        'face 1@Body1',
        'face 4@Body1',
        'face 8@Body1',
      ]);
      expect((await bcOnDisk(request, host, scope.pid, sim, side)).geometry_rev).toBe(2);
    } finally {
      await ctx2.close();
    }
  });

  test('gate:l2-e2e two Demo studies open in two tabs: the geometry event reaches only the page of the study that linked @plugins', async ({ page, browser, request }) => {
    test.setTimeout(300_000);
    const a = await demoProject(request, host, 'Link two pages');
    const s2 = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: a.pid, plugin: 'link-demo', kind: 'demo', title: 'Demo 2' } });
    const b = { pid: a.pid, sid: (await s2.json()).study.id };
    await openProject(page, host, a.pid);
    const frameA = await openWorkspace(page, host, a);
    const ctx2 = await browser.newContext();
    const tab2 = await ctx2.newPage();
    try {
      await openProject(tab2, host, b.pid);
      await tab2.evaluate((h) => {
        window.location.hash = h;
      }, `#/p/${b.pid}/ws/link-demo/demo/${b.sid}`);
      const frameB = tab2.frameLocator('#workspace-frame');
      await expect(frameB.locator('#link-title')).toHaveText('Demo 2', { timeout: 30_000 });
      await linkFromPage(frameA, 'v1', 'shape rev 1');
      await linkFromPage(frameA, 'v2', 'shape rev 2');
      await expect(frameA.locator('#link-events')).toHaveText('rev 1, rev 2', { timeout: 30_000 });
      await tab2.waitForTimeout(2000);
      await expect(frameB.locator('#link-events')).toHaveText('');
    } finally {
      await ctx2.close();
    }
  });
});

// ---- L2 step 3, build stamps and starts --------------------------------------------------

/** The folder of a mesh or run record of the project, by its id. */
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
  throw new Error(`no ${kind} folder for ${id}`);
}

/** A study's folder, by its id. */
function studyFolder(projects, pid, simId) {
  const geoms = join(projects, pid, 'geometries');
  for (const g of readdirSync(geoms)) {
    const sims = join(geoms, g, 'simulations');
    if (!existsSync(sims)) continue;
    for (const s of readdirSync(sims)) {
      try {
        if (JSON.parse(readFileSync(join(sims, s, 'id.json'), 'utf8')).id === simId) return join(sims, s);
      } catch {
        /* not a study */
      }
    }
  }
  throw new Error(`no study folder for ${simId}`);
}

test.describe('linked geometries: build stamps and starts (L2 step 3)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('link-build');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({ name: 'link-build', tmp, projects, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/link-plugins' });
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-e2e Back lands on the linked part; a mesh made before v2 is "Out of date", Generate and Start say why, a run on v1 is on an older geometry @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const t1 = Date.now();
    const scope = await demoProject(request, host, 'Link build');
    await openProject(page, host, scope.pid);
    // The first link from the page, then Back: the new geometry is shown, with no reload.
    let frame = await openWorkspace(page, host, scope);
    await linkFromPage(frame, 'v1', 'shape rev 1');
    await back(page, scope.pid);
    const gid = (await linkedOf(request, host, scope)).geometryId;
    const geomRow = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
    await expect(geomRow.locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 60_000 });
    expect(await shownPart(page, host, scope.pid, gid)).toEqual({ status: 200, zmax: 35, faces: 21 });
    stage(t1, `landed on ${gid}`);

    // A study whose two BCs hold the two halves of +x (v2 merges them), a mesh and two runs.
    const sim = await createStudy(page);
    const inlet = await addBcWithFace(page, request, host, scope.pid, sim, 'velocity_inlet', 'face 6@Body1');
    const outlet = await addBcWithFace(page, request, host, scope.pid, sim, 'pressure_outlet', 'face 14@Body1');
    const mat = await request.post(`${host.base}/api/materials`, { data: { project_id: scope.pid, simulation_id: sim, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 } });
    expect(mat.ok(), await mat.text()).toBe(true);
    const meshes = async () => (await getJson(request, `${host.base}/api/mesh?project_id=${scope.pid}&simulation_id=${encodeURIComponent(sim)}`)).meshes || [];
    await page.locator(`#left-tree [data-w17-sim-id="${sim}"] [data-w20-mesh="1"] > .tree-row .tl`).first().click();
    await page.locator('#btn-create-mesh').click({ timeout: 15_000 });
    let meshId = '';
    await expect.poll(async () => (meshId = String(((await meshes())[0] || {}).id || '')), { timeout: 15_000 }).not.toBe('');
    // As its generate leaves it at rev 1 (no mesher here): a whole polyMesh, stamped rev 1.
    const meshDir = recordDir(host.projects, scope.pid, 'mesh', meshId);
    const caseDir = join(meshDir, 'case');
    mkdirSync(join(caseDir, 'constant', 'polyMesh'), { recursive: true });
    for (const n of ['points', 'faces', 'owner', 'neighbour']) writeFileSync(join(caseDir, 'constant', 'polyMesh', n), `${n}\n`);
    // One patch per BC, as a generate after the BCs were set names them.
    writeFileSync(
      join(caseDir, 'constant', 'polyMesh', 'boundary'),
      [
        'FoamFile { version 2.0; format ascii; class polyBoundaryMesh; location "constant/polyMesh"; object boundary; }',
        '3',
        '(',
        ...[
          ['velocity_inlet_1', 'patch'],
          ['pressure_1', 'patch'],
          ['wall', 'wall'],
        ].flatMap(([name, type], i) => [`    ${name}`, '    {', `        type            ${type};`, '        nFaces          1;', `        startFace       ${i};`, '    }']),
        ')',
        '',
      ].join('\n'),
    );
    const meshFile = join(meshDir, 'mesh.json');
    const meshRec = JSON.parse(readFileSync(meshFile, 'utf8'));
    writeFileSync(
      meshFile,
      JSON.stringify({
        ...meshRec,
        generated: true,
        live_mesh_result: { status: 'done', generate_id: 'g-e2e', built_from_rev: 1, n_cells: 8, n_points: 27, case_dir: caseDir, mesh_path: join(caseDir, 'constant', 'polyMesh') },
      }),
    );
    const made = async (name) => {
      const r = await request.post(`${host.base}/api/run/create`, { data: { project_id: scope.pid, simulation_id: sim, name, mesh_id: meshId } });
      const j = await r.json();
      expect(r.ok(), JSON.stringify(j)).toBe(true);
      return String(j.run_id || (j.run && (j.run.id || j.run.run_id)) || j.id);
    };
    const run1 = await made('Fresh run');
    const run2 = await made('Old run');
    // Run 2 was started on rev 1 (as Start leaves it): stopped, with its build stamp.
    const run2File = join(recordDir(host.projects, scope.pid, 'run', run2), 'run.json');
    writeFileSync(run2File, JSON.stringify({ ...JSON.parse(readFileSync(run2File, 'utf8')), status: 'stopped', built_from: { mesh_id: meshId, generate_id: 'g-e2e', geometry_rev: 1 } }));
    await reloadProject(page, scope.pid);
    const meshRow = page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`);
    await expect(meshRow).toBeVisible({ timeout: 30_000 });
    await expect(meshRow.locator('[data-mesh-out-of-date]')).toHaveCount(0);
    await expect(page.locator(`#left-tree [data-w27-run="${run2}"] > .tree-row [data-run-older-geometry]`)).toHaveCount(0);
    stage(t1, 'mesh and runs at rev 1');

    // v2 from the page, then Back: the same geometry at v2 in the viewport, with no reload.
    frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    await answerQuestion(page, 'overwrite');
    await readReport(page);
    await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 60_000 });
    await back(page, scope.pid);
    await expect.poll(async () => (await shownPart(page, host, scope.pid, gid)).zmax, { timeout: 60_000 }).toBe(30);
    await expect.poll(() => page.evaluate(() => window.__CFD_LAST_LANDING__ && window.__CFD_LAST_LANDING__.landed), { timeout: 60_000 }).toBe('reloaded');

    // The mesh is out of date: its row and its panel say so; the run on rev 1 is on an older geometry.
    const runPanel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
    const form = page.locator('#panel-mesh-form .cfd-island');
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(meshRow.locator('[data-mesh-out-of-date]')).toHaveText('Out of date', { timeout: 30_000 });
      await expect(page.locator(`#left-tree [data-w27-run="${run2}"] > .tree-row [data-run-older-geometry]`)).toHaveText('Older geometry');
      await expect(page.locator(`#left-tree [data-w27-run="${run1}"] > .tree-row [data-run-older-geometry]`)).toHaveCount(0);
      await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
      await expect(form.locator('[data-mesh-out-of-date-line]')).toHaveText('Out of date: made from an older version of Demo 1. Generate it again.', { timeout: 30_000 });
      await page.locator(`#left-tree [data-w27-run="${run2}"] > .tree-row .tl`).first().click();
      await expect(runPanel).toHaveAttribute('data-run-id', run2, { timeout: 15_000 });
      await expect(runPanel.locator('[data-run-older]')).toHaveText('This run was made on an older version of Demo 1. Face seeds and highlights are off for it.');
      if (pass === 0) await reloadProject(page, scope.pid);
    }
    await page.screenshot({ path: testInfo.outputPath('out-of-date.png') }).catch(() => {});
    stage(t1, 'out of date shown');

    // Claimed twice (D25): Generate is refused and says why.
    const claimed = "Face 'Box +x' was in Pressure 1 and Velocity inlet 1 after Demo 1 changed. Pick which one keeps it.";
    await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
    await form.locator('[data-mesh-generate="1"]').click();
    await expect(form.locator('[role="alert"]')).toHaveText(claimed, { timeout: 30_000 });
    // Velocity inlet 1 picks the merged face, Pressure 1 another one: Generate gets past it.
    await openBcPanel(page, inlet);
    await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 10@Body1'));
    await expect.poll(async () => (await bcOnDisk(request, host, scope.pid, sim, inlet)).faces, { timeout: 15_000 }).toEqual(['face 10@Body1']);
    await openBcPanel(page, outlet);
    await page.evaluate(() => window.__CFD_ASSIGN_FACE__('face 1@Body1'));
    await expect.poll(async () => (await bcOnDisk(request, host, scope.pid, sim, outlet)).faces, { timeout: 15_000 }).toEqual(['face 1@Body1']);
    const past = await request.post(`${host.base}/api/mesh/generate`, { data: { project_id: scope.pid, simulation_id: sim, mesh_id: meshId, settings: { mesh_backend: 'no-such-mesher' } } });
    expect((await past.json()).error).toMatch(/not installed or is turned off/);

    // Start on the out-of-date mesh: the run panel says why before any click and Start is
    // off; the server's Start refuses with the same words.
    const outOfDate = 'Generate Mesh 1 again first. It was made from an older version of Demo 1.';
    await page.locator(`#left-tree [data-w27-run="${run1}"] > .tree-row .tl`).first().click();
    await expect(runPanel).toHaveAttribute('data-run-id', run1, { timeout: 15_000 });
    await expect(runPanel).toContainText(outOfDate, { timeout: 30_000 });
    await expect(runPanel.locator('[data-run-start]')).toBeDisabled();
    const refused = await request.post(`${host.base}/api/run/start`, { data: { project_id: scope.pid, simulation_id: sim, run_id: run1 } });
    const refusedBody = await refused.json();
    expect([refused.ok(), refusedBody.code, refusedBody.error], JSON.stringify(refusedBody)).toEqual([false, 'mesh_out_of_date', outOfDate]);
    await page.screenshot({ path: testInfo.outputPath('start-refused.png') }).catch(() => {});

    // A first link into a project that already shows a geometry: Back shows the new one.
    const s2 = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: scope.pid, plugin: 'link-demo', kind: 'demo', title: 'Demo 2' } });
    const scope2 = { pid: scope.pid, sid: (await s2.json()).study.id };
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${scope.pid}/ws/link-demo/demo/${scope2.sid}`);
    frame = page.frameLocator('#workspace-frame');
    await expect(frame.locator('#link-title')).toHaveText('Demo 2', { timeout: 30_000 });
    await linkFromPage(frame, 'v1', 'shape rev 1');
    await back(page, scope.pid);
    const gid2 = (await linkedOf(request, host, scope2)).geometryId;
    expect(gid2).not.toBe(gid);
    expect(await shownPart(page, host, scope.pid, gid2)).toEqual({ status: 200, zmax: 35, faces: 21 });
    await expect(page.locator(`#left-tree [data-w16-geom="${gid2}"] > .tree-row [data-geom-from]`)).toHaveText('from Demo 2', { timeout: 30_000 });
    stage(t1, 'done');
  });
});

// ---- L2 step 4, the question and "Save as new" ------------------------------------------------

/** The host's question over the workspace: its words and its copy boxes ([label, checked, disabled]). */
async function readQuestion(page) {
  const modal = page.locator('#modal-link-choice');
  await expect(modal).toBeVisible({ timeout: 120_000 });
  return {
    title: await page.locator('#lc-heading').textContent(),
    copy: await page.locator('#lc-copy').textContent(),
    newLabel: await page.locator('#lc-new').textContent(),
    newLine: await page.locator('#lc-new-line').textContent(),
    overwrite: await page.locator('#lc-overwrite').textContent(),
    overwriteDisabled: await page.locator('#lc-overwrite').isDisabled(),
    overwriteLine: await page.locator('#lc-overwrite-line').textContent(),
    cancel: await page.locator('#lc-cancel').textContent(),
    boxes: await page.locator('#lc-copies label').evaluateAll((labels) =>
      labels.map((l) => {
        const box = l.querySelector('input');
        return [l.textContent, !!(box && box.checked), !!(box && box.disabled)];
      }),
    ),
  };
}

/** Answer the host's question: 'new', 'overwrite' or 'cancel' (Keep editing). */
async function answerQuestion(page, choice) {
  await expect(page.locator('#modal-link-choice')).toBeVisible({ timeout: 120_000 });
  await page.locator({ new: '#lc-new', overwrite: '#lc-overwrite', cancel: '#lc-cancel' }[choice]).click();
  await expect(page.locator('#modal-link-choice')).toBeHidden();
}

/** A simulation study on a geometry, made through the route; {id, name}. */
async function apiStudy(request, host, pid, gid) {
  const r = await request.post(`${host.base}/api/simulation`, { data: { project_id: pid, geometry_id: gid } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return { id: j.simulation.id, name: j.simulation.name };
}

async function apiBc(request, host, pid, sim, name, faces, rev) {
  const r = await request.post(`${host.base}/api/bcs`, { data: { project_id: pid, simulation_id: sim, name, bc_type: 'Wall', faces, geometry_rev: rev } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.bc.id;
}

/** link-demo-2's workspace (no exit hook): its page's frame. */
async function openWorkspace2(page, { pid, sid }, title) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `#/p/${pid}/ws/link-demo-2/demo2/${sid}`);
  const frame = page.frameLocator('#workspace-frame');
  await expect(frame.locator('#link2-title')).toHaveText(title, { timeout: 30_000 });
  return frame;
}

test.describe("linked geometries: the host's question and Save as new (L2 step 4)", () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('link-choice');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({ name: 'link-choice', tmp, projects, bundledDir: bundledIfOnly(tmp), pluginsFrom: 'python/tests/fixtures/link-plugins' });
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-e2e the question: Save as new with the copy keeps "Demo 1" as it was and adds "Demo 1 v2" with the copied setup; Keep editing changes nothing and asks again @plugins', async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const t1 = Date.now();
    const scope = await demoProject(request, host, 'Link save as new');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const gid = first.geometry_id;
    // A study on it: a BC on Body 2's +x side (v1 face 17, v2 face 12) and a mesh generated at rev 1.
    const sim = await apiStudy(request, host, scope.pid, gid);
    const bc = await apiBc(request, host, scope.pid, sim.id, 'Side wall', ['face 17@Body2'], 1);
    const mesh = await request.post(`${host.base}/api/mesh`, { data: { project_id: scope.pid, simulation_id: sim.id, name: 'Mesh 1' } });
    const meshId = (await mesh.json()).mesh.id;
    const meshFile = join(recordDir(host.projects, scope.pid, 'mesh', meshId), 'mesh.json');
    writeFileSync(meshFile, JSON.stringify({ ...JSON.parse(readFileSync(meshFile, 'utf8')), generated: true, live_mesh_result: { status: 'done', generate_id: 'g-e2e', built_from_rev: 1, n_cells: 8 } }));
    await openProject(page, host, scope.pid);
    stage(t1, `Demo 1 in use (${gid})`);

    // v2 from the page: the host asks, over the workspace.
    let frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    const q = await readQuestion(page);
    await page.screenshot({ path: testInfo.outputPath('question.png') }).catch(() => {});
    expect(q).toEqual({
      title: 'Demo 1 has a new shape',
      copy: `Demo 1 is used by ${sim.name}. How should the simulation get the new shape?`,
      newLabel: 'Save as new geometry',
      newLine: 'Adds Demo 1 v2. Demo 1 and its studies, meshes and results stay as they are.',
      overwrite: 'Overwrite Demo 1',
      overwriteDisabled: false,
      overwriteLine: 'Updates Demo 1 in place. Faces are matched by name; its meshes must be generated again before a run.',
      cancel: 'Keep editing',
      boxes: [[`Copy the setup of ${sim.name} onto it`, true, false]],
    });
    await answerQuestion(page, 'new');
    const report = await readReport(page, testInfo.outputPath('saved-as-new.png'));
    expect(report.title).toBe('Demo 1 v2 added');
    expect(report.copy).toContain('Demo 1 v2 added. Demo 1 and its studies are kept as they were.');
    expect(report.copy).toContain(`Copied the setup of ${sim.name} onto it`);
    await expect(frame.locator('#link-status')).toHaveText('shape rev 1', { timeout: 60_000 });
    await back(page, scope.pid);
    const linked = await linkedOf(request, host, scope);
    expect([linked.name, linked.rev]).toEqual(['Demo 1 v2', 1]);
    const newId = linked.geometryId;
    expect(newId).not.toBe(gid);
    // The landing shows the new geometry (v2's box).
    await expect.poll(async () => (await shownPart(page, host, scope.pid, newId)).zmax, { timeout: 60_000 }).toBe(30);
    stage(t1, `saved as new (${newId})`);

    const tree = async () => (await getJson(request, `${host.base}/api/project/tree?project_id=${scope.pid}`)).geometries;
    const copyId = (await tree()).find((g) => g.id === newId).studies[0].id;
    // The landing opens the copied study's setup.
    await expect.poll(() => page.evaluate(() => window.__CFD_W17__ && window.__CFD_W17__.activeId), { timeout: 60_000 }).toBe(copyId);
    // (Before any reload: this tab's streams were opened for "Demo 1".)
    // A question left open about "Demo 1 v2" (its page goes before an answer) waits on its
    // own row: the study's link stream follows the geometry it links now.
    const frame2 = await openWorkspace(page, host, scope);
    await frame2.locator('#link-v3').click();
    await readQuestion(page);
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${scope.pid}`);
    await expect(page.locator('#modal-link-choice')).toBeHidden({ timeout: 30_000 });
    const waiting = page.locator(`#left-tree [data-w16-geom="${newId}"] > .tree-row [data-geom-link-status]`);
    await expect(waiting).toHaveText('Waiting for your choice: Demo 1 changed', { timeout: 60_000 });
    await page.locator(`#left-tree [data-w16-geom="${newId}"] > .tree-row [data-geom-choose]`).click();
    await answerQuestion(page, 'cancel');
    // Kept editing: the page saved a newer design that did not land.
    await expect(waiting).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
    await expect(page.locator(`#left-tree [data-w16-geom="${newId}"] > .tree-row [data-geom-choose]`)).toHaveCount(0);
    for (let pass = 0; pass < 2; pass += 1) {
      // "Demo 1" is a plain row now: no "from", no Edit; its study, BC and mesh as they were.
      const oldRow = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
      await expect(oldRow.locator('.tl').first()).toHaveText('Demo 1', { timeout: 30_000 });
      await expect(oldRow.locator('[data-geom-from]')).toHaveCount(0);
      await expect(oldRow.locator('[data-geom-edit]')).toHaveCount(0);
      const oldBc = await bcOnDisk(request, host, scope.pid, sim.id, bc);
      expect([oldBc.faces, oldBc.geometry_rev]).toEqual([['face 17@Body2'], 1]);
      // (In the tree, under the old study, which the landing left folded.)
      await expect(page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row`)).toHaveCount(1);
      await expect(page.locator(`#left-tree [data-w20-mesh-item="${meshId}"] > .tree-row [data-mesh-out-of-date]`)).toHaveCount(0);
      // "Demo 1 v2" is the linked one, with the copied study whose BC holds the v2 face.
      const newRow = page.locator(`#left-tree [data-w16-geom="${newId}"] > .tree-row`);
      await expect(newRow.locator('.tl').first()).toHaveText('Demo 1 v2');
      await expect(newRow.locator('[data-geom-from]')).toHaveText('from Demo 1');
      await expect(newRow.locator('[data-geom-edit]')).toBeVisible();
      const copied = ((await getJson(request, `${host.base}/api/bcs?project_id=${scope.pid}&simulation_id=${copyId}`)).boundary_conditions || []).find((b) => b.name === 'Side wall');
      expect([copied.faces, copied.geometry_rev]).toEqual([['face 12@Body2'], 1]);
      // Opened once the copied study's BCs have loaded (the landing may still be loading them).
      const editor = page.locator('#panel-bc-editor .cfd-island [data-bc-editor="1"]');
      await expect
        .poll(
          async () => {
            await page.evaluate((x) => window.__CFD_OPEN_BC__(x), copied.id);
            return editor.getAttribute('data-bc-id', { timeout: 2000 }).catch(() => null);
          },
          { timeout: 60_000 },
        )
        .toBe(copied.id);
      await expect(editor.locator('[data-face-picker="1"] [data-face-id] .bc-assign-pick')).toHaveText(['Side box +x (face 12)']);
      // The plugin study's row names the geometry it links now.
      await expect(page.locator(`[data-plugin-study="${scope.sid}"] [data-plugin-study-geometry]`)).toHaveText('→ Demo 1 v2');
      if (pass === 0) await reloadProject(page, scope.pid);
    }
    stage(t1, 'both geometries checked, also after a reload');

    // Keep editing: nothing changes, and the next link asks again.
    frame = await openWorkspace(page, host, scope);
    for (let i = 0; i < 2; i += 1) {
      await frame.locator('#link-v3').click();
      const again = await readQuestion(page);
      expect(again.title).toBe('Demo 1 has a new shape');
      expect(again.copy).toBe('Demo 1 v2 is used by ' + (await tree()).find((g) => g.id === newId).studies[0].name + '. How should the simulation get the new shape?');
      await answerQuestion(page, 'cancel');
      await expect(frame.locator('#link-status')).toHaveText('Refused: cancelled You kept editing. Nothing changed.', { timeout: 30_000 });
      const still = await linkedOf(request, host, scope);
      expect([still.geometryId, still.rev]).toEqual([newId, 1]);
    }
    expect((await tree()).map((g) => g.id).sort()).toEqual([gid, newId].sort());
    stage(t1, 'done');
  });

  test('gate:l2-e2e an unused geometry gets no question: v2 overwrites it @plugins', async ({ page, request }) => {
    test.setTimeout(300_000);
    const scope = await demoProject(request, host, 'Link unused');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    await apiStudy(request, host, scope.pid, first.geometry_id); // its defaults only
    await openProject(page, host, scope.pid);
    let asked = false;
    await page.exposeFunction('__e2eAsked', () => {
      asked = true;
    });
    await page.evaluate(() => {
      const modal = document.getElementById('modal-link-choice');
      new MutationObserver(() => {
        if (modal && !modal.hidden) window.__e2eAsked();
      }).observe(modal, { attributes: true });
    });
    const frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 180_000 });
    expect(asked, 'no question').toBe(false);
    expect((await linkedOf(request, host, scope)).geometryId).toBe(first.geometry_id);
  });

  test("gate:l2-e2e link-demo-2's own button meets the same question; with its page gone the row says \"Waiting for your choice\" and Choose… answers it @plugins", async ({ page, request }, testInfo) => {
    test.setTimeout(600_000);
    const t1 = Date.now();
    const p = await request.post(`${host.base}/api/project`, { data: { title: 'Link own button', folder: 'My Projects', units: 'Metric', category: 'Other' } });
    const pid = (await p.json()).id;
    const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin: 'link-demo-2', kind: 'demo', title: 'Demo 3' } });
    const scope = { pid, sid: (await s.json()).study.id };
    await openProject(page, host, pid);
    // Its backend writes a text BREP; its page links it by etag.
    let frame = await openWorkspace2(page, scope, 'Demo 3');
    await frame.locator('#link2-send').click();
    await expect(frame.locator('#link2-status')).toHaveText('shape rev 1 created', { timeout: 180_000 });
    const exported = join(host.projects, pid, 'plugins', 'link-demo-2', 'studies', scope.sid, 'export', 'shape.brep');
    expect(readFileSync(exported, 'utf8').startsWith('DBRep_DrawableShape'), 'a text BREP').toBe(true);
    await back(page, pid);
    const linked = (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo-2&study_id=${scope.sid}`)).linked;
    expect(linked.shapeSha256).toBe(sha256(readFileSync(exported)));
    const gid = linked.geometryId;
    const sim = await apiStudy(request, host, pid, gid);
    await apiBc(request, host, pid, sim.id, 'Top wall', ['face 12@Body1'], 1);
    stage(t1, `Demo 3 linked and in use (${gid})`);

    // v2 from its button: the question shows in the workspace; the page goes before an answer.
    frame = await openWorkspace2(page, scope, 'Demo 3');
    await frame.locator('#link2-version').selectOption('v2');
    await frame.locator('#link2-send').click();
    expect((await readQuestion(page)).title).toBe('Demo 3 has a new shape');
    await page.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${pid}`);
    await expect(page.locator('#modal-link-choice')).toBeHidden({ timeout: 30_000 });
    const row = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(row.locator('[data-geom-link-status]')).toHaveText('Waiting for your choice: Demo 3 changed', { timeout: 60_000 });
      await expect(row.locator('[data-geom-choose]')).toHaveText('Choose…');
      if (pass === 0) await reloadProject(page, pid);
    }
    await page.screenshot({ path: testInfo.outputPath('waiting.png') }).catch(() => {});
    // Choose… opens the same question; Overwrite lands the part.
    await row.locator('[data-geom-choose]').click();
    const q = await readQuestion(page);
    expect([q.title, q.overwrite]).toEqual(['Demo 3 has a new shape', 'Overwrite Demo 3']);
    await answerQuestion(page, 'overwrite');
    await expect.poll(async () => (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo-2&study_id=${scope.sid}`)).linked.rev, { timeout: 180_000 }).toBe(2);
    await expect.poll(async () => (await shownPart(page, host, pid, gid)).zmax, { timeout: 60_000 }).toBe(30);
    await expect(row.locator('[data-geom-choose]')).toHaveCount(0);
    stage(t1, 'done');
  });

  test('gate:l2-e2e plugin_needed: with bc-demo off Overwrite is disabled with the record named, the copy of that study too; Keep editing leaves "Not up to date"; with it on, Overwrite commits @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const scope = await demoProject(request, host, 'Link plugin needed');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const gid = first.geometry_id;
    const sim = await apiStudy(request, host, scope.pid, gid);
    await apiBc(request, host, scope.pid, sim.id, 'Wall 1', ['face 12@Body1'], 1);
    // A BC of bc-demo's family, made as the BC panel makes it: its face field (extra_faces)
    // is a field only bc-demo's family names.
    const made = await request.post(`${host.base}/api/bcs`, {
      data: { project_id: scope.pid, simulation_id: sim.id, name: 'Porous', bc_type: 'Demo porous', faces: [], extra_faces: ['face 12@Body1'], geometry_rev: 1 },
    });
    const porous = (await made.json()).bc;
    expect([made.ok(), porous.bc_type, porous.registry_key]).toEqual([true, 'Demo porous', undefined]);
    const off = await request.post(`${host.base}/api/plugins/bc-demo/disable`, { data: {} });
    expect(off.ok(), await off.text()).toBe(true);
    try {
      await openProject(page, host, scope.pid);
      let frame = await openWorkspace(page, host, scope);
      await frame.locator('#link-v2').click();
      const q = await readQuestion(page);
      const text = `Records of Demo porous come from a plugin that is off or not installed: ${sim.name} › Porous. Turn it on or install it, or delete those records, to update Demo 1.`;
      expect([q.overwriteDisabled, q.overwriteLine]).toEqual([true, text]);
      expect(q.boxes).toEqual([[`Copy the setup of ${sim.name} onto it${text}`, false, true]]);
      await answerQuestion(page, 'cancel');
      await expect(frame.locator('#link-status')).toHaveText('Refused: cancelled You kept editing. Nothing changed.', { timeout: 30_000 });
      await back(page, scope.pid);
      const row = page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);
      await expect(row.locator('[data-geom-link-status]')).toHaveText('Not up to date with Demo 1.', { timeout: 60_000 });
      // bc-demo on again: Overwrite commits.
      const on = await request.post(`${host.base}/api/plugins/bc-demo/enable`, { data: {} });
      expect(on.ok(), await on.text()).toBe(true);
      frame = await openWorkspace(page, host, scope);
      await frame.locator('#link-v2').click();
      expect((await readQuestion(page)).overwriteDisabled).toBe(false);
      await answerQuestion(page, 'overwrite');
      // The update split and merged faces: the host's report, then OK.
      await readReport(page);
      await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 180_000 });
      const bcs = (await getJson(request, `${host.base}/api/bcs?project_id=${scope.pid}&simulation_id=${sim.id}`)).boundary_conditions || [];
      const after = bcs.find((b) => b.name === 'Porous') || {};
      // The family's own face field followed v1's +y face onto v2's two halves.
      expect([after.geometry_rev, (after.extra_faces || []).slice().sort()]).toEqual([2, ['face 4@Body1', 'face 8@Body1']]);
    } finally {
      await request.post(`${host.base}/api/plugins/bc-demo/enable`, { data: {} });
    }
  });
});

// ---- rows and plugins: what each state of a link looks like in the tree ------------------------

/** A record's folder in a study (boundary_conditions, materials, ...), by its id. */
function recordDirOf(projects, pid, simId, sub, id) {
  const dir = join(studyFolder(projects, pid, simId), sub);
  for (const f of readdirSync(dir)) {
    for (const name of ['bc.json', 'material.json', 'result_control.json']) {
      try {
        if (JSON.parse(readFileSync(join(dir, f, name), 'utf8')).id === id) return join(dir, f);
      } catch {
        /* not this one */
      }
    }
  }
  throw new Error(`no ${sub} record ${id}`);
}

/** A plugin study of a project: {pid, sid, plugin}. */
async function pluginStudy(request, host, pid, plugin, kind, title) {
  const s = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: pid, plugin, kind, title } });
  const sj = await s.json();
  expect(s.ok(), JSON.stringify(sj)).toBe(true);
  return { pid, sid: sj.study.id, plugin };
}

async function linkedBy(request, host, { pid, sid, plugin = 'link-demo' }) {
  return (await getJson(request, `${host.base}/api/plugin-geometry/linked?project_id=${pid}&plugin=${plugin}&study_id=${sid}`)).linked;
}

const geomRowOf = (page, gid) => page.locator(`#left-tree [data-w16-geom="${gid}"] > .tree-row`);

test.describe('linked geometries: rows and plugins (gate:l2-e2e)', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const tmp = e2eTemp('link-rows');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'link-rows',
      tmp,
      projects,
      bundledDir: bundledIfOnly(tmp),
      pluginsFrom: 'python/tests/fixtures/link-plugins',
      env: { MAGNUSIM_TEST_SLOT_HOLD: '1' },
    });
  });
  test.afterEach(async ({}, testInfo) => {
    if (host && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('host.log', { body: host.log(), contentType: 'text/plain' });
    }
  });
  test.afterAll(() => host?.stop());

  test('gate:l2-e2e two plugins in one project: each row\'s Edit opens its own workspace; both plugins\' overwrites wait as "Queued" and run one at a time @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const t1 = Date.now();
    const a = await demoProject(request, host, 'Link two plugins');
    const b = await pluginStudy(request, host, a.pid, 'link-demo', 'demo', 'Demo 2');
    const c = await pluginStudy(request, host, a.pid, 'link-demo-2', 'demo', 'Demo 3');
    const scopes = [{ ...a, plugin: 'link-demo' }, b, c];
    const gids = [];
    for (const s of scopes) {
      const r = await link(request, host, s, 'v1', 1, null);
      expect((await until(request, host, s, r.job_id)).status).toBe('done');
      gids.push(r.geometry_id);
    }
    expect(new Set(gids).size).toBe(3);
    await openProject(page, host, a.pid);
    for (const [i, title] of ['Demo 1', 'Demo 2', 'Demo 3'].entries()) {
      await expect(geomRowOf(page, gids[i]).locator('[data-geom-from]')).toHaveText(`from ${title}`, { timeout: 30_000 });
    }
    // Edit opens each study in its own plugin's workspace.
    await geomRowOf(page, gids[1]).locator('[data-geom-edit]').click();
    await expect(page.frameLocator('#workspace-frame').locator('#link-title')).toHaveText('Demo 2', { timeout: 30_000 });
    await back(page, a.pid);
    await geomRowOf(page, gids[2]).locator('[data-geom-edit]').click();
    await expect(page.frameLocator('#workspace-frame').locator('#link2-title')).toHaveText('Demo 3', { timeout: 30_000 });
    await back(page, a.pid);
    stage(t1, 'three rows, two plugins');

    // Both plugins' updates, with the compute slot held: each row says "Queued".
    const hold = await request.post(`${host.base}/api/test/slot-hold`);
    expect(hold.ok(), await hold.text()).toBe(true);
    let released = false;
    try {
      const u1 = await link(request, host, scopes[0], 'v2', 2, 1);
      const u3 = await link(request, host, scopes[2], 'v2', 2, 1);
      expect([u1.queued, u3.queued]).toEqual([true, true]);
      for (const i of [0, 2]) await expect(geomRowOf(page, gids[i]).locator('[data-geom-link-status]')).toHaveText('Queued', { timeout: 30_000 });
      await expect(geomRowOf(page, gids[1]).locator('[data-geom-link-status]')).toHaveCount(0);
      // Also on a page opened while they wait.
      await reloadProject(page, a.pid);
      for (const i of [0, 2]) await expect(geomRowOf(page, gids[i]).locator('[data-geom-link-status]')).toHaveText('Queued', { timeout: 30_000 });
      await page.locator('#btn-queue').click();
      await expect(page.locator('#job-queue-list li')).toHaveText([/Update Demo 1 from Demo 1/, /Update Demo 3 from Demo 3/]);
      await page.keyboard.press('Escape');
      // Released: one at a time, never both running.
      const seen = [];
      const watch = setInterval(() => {
        void Promise.all([jobStatus(request, host, scopes[0], u1.job_id), jobStatus(request, host, scopes[2], u3.job_id)])
          .then(([j1, j3]) => seen.push(`${j1 && j1.status}/${j3 && j3.status}`))
          .catch(() => {});
      }, 100);
      try {
        expect((await request.post(`${host.base}/api/test/slot-release`)).ok()).toBe(true);
        released = true;
        await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: a.pid } });
        expect((await until(request, host, scopes[0], u1.job_id)).status).toBe('done');
        expect((await until(request, host, scopes[2], u3.job_id)).status).toBe('done');
      } finally {
        clearInterval(watch);
      }
      expect(seen.filter((x) => x === 'running/running'), seen.join(' ')).toEqual([]);
    } finally {
      if (!released) await request.post(`${host.base}/api/test/slot-release`);
    }
    for (const i of [0, 2]) await expect(geomRowOf(page, gids[i]).locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 60_000 });
    expect([(await linkedBy(request, host, scopes[0])).rev, (await linkedBy(request, host, b)).rev, (await linkedBy(request, host, c)).rev]).toEqual([2, 1, 2]);
    stage(t1, 'done');
  });

  test('gate:l2-e2e "Not up to date": a newer saved design marks the row; a link with no change clears it @plugins', async ({ page, request }) => {
    test.setTimeout(300_000);
    const scope = await demoProject(request, host, 'Link not up to date');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const gid = first.geometry_id;
    // The plugin saved a newer design (its study's source_version) and has not linked it.
    const got = (await getJson(request, `${host.base}/api/plugin-studies/get?project_id=${scope.pid}&plugin=link-demo&study_id=${scope.sid}`)).study;
    const up = await request.post(`${host.base}/api/plugin-studies/update`, { data: { project_id: scope.pid, plugin: 'link-demo', study_id: scope.sid, rev: got.rev, patch: { source_version: 2 } } });
    expect(up.ok(), await up.text()).toBe(true);
    await openProject(page, host, scope.pid);
    const status = geomRowOf(page, gid).locator('[data-geom-link-status]');
    await expect(status).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
    await reloadProject(page, scope.pid);
    await expect(status).toHaveText('Not up to date with Demo 1.', { timeout: 30_000 });
    // The page links its design: the same bytes, nothing changes, and the row is up to date.
    const frame = await openWorkspace(page, host, scope);
    await linkFromPage(frame, 'v1', 'none rev 1');
    await back(page, scope.pid);
    await expect(status).toHaveCount(0, { timeout: 30_000 });
    await reloadProject(page, scope.pid);
    await expect(geomRowOf(page, gid).locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
    await expect(status).toHaveCount(0);
  });

  test('gate:l2-e2e the linking plugin off: Edit greyed with the reason and "Open Settings → Plugins", which turns it on; uninstalled: "from Demo 3 (plugin not installed)" with no Edit @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const a = await demoProject(request, host, 'Link plugin off');
    const c = await pluginStudy(request, host, a.pid, 'link-demo-2', 'demo', 'Demo 3');
    const r1 = await link(request, host, a, 'v1', 1, null);
    const r3 = await link(request, host, c, 'v1', 1, null);
    expect((await until(request, host, a, r1.job_id)).status).toBe('done');
    expect((await until(request, host, c, r3.job_id)).status).toBe('done');
    const row1 = geomRowOf(page, r1.geometry_id);
    const off = await request.post(`${host.base}/api/plugins/link-demo/disable`, { data: {} });
    expect(off.ok(), await off.text()).toBe(true);
    try {
      await openProject(page, host, a.pid);
      for (let pass = 0; pass < 2; pass += 1) {
        await expect(row1.locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
        await expect(row1.locator('[data-geom-edit]')).toBeDisabled();
        await expect(row1.locator('[data-geom-edit]')).toHaveAttribute('title', 'Link demo is off');
        await expect(row1.locator('[data-geom-link-reason]')).toHaveText('Link demo is off. Open Settings → Plugins');
        if (pass === 0) await reloadProject(page, a.pid);
      }
      // The geometry itself works: its part is shown.
      await expect.poll(async () => (await page.evaluate(() => window.__CFD_W16__?.fingerprint?.nCells || 0)), { timeout: 60_000 }).toBeGreaterThan(0);
      // Its link opens Settings → Plugins, where the user turns it on; Edit works again.
      await row1.locator('[data-geom-link-settings]').click();
      const wizard = page.locator('#setup-wizard');
      await expect(wizard).toBeVisible();
      const prow = wizard.locator('[data-plugin-key="link-demo"]');
      await expect(prow).toHaveAttribute('data-plugin-status', 'disabled');
      await prow.locator('[data-plugin-toggle="link-demo"]').click();
      await expect(prow).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
      // Plugins is the last step: Finish closes Settings.
      await expect(page.locator('#wiz-next')).toHaveText('Finish');
      await page.locator('#wiz-next').click();
      await expect(wizard).toBeHidden({ timeout: 15_000 });
      await reloadProject(page, a.pid);
      await expect(row1.locator('[data-geom-edit]')).toBeEnabled({ timeout: 30_000 });
      await expect(row1.locator('[data-geom-link-reason]')).toHaveCount(0);
    } finally {
      await request.post(`${host.base}/api/plugins/link-demo/enable`, { data: {} });
    }
    // link-demo-2 uninstalled: "(plugin not installed)", no Edit and no Settings link.
    const folder = join(host.pluginsDir, 'link-demo-2');
    const kept = join(host.tmp, 'link-demo-2-kept');
    cpSync(folder, kept, { recursive: true });
    rmSync(folder, { recursive: true, force: true });
    try {
      await request.post(`${host.base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
      await reloadProject(page, a.pid);
      const row3 = geomRowOf(page, r3.geometry_id);
      await expect(row3.locator('[data-geom-from]')).toHaveText('from Demo 3 (plugin not installed)', { timeout: 30_000 });
      await expect(row3.locator('[data-geom-edit]')).toHaveCount(0);
      await expect(row3.locator('[data-geom-link-reason]')).toHaveCount(0);
    } finally {
      cpSync(kept, folder, { recursive: true });
      await request.post(`${host.base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
    }
  });

  test('gate:l2-e2e remove the geometry, then link: a new geometry; delete the study: a plain geometry, also after a reload @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const scope = await demoProject(request, host, 'Link remove and delete');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const removed = await request.post(`${host.base}/api/geometry/remove`, { data: { project_id: scope.pid, geometry_id: first.geometry_id } });
    expect(removed.ok(), await removed.text()).toBe(true);
    await openProject(page, host, scope.pid);
    // The next link from the page asks first (API 1.7: never a silent create); "Add as new
    // geometry" creates a new geometry.
    const frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    const q = await readQuestion(page);
    expect([q.title, q.copy, q.newLabel, q.overwrite, q.cancel]).toEqual(['Demo 1 was removed from the project', 'Add Demo 1 as a new geometry?', 'Add as new geometry', 'Not now', 'Keep editing']);
    await answerQuestion(page, 'new');
    await expect(frame.locator('#link-status')).toHaveText('shape rev 1', { timeout: 180_000 });
    await back(page, scope.pid);
    const linked = await linkedOf(request, host, scope);
    expect(linked.geometryId).not.toBe(first.geometry_id);
    const gid = linked.geometryId;
    const row = geomRowOf(page, gid);
    await expect(row.locator('[data-geom-from]')).toHaveText('from Demo 1', { timeout: 30_000 });
    await expect(page.locator(`#left-tree [data-w16-geom="${first.geometry_id}"]`)).toHaveCount(0);
    // A study on it (so the plain geometry keeps something of its own).
    const sim = await apiStudy(request, host, scope.pid, gid);
    await apiBc(request, host, scope.pid, sim.id, 'Wall 1', ['face 4@Body1'], 1);
    await reloadProject(page, scope.pid);
    // Delete the plugin study from its row: the geometry stays, as a plain one.
    const studyRow = page.locator(`[data-plugin-study="${scope.sid}"] > .tree-row`);
    await studyRow.locator('[data-plugin-study-act="delete"]').click();
    await expect(page.locator('#modal-confirm')).toBeVisible();
    await page.locator('#cf-confirm').click();
    await expect(page.locator(`[data-plugin-study="${scope.sid}"]`)).toHaveCount(0, { timeout: 30_000 });
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(row.locator('.tl').first()).toHaveText('Demo 1', { timeout: 30_000 });
      await expect(row.locator('[data-geom-from]')).toHaveCount(0);
      await expect(row.locator('[data-geom-edit]')).toHaveCount(0);
      await expect(row.locator('[data-geom-link-status]')).toHaveCount(0);
      await expect(row.locator('[data-geom-link-reason]')).toHaveCount(0);
      const bcs = (await getJson(request, `${host.base}/api/bcs?project_id=${scope.pid}&simulation_id=${sim.id}`)).boundary_conditions || [];
      expect(bcs.map((b) => [b.name, b.faces])).toEqual([['Wall 1', ['face 4@Body1']]]);
      if (pass === 0) await reloadProject(page, scope.pid);
    }
    // The geometry panel names no source either.
    await row.locator('.tl').first().click();
    await expect(page.locator('#panel-geometry .cfd-island [data-geometry-source]')).toHaveCount(0);
  });

  test('gate:l2-e2e "Adding Demo 1 v2…" while Save as new runs; a stopped run\'s monitor follows the update (it can start again) @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const scope = await demoProject(request, host, 'Link rows adding');
    const first = await link(request, host, scope, 'v1', 1, null);
    expect((await until(request, host, scope, first.job_id)).status).toBe('done');
    const gid = first.geometry_id;
    const sim = await apiStudy(request, host, scope.pid, gid);
    await apiBc(request, host, scope.pid, sim.id, 'Wall 1', ['face 12@Body1'], 1);
    // A run with an area average on v1's +x half (face 6), stopped after it started.
    const made = await request.post(`${host.base}/api/run/create`, { data: { project_id: scope.pid, simulation_id: sim.id, name: 'Run 1' } });
    const runId = (await made.json()).run.id;
    const rc = { id: 'rc-e2e', name: 'Area average 1', kind: 'Area average', faces: ['face 6@Body1'] };
    const set = await request.post(`${host.base}/api/run/update`, { data: { project_id: scope.pid, simulation_id: sim.id, run_id: runId, result_controls: [rc], geometry_rev: 1 } });
    expect(set.ok(), await set.text()).toBe(true);
    const runFile = join(recordDir(host.projects, scope.pid, 'run', runId), 'run.json');
    writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, 'utf8')), status: 'stopped', built_from: { geometry_rev: 1 } }));
    await openProject(page, host, scope.pid);
    const monitorFace = page.locator(`#left-tree [data-w27-aa-run="${runId}"][data-w27-aa-face]`);
    await expect(monitorFace).toHaveAttribute('data-w27-aa-face', 'face 6@Body1', { timeout: 30_000 });

    // Overwrite from the page: the stopped run's monitor is on v2's +x face (10), which its
    // next Start writes into its case; v2's face 6 is another face (Box -y).
    const frame = await openWorkspace(page, host, scope);
    await frame.locator('#link-v2').click();
    await answerQuestion(page, 'overwrite');
    await readReport(page);
    await expect(frame.locator('#link-status')).toHaveText('shape rev 2', { timeout: 180_000 });
    await back(page, scope.pid);
    await expect(monitorFace).toHaveAttribute('data-w27-aa-face', 'face 10@Body1', { timeout: 30_000 });
    await reloadProject(page, scope.pid);
    await expect(monitorFace).toHaveAttribute('data-w27-aa-face', 'face 10@Body1', { timeout: 30_000 });

    // Save as new from the row's Choose…: the row says "Adding Demo 1 v2…" while it is made.
    const asked = await link(request, host, scope, 'v3', 3, 2);
    expect(asked.choosing, JSON.stringify(asked)).toBeTruthy();
    const row = geomRowOf(page, gid);
    await expect(row.locator('[data-geom-link-status]')).toHaveText('Waiting for your choice: Demo 1 changed', { timeout: 60_000 });
    await page.evaluate((id) => {
      const seen = [];
      window.__e2eRowTexts = seen;
      const root = document.querySelector('#left-tree');
      const take = () => {
        const el = root && root.querySelector(`[data-w16-geom="${id}"] > .tree-row [data-geom-link-status]`);
        const t = el ? el.textContent : '';
        if (t && seen[seen.length - 1] !== t) seen.push(t);
      };
      new MutationObserver(take).observe(root, { subtree: true, childList: true, characterData: true });
      take();
    }, gid);
    await row.locator('[data-geom-choose]').click();
    await answerQuestion(page, 'new');
    await expect.poll(async () => (await linkedOf(request, host, scope)).name, { timeout: 180_000 }).toBe('Demo 1 v2');
    const texts = await page.evaluate(() => window.__e2eRowTexts);
    expect(texts, texts.join(' | ')).toContain('Adding Demo 1 v2…');
    await expect(row.locator('[data-geom-link-status]')).toHaveCount(0, { timeout: 30_000 });
  });
});
