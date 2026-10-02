/**
 * Plugin OpenFOAM cases (host API 1.3): a workspace writes an OpenFOAM case in its
 * study's folder and submits it; the host queues it on the one compute slot and
 * runs it on the step-list runner (scripts/foam-runner.js). These routes are what
 * the workspace bridge calls. `plugin` and `study_id` come from the bridge's scope;
 * every route checks a record's project (by folder), plugin, study and projects
 * root, and another scope's case answers 404 not_found.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestContext, Router } from './router.ts';
import { RpcError, WorkerUnavailableError, type WorkerClient } from './worker.ts';
import { PluginFileError, caseKeyOf, type PluginFiles } from './plugin-files.ts';
import { enqueueFoamJob, queueAheadOf, queuedFoamCount, scheduleComputeQueueKick } from './compute-queue.ts';
import { writeSse } from './jobs.ts';
import { sameProjectFolder } from '../compute-slot.js';
import {
  FOAM_JOB_RE,
  createFoamRecord,
  foamEventBus,
  listFoamRecords,
  readFoamRecord,
  recentFoamPoints,
} from '../foam-store.js';
import { foamWslCaseId, newFoamToken, pluginEpoch, rowNameOf, stopFoamCase } from '../foam-runner.js';
import { pluginLoaded, solverForApplication } from '../registry-defaults.js';
import { wslCaseRoot } from '../wsl-env.js';
import { projectDir } from '../w17-sim-catalog.js';
import { LEGACY_FRAME_FIELDS, listFoamTimeDirs } from '../project-layout.js';

export interface PluginCaseDeps {
  worker: WorkerClient;
  files: PluginFiles;
}

/** At most this many queued cases per plugin per project. */
export const FOAM_QUEUE_CAP = 20;
const CHECK_TIMEOUT_MS = 30_000;
const HEARTBEAT_MS = 15_000;
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/;
// eslint-disable-next-line no-control-regex
const WSL_BAD_CHAR_RE = /[$`"\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const ROOT_BAD_CHAR_RE = /[$`"'\\\u0000-\u001f\u007f]/;
const ROOT_TEXT = 'The WSL case folder setting is not usable';

type Json = Record<string, unknown>;
type Scope = { projectId: string; plugin: string; studyId: string };
type Rec = Record<string, any>;

class CaseError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(ctx: RequestContext, status: number, code: string, error: string): void {
  ctx.sendJson(status, { ok: false, code, error });
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

async function bodyOf(ctx: RequestContext): Promise<Json> {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') return {};
  try {
    return ((await ctx.readJsonBody()) || {}) as Json;
  } catch {
    return {};
  }
}

/** A field from the JSON body, else the query. */
function pick(ctx: RequestContext, body: Json, name: string): unknown {
  return body[name] !== undefined && body[name] !== null ? body[name] : ctx.url.searchParams.get(name) ?? undefined;
}

function scopeOf(ctx: RequestContext, body: Json): Scope {
  const projectId = str(pick(ctx, body, 'project_id') || ctx.scope.projectId).trim();
  const plugin = str(pick(ctx, body, 'plugin')).trim();
  const studyId = str(pick(ctx, body, 'study_id')).trim();
  if (!projectId) throw new CaseError(400, 'bad_request', 'project_id required');
  if (!PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin)) throw new CaseError(400, 'bad_request', 'invalid plugin key');
  if (!STUDY_ID_RE.test(studyId)) throw new CaseError(400, 'bad_request', 'invalid study id');
  return { projectId, plugin, studyId };
}

/** A record of this scope (kind foam), or null. */
function inScope(rec: Rec | null, s: Scope): Rec | null {
  if (!rec || rec.kind !== 'foam') return null;
  if (rec.plugin !== s.plugin || rec.study_id !== s.studyId) return null;
  return sameProjectFolder(rec.project_id, s.projectId) ? rec : null;
}

/** What a frame sees of a case (no paths). */
export function computeJobOf(rec: Rec): Json {
  const active = rec.status === 'queued' || rec.status === 'running';
  const r = rec.result as Rec | null;
  return {
    id: rec.id,
    caseRel: rec.case_rel,
    app: rec.app,
    nProcs: Number(rec.n_procs_run || rec.n_procs) || 1,
    status: rec.status,
    stage: rec.stage || null,
    stopping: !!rec.stop && active,
    ahead: rec.status === 'queued' && rec.row_id ? queueAheadOf(rec.row_id) : null,
    createdAt: rec.created_at || null,
    startedAt: rec.started_at || null,
    finishedAt: rec.finished_at || null,
    error: rec.error ?? null,
    code: rec.code ?? null,
    result: r
      ? { savedTimes: r.saved_times || [], lastSaved: r.last_saved ?? null, phases: r.phases || {}, writeFormat: r.write_format ?? null }
      : null,
    seq: Number(rec.seq) || 0,
  };
}

function strings(v: unknown, max: number, each: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  if (!v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= each)) return null;
  return v as string[];
}

function fieldNamesOk(list: string[]): boolean {
  return list.every((f) => FIELD_RE.test(f) && !f.includes('__'));
}

type Shapes = {
  caseRel: string;
  app: string;
  nProcs: number;
  pre: Array<{ tool: string; args: string[]; parallel: boolean }>;
  results: { kinematicFields: string[]; rho?: number; frameFields?: string[] };
};

/** The body's shapes (§8.1 step 1): 400 bad_request when one is off. */
export function submitShapes(body: Json): Shapes {
  const bad = (why: string) => new CaseError(400, 'bad_request', why);
  const caseRel = body.case_rel;
  if (typeof caseRel !== 'string' || !caseRel || caseRel.length > 240) throw bad('case_rel must be a case folder name');
  const app = body.app;
  if (typeof app !== 'string' || !app || app.length > 64) throw bad('app must name a solver');
  let nProcs = 1;
  if (body.n_procs !== undefined && body.n_procs !== null) {
    const n = body.n_procs;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 64) throw bad('n_procs must be a whole number from 1 to 64');
    nProcs = n;
  }
  const pre: Shapes['pre'] = [];
  if (body.pre !== undefined && body.pre !== null) {
    if (!Array.isArray(body.pre) || body.pre.length > 16) throw bad('pre must be a list of at most 16 steps');
    for (const raw of body.pre) {
      const step = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : null;
      if (!step || typeof step.tool !== 'string' || !step.tool || step.tool.length > 32) throw bad('each step needs a tool');
      const args = step.args === undefined || step.args === null ? [] : strings(step.args, 4, 120);
      if (!args && !(Array.isArray(step.args) && step.args.length === 0)) throw bad('step args must be at most 4 texts of 120 characters');
      if (step.parallel !== undefined && step.parallel !== null && typeof step.parallel !== 'boolean') throw bad('step parallel must be true or false');
      pre.push({ tool: step.tool, args: args || [], parallel: step.parallel === true });
    }
  }
  const res = body.results && typeof body.results === 'object' && !Array.isArray(body.results) ? (body.results as Json) : null;
  if (!res) throw bad('results is required');
  const kinematic = Array.isArray(res.kinematicFields) && res.kinematicFields.length === 0 ? [] : strings(res.kinematicFields, 16, 64);
  if (!kinematic || !fieldNamesOk(kinematic)) throw bad('results.kinematicFields must list field names');
  const results: Shapes['results'] = { kinematicFields: kinematic };
  if (res.rho !== undefined && res.rho !== null) {
    if (typeof res.rho !== 'number' || !Number.isFinite(res.rho) || res.rho <= 0) throw bad('results.rho must be a number above 0');
    results.rho = res.rho;
  }
  if (res.frameFields !== undefined && res.frameFields !== null) {
    const ff = strings(res.frameFields, 16, 64);
    if (!ff || !ff.length || !fieldNamesOk(ff)) throw bad('results.frameFields must list field names');
    results.frameFields = ff;
  }
  return { caseRel, app, nProcs, pre, results };
}

/** The WSL case root rule (§7.6): null when usable. */
export function wslRootProblem(root: string): string | null {
  const r = String(root || '');
  if (!r.startsWith('/') || r.length > 200) return ROOT_TEXT;
  const parts = r.split('/').slice(1);
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) return ROOT_TEXT;
  if (PLACEHOLDER_RE.test(r) || ROOT_BAD_CHAR_RE.test(r)) return ROOT_TEXT;
  return null;
}

/** The case's Windows path through the WSL scripts' rules (§7.6): null when usable. */
export function casePathProblem(dir: string): string | null {
  const ph = PLACEHOLDER_RE.exec(dir);
  if (ph) return `The case path has a name the WSL scripts cannot take: ${ph[0]}`;
  const ch = WSL_BAD_CHAR_RE.exec(dir);
  if (ch) {
    const shown = ch[0].charCodeAt(0) < 0x20 || ch[0] === '\u007f' ? 'a control character' : ch[0];
    return `The projects folder path has a character the WSL scripts cannot take: ${shown}`;
  }
  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function versionTuple(v: unknown): number[] {
  return String(v || '0')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => Number(x));
}

function newerThan(a: unknown, b: unknown): boolean {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}

/** The queued or running case of this folder (the dedupe). */
function activeOfFolder(s: Scope, key: string): Rec | null {
  return (
    (listFoamRecords({ kind: 'foam', status: ['queued', 'running'] }) as Rec[]).find(
      (r) => r.plugin === s.plugin && r.case_key === key && sameProjectFolder(r.project_id, s.projectId),
    ) || null
  );
}

function checkCodeStatus(code: string): number {
  return code === 'not_found' ? 404 : 400;
}

function newRowId(): string {
  return `q-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

function controlDictApp(caseDir: string): string {
  try {
    const text = readFileSync(join(caseDir, 'system', 'controlDict'), 'utf8');
    const m = /^\s*application\s+([A-Za-z][A-Za-z0-9_]*)\s*;/m.exec(text);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function sidecarOf(caseDir: string): Rec {
  try {
    const doc = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

function sendCaseError(ctx: RequestContext, err: unknown): void {
  if (err instanceof CaseError || err instanceof PluginFileError) {
    fail(ctx, err.status, err.code, err.message);
    return;
  }
  console.warn('[CFD plugin cases]', err);
  fail(ctx, 500, 'error', 'The request failed');
}

export function registerPluginCaseRoutes(router: Router, deps: PluginCaseDeps): void {
  const { worker, files } = deps;

  router.post('/api/plugin-cases/submit', async (ctx) => {
    const body = await bodyOf(ctx);
    try {
      // 1. Shapes, and the WSL case root.
      const s = scopeOf(ctx, body);
      const shapes = submitShapes(body);
      let wslRoot = '';
      try {
        wslRoot = String(wslCaseRoot());
      } catch {
        wslRoot = '';
      }
      if (wslRootProblem(wslRoot)) throw new CaseError(400, 'invalid_path', ROOT_TEXT);
      // 2. The plugin is on; the project exists.
      const row = pluginLoaded(s.plugin) as Rec | null;
      if (!row) throw new CaseError(404, 'plugin_off', 'This plugin is not on');
      if (!isFile(join(String(projectDir(s.projectId)), 'project.json'))) throw new CaseError(404, 'project_not_found', 'No such project');
      const name = String(row.name || s.plugin);
      const epoch = pluginEpoch(s.plugin);
      const checkEpoch = () => {
        if (pluginEpoch(s.plugin) !== epoch) {
          throw new CaseError(404, 'plugin_off', `${name} was turned off or reloaded while the case was checked. Submit it again.`);
        }
      };
      // 3. The study.
      let study: Rec | null = null;
      try {
        const got = (await worker.call('plugin_studies.get', { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId }, CHECK_TIMEOUT_MS)) as Rec;
        study = got && got.study && typeof got.study === 'object' ? (got.study as Rec) : null;
      } catch (err) {
        if (err instanceof WorkerUnavailableError) throw new CaseError(503, 'unavailable', 'The app could not check the case right now');
        if (!(err instanceof RpcError)) throw err;
        study = null;
      }
      checkEpoch();
      if (!study) throw new CaseError(404, 'study_not_found', 'That study was removed');
      if (study.read_only === true || newerThan(study.plugin_version, row.version)) {
        throw new CaseError(409, 'read_only', `This study was saved by a newer version of ${name}`);
      }
      // 4. The case folder, by its real parts; the WSL scripts' path rules.
      const folder = await files.caseFolder(s.projectId, s.plugin, s.studyId, shapes.caseRel);
      checkEpoch();
      const pathWhy = casePathProblem(folder.dir);
      if (pathWhy) throw new CaseError(400, 'invalid_path', pathWhy);
      // 5. It exists.
      if (!isDir(folder.dir)) throw new CaseError(404, 'not_found', `${folder.rel} does not exist`);
      // 6. The same folder queued or running: that case.
      const key = caseKeyOf(folder.parts);
      const already = activeOfFolder(s, key);
      if (already) {
        ctx.sendJson(200, { ok: true, job: computeJobOf(already), ahead: already.row_id ? queueAheadOf(already.row_id) : null, existing: true });
        return;
      }
      // 7. The cap.
      if (queuedFoamCount(s.projectId, s.plugin) >= FOAM_QUEUE_CAP) {
        throw new CaseError(409, 'too_many', `${name} already has ${FOAM_QUEUE_CAP} cases queued in this project`);
      }
      // 8. Room in the plugin's folder.
      const used = await files.usage(s.projectId, s.plugin);
      checkEpoch();
      if (used.bytes >= used.maxTotal || used.entries >= used.maxEntries) {
        const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
        throw new CaseError(
          413,
          'quota',
          used.entries >= used.maxEntries
            ? `This plugin's files already take ${used.entries} of its ${used.maxEntries} files and folders in this project. Delete old cases first.`
            : `This plugin's files already take ${mb(used.bytes)} of its ${mb(used.maxTotal)} in this project. Delete old cases first.`,
        );
      }
      // 9. The case itself (plugin lane): what it is, what it runs, what comes back.
      let check: Rec | null = null;
      try {
        check = (await worker.call(
          'foam.check_case',
          { case_dir: folder.dir, app: shapes.app, pre: shapes.pre, results: shapes.results },
          CHECK_TIMEOUT_MS,
        )) as Rec;
      } catch {
        throw new CaseError(503, 'unavailable', 'The app could not check the case right now');
      }
      checkEpoch();
      if (!check || check.ok !== true) {
        const code = typeof check?.code === 'string' && /^[a-z_]{2,40}$/.test(check.code) ? check.code : 'bad_request';
        throw new CaseError(checkCodeStatus(code), code, typeof check?.error === 'string' ? check.error : 'The case was refused');
      }
      // 10. Synchronously again: the epoch, the dedupe, the cap; then store and queue.
      checkEpoch();
      const again = activeOfFolder(s, key);
      if (again) {
        ctx.sendJson(200, { ok: true, job: computeJobOf(again), ahead: again.row_id ? queueAheadOf(again.row_id) : null, existing: true });
        return;
      }
      if (queuedFoamCount(s.projectId, s.plugin) >= FOAM_QUEUE_CAP) {
        throw new CaseError(409, 'too_many', `${name} already has ${FOAM_QUEUE_CAP} cases queued in this project`);
      }
      const launch = (check.launch && typeof check.launch === 'object' ? check.launch : {}) as Rec;
      const token = newFoamToken(s.plugin, s.studyId);
      const rowId = newRowId();
      const results: Rec = {
        kinematic_fields: shapes.results.kinematicFields,
        frame_fields: Array.isArray(launch.frame_fields) && launch.frame_fields.length ? launch.frame_fields : shapes.results.frameFields || LEGACY_FRAME_FIELDS,
      };
      if (shapes.results.rho !== undefined) results.rho = shapes.results.rho;
      const rec = createFoamRecord({
        kind: 'foam',
        project_id: s.projectId,
        plugin: s.plugin,
        plugin_name: name,
        study_id: s.studyId,
        study_title: str(study.title) || s.studyId,
        case_rel: folder.rel,
        case_parts: folder.parts,
        case_key: key,
        case_dir: folder.dir,
        case_base: folder.base,
        token,
        wsl_case: foamWslCaseId(s.plugin, s.studyId, token),
        wsl_root: wslRoot,
        prepare: null,
        app: shapes.app,
        n_procs: shapes.nProcs,
        pre: shapes.pre,
        results,
        launch: { ...launch, write_format: check.write_format ?? null },
        row_id: rowId,
      }) as Rec;
      const queued = enqueueFoamJob({
        id: rowId,
        kind: 'foam',
        project_id: s.projectId,
        name: rowNameOf(rec),
        job_id: rec.id,
        foam: { plugin: s.plugin, study_id: s.studyId },
      });
      if (!queued.ok) throw new Error('the case could not be queued');
      scheduleComputeQueueKick(250);
      const now = (readFoamRecord(rec.id) as Rec) || rec;
      ctx.sendJson(202, { ok: true, job: computeJobOf(now), ahead: queueAheadOf(rowId), existing: false });
    } catch (err) {
      sendCaseError(ctx, err);
    }
  });

  router.get('/api/plugin-cases', async (ctx) => {
    try {
      const s = scopeOf(ctx, {});
      const jobs = (listFoamRecords({ kind: 'foam' }) as Rec[]).filter((r) => inScope(r, s)).slice(0, 50).map(computeJobOf);
      ctx.sendJson(200, { ok: true, jobs });
    } catch (err) {
      sendCaseError(ctx, err);
    }
  });

  router.get('/api/plugin-cases/status', async (ctx) => {
    try {
      const s = scopeOf(ctx, {});
      const id = str(ctx.url.searchParams.get('job_id'));
      const rec = FOAM_JOB_RE.test(id) ? inScope(readFoamRecord(id) as Rec | null, s) : null;
      if (!rec) throw new CaseError(404, 'not_found', 'No such case in this study');
      ctx.sendJson(200, { ok: true, job: computeJobOf(rec) });
    } catch (err) {
      sendCaseError(ctx, err);
    }
  });

  router.post('/api/plugin-cases/stop', async (ctx) => {
    const body = await bodyOf(ctx);
    try {
      const s = scopeOf(ctx, body);
      const id = str(pick(ctx, body, 'job_id'));
      const rec = FOAM_JOB_RE.test(id) ? inScope(readFoamRecord(id) as Rec | null, s) : null;
      if (!rec) throw new CaseError(404, 'not_found', 'No such case in this study');
      stopFoamCase(id, { force: body.force === true, by: 'user' });
      const now = (readFoamRecord(id) as Rec) || rec;
      ctx.sendJson(200, { ok: true, job: computeJobOf(now) });
    } catch (err) {
      sendCaseError(ctx, err);
    }
  });

  // One stream per open workspace: this study's cases only.
  router.get('/api/plugin-cases/events', (ctx) => {
    let s: Scope;
    try {
      s = scopeOf(ctx, {});
    } catch (err) {
      sendCaseError(ctx, err);
      return;
    }
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    const mine = (listFoamRecords({ kind: 'foam' }) as Rec[]).filter((r) => inScope(r, s)).slice(0, 50);
    const running = mine.find((r) => r.status === 'running');
    writeSse(res, 'snapshot', {
      jobs: mine.map(computeJobOf),
      live: running ? { job_id: running.id, points: recentFoamPoints(running.id, 400) } : null,
    });
    const bus = foamEventBus();
    const onEvent = (msg: Rec) => {
      if (!msg || msg.kind !== 'foam' || msg.plugin !== s.plugin || msg.study_id !== s.studyId) return;
      if (!sameProjectFolder(msg.project_id, s.projectId)) return;
      writeSse(res, 'case', { job_id: msg.job_id, seq: msg.seq, ev: msg.ev });
    };
    bus.on('event', onEvent);
    const beat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* closed */
      }
    }, HEARTBEAT_MS);
    beat.unref();
    const cleanup = () => {
      bus.off('event', onEvent);
      clearInterval(beat);
      res.off('close', cleanup);
    };
    res.on('close', cleanup);
  });

  // Results in 3D: where a case's results are, and what they are.
  router.get('/api/plugin-cases/resolve', async (ctx) => {
    try {
      const s = scopeOf(ctx, {});
      const folder = await files.caseFolder(s.projectId, s.plugin, s.studyId, str(ctx.url.searchParams.get('case_rel')));
      if (!isDir(folder.dir)) throw new CaseError(404, 'not_found', `${folder.rel} does not exist`);
      const key = caseKeyOf(folder.parts);
      const recs = (listFoamRecords({ kind: 'foam' }) as Rec[]).filter(
        (r) => r.plugin === s.plugin && r.case_key === key && sameProjectFolder(r.project_id, s.projectId),
      );
      if (recs.some((r) => r.status === 'queued' || r.status === 'running')) {
        throw new CaseError(409, 'running', 'This case is queued or running. Open its results when it has finished.');
      }
      const times = listFoamTimeDirs(folder.dir, { complete: true })
        .filter((t: string) => Number.isFinite(Number(t)) && Number(t) > 0)
        .sort((a: string, b: string) => Number(a) - Number(b));
      if (!times.length) throw new CaseError(404, 'no_results', 'This case has no saved results yet');
      const sidecar = sidecarOf(folder.dir);
      const app = typeof sidecar.app === 'string' && sidecar.app ? sidecar.app : controlDictApp(folder.dir);
      const latest = recs[0] as Rec | undefined;
      const solver = app ? (solverForApplication(app) as Rec | null) : null;
      const td = str((latest && latest.launch && latest.launch.time_dependency) || (solver && solver.time_dependency));
      const frameFields = Array.isArray(sidecar.frame_fields) && sidecar.frame_fields.length ? sidecar.frame_fields : LEGACY_FRAME_FIELDS;
      const hashed = 'pf-' + createHash('sha1').update(`${s.projectId}/${s.plugin}/${s.studyId}/${key}`).digest('hex').slice(0, 12);
      ctx.sendJson(200, {
        ok: true,
        key: hashed,
        case_dir: folder.dir,
        times,
        app: app || null,
        time_dependency: /transient/i.test(td) ? 'transient' : 'steady',
        frame_fields: frameFields,
      });
    } catch (err) {
      sendCaseError(ctx, err);
    }
  });
}
