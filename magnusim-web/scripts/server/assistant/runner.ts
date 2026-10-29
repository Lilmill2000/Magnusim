/**
 * Runs one tool call (Foundation spec 6.3). Independent of turns, so the MCP server runs
 * calls the same way (its own progress listener, and its question's own wait,
 * `gateTimeoutMs`); a turn passes hooks for its log and its clock.
 *
 * 1. Resolve the name ONLY in `offered`: the list sent in that step's request (MCP: the
 *    list it last served). Anything else, a tool the per-request cap or budget left out and the
 *    Settings test's own tool included, is `no_tool`. A tool result can never add a tool.
 * 2. Input the model wrote as broken JSON is `invalid_input`.
 * 3. Nulls the second cloud dialect sends for optional fields are removed; a local model's
 *    call of a workspace or host tool gets "", [] or false for the required fields it left
 *    out or sent as null, when their type has that empty value (fillLocalDefaults). Then the
 *    input is validated against every constraint of the tool's schema, every problem named
 *    at once (`invalid_input`).
 * 4. Availability is checked again now, with the plugin-epoch fence (`unavailable`,
 *    `plugin_off`).
 * 5. The call's risk: the tool's, raised (never lowered) by its `escalate` for this input
 *    (core host tools spec C3); an escalate that throws or takes longer than ESCALATE_MAX_MS
 *    counts as destructive. The log's tool_call carries that risk (a tool that escalates is
 *    logged once it is known). compute and destructive calls ask first (a confirm gate); a
 *    no, the timeout or Stop means it doesn't run (`declined`). An unknown risk counts as
 *    destructive. The question is the tool's own (`gateText`) or shows every field the call
 *    sent, in the schema's order, each cut on its own and marked. Another app's call (MCP,
 *    `app`) is asked for as that app's, not the Assistant's. A compute call whose job a chain
 *    grant of the same owner covers (grants.ts) runs without a question, with a note; a call
 *    allowed with a `chain` grants its other jobs. Then the caller's last check (`beforeRun`;
 *    MCP reads privacy again) may stop it unrun.
 * 6. The tool runs with its stall window (reset by progress); Stop and the turn's
 *    minutes cap abort it through the call's signal (`stopped`, `capped`). An aborted tool
 *    has ABORT_GRACE_MS for its last answer: a result that finished (ok) is its result, as
 *    the page's bridge keeps it (the tool did its work); anything else is the abort, "may or
 *    may not have finished". Then the runner stops waiting and says so on the call's
 *    `released` signal (the relay frees the tab before the next call can start).
 *    A progress that says the call waits for the person (`waiting`) pauses the turn's minutes
 *    once, until the next progress without it or the call's end, for WAIT_PAUSE_MAX_MS of the
 *    call's waits at most: then they run again, and the turn's log says so (a page that says
 *    it waits for ever can't hold a turn past its minutes). Every progress still resets the
 *    stall window. The log's tool_progress carries `waiting: true` while the page says so.
 * 7. What it returns reaches the model only as cleaned, capped JSON text (sanitize.ts), with
 *    its images checked: one the model can't be sent fails the call (`too_large`, `bad_result`).
 *    A failed call's hint and detail go with its error, and the hint to the log's tool_result
 *    too; a result's summary is the log's line only. A turn keeps the result's images for the
 *    window (keepImages): the log's tool_result names them (`images`, refs, never the bytes).
 */
import { safeLinks, type ToolLink } from './links.ts';
import { alog } from './log.ts';
import { redact } from './redact.ts';
import type { ProgressOptions, StepInfo, ToolCtx, ToolDef, ToolOutcome, ToolRefusal, ToolSource, TurnUse } from './registry.ts';
import { capResult, checkImages, cleanText, CONFIRM_NOTE_MAX, GATE_NOTE_MAX, TEXT_CAPS } from './sanitize.ts';
import { fillLocalDefaults, stripNullOptionals, validateInput } from './schema.ts';
import { realClock, type Clock, type GateBroker, type GateDetail, type GateOwner, type GateRequest } from './gates.ts';
import { CHAIN_MAX, grants as serverGrants, type ChainGrants } from './grants.ts';
import type { Assessed } from './registry.ts';
import type { ImagePart, Risk, ToolCallPart, ToolResultPart } from './types.ts';

export type RunnerEvent =
  | { type: 'tool_call'; step: number; call: string; tool: string; title: string; risk: Risk; source: string; input_preview: string }
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string; waiting?: true }
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; hint?: string; summary: string; ms: number; images?: ImageRef[]; links?: ToolLink[] };

/**
 * A picture a turn keeps for the window (phase 4 spec 9.4), as its log names it: `n` is its id in
 * the turn ("1", "2", ...; the person's own "p1".."p4"), served by GET
 * /api/assistant/turns/:id/images/:n while it is kept.
 */
export interface ImageRef {
  n: string;
  media_type: string;
  width: number;
  height: number;
}

/** What a turn lends the runner (absent for MCP). */
export interface RunnerTurn {
  readonly id: string;
  readonly step: number;
  emit(e: RunnerEvent): void;
  setState(s: 'tools' | 'awaiting_confirmation'): void;
  /** Gate waits, and a call's waits for the person, don't count toward the turn's minutes. */
  pause(): void;
  resume(): void;
  /** A line for the turn's log. */
  note?(text: string): void;
  /** Keeps a result's pictures for the window (already checked); their refs go on the log's tool_result. */
  keepImages?(images: ImagePart[]): ImageRef[];
  /** What it used so far of its limits (ToolCtx.used: app_status shows it). */
  toolUse?(): TurnUse;
}

/** Why a call's signal aborted: Stop, the turn's minutes cap, or no progress for too long. */
export interface CallAbort {
  code: 'stopped' | 'capped' | 'stalled';
  text?: string;
  /** `stopped` because the server is stopping, not by the person (Stop, a key change). */
  server?: boolean;
  /**
   * `stopped` by neither the person nor the server: what happened, as the start of the result's
   * sentence ("Claude Code stopped unexpectedly", "The app disconnected", "The turn ended").
   */
  cause?: string;
}

export interface RunOptions {
  owner: GateOwner;
  ctx: ToolCtx;
  /** The call's signal (Turn.callSignal()); its reason is a CallAbort. */
  signal: AbortSignal;
  turn?: RunnerTurn;
  /**
   * The turn the tool is told when no turn of the Assistant's makes the call (MCP: another app's
   * connection, `mcp:<connection id>`, which a workspace page gets as AssistantCall.turn). Its
   * question still has no turn: no turn's answer key answers it.
   */
  callTurn?: string;
  /** This step's tools by name: the only names that may run. */
  offered: ReadonlyMap<string, ToolDef>;
  /** The call's place in its step (a turn's own calls: loop.ts); the tool hears it (a workspace page, through the relay). */
  step?: StepInfo;
  /** How long its confirm question waits (the broker's own when left out: 10 minutes). */
  gateTimeoutMs?: number;
  /** Hears the tool's progress, as a turn's log does (MCP: the client's progress notifications). */
  onProgress?: (fraction: number | null, label: string) => void;
  /**
   * Who asks for the call when it isn't the Assistant (MCP: another app on this PC, as
   * privacy.ts mcpAppText words it): its confirm question says so.
   */
  app?: string;
  /**
   * The caller's last check, after any question and right before the tool runs (MCP: the
   * privacy rules read again): a result stops the call there, unrun.
   */
  beforeRun?: () => Promise<RunResult | null>;
  /**
   * The privacy of another project than the turn's (core host tools spec C5, §9.2): a call whose
   * tool names a project (projectOf) other than ctx.projectId asks for that project's consent
   * (LIST_CONSENT_KEY: the project list's) before it runs. A refusal comes back as `{code,
   * message}` and the call doesn't run; the turn goes on.
   */
  privacyFor?: (projectId: string, signal: AbortSignal) => Promise<{ code: string; message: string } | null>;
}


/** The project a call reads, when it is not the turn's own (null: the turn's, or no project data). */
export function otherProjectOf(def: ToolDef, input: Record<string, unknown>, ctx: ToolCtx): string | null {
  const of = def.projectOf;
  if (typeof of !== 'function') return null;
  let id: string | null = null;
  try {
    id = of.call(def, input, ctx);
  } catch {
    id = null;
  }
  return id && id !== (ctx.projectId ?? '') ? id : null;
}

export interface RunResult {
  part: ToolResultPart;
  ok: boolean;
  /** null when it ran and succeeded; else the error code. */
  code: string | null;
  /** A failed call's hint, as the model has it (for the log). */
  hint?: string;
  summary: string;
  /** The person's links of a result (links.ts): the log's tool_result only. */
  links?: ToolLink[];
}

const RISKS: readonly Risk[] = ['read', 'edit', 'compute', 'destructive'];
/** How long a tool's escalate may take: past it, the call counts as destructive. */
export const ESCALATE_MAX_MS = 10_000;
/** The card's words when a tool's escalate failed or took too long. */
export const ESCALATE_FAILED_NOTE = 'Magnusim could not check what this changes, so it asks.';
/** The log's line when a chain grant covered a call: the job's label follows. */
export const COVERED_NOTE = 'Covered by your earlier approval: ';
/** How long an aborted tool may take to give its last answer. */
export const ABORT_GRACE_MS = 2_000;
/**
 * The most of one call's waits for the person (progress `waiting`) that the turn's minutes
 * leave out. CAD's longest call waits twice, up to 10 minutes each (for the person, then for
 * their Keep or Discard); past this its waiting counts toward the turn's minutes.
 */
export const WAIT_PAUSE_MAX_MS = 20 * 60_000;
/** The log's line when a call's waits used WAIT_PAUSE_MAX_MS. */
export const WAITED_TOO_LONG_NOTE = `A call has waited for you ${WAIT_PAUSE_MAX_MS / 60_000} minutes: from now on its waiting counts toward the turn's minutes.`;
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

/**
 * A stopped call's result text: by the person, because the server stopped, or for `cause` (the
 * agent that ran it exited, the app went): never the person's doing when it wasn't.
 */
export function stoppedText(running: boolean, server = false, cause?: string | null): string {
  if (server) return running ? SERVER_DURING : SERVER_BEFORE;
  if (cause) return running ? `${cause} while it ran; it may or may not have finished.` : `${cause} before this ran.`;
  return running ? STOPPED_DURING : STOPPED_BEFORE;
}

export function riskOf(def: ToolDef | null): Risk {
  return def && RISKS.includes(def.risk) ? def.risk : 'destructive';
}

/** The higher of two risks (read < edit < compute < destructive); an unknown one counts as destructive. */
export function maxRisk(a: Risk, b: Risk | null | undefined): Risk {
  if (b === null || b === undefined) return RISKS.includes(a) ? a : 'destructive';
  const i = RISKS.indexOf(a);
  const j = RISKS.indexOf(b);
  return i < 0 || j < 0 ? 'destructive' : RISKS[Math.max(i, j)];
}

/** The job ids a call's `chain` names (its tool has chainKey): strings of 1-100 characters, at most CHAIN_MAX. */
export function chainOf(def: ToolDef, input: Record<string, unknown>): string[] {
  if (!def.chainKey || !Array.isArray(input.chain)) return [];
  return [...new Set(input.chain.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 100))].slice(0, CHAIN_MAX);
}

/** The card's names of the chained jobs (escalate's `labels`), cleaned; the ids without one are left out. */
function labelsOf(assessed: Assessed | null, chain: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const given = assessed?.labels;
  if (!given || typeof given !== 'object') return out;
  for (const id of chain) {
    const label = typeof given[id] === 'string' ? cleanText(given[id], TEXT_CAPS.name) : '';
    if (label) out[id] = label;
  }
  return out;
}

/** Who offers the tool, as the person reads it. */
export function sourceLabel(source: ToolSource | null): string {
  if (!source) return '';
  if (source.kind === 'host' || source.kind === 'core') return 'Magnusim';
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

/** The tool_call event for a call (also for calls that don't run); `risk`: the call's own when it escalated. */
export function toolCallEvent(call: ToolCallPart, def: ToolDef | null, step: number, risk?: Risk): RunnerEvent {
  return {
    type: 'tool_call',
    step,
    call: call.callId,
    tool: cleanText(call.name, 64),
    title: cleanText(def?.title ?? call.name, TEXT_CAPS.name),
    risk: risk ?? riskOf(def),
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
    return {
      code: r.code,
      ...(r.text ? { text: r.text } : {}),
      ...(r.server === true ? { server: true } : {}),
      ...(typeof r.cause === 'string' && r.cause ? { cause: r.cause } : {}),
    };
  }
  return { code: 'stopped' };
}

/**
 * The result of a call stopped by `why`: before its tool ran, or while it ran (`running`: it may or
 * may not have finished). An agent turn that ends with a call still open logs this for it.
 */
export function abortedResult(call: ToolCallPart, why: CallAbort, running: boolean): RunResult {
  if (why.code === 'capped') {
    const text = why.text || 'This turn reached a limit.';
    return errorResult(call, 'capped', running ? `Stopped: ${text} It may or may not have finished.` : `Not run: ${text}`);
  }
  if (why.code === 'stalled') return errorResult(call, 'stalled', why.text || 'No progress for too long; it was stopped and may or may not have finished.');
  return errorResult(call, 'stopped', stoppedText(running, why.server === true, why.cause));
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

const ASSISTANT_ASKS = 'Allow the Assistant to ';
const APP_ASKS = 'Allow an app on this PC to ';

/** What the question knows of the call beyond its tool: its risk once escalated, and what the escalation found. */
export interface GateCall {
  risk?: Risk;
  assessed?: Assessed | null;
}

/**
 * The confirm question for a compute or destructive call: the Assistant's, or (`app`, who
 * asks in its stead) another app's. The tool's own words when it has them (gateText: title,
 * copy and rows); else a destructive call's confirm note (or what its escalation found) says
 * what it does in place of "can't be undone", a compute call's "starts a computation" (or what
 * its escalation found), with every field it sent. Rows: the tool's, else the escalation's, else
 * describe()'s (at most 6).
 */
export function confirmGate(def: ToolDef, input: Record<string, unknown>, turn: string | null, app?: string, call: GateCall = {}): GateRequest {
  const risk: 'compute' | 'destructive' = (call.risk ?? riskOf(def)) === 'compute' ? 'compute' : 'destructive';
  const assessed = call.assessed ?? null;
  let own: { title: string; copy: string; detail?: GateDetail[] } | null = null;
  try {
    own = def.gateText?.(input, assessed) ?? null;
  } catch {
    own = null;
  }
  let detail: GateDetail[] | undefined;
  try {
    detail = own?.detail?.length ? own.detail : assessed?.detail?.length ? assessed.detail : def.describe?.(input)?.detail;
  } catch {
    detail = undefined;
  }
  detail = detail?.slice(0, 6);
  const head = {
    kind: 'confirm' as const,
    turn,
    yes: 'Allow',
    no: "Don't",
    ...(detail?.length ? { detail } : {}),
    risk,
    tool: def.name,
    source: sourceLabel(def.source),
  };
  const ownTitle = own ? cleanText(own.title, TEXT_CAPS.name) : '';
  const ownCopy = own ? cleanText(own.copy, 1500) : '';
  if (ownTitle && ownCopy) {
    const title = app && ownTitle.startsWith(ASSISTANT_ASKS) ? `${APP_ASKS}${ownTitle.slice(ASSISTANT_ASKS.length)}` : ownTitle;
    return { ...head, title, copy: `${app ? `${app} asks for this. ` : ''}${ownCopy}` };
  }
  let sent = '';
  try {
    sent = gateInputText(def.schema, input);
  } catch {
    sent = '(unreadable)';
  }
  const found = cleanText(assessed?.note, CONFIRM_NOTE_MAX);
  const note = risk === 'destructive' ? cleanText(def.confirmNote, CONFIRM_NOTE_MAX) : '';
  const what = found || (risk === 'compute' ? 'starts a computation' : note || "can't be undone");
  const action = lowerFirst(cleanText(def.title || def.name, TEXT_CAPS.name));
  return {
    ...head,
    title: app ? `${APP_ASKS}${action}?` : `${ASSISTANT_ASKS}${action}?`,
    copy: `${app ? `${app} asks for this. ` : ''}${sourceLabel(def.source)} · ${what}${/[.!?]$/.test(what) ? '' : '.'} What it sent: ${sent}. Nothing runs until you choose.`,
  };
}

export interface ToolRunnerOptions {
  gates: GateBroker;
  /** The chain grants (grants.ts); the server's own store when left out. */
  grants?: ChainGrants;
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
  private readonly grantsOf: () => ChainGrants;

  constructor(o: ToolRunnerOptions) {
    this.gates = o.gates;
    const own = o.grants;
    this.grantsOf = own ? () => own : serverGrants;
    this.fenced = o.fenced ?? (() => false);
    this.clock = o.clock ?? realClock;
    this.graceMs = o.abortGraceMs ?? ABORT_GRACE_MS;
  }

  async run(call: ToolCallPart, o: RunOptions): Promise<RunResult> {
    const started = this.clock.now();
    const def = o.offered.get(call.name) ?? null;
    // A tool that escalates is logged once its call's risk is known (or as it fails before).
    let logged = false;
    const announce = (risk?: Risk) => {
      if (logged) return;
      logged = true;
      o.turn?.emit(toolCallEvent(call, def, o.turn.step, risk));
    };
    if (!def?.escalate) announce();
    const r = await this.runResolved(call, def, o, announce);
    announce();
    // Its pictures (checked: the model gets the same ones) are kept for the window, by reference.
    let images: ImageRef[] = [];
    if (r.part.images.length && o.turn?.keepImages) {
      try {
        images = o.turn.keepImages(r.part.images);
      } catch {
        images = [];
      }
    }
    o.turn?.emit({
      type: 'tool_result',
      call: call.callId,
      ok: r.ok,
      ...(r.code ? { code: r.code } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
      summary: r.summary,
      ms: Math.max(0, this.clock.now() - started),
      ...(images.length ? { images } : {}),
      ...(r.links?.length ? { links: r.links } : {}),
    });
    return r;
  }

  private async runResolved(call: ToolCallPart, def: ToolDef | null, o: RunOptions, announce: (risk: Risk) => void): Promise<RunResult> {
    // 1. Only this step's list.
    if (!def) return errorResult(call, 'no_tool', `No tool named ${cleanText(call.name, 64)} in this step. Use only the tools listed.`);
    if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
    // 2-3. The input.
    if (call.inputError) return errorResult(call, 'invalid_input', call.inputError);
    let input = stripNullOptionals(def.schema, call.input ?? {}) as Record<string, unknown>;
    // A local model often leaves out the fields it has no use for: a workspace or host tool gets their empty values.
    if (o.ctx.local && def.source.kind !== 'plugin') input = fillLocalDefaults(def.schema, input) as Record<string, unknown>;
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
    // A refusal the tool knows from the input alone: before any question, so none is asked for nothing.
    if (def.refuse) {
      let no: ToolRefusal | null = null;
      try {
        no = await def.refuse(input, o.ctx);
      } catch {
        no = null;
      }
      if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
      if (no) return errorResult(call, no.code, no.message, no.hint);
    }
    // 5. This call's risk (raise-only), then ask first.
    const assessed = def.escalate ? await this.assess(def, input, o) : null;
    if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
    const risk = maxRisk(riskOf(def), assessed?.risk);
    announce(risk);
    if (risk === 'compute' || risk === 'destructive') {
      const owner = o.turn?.id ?? o.callTurn ?? null;
      const key = def.chainKey ? this.keyOf(def, input) : null;
      const store = this.grantsOf();
      // A chain grant covers a compute call of its own owner, each job once: never a destructive one.
      const covered = risk === 'compute' && owner && key ? store.consume(owner, key) : null;
      if (covered !== null) {
        // What the card called it (Start "Run 1"); the call's own line when the card named none.
        let label = covered;
        if (covered === key) {
          try {
            label = cleanText(def.describe?.(input)?.line, TEXT_CAPS.name) || covered;
          } catch {
            label = covered;
          }
        }
        o.turn?.note?.(`${COVERED_NOTE}${label}`);
      } else {
        o.turn?.setState('awaiting_confirmation');
        o.turn?.pause();
        let answer: 'allow' | 'deny';
        try {
          answer = await this.gates.ask(confirmGate(def, input, o.turn?.id ?? null, o.app, { risk, assessed }), o.owner, o.signal, { timeoutMs: o.gateTimeoutMs });
        } finally {
          o.turn?.resume();
          o.turn?.setState('tools');
        }
        if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
        if (answer !== 'allow') return errorResult(call, 'declined', 'The user declined this call; it did not run. Accept it and say what you would have done.');
        // Allowed with a chain: its other jobs run without a card, each once, for this owner,
        // only those the card named (escalate's labels): an Allow never covers a step the
        // person was not shown.
        const chain = chainOf(def, input).filter((j) => j !== key);
        const named = labelsOf(assessed, chain);
        const shown = chain.filter((j) => j in named);
        if (owner && shown.length) store.grant(owner, shown, named);
      }
    }
    // 5a. Another project's data: that project's consent (the turn goes on when it is refused).
    const other = o.privacyFor ? otherProjectOf(def, input, o.ctx) : null;
    if (other && o.privacyFor) {
      const refused = await o.privacyFor(other, o.signal);
      if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
      if (refused) return errorResult(call, refused.code, refused.message);
    }
    // 5b. The caller's last check (MCP: privacy, which may have changed while it asked).
    if (o.beforeRun) {
      const stop = await o.beforeRun();
      if (stop) return stop;
      if (o.signal.aborted) return this.abortedResult(call, o.signal, false);
    }
    // 6. Run it.
    return this.execute(call, def, input, o);
  }

  private abortedResult(call: ToolCallPart, signal: AbortSignal, running: boolean): RunResult {
    return abortedResult(call, callAbortOf(signal) ?? { code: 'stopped' }, running);
  }

  /** The job a call starts (chainKey), or null when the tool's own answer is not one. */
  private keyOf(def: ToolDef, input: Record<string, unknown>): string | null {
    try {
      const k = def.chainKey?.(input);
      return typeof k === 'string' && k.length > 0 && k.length <= 100 ? k : null;
    } catch {
      return null;
    }
  }

  /**
   * What the tool's escalate finds for this input, within ESCALATE_MAX_MS: a throw, a time-out
   * or an answer out of shape counts as destructive (it asks). Its own signal aborts with the
   * call's, or at the time-out.
   */
  private async assess(def: ToolDef, input: Record<string, unknown>, o: RunOptions): Promise<Assessed | null> {
    const failed: Assessed = { risk: 'destructive', note: ESCALATE_FAILED_NOTE, detail: [] };
    const late = new AbortController();
    const signal = AbortSignal.any([o.signal, late.signal]);
    let timer: unknown = null;
    // The time-out, or the call stopped meanwhile (the caller then answers the abort).
    const timedOut = new Promise<'late'>((resolve) => {
      timer = this.clock.setTimeout(() => late.abort(), ESCALATE_MAX_MS);
      if (signal.aborted) resolve('late');
      else signal.addEventListener('abort', () => resolve('late'), { once: true });
    });
    try {
      const got = await Promise.race([Promise.resolve().then(() => def.escalate?.(input, { ctx: o.ctx, signal, turn: o.turn?.id ?? o.callTurn ?? null })), timedOut]);
      if (got === 'late') return failed;
      if (got === null || got === undefined) return null;
      if (!got || typeof got !== 'object' || !['edit', 'compute', 'destructive'].includes(got.risk)) return failed;
      // A tool that words its own card (gateText) gets the whole note, cleaned: its card copy is longer than a confirm note.
      const labels = got.labels && typeof got.labels === 'object' && !Array.isArray(got.labels) ? { labels: got.labels } : {};
      return { risk: got.risk, note: cleanText(got.note, def.gateText ? GATE_NOTE_MAX : CONFIRM_NOTE_MAX), detail: Array.isArray(got.detail) ? got.detail.slice(0, 6) : [], ...labels };
    } catch {
      return failed;
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  private async execute(call: ToolCallPart, def: ToolDef, input: Record<string, unknown>, o: RunOptions): Promise<RunResult> {
    const stallMs = def.stallMs + (def.source.kind === 'workspace' || def.source.kind === 'core' ? WORKSPACE_STALL_MARGIN_MS : 0);
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
    // The call waits for the person (its last progress said so): the turn's minutes are paused,
    // for WAIT_PAUSE_MAX_MS of the call's waits at most.
    let waiting = false;
    let waitedMs = 0;
    let waitFrom = 0;
    let waitTimer: unknown = null;
    let finished = false;
    const wait = (on: boolean) => {
      if (on === waiting || (on && waitedMs >= WAIT_PAUSE_MAX_MS)) return;
      waiting = on;
      if (on) {
        waitFrom = clock.now();
        o.turn?.pause();
        waitTimer = clock.setTimeout(() => {
          waitTimer = null;
          wait(false);
          o.turn?.note?.(WAITED_TOO_LONG_NOTE);
        }, WAIT_PAUSE_MAX_MS - waitedMs);
        return;
      }
      clock.clearTimeout(waitTimer);
      waitTimer = null;
      waitedMs += Math.max(0, clock.now() - waitFrom);
      o.turn?.resume();
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
      // `waiting`: the page says this call waits for the person (the dock says where), even past
      // WAIT_PAUSE_MAX_MS, when its waits count toward the turn's minutes again.
      o.turn?.emit({ type: 'tool_progress', call: call.callId, fraction: f, label: text, ...(opts?.waiting === true ? { waiting: true as const } : {}) });
      try {
        o.onProgress?.(f, text);
      } catch {
        /* a listener's failure never stops the tool */
      }
    };

    let outcome: ToolOutcome | null = null;
    let graceTimer: unknown = null;
    let onAbort: (() => void) | null = null;
    const released = new AbortController();
    const ran = Promise.resolve()
      .then(() => def.run(input, { signal, ctx: o.ctx, turn: o.turn?.id ?? o.callTurn ?? null, progress, released: released.signal, ...(o.step ? { step: o.step } : {}) }))
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
    const links = safeLinks(outcome.links);
    return { part, ok: true, code: null, summary, ...(links.length ? { links } : {}) };
  }
}
