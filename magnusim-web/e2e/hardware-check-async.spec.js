// Settings > This PC no longer freezes the app (Assistant phase 5 spec 8.5, finding 9). The
// check ran PowerShell, `simpleFoam -help` in WSL and lscpu with spawnSync: the whole server
// stopped answering for up to about two minutes, so every other window hung. Now each probe
// is a child process the server waits for without blocking.
// Its own server with MAGNUSIM_TEST_COMPUTE=fake: each probe takes MAGNUSIM_TEST_HW_PROBE_MS
// (as a cold WSL does; each is a real child process), so the check takes 8 to 12 s here. While one window checks this PC,
// another window opens a project and its tree shows, and the app answers within a second.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seedElbowProject } from './prepare-projects.js';
import { e2eTemp, startHost } from './support/host-server.mjs';

const PID = 'hardware-check-e2e';
const PROBE_MS = 4_000;
let host;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const tmp = e2eTemp('hw-check');
  const projects = join(tmp, 'projects');
  mkdirSync(projects, { recursive: true });
  seedElbowProject(projects, PID, 'This PC check');
  host = await startHost({ name: 'hw-check', tmp, projects, env: { MAGNUSIM_TEST_COMPUTE: 'fake', MAGNUSIM_TEST_HW_PROBE_MS: String(PROBE_MS) } });
});

test.afterAll(() => {
  host?.stop();
});

test('while This PC checks, another window opens a project and the app keeps answering', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const base = host.base;
  const settings = await browser.newPage();
  const other = await browser.newPage();
  try {
    await settings.goto(`${base}/#/`);
    // Settings opens the wizard once the page has wired its button.
    await expect(async () => {
      await settings.locator('#home-prefs').click();
      await expect(settings.locator('#setup-wizard')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    const checked = settings.waitForResponse((r) => r.url().endsWith('/api/prefs/hardware-check'), { timeout: 120_000 });
    await settings.locator('#wiz-rail li[data-wiz-key="pc"]').click();
    await expect(settings.locator('#wiz-hw-status')).toContainText('Checking this PC');
    const t0 = Date.now();

    // Another window, meanwhile: the project opens and its tree shows.
    await other.goto(`${base}/#/p/${PID}`);
    await other.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, PID, { timeout: 60_000 });
    await expect(other.locator('#left-tree [data-w20-mesh-item]').first()).toBeVisible({ timeout: 30_000 });
    // And every request answers within a second while the check still runs.
    const slowest = [];
    while (Date.now() - t0 < 1.5 * PROBE_MS) {
      const a = Date.now();
      const r = await request.get(`${base}/api/project/tree?project_id=${PID}`);
      expect(r.ok()).toBe(true);
      slowest.push(Date.now() - a);
      await new Promise((r2) => setTimeout(r2, 250));
    }
    expect(Math.max(...slowest), `answers while the check ran (ms): ${slowest.join(', ')}`).toBeLessThan(1_000);
    // The check was still running all that while (two or three probes of PROBE_MS each: PowerShell's on Windows).
    await expect(settings.locator('#wiz-hw-status')).toContainText('Checking this PC');

    // Then it ends, and the window that asked shows the result.
    const answer = await checked;
    expect(answer.status()).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1.8 * PROBE_MS);
    await expect(settings.locator('#wiz-hw-status')).toHaveText('Applied to this installation.', { timeout: 30_000 });
    await expect(settings.locator('#wiz-hw-result')).toBeVisible();
    await expect(settings.locator('#wiz-hw-result')).toContainText('4');
  } finally {
    await settings.close();
    await other.close();
  }
});
