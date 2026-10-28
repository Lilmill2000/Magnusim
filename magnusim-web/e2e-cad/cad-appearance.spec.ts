// Settings → Appearance in Magnusim CAD: Dark turns Home dark at once, the project page opens dark,
// and a reload paints dark from the start. So does a browser with no copy of the look: the
// desktop app's server takes a new port at every start, and with it the page's storage, so the
// page as served carries the look. Reset to defaults puts light at 100% back. The look is the
// person's pref on this server: the test puts it back.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from './pw';

const theme = (page: Page) => page.evaluate(() => [document.documentElement.dataset.theme ?? 'light', document.documentElement.dataset.themePref ?? '']);
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// The look back to light at 100% on this shared server, even after a timeout (a finally would not
// run then): the window closed first, so it saves nothing again.
test.afterEach(async ({ page, request }) => {
  await page.close();
  await request.post('/api/prefs', { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
});

test('Dark in Settings turns Magnusim CAD dark at once and from the first paint; Reset brings light back', async ({ page, request, browser }) => {
  await request.post('/api/prefs', { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
  {
    await page.goto('/');
    await expect(page.locator('#home')).toBeVisible();
    const lightBg = await bodyBg(page);
    await page.locator('#home-prefs').click();
    await page.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
    const pane = page.locator('#setup-wizard .wiz-pane[data-wiz-key="appearance"]');
    await pane.locator('[data-wiz-look="theme"][data-value="dark"]').click();
    await expect(page.locator('#wiz-saved')).toHaveText('Saved');
    expect(await theme(page)).toEqual(['dark', 'dark']);
    const darkBg = await bodyBg(page);
    expect(darkBg).not.toBe(lightBg);

    // A project's page opens dark; a reload paints dark from the start.
    const made = await request.post('/api/project', { data: { title: 'Dark parts', category: 'Other', units: 'Metric' } });
    const pid = String((await made.json()).id);
    await page.goto(`/#/p/${pid}`);
    await expect(page.locator('#cad-project')).toBeVisible();
    expect(await theme(page)).toEqual(['dark', 'dark']);
    // Nothing stays light but what is kept light (data-theme-keep): not Settings' preview.
    expect(await page.evaluate(() => document.querySelectorAll('[data-theme="light"]:not([data-theme-keep])').length)).toBe(0);
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => !!document.body && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');
    expect(await theme(page)).toEqual(['dark', 'dark']);
    expect(await bodyBg(page)).toBe(darkBg);

    // A browser with no copy of the look (as the app at its next start), its prefs held: dark
    // before the app has read them.
    const fresh = await browser.newContext();
    try {
      const first = await fresh.newPage();
      let open = () => {};
      const hold = new Promise<void>((r) => (open = r));
      await first.route(
        (url) => url.pathname === '/api/prefs',
        async (route) => {
          await hold;
          await route.continue();
        },
      );
      await first.goto(`${process.env.CAD_E2E_BASE_URL}/`, { waitUntil: 'commit' });
      // Once its stylesheets are in (the first paint waits for them; the app's start waits for the prefs).
      await first.waitForFunction(() => !!document.body && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');
      expect(await first.evaluate(() => localStorage.getItem('magnusim.appearance'))).toBeNull();
      expect(await theme(first)).toEqual(['dark', 'dark']);
      expect(await bodyBg(first)).toBe(darkBg);
      open();
    } finally {
      await fresh.close();
    }

    // Reset to defaults: light at 100%.
    await page.goto('/');
    await expect(page.locator('#home')).toBeVisible();
    await page.locator('#home-prefs').click();
    await page.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
    await pane.locator('[data-wiz-reset="appearance"]').click();
    await expect.poll(() => theme(page)).toEqual(['light', 'light']);
    expect(await bodyBg(page)).toBe(lightBg);
  }
});
