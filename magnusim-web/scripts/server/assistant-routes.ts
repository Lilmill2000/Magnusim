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
 *   GET  /api/assistant/status          the status (never runs a helper)
 *   POST /api/assistant/settings        a partial change → status; 400 {error, field}; 409 {needs_confirm:'base_url'}
 *   POST /api/assistant/key             {provider, key} → status (+ warning); 400; 409 storage_unavailable; 500
 *   POST /api/assistant/key/remove      {provider} → status; 400
 *
 * MAGNUSIM_TEST_ASSISTANT=1 (read when the routes are registered) also registers, for tests:
 *   GET  /api/test/assistant/state      what the Assistant holds in memory
 *   POST /api/test/assistant/reset      {files?} forget it all (files: also the test home's files)
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.ts';
import type { RequestContext, RouteHandler, Router } from './router.ts';
import { assistantAccess, REMOTE_BODY } from './assistant/access.ts';
import { assistantDataDir, assistantHomeIsOverridden, secretsDir } from './assistant/home.ts';
import { spendLedger, type SpendLedger } from './assistant/ledger.ts';
import { alog } from './assistant/log.ts';
import { redact } from './assistant/redact.ts';
import { consentCount, isLoopbackUrl, loadSettings, saveSettings, type AssistantSettings } from './assistant/settings.ts';
import { isKeySlot, KeyError, secretStore, type Store } from './assistant/secrets/store.ts';
import { assistantState, resetAssistantState, shutdownAssistant } from './assistant/state.ts';

/** Sent by the Assistant's own tool calls to the app's routes; its own routes refuse it. */
export const TURN_HEADER = 'x-magnusim-assistant-turn';

export interface AssistantDeps {
  worker?: unknown;
  services?: unknown;
  /** The port this server listens on (the host tools call the app over loopback). */
  port?: () => number;
}

export interface AssistantHandle {
  readonly deps: AssistantDeps;
  /** The server is closing: stop what the Assistant runs and drop the master key. */
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
    if (method !== 'GET' && method !== 'HEAD' && !/application\/json/i.test(String(ctx.req.headers['content-type'] || ''))) {
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
}

/** One part of the status. Later parts (packages, providers, models, prices, readiness) are added here. */
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
];

/** Adds a part to every status answer (for the commits that bring providers, models and turns). */
export function addStatusPart(part: StatusPart): void {
  STATUS_PARTS.push(part);
}

/** What GET /api/assistant/status answers. Reads files; never runs a helper. */
export async function assistantStatus(): Promise<Record<string, unknown>> {
  const store = secretStore();
  const [settings, ledger] = await Promise.all([loadSettings(), spendLedger(), store.load()]);
  const sources: StatusSources = { settings, store, ledger };
  const out: Record<string, unknown> = { ok: true, available: true };
  for (const part of STATUS_PARTS) Object.assign(out, part(sources));
  return out;
}

// ---------------------------------------------------------------- routes

function keyRefusal(ctx: RequestContext, err: unknown, store: Store): boolean {
  if (!(err instanceof KeyError)) return false;
  const body: Record<string, unknown> = { ok: false, code: err.code, error: err.message };
  if (err.code === 'storage_unavailable') body.storage = store.storage();
  ctx.sendJson(err.status, body);
  return true;
}

function registerTestRoutes(router: Router): void {
  router.get(
    '/api/test/assistant/state',
    local(async (ctx) => {
      const store = secretStore();
      const ledger = await spendLedger();
      const st = assistantState();
      ctx.sendJson(200, {
        ok: true,
        boot: st.bootId,
        running: 0,
        turns: st.turns.size,
        links: {},
        gates: st.gates.size,
        reservations: ledger.openCount(),
        protector: store.testProtector ?? store.protector.kind,
        hold_ms: null,
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

export function registerAssistantRoutes(router: Router, deps: AssistantDeps = {}): AssistantHandle {
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
        ({ warning } = await store.setKey(provider, typeof key === 'string' ? key : ''));
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

  if (process.env.MAGNUSIM_TEST_ASSISTANT === '1') registerTestRoutes(router);

  return {
    deps,
    shutdown() {
      shutdownAssistant();
    },
  };
}
