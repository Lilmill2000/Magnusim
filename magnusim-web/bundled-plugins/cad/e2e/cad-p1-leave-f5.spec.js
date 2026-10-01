// F5 with a change that is not saved yet. Review round 2 found a waiting change
// lost on F5 (the reload did not wait for the save). With host API 1.2 the page
// tells the host it has unsaved work (nav.setDirty) until the save lands, so a
// reload asks first with the browser's own prompt: staying keeps the page, the
// save lands, and the next reload shows the change.
// P1.5 review round 1: a tab behind another one (its save not yet refused) that
// leaves by F5, by the pointer leaving the frame, or by Back then Leave, never
// replaces the other tab's saved version: the leave flush on a 1.2 host is the
// same conditional write (ifMatch) as every save.
//
// The save is held at its commit (the step that replaces the file), or at its
// begin for the tab that is behind, so the change is on its way for as long as
// the test needs: no timing luck.
// Real Chrome and Edge run the sandboxed frame in a process of its own (site
// isolation); this file asks the bundled Chromium for the same (a launch option
// applies to a whole file).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { answerLeave, baseUrl, historyState, holdCommits, newPartFromTree, newProject, openPart, openProject, partOpened, watchPage } from './helpers';

test.use({ launchOptions: { args: ['--site-per-process'] } });

const historyLabels = (frame) => frame.locator('[data-cad-tree] [data-feature-row] > .tree-row .tl');

async function freshPart(page, request) {
  const seen = await watchPage(page);
  const projectId = await newProject(request);
  await openProject(page, projectId);
  const row = await newPartFromTree(page, 'Part 1');
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return { seen, frame, row, projectId };
}

async function addBox(frame) {
  await frame.locator('[data-cad-toolbar] [data-command="solid.box"]').click();
  await frame.locator('[data-cad-panel="feature"] [data-panel-done]').click();
  await expect(frame.locator('[data-cad-panel="feature"]')).toHaveCount(0);
}

const expectSaved = (frame) => expect(frame.locator('[data-chip="save"]')).toHaveText('Saved', { timeout: 20_000 });

test('cad:p1-leave-f5 F5 with a save on its way: the browser asks before reloading; staying keeps the change, and it is there after the next reload', async ({ page, request }) => {
  const { seen, frame } = await freshPart(page, request);
  await addBox(frame);
  await addBox(frame);
  await expectSaved(frame);
  const hold = await holdCommits(page);
  const box2 = frame.locator('[data-cad-tree] [data-feature-row]').nth(1);
  await box2.locator('> .tree-row').click({ button: 'right' });
  await frame.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
  await expect(box2).toHaveAttribute('data-suppressed', '1');
  await expect.poll(() => hold.held()).toBe(1);
  await expect(frame.locator('[data-chip="save"]')).toHaveText('Saving…');
  const expected = await historyState(frame);
  expect(expected).toBe('Box 1, Box 2 (S)');

  // F5 reaches the frame (it has the keyboard); the browser then reloads (headless Chromium
  // does not on the key itself). The page has unsaved work: the browser asks first.
  const prompts = [];
  const onDialog = (d) => {
    prompts.push(d.type());
    void d.dismiss().catch(() => {});
  };
  page.on('dialog', onDialog);
  await page.keyboard.press('F5');
  // Staying cancels the reload: page.reload() then never sees a load, so it is cut short.
  await page.reload({ timeout: 3000 }).catch(() => {});
  await expect.poll(() => prompts).toEqual(['beforeunload']);
  page.off('dialog', onDialog);
  // Stayed: the same page, the change still there, its save still on its way.
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  expect(await historyState(frame)).toBe(expected);
  await hold.release();
  await expectSaved(frame);

  // Saved: a reload asks nothing, and the change is there.
  const after = [];
  const count = (d) => {
    after.push(d.type());
    void d.dismiss().catch(() => {});
  };
  page.on('dialog', count);
  await page.reload();
  page.off('dialog', count);
  expect(after).toEqual([]);
  const reloaded = page.frameLocator('#workspace-frame');
  await expect(reloaded.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(historyLabels(reloaded)).toHaveText(['Box 1', 'Box 2']);
  expect(await historyState(reloaded)).toBe(expected);
  await expect(reloaded.locator('[data-chip="save"]')).toHaveText('Saved');
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

// ---------------------------------------------------------------- P1.5 review round 1

/**
 * Hold the first ws.files write a page begins (POST /api/plugin-files/uploads, where
 * the host checks its ifMatch first) until release(); later writes go through. A
 * stale tab's save is then still on its way, not yet refused.
 */
async function holdFirstBegin(page) {
  const match = (url) => url.pathname === '/api/plugin-files/uploads';
  const held = [];
  let first = true;
  const handler = async (route) => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      held.push(route);
      return;
    }
    await route.continue();
  };
  await page.route(match, handler);
  return {
    held: () => held.length,
    release: async () => {
      for (const r of held.splice(0)) await r.continue().catch(() => {});
      await page.unroute(match, handler);
    },
  };
}

const studyIdOf = (page) => /\/ws\/cad\/part\/([^/?#]+)/.exec(decodeURIComponent(page.url()))[1];

/** The stored model as the host has it: its etag (GET /api/plugin-files/stat) and what is in it. */
async function stored(request, projectId, studyId) {
  const q = new URLSearchParams({ project_id: projectId, plugin: 'cad', rel: `studies/${studyId}/model.json` });
  const st = await request.get(`${baseUrl()}/api/plugin-files/stat?${q}`);
  expect(st.ok(), await st.text()).toBe(true);
  const rd = await request.get(`${baseUrl()}/api/plugin-files/read?${q}`);
  expect(rd.ok()).toBe(true);
  const doc = JSON.parse(await rd.text()).doc;
  return { etag: (await st.json()).file.etag, tree: doc.features.map((f) => f.name + (f.suppressed ? ' (S)' : '')).join(', ') };
}

test("cad:p1-leave-f5-conflict a tab behind another one never overwrites it on its way out: F5, the pointer leaving, Back then Leave", async ({ page, context, request }) => {
  // Tab A: Box 1, saved.
  const { seen, frame: a, projectId } = await freshPart(page, request);
  const studyId = studyIdOf(page);
  await addBox(a);
  await expectSaved(a);
  // Tab B opens the same Part.
  const page2 = await context.newPage();
  const seen2 = await watchPage(page2);
  await page2.goto(page.url());
  const b = page2.frameLocator('#workspace-frame');
  await expect(b.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready', { timeout: 60_000 });
  await expect(historyLabels(b)).toHaveText(['Box 1']);
  // B suppresses Box 1; its save is begun and held, so it is still on its way.
  const hold = await holdFirstBegin(page2);
  const b1 = b.locator('[data-cad-tree] [data-feature-row]').first();
  await b1.locator('> .tree-row').click({ button: 'right' });
  await b.locator('[data-cad-menu] [data-menu-item="suppress"]').click();
  await expect(b1).toHaveAttribute('data-suppressed', '1');
  await expect.poll(() => hold.held()).toBe(1);
  await expect(b.locator('[data-chip="save"]')).toHaveText('Saving…');
  // Meanwhile tab A adds Box 2 and saves: B's version is now behind.
  await page.bringToFront();
  await addBox(a);
  await expectSaved(a);
  const theirs = await stored(request, projectId, studyId);
  expect(theirs.tree).toBe('Box 1, Box 2');

  // 1. F5 in B with its save on its way: the browser asks; B stays. The leave flush is
  // the same conditional write as every save, so it cannot replace A's version.
  await page2.bringToFront();
  const prompts = [];
  const onDialog = (d) => {
    prompts.push(d.type());
    void d.dismiss().catch(() => {});
  };
  page2.on('dialog', onDialog);
  await page2.keyboard.press('F5');
  await page2.reload({ timeout: 3000 }).catch(() => {});
  await expect.poll(() => prompts).toEqual(['beforeunload']);
  page2.off('dialog', onDialog);
  await page2.waitForTimeout(1000);
  expect(await stored(request, projectId, studyId), "after B's F5: A's version").toEqual(theirs);
  // B's save reaches the host: refused on its etag. B says so, and A's version stands.
  await hold.release();
  const chip = b.locator('[data-chip="save"][data-state="conflict"]');
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip.locator('.cad-chip-v')).toHaveText('Changed in another tab');
  expect(await stored(request, projectId, studyId), "after B's refused save: A's version").toEqual(theirs);

  // 2. The pointer into B's part and out of the frame (the flush on leaving the frame).
  const fb = await page2.locator('#workspace-frame').boundingBox();
  await page2.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 4 });
  await page2.mouse.move(fb.x + fb.width / 2, 5, { steps: 6 });
  await page2.waitForTimeout(1000);
  expect(await stored(request, projectId, studyId), 'after the pointer left B: A\'s version').toEqual(theirs);

  // 3. B's Back asks (its change is not saved: A's came first); Leave closes B's workspace.
  const back = await page2.locator('#workspace-overlay [data-ws-back]').boundingBox();
  await page2.mouse.move(back.x + back.width / 2, back.y + back.height / 2, { steps: 10 });
  await page2.mouse.click(back.x + back.width / 2, back.y + back.height / 2, { delay: 80 });
  await expect(page2.locator('#cf-heading')).toHaveText('Leave without saving?');
  await expect(page2.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes to Part 1 are not saved: it was changed in another tab. Leaving discards them.');
  await answerLeave(page2, true);
  await expect(page2.locator('#workspace-overlay')).toBeHidden();
  await page2.waitForTimeout(1000);
  expect(await stored(request, projectId, studyId), "after B's Leave: A's version").toEqual(theirs);

  // B reopens the Part: A's tree. A still shows it too, saved.
  const rowB = page2.locator('#plugin-studies-section li[data-plugin="cad"]').filter({ has: page2.locator('.tl', { hasText: 'Part 1' }) });
  const again = await openPart(page2, rowB);
  await expect(again.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  expect(await historyState(again)).toBe('Box 1, Box 2');
  await expect(again.locator('[data-chip="save"]')).toHaveText('Saved');
  await page.bringToFront();
  expect(await historyState(a)).toBe('Box 1, Box 2');
  await expect(a.locator('[data-chip="save"]')).toHaveText('Saved');

  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  expect(seen2.csp, 'CSP violations (tab B)').toEqual([]);
  // The browser logs the host's 409 answer to B's refused save as a failed load, once; nothing else.
  const conflict409 = /^Failed to load resource: the server responded with a status of 409 \(Conflict\) \(http:\/\/[^/]+\/api\/plugin-files\/uploads(\/[^/]+\/commit)?\)$/;
  expect(seen2.errors.filter((e) => conflict409.test(e)).length, 'the refused save, once').toBe(1);
  expect(seen2.errors.filter((e) => !conflict409.test(e)), 'console errors (tab B)').toEqual([]);
  await page2.close();
});
