// Incompressible Flow's browser tests: its studies, run settings, meshes and solves,
// and the results views they feed. They run on the core's Playwright and app server
// (e2e/support/app-config.js); docs/TESTING.md, "A bundled plugin's own suite".
//   npx playwright test -c bundled-plugins/incompressible_flow/e2e/playwright.config.js
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSuiteConfig } from '../../../e2e/support/app-config.js';

export default appSuiteConfig({ name: 'incompressible_flow', testDir: dirname(fileURLToPath(import.meta.url)) });
