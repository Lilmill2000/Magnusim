/**
 * The loopback call the read and edit tools use (Core host tools spec 3.1-3.4): an entry of
 * HOST_ROUTES, its args, and the turn. The same rules as the starters' GET (host-call.ts):
 * 127.0.0.1 with no Origin, the turn header, a timeout per entry, answers over the entry's
 * size refused, a 5xx as a fixed line and a 4xx's text with its paths taken out. Added here:
 *
 * - JSON bodies (content-type application/json, so the router reads project_id from them),
 *   a raw file stream (the geometry import) and binary answers (thumbnails);
 * - `x-magnusim-assistant-tool: <tool>.<action>` on every request (logs);
 * - pacing, not refusal: at most 5 calls a second per turn, 2 of them writes; a call over
 *   that waits for its slot (a tool's own steps, or 64 probe points, never fail for it);
 * - a 503 `geometry_updating` is asked again once after its Retry-After (the page's
 *   fetchLinkedSave does the same); a 409 fails at once.
 *
 * A refusal keeps the app's code (`appCode`: the body's string `code`, or its numeric RPC
 * code as text) so a tool can tell `stale_record`, `geometry_changed` and the rest apart.
 */
import http from 'node:http';
import { TURN_HEADER } from '../access.ts';
import { HOST_CALL_RATE, HostCallError, scrubPaths, type HostGetOptions } from '../host-call.ts';
import { HOST_ROUTES, SEGMENT, type Args, type HostRoute } from '../host-routes.ts';
import { alog } from '../log.ts';
import { redact } from '../redact.ts';
import { cleanText } from '../sanitize.ts';

export const TOOL_HEADER = 'x-magnusim-assistant-tool';
export const HOST_WRITE_RATE = Object.freeze({ calls: 2, perMs: 1_000 });
/** The longest a 503 `geometry_updating` is waited out before its one retry. */
const RETRY_AFTER_MAX_MS = 5_000;

export class RouteCallError extends HostCallError {
  /** The app's own code for the refusal ('stale_record', 'geometry_changed', '-32009', …), or null. */
  appCode: string | null;
  /** The refusal's JSON body (paths scrubbed from its text), for a tool that reads more of it. */
  body: Record<string, unknown> | null;
  constructor(code: HostCallError['code'], message: string, status: number | null, appCode: string | null = null, body: Record<string, unknown> | null = null) {
    super(code, message, status);
    this.appCode = appCode;
    this.body = body;
  }
}

export interface RouteCallOptions extends HostGetOptions {
  /** `<tool>.<action>` for the tool header. */
  tool?: string;
}

export type HostCall = (id: string, args: Args, o: RouteCallOptions) => Promise<Record<string, unknown> | Buffer>;

export interface RouteCallerOptions {
  port: () => number | null | undefined;
  now?: () => number;
  /** The table (tests pass their own); HOST_ROUTES by default. */
  routes?: Readonly<Record<string, HostRoute>>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HostCallError('aborted', 'Stopped.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new HostCallError('aborted', 'Stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The path with its `:name` segments filled from `args`, or why not. */
export function fillPath(path: string, args: Args): string {
  return path.replace(/:([A-Za-z_]+)/g, (_m, name: string) => {
    const v = String(args[name] ?? '');
    if (!SEGMENT.test(v)) throw new RouteCallError('not_allowed', `Not a valid ${name}.`, null);
    return encodeURIComponent(v);
  });
}

/** The request an entry makes for `args` (no I/O): method, path with query, body bytes or stream. */
export function buildRequest(route: HostRoute, args: Args): { method: string; target: string; json: string | null; raw: ReturnType<NonNullable<HostRoute['raw']>> | null } {
  const path = fillPath(route.path, args);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(route.query ? route.query(args) : {})) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  const target = `${path}${qs.size ? `?${qs.toString()}` : ''}`;
  const raw = route.raw ? route.raw(args) : null;
  const json = !raw && route.body ? JSON.stringify(route.body(args)) : null;
  return { method: route.method, target, json, raw };
}

function codeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { code?: unknown; reason?: unknown };
  if (typeof b.code === 'string' && b.code) return b.code;
  if (typeof b.reason === 'string' && b.reason) return b.reason;
  if (typeof b.code === 'number' && Number.isFinite(b.code)) return String(b.code);
  return null;
}

export function createRouteCaller(o: RouteCallerOptions): HostCall {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const table = o.routes ?? HOST_ROUTES;
  const recent = new Map<string, number[]>();
  const writes = new Map<string, number[]>();

  /** Waits for a slot in `map` for `key` (at most `rate.calls` in `rate.perMs`), then takes it. */
  async function slot(map: Map<string, number[]>, key: string, rate: { calls: number; perMs: number }, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const t = now();
      const calls = (map.get(key) ?? []).filter((at) => t - at < rate.perMs);
      if (calls.length < rate.calls) {
        calls.push(t);
        map.set(key, calls);
        if (map.size > 200) for (const [k, v] of map) if (!v.some((at) => t - at < rate.perMs)) map.delete(k);
        return;
      }
      map.set(key, calls);
      await sleep(Math.max(5, rate.perMs - (t - calls[0]) + 1), signal);
    }
  }

  function once(route: HostRoute, req: ReturnType<typeof buildRequest>, port: number, opts: RouteCallOptions): Promise<{ status: number; body: Record<string, unknown> | Buffer; retryAfter: number | null }> {
    const timeoutMs = opts.timeoutMs ?? route.timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, value?: { status: number; body: Record<string, unknown> | Buffer; retryAfter: number | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value!);
      };
      const headers: Record<string, string | number> = {
        host: `127.0.0.1:${port}`,
        accept: route.binary ? 'application/octet-stream, image/png, application/json' : 'application/json',
        [TURN_HEADER]: opts.turn ?? 'none',
        [TOOL_HEADER]: cleanText(opts.tool ?? '', 80) || 'host',
      };
      if (req.json !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(req.json);
      } else if (req.raw) {
        headers['content-type'] = req.raw.type;
        headers['content-length'] = req.raw.bytes;
      }
      const r = http.request({ host: '127.0.0.1', port, method: req.method, path: req.target, headers }, (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > route.maxBytes) {
            r.destroy();
            finish(new RouteCallError('too_large', 'The app answered with more than the Assistant reads.', res.statusCode ?? null));
            return;
          }
          parts.push(c);
        });
        res.on('error', () => finish(new RouteCallError('unreachable', 'The app stopped answering.', null)));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const bytes = Buffer.concat(parts);
          const ra = Number(res.headers['retry-after']);
          const retryAfter = Number.isFinite(ra) ? ra : null;
          const type = String(res.headers['content-type'] || '');
          if (route.binary && status >= 200 && status < 300 && !type.includes('json')) {
            finish(null, { status, body: bytes, retryAfter });
            return;
          }
          let body: unknown = null;
          if (bytes.length) {
            try {
              body = JSON.parse(bytes.toString('utf8'));
            } catch {
              finish(new RouteCallError('bad_answer', 'The app answered with something that is not JSON.', status));
              return;
            }
          } else body = {};
          finish(null, { status, body: body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : { value: body }, retryAfter });
        });
      });
      const onAbort = () => {
        r.destroy();
        finish(new RouteCallError('aborted', 'Stopped.', null));
      };
      const timer = setTimeout(() => {
        r.destroy();
        finish(new RouteCallError('timeout', `The app didn't answer within ${Math.round(timeoutMs / 1000)} s.`, null));
      }, timeoutMs);
      timer.unref?.();
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
      r.on('error', () => finish(new RouteCallError('unreachable', "The app didn't answer.", null)));
      if (req.json !== null) r.end(req.json);
      else if (req.raw) {
        req.raw.stream.on('error', () => {
          r.destroy();
          finish(new RouteCallError('unreachable', 'The file could not be read.', null));
        });
        req.raw.stream.pipe(r);
      } else r.end();
    });
  }

  return async (id, args, opts) => {
    const route = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!route) throw new RouteCallError('not_allowed', `The Assistant may not call ${cleanText(id, 80)}.`, null);
    const port = Number(o.port());
    if (!Number.isInteger(port) || port <= 0) throw new RouteCallError('not_ready', 'The app is still starting.', null);
    const key = opts.turn ?? '-';
    let retried = false;
    for (;;) {
      await slot(recent, key, HOST_CALL_RATE, opts.signal);
      if (route.band === 'write') await slot(writes, key, HOST_WRITE_RATE, opts.signal);
      // Built per attempt: a raw stream is read once (the import is never retried: it is not gated twice).
      const req = buildRequest(route, args);
      const { status, body, retryAfter } = await once(route, req, port, opts);
      if (status >= 200 && status < 300) {
        if (Buffer.isBuffer(body)) return body;
        // A worker refusal can come as 200 {ok:false} (workerJson answers the RPC's result as is).
        return body;
      }
      const json = Buffer.isBuffer(body) ? {} : body;
      const appCode = codeOf(json);
      if (status === 503 && appCode === 'geometry_updating' && !retried && !req.raw) {
        retried = true;
        await sleep(Math.min(RETRY_AFTER_MAX_MS, Math.max(500, (retryAfter ?? 2) * 1000)), opts.signal);
        continue;
      }
      const rawText = (json as { error?: unknown }).error;
      if (status >= 500 && appCode !== 'geometry_updating') {
        alog('warn', 'a host tool call failed', { route: id, status, detail: redact(cleanText(rawText, 300)) });
        throw new RouteCallError('http', `The app had an error (HTTP ${status}).`, status, appCode);
      }
      const said = cleanText(scrubPaths(cleanText(rawText, 2000)), 300);
      const scrubbed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(json)) scrubbed[k] = typeof v === 'string' ? scrubPaths(v) : v;
      throw new RouteCallError('http', said || `The app answered HTTP ${status}.`, status, appCode, scrubbed);
    }
  };
}
