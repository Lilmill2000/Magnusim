// Types for scripts/gate-l3-cad.mjs (its unit test imports them).
// SPDX-License-Identifier: GPL-3.0-or-later
export const L3_UNIT: string[];
export const L3_E2E: string[];
export function missingInputs(env?: Record<string, string | undefined>, exists?: (path: string) => boolean): string | null;
export const L3_E2E_CENSUS: [string, 'passed' | 'failed'][];
export function censusVerdict(report: unknown, census?: [string, 'passed' | 'failed'][]): string | null;
export function unitFilesVerdict(report: unknown, files?: string[]): string | null;
