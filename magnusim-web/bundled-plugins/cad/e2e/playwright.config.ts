// CAD e2e: runs against this checkout's host app (e2e/host-server.mjs starts it,
// or reuses a live one named by CAD_E2E_LOCK, or CAD_E2E_BASE_URL points at one).
//   npm run test:e2e                              bundled Chromium (functional)
//   CAD_E2E_CHANNELS=chrome,msedge npm run test:e2e   also real Chrome / Edge
// Playwright's bundled Chromium caches sandboxed frames and does not isolate
// their process: load-time and crash-isolation checks need channel chrome/msedge.
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, type Project } from '@playwright/test';

const channels = (process.env.CAD_E2E_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const projects: Project[] = [{ name: 'chromium', use: { browserName: 'chromium' } }];
for (const channel of channels) projects.push({ name: channel, use: { browserName: 'chromium', channel } });

export default defineConfig({
  testDir: '.',
  // Area specs are TypeScript; the phase exit gates keep the proposal's names (cad-p1-document.spec.js).
  testMatch: /.*\.spec\.[jt]s$/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results',
  globalSetup: './global-setup.ts',
  use: {
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
});
