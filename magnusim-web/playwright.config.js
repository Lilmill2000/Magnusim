import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = process.env.MAGNUSIM_E2E_PORT || '8083';
const baseURL = `http://127.0.0.1:${PORT}`;
const projectsRoot = process.env.MAGNUSIM_E2E_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
process.env.MAGNUSIM_PROJECTS_ROOT = projectsRoot;
const prefsPath = resolve('e2e/.tmp-prefs.json');

export default defineConfig({
  testDir: './e2e',
  timeout: (process.env.MAGNUSIM_E2E_WSL || process.env.CFDDESK_E2E_WSL) === '1' ? 900_000 : 60_000,
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
      MAGNUSIM_BOUND_PORT: String(PORT),
    },
  },
});
