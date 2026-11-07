// Magnusim CAD issue 17: a tab closed while its save was on its way left that upload of the
// Part's model open on the server, which keeps 4 uploads open per project and plugin and ends an
// idle one after 10 minutes. After four such tabs every save of the Part was refused ("Not saved:
// too many files are being saved at once") until they ran out. A new upload of a file now ends
// that file's older uploads that waited 30 s, and other files' ones when the plugin's places are
// taken (scripts/server/plugin-files.ts UPLOAD_SUPERSEDE_MS).
// Four tabs open the Part, then each in turn changes it and goes while its save is on its way: its
// commit is held in the browser (the begin and the bytes reached the server), then the tab's page
// crashes, so it sends nothing more, as a closed or crashed tab does (with Playwright's own close
// the page still aborted its upload: the server held none). The server then holds four uploads:
// while none waited 30 s, a fifth begin is refused. A fresh tab, once the last of them waited
// 30 s, changes the Part: no save of it is refused, its chip says Saved, and the change is stored.
// The page's own side: a tab closed (not crashed) while its save's bytes are on their way aborts
// that upload as its page goes (src/workspace/bridge.ts pageGone), so the server holds none of
// it at once, with no 30 s wait.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page, type Response, type Route } from '@playwright/test';
import { addSketch, baseUrl, holdCommits, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage } from './helpers';

/** How long the server lets an older upload of a file wait before a new one of it ends it (UPLOAD_SUPERSEDE_MS). */
const SUPERSEDE_MS = 30_000;

function studyIdOf(page: Page): string {
  const m = /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()));
  if (!m) throw new Error(`not a Part workspace address: ${page.url()}`);
  return m[1];
}

async function storedModel(request: APIRequestContext, projectId: string, studyId: string) {
  const r = await request.post(`${baseUrl()}/api/plugin-data/read`, { data: { project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.json` } });
  expect(r.ok()).toBe(true);
  return (await r.json()).doc as { doc: { features: unknown[] } };
}

/** A save's begin (POST /api/plugin-files/uploads). */
const isBegin = (r: Response) => new URL(r.url()).pathname === '/api/plugin-files/uploads' && r.request().method() === 'POST';

test('cad:save-after-closed-tabs four tabs closed mid-save leave the Part saving in a fresh tab', async ({ page, context, request }) => {
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const first = await partOpened(page);
  await expect(first.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  const studyId = studyIdOf(page);
  const rowIn = (p: Page) => p.locator(`#plugin-studies-section li[data-plugin="cad"][data-plugin-study="${studyId}"]`);
  // This tab leaves the Part: only the tabs below save it.
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();

  // The tabs open the Part first, so their saves follow each other closely.
  const tabs: { tab: Page; held: Awaited<ReturnType<typeof holdCommits>> }[] = [];
  for (let i = 1; i <= 4; i++) {
    const tab = await context.newPage();
    await openProject(tab, projectId);
    await openPart(tab, rowIn(tab));
    tabs.push({ tab, held: await holdCommits(tab) });
  }
  let firstSent = 0;
  let lastClosed = 0;
  for (const [n, { tab, held }] of tabs.entries()) {
    const begun = tab.waitForResponse(isBegin);
    await addSketch(tab, { size: [11 + n, 10] });
    expect((await begun).status(), `tab ${n + 1}'s save began`).toBe(201);
    await expect.poll(() => held.held(), { message: `tab ${n + 1}'s save sent its bytes and its commit` }).toBe(1);
    firstSent ||= Date.now();
    const cdp = await context.newCDPSession(tab);
    const crashed = tab.waitForEvent('crash');
    void cdp.send('Page.crash').catch(() => undefined);
    await crashed;
    await tab.close();
    lastClosed = Date.now();
  }
  // The four uploads are open on the server: another begin of the plugin is refused. A begin ends
  // uploads that waited 30 s, so this holds only while none has.
  expect(Date.now() - firstSent, 'the four tabs saved within 30 s (on a loaded PC, run this spec alone)').toBeLessThan(SUPERSEDE_MS - 2_000);
  const fifth = await request.post(`${baseUrl()}/api/plugin-files/uploads`, { data: { project_id: projectId, plugin: 'cad', rel: 'other.bin', size: 1 } });
  expect([fifth.status(), (await fifth.json()).code], "the server holds the four closed tabs' uploads").toEqual([429, 'too_many_uploads']);

  const fresh = await context.newPage();
  const seen = await watchPage(fresh);
  const begins: number[] = [];
  fresh.on('response', (r) => {
    if (isBegin(r)) begins.push(r.status());
  });
  await openProject(fresh, projectId);
  const part = await openPart(fresh, rowIn(fresh));
  // The person comes back once the last closed tab's upload waited 30 s.
  await fresh.waitForTimeout(Math.max(0, lastClosed + SUPERSEDE_MS + 1_000 - Date.now()));
  await addSketch(fresh, { size: [37, 23] });
  await expect.poll(() => begins.length, { message: "the fresh tab's save began" }).toBeGreaterThan(0);
  expect(begins[0], "the fresh tab's save was not refused (429: too many files are being saved at once)").toBe(201);
  await expect(part.locator('[data-chip="save"]')).toHaveText('Saved');
  await expect.poll(async () => JSON.stringify((await storedModel(request, projectId, studyId)).doc.features), { message: 'the change is stored' }).toContain('"37 mm"');
  expect(begins.every((s) => s === 201), `every save began: ${begins}`).toBe(true);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('cad:save-tab-closed-mid-save a tab closed while its save is on its way leaves no upload open', async ({ page, context, request }) => {
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Part 1');
  const first = await partOpened(page);
  await expect(first.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });
  const studyId = studyIdOf(page);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden();

  const tab = await context.newPage();
  await openProject(tab, projectId);
  await openPart(tab, tab.locator(`#plugin-studies-section li[data-plugin="cad"][data-plugin-study="${studyId}"]`));
  // The save's bytes (its chunk PUT) are held in the browser: the server has its begin only.
  const held: Route[] = [];
  await tab.route(
    (url) => /^\/api\/plugin-files\/uploads\/[^/]+$/.test(url.pathname),
    (route) => (route.request().method() === 'PUT' ? void held.push(route) : route.continue()),
  );
  const begun = tab.waitForResponse(isBegin);
  await addSketch(tab, { size: [12, 10] });
  expect((await begun).status(), "the tab's save began").toBe(201);
  await expect.poll(() => held.length, { message: "the tab's save sent its bytes" }).toBe(1);
  await tab.close();

  // The server holds none of the closed tab's uploads: with three other files begun, a fourth still
  // gets a place well before the server would end the tab's upload by itself (30 s).
  const begin = (rel: string) => request.post(`${baseUrl()}/api/plugin-files/uploads`, { data: { project_id: projectId, plugin: 'cad', rel, size: 1 } });
  const ids: string[] = [];
  for (const rel of ['probe-1.bin', 'probe-2.bin', 'probe-3.bin']) {
    const r = await begin(rel);
    expect(r.status(), `${rel} began: ${await r.text()}`).toBe(201);
    ids.push((await r.json()).upload);
  }
  await expect
    .poll(
      async () => {
        const r = await begin('probe-4.bin');
        const text = await r.text();
        if (r.status() === 201) ids.push(JSON.parse(text).upload);
        return `${r.status()} ${text}`;
      },
      { message: "the closed tab's upload was aborted as its page went", timeout: 5_000 },
    )
    .toMatch(/^201 /);
  for (const id of ids) {
    const r = await request.post(`${baseUrl()}/api/plugin-files/uploads/${id}/abort`, { data: { project_id: projectId, plugin: 'cad' } });
    expect((await r.json()).aborted).toBe(true);
  }
});
