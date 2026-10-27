// Magnusim CAD's desktop app tests (e2e-desktop/): Electron launches desktop/main.mjs, which
// starts its own server. npm run test:e2e:desktop (after npm install in desktop/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The CAD plugin's Playwright (e2e-cad/pw.ts says why).
import { defineConfig } from './bundled-plugins/cad/node_modules/@playwright/test/index.mjs';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  testDir: join(WEB_ROOT, 'e2e-desktop'),
  outputDir: join(WEB_ROOT, 'test-results', 'desktop'),
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
