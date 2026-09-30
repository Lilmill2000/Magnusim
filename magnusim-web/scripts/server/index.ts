import { join } from 'node:path';
import { WEB_ROOT } from '../python-env.js';
import { dispatch, Router } from './router.ts';
import { HttpError, assertSameOrigin, sendJson } from './http.ts';
import { JobManager } from './jobs.ts';
import { persistJobToWorker, registerPhase3Routes } from './routes.ts';
import { getWorker } from './worker.ts';
import { PluginServiceHost } from './plugin-services.ts';
import type { SdkVariant } from './plugin-sdk.ts';
import { isFrameAssetRequest } from './workspace-files.ts';
import { attachWorkerBridge } from '../py-json.js';
import { registerLiveRoutes } from './live-routes.js';
import { setLiveRegistry } from '../registry-defaults.js';

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
  const services = new PluginServiceHost(worker);
  const cacheDir = join(WEB_ROOT, '.cache');
  const jobs = new JobManager({
    cacheDir,
    onPersist: (job) => persistJobToWorker(worker, job),
  });

  function install(
    server: {
      middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void };
      httpServer?: { on: (ev: string, fn: () => void) => void };
    },
    sdkVariant: SdkVariant,
  ) {
      worker.start();
      // Node validates mesher / analysis keys against the live registry (plugins
      // included); the committed registry.json holds builtins only.
      const refreshRegistry = () =>
        worker
          .call('registry.describe', {}, 60_000)
          .then((doc: unknown) => {
            if (!setLiveRegistry(doc)) console.warn('[registry] worker returned an unusable registry doc');
          })
          .catch((err: unknown) => console.warn('[registry] live registry load failed:', String(err)));
      let registrySettled = false;
      const registryReady = refreshRegistry().finally(() => {
        registrySettled = true;
      });
      worker.on('registry-changed', () => {
        void refreshRegistry();
      });
      attachWorkerBridge((method: string, params: unknown, timeoutMs?: number) =>
        worker.call(method, params, timeoutMs),
      );
      const router = new Router();
      const live = registerLiveRoutes(router, { worker, jobs, webRoot: WEB_ROOT, cacheDir, services });
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
        services,
        sdkVariant,
      });
      // The boot queue kick may start a plugin mesher; wait for the live registry.
      void registryReady.finally(() => live.boot());

      server.middlewares.use(async (req, res, next) => {
        try {
          const url = String(req.url || '');
          if (!url.startsWith('/api/') && !url.startsWith('/plugins/') && !url.startsWith('/plugin-sdk/')) {
            next();
            return;
          }
          // Plugin workspace frames have an opaque origin (Origin: null); they may GET
          // the SDK and their own workspace files, and nothing else.
          if (!isFrameAssetRequest(req.method, url)) assertSameOrigin(req);
          if (!registrySettled) {
            // First requests after boot: bounded wait so plugin keys resolve.
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([registryReady, new Promise((r) => (timer = setTimeout(r, 20_000)))]);
            if (timer) clearTimeout(timer);
          }
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
  return {
    name: 'cfd-case-fields-api',
    configureServer: (server: Parameters<typeof install>[0]) => install(server, 'dev'),
    configurePreviewServer: (server: Parameters<typeof install>[0]) => install(server, 'prod'),
  };
}

export default createApiPlugin;
