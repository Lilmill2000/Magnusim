import { expect, test } from '@playwright/test';
import { startHost } from './support/host-server.mjs';

// A workspace connects whatever order its frame's events come in. The page says hello as
// its script runs; the app welcomes it once it has read the study; the frame's load event
// can come before that welcome, long after it, or again for a real reload. In Edge the
// CAD page's load came 1 ms after its hello, before the welcome: the app took it for a new
// page, probed a page that answers only once welcomed, dropped the channel, and showed
// "<Plugin> didn't start" 5 s later (418df9a). A browser does not pick the order on demand,
// so each case forces it (the study read held back, or a slow image in the page) and
// records the order it got, so a pass cannot be a lucky order.
const KEY = 'ws-demo';
const PROJECT = 'sample-project-steady-state-e2e';
const FRAME_URL = `/plugins/${KEY}/workspace/index.html`;

/** The app's page records, per frame element, when its page said hello, when the frame loaded and when the app welcomed it. */
function recordFrameOrder() {
  if (window.top !== window) return;
  window.__frameOrder = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const seen = new WeakSet();
  const watch = () => {
    const f = document.querySelector('#workspace-frame');
    if (!f || seen.has(f)) return;
    seen.add(f);
    const row = { hellos: [], loads: [], welcomed: [] };
    window.__frameOrder.push(row);
    f.addEventListener('load', () => row.loads.push(at()));
    window.addEventListener('message', (e) => {
      if (e.source === f.contentWindow && e.data && e.data.magnusim === 'hello') row.hellos.push(at());
    });
    // The bridge marks the frame (data-ws-hello) when it has welcomed the page.
    new MutationObserver(() => {
      if (f.dataset.wsHello === '1') row.welcomed.push(at());
    }).observe(f, { attributes: true, attributeFilter: ['data-ws-hello'] });
  };
  new MutationObserver(watch).observe(document, { childList: true, subtree: true });
}

/** The workspace frame, once its page is connected (its title is the study's). */
async function connected(page, title) {
  await expect(page.frameLocator('#workspace-frame').locator('#bench-title')).toHaveText(title, { timeout: 60_000 });
  const frame = page.frames().find((f) => f.url().includes(FRAME_URL));
  expect(frame, 'workspace frame').toBeTruthy();
  return frame;
}

/** Past the app's 5 s hello wait and its 1.5 s probe: still connected, no card, a call answers. */
async function staysConnected(page, title) {
  await page.waitForTimeout(6_500);
  await expect(page.getByText("didn't start")).toHaveCount(0);
  const frame = page.frames().find((f) => f.url().includes(FRAME_URL));
  expect(await frame.evaluate(() => window.__ws.study.get().then((s) => s.title))).toBe(title);
}

test.describe('workspace handshake orders', () => {
  /** @type {Awaited<ReturnType<typeof startHost>>} */
  let host;
  test.beforeAll(async () => {
    host = await startHost({ name: 'handshake', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  });
  test.afterAll(async () => {
    await host?.stop();
  });

  /** A study of its own for each case. */
  async function study(request, title) {
    const r = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind: 'bench_case', title } });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).study.id;
  }

  test('gate:handshake the load event comes between the hello and the welcome (Edge, CAD): no probe of an unwelcomed page, it connects and stays @plugins', async ({ page, request }) => {
    test.setTimeout(120_000);
    const sid = await study(request, 'Load first');
    await page.addInitScript(recordFrameOrder);
    // Hello, then load, then welcome: the page's image (#bench-pixel) holds its load event
    // back 0.5 s, past its hello; the app reads the study before it welcomes the page, and
    // that read is held back 2.5 s.
    await page.route(`**/plugins/${KEY}/workspace/pixel.svg`, async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await page.route('**/api/plugin-studies/get**', async (route) => {
      await new Promise((r) => setTimeout(r, 2_500));
      await route.continue();
    });
    await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/bench/${sid}`);
    await connected(page, 'Load first');
    const [row] = await page.evaluate(() => window.__frameOrder);
    expect(row.loads.length, 'the frame loaded').toBeGreaterThanOrEqual(1);
    expect(row.welcomed.length, 'the app welcomed the page').toBe(1);
    expect(row.hellos.length, 'the page said hello').toBeGreaterThanOrEqual(1);
    expect(row.hellos[0], 'forced: hello before load').toBeLessThan(row.loads[0]);
    expect(row.loads[0], 'forced: load before the welcome').toBeLessThan(row.welcomed[0]);
    await staysConnected(page, 'Load first');
  });

  test('gate:handshake the load event comes long after the welcome: its probe is answered and the channel stays @plugins', async ({ page, request }) => {
    test.setTimeout(120_000);
    const sid = await study(request, 'Load late');
    await page.addInitScript(recordFrameOrder);
    // The page's image (#bench-pixel) holds its load event back 3 s; an image does not hold
    // back the script, so the hello and the welcome come first. (The page itself is not
    // rewritten: a page Playwright fulfils loses its local address space, and Chromium then
    // blocks its own loads from 127.0.0.1.)
    await page.route(`**/plugins/${KEY}/workspace/pixel.svg`, async (route) => {
      await new Promise((r) => setTimeout(r, 3_000));
      await route.continue();
    });
    await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/bench/${sid}`);
    await connected(page, 'Load late');
    await expect.poll(() => page.evaluate(() => window.__frameOrder[0]?.loads.length || 0), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const [row] = await page.evaluate(() => window.__frameOrder);
    expect(row.welcomed.length).toBe(1);
    expect(row.loads[0], 'forced: load after the welcome').toBeGreaterThan(row.welcomed[0] + 1_000);
    await staysConnected(page, 'Load late');
  });

  test('gate:handshake a real reload of the page says hello again and connects the new page @plugins', async ({ page, request }) => {
    test.setTimeout(120_000);
    const sid = await study(request, 'Reloaded');
    await page.addInitScript(recordFrameOrder);
    await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/bench/${sid}`);
    const first = await connected(page, 'Reloaded');
    const before = await first.evaluate(() => window.__benchLoadId);
    await first.evaluate(() => location.reload());
    await expect.poll(async () => {
      const f = page.frames().find((x) => x.url().includes(FRAME_URL));
      return f ? f.evaluate(() => (window.__ws ? window.__benchLoadId : '')).catch(() => '') : '';
    }, { timeout: 30_000 }).not.toMatch(new RegExp(`^(${before})?$`));
    const [row] = await page.evaluate(() => window.__frameOrder);
    expect(row.loads.length, 'two loads of one frame').toBeGreaterThanOrEqual(2);
    await staysConnected(page, 'Reloaded');
  });
});
