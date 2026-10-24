/**
 * How the host tools reach the app: over loopback HTTP, through the app's own routes, so
 * a tool sees exactly what the page sees and passes the same checks (same-origin gate,
 * project scope, the boot wait, the worker's lanes, the link gate). Never by calling route
 * code or the worker directly.
 *
 * Two callers share one transport (createHostTransport):
 * - `get(path, query)`: the starter tools' GET, only the frozen HOST_GET_ALLOWLIST (exact
 *   paths).
 * - `call(id, args)` (core host tools spec C1): a tool never passes a path, only an entry id
 *   of HOST_ROUTES (host-routes.ts), whose method, exact path (`:name` segments filled from
 *   args, each /^[A-Za-z0-9._-]{1,128}$/), query and body builders are fixed. A JSON body
 *   names every key it sends (never the model's input spread); a raw body is a file stream
 *   (the geometry import); a `binary` answer is bytes (PNG thumbnails, C6).
 *
 * - The table is checked against the denylist when it is frozen and again at each call
 *   (deniedRoute; the node test holds its own copy of the list): no Assistant route, no
 *   plugin on/off, removal or package route, no prefs write, no project open, no case attach,
 *   no mesh/delete, the worker only for materials.set, bcs.set and bc.menu, never
 *   `{delete:true}` to the BC or refinement routes, and a geometry import's `step_path` only
 *   when the turn's own message holds it exactly (§4.11).
 * - Every call carries `x-magnusim-assistant-turn: <turn id>`, which the Assistant's own
 *   routes refuse (assistant-routes.ts local()): a tool can never start a turn, save a
 *   key or answer a question; and `x-magnusim-assistant-tool: <tool>.<action>` when the
 *   tool names itself (logs; the ui_sync origin). JSON bodies go as application/json (the
 *   router reads `project_id` from a body only then).
 * - Per turn: at most 5 calls a second, and at most 2 writes a second (a model in a loop
 *   can't hammer the serial worker). 30 s per call unless the entry says (import 600 s, the
 *   hardware check 150 s); answers over the entry's maxBytes (default 4 MB) are refused.
 * - The link gate (§3.4): a 503 `geometry_updating` is tried once more after its Retry-After
 *   (at most LINK_RETRY_MAX_MS), then fails `geometry_updating`; a 409 `geometry_changed`
 *   fails at once, as does a 409 `stale_record` (C2, with its kind, id and rev).
 * - The app's error text reaches the model only for a refusal (4xx), with any path taken
 *   out; a server error (5xx: often an exception's text, with a full path and the user
 *   name in it) is a fixed line, its text only in the log.
 */
import http from 'node:http';
import { TURN_HEADER } from './access.ts';
import { HOST_ROUTE_TABLE } from './host-routes.ts';
import { alog } from './log.ts';
import { redact } from './redact.ts';
import { cleanText } from './sanitize.ts';

/** Names the tool and action that made a call (`setup_edit.bc`), for the logs and the ui_sync origin. */
export const TOOL_HEADER = 'x-magnusim-assistant-tool';

export const HOST_CALL_TIMEOUT_MS = 30_000;
export const HOST_CALL_RATE = Object.freeze({ calls: 5, perMs: 1_000 });
/** Writes per turn, within HOST_CALL_RATE. */
export const HOST_WRITE_RATE = Object.freeze({ calls: 2, perMs: 1_000 });
export const HOST_ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** The longest wait before the one retry of a request the link gate held (its Retry-After). */
export const LINK_RETRY_MAX_MS = 10_000;
/** The worker methods a host route may name (POST /api/worker): every other one is refused. */
export const WORKER_METHODS: readonly string[] = Object.freeze(['materials.set', 'bcs.set', 'bc.menu']);
/** A `:name` segment's value. */
export const PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export type HostCallCode =
  | 'not_allowed'
  | 'invalid_args'
  | 'not_ready'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  | 'unreachable'
  | 'too_large'
  | 'bad_answer'
  | 'geometry_updating'
  | 'geometry_changed'
  | 'stale_record'
  | 'http';

export class HostCallError extends Error {
  code: HostCallCode;
  status: number | null;
  /** The app's own word for a refusal (`code` or `reason` of its 4xx body), else null. */
  appCode: string | null;
  /** Plain fields of the refusal the tool may pass on (a stale record's kind, id and rev). */
  detail: Record<string, unknown> | null;
  constructor(code: HostCallCode, message: string, status: number | null = null, appCode: string | null = null, detail: Record<string, unknown> | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.appCode = appCode;
    this.detail = detail;
  }
}

export interface HostGetOptions {
  signal?: AbortSignal;
  /** The turn the call is for (its id goes in the header); null for the Settings test. */
  turn: string | null;
  timeoutMs?: number;
}

export interface HostCallOptions extends HostGetOptions {
  /** `<tool>.<action>` for the tool header (logs; the ui_sync origin). */
  tool?: string;
  /** This turn's own message (ToolCtx.prompt): a geometry import's step_path must be in it exactly. */
  prompt?: string | null;
}

export type Args = Record<string, unknown>;
export type QueryValue = string | number | boolean | null | undefined;

export interface HostRoute {
  method: 'GET' | 'POST' | 'PATCH';
  /** Exact path; `:name` segments are filled from args and must match PATH_SEGMENT. */
  path: string;
  /** Query from args (GET, and the raw import). */
  query?: (a: Args) => Record<string, QueryValue>;
  /** JSON body from args (POST/PATCH). Never spreads the model's input: every key is named. */
  body?: (a: Args) => Record<string, unknown>;
  /** A raw body instead (the geometry import): a file stream, with its byte count. Called again for the link gate's retry. */
  raw?: (a: Args) => { stream: NodeJS.ReadableStream; bytes: number; type: 'application/octet-stream' };
  /** Binary answer (PNG thumbnails, C6): the call resolves with the bytes. */
  binary?: boolean;
  /** POST /api/worker only: the one worker method its body names (WORKER_METHODS). */
  worker?: string;
  /** Default HOST_CALL_TIMEOUT_MS; import 600 s; hardware check 150 s. */
  timeoutMs?: number;
  /** Default HOST_ANSWER_MAX_BYTES; faces/meta 16 MB (then trimmed by the tool). */
  maxBytes?: number;
  band: 'read' | 'write';
}

export type HostCall = (id: string, args: Args, o: HostCallOptions) => Promise<Record<string, unknown> | Buffer>;
export type HostGet = (path: string, query: Record<string, string | null | undefined>, o: HostGetOptions) => Promise<Record<string, unknown>>;

const BC_OR_REFINEMENTS = new Set(['/api/bcs', '/api/mesh/refinements']);
const IMPORT_PATH = '/api/geometry/import';

/**
 * Why a route may never be a host route (core host tools spec §3.3), or null when it may.
 * Static: the method, path and flags. Body-dependent rules are checked per call (bodyDenied).
 */
export function deniedRoute(r: HostRoute): string | null {
  if (!r || typeof r !== 'object') return 'not a route';
  if (!['GET', 'POST', 'PATCH'].includes(r.method)) return `method ${String(r.method)}`;
  const path = typeof r.path === 'string' ? r.path : '';
  if (!/^\/api\/[A-Za-z0-9._:/-]+$/.test(path) || path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(path) || path.endsWith('/')) return 'not an exact /api path';
  const p = path.toLowerCase();
  if (p === '/api/assistant' || p.startsWith('/api/assistant/') || p.startsWith('/api/assistant-') || p.startsWith('/api/assistant_')) return "the Assistant's own routes";
  if (p.startsWith('/api/test/')) return 'test routes';
  if (/^\/api\/plugins\/[^/]+\/(enable|disable|remove)$/.test(p) || /^\/api\/plugins\/[^/]+\/env\/remove$/.test(p)) return 'turning plugins on or off, or removing them';
  if (p === '/api/plugins/package' || p.startsWith('/api/plugins/package/')) return 'plugin packages';
  if (p === '/api/prefs' && r.method !== 'GET') return 'writing the preferences';
  if (p === '/api/project/open') return 'opening a project (core__show moves the view)';
  if (p === '/api/case/attach') return 'attaching a case server-wide';
  if (p === '/api/mesh/delete') return 'mesh/delete (it skips the generated-mesh hook)';
  if (p === '/api/worker' && (r.method !== 'POST' || !r.worker || !WORKER_METHODS.includes(r.worker))) return `the worker (only ${WORKER_METHODS.join(', ')})`;
  if (r.raw && p !== IMPORT_PATH) return 'a raw body outside the geometry import';
  if (r.binary && r.method !== 'GET') return 'a binary answer to a write';
  if (r.method === 'GET' && (r.body || r.raw)) return 'a GET with a body';
  if (r.method === 'GET' && r.band !== 'read') return 'a GET in the write band';
  if (r.band !== 'read' && r.band !== 'write') return 'no band';
  return null;
}

/** Why a call's body may not go (§3.3), or null. */
function bodyDenied(path: string, body: Record<string, unknown> | null, route: HostRoute, prompt: string | null | undefined): string | null {
  if (!body) return null;
  const p = path.toLowerCase();
  if (BC_OR_REFINEMENTS.has(p) && body.delete === true) return '`delete: true` removes every record: send the one id';
  if (p === '/api/worker' && body.method !== route.worker) return `the worker method must be ${String(route.worker)}`;
  if (p === IMPORT_PATH && body.step_path !== undefined) {
    const sp = body.step_path;
    if (typeof sp !== 'string' || !sp || typeof prompt !== 'string' || !prompt.includes(sp)) return 'a path the person did not type in this message';
  }
  if (p === IMPORT_PATH && (body.mode === 'replace' || body.replace === true)) return 'replacing every geometry';
  return null;
}

/** Throws when any entry of `table` is denied (a table is checked before it is used). */
export function checkRouteTable(table: Readonly<Record<string, HostRoute>>): void {
  for (const [id, r] of Object.entries(table)) {
    const why = deniedRoute(r);
    if (why) throw new Error(`host route ${id} is not allowed: ${why}`);
  }
}

function deepFreeze<T extends Record<string, HostRoute>>(table: T): Readonly<T> {
  for (const r of Object.values(table)) Object.freeze(r);
  return Object.freeze(table);
}

checkRouteTable(HOST_ROUTE_TABLE);
/** Every route a host tool may call, by entry id (host-routes.ts), frozen. */
export const HOST_ROUTES: Readonly<Record<string, HostRoute>> = deepFreeze({ ...HOST_ROUTE_TABLE });

/** The starter tools' entries (Foundation): their paths are HOST_GET_ALLOWLIST. */
export const STARTER_ROUTES: readonly string[] = Object.freeze(['queue.get', 'projects.list', 'project.get', 'simulation.get', 'run.ready']);
export const HOST_GET_ALLOWLIST: readonly string[] = Object.freeze(STARTER_ROUTES.map((id) => HOST_ROUTES[id].path));

const PATHS: readonly RegExp[] = [
  // Quoted text holding a slash or a backslash (an exception's file name).
  /(['"])[^'"\r\n]*[\\/][^'"\r\n]*\1/g,
  // A drive path or a network share, to the end of the line or quote.
  /\b[A-Za-z]:[\\/][^'"\r\n]*/g,
  /\\\\[^\\\s'"]+\\[^'"\r\n]*/g,
  // POSIX homes, mounts and temp folders.
  /(?<![\w.])\/(?:home|Users|root|mnt|tmp|var|private|media|run|opt|srv)\/[^\s'"]*/g,
];

/** `text` with every local path replaced by [path] (quotes kept). */
export function scrubPaths(text: string): string {
  let out = text;
  out = out.replace(PATHS[0], (_m, q: string) => `${q}[path]${q}`);
  for (const re of PATHS.slice(1)) out = out.replace(re, '[path]');
  return out;
}

export interface HostCallerOptions {
  /** The port this server listens on (boundPortFromListen). */
  port: () => number | null | undefined;
  now?: () => number;
  /** Tests: a table of their own (checked the same way); HOST_ROUTES when left out. */
  routes?: Readonly<Record<string, HostRoute>>;
  /** Tests: the wait before the link gate's retry (the server's Retry-After otherwise). */
  retryDelayMs?: (retryAfterS: number) => number;
}

interface Sent {
  status: number;
  retryAfterS: number | null;
  /** The answer's content-type, lower case ("" when none). */
  type: string;
  buf: Buffer;
}

interface SendSpec {
  port: number;
  method: string;
  target: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
  raw: { stream: NodeJS.ReadableStream; bytes: number; type: string } | null;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

/** One request: its status and bytes, or why there are none. */
function send(s: SendSpec): Promise<Sent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: HostCallError | null, value?: Sent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.signal?.removeEventListener('abort', onAbort);
      if (err) {
        // A raw body still being read goes with the request.
        const st = s.raw?.stream as { destroy?: () => void } | undefined;
        st?.destroy?.();
        reject(err);
      } else resolve(value as Sent);
    };
    const req = http.request({ host: '127.0.0.1', port: s.port, method: s.method, path: s.target, headers: s.headers }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > s.maxBytes) {
          req.destroy();
          finish(new HostCallError('too_large', 'The app answered with more than the Assistant reads.'));
          return;
        }
        parts.push(c);
      });
      res.on('error', () => finish(new HostCallError('unreachable', 'The app stopped answering.')));
      res.on('end', () => {
        const ra = Number(res.headers['retry-after']);
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        finish(null, { status: res.statusCode ?? 0, retryAfterS: Number.isFinite(ra) && ra >= 0 ? ra : null, type, buf: Buffer.concat(parts) });
      });
    });
    const onAbort = () => {
      req.destroy();
      finish(new HostCallError('aborted', 'Stopped.'));
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(new HostCallError('timeout', `The app didn't answer within ${Math.round(s.timeoutMs / 1000)} s.`));
    }, s.timeoutMs);
    timer.unref?.();
    // Before any destroy: a request destroyed with no error listener would throw.
    req.on('error', () => finish(new HostCallError('unreachable', "The app didn't answer.")));
    if (s.signal?.aborted) {
      onAbort();
      return;
    }
    s.signal?.addEventListener('abort', onAbort, { once: true });
    if (s.raw) {
      const stream = s.raw.stream;
      stream.on('error', () => {
        req.destroy();
        finish(new HostCallError('unreachable', 'The file could not be read.'));
      });
      stream.pipe(req);
    } else req.end(s.body ?? undefined);
  });
}

/**
 * The worker's numeric error codes (python/cfddesk/worker, its RpcError) as the app's own words:
 * a route that passes a worker refusal on answers `{code: <number>}` (routes.ts rpcStatus), and
 * the tools act on the word (spec 2.6).
 */
export const WORKER_CODES: Readonly<Record<number, string>> = Object.freeze({
  [-32004]: 'not_found',
  [-32602]: 'invalid_input',
  // A record changed since the caller read it (a plugin study's rev), and a record saved from an
  // older copy than the stored one (record_rev.py): both are a stale record.
  [-32009]: 'stale_record',
  [-32012]: 'stale_record',
  [-32010]: 'geometry_changed',
  [-32011]: 'geometry_updating',
});

/** The app's word for a refusal: its `code` (a word, or a worker number), else its `reason`; null when it gives none. */
function appCodeOf(obj: Record<string, unknown>): string | null {
  if (typeof obj.code === 'string' && obj.code) return cleanText(obj.code, 64);
  if (typeof obj.code === 'number' && Object.hasOwn(WORKER_CODES, obj.code)) return WORKER_CODES[obj.code];
  if (typeof obj.reason === 'string' && obj.reason) return cleanText(obj.reason, 64);
  return null;
}

/** A refusal's fields a tool may pass on: plain strings and numbers, paths scrubbed. */
function refusalDetail(body: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of ['kind', 'id', 'rev', 'key', 'reason']) {
    const v = body[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v) out[k] = cleanText(scrubPaths(v), 120);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * What an answer means: the JSON object of a 2xx, else the HostCallError. A binary route's 2xx
 * is its bytes, unless the app answered JSON (a thumbnail still being made: 202 {pending}),
 * which comes back as its object.
 */
function interpret(sent: Sent, path: string, binary: boolean): Record<string, unknown> | Buffer {
  const status = sent.status;
  if (binary && status >= 200 && status < 300 && !sent.type.startsWith('application/json')) return sent.buf;
  let body: unknown = null;
  try {
    body = JSON.parse(sent.buf.toString('utf8'));
  } catch {
    throw new HostCallError('bad_answer', 'The app answered with something that is not JSON.', status || null);
  }
  const isObject = !!body && typeof body === 'object' && !Array.isArray(body);
  if (status >= 200 && status < 300 && isObject) return body as Record<string, unknown>;
  const obj = isObject ? (body as Record<string, unknown>) : {};
  const raw = obj.error;
  const appCode = appCodeOf(obj);
  const said = cleanText(scrubPaths(cleanText(raw, 2000)), 300);
  // The link gate's own answer (after its one retry): it says why in its words, with no path.
  if (status === 503 && appCode === 'geometry_updating') throw new HostCallError('geometry_updating', said || 'The geometry is updating.', status, appCode);
  if (status >= 500) {
    alog('warn', 'a host tool call failed', { path, status, detail: redact(cleanText(raw, 300)) });
    throw new HostCallError('http', `The app had an error (HTTP ${status}).`, status);
  }
  if (status === 409 && appCode === 'geometry_changed') throw new HostCallError('geometry_changed', said || 'The geometry changed.', status, appCode);
  if (status === 409 && appCode === 'stale_record') throw new HostCallError('stale_record', said || 'This was changed elsewhere.', status, appCode, refusalDetail(obj));
  throw new HostCallError('http', said || `The app answered HTTP ${status}.`, status, appCode, refusalDetail(obj));
}

function queryString(query: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  return qs.size ? `?${qs.toString()}` : '';
}

/** `path` with each `:name` segment filled from args, or why it can't be. */
function fillPath(path: string, args: Args): string | HostCallError {
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i].startsWith(':')) continue;
    const v = args[parts[i].slice(1)];
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
    if (!PATH_SEGMENT.test(s) || s === '.' || s === '..') return new HostCallError('invalid_args', `Not a valid ${parts[i].slice(1)}.`);
    parts[i] = s;
  }
  return parts.join('/');
}

export interface HostTransport {
  get: HostGet;
  call: HostCall;
}

/** The loopback transport the host tools use: the starter GET and the routes call, sharing one rate per turn. */
export function createHostTransport(o: HostCallerOptions): HostTransport {
  const now = o.now ?? Date.now;
  const table = o.routes ?? HOST_ROUTES;
  if (o.routes) checkRouteTable(o.routes);
  const recent = new Map<string, number[]>();
  const writes = new Map<string, number[]>();

  const portNow = (): number | HostCallError => {
    const port = Number(o.port());
    return Number.isInteger(port) && port > 0 ? port : new HostCallError('not_ready', 'The app is still starting.');
  };

  /** Counts the call in its turn's window (and the write window): null, or why it must wait. */
  const admit = (turn: string | null, write: boolean): HostCallError | null => {
    const key = turn ?? '-';
    const t = now();
    const calls = (recent.get(key) ?? []).filter((at) => t - at < HOST_CALL_RATE.perMs);
    const wrote = write ? (writes.get(key) ?? []).filter((at) => t - at < HOST_WRITE_RATE.perMs) : [];
    if (calls.length >= HOST_CALL_RATE.calls || (write && wrote.length >= HOST_WRITE_RATE.calls)) {
      recent.set(key, calls);
      if (write) writes.set(key, wrote);
      return new HostCallError('rate_limited', 'Too many app requests at once; wait a moment and try again.');
    }
    calls.push(t);
    recent.set(key, calls);
    if (write) {
      wrote.push(t);
      writes.set(key, wrote);
    }
    for (const m of [recent, writes]) {
      if (m.size > 200) for (const [k, v] of m) if (!v.some((at) => t - at < HOST_CALL_RATE.perMs)) m.delete(k);
    }
    return null;
  };

  const get: HostGet = async (path, query, opts) => {
    if (!HOST_GET_ALLOWLIST.includes(path)) throw new HostCallError('not_allowed', `The Assistant may not read ${cleanText(path, 80)}.`);
    const port = portNow();
    if (port instanceof HostCallError) throw port;
    const refused = admit(opts.turn, false);
    if (refused) throw refused;
    const timeoutMs = opts.timeoutMs ?? HOST_CALL_TIMEOUT_MS;
    const sent = await send({
      port,
      method: 'GET',
      target: `${path}${queryString(query)}`,
      headers: { host: `127.0.0.1:${port}`, accept: 'application/json', [TURN_HEADER]: opts.turn ?? 'none' },
      body: null,
      raw: null,
      timeoutMs,
      maxBytes: HOST_ANSWER_MAX_BYTES,
      signal: opts.signal,
    });
    return interpret(sent, path, false) as Record<string, unknown>;
  };

  const call: HostCall = async (id, args, opts) => {
    const route = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!route) throw new HostCallError('not_allowed', `The Assistant has no app route "${cleanText(id, 80)}".`);
    const denied = deniedRoute(route);
    if (denied) throw new HostCallError('not_allowed', `The Assistant may not use that route (${denied}).`);
    const filled = fillPath(route.path, args);
    if (filled instanceof HostCallError) throw filled;
    const body = route.body ? route.body(args) : null;
    const whyBody = bodyDenied(route.path, body, route, opts.prompt);
    if (whyBody) throw new HostCallError('not_allowed', `The Assistant may not send that (${whyBody}).`);
    const port = portNow();
    if (port instanceof HostCallError) throw port;
    const refused = admit(opts.turn, route.band === 'write');
    if (refused) throw refused;
    const target = `${filled}${queryString(route.query ? route.query(args) : {})}`;
    const json = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const timeoutMs = opts.timeoutMs ?? route.timeoutMs ?? HOST_CALL_TIMEOUT_MS;
    const maxBytes = route.maxBytes ?? HOST_ANSWER_MAX_BYTES;
    const tool = typeof opts.tool === 'string' ? opts.tool.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120) : '';
    const attempt = () => {
      const raw = route.raw ? route.raw(args) : null;
      const headers: Record<string, string | number> = {
        host: `127.0.0.1:${port}`,
        accept: route.binary ? '*/*' : 'application/json',
        [TURN_HEADER]: opts.turn ?? 'none',
        ...(tool ? { [TOOL_HEADER]: tool } : {}),
      };
      if (json) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = json.length;
      } else if (raw) {
        headers['content-type'] = raw.type;
        headers['content-length'] = raw.bytes;
      }
      return send({ port, method: route.method, target, headers, body: json, raw, timeoutMs, maxBytes, signal: opts.signal });
    };
    let sent = await attempt();
    // The link gate held it: once more after its Retry-After, as the page's fetchLinkedSave does.
    if (sent.status === 503 && gateCode(sent) === 'geometry_updating') {
      const s = sent.retryAfterS ?? 2;
      const waitMs = Math.min(LINK_RETRY_MAX_MS, Math.max(0, o.retryDelayMs ? o.retryDelayMs(s) : s * 1000));
      await sleep(waitMs, opts.signal);
      sent = await attempt();
    }
    return interpret(sent, route.path, route.binary === true);
  };

  return { get, call };
}

function gateCode(sent: Sent): string | null {
  try {
    const b = JSON.parse(sent.buf.toString('utf8')) as { code?: unknown };
    return typeof b?.code === 'string' ? b.code : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HostCallError('aborted', 'Stopped.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HostCallError('aborted', 'Stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The loopback GET the starter tools use. */
export function createHostCaller(o: HostCallerOptions): HostGet {
  return createHostTransport(o).get;
}

/** The routes call the host tools use (C1): an entry id of HOST_ROUTES and its args. */
export function createHostRoutes(o: HostCallerOptions): HostCall {
  return createHostTransport(o).call;
}
