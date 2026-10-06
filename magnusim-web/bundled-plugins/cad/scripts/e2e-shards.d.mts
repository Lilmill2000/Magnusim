// Types for scripts/e2e-shards.mjs (its unit test imports the shards and the map).
// SPDX-License-Identifier: GPL-3.0-or-later
export const SHARDS: Record<'shell' | 'sketch' | 'solids' | 'step' | 'link' | 'big', string[]>;
export const SHARD_NAMES: string[];
export const SMOKE_TAG: '@smoke';
export const SERIAL_TAG: '@serial';
export const RULES: [string | RegExp, string[] | 'all' | 'none', string][];
export function shardOfSpec(rel: string): string | null;
export function shardsForFile(rel: string, hostPaths?: string[]): { shards: string[]; why: string };
export function shardsForFiles(rels: string[], hostPaths?: string[]): { shards: string[]; why: Record<string, string[]>; none: { file: string; why: string }[] };
export function specsOf(shards: string[]): string[];
