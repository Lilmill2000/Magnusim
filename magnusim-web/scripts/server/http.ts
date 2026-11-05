import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

export type SendJson = (res: ServerResponse, status: number, body: unknown) => void;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

export function parseUrl(reqUrl: string | undefined): URL {
  return new URL(reqUrl || '/', 'http://127.0.0.1');
}

/**
 * A path as the router matches it: empty segments dropped (the router splits on '/' and
 * keeps the non-empty parts), so `/api//x` reads `/api/x`. parseUrl has already folded
 * `.` and `..` segments, `%2e%2e` included.
 */
export function canonicalPath(pathname: string): string {
  return '/' + String(pathname || '').split('/').filter(Boolean).join('/');
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const jsonBodies = new WeakMap<IncomingMessage, Record<string, unknown>>();

/** A JSON request body's size limit. */
export const JSON_BODY_LIMIT = 2 * 1024 * 1024;
/**
 * A plugin's data file may be 8 MB (plugin_data.write refuses more); its request
 * carries it plus the project, plugin and path.
 */
export const PLUGIN_DATA_BODY_LIMIT = 9 * 1024 * 1024;

/**
 * The Assistant's bodies are small, but for a workspace tool's result (images), a turn's
 * reference pictures and the tool list a workspace offers; a key is a few hundred bytes.
 */
export const ASSISTANT_BODY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  '/api/assistant/relay/result': 10 * 1024 * 1024,
  '/api/assistant/relay/tools': 512 * 1024,
  '/api/assistant/key': 16 * 1024,
  // A turn's start: its prompt and up to 4 reference pictures (each at most 1.5 MB, as base64).
  '/api/assistant/turns': 10 * 1024 * 1024,
});
/** Every other Assistant route (the test-only ones too). */
export const ASSISTANT_BODY_LIMIT = 64 * 1024;

/** The body limit of the route the router will match (so `/api//assistant/key` reads as `/api/assistant/key`). */
export function jsonBodyLimit(pathname: string): number {
  const path = canonicalPath(pathname);
  if (path === '/api/plugin-data/write') return PLUGIN_DATA_BODY_LIMIT;
  if (Object.hasOwn(ASSISTANT_BODY_LIMITS, path)) return ASSISTANT_BODY_LIMITS[path];
  for (const prefix of ['/api/assistant', '/api/test/assistant']) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return ASSISTANT_BODY_LIMIT;
  }
  return JSON_BODY_LIMIT;
}

export async function readJsonBody(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
  const cached = jsonBodies.get(req);
  if (cached) return cached;
  const raw = (await readBinaryBody(req, limit)).toString('utf8');
  if (!raw.trim()) {
    const empty = {};
    jsonBodies.set(req, empty);
    return empty;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON body must be an object');
  }
  const body = parsed as Record<string, unknown>;
  jsonBodies.set(req, body);
  return body;
}

export function readBinaryBody(req: IncomingMessage, limit = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    req.on('data', (c: Buffer) => {
      if (exceeded) return;
      total += c.length;
      if (total > limit) {
        exceeded = true;
        chunks = [];
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on('aborted', () => { chunks = []; reject(new HttpError(400, 'request aborted')); });
    req.on('error', reject);
  });
}

export function sendBytes(
  res: ServerResponse,
  buf: Buffer,
  headers: Record<string, string>,
  headOnly = false,
): void {
  res.statusCode = 200;
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', headers['Cache-Control'] || 'no-store');
  if (headOnly) {
    res.end();
    return;
  }
  res.end(buf);
}

export function weakEtag(payload: string): string {
  let h = 2166136261;
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `W/"${(h >>> 0).toString(16)}-${payload.length.toString(16)}"`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True only for a browser on this PC talking to the app directly. Turning plugins
 * on or off changes what code the app runs, so it is refused through the public
 * tunnel or any reverse proxy (their requests carry a public Host or X-Forwarded-*).
 */
export function isLocalOperator(req: IncomingMessage): boolean {
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith('x-forwarded-') || name === 'forwarded' || name.startsWith('cf-')) return false;
  }
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const remote = String(req.socket?.remoteAddress || '');
  return LOOPBACK_ADDRS.has(remote);
}

/**
 * The hosts a server answers on: Vite's `allowedHosts` (a list, or true for any host) and
 * the extra names Vite adds from its own options (the `host` it was started with, the HMR
 * host, the `origin`'s hostname).
 */
export interface HostRule {
  allowed: readonly string[] | true;
  extra: readonly string[];
}

/** A server with no Vite config (Magnusim CAD's): this PC's own names and IP addresses only. */
export const LOOPBACK_ONLY: HostRule = Object.freeze({ allowed: Object.freeze([]) as readonly string[], extra: Object.freeze([]) as readonly string[] });

/** What the host check reads of a Vite server's resolved config (ViteDevServer / PreviewServer `.config`). */
export interface HostConfigSource {
  server?: { allowedHosts?: readonly string[] | true; host?: unknown; hmr?: unknown; origin?: unknown; https?: unknown };
  preview?: { allowedHosts?: readonly string[] | true; host?: unknown; https?: unknown };
}

/**
 * The host rule of a Vite server (`side`: the dev server or `vite preview`), read from its
 * resolved config so vite.config.js `allowedHosts` (MAGNUSIM_ALLOWED_HOSTS and the public
 * tunnel's host included) stays the one list. The same as Vite's own host check: an HTTPS
 * server checks no host (a rebinding page can't get its certificate), and `vite preview`'s
 * list is the dev server's unless set. No config: LOOPBACK_ONLY.
 */
export function hostRuleOf(config: HostConfigSource | null | undefined, side: 'server' | 'preview'): HostRule {
  if (!config || typeof config !== 'object') return LOOPBACK_ONLY;
  const server = config.server || {};
  const preview = config.preview || {};
  const own = side === 'preview' ? preview : server;
  if (own.https) return { allowed: true, extra: [] };
  const list = (side === 'preview' ? preview.allowedHosts ?? server.allowedHosts : server.allowedHosts) ?? [];
  const extra: string[] = [];
  const named = (v: unknown) => {
    if (typeof v === 'string' && v) extra.push(v);
  };
  named(server.host);
  if (server.hmr && typeof server.hmr === 'object') named((server.hmr as { host?: unknown }).host);
  named(preview.host);
  if (typeof server.origin === 'string' && server.origin) {
    try {
      named(new URL(server.origin).hostname);
    } catch {
      /* not a URL: Vite skips it too */
    }
  }
  return { allowed: list === true ? true : [...list], extra };
}

/**
 * Whether a request's Host header names this server (Vite's host check, isHostAllowed): an IP
 * address, `localhost` or a `*.localhost` name, one of `rule.extra`, or one of `rule.allowed`
 * (a name starting with "." also allows every name under it). A DNS-rebinding page sends its own
 * domain as Host, so it is refused even though its requests reach 127.0.0.1. No Host: refused.
 */
export function isAllowedHost(hostHeader: string | string[] | undefined, rule: HostRule = LOOPBACK_ONLY): boolean {
  if (rule.allowed === true) return true;
  const host = String(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader ?? '').trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 && isIP(host.slice(1, end)) === 6;
  }
  const colon = host.indexOf(':');
  const name = colon === -1 ? host : host.slice(0, colon);
  if (isIP(name) === 4) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (rule.extra.some((h) => h.toLowerCase() === name)) return true;
  return rule.allowed.some((entry) => {
    const h = entry.trim().toLowerCase();
    if (h === name) return true;
    return h.startsWith('.') && h.length > 1 && (h.slice(1) === name || name.endsWith(h));
  });
}

/** The hostname a refusal names (the Host header without its port). */
function hostnameOf(hostHeader: string | string[] | undefined): string {
  const host = String(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader ?? '').trim();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}

/** The 403 a request to a host this server doesn't answer on gets (refuseForeignHost). */
export function foreignHostBody(hostHeader: string | string[] | undefined): { ok: false; reason: 'host'; error: string } {
  const name = hostnameOf(hostHeader);
  return {
    ok: false,
    reason: 'host',
    error:
      `Blocked request: this host (${JSON.stringify(name)}) is not allowed. Magnusim answers only on this PC's own ` +
      'addresses (localhost, 127.0.0.1) and the hosts in its allowed list (server.allowedHosts in vite.config.js, ' +
      'plus MAGNUSIM_ALLOWED_HOSTS).',
  };
}

/**
 * Answers 403 (and returns true) for a request whose Host this server doesn't answer on. index.ts
 * runs it first for every /api/, /plugins/ and /plugin-sdk/ request: the app's middleware runs
 * before Vite's own host check (a plugin's configureServer middlewares come first), so without it
 * a DNS-rebinding page could read and write projects and open the event streams.
 */
export function refuseForeignHost(req: IncomingMessage, res: ServerResponse, rule: HostRule): boolean {
  if (isAllowedHost(req.headers.host, rule)) return false;
  sendJson(res, 403, foreignHostBody(req.headers.host));
  return true;
}

/**
 * Browser requests must come from the app origin, including localhost deployments. This compares
 * Origin with Host only, so it can't tell a rebinding page (both its own domain) from the app:
 * refuseForeignHost runs before it.
 */
export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site API request denied');
  if (!origin) return; // Native/CLI clients do not send Origin.
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'invalid request origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== req.headers.host) {
    throw new HttpError(403, 'cross-origin API request denied');
  }
}
