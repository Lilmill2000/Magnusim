/**
 * Runs one tool call (Foundation spec 6.3). Independent of turns, so a later MCP server
 * runs calls the same way; a turn passes hooks for its log and its clock.
 *
 * 1. Resolve the name ONLY in `offered`: the list sent in that step's request (MCP: the
 *    list it last served). Anything else, a tool the per-request cap left out and the
 *    Settings test's own tool included, is `no_tool`. A tool result can never add a tool.
 * 2. Input the model wrote as broken JSON is `invalid_input`.
 * 3. Nulls the second cloud dialect sends for optional fields are removed, then the input
 *    is validated against every constraint of the tool's schema (`invalid_input`).
 * 4. Availability is checked again now, with the plugin-epoch fence (`unavailable`,
 *    `plugin_off`).
 * 5. compute and destructive tools ask first (a confirm gate); a no, the timeout or Stop
 *    means it doesn't run (`declined`). An unknown risk counts as destructive.
 * 6. The tool runs with its stall window (reset by progress); Stop and the turn's
 *    minutes cap abort it through the call's signal (`stopped`, `capped`).
 * 7. What it returns reaches the model only as cleaned, capped JSON text (sanitize.ts).
 */
import { alog } from './log.ts';
import { redact } from './redact.ts';
import type { ToolCtx, ToolDef, ToolOutcome, ToolSource } from './registry.ts';
import { capResult, checkImage, cleanText, TEXT_CAPS } from './sanitize.ts';
import { stripNullOptionals, validateInput } from './schema.ts';
import { realClock, type Clock, type GateBroker, type GateDetail, type GateOwner, type GateRequest } from './gates.ts';
import type { ImagePart, Risk, ToolCallPart, ToolResultPart } from './types.ts';

export type RunnerEvent =
  | { type: 'tool_call'; step: number; call: string; tool: string; title: string; risk: Risk; source: string; input_preview: string }
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string }
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; summary: string; ms: number };

/** What a turn lends the runner (absent for MCP). */
export interface RunnerTurn {
  readonly id: string;
  readonly step: number;
  emit(e: RunnerEvent): void;
  setState(s: 'tools' | 'awaiting_confirmation'): void;
  /** Gate waits don't count toward the turn's minutes. */
  pause(): void;
  resume(): void;
}

/** Why a call's signal aborted: Stop, the turn's minutes cap, or no progress for too long. */
export interface CallAbort {
  code: 'stopped' | 'capped' | 'stalled';
  text?: string;
  /** `stopped` because the server is stopping, not by the person (Stop, a key change). */
  server?: boolean;
}

export interface RunOptions {
  owner: GateOwner;
  ctx: ToolCtx;
  /** The call's signal (Turn.callSignal()); its reason is a CallAbort. */
  signal: AbortSignal;
  turn?: RunnerTurn;
  /** This step's tools by name: the only names that may run. */
  offered: ReadonlyMap<string, ToolDef>;
}

export interface RunResult {
  part: ToolResultPart;
  ok: boolean;
  /** null when it ran and succeeded; else the error code. */
  code: string | null;
  summary: string;
}

const RISKS: readonly Risk[] = ['read', 'edit', 'compute', 'destructive'];
/** How long an aborted tool may take to give its last answer. */
export const ABORT_GRACE_MS = 2_000;
/** A workspace tool's stall window on the server: its own plus the relay's margin. */
export const WORKSPACE_STALL_MARGIN_MS = 10_000;
const PREVIEW = 200;
const GATE_INPUT = 400;

export const STOPPED_BEFORE = 'Stopped by the user before this ran.';
const STOPPED_DURING = 'Stopped by the user while it ran; it may or may not have finished.';
const SERVER_BEFORE = 'The server stopped before this ran.';
const SERVER_DURING = 'The server stopped while it ran; it may or may not have finished.';

/** A stopped call's result text: by the person, or because the server stopped. */
export function stoppedText(running: boolean, server = false): string {
  if (server) return running ? SERVER_DURING : SERVER_BEFORE;
  return running ? STOPPED_DURING : STOPPED_BEFORE;
}

export function riskOf(def: ToolDef | null): Risk {
  return def && RISKS.includes(def.risk) ? def.risk : 'destructive';
}

/** Who offers the tool, as the person reads it. */
export function sourceLabel(source: ToolSource | null): string {
  if (!source) return '';
  if (source.kind === 'host') return 'Magnusim';
  if (source.kind === 'workspace') return `${source.pluginName} (${source.workspace})`;
  return cleanText(source.plugin, TEXT_CAPS.name);
}

function preview(call: ToolCallPart, max: number): string {
  if (call.inputError) return '(input that is not valid JSON)';
  let text = '';
  try {
    text = JSON.stringify(call.input ?? {});
  } catch {
    text = '(unreadable input)';
  }
  return cleanText(text, max);
}

/** The tool_call event for a call (also for calls that don't run). */
export function toolCallEvent(call: ToolCallPart, def: ToolDef | null, step: number): RunnerEvent {
  return {
    type: 'tool_call',
    step,
    call: call.callId,
    tool: cleanText(call.name, 64),
    title: cleanText(def?.title ?? call.name, TEXT_CAPS.name),
    risk: riskOf(def),
    source: sourceLabel(def?.source ?? null),
    input_preview: preview(call, PREVIEW),
  };
}

/** A call answered without running it (or after it failed): `{tool, ok:false, error}`. */
export function errorResult(call: ToolCallPart, code: string, message: string, hint?: string): RunResult {
  const msg = cleanText(message, TEXT_CAPS.other);
  return {
    part: capResult(call.callId, call.name, { ok: false, error: { code, message: msg, ...(hint ? { hint } : {}) } }),
    ok: false,
    code,
    summary: cleanText(msg, PREVIEW),
  };
}

/** The CallAbort a signal was aborted with, if any. */
export function callAbortOf(signal: AbortSignal): CallAbort | null {
  if (!signal.aborted) return null;
  const r = signal.reason as Partial<CallAbort> | undefined;
  if (r && (r.code === 'capped' || r.code === 'stalled' || r.code === 'stopped')) {
    return { code: r.code, ...(r.text ? { text: r.text } : {}), ...(r.server === true ? { server: true } : {}) };
  }
  return { code: 'stopped' };
}

function lowerFirst(s: string): string {
  if (s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1])) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** The confirm question for a compute or destructive tool. */
export function confirmGate(def: ToolDef, input: Record<string, unknown>, turn: string | null): GateRequest {
  const risk = riskOf(def) === 'compute' ? 'compute' : 'destructive';
  let sent = '';
  try {
    sent = cleanText(JSON.stringify(input), GATE_INPUT);
  } catch {
    sent = '(unreadable)';
  }
  let detail: GateDetail[] | undefined;
  try {
    detail = def.describe?.(input)?.detail;
  } catch {
    detail = undefined;
  }
  const what = risk === 'compute' ? 'starts a computation' : "can't be undone";
  return {
    kind: 'confirm',
    turn,
    title: `Allow the Assistant to ${lowerFirst(cleanText(def.title || def.name, TEXT_CAPS.name))}?`,
    copy: `${sourceLabel(def.source)} · ${what}. What it sent: ${sent}. Nothing runs until you choose.`,
    yes: 'Allow',
    no: "Don't",
    ...(detail ? { detail } : {}),
    risk,
    tool: def.name,
    source: sourceLabel(def.source),
  };
}

function checkedImages(list: ImagePart[] | undefined): ImagePart[] {
  const out: ImagePart[] = [];
  for (const img of Array.isArray(list) ? list : []) {
    if (out.length >= 4) break;
    if (!img || typeof img.base64 !== 'string') continue;
    const c = checkImage(Buffer.from(img.base64, 'base64'));
    if (c.ok) out.push({ type: 'image', mediaType: c.mediaType, base64: img.base64, width: c.width, height: c.height });
  }
  return out;
}

export interface ToolRunnerOptions {
  gates: GateBroker;
  /** The plugin-epoch fence (Registry.fenced). */
  fenced?: (source: ToolSource) => boolean;
  clock?: Clock;
  abortGraceMs?: number;
}

export class ToolRunner {
  private readonly gates: GateBroker;
  private readonly fenced: (source: ToolSource) => boolean;
  private readonly clock: Clock;
  private readonly graceMs: number;

  constructor(o: ToolRunnerOptions) {
    this.gates = o.gates;
    this.fenced = o.fenced ?? (() => false);
    this.clock = o.clock ?? realClock;
    this.graceMs = o.abortGraceMs ?? ABORT_GRACE_MS;
  }

  async run(call: ToolCallPart, o: RunOptions): Promise<RunResult> {
    const started = this.clock.now();
    const def = o.offered.get(call.name) ?? null;
    o.turn?.emit(toolCallEvent(call, def, o.turn.step));
    const r = await this.runResolved(call, def, o);
    o.turn?.emit({
      type: 'tool_result',
      call: call.callId,
      ok: r.ok,
      ...(r.code ? { code: r.code } : {}),
      summary: r.summary,
      ms: Math.max(0, this.clock.now() - started),
    });
    return r;
  }

  private async runResolved(call: ToolCallPart, def: ToolDef | null, o: RunOptions): Promise<RunResult> {
    // 1. Only this step's list.
    if (!def) return errorResult(call, 'no_tool', `No tool named ${cleanText(call.name, 64)} in this step. Use only the tools listed.`);
    if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
    // 2-3. The input.
    if (call.inputError) return errorResult(call, 'invalid_input', call.inputError);
    const input = stripNullOptionals(def.schema, call.input ?? {}) as Record<string, unknown>;
    const valid = validateInput(def.schema, input);
    if (!valid.ok) return errorResult(call, 'invalid_input', valid.error);
    // 4. Still available, and its plugin not turned off or replaced.
    if (this.fenced(def.source)) return errorResult(call, 'plugin_off', `${sourceLabel(def.source)} was turned off or replaced.`);
    let available: true | string;
    try {
      available = def.available(o.ctx);
    } catch {
      available = 'It is not available now.';
    }
    if (available !== true) return errorResult(call, 'unavailable', String(available));
    // 5. Ask first.
    const risk = riskOf(def);
    if (risk === 'compute' || risk === 'destructive') {
      o.turn?.setState('awaiting_confirmation');
      o.turn?.pause();
      let answer: 'allow' | 'deny';
      try {
        answer = await this.gates.ask(confirmGate(def, input, o.turn?.id ?? null), o.owner, o.signal);
      } finally {
        o.turn?.resume();
        o.turn?.setState('tools');
      }
      if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
      if (answer !== 'allow') return errorResult(call, 'declined', 'The user declined this call; it did not run. Accept it and say what you would have done.');
    }
    // 6. Run it.
    return this.execute(call, def, input, o);
  }

  private abortedResult(call: ToolCallPart, signal: AbortSignal, running: boolean): RunResult {
    const why = callAbortOf(signal) ?? { code: 'stopped' as const };
    if (why.code === 'capped') {
      const text = why.text || 'This turn reached a limit.';
      return errorResult(call, 'capped', running ? `Stopped: ${text} It may or may not have finished.` : `Not run: ${text}`);
    }
    if (why.code === 'stalled') return errorResult(call, 'stalled', why.text || 'No progress for too long; it was stopped and may or may not have finished.');
    return errorResult(call, 'stopped', stoppedText(running, why.server === true));
  }

  private async execute(call: ToolCallPart, def: ToolDef, input: Record<string, unknown>, o: RunOptions): Promise<RunResult> {
    const stallMs = def.stallMs + (def.source.kind === 'workspace' ? WORKSPACE_STALL_MARGIN_MS : 0);
    const stall = new AbortController();
    const signal = AbortSignal.any([o.signal, stall.signal]);
    const clock = this.clock;
    let stallTimer: unknown = null;
    const arm = () => {
      clock.clearTimeout(stallTimer);
      stallTimer = clock.setTimeout(() => {
        const s = Math.round(stallMs / 1000);
        stall.abort({ code: 'stalled', text: `No progress for ${s} s; it was stopped and may or may not have finished.` } satisfies CallAbort);
      }, stallMs);
    };
    arm();
    const progress = (fraction: number | null, label: string) => {
      if (signal.aborted) return;
      arm();
      const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
      o.turn?.emit({ type: 'tool_progress', call: call.callId, fraction: f, label: cleanText(label, 120) });
    };

    let outcome: ToolOutcome | null = null;
    let lateOrNone = false;
    let graceTimer: unknown = null;
    let onAbort: (() => void) | null = null;
    const ran = Promise.resolve()
      .then(() => def.run(input, { signal, ctx: o.ctx, turn: o.turn?.id ?? null, progress }))
      .then(
        (out): ToolOutcome | null => {
          if (signal.aborted) lateOrNone = true;
          return out && typeof out === 'object' ? out : { ok: false, error: { code: 'bad_result', message: 'The tool gave no result.' }, summary: 'No result' };
        },
        (err: unknown): ToolOutcome => {
          if (signal.aborted) lateOrNone = true;
          alog('warn', 'a tool threw', { tool: def.name, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) });
          return { ok: false, error: { code: 'failed', message: 'The tool failed with an unexpected error.' }, summary: 'Failed' };
        },
      );
    const gaveUp = new Promise<null>((resolve) => {
      onAbort = () => {
        graceTimer = clock.setTimeout(() => resolve(null), this.graceMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      outcome = await Promise.race([ran, gaveUp]);
    } finally {
      clock.clearTimeout(stallTimer);
      clock.clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (!outcome || lateOrNone || signal.aborted) {
      return this.abortedResult(call, stall.signal.aborted && !o.signal.aborted ? stall.signal : o.signal, true);
    }
    const summary = cleanText(outcome.summary || (outcome.ok ? 'Done' : outcome.error?.message || 'Failed'), PREVIEW);
    if (!outcome.ok) {
      const e = outcome.error ?? { code: 'failed', message: 'The tool failed.' };
      const code = cleanText(e.code, 64) || 'failed';
      const r = errorResult(call, code, e.message || 'The tool failed.', e.hint ? cleanText(e.hint, TEXT_CAPS.other) : undefined);
      return { ...r, summary };
    }
    const part = capResult(call.callId, call.name, { ok: true, data: outcome.data, text: outcome.text }, checkedImages(outcome.images));
    return { part, ok: true, code: null, summary };
  }
}
