import { expect, test } from '@playwright/test';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_GEOMETRY_PROJECT, prepareE2eProjectsRoot } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

// gate:l1-places, start actions (API 1.4) as the user meets them, with two test plugins
// (python/tests/fixtures/start-plugins), no bundled plugin but Incompressible Flow:
//   start-demo    kind Demo (header_label "Demo", every place) and kind Note (no action)
//   start-demo-2  kinds Alpha, Beta, Gamma, each with a header action (one also names
//                 the place "toolbar", which this app does not know), so four header
//                 actions over the two plugins: Gamma, loaded last, is past the cap.
// Each place opens the study's workspace; Back returns, also after a reload; the
// overflow kind stays in the Workspaces menu and STUDIES; the New Project dialog and
// Home's button (one Create click, one project on a double click, none on Cancel or
// Escape); a create the server refuses; the empty project's buttons during an import;
// and nothing at all while the plugins are off, back after Enable without a reload.
// Then the edges: Home's header and the dialog with the longest texts and most actions
// the manifest allows, the dialog while the plugins are still being read, Home after a
// failed read, a double click on a start button, and a start action finishing after the
// user went elsewhere.
const PROJECT = NO_GEOMETRY_PROJECT;
const DEMO = 'start-demo';
const TWO = 'start-demo-2';

function stage(t0, msg) {
  console.log(`[start-actions +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

// One server for the file (the suite runs one worker, in file order); each test makes or
// names its own projects, so a test that fails leaves the next ones a fresh server.
let host;
let t0 = 0;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  t0 = Date.now();
  const tmp = e2eTemp('start-actions');
  const projects = join(tmp, 'projects');
  prepareE2eProjectsRoot(projects);
  const bundled = join(tmp, 'bundled');
  cpSync(resolve('bundled-plugins/incompressible_flow'), join(bundled, 'incompressible_flow'), {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(src),
  });
  host = await startHost({ name: 'start-actions', tmp, projects, bundledDir: bundled, pluginsFrom: 'python/tests/fixtures/start-plugins' });
  stage(t0, `server up at ${host.base}`);
});

test.afterAll(() => {
  host?.stop();
});

async function setPlugin(request, key, on) {
  const r = await request.post(`${host.base}/api/plugins/${key}/${on ? 'enable' : 'disable'}`);
  expect(r.ok(), await r.text()).toBe(true);
  await request.post(`${host.base}/api/worker`, { data: { method: 'registry.reload', params: {} } });
}

async function openProject(page, pid) {
  await page.goto(`${host.base}/#/p/${pid}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
}

// Home, once its controller has drawn the project cards (its buttons are wired by then).
async function goHome(page) {
  await page.goto(`${host.base}/#/`);
  await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
}

async function newProject(request, title) {
  const r = await request.post(`${host.base}/api/project`, { data: { title, folder: 'My Projects', units: 'Metric', category: 'Other' } });
  const j = await r.json();
  expect(r.ok(), JSON.stringify(j)).toBe(true);
  return j.id;
}

async function projectsTitled(request, title) {
  const j = await (await request.get(`${host.base}/api/projects`)).json();
  return (j.projects || []).filter((p) => p.title === title);
}

const headerButtons = (page) => page.locator('#ws-start-host [data-start-header] > button');
const header = (page, key) => page.locator(`#ws-start-host [data-start-header="${key}"] > button`);
const overlay = (page) => page.locator('#workspace-overlay');
const frameTitle = (page) => page.frameLocator('#workspace-frame').locator('#start-title');
const studiesSection = (page) => page.locator('#plugin-studies-section');
const notice = (page) => page.locator('#modal-confirm');

async function back(page, pid) {
  await overlay(page).locator('[data-ws-back]').click();
  await expect(overlay(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}$`));
}

test('gate:l1-places in a project: header buttons in load order, the overflow in Workspaces and STUDIES, the empty project, the ignored place @plugins', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await openProject(page, PROJECT);
  // Header: start-demo's header_label, then start-demo-2's workspace titles; Gamma is cut.
  await expect(headerButtons(page)).toHaveText(['Demo', 'Alpha bench', 'Beta bench']);
  await expect(header(page, `${DEMO}:demo`)).toHaveAttribute('title', 'Demo: open one or start a new one (Start demo)');
  await expect(header(page, `${DEMO}:demo`)).toHaveAttribute('aria-haspopup', 'menu');
  // The Workspaces menu keeps the kinds that are not header buttons: Note (no action) and Gamma (cut).
  await page.locator('#btn-workspaces').click();
  await expect(page.locator('#ws-menu-host [data-ws-new]')).toHaveCount(2);
  await expect(page.locator(`[data-ws-new="${DEMO}:note"]`)).toContainText('New Note');
  await expect(page.locator(`[data-ws-new="${TWO}:gamma"]`)).toContainText('New Gamma');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ws-menu-host [role="menu"]')).toHaveCount(0);
  // So STUDIES shows, with "+ New" for every kind.
  await expect(studiesSection(page)).toBeVisible();
  await expect(studiesSection(page).locator('[data-plugin-study-new]')).toHaveCount(5);
  // The empty project: Demo, Alpha and Gamma under Add geometry, with Demo's hint.
  const empty = page.locator('#wb-empty-start [data-start-empty]');
  await expect(empty).toHaveText(['Design a demo', 'Start an alpha', 'Start a gamma']);
  await expect(page.locator('#wb-empty-start')).toContainText('Make a demo here, then simulate it');
  await expect(page.locator('#btn-add-geometry')).toBeVisible();
  // For review: the header and the empty project as drawn (test-results/).
  await page.locator('#top-header').screenshot({ path: testInfo.outputPath('header.png') });
  await page.screenshot({ path: testInfo.outputPath('empty-project.png') });
  stage(t0, 'project places drawn');

  // "toolbar" is ignored: start-demo-2 is on, and its Settings row says why.
  await page.locator('#wb-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  const row = wizard.locator(`[data-plugin-key="${TWO}"]`);
  await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
  await expect(row).toContainText("manifest [[start_actions]]: place 'toolbar' is not known to this app; ignored");
  await expect(wizard.locator(`[data-plugin-key="${DEMO}"]`)).not.toContainText('not known to this app');
  await page.locator('#wiz-next').click();
  await expect(wizard).toBeHidden();
});

test('gate:l1-places each place in a project opens the workspace, Back returns, also after a reload; the header menu works by keyboard @plugins', async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await openProject(page, PROJECT);
  // The empty project's button: "Demo 1", no name asked.
  await page.locator(`[data-start-empty="${DEMO}:demo"]`).click();
  await expect(overlay(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}/ws/${DEMO}/demo/st-[a-z0-9-]+$`));
  await expect(frameTitle(page)).toHaveText('Demo 1');
  await expect(page.locator('#modal-prompt')).toBeHidden();
  // The header button reads its header_label; the crumb keeps the plugin's name and the study.
  await expect(overlay(page).locator('[data-ws-crumb]')).toHaveText(/Start demo\s*›\s*Demo 1/);
  await back(page, PROJECT);
  await expect(studiesSection(page).locator('[data-plugin-study] .tl')).toHaveText(['Demo 1']);

  // The header's Alpha menu by keyboard: no study yet, then "New Alpha" (Down opens on it).
  const alpha = header(page, `${TWO}:alpha`);
  await alpha.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.locator(`#ws-start-host [data-start-header="${TWO}:alpha"] [role="menu"]`);
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-start-none]')).toHaveText('No Alpha yet');
  await expect(menu.locator('[role="menuitem"]:focus')).toHaveText('New Alpha');
  // Escape closes it and the button has the focus again.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu.locator('[role="menuitem"]:focus')).toHaveText('New Alpha');
  await page.keyboard.press('Enter');
  await expect(overlay(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}/ws/${TWO}/alpha/st-[a-z0-9-]+$`));
  await expect(frameTitle(page)).toHaveText('Alpha 1');
  // A reload keeps the workspace open on the same study; Back returns to the project.
  const alphaUrl = page.url();
  await page.reload();
  await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
  await expect(frameTitle(page)).toHaveText('Alpha 1', { timeout: 60_000 });
  expect(page.url()).toBe(alphaUrl);
  await back(page, PROJECT);
  stage(t0, 'empty project and header create and open');

  // The Demo menu lists Demo 1 first; Home/End move; Enter opens the study.
  const demo = header(page, `${DEMO}:demo`);
  await demo.focus();
  await page.keyboard.press('Space');
  const demoMenu = page.locator(`#ws-start-host [data-start-header="${DEMO}:demo"] [role="menu"]`);
  await expect(demoMenu.locator('[role="menuitem"]')).toHaveText(['Demo 1', 'New Demo']);
  await expect(demoMenu.locator('[role="menuitem"]:focus')).toHaveText('Demo 1');
  await page.keyboard.press('End');
  await expect(demoMenu.locator('[role="menuitem"]:focus')).toHaveText('New Demo');
  await page.keyboard.press('Home');
  await expect(demoMenu.locator('[role="menuitem"]:focus')).toHaveText('Demo 1');
  await page.keyboard.press('ArrowUp');
  await expect(demoMenu.locator('[role="menuitem"]:focus')).toHaveText('New Demo');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(overlay(page)).toBeVisible();
  await expect(frameTitle(page)).toHaveText('Demo 1');
  await back(page, PROJECT);
  // Tab closes the menu.
  await demo.focus();
  await page.keyboard.press('ArrowDown');
  await expect(demoMenu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(demoMenu).toHaveCount(0);
  // After a reload of the project the places are the same.
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await expect(headerButtons(page)).toHaveText(['Demo', 'Alpha bench', 'Beta bench']);
  await expect(studiesSection(page).locator('[data-plugin-study] .tl')).toHaveText(['Demo 1', 'Alpha 1']);
});

test('gate:l1-places STUDIES stays hidden while every kind is a header button and no study exists (D3), also after a reload @plugins', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // Only start-demo-2: its three kinds are all header buttons.
  await setPlugin(request, DEMO, false);
  try {
    const pid = await newProject(request, 'Studies rule');
    await openProject(page, pid);
    await expect(headerButtons(page)).toHaveText(['Alpha bench', 'Beta bench', 'Gamma bench']);
    await expect(page.locator('#btn-workspaces')).toHaveCount(0);
    await expect(studiesSection(page)).toBeHidden();
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await expect(headerButtons(page)).toHaveCount(3);
    await expect(studiesSection(page)).toBeHidden();
    // A study made from the header: STUDIES shows it, and still after a reload.
    await header(page, `${TWO}:gamma`).click();
    await page.locator(`[data-start-new="${TWO}:gamma"]`).click();
    await expect(frameTitle(page)).toHaveText('Gamma 1');
    await back(page, pid);
    await expect(studiesSection(page)).toBeVisible();
    await expect(studiesSection(page).locator('[data-plugin-study] .tl')).toHaveText(['Gamma 1']);
    await page.reload();
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
    await expect(studiesSection(page)).toBeVisible();
  } finally {
    await setPlugin(request, DEMO, true);
  }
});

test('gate:l1-places New Project: Start from in create mode (one project, one study, its workspace), hidden in edit mode @plugins', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await goHome(page);
  await page.locator('#home-new-project').click();
  const modal = page.locator('#modal-new-project');
  await expect(modal).toBeVisible();
  const start = page.locator('#np-start');
  await expect(start).toBeVisible();
  await expect(start.locator('legend')).toHaveText('Start from');
  // Import geometry (the default), then every new_project action: Demo, Alpha, Beta (not Gamma).
  await expect(start.locator('.np-start-label')).toHaveText(['Import geometry', 'Design a demo', 'Start an alpha', 'Start a beta']);
  await expect(page.locator('#np-start-import')).toBeChecked();
  await expect(start).toContainText('Make a demo here, then simulate it');
  await page.locator('#modal-new-project .cfd-modal-card').screenshot({ path: test.info().outputPath('new-project.png') });
  // Plain New project: the title is not filled in.
  await expect(page.locator('#np-title')).toHaveValue('');
  await start.locator('label', { hasText: 'Start a beta' }).click();
  await page.locator('#np-title').fill('From the dialog');
  await page.locator('#np-create').click();
  await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/ws/${TWO}/beta/st-[a-z0-9-]+$`));
  await expect(frameTitle(page)).toHaveText('Beta 1', { timeout: 60_000 });
  const pid = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  expect(await projectsTitled(request, 'From the dialog')).toHaveLength(1);
  await back(page, pid);
  await expect(page.locator('.project-name')).toHaveText('From the dialog');
  stage(t0, 'New Project with a start action');

  // Import geometry: the empty project, as before.
  await goHome(page);
  await page.locator('#home-new-project').click();
  await page.locator('#np-title').fill('Plain one');
  await page.locator('#np-create').click();
  await expect(page).toHaveURL(/#\/p\/[^/]+$/, { timeout: 60_000 });
  await expect(page.locator('#btn-add-geometry')).toBeVisible({ timeout: 60_000 });
  await expect(overlay(page)).toBeHidden();

  // Edit mode has no Start from.
  await goHome(page);
  await page.locator(`#home-grid [data-project-id="${pid}"]`).click();
  await page.locator('#home-edit-project').click();
  await expect(modal).toBeVisible();
  await expect(page.locator('#np-heading')).toHaveText('Edit project');
  await expect(start).toBeHidden();
  await page.locator('#np-cancel').click();
  await expect(modal).toBeHidden();
});

test("gate:l1-places Home's button opens New Project with its action chosen: one Create click, one project on a double click, none on Cancel or Escape @plugins", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await goHome(page);
  const homeButtons = page.locator('#home-start-host [data-home-start]');
  // home_label for Demo, else the label; at most three.
  await expect(homeButtons).toHaveText(['New demo', 'Start an alpha', 'Start a gamma']);
  await page.locator('.home-top').screenshot({ path: test.info().outputPath('home-header.png') });
  const modal = page.locator('#modal-new-project');
  const title = page.locator('#np-title');
  const openFromHome = async () => {
    await page.locator(`[data-home-start="${DEMO}:demo"]`).click();
    await expect(modal).toBeVisible();
  };
  await openFromHome();
  await expect(page.locator('#np-start input[value="start-demo:demo"]')).toBeChecked();
  await expect(title).toHaveValue('Untitled Demo 1');
  await expect(title).toBeFocused();
  expect(await title.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'Untitled Demo 1'.length]);
  await expect(page.locator('#np-folder')).toHaveValue('My Projects');
  // Cancel and Escape make nothing.
  await page.locator('#np-cancel').click();
  await expect(modal).toBeHidden();
  await openFromHome();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  // Typing replaces the title filled in.
  await openFromHome();
  await page.keyboard.type('Typed over');
  await expect(title).toHaveValue('Typed over');
  await page.locator('#np-cancel').click();
  expect(await projectsTitled(request, 'Untitled Demo 1')).toHaveLength(0);
  expect(await projectsTitled(request, 'Typed over')).toHaveLength(0);
  stage(t0, 'Home dialog: cancel, Escape, typing');

  // A double click on Create makes one project; it opens on its Demo workspace. The two
  // clicks land in one task, before the first one's work has closed the dialog (a real
  // double click on a slow machine; Playwright's dblclick lets the dialog close between them).
  await openFromHome();
  await page.locator('#np-create').evaluate((b) => {
    b.click();
    b.click();
  });
  await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/ws/${DEMO}/demo/st-[a-z0-9-]+$`));
  await expect(frameTitle(page)).toHaveText('Demo 1', { timeout: 60_000 });
  const pid = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await back(page, pid);
  await goHome(page);
  await page.reload();
  await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#home-grid .home-card-title', { hasText: /^Untitled Demo 1$/ })).toHaveCount(1);
  expect(await projectsTitled(request, 'Untitled Demo 1')).toHaveLength(1);
  // The next one is "Untitled Demo 2", and one Create click is enough.
  await openFromHome();
  await expect(title).toHaveValue('Untitled Demo 2');
  await page.locator('#np-create').click();
  await expect(frameTitle(page)).toHaveText('Demo 1', { timeout: 60_000 });
  expect(await projectsTitled(request, 'Untitled Demo 2')).toHaveLength(1);
  stage(t0, 'Home dialog: one click, double click');
});

test('gate:l1-places a create the server refuses says so and the project stays open, from the header and from New Project @plugins', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await openProject(page, PROJECT);
  await expect(header(page, `${DEMO}:demo`)).toBeVisible();
  // Turned off on the server after the page drew its buttons.
  await setPlugin(request, DEMO, false);
  try {
    await header(page, `${DEMO}:demo`).click();
    await page.locator(`[data-start-new="${DEMO}:demo"]`).click();
    await expect(notice(page)).toBeVisible();
    await expect(notice(page).locator('#cf-heading')).toHaveText('Could not create the study');
    await expect(page).toHaveURL(new RegExp(`#/p/${PROJECT}$`));
    await expect(overlay(page)).toBeHidden();
    await expect(header(page, `${DEMO}:demo`)).toBeDisabled();
    await notice(page).locator('#cf-confirm').click();
    await expect(notice(page)).toBeHidden();
    stage(t0, 'refused from the header');
  } finally {
    await setPlugin(request, DEMO, true);
  }

  // New Project: the dialog drew the radio while the plugin was on.
  await goHome(page);
  await page.reload();
  await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
  await page.locator('#home-new-project').click();
  await page.locator('#np-start label', { hasText: 'Design a demo' }).click();
  await page.locator('#np-title').fill('Refused study');
  await setPlugin(request, DEMO, false);
  try {
    await page.locator('#np-create').click();
    await expect(notice(page).locator('#cf-heading')).toHaveText('Could not create the study', { timeout: 60_000 });
    // The project was made and is open, with no workspace.
    await expect(page).toHaveURL(/#\/p\/[^/]+$/);
    await expect(page.locator('.project-name')).toHaveText('Refused study');
    await expect(overlay(page)).toBeHidden();
    await notice(page).locator('#cf-confirm').click();
    expect(await projectsTitled(request, 'Refused study')).toHaveLength(1);
  } finally {
    await setPlugin(request, DEMO, true);
  }
});

test("gate:l1-places the empty project's start buttons are disabled while a geometry import runs @plugins", async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const pid = await newProject(request, 'Import wait');
  await openProject(page, pid);
  const demo = page.locator(`[data-start-empty="${DEMO}:demo"]`);
  await expect(demo).toBeEnabled();
  // Hold the import on its way to the server, then let it fail.
  let release = () => undefined;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/geometry/import**', async (route) => {
    await held;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'held by the test' }) });
  });
  await page.locator('#geometry-file-input').setInputFiles(resolve('python/tests/fixtures/elbow.step'));
  await expect(page.locator('#btn-add-geometry')).toBeDisabled();
  await expect(demo).toBeDisabled();
  // Only the start buttons fade; Add geometry looks as it always did while importing.
  await expect(demo).toHaveCSS('opacity', '0.6');
  await expect(page.locator('#btn-add-geometry')).toHaveCSS('opacity', '1');
  await expect(page.locator('#wb-empty-start [data-start-empty]')).toHaveCount(3);
  for (const b of await page.locator('#wb-empty-start [data-start-empty]').all()) await expect(b).toBeDisabled();
  release();
  await expect(notice(page).locator('#cf-heading')).toHaveText(/Could not import/);
  await notice(page).locator('#cf-confirm').click();
  await expect(demo).toBeEnabled();
  await expect(page.locator('#btn-add-geometry')).toBeEnabled();
  await page.unroute('**/api/geometry/import**');
});

test('gate:l1-places with the plugins off nothing shows in the four places; after Enable they return without a reload @plugins', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  await setPlugin(request, DEMO, false);
  await setPlugin(request, TWO, false);
  await openProject(page, PROJECT);
  await expect(page.locator('#btn-workspaces')).toHaveCount(0);
  await expect(page.locator('#ws-start-host [data-start-header]')).toHaveCount(0);
  await expect(page.locator('#wb-empty-start [data-start-empty]')).toHaveCount(0);
  await expect(page.locator('#btn-add-geometry')).toBeVisible();
  await goHome(page);
  await expect(page.locator('#home-start-host [data-home-start]')).toHaveCount(0);
  await page.locator('#home-new-project').click();
  await expect(page.locator('#modal-new-project')).toBeVisible();
  await expect(page.locator('#np-start')).toBeHidden();
  await page.locator('#np-cancel').click();
  stage(t0, 'off: nothing shows');

  // Turned on in Settings → Plugins (no reload): Home, then the project, have them again.
  await page.locator('#home-prefs').click();
  const wizard = page.locator('#setup-wizard');
  await wizard.locator('#wiz-rail li', { hasText: 'Plugins' }).click();
  for (const key of [DEMO, TWO]) {
    const row = wizard.locator(`[data-plugin-key="${key}"]`);
    await expect(row).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 });
    await row.locator(`[data-plugin-toggle="${key}"]`).click();
    await expect(row).toHaveAttribute('data-plugin-status', 'enabled', { timeout: 30_000 });
  }
  await page.locator('#wiz-next').click();
  await expect(wizard).toBeHidden();
  await expect(page.locator('#home-start-host [data-home-start]')).toHaveText(['New demo', 'Start an alpha', 'Start a gamma']);
  await page.locator('#home-new-project').click();
  await expect(page.locator('#np-start')).toBeVisible();
  await expect(page.locator('#np-start .np-start-label')).toHaveCount(4);
  await page.locator('#np-cancel').click();
  await page.evaluate((pid) => window.__CFD_HOME__.open(pid, { reloadIfNeeded: false }), PROJECT);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PROJECT, { timeout: 60_000 });
  await expect(headerButtons(page)).toHaveText(['Demo', 'Alpha bench', 'Beta bench']);
  await expect(page.locator('#wb-empty-start [data-start-empty]')).toHaveCount(3);
  await expect(page.locator('#btn-workspaces')).toBeVisible();
});

// Home and New Project with texts and counts the manifest allows: the app's answer for
// /api/plugins is passed through with longer texts and more actions (each within the
// manifest check: labels of 40 characters, any number of new_project actions).
async function patchPlugins(page, patch) {
  await page.route('**/api/plugins', async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    patch(j.plugins || []);
    await route.fulfill({ response: res, json: j });
  });
}

// What a user sees of Home's header: nothing past the window, nothing on top of the mark.
async function homeHeaderFits(page, width) {
  const box = async (sel) => (await page.locator(sel).first().boundingBox()) || { x: 0, y: 0, width: 0, height: 0 };
  const mark = await box('.home-mark');
  const search = await box('.home-search-wrap');
  const actions = await box('.home-top-actions');
  const why = `at ${width}px: mark ${JSON.stringify(mark)} search ${JSON.stringify(search)} actions ${JSON.stringify(actions)}`;
  expect(mark.x + mark.width, why).toBeLessThanOrEqual(search.x);
  expect(search.x + search.width, why).toBeLessThanOrEqual(actions.x);
  expect(search.width, why).toBeGreaterThanOrEqual(140);
  for (const sel of ['#home-new-project', '#home-new-folder', '#home-prefs']) {
    await expect(page.locator(sel), `${sel} ${why}`).toBeInViewport({ ratio: 1 });
  }
  const top = await page.locator('.home-top').evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(top[0], why).toBeLessThanOrEqual(top[1]);
  for (const b of await page.locator('#home-start-host [data-home-start]').all()) await expect(b).toBeInViewport({ ratio: 1 });
}

test("gate:l1-places Home's header fits the window with three start buttons, at 1024 and 1280, also with 40-character labels @plugins", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const homeButtons = page.locator('#home-start-host [data-home-start]');
  // The fixtures' own labels at 1024 wide.
  await page.setViewportSize({ width: 1024, height: 768 });
  await goHome(page);
  await expect(homeButtons).toHaveText(['New demo', 'Start an alpha', 'Start a gamma']);
  await homeHeaderFits(page, 1024);
  // The longest labels the manifest allows.
  const long = ['Start a new structural analysis study ok', 'Start a new aerodynamic wing design now!', 'Begin a brand new gamma ray bench setup'];
  expect(long.map((t) => t.length <= 40)).toEqual([true, true, true]);
  await patchPlugins(page, (rows) => {
    for (const row of rows) {
      for (const a of row.start_actions || []) {
        if (a.study_kind === 'demo') a.home_label = long[0];
        if (a.study_kind === 'alpha') a.label = long[1];
        if (a.study_kind === 'gamma') a.label = long[2];
      }
    }
  });
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload();
    await expect(page.locator('#home-grid [data-project-id]').first()).toBeVisible({ timeout: 60_000 });
    await expect(homeButtons).toHaveCount(3);
    // The whole text is the tooltip, also when the button is cut short.
    const titles = await homeButtons.evaluateAll((bs) => bs.map((b) => b.getAttribute('title') || ''));
    expect(titles.map((t, i) => t.startsWith(long[i])), titles.join(' | ')).toEqual([true, true, true]);
    await homeHeaderFits(page, width);
    await page.locator('.home-top').screenshot({ path: test.info().outputPath(`home-header-long-${width}.png`) });
  }
  // A cut button still opens the dialog with its action chosen.
  await page.locator(`[data-home-start="${DEMO}:demo"]`).click();
  await expect(page.locator('#modal-new-project')).toBeVisible();
  await expect(page.locator('#np-start input[value="start-demo:demo"]')).toBeChecked();
  await page.locator('#np-cancel').click();
});

test('gate:l1-places New Project with many start actions: the list scrolls, the title and Create stay in view @plugins', async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await patchPlugins(page, (rows) => {
    const demo = rows.find((r) => r.key === DEMO);
    const base = demo.start_actions[0];
    for (let i = 1; i <= 8; i += 1) {
      demo.start_actions.push({ ...base, study_kind: `many${i}`, label: `Start many ${i}`, hint: `A hint for many ${i}, one line of plain text`, places: ['new_project'] });
    }
  });
  await goHome(page);
  await page.locator('#home-new-project').click();
  const labels = page.locator('#np-start .np-start-label');
  await expect(labels).toHaveCount(12);
  await expect(page.locator('#np-heading')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#np-title')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#np-create')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#np-cancel')).toBeInViewport({ ratio: 1 });
  await page.locator('#np-create').click({ trial: true });
  await page.locator('#modal-new-project .cfd-modal-card').screenshot({ path: test.info().outputPath('new-project-many.png') });
  // The last one is reached by scrolling the list.
  await page.locator('#np-start label', { hasText: 'Start many 8' }).click();
  await expect(page.locator('#np-start input[value="start-demo:many8"]')).toBeChecked();
  await expect(page.locator('#np-create')).toBeInViewport({ ratio: 1 });
  await page.locator('#np-cancel').click();
  await expect(page.locator('#modal-new-project')).toBeHidden();
});

test('gate:l1-places New Project opens at once while the app is still reading the plugins, and Start from fills in when it has them @plugins', async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  let release = () => undefined;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/plugins', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await goHome(page);
    const t = Date.now();
    await page.locator('#home-new-project').click();
    await expect(page.locator('#modal-new-project')).toBeVisible({ timeout: 2000 });
    expect(Date.now() - t).toBeLessThan(2000);
    await expect(page.locator('#np-title')).toBeFocused();
    await expect(page.locator('#np-start')).toBeHidden();
    await page.locator('#np-title').fill('Typed while reading');
    release();
    // The read itself can take seconds (a worker that just started loads the registry).
    await expect(page.locator('#np-start')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#np-start .np-start-label')).toHaveText(['Import geometry', 'Design a demo', 'Start an alpha', 'Start a beta']);
    await expect(page.locator('#np-start-import')).toBeChecked();
    await expect(page.locator('#np-title')).toHaveValue('Typed while reading');
    await page.locator('#np-cancel').click();
    await expect(page.locator('#home-start-host [data-home-start]')).toHaveCount(3);
  } finally {
    release();
  }
});

test("gate:l1-places Home's start buttons come back on their own after the app could not read the plugins @plugins", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  // The worker answers 503 for the first 3 s after Home asks, then normally.
  let downUntil = 0;
  await page.route('**/api/plugins', async (route) => {
    if (!downUntil) downUntil = Date.now() + 3000;
    if (Date.now() < downUntil) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'worker busy' }) });
      return;
    }
    await route.continue();
  });
  await goHome(page);
  // Nothing else asks again (no dialog, no Settings): the buttons come back by themselves.
  await expect(page.locator('#home-start-host [data-home-start]')).toHaveText(['New demo', 'Start an alpha', 'Start a gamma'], { timeout: 20_000 });
  expect(downUntil).toBeGreaterThan(0);
});

test('gate:l1-places a double click on an empty-project start button makes one study; the other buttons wait for it @plugins', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const pid = await newProject(request, 'Double start');
  await openProject(page, pid);
  const creates = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/plugin-studies/create')) creates.push(r.url());
  });
  // Hold the create, so both clicks land while the first one is out.
  let release = () => undefined;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/plugin-studies/create', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.locator(`[data-start-empty="${DEMO}:demo"]`).dblclick();
    for (const b of await page.locator('#wb-empty-start [data-start-empty]').all()) await expect(b).toBeDisabled();
    await header(page, `${TWO}:alpha`).click();
    await expect(page.locator(`[data-start-new="${TWO}:alpha"]`)).toBeDisabled();
    await page.keyboard.press('Escape');
    release();
    await expect(overlay(page)).toBeVisible({ timeout: 60_000 });
    await expect(frameTitle(page)).toHaveText('Demo 1', { timeout: 60_000 });
  } finally {
    release();
    await page.unroute('**/api/plugin-studies/create');
  }
  expect(creates).toHaveLength(1);
  await back(page, pid);
  await page.reload();
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await expect(studiesSection(page).locator('[data-plugin-study] .tl')).toHaveText(['Demo 1']);
});

test('gate:l1-places a start action does not take over when the user opened another study while it was made @plugins', async ({ page, request }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  const pid = await newProject(request, 'Went elsewhere');
  await openProject(page, pid);
  await page.locator(`[data-start-empty="${DEMO}:demo"]`).click();
  await expect(frameTitle(page)).toHaveText('Demo 1');
  await back(page, pid);
  // "New Alpha" from the header, held on its way to the server.
  let release = () => undefined;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/plugin-studies/create', async (route) => {
    await held;
    await route.continue();
  });
  try {
    await header(page, `${TWO}:alpha`).click();
    await page.locator(`[data-start-new="${TWO}:alpha"]`).click();
    // Meanwhile the user opens Demo 1 from the Demo menu.
    await header(page, `${DEMO}:demo`).click();
    await page.locator(`#ws-start-host [data-start-header="${DEMO}:demo"] [data-start-study]`).click();
    await expect(overlay(page)).toBeVisible();
    await expect(frameTitle(page)).toHaveText('Demo 1');
    const demoUrl = page.url();
    const made = page.waitForResponse((r) => r.url().includes('/api/plugin-studies/create'));
    release();
    expect((await made).ok()).toBe(true);
    // The new study is made (STUDIES lists it below), and Demo 1 stays on screen: the
    // open would follow the answer at once, so a short wait shows it did not happen.
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(demoUrl);
    await expect(frameTitle(page)).toHaveText('Demo 1');
  } finally {
    release();
    await page.unroute('**/api/plugin-studies/create');
  }
  await back(page, pid);
  await expect(studiesSection(page).locator('[data-plugin-study] .tl')).toHaveText(['Demo 1', 'Alpha 1']);
});
