import type { IncomingMessage, ServerResponse } from 'node:http';
import { caseDirAllowedForAttach } from '../project-isolation.js';
import { scopeIsStrict } from '../request-scope.js';
import { HttpError, parseUrl, readJsonBody, sendJson } from './http.ts';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  pathname: string;
  scope: {
    projectId: string;
    simulationId: string;
    geometryId: string;
    caseDir: string;
  };
  sendJson: (status: number, body: unknown) => void;
  readJsonBody: () => Promise<Record<string, unknown>>;
}

export type RouteHandler = (ctx: RequestContext) => unknown | Promise<unknown>;

export interface Route {
  methods: HttpMethod[];
  path: string;
  handler: RouteHandler;
  name?: string;
  alias?: boolean;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export interface MethodNotAllowed {
  allow: HttpMethod[];
}

type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'wildcard'; name: string };

function tokenize(path: string): Segment[] {
  const raw = path.split('/').filter(Boolean);
  return raw.map((part) => {
    if (part.startsWith('**')) return { kind: 'wildcard', name: part.slice(2) || 'rest' };
    if (part.startsWith(':')) return { kind: 'param', name: part.slice(1) };
    return { kind: 'static', value: part };
  });
}

function matchSegments(
  segs: Segment[],
  parts: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  let i = 0;
  let j = 0;
  while (i < segs.length && j < parts.length) {
    const seg = segs[i];
    if (seg.kind === 'wildcard') {
      params[seg.name] = parts.slice(j).join('/');
      return params;
    }
    if (seg.kind === 'param') {
      try { params[seg.name] = decodeURIComponent(parts[j]); }
      catch { throw new HttpError(400, 'invalid URL encoding'); }
    } else if (seg.value !== parts[j]) {
      return null;
    }
    i += 1;
    j += 1;
  }
  if (i < segs.length) {
    const last = segs[i];
    if (last.kind === 'wildcard' && i === segs.length - 1) {
      params[last.name] = '';
      return params;
    }
    return null;
  }
  if (j !== parts.length) return null;
  return params;
}

function underscoreAlias(path: string): string | null {
  if (!path.includes('-')) return null;
  const aliased = path.replace(/-/g, '_');
  return aliased === path ? null : aliased;
}

export class Router {
  private readonly routes: Route[] = [];

  add(
    methods: HttpMethod | HttpMethod[],
    path: string,
    handler: RouteHandler,
    opts?: { name?: string; alias?: boolean; underscoreAlias?: boolean },
  ): this {
    const list = Array.isArray(methods) ? methods : [methods];
    this.routes.push({
      methods: list,
      path,
      handler,
      name: opts?.name,
      alias: opts?.alias,
    });
    if (opts?.underscoreAlias !== false) {
      const alt = underscoreAlias(path);
      if (alt) {
        this.routes.push({
          methods: list,
          path: alt,
          handler,
          name: opts?.name,
          alias: true,
        });
      }
    }
    return this;
  }

  get(path: string, handler: RouteHandler, opts?: { name?: string }): this {
    return this.add(['GET', 'HEAD'], path, handler, opts);
  }

  post(path: string, handler: RouteHandler, opts?: { name?: string }): this {
    return this.add('POST', path, handler, opts);
  }

  match(method: string, pathname: string): Match | MethodNotAllowed | null {
    const parts = pathname.split('/').filter(Boolean);
    const m = method.toUpperCase();
    const allow: HttpMethod[] = [];
    let pathHit = false;
    for (const route of this.routes) {
      const segs = tokenize(route.path);
      const params = matchSegments(segs, parts);
      if (!params) continue;
      pathHit = true;
      if (route.methods.includes(m as HttpMethod)) {
        return { route, params };
      }
      for (const meth of route.methods) {
        if (!allow.includes(meth)) allow.push(meth);
      }
    }
    if (pathHit) return { allow };
    return null;
  }

  list(): Array<{ methods: HttpMethod[]; path: string; name?: string; alias?: boolean }> {
    return this.routes.map((r) => ({
      methods: r.methods,
      path: r.path,
      name: r.name,
      alias: r.alias,
    }));
  }
}

const SCOPED_PREFIXES = [
  '/api/mesh',
  '/api/run',
  '/api/runs',
  '/api/bcs',
  '/api/materials',
  '/api/simulation',
  '/api/simulation-control',
  '/api/case',
  '/api/filter',
  '/api/result-controls',
  '/api/area-average',
  '/api/media',
  '/api/jobs',
];

let missingProjectWarned = false;

function bodyTexts(body: Record<string, unknown> | null, names: string[]): string[] {
  if (!body) return [];
  const bags: Record<string, unknown>[] = [body];
  const nested = body.params;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    bags.push(nested as Record<string, unknown>);
  }
  const found: string[] = [];
  for (const bag of bags) {
    for (const name of names) {
      const value = bag[name];
      if (value == null) continue;
      const text = String(value).trim();
      if (text && !found.includes(text)) found.push(text);
    }
  }
  return found;
}

function scopedField(
  url: URL,
  body: Record<string, unknown> | null,
  names: string[],
): { value: string; mismatch: boolean } {
  const fromBody = bodyTexts(body, names);
  if (fromBody.length > 1) return { value: '', mismatch: true };
  const fromQuery = queryValue(url, ...names);
  const bodyValue = fromBody[0] || '';
  if (fromQuery && bodyValue && fromQuery !== bodyValue) return { value: '', mismatch: true };
  return { value: fromQuery || bodyValue, mismatch: false };
}

function pathNeedsProject(pathname: string): boolean {
  return SCOPED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function queryValue(url: URL, ...names: string[]): string {
  for (const name of names) {
    const value = String(url.searchParams.get(name) || '').trim();
    if (value) return value;
  }
  return '';
}

// MAGNUSIM_HTTP_TRACE=1: every 10 s, list API requests still unanswered after 10 s.
const HTTP_TRACE = process.env.MAGNUSIM_HTTP_TRACE === '1';
const openRequests = new Map<ServerResponse, { at: number; what: string }>();
if (HTTP_TRACE) {
  setInterval(() => {
    const now = Date.now();
    for (const { at, what } of openRequests.values()) {
      if (now - at > 10_000) console.warn(`[http] still open after ${Math.round((now - at) / 1000)} s: ${what}`);
    }
  }, 10_000).unref();
}

export async function dispatch(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req.url);
  const method = String(req.method || 'GET').toUpperCase();
  const found = router.match(method, url.pathname);
  if (!found) return false;
  if (HTTP_TRACE && !url.pathname.endsWith('/events')) {
    openRequests.set(res, { at: Date.now(), what: `${method} ${url.pathname}?time=${url.searchParams.get('time') || ''}` });
    const done = () => openRequests.delete(res);
    res.on('finish', done);
    res.on('close', done);
  }
  if ('allow' in found) {
    res.setHeader('Allow', found.allow.join(', '));
    sendJson(res, 405, { error: 'method not allowed', path: url.pathname, allow: found.allow });
    return true;
  }
  let parsedBody: Record<string, unknown> | null = null;
  const contentType = String((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '');
  if (method !== 'GET' && method !== 'HEAD' && contentType.includes('application/json')) {
    try {
      parsedBody = await readJsonBody(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : 'invalid JSON body' });
      return true;
    }
  }
  const projectField = scopedField(url, parsedBody, ['project_id', 'projectId']);
  const simulationField = scopedField(url, parsedBody, ['simulation_id', 'simulationId']);
  const geometryField = scopedField(url, parsedBody, ['geometry_id', 'geometryId']);
  const caseField = scopedField(url, parsedBody, ['case_dir', 'caseDir']);
  if (projectField.mismatch || simulationField.mismatch || geometryField.mismatch || caseField.mismatch) {
    sendJson(res, 400, { error: 'scope fields disagree' });
    return true;
  }
  const projectId = projectField.value;
  const simulationId = simulationField.value;
  const geometryId = geometryField.value;
  const caseDir = caseField.value;
  if (pathNeedsProject(url.pathname) && !projectId) {
    if (scopeIsStrict()) {
      sendJson(res, 400, { error: 'project_id required' });
      return true;
    }
    if (!missingProjectWarned) {
      missingProjectWarned = true;
      console.warn(`[scope] ${url.pathname} has no project_id`);
    }
  }
  if (caseDir && projectId && !caseDirAllowedForAttach(caseDir, projectId, simulationId)) {
    sendJson(res, 403, { error: 'case_dir is outside this study' });
    return true;
  }
  if (caseDir && !projectId && scopeIsStrict()) {
    sendJson(res, 400, { error: 'project_id required' });
    return true;
  }
  const ctx: RequestContext = {
    req,
    res,
    url,
    method,
    params: found.params,
    pathname: url.pathname,
    scope: { projectId, simulationId, geometryId, caseDir },
    sendJson: (status, body) => sendJson(res, status, body),
    readJsonBody: () => readJsonBody(req),
  };
  try {
    const out = await found.route.handler(ctx);
    return out !== false;
  } catch (err) {
    const status =
      typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 0;
    const message = err instanceof Error ? err.message : 'request rejected';
    if (status === 400 || status === 403 || status === 404) {
      sendJson(res, status, { error: message });
      return true;
    }
    throw err;
  }
}
