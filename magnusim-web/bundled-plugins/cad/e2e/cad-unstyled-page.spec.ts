// The harness's guard against an unstyled host page (the core's e2e/support/page-styles.mjs,
// magnusim-web/docs/TESTING.md "An unstyled page"). On 2026-10-28 cad:p4b-fu-no-not-allowed
// waited out its 240 s on the CAD header button in newPartFromTree: /src/style.css had failed
// with net::ERR_NO_BUFFER_SPACE in a long, loaded run, so the 3D view's canvas covered the whole
// window and took the click. Here the test fails that request itself, once: openProject (or
// newPartFromTree, on a page the spec opened itself) reloads the page and the Part opens.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
import { baseUrl, newPartFromTree, newProject, openProject, partOpened } from './helpers';

/** Fails the first request for the host's /src/style.css as a dropped connection does; counts every request. */
async function failStyleOnce(page: Page) {
  const asked = { n: 0 };
  await page.route(/\/src\/style\.css(\?|$)/, async (route) => {
    asked.n += 1;
    if (asked.n === 1) await route.abort('addressunreachable');
    else await route.continue();
  });
  return asked;
}

/** The guard's log lines (it logs to the test's output) while `fn` runs. */
async function logsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
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

const RELOADED = /^\[e2e\] the app page is unstyled: \/src\/style\.css did not load \(.+\); reloading it once$/;

test('cad:unstyled-open openProject reloads a page whose style.css failed, and the CAD menu makes Part 1', async ({ page, request }) => {
  const pid = await newProject(request);
  const asked = await failStyleOnce(page);
  const lines = await logsOf(() => openProject(page, pid));
  expect(lines).toContainEqual(expect.stringMatching(/^\[e2e\] the app page is unstyled: \/src\/style\.css did not load \(net::ERR_ADDRESS_UNREACHABLE\); reloading it once$/));
  expect(asked.n, 'the reload asked for style.css again').toBe(2);
  await newPartFromTree(page, 'Part 1');
  await partOpened(page);
});

test('cad:unstyled-new-part newPartFromTree reloads a page the spec opened itself while its style.css had failed', async ({ page, request }) => {
  const pid = await newProject(request);
  const asked = await failStyleOnce(page);
  await page.goto(`${baseUrl()}/#/p/${pid}`);
  await page.waitForFunction((id) => (window as unknown as { __CFD_PROJECT_READY__?: string }).__CFD_PROJECT_READY__ === id, pid, { timeout: 90_000 });
  const lines = await logsOf(() => newPartFromTree(page, 'Part 1'));
  expect(lines).toContainEqual(expect.stringMatching(RELOADED));
  expect(asked.n).toBe(2);
  await partOpened(page);
});
