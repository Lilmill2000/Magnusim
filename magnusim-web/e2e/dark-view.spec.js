// The 3D view in the dark theme (Daniel, 2026-10-27): its background, lines, edges, points and
// labels turn dark-theme colours, the model's surfaces stay light, and what the person keeps (a
// capture) stays light. The theme is set as Settings → Appearance sets it (applyAppearance).
import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

const FIXTURE = 'sample-project-steady-state-e2e';
const LIGHT_BG = [240, 242, 247];
const DARK_BG = [27, 31, 39];
let host;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  host = await startHost({ name: 'dark-view' });
});

test.afterAll(() => {
  if (host) host.stop();
});

async function setTheme(page, theme) {
  await page.evaluate(async (t) => {
    const { applyAppearance } = await import('/src/theme/appearance.ts');
    applyAppearance({ theme: t || 'light', text_scale: 1, icon_scale: 1 });
  }, theme);
}

const colors = (page) => page.evaluate(() => window.__CFD_THEME__.viewColors());
const near = (a, b) => !!a && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= 2);

test('the 3D view follows the theme: dark background, light lines and points, mid-grey CAD edges; a capture stays light; back to light as it was', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const chip = document.getElementById('viewport-job-chip');
    return !chip || chip.hidden;
  }, null, { timeout: 180_000 });

  const light = await colors(page);
  expect(light.bg).toEqual(LIGHT_BG);
  expect(light.edge).toEqual([10, 11, 14]);
  expect(light.ink).toEqual([20, 26, 41]);
  expect(light.pin).toEqual([192, 38, 211]);
  expect(near(await page.evaluate(() => window.__CFD_THEME__.screenPixel(10, 10)), LIGHT_BG)).toBe(true);

  await setTheme(page, 'dark');
  await expect.poll(async () => (await colors(page)).bg).toEqual(DARK_BG);
  const dark = await colors(page);
  expect(dark.edge).toEqual([107, 115, 130]);
  expect(dark.ink).toEqual([230, 233, 239]);
  expect(dark.pin).toEqual([232, 121, 249]);
  // What the screen shows, and the margins beside the view with it.
  expect(near(await page.evaluate(() => window.__CFD_THEME__.screenPixel(10, 10)), DARK_BG)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.viewport-wrap')).backgroundColor)).toBe('rgb(27, 31, 39)');
  await page.screenshot({ path: test.info().outputPath('dark-view.png') });

  // A capture of the view is light, and the view is dark again after it, with no island left over.
  expect(near(await page.evaluate(() => window.__CFD_THEME__.capturePixel(10, 10)), LIGHT_BG)).toBe(true);
  expect((await colors(page)).bg).toEqual(DARK_BG);
  expect((await colors(page)).edge).toEqual([107, 115, 130]);
  expect(near(await page.evaluate(() => window.__CFD_THEME__.screenPixel(10, 10)), DARK_BG)).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('[data-theme="light"]:not([data-theme-keep])').length)).toBe(0);

  await setTheme(page, null);
  await expect.poll(async () => (await colors(page)).bg).toEqual(LIGHT_BG);
  expect(await colors(page)).toEqual(light);
  expect(near(await page.evaluate(() => window.__CFD_THEME__.screenPixel(10, 10)), LIGHT_BG)).toBe(true);
});

test("the Assistant's picture of Home is light while Home is dark, and Home stays dark", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => window.__CFD_PLUGINS_READY__ === true, null, { timeout: 90_000 });
  await setTheme(page, 'dark');
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
  const darkBg = await bodyBg();
  expect(Math.max(...darkBg)).toBeLessThan(80);
  // The picture core__view takes of a window with no 3D view (src/assistant/domPicture.ts).
  const pixel = await page.evaluate(async () => {
    const { drawPagePicture } = await import('/src/assistant/domPicture.ts');
    const pic = await drawPagePicture(document.body, { aspect: 'view', width: 640 });
    const bmp = await createImageBitmap(pic.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    return Array.from(g.getImageData(c.width - 4, c.height - 4, 1, 1).data.slice(0, 3));
  });
  expect(Math.min(...pixel), `the picture's corner ${pixel}`).toBeGreaterThan(200);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await bodyBg()).toEqual(darkBg);
  await setTheme(page, null);
});
