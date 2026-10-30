/**
 * The provider debug log, opt-in: with MAGNUSIM_ASSISTANT_DEBUG_LOG=<folder> in the server's
 * environment (read once, at the first use), or while Settings → Assistant's "Keep a provider
 * log for a problem report" is on (settings.provider_log, read at each request: then the folder
 * is providerLogDir: the server's own log's folder when MAGNUSIM_SERVER_LOG names one, as Magnusim
 * CAD's desktop app does, so one folder holds both; else <home>/assistant/logs), every model
 * request an adapter sends appends one JSON row to <folder>/provider.jsonl, a local file only.
 * Off, nothing is kept and nothing costs anything (debugCall() returns null). Past
 * PROVIDER_LOG_MAX the file becomes provider.1.jsonl (the one before it goes) and a new one starts.
 *
 * A row: time, turn and step (debugScoped, from the loop), dialect, model, attempt (strict,
 * reduced, loose; for a local server no_images, with_images, without_images), for a cloud request
 * its strict tools (`strict: {count, of}`), and why it went so (a strict refusal: strict_reduced,
 * strict_refused and their _earlier forms; images refused, an overload resend), the whole request body as sent, every HTTP answer's status, request id
 * header and time (the SDK may retry), the duration, and then either the result (stop reason,
 * usage, the model that served it, notes, what the provider's context editing cleared, and a
 * compact list of its blocks: text, thinking's
 * length, tool calls with their inputs) or the error (its text, type, code and status, and each
 * failed answer's whole body text).
 *
 * Never kept: request headers, a key, the key route. Each row passes through redact() whole;
 * base64 image data longer than BIG_STRING becomes a marker with its size, and a row stays
 * under MAX_ROW (a bigger request body is cut, and says so). Writes go one after another on a
 * queue whose failures are swallowed (one log line), so the log never breaks or holds a turn.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assistantDataDir } from './home.ts';
import { alog } from './log.ts';
import { redact } from './redact.ts';
import { assistantState } from './state.ts';
import type { ProviderAdapter, ProviderId, ProviderResult } from './types.ts';

export const DEBUG_LOG_ENV = 'MAGNUSIM_ASSISTANT_DEBUG_LOG';
/** The server's own console log, a file (Magnusim CAD's desktop app sets it: desktop/config.mjs serverEnv). */
export const SERVER_LOG_ENV = 'MAGNUSIM_SERVER_LOG';
export const DEBUG_LOG_FILE = 'provider.jsonl';
/** The file before the current one (PROVIDER_LOG_MAX). */
export const DEBUG_LOG_OLD = 'provider.1.jsonl';
/** The provider log's file starts again past this size (the one before it kept as DEBUG_LOG_OLD). */
export const PROVIDER_LOG_MAX = 64 * 1024 * 1024;
/** The longest row, in characters. */
export const MAX_ROW = 4 * 1024 * 1024;
/** The longest error body kept. */
const MAX_ERROR_BODY = 1024 * 1024;
/** A base64 string longer than this is kept as a marker with its size. */
export const BIG_STRING = 2048;
/** The longest text block kept in a result's block list. */
const MAX_TEXT = 8000;
/** How long a row waits for an error body before it is written without it. */
const BODY_WAIT_MS = 5_000;
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'];
const BASE64 = /^(data:[\w.+/-]+;base64,)?[A-Za-z0-9+/=\r\n]+$/;

let envDir: string | null | undefined;
let serverLog: string | null | undefined;
let made: string | null = null;
let warned = false;
let queue: Promise<void> = Promise.resolve();

/** The folder MAGNUSIM_ASSISTANT_DEBUG_LOG names, or null (the environment is read once). */
export function debugLogEnvDir(): string | null {
  if (envDir === undefined) {
    const v = String(process.env[DEBUG_LOG_ENV] ?? '').trim();
    envDir = v ? resolve(v) : null;
  }
  return envDir;
}

/** The server's own log file MAGNUSIM_SERVER_LOG names, or null (the environment is read once). */
export function serverLogFile(): string | null {
  if (serverLog === undefined) {
    const v = String(process.env[SERVER_LOG_ENV] ?? '').trim();
    serverLog = v ? resolve(v) : null;
  }
  return serverLog;
}

/**
 * Where Settings' provider log goes: the server's log's folder when MAGNUSIM_SERVER_LOG names one
 * (Magnusim CAD: %APPDATA%\Magnusim CAD\logs, beside server.log), else <home>/assistant/logs.
 */
export function providerLogDir(): string {
  const server = serverLogFile();
  return server ? dirname(server) : join(assistantDataDir(), 'logs');
}

/** The server's log's file name when it is kept in `folder` (the provider log's), else null. */
export function serverLogIn(folder: string): string | null {
  const server = serverLogFile();
  return server && resolve(dirname(server)) === resolve(folder) ? basename(server) : null;
}

/** The folder rows go to, or null when the log is off: the environment's, else Settings' switch's (as last read or saved). */
export function debugLogDir(): string | null {
  const env = debugLogEnvDir();
  if (env) return env;
  return assistantState().settings.cache?.provider_log === true ? providerLogDir() : null;
}

/** Tests: read the environment again at the next use. */
export function resetDebugLogForTests(): void {
  envDir = undefined;
  serverLog = undefined;
  made = null;
  warned = false;
}

/** Resolves once every row so far is written (or given up). */
export function flushDebugLog(): Promise<void> {
  return queue;
}

interface Scope {
  turn?: string;
  step?: number;
  resend?: string;
}
const scope = new AsyncLocalStorage<Scope>();

/** Runs `fn` with these fields on the rows of the requests it sends (merged over the outer scope's). */
export function withDebugScope<T>(s: Scope, fn: () => Promise<T>): Promise<T> {
  if (!debugLogDir()) return fn();
  return scope.run({ ...(scope.getStore() ?? {}), ...s }, fn);
}

/** The adapter with each send() in withDebugScope(s): the same adapter when the log is off. */
export function debugScoped(adapter: ProviderAdapter, s: Scope): ProviderAdapter {
  if (!debugLogDir()) return adapter;
  return { ...adapter, send: (req, signal, onEvent) => withDebugScope(s, () => adapter.send(req, signal, onEvent)) };
}

export interface DebugCallInfo {
  dialect: ProviderId;
  model: string;
  /** strict | reduced | loose (a cloud provider); no_images | with_images | without_images (a local server) */
  attempt: string;
  /** Why the request went so: null for a first try. */
  reason?: string | null;
  /** A cloud request's strict tools: `count` of the `of` it offers. */
  strict?: { count: number; of: number };
  /** The request body exactly as sent. */
  body: unknown;
}

export interface DebugCall {
  /** The fetch the SDK gets, noting each answer's status, request id and, for a failure, its body. */
  fetch(f: typeof globalThis.fetch): typeof globalThis.fetch;
  done(r: ProviderResult): void;
  failed(err: unknown, mapped?: { code?: string; status?: number | null; message?: string } | null): void;
}

interface HttpNote {
  status?: number;
  request_id?: string | null;
  ms: number;
  error?: string;
  body?: string;
}

type Json = Record<string, unknown>;
const field = (e: unknown, k: string): unknown => (e && typeof e === 'object' ? (e as Json)[k] : undefined);

function requestId(h: Headers): string | null {
  for (const k of REQUEST_ID_HEADERS) {
    const v = h.get(k);
    if (v) return v;
  }
  return null;
}

const capText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…[${s.length - max} more characters]` : s);

/** JSON with base64 image data as markers. */
function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'string' && x.length > BIG_STRING && BASE64.test(x)) {
      const data = x.replace(/^data:[^,]*,/, '').replace(/[\r\n]/g, '');
      return `[base64 data, ${Math.floor((data.length * 3) / 4)} bytes]`;
    }
    return x;
  });
}

function errorOf(err: unknown): Json {
  const out: Json = {};
  const name = field(err, 'name') ?? (err as object | null)?.constructor?.name;
  if (typeof name === 'string' && name) out.name = name;
  out.message = err instanceof Error ? err.message : String(err);
  for (const k of ['status', 'type', 'code', 'request_id', 'requestID']) {
    const v = field(err, k);
    if (v !== undefined && v !== null && typeof v !== 'object') out[k] = v;
  }
  const body = field(err, 'error');
  if (body !== undefined) {
    try {
      out.body = JSON.parse(JSON.stringify(body)) as unknown;
    } catch {
      out.body = String(body);
    }
  }
  const cause = field(err, 'cause');
  if (cause && cause !== err) out.cause = field(cause, 'message') ?? String(cause);
  return out;
}

function resultOf(r: ProviderResult): Json {
  const blocks = r.message.parts.map((p): Json => {
    if (p.type === 'text') return { type: 'text', text: capText(p.text, MAX_TEXT) };
    if (p.type === 'thinking') return { type: 'thinking', chars: p.text.length };
    return {
      type: 'tool_call',
      name: p.name,
      call_id: p.callId,
      input: p.input,
      ...(p.inputError ? { input_error: p.inputError } : {}),
    };
  });
  return {
    stop: r.stop,
    served_by: r.servedBy,
    usage: r.usage,
    attempts: r.attempts,
    ...(r.refusal ? { refusal: r.refusal } : {}),
    ...(r.notes?.length ? { notes: r.notes } : {}),
    ...(r.toolCallAsText ? { tool_call_as_text: true } : {}),
    ...(r.cleared ? { cleared: r.cleared } : {}),
    blocks,
  };
}

function enqueue(build: Promise<string>): void {
  const folder = debugLogDir();
  if (!folder) return;
  queue = queue
    .then(async () => {
      const line = await build;
      if (made !== folder) {
        await mkdir(folder, { recursive: true });
        made = folder;
      }
      const file = join(folder, DEBUG_LOG_FILE);
      // Past its size the file starts again; the one before it is kept.
      const size = await stat(file).then(
        (st) => st.size,
        () => 0,
      );
      if (size + line.length > PROVIDER_LOG_MAX) await rename(file, join(folder, DEBUG_LOG_OLD));
      await appendFile(file, `${line}\n`, 'utf8');
    })
    .catch((err: unknown) => {
      if (warned) return;
      warned = true;
      alog('warn', 'the provider debug log could not be written', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** One provider request's row, or null when the log is off. */
export function debugCall(info: DebugCallInfo): DebugCall | null {
  if (!debugLogDir()) return null;
  const started = Date.now();
  const ctx = scope.getStore() ?? {};
  const http: HttpNote[] = [];
  const bodies: Array<Promise<void>> = [];
  let ended = false;

  const finish = (outcome: Json) => {
    if (ended) return;
    ended = true;
    const ms = Date.now() - started;
    const build = (async () => {
      await Promise.race([Promise.all(bodies), new Promise((r) => setTimeout(r, BODY_WAIT_MS).unref?.())]);
      const row: Json = {
        time: new Date(started).toISOString(),
        turn: ctx.turn ?? null,
        step: ctx.step ?? null,
        dialect: info.dialect,
        model: info.model,
        attempt: info.attempt,
        reason: info.reason ?? null,
        ...(info.strict ? { strict: { count: info.strict.count, of: info.strict.of } } : {}),
        ...(ctx.resend ? { resend: ctx.resend } : {}),
        ms,
        http,
        ...outcome,
        request: info.body,
      };
      let line = stringify(row);
      if (line.length > MAX_ROW) {
        const req = stringify(info.body);
        const head = Math.max(0, MAX_ROW - (line.length - req.length) - 512);
        row.request = {
          cut: `the request body was ${req.length} characters; its first ${head} follow`,
          head: req.slice(0, head),
        };
        line = stringify(row);
      }
      return redact(line);
    })();
    enqueue(build);
  };

  return {
    fetch(f) {
      return async (input, init) => {
        const t0 = Date.now();
        const note: HttpNote = { ms: 0 };
        http.push(note);
        try {
          const res = await f(input, init);
          note.ms = Date.now() - t0;
          note.status = res.status;
          note.request_id = requestId(res.headers);
          if (!res.ok) {
            bodies.push(
              res
                .clone()
                .text()
                .then(
                  (t) => {
                    note.body = capText(t, MAX_ERROR_BODY);
                  },
                  (e: unknown) => {
                    note.body = `(the body could not be read: ${e instanceof Error ? e.message : String(e)})`;
                  },
                ),
            );
          }
          return res;
        } catch (err) {
          note.ms = Date.now() - t0;
          note.error = err instanceof Error ? err.message : String(err);
          throw err;
        }
      };
    },
    done(r) {
      finish({ ok: true, result: resultOf(r) });
    },
    failed(err, mapped) {
      finish({
        ok: false,
        ...(mapped
          ? {
              mapped: {
                code: mapped.code ?? null,
                status: mapped.status ?? null,
                message: mapped.message ?? null,
              },
            }
          : {}),
        error: errorOf(err),
      });
    },
  };
}
