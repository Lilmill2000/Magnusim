// Settings → Appearance (src/theme/appearance.ts): what Daniel sees when he picks a look. A choice
// the pointer is on shows in the preview only; a click keeps it: Dark turns the app dark at once,
// in this window and another one open, and a reload paints dark before the app has read its prefs
// (the pre-paint script). Text and icon sizes grow what they size. "Match the system" follows the
// system's light or dark. Reset to defaults puts light at 100% back. The Assistant (the scripted
// model) reads the look, and changes it only when Daniel asked for it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { appReady, dockSend, dockTurn, resultsIn, trackTab, useScriptedModel } from './support/assistant.js';
import { startFakeLlm } from './support/fake-llm.mjs';
import { startHost } from './support/host-server.mjs';
import { expect, test } from './support/stress.js';

let host;
let fake;

test.describe.configure({ mode: 'serial' });

const api = (path) => `${host.base}${path}`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fake = await startFakeLlm();
  host = await startHost({ name: 'appearance', env: { MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL: fake.base } });
});

test.afterAll(async () => {
  if (host) host.stop();
  if (fake) await fake.stop();
});

const theme = (page) => page.evaluate(() => [document.documentElement.dataset.theme ?? 'light', document.documentElement.dataset.themePref ?? '']);
/** The page's own background colour, as the person sees it. */
const bodyBg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const pxOf = (page, sel, prop) => page.evaluate(([s, p]) => parseFloat(getComputedStyle(document.querySelector(s))[p]), [sel, prop]);
/** Settings' Port field (background, text) and Workspace checkbox (tick colour): fields no rule colours. */
const fieldLook = (page) =>
  page.evaluate(() => {
    const field = getComputedStyle(document.querySelector('#wiz-port'));
    return [field.backgroundColor, field.color, getComputedStyle(document.querySelector('#wiz-collapse-completed')).accentColor];
  });
/** The plugin kit's field (an input.mgk-input put on the page): background and text. */
const kitFieldLook = (page) =>
  page.evaluate(() => {
    const input = document.createElement('input');
    input.className = 'mgk-input';
    document.body.append(input);
    const s = getComputedStyle(input);
    const look = [s.backgroundColor, s.color];
    input.remove();
    return look;
  });
/**
 * A page just committed, once its stylesheets are in (its first paint waits for them; the app's
 * own start waits for the prefs, held): the body and its background are there.
 */
const stylesIn = (page) => page.waitForFunction(() => !!document.body && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)');
/** Parts drawn light in a dark page that are not meant to stay light (data-theme-keep): their classes. */
const lightIslands = (page) => page.evaluate(() => [...document.querySelectorAll('[data-theme="light"]:not([data-theme-keep])')].map((el) => el.className || el.tagName));
// Light: the browser's own field and tick. Dark: a select's colours (#1b1f27, #e6e9ef) and the primary, not the browser's grey.
const LIGHT_FIELD = ['rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'auto'];
const DARK_FIELD = ['rgb(27, 31, 39)', 'rgb(230, 233, 239)', 'rgb(47, 111, 222)'];

async function openAppearance(page) {
  await page.goto(api('/#/'));
  await appReady(page);
  await page.locator('#home-prefs').click();
  await page.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
  const pane = page.locator('#setup-wizard .wiz-pane[data-wiz-key="appearance"]');
  await expect(pane).toBeVisible();
  return { pane, choice: (field, value) => pane.locator(`[data-wiz-look="${field}"][data-value="${value}"]`) };
}

test('gate:appearance the person picks a look: dark at once and before the first paint, sizes, the system, every window', async ({ browser, request }) => {
  test.setTimeout(240_000);
  await request.post(api('/api/prefs'), { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const other = await context.newPage();
    await other.goto(api('/#/'));
    await appReady(other);
    const { pane, choice } = await openAppearance(page);
    await expect(page.locator('#wiz-rail li:visible')).toHaveText(['Units', 'Appearance', 'This PC', 'Port', 'Workspace', 'Keybinds', 'Assistant', 'Plugins']);
    expect(await theme(page)).toEqual(['light', 'light']);
    const lightBg = await bodyBg(page);
    expect(await fieldLook(page)).toEqual(LIGHT_FIELD);
    // ...which is the browser's own: a field with the app's colours reverted shows the same.
    const browserField = await page.evaluate(() => {
      const lookOf = (disabled, reverted) => {
        const input = document.createElement('input');
        input.disabled = disabled;
        if (reverted) input.style.cssText = 'background-color: revert; color: revert; accent-color: revert';
        document.body.append(input);
        const s = getComputedStyle(input);
        const look = [s.backgroundColor, s.color, s.accentColor];
        input.remove();
        return look;
      };
      // A disabled field is the browser's own too (its greyed look).
      return { field: lookOf(false, true), disabled: lookOf(true, false), browserDisabled: lookOf(true, true) };
    });
    expect(browserField.field).toEqual(LIGHT_FIELD);
    expect(browserField.disabled).toEqual(browserField.browserDisabled);
    expect(browserField.disabled[0]).not.toBe(LIGHT_FIELD[0]);
    expect(await kitFieldLook(page)).toEqual(LIGHT_FIELD.slice(0, 2));
    await expect(choice('theme', 'light')).toHaveAttribute('aria-checked', 'true');

    // The pointer on Dark: the preview only.
    const preview = pane.locator('[data-look-preview]');
    const previewLight = await preview.evaluate((el) => getComputedStyle(el).backgroundColor);
    await choice('theme', 'dark').hover();
    await expect(preview).toHaveAttribute('data-theme', 'dark');
    await expect(pane.locator('#wiz-look-note')).toHaveText('Preview of the choice: click it to keep it.');
    expect(await preview.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(previewLight);
    expect(await theme(page)).toEqual(['light', 'light']);

    // Under the choices, the look kept now; the preview is a picture, with nothing to press (it had a
    // Save that did nothing: Daniel pressed it).
    const kept = pane.locator('#wiz-look-now');
    await expect(kept).toHaveText('Your look now: Light, text 100%, icons 100%.');
    await expect(preview.getByText('Save', { exact: true })).toHaveCount(0);
    expect(await preview.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // The choice kept now has a tick.
    const tick = (field, value) => choice(field, value).locator('strong').evaluate((el) => getComputedStyle(el, '::after').content);
    expect(await tick('theme', 'light')).toMatch(/✓/);
    expect(await tick('theme', 'dark')).toBe('none');

    // A click keeps it: this window and the other one are dark, and the line under the choices says it was saved.
    await choice('theme', 'dark').click();
    await expect(page.locator('#wiz-saved')).toHaveText('Saved');
    await expect(kept).toHaveText('Saved. Your look now: Dark, text 100%, icons 100%.');
    expect(await tick('theme', 'dark')).toMatch(/✓/);
    expect(await theme(page)).toEqual(['dark', 'dark']);
    const darkBg = await bodyBg(page);
    expect(darkBg).not.toBe(lightBg);
    await expect.poll(() => theme(other)).toEqual(['dark', 'dark']);
    expect(await bodyBg(other)).toBe(await bodyBg(page));
    // Nothing stays light but what is kept light (the probe, Home's pictures): not the preview, in
    // the window whose Settings was never opened either.
    for (const p of [page, other]) expect(await lightIslands(p)).toEqual([]);
    // The browser's colour scheme is the theme's (tokens.css), never inline: a light swap on html for
    // one task (the Assistant's picture of Home) has the browser's light controls too.
    expect(await page.evaluate(() => [getComputedStyle(document.documentElement).colorScheme, document.documentElement.style.colorScheme])).toEqual(['dark', '']);
    const swapped = await page.evaluate(() => {
      const html = document.documentElement;
      const input = document.createElement('input');
      input.disabled = true;
      document.body.append(input);
      html.setAttribute('data-theme', 'light');
      const look = [getComputedStyle(html).colorScheme, getComputedStyle(input).backgroundColor];
      html.setAttribute('data-theme', 'dark');
      input.remove();
      return look;
    });
    expect(swapped).toEqual(['light', browserField.disabled[0]]);
    // Fields and ticks turn with it: Settings' Port field and Workspace checkbox.
    await page.locator('#wiz-rail li[data-wiz-key="port"]').click();
    await expect(page.locator('#wiz-port')).toBeVisible();
    expect(await fieldLook(page)).toEqual(DARK_FIELD);
    // The plugin kit's field too (its own rule reverts to the browser's field).
    expect(await kitFieldLook(page)).toEqual(DARK_FIELD.slice(0, 2));
    await page.locator('#wiz-rail li[data-wiz-key="appearance"]').click();

    // A reload paints dark before the app has read its prefs (they are held until it has).
    let release;
    const held = new Promise((r) => (release = r));
    await page.route(
      (url) => url.pathname === '/api/prefs',
      async (route) => {
        await held;
        await route.continue();
      },
    );
    // (Only until the new page's body is there: the app's own start waits for the prefs.)
    await page.reload({ waitUntil: 'commit' });
    await stylesIn(page);
    expect(await theme(page)).toEqual(['dark', 'dark']);
    expect(await bodyBg(page)).toBe(darkBg);
    release();
    await appReady(page);
    await page.unroute((url) => url.pathname === '/api/prefs');

    // A browser with no copy of the look (another origin: Magnusim CAD's port changes every start)
    // gets it with the page as served: dark before the app reads its prefs, which are held.
    const fresh = await browser.newContext();
    try {
      const first = await fresh.newPage();
      let open;
      const hold = new Promise((r) => (open = r));
      await first.route(
        (url) => url.pathname === '/api/prefs',
        async (route) => {
          await hold;
          await route.continue();
        },
      );
      await first.goto(api('/#/'), { waitUntil: 'commit' });
      await stylesIn(first);
      expect(await first.evaluate(() => localStorage.getItem('magnusim.appearance'))).toBeNull();
      expect(await theme(first)).toEqual(['dark', 'dark']);
      expect(await bodyBg(first)).toBe(darkBg);
      open();
    } finally {
      await fresh.close();
    }

    // Text and icon sizes grow what they size.
    await page.locator('#home-prefs').click();
    await page.locator('#wiz-rail li[data-wiz-key="appearance"]').click();
    const textBefore = await pxOf(page, '#setup-wizard .wiz-pane[data-wiz-key="appearance"] .wiz-copy', 'fontSize');
    const iconBefore = await page.locator('#wiz-close svg').evaluate((el) => el.getBoundingClientRect().width);
    await choice('text_scale', '1.3').click();
    await expect.poll(() => pxOf(page, '#setup-wizard .wiz-pane[data-wiz-key="appearance"] .wiz-copy', 'fontSize')).toBeCloseTo(textBefore * 1.3, 1);
    await choice('icon_scale', '1.5').click();
    await expect.poll(() => page.locator('#wiz-close svg').evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(iconBefore * 1.5, 0);
    const saved = await (await request.get(api('/api/prefs'))).json();
    expect([saved.theme, saved.text_scale, saved.icon_scale]).toEqual(['dark', 1.3, 1.5]);

    // By keyboard, as radios: Tab reaches the group's choice; Home and End pick and keep.
    await expect(choice('text_scale', '1.3')).toHaveAttribute('tabindex', '0');
    await expect(choice('text_scale', '1')).toHaveAttribute('tabindex', '-1');
    await choice('text_scale', '1.3').focus();
    await page.keyboard.press('Home');
    await expect(choice('text_scale', '0.9')).toBeFocused();
    await expect(choice('text_scale', '0.9')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await (await request.get(api('/api/prefs'))).json()).text_scale).toBe(0.9);
    await page.keyboard.press('ArrowLeft');
    await expect(choice('text_scale', '1.3')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => pxOf(page, '#setup-wizard .wiz-pane[data-wiz-key="appearance"] .wiz-copy', 'fontSize')).toBeCloseTo(textBefore * 1.3, 1);

    // Match the system: light or dark as the system is, and it follows a change.
    await page.emulateMedia({ colorScheme: 'light' });
    await choice('theme', 'system').click();
    await expect.poll(() => theme(page)).toEqual(['light', 'system']);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toEqual(['dark', 'system']);

    // Reset to defaults: light at 100%.
    await pane.locator('[data-wiz-reset="appearance"]').click();
    await expect.poll(() => theme(page)).toEqual(['light', 'light']);
    expect(await bodyBg(page)).toBe(lightBg);
    expect(await fieldLook(page)).toEqual(LIGHT_FIELD);
    await expect.poll(() => pxOf(page, '#setup-wizard .wiz-pane[data-wiz-key="appearance"] .wiz-copy', 'fontSize')).toBeCloseTo(textBefore, 1);
    await expect.poll(() => theme(other)).toEqual(['light', 'light']);
  } finally {
    await context.close();
  }
});

test("gate:appearance-ai the Assistant reads the look any time, and changes it only when asked @plugins", async ({ page, request }) => {
  test.setTimeout(180_000);
  await request.post(api('/api/prefs'), { data: { theme: 'light', text_scale: 1, icon_scale: 1 } });
  await request.post(api('/api/test/assistant/reset'), { data: {} });
  await useScriptedModel(request, host.base, fake, 'cloud');
  const call = (input) => ({ tools: [{ name: 'core__set_appearance', input: { theme: '', text_scale: 0, icon_scale: 0, person_asked: true, ...input } }] });
  let seen = [];
  const after = (reply) => (body) => {
    seen.push(...resultsIn(body));
    return reply;
  };
  const tabOf = trackTab(page);
  await page.goto(api('/#/'));
  await appReady(page);
  // The window's core page (its tools with it) is on the server before the first request.
  await expect
    .poll(async () => (await (await request.get(api('/api/assistant/tabs'))).json()).tabs.find((t) => t.tab === tabOf())?.core?.place, { timeout: 30_000 })
    .toBe('home');

  // Not asked for: refused, the look stays.
  fake.reply(() => call({ theme: 'dark', person_asked: false }), after({ text: 'Done.' }));
  await dockSend(page, 'What is my theme?');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(JSON.stringify(seen)).toContain('not_asked');
  expect(await theme(page)).toEqual(['light', 'light']);

  // Asked for: it reads, then sets; the window is dark at once, and the step says so as Settings does.
  seen = [];
  fake.reply(() => ({ tools: [{ name: 'core__appearance', input: {} }] }), after(call({ theme: 'dark', text_scale: 1.15 })), after({ text: 'Dark now.' }));
  await dockSend(page, 'Make it dark, with large text');
  await expect(dockTurn(page).locator('[data-turn-end="done"]')).toBeVisible({ timeout: 30_000 });
  expect(JSON.stringify(seen)).toContain('"shown":"light"');
  expect(JSON.stringify(seen)).toContain('"text_scale":[0.9,1,1.15,1.3]');
  expect(await theme(page)).toEqual(['dark', 'dark']);
  await expect(dockTurn(page)).toContainText('Now dark theme, text 115%, icons 100%');
  const saved = await (await request.get(api('/api/prefs'))).json();
  expect([saved.theme, saved.text_scale]).toEqual(['dark', 1.15]);
  expect(fake.pending(), 'scripted answers left unused').toBe(0);
  await request.post(api('/api/prefs'), { data: { theme: 'light', text_scale: 1 } });
});
