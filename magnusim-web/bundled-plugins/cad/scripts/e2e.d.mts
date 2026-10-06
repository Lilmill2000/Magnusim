// Types for scripts/e2e.mjs (its unit test, tests/e2e/shards.test.ts, imports the planning).
// SPDX-License-Identifier: GPL-3.0-or-later
export const DEFAULT_WORKERS: number;
export interface E2eArgs {
  shards: string[];
  smoke: boolean;
  changed: boolean;
  base: string | null;
  files: string[] | null;
  plan: boolean;
  pw: string[];
}
export function parseArgs(argv: string[]): E2eArgs;
export function withoutOptions(args: string[], names: string[]): string[];
export function toPluginRel(p: string, base?: string): string;
export function changedFromGit(base: string | null, run?: (args: string[]) => string): string[];
export function planRun(
  o: E2eArgs,
  changed?: string[],
  host?: string[],
): { shards: string[]; specs: string[] | null; why: Record<string, string[]>; none: { file: string; why: string }[]; nothing: boolean };
export function playwrightArgs(o: E2eArgs, plan: { specs: string[] | null }): string[];
