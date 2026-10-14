import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedElbowProject } from './prepare-projects.js';
import { mockJobChannel } from './support/event-hub-mock.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { serverAnswersIn, stager, watchRequests } from './support/link-streams.js';

// A part's preview being made holds no connection of the browser's. The app server speaks
// plain HTTP/1.1, where the browser opens at most 6 connections to it for all of its tabs
// together. A plain STEP part whose preview is not made yet (cad_faces.vtp, cad_edges.vtp,
// cad_preview.json) is made when a tab shows it, and the tab's four requests for it (its
// faces, its edges and its face table twice) each waited for the whole build, up to 3
// minutes. Two tabs on two such projects held 8: a third tab could not even load Home.
// Now the server answers "being prepared" (202, Retry-After) after a quarter of a second,
// the tab asks again, one request at a time, and its viewport says "Preparing <part>…".
// Two projects, so the tabs' requests differ (a second tab asking for the very same URLs
// waits on the browser's cache instead of taking a connection).
// A part whose preview is made loads as before: its face table, faces and edges asked for
// at once, and its face table once. A part being prepared while a mesh runs keeps the mesh's
// chip (its stage and time), and says the part after it. A project left while its part is
// prepared ends that load quietly (its faces and edges asked for meanwhile raise no error).
// MAGNUSIM_TEST_PREVIEW_HOLD holds each preview once made, before it is placed. No WSL.

const HERE = dirname(fileURLToPath(import.meta.url));
const ELBOW = resolve(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step');
const stage = stager('connection-limit-cad');

/** A project with elbow.step, its preview made at the import: {pid, step}. */
async function importedProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  const imported = await request.post(`${host.base}/api/geometry/import`, { data: { project_id: pj.id, step_path: ELBOW, filename: 'elbow.step' } });
  const ij = await imported.json();
  expect(imported.ok(), JSON.stringify(ij)).toBe(true);
  return { pid: pj.id, step: ij.geometry.step_path };
}

/** A project with elbow.step whose preview is gone (its picture is made first): {pid, step}. */
async function plainProject(request, host, title) {
  const p = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const pj = await p.json();
  expect(p.ok(), JSON.stringify(pj)).toBe(true);
  const imported = await request.post(`${host.base}/api/geometry/import`, { data: { project_id: pj.id, step_path: ELBOW, filename: 'elbow.step' } });
  const ij = await imported.json();
  expect(imported.ok(), JSON.stringify(ij)).toBe(true);
  const thumbUrl = `${host.base}/api/geometry/thumb?project_id=${encodeURIComponent(pj.id)}`;
  await expect.poll(async () => (await request.get(thumbUrl)).status(), { timeout: 180_000, intervals: [1_000] }).not.toBe(202);
  const step = ij.geometry.step_path;
  for (const f of ['cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json']) rmSync(join(dirname(step), f), { force: true });
  return { pid: pj.id, step };
}

test.describe('parts whose previews are being made, in two tabs', () => {
  /** @type {any} */
  let host;
  let hold = '';
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    stage.reset();
    const tmp = e2eTemp('connection-limit-cad');
    hold = join(tmp, 'preview-hold');
    host = await startHost({ name: 'connection-limit-cad', tmp, env: { MAGNUSIM_TEST_PREVIEW_HOLD: hold } });
    stage(`server up at ${host.base}`);
  });
  test.afterAll(() => {
    if (hold) rmSync(hold, { force: true });
    host?.stop();
  });

  test('a third tab opens Home and its Edit project is saved and shown; the parts show once made', async ({ page, request }) => {
    test.setTimeout(480_000);
    const one = await plainProject(request, host, 'Preview held one');
    const two = await plainProject(request, host, 'Preview held two');
    stage(`projects ${one.pid} and ${two.pid}, their previews gone`);
    rmSync(`${hold}.log`, { force: true });
    writeFileSync(hold, '');
    const madeCount = () => (existsSync(`${hold}.log`) ? readFileSync(`${hold}.log`, 'utf8') : '').split(/\r?\n/).filter((l) => l.startsWith('made ')).length;
    const context = page.context();
    const seen = watchRequests(context);
    try {
      await page.goto(`${host.base}/#/p/${one.pid}`);
      await expect.poll(madeCount, { timeout: 120_000, message: "tab 1's load makes its part's preview" }).toBeGreaterThanOrEqual(1);
      const tab2 = await context.newPage();
      await tab2.goto(`${host.base}/#/p/${two.pid}`);
      await expect.poll(madeCount, { timeout: 120_000, message: "tab 2's load makes its part's preview" }).toBe(2);
      stage(`both previews are being made; tab 1 waits for ${seen.unanswered(page).length} requests, tab 2 for ${seen.unanswered(tab2).length}`);
      // A third tab: Home loads, and Edit project saves a new title.
      const tab3 = await context.newPage();
      const loaded = await tab3
        .goto(`${host.base}/#/`, { timeout: 30_000 })
        .then(() => '')
        .catch((e) => String(e.message || e).split('\n')[0]);
      if (loaded) {
        stage(
          `Home did not load: ${loaded}; the server answers a request from outside the browser: ${await serverAnswersIn(request, host)}; ` +
            `tab 1's requests with no answer: ${seen.unanswered(page).join(', ') || 'none'}; tab 2's: ${seen.unanswered(tab2).join(', ') || 'none'}`,
        );
      }
      expect(loaded, 'a third tab loads Home within 30 s').toBe('');
      const card = tab3.locator(`.home-card[data-project-id="${one.pid}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.click();
      await tab3.locator('#home-edit-project').click();
      await expect(tab3.locator('#np-heading')).toHaveText(/Edit project/);
      await tab3.locator('#np-title').fill('Preview held one renamed');
      await tab3.locator('#np-create').click();
      await expect(card).toContainText('Preview held one renamed', { timeout: 20_000 });
      // Tab 1 says what it waits for.
      await expect(page.locator('#viewport-job-label')).toContainText('Preparing elbow', { timeout: 15_000 });
      await tab3.close();
    } finally {
      rmSync(hold, { force: true });
    }
    // Once made, both parts show.
    for (const tab of context.pages()) {
      await expect
        .poll(() => tab.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready)), { timeout: 60_000, message: 'the part shows once its preview is made' })
        .toBe(true);
    }
  });

  test('a part whose preview is made: its face table, faces and edges are asked for at once, and its face table once', async ({ page, request }) => {
    test.setTimeout(240_000);
    const project = await importedProject(request, host, 'Preview made');
    /** The viewport's asks for the part, in order: [what, part], what = 'asked' | 'answered'. */
    const seen = [];
    const partOf = (url) => {
      const u = new URL(url);
      return u.pathname === '/api/geometry/cad' ? u.searchParams.get('part') || 'faces' : '';
    };
    page.on('request', (r) => {
      if (partOf(r.url())) seen.push(['asked', partOf(r.url())]);
    });
    page.on('response', (r) => {
      if (partOf(r.url())) seen.push(['answered', partOf(r.url()), r.status()]);
    });
    await page.goto(`${host.base}/#/p/${project.pid}`);
    await expect
      .poll(() => page.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready && window.__CFD_W16__.fingerprint && window.__CFD_W16__.fingerprint.nCells > 0)), {
        timeout: 60_000,
        message: 'the part is on screen',
      })
      .toBe(true);
    await page.waitForTimeout(1_000);
    stage(`the viewport's asks: ${seen.map((s) => s.join(' ')).join(', ')}`);
    const at = (what, part) => seen.findIndex((s) => s[0] === what && s[1] === part);
    expect(at('asked', 'faces'), 'its faces are asked for').toBeGreaterThanOrEqual(0);
    expect(at('asked', 'faces'), 'its faces are asked for before its face table has answered').toBeLessThan(at('answered', 'preview'));
    expect(at('asked', 'edges'), 'its edges too').toBeLessThan(at('answered', 'preview'));
    expect(seen.filter((s) => s[0] === 'asked' && s[1] === 'preview').length, 'its face table, once (it is the active geometry)').toBe(1);
  });

  test("a part being prepared while a mesh runs: the viewport's chip keeps the mesh and says the part after it", async ({ page, request }) => {
    test.setTimeout(240_000);
    const PID = 'preparing-while-meshing';
    const JOB = 'job-preparing-while-meshing';
    seedElbowProject(host.projects, PID, 'Preparing while meshing');
    const tree = await (await request.get(`${host.base}/api/project/tree?project_id=${PID}`)).json();
    const study = (tree.geometries || []).flatMap((g) => g.studies || [])[0] || {};
    const meshId = String(((study.meshes || [])[0] || {}).id || '');
    expect(meshId, 'seeded mesh').toBeTruthy();
    // No mesher runs: Generate is answered as a started snappyHexMesh job, whose events are the test's.
    await page.addInitScript(() => {
      window.__CFD_DISABLE_RUN_STATUS_POLL__ = true;
    });
    await mockJobChannel(page, JOB, () => [['event', { event: 'progress', stage: 'snappyHexMesh', status: 'running' }]]);
    await page.route(/\/api\/mesh\/generate(\?|$)/, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, job_id: JOB, status: 'running', mode: 'mesh', path_kind: 'snappyHexMesh', mesh_id: meshId, generate_id: 'gen-preparing', stage: 'snappyHexMesh' }),
      }),
    );
    // The seeded part has no preview yet: the page's load makes it, and it is held once made.
    rmSync(`${hold}.log`, { force: true });
    writeFileSync(hold, '');
    const chip = page.locator('#viewport-job-label');
    try {
      await page.goto(`${host.base}/#/p/${PID}`);
      await expect.poll(() => (existsSync(`${hold}.log`) ? readFileSync(`${hold}.log`, 'utf8') : ''), { timeout: 120_000 }).toContain('made ');
      // (The seeded part is named "Elbow".)
      await expect(chip).toContainText('Preparing Elbow', { timeout: 15_000 });
      // A mesh starts meanwhile: its chip, with the part said after it.
      await page.waitForFunction(() => typeof window.__CFD_MESH_OPEN_SETTINGS__ === 'function');
      await page.evaluate((id) => window.__CFD_MESH_OPEN_SETTINGS__(id), meshId);
      await page.locator('#panel-mesh-form .cfd-island [data-mesh-generate="1"]').click();
      await expect(chip).toHaveText(/^Meshing .* · Snapping the mesh to the surface · Preparing Elbow$/, { timeout: 15_000 });
      stage(`while the part is prepared and the mesh runs, the chip says "${await chip.textContent()}"`);
    } finally {
      rmSync(hold, { force: true });
    }
    // Once the part is made, the chip is the mesh's alone.
    await expect(chip).toHaveText(/^Meshing .* · Snapping the mesh to the surface$/, { timeout: 30_000 });
  });

  test('a project left while its part is prepared: the next project opens with no error, and the part is not drawn there', async ({ page, request }) => {
    test.setTimeout(240_000);
    const one = await plainProject(request, host, 'Left while prepared');
    const other = await request.post(`${host.base}/api/project`, { data: { title: 'Opened meanwhile', folder: 'My Projects', units: 'Metric', category: 'Other' } });
    const oj = await other.json();
    expect(other.ok(), JSON.stringify(oj)).toBe(true);
    const errors = [];
    page.on('pageerror', (e) => errors.push(`page error: ${String(e)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
    });
    rmSync(`${hold}.log`, { force: true });
    writeFileSync(hold, '');
    try {
      await page.goto(`${host.base}/#/p/${one.pid}`);
      await expect.poll(() => (existsSync(`${hold}.log`) ? readFileSync(`${hold}.log`, 'utf8') : ''), { timeout: 120_000 }).toContain('made ');
      await expect(page.locator('#viewport-job-label')).toContainText('Preparing elbow', { timeout: 15_000 });
      // The user opens another project (in the same page) while the part is prepared.
      await page.evaluate((h) => {
        window.location.hash = h;
      }, `#/p/${oj.id}`);
      await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, oj.id, { timeout: 60_000 });
      // The left part's load ends at its next ask (at most 2 s): quietly.
      await page.waitForTimeout(4_000);
      expect(errors, 'no error from the load the user left').toEqual([]);
      await expect(page.locator('#viewport-job-chip')).toBeHidden();
    } finally {
      rmSync(hold, { force: true });
    }
    await page.waitForTimeout(2_000);
    expect(errors, 'nor once the left part is made').toEqual([]);
    expect(await page.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready)), 'the other project shows no part').toBe(false);
  });
});
