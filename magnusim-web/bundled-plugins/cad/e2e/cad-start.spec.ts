// CAD ships on (Daniel's D33): its start action, clicked in each place it is offered,
// in the real host with CAD at its manifest default (nothing turns it on).
//   - an empty project: "Design a part" opens a new Part ("Part 1") in its workspace;
//     STUDIES then lists it;
//   - the header's "CAD" button: its menu says "No Part yet" and offers "New Part",
//     which opens "Part 1"; then it lists the Parts (a click opens one) and makes the
//     next ("Part 2");
//   - Home's "New design": New Project opens with "Untitled Part N" and "Design a
//     part" chosen, and one Create click opens the Part in the new project;
//   - the New Project dialog's "Start from": "Import geometry" by default, "Design a
//     part" offered; chosen, Create opens a Part in the new project.
// Each Part opens with its document ready, the crumb "Magnusim CAD › Part N", and Back
// returns to its project. The projects made here are deleted at the end.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { baseUrl, cadPluginRow, newProject, openProject, partOpened, watchPage } from './helpers';

const made: string[] = [];
test.afterAll(async ({ request }) => {
  for (const pid of made) await request.post(`${baseUrl()}/api/project/delete`, { data: { project_id: pid } }).catch(() => {});
});

/** Home lists the app's seeded sample projects, whose thumbnails 404 on a fresh e2e root (the app's, not CAD's). */
const notHomeThumbs = (errors: string[]) => errors.filter((e) => !/status of 404 \(Not Found\) \(https?:\/\/[^/]+\/api\/geometry\/thumb\?project_id=sample-/.test(e));

const overlay = (page: Page) => page.locator('#workspace-overlay');
const headerButton = (page: Page) => page.locator('#ws-start-host [data-start-header="cad:part"] > button');
const headerMenu = (page: Page) => page.locator('#ws-start-host [data-start-header="cad:part"] [role="menu"]');
const studyRows = (page: Page) => page.locator('#plugin-studies-section li[data-plugin="cad"] > .tree-row .tl');

/** CAD ships on: on in the catalog with its start action, before any test turned it on. */
async function shipsOn(request: APIRequestContext) {
  const row = (await cadPluginRow(request))!;
  expect(row.status).toBe('enabled');
  expect(row.default_enabled).not.toBe(false);
  expect(row.start_actions).toEqual([expect.objectContaining({ study_kind: 'part', label: 'Design a part', home_label: 'New design', header_label: 'CAD' })]);
}

/** A Part opened in its workspace: its route, title, crumb, and the document ready. */
async function partOpen(page: Page, title: string): Promise<string> {
  await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/#\/p\/[^/]+\/ws\/cad\/part\/st-[a-z0-9-]+$/, { timeout: 60_000 });
  await expect(overlay(page).locator('[data-ws-title]')).toHaveText(title);
  await expect(overlay(page).locator('[data-ws-crumb]')).toHaveText(new RegExp(`Magnusim CAD\\s*›\\s*${title}`));
  await expect(page.locator('#modal-prompt')).toBeHidden();
  const frame = await partOpened(page);
  await expect(frame.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  return decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
}

async function back(page: Page, pid: string) {
  await overlay(page).locator('[data-ws-back]').click();
  await expect(overlay(page)).toBeHidden({ timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
}

async function home(page: Page) {
  await page.goto('about:blank');
  await page.goto(`${baseUrl()}/#/`);
  await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
}

test.describe('CAD ships on: its start action in every place', () => {
  test('cad:start-empty-project "Design a part" on an empty project opens a new Part; STUDIES then lists it', async ({ page, request }) => {
    test.setTimeout(240_000);
    const seen = await watchPage(page);
    await shipsOn(request);
    const pid = await newProject(request, 'CAD start empty', { cadOff: true });
    made.push(pid);
    await openProject(page, pid);
    // Empty: the project's own buttons and CAD's beside them; no STUDIES yet.
    await expect(page.locator('#btn-add-geometry')).toBeVisible();
    const start = page.locator('#wb-empty-start [data-start-empty="cad:part"]');
    await expect(start).toHaveText('Design a part');
    await expect(page.locator('#plugin-studies-section')).toBeHidden();
    await start.click();
    expect(await partOpen(page, 'Part 1')).toBe(pid);
    await back(page, pid);
    await expect(studyRows(page)).toHaveText(['Part 1']);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:start-header the header "CAD" menu: no Part yet, New Part opens Part 1; then it lists the Parts (a click opens one) and makes Part 2', { tag: '@smoke' }, async ({ page, request }) => {
    test.setTimeout(300_000);
    const seen = await watchPage(page);
    await shipsOn(request);
    const pid = await newProject(request, 'CAD start header', { cadOff: true });
    made.push(pid);
    await openProject(page, pid);
    await expect(headerButton(page)).toHaveText('CAD');
    await headerButton(page).click();
    await expect(headerMenu(page)).toBeVisible();
    await expect(headerMenu(page).locator('[data-start-none]')).toHaveText('No Part yet');
    await expect(headerMenu(page).locator('[data-start-new="cad:part"]')).toHaveText('New Part');
    await headerMenu(page).locator('[data-start-new="cad:part"]').click();
    await partOpen(page, 'Part 1');
    await back(page, pid);
    // The menu lists Part 1 now; a click opens it, as it was.
    await headerButton(page).click();
    await expect(headerMenu(page).locator('[data-start-study]')).toHaveText(['Part 1']);
    await headerMenu(page).locator('[data-start-study]').click();
    await partOpen(page, 'Part 1');
    await back(page, pid);
    // New Part again: Part 2.
    await headerButton(page).click();
    await headerMenu(page).locator('[data-start-new="cad:part"]').click();
    await partOpen(page, 'Part 2');
    await back(page, pid);
    await expect(studyRows(page)).toHaveText(['Part 1', 'Part 2']);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  });

  test('cad:start-home Home "New design" opens New Project with "Untitled Part N" and "Design a part" chosen; one Create click opens the Part', { tag: '@serial' }, async ({ page, request }) => {
    test.setTimeout(240_000);
    const seen = await watchPage(page);
    await shipsOn(request);
    await home(page);
    const button = page.locator('#home-start-host [data-home-start="cad:part"]');
    await expect(button).toHaveText('New design');
    await button.click();
    await expect(page.locator('#modal-new-project')).toBeVisible();
    await expect(page.locator('#np-start input[value="cad:part"]')).toBeChecked();
    await expect(page.locator('#np-start .np-start-label')).toHaveText(['Import geometry', 'Design a part']);
    // "Untitled Part N": the first N no project of the folder has yet (the app's own rule).
    await expect(page.locator('#np-title')).toHaveValue(/^Untitled Part \d+$/);
    const title = await page.locator('#np-title').inputValue();
    await page.locator('#np-create').click();
    await expect(page.locator('#modal-new-project')).toBeHidden();
    const pid = await partOpen(page, 'Part 1');
    made.push(pid);
    await back(page, pid);
    await expect(page.locator('.project-name')).toHaveText(title);
    await expect(studyRows(page)).toHaveText(['Part 1']);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(notHomeThumbs(seen.errors), 'console errors').toEqual([]);
  });

  test('cad:start-new-project the New Project dialog "Start from": Import geometry by default, "Design a part" chosen opens a Part in the new project', { tag: '@serial' }, async ({ page, request }) => {
    test.setTimeout(240_000);
    const seen = await watchPage(page);
    await shipsOn(request);
    await home(page);
    await page.locator('#home-new-project').click();
    await expect(page.locator('#modal-new-project')).toBeVisible();
    await expect(page.locator('#np-start')).toBeVisible();
    await expect(page.locator('#np-start .np-start-label')).toHaveText(['Import geometry', 'Design a part']);
    await expect(page.locator('#np-start-import')).toBeChecked();
    await page.locator('#np-start label', { has: page.locator('input[value="cad:part"]') }).click();
    await expect(page.locator('#np-start input[value="cad:part"]')).toBeChecked();
    await page.locator('#np-title').fill('CAD start from');
    await page.locator('#np-create').click();
    await expect(page.locator('#modal-new-project')).toBeHidden();
    const pid = await partOpen(page, 'Part 1');
    made.push(pid);
    await back(page, pid);
    await expect(page.locator('.project-name')).toHaveText('CAD start from');
    await expect(studyRows(page)).toHaveText(['Part 1']);
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(notHomeThumbs(seen.errors), 'console errors').toEqual([]);
  });
});
