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
  serverChannels,
  serverStream,
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
// (document.visibilityState) from their first script on. A tab the user leaves after it was
// shown (or the old tab a new run.bat start leaves behind) is hidden by saying so, as the
// browser does; the server's own count says what it holds then (MAGNUSIM_TEST_EVENT_HUB), and
// a page that waits for a link keeps its stream (MAGNUSIM_TEST_SLOT_HOLD keeps the link
// queued) until the link ends. No WSL.

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

/** The tab is hidden (the user went to another tab or app): it says so, as the browser does. */
function hideTab(tab) {
  return tab.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
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
      env: { MAGNUSIM_TEST_EVENT_HUB: '1', MAGNUSIM_TEST_SLOT_HOLD: '1' },
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

  test('a tab hidden after it was shown lets its stream go and takes it back when shown; one whose page waits for a link keeps it until the link ends @plugins', async ({ page, request }) => {
    test.setTimeout(600_000);
    const project = await linkedProject(request, host, 'Hidden after shown', 2, stage);
    const context = page.context();
    const seen = watchRequests(context);
    const ready = async (tab) => {
      await tab.goto(`${host.base}/#/p/${project.pid}`);
      await tab.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, project.pid, { timeout: 60_000 });
      for (const s of project.studies) await expect(geometryRow(tab, s.gid)).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => tab.evaluate(() => !!(window.__CFD_W16__ && window.__CFD_W16__.ready)), { timeout: 60_000 }).toBe(true);
    };
    // The tab in front, and a second one the user looks at first.
    await ready(page);
    const back = await context.newPage();
    await ready(back);
    const shownId = await back.evaluate(() => String(window.__CFD_W16__.geometry.id));
    const target = project.studies.find((s) => s.gid === shownId);
    expect(target, `the tab shows one of the linked geometries (${shownId})`).toBeTruthy();
    expect(await shownZmax(back)).toBe(35);
    const backTab = seen.tabIdOf(back);
    expect(backTab, "the tab's event stream").toBeTruthy();
    await expect.poll(() => serverChannels(request, host, backTab, 'link'), { timeout: 15_000, message: 'its two linked geometries, on the server' }).toBe(2);

    // The user goes to another tab: after a few seconds the server holds nothing for it.
    await hideTab(back);
    // The monotonic clock: the wall clock can step back under load (seen on the Linux mirror: 2.1 s for a 2.5 s grace).
    const hiddenAt = performance.now();
    await expect
      .poll(() => serverStream(request, host, backTab), { timeout: 15_000, message: 'the hidden tab lets its stream go' })
      .toBeNull();
    const after = performance.now() - hiddenAt;
    expect(after, 'it was kept for the grace first').toBeGreaterThanOrEqual(2_500);
    await expect.poll(() => seen.openStreams(back), { timeout: 5_000, message: 'the browser holds no stream for it' }).toBe(0);
    await back.waitForTimeout(3_000);
    expect(await serverStream(request, host, backTab), 'it stays let go while hidden').toBeNull();
    stage(`the hidden tab let its stream go after ${after} ms; the browser holds ${seen.openStreams(back)} for it`);

    // v2 is linked meanwhile: the tab in front shows it, the hidden one does not yet.
    await linkVersion(request, host, project.pid, target.sid, 'v2', 2, 1);
    await expect.poll(() => shownZmax(page), { timeout: 60_000, message: 'the tab in front shows v2' }).toBe(30);
    expect(await shownZmax(back), 'the hidden tab still shows v1').toBe(35);
    // Shown again: its stream and both channels are back on the server, and it catches up.
    await showTab(back);
    await expect.poll(() => serverChannels(request, host, backTab, 'link'), { timeout: 15_000, message: 'its channels, back on the server' }).toBe(2);
    await expect.poll(() => serverChannels(request, host, backTab, 'ui'), { timeout: 15_000, message: "and its project's ui channel" }).toBe(1);
    await expect.poll(() => shownZmax(back), { timeout: 15_000, message: 'the tab shown again shows v2' }).toBe(30);

    // Its page waits for a link (queued: the compute slot is held) when the user leaves the tab.
    const other = project.studies.find((s) => s !== target);
    let held = false;
    try {
      const h = await request.post(`${host.base}/api/test/slot-hold`);
      expect(h.ok(), await h.text()).toBe(true);
      held = true;
      await back.evaluate((hash) => {
        window.location.hash = hash;
      }, `#/p/${project.pid}/ws/link-demo/demo/${other.sid}`);
      const frame = back.frameLocator('#workspace-frame');
      await expect(frame.locator('#link-title')).toHaveText(other.title, { timeout: 60_000 });
      const accepted = back.waitForResponse((r) => new URL(r.url()).pathname === '/api/plugin-geometry/link' && r.request().method() === 'POST', {
        timeout: 60_000,
      });
      await frame.locator('#link-v2').click();
      const answer = await (await accepted).json();
      expect(answer.job_id && answer.queued, `the link waits in the queue: ${JSON.stringify(answer)}`).toBeTruthy();
      await expect(frame.locator('#link-status')).toHaveText('Linking v2…');
      await hideTab(back);
      await back.waitForTimeout(6_000);
      const kept = await serverStream(request, host, backTab);
      expect(kept, 'a hidden tab whose page waits for a link keeps its stream').not.toBeNull();
      stage(`hidden 6 s while its page waits for a link: the server carries ${kept && kept.channels} channel(s) for it`);
      // The link ends while the tab is still hidden: its page hears it.
      await request.post(`${host.base}/api/test/slot-release`);
      held = false;
      await request.post(`${host.base}/api/compute-queue/kick`, { data: { project_id: project.pid } });
      await expect(frame.locator('#link-status')).toHaveText(/ rev 2$/, { timeout: 180_000 });
    } finally {
      if (held) await request.post(`${host.base}/api/test/slot-release`);
    }
    // Nothing waits any more: the hidden tab lets its stream go.
    await expect
      .poll(() => serverStream(request, host, backTab), { timeout: 15_000, message: 'once the link ended, the hidden tab lets its stream go' })
      .toBeNull();
    await back.close();
  });
});
