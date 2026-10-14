// CPU throttling for browser tests, for stress runs (docs/TESTING.md, "Stress runs").
//
// MAGNUSIM_E2E_CPU_THROTTLE=N (N > 1) slows every page of a test's browser context N times
// through the DevTools protocol (Emulation.setCPUThrottlingRate): the page's own JavaScript
// runs as on a slow CI runner while the app server keeps its speed, which is what brings out
// a race between the page and the server's answers. Unset, empty or <= 1: no effect, and no
// DevTools session is opened.
//
// Each page of the context is throttled when it opens (the test's `page` before the test
// starts; a popup or a second tab as it appears), and so is every frame of it that runs in a
// process of its own (a sandboxed workspace frame can): Chromium's throttle is per renderer
// process, so a frame in its page's process is slowed with the page. A context the test makes
// itself (browser.newContext()) is not.
//
// Dependency-free on purpose: the core's harness (e2e/support/stress.js) and CAD's own
// Playwright (bundled-plugins/cad/e2e/stress.ts) each wrap their own @playwright/test with it.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The throttle rate MAGNUSIM_E2E_CPU_THROTTLE asks for, or 0 (none). */
export function cpuThrottleRate(env = process.env) {
  const n = Number(env.MAGNUSIM_E2E_CPU_THROTTLE);
  return Number.isFinite(n) && n > 1 ? n : 0;
}

let told = false;

/** Throttle one page, or one frame that has its own process; false when it has none (or is gone). */
async function throttle(context, target, rate) {
  try {
    const session = await context.newCDPSession(target);
    await session.send('Emulation.setCPUThrottlingRate', { rate });
    return true;
  } catch {
    // A frame in its page's process has no session of its own: the page's throttle covers it.
    return false;
  }
}

/**
 * `base` (a Playwright `test`) with every page of each test's context CPU-throttled while
 * MAGNUSIM_E2E_CPU_THROTTLE is set; `base` itself when it is not.
 * @template T
 * @param {T} base
 * @returns {T}
 */
export function withCpuThrottle(base) {
  const rate = cpuThrottleRate();
  if (!rate) return base;
  // Each page once: its throttle (awaited by the `page` fixture) and its own-process frames.
  const started = new WeakMap();
  const start = (context, page) => {
    let done = started.get(page);
    if (!done) {
      const onFrame = (frame) => {
        if (frame.parentFrame()) void throttle(context, frame, rate);
      };
      page.on('frameattached', onFrame);
      page.on('framenavigated', onFrame);
      done = throttle(context, page, rate);
      started.set(page, done);
    }
    return done;
  };
  return /** @type {any} */ (base).extend({
    context: async ({ context }, use) => {
      if (!told) {
        told = true;
        console.log(`[stress] pages CPU-throttled ${rate}x (MAGNUSIM_E2E_CPU_THROTTLE=${process.env.MAGNUSIM_E2E_CPU_THROTTLE})`);
      }
      // A page opened later (a popup, a second tab): throttled as it appears.
      context.on('page', (page) => void start(context, page));
      await use(context);
    },
    // The test's own page: throttled before the test starts.
    page: async ({ context, page }, use) => {
      await start(context, page);
      await use(page);
    },
  });
}
