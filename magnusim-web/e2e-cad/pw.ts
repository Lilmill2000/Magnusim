// One Playwright for these specs and the CAD plugin's e2e helpers they reuse
// (bundled-plugins/cad/e2e/helpers.ts): the plugin's own copy, which npm run test:e2e:cad runs.
// Two copies in one run refuse to load ("Requiring @playwright/test second time").
// SPDX-License-Identifier: GPL-3.0-or-later
export * from '../bundled-plugins/cad/node_modules/@playwright/test/index.mjs';
