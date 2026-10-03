// Incompressible Flow's browser tests: its studies, run settings, meshes and solves,
// and the results views they feed. They run on the core's Playwright and app server
// (e2e/support/app-config.js); docs/TESTING.md, "A bundled plugin's own suite".
//   npx playwright test -c bundled-plugins/incompressible_flow/e2e/playwright.config.js
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSuiteConfig } from '../../../e2e/support/plugin-suite.js';

const here = dirname(fileURLToPath(import.meta.url));

// Its own projects (seed.js) are seeded after the core's.
export default appSuiteConfig({ name: 'incompressible_flow', testDir: here, seed: join(here, 'seed.js') });
