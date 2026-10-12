// The 2D Wind Tunnel's browser tests. Each test file starts its own app server
// (e2e/support/host-server.mjs) with the plugin turned on, so this config starts none.
//   npx playwright test -c bundled-plugins/tunnel2d/e2e/playwright.config.js    (from magnusim-web)
// WebGPU: Playwright's own Chromium has no WebGPU adapter, so these run on the installed
// Chrome (channel "chrome"). Where there is no GPU (CI), set MAGNUSIM_E2E_WEBGPU=swiftshader:
// Chrome's software WebGPU gives the same results, slowly.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { settleE2eToolchain } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..', '..', '..');
// Settled once, as every app suite does (e2e/toolchain.js); this suite needs no WSL.
settleE2eToolchain();

const SOFTWARE = process.env.MAGNUSIM_E2E_WEBGPU === 'swiftshader' || (!!process.env.CI && process.env.MAGNUSIM_E2E_WEBGPU !== 'gpu');

export default defineConfig({
  testDir: HERE,
  outputDir: join(WEB_ROOT, 'test-results', 'tunnel2d'),
  timeout: 600_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.GITHUB_ACTIONS ? [['github'], ['list']] : 'list',
  use: {
    headless: true,
    channel: 'chrome',
    viewport: { width: 1600, height: 960 },
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-unsafe-webgpu', ...(SOFTWARE ? ['--use-webgpu-adapter=swiftshader'] : [])] },
  },
});
