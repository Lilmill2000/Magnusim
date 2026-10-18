// Types of eval/lib.mjs (the suites' TypeScript has no allowJs: CAD tools spec §2.1, fact check #37).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Frame, Page } from '@playwright/test';
import type { EvalAsk, EvalFacts } from '../src/assistant/eval-types';
import type { CheckResult, EvalTask, ScoreExtra, WalkResult } from './score.mjs';

export const EVAL_DIR: string;
export const PLUGIN_DIR: string;
export const RESULTS_DIR: string;
export const PART_TOOLS: number;
export const CORE_TOOLS: number;
export const TURN_MS: number;

/** One answer step of the app's scripted model (e2e/support/fake-llm.mjs). */
export interface FakeStep {
  tools?: { name: string; input: Record<string, unknown> }[];
  text?: string;
}

/** A task's reference: the scripted model's answers, one list per turn; `expect` marks a call that must fail. */
export interface EvalReference {
  id: string;
  about?: string;
  turns: { tools?: { name: string; input: Record<string, unknown>; expect?: string }[]; text?: string }[][];
  repair?: { tools?: { name: string; input: Record<string, unknown> }[]; text?: string }[];
}

/** A question a turn asks (the turn log's `gate`). */
export interface EvalGate {
  id: string;
  kind: 'confirm' | 'privacy';
  tool?: string;
  title: string;
  yes: string;
  no: string;
  project?: { id: string; title: string };
}

/** Where the model's answers come from. */
export interface EvalDriver {
  kind: 'scripted' | 'profile' | 'attach';
  beforeTurn?(task: EvalTask, turn: number): void | Promise<void>;
  beforeRepair?(task: EvalTask): void | Promise<void>;
  /** The answer to a question (true allow, false deny, null left); gateAnswer when absent. */
  answer?(gate: EvalGate, task: EvalTask, created: Set<string>): boolean | null;
}

/** The scripted model as runTask needs it. */
export interface FakeReplies {
  reply(...steps: unknown[]): void;
  /** Answers not used yet (a turn that ended early leaves some): a new turn refuses to start on them. */
  pending?(): number;
}

/** One event of a turn's log (GET /api/assistant/turns/:id). */
export type TurnEvent = { type: string; seq?: number; at?: number } & Record<string, unknown>;

export interface TurnRun {
  id: string;
  conversation: string | null;
  events: TurnEvent[];
  turn: Record<string, unknown> | null;
}

/** The record of one run (runs.jsonl). */
export interface RunRecord {
  task: string;
  tier: string;
  label: string;
  run: number;
  driver: string;
  model: { provider: string | null; model: string | null; effort: string | null; served_by: string[] };
  project: string;
  tab: string;
  pace: string | null;
  toolset: string;
  first_shot: { pass: boolean; passed: number; counted: number; failed: string[] };
  final: { pass: boolean; passed: number; counted: number; failed: string[] };
  repaired: boolean;
  checks: CheckResult[];
  steps: number;
  calls_by_tool: Record<string, number>;
  errors_by_reason: Record<string, number>;
  errors_by_code: Record<string, number>;
  invalid_input: number;
  images: number;
  notes: string[];
  max_request_tokens: number;
  context_tokens: number | null;
  usd: number;
  tokens: number;
  wall_s: number;
  end: { state: string; reason: string }[];
  health: { health: string; words: string[] };
  fact_errors: string[];
}

export interface EvalEnv {
  base: string;
  page: Page;
  driver: EvalDriver;
  /** The run folder records go to (runs.jsonl and one folder per run), or null for none. */
  out?: string | null;
  /** Projects this run made (privacy answers only for these; --clean deletes only these). */
  created?: Set<string>;
  log?: (line: string) => void;
}

export interface RunOptions {
  label?: string;
  run?: number;
  pace?: 'fast' | 'watch';
  toolset?: 'all' | 'core';
  /** One repair turn on a failure (true by default). */
  repair?: boolean;
  turnMs?: number;
  /** Bind turns to this tab (it must show the project the run made). */
  tab?: string | null;
  /** The project's title ("Eval · <task>" by default). */
  title?: string;
  /** Draw the final picture into the run folder (true by default). */
  picture?: boolean;
}

export function taskIds(): string[];
export function loadTask(id: string): EvalTask;
export function loadTasks(ids?: string | string[] | null): EvalTask[];
export function loadReference(id: string): EvalReference;
export function fakeSteps(reference: EvalReference, turn: number): FakeStep[];
export function referenceCalls(reference: EvalReference, turn: number): { tool: string; input: Record<string, unknown>; expect: string }[];
export function scriptedDriver(fake: FakeReplies): EvalDriver;
export function gateAnswer(gate: Pick<EvalGate, 'kind' | 'tool' | 'project'>, task: Pick<EvalTask, 'gates'>, created: Set<string>): boolean | null;
export function api(base: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
export function tabOfProject(base: string, pid: string, tools?: number): Promise<{ tab: string; tools: string[]; workspace: { project_id: string } } | null>;
export function cadFrameOf(page: Page): Frame;
export function newPart(page: Page, base: string, o: { title: string; units?: 'mm' | 'in'; log?: (line: string) => void }): Promise<{ projectId: string; tab: string }>;
export function factsOf(frame: Frame, ask: EvalAsk): Promise<EvalFacts>;
export function setParamOf(frame: Frame, name: string, expr: string): Promise<{ ok: boolean; reason?: string }>;
export function runWalks(task: Pick<EvalTask, 'checks'>, io: { facts(ask: EvalAsk): Promise<EvalFacts>; setParam(name: string, expr: string): Promise<{ ok: boolean; reason?: string }> }): Promise<Record<string, WalkResult>>;
export function runTurn(base: string, body: { text: string; tab?: string; conversation?: string }, o?: { answer?: (gate: EvalGate) => boolean | null | undefined; ms?: number; log?: (line: string) => void }): Promise<TurnRun>;
export function lastText(events: TurnEvent[]): string;
export function turnUse(turns: { events: TurnEvent[] }[]): {
  steps: number;
  calls_by_tool: Record<string, number>;
  errors_by_code: Record<string, number>;
  usd: number;
  tokens: number;
  max_request_tokens: number;
  notes: string[];
  ends: { state: string; reason: string }[];
};
export function runTask(env: EvalEnv, task: EvalTask, o?: RunOptions): Promise<RunRecord>;
export function runFolder(label: string, now?: Date): string;
export function summaryMd(records: RunRecord[], meta?: { label?: string; when?: string; driver?: string; caps?: string }): string;
export type { ScoreExtra };
