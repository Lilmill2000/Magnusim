// The Airfoil plugin's browser tests. Each test starts its own app server
// (e2e/support/host-server.mjs) with the plugin turned on, so this config starts none.
//   npx playwright test -c bundled-plugins/airfoil/e2e/playwright.config.js    (from magnusim-web)
// The NeuralFoil test (gate:h17-e2e) needs the plugin's environment from requirements.lock:
// it runs when that is already built (.cache/plugin-envs/) or MAGNUSIM_E2E_NETWORK=1 allows
// the download (about 200 MB from PyPI); otherwise it is skipped with that reason, except in
// the full tier (MAGNUSIM_E2E_WSL=1 or MAGNUSIM_E2E_FULL=1), where it fails with it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { settleE2eToolchain } from '../../../e2e/support/plugin-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..', '..', '..');

// WSL with OpenFOAM settled once, as every app suite does (e2e/toolchain.js): the full tier
// then runs gate:h17-openfoam-2d where WSL is here, instead of skipping it. The gate takes
// the PC's WSL test lock itself.
settleE2eToolchain();

export default defineConfig({
  testDir: HERE,
  outputDir: join(WEB_ROOT, 'test-results', 'airfoil'),
  timeout: 1_200_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.GITHUB_ACTIONS ? [['github'], ['list']] : 'list',
  use: { headless: true, trace: 'on-first-retry' },
});
