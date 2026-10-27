// Magnusim CAD's browser tests (e2e-cad/): the CAD edition's page and server, from
// source, with no Python and no WSL (e2e-cad/server.mjs). npm run test:e2e:cad.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The CAD plugin's Playwright (e2e-cad/pw.ts says why).
import { defineConfig } from './bundled-plugins/cad/node_modules/@playwright/test/index.mjs';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.MAGNUSIM_CAD_E2E_PORT || '8092';
const baseURL = `http://127.0.0.1:${PORT}`;
// The CAD plugin's helpers (bundled-plugins/cad/e2e/helpers.ts) find the app here.
process.env.CAD_E2E_BASE_URL = baseURL;

export default defineConfig({
  testDir: join(WEB_ROOT, 'e2e-cad'),
  outputDir: join(WEB_ROOT, 'test-results', 'cad-edition'),
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.GITHUB_ACTIONS ? [['github'], ['list']] : 'list',
  use: { baseURL, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: `node e2e-cad/server.mjs ${PORT}`,
    cwd: WEB_ROOT,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: join(WEB_ROOT, 'e2e', `.tmp-projects-cad-${PORT}`),
      MAGNUSIM_LOCAL_JSON: join(WEB_ROOT, 'e2e', `.tmp-prefs-cad-${PORT}.json`),
      MAGNUSIM_ASSISTANT_HOME: join(WEB_ROOT, 'e2e', `.tmp-prefs-cad-${PORT}.assistant`),
    },
  },
});
