/**
 * How the host tools read the app: over loopback HTTP, through the app's own routes, so
 * a tool sees exactly what the page sees and passes the same checks (same-origin gate,
 * project scope, the boot wait, the worker's lanes). Never by calling route code or the
 * worker directly.
 *
 * - GET only, and only the frozen allowlist below (exact paths): no write, no compute,
 *   and none of the Assistant's own routes.
 * - Every call carries `x-magnusim-assistant-turn: <turn id>`, which the Assistant's own
 *   routes refuse (assistant-routes.ts local()): a tool can never start a turn, save a
 *   key or answer a question.
 * - 30 s per call; at most 5 calls a second per turn (a model in a loop can't hammer the
 *   serial worker); answers over 4 MB are refused.
 */
import http from 'node:http';
import { TURN_HEADER } from './access.ts';
import { cleanText } from './sanitize.ts';

export const HOST_GET_ALLOWLIST: readonly string[] = Object.freeze(['/api/compute-queue', '/api/projects', '/api/project', '/api/simulation', '/api/run/ready']);

export const HOST_CALL_TIMEOUT_MS = 30_000;
export const HOST_CALL_RATE = Object.freeze({ calls: 5, perMs: 1_000 });
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

export type HostCallCode = 'not_allowed' | 'not_ready' | 'rate_limited' | 'timeout' | 'aborted' | 'unreachable' | 'too_large' | 'bad_answer' | 'http';

export class HostCallError extends Error {
  code: HostCallCode;
  status: number | null;
  constructor(code: HostCallCode, message: string, status: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface HostGetOptions {
  signal?: AbortSignal;
  /** The turn the call is for (its id goes in the header); null for the Settings test. */
  turn: string | null;
  timeoutMs?: number;
}

export type HostGet = (path: string, query: Record<string, string | null | undefined>, o: HostGetOptions) => Promise<Record<string, unknown>>;

export interface HostCallerOptions {
  /** The port this server listens on (boundPortFromListen). */
  port: () => number | null | undefined;
  now?: () => number;
}

/** The loopback GET the host tools use. */
export function createHostCaller(o: HostCallerOptions): HostGet {
  const now = o.now ?? Date.now;
  const recent = new Map<string, number[]>();

  return (path, query, opts) => {
    if (!HOST_GET_ALLOWLIST.includes(path)) return Promise.reject(new HostCallError('not_allowed', `The Assistant may not read ${cleanText(path, 80)}.`));
    const port = Number(o.port());
    if (!Number.isInteger(port) || port <= 0) return Promise.reject(new HostCallError('not_ready', 'The app is still starting.'));
    const key = opts.turn ?? '-';
    const t = now();
    const calls = (recent.get(key) ?? []).filter((at) => t - at < HOST_CALL_RATE.perMs);
    if (calls.length >= HOST_CALL_RATE.calls) {
      recent.set(key, calls);
      return Promise.reject(new HostCallError('rate_limited', 'Too many app requests at once; wait a moment and try again.'));
    }
    calls.push(t);
    recent.set(key, calls);
    if (recent.size > 200) for (const [k, v] of recent) if (!v.some((at) => t - at < HOST_CALL_RATE.perMs)) recent.delete(k);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
    const target = `${path}${qs.size ? `?${qs.toString()}` : ''}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: HostCallError | null, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value as Record<string, unknown>);
      };
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: target,
          headers: { host: `127.0.0.1:${port}`, accept: 'application/json', [TURN_HEADER]: opts.turn ?? 'none' },
        },
        (res) => {
          const parts: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_ANSWER_BYTES) {
              req.destroy();
              finish(new HostCallError('too_large', 'The app answered with more than the Assistant reads.'));
              return;
            }
            parts.push(c);
          });
          res.on('error', () => finish(new HostCallError('unreachable', 'The app stopped answering.')));
          res.on('end', () => {
            let body: unknown = null;
            try {
              body = JSON.parse(Buffer.concat(parts).toString('utf8'));
            } catch {
              finish(new HostCallError('bad_answer', 'The app answered with something that is not JSON.', res.statusCode ?? null));
              return;
            }
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300 || !body || typeof body !== 'object' || Array.isArray(body)) {
              const said = body && typeof body === 'object' ? cleanText((body as { error?: unknown }).error, 300) : '';
              finish(new HostCallError('http', said || `The app answered HTTP ${status}.`, status));
              return;
            }
            finish(null, body as Record<string, unknown>);
          });
        },
      );
      const onAbort = () => {
        req.destroy();
        finish(new HostCallError('aborted', 'Stopped.'));
      };
      const timer = setTimeout(() => {
        req.destroy();
        finish(new HostCallError('timeout', `The app didn't answer within ${Math.round((opts.timeoutMs ?? HOST_CALL_TIMEOUT_MS) / 1000)} s.`));
      }, opts.timeoutMs ?? HOST_CALL_TIMEOUT_MS);
      timer.unref?.();
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', () => finish(new HostCallError('unreachable', "The app didn't answer.")));
      req.end();
    });
  };
}
