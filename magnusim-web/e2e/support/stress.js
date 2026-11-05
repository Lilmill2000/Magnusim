// The core's browser tests import `test` and `expect` from here, not from @playwright/test:
// the same `test`, with every page CPU-throttled when MAGNUSIM_E2E_CPU_THROTTLE=N is set
// (cpu-throttle.mjs; docs/TESTING.md, "Stress runs"). Unset, it is @playwright/test's own.
// Each page's goto and reload also checks that the app's stylesheets applied: when one did
// not, the page is reloaded once, or the test stops there with the reason (page-styles.mjs;
// docs/TESTING.md, "An unstyled page").
// Plugin suites get them through e2e/support/plugin-suite.js.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test as base } from '@playwright/test';
import { withCpuThrottle } from './cpu-throttle.mjs';
import { withStyleGuard } from './page-styles.mjs';

export const test = withStyleGuard(withCpuThrottle(base));
export { expect };
