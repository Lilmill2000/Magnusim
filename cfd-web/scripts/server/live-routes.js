/**
 * Register live product routes (same request/response shape as the old if-chain).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleW16Api, attachLiveMeshJobReader, attachActiveProjectListener, importGeometry } from '../w16-project-geometry.js';
import { handleProjectHydrate } from '../project-hydrate.js';
import { caseDirBelongsToProject } from '../project-isolation.js';
import { handleW17Api } from '../w17-simulation.js';
import { handleW18Api } from '../w18-materials.js';
import { handleW19Api } from '../w19-boundary-conditions.js';
import { handleW20Api } from '../w20-mesh.js';
import { startMeshGenerate, liveMeshJobSnapshot, isLiveMeshJobHeld, reapOrphanMeshGeneratorsOnBoot } from '../w21-mesh-generate.js';
import { handleW26Api } from '../w26-mesh-refinements.js';
import { handleW22Api } from '../w22-area-average.js';
import { handleW27Api, startSolve, isLiveSolveHeld, liveSolveJobSnapshot } from '../w27-solve.js';
import {
  configureComputeQueue,
  snapshotComputeQueue,
  enqueueComputeJob,
  mergeComputeQueueItems,
  removeComputeJob,
  dropComputeJobsForMesh,
  reorderComputeQueue,
  kickComputeQueue,
  scheduleComputeQueueKick,
  startResultFromEngine,
} from './compute-queue.ts';
import { handleW28Api } from '../w28-media.js';
import { handlePrefsApi } from '../w32-prefs.js';
import { getCaseFieldApi } from '../vite-plugin-case-fields.js';
import { readBinaryBody, readJsonBody, sendJson } from './http.ts';
import { WorkerUnavailableError } from './worker.ts';

function wrap(handler) {
  return async (ctx) => {
    const parts = ctx.pathname.split('/').filter(Boolean);
    const handled = await handler(ctx.req, ctx.res, ctx.url, parts, {
      sendJson,
      readJsonBody,
      readBinaryBody,
    });
    return handled !== false;
  };
}

function computeQueueLive() {
  if (isLiveMeshJobHeld()) {
    const mesh = liveMeshJobSnapshot() || {};
    return {
      kind: 'mesh',
      mesh_id: mesh.mesh_id || null,
      run_id: null,
      project_id: mesh.project_id || null,
    };
  }
  if (isLiveSolveHeld()) {
    const solve = liveSolveJobSnapshot() || {};
    return {
      kind: 'solve',
      mesh_id: null,
      run_id: solve.run_id || null,
      project_id: solve.project_id || null,
    };
  }
  return null;
}

function wireComputeQueue(api) {
  configureComputeQueue({
    isBusy: () => isLiveMeshJobHeld() || isLiveSolveHeld(),
    meshIsGenerating: (meshId) => {
      const snap = liveMeshJobSnapshot();
      return !!(snap && meshId && String(snap.mesh_id || '') === String(meshId));
    },
    startMesh: (item) => {
      const kicked = startMeshGenerate({
        settings: item.settings || null,
        projectId: item.project_id || null,
        meshId: item.mesh_id || null,
        onUpdate: (fields) => api.applyKickUpdate(fields),
      });
      if (kicked.ok) api.applyKickUpdate(kicked.bodyExtra);
      return startResultFromEngine(kicked);
    },
    startSolve: (item) => startResultFromEngine(
      startSolve({
        projectId: item.project_id || null,
        runId: item.run_id || null,
        simulationId: item.simulation_id || null,
      }),
    ),
    live: computeQueueLive,
  });
}

export function registerLiveRoutes(router, { worker, jobs }) {
  const api = getCaseFieldApi();

  attachLiveMeshJobReader(liveMeshJobSnapshot);
  attachActiveProjectListener(api.syncActiveCaseToActiveProject);
  wireComputeQueue(api);

  router.get('/api/compute-queue', (ctx) => {
    ctx.sendJson(200, snapshotComputeQueue());
  });

  router.post('/api/compute-queue', async (ctx) => {
    let body;
    try {
      body = await ctx.readJsonBody();
    } catch (e) {
      ctx.sendJson(400, { error: 'invalid JSON body', detail: String(e) });
      return;
    }
    const action = String(body.action || '');
    if (action === 'merge') {
      ctx.sendJson(200, mergeComputeQueueItems(body.items));
      return;
    }
    if (action === 'drop-mesh') {
      ctx.sendJson(200, dropComputeJobsForMesh(body.mesh_id));
      return;
    }
    if (action === 'remove') {
      ctx.sendJson(200, removeComputeJob(body.kind, body.id));
      return;
    }
    const enqueued = enqueueComputeJob(body.item || body, {
      hasMaterial: body.has_material,
      meshGenerating: !!body.mesh_generating,
    });
    if (!enqueued.ok) {
      ctx.sendJson(400, { ok: false, error: enqueued.error, items: enqueued.items, live: computeQueueLive() });
      return;
    }
    ctx.sendJson(200, { ...snapshotComputeQueue(), item: enqueued.item });
  });

  router.add('PATCH', '/api/compute-queue', async (ctx) => {
    let body;
    try {
      body = await ctx.readJsonBody();
    } catch (e) {
      ctx.sendJson(400, { error: 'invalid JSON body', detail: String(e) });
      return;
    }
    const next = reorderComputeQueue(body.ids);
    ctx.sendJson(next.ok === false ? 400 : 200, next);
  });

  router.add('DELETE', '/api/compute-queue/:id', (ctx) => {
    ctx.sendJson(200, removeComputeJob(ctx.url.searchParams.get('kind'), ctx.params.id));
  });

  router.post('/api/compute-queue/kick', async (ctx) => {
    await ctx.readJsonBody().catch(() => ({}));
    ctx.sendJson(200, await kickComputeQueue());
  });

  router.get('/api/project/hydrate', async (ctx) => {
    const id = String(ctx.url.searchParams.get('project_id') || '').trim();
    if (!id) {
      sendJson(ctx.res, 400, { error: 'project_id required' });
      return;
    }
    // Reconcile orphan run folders in the background. Awaiting the worker
    // here queued behind volume release / field export and left the
    // workbench blank for tens of seconds with no geometry.
    worker
      .call('project.hydrate', { id, simulation_id: ctx.url.searchParams.get('simulation_id') || '' })
      .catch(() => {});
    return handleProjectHydrate(ctx.req, ctx.res, ctx.url, { sendJson });
  });

  router.add(['GET', 'HEAD', 'POST'], '/api/prefs', wrap(handlePrefsApi));
  router.add(['GET', 'HEAD', 'POST'], '/api/prefs/**rest', wrap(handlePrefsApi));

  router.add(['GET', 'HEAD', 'POST'], '/api/media', wrap(handleW28Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/media/**rest', wrap(handleW28Api));

  router.add(['GET', 'HEAD', 'POST'], '/api/simulation-control', wrap(handleW27Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/run', wrap(handleW27Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/run/**rest', wrap(handleW27Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/runs', wrap(handleW27Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/runs/**rest', wrap(handleW27Api));

  router.add(['GET', 'HEAD', 'POST'], '/api/result-controls', wrap(handleW22Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/area-average', wrap(handleW22Api));

  router.add(['GET', 'HEAD', 'POST'], '/api/mesh/refinements', wrap(handleW26Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/mesh-refinements', wrap(handleW26Api));

  router.add(['GET', 'HEAD', 'POST'], '/api/bcs', wrap(handleW19Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/materials', wrap(handleW18Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/simulation', wrap(handleW17Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/simulation/**rest', wrap(handleW17Api));

  router.add(['GET', 'HEAD', 'POST'], '/api/project', wrap(handleW16Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/project/**rest', wrap(handleW16Api));
  router.add(['GET', 'HEAD'], '/api/projects', wrap(handleW16Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/folders', wrap(handleW16Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/geometry', wrap(handleW16Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/geometry/**rest', wrap(handleW16Api));

  router.post('/api/case/attach', async (ctx) => {
    let body;
    try {
      body = await ctx.readJsonBody();
    } catch (e) {
      ctx.sendJson(400, { error: 'invalid JSON body', detail: String(e) });
      return;
    }
    const caseDir = body.case_dir || body.case || body.path || '';
    const result = api.attachCaseDir(
      caseDir,
      body.project_id || body.projectId,
      body.simulation_id || body.simulationId
    );
    ctx.res.setHeader('X-CFD-Source', 'case-attach');
    if (result.ok && result.body && result.body.case_dir) {
      ctx.res.setHeader('X-CFD-Case-Dir', result.body.case_dir);
    }
    ctx.sendJson(result.status, result.body);
  });

  router.get('/api/case', (ctx) => sendCaseStatus(ctx, api));
  router.get('/api/case/status', (ctx) => sendCaseStatus(ctx, api));

  router.post('/api/case/detach', async (ctx) => {
    await ctx.readJsonBody().catch(() => ({}));
    api.resetActiveCaseIdle('W15.1: detached; idle until next attach/kick. No fake progress.');
    try {
      await api.releaseVolume();
    } catch {
      /* worker may already be idle */
    }
    ctx.sendJson(200, api.caseSnapshot());
  });

  router.post('/api/mesh/generate', (ctx) => kickMesh(ctx, api));
  router.post('/api/mesh/remesh', (ctx) => kickMesh(ctx, api));

  router.add(['GET', 'HEAD', 'POST'], '/api/mesh', async (ctx) => {
    if (/\/(generate|remesh|surface|section|refinements)(\/|$)/.test(ctx.pathname)) return false;
    const parts = ctx.pathname.split('/').filter(Boolean);
    const handled = await handleW20Api(ctx.req, ctx.res, ctx.url, parts, {
      sendJson,
      readJsonBody,
      onGeneratedMeshDeleted({ deleted_runs }) {
        const active = api.caseSnapshot().case_dir;
        const removed = (deleted_runs || []).map((p) => resolve(p).toLowerCase());
        if (active) {
          const a = resolve(active).toLowerCase();
          const hit = removed.some((p) => a === p || a.startsWith(`${p}\\`) || a.startsWith(`${p}/`));
          if (hit || !existsSync(active)) api.resetActiveCaseIdle('Generated mesh deleted');
        }
        for (const p of deleted_runs || []) {
          try {
            const vtp = api.meshSurfaceCacheKey(p);
            const meta = vtp.replace(/\.vtp$/i, '.meta.json');
            if (existsSync(vtp)) rmSync(vtp, { force: true });
            if (existsSync(meta)) rmSync(meta, { force: true });
          } catch {
            /* ignore */
          }
        }
      },
    });
    return handled !== false;
  });
  router.add(['GET', 'HEAD', 'POST'], '/api/mesh/delete', wrap(handleW20Api));
  router.add(['GET', 'HEAD', 'POST'], '/api/mesh/kick', wrap(handleW20Api));

  router.get('/api/fields/:field/series-range', async (ctx) => {
    const field = ctx.params.field;
    if (!api.ALLOWED_FIELDS.has(field)) {
      ctx.sendJson(400, { error: 'unsupported field', allowed: [...api.ALLOWED_FIELDS] });
      return;
    }
    const caseDir = api.resolveCaseDir(ctx.url);
    if (!caseDir || !existsSync(caseDir)) {
      ctx.sendJson(404, { error: 'case_dir not found', case: caseDir, empty: true });
      return;
    }
    try {
      const body = await api.ensureSeriesRange(caseDir, field);
      ctx.sendJson(200, { ...body, proves_not_baked_only: true });
    } catch (e) {
      ctx.sendJson(500, { error: String(e && e.message ? e.message : e), empty: true });
    }
  });

  router.add(['GET', 'POST'], '/api/volume/release', async (ctx) => {
    try {
      const body = await api.releaseVolume();
      ctx.sendJson(200, body && typeof body === 'object' ? body : { ok: true, released: true });
    } catch (err) {
      if (err instanceof WorkerUnavailableError) {
        ctx.sendJson(200, { ok: true, released: false, worker: false });
        return;
      }
      ctx.sendJson(200, { ok: true, released: false, error: String(err && err.message ? err.message : err) });
    }
  });

  router.get('/api/volume/warmup', async (ctx) => {
    const caseDir = api.resolveCaseDir(ctx.url);
    const time = ctx.url.searchParams.get('time') || api.DEFAULT_TIME;
    if (!caseDir || !existsSync(caseDir)) {
      ctx.sendJson(404, { error: 'case_dir not found', case: caseDir, empty: true });
      return;
    }
    try {
      const body = await api.warmVolume(caseDir, time);
      ctx.sendJson(200, body && typeof body === 'object' ? body : { ok: true, case_dir: caseDir, time: String(time) });
    } catch (err) {
      if (err instanceof WorkerUnavailableError) {
        ctx.sendJson(503, { error: err.message, ok: false });
        return;
      }
      const status = err && err.status === 503 ? 503 : 500;
      ctx.sendJson(status, { error: String(err && err.message ? err.message : err), ok: false });
    }
  });

  router.get('/api/times', (ctx) => {
    const caseDir = api.resolveCaseDir(ctx.url);
    if (!caseDir || !existsSync(caseDir)) {
      ctx.sendJson(404, { error: 'case_dir not found', case: caseDir, times: [], empty: true });
      return;
    }
    const times = api.listCaseTimes(caseDir);
    ctx.res.setHeader('X-CFD-Source', 'case-tree-times');
    ctx.res.setHeader('X-CFD-Case-Dir', caseDir);
    ctx.sendJson(200, {
      increment: 'W12',
      case_dir: caseDir,
      times,
      n_times: times.length,
      start: times.length ? times[0] : null,
      end: times.length ? times[times.length - 1] : null,
      proves_not_baked_only: true,
      no_invented_frames: true,
    });
  });

  router.get('/api/particle-trace/faces', (ctx) => {
    const caseDir = api.resolveCaseDir(ctx.url);
    ctx.sendJson(200, {
      increment: 'W14',
      case_dir: caseDir,
      face_source_doc:
        'Inlet/outlet openings for highlight. Any CAD face can be selected; walls seed from the CAD surface in mesh metres.',
      faces: api.listCaseSeedFaces(caseDir),
    });
  });

  const serveLegacyFilter = async (ctx, key) => {
    const caseDir = api.resolveCaseDir(ctx.url);
    const time = ctx.url.searchParams.get('time') || api.DEFAULT_TIME;
    const wantMeta =
      ctx.pathname.endsWith('/meta') || ctx.url.searchParams.get('meta') === '1' || ctx.method === 'HEAD';
    if (!caseDir || !existsSync(caseDir)) {
      ctx.sendJson(404, {
        error: 'case_dir not found',
        case: caseDir,
        case_dir: caseDir,
        empty: true,
      });
      return;
    }

    const sendVtp = (buf, name, headers) => {
      ctx.res.statusCode = 200;
      for (const [k, v] of Object.entries(headers || {})) ctx.res.setHeader(k, v);
      ctx.res.setHeader('Content-Type', 'application/octet-stream');
      ctx.res.setHeader('Content-Length', String(buf.length));
      ctx.res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      ctx.res.setHeader('Cache-Control', 'no-store');
      if (ctx.method === 'HEAD') {
        ctx.res.end();
        return;
      }
      ctx.res.end(buf);
    };

    if (key === 'fields') {
      const field = ctx.url.searchParams.get('field') || ctx.params.field;
      if (!api.ALLOWED_FIELDS.has(field)) {
        ctx.sendJson(400, { error: 'unsupported field', allowed: [...api.ALLOWED_FIELDS] });
        return;
      }
      const foamPath = api.foamFieldPath(caseDir, time, field);
      if (!existsSync(foamPath)) {
        ctx.sendJson(404, {
          error: 'time_not_found',
          case: caseDir,
          time: String(time),
          field,
          empty: true,
          available_times: api.listCaseTimes(caseDir),
          proves_not_baked_only: true,
        });
        return;
      }
      const exported = await api.ensureExported(caseDir, time, field);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      ctx.res.setHeader('X-CFD-Source', 'case-tree');
      ctx.res.setHeader('X-CFD-Cache', exported.from_cache ? 'hit' : 'miss');
      if (wantMeta) {
        ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
        return;
      }
      sendVtp(readFileSync(exported.vtp), `${field}.vtp`);
      return;
    }

    if (key === 'cut_plane') {
      const p = api.cutParamsFromUrl(ctx.url);
      const exported = await api.ensureCutPlane(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      if (wantMeta) {
        ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache });
        return;
      }
      sendVtp(readFileSync(exported.vtp), 'cut_plane.vtp');
      return;
    }
    if (key === 'iso_surface') {
      const p = api.isoParamsFromUrl(ctx.url);
      const exported = await api.ensureIsoSurface(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      if (wantMeta) {
        ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
        return;
      }
      sendVtp(readFileSync(exported.vtp), 'iso_surface.vtp');
      return;
    }
    if (key === 'iso_volume') {
      const p = api.isoVolParamsFromUrl(ctx.url);
      const exported = await api.ensureIsoVolume(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      if (wantMeta) {
        ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
        return;
      }
      sendVtp(readFileSync(exported.vtp), 'iso_volume.vtp');
      return;
    }
    if (key === 'plot_over_path') {
      const p = api.popParamsFromUrl(ctx.url);
      const exported = await api.ensurePlotOverPath(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
      return;
    }
    if (key === 'particle_trace') {
      const p = api.ptParamsFromUrl(ctx.url);
      const exported = await api.ensureParticleTrace(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      if (wantMeta) {
        ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
        return;
      }
      sendVtp(readFileSync(exported.vtp), 'particle_trace.vtp');
      return;
    }
    if (key === 'inspect') {
      const p = api.inspectParamsFromUrl(ctx.url);
      if (![p.x, p.y, p.z].every((v) => Number.isFinite(v))) {
        ctx.sendJson(400, { error: 'x,y,z required as finite numbers', empty: true, hit: false });
        return;
      }
      const exported = await api.ensureInspect(caseDir, time, p);
      const metaObj = JSON.parse(readFileSync(exported.meta, 'utf8'));
      ctx.sendJson(200, { ...metaObj, from_cache: exported.from_cache, proves_not_baked_only: true });
      return;
    }
    if (key === 'mesh_surface') {
      const ensured = await api.ensureMeshSurface(caseDir);
      if (!ensured.ok) {
        ctx.sendJson(500, { error: 'mesh-surface failed', detail: ensured });
        return;
      }
      if (wantMeta) {
        ctx.sendJson(200, { ok: true, increment: 'W27', case_dir: caseDir, meta: ensured.meta, cached: !!ensured.cached });
        return;
      }
      sendVtp(readFileSync(ensured.path), 'mesh-surface.vtp');
      return;
    }
    if (key === 'mesh_section') {
      const axis = (ctx.url.searchParams.get('axis') || 'x').toLowerCase();
      const frac = Number(ctx.url.searchParams.get('frac') || '0.5');
      const ensured = await api.ensureMeshSection(caseDir, axis, Number.isFinite(frac) ? frac : 0.5);
      if (!ensured.ok) {
        ctx.sendJson(500, { error: 'mesh-section failed', detail: ensured });
        return;
      }
      if (wantMeta) {
        ctx.sendJson(200, { ok: true, increment: 'W25b', case_dir: caseDir, axis, frac, meta: ensured.meta, cached: !!ensured.cached });
        return;
      }
      sendVtp(readFileSync(ensured.path), 'mesh-section.vtp');
      return;
    }
    ctx.sendJson(404, { error: 'unknown filter', key });
  };

  return {
    serveLegacyFilter,
    caseSnapshot: () => api.caseSnapshot(),
    attachCaseDir: (dir, pid) => api.attachCaseDir(dir, pid),
    resetCaseIdle: (note) => api.resetActiveCaseIdle(note),
    startMeshJob(params, job) {
      const kicked = startMeshGenerate({
        settings: params.settings || null,
        projectId: params.project_id || params.projectId || null,
        meshId: params.mesh_id || params.id || null,
        onUpdate: (fields) => {
          api.applyKickUpdate(fields);
          if (fields && fields.status === 'done') jobs.finish(job.id, 'done', api.caseSnapshot());
          if (fields && (fields.status === 'failed' || fields.status === 'stopped')) {
            jobs.finish(job.id, fields.status, fields, fields.error || 'mesh failed');
          }
        },
      });
      if (!kicked.ok) {
        jobs.finish(job.id, 'failed', kicked.bodyExtra, (kicked.bodyExtra && kicked.bodyExtra.error) || 'mesh failed');
        return;
      }
      api.applyKickUpdate(kicked.bodyExtra);
      const snap = api.caseSnapshot();
      jobs.attachChild(job.id, { pid: snap.pid });
      job.result = snap;
    },
    startSolveJob(params, job) {
      const started = startSolve({
        projectId: params.project_id || params.projectId,
        endTime: params.endTime || params.end_time,
        writeInterval: params.writeInterval || params.write_interval,
        runId: params.runId || params.run_id,
        transient: params.transient,
        onDone: (result) => {
          const status = result && result.status === 'done' ? 'done' : result && result.status === 'stopped' ? 'stopped' : 'failed';
          jobs.finish(job.id, status, result, result && result.error);
        },
      });
      if (!started.ok) {
        jobs.finish(job.id, 'failed', started.bodyExtra, (started.bodyExtra && started.bodyExtra.error) || 'solve failed');
        return;
      }
      jobs.attachChild(job.id, { pid: started.bodyExtra && started.bodyExtra.pid });
      job.result = started.bodyExtra || started;
    },
    startCadImportJob(params, job) {
      importGeometry(params)
        .then((result) => {
          if (!result.ok) jobs.finish(job.id, 'failed', result.body, (result.body && result.body.error) || 'import failed');
          else jobs.finish(job.id, 'done', result.body);
        })
        .catch((err) => jobs.finish(job.id, 'failed', null, String(err)));
    },
    boot() {
      api.hydrateActiveMeshCase();
      try {
        reapOrphanMeshGeneratorsOnBoot();
      } catch {
        /* ignore */
      }
      try {
        scheduleComputeQueueKick(400);
      } catch {
        /* ignore */
      }
    },
  };
}

function sendCaseStatus(ctx, api) {
  const pid = api.requestProjectId(ctx.url);
  const snap = api.caseSnapshot();
  if (pid && snap.case_dir && !caseDirBelongsToProject(snap.case_dir, pid)) {
    ctx.sendJson(200, {
      ok: true,
      case_dir: null,
      status: 'idle',
      mode: 'idle',
      project_id: pid,
      n_times: 0,
      times: [],
      note: 'idle — attached case belongs to another project',
      pid: null,
    });
    return;
  }
  ctx.res.setHeader('X-CFD-Source', 'case-status');
  if (snap.case_dir) ctx.res.setHeader('X-CFD-Case-Dir', snap.case_dir);
  ctx.res.setHeader('X-CFD-Case-Status', snap.status);
  ctx.sendJson(200, snap);
}

async function kickMesh(ctx, api) {
  let body;
  try {
    body = await ctx.readJsonBody();
  } catch (e) {
    ctx.sendJson(400, { error: 'invalid JSON body', detail: String(e) });
    return;
  }
  const kicked = startMeshGenerate({
    settings: body.settings || null,
    projectId: body.project_id || null,
    meshId: body.mesh_id || body.id || null,
    onUpdate: (fields) => api.applyKickUpdate(fields),
  });
  if (!kicked.ok) {
    ctx.sendJson(kicked.status, { ...api.caseSnapshot(), ...(kicked.bodyExtra || {}), ok: false, increment: 'W23' });
    return;
  }
  api.applyKickUpdate(kicked.bodyExtra);
  const snap = api.caseSnapshot();
  ctx.res.setHeader('X-CFD-Source', 'mesh-generate');
  ctx.sendJson(kicked.status, { ...snap, ok: true, increment: 'W23', mtp1_silent_copy: false });
}
