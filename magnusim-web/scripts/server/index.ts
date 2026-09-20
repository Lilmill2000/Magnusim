import { join } from 'node:path';
import { WEB_ROOT } from '../python-env.js';
import { dispatch, Router } from './router.ts';
import { HttpError, assertSameOrigin, sendJson } from './http.ts';
import { JobManager } from './jobs.ts';
import { persistJobToWorker, registerPhase3Routes } from './routes.ts';
import { getWorker } from './worker.ts';
import { attachWorkerBridge } from '../py-json.js';
import { registerLiveRoutes } from './live-routes.js';

export { Router, dispatch } from './router.ts';
export { WorkerClient, getWorker, WorkerUnavailableError, RpcError } from './worker.ts';
export { JobManager } from './jobs.ts';

function installProcessGuards(): void {
  const g = globalThis as { __CFD_PROCESS_GUARDS__?: boolean };
  if (g.__CFD_PROCESS_GUARDS__) return;
  g.__CFD_PROCESS_GUARDS__ = true;
  process.on('uncaughtException', (err) => {
    console.error('[CFD] uncaughtException (dev server stays up)', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[CFD] unhandledRejection', reason);
  });
}

export function createApiPlugin() {
  installProcessGuards();
  const worker = getWorker();
  const cacheDir = join(WEB_ROOT, '.cache');
  const jobs = new JobManager({
    cacheDir,
    onPersist: (job) => persistJobToWorker(worker, job),
  });

  function install(server: {
      middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void };
      httpServer?: { on: (ev: string, fn: () => void) => void };
    }) {
      worker.start();
      attachWorkerBridge((method: string, params: unknown, timeoutMs?: number) =>
        worker.call(method, params, timeoutMs),
      );
      const router = new Router();
      const live = registerLiveRoutes(router, { worker, jobs, webRoot: WEB_ROOT, cacheDir });
      registerPhase3Routes(router, {
        worker,
        jobs,
        webRoot: WEB_ROOT,
        cacheDir,
        serveLegacyFilter: live.serveLegacyFilter,
        startMeshJob: live.startMeshJob,
        startSolveJob: live.startSolveJob,
        startCadImportJob: live.startCadImportJob,
        caseSnapshot: live.caseSnapshot,
        attachCaseDir: live.attachCaseDir,
        resetCaseIdle: live.resetCaseIdle,
      });
      live.boot();

      server.middlewares.use(async (req, res, next) => {
        try {
          const url = String(req.url || '');
          if (!url.startsWith('/api/') && !url.startsWith('/plugins/')) {
            next();
            return;
          }
          assertSameOrigin(req);
          const handled = await dispatch(router, req, res);
          if (!handled) sendJson(res, 404, { error: 'route not found' });
        } catch (err) {
          const msg = String(err && (err as Error).message ? (err as Error).message : err);
          const missing = /time_not_found|missing OpenFOAM|missing time dir|case foam files missing/i.test(
            msg,
          );
          sendJson(res, err instanceof HttpError ? err.status : (err as { status?: number })?.status === 400 ? 400 : missing ? 404 : 500, {
            error: msg,
            empty: !!missing,
            proves_not_baked_only: true,
            note: 'API reads case tree via pyvista export; not public/mtp1-fields.vtp',
          });
        }
      });

      const stop = () => {
        try {
          worker.stop();
        } catch {
          /* ignore */
        }
      };
      if (server.httpServer) {
        server.httpServer.on('close', stop);
      }
  }
  return { name: 'cfd-case-fields-api', configureServer: install, configurePreviewServer: install };
}

export default createApiPlugin;
