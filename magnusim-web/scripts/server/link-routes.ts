/**
 * Linked geometries (host API 1.5): the routes a workspace's bridge calls.
 *
 *   POST /api/plugin-geometry/link    {project_id, plugin, study_id, shape: {rel, format,
 *                                      sha256 | etag}, face_names: {rel, sha256 | etag} | null,
 *                                      source_version, based_on_rev, name}
 *       200 {ok, result} (nothing changed) | 202 {ok, job_id, geometry_id, created, queued}
 *       | 202 {ok, job_id, geometry_id, choosing: {...}} (the host asks, proposal 5.0)
 *       | an error {ok: false, code, error} (proposal 5.3)
 *   POST /api/plugin-geometry/choose  {project_id, plugin, study_id, job_id, choice: 'new' |
 *                                      'overwrite' | 'cancel', copy: [study ids]}: the user's
 *       answer to the host's question. Host-only: no bridge call reaches it, so a page
 *       never chooses. 202 {ok, job_id, geometry_id, created, queued} | 200 {ok, cancelled}
 *   GET  /api/plugin-geometry/linked?project_id&plugin&study_id   {ok, linked: LinkedGeometry | null}
 *   GET  /api/plugin-geometry/status?project_id&plugin&study_id&job_id   {ok, job}
 *   GET  /api/plugin-geometry/events?project_id&plugin&study_id   (SSE) a snapshot of the
 *       study's jobs, then {job_id, seq, ev} per event
 *   GET  /api/geometry/lost-faces?project_id&geometry_id   a geometry's link for its panel:
 *       {linked, rev, name, source, last_update, entries: [lost entries by record]}
 *   POST /api/geometry/lost-faces/forget   {project_id, geometry_id, geometry_rev, study_id?,
 *       kind?, id?, mesh_id?, run_id?, entry?}: the user's Forget of lost faces (gated, as
 *       every /api/geometry route); 409 geometry_changed when geometry_rev is not the
 *       geometry's rev, 503 geometry_updating while it is fenced
 *
 * Scope comes from the bridge: the plugin and the study are never the page's to choose.
 * Not gated (link-gate.js): the call writes only its own staging folder. There is no stop
 * route: a queued update leaves when its Queue row is removed.
 *
 * MAGNUSIM_TEST_SLOT_HOLD=1 (read once, when this module loads) also registers
 * POST /api/test/slot-hold and /api/test/slot-release: a test holds the compute slot as
 * the boot check does (kind `check`) until it releases it.
 */
import type { RequestContext, Router } from './router.ts';
import type { WorkerClient } from './worker.ts';
import { writeSse } from './jobs.ts';
import type { PluginFiles } from './plugin-files.ts';
import { claimComputeSlot, releaseComputeSlot, sameProjectFolder } from '../compute-slot.js';
import { LINK_JOB_RE, linkEventBus, readLinkRecord } from '../link-store.js';
import {
  LinkJobError,
  acceptLink,
  chooseLink,
  configureLinkJobs,
  linkCallOf,
  linkJobOf,
  linkedGeometryOf,
  studyLinkJobs,
} from './link-job.js';

const SLOT_HOLD = process.env.MAGNUSIM_TEST_SLOT_HOLD === '1';
const HEARTBEAT_MS = 15_000;
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Json = Record<string, unknown>;
type Scope = { projectId: string; plugin: string; studyId: string };

function sendLinkError(ctx: RequestContext, err: unknown): void {
  if (err instanceof LinkJobError) {
    const e = err as unknown as { status: number; code: string; message: string; extra: Json };
    ctx.sendJson(e.status, { ok: false, code: e.code, error: e.message, ...e.extra });
    return;
  }
  const e = err as { status?: number; code?: string; message?: string } | null;
  if (e && typeof e.status === 'number' && typeof e.code === 'string') {
    ctx.sendJson(e.status, { ok: false, code: e.code, error: String(e.message || 'refused') });
    return;
  }
  console.warn('[CFD link routes]', err);
  ctx.sendJson(500, { ok: false, code: 'error', error: 'The request failed' });
}

function scopeOf(ctx: RequestContext): Scope {
  const q = ctx.url.searchParams;
  const projectId = String(q.get('project_id') || ctx.scope.projectId || '').trim();
  const plugin = String(q.get('plugin') || '').trim();
  const studyId = String(q.get('study_id') || '').trim();
  if (!projectId) throw new LinkJobError(400, 'bad_request', 'project_id required');
  if (!PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin)) throw new LinkJobError(400, 'bad_request', 'invalid plugin key');
  if (!STUDY_ID_RE.test(studyId)) throw new LinkJobError(400, 'bad_request', 'invalid study id');
  return { projectId, plugin, studyId };
}

/** A record of this scope, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inScope(rec: any, s: Scope): any {
  if (!rec || rec.plugin !== s.plugin || rec.study_id !== s.studyId) return null;
  return sameProjectFolder(rec.project_id, s.projectId) ? rec : null;
}

export function registerLinkRoutes(router: Router, deps: { worker: WorkerClient; files: PluginFiles }): void {
  configureLinkJobs({ worker: deps.worker, files: deps.files });
  const own = { underscoreAlias: false };

  router.add(
    'POST',
    '/api/plugin-geometry/link',
    async (ctx) => {
      let body: Json = {};
      try {
        body = ((await ctx.readJsonBody()) || {}) as Json;
      } catch {
        return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid JSON body' });
      }
      try {
        const answer = await acceptLink(linkCallOf(body));
        ctx.sendJson(answer.status, answer.body);
      } catch (err) {
        sendLinkError(ctx, err);
      }
    },
    own,
  );

  router.add(
    'POST',
    '/api/plugin-geometry/choose',
    async (ctx) => {
      let body: Json = {};
      try {
        body = ((await ctx.readJsonBody()) || {}) as Json;
      } catch {
        return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid JSON body' });
      }
      try {
        const answer = await chooseLink(body);
        ctx.sendJson(answer.status, answer.body);
      } catch (err) {
        sendLinkError(ctx, err);
      }
    },
    own,
  );

  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-geometry/linked',
    async (ctx) => {
      try {
        const s = scopeOf(ctx);
        ctx.sendJson(200, { ok: true, linked: await linkedGeometryOf(s.projectId, s.plugin, s.studyId) });
      } catch (err) {
        sendLinkError(ctx, err);
      }
    },
    own,
  );

  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-geometry/status',
    (ctx) => {
      try {
        const s = scopeOf(ctx);
        const id = String(ctx.url.searchParams.get('job_id') || '');
        const rec = LINK_JOB_RE.test(id) ? inScope(readLinkRecord(id), s) : null;
        if (!rec) throw new LinkJobError(404, 'not_found', 'No such link job in this study');
        ctx.sendJson(200, { ok: true, job: linkJobOf(rec) });
      } catch (err) {
        sendLinkError(ctx, err);
      }
    },
    own,
  );

  // One stream per open page (and the workbench): this study's link jobs only.
  router.add(
    ['GET'],
    '/api/plugin-geometry/events',
    (ctx) => {
      let s: Scope;
      try {
        s = scopeOf(ctx);
      } catch (err) {
        sendLinkError(ctx, err);
        return;
      }
      const res = ctx.res;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      writeSse(res, 'snapshot', { jobs: studyLinkJobs(s.projectId, s.plugin, s.studyId).map(linkJobOf) });
      const bus = linkEventBus();
      const onEvent = (msg: Json) => {
        if (!msg || msg.plugin !== s.plugin || msg.study_id !== s.studyId) return;
        if (!sameProjectFolder(msg.project_id, s.projectId)) return;
        writeSse(res, 'link', { job_id: msg.job_id, seq: msg.seq, ev: msg.ev });
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
    },
    own,
  );

  if (SLOT_HOLD) {
    let held: string | null = null;
    router.post('/api/test/slot-hold', (ctx) => {
      if (held) return ctx.sendJson(200, { ok: true, token: held, already: true });
      const claimed = claimComputeSlot('check', { name: 'Checking for jobs left running' }, { phase: 'checking' });
      if (!claimed.ok) return ctx.sendJson(409, { ok: false, error: 'the slot is held' });
      held = claimed.token;
      ctx.sendJson(200, { ok: true, token: held });
    });
    router.post('/api/test/slot-release', (ctx) => {
      const was = held;
      held = null;
      ctx.sendJson(200, { ok: true, released: was ? releaseComputeSlot(was) : false });
    });
  }
}

/** Whether this process registers the test slot-hold routes (false in production). */
export function slotHoldRoutesOn(): boolean {
  return SLOT_HOLD;
}

/**
 * A linked geometry's lost faces (API 1.5): GET /api/geometry/lost-faces and POST
 * /api/geometry/lost-faces/forget. Registered before the /api/geometry/** catch-all
 * (live-routes.js), which would answer them otherwise; gated like every /api/geometry route.
 */
export function registerLostFaceRoutes(router: Router, worker: { call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> }): void {
  router.add(['GET', 'HEAD'], '/api/geometry/lost-faces', async (ctx) => {
    const q = ctx.url.searchParams;
    const projectId = String(q.get('project_id') || ctx.scope.projectId || '').trim();
    const geometryId = String(q.get('geometry_id') || '').trim();
    if (!projectId || !geometryId) return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id and geometry_id required' });
    try {
      const answer = (await worker.call('geometry.lost_list', { project_id: projectId, geometry_id: geometryId })) as Json;
      if (answer && answer.ok) return ctx.sendJson(200, answer);
      const code = String((answer && answer.code) || 'failed');
      ctx.sendJson(code === 'gone' ? 404 : 400, { ok: false, code, error: String((answer && answer.error) || 'failed') });
    } catch (err) {
      sendLinkError(ctx, err);
    }
  });

  router.post('/api/geometry/lost-faces/forget', async (ctx) => {
    let body: Json = {};
    try {
      body = ((await ctx.readJsonBody()) || {}) as Json;
    } catch {
      return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid JSON body' });
    }
    const projectId = String(body.project_id || ctx.scope.projectId || '').trim();
    const geometryId = String(body.geometry_id || '').trim();
    if (!projectId || !geometryId) return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id and geometry_id required' });
    const entry = body.entry && typeof body.entry === 'object' ? body.entry : null;
    let answer: Json;
    try {
      answer = (await worker.call('geometry.forget_lost', {
        project_id: projectId,
        geometry_id: geometryId,
        geometry_rev: body.geometry_rev ?? null,
        study_id: String(body.study_id || ''),
        kind: String(body.kind || ''),
        id: String(body.id || ''),
        mesh_id: String(body.mesh_id || ''),
        run_id: String(body.run_id || ''),
        entry,
      })) as Json;
    } catch (err) {
      return sendLinkError(ctx, err);
    }
    if (answer && answer.ok) return ctx.sendJson(200, answer);
    const code = String((answer && answer.code) || 'failed');
    const status = code === 'geometry_changed' ? 409 : code === 'geometry_updating' ? 503 : code === 'gone' ? 404 : 400;
    if (status === 503) ctx.res.setHeader('Retry-After', '2');
    ctx.sendJson(status, { ok: false, code, error: String((answer && answer.error) || 'Could not forget the lost faces') });
  });
}
