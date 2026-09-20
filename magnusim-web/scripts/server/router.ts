import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, parseUrl, readJsonBody, sendJson } from './http.ts';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  params: Record<string, string>;
  pathname: string;
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

export async function dispatch(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req.url);
  const method = String(req.method || 'GET').toUpperCase();
  const found = router.match(method, url.pathname);
  if (!found) return false;
  if ('allow' in found) {
    res.setHeader('Allow', found.allow.join(', '));
    sendJson(res, 405, { error: 'method not allowed', path: url.pathname, allow: found.allow });
    return true;
  }
  const ctx: RequestContext = {
    req,
    res,
    url,
    method,
    params: found.params,
    pathname: url.pathname,
    sendJson: (status, body) => sendJson(res, status, body),
    readJsonBody: () => readJsonBody(req),
  };
  const out = await found.route.handler(ctx);
  return out !== false;
}
