// Types for scripts/gate-l2-cad.mjs (its unit test imports the verdicts).
// SPDX-License-Identifier: GPL-3.0-or-later
export function gatePython(env?: Record<string, string | undefined>): string;
export function vitestVerdict(report: unknown): string | null;
export function e2eVerdict(report: unknown): string | null;
