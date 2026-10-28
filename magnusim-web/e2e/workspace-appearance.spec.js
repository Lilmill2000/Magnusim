// Settings → Appearance in a plugin's workspace (the ai-demo test plugin's page, on the SDK's
// theme.css): the page is dark from its first paint, before its SDK has connected (the host puts
// the look in the page as it serves it), with the text size Daniel chose; its SDK says the same
// look; the kit's icons grow with the icon size, and a page that pins the sizes at 1 (`:root {
// --mg-*-scale: 1 !important }`) keeps them. What is kept light in the dark page
// (data-theme="light": a picture's box, or a page's body) has dark text on a light background,
// and html has no background of its own. A change made in Settings in another window
// reaches the open page at once: light, the sizes, then "Match system", which follows the system
// as it turns dark and light. No inline script of the host's breaks the page's
// Content-Security-Policy. The look is put back after each test.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appReady } from './support/assistant.js';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

const PLUGIN = 'ai-demo';
const WORKSPACE_PAGE = `/plugins/${PLUGIN}/workspace/`;

let host;
let project;
let study;

test.describe.configure({ mode: 'serial' });

const api = (path) => `${host.base}${path}`;

async function postOk(request, path, data = {}) {
  const r = await request.post(api(path), { data });
  const j = await r.json().catch(() => ({}));
  expect(r.ok(), `${path}: ${r.status()} ${JSON.stringify(j)}`).toBe(true);
  return j;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(180_000);
  host = await startHost({ name: 'workspace-appearance', pluginsFrom: 'python/tests/fixtures/assistant-plugins' });
  project = (await postOk(request, '/api/project', { title: 'Look project', folder: 'My Projects', units: 'Metric', category: 'Other' })).id;
  study = (await postOk(request, '/api/plugin-studies/create', { project_id: project, plugin: PLUGIN, kind: 'counter_case', title: 'Counter 1' })).study.id;
});

test.afterAll(async () => {
  if (host) host.stop();
});

// The look back to light at 100%, even after a test that timed out (its finally would not run):
// the windows closed first, so none of them saves again.
test.afterEach(async ({ page, request }) => {
  for (const p of page.context().pages()) await p.close();
  await postOk(request, '/api/prefs', { theme: 'light', text_scale: 1, icon_scale: 1 });
});

/** The workspace page's frame, once the overlay has made it. */
async function workspaceFrame(page) {
  await expect.poll(() => page.frames().some((f) => f.url().includes(WORKSPACE_PAGE)), { timeout: 60_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes(WORKSPACE_PAGE));
}

/** What the page shows: html's theme, choice and scales, its colour scheme, its background's lightness (0 black to 1 white) and its text size. */
const lookOf = (frame) =>
  frame.evaluate(() => {
    const html = document.documentElement;
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).map(Number);
    return {
      theme: html.dataset.theme ?? '',
      pref: html.dataset.themePref ?? '',
      text: html.style.getPropertyValue('--mg-text-scale'),
      icons: html.style.getPropertyValue('--mg-icon-scale'),
      scheme: getComputedStyle(html).colorScheme,
      light: Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100) / 100,
      textPx: parseFloat(getComputedStyle(document.body).fontSize),
    };
  });

/** The width a kit Icon (svg.mgk-icon, 15 px as drawn) takes on the page now. */
const iconPx = (frame) =>
  frame.evaluate(() => {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'mgk-icon');
    icon.setAttribute('width', '15');
    icon.setAttribute('height', '15');
    document.body.append(icon);
    const width = icon.getBoundingClientRect().width;
    icon.remove();
    return width;
  });

/** Its stylesheets are in (the first paint waits for them): the body has its background. */
const stylesIn = (frame) => frame.waitForFunction(() => !!document.body && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');

/** Every console error and CSP refusal of the page and its frames. */
function watch(page) {
  const seen = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) seen.push(m.text());
  });
  page.on('pageerror', (e) => seen.push(String(e)));
  return seen;
}

/** Settings → Appearance in another window of the same browser. */
async function appearanceIn(context) {
  const settings = await context.newPage();
  await settings.goto(`${host.base}/#/`);
  await appReady(settings);
  await settings.locator('#home-prefs').click();
  await settings.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
  const pane = settings.locator('#setup-wizard .wiz-pane[data-wiz-key="appearance"]');
  await expect(pane).toBeVisible();
  return {
    settings,
    // Each pick waits for its own save (the "Saved" of the one before may still show).
    pick: async (field, value) => {
      const saved = settings.waitForResponse((r) => new URL(r.url()).pathname === '/api/prefs' && r.request().method() === 'POST');
      await pane.locator(`[data-wiz-look="${field}"][data-value="${value}"]`).click();
      expect((await saved).ok()).toBe(true);
      await expect(settings.locator('#wiz-saved')).toHaveText('Saved');
    },
  };
}

test('a workspace page is dark from its first paint with the sizes chosen, before its SDK connects; the SDK has the same look', async ({ page, request }) => {
  test.setTimeout(180_000);
  const seen = watch(page);
  await postOk(request, '/api/prefs', { theme: 'light', text_scale: 1, icon_scale: 1 });
  {
    // Light at 100% first: the page's own light and text size, to compare with.
    await page.goto(`${host.base}/#/p/${project}/ws/${PLUGIN}/counter/${study}`);
    let frame = await workspaceFrame(page);
    await expect(frame.locator('#title')).not.toHaveText('Connecting…', { timeout: 60_000 });
    const light = await lookOf(frame);
    const lightIcon = await iconPx(frame);
    expect(light).toMatchObject({ theme: 'light', pref: 'light', scheme: 'light' });
    expect(light.light).toBeGreaterThan(0.8);
    expect(await frame.evaluate(() => window.__ws.context.appearance)).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });

    // Dark, larger text, larger icons: the page as served has them, its SDK held back.
    await postOk(request, '/api/prefs', { theme: 'dark', text_scale: 1.3, icon_scale: 1.25 });
    let release = () => {};
    const held = new Promise((r) => (release = r));
    await page.route(
      (url) => url.pathname === '/plugin-sdk/workspace.js',
      async (route) => {
        await held;
        await route.continue();
      },
    );
    // A new start of the app (the page's own look comes from the prefs too).
    await page.goto('about:blank');
    await page.goto(`${host.base}/#/p/${project}/ws/${PLUGIN}/counter/${study}`);
    frame = await workspaceFrame(page);
    await stylesIn(frame);
    expect(await frame.locator('#title').textContent()).toBe('Connecting…');
    const first = await lookOf(frame);
    expect(first).toMatchObject({ theme: 'dark', pref: 'dark', text: '1.3', icons: '1.25', scheme: 'dark' });
    expect(first.light).toBeLessThan(0.2);
    expect(first.textPx / light.textPx).toBeCloseTo(1.3, 1);
    // The kit's icons grow with the icon size.
    expect((await iconPx(frame)) / lightIcon).toBeCloseTo(1.25, 2);
    // Let it through (the route stays: it passes each request on at once now).
    release();
    await expect(frame.locator('#title')).not.toHaveText('Connecting…', { timeout: 60_000 });
    expect(await frame.evaluate(() => window.__ws.context.appearance)).toEqual({ theme: 'dark', preference: 'dark', textScale: 1.3, iconScale: 1.25 });
    expect(await lookOf(frame)).toEqual(first);
    // The hold did not outlast the app's wait for the page.
    await expect(page.getByText("didn't start")).toHaveCount(0);

    // A page keeps the sizes at 1 with `:root { --mg-*-scale: 1 !important }` (compatibility.md):
    // above what the host and the SDK set on html.
    const kept1 = await frame.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = ':root { --mg-text-scale: 1 !important; --mg-icon-scale: 1 !important; }';
      document.head.append(style);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'mgk-icon');
      icon.setAttribute('width', '15');
      document.body.append(icon);
      const out = { textPx: parseFloat(getComputedStyle(document.body).fontSize), iconPx: icon.getBoundingClientRect().width };
      icon.remove();
      style.remove();
      return out;
    });
    expect(kept1).toEqual({ textPx: light.textPx, iconPx: lightIcon });

    // Kept light in the dark page (data-theme="light"): a picture's box, and a whole page not ready
    // for dark (its body): dark text on a light background, not the dark page's light text. html
    // itself has no background, so body's fills the canvas past the first screen too.
    const kept = await frame.evaluate(() => {
      const lightness = (c) => {
        const [r, g, b] = c.match(/[\d.]+/g).map(Number);
        return Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100) / 100;
      };
      const box = document.createElement('div');
      box.dataset.theme = 'light';
      const line = document.createElement('p');
      line.textContent = 'Kept light';
      box.append(line);
      document.body.append(box);
      const picture = { text: lightness(getComputedStyle(line).color), bg: lightness(getComputedStyle(box).backgroundColor) };
      box.remove();
      document.body.dataset.theme = 'light';
      const body = { text: lightness(getComputedStyle(document.body).color), bg: lightness(getComputedStyle(document.body).backgroundColor) };
      const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
      delete document.body.dataset.theme;
      return { picture, body, htmlBg };
    });
    for (const part of [kept.picture, kept.body]) {
      expect(part.text).toBeLessThan(0.3);
      expect(part.bg).toBeGreaterThan(0.8);
    }
    expect(kept.htmlBg).toBe('rgba(0, 0, 0, 0)');
    expect(seen, 'console errors and CSP refusals').toEqual([]);
  }
});

test('a change in Settings in another window reaches the open workspace page at once; "Match system" follows the system', async ({ page, request }) => {
  test.setTimeout(180_000);
  const seen = watch(page);
  await postOk(request, '/api/prefs', { theme: 'dark', text_scale: 1, icon_scale: 1 });
  {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${host.base}/#/p/${project}/ws/${PLUGIN}/counter/${study}`);
    const frame = await workspaceFrame(page);
    await expect(frame.locator('#title')).not.toHaveText('Connecting…', { timeout: 60_000 });
    const heard = () => frame.evaluate(() => window.__looks || []);
    await frame.evaluate(() => {
      window.__looks = [];
      window.__ws.on('appearance', (a) => window.__looks.push(`${a.theme} ${a.preference} ${a.textScale} ${a.iconScale}`));
    });
    const dark = await lookOf(frame);
    expect(dark).toMatchObject({ theme: 'dark', pref: 'dark', scheme: 'dark' });

    const { settings, pick } = await appearanceIn(page.context());
    await settings.emulateMedia({ colorScheme: 'light' });
    // Light, then larger text: the open page has each at once, without a reload.
    await pick('theme', 'light');
    await expect.poll(() => lookOf(frame).then((l) => [l.theme, l.pref, l.scheme])).toEqual(['light', 'light', 'light']);
    expect((await lookOf(frame)).light).toBeGreaterThan(0.8);
    await pick('text_scale', '1.15');
    await expect.poll(() => lookOf(frame).then((l) => l.text)).toBe('1.15');
    expect((await lookOf(frame)).textPx / dark.textPx).toBeCloseTo(1.15, 1);
    await pick('text_scale', '1');

    // Match system: the system is light here, then turns dark, then light again.
    await pick('theme', 'system');
    await expect.poll(() => lookOf(frame).then((l) => [l.theme, l.pref])).toEqual(['light', 'system']);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => lookOf(frame).then((l) => [l.theme, l.pref, l.scheme])).toEqual(['dark', 'system', 'dark']);
    expect((await lookOf(frame)).light).toBeLessThan(0.2);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => lookOf(frame).then((l) => l.theme)).toBe('light');
    // Each look once, in order; the SDK's context follows.
    expect(await heard()).toEqual(['light light 1 1', 'light light 1.15 1', 'light light 1 1', 'light system 1 1', 'dark system 1 1', 'light system 1 1']);
    expect(await frame.evaluate(() => window.__ws.context.appearance)).toEqual({ theme: 'light', preference: 'system', textScale: 1, iconScale: 1 });

    // Its first paint under "Match system" is the system's too: dark here.
    await page.emulateMedia({ colorScheme: 'dark' });
    let release = () => {};
    const held = new Promise((r) => (release = r));
    await page.route(
      (url) => url.pathname === '/plugin-sdk/workspace.js',
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await page.goto('about:blank');
    await page.goto(`${host.base}/#/p/${project}/ws/${PLUGIN}/counter/${study}`);
    const again = await workspaceFrame(page);
    await stylesIn(again);
    expect(await lookOf(again)).toMatchObject({ theme: 'dark', pref: 'system', scheme: 'dark' });
    // Let it through (the route stays: it passes each request on at once now).
    release();
    await expect(again.locator('#title')).not.toHaveText('Connecting…', { timeout: 60_000 });
    expect(await again.evaluate(() => window.__ws.context.appearance)).toEqual({ theme: 'dark', preference: 'system', textScale: 1, iconScale: 1 });
    await expect(page.getByText("didn't start")).toHaveCount(0);
    await settings.close();
    expect(seen, 'console errors and CSP refusals').toEqual([]);
  }
});
