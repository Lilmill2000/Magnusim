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
import { DEV_SHEET_FILES, devSheetFile, devSheetsOn, pluginSdkFile, type SdkVariant } from './plugin-sdk.ts';
import { CASE_BUSY, PluginFileError, PluginFiles, caseBusy, registerPluginFileRoutes } from './plugin-files.ts';
import { FRAME_ASSET_HEADERS, frameCsp, injectWorkspaceHead, SDK_TYPES, WORKSPACE_TYPES, workspaceCsp } from './workspace-files.ts';
import { registerPluginCaseRoutes } from './plugin-cases.ts';
import { registerLinkRoutes } from './link-routes.ts';
import { cancelStudyQuestions } from './link-job.js';
import { dropFoamJobs, relabelFoamJobs } from './compute-queue.ts';
import { activeCaseKeys, bumpPluginEpoch, stopFoamCasesFor, studyHasActiveCase } from '../foam-runner.js';
import { listFoamRecords, updateFoamRecord } from '../foam-store.js';
import { pluginLoaded } from '../registry-defaults.js';
import { sameProjectFolder } from '../compute-slot.js';
import { projectDir } from '../w17-sim-catalog.js';
import { checkRecordSave } from '../link-stamp.js';

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
  /** Makes the environment builder, given what to do when a build ends (tests pass one that runs nothing). */
  envInstaller?: (built: (key: string) => void) => PluginEnvInstaller;
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
    // A linked geometry's stamp check refused the save (host API 1.5): -32010 the tab's
    // labels are older than the geometry (409), -32011 the geometry is updating (503).
    if (err.code === -32010 || err.code === -32011) {
      const data = (err.data && typeof err.data === 'object' ? err.data : {}) as { code?: string };
      const code = data.code || (err.code === -32010 ? 'geometry_changed' : 'geometry_updating');
      return { status: err.code === -32010 ? 409 : 503, body: { error: err.message, code, ok: false } };
    }
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
    if (status === 503 && body.code === 'geometry_updating') ctx.res.setHeader('Retry-After', '2');
    ctx.sendJson(status, body);
    return true;
  }
}

/** workerJson's answer, returned before it is sent (the caller acts on an ok first). */
async function workerAnswer(
  deps: RouteDeps,
  method: string,
  params: unknown,
  timeoutMs?: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const result = await deps.worker.call(method, params, timeoutMs);
    const failed = !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
    return { ok: !failed, status: 200, body: result };
  } catch (err) {
    const { status, body } = rpcStatus(err);
    return { ok: false, status, body };
  }
}

/** The project's folder holds its project.json (an id that is not a safe folder name is no project). */
function projectExists(id: string): boolean {
  try {
    return statSync(resolve(String(projectDir(id)), 'project.json')).isFile();
  } catch {
    return false;
  }
}

/** A plugin's name for the host's notices: the live registry's, else a case record's, else its key. */
function pluginNameOf(key: string): string {
  const row = pluginLoaded(key) as { name?: string } | null;
  if (row && row.name) return String(row.name);
  const rec = (listFoamRecords({ kind: 'foam' }) as Array<{ plugin?: string; plugin_name?: string }>).find((r) => r.plugin === key && r.plugin_name);
  return rec && rec.plugin_name ? String(rec.plugin_name) : key;
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
  // The plugin list, briefly cached: a workspace page loads many files at once. The
  // UI, workspace and plugin file routes share it; it is dropped when plugins change.
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
  if (typeof deps.worker.on === 'function') {
    deps.worker.on('registry-changed', () => {
      listedCache = null;
    });
  }
  // A plugin's own files in a project; its open uploads stop whenever its service does.
  // A running OpenFOAM case's folder is busy for writes and deletes.
  const pluginFiles = new PluginFiles({ plugins: listedPlugins, activeCases: (pid, key) => activeCaseKeys(pid, key) });
  // A rebuilt environment replaces the running service (and its cached state).
  const envBuilt = (key: string) => {
    services.reset(key, 'restarted on its new environment');
    void pluginFiles.abortPlugin(key);
    listedCache = null;
  };
  const envInstaller = deps.envInstaller ? deps.envInstaller(envBuilt) : new PluginEnvInstaller(envBuilt);
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
      void pluginFiles.abortAll();
      listedCache = null;
    }
    // Only the Reload button stops plugin cases (Enable, Disable and an environment
    // install reload the registry too, and stop nothing here).
    if (method === 'registry.reload' && raw.stop_plugin_cases === true) {
      bumpPluginEpoch('*');
      const answer = await workerAnswer(deps, method, {});
      if (answer.ok) {
        bumpPluginEpoch('*');
        stopFoamCasesFor({}, 'reload', 'plugins were reloaded');
      }
      ctx.sendJson(answer.status, answer.body);
      return;
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
    // A linked geometry's stamp check (host API 1.5), before the worker writes anything:
    // each record the save writes carries the rev its labels were drawn at (Python
    // checks again; a page can never pass the checked rev itself).
    const listKey = method === 'bcs.set' ? 'boundary_conditions' : method === 'materials.set' ? 'materials' : '';
    if (listKey && params.body && typeof params.body === 'object') {
      const body = params.body as Record<string, unknown>;
      const rows = Array.isArray(body[listKey]) ? (body[listKey] as Array<Record<string, unknown>>) : [];
      const only = String(body.only_id || '');
      const recs = only ? rows.filter((r) => r && String(r.id || '') === only) : rows;
      const check = checkRecordSave(String(projectDir(project_id)), String(params.sim_id || ''), recs, undefined) as {
        ok: boolean;
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
      };
      if (!check.ok) {
        for (const [k, v] of Object.entries(check.headers || {})) ctx.res.setHeader(k, v);
        ctx.sendJson(Number(check.status) || 409, check.body);
        return;
      }
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
  router.post('/api/plugin-studies/create', async (ctx) => {
    const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
    const pick = (k: string) => (body[k] == null ? undefined : body[k]);
    return workerJson(deps, ctx, 'plugin_studies.create', {
      project_id: String(pick('project_id') || ''),
      plugin: String(pick('plugin') || ''),
      kind: String(pick('kind') || ''),
      title: String(pick('title') || ''),
    });
  });
  router.post('/api/plugin-studies/rename', async (ctx) => {
    const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
    const pick = (k: string) => (body[k] == null ? undefined : body[k]);
    const params = {
      project_id: String(pick('project_id') || ''),
      plugin: String(pick('plugin') || ''),
      study_id: String(pick('study_id') || ''),
      title: String(pick('title') || ''),
      rev: pick('rev'),
    };
    const answer = await workerAnswer(deps, 'plugin_studies.rename', params);
    if (answer.ok) {
      // Its queued cases and their records carry the study's new title.
      const study = (answer.body as { study?: { title?: string } } | null)?.study;
      const title = String((study && study.title) || params.title);
      relabelFoamJobs(params.project_id, params.plugin, params.study_id, title);
      for (const rec of listFoamRecords({ kind: 'foam' }) as Array<{ id: string; plugin?: string; study_id?: string; project_id?: string }>) {
        if (rec.plugin === params.plugin && rec.study_id === params.study_id && sameProjectFolder(rec.project_id, params.project_id)) {
          updateFoamRecord(rec.id, { study_title: title });
        }
      }
    }
    ctx.sendJson(answer.status, answer.body);
  });
  router.post('/api/plugin-studies/delete', async (ctx) => {
    const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
    const pick = (k: string) => (body[k] == null ? undefined : body[k]);
    const params = {
      project_id: String(pick('project_id') || ''),
      plugin: String(pick('plugin') || ''),
      study_id: String(pick('study_id') || ''),
    };
    // A study id is unique only in its project: nothing is checked or dropped without one.
    if (!params.project_id) return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id required' });
    if (!projectExists(params.project_id)) return ctx.sendJson(404, { ok: false, code: 'not_found', error: 'project not found' });
    // Synchronous: a running case refuses; queued cases are dropped at once.
    if (studyHasActiveCase(params.project_id, params.plugin, params.study_id)) {
      return ctx.sendJson(409, { ok: false, code: 'busy', error: 'A case of this study is running. Stop it before deleting the study.' });
    }
    if (params.plugin && params.study_id) {
      dropFoamJobs({ project_id: params.project_id, plugin: params.plugin, study_id: params.study_id }, 'The study was deleted');
      // A linked geometry's open question ends cancelled (API 1.5); its geometry stays.
      cancelStudyQuestions(params.project_id, params.plugin, params.study_id);
    }
    return workerJson(deps, ctx, 'plugin_studies.delete', params);
  });
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
  // A plugin's own JSON files in the project (plugins/<key>/...), only while it is on
  // (its binary files answer the same): a page left open after Disable cannot write.
  for (const action of ['read', 'write'] as const) {
    router.post(`/api/plugin-data/${action}`, async (ctx) => {
      const body = ((await ctx.readJsonBody().catch(() => ({}))) || {}) as Record<string, unknown>;
      const plugin = String(body.plugin || '');
      let row: ListedPluginRow | undefined;
      try {
        row = (await listedPlugins()).find((p) => p.key === plugin);
      } catch {
        return ctx.sendJson(503, { ok: false, code: 'unavailable', error: 'the plugin list is not available right now' });
      }
      if (!row || row.status !== 'enabled') return ctx.sendJson(404, { ok: false, code: 'plugin_off', error: 'this plugin is not on' });
      if (action === 'write') {
        // It goes straight to Python: a running case's folder is checked here, by the names on disk.
        const keys = activeCaseKeys(String(body.project_id || ''), plugin) as string[];
        if (keys.length) {
          try {
            const parts = await pluginFiles.realParts(String(body.project_id || ''), plugin, String(body.rel || ''), 'write');
            if (caseBusy(parts, keys, 'write')) return ctx.sendJson(409, { ok: false, code: 'busy', error: CASE_BUSY });
          } catch (err) {
            if (err instanceof PluginFileError) return ctx.sendJson(err.status, { ok: false, code: err.code, error: err.message });
            throw err;
          }
        }
      }
      return workerJson(deps, ctx, `plugin_data.${action}`, {
        project_id: String(body.project_id || ''),
        plugin,
        rel: String(body.rel || ''),
        ...(action === 'write' ? { doc: body.doc ?? null } : {}),
      });
    });
  }
  // Its binary files in the same folder (/api/plugin-files/*): streamed here, never through the worker.
  registerPluginFileRoutes(router, pluginFiles);
  // Its OpenFOAM cases on the compute slot (/api/plugin-cases/*).
  registerPluginCaseRoutes(router, { worker: deps.worker, files: pluginFiles });
  // A plugin study's linked geometry (/api/plugin-geometry/*, API 1.5).
  registerLinkRoutes(router, { worker: deps.worker, files: pluginFiles });

  router.post('/api/plugins/:key/enable', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    if (!validPluginKey(String(ctx.params.key || ''))) return ctx.sendJson(400, { error: 'invalid plugin key', ok: false });
    services.reset(String(ctx.params.key || ''), 'restarted');
    void pluginFiles.abortPlugin(String(ctx.params.key || ''));
    listedCache = null;
    return workerJson(deps, ctx, 'plugins.enable', { key: ctx.params.key });
  });
  router.post('/api/plugins/:key/disable', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { error: LOCAL_ONLY, ok: false });
    if (!validPluginKey(String(ctx.params.key || ''))) return ctx.sendJson(400, { error: 'invalid plugin key', ok: false });
    const key = String(ctx.params.key || '');
    const name = pluginNameOf(key);
    services.reset(key, 'stopped: the plugin was turned off');
    void pluginFiles.abortPlugin(key);
    listedCache = null;
    // Before and after the worker: a submit that read the epoch in between still fails its next check.
    bumpPluginEpoch(key);
    const answer = await workerAnswer(deps, 'plugins.disable', { key: ctx.params.key });
    if (answer.ok) {
      bumpPluginEpoch(key);
      stopFoamCasesFor({ plugin: key }, 'plugin_off', `${name} was turned off`);
    }
    ctx.sendJson(answer.status, answer.body);
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
      void pluginFiles.abortPlugin(key);
      listedCache = null;
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
    const name = pluginNameOf(key);
    services.reset(key, 'stopped: its environment was removed');
    void pluginFiles.abortPlugin(key);
    listedCache = null;
    bumpPluginEpoch(key);
    const answer = await workerAnswer(deps, 'plugins.env_remove', { key });
    if (answer.ok) {
      bumpPluginEpoch(key);
      stopFoamCasesFor({ plugin: key }, 'env_removed', `${name}'s environment was removed`);
    }
    ctx.sendJson(answer.status, answer.body);
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

  // The workspace SDK for plugin frames (React as ES modules, the bridge, the theme).
  router.get('/plugin-sdk/:file', async (ctx) => {
    const name = String(ctx.params.file || '');
    let text: string | null = null;
    if (DEV_SHEET_FILES.includes(name)) {
      // The UI kit dev sheet's frame: a dev server started with VITE_MAGNUSIM_DEV_SHEETS=1 only.
      const variant = deps.sdkVariant || 'dev';
      if (!devSheetsOn(variant)) {
        ctx.sendJson(404, { error: 'no such SDK file' });
        return;
      }
      try {
        text = await devSheetFile(deps.webRoot, name);
      } catch (err) {
        ctx.sendJson(500, { error: `dev sheet build failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (text == null) {
        ctx.sendJson(404, { error: 'no such SDK file' });
        return;
      }
      const html = name.endsWith('.html');
      const headers: Record<string, string> = { ...FRAME_ASSET_HEADERS, 'Content-Type': SDK_TYPES[html ? 'html' : 'js'] };
      if (html) {
        text = injectWorkspaceHead(text);
        headers['Content-Security-Policy'] = frameCsp(String(ctx.req.headers.host || ''), '/plugin-sdk/');
      }
      sendBytes(ctx.res, Buffer.from(text, 'utf8'), headers, ctx.method === 'HEAD');
      return;
    }
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
    let hit: ListedPluginRow | undefined;
    try {
      hit = (await listedPlugins()).find((p) => p.key === ctx.params.key);
    } catch {
      hit = undefined;
    }
    // Only a plugin that is on gets its UI served or built (the page loads no other):
    // one that is off (an optional bundled one that ships off among them), needs setup
    // or failed to load is never run, and nothing is served for a key the app does not list.
    if (!hit || hit.status !== 'enabled') {
      ctx.sendJson(404, { error: hit && hit.status === 'disabled' ? 'this plugin is off' : 'plugin ui not found' });
      return;
    }
    if (hit.ui) ui = hit.ui;
    if (hit.dir) folder = String(hit.dir);
    if (hit.tier) tier = String(hit.tier);
    const file = safePluginFile(deps.webRoot, folder, ui, ctx.params.rest || 'index.js', tier);
    if (!file) {
      ctx.sendJson(404, { error: 'plugin ui not found' });
      return;
    }
    if (BUNDLED_UI.test(file)) {
      // TypeScript/TSX UI: one bundled ES module on the host's React.
      try {
        const code = await bundlePluginUi(file, pluginUiRoot(deps.webRoot, folder, ui, tier), { webRoot: deps.webRoot });
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
