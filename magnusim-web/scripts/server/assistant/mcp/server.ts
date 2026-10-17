/**
 * Magnusim's tools over MCP (phase 3 spec 3.1-3.4, 3.7-3.10): one SDK server per
 * connection the listener admits.
 *
 * - Each connection is served by the SDK's serveStdio (loaded through load-sdk.ts), which
 *   picks the protocol era per connection (2026-07-28 through server/discover, 2025-11-25
 *   through initialize), with a low-level Server answering tools/list and tools/call.
 * - The list is the registry's toolsFor(ctx) (the 40-tool cap), each tool under its MCP
 *   name (names.ts), with read-only and destructive hints. An external app's context is
 *   the only connected app tab (TurnManager.resolveTab('auto')), read per request; with
 *   none, or more than one, it is tab-less: host tools only, and the reason in the
 *   answer to a call of a tool it can't see.
 * - A call resolves only in the list last served on that connection (before any
 *   tools/list, the current list counts as served at the call), runs through ToolRunner
 *   (schema validation, the epoch fence, availability, questions, stall windows and
 *   result caps), one at a time per connection in arrival order (16 at most at once,
 *   `busy` past that), and comes back as the same cleaned JSON text the Assistant's model
 *   gets, plus its images; `isError` for an error.
 * - Project data: external apps are offered workspace and other plugin tools without
 *   their registration text (a generic description, schemas without enums, descriptions,
 *   titles, consts, defaults or examples), and no tool that reads project data runs for
 *   them yet: they are refused `project_data_off` until the privacy rules (the per-project
 *   question for "other apps") cover them. Nor does a tool that asks first (compute,
 *   destructive): no app tab shows an app's questions yet (`questions_off`).
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
import type { Readable, Writable } from 'node:stream';
import { realClock, type Clock } from '../gates.ts';
import { appVersion } from '../host-tools.ts';
import { alog } from '../log.ts';
import { guideBlock, SYSTEM_PROMPT } from '../prompt.ts';
import { CONNECTION_CHECK, CONNECTION_CHECK_SCHEMA } from '../provider-test.ts';
import { loadMcpSdk, type McpSdkModules } from '../providers/load-sdk.ts';
import type { Registry, ToolCtx, ToolDef } from '../registry.ts';
import { errorResult, riskOf, STOPPED_BEFORE, type CallAbort, type RunResult, type ToolRunner } from '../runner.ts';
import { cleanText, resultText } from '../sanitize.ts';
import { emitSchema, validateInput } from '../schema.ts';
import type { AssistantSettings } from '../settings.ts';
import { onAssistantShutdown } from '../state.ts';
import type { Risk, ToolCallPart } from '../types.ts';
import { CLIENTS_OFF_TEXT, type McpAdmission, type McpConnection, type McpHandler, type McpHello } from './listener.ts';
import { servedMap } from './names.ts';
import { bindingEntry, CallQueue, claimBinding, type BindingClaim, type McpSession } from './sessions.ts';

/** A line longer than this closes the connection (the SDK's default is 10 MB). */
export const MCP_LINE_MAX = 8 * 1024 * 1024;
/** External apps' calls per rolling hour, process-wide. */
export const MCP_RATES = Object.freeze({ calls: 1200, changes: 120, windowMs: 60 * 60_000 });

export const MCP_INSTRUCTIONS = [
  "These are Magnusim's tools. Magnusim is a CFD and CAD app on this PC, and the tools act in it for the person at this PC.",
  ...SYSTEM_PROMPT.split('\n').slice(1),
].join('\n');

export const PROJECT_DATA_OFF_TEXT =
  "Magnusim doesn't give other apps (MCP) project data yet: only its tools that read no project data run for them.";
export const QUESTIONS_OFF_TEXT =
  "Magnusim can't ask its questions for other apps (MCP) yet, so tools that ask first (computations, and changes that can't be undone) don't run for them.";
export const TOOLS_CHANGED_HINT = 'The tools changed. List the tools again.';
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
  };
}
interface SdkServer {
  setRequestHandler(method: string, handler: (request: { params?: Record<string, unknown> }, ctx: SdkContext) => unknown): void;
  getClientVersion(): unknown;
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

const TABLESS: ToolCtx = Object.freeze({ tab: null, projectId: null, simulationId: null, cloud: true, local: false });

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
  /** TurnManager.resolveTab: the only connected app tab ('auto'), or why there is none. */
  resolveTab(target: string): { tab: string; projectId: string; studyId: string } | { status: number; body: Record<string, unknown> };
  settings(): Promise<AssistantSettings>;
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

export function createMcpService(d: McpServiceDeps): McpService {
  const clock = d.clock ?? realClock;
  const loadSdk = d.sdk ?? loadMcpSdk;
  const version = d.version ?? appVersion;
  const sessions = new Map<string, McpSession>();

  /** The context a session's tools are listed and run in now, and why it has no tab. */
  function contextOf(session: McpSession): { ctx: ToolCtx; why: string | null } {
    if (session.kind === 'agent') {
      const dispatch = session.binding ? bindingEntry(session.binding.id)?.dispatch : null;
      return { ctx: dispatch ? dispatch.ctx() : TABLESS, why: null };
    }
    const t = d.resolveTab('auto');
    if ('status' in t) return { ctx: TABLESS, why: typeof t.body.error === 'string' ? t.body.error : null };
    return { ctx: { tab: t.tab, projectId: t.projectId || null, simulationId: t.studyId || null, cloud: true, local: false }, why: null };
  }

  const withheld = (session: McpSession, def: ToolDef) => session.kind === 'external' && def.projectData && def.source.kind !== 'host';

  function listFor(session: McpSession, ctx: ToolCtx, log: boolean): Map<string, ToolDef> {
    return servedMap(
      d.registry.toolsFor(ctx),
      log ? (name, served) => alog('warn', 'mcp tool name taken; the later tool is not served', { session: session.id, tool: cleanText(name, 64), served }) : undefined,
    );
  }

  function instructions(session: McpSession): string {
    if (session.binding?.test) return MCP_INSTRUCTIONS;
    const { ctx } = contextOf(session);
    const ws = ctx.tab ? d.registry.workspaceOf(ctx.tab) : null;
    if (!ws?.guide) return MCP_INSTRUCTIONS;
    return `${MCP_INSTRUCTIONS}\n\n${guideBlock(ws.guide, ws.reg.pluginName || ws.reg.plugin)}`;
  }

  async function listTools(session: McpSession): Promise<Array<Record<string, unknown>>> {
    if (session.binding?.test) {
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
    const { ctx } = contextOf(session);
    const served = listFor(session, ctx, true);
    session.served = served;
    return [...served].map(([name, def]) => toolView(name, def, withheld(session, def)));
  }

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

  async function runOne(session: McpSession, call: ToolCallPart, signal: AbortSignal): Promise<{ r: RunResult; def: ToolDef | null }> {
    if (session.binding?.test) return { r: testCall(session, call), def: null };
    if (signal.aborted) return { r: errorResult(call, 'stopped', STOPPED_BEFORE), def: null };
    // Other apps turned off since this app connected (or since this call was queued).
    if (session.kind === 'external' && !(await d.settings()).mcp.clients) return { r: errorResult(call, 'clients_off', CLIENTS_OFF_TEXT), def: null };
    const { ctx, why } = contextOf(session);
    const served = session.served ?? listFor(session, ctx, false);
    const def = served.get(call.name) ?? null;
    if (!def) {
      const r = errorResult(call, 'no_tool', `No tool named ${cleanText(call.name, 64)} on this connection. List the tools and use only those.`, why ?? undefined);
      return { r, def: null };
    }
    const offered = new Map([[call.name, def]]);
    if (session.kind === 'agent') {
      const dispatch = session.binding ? bindingEntry(session.binding.id)?.dispatch : null;
      if (!dispatch) return { r: errorResult(call, 'stopped', NOTHING_RUNS_TEXT), def };
      return { r: await dispatch.run(call, { offered, signal }), def };
    }
    if (def.projectData) return { r: errorResult(call, 'project_data_off', PROJECT_DATA_OFF_TEXT), def };
    // Its question could reach nobody yet (no app tab shows an app's questions): refused at
    // once rather than declined after ten unseen minutes.
    const risk = riskOf(def);
    if (risk === 'compute' || risk === 'destructive') return { r: errorResult(call, 'questions_off', QUESTIONS_OFF_TEXT), def };
    const rate = takeRate(clock.now(), risk);
    if (!rate.ok) return { r: errorResult(call, 'rate_limited', rate.text), def };
    let r = await d.runner.run(call, { owner: { kind: 'mcp', session: session.id }, ctx, signal, offered });
    // A tool of an earlier list (the tab registered again, or went): say how to recover.
    if (r.code === 'unavailable' && ![...listFor(session, contextOf(session).ctx, false).values()].includes(def)) r = withHint(call, r, TOOLS_CHANGED_HINT);
    return { r, def };
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
    // passes on its own reason (with `server` when Magnusim closed it).
    const abort = new AbortController();
    const onCancel = () => abort.abort({ code: 'stopped' } satisfies CallAbort);
    const onClosed = () => abort.abort(closed.reason);
    if (closed.aborted) onClosed();
    else if (ctx.mcpReq.signal.aborted) onCancel();
    closed.addEventListener('abort', onClosed, { once: true });
    ctx.mcpReq.signal.addEventListener('abort', onCancel, { once: true });
    const signal = abort.signal;
    let def: ToolDef | null = null;
    const queued = session.queue.run(
      signal,
      async () => {
        const out = await runOne(session, call, signal);
        def = out.def;
        return out.r;
      },
      () => errorResult(call, 'stopped', STOPPED_BEFORE),
    );
    let r: RunResult;
    try {
      r = queued ? await queued : errorResult(call, 'busy', BUSY_CALLS_TEXT);
    } finally {
      closed.removeEventListener('abort', onClosed);
      ctx.mcpReq.signal.removeEventListener('abort', onCancel);
    }
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
    const closed = new AbortController();
    let handle: { close(): Promise<void> } | null = null;
    const offShutdown = onAssistantShutdown(() => conn.close({ server: true }));
    claim?.attach(() => conn.close({ server: true }));
    conn.onClose(({ server }) => {
      closed.abort({ code: 'stopped', ...(server ? { server: true } : {}) } satisfies CallAbort);
      offShutdown();
      claim?.release();
      sessions.delete(session.id);
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
          { capabilities: { tools: {} }, instructions: instructions(session) },
        );
        server.setRequestHandler('tools/list', async (_request, ctx) => {
          noteClient(session, conn, server, ctx);
          return { tools: await listTools(session) };
        });
        server.setRequestHandler('tools/call', async (request, ctx) => {
          noteClient(session, conn, server, ctx);
          return callTool(session, conn, request.params ?? {}, ctx, closed.signal);
        });
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
