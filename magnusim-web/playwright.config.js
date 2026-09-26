import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { settleE2eToolchain } from './e2e/toolchain.js';

const PORT = process.env.MAGNUSIM_E2E_PORT || '8083';
const baseURL = `http://127.0.0.1:${PORT}`;
const projectsRoot = process.env.MAGNUSIM_E2E_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
process.env.MAGNUSIM_PROJECTS_ROOT = projectsRoot;
const prefsPath = resolve('e2e/.tmp-prefs.json');
// Every test runs by default; real meshes and solves need WSL with OpenFOAM (see e2e/toolchain.js).
const toolchain = settleE2eToolchain();

export default defineConfig({
  testDir: './e2e',
  timeout: toolchain.wsl ? 900_000 : 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node e2e/prepare-projects.js && npm run dev',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projectsRoot,
      MAGNUSIM_LOCAL_JSON: prefsPath,
      MAGNUSIM_PORT: String(PORT),
      // The app ships no plugins; the plugin gates load test plugins from here.
      MAGNUSIM_PLUGINS_DIR: resolve('python/tests/fixtures/plugins'),
      MAGNUSIM_BOUND_PORT: String(PORT),
    },
  },
});
