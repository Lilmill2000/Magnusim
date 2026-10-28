// Settings → Appearance with a Part open in Magnusim CAD: the Part's page is dark from its first
// paint, with the sizes chosen, before its SDK has connected (the host puts the look in the page
// as it serves it), the Part's bridge has the same look once it connects (ws.context.appearance),
// and a change made in Settings in another window reaches the open Part at once. What the Part
// draws in dark is the CAD plugin's own (its dark set); here: what the host and its SDK put on
// the Part's page. No CSP refusal, no console error. The look is the person's pref on this
// server: the test puts it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type BrowserContext, type Page } from './pw';
import { partOpened, watchPage, workspaceFrame } from '../bundled-plugins/cad/e2e/helpers';

const CAD_PAGE = /\/plugins\/cad\/workspace\//;
const sdkFile = (url: URL) => url.pathname === '/plugin-sdk/workspace.js';

/** What the Part's page shows: html's theme, choice and scales, and its colour scheme. */
const lookOf = (page: Page) =>
  workspaceFrame(page).evaluate(() => {
    const h = document.documentElement;
    return {
      theme: h.dataset.theme ?? '',
      pref: h.dataset.themePref ?? '',
      text: h.style.getPropertyValue('--mg-text-scale'),
      icons: h.style.getPropertyValue('--mg-icon-scale'),
      scheme: getComputedStyle(h).colorScheme,
    };
  });

let context: BrowserContext | null = null;

// The look back to light at 100% on this shared server, even after a timeout (a finally would not
// run then): the windows closed first, so none of them saves again.
test.afterEach(async ({ request }) => {
  await context?.close();
  context = null;
  await request.post('/api/prefs', { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
});

test('a Part opens dark from its first paint with the sizes chosen, and takes a change made in Settings in another window at once', async ({ browser, request }) => {
  test.setTimeout(180_000);
  context = await browser.newContext();
  {
    expect((await request.post('/api/prefs', { data: { theme: 'dark', text_scale: 1.15, icon_scale: 1.25 } })).ok()).toBe(true);
    const made = await request.post('/api/project', { data: { title: 'Look of a Part', category: 'Other', units: 'Metric' } });
    expect(made.ok()).toBe(true);
    const pid = String((await made.json()).id);
    const st = await request.post('/api/plugin-studies/create', { data: { project_id: pid, plugin: 'cad', kind: 'part', title: 'Part 1' } });
    expect(st.ok()).toBe(true);

    // Window A: the Part, its SDK held back: the page as served is dark already.
    const part = await context.newPage();
    const seen = await watchPage(part);
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await part.route(sdkFile, async (route) => {
      await held;
      await route.continue();
    });
    await part.goto(`/#/p/${pid}`);
    await part.locator('#cad-project .cad-part-open', { hasText: 'Part 1' }).click();
    await expect.poll(() => part.frames().some((f) => CAD_PAGE.test(f.url())), { timeout: 60_000 }).toBe(true);
    await workspaceFrame(part).waitForFunction(() => !!document.body && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');
    expect(await lookOf(part)).toEqual({ theme: 'dark', pref: 'dark', text: '1.15', icons: '1.25', scheme: 'dark' });
    // Let it through (the route stays: it passes each request on at once now).
    release();
    await partOpened(part);
    // The hold did not outlast the app's wait for the Part.
    await expect(part.getByText("didn't start")).toHaveCount(0);
    expect(await lookOf(part)).toEqual({ theme: 'dark', pref: 'dark', text: '1.15', icons: '1.25', scheme: 'dark' });
    // The Part's bridge has the host's look (what CAD's own dark set reads).
    const inPart = () =>
      workspaceFrame(part).evaluate(() => (window as unknown as { __CAD__: { services: { bridge: { context: { appearance?: unknown } } } } }).__CAD__.services.bridge.context.appearance);
    expect(await inPart()).toEqual({ theme: 'dark', preference: 'dark', textScale: 1.15, iconScale: 1.25 });

    // Window B: Settings → Appearance. Light, then the default sizes: the open Part takes each.
    const settings = await context.newPage();
    await settings.goto('/');
    await settings.locator('#home-prefs').click();
    await settings.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
    const pane = settings.locator('#setup-wizard .wiz-pane[data-wiz-key="appearance"]');
    // Each pick waits for its own save (the "Saved" of the one before may still show).
    const pick = async (field: string, value: string) => {
      const saved = settings.waitForResponse((r) => new URL(r.url()).pathname === '/api/prefs' && r.request().method() === 'POST');
      await pane.locator(`[data-wiz-look="${field}"][data-value="${value}"]`).click();
      expect((await saved).ok()).toBe(true);
      await expect(settings.locator('#wiz-saved')).toHaveText('Saved');
    };
    await pick('theme', 'light');
    await expect.poll(() => lookOf(part).then((l) => [l.theme, l.pref, l.scheme]), { timeout: 10_000 }).toEqual(['light', 'light', 'light']);
    await pick('text_scale', '1');
    await pick('icon_scale', '1');
    await expect.poll(() => lookOf(part).then((l) => [l.text, l.icons]), { timeout: 10_000 }).toEqual(['1', '1']);
    expect(await inPart()).toEqual({ theme: 'light', preference: 'light', textScale: 1, iconScale: 1 });
    expect(seen.csp, 'CSP violations').toEqual([]);
    expect(seen.errors, 'console errors').toEqual([]);
  }
});
