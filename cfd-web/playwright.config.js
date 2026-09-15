import { defineConfig } from '@playwright/test';
import { prepareE2eProjectsRoot } from './e2e/prepare-projects.js';

const PORT = process.env.MAGNUSIM_E2E_PORT || '8083';
const baseURL = `http://127.0.0.1:${PORT}`;
const projectsRoot = process.env.MAGNUSIM_E2E_PROJECTS_ROOT || prepareE2eProjectsRoot();
process.env.MAGNUSIM_PROJECTS_ROOT = projectsRoot;

export default defineConfig({
  testDir: './e2e',
  timeout: 900_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      MAGNUSIM_PROJECTS_ROOT: projectsRoot,
      MAGNUSIM_PORT: String(PORT),
      MAGNUSIM_BOUND_PORT: String(PORT),
    },
  },
});
