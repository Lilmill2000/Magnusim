import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { getJson } from './support/compute-slot.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import {
  bundledIfOnly,
  expectRenamed,
  linkVersion,
  linkedProject,
  pageFetchAnswers,
  renameStudy,
  serverAnswersIn,
  showsProject,
  shownZmax,
  stager,
  watchRequests,
} from './support/link-streams.js';

// The app's own requests are answered while its pages hold their event streams open.
// The app server speaks plain HTTP/1.1 (http://127.0.0.1:<port>), where the browser opens
// at most 6 connections to it, for all of its tabs together. An event stream holds its
// connection for as long as it is open, and a request the server holds (a part's preview
// being made) holds one too. Each linked geometry of the project a tab showed kept one
// stream (the server's heartbeats keep it open forever), a tab that went Home kept them,
// and a part whose preview was being made held four requests. With six held, every later
// request of every tab waited for a connection that never freed: the page looked frozen,
// said nothing, and a rename typed in it was never saved. Now a tab holds one event stream
// for everything it follows, none on Home, and a preview being made is asked for again
// (the tab says "Preparing <part>…" meanwhile). The streams are the ones the app opens
// itself: projects whose geometries the test plugin link-demo linked
// (python/tests/fixtures/link-plugins).
//   - two tabs on a project with three linked geometries: a rename in the first;
//   - one tab on a project with six linked geometries: a rename in it;
//   - a tab that went Home from a project with three linked geometries, and a second tab on
//     that project: a rename on Home;
//   - one tab on a project with three linked geometries and a plain part whose preview is
//     being made (MAGNUSIM_TEST_PREVIEW_HOLD holds it): a rename, and the part once made;
//   - a second tab on a Demo study's workspace: a link's events still reach its page and
//     the first tab's viewport (the one stream carries them), and a rename lands.
// No WSL. Each test prints how many link streams its tabs hold, and on a failure which of
// the page's requests got no answer while the server answered at once from outside the browser.

const HERE = dirname(fileURLToPath(import.meta.url));
const ELBOW = resolve(HERE, '..', 'python', 'tests', 'fixtures', 'geometry', 'elbow.step');
const stage = stager('connection-limit');

test.describe('the browser connection limit (6 to the app server)', () => {
  /** @type {any} */
  let host;
  /** MAGNUSIM_TEST_PREVIEW_HOLD: while this file is there, a preview that is made waits before it is placed. */
  let hold = '';
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    stage.reset();
    const tmp = e2eTemp('connection-limit');
    const projects = join(tmp, 'projects');
    hold = join(tmp, 'preview-hold');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'connection-limit',
      tmp,
      projects,
      bundledDir: bundledIfOnly(tmp),
      pluginsFrom: 'python/tests/fixtures/link-plugins',
      env: { MAGNUSIM_TEST_PREVIEW_HOLD: hold },
    });
    stage(`server up at ${host.base}`);
  });
  test.afterAll(() => {
    if (hold) rmSync(hold, { force: true });
    host?.stop();
  });

  test('two tabs on a project with three linked geometries: a rename in the first tab is saved and shown @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const project = await linkedProject(request, host, 'Held streams two tabs', 3, stage);
    const context = page.context();
    const seen = watchRequests(context);
    await showsProject(page, host, project, seen);
    stage(`tab 1 shows the project; link streams it holds: ${seen.openStreams(page)}`);
    // The same project in a second tab of the same browser (as a second run.bat start opens one).
    const tab2 = await context.newPage();
    await showsProject(tab2, host, project, seen, { ready: false });
    stage(`tab 2 shows it too; link streams held: ${seen.openStreams()} (tab 1 ${seen.openStreams(page)}, tab 2 ${seen.openStreams(tab2)})`);
    expect.soft(await pageFetchAnswers(page, 5_000), 'a request from tab 1 is answered').toMatch(/^answered/);
    await renameStudy(page, project.studies[0].sid, 'Demo 1 renamed');
    await expectRenamed(page, request, host, project.pid, project.studies[0].sid, 'Demo 1 renamed', seen, stage);
    await tab2.close();
  });

  test('one tab on a project with six linked geometries: a rename is saved and shown @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const project = await linkedProject(request, host, 'Held streams six links', 6, stage);
    const seen = watchRequests(page.context());
    // Not waiting for the project to be ready: what the page asks for after its tree has opened
    // the streams may never be answered.
    await showsProject(page, host, project, seen, { ready: false });
    stage(`the tab shows the project; link streams it holds: ${seen.openStreams(page)}`);
    expect.soft(await pageFetchAnswers(page, 5_000), 'a request from the tab is answered').toMatch(/^answered/);
    await renameStudy(page, project.studies[0].sid, 'Demo 1 renamed');
    await expectRenamed(page, request, host, project.pid, project.studies[0].sid, 'Demo 1 renamed', seen, stage);
  });

  test('a tab that went Home from a project with three linked geometries, a second tab on it: a rename on Home is saved and shown @plugins', async ({ page, request }) => {
    test.setTimeout(420_000);
    const project = await linkedProject(request, host, 'Held streams home', 3, stage);
    const context = page.context();
    const seen = watchRequests(context);
    await showsProject(page, host, project, seen);
    // Home, by the folder chip.
    await page.locator('#folder-chip').click();
    const card = page.locator(`.home-card[data-project-id="${project.pid}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    stage(`tab 1 is on Home; link streams it still holds: ${seen.openStreams(page)}`);
    const tab2 = await context.newPage();
    await showsProject(tab2, host, project, seen, { ready: false });
    stage(`tab 2 shows the project; link streams held: ${seen.openStreams()} (Home ${seen.openStreams(page)}, tab 2 ${seen.openStreams(tab2)})`);
    expect.soft(await pageFetchAnswers(page, 5_000), 'a request from Home is answered').toMatch(/^answered/);
    // Home's Edit project: a new title.
    await card.click();
    await page.locator('#home-edit-project').click();
    await expect(page.locator('#np-heading')).toHaveText(/Edit project/);
    await page.locator('#np-title').fill('Held streams renamed on Home');
    await page.locator('#np-create').click();
    const shown = await expect(card)
      .toContainText('Held streams renamed on Home', { timeout: 20_000 })
      .then(() => true, () => false);
    let why = '';
    if (!shown) {
      const pj = await getJson(request, `${host.base}/api/project?project_id=${encodeURIComponent(project.pid)}`);
      why = [
        `the server has the title ${JSON.stringify((pj.project || {}).title)}`,
        `the server answers a request from outside the browser: ${await serverAnswersIn(request, host)}`,
        `link streams held open: ${seen.openStreams()} (Home ${seen.openStreams(page)})`,
        `Home's requests with no answer: ${seen.unanswered(page).join(', ') || 'none'}`,
      ].join('; ');
      stage(`NOT renamed on Home: ${why}`);
    }
    expect(shown, `the card shows the new title within 20 s (${why})`).toBe(true);
    await tab2.close();
  });

  test('one tab on a project with three linked geometries and a part whose preview is being made: a rename is saved and shown, then the part @plugins', async ({ page, request }) => {
    test.setTimeout(480_000);
    const project = await linkedProject(request, host, 'Held streams and a preview', 3, stage);
    // A plain STEP part in the same project, the one the project opens on.
    const imported = await request.post(`${host.base}/api/geometry/import`, {
      data: { project_id: project.pid, step_path: ELBOW, filename: 'elbow.step' },
    });
    const ij = await imported.json();
    expect(imported.ok(), JSON.stringify(ij)).toBe(true);
    const plain = ij.geometry;
    const activated = await request.post(`${host.base}/api/geometry/activate`, { data: { project_id: project.pid, geometry_id: plain.id } });
    expect(activated.ok(), await activated.text()).toBe(true);
    // The import's picture is made first (from the preview it made) ...
    const thumbUrl = `${host.base}/api/geometry/thumb?project_id=${encodeURIComponent(project.pid)}`;
    await expect.poll(async () => (await request.get(thumbUrl)).status(), { timeout: 180_000, intervals: [1_000] }).not.toBe(202);
    // ... then its preview is gone, so the tab's load makes it again, and it is held once made.
    for (const f of ['cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json']) rmSync(join(dirname(plain.step_path), f), { force: true });
    rmSync(`${hold}.log`, { force: true });
    writeFileSync(hold, '');
    const made = () => (existsSync(`${hold}.log`) ? readFileSync(`${hold}.log`, 'utf8') : '').split(/\r?\n/).includes(`made ${plain.step_path}`);
    try {
      const seen = watchRequests(page.context());
      await showsProject(page, host, project, seen, { ready: false });
      await expect.poll(made, { timeout: 120_000, message: "the tab's load makes the part's preview" }).toBe(true);
      stage(`the preview is being made; link streams the tab holds: ${seen.openStreams(page)}; its requests with no answer: ${seen.unanswered(page).join(', ') || 'none'}`);
      await renameStudy(page, project.studies[1].sid, 'Demo 2 renamed');
      await expectRenamed(page, request, host, project.pid, project.studies[1].sid, 'Demo 2 renamed', seen, stage);
      // The viewport says what it waits for.
      await expect(page.locator('#viewport-job-label')).toContainText('Preparing elbow', { timeout: 15_000 });
    } finally {
      rmSync(hold, { force: true });
    }
    // Once made, the part shows and the chip no longer says so.
    await expect
      .poll(
        () => page.evaluate((id) => !!(window.__CFD_W16__ && window.__CFD_W16__.ready && window.__CFD_W16__.geometry && window.__CFD_W16__.geometry.id === id), plain.id),
        { timeout: 60_000, message: 'the part shows once its preview is made' },
      )
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => {
        const chip = document.getElementById('viewport-job-chip');
        return !chip || chip.hidden || !/Preparing/.test(chip.textContent || '');
      }), { timeout: 15_000 })
      .toBe(true);
  });

  test('a second tab on a Demo study\'s workspace: a link\'s events reach its page and the first tab\'s viewport, and a rename in the first tab is saved and shown @plugins', async ({ page, request }) => {
    test.setTimeout(480_000);
    const project = await linkedProject(request, host, 'Held streams live events', 3, stage);
    const context = page.context();
    const seen = watchRequests(context);
    await showsProject(page, host, project, seen);
    // The linked geometry tab 1 shows, and the study that links it.
    await expect.poll(() => page.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready)), { timeout: 60_000 }).toBe(true);
    const shownId = await page.evaluate(() => String(window.__CFD_W16__.geometry.id));
    const target = project.studies.find((s) => s.gid === shownId);
    expect(target, `tab 1 shows one of the linked geometries (${shownId})`).toBeTruthy();
    expect(await shownZmax(page)).toBe(35);
    await page.evaluate(() => {
      window.__sameLoad = true;
    });
    const tab2 = await context.newPage();
    await showsProject(tab2, host, project, seen);
    await tab2.evaluate((h) => {
      window.location.hash = h;
    }, `#/p/${project.pid}/ws/link-demo/demo/${target.sid}`);
    const frame = tab2.frameLocator('#workspace-frame');
    await expect(frame.locator('#link-title')).toHaveText(target.title, { timeout: 60_000 });
    stage(`tab 2 shows ${target.title}'s workspace; link streams held: ${seen.openStreams()} (tab 1 ${seen.openStreams(page)}, tab 2 ${seen.openStreams(tab2)})`);
    // v2 of that design, linked as the plugin does: its page hears it, and tab 1 loads it.
    await linkVersion(request, host, project.pid, target.sid, 'v2', 2, 1);
    stage('v2 linked');
    // (The page heard of v1 too: the link channel's snapshot has that job.)
    await expect(frame.locator('#link-events')).toHaveText(/(^|, )rev 2$/, { timeout: 60_000 });
    await expect.poll(() => shownZmax(page), { timeout: 60_000, message: "tab 1's viewport shows v2" }).toBe(30);
    expect(await page.evaluate(() => window.__sameLoad === true), 'tab 1 was not reloaded').toBe(true);
    await renameStudy(page, project.studies[0].sid, 'Demo 1 renamed');
    await expectRenamed(page, request, host, project.pid, project.studies[0].sid, 'Demo 1 renamed', seen, stage);
    await tab2.close();
  });
});
