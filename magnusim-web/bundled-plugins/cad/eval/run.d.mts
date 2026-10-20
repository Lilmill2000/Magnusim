// Types of eval/run.mjs's checked pieces (the suites' TypeScript has no allowJs: CAD tools spec §2.1).
// SPDX-License-Identifier: GPL-3.0-or-later

export interface RunArgs {
  tasks: string;
  runs: number;
  label: string;
  driver: 'profile' | 'attach' | 'scripted' | null;
  profile: string | null;
  attach: string | null;
  tab: string | null;
  toolset: 'all' | 'core';
  pace: 'fast' | 'watch';
  headed: boolean;
  clean: boolean;
  out: string | null;
  repair: boolean;
  keepOpen: boolean;
  portFrom: number | null;
  turnMs: number;
  /** --reference files, as given (read with readReference). */
  references: string[];
  /** --review on (default) or off. */
  review: boolean;
  help: boolean;
}

export interface Caps {
  steps: number;
  turn_usd: number;
  turn_minutes: number;
  day_usd: number;
}

/** A profile file (kept outside the repository). */
export interface Profile {
  provider: string;
  model: string;
  effort?: string;
  base_url?: string;
  confirm_remote?: boolean;
  key_env?: string;
  caps?: Partial<Caps>;
}

export const PROFILE_CAPS: Readonly<Caps>;
export const ATTACH_MIN_STEPS: number;
export const PROBE_TEXT: string;
export function parseArgs(argv: string[]): RunArgs;
export function readProfile(file: string, repoTop: string): Profile;
export const REFERENCES_MAX: number;
export function readReference(file: string, repoTop: string): { path: string; sha256: string; media_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string };
export function profileSettings(p: Profile): { provider: string; model: string; effort?: string; base_url?: string; confirm_remote?: true; privacy: 'allow'; caps: Caps };
export function capsWords(c: Caps | null | undefined): string;
export const DEBUG_LOG_ENV: string;
/** Where the run's own server left its logs, one line each. */
export function logLines(logs: { server: string; debug: string }): string[];

/** What the probe's turn notes say of its strict tools: accepted, reduced: N of M strict (unchecked: ...), refused: all unchecked. */
export function probeStrict(notes: readonly string[]): string;
