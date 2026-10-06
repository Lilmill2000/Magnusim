// CAD e2e: runs against this checkout's host app (e2e/host-server.mjs starts it,
// or reuses a live one named by CAD_E2E_LOCK, or CAD_E2E_BASE_URL points at one).
//   npm run test:e2e                              bundled Chromium (functional), parallel workers
//   CAD_E2E_CHANNELS=chrome,msedge npm run test:e2e   also real Chrome / Edge
// Playwright's bundled Chromium caches sandboxed frames and does not isolate
// their process: load-time and crash-isolation checks need channel chrome/msedge.
// Run it through scripts/e2e.mjs (npm run test:e2e*), which sets the phase:
//   CAD_E2E_PHASE=parallel  every test but the @serial ones, on CAD_E2E_WORKERS workers;
//   CAD_E2E_PHASE=serial    the @serial tests only, one worker, output in test-results/serial;
//   unset                   every test on one worker (a plain `playwright test -c` call).
// CAD_E2E_SMOKE=1 keeps only the tests tagged @smoke.
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, type Project } from '@playwright/test';

const phase = process.env.CAD_E2E_PHASE || '';
const smoke = process.env.CAD_E2E_SMOKE === '1';
/** A test whose title and tags hold every one of these tags. */
const withTags = (tags: string[]) => new RegExp(tags.map((t) => `(?=.*${t}\\b)`).join(''));
const grep = phase === 'serial' ? withTags(['@serial', ...(smoke ? ['@smoke'] : [])]) : smoke ? withTags(['@smoke']) : undefined;
const grepInvert = phase === 'parallel' ? /@serial\b/ : undefined;
const filter = { ...(grep ? { grep } : {}), ...(grepInvert ? { grepInvert } : {}) };

const channels = (process.env.CAD_E2E_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const projects: Project[] = [{ name: 'chromium', use: { browserName: 'chromium' }, ...filter }];
for (const channel of channels) projects.push({ name: channel, use: { browserName: 'chromium', channel }, ...filter });

export default defineConfig({
  testDir: '.',
  // Area specs are TypeScript; the phase exit gates keep the proposal's names (cad-p1-document.spec.js).
  testMatch: /.*\.spec\.[jt]s$/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  // A spec file runs in order in one worker; files run side by side in the parallel phase.
  fullyParallel: false,
  workers: phase === 'parallel' ? Number(process.env.CAD_E2E_WORKERS) || 1 : 1,
  reporter: [['list']],
  outputDir: phase === 'serial' ? '../test-results/serial' : '../test-results',
  globalSetup: './global-setup.ts',
  use: {
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
});
