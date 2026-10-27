// Leaving a Part in Magnusim CAD: it has no project geometries, so a Part is never linked, but
// CAD's exit hook still guards the person's work. An edit with Back pressed while its save is
// on its way waits for the save ("Saving Part 1") and is kept; a save the app refuses asks
// "Leave without saving?" (never "Couldn't update the project"), and Stay keeps the Part.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from './pw';
import { addSolid, historyNames, holdCommits, partOpened, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';

async function freshPart(page: Page, request: APIRequestContext, title: string) {
  const seen = await watchPage(page);
  const made = await request.post('/api/project', { data: { title, category: 'Other', units: 'Metric' } });
  expect(made.ok()).toBe(true);
  const pid = String((await made.json()).id);
  const st = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Part 1' } });
  expect(st.ok()).toBe(true);
  const sid = String((await st.json()).study.id);
  await page.goto(`/#/p/${pid}`);
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Part 1']);
  await page.locator('#cad-project .cad-part-open', { hasText: 'Part 1' }).click();
  const frame = await partOpened(page);
  // The kernel is up; the Part's document loads after it.
  await expect
    .poll(() => workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { snapshot(): { doc: { status: string } } } }).__CAD__.snapshot().doc.status), { timeout: 30_000 })
    .toBe('ready');
  return { seen, pid, sid, frame };
}

const chip = (frame: ReturnType<Page['frameLocator']>) => frame.locator('[data-chip="save"]');

test('an edit with Back pressed while its save is on its way is kept', async ({ page, request }) => {
  const { seen, pid, frame } = await freshPart(page, request, 'Leave while saving');
  await addSolid(page, { size: [30, 20, 10] });
  await expect(chip(frame)).toHaveText('Saved', { timeout: 20_000 });

  const hold = await holdCommits(page);
  await addSolid(page, { at: [50, 0, 0], size: [10, 10, 10] });
  await expect.poll(() => hold.held(), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  // The exit waits for the save, over the covered Part, and asks nothing.
  await expect(page.locator('[data-ws-leave-status]')).toHaveText('Saving Part 1', { timeout: 10_000 });
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await hold.release();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 60_000 });
  await expect(page.locator('#modal-confirm')).toBeHidden();
  await expect(page.locator('#cad-project .cad-part-title')).toHaveText(['Part 1']);

  // Reopened, it has the edit made just before Back.
  await page.locator('#cad-project .cad-part-open', { hasText: 'Part 1' }).click();
  const again = await partOpened(page);
  await expect(historyNames(again)).toHaveText(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test('a save the app refuses asks "Leave without saving?" at Back, and Stay keeps the Part', async ({ page, request }) => {
  const { seen, pid, sid, frame } = await freshPart(page, request, 'Leave unsaved');
  await addSolid(page, { size: [30, 20, 10] });
  await expect(chip(frame)).toHaveText('Saved', { timeout: 20_000 });

  // The app refuses every commit until the disk has room again (its own answer, HTTP 507).
  const commit = '**/api/plugin-files/uploads/*/commit*';
  let room = false;
  await page.route(commit, async (route) => {
    if (room) return route.continue();
    await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'there is not enough free disk space for this file', code: 'disk_full' }) });
  });
  await addSolid(page, { at: [50, 0, 0], size: [10, 10, 10] });
  await expect(chip(frame)).toHaveAttribute('data-state', 'error', { timeout: 20_000 });

  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#cf-heading')).toHaveText('Leave without saving?', { timeout: 60_000 });
  await expect(page.locator('#cf-copy')).toHaveText('Magnusim CAD: Changes to Part 1 are not saved: the disk is full. Leaving discards them.');
  await expect(page.locator('#cf-confirm')).toHaveText('Leave');
  await expect(page.locator('#cf-cancel')).toHaveText('Stay');
  await page.locator('#cf-cancel').click();
  await expect(page.locator('#workspace-overlay')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/ws/cad/part/${sid}$`));

  // Room again: Retry saves, and Back leaves with nothing asked.
  room = true;
  await chip(frame).locator('[data-chip-action="Retry"]').click();
  await expect(chip(frame)).toHaveText('Saved', { timeout: 10_000 });
  await page.unroute(commit);
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`), { timeout: 60_000 });
  await expect(page.locator('#modal-confirm')).toBeHidden();
  expect(seen.csp, 'CSP violations').toEqual([]);
  // The browser logs the 507 this test answered as a failed load; nothing else.
  expect(seen.errors.filter((e) => !/status of 507 .*\/api\/plugin-files\/uploads\/[^/]+\/commit/.test(e)), 'console errors').toEqual([]);
});
