// Heat Transfer's browser tests: its studies (settings, materials, Thermal BC fields in
// the project's temperature unit), its finished results (legend in °C / °F, monitors and
// the energy balance) and, with WSL, a heated cavity meshed and solved through the app.
// They run on the core's Playwright and app server (e2e/support/app-config.js);
// docs/TESTING.md, "A bundled plugin's own suite".
//   npx playwright test -c bundled-plugins/heat_transfer/e2e/playwright.config.js
// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSuiteConfig } from '../../../e2e/support/plugin-suite.js';

const here = dirname(fileURLToPath(import.meta.url));

export default appSuiteConfig({ name: 'heat_transfer', testDir: here });
