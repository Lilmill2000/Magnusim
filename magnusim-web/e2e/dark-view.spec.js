// The 3D view in the dark theme (Daniel, 2026-10-27): its background, lines, edges, points and
// labels turn dark-theme colours, the model's surfaces stay light, and what the person keeps (a
// capture) stays light. The theme is set as Settings → Appearance sets it (applyAppearance).
import { expect, test } from '@playwright/test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './support/host-server.mjs';

const FIXTURE = 'sample-project-steady-state-e2e';
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUND = join(WEB, 'python', 'tests', 'fixtures', 'geometry', 'transient-test.step');
const CAVITY = join(WEB, 'python', 'tests', 'fixtures', 'foam-results', 'cavity-2d');
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

/** WCAG relative luminance of [r, g, b] bytes. */
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the triad reads in the dark theme: each arrow, end-on ones too, stands out from the dark background; light and a capture are as they were', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${host.base}/#/p/${FIXTURE}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, FIXTURE, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const chip = document.getElementById('viewport-job-chip');
    return !chip || chip.hidden;
  }, null, { timeout: 180_000 });
  // The triad's slot in the view's canvas pixels (on screen) and in the view's CSS px (a capture).
  const slot = await page.evaluate(() => {
    const canvas = document.querySelector('#viewer canvas');
    const cr = canvas.getBoundingClientRect();
    const wr = document.querySelector('.viewport-wrap').getBoundingClientRect();
    const sr = document.getElementById('viewport-triad-slot').getBoundingClientRect();
    const k = canvas.width / cr.width;
    return {
      screen: { x: Math.round((sr.left - cr.left) * k), y: Math.round((sr.top - cr.top) * k), w: Math.round(sr.width * k), h: Math.round(sr.height * k) },
      capture: { x: Math.round(sr.left - wr.left), y: Math.round(sr.top - wr.top), w: Math.round(sr.width), h: Math.round(sr.height) },
    };
  });
  const onScreen = () => page.evaluate((b) => window.__CFD_THEME__.screenBox(b.x, b.y, b.w, b.h), slot.screen);
  const captured = () => page.evaluate((b) => window.__CFD_THEME__.captureBox(b.x, b.y, b.w, b.h), slot.capture);
  /** Each arrow's brightest pixel (its hue clearly ahead of the other two) against the background. */
  const arrows = (rgb, bg) => {
    const best = { x: 1, y: 1, z: 1 };
    for (let i = 0; i < rgb.length; i += 3) {
      const p = [rgb[i], rgb[i + 1], rgb[i + 2]];
      const [r, g, b] = p;
      const axis = r > g + 40 && r > b + 40 ? 'x' : g > r + 30 && g > b + 30 ? 'y' : b > r + 30 && b > g + 30 ? 'z' : null;
      if (axis) best[axis] = Math.max(best[axis], contrast(p, bg));
    }
    return best;
  };
  const lightScreen = await onScreen();
  const lightCapture = await captured();
  const lightArrows = arrows(lightScreen, LIGHT_BG);
  for (const axis of ['x', 'y', 'z']) expect(lightArrows[axis], `light: the ${axis} arrow is drawn`).toBeGreaterThan(2);

  await setTheme(page, 'dark');
  await expect.poll(async () => (await colors(page)).bg).toEqual(DARK_BG);
  const dark = arrows(await onScreen(), DARK_BG);
  for (const axis of ['x', 'y', 'z']) expect(dark[axis], `dark: the ${axis} arrow against the background`).toBeGreaterThanOrEqual(3);
  expect(await captured(), 'a capture taken in dark has the light triad').toEqual(lightCapture);

  await setTheme(page, null);
  await expect.poll(async () => (await colors(page)).bg).toEqual(LIGHT_BG);
  expect(await onScreen(), 'back in light, the triad is as it was').toEqual(lightScreen);

  // Looked at from each axis and the two diagonals, an arrow pointing at the eye included, every
  // arrow still reads in dark (the lowest was 4.1:1, from -X -Y -Z, when this was written).
  await setTheme(page, 'dark');
  await expect.poll(async () => (await colors(page)).bg).toEqual(DARK_BG);
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, -1]]) {
    await page.evaluate((d) => {
      const cam = window.__CFD_VIEW__.renderer.getActiveCamera();
      const fp = cam.getFocalPoint();
      const dist = Math.hypot(...cam.getPosition().map((v, i) => v - fp[i]));
      const n = Math.hypot(...d);
      cam.setPosition(fp[0] + (d[0] / n) * dist, fp[1] + (d[1] / n) * dist, fp[2] + (d[2] / n) * dist);
      cam.setViewUp(...(Math.abs(d[2]) > 0.9 * n ? [0, 1, 0] : [0, 0, 1]));
      window.__CFD_VIEW__.renderWindow.render();
    }, d);
    const seen = arrows(await onScreen(), DARK_BG);
    for (const axis of ['x', 'y', 'z']) expect(seen[axis], `dark, seen from ${d}: the ${axis} arrow`).toBeGreaterThanOrEqual(3);
  }
  await setTheme(page, null);
});

test("a capture of results taken in the dark theme keeps the legend light: it is the light capture's legend, pixel for pixel, title included", async ({ page, request }) => {
  test.setTimeout(360_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const json = async (url) => {
    for (let i = 0; ; i++) {
      try {
        return await (await request.get(url)).json();
      } catch (e) {
        if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
      }
    }
  };
  await page.goto(`${host.base}/#/`);
  await page.waitForFunction(() => typeof window.__CFD_W16_CREATE__ === 'function', null, { timeout: 60_000 });
  const pid = await page.evaluate(
    async (t) =>
      (await window.__CFD_W16_CREATE__({ title: t, description: '', category: 'Other', units: 'Metric', folder: 'My Projects' }))
        .project.id,
    `e2e dark capture ${Date.now().toString(36)}`,
  );
  const q = (path, extra = {}) => `${host.base}${path}?${new URLSearchParams({ project_id: pid, ...extra })}`;
  const ready = () => page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, pid, { timeout: 60_000 });
  await page.goto(`${host.base}/#/p/${encodeURIComponent(pid)}`);
  await ready();
  await page.locator('#geometry-file-input').setInputFiles(ROUND);
  await expect
    .poll(async () => ((await json(q('/api/project'))).project?.geometries || []).length, { timeout: 120_000 })
    .toBe(1);
  await expect(page.locator('#btn-create-simulation')).toBeVisible({ timeout: 60_000 });
  await page.locator('#btn-create-simulation').click();
  await expect(page.locator('#modal-create-simulation')).toBeVisible();
  await page.locator('#cs-create').click();
  await expect(page.locator('#modal-create-simulation')).toBeHidden({ timeout: 30_000 });
  if (await page.locator('#modal-confirm').isVisible()) await page.locator('#cf-confirm').click();
  const sid = await page.evaluate(() => window.__CFD_W17__.activeId);
  expect(sid).toBeTruthy();

  // A finished run whose case is a copy of the cavity (U and p, five saved times).
  const runRows = async () => (await json(q('/api/run/status', { simulation_id: sid }))).runs || [];
  const made = await (await request.post(q('/api/run/create'), { data: { project_id: pid, simulation_id: sid, name: 'Run 1' } })).json();
  const rid = String(made.run_id || (made.run && (made.run.id || made.run.run_id)));
  expect(rid, JSON.stringify(made)).toBeTruthy();
  const runDir = dirname((await runRows()).find((r) => String(r.id) === rid).case_dir);
  const caseDir = join(runDir, 'case');
  cpSync(CAVITY, caseDir, { recursive: true });
  const sidecar = join(caseDir, 'w27-case.json');
  const doc = JSON.parse(readFileSync(sidecar, 'utf8'));
  delete doc.plugin;
  delete doc.study_id;
  writeFileSync(sidecar, JSON.stringify(doc, null, 2));
  const runJson = join(runDir, 'run.json');
  const rec = JSON.parse(readFileSync(runJson, 'utf8'));
  writeFileSync(
    runJson,
    JSON.stringify(
      { ...rec, status: 'done', stage: 'done', has_results: true, n_saved_times: 5, last_saved_iteration: 0.5, finished_at: new Date().toISOString(), case_dir: caseDir },
      null,
      2,
    ),
  );
  await page.reload();
  await ready();

  // Its results, opened from the tree as a person does.
  const studyRow = page.locator(`#left-tree [data-w17-sim-id="${sid}"] > .tree-row`).first();
  if ((await page.evaluate(() => window.__CFD_W17__.activeId)) !== sid) await studyRow.click();
  await expect.poll(() => page.evaluate(() => window.__CFD_W17__.activeId)).toBe(sid);
  const runsFolder = page.locator(`#left-tree [data-w17-sim-id="${sid}"] li[data-w27-sim-control="1"]`).first();
  if (!(await runsFolder.evaluate((el) => el.classList.contains('expanded')))) {
    await runsFolder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${rid}"] > .tree-row .tl`).first().click();
  const results = page.locator(`#left-tree [data-w27-run-results="${rid}"] > .tree-row .tl`).first();
  await expect(results).toBeVisible();
  await results.click();
  await expect(page.locator('#viewport-job-chip')).toBeHidden({ timeout: 90_000 });
  const title = page.locator('#legend .legend-title');
  await expect(title).toHaveText('Velocity Magnitude', { timeout: 60_000 });

  // Where the legend and its title are, in the capture's pixels (the view's CSS px at scale 1).
  const boxes = () =>
    page.evaluate(() => {
      const wrap = document.querySelector('.viewport-wrap').getBoundingClientRect();
      const box = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { x: Math.round(r.left - wrap.left), y: Math.round(r.top - wrap.top), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return { legend: box('#legend'), title: box('#legend .legend-title') };
    });
  const captured = (b) => page.evaluate((b) => window.__CFD_THEME__.captureBox(b.x, b.y, b.w, b.h), b);
  const { legend, title: t } = await boxes();
  const light = await captured(legend);
  expect(light.length).toBe(legend.w * legend.h * 3);
  // Not a blank box: the title's letters are dark ink on the light card.
  let ink = 255;
  for (let y = t.y - legend.y; y < t.y - legend.y + t.h; y++) {
    for (let x = t.x - legend.x; x < t.x - legend.x + t.w; x++) {
      const i = (y * legend.w + x) * 3;
      ink = Math.min(ink, (light[i] + light[i + 1] + light[i + 2]) / 3);
    }
  }
  expect(ink, "the title's darkest pixel in the light capture").toBeLessThan(110);
  const lightTitle = await title.evaluate((el) => getComputedStyle(el).color);

  await setTheme(page, 'dark');
  await expect.poll(async () => (await colors(page)).bg).toEqual(DARK_BG);
  // On screen the legend is the dark theme's; in the same place.
  expect(await title.evaluate((el) => getComputedStyle(el).color)).not.toBe(lightTitle);
  expect(await boxes()).toEqual({ legend, title: t });
  const dark = await captured(legend);
  let differ = 0;
  for (let i = 0; i < light.length; i += 3) {
    if (Math.abs(light[i] - dark[i]) > 3 || Math.abs(light[i + 1] - dark[i + 1]) > 3 || Math.abs(light[i + 2] - dark[i + 2]) > 3) differ += 1;
  }
  expect(differ, "the legend's pixels in the dark-theme capture that differ from the light capture").toBe(0);
  // The screen is dark again after the capture.
  expect(await title.evaluate((el) => getComputedStyle(el).color)).not.toBe(lightTitle);
  await setTheme(page, null);
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
