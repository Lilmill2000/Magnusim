import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import {
  bundledIfOnly,
  expectRenamed,
  geometryRow,
  linkVersion,
  linkedProject,
  renameStudy,
  shownZmax,
  stager,
  watchRequests,
} from './support/link-streams.js';

// Tabs in the background hold no connection of the browser's. The app server speaks plain
// HTTP/1.1, where the browser opens at most 6 connections to it for all of its tabs together,
// and each tab on a project holds one event stream (its linked geometries' events). Six tabs
// (old run.bat tabs, say) held six, and the one the user looks at froze. A tab that is hidden
// lets its stream go (after a few seconds) unless it follows a job, and takes it again when it
// is shown: the snapshots and one tree read catch it up, so a geometry linked meanwhile shows.
// Playwright's pages are always visible: the five background tabs say they are hidden
// (document.visibilityState) from their first script on. No WSL.

const stage = stager('connection-limit-hidden');

/** A tab that says it is hidden from its first script on (Playwright's pages are always visible). */
async function hiddenTab(context) {
  const tab = await context.newPage();
  await tab.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  return tab;
}

/** The tab is shown again: it says so, as the browser does. */
function showTab(tab) {
  return tab.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('tabs in the background and the browser connection limit', () => {
  /** @type {any} */
  let host;
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    stage.reset();
    const tmp = e2eTemp('connection-limit-hidden');
    const projects = join(tmp, 'projects');
    prepareE2eProjectsRoot(projects);
    host = await startHost({
      name: 'connection-limit-hidden',
      tmp,
      projects,
      bundledDir: bundledIfOnly(tmp),
      pluginsFrom: 'python/tests/fixtures/link-plugins',
    });
    stage(`server up at ${host.base}`);
  });
  test.afterAll(() => host?.stop());

  test('five background tabs and one in front on a project with three linked geometries: a rename in front is saved and shown, and a background tab shows a link made meanwhile when shown @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const project = await linkedProject(request, host, 'Hidden tabs', 3, stage);
    const context = page.context();
    const seen = watchRequests(context);
    // The tab in front: the project, ready, and the linked geometry it shows.
    await page.goto(`${host.base}/#/p/${project.pid}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project.pid, { timeout: 60_000 });
    for (const s of project.studies) await expect(geometryRow(page, s.gid)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready)), { timeout: 60_000 }).toBe(true);
    const shownId = await page.evaluate(() => String(window.__CFD_W16__.geometry.id));
    const target = project.studies.find((s) => s.gid === shownId);
    expect(target, `the tab shows one of the linked geometries (${shownId})`).toBeTruthy();
    expect(await shownZmax(page)).toBe(35);
    // Five tabs in the background on the same project.
    const hidden = [];
    for (let i = 0; i < 5; i++) {
      const tab = await hiddenTab(context);
      await tab.goto(`${host.base}/#/p/${project.pid}`, { waitUntil: 'commit' });
      hidden.push(tab);
    }
    const showing = await Promise.all(
      hidden.map((tab) =>
        expect(geometryRow(tab, target.gid))
          .toBeVisible({ timeout: 90_000 })
          .then(() => true, () => false),
      ),
    );
    stage(`background tabs that show the project: ${showing.filter(Boolean).length} of 5; event streams held: ${seen.openStreams()} (front ${seen.openStreams(page)})`);
    await renameStudy(page, project.studies[0].sid, 'Demo 1 renamed');
    await expectRenamed(page, request, host, project.pid, project.studies[0].sid, 'Demo 1 renamed', seen, stage);
    expect(showing, 'every background tab shows the project').toEqual([true, true, true, true, true]);
    // v2 of the shown geometry's design while the tabs are in the background.
    const tab2 = hidden[0];
    expect(await shownZmax(tab2)).toBe(35);
    await linkVersion(request, host, project.pid, target.sid, 'v2', 2, 1);
    await expect.poll(() => shownZmax(page), { timeout: 60_000, message: 'the tab in front shows v2' }).toBe(30);
    stage(`v2 linked; the tab in front shows it; event streams held: ${seen.openStreams()} (front ${seen.openStreams(page)})`);
    expect(await shownZmax(tab2), 'a background tab still shows v1').toBe(35);
    // A background tab shown again catches up: it shows v2 too.
    await showTab(tab2);
    await expect.poll(() => shownZmax(tab2), { timeout: 15_000, message: 'the tab shown again shows v2' }).toBe(30);
    for (const tab of hidden) await tab.close();
  });
});
