import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathIsWithin } from '../safe-path.js';
import { sendBytes, weakEtag } from './http.ts';
import { writeSse, type JobManager, type JobRecord } from './jobs.ts';
import { canonicalFilterKey, LEGACY_FILTER_PATHS } from './legacy-aliases.ts';
import type { RequestContext, Router } from './router.ts';
import { serveRegisteredFilter, startRegisteredJob } from './registered-tool.js';
import { RpcError, WorkerUnavailableError, type WorkerClient } from './worker.ts';

export interface RouteDeps {
  worker: WorkerClient;
  jobs: JobManager;
  webRoot: string;
  cacheDir: string;
  serveLegacyFilter: (ctx: RequestContext, key: string) => Promise<unknown>;
  startMeshJob: (params: Record<string, unknown>, job: JobRecord) => void;
  startSolveJob: (params: Record<string, unknown>, job: JobRecord) => void;
  startCadImportJob: (params: Record<string, unknown>, job: JobRecord) => void;
  caseSnapshot: () => Record<string, unknown>;
  attachCaseDir: (caseDir: string, projectId?: string) => { ok: boolean; status: number; body: unknown };
  resetCaseIdle: (note?: string) => void;
}

function rpcStatus(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkerUnavailableError) {
    return { status: 503, body: { error: err.message, ok: false } };
  }
  if (err instanceof RpcError) {
    const status = err.code === -32004 ? 404 : err.code === -32602 ? 400 : 500;
    return { status, body: { error: err.message, code: err.code, ok: false } };
  }
  return { status: 500, body: { error: String(err instanceof Error ? err.message : err), ok: false } };
}

async function workerJson(
  deps: RouteDeps,
  ctx: RequestContext,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<boolean> {
  try {
    const result = await deps.worker.call(method, params, timeoutMs);
    ctx.sendJson(200, result);
    return true;
  } catch (err) {
    const { status, body } = rpcStatus(err);
    ctx.sendJson(status, body);
    return true;
  }
}

export function safePluginFile(webRoot: string, key: string, uiRel: string, rest: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) || /[. ]$/.test(key)) return null;
  try {
    const pluginsRoot = resolve(webRoot, 'plugins');
    const pluginRoot = resolve(pluginsRoot, key);
    const uiRoot = resolve(pluginRoot, uiRel || 'ui');
    const target = resolve(uiRoot, rest || 'index.js');
    if (!pathIsWithin(pluginRoot, pluginsRoot) || !pathIsWithin(uiRoot, pluginRoot) || !pathIsWithin(target, uiRoot)) return null;
    return existsSync(target) && statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

export function registerPhase3Routes(router: Router, deps: RouteDeps): void {
  router.get('/api/_routes', (ctx) => {
    ctx.sendJson(200, {
      ok: true,
      routes: router.list(),
    });
  });

  router.get('/api/registry', async (ctx) => {
    try {
      const result = await deps.worker.call('registry.describe');
      const payload = JSON.stringify(result);
      const etag = weakEtag(payload);
      ctx.res.setHeader('ETag', etag);
      const inm = ctx.req.headers['if-none-match'];
      if (inm && inm === etag) {
        ctx.res.statusCode = 304;
        ctx.res.end();
        return;
      }
      ctx.sendJson(200, result);
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
    }
  });

  router.get('/api/registry/:kind/:key', async (ctx) => {
    return workerJson(deps, ctx, 'registry.describe_key', {
      kind: ctx.params.kind,
      key: ctx.params.key,
    });
  });

  router.get('/api/registry/:kind', async (ctx) => {
    return workerJson(deps, ctx, 'registry.describe_kind', { kind: ctx.params.kind });
  });

  const filterHandler = async (ctx: RequestContext, keyRaw?: string) => {
    const key = canonicalFilterKey(keyRaw || ctx.params.key || '');
    const params: Record<string, unknown> = {};
    ctx.url.searchParams.forEach((v, k) => {
      params[k] = v;
    });
    let validated: { plugin?: string; key?: string } = {};
    try {
      validated = (await deps.worker.call('filter.validate', { key, params })) as { plugin?: string };
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
      return;
    }
    const plugin = String(validated.plugin || 'builtin');
    if (plugin !== 'builtin') {
      serveRegisteredFilter(deps, ctx, { ...validated, key: String(validated.key || key) });
      return;
    }
    return deps.serveLegacyFilter(ctx, key);
  };

  router.get('/api/filter/:key/meta', (ctx) => filterHandler(ctx, ctx.params.key));
  router.get('/api/filter/:key', (ctx) => filterHandler(ctx, ctx.params.key));

  for (const alias of LEGACY_FILTER_PATHS) {
    router.get(alias.path, (ctx) => filterHandler(ctx, alias.key), { name: `alias:${alias.key}` });
  }

  router.get('/api/fields/:field/meta', (ctx) => {
    ctx.url.searchParams.set('field', ctx.params.field);
    return filterHandler(ctx, 'fields');
  });
  router.get('/api/fields/:field', (ctx) => {
    ctx.url.searchParams.set('field', ctx.params.field);
    return filterHandler(ctx, 'fields');
  });

  const setupRpc = new Set([
    'materials.set',
    'bcs.set',
    'sim.set',
    'sim.catalog.set',
    'sim.get',
    'mesh.set',
    'bc.menu',
    'registry.reload',
  ]);

  router.post('/api/worker', async (ctx) => {
    let body: Record<string, unknown> = {};
    try {
      body = await ctx.readJsonBody();
    } catch {
      ctx.sendJson(400, { error: 'invalid JSON body', ok: false });
      return;
    }
    const method = String(body.method || '');
    if (!setupRpc.has(method)) {
      ctx.sendJson(400, { error: 'method not allowed', ok: false });
      return;
    }
    const raw = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>;
    if (method === 'bc.menu' || method === 'registry.reload') {
      return workerJson(deps, ctx, method, {});
    }
    const project_id = String(raw.project_id || raw.id || ctx.scope.projectId || '');
    if (!project_id) {
      ctx.sendJson(400, { error: 'project_id required', ok: false });
      return;
    }
    const params: Record<string, unknown> = { project_id };
    if (method !== 'sim.get') {
      params.sim_id = String(raw.sim_id || raw.simulation_id || ctx.scope.simulationId || '');
      if (raw.body && typeof raw.body === 'object') params.body = raw.body;
    }
    return workerJson(deps, ctx, method, params);
  });

  router.post('/api/jobs', async (ctx) => {
    let body: Record<string, unknown> = {};
    try {
      body = await ctx.readJsonBody();
    } catch (e) {
      ctx.sendJson(400, { error: 'invalid JSON body', detail: String(e) });
      return;
    }
    const kind = String(body.kind || '');
    const params = (body.params && typeof body.params === 'object' ? body.params : body) as Record<
      string,
      unknown
    >;
    if (!params.project_id && ctx.scope.projectId) params.project_id = ctx.scope.projectId;
    if (!params.simulation_id && ctx.scope.simulationId) params.simulation_id = ctx.scope.simulationId;
    if (!params.geometry_id && ctx.scope.geometryId) params.geometry_id = ctx.scope.geometryId;
    let spec: { tool?: string; scope?: string; tool_path?: string; args_from_params?: string[] } | null =
      null;
    try {
      const described = (await deps.worker.call('jobs.describe', { kind })) as {
        job?: { tool?: string; scope?: string; tool_path?: string; args_from_params?: string[] };
      };
      spec = described.job || null;
    } catch (err) {
      const { status, body: errBody } = rpcStatus(err);
      const unknown = /unknown job/i.test(String(errBody.error || ''));
      ctx.sendJson(unknown ? 400 : status, errBody);
      return;
    }
    if (!spec || !spec.tool) {
      ctx.sendJson(400, { error: 'unknown job kind' });
      return;
    }
    const project = String(params.project_id || params.projectId || body.project || '');
    let job;
    try {
      job = deps.jobs.create(kind, params, project || undefined, { scope: spec.scope });
    } catch (e) {
      ctx.sendJson(400, { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const starters: Record<string, (p: Record<string, unknown>, started: JobRecord) => void> = {
      'generate_standard.py': (p, started) => deps.startMeshJob(p, started),
      'solve.sh': (p, started) => deps.startSolveJob(p, started),
      'convert_step_to_stl.py': (p, started) => deps.startCadImportJob(p, started),
    };
    const start = starters[spec.tool];
    if (start) start(params, job);
    else startRegisteredJob(deps.jobs, spec, params, job);
    ctx.sendJson(202, { ok: true, job });
  });

  router.get('/api/jobs', (ctx) => {
    const kind = ctx.url.searchParams.get('kind') || undefined;
    const project = ctx.scope.projectId || ctx.url.searchParams.get('project') || '';
    if (!project) {
      ctx.sendJson(400, { error: 'project_id required' });
      return;
    }
    ctx.sendJson(200, { ok: true, jobs: deps.jobs.list({ kind, project }) });
  });

  router.get('/api/jobs/:id/events', (ctx) => {
    const project = ctx.scope.projectId;
    const job = deps.jobs.get(ctx.params.id);
    if (!project) {
      ctx.sendJson(400, { error: 'project_id required' });
      return;
    }
    if (!job) {
      ctx.sendJson(404, { error: 'job not found' });
      return;
    }
    if (job.project !== project) {
      ctx.sendJson(403, { error: 'job belongs to another project' });
      return;
    }
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader('Connection', 'keep-alive');
    writeSse(ctx.res, 'snapshot', job);
    for (const ev of job.events) writeSse(ctx.res, 'event', ev);
    if (['done', 'failed', 'stopped'].includes(job.status)) {
      writeSse(ctx.res, 'end', job);
      ctx.res.end();
      return;
    }
    const bus = deps.jobs.onEvents(job.id);
    const onEv = (ev: object) => writeSse(ctx.res, 'event', ev);
    const onEnd = (rec: JobRecord) => {
      writeSse(ctx.res, 'end', rec);
      cleanup();
      ctx.res.end();
    };
    const cleanup = () => {
      bus.off('event', onEv);
      bus.off('end', onEnd);
      ctx.res.off('close', cleanup);
    };
    bus.on('event', onEv);
    bus.on('end', onEnd);
    ctx.res.on('close', cleanup);
  });

  router.get('/api/jobs/:id', (ctx) => {
    const project = ctx.scope.projectId;
    const job = deps.jobs.get(ctx.params.id);
    if (!project) {
      ctx.sendJson(400, { error: 'project_id required' });
      return;
    }
    if (!job) {
      ctx.sendJson(404, { error: 'job not found' });
      return;
    }
    if (job.project !== project) {
      ctx.sendJson(403, { error: 'job belongs to another project' });
      return;
    }
    ctx.sendJson(200, { ok: true, job });
  });

  router.post('/api/jobs/:id/stop', (ctx) => {
    const project = ctx.scope.projectId;
    if (!project) {
      ctx.sendJson(400, { error: 'project_id required' });
      return;
    }
    const existing = deps.jobs.get(ctx.params.id);
    const job = deps.jobs.stop(ctx.params.id, project);
    if (!job) {
      if (existing && existing.project !== project) {
        ctx.sendJson(403, { error: 'job belongs to another project' });
        return;
      }
      ctx.sendJson(404, { error: 'job not found' });
      return;
    }
    ctx.sendJson(200, { ok: true, job });
  });

  router.get('/api/plugins', async (ctx) => workerJson(deps, ctx, 'plugins.list', {}));
  router.post('/api/plugins/:key/enable', async (ctx) =>
    workerJson(deps, ctx, 'plugins.enable', { key: ctx.params.key }),
  );
  router.post('/api/plugins/:key/disable', async (ctx) =>
    workerJson(deps, ctx, 'plugins.disable', { key: ctx.params.key }),
  );

  const pluginDispatch = async (ctx: RequestContext) => {
    const key = String(ctx.params.key || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) || /[. ]$/.test(key)) {
      ctx.sendJson(400, { error: 'invalid plugin key' });
      return;
    }
    const pluginsRoot = resolve(deps.webRoot, 'plugins');
    const pluginRoot = resolve(pluginsRoot, key);
    if (!pathIsWithin(pluginRoot, pluginsRoot)) {
      ctx.sendJson(400, { error: 'plugin path escapes plugins root' });
      return;
    }
    const rest = String(ctx.params.rest || '').replace(/^\/+/, '');
    if (!rest || rest.split('/').includes('..') || rest.includes('\\')) {
      ctx.sendJson(400, { error: 'invalid plugin method' });
      return;
    }
    const params: Record<string, unknown> =
      ctx.method === 'GET' ? {} : ((await ctx.readJsonBody().catch(() => ({}))) as Record<string, unknown>);
    if (ctx.method === 'GET') {
      ctx.url.searchParams.forEach((value, name) => {
        params[name] = value;
      });
    }
    try {
      const result = await deps.worker.call('plugin.dispatch', {
        key,
        method: rest,
        params,
        scope: {
          project_id: ctx.scope.projectId,
          simulation_id: ctx.scope.simulationId,
          geometry_id: ctx.scope.geometryId,
          case_dir: ctx.scope.caseDir,
        },
      });
      ctx.sendJson(200, result);
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
    }
  };
  router.get('/api/plugin/:key/**rest', pluginDispatch);
  router.post('/api/plugin/:key/**rest', pluginDispatch);

  router.get('/plugins/:key/ui/**rest', async (ctx) => {
    let ui = 'ui';
    try {
      const listed = (await deps.worker.call('plugins.list')) as { plugins?: Array<{ key: string; ui?: string }> };
      const hit = (listed.plugins || []).find((p) => p.key === ctx.params.key);
      if (hit && hit.ui) ui = hit.ui;
    } catch {
      /* serve from default ui/ */
    }
    const file = safePluginFile(deps.webRoot, ctx.params.key, ui, ctx.params.rest || 'index.js');
    if (!file) {
      ctx.sendJson(404, { error: 'plugin ui not found' });
      return;
    }
    const buf = readFileSync(file);
    const ext = file.split('.').pop() || '';
    const types: Record<string, string> = {
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      html: 'text/html; charset=utf-8',
      svg: 'image/svg+xml',
    };
    sendBytes(ctx.res, buf, { 'Content-Type': types[ext] || 'application/octet-stream' }, ctx.method === 'HEAD');
  });
}

export function persistJobToWorker(worker: WorkerClient, job: JobRecord): void {
  if (job.status !== 'done' || !job.result || !job.project) return;
  const result = job.result as Record<string, unknown>;
  if (job.kind === 'mesh') {
    worker.call('mesh.result.persist', { id: job.project, body: result }).catch(() => undefined);
  }
  if (job.kind === 'solve' && result.id) {
    worker
      .call('runs.upsert', { id: job.project, body: result, stamp_project: true })
      .catch(() => undefined);
  }
}
