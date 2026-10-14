// CAD's specs import `test` and `expect` from here: CAD's own @playwright/test, with every page
// CPU-throttled when MAGNUSIM_E2E_CPU_THROTTLE=N is set (the core's
// e2e/support/cpu-throttle.mjs; magnusim-web/docs/TESTING.md, "Stress runs"). Unset, it is
// @playwright/test's own.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test as base } from '@playwright/test';
import { withCpuThrottle } from '../../../e2e/support/cpu-throttle.mjs';

export const test = withCpuThrottle(base);
export { expect };
