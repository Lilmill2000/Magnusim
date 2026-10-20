/**
 * Provider failures as the Assistant reports them (Foundation spec 5.6). Messages are
 * built from the code and safe fields only (status, model id, base URL, a retry wait);
 * the provider's own text goes only to the log, redacted and capped at 300 characters.
 */
import { alog } from '../log.ts';
import { redact } from '../redact.ts';
import { ProviderError, type ProviderErrorCode, type ProviderId } from '../types.ts';

export { ProviderError };

export interface ErrorContext {
  provider: ProviderId;
  /** "Anthropic", "OpenAI", "The local server". */
  label: string;
  model: string;
  baseUrl: string;
  local: boolean;
  /** The request's watchdog, if it fired the error is a timeout. */
  watchdog?: { fired: string | null; waitedS: number } | null;
  /** The caller's signal: Stop, or a limit that aborted with a ProviderError as its reason (reported as that error). */
  signal?: AbortSignal | null;
  /** Some of the answer had streamed before it failed. */
  streamed?: boolean;
}

export const LOCAL_START_HINT = 'Start the server (LM Studio: Developer → Start server; Ollama: `ollama serve`) and test again.';
export const LOCAL_SLOW_HINT = 'A local model can take a while to load; try again, or choose a smaller model.';

function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  for (let i = 0; i < 6 && e && !out.includes(e); i += 1) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

const field = (e: unknown, k: string) => (e && typeof e === 'object' ? (e as Record<string, unknown>)[k] : undefined);

/** Every error type or code the error (and its causes) carries: `overloaded_error`, `server_is_overloaded`, … */
function errorTypes(err: unknown): string[] {
  const out: string[] = [];
  for (const e of causes(err)) {
    const inner = field(e, 'error');
    for (const v of [field(e, 'type'), field(e, 'code'), field(inner, 'type'), field(inner, 'code'), field(field(inner, 'error'), 'type')]) {
      if (typeof v === 'string' && v && v !== 'error' && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

function providerText(err: unknown): string {
  const parts: string[] = [];
  for (const e of causes(err)) {
    const m = field(e, 'message');
    if (typeof m === 'string' && m) parts.push(m);
  }
  return parts.join(' | ');
}

function retryAfterS(err: unknown): number | null {
  const headers = field(err, 'headers') as { get?: (k: string) => string | null } | undefined;
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const n = raw == null ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return null;
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'EPIPE']);
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);

/**
 * A request past the model's context, in a provider's words or error type. llama.cpp's server
 * answers 400 "the request exceeds the available context size" (newer builds name the token
 * counts) with the type `exceed_context_size_error`: "context size" and "context_size" cover both.
 */
const CONTEXT_RE = /context[ _-]?(length|window|size)|too long|prompt is too long|maximum context|context_length_exceeded|model_context_window_exceeded/i;

/**
 * Whether a provider's refusal is an HTTP 400 whose words (or error code) say the request's
 * strict tool schemas can't be compiled (CAD tools spec H8); each cloud adapter gives its
 * own dialect's words and codes.
 */
export function strictSchemaRefusal(err: unknown, words: RegExp, codes: readonly string[] = []): boolean {
  if (field(err, 'status') !== 400) return false;
  return words.test(providerText(err)) || errorTypes(err).some((t) => codes.includes(t));
}

/**
 * The provider's own words for a failure, redacted and capped at `max` characters: the message
 * in its error body (`{error: {message}}` or `{message}`), else the error's text.
 */
export function providerSaid(err: unknown, max: number): string {
  let words = '';
  for (const e of causes(err)) {
    const inner = field(e, 'error');
    const m = [field(field(inner, 'error'), 'message'), field(inner, 'message')].find((v) => typeof v === 'string' && v.trim());
    if (typeof m === 'string') {
      words = m.trim();
      break;
    }
  }
  const text = redact(words || providerText(err)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The ProviderError for anything a provider call threw; logs the provider's own text, redacted. */
export function mapProviderError(err: unknown, ctx: ErrorContext): ProviderError {
  const mapped = classify(err, ctx);
  if (mapped.code !== 'aborted') {
    const detail = redact(providerText(err)).slice(0, 300);
    alog(mapped.code === 'blocked_origin' ? 'warn' : 'info', 'provider request failed', {
      provider: ctx.provider,
      code: mapped.code,
      status: mapped.status,
      ...(detail ? { detail } : {}),
    });
  }
  return mapped;
}

function classify(err: unknown, ctx: ErrorContext): ProviderError {
  const L = ctx.label;
  const o = (code: ProviderErrorCode, message: string, extra: { status?: number | null; retryAfterS?: number | null } = {}) =>
    new ProviderError(code, message, { ...extra, streamed: !!ctx.streamed });

  // The caller ended it: with its own reason when it gave one (a route's time limit), else
  // a Stop. Either way it says whether part of the answer had streamed (and was billed).
  const stopped = (): ProviderError => {
    const why = ctx.signal?.aborted ? (ctx.signal.reason as unknown) : null;
    if (why instanceof ProviderError) return new ProviderError(why.code, why.message, { status: why.status, retryAfterS: why.retryAfterS, streamed: !!ctx.streamed });
    return o('aborted', 'Stopped.');
  };

  // Our own errors (the origin lock, deps, a missing key) pass through, wherever the SDK wrapped them.
  for (const e of causes(err)) {
    if (e instanceof ProviderError) {
      if (ctx.watchdog?.fired && (e.code === 'timeout' || e.code === 'aborted')) break;
      if (e.code === 'aborted') return stopped();
      return e;
    }
  }
  if (ctx.watchdog?.fired) {
    return o('timeout', `No answer for ${ctx.watchdog.waitedS} s.${ctx.local ? ` ${LOCAL_SLOW_HINT}` : ''}`);
  }
  const name = String(field(err, 'name') || (err as object | null)?.constructor?.name || '');
  if (ctx.signal?.aborted || name === 'APIUserAbortError' || name === 'AbortError') return stopped();

  const status = typeof field(err, 'status') === 'number' ? (field(err, 'status') as number) : null;
  const types = errorTypes(err);
  const is = (re: RegExp) => types.some((t) => re.test(t));
  const text = providerText(err);

  if (status === 401 || status === 403 || is(/^(authentication_error|permission_error|invalid_api_key)$/)) {
    return o('auth', `${L} refused the key. Check it in Settings → Assistant.`, { status });
  }
  if (is(CONTEXT_RE) || ((status === 400 || status === 413) && CONTEXT_RE.test(text))) {
    return o('context', `This conversation is too long for ${ctx.model}. Start a new one.`, { status });
  }
  if (status === 404 || is(/^(not_found_error|model_not_found)$/)) {
    return o('model', `The model ${ctx.model} isn't available to this key or server.`, { status });
  }
  if (status === 429 || is(/^(rate_limit_error|rate_limit_exceeded)$/)) {
    const wait = retryAfterS(err) ?? 30;
    return o('rate_limit', `${L} is limiting requests; try again in ${wait} s.`, { status, retryAfterS: wait });
  }
  if (status === 529 || is(/overloaded/i)) {
    return o('overloaded', `${L} is overloaded right now; try again shortly.`, { status });
  }
  if (status !== null && status >= 500) return o('server', `${L} had an error (HTTP ${status}).`, { status });
  if (status !== null && status >= 400) return o('bad_request', `${L} refused the request (HTTP ${status}).`, { status });
  if (!status && is(/^(api_error|server_error)$/)) return o('server', `${L} had an error.`);

  // No answer at all: a refused connection, a name that doesn't resolve, a timeout, a redirect.
  // After part of the answer arrived, a lost connection means the answer ended early.
  const connectionLost = causes(err).some((e) => CONNECT_CODES.has(String(field(e, 'code') || '')) || /terminated|other side closed/i.test(String(field(e, 'message') || '')));
  if (ctx.streamed && connectionLost) return o('server', `${L} ended the answer early.`);
  for (const e of causes(err)) {
    const code = String(field(e, 'code') || '');
    const msg = String(field(e, 'message') || '');
    if (/redirect/i.test(msg)) return o('blocked_origin', "Blocked a request to an address other than the provider's.");
    if (TIMEOUT_CODES.has(code) || name === 'APIConnectionTimeoutError') {
      return o('timeout', `No answer from ${ctx.local ? ctx.baseUrl : L}.${ctx.local ? ` ${LOCAL_SLOW_HINT}` : ''}`);
    }
    if (CONNECT_CODES.has(code)) {
      return ctx.local
        ? o('unreachable', `Nothing answered at ${ctx.baseUrl}. ${LOCAL_START_HINT}`)
        : o('unreachable', `Couldn't reach ${L}. Check this PC's internet connection.`);
    }
  }
  if (name === 'APIConnectionError' || /fetch failed|connection error/i.test(text)) {
    return ctx.local
      ? o('unreachable', `Nothing answered at ${ctx.baseUrl}. ${LOCAL_START_HINT}`)
      : o('unreachable', `Couldn't reach ${L}. Check this PC's internet connection.`);
  }
  return o('other', `${L} failed with an unexpected error.`);
}
