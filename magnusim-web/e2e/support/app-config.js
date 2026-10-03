// The Playwright config of every suite that runs on the core's Playwright: the core
// (playwright.config.js) and a bundled plugin's own suite
// (bundled-plugins/<key>/e2e/playwright.config.js). Each gets the app server on
// MAGNUSIM_E2E_PORT with freshly seeded test projects (e2e/prepare-projects.js), the
// WSL toolchain settled once (e2e/toolchain.js) and the PC's WSL test lock
// (e2e/global-setup.js). docs/TESTING.md.
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { settleE2eToolchain } from '../toolchain.js';

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {object} o
 * @param {string} o.testDir  the suite's spec folder (absolute)
 * @param {string} [o.name]   'core', or the plugin's key (its output goes to test-results/<key>)
 * @param {string} [o.seed]   a plugin suite's seed module (absolute path): its default export
 *                            seeds the suite's own projects into the projects root, after the core's
 *                            (e2e/support/seed-suite.js)
 */
export function appSuiteConfig({ testDir, name = 'core', seed = '' }) {
  const PORT = process.env.MAGNUSIM_E2E_PORT || '8083';
  const baseURL = `http://127.0.0.1:${PORT}`;
  const projectsRoot = process.env.MAGNUSIM_E2E_PROJECTS_ROOT || join(WEB_ROOT, 'e2e', '.tmp-projects');
  process.env.MAGNUSIM_PROJECTS_ROOT = projectsRoot;
  // Test servers never sweep the WSL case root, which holds this PC's real cases
  // (wsl-prune.spec.js turns the sweep on for its own server and its own root).
  process.env.MAGNUSIM_WSL_PRUNE ??= '0';
  const prefsPath = join(WEB_ROOT, 'e2e', '.tmp-prefs.json');
  // Every test runs by default; real meshes and solves need WSL with OpenFOAM (see e2e/toolchain.js).
  const toolchain = settleE2eToolchain();

  return defineConfig({
    testDir,
    outputDir: name === 'core' ? join(WEB_ROOT, 'test-results') : join(WEB_ROOT, 'test-results', name),
    // A run that may mesh or solve in WSL waits for the PC's WSL test lock (docs/TESTING.md).
    globalSetup: join(WEB_ROOT, 'e2e', 'global-setup.js'),
    timeout: toolchain.wsl ? 900_000 : 60_000,
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    // On GitHub Actions each failure also becomes an annotation, which anyone can read
    // on the run page and through the API (the step log needs a signed-in account).
    reporter: process.env.GITHUB_ACTIONS ? [['github'], ['list']] : 'list',
    use: {
      baseURL,
      headless: true,
      trace: 'on-first-retry',
    },
    webServer: {
      command: seed
        ? `node e2e/prepare-projects.js && node e2e/support/seed-suite.js "${resolve(seed)}" && npm run dev`
        : 'node e2e/prepare-projects.js && npm run dev',
      cwd: WEB_ROOT,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        MAGNUSIM_PROJECTS_ROOT: projectsRoot,
        MAGNUSIM_LOCAL_JSON: prefsPath,
        MAGNUSIM_PORT: String(PORT),
        // The app ships no plugins; the plugin gates load test plugins from here.
        // MAGNUSIM_E2E_PLUGINS_DIR overrides it (CI's core-without-user-plugins job
        // points it at an empty folder and skips the @plugins tests).
        MAGNUSIM_PLUGINS_DIR: process.env.MAGNUSIM_E2E_PLUGINS_DIR
          ? resolve(process.env.MAGNUSIM_E2E_PLUGINS_DIR)
          : join(WEB_ROOT, 'python', 'tests', 'fixtures', 'plugins'),
        MAGNUSIM_BOUND_PORT: String(PORT),
      },
    },
  });
}
