/**
 * Magnusim's tools over MCP (phase 3 spec 3.1-3.4, 3.7-3.10): one SDK server per
 * connection the listener admits.
 *
 * - Each connection is served by the SDK's serveStdio (loaded through load-sdk.ts), which
 *   picks the protocol era per connection (2026-07-28 through server/discover, 2025-11-25
 *   through initialize), with a low-level Server answering tools/list and tools/call.
 * - The list is the registry's toolsFor(ctx) (the 40-tool cap), each tool under its MCP
 *   name (names.ts), with read-only and destructive hints. An external app's context is
 *   the only connected app tab (TurnManager.resolveTab('auto'): every Magnusim window counts,
 *   by its core page, core host tools spec C7), read per request; with none, or more than one,
 *   it is tab-less: host tools only (the Home subset, each project tool by its project_id), and
 *   the reason in the answer to a call of a tool it can't see. With more than one, a call whose
 *   project_id is open in exactly one window runs in that window's context (§9.5).
 * - A call resolves only in the list last served on that connection (before any
 *   tools/list, the current list counts as served at the call), runs through ToolRunner
 *   (schema validation, the epoch fence, availability, questions, stall windows and
 *   result caps), one at a time per connection in arrival order (16 at most at once,
 *   `busy` past that), and comes back as the same cleaned JSON text the Assistant's model
 *   gets, plus its images; `isError` for an error. An external app's call is made by no turn
 *   of the Assistant's: its tool is told the turn `mcp:<connection id>`, the same for every
 *   call on that connection (a workspace page's AssistantCall.turn, which groups its undo).
 * - Privacy (spec 3.6): every external app counts as off this PC, under one destination,
 *   `mcp` ("Other apps on this PC"). Until Settings → Assistant allows the tab's project for
 *   it (Always allow, or an Allow remembered for the project), external apps are offered
 *   workspace and other plugin tools without their registration text (a generic
 *   description, schemas without enums, descriptions, titles, consts, defaults or examples),
 *   whatever their projectData flag, and their instructions carry no workspace guide: a
 *   registration's text can hold project names. Before a tool that reads project data runs
 *   (the project its call names, projectOf, else the tab's; the project list is asked about as
 *   one more "project", once for every app, §9.3), the mode is read live: Never send refuses it (`privacy_denied`); Ask opens the question
 *   in the tab ("Let other apps read project …?", one answer for every app: calls while it is
 *   open wait on that same question, and it is withdrawn only when every call waiting on it
 *   has gone), and Allow is remembered and every app's list changes (list_changed); Don't
 *   allow, the timeout or a cancel leave it unrun (`declined`, `stopped`), and a Don't allow
 *   holds for every app for 10 minutes (`declined` at once, no question). The mode is read
 *   again right before the tool runs (after its own question) and before its result goes: a
 *   result of a tool that ran while privacy turned against other apps stays here.
 *   A call never quotes withheld text back: a tool that can't run here now is answered
 *   before its input is read, and an input a tool listed without its words refuses is told
 *   without the schema's enum or const values.
 * - Questions (spec 3.5): a compute or destructive tool asks first, as the Assistant's do: the
 *   gate's owner is {kind:'mcp', session, tab} (the tab the call runs in), the page relay
 *   shows it as the app's own dialog with No focused, and only that tab's link answers it:
 *   an MCP client never can (no elicitation, no answer key). Its title says another app asks
 *   ("Allow an app on this PC to …?", the app named as it calls itself), not the Assistant.
 *   It waits 10 minutes. With no tab to show it, the call of a tool that can run tab-less is
 *   refused at once (`no_window`); one of a list that went is `unavailable` with the hint to
 *   list the tools again. While a question waits, a request that carried a progressToken
 *   gets notifications/progress at once and every 15 s ("Waiting for an answer in Magnusim",
 *   and "…its window is hidden or closed…" once its tab has had no live link for 15 s),
 *   which keeps clients that reset their timeout on progress waiting.
 *   A tool's own progress is passed on the same way. An agent binding's call gets both too:
 *   its dispatch is handed the progress and says which of its turn's questions are its own.
 * - Cancellation: the client's notifications/cancelled is a Stop for that call (a question it
 *   waits on closes, `stopped`); a waiting call leaves the queue at once.
 * - List changes (spec 3.4): the registry's changes (registry.onChange), and a check before
 *   and after each call (sources are pure functions), recompute the list of each connection
 *   that listed; one that differs from the list last served sends
 *   notifications/tools/list_changed once (a modern-era client hears it on its
 *   subscriptions/listen stream).
 * - External apps share process-wide rates (a reconnect doesn't reset them): 120 change
 *   calls and 1200 calls per rolling hour (`rate_limited`, with the time to wait).
 * - Other apps turned off: the settings save closes external apps' connections
 *   (listener.ts), and each external list and call reads the switch again, so nothing
 *   waiting runs after it (`clients_off`).
 * - A Settings Test binding (sessions.ts) is served only connection_check, by its own
 *   path: the canned answer, without ToolRunner. Another agent binding's calls run in its
 *   turn (AgentDispatch); with no turn on it, nothing runs (`stopped`).
 * - A connection that closes aborts its calls, running and queued ("The server
 *   stopped…" when Magnusim closed it). The log has one line per connection open and
 *   close, one per call and the listener's refused handshakes: never inputs, results,
 *   arguments or the token.
 */
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { GATE_TIMEOUT_MS, realClock, type Clock, type GateAnswer, type GateBroker, type GateOwner } from '../gates.ts';
import { appVersion } from '../host-tools.ts';
import { alog } from '../log.ts';
import {
  isProjectList,
  LIST_CONSENT_KEY,
  MCP_DESTINATION,
  MCP_PRIVACY_DENIED_TEXT,
  mcpAppText,
  mcpPrivacyGate,
  mcpProjectListGate,
  privacyDecision,
  remember as rememberConsent,
  type ProjectInfo,
} from '../privacy.ts';
import { isCadEdition } from '../../../edition.js';
import { appWords, guideBlock, LEFT_OUT_RULE, systemPrompt } from '../prompt.ts';
import { CONNECTION_CHECK, CONNECTION_CHECK_SCHEMA } from '../provider-test.ts';
import { loadMcpSdk, type McpSdkModules } from '../providers/load-sdk.ts';
import type { Registry, ToolCtx, ToolDef } from '../registry.ts';
import { grants } from '../grants.ts';
import { callAbortOf, errorResult, riskOf, sourceLabel, STOPPED_BEFORE, stoppedText, type CallAbort, type RunResult, type ToolRunner } from '../runner.ts';
import { cleanText, resultText } from '../sanitize.ts';
import { emitSchema, stripNullOptionals, validateInput } from '../schema.ts';
import type { AssistantSettings } from '../settings.ts';
import { onAssistantShutdown } from '../state.ts';
import type { Risk, ToolCallPart } from '../types.ts';
import { CLIENTS_OFF_TEXT, type McpAdmission, type McpConnection, type McpHandler, type McpHello } from './listener.ts';
import { servedMap } from './names.ts';
import { bindingEntry, bindingPrompts, CallQueue, claimBinding, noteBindingServed, type BindingClaim, type McpSession } from './sessions.ts';

/** A line longer than this closes the connection (the SDK's default is 10 MB). */
export const MCP_LINE_MAX = 8 * 1024 * 1024;
/** External apps' calls per rolling hour, process-wide. */
export const MCP_RATES = Object.freeze({ calls: 1200, changes: 120, windowMs: 60 * 60_000 });

export function mcpInstructions(cad: boolean = isCadEdition()): string {
  const app = appWords(cad).app;
  const name = app.split(',')[0];
  return [
    `These are ${name}'s tools. ${name} is ${app.slice(name.length + 2)} on this PC, and the tools act in it for the person at this PC.`,
    ...systemPrompt(cad)
      .split('\n')
      .slice(1)
      .filter((line) => line !== LEFT_OUT_RULE),
  ].join('\n');
}

export const MCP_INSTRUCTIONS = mcpInstructions(false);

/** How long an external app's question waits before it is declined. */
export const MCP_GATE_TIMEOUT_MS = GATE_TIMEOUT_MS;
/** How often a waiting question tells the client it still waits. */
export const WAIT_PROGRESS_MS = 15_000;
export const WAITING_TEXT = 'Waiting for an answer in Magnusim';
export const WAITING_HIDDEN_TEXT = 'Waiting for an answer in Magnusim: its window is hidden or closed. Show it to answer.';
export const PRIVACY_DECLINED_TEXT = "The person didn't allow other apps to read this project's data, so the tool did not run. Nothing was read.";
export const PROJECT_UNREADABLE_TEXT = "Magnusim couldn't read this project's row, so it can't ask about its data; the tool did not run.";
export const NO_WINDOW_TEXT =
  'Magnusim asks the person before this tool runs, and only in its own window, but no app tab can show the question now. Show one Magnusim window (or name a project open in exactly one), then call it again.';
export const TOOLS_CHANGED_HINT = 'The tools changed. List the tools again.';
/** Why an app's list has no tab's tools, worded for an app (a turn's words tell a person to name a tab). */
export const NO_APP_TAB_TEXT = "No Magnusim window is open, so only Magnusim's own tools are offered, each project tool by its project_id. Open Magnusim, then list the tools again.";
export const MANY_APP_TABS_TEXT =
  "More than one app tab of Magnusim is open, so only Magnusim's own tools are offered, each project tool by its project_id (a project open in one window is read in that window). Leave one open, then list the tools again.";
export const HIDDEN_APP_TAB_TEXT =
  "The Magnusim window is in the background or covered, or it was closed, so only Magnusim's own tools are offered. Show it, then list the tools again.";
const APP_TAB_TEXTS = new Map([
  ['no_tab', NO_APP_TAB_TEXT],
  ['ambiguous_tab', MANY_APP_TABS_TEXT],
  ['tab_hidden', HIDDEN_APP_TAB_TEXT],
]);
/** A tool listed without its registration's words, given a value its full schema refuses (an enum's or a const's, which stay unsaid). */
export const WITHHELD_INPUT_TEXT = "A value isn't one this tool takes. Its details show once you allow this project's data.";
/** After "Don't allow", no app is asked about that project again for this long. */
export const PRIVACY_DECLINE_HOLD_MS = 10 * 60_000;
/** A call while a "Don't allow" holds: `ms` is how long it still holds. */
export function privacyHeldText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `The person didn't allow other apps to read this project's data, so the tool did not run. Nothing was read. Magnusim asks again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
/** A tool that ran while the privacy rules turned against other apps: its result stays here. */
export const RESULT_KEPT_TEXT = 'Settings → Assistant changed while the tool ran, and other apps may not read this project now. It ran, but its result was not sent.';
/** A project's row is read again after this long (the privacy rules need its created_at). */
const PROJECT_KEEP_MS = 10_000;
export const NOTHING_RUNS_TEXT = "Nothing runs between messages: the person hasn't sent one, or stopped it.";
const BUSY_CALLS_TEXT = 'Too many calls are waiting on this connection (16 at most). Wait for one to finish.';
const BINDING_TEXT = 'That coding-agent session has ended.';
const BINDING_IN_USE_TEXT = 'That coding-agent session is already connected.';
/** Socket errors of a client that went away: not worth a log line. */
const SOCKET_GONE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

// ---------------------------------------------------------------- the SDK, as used here

interface SdkContext {
  mcpReq: {
    signal: AbortSignal;
    envelope?: Record<string, unknown>;
    /** The request's own _meta (its progressToken). */
    _meta?: Record<string, unknown>;
    /** A notification about this request (progress). */
    notify(n: { method: string; params?: Record<string, unknown> }): Promise<void>;
  };
}
interface SdkServer {
  setRequestHandler(method: string, handler: (request: { params?: Record<string, unknown> }, ctx: SdkContext) => unknown): void;
  getClientVersion(): unknown;
  sendToolListChanged(): Promise<void>;
}
type SdkServerCtor = new (
  info: { name: string; version: string },
  options: { capabilities: Record<string, unknown>; instructions?: string },
) => SdkServer;
interface SdkTransport {
  onclose?: () => void;
}
type SdkTransportCtor = new (input: Readable, output: Writable, options?: { maxBufferSize?: number }) => SdkTransport;
type SdkServeStdio = (
  factory: (o: { era: string }) => Promise<SdkServer>,
  options: { transport: SdkTransport; onerror?: (err: Error) => void },
) => { close(): Promise<void> };

interface Sdk {
  Server: SdkServerCtor;
  StdioServerTransport: SdkTransportCtor;
  serveStdio: SdkServeStdio;
}

function sdkOf(m: McpSdkModules): Sdk {
  return {
    Server: m.server.Server as SdkServerCtor,
    StdioServerTransport: m.stdio.StdioServerTransport as SdkTransportCtor,
    serveStdio: m.stdio.serveStdio as SdkServeStdio,
  };
}

// ---------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Where an app's calls answer to (chat_history asks before a saved chat's words go there). */
const APP_DESTINATION = Object.freeze({ key: MCP_DESTINATION, label: 'the app that asks' });

/** No tab (none, or two or more windows): Home (core host tools spec 9.5); each project tool by its project_id. */
const TABLESS: ToolCtx = Object.freeze({ tab: null, projectId: null, simulationId: null, cloud: true, local: false, place: 'home', budgetTokens: null, prompt: null, destination: APP_DESTINATION });

/** Schema keys that carry a registration's own words or values. */
const WITHHELD_KEYS = new Set(['description', 'title', 'enum', 'const', 'default', 'examples']);

/** A schema with every key that carries registration text removed, at every depth. */
export function withheldSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withheldSchema);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(node)) {
    if (WITHHELD_KEYS.has(key)) continue;
    let value: unknown;
    if (key === 'properties' && isRecord(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(v)) {
        Object.defineProperty(props, name, { value: withheldSchema(child), enumerable: true, writable: true, configurable: true });
      }
      value = props;
    } else value = withheldSchema(v);
    out[key] = value;
  }
  return out;
}

function pluginNameOf(def: ToolDef): string {
  const s = def.source;
  if (s.kind === 'workspace') return s.pluginName;
  if (s.kind === 'plugin') return cleanText(s.plugin, 80);
  return 'Magnusim';
}

/** A tool's MCP listing: in full, or (withheld) without its registration's words. */
export function toolView(name: string, def: ToolDef, withheld: boolean): Record<string, unknown> {
  const risk: Risk = riskOf(def);
  const annotations: Record<string, unknown> = {
    readOnlyHint: risk === 'read',
    destructiveHint: risk === 'destructive',
    idempotentHint: false,
    openWorldHint: false,
  };
  if (withheld) {
    return {
      name,
      description: `A tool of the ${pluginNameOf(def)} workspace; its details show once you allow this project's data.`,
      inputSchema: withheldSchema(def.schema),
      annotations,
    };
  }
  return {
    name,
    title: def.title,
    description: def.description,
    // As validated: the plain dialect (constraints kept, not strict).
    inputSchema: emitSchema('openai_compatible', def.schema),
    annotations: { ...annotations, title: def.title },
  };
}

/** The result as an MCP CallToolResult: the cleaned JSON text, then the images; isError on an error. */
function toMcpResult(r: RunResult): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: r.part.text }, ...r.part.images.map((i) => ({ type: 'image', data: i.base64, mimeType: i.mediaType }))],
    ...(r.ok ? {} : { isError: true }),
  };
}

/** `r` (an error) again with `hint`. */
function withHint(call: ToolCallPart, r: RunResult, hint: string): RunResult {
  let message = r.summary;
  try {
    const body = JSON.parse(r.part.text) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    /* the summary stands in */
  }
  return errorResult(call, r.code ?? 'failed', message, hint);
}

/**
 * Why `input` doesn't fit a tool listed without its registration's words, saying only what
 * the listed schema shows: its own words when that schema refuses it too, else the plain
 * text (the full schema refused a value of an enum or a const).
 */
function withheldInputError(def: ToolDef, input: Record<string, unknown> | undefined): string {
  try {
    const schema = withheldSchema(def.schema) as Record<string, unknown>;
    const valid = validateInput(schema, stripNullOptionals(schema, input ?? {}));
    if (!valid.ok) return valid.error;
  } catch {
    /* the plain text */
  }
  return WITHHELD_INPUT_TEXT;
}

/** The SDK's abort of a request whose connection closed (its SdkError CONNECTION_CLOSED). */
function connectionClosed(reason: unknown): boolean {
  return reason instanceof Error && (reason as { code?: unknown }).code === 'CONNECTION_CLOSED';
}

/** `p`'s value, or 'aborted' as soon as `signal` aborts (`p` goes on). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** A call's progress notifications: only when its request carried a progressToken. */
interface ProgressSender {
  /** `fraction` (0..1) known: progress round(fraction*100) of 100; else the count of updates. Always increasing. */
  send(fraction: number | null, message: string): void;
  /** The call answered: nothing more is sent for its token. */
  close(): void;
}

function progressOf(ctx: SdkContext): ProgressSender | null {
  const token = ctx.mcpReq._meta?.progressToken;
  if (typeof token !== 'string' && typeof token !== 'number') return null;
  let last = 0;
  let closed = false;
  return {
    send(fraction, message) {
      if (closed) return;
      const known = typeof fraction === 'number' && Number.isFinite(fraction);
      let value = known ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : last + 1;
      if (value <= last) value = last + 1;
      last = value;
      const params: Record<string, unknown> = { progressToken: token, progress: value };
      if (known && value <= 100) params.total = 100;
      if (message) params.message = message;
      ctx.mcpReq.notify({ method: 'notifications/progress', params }).catch(() => {});
    },
    close() {
      closed = true;
    },
  };
}

/**
 * A tool as a list's signature counts it. A host or workspace tool by its own object: a tab
 * that registers again offers new tools even under the same names (the earlier ones are
 * unavailable), so the list changed. Another source's tool by what it says: a source is a
 * pure function that may build its tools afresh at each call.
 */
const DEF_IDS = new WeakMap<ToolDef, string>();
let defSerial = 0;
function defKey(def: ToolDef): string {
  const kind = def.source.kind;
  if (kind !== 'host' && kind !== 'workspace') {
    try {
      const text = JSON.stringify([def.title, def.description, def.schema, def.risk, def.projectData, def.source]);
      return `c${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
    } catch {
      /* not plain JSON: counted by its object */
    }
  }
  let n = DEF_IDS.get(def);
  if (n === undefined) {
    n = `i${++defSerial}`;
    DEF_IDS.set(def, n);
  }
  return n;
}

// ---------------------------------------------------------------- rates (process-wide)

const RATES = Symbol.for('magnusim.assistant.mcpRates');

interface RateLog {
  all: number[];
  changes: number[];
}

function rateLog(): RateLog {
  const g = globalThis as unknown as Record<symbol, RateLog | undefined>;
  let r = g[RATES];
  if (!r) {
    r = { all: [], changes: [] };
    g[RATES] = r;
  }
  return r;
}

/** Takes one external call of `risk` now, or says how long to wait. */
function takeRate(now: number, risk: Risk): { ok: true } | { ok: false; text: string } {
  const log = rateLog();
  const since = now - MCP_RATES.windowMs;
  while (log.all.length && log.all[0] <= since) log.all.shift();
  while (log.changes.length && log.changes[0] <= since) log.changes.shift();
  const wait = (oldest: number) => {
    const minutes = Math.max(1, Math.ceil((oldest + MCP_RATES.windowMs - now) / 60_000));
    return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  };
  if (log.all.length >= MCP_RATES.calls) {
    return { ok: false, text: `Other apps reached Magnusim's limit of ${MCP_RATES.calls} tool calls an hour. ${wait(log.all[0])}` };
  }
  const change = risk !== 'read';
  if (change && log.changes.length >= MCP_RATES.changes) {
    return { ok: false, text: `Other apps reached Magnusim's limit of ${MCP_RATES.changes} changes an hour. ${wait(log.changes[0])}` };
  }
  log.all.push(now);
  if (change) log.changes.push(now);
  return { ok: true };
}

/** Tests only: forget the external calls counted so far. */
export function resetMcpRatesForTests(): void {
  const log = rateLog();
  log.all.length = 0;
  log.changes.length = 0;
}

// ---------------------------------------------------------------- the service

export interface McpServiceDeps {
  registry: Registry;
  runner: ToolRunner;
  /** The questions' broker (TurnManager.gates): a call's questions are asked through it and watched for wait progress. */
  gates: GateBroker;
  /** TurnManager.resolveTab: the only connected app tab ('auto'), or why there is none. */
  resolveTab(target: string): { tab: string; projectId: string; studyId: string } | { status: number; body: Record<string, unknown> };
  /** TurnManager.resolveTabForProject: the one connected app tab showing a project, or null (§9.5). */
  resolveTabForProject?(projectId: string): { tab: string; projectId: string; studyId: string } | null;
  settings(): Promise<AssistantSettings>;
  /** A project's row (its title and created_at), for the privacy rules (privacy.ts projectLookup); none: unreadable. */
  projects?: (id: string, o: { signal: AbortSignal; turn: string }) => Promise<ProjectInfo | null>;
  /** Remembers an Allow for a project and destination (privacy.ts remember, by default). */
  remember?: (projectId: string, createdAt: string | null, destination: string) => Promise<void>;
  clock?: Clock;
  /** The MCP package (load-sdk.ts loadMcpSdk). */
  sdk?: () => Promise<McpSdkModules>;
  /** The app's version, for the server's info. */
  version?: () => Promise<string>;
}

export interface McpService {
  /** For setMcpHandler. */
  readonly handler: McpHandler;
  /** The sessions it serves now. */
  sessions(): McpSession[];
}

/** A list as computed for a session now: what it serves, whether registration text is withheld, and its signature. */
interface ListView {
  served: Map<string, ToolDef>;
  /** External apps before privacy allows the project: workspace and plugin tools without their registration text. */
  withheld: boolean;
  sig: string;
}

/** A connection's own state beyond its session. */
interface Live {
  /** The SDK instance serving it (the last the factory made: serveStdio may make a probe first). */
  server: SdkServer | null;
  /** The signature of the list last served (null before any tools/list). */
  servedSig: string | null;
  /** The signature last announced with list_changed. */
  notifiedSig: string | null;
  checking: boolean;
  again: boolean;
  closed: boolean;
}

/** How an open privacy question ended, for every call that waited on it. */
type PrivacyOutcome = 'allow' | 'declined' | 'privacy_denied' | 'stopped';

/** An open "Let other apps read project …?" question: one per tab and project, shared by every app's calls. */
interface PrivacyAsk {
  /** Its gate's id. */
  gate: string | null;
  /** The calls waiting on it: the last one to go (cancelled, its connection closed) withdraws it. */
  waiters: number;
  stop: AbortController;
  outcome: Promise<PrivacyOutcome>;
}

/** A running call's wait progress: the questions it waits on, each told at once and every 15 s. */
interface Watch {
  /** Starts telling of this open question (once per question). */
  follow(gate: string): void;
  stop(): void;
}

const NO_WATCH: Watch = Object.freeze({ follow: () => {}, stop: () => {} });

export function createMcpService(d: McpServiceDeps): McpService {
  const clock = d.clock ?? realClock;
  const loadSdk = d.sdk ?? loadMcpSdk;
  const version = d.version ?? appVersion;
  const remember = d.remember ?? rememberConsent;
  const sessions = new Map<string, McpSession>();
  const lives = new WeakMap<McpSession, Live>();
  /** Project rows read lately, per session (a client's calls in a row read it once). */
  const projectRows = new WeakMap<McpSession, Map<string, { row: ProjectInfo; at: number }>>();
  /** Open privacy questions, by tab and project (as it is now). */
  const privacyAsks = new Map<string, PrivacyAsk>();
  /** "Don't allow" answers by project (as it is now): until when each holds, for every app. */
  const declines = new Map<string, number>();

  /**
   * The context a session's tools are listed and run in now, and why it has no tab (worded for an
   * app). `projectId`: the project a call names; with two or more windows, the one window showing
   * it (if exactly one does) is the call's context (§9.5).
   */
  function contextOf(session: McpSession, projectId: string | null = null): { ctx: ToolCtx; why: string | null } {
    if (session.kind === 'agent') {
      const dispatch = session.binding ? bindingEntry(session.binding.id)?.dispatch : null;
      return { ctx: dispatch ? dispatch.ctx() : TABLESS, why: null };
    }
    const t = d.resolveTab('auto');
    if ('status' in t) {
      const hit = projectId ? (d.resolveTabForProject?.(projectId) ?? null) : null;
      if (hit) {
        const pid = hit.projectId || null;
        return { ctx: { tab: hit.tab, projectId: pid, simulationId: hit.studyId || null, cloud: true, local: false, place: d.registry.placeOf(hit.tab, pid), budgetTokens: null, prompt: null, destination: APP_DESTINATION }, why: null };
      }
      const why = APP_TAB_TEXTS.get(String(t.body.code)) ?? (typeof t.body.error === 'string' ? t.body.error : null);
      return { ctx: TABLESS, why };
    }
    const pid = t.projectId || null;
    return { ctx: { tab: t.tab, projectId: pid, simulationId: t.studyId || null, cloud: true, local: false, place: d.registry.placeOf(t.tab, pid), budgetTokens: null, prompt: null, destination: APP_DESTINATION }, why: null };
  }

  /**
   * The project a call reads (§9.2): the one its tool names (projectOf: its project_id, or the
   * project list), else the context's for a tool of project data. Null: no project data.
   */
  function projectOfCall(def: ToolDef, input: Record<string, unknown>, ctx: ToolCtx): string | null {
    const of = def.projectOf;
    if (typeof of === 'function') {
      try {
        return of.call(def, input, ctx) || null;
      } catch {
        return ctx.projectId;
      }
    }
    return def.projectData ? ctx.projectId : null;
  }

  /** The project's row, kept a moment per session; null when it can't be read. */
  async function projectRow(session: McpSession, id: string, signal: AbortSignal): Promise<ProjectInfo | null> {
    let rows = projectRows.get(session);
    if (!rows) {
      rows = new Map();
      projectRows.set(session, rows);
    }
    const kept = rows.get(id);
    if (kept && clock.now() - kept.at < PROJECT_KEEP_MS) return kept.row;
    let row: ProjectInfo | null = null;
    try {
      row = d.projects ? await d.projects(id, { signal, turn: session.id }) : null;
    } catch {
      row = null;
    }
    if (row) rows.set(id, { row, at: clock.now() });
    else rows.delete(id);
    return row;
  }

  /**
   * Whether an external app may see registration text now: Settings → Assistant always
   * allows project data, or allows the tab's project for other apps (an Allow remembered for
   * it as it is now). With no project, only Always allow does.
   */
  async function projectOpen(session: McpSession, ctx: ToolCtx): Promise<boolean> {
    if (session.kind !== 'external') return true;
    const s = await d.settings();
    if (s.privacy === 'allow') return true;
    if (s.privacy === 'deny' || !ctx.projectId) return false;
    const row = await projectRow(session, ctx.projectId, new AbortController().signal);
    if (!row) return false;
    return privacyDecision(s, { cloud: true, destination: MCP_DESTINATION, projectId: row.id, createdAt: row.created_at }) === 'allow';
  }

  function listFor(session: McpSession, ctx: ToolCtx, log: boolean): Map<string, ToolDef> {
    return servedMap(
      d.registry.toolsFor(ctx),
      log ? (name, served) => alog('warn', 'mcp tool name taken; the later tool is not served', { session: session.id, tool: cleanText(name, 64), served }) : undefined,
    );
  }

  async function viewOf(session: McpSession, log: boolean): Promise<ListView> {
    const { ctx } = contextOf(session);
    const served = listFor(session, ctx, log);
    const text = [...served.values()].some((def) => def.source.kind !== 'host');
    const withheld = text && !(await projectOpen(session, ctx));
    const sig = `${[...served].map(([name, def]) => `${name}:${defKey(def)}`).join('|')}#${withheld ? 'withheld' : 'full'}`;
    return { served, withheld, sig };
  }

  async function instructions(session: McpSession): Promise<string> {
    // A Test binding gets the rules alone. So does an external app until privacy allows the
    // project: the workspace guide is registration text, as the tools' own text is.
    const rules = mcpInstructions();
    if (session.binding?.test) return rules;
    const { ctx } = contextOf(session);
    const ws = ctx.tab ? d.registry.workspaceOf(ctx.tab) : null;
    if (!ws?.guide) return rules;
    if (!(await projectOpen(session, ctx).catch(() => false))) return rules;
    return `${rules}\n\n${guideBlock(ws.guide, ws.reg.pluginName || ws.reg.plugin)}`;
  }

  async function listTools(session: McpSession): Promise<Array<Record<string, unknown>>> {
    if (session.binding?.test) {
      // Listed: the Test's message waits for this (AgentSession.waitForTools).
      noteBindingServed(session.binding.id, [CONNECTION_CHECK.name]);
      return [
        {
          name: CONNECTION_CHECK.name,
          title: 'Check the connection',
          description: CONNECTION_CHECK.description,
          inputSchema: emitSchema('openai_compatible', CONNECTION_CHECK_SCHEMA),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
      ];
    }
    if (session.kind === 'external' && !(await d.settings()).mcp.clients) {
      // A JSON-RPC error with the Settings text (the SDK answers a thrown error's message).
      throw Object.assign(new Error(CLIENTS_OFF_TEXT), { data: { code: 'clients_off' } });
    }
    const view = await viewOf(session, true);
    session.served = view.served;
    // An agent turn's permission matcher counts only the tools listed to its agent.
    if (session.binding) noteBindingServed(session.binding.id, view.served.keys());
    const live = lives.get(session);
    if (live) {
      live.servedSig = view.sig;
      live.notifiedSig = null;
    }
    return [...view.served].map(([name, def]) => toolView(name, def, view.withheld && def.source.kind !== 'host'));
  }

  /**
   * Recomputes a connection's list (after a registry change, around each call, after an
   * Allow): one that differs from the list last served is announced once (list_changed).
   */
  function recheck(session: McpSession): void {
    const live = lives.get(session);
    if (!live || live.closed || session.binding?.test) return;
    if (live.checking) {
      live.again = true;
      return;
    }
    live.checking = true;
    void (async () => {
      try {
        do {
          live.again = false;
          if (live.servedSig === null || !live.server) return;
          if (session.kind === 'external' && !(await d.settings()).mcp.clients) return;
          const view = await viewOf(session, false);
          if (live.closed || view.sig === live.servedSig || view.sig === live.notifiedSig) continue;
          live.notifiedSig = view.sig;
          await live.server.sendToolListChanged().catch(() => {});
        } while (live.again && !live.closed);
      } catch {
        /* the next change or call checks again */
      } finally {
        live.checking = false;
      }
    })();
  }

  const recheckAll = () => {
    for (const s of sessions.values()) recheck(s);
  };

  /** A Settings Test binding's call: connection_check only, the canned answer, no ToolRunner. */
  function testCall(session: McpSession, call: ToolCallPart): RunResult {
    if (call.name !== CONNECTION_CHECK.name) {
      return errorResult(call, 'no_tool', `No tool named ${cleanText(call.name, 64)} on this connection. Use connection_check.`);
    }
    if (call.inputError) return errorResult(call, 'invalid_input', call.inputError);
    const valid = validateInput(CONNECTION_CHECK_SCHEMA, call.input);
    if (!valid.ok) return errorResult(call, 'invalid_input', valid.error);
    try {
      if (session.binding) bindingEntry(session.binding.id)?.onTestCall?.();
    } catch {
      /* the Test's record never fails the call */
    }
    const text = resultText(CONNECTION_CHECK.name, { ok: true, data: { word: 'ok' } });
    return { part: { type: 'tool_result', callId: call.callId, isError: false, text, images: [] }, ok: true, code: null, summary: 'Connection checked' };
  }

  /** A call that stopped before its tool ran: by the client's cancel, its connection closing, or the server. */
  function stoppedBefore(call: ToolCallPart, signal: AbortSignal): RunResult {
    const why = callAbortOf(signal);
    return errorResult(call, 'stopped', stoppedText(false, why?.server === true, why?.cause));
  }

  /** The privacy rules for an external app reading `projectId` now (the project list too), read live, with no question. */
  async function privacyNow(session: McpSession, call: ToolCallPart, projectId: string | null, signal: AbortSignal): Promise<{ ok: true } | { ok: false; r: RunResult } | { ok: 'ask'; project: ProjectInfo }> {
    if (!projectId) return { ok: true };
    const s = await d.settings();
    if (s.privacy === 'allow') return { ok: true };
    if (s.privacy === 'deny') return { ok: false, r: errorResult(call, 'privacy_denied', MCP_PRIVACY_DENIED_TEXT) };
    // The project list: one answer for every app, remembered under its reserved key (§9.3).
    if (isProjectList(projectId)) {
      const verdict = privacyDecision(s, { cloud: true, destination: MCP_DESTINATION, projectId: LIST_CONSENT_KEY, createdAt: null });
      return verdict === 'allow' ? { ok: true } : { ok: 'ask', project: { id: LIST_CONSENT_KEY, title: '', created_at: null } };
    }
    const project = await projectRow(session, projectId, signal);
    if (signal.aborted) return { ok: false, r: stoppedBefore(call, signal) };
    if (!project) return { ok: false, r: errorResult(call, 'project_unreadable', PROJECT_UNREADABLE_TEXT) };
    const verdict = privacyDecision(s, { cloud: true, destination: MCP_DESTINATION, projectId: project.id, createdAt: project.created_at });
    if (verdict === 'allow') return { ok: true };
    if (verdict === 'deny') return { ok: false, r: errorResult(call, 'privacy_denied', MCP_PRIVACY_DENIED_TEXT) };
    return { ok: 'ask', project };
  }

  /**
   * The privacy rules before an external app's call of a tool that reads project data
   * (spec 3.6), read live, before the tool runs (and again once its own question was
   * answered): null when it may run, else its answer.
   */
  async function requireProjectData(session: McpSession, call: ToolCallPart, def: ToolDef, ctx: ToolCtx, signal: AbortSignal, watch: Watch): Promise<RunResult | null> {
    if (session.kind !== 'external') return null;
    // The project the call names (a read of another project by its id), not only the tab's.
    const projectId = projectOfCall(def, call.input ?? {}, ctx);
    if (!projectId) return null;
    const now = await privacyNow(session, call, projectId, signal);
    if (now.ok === true) return null;
    if (now.ok === false) return now.r;
    // The question shows only in a Magnusim window: with none to show it, refused at once.
    if (!ctx.tab) return errorResult(call, 'no_window', NO_WINDOW_TEXT);
    return askPrivacy(session, call, ctx.tab, now.project, signal, watch);
  }

  /**
   * Asks "Let other apps read project …?" in the tab, once for every app: a call while the
   * project's question is open waits on that same question, and a "Don't allow" holds for
   * every app for PRIVACY_DECLINE_HOLD_MS (no question, `declined` at once). Allow is
   * remembered for destination mcp, and every app's list is checked again.
   */
  async function askPrivacy(session: McpSession, call: ToolCallPart, tab: string | null, project: ProjectInfo, signal: AbortSignal, watch: Watch): Promise<RunResult | null> {
    const pkey = `${project.id}\n${project.created_at ?? ''}`;
    const held = declines.get(pkey);
    if (held !== undefined) {
      if (clock.now() < held) return errorResult(call, 'declined', privacyHeldText(held - clock.now()));
      declines.delete(pkey);
    }
    const key = `${tab ?? ''}\n${pkey}`;
    const ask = privacyAsks.get(key) ?? openPrivacyAsk(key, pkey, session, tab, project);
    ask.waiters += 1;
    if (ask.gate) watch.follow(ask.gate);
    let outcome: PrivacyOutcome | 'aborted';
    try {
      outcome = await untilAborted(ask.outcome, signal);
    } finally {
      ask.waiters -= 1;
      // The last call waiting on it went: the question goes too (a call after asks again).
      if (ask.waiters === 0 && signal.aborted) {
        if (privacyAsks.get(key) === ask) privacyAsks.delete(key);
        ask.stop.abort();
      }
    }
    if (outcome === 'aborted' || outcome === 'stopped') return stoppedBefore(call, signal);
    if (outcome === 'declined') return errorResult(call, 'declined', PRIVACY_DECLINED_TEXT);
    if (outcome === 'privacy_denied') return errorResult(call, 'privacy_denied', MCP_PRIVACY_DENIED_TEXT);
    return null;
  }

  function openPrivacyAsk(key: string, pkey: string, session: McpSession, tab: string | null, project: ProjectInfo): PrivacyAsk {
    const stop = new AbortController();
    const owner: GateOwner = { kind: 'mcp', session: session.id, tab };
    const ask: PrivacyAsk = { gate: null, waiters: 0, stop, outcome: Promise.resolve<PrivacyOutcome>('stopped') };
    // The gate opens (its 'open' event) inside ask(): its id, for the calls that join it.
    const off = d.gates.subscribe((e) => {
      if (e.type === 'open' && e.owner === owner) ask.gate = e.view.id;
    });
    let asked: Promise<GateAnswer>;
    try {
      const gate = isProjectList(project.id) ? mcpProjectListGate({ client: session.client.name }) : mcpPrivacyGate({ project, client: session.client.name });
      asked = d.gates.ask(gate, owner, stop.signal, { timeoutMs: MCP_GATE_TIMEOUT_MS });
    } finally {
      off();
    }
    ask.outcome = (async (): Promise<PrivacyOutcome> => {
      try {
        const answer = await asked;
        if (answer !== 'allow') {
          const by = ask.gate ? d.gates.closedAs(ask.gate)?.by : null;
          if (by === 'stop') return 'stopped';
          // The person's own "Don't allow" holds a while; a question that timed out unseen doesn't.
          if (by === 'user') declines.set(pkey, clock.now() + PRIVACY_DECLINE_HOLD_MS);
          return 'declined';
        }
        // "Never send" chosen while the question was open wins over its Allow.
        if ((await d.settings()).privacy === 'deny') return 'privacy_denied';
        await remember(project.id, project.created_at, MCP_DESTINATION);
        // Every app's list shows the project's tools in full now.
        recheckAll();
        return 'allow';
      } finally {
        if (privacyAsks.get(key) === ask) privacyAsks.delete(key);
      }
    })();
    // Its failure reaches the calls waiting on it; with none left, it is dropped quietly.
    ask.outcome.catch(() => {});
    privacyAsks.set(key, ask);
    return ask;
  }

  /** Whether a question is one a session's running call waits on: an app's own, or (agent) its turn's, as its dispatch says. */
  function ownsQuestion(session: McpSession, owner: GateOwner): boolean {
    if (session.kind === 'external') return owner.kind === 'mcp' && owner.session === session.id;
    const dispatch = session.binding ? bindingEntry(session.binding.id)?.dispatch : null;
    try {
      return dispatch?.owns?.(owner) === true;
    } catch {
      return false;
    }
  }

  /**
   * While a question this call waits on is open: progress at once and every 15 s, worded by
   * whether its tab can show it. `mine` says which questions are the call's own (as they
   * open); a shared question it joins is followed by its id.
   */
  function watchQuestions(progress: ProgressSender, mine: (owner: GateOwner) => boolean): Watch {
    const waiting = new Map<string, { timer: unknown; stopped: boolean }>();
    const end = (id: string) => {
      const w = waiting.get(id);
      if (!w) return;
      w.stopped = true;
      clock.clearTimeout(w.timer);
      waiting.delete(id);
    };
    const follow = (id: string) => {
      if (waiting.has(id)) return;
      const w = { timer: null as unknown, stopped: false };
      waiting.set(id, w);
      const tick = () => {
        if (w.stopped) return;
        progress.send(null, d.gates.unseen(id) ? WAITING_HIDDEN_TEXT : WAITING_TEXT);
        w.timer = clock.setTimeout(tick, WAIT_PROGRESS_MS);
      };
      // After the question was offered to its tab: its unseen wait starts first, so a tick at
      // the same moment reads it.
      queueMicrotask(tick);
    };
    const off = d.gates.subscribe((e) => {
      if (e.type === 'closed') end(e.view.id);
      else if (e.type === 'open' && mine(e.owner)) follow(e.view.id);
    });
    return {
      follow: (id) => {
        if (d.gates.lookup(id)?.open) follow(id);
      },
      stop: () => {
        off();
        for (const id of [...waiting.keys()]) end(id);
      },
    };
  }

  /** The answer for a tool that can't run here now (its plugin off, or not available): null when it may. */
  function unavailableNow(call: ToolCallPart, def: ToolDef, ctx: ToolCtx): RunResult | null {
    if (d.registry.fenced(def.source)) return errorResult(call, 'plugin_off', `${sourceLabel(def.source)} was turned off or replaced.`);
    let available: true | string;
    try {
      available = def.available(ctx);
    } catch {
      available = 'It is not available now.';
    }
    return available === true ? null : errorResult(call, 'unavailable', String(available));
  }

  /** `r` with how to recover when it is a tool of an earlier list (the tab registered again, or went). */
  function changedHint(session: McpSession, call: ToolCallPart, def: ToolDef, r: RunResult): RunResult {
    if (r.code !== 'unavailable' || [...listFor(session, contextOf(session).ctx, false).values()].includes(def)) return r;
    return withHint(call, r, TOOLS_CHANGED_HINT);
  }

  async function runOne(
    session: McpSession,
    call: ToolCallPart,
    signal: AbortSignal,
    progress: ProgressSender | null,
    watch: Watch,
    prompts: number,
  ): Promise<{ r: RunResult; def: ToolDef | null }> {
    if (session.binding?.test) return { r: testCall(session, call), def: null };
    if (signal.aborted) return { r: stoppedBefore(call, signal), def: null };
    // Other apps turned off since this app connected (or since this call was queued).
    if (session.kind === 'external' && !(await d.settings()).mcp.clients) return { r: errorResult(call, 'clients_off', CLIENTS_OFF_TEXT), def: null };
    // A call naming a project runs in the one window showing it, when two or more are open (§9.5).
    const named = isRecord(call.input) && typeof call.input.project_id === 'string' && call.input.project_id ? call.input.project_id : null;
    const { ctx, why } = contextOf(session, named);
    const served = session.served ?? listFor(session, ctx, false);
    const def = served.get(call.name) ?? null;
    if (!def) {
      const r = errorResult(call, 'no_tool', `No tool named ${cleanText(call.name, 64)} on this connection. List the tools and use only those.`, why ?? undefined);
      return { r, def: null };
    }
    const offered = new Map([[call.name, def]]);
    const onProgress = progress ? { onProgress: (fraction: number | null, label: string) => progress.send(fraction, label) } : {};
    if (session.kind === 'agent') {
      const dispatch = session.binding ? bindingEntry(session.binding.id)?.dispatch : null;
      if (!dispatch) return { r: errorResult(call, 'stopped', NOTHING_RUNS_TEXT), def };
      // The prompt count it arrived at: one queued behind another call of an earlier message
      // never runs in the next message (the turn checks it).
      return { r: await dispatch.run(call, { offered, signal, prompts, ...onProgress }), def };
    }
    // A tool that can't run here now (of an earlier list, or its tab hidden or gone) is told so
    // before its input is read: no answer quotes a schema's withheld values, and its advice is
    // to list the tools again (no_window's could never work for it).
    const gone = unavailableNow(call, def, ctx);
    if (gone) return { r: changedHint(session, call, def, gone), def };
    const risk = riskOf(def);
    // Its question could reach nobody (no app tab shows it): refused at once rather than
    // declined after ten unseen minutes.
    if ((risk === 'compute' || risk === 'destructive') && !ctx.tab) return { r: errorResult(call, 'no_window', NO_WINDOW_TEXT, why ?? undefined), def };
    const rate = takeRate(clock.now(), risk);
    if (!rate.ok) return { r: errorResult(call, 'rate_limited', rate.text), def };
    const refused = await requireProjectData(session, call, def, ctx, signal, watch);
    if (refused) return { r: refused, def };
    const reads = !!projectOfCall(def, call.input ?? {}, ctx);
    let r = await d.runner.run(call, {
      owner: { kind: 'mcp', session: session.id, tab: ctx.tab },
      ctx,
      signal,
      offered,
      // No turn of the Assistant's: the tool is told this connection's (one per app connected).
      callTurn: `mcp:${session.id}`,
      gateTimeoutMs: MCP_GATE_TIMEOUT_MS,
      // Its question says another app asks, as it calls itself.
      app: mcpAppText(session.client.name),
      // Privacy read again once its question was answered (it may have changed meanwhile).
      ...(reads ? { beforeRun: () => requireProjectData(session, call, def, ctx, signal, watch) } : {}),
      ...onProgress,
    });
    // Privacy turned against other apps while it ran: its result stays here.
    if (r.ok && reads && (await privacyNow(session, call, projectOfCall(def, call.input ?? {}, ctx), new AbortController().signal)).ok !== true) r = errorResult(call, 'privacy_denied', RESULT_KEPT_TEXT);
    // A value of a schema it was listed without: said without the schema's withheld values.
    if (r.code === 'invalid_input' && !call.inputError && def.source.kind !== 'host' && !(await projectOpen(session, ctx).catch(() => false))) {
      r = errorResult(call, 'invalid_input', withheldInputError(def, call.input));
    }
    return { r: changedHint(session, call, def, r), def };
  }

  function noteClient(session: McpSession, conn: McpConnection, server: SdkServer, ctx: SdkContext): void {
    if (session.client.name) return;
    const info = server.getClientVersion() ?? ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo'];
    if (!isRecord(info)) return;
    session.client.name = cleanText(info.name, 64);
    session.client.version = cleanText(info.version, 64);
    conn.label.name = session.client.name;
  }

  async function callTool(session: McpSession, conn: McpConnection, params: Record<string, unknown>, ctx: SdkContext, closed: AbortSignal): Promise<Record<string, unknown>> {
    session.calls += 1;
    conn.label.calls = session.calls;
    const args = params.arguments;
    const call: ToolCallPart = {
      type: 'tool_call',
      callId: `${session.id}-${session.calls}`,
      name: typeof params.name === 'string' ? params.name : '',
      input: isRecord(args) ? args : {},
      ...(args !== undefined && args !== null && !isRecord(args) ? { inputError: 'The arguments must be an object.' } : {}),
    };
    const started = clock.now();
    // The client's notifications/cancelled is a Stop for this call; the connection closing
    // passes on its own reason (with `server` when Magnusim closed it). The SDK aborts the
    // request too when its transport closes: that is the connection's reason, never a Stop.
    const abort = new AbortController();
    const onClosed = () => abort.abort(closed.reason);
    const onCancel = () => {
      if (!connectionClosed(ctx.mcpReq.signal.reason)) abort.abort({ code: 'stopped' } satisfies CallAbort);
      else if (closed.aborted) onClosed();
      else abort.abort({ code: 'stopped', cause: goneCause(session) } satisfies CallAbort);
    };
    if (closed.aborted) onClosed();
    else if (ctx.mcpReq.signal.aborted) onCancel();
    closed.addEventListener('abort', onClosed, { once: true });
    ctx.mcpReq.signal.addEventListener('abort', onCancel, { once: true });
    const signal = abort.signal;
    const progress = progressOf(ctx);
    let def: ToolDef | null = null;
    // An agent's call belongs to the message whose prompt its agent had when the call arrived.
    const prompts = session.binding ? bindingPrompts(session.binding.id) : -1;
    // The list may have changed since it was served (a source is a pure function).
    recheck(session);
    const queued = session.queue.run(
      signal,
      async () => {
        // Its questions are watched only while it runs: one call at a time per connection. An
        // app's are its session's; an agent binding's, those its dispatch says are its turn's.
        const watch = progress ? watchQuestions(progress, (owner) => ownsQuestion(session, owner)) : NO_WATCH;
        try {
          const out = await runOne(session, call, signal, progress, watch, prompts);
          def = out.def;
          return out.r;
        } finally {
          watch.stop();
        }
      },
      () => errorResult(call, 'stopped', STOPPED_BEFORE),
    );
    let r: RunResult;
    try {
      r = queued ? await queued : errorResult(call, 'busy', BUSY_CALLS_TEXT);
    } finally {
      progress?.close();
      closed.removeEventListener('abort', onClosed);
      ctx.mcpReq.signal.removeEventListener('abort', onCancel);
    }
    recheck(session);
    const ran = def as ToolDef | null;
    alog('info', 'mcp call', {
      session: session.id,
      tool: cleanText(call.name, 64),
      risk: ran ? riskOf(ran) : null,
      ok: r.ok,
      code: r.code,
      ms: Math.max(0, clock.now() - started),
    });
    return toMcpResult(r);
  }

  /** Why a connection's calls stopped when it closed from the other side. */
  function goneCause(session: McpSession): string {
    if (session.binding) return `${session.binding.name || 'The coding agent'} stopped unexpectedly`;
    return `${session.client.name || 'The app'} disconnected`;
  }

  function serve(conn: McpConnection, hello: McpHello, claim: (BindingClaim & { ok: true }) | null, sdk: Sdk): void {
    const session: McpSession = {
      id: conn.id,
      kind: hello.kind,
      client: { bridge: hello.client, name: '', version: '' },
      binding: claim ? { ...claim.entry.binding } : null,
      served: null,
      queue: new CallQueue(),
      opened: conn.opened,
      calls: 0,
    };
    const live: Live = { server: null, servedSig: null, notifiedSig: null, checking: false, again: false, closed: false };
    lives.set(session, live);
    const closed = new AbortController();
    let handle: { close(): Promise<void> } | null = null;
    const offShutdown = onAssistantShutdown(() => conn.close({ server: true }));
    // A registration changed: recomputed once the change is done (never inside it).
    const offChange = d.registry.onChange(() => queueMicrotask(() => recheck(session)));
    // Its binding dropped: Magnusim ended the agent (server), or the agent exited by itself (cause).
    let cause: string | null = null;
    claim?.attach((why) => {
      if (why?.cause) cause = why.cause;
      conn.close(why?.cause ? {} : { server: true });
    });
    conn.onClose(({ server }) => {
      live.closed = true;
      live.server = null;
      offChange();
      // Closed from the other side: the agent (the bridge is its child) or the app went, never the person.
      closed.abort({ code: 'stopped', ...(server ? { server: true } : { cause: cause ?? goneCause(session) }) } satisfies CallAbort);
      offShutdown();
      claim?.release();
      sessions.delete(session.id);
      // Its chain grants end with it (grants.ts).
      grants().end(`mcp:${session.id}`);
      void handle?.close().catch(() => {});
      alog('info', 'mcp connection closed', {
        session: session.id,
        kind: session.kind,
        client_name: session.client.name,
        ...(session.binding ? { binding: true } : {}),
        calls: session.calls,
        ms: Math.max(0, Date.now() - session.opened),
      });
    });
    if (conn.closed) return;
    sessions.set(session.id, session);
    alog('info', 'mcp connection opened', { session: session.id, kind: session.kind, ...(session.binding ? { binding: true } : {}) });
    const transport = new sdk.StdioServerTransport(conn.input, conn.output, { maxBufferSize: MCP_LINE_MAX });
    handle = sdk.serveStdio(
      async () => {
        const server = new sdk.Server(
          { name: 'magnusim', version: (await version().catch(() => '')) || '0' },
          { capabilities: { tools: { listChanged: true } }, instructions: await instructions(session) },
        );
        server.setRequestHandler('tools/list', async (_request, ctx) => {
          noteClient(session, conn, server, ctx);
          return { tools: await listTools(session) };
        });
        server.setRequestHandler('tools/call', async (request, ctx) => {
          noteClient(session, conn, server, ctx);
          return callTool(session, conn, request.params ?? {}, ctx, closed.signal);
        });
        if (!live.closed) live.server = server;
        return server;
      },
      {
        transport,
        // The error's kind and code only: its message may quote what the client sent. A
        // client that goes away mid-write (a killed probe process) is routine.
        onerror: (err) => {
          const code = cleanText((err as { code?: unknown } | null)?.code, 40);
          if (SOCKET_GONE.has(code)) return;
          alog('warn', 'mcp connection error', { session: session.id, error: cleanText(err?.name, 40) || 'Error', ...(code ? { code } : {}) });
        },
      },
    );
    // The transport closing (an oversized line, the input ending) ends the connection.
    const sdkClose = transport.onclose;
    transport.onclose = () => {
      sdkClose?.();
      conn.close();
    };
  }

  const handler: McpHandler = {
    async admit(hello: McpHello): Promise<McpAdmission> {
      const sdk = sdkOf(await loadSdk());
      if (hello.kind === 'external') {
        const s = await d.settings();
        if (!s.mcp.clients) return { ok: false, code: 'clients_off', error: CLIENTS_OFF_TEXT };
        return { ok: true, serve: (conn) => serve(conn, hello, null, sdk), abandon: () => {} };
      }
      const claim = claimBinding(String(hello.binding), hello.session);
      if (!claim.ok) return { ok: false, code: claim.code, error: claim.code === 'binding' ? BINDING_TEXT : BINDING_IN_USE_TEXT };
      return { ok: true, serve: (conn) => serve(conn, hello, claim, sdk), abandon: () => claim.release() };
    },
  };

  return {
    handler,
    sessions: () => [...sessions.values()],
  };
}
