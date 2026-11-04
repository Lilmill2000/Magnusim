// The harness's guard against an unstyled app page (e2e/support/page-styles.mjs; docs/TESTING.md,
// "An unstyled page"). On 2026-10-28 a CAD test waited out its 4 minutes on one click:
// /src/style.css had failed with net::ERR_NO_BUFFER_SPACE (Windows, out of socket buffers in a
// long, loaded run), so the 3D view's canvas covered the whole window and took every click. Here
// the test fails that stylesheet's request itself: once (the guard reloads the page and the test
// goes on, styled) or every time (the test stops at its goto within seconds, naming the
// stylesheet and the error). No WSL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { NO_GEOMETRY_PROJECT } from './prepare-projects.js';
import { appReady } from './support/assistant.js';
import { ensureStyled } from './support/page-styles.mjs';
import { expect, test } from './support/stress.js';

const STYLE = /\/src\/style\.css(\?|$)/;

/** Fails the first `times` requests for /src/style.css as a dropped connection does; counts every request. */
async function failStyle(page, times) {
  const asked = { n: 0 };
  await page.route(STYLE, async (route) => {
    asked.n += 1;
    if (asked.n <= times) await route.abort('addressunreachable');
    else await route.continue();
  });
  return asked;
}

/** `.main-row`'s position: style.css makes it 'relative' (the 3D view stays inside it); unstyled, 'static'. */
const mainRowPosition = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.main-row');
    return row ? getComputedStyle(row).position : 'no .main-row';
  });

/** The guard's log lines (it logs to the test's output) while `fn` runs. */
async function logsOf(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
    log(...args);
  };
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines;
}

test('e2e-guard:unstyled-reload a stylesheet that failed once: the goto reloads the page and the test goes on with the app styled', async ({ page }) => {
  const asked = await failStyle(page, 1);
  const lines = await logsOf(() => page.goto('/#/'));
  expect(asked.n, 'style.css was asked again by the reload').toBe(2);
  expect(lines).toContainEqual(expect.stringMatching(/^\[e2e\] the app page is unstyled: \/src\/style\.css did not load \(net::ERR_ADDRESS_UNREACHABLE\); reloading it once$/));
  expect(lines).toContain('[e2e] the reload styled the page');
  expect(await mainRowPosition(page)).toBe('relative');
  // The app comes up on the reloaded page; appReady checks the same document only once.
  await appReady(page);
  await page.locator('#home-prefs').click();
  await expect(page.locator('#setup-wizard')).toBeVisible();
});

test('e2e-guard:unstyled-stop a stylesheet that fails every time: the goto stops the test in seconds, naming the stylesheet and the error', async ({ page }) => {
  const asked = await failStyle(page, Infinity);
  const t0 = Date.now();
  const error = await page.goto('/#/').then(
    () => null,
    (e) => e,
  );
  const ms = Date.now() - t0;
  expect(error, 'the goto threw').not.toBeNull();
  expect(error.message).toMatch(/^The app page is unstyled, also after a reload: \/src\/style\.css did not load \(net::ERR_ADDRESS_UNREACHABLE\)\./);
  expect(error.message).toContain('net::ERR_NO_BUFFER_SPACE');
  expect(asked.n, 'one reload, no more').toBe(2);
  expect(ms, 'seconds, not the test timeout').toBeLessThan(30_000);
});

test('e2e-guard:unstyled-ready a page the harness did not open (a context of its own): unstyled, the canvas takes the clicks; appReady reloads it once and the tree is clickable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    const asked = await failStyle(page, 1);
    await page.goto(`/#/p/${NO_GEOMETRY_PROJECT}`);
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, NO_GEOMETRY_PROJECT, { timeout: 90_000 });
    // What the CAD test met: without style.css the 3D view's canvas lies over the tree.
    const onTree = () =>
      page.evaluate(() => {
        const r = document.querySelector('#left-tree').getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40))?.tagName ?? null;
      });
    expect(await mainRowPosition(page)).toBe('static');
    expect(await onTree()).toBe('CANVAS');
    const lines = await logsOf(() => appReady(page));
    expect(lines).toContainEqual(expect.stringMatching(/^\[e2e\] the app page is unstyled: \/src\/style\.css did not load \(.+\); reloading it once$/));
    expect(asked.n).toBe(2);
    expect(await mainRowPosition(page)).toBe('relative');
    await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, NO_GEOMETRY_PROJECT, { timeout: 90_000 });
    expect(await onTree()).not.toBe('CANVAS');
    // A new document is checked again, not taken for the one already found styled: the page
    // reloaded (this context's pages are not guarded) with style.css failing once more.
    await page.unroute(STYLE);
    const again = await failStyle(page, 1);
    await page.reload();
    expect(await mainRowPosition(page)).toBe('static');
    expect(await ensureStyled(page)).toBe('reloaded');
    expect(again.n).toBe(2);
    expect(await mainRowPosition(page)).toBe('relative');
  } finally {
    await context.close();
  }
});
