// The Assistant's place on screen (chat dock spec, phase 4, lane C: 1.4-1.8, 2.10, 11.3-9 and
// 11.3-13): the app's toasts at the bottom left, clear of a workspace's status chips (the
// frame's bottom-left 660 x 110 px band) and of the workspace's own toast.
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
