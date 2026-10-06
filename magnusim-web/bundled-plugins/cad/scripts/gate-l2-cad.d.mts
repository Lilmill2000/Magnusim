// Types for scripts/gate-l2-cad.mjs (its unit test imports the verdicts).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppPython } from './app-python.mjs';
export function gatePython(env?: Record<string, string | undefined>, o?: { exists?: (p: string) => boolean; probe?: (cmd: string) => string | null; pyRoot?: string }): AppPython;
export function gateEnv(python: string, env?: Record<string, string | undefined>): Record<string, string | undefined>;
export function vitestVerdict(report: unknown): string | null;
export function e2eVerdict(report: unknown): string | null;
