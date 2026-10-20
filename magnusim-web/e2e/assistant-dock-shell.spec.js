// The Assistant's place on screen (chat dock spec, phase 4, lane C: 1.4-1.8, 2.10, 11.3-9 and
// 11.3-13): the app's toasts at the bottom left, clear of a workspace's status chips (the
// frame's bottom-left 660 x 110 px band) and of the workspace's own toast; the dock at the
// bottom right with its header buttons, Ctrl+/, Escape and the keyboard given back, its sizes in
// wide, narrow and short windows, under Settings, over a workspace (its header borrows the
// button), the toasts clear of it, and the states it shows by itself (Off here; over remote
// access only the remote sentence, with no stream of the Assistant's opened).
// Its own server with the Assistant's test switches (a test home, never this PC's keys) and the
// ai-demo test plugin (python/tests/fixtures/assistant-plugins) for a workspace. Rect checks
// allow 2 px (fonts differ under Linux); no pixel snapshots.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appReady, noAgentsHere } from './support/assistant.js';
import { e2eTemp, startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
/** The frame's bottom-left band its own chips use (CAD's .cad-dock: 16 px up, about 36 px a chip). */
const CHIP_BAND = 136;
/** Font metrics differ under the Linux mirror's fonts. */
const SLACK = 2;
const REMOTE_TEXT =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';
const OFF_TEXT = 'The Assistant is off. Choose a provider in Settings → Assistant.';

let host;
let project;
let study;

const api = (path) => `${host.base}${path}`;

async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  const tmp = e2eTemp('assistant-dock-shell');
  host = await startHost({
    name: 'assistant-dock-shell',
    tmp,
    pluginsFrom: 'python/tests/fixtures/assistant-plugins',
    env: { MAGNUSIM_TEST_ASSISTANT: '1', ...noAgentsHere(tmp) },
  });
  project = (await postOk(request, '/api/project', { title: 'Dock project', folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
});

test.afterAll(async () => {
  if (host) host.stop();
});

/** An app toast, as an in-page plugin's pluginUi.toast sends it. */
async function appToast(page, message) {
  await page.evaluate((m) => window.dispatchEvent(new CustomEvent('cfd:toast', { detail: { message: m } })), message);
  const toast = page.locator('.app-toasts .mgk-toast').filter({ hasText: message });
  await expect(toast).toBeVisible();
  return toast;
}

/** A locator's rect in the page, or fails. */
async function rect(locator) {
  const box = await locator.boundingBox();
  expect(box, 'it is on screen').not.toBeNull();
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function openWorkspace(page) {
  await page.goto(`${host.base}/#/p/${project}/ws/${PLUGIN}/counter/${study}`);
  await expect(page.locator('#workspace-overlay .ws-shell[data-workspace-connected="1"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.frameLocator('#workspace-frame').locator('#counter')).toHaveText('0', { timeout: 60_000 });
  const frame = page.frames().find((f) => f.url().includes(`/plugins/${PLUGIN}/workspace/`));
  expect(frame, 'the workspace page').toBeTruthy();
  return frame;
}

test.describe('toasts', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('an app toast shows at the bottom left', async ({ page }) => {
    await page.goto(`${host.base}/#/`);
    await appReady(page);
    // Away from where the toast draws: a still pointer over it would hold it.
    await page.mouse.move(640, 10);
    const r = await rect(await appToast(page, 'Saved the polar'));
    const vp = page.viewportSize();
    expect(r.left, 'the left edge').toBeLessThanOrEqual(16 + 1);
    expect(r.left).toBeGreaterThanOrEqual(16 - 1);
    expect(Math.abs(vp.height - r.bottom - 16), `16 px from the bottom (${vp.height - r.bottom})`).toBeLessThanOrEqual(SLACK);
    expect(r.right, 'in the left half').toBeLessThan(vp.width / 2);
  });

  test("in a workspace, app toasts sit above its chips' band and above the workspace's own toast", async ({ page }) => {
    const frame = await openWorkspace(page);
    await page.mouse.move(640, 10);
    const vp = page.viewportSize();

    // No page toast: the app toast's bottom is 136 px up, clear of the frame's 660 x 110 band.
    const first = await rect(await appToast(page, 'App over workspace'));
    expect(first.left).toBeLessThanOrEqual(16 + 1);
    expect(vp.height - first.bottom, 'above the chips band').toBeGreaterThanOrEqual(CHIP_BAND - SLACK);
    expect(vp.height - first.bottom).toBeLessThanOrEqual(CHIP_BAND + SLACK);
    const band = { left: 0, top: vp.height - 110, right: 660, bottom: vp.height };
    expect(overlap(first, band), 'the toast is clear of the band').toBe(false);
    await page.locator('.app-toasts .mgk-toast-close').click();
    await expect(page.locator('.app-toasts .mgk-toast')).toHaveCount(0);
    await page.mouse.move(640, 10);

    // The page's own toast sits there too (bottom left, 136 px up); an app toast goes above it.
    await frame.evaluate(() => window.__ws.ui.toast('From the page'));
    const wsToast = page.locator('#workspace-overlay [data-ws-toast]');
    await expect(wsToast).toBeVisible();
    const ws = await rect(wsToast);
    expect(ws.left).toBeLessThanOrEqual(16 + 1);
    expect(vp.height - ws.bottom, 'the page toast is above the band').toBeGreaterThanOrEqual(CHIP_BAND - SLACK);
    const reserve = await page.evaluate(() => document.body.style.getPropertyValue('--ws-toast-reserve'));
    expect(reserve, 'the page toast height + 8').toBe(`${Math.ceil(ws.bottom - ws.top) + 8}px`);
    const second = await rect(await appToast(page, 'App over the page toast'));
    expect(overlap(second, ws), 'the two toasts do not overlap').toBe(false);
    expect(ws.top - second.bottom, '8 px between them').toBeGreaterThanOrEqual(8 - SLACK);
    expect(overlap(second, band)).toBe(false);

    // The page toast closes: the room it held goes.
    await wsToast.locator('.mgk-toast-close').click();
    await expect(wsToast).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--ws-toast-reserve'))).toBe('');
  });
});

const dock = (page) => page.locator('#assistant-dock');

/** Whether nothing draws over the middle of `locator` (it is on top there). */
const onTop = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });

async function openFromHome(page) {
  await page.goto(`${host.base}/#/`);
  await appReady(page);
  await page.locator('#home-assistant').click();
  await expect(dock(page)).toBeVisible();
  await expect(dock(page)).toHaveAttribute('data-assistant-dock-state', 'off');
}

test.describe('the dock', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("Home's button opens it bottom right, Off with Open Settings; Escape and Ctrl+/ close it and give the keyboard back", async ({ page }) => {
    await page.goto(`${host.base}/#/`);
    await appReady(page);
    const button = page.locator('#home-assistant');
    // Before Settings, in Home's header.
    await expect(page.locator('.home-top-actions > button').first()).toHaveId('home-assistant');
    await expect(page.locator('#home-assistant + #home-prefs')).toHaveCount(1);
    await expect(button).toHaveText('Assistant');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(dock(page)).toBeHidden();
    await expect(page.locator('[data-assistant-pill]')).toBeHidden();

    await button.click();
    await expect(dock(page)).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(dock(page)).toHaveAttribute('data-dock-size', 'open');
    await expect(dock(page)).toHaveAttribute('data-assistant-dock-state', 'off');
    await expect(dock(page).locator('.assistant-dock-note')).toHaveText(OFF_TEXT);
    const settings = dock(page).getByRole('button', { name: 'Open Settings' });
    await expect(settings).toBeFocused();
    await expect(dock(page).getByRole('heading', { name: 'Assistant' })).toBeVisible();
    await expect(dock(page).getByRole('button', { name: 'Assistant settings' })).toBeVisible();
    await expect(dock(page).getByRole('button', { name: 'Close the Assistant' })).toBeVisible();

    // 400 x min(640, vh - 76) at 16 px from the bottom right, outside #app and on top.
    const vp = page.viewportSize();
    const r = await rect(dock(page));
    expect(Math.abs(vp.width - r.right - 16)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(vp.height - r.bottom - 16)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(r.right - r.left - 400)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(r.bottom - r.top - Math.min(640, vp.height - 76))).toBeLessThanOrEqual(SLACK);
    expect(await page.evaluate(() => document.getElementById('assistant-dock').closest('#app, #home'))).toBeNull();
    expect(await page.evaluate(() => document.getElementById('assistant-dock-root').parentElement === document.body)).toBe(true);
    expect(await onTop(dock(page))).toBe(true);

    // Escape inside closes it; the keyboard goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dock(page)).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    // Ctrl+/ from the search field opens it with the keyboard in it, and again closes it, back to the field.
    await page.locator('#home-search').focus();
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeVisible();
    await expect(settings).toBeFocused();
    await page.locator('#home-search').focus();
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeVisible();
    await expect(settings).toBeFocused();
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeHidden();
    await expect(page.locator('#home-search')).toBeFocused();
  });

  test('Settings covers it and Ctrl+/ waits while Settings shows; it stays open from Home to a project', async ({ page }) => {
    await openFromHome(page);
    await dock(page).getByRole('button', { name: 'Open Settings' }).click();
    const wizard = page.locator('#setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard.locator('#wiz-rail li.is-on')).toHaveText('Assistant');
    expect(await onTop(dock(page)), 'Settings is in front of the dock').toBe(false);
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeVisible();
    await page.locator('#wiz-skip').click();
    await expect(wizard).toBeHidden();
    expect(await onTop(dock(page))).toBe(true);

    await page.goto(`${host.base}/#/p/${project}`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 60_000 });
    await expect(dock(page)).toBeVisible();
    // Between Queue and Settings in the workbench header.
    await expect(page.locator('#top-header .top-right #queue-menu + #wb-assistant + #wb-prefs')).toHaveCount(1);
    await expect(page.locator('#wb-assistant')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#wb-assistant').click();
    await expect(dock(page)).toBeHidden();
    await expect(page.locator('#wb-assistant')).toHaveAttribute('aria-expanded', 'false');
  });

  test("over a workspace: the header's button opens it on top of the frame, and closing gives the keyboard back to it", async ({ page }) => {
    await openWorkspace(page);
    const button = page.locator('#workspace-overlay .ws-header-right #wb-assistant');
    await expect(page.locator('#workspace-overlay .ws-header-right #queue-menu + #wb-assistant + #wb-prefs')).toHaveCount(1);
    await button.click();
    await expect(dock(page)).toBeVisible();
    expect(await onTop(dock(page)), 'the dock is over the workspace').toBe(true);
    expect(await dock(page).evaluate((el) => !!el.closest('[inert]'))).toBe(false);
    await dock(page).getByRole('button', { name: 'Close the Assistant' }).click();
    await expect(dock(page)).toBeHidden();
    await expect(button).toBeFocused();
    // Back to the project: the button goes home to the workbench header.
    await page.locator('#workspace-overlay [data-ws-back]').click();
    await expect(page.locator('#workspace-overlay')).toBeHidden();
    await expect(page.locator('#top-header .top-right #queue-menu + #wb-assistant + #wb-prefs')).toHaveCount(1);
  });

  test('in a workspace: its page is docked, and Ctrl+/ typed in its frame opens the dock; typed in the dock, it closes and gives the frame the keyboard back', async ({ page }) => {
    await openWorkspace(page);
    const ws = page.frameLocator('#workspace-frame');
    await expect(ws.locator('#docked')).toHaveText('yes');
    await ws.locator('#counter').click();
    await expect(page.locator('#workspace-frame')).toBeFocused();
    // The key never reaches the app's page: the frame's SDK sends it as assistant.dock.
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#assistant-dock'))).toBe(true);
    await page.keyboard.press('Control+Slash');
    await expect(dock(page)).toBeHidden();
    await expect(page.locator('#workspace-frame')).toBeFocused();
  });

  test('with the dock open, a toast and the dock do not overlap, down to 720 px wide', async ({ page }) => {
    await openFromHome(page);
    for (const width of [1280, 760, 720]) {
      await page.setViewportSize({ width, height: 800 });
      await page.mouse.move(width / 2, 5);
      const t = await rect(await appToast(page, `A long message beside the dock at ${width} px wide, which wraps when it must`));
      expect(overlap(t, await rect(dock(page))), `at ${width} px`).toBe(false);
      expect(t.left).toBeLessThanOrEqual(16 + 1);
      await page.locator('.app-toasts .mgk-toast-close').first().click();
      await expect(page.locator('.app-toasts .mgk-toast')).toHaveCount(0);
    }
  });

  test('the pill: a toast keeps clear of it, beside it or above it in a narrow window', async ({ page }) => {
    await page.goto(`${host.base}/#/`);
    await appReady(page);
    const pill = page.locator('[data-assistant-pill]');
    // The pill as a running request shows it (the dock's store, as the app's own module).
    await page.evaluate(() =>
      import('/src/assistant/dock/dockState.ts').then((m) =>
        m.setDockPill({ kind: 'running', text: 'Assistant · Working: Extrude the sketch · 3 of 120 steps', onStop: () => undefined }),
      ),
    );
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('data-pill', 'running');
    await expect(page.locator('#home-assistant')).toHaveAttribute('data-assistant-badge', 'working');
    await expect(pill.getByRole('button', { name: 'Stop the Assistant' })).toBeVisible();
    for (const width of [760, 600]) {
      await page.setViewportSize({ width, height: 800 });
      await page.mouse.move(width / 2, 5);
      const t = await rect(await appToast(page, `A long message while the pill shows at ${width} px, which wraps when it must`));
      expect(overlap(t, await rect(pill)), `at ${width} px`).toBe(false);
      await page.locator('.app-toasts .mgk-toast-close').first().click();
      await expect(page.locator('.app-toasts .mgk-toast')).toHaveCount(0);
    }
    // Its words open the dock; the pill goes while it is open.
    await pill.getByRole('button', { name: /^Assistant · Working/ }).click();
    await expect(dock(page)).toBeVisible();
    await expect(pill).toBeHidden();
    await page.evaluate(() => import('/src/assistant/dock/dockState.ts').then((m) => m.setDockPill(null)));
  });

  test("a narrow window over a workspace: the page's toast and the app's go above the open sheet", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    const frame = await openWorkspace(page);
    await page.locator('#workspace-overlay #wb-assistant').click();
    await expect(dock(page)).toBeVisible();
    await page.mouse.move(300, 5);
    await frame.evaluate(() => window.__ws.ui.toast('From the page'));
    const wsToast = page.locator('#workspace-overlay [data-ws-toast]');
    await expect(wsToast).toBeVisible();
    const sheet = await rect(dock(page));
    const ws = await rect(wsToast);
    expect(ws.bottom, "the page's toast is above the sheet").toBeLessThanOrEqual(sheet.top);
    expect(await onTop(wsToast)).toBe(true);
    const app = await rect(await appToast(page, 'App toast above both'));
    expect(overlap(app, ws)).toBe(false);
    expect(app.bottom).toBeLessThanOrEqual(ws.top);
  });

  test('a narrow window: a bottom sheet with the toasts above it; a short one: the full height under the header', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await openFromHome(page);
    let vp = page.viewportSize();
    let r = await rect(dock(page));
    expect(Math.abs(r.left - 8)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(vp.width - r.right - 8)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(vp.height - r.bottom - 8)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(r.bottom - r.top - Math.min(0.7 * vp.height, vp.height - 60))).toBeLessThanOrEqual(SLACK);
    await expect(page.locator('#home-assistant')).toHaveText('Assistant');
    await page.mouse.move(300, 5);
    const t = await rect(await appToast(page, 'Saved above the sheet'));
    expect(overlap(t, r), 'the toast is above the sheet').toBe(false);
    expect(t.bottom).toBeLessThanOrEqual(r.top);

    await page.setViewportSize({ width: 1000, height: 480 });
    vp = page.viewportSize();
    r = await rect(dock(page));
    expect(Math.abs(r.top - (44 + 8))).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(vp.height - r.bottom - 8)).toBeLessThanOrEqual(SLACK);
  });

  test('over remote access it says only that it is off there, and opens no stream of its own', async ({ browser }) => {
    // Every request of this browser comes through a proxy, as over the public tunnel.
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.9' }, viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const streams = [];
      page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/api/assistant/events') || (url.includes('/api/events/subscribe') && /"kind"\s*:\s*"assistant"/.test(req.postData() || ''))) streams.push(url);
      });
      await page.goto(`${host.base}/#/`);
      await appReady(page);
      await page.locator('#home-assistant').click();
      await expect(dock(page)).toHaveAttribute('data-assistant-dock-state', 'remote');
      await expect(dock(page).locator('[data-dock-remote]')).toHaveText(REMOTE_TEXT);
      await expect(dock(page).locator('textarea, [role="log"], [role="listbox"], .assistant-dock-composer')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dock(page)).toBeHidden();
      expect(streams, 'no stream of the Assistant').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
