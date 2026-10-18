/**
 * Runs one tool call (Foundation spec 6.3). Independent of turns, so a later MCP server
 * runs calls the same way; a turn passes hooks for its log and its clock.
 *
 * 1. Resolve the name ONLY in `offered`: the list sent in that step's request (MCP: the
 *    list it last served). Anything else, a tool the per-request cap left out and the
 *    Settings test's own tool included, is `no_tool`. A tool result can never add a tool.
 * 2. Input the model wrote as broken JSON is `invalid_input`.
 * 3. Nulls the second cloud dialect sends for optional fields are removed; a local model's
 *    call of a workspace tool gets "", [] or false for the required fields it left out or
 *    sent as null, when their type has that empty value (fillLocalDefaults). Then the input
 *    is validated against every constraint of the tool's schema, every problem named at
 *    once (`invalid_input`).
 * 4. Availability is checked again now, with the plugin-epoch fence (`unavailable`,
 *    `plugin_off`).
 * 5. compute and destructive tools ask first (a confirm gate); a no, the timeout or Stop
 *    means it doesn't run (`declined`). An unknown risk counts as destructive. The question
 *    shows every field the call sent, in the schema's order, each cut on its own and marked.
 * 6. The tool runs with its stall window (reset by progress); Stop and the turn's
 *    minutes cap abort it through the call's signal (`stopped`, `capped`). An aborted tool
 *    has ABORT_GRACE_MS for its last answer: a result that finished (ok) is its result, as
 *    the page's bridge keeps it (the tool did its work); anything else is the abort, "may or
 *    may not have finished". Then the runner stops waiting and says so on the call's
 *    `released` signal (the relay frees the tab before the next call can start).
 *    A progress that says the call waits for the person (`waiting`) pauses the turn's minutes
 *    once, until the next progress without it or the call's end; every progress still resets
 *    the stall window.
 * 7. What it returns reaches the model only as cleaned, capped JSON text (sanitize.ts), with
 *    its images checked: one the model can't be sent fails the call (`too_large`, `bad_result`).
 *    A failed call's hint and detail go with its error, and the hint to the log's tool_result
 *    too; a result's summary is the log's line only.
 */
import { alog } from './log.ts';
import { redact } from './redact.ts';
import type { ProgressOptions, ToolCtx, ToolDef, ToolOutcome, ToolSource } from './registry.ts';
import { capResult, checkImages, cleanText, CONFIRM_NOTE_MAX, TEXT_CAPS } from './sanitize.ts';
import { fillLocalDefaults, stripNullOptionals, validateInput } from './schema.ts';
import { realClock, type Clock, type GateBroker, type GateDetail, type GateOwner, type GateRequest } from './gates.ts';
import type { Risk, ToolCallPart, ToolResultPart } from './types.ts';

export type RunnerEvent =
  | { type: 'tool_call'; step: number; call: string; tool: string; title: string; risk: Risk; source: string; input_preview: string }
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string }
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; hint?: string; summary: string; ms: number };

/** What a turn lends the runner (absent for MCP). */
export interface RunnerTurn {
  readonly id: string;
  readonly step: number;
  emit(e: RunnerEvent): void;
  setState(s: 'tools' | 'awaiting_confirmation'): void;
  /** Gate waits, and a call's waits for the person, don't count toward the turn's minutes. */
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
  /** A failed call's hint, as the model has it (for the log). */
  hint?: string;
  summary: string;
}

const RISKS: readonly Risk[] = ['read', 'edit', 'compute', 'destructive'];
/** How long an aborted tool may take to give its last answer. */
export const ABORT_GRACE_MS = 2_000;
/** A workspace tool's stall window on the server: its own plus the relay's margin. */
export const WORKSPACE_STALL_MARGIN_MS = 10_000;
const PREVIEW = 200;
/** The room the confirm question gives the call's input, shared fairly among its fields. */
const GATE_INPUT = 400;
/** The least of a field's value the question shows, however many fields share the room. */
const GATE_FIELD_MIN = 24;
/** The most the input may take (the question's copy is capped at 2000): past it, fields are only counted. */
const GATE_INPUT_MAX = 1500;
/** Room for a cut's mark, "… (N more characters)". */
const GATE_MARK = 28;

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

/**
 * A call answered without running it (or after it failed): `{tool, ok:false, error}`, with the
 * tool's hint (how to fix it) and detail (plain JSON about it) when it gave them.
 */
export function errorResult(call: ToolCallPart, code: string, message: string, hint?: string, detail?: unknown): RunResult {
  const msg = cleanText(message, TEXT_CAPS.other);
  const h = hint ? cleanText(hint, TEXT_CAPS.other) : '';
  return {
    part: capResult(call.callId, call.name, { ok: false, error: { code, message: msg, ...(h ? { hint: h } : {}), ...(detail !== undefined ? { detail } : {}) } }),
    ok: false,
    code,
    ...(h ? { hint: h } : {}),
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

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `v` with its objects' keys in the schema's order (any others after), at every depth: never the model's order. */
function inSchemaOrder(schema: unknown, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => inSchemaOrder(isObject(schema) ? schema.items : undefined, x));
  if (!isObject(v)) return v;
  const props = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const keys = [...Object.keys(props).filter((k) => Object.hasOwn(v, k)), ...Object.keys(v).filter((k) => !Object.hasOwn(props, k))];
  const out: Record<string, unknown> = {};
  // Defined, not assigned, as stripNullOptionals keeps an own "__proto__" key.
  for (const k of keys) Object.defineProperty(out, k, { value: inSchemaOrder(props[k], v[k]), enumerable: true, writable: true, configurable: true });
  return out;
}

/** `text` cut to `n` characters, saying how many more there are. */
function cutMarked(text: string, n: number): string {
  const chars = [...text];
  return chars.length <= n ? text : `${chars.slice(0, n).join('')}… (${chars.length - n} more characters)`;
}

/**
 * The call's input as the confirm question shows it: every field, in the schema's order,
 * each value given a fair share of the room and cut on its own, marked with how much is not
 * shown. A long field, or one the model put first, never pushes another out of sight.
 */
export function gateInputText(schema: unknown, input: Record<string, unknown>): string {
  const ordered = inSchemaOrder(schema, input) as Record<string, unknown>;
  const fields = Object.keys(ordered).map((k) => {
    const value = cleanText(JSON.stringify(ordered[k]) ?? 'null', Number.MAX_SAFE_INTEGER);
    return { key: JSON.stringify(cleanText(k, 64)), value, length: [...value].length };
  });
  if (!fields.length) return '{}';
  const frame = (n: number) => 2 + fields.slice(0, n).reduce((sum, f) => sum + f.key.length + 2, 0) - 1;
  let shown = fields.length;
  while (shown > 1 && frame(shown) + shown * (GATE_FIELD_MIN + GATE_MARK) > GATE_INPUT_MAX) shown -= 1;
  let room = Math.max(GATE_INPUT - frame(shown), shown * GATE_FIELD_MIN);
  // The shortest first: what one field doesn't need goes to the others.
  const give = new Array<number>(shown).fill(0);
  const order = [...give.keys()].sort((a, b) => fields[a].length - fields[b].length);
  order.forEach((i, at) => {
    give[i] = Math.min(fields[i].length, Math.floor(room / (shown - at)));
    room -= give[i];
  });
  const parts = fields.slice(0, shown).map((f, i) => `${f.key}:${cutMarked(f.value, give[i])}`);
  if (shown < fields.length) parts.push(`… (${fields.length - shown} more fields)`);
  return `{${parts.join(',')}}`;
}

/**
 * The confirm question for a compute or destructive tool. A destructive tool's confirm note
 * says what the call does in place of "can't be undone"; a compute tool's always "starts a
 * computation".
 */
export function confirmGate(def: ToolDef, input: Record<string, unknown>, turn: string | null): GateRequest {
  const risk = riskOf(def) === 'compute' ? 'compute' : 'destructive';
  let sent = '';
  try {
    sent = gateInputText(def.schema, input);
  } catch {
    sent = '(unreadable)';
  }
  let detail: GateDetail[] | undefined;
  try {
    detail = def.describe?.(input)?.detail;
  } catch {
    detail = undefined;
  }
  const note = risk === 'destructive' ? cleanText(def.confirmNote, CONFIRM_NOTE_MAX) : '';
  const what = risk === 'compute' ? 'starts a computation' : note || "can't be undone";
  return {
    kind: 'confirm',
    turn,
    title: `Allow the Assistant to ${lowerFirst(cleanText(def.title || def.name, TEXT_CAPS.name))}?`,
    copy: `${sourceLabel(def.source)} · ${what}${/[.!?]$/.test(what) ? '' : '.'} What it sent: ${sent}. Nothing runs until you choose.`,
    yes: 'Allow',
    no: "Don't",
    ...(detail ? { detail } : {}),
    risk,
    tool: def.name,
    source: sourceLabel(def.source),
  };
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
      ...(r.hint ? { hint: r.hint } : {}),
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
    let input = stripNullOptionals(def.schema, call.input ?? {}) as Record<string, unknown>;
    // A local model often leaves out the fields it has no use for: a workspace tool gets their empty values.
    if (o.ctx.local && def.source.kind === 'workspace') input = fillLocalDefaults(def.schema, input) as Record<string, unknown>;
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
    // The call waits for the person (its last progress said so): the turn's minutes are paused.
    let waiting = false;
    let finished = false;
    const wait = (on: boolean) => {
      if (on === waiting) return;
      waiting = on;
      if (on) o.turn?.pause();
      else o.turn?.resume();
    };
    const progress = (fraction: number | null, label: string, opts?: ProgressOptions) => {
      if (signal.aborted || finished) return;
      arm();
      wait(opts?.waiting === true);
      const f = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
      const text = cleanText(label, 120);
      // A bare sign of life (a workspace page waiting on a call to the app, or its progress()
      // with nothing) holds the window open and has nothing to show: no row in the log.
      if (f === null && !text) return;
      o.turn?.emit({ type: 'tool_progress', call: call.callId, fraction: f, label: text });
    };

    let outcome: ToolOutcome | null = null;
    let graceTimer: unknown = null;
    let onAbort: (() => void) | null = null;
    const released = new AbortController();
    const ran = Promise.resolve()
      .then(() => def.run(input, { signal, ctx: o.ctx, turn: o.turn?.id ?? null, progress, released: released.signal }))
      .then(
        (out): ToolOutcome | null => {
          return out && typeof out === 'object' ? out : { ok: false, error: { code: 'bad_result', message: 'The tool gave no result.' }, summary: 'No result' };
        },
        (err: unknown): ToolOutcome => {
          alog('warn', 'a tool threw', { tool: def.name, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) });
          return { ok: false, error: { code: 'failed', message: 'The tool failed with an unexpected error.' }, summary: 'Failed' };
        },
      );
    const gaveUp = new Promise<null>((resolve) => {
      onAbort = () => {
        graceTimer = clock.setTimeout(() => {
          // Synchronously, before the caller can go on to its next call.
          released.abort();
          resolve(null);
        }, this.graceMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      outcome = await Promise.race([ran, gaveUp]);
    } finally {
      finished = true;
      wait(false);
      clock.clearTimeout(stallTimer);
      clock.clearTimeout(graceTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    // Aborted: only a result that finished counts (its last answer within the grace, as the
    // page's bridge keeps it: the tool did its work, and the model must not do it again);
    // no answer, or any other one, is the abort ("may or may not have finished").
    if (!outcome || (signal.aborted && !outcome.ok)) {
      return this.abortedResult(call, stall.signal.aborted && !o.signal.aborted ? stall.signal : o.signal, true);
    }
    const summary = cleanText(outcome.summary || (outcome.ok ? 'Done' : outcome.error?.message || 'Failed'), PREVIEW);
    if (!outcome.ok) {
      const e = outcome.error ?? { code: 'failed', message: 'The tool failed.' };
      const code = cleanText(e.code, 64) || 'failed';
      const r = errorResult(call, code, e.message || 'The tool failed.', e.hint, e.detail);
      return { ...r, summary };
    }
    // An image the model can't be sent fails the call with why, as the bridge's caps do: dropped
    // quietly, the model would get the result without it while the log counts it.
    const images = checkImages(outcome.images);
    if (!images.ok) return errorResult(call, images.code, images.message);
    const part = capResult(call.callId, call.name, { ok: true, data: outcome.data, text: outcome.text }, images.images);
    return { part, ok: true, code: null, summary };
  }
}
