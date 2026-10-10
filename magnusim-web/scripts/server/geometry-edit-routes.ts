/**
 * Editing a project geometry in a plugin's workspace (host API 1.7): the routes.
 *
 *   POST /api/geometry-actions/open  {project_id, geometry_id, plugin, study_kind}
 *       200 {ok, plugin, study_id, workspace, created, title}: the study the action opens
 *       (the one that links the geometry, else the newest that edits it and links nothing,
 *       else a new one, titled as the geometry); 409 {code: 'not_editable', error} (the
 *       reason the menu shows); 404 {code: 'plugin_off' | 'gone'}. On the main worker lane,
 *       so two tabs never make two studies.
 *   GET  /api/plugin-geometry/target?project_id&plugin&study_id   {ok, geometry: EditedGeometry | null}
 *   GET  /api/plugin-geometry/source?project_id&plugin&study_id&format=step
 *       the geometry's STEP file, streamed, with Content-Length, X-Sha256 and X-File-Name
 *       (URI-encoded), X-Geometry-Id and X-Adopted; refusals {ok: false, code, error}:
 *       not_allowed 403, gone 404, no_source 404, not_ready 503 (Retry-After, retryAfter)
 *   GET  /api/plugin-geometry/faces?project_id&plugin&study_id   {ok, ...GeometryFaces}
 *   POST /api/geometry/original/import  {project_id, geometry_id}: an adopted geometry's
 *       original imported again as a new geometry ("Add the original as a new geometry";
 *       gated, as every /api/geometry route)
 *
 * The plugin and the study of the plugin-geometry routes come from the workspace bridge,
 * never from the page.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { RequestContext, Router } from './router.ts';
import { PROJECTS_ROOT } from '../project-isolation.js';
import { pluginLoaded } from '../registry-defaults.js';

type Json = Record<string, unknown>;
type Worker = { call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> };

const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** The HTTP status of a refusal's code. */
export function statusOfCode(code: string): number {
  switch (code) {
    case 'not_editable':
    case 'adopted':
      return 409;
    case 'not_allowed':
      return 403;
    case 'gone':
    case 'plugin_off':
    case 'no_source':
    case 'not_found':
      return 404;
    case 'not_ready':
      return 503;
    case 'bad_request':
      return 400;
    default:
      return 500;
  }
}

function refuse(ctx: RequestContext, answer: Json | null | undefined): void {
  const code = String((answer && answer.code) || 'failed');
  const status = statusOfCode(code);
  if (status === 503) ctx.res.setHeader('Retry-After', String(Number((answer && answer.retryAfter) || 3)));
  ctx.sendJson(status, { ok: false, code, error: String((answer && answer.error) || 'The request failed'), ...(answer && answer.retryAfter ? { retryAfter: answer.retryAfter } : {}) });
}

function failed(ctx: RequestContext, err: unknown): void {
  console.warn('[CFD geometry edit]', err);
  ctx.sendJson(503, { ok: false, code: 'unavailable', error: 'The app could not answer right now' });
}

/** A project id the routes may use: one folder under the projects root (400 or 404 sent otherwise). */
function projectOk(ctx: RequestContext, projectId: string): boolean {
  const root = resolve(PROJECTS_ROOT);
  const dir = resolve(root, projectId);
  if (!projectId || /[\\/]/.test(projectId) || projectId === '.' || projectId === '..' || resolve(dir, '..') !== root) {
    ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid project id' });
    return false;
  }
  if (!existsSync(join(dir, 'project.json'))) {
    ctx.sendJson(404, { ok: false, code: 'not_found', error: 'No such project' });
    return false;
  }
  return true;
}

/** The bridge's scope from the query, or null after a 400 was sent. */
function scopeOf(ctx: RequestContext): { projectId: string; plugin: string; studyId: string } | null {
  const q = ctx.url.searchParams;
  const projectId = String(q.get('project_id') || ctx.scope.projectId || '').trim();
  const plugin = String(q.get('plugin') || '').trim();
  const studyId = String(q.get('study_id') || '').trim();
  if (!projectId || !PLUGIN_KEY_RE.test(plugin) || /[. ]$/.test(plugin) || !STUDY_ID_RE.test(studyId)) {
    ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id, plugin and study_id required' });
    return null;
  }
  if (!pluginLoaded(plugin)) {
    ctx.sendJson(404, { ok: false, code: 'plugin_off', error: 'This plugin is not on' });
    return null;
  }
  if (!projectOk(ctx, projectId)) return null;
  return { projectId, plugin, studyId };
}

/** A file the worker named, only when it lies in that project's folder. */
function insideProject(path: string, projectId: string): string | null {
  const root = resolve(PROJECTS_ROOT, projectId);
  if (resolve(root, '..') !== resolve(PROJECTS_ROOT)) return null;
  const full = resolve(path);
  return full.toLowerCase().startsWith((root + sep).toLowerCase()) ? full : null;
}

export function registerGeometryEditRoutes(router: Router, worker: Worker): void {
  const own = { underscoreAlias: false };

  router.add(
    'POST',
    '/api/geometry-actions/open',
    async (ctx) => {
      let body: Json = {};
      try {
        body = ((await ctx.readJsonBody()) || {}) as Json;
      } catch {
        return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid JSON body' });
      }
      const projectId = String(body.project_id || ctx.scope.projectId || '').trim();
      const geometryId = String(body.geometry_id || '').trim();
      const plugin = String(body.plugin || '').trim();
      const studyKind = String(body.study_kind || '').trim();
      if (!projectId || !geometryId || !PLUGIN_KEY_RE.test(plugin) || !KIND_KEY_RE.test(studyKind)) {
        return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id, geometry_id, plugin and study_kind required' });
      }
      if (!pluginLoaded(plugin)) return ctx.sendJson(404, { ok: false, code: 'plugin_off', error: 'This plugin is not on' });
      if (!projectOk(ctx, projectId)) return;
      try {
        const answer = (await worker.call('geometry_actions.open', { project_id: projectId, geometry_id: geometryId, plugin, study_kind: studyKind })) as Json;
        if (answer && answer.ok) return ctx.sendJson(200, answer);
        refuse(ctx, answer);
      } catch (err) {
        failed(ctx, err);
      }
    },
    own,
  );

  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-geometry/target',
    async (ctx) => {
      const s = scopeOf(ctx);
      if (!s) return;
      // A plugin none of whose kinds links geometry edits none: no worker call at its handshake.
      const row = pluginLoaded(s.plugin) as { links_geometry?: boolean } | null;
      if (row && row.links_geometry === false) return ctx.sendJson(200, { ok: true, geometry: null });
      try {
        const answer = (await worker.call('geometry.edit_target', { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId })) as Json;
        ctx.sendJson(200, { ok: true, geometry: (answer && answer.geometry) || null });
      } catch (err) {
        failed(ctx, err);
      }
    },
    own,
  );

  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-geometry/faces',
    async (ctx) => {
      const s = scopeOf(ctx);
      if (!s) return;
      try {
        const answer = (await worker.call('geometry.faces_table', { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId }, 120_000)) as Json;
        if (answer && answer.ok) return ctx.sendJson(200, answer);
        refuse(ctx, answer);
      } catch (err) {
        failed(ctx, err);
      }
    },
    own,
  );

  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-geometry/source',
    async (ctx) => {
      const s = scopeOf(ctx);
      if (!s) return;
      const format = String(ctx.url.searchParams.get('format') || 'step');
      if (format !== 'step') {
        return ctx.sendJson(400, { ok: false, code: 'unsupported_format', error: `This app serves a geometry only as 'step', not ${JSON.stringify(format)}.`, formats: ['step'] });
      }
      let answer: Json;
      try {
        // Hashing a large STEP the first time takes a moment (the hash is kept beside it).
        answer = (await worker.call('geometry.source_path', { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId }, 300_000)) as Json;
      } catch (err) {
        return failed(ctx, err);
      }
      if (!answer || !answer.ok) return refuse(ctx, answer);
      const path = insideProject(String(answer.path || ''), s.projectId);
      let size = -1;
      try {
        size = path ? statSync(path).size : -1;
      } catch {
        size = -1;
      }
      if (!path || size < 0) return refuse(ctx, { code: 'no_source', error: 'The source file is missing.' });
      const res = ctx.res;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/step');
      res.setHeader('Content-Length', String(size));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Sha256', String(answer.sha256 || ''));
      res.setHeader('X-File-Name', encodeURIComponent(String(answer.file_name || 'source.step')));
      res.setHeader('X-Geometry-Id', String(answer.geometry_id || ''));
      res.setHeader('X-Adopted', answer.adopted ? '1' : '0');
      if (ctx.req.method === 'HEAD') return void res.end();
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    },
    own,
  );
}

/** POST /api/geometry/original/import: ahead of the /api/geometry/** catch-all (live-routes.js). */
export function registerOriginalImportRoute(
  router: Router,
  worker: Worker,
  importGeometry: (opts: Json) => Promise<{ ok: boolean; status: number; body: unknown }>,
): void {
  router.post('/api/geometry/original/import', async (ctx) => {
    let body: Json = {};
    try {
      body = ((await ctx.readJsonBody()) || {}) as Json;
    } catch {
      return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'invalid JSON body' });
    }
    const projectId = String(body.project_id || ctx.scope.projectId || '').trim();
    const geometryId = String(body.geometry_id || '').trim();
    if (!projectId || !geometryId) return ctx.sendJson(400, { ok: false, code: 'bad_request', error: 'project_id and geometry_id required' });
    if (!projectOk(ctx, projectId)) return;
    let where: Json;
    try {
      where = (await worker.call('geometry.original_import', { project_id: projectId, geometry_id: geometryId })) as Json;
    } catch (err) {
      return failed(ctx, err);
    }
    if (!where || !where.ok) return refuse(ctx, where);
    const path = insideProject(String(where.path || ''), projectId);
    if (!path) return refuse(ctx, { code: 'no_source', error: 'This geometry keeps no original file.' });
    const result = await importGeometry({ project_id: projectId, step_path: path, filename: String(where.file_name || 'original.step') });
    ctx.sendJson(result.status, result.body as Json);
  });
}
