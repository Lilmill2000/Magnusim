// Types of eval/score.mjs (the suites' TypeScript has no allowJs: CAD tools spec §2.1, fact check #37).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EvalAsk, EvalFacts } from '../src/assistant/eval-types';

export type CheckKind =
  | 'bodies'
  | 'volume'
  | 'bbox'
  | 'holes'
  | 'round_faces'
  | 'flat_faces'
  | 'features_ok'
  | 'sketches_defined'
  | 'params'
  | 'walk'
  | 'overlap'
  | 'union'
  | 'section'
  | 'wall'
  | 'spots'
  | 'interlock'
  | 'names_kept'
  | 'feature_type'
  | 'driven'
  | 'units'
  | 'blend_honest'
  | 'last_text';

export const CHECK_KINDS: readonly CheckKind[];

/** A number, or a formula ("100*60*8 - 4*pi*3.25^2*8"). */
export type Formula = number | string;

/** One check of a task (eval/tasks/<id>.json): its kind and that kind's fields. */
export interface Check {
  id?: string;
  kind: CheckKind;
  heuristic?: boolean;
  [field: string]: unknown;
}

export interface EvalTask {
  id: string;
  tier: 'L1' | 'L2' | 'L3' | 'L4' | 'Edit';
  units: 'mm' | 'in';
  title?: string;
  /** The first request. */
  prompt: string;
  /** Later requests in the same conversation, in order. */
  turns: string[];
  /** Questions a turn may ask: a tool's confirmation allowed or denied (deny when not named). */
  gates: Record<string, 'allow' | 'deny'>;
  checks: Check[];
}

export interface CheckResult {
  id: string;
  kind: CheckKind;
  heuristic: boolean;
  pass: boolean;
  got: unknown;
  want?: unknown;
  why: string;
}

export interface ScoreResult {
  /** Every counted check passed (heuristic ones never count). */
  pass: boolean;
  passed: number;
  counted: number;
  checks: CheckResult[];
}

/** One walk check's run: the volume before, then each value set. */
export interface WalkResult {
  param?: string;
  from?: string;
  base?: number | null;
  steps: { expr: string; ok: boolean; reason?: string; volume: number | null; failing: string[] }[];
  error?: string;
}

/** What a run keeps beside the facts. */
export interface ScoreExtra {
  /** Walk results by check id (eval/lib.mjs runWalks). */
  walk?: Record<string, WalkResult>;
  /** Feature names after each turn. */
  names?: string[][];
  /** The last turn's last words. */
  last_text?: string;
}

export function formula(text: Formula): number;
export function within(got: unknown, want: number, tol?: { abs?: Formula; rel?: Formula }): boolean;
export function factsAsk(task: Pick<EvalTask, 'checks'>): Required<EvalAsk>;
export function holesOf(facts: EvalFacts, c: Check): { body: string; axis: { point: number[]; dir: number[] }; radius: number; faces: unknown[] }[];
export function checkIds(task: Pick<EvalTask, 'checks'>): string[];
export function score(task: Pick<EvalTask, 'checks'>, facts: EvalFacts, extra?: ScoreExtra): ScoreResult;
export function failedWords(result: ScoreResult): string;
export function taskProblems(task: unknown): string[];
