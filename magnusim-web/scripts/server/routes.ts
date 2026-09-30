import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathIsWithin } from '../safe-path.js';
import { BUNDLED_UI, bundlePluginUi } from './plugin-ui-bundle.ts';
import { isLocalOperator, sendBytes, weakEtag } from './http.ts';
import { writeSse, type JobManager, type JobRecord } from './jobs.ts';
import { canonicalFilterKey, LEGACY_FILTER_PATHS } from './legacy-aliases.ts';
import type { RequestContext, Router } from './router.ts';
import { serveRegisteredFilter, startRegisteredJob } from './registered-tool.js';
import {
  startStudyMigrations,
  PluginEnvInstaller,
  PluginServiceError,
  PluginServiceHost,
  serviceScope,
  type EnvInstall,
  type PluginEnv,
} from './plugin-services.ts';
import { RpcError, WorkerUnavailableError, type WorkerClient } from './worker.ts';
import { pluginSdkFile, type SdkVariant } from './plugin-sdk.ts';
import { FRAME_ASSET_HEADERS, injectWorkspaceHead, SDK_TYPES, WORKSPACE_TYPES, workspaceCsp } from './workspace-files.ts';

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
  /** Plugin services (their own environments); made here when not given. */
  services?: PluginServiceHost;
  envInstaller?: PluginEnvInstaller;
  /** The workspace SDK build the frames get: dev (npm run dev) or prod (preview). */
  sdkVariant?: SdkVariant;
}

type ListedPluginRow = { key: string; ui?: string; dir?: string | null; tier?: string; status?: string };

/** What a page may see of a plugin environment (no local paths). */
function publicEnv(env: PluginEnv | null): Record<string, unknown> | null {
  if (!env) return null;
  return {
    state: env.state,
    error: env.error || '',
    tail: (env.tail || []).slice(-8),
    lock_hash: env.lock_hash || '',
    service: !!env.service,
    python_version: env.python_version || '',
  };
}

function publicInstall(run: EnvInstall | null): Record<string, unknown> | null {
  if (!run) return null;
  return {
    state: run.state,
    stage: run.stage,
    label: run.label,
    error: run.error || '',
    tail: (run.tail || []).slice(-8),
    log: run.log.slice(-12),
    started_at: run.started_at,
    finished_at: run.finished_at || null,
  };
}

const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function validPluginKey(key: string): boolean {
  return PLUGIN_KEY_RE.test(key) && !/[. ]$/.test(key);
}

function rpcStatus(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkerUnavailableError) {
    return { status: 503, body: { error: err.message, ok: false } };
  }
  if (err instanceof RpcError) {
    // -32009: the record changed since the caller read it (a plugin study's rev).
    const status = err.code === -32004 ? 404 : err.code === -32602 ? 400 : err.code === -32009 ? 409 : 500;
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

/** Plugin folders: webRoot/plugins, or MAGNUSIM_PLUGINS_DIR (the e2e tests point it at their fixture plugins). */
export function pluginsRootFor(webRoot: string): string {
  const override = String(process.env.MAGNUSIM_PLUGINS_DIR || '').trim();
  return override ? resolve(override) : resolve(webRoot, 'plugins');
}

/** Plugins that ship with the app: webRoot/bundled-plugins, or MAGNUSIM_BUNDLED_DIR (tests). */
export function bundledRootFor(webRoot: string): string {
  const override = String(process.env.MAGNUSIM_BUNDLED_DIR || '').trim();
  return override ? resolve(override) : resolve(webRoot, 'bundled-plugins');
}

/** The plugin's UI folder (the file route already checked it lies inside the plugin). */
export function pluginUiRoot(webRoot: string, key: string, uiRel: string, tier: string = 'user'): string {
  const pluginsRoot = tier === 'bundled' ? bundledRootFor(webRoot) : pluginsRootFor(webRoot);
  return resolve(pluginsRoot, key, uiRel || 'ui');
}

export function safePluginFile(
  webRoot: string,
  key: string,
  uiRel: string,
  rest: string,
  tier: string = 'user',
): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) || /[. ]$/.test(key)) return null;
  try {
    const pluginsRoot = tier === 'bundled' ? bundledRootFor(webRoot) : pluginsRootFor(webRoot);
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
  const services = deps.services || new PluginServiceHost(deps.worker);
  // A rebuilt environment replaces the running service (and its cached state).
  const envInstaller = deps.envInstaller || new PluginEnvInstaller((key) => services.reset(key, 'restarted on its new environment'));
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
    if (method === 'registry.reload' && !isLocalOperator(ctx.req)) {
      ctx.sendJson(403, { error: 'Plugin management is only available on this PC.', ok: false });
      return;
    }
    if (method === 'registry.reload') {
      services.resetAll('stopped for a plugin reload');
      listedCache = null;
    }
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
    type DescribedJob = {
      tool?: string;
      scope?: string;
      tool_path?: string;
      args_from_params?: string[];
      plugin?: string;
      // A plugin job on its plugin's own environment: its interpreter and folder.
      python?: string | null;
      cwd?: string | null;
      python_error?: string;
    };
    let spec: DescribedJob | null = null;
    try {
      const described = (await deps.worker.call('jobs.describe', { kind })) as { job?: DescribedJob };
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
    // A workspace starts only its own plugin's jobs (its bridge names the plugin).
    if (body.plugin != null && String(spec.plugin || 'builtin') !== String(body.plugin)) {
      ctx.sendJson(403, { error: `not allowed: ${kind} is not a job of ${String(body.plugin)}`, ok: false });
      return;
    }
    if (spec.python_error) {
      ctx.sendJson(409, { error: spec.python_error, ok: false });
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
    const starters: Record<string, (p: Record<string, unknown>, started: JobRecord) => void | Promise<void>> = {
      'generate_standard.py': (p, started) => deps.startMeshJob(p, started),
      'solve.sh': (p, started) => deps.startSolveJob(p, started),
      'convert_step_to_stl.py': (p, started) => deps.startCadImportJob(p, started),
    };
    // Only builtin job kinds reach the builtin starters; a plugin job named like a
    // core tool still runs its own script from its own folder.
    const builtin = String(spec.plugin || 'builtin') === 'builtin';
    const start = builtin ? starters[spec.tool] : undefined;
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

  const LOCAL_ONLY = 'Plugin management is only available on this PC.';
  router.get('/api/plugins', async (ctx) => workerJson(deps, ctx, 'plugins.list', {}));

  // Plugin studies: project-level records a plugin owns (plugins/<key>/studies).
  router.get('/api/plugin-studies', async (ctx) => {
    const projectId = ctx.url.searchParams.get('project_id') || '';
    try {
      const listed = (await deps.worker.call('plugin_studies.list', { project_id: projectId })) as {
        studies?: Parameters<typeof startStudyMigrations>[3];
        migrating?: boolean;
      };
      // Studies saved with an older schema: their plugin's service upgrades them
      // in the background; the list says so and the page reads it again.
      listed.migrating = startStudyMigrations(deps.worker, services, projectId, listed.studies);
      ctx.sendJson(200, listed);
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
    }
  });
  for (const action of ['create', 'rename', 'delete'] as const) {
    router.post(`/api/plugin-studies/${action}`, async (ctx) => {
      const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
      const pick = (k: string) => (body[k] == null ? undefined : body[k]);
      return workerJson(deps, ctx, `plugin_studies.${action}`, {
        project_id: String(pick('project_id') || ''),
        plugin: String(pick('plugin') || ''),
        ...(action === 'create' ? { kind: String(pick('kind') || ''), title: String(pick('title') || '') } : {}),
        ...(action !== 'create' ? { study_id: String(pick('study_id') || '') } : {}),
        ...(action === 'rename' ? { title: String(pick('title') || ''), rev: pick('rev') } : {}),
      });
    });
  }
  // A study's whole record, and saving its own fields (a workspace's bridge uses these).
  router.get('/api/plugin-studies/get', async (ctx) =>
    workerJson(deps, ctx, 'plugin_studies.get', {
      project_id: ctx.url.searchParams.get('project_id') || '',
      plugin: ctx.url.searchParams.get('plugin') || '',
      study_id: ctx.url.searchParams.get('study_id') || '',
    }),
  );
  router.post('/api/plugin-studies/update', async (ctx) => {
    const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
    return workerJson(deps, ctx, 'plugin_studies.update', {
      project_id: String(body.project_id || ''),
      plugin: String(body.plugin || ''),
      study_id: String(body.study_id || ''),
      rev: body.rev,
      patch: body.patch && typeof body.patch === 'object' ? body.patch : null,
    });
  });
  // A plugin's own JSON files in the project (plugins/<key>/...).
  for (const action of ['read', 'write'] as const) {
    router.post(`/api/plugin-data/${action}`, async (ctx) => {
      const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
      return workerJson(deps, ctx, `plugin_data.${action}`, {
        project_id: String(body.project_id || ''),
        plugin: String(body.plugin || ''),
        rel: String(body.rel || ''),
        ...(action === 'write' ? { doc: body.doc ?? null } : {}),
      });
    });
  }

  router.post('/api/plugins/:key/enable', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    services.reset(String(ctx.params.key || ''), 'restarted');
    listedCache = null;
    return workerJson(deps, ctx, 'plugins.enable', { key: ctx.params.key });
  });
  router.post('/api/plugins/:key/disable', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    services.reset(String(ctx.params.key || ''), 'stopped: the plugin was turned off');
    listedCache = null;
    return workerJson(deps, ctx, 'plugins.disable', { key: ctx.params.key });
  });

  // A plugin's own environment ([python]): its state, and building or removing it.
  router.get('/api/plugins/:key/env', async (ctx) => {
    const key = String(ctx.params.key || '');
    if (!validPluginKey(key)) return ctx.sendJson(400, { error: 'invalid plugin key', ok: false });
    try {
      services.forgetEnv(key);
      const { name, env } = await services.envOf(key);
      ctx.sendJson(200, { ok: true, key, name, env: publicEnv(env), install: publicInstall(envInstaller.get(key)) });
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
    }
  });
  router.post('/api/plugins/:key/env/install', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    const key = String(ctx.params.key || '');
    if (!validPluginKey(key)) return ctx.sendJson(400, { error: 'invalid plugin key', ok: false });
    try {
      const { name, env } = await services.envOf(key);
      if (!env) return ctx.sendJson(400, { error: `${name} has no environment to set up`, ok: false });
      services.reset(key, 'stopped while its environment is rebuilt');
      ctx.sendJson(202, { ok: true, key, install: publicInstall(envInstaller.start(key)) });
    } catch (err) {
      const { status, body } = rpcStatus(err);
      ctx.sendJson(status, body);
    }
  });
  router.post('/api/plugins/:key/env/remove', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    const key = String(ctx.params.key || '');
    if (!validPluginKey(key)) return ctx.sendJson(400, { error: 'invalid plugin key', ok: false });
    services.reset(key, 'stopped: its environment was removed');
    return workerJson(deps, ctx, 'plugins.env_remove', { key });
  });

  const pluginDispatch = async (ctx: RequestContext) => {
    const key = String(ctx.params.key || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) || /[. ]$/.test(key)) {
      ctx.sendJson(400, { error: 'invalid plugin key' });
      return;
    }
    const pluginsRoot = pluginsRootFor(deps.webRoot);
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
    // A plugin with its own environment answers from its service process.
    let service = null;
    try {
      service = await services.serviceFor(key);
    } catch (err) {
      if (err instanceof PluginServiceError) return ctx.sendJson(err.status, { error: err.message, ok: false });
      const { status, body } = rpcStatus(err);
      return ctx.sendJson(status, body);
    }
    if (service) {
      const scopePid = String(ctx.scope.projectId || '');
      const paramPid = String(params.project_id || params.projectId || '');
      if (scopePid && paramPid && scopePid !== paramPid) {
        return ctx.sendJson(400, { error: 'project_id does not match this request', ok: false });
      }
      try {
        const result = await service.call(rest, params, serviceScope(key, ctx.scope));
        const body = result && typeof result === 'object' && !Array.isArray(result) ? result : { ok: true, result };
        return ctx.sendJson(200, body);
      } catch (err) {
        const status = err instanceof PluginServiceError ? err.status : 500;
        return ctx.sendJson(status, { error: err instanceof Error ? err.message : String(err), ok: false });
      }
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

  // The plugin list, briefly cached: a workspace page loads many files at once.
  let listedCache: { at: number; rows: Promise<ListedPluginRow[]> } | null = null;
  const listedPlugins = (): Promise<ListedPluginRow[]> => {
    if (listedCache && Date.now() - listedCache.at < 2000) return listedCache.rows;
    const rows = deps.worker
      .call('plugins.list')
      .then((r) => ((r as { plugins?: ListedPluginRow[] }).plugins || []) as ListedPluginRow[]);
    listedCache = { at: Date.now(), rows };
    rows.catch(() => {
      listedCache = null;
    });
    return rows;
  };

  // The workspace SDK for plugin frames (React as ES modules, the bridge, the theme).
  router.get('/plugin-sdk/:file', async (ctx) => {
    const name = String(ctx.params.file || '');
    let text: string | null = null;
    try {
      text = await pluginSdkFile(deps.webRoot, deps.sdkVariant || 'dev', name);
    } catch (err) {
      ctx.sendJson(500, { error: `plugin SDK build failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (text == null) {
      ctx.sendJson(404, { error: 'no such SDK file' });
      return;
    }
    const ext = name.split('.').pop() || '';
    sendBytes(
      ctx.res,
      Buffer.from(text, 'utf8'),
      { ...FRAME_ASSET_HEADERS, 'Content-Type': SDK_TYPES[ext] || 'application/octet-stream' },
      ctx.method === 'HEAD',
    );
  });

  // A plugin's workspace files, for its sandboxed frame (only while the plugin is on).
  router.get('/plugins/:key/workspace/**rest', async (ctx) => {
    const key = String(ctx.params.key || '');
    if (!validPluginKey(key)) {
      ctx.sendJson(400, { error: 'invalid plugin key' });
      return;
    }
    let hit: ListedPluginRow | undefined;
    try {
      hit = (await listedPlugins()).find((p) => p.key === key);
    } catch {
      hit = undefined;
    }
    if (!hit || hit.status !== 'enabled') {
      ctx.sendJson(404, { error: 'this plugin is not on, or has no workspace' });
      return;
    }
    const file = safePluginFile(deps.webRoot, String(hit.dir || key), 'workspace', ctx.params.rest || 'index.html', hit.tier || 'user');
    if (!file) {
      ctx.sendJson(404, { error: 'workspace file not found' });
      return;
    }
    const ext = (file.split('.').pop() || '').toLowerCase();
    const headers: Record<string, string> = { ...FRAME_ASSET_HEADERS, 'Content-Type': WORKSPACE_TYPES[ext] || 'application/octet-stream' };
    let buf = readFileSync(file);
    if (ext === 'html') {
      buf = Buffer.from(injectWorkspaceHead(buf.toString('utf8')), 'utf8');
      headers['Content-Security-Policy'] = workspaceCsp(String(ctx.req.headers.host || ''), key);
    }
    sendBytes(ctx.res, buf, headers, ctx.method === 'HEAD');
  });

  router.get('/plugins/:key/ui/**rest', async (ctx) => {
    let ui = 'ui';
    // The manifest key may differ from the plugin's folder name; files live in the folder.
    let folder = String(ctx.params.key || '');
    let tier = 'user';
    try {
      const listed = (await deps.worker.call('plugins.list')) as {
        plugins?: Array<{ key: string; ui?: string; dir?: string | null; tier?: string }>;
      };
      const hit = (listed.plugins || []).find((p) => p.key === ctx.params.key);
      if (hit && hit.ui) ui = hit.ui;
      if (hit && hit.dir) folder = String(hit.dir);
      if (hit && hit.tier) tier = String(hit.tier);
    } catch {
      /* serve from default ui/ */
    }
    const file = safePluginFile(deps.webRoot, folder, ui, ctx.params.rest || 'index.js', tier);
    if (!file) {
      ctx.sendJson(404, { error: 'plugin ui not found' });
      return;
    }
    if (BUNDLED_UI.test(file)) {
      // TypeScript/TSX UI: one bundled ES module on the host's React.
      try {
        const code = await bundlePluginUi(file, pluginUiRoot(deps.webRoot, folder, ui, tier));
        sendBytes(ctx.res, Buffer.from(code, 'utf8'), { 'Content-Type': 'text/javascript; charset=utf-8' }, ctx.method === 'HEAD');
      } catch (err) {
        ctx.sendJson(500, { error: `plugin ui build failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    const buf = readFileSync(file);
    const ext = file.split('.').pop() || '';
    sendBytes(ctx.res, buf, { 'Content-Type': WORKSPACE_TYPES[ext] || 'application/octet-stream' }, ctx.method === 'HEAD');
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
