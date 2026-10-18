/**
 * The Assistant's routes (Foundation spec 9). This file sits flat in scripts/server so
 * gen-api finds its literal paths, and does nothing when it loads.
 *
 * Every route is for this PC only, three times over:
 * 1. index.ts answers 403 {reason:'remote'} to any /api/assistant… or /api/test/assistant…
 *    request that is not from this PC, on the path the router will match, before any
 *    body is read (assistant/access.ts);
 * 2. local() checks the same on every handler; it also answers 415 to a non-GET that is
 *    not JSON, 403 to a request carrying the Assistant's own tool-call header (its tools
 *    call the app's routes, never its own), and turns any error into
 *    {ok:false, error, code} with the error text redacted, never rethrown;
 * 3. no key travels in a URL or an answer: the key routes take one in a POST body and
 *    answer the status, which shows only set/unset and the last 4 characters.
 *
 *   GET  /api/assistant/status          the status (never runs a helper): the default provider and
 *                                        each provider's readiness (providers_ready)
 *   POST /api/assistant/settings        a partial change → status; 400 {error, field}; 409 {needs_confirm:'base_url'}.
 *                                        models: {<provider>: id} saves each provider's own model
 *   POST /api/assistant/key             {provider, key} → status (+ warning); 400; 409 storage_unavailable; 500
 *   POST /api/assistant/key/remove      {provider} → status; 400
 *   GET  /api/assistant/models?provider= {ok, models, source}: the curated list, merged with what
 *                                        the provider lists for this key ('provider'), or what the
 *                                        local server lists ('server'); 400; 502 {code, error, models}
 *   POST /api/assistant/test            {provider?} → Settings' connection test of that provider (the
 *                                        default without one): {ok:true, model, served_by, ms, tools,
 *                                        cost_usd} or {ok:false, code, error}; 400 when it can't
 *                                        start; 409 while one runs. For agent:<id>: the agent Test
 *                                        with a message (as /agents/test)
 *   POST /api/assistant/turns           {text, conversation?, tab?, context?:{project_id?, simulation_id?}, provider?, link?}
 *                                        → 202 {ok, conversation, turn, answer_key}: the turn runs detached
 *                                        (assistant/turns.ts); 400/404/409/429 with a code. tab:
 *                                        an app tab's id, or 'auto' for the only connected one.
 *                                        provider: any provider, whatever the default (without
 *                                        one: the conversation's own, else the default), or
 *                                        agent:<id> for a coding agent, whose turn needs the
 *                                        per-launch token in x-magnusim-launch (the CLI) or `link`
 *                                        = the tab's live relay link (the page): else 403 launch_proof
 *   GET  /api/assistant/turns/:id       ?since=N&wait_ms=0..25000 → {ok, turn, events, next, ended}
 *                                        (a long-poll: waits for an event after `since`)
 *   POST /api/assistant/turns/:id/stop  {} → {ok, turn} once it ended (≤ 5 s), else {ok, stopping:true}
 *   POST /api/assistant/gates/:id       {allow, answer_key} → {ok}: the program that started the turn
 *                                        answers its question with the 202's answer_key; 403
 *                                        answer_key (missing or wrong), not_shown (a question for
 *                                        the window only); 409 {already} (the first answer wins); 404
 *   POST /api/assistant/conversations/:id/forget  {} → {ok}; 409 while a turn runs in it
 *   GET  /api/assistant/tabs            what each app tab offers the Assistant (its workspace tools):
 *                                        {ok, tabs:[{tab, connected, since, workspace, tools, refused,
 *                                        active_turns, hold_until}]} (since and hold_until: ms since 1970)
 *   POST /api/assistant/relay/tools     the page relay (assistant/relay.ts): a tab's workspace tools,
 *   POST /api/assistant/relay/progress  a call's ack and progress, and its result; and the event hub's
 *   POST /api/assistant/relay/result    channel kind `assistant` {role:'relay'}, for this PC only
 *   POST /api/assistant/relay/gate      {link, gate, allow} → {ok}: the tab that shows a question
 *                                        answers it through its live link; 409 no_channel; 403
 *                                        not_shown (not sent on this link, or another tab's); 409 {already}
 *   GET  /api/assistant/mcp             other apps (MCP): {ok, clients, running, reason, port,
 *                                        bridge:{command, args}, snippet, connections:[{id, kind,
 *                                        name, since, calls}]} (never the token; the MCP connection
 *                                        itself is a loopback socket, assistant/mcp/listener.ts)
 *   GET  /api/assistant/agents          ?refresh=1 → {ok, checked_at, took_ms, agents:[AgentRow]}: the
 *                                        coding agents on this PC (assistant/agents/discover.ts; it
 *                                        runs --version of each agent's own verified package or an
 *                                        allowed program, never anything else; Refresh asks again)
 *   POST /api/assistant/agents/custom   {name, command, keep_env?} → {ok, agent}: a custom agent (off
 *                                        until allowed); browser only (403 browser_only); 400
 *                                        bad_name, bad_command, bad_keep_env, cant_start_script, too_many
 *   POST /api/assistant/agents/custom/remove  {id} → {ok} (what it still runs is stopped); 404;
 *                                        409 agent_running
 *   POST /api/assistant/agents/allow    {id, allow, fingerprint?} → {ok, agent}: the allow switch;
 *                                        browser only (403 browser_only). allow:false is always taken
 *                                        and stops that agent first, even when the switch can't be
 *                                        saved (then 500 save_failed); allow:true needs the row's
 *                                        fingerprint (409 fingerprint_changed) and is refused while
 *                                        the agent runs (409 agent_running); 404 agent_unknown
 *   POST /api/assistant/agents/test     {id, message} → the agent Test (message:true sends one short
 *                                        message) or connect check (false): {ok:true, agent, version,
 *                                        ms, signed_in, own_tools, images, modes, models, tools} or
 *                                        {ok:false, code, error, auth?}; 404 agent_unknown; 409 busy,
 *                                        agent_not_allowed (and the other start refusals); the
 *                                        request closing stops it (assistant/agents/test.ts)
 *   POST /api/assistant/agents/sign-in  {id, method} → {ok, agent?} | {ok:false, code, error}: the
 *                                        agent signs in by itself (an `agent` method it listed);
 *                                        400 bad_method; 409 busy, agent_not_allowed
 *
 * MAGNUSIM_TEST_ASSISTANT=1 (read when the routes are registered) also registers, for tests:
 *   GET  /api/test/assistant/state      what the Assistant holds in memory
 *   POST /api/test/assistant/reset      {files?} forget it all (files: also the test home's files)
 */
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.ts';
import { registerChannelKind } from './event-hub.ts';
import type { RequestContext, RouteHandler, Router } from './router.ts';
import { assistantAccess, REMOTE_BODY, TURN_HEADER } from './assistant/access.ts';
import { assistantDataDir, assistantHomeIsOverridden, secretsDir } from './assistant/home.ts';
import { spendLedger, type SpendLedger } from './assistant/ledger.ts';
import { alog } from './assistant/log.ts';
import { redact } from './assistant/redact.ts';
import { consentCount, isAgentProvider, isLoopbackUrl, loadSettings, PROVIDER_IDS, saveSettings, serverOrigin, type AssistantSettings } from './assistant/settings.ts';
import { isKeySlot, KeyError, secretStore, type Store } from './assistant/secrets/store.ts';
import { assistantState, beginAssistantLifetime, onAssistantShutdown, resetAssistantState, shutdownAssistant } from './assistant/state.ts';
import { curatedModels, FALLBACK_TARGETS, PRICES_AS_OF, priceInfo } from './assistant/prices.ts';
import { createAdapter, destinationOf, isCloud, PROVIDER_LABELS } from './assistant/providers/index.ts';
import { CLOUD_WATCHDOG, LOCAL_WATCHDOG } from './assistant/providers/common.ts';
import { testProviderUrl } from './assistant/providers/endpoints.ts';
import { LOCAL_SLOW_HINT } from './assistant/providers/errors.ts';
import { DEPS_MISSING_TEXT, depsStatus } from './assistant/providers/load-sdk.ts';
import { runConnectionTest } from './assistant/provider-test.ts';
import { ProviderError, type ModelInfo, type ProviderId } from './assistant/types.ts';
import { createToolRegistry, type Registry } from './assistant/registry.ts';
import { defaultHostTools } from './assistant/host-tools.ts';
import { createHostCaller } from './assistant/host-call.ts';
import { projectLookup, remember } from './assistant/privacy.ts';
import { createTurnManager, type TurnManager, type TurnManagerDeps } from './assistant/turns.ts';
import { createRelay, relaySwitches, type Relay, type RelayOptions } from './assistant/relay.ts';
import { closeExternalMcpConnections, mcpClientConfig, mcpConnections, mcpListenerStatus, setMcpHandler, startMcpListener } from './assistant/mcp/listener.ts';
import { createMcpService } from './assistant/mcp/server.ts';
import {
  addCustomAgentRequest,
  agentReadyRows,
  agentsCache,
  allowAgentRequest,
  listAgents,
  removeCustomAgentRequest,
  type AgentRouteContext,
  type RowContext,
} from './assistant/agents/discover.ts';
import { agentsTreeKill } from './assistant/agents/process.ts';
import { agentHost } from './assistant/agents/host.ts';
import { agentProviderTest, agentSignInRequest, agentTestRequest } from './assistant/agents/test.ts';
import { agentIdOf } from './assistant/agents/known.ts';
import { setAgentRunHooks } from './assistant/agents/discover.ts';
import { appVersion } from './assistant/host-tools.ts';
import { mcpSdkInstalled } from './assistant/providers/load-sdk.ts';

export { TURN_HEADER };

export interface AssistantDeps {
  worker?: unknown;
  services?: unknown;
  /** The port this server listens on (the host tools call the app over loopback). */
  port?: () => number;
  /** Tests: parts of the turn machinery replaced (the clock, the gate waits, the registry). */
  turns?: Partial<TurnManagerDeps>;
  /** Tests: the relay's timings and the plugins it finds loaded. */
  relay?: Partial<Omit<RelayOptions, 'registry' | 'turns'>>;
}

export interface AssistantHandle {
  readonly deps: AssistantDeps;
  /** The tools the turns are offered (the page relay registers workspaces here). */
  readonly registry: Registry;
  readonly turns: TurnManager;
  /** The page relay: how turns reach the workspace open in an app tab. */
  readonly relay: Relay;
  /** The MCP listener's start with this server (when the settings file exists): settled once it is decided. */
  readonly mcpStart: Promise<void>;
  /** The server is closing: stop what the Assistant runs and drop the master key (nothing once a newer server registered). */
  shutdown(): void;
}

// ---------------------------------------------------------------- the wrapper

function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const s = Number((err as { status?: unknown } | null)?.status);
  return Number.isInteger(s) && s >= 400 && s < 600 ? s : 500;
}

function errorCode(err: unknown, status: number): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z][a-z_]{1,40}$/.test(code)) return code;
  if (status === 413) return 'too_large';
  return status >= 500 ? 'internal' : 'bad_request';
}

/** Every Assistant handler goes through this (see the header). */
export function local(handler: RouteHandler): RouteHandler {
  return async (ctx: RequestContext) => {
    if (!assistantAccess(ctx.req)) {
      ctx.sendJson(403, REMOTE_BODY);
      return;
    }
    const method = ctx.method.toUpperCase();
    // The media type itself, not a parameter: "text/plain;x=application/json" is a simple
    // type a page elsewhere may send with no preflight.
    const mediaType = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (method !== 'GET' && method !== 'HEAD' && mediaType !== 'application/json') {
      ctx.sendJson(415, { ok: false, code: 'json_only', error: 'Send the request as JSON (Content-Type: application/json).' });
      return;
    }
    if (ctx.req.headers[TURN_HEADER] !== undefined) {
      ctx.sendJson(403, { ok: false, code: 'recursion', error: "The Assistant's tools can't call the Assistant." });
      return;
    }
    try {
      return await handler(ctx);
    } catch (err) {
      const status = errorStatus(err);
      const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (status >= 500) alog('error', 'request failed', { path: ctx.pathname, status, error: message });
      if (!ctx.res.headersSent) ctx.sendJson(status, { ok: false, error: message, code: errorCode(err, status) });
      else ctx.res.end();
      return;
    }
  };
}

// ---------------------------------------------------------------- status

interface StatusSources {
  settings: AssistantSettings;
  store: Store;
  ledger: SpendLedger;
  /** Whether the provider packages are installed. */
  deps: 'ok' | 'missing';
  /** What the coding agents' rows are read with (the last discovery is read from its cache). */
  agents: RowContext;
}

/** One part of the status (STATUS_PARTS lists them all). */
export type StatusPart = (s: StatusSources) => Record<string, unknown>;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const STATUS_PARTS: StatusPart[] = [
  ({ settings: s }) => ({
    provider: s.provider,
    models: s.models,
    base_url: s.base_url,
    base_url_is_local: isLoopbackUrl(s.base_url),
    effort: s.effort,
    privacy: s.privacy,
    /** Projects with an answer remembered ("Forget project answers (N)"). */
    consents: consentCount(s),
    caps: s.caps,
  }),
  ({ store }) => ({ keys: store.status(), storage: store.storage(), keys_notice: store.notice() }),
  ({ ledger }) => ({ spent_today_usd: round4(ledger.spentToday()) }),
  ({ store }) => ({ test_protector: store.testProtector }),
  () => {
    // The relay's test switches in use (null when not).
    const sw = relaySwitches();
    return { test_hold_ms: sw.holdMs, test_ack_ms: sw.ackMs, test_dormant_ms: sw.dormantMs };
  },
  ({ settings: s, deps }) => {
    // A coding agent has no price or fallback here: its own account pays.
    const provider = isAgentProvider(s.provider) ? 'off' : s.provider;
    const model = provider === 'off' ? '' : s.models[provider];
    return {
      deps,
      providers: PROVIDER_IDS.map((id) => ({
        id,
        label: PROVIDER_LABELS[id],
        cloud: isCloud({ provider: id, base_url: s.base_url }),
        destination: destinationOf({ provider: id, base_url: s.base_url }),
        key: id === 'openai_compatible' ? 'optional' : 'required',
        models: curatedModels(id),
      })),
      /** The default's model's price (older pages); `prices` has each provider's. */
      price: provider === 'off' || !model ? null : priceInfo(provider, model),
      prices: perProvider((id) => (s.models[id] ? priceInfo(id, s.models[id]) : null)),
      prices_as_of: PRICES_AS_OF,
      /** The default's model may be retried on an older model of its provider's own (Opus and Sonnet 5.5); `fallbacks` per provider. */
      fallback: fallbackOf(provider === 'off' ? null : provider, model),
      fallbacks: perProvider((id) => fallbackOf(id, s.models[id])),
      /** MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL is in use (both cloud providers go to a fake). */
      test_provider: testProviderUrl() !== null,
    };
  },
  (src) => readiness(src),
  (src) => ({
    /** The provider a turn uses when it names none (= `provider`, kept for older pages). */
    default_provider: src.settings.provider,
    /** Each provider's readiness: a turn or the Test may name any of them, whatever the default. */
    providers_ready: { ...perProvider((id) => providerRow(id, src)), ...agentReadyRows(src.agents) },
  }),
  ({ settings: s }) => ({ mcp: mcpStatus(s) }),
  () => ({
    /** When the coding agents were last looked for (null: not since the server started; GET /agents looks). */
    agents_checked_at: agentsCache()?.checked_at ?? null,
    /** How an agent's whole tree is stopped on this PC. */
    agents_tree_kill: agentsTreeKill(),
  }),
];

/** Whether the connection coding agents use can run: the listener isn't refused, its package is there. */
async function mcpAvailability(): Promise<RowContext['mcp']> {
  const l = mcpListenerStatus();
  if (!l.running && l.reason) return { available: false, reason: l.reason };
  if (!(await mcpSdkInstalled())) return { available: false, reason: 'deps_missing' };
  return { available: true, reason: null };
}

/** Other apps (MCP): the switch, and whether the connection runs (and why not). */
function mcpStatus(s: AssistantSettings): { clients: boolean; running: boolean; reason: string | null; port: number | null; connected: number } {
  const l = mcpListenerStatus();
  return { clients: s.mcp.clients, running: l.running, reason: l.reason, port: l.port ?? s.mcp.port, connected: l.connected };
}

function perProvider<T>(fn: (id: ProviderId) => T): Record<ProviderId, T> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, fn(id)])) as Record<ProviderId, T>;
}

/** Whether the provider may retry a declined request of this model on an older model of its own. */
function fallbackOf(provider: ProviderId | null, model: string): { on: boolean; targets: string[] } {
  return provider === 'anthropic' && Object.hasOwn(FALLBACK_TARGETS, model) ? { on: true, targets: [...FALLBACK_TARGETS[model]] } : { on: false, targets: [] };
}

/**
 * Whether a turn or the Test could start now on `provider`, and the first reason it can't (the
 * codes POST /turns and the Test refuse with).
 */
export function providerReadiness(provider: ProviderId, { settings: s, store, deps }: StatusSources): { ready: boolean; reason: string | null } {
  const no = (reason: string) => ({ ready: false, reason });
  if (deps === 'missing') return no('deps_missing');
  if (!s.models[provider]) return no('no_model');
  const key = store.status()[provider];
  if (provider !== 'openai_compatible') {
    if (store.storage().kind === 'unavailable') return no('storage_unavailable');
    if (!key.set) return no('no_key');
  } else if (key.set) {
    // A saved server token is sent with every request: one that can't be unlocked, or is for another address, stops them.
    if (store.storage().reason === 'blocked') return no('token_locked');
    if (!key.origin || key.origin !== serverOrigin(s.base_url)) return no('token_other_server');
  }
  if (key.set && key.state === 'unreadable') return no('key_unreadable');
  return { ready: true, reason: null };
}

/** Whether a turn naming no provider (the default's) or the Test could start now, and the first reason it can't. */
function readiness(src: StatusSources): { ready: boolean; ready_reason: string | null } {
  const p = src.settings.provider;
  if (p === 'off') return { ready: false, ready_reason: 'provider_off' };
  if (isAgentProvider(p)) {
    // The coding agent's own row (from the discovery cache; not looked for yet: not_checked).
    const row = agentReadyRows(src.agents)[p] as { ready?: boolean; reason?: string | null } | undefined;
    return { ready: row?.ready === true, ready_reason: row ? (row.reason ?? null) : 'not_checked' };
  }
  const r = providerReadiness(p, src);
  return { ready: r.ready, ready_reason: r.reason };
}

/** Why a provider can't run, as its line in Settings says it. */
const NOT_READY_DETAIL: Readonly<Record<string, string>> = Object.freeze({
  deps_missing: "The Assistant's packages aren't installed",
  no_model: 'No model chosen',
  storage_unavailable: "Keys can't be stored on this PC",
  no_key: 'No key',
  token_locked: "The saved token can't be unlocked",
  token_other_server: 'The saved token is for another server address',
  key_unreadable: "The saved key can't be decrypted",
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One provider's row of `providers_ready`: its readiness, how it is paid for, and the line Settings shows. */
function providerRow(id: ProviderId, src: StatusSources): Record<string, unknown> {
  const s = src.settings;
  const r = providerReadiness(id, src);
  const key = src.store.status()[id];
  const model = s.models[id];
  const server = id === 'openai_compatible';
  let detail: string;
  if (!r.ready) detail = NOT_READY_DETAIL[r.reason ?? ''] ?? 'Not ready';
  else if (server) detail = `${hostOf(s.base_url)} · ${model}${key.set ? ' · token set' : ''}`;
  else detail = `${key.last4 ? `Key set, ends in …${key.last4}` : 'Key set'} · ${model}`;
  return {
    label: PROVIDER_LABELS[id],
    kind: server ? 'server' : 'key',
    ready: r.ready,
    reason: r.reason,
    // The $ meter counts cloud providers only: a local server (or one off this PC) is not priced.
    billing: server ? 'free' : 'usd',
    detail,
  };
}

/** What GET /api/assistant/status answers. Reads files; never runs a helper. */
export async function assistantStatus(): Promise<Record<string, unknown>> {
  const store = secretStore();
  const [settings, ledger, , deps, mcp, version] = await Promise.all([loadSettings(), spendLedger(), store.load(), depsStatus(), mcpAvailability(), appVersion()]);
  const sources: StatusSources = { settings, store, ledger, deps: deps.state, agents: { settings, mcp, appVersion: version } };
  const out: Record<string, unknown> = { ok: true, available: true };
  for (const part of STATUS_PARTS) Object.assign(out, part(sources));
  return out;
}

// ---------------------------------------------------------------- models and the connection test

function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

const MODELS_TIMEOUT_MS = 20_000;
/** Time each Test request is given to answer once its first byte came. */
const TEST_ANSWER_MS = 300_000;

/**
 * The Test's own limit, a backstop only: two requests, each allowed its provider's whole
 * first-byte wait (a local model may be loading) and then time to answer. The watchdog
 * ends a stalled request long before.
 */
export function testBoundMs(provider: ProviderId): number {
  const wd = provider === 'openai_compatible' ? LOCAL_WATCHDOG : CLOUD_WATCHDOG;
  return 2 * (wd.firstByteMs + TEST_ANSWER_MS);
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** What the Test reports when its limit runs out (not "Stopped.": nobody pressed Stop). */
export function testTimeoutError(provider: ProviderId, ms: number): ProviderError {
  const span = ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : seconds(ms);
  return new ProviderError('timeout', `The test took longer than ${span}.${provider === 'openai_compatible' ? ` ${LOCAL_SLOW_HINT}` : ''}`);
}

/** What the model list reports when its limit runs out. */
export function modelsTimeoutError(ms: number): ProviderError {
  return new ProviderError('timeout', `No answer for ${seconds(ms)}.`);
}

type Answer = { status: number; body: Record<string, unknown> };

/**
 * A signal that aborts after `ms` with `expired()` as its reason (the adapters report that
 * error), or plainly (a Stop) when the server shuts the Assistant down.
 */
export function boundedSignal(ms: number, expired: () => ProviderError): { signal: AbortSignal; abort: AbortController; done(): void } {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(expired()), ms);
  timer.unref?.();
  const off = onAssistantShutdown(() => abort.abort());
  return {
    signal: abort.signal,
    abort,
    done() {
      clearTimeout(timer);
      off();
    },
  };
}

/** GET /api/assistant/models: the curated list first, then what the provider (or local server) lists. */
async function listModels(provider: ProviderId, settings: AssistantSettings): Promise<Answer> {
  const curated: ModelInfo[] = curatedModels(provider);
  const deps = await depsStatus();
  if (deps.state === 'missing') {
    if (provider !== 'openai_compatible') return { status: 200, body: { ok: true, models: curated, source: 'curated' } };
    return { status: 502, body: { ok: false, code: 'deps_missing', error: DEPS_MISSING_TEXT, models: [] } };
  }
  const store = secretStore();
  await store.load();
  if (provider !== 'openai_compatible' && !store.status()[provider].set) return { status: 200, body: { ok: true, models: curated, source: 'curated' } };
  const bound = boundedSignal(MODELS_TIMEOUT_MS, () => modelsTimeoutError(MODELS_TIMEOUT_MS));
  try {
    const listed = await createAdapter({ ...settings, provider }, store).listModels(bound.signal);
    if (provider === 'openai_compatible') return { status: 200, body: { ok: true, models: listed, source: 'server' } };
    const known = new Set(curated.map((m) => m.id));
    const extra = listed.filter((m) => !known.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
    return { status: 200, body: { ok: true, models: [...curated, ...extra], source: 'provider' } };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('other', 'The model list could not be read.');
    return { status: 502, body: { ok: false, code: e.code, error: e.message, models: curated } };
  } finally {
    bound.done();
  }
}

/**
 * POST /api/assistant/test: refused (400) when it can't start, 409 while one runs; else the
 * result. `gone` aborts when the request that asked closed (a reload, Settings left or the
 * Test block started afresh): nobody waits for the result, so the test stops and the next
 * one may start at once.
 */
async function connectionTest(asked: unknown, gone: AbortSignal | undefined, manager: TurnManager): Promise<Answer> {
  const settings = await loadSettings();
  const refuse = (code: string, error: string, status = 400): Answer => ({ status, body: { ok: false, code, error } });
  // The provider named (each Settings card tests its own), else the default.
  const named = asked === undefined || asked === null || asked === '' ? null : asked;
  if (named !== null && named !== 'off' && !isProviderId(named) && agentIdOf(named) === null) return refuse('bad_provider', 'Unknown provider.');
  const chosen = named === null ? settings.provider : (named as string);
  // A coding agent: its Test with one short message (spec 5.2).
  const agent = agentIdOf(chosen);
  if (agent !== null) return agentProviderTest(agent, { mcp: mcpAvailability, gone, manager });
  const provider = chosen as ProviderId | 'off';
  if (provider === 'off') return refuse('provider_off', 'Choose a provider first.');
  if ((await depsStatus()).state === 'missing') return refuse('deps_missing', DEPS_MISSING_TEXT);
  const model = settings.models[provider];
  if (!model) return refuse('no_model', 'Choose a model first.');
  const store = secretStore();
  await store.load();
  const key = store.status()[provider];
  if (provider !== 'openai_compatible') {
    const storage = store.storage();
    if (storage.kind === 'unavailable') return refuse('storage_unavailable', storage.note);
    if (!key.set) return refuse('no_key', `No key is saved for ${PROVIDER_LABELS[provider]}. Add one first.`);
  }
  if (key.set && key.state === 'unreadable') return refuse('no_key', "The saved key can't be decrypted on this account. Enter it again.");
  const st = assistantState();
  if (st.test) return refuse('busy', 'A test is already running.', 409);
  const testMs = testBoundMs(provider);
  const bound = boundedSignal(testMs, () => testTimeoutError(provider, testMs));
  const running = { abort: bound.abort };
  st.test = running;
  const stop = () => {
    // Free at once: the stopped test winds down on its own.
    if (assistantState().test === running) assistantState().test = null;
    bound.abort.abort();
  };
  if (gone?.aborted) stop();
  else gone?.addEventListener('abort', stop, { once: true });
  try {
    const ledger = await spendLedger();
    const adapter = createAdapter({ provider, base_url: settings.base_url }, store);
    const result = await runConnectionTest({
      adapter,
      provider,
      model,
      effort: settings.effort,
      ledger,
      dayCapUsd: provider === 'openai_compatible' ? null : settings.caps.day_usd,
      signal: bound.signal,
    });
    alog('info', 'connection test', { provider, model, ok: result.ok, code: result.ok ? null : result.code, usd: result.cost_usd });
    return { status: 200, body: { ...result, spent_today_usd: round4(ledger.spentToday()) } };
  } finally {
    gone?.removeEventListener('abort', stop);
    bound.done();
    if (assistantState().test === running) assistantState().test = null;
  }
}

// ---------------------------------------------------------------- routes

function keyRefusal(ctx: RequestContext, err: unknown, store: Store): boolean {
  if (!(err instanceof KeyError)) return false;
  const body: Record<string, unknown> = { ok: false, code: err.code, error: err.message };
  if (err.code === 'storage_unavailable') body.storage = store.storage();
  ctx.sendJson(err.status, body);
  return true;
}

function registerTestRoutes(router: Router, turns: TurnManager, relay: Relay): void {
  router.get(
    '/api/test/assistant/state',
    local(async (ctx) => {
      const store = secretStore();
      const ledger = await spendLedger();
      const st = assistantState();
      ctx.sendJson(200, {
        ok: true,
        boot: st.bootId,
        running: turns.running().length,
        turns: st.turns.size,
        links: relay.snapshot(),
        gates: turns.gates.openCount(),
        reservations: ledger.openCount(),
        protector: store.testProtector ?? store.protector.kind,
        hold_ms: relay.holdMs,
        ack_ms: relay.ackMs,
        dormant_ms: relay.dormantMs,
        mcp: { connections: mcpConnections().length, port: mcpListenerStatus().port },
        agents: agentHost().snapshot(),
      });
    }),
  );

  router.post(
    '/api/test/assistant/reset',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      const files = body.files === true;
      // Never this PC's real keys: only a home a test chose.
      if (files && !assistantHomeIsOverridden()) {
        ctx.sendJson(409, { ok: false, code: 'real_home', error: 'Files are removed only from a test home (MAGNUSIM_ASSISTANT_HOME).' });
        return;
      }
      resetAssistantState();
      if (files) {
        const data = assistantDataDir();
        const secrets = secretsDir();
        for (const f of [join(data, 'settings.json'), join(data, 'spend.json'), join(secrets, 'keys.json'), join(secrets, 'master.json')]) {
          await rm(f, { force: true });
        }
      }
      ctx.sendJson(200, { ok: true, boot: assistantState().bootId });
    }),
  );
}

/** The turn machinery as the server runs it: the app's settings, keys, ledger and projects. */
function turnManager(deps: AssistantDeps): TurnManager {
  const port = () => deps.port?.() ?? null;
  const registry = deps.turns?.registry ?? createToolRegistry({ hostTools: defaultHostTools(port) });
  return createTurnManager({
    settings: loadSettings,
    secrets: () => secretStore(),
    deps: async () => (await depsStatus()).state,
    ledger: spendLedger,
    createAdapter: (s) => createAdapter(s, secretStore()),
    projects: projectLookup(createHostCaller({ port })),
    remember,
    ...deps.turns,
    registry,
  });
}

/** The turn routes (assistant/turns.ts does the work). */
function registerTurnRoutes(router: Router, turns: TurnManager): void {
  router.post(
    '/api/assistant/turns',
    local(async (ctx) => {
      // An agent turn's proof of this account (the CLI's per-launch token); never logged.
      const r = await turns.start(await ctx.readJsonBody(), { token: ctx.req.headers['x-magnusim-launch'] });
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.get(
    '/api/assistant/turns/:id',
    local(async (ctx) => {
      // A client that goes away ends its wait.
      const gone = new AbortController();
      const onClose = () => gone.abort();
      ctx.res.on('close', onClose);
      try {
        const q = ctx.url.searchParams;
        const r = await turns.poll(ctx.params.id, Number(q.get('since') ?? 0), Number(q.get('wait_ms') ?? 0), gone.signal);
        if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.sendJson(r.status, r.body);
      } finally {
        ctx.res.off('close', onClose);
      }
    }),
  );

  router.post(
    '/api/assistant/turns/:id/stop',
    local(async (ctx) => {
      await ctx.readJsonBody();
      const r = await turns.stop(ctx.params.id);
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/gates/:id',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      // Only the program that started the turn holds its answer key (the page answers through /relay/gate).
      const r = turns.answerGate(ctx.params.id, body.allow, { kind: 'key', key: body.answer_key });
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/conversations/:id/forget',
    local(async (ctx) => {
      await ctx.readJsonBody();
      const r = turns.forget(ctx.params.id);
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.get(
    '/api/assistant/tabs',
    local(async (ctx) => {
      const r = turns.tabs();
      ctx.sendJson(r.status, r.body);
    }),
  );
}

/** Other apps (MCP): what Settings shows and the config to paste. */
function registerMcpRoutes(router: Router): void {
  router.get(
    '/api/assistant/mcp',
    local(async (ctx) => {
      const s = await loadSettings();
      const { command, args, snippet } = mcpClientConfig();
      const st = mcpStatus(s);
      ctx.sendJson(200, { ok: true, clients: st.clients, running: st.running, reason: st.reason, port: st.port, bridge: { command, args }, snippet, connections: mcpConnections() });
    }),
  );
}

/**
 * Browser only (spec 4.9): the request carries an Origin that is the app's own (the Host it was
 * sent to), and `sec-fetch-site: same-origin` when it carries that header. The CLI, a script or
 * an agent's own shell sends no Origin. (Any program on this PC can forge one: this keeps a
 * prompt-injected one-liner out, it is not an account boundary.)
 */
export function browserOnly(ctx: RequestContext): boolean {
  const origin = ctx.req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin.toLowerCase().replace(/\/$/, '')) return false;
  const host = String(ctx.req.headers.host || '').trim().toLowerCase();
  if (!host || url.host !== host) return false;
  const site = ctx.req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}

/**
 * The coding agents' routes (assistant/agents/discover.ts does the work). `turns`: this server's
 * lifetime, whose shutdown stops the Test and sign-in runs its routes started.
 */
function registerAgentRoutes(router: Router, turns: TurnManager): void {
  const r: AgentRouteContext = { mcp: mcpAvailability };

  router.get(
    '/api/assistant/agents',
    local(async (ctx) => {
      const a = await listAgents(r, { refresh: ctx.url.searchParams.get('refresh') === '1' });
      ctx.sendJson(a.status, a.body);
    }),
  );

  router.post(
    '/api/assistant/agents/custom',
    local(async (ctx) => {
      if (!browserOnly(ctx)) {
        ctx.sendJson(403, { ok: false, code: 'browser_only', error: 'Add a custom agent from Settings → Assistant in the Magnusim window.' });
        return;
      }
      const a = await addCustomAgentRequest(r, await ctx.readJsonBody());
      ctx.sendJson(a.status, a.body);
    }),
  );

  router.post(
    '/api/assistant/agents/custom/remove',
    local(async (ctx) => {
      const a = await removeCustomAgentRequest(await ctx.readJsonBody());
      ctx.sendJson(a.status, a.body);
    }),
  );

  router.post(
    '/api/assistant/agents/allow',
    local(async (ctx) => {
      if (!browserOnly(ctx)) {
        ctx.sendJson(403, { ok: false, code: 'browser_only', error: 'Allow an agent from Settings → Assistant in the Magnusim window.' });
        return;
      }
      const a = await allowAgentRequest(r, await ctx.readJsonBody());
      ctx.sendJson(a.status, a.body);
    }),
  );

  /** A request that goes away (a reload, Settings left) stops its run. */
  const whileOpen = async (ctx: RequestContext, run: (gone: AbortSignal) => Promise<Answer>): Promise<void> => {
    const gone = new AbortController();
    const onClose = () => {
      if (!ctx.res.writableEnded) gone.abort();
    };
    ctx.res.on('close', onClose);
    try {
      const a = await run(gone.signal);
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.sendJson(a.status, a.body);
    } finally {
      ctx.res.off('close', onClose);
    }
  };

  router.post(
    '/api/assistant/agents/test',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      await whileOpen(ctx, (gone) => agentTestRequest(body, { mcp: mcpAvailability, gone, manager: turns }));
    }),
  );

  router.post(
    '/api/assistant/agents/sign-in',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      await whileOpen(ctx, (gone) => agentSignInRequest(body, { mcp: mcpAvailability, gone, manager: turns }));
    }),
  );
}

/**
 * The MCP listener starts with the server when the Assistant's settings file exists (it was
 * used here), whatever Other apps says: coding agents use it too, and an external app is
 * then refused with the Settings text, not "not running". Never at module load, and never
 * creating the Assistant's folder.
 */
async function startMcpIfUsed(): Promise<void> {
  try {
    await access(join(assistantDataDir(), 'settings.json'));
  } catch {
    return;
  }
  await startMcpListener();
}

/** The page relay's routes and its event-hub channel kind (assistant/relay.ts does the work). */
function registerRelayRoutes(router: Router, relay: Relay): void {
  registerChannelKind('assistant', (params, send, done, meta) => relay.open(params, send, done, meta));

  router.post(
    '/api/assistant/relay/tools',
    local(async (ctx) => {
      const r = relay.register(await ctx.readJsonBody());
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/relay/progress',
    local(async (ctx) => {
      const r = relay.progress(await ctx.readJsonBody());
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/relay/result',
    local(async (ctx) => {
      const r = relay.result(await ctx.readJsonBody());
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/relay/gate',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      const r = relay.answer(body.link, body.gate, body.allow);
      ctx.sendJson(r.status, r.body);
    }),
  );
}

/**
 * The worker's 'registry-changed' (worker.ts: a plugin turned on or off, installed, removed
 * or reloaded; index.ts reads the live registry again after it), for the relay.
 */
function registryChanges(worker: unknown): RelayOptions['onRegistryChanged'] {
  const w = worker as { on?: unknown; off?: unknown } | null | undefined;
  if (!w || typeof w.on !== 'function' || typeof w.off !== 'function') return undefined;
  const on = w.on as (event: string, fn: () => void) => void;
  const off = w.off as (event: string, fn: () => void) => void;
  return (fn) => {
    on.call(w, 'registry-changed', fn);
    return () => off.call(w, 'registry-changed', fn);
  };
}

export function registerAssistantRoutes(router: Router, deps: AssistantDeps = {}): AssistantHandle {
  const turns = turnManager(deps);
  const relay = createRelay({
    clock: turns.clock,
    keepPresenter: !!deps.turns?.presenter,
    onRegistryChanged: registryChanges(deps.worker),
    ...deps.relay,
    registry: turns.registry,
    turns,
  });
  // An agent turn started from the page proves this account with its tab's live link.
  turns.setLinkCheck((tab, link) => relay.isLiveLinkOf(tab, link));
  // Discovery's allow switch and custom-agent removal stop that agent's turns and processes.
  const host = agentHost();
  setAgentRunHooks({ running: (id) => host.running(id), stop: (id, text) => host.stopAgent(id, text) });
  // A real stop of the process (or a test reset): every agent ends.
  onAssistantShutdown(() => host.endAll('shutdown'));
  router.get(
    '/api/assistant/status',
    local(async (ctx) => {
      ctx.sendJson(200, await assistantStatus());
    }),
  );

  router.post(
    '/api/assistant/settings',
    local(async (ctx) => {
      const r = await saveSettings(await ctx.readJsonBody());
      if (!r.ok) {
        ctx.sendJson(r.status, {
          ok: false,
          code: r.needs_confirm ? 'needs_confirm' : 'invalid',
          error: r.error,
          field: r.field ?? null,
          ...(r.needs_confirm ? { needs_confirm: r.needs_confirm } : {}),
        });
        return;
      }
      // Other apps turned on: the connection starts now (it then runs until the process exits).
      if (r.settings.mcp.clients && !mcpListenerStatus().running) await startMcpListener();
      // Off: the apps connected now are cut off too (coding agents' connections stay).
      if (!r.settings.mcp.clients) closeExternalMcpConnections();
      ctx.sendJson(200, await assistantStatus());
    }),
  );

  router.post(
    '/api/assistant/key',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      const provider = body.provider;
      const key = body.key;
      // The parsed body lives as long as the request; it need not hold the key that long.
      delete body.key;
      const store = secretStore();
      if (!isKeySlot(provider)) {
        ctx.sendJson(400, { ok: false, code: 'bad_provider', error: 'Unknown provider.' });
        return;
      }
      let warning: string | undefined;
      try {
        // A server token is saved for the server address set now.
        const server = provider === 'openai_compatible' ? (await loadSettings()).base_url : undefined;
        ({ warning } = await store.setKey(provider, typeof key === 'string' ? key : '', { server }));
      } catch (err) {
        if (keyRefusal(ctx, err, store)) return;
        throw err;
      }
      ctx.sendJson(200, { ...(await assistantStatus()), ...(warning ? { warning } : {}) });
    }),
  );

  router.post(
    '/api/assistant/key/remove',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      const store = secretStore();
      if (!isKeySlot(body.provider)) {
        ctx.sendJson(400, { ok: false, code: 'bad_provider', error: 'Unknown provider.' });
        return;
      }
      try {
        await store.removeKey(body.provider);
      } catch (err) {
        if (keyRefusal(ctx, err, store)) return;
        throw err;
      }
      ctx.sendJson(200, await assistantStatus());
    }),
  );

  router.get(
    '/api/assistant/models',
    local(async (ctx) => {
      const settings = await loadSettings();
      const asked = ctx.url.searchParams.get('provider') || settings.provider;
      if (!isProviderId(asked)) {
        ctx.sendJson(400, { ok: false, code: 'bad_provider', error: 'Unknown provider.' });
        return;
      }
      const r = await listModels(asked, settings);
      ctx.sendJson(r.status, r.body);
    }),
  );

  router.post(
    '/api/assistant/test',
    local(async (ctx) => {
      const body = await ctx.readJsonBody();
      // A client that goes away stops its test.
      const gone = new AbortController();
      const onClose = () => {
        if (!ctx.res.writableEnded) gone.abort();
      };
      ctx.res.on('close', onClose);
      try {
        const r = await connectionTest(body.provider, gone.signal, turns);
        if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.sendJson(r.status, r.body);
      } finally {
        ctx.res.off('close', onClose);
      }
    }),
  );

  registerTurnRoutes(router, turns);
  registerRelayRoutes(router, relay);
  registerMcpRoutes(router);
  registerAgentRoutes(router, turns);

  if (process.env.MAGNUSIM_TEST_ASSISTANT === '1') registerTestRoutes(router, turns, relay);

  // Other apps and coding agents reach this server's tools through the process-wide listener:
  // its questions through this server's gates (shown by its relay), its privacy rules with the
  // same project rows and remembered answers as the turns'.
  const mcp = createMcpService({
    registry: turns.registry,
    runner: turns.runner,
    gates: turns.gates,
    resolveTab: (target) => turns.resolveTab(target),
    settings: deps.turns?.settings ?? loadSettings,
    projects: deps.turns?.projects ?? projectLookup(createHostCaller({ port: () => deps.port?.() ?? null })),
    remember: deps.turns?.remember ?? remember,
    clock: turns.clock,
  });
  const disposeMcp = setMcpHandler(mcp.handler);
  const mcpStart = startMcpIfUsed().catch((err: unknown) => {
    alog('warn', 'mcp listener start failed', { error: redact(String((err as Error)?.message ?? err)).slice(0, 200) });
  });

  // This server's lifetime: after a Vite restart the old server's close ends nothing of the new one's.
  const lifetime = beginAssistantLifetime();
  return {
    deps,
    registry: turns.registry,
    turns,
    relay,
    mcpStart,
    shutdown() {
      shutdownAssistant(lifetime);
      relay.shutdown();
      // Explicitly, superseded or not: the connections this lifetime's handler served close,
      // and the coding agents its turns started end (their turns failed/shutdown).
      disposeMcp();
      agentHost().endLifetime(turns);
    },
  };
}
