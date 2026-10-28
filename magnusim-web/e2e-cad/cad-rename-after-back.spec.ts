// A Part renamed on the project page right after Back keeps its new name. A new Part writes its
// own record while it is open (its document's pointer on first open), so the project page's row,
// read when the Part was made, is older than the record. The rename used to send the row's rev
// and be refused ("This study changed in another tab"), losing the name: on a slow PC the list
// read on Back has not answered when Rename is clicked, and the Part's write can even land after
// Back. The page now reads the record once the name is typed, so neither order is refused.
// Each test holds the request that makes its order happen every time.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from './pw';
import { partOpened, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';

async function recordOf(request: APIRequestContext, pid: string, sid: string): Promise<{ title: string; rev: number }> {
  const r = await request.get(`/api/plugin-studies/get?${new URLSearchParams({ project_id: pid, plugin: 'cad', study_id: sid })}`);
  expect(r.ok()).toBe(true);
  const s = (await r.json()).study;
  return { title: String(s.title), rev: Number(s.rev) };
}

const docStatus = (page: Page) =>
  workspaceFrame(page).evaluate(() => (window as unknown as { __CAD__: { snapshot(): { doc: { status: string } } } }).__CAD__.snapshot().doc.status);

/** A project with Part 1, its page open; what the page's rename requests answered. */
async function projectPage(page: Page, request: APIRequestContext, title: string) {
  const seen = await watchPage(page);
  const made = await request.post('/api/project', { data: { title, category: 'Other', units: 'Metric' } });
  expect(made.ok()).toBe(true);
  const pid = String((await made.json()).id);
  const first = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Part 1' } });
  expect(first.ok()).toBe(true);
  const renames: number[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/plugin-studies/rename') renames.push(r.status());
  });
  await page.goto(`/#/p/${pid}`);
  const project = page.locator('#cad-project');
  await expect(project.locator('.cad-part-title')).toHaveText(['Part 1']);
  return { seen, pid, project, renames };
}

/** The page's `method` requests to `path` wait until released (and any later one goes at once). */
async function hold(page: Page, method: string, path: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== method) return route.fallback();
      held += 1;
      await gate;
      await route.continue();
    },
  );
  return { held: () => held, release };
}

async function renameTo(page: Page, project: ReturnType<Page['locator']>, sid: string, from: string, to: string) {
  await project.locator(`.cad-part[data-part-id="${sid}"]`).getByRole('button', { name: `Rename ${from}` }).click();
  const prompt = page.locator('#modal-prompt');
  await expect(prompt).toBeVisible();
  await prompt.locator('#pm-input').fill(to);
  await prompt.locator('#pm-confirm').click();
}

test('a Part renamed right after Back keeps its new name, though its row was read before the Part saved', async ({ page, request }) => {
  const { seen, pid, project, renames } = await projectPage(page, request, 'Rename after Back');

  // New part: the page lists Part 2 as it was made; opened, it writes its record.
  await project.locator('#cad-new-part').click();
  await partOpened(page);
  await expect(page).toHaveURL(/\/ws\/cad\/part\/[^/]+$/);
  const sid = decodeURIComponent(page.url().split('/').pop() || '');
  await expect.poll(() => docStatus(page), { timeout: 30_000 }).toBe('ready');
  const listed = Number(await project.locator(`.cad-part[data-part-id="${sid}"]`).getAttribute('data-part-rev'));
  await expect.poll(async () => (await recordOf(request, pid, sid)).rev, { timeout: 20_000 }).toBeGreaterThan(listed);

  // From Back until the rename is done, the page's list reads wait (a slow PC's).
  const list = await hold(page, 'GET', '/api/plugin-studies');
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => list.held(), { timeout: 10_000 }).toBeGreaterThan(0);
  // What the path under test needs: the row the person clicks is older than the record.
  await expect(project.locator(`.cad-part[data-part-id="${sid}"]`)).toHaveAttribute('data-part-rev', String(listed));
  expect((await recordOf(request, pid, sid)).rev).toBeGreaterThan(listed);

  await renameTo(page, project, sid, 'Part 2', 'Lid');
  await expect.poll(async () => (await recordOf(request, pid, sid)).title, { timeout: 10_000 }).toBe('Lid');
  // Sent with the record's rev: nothing refused.
  await expect.poll(() => renames).toEqual([200]);
  list.release();
  // (Both Parts were made within the same second: the list's order between them is by id.)
  await expect.poll(async () => (await project.locator('.cad-part-title').allTextContents()).sort()).toEqual(['Lid', 'Part 1']);
  await expect(page.locator('#modal-confirm')).toBeHidden();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});

test("a Part renamed right after Back keeps its new name when the Part's own write lands after Back", async ({ page, request }) => {
  const { seen, pid, project, renames } = await projectPage(page, request, 'Rename before the write');

  // The new Part's first write of its record (its document's pointer) waits: the kernel is up,
  // the document still loading.
  const write = await hold(page, 'POST', '/api/plugin-studies/update');
  await project.locator('#cad-new-part').click();
  await partOpened(page);
  await expect(page).toHaveURL(/\/ws\/cad\/part\/[^/]+$/);
  const sid = decodeURIComponent(page.url().split('/').pop() || '');
  await expect.poll(() => write.held(), { timeout: 20_000 }).toBe(1);
  expect(await docStatus(page)).toBe('loading');

  // Back while it waits; the list read on Back answers with the record as it is (not written yet).
  const lists = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/plugin-studies' && r.request().method() === 'GET');
  await page.locator('#workspace-overlay [data-ws-back]').click();
  await expect(page.locator('#workspace-overlay')).toBeHidden({ timeout: 30_000 });
  await lists;
  const row = project.locator(`.cad-part[data-part-id="${sid}"]`);
  const listed = Number(await row.getAttribute('data-part-rev'));

  // Then the write lands: the row is older than the record from here on.
  write.release();
  await expect.poll(async () => (await recordOf(request, pid, sid)).rev, { timeout: 20_000 }).toBeGreaterThan(listed);
  await expect(row).toHaveAttribute('data-part-rev', String(listed));

  await renameTo(page, project, sid, 'Part 2', 'Lid');
  await expect.poll(async () => (await recordOf(request, pid, sid)).title, { timeout: 10_000 }).toBe('Lid');
  await expect.poll(() => renames).toEqual([200]);
  await expect.poll(async () => (await project.locator('.cad-part-title').allTextContents()).sort()).toEqual(['Lid', 'Part 1']);
  await expect(page.locator('#modal-confirm')).toBeHidden();
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
});
