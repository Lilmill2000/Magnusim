// Types of cpu-throttle.mjs for TypeScript e2e files (CAD's own Playwright).
// SPDX-License-Identifier: GPL-3.0-or-later
/** The throttle rate MAGNUSIM_E2E_CPU_THROTTLE asks for, or 0 (none). */
export function cpuThrottleRate(env?: Record<string, string | undefined>): number;
/** `base` with every page of each test's context CPU-throttled while MAGNUSIM_E2E_CPU_THROTTLE is set. */
export function withCpuThrottle<T>(base: T): T;
