// Shared steps of the tunnel's browser tests: an app server with the plugin on, a tunnel
// opened in its workspace, and the page's test handle (window.__TUNNEL__).
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { e2eTemp, NO_GEOMETRY_PROJECT, startHost } from '../../../e2e/support/plugin-suite.js';

export const KEY = 'tunnel2d';
export const KIND = 'tunnel';
export const PROJECT = NO_GEOMETRY_PROJECT;

/**
 * Start this file's server in beforeAll and stop it in afterAll. Returns a getter for the
 * host and the reasons GPU tests skip (no WebGPU at all; only the software adapter).
 */
export function useTunnelHost(name) {
  const state = { host: null, noGpu: '', slowGpu: '' };
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const tmp = e2eTemp(name);
    state.host = await startHost({ name, tmp, enablePlugins: [KEY], viteCacheDir: join(tmp, 'vite-cache') });
    const page = await browser.newPage();
    await page.goto(`${state.host.base}/api/registry`);
    const adapter = await page.evaluate(async () => {
      const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      if (!a) return null;
      const i = a.info ?? {};
      return { software: !!i.isFallbackAdapter || /swiftshader/i.test(`${i.vendor} ${i.architecture} ${i.description}`) };
    });
    await page.close();
    if (!adapter) state.noGpu = "this browser offers no WebGPU adapter (not even Chrome's software one), so the flow cannot run here";
    else if (adapter.software) state.slowGpu = 'only the software WebGPU adapter (SwiftShader) is here: it runs the flow about a thousand times slower than a GPU, so this test runs where there is one (it does on every local run)';
  });
  test.afterAll(() => state.host?.stop());
  return {
    get host() {
      return state.host;
    },
    needsGpu: () => test.skip(!!state.noGpu, state.noGpu),
    needsFastGpu: () => test.skip(!!(state.noGpu || state.slowGpu), state.noGpu || state.slowGpu),
  };
}

export async function newTunnel(host, request, title) {
  const made = await request.post(`${host.base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind: KIND, title } });
  expect(made.ok(), await made.text()).toBe(true);
  return (await made.json()).study;
}

/** Open a tunnel and wait for its page to run; returns the frame. */
export async function openTunnel(host, page, study) {
  await page.goto(`${host.base}/#/p/${PROJECT}/ws/${KEY}/${KIND}/${study.id}`);
  await expect(page.locator('#workspace-overlay')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#workspace-overlay [data-ws-crumb]')).toContainText(study.title, { timeout: 60_000 });
  let frame = null;
  await expect.poll(() => (frame = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/`))) && true, { timeout: 60_000 }).toBe(true);
  await expect.poll(() => frame.evaluate(() => !!window.__TUNNEL__?.ready).catch(() => false), { timeout: 90_000 }).toBe(true);
  return frame;
}

export const T = (frame, fn, arg) => frame.evaluate(fn, arg);
export const scene = (frame) => T(frame, () => window.__TUNNEL__.scene());
export const stats = (frame) => T(frame, () => window.__TUNNEL__.stats());

/** Frame-internal CSS px -> page px. */
export async function pageXY(page, xy) {
  const box = await page.locator('#workspace-frame').boundingBox();
  return { x: box.x + xy.x, y: box.y + xy.y };
}

/** A world point's position on the page. */
export async function worldToPage(page, frame, x, y) {
  return pageXY(page, await T(frame, ([a, b]) => window.__TUNNEL__.toScreen(a, b), [x, y]));
}

/** Flip a kit toggle (its input is hidden behind the switch it draws). */
export async function toggle(frame, label) {
  await frame.locator(`label.mgk-switch:has(input[aria-label="${label}"])`).click();
}
