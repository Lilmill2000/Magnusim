// Underscore aliases (the router adds one for every hyphenated route): scoped and answered
// like their routes. Also: DELETE /api/materials is no route, and src/api/routes.gen.ts
// lists only real routes.
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-route-aliases-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(join(PROJECTS, 'pa'), { recursive: true });
writeFileSync(join(PROJECTS, 'pa', 'project.json'), JSON.stringify({ id: 'pa', title: 'pa' }));
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const { Router, dispatch, pathNeedsProject } = await import('../router.ts');
const { API_ROUTES } = await import('../../../src/api/routes.gen.ts');

after(() => rmSync(ROOT, { recursive: true, force: true }));

class FakeWorker {
  on() {}
  async call(method) {
    if (method === 'plugins.list') return { plugins: [] };
    return { ok: true };
  }
}

/** The app's router, as index.ts builds it: live, phase 3 and VTK export routes. */
async function appRouter() {
  const { registerLiveRoutes } = await import('../live-routes.js');
  const { registerPhase3Routes } = await import('../routes.ts');
  const { registerVtkExportRoutes } = await import('../vtk-export.ts');
  const { JobManager } = await import('../jobs.ts');
  const router = new Router();
  const worker = new FakeWorker();
  const jobs = new JobManager({ cacheDir: join(ROOT, 'jobs') });
  registerLiveRoutes(router, { worker, jobs, services: null });
  registerPhase3Routes(router, {
    worker,
    jobs,
    webRoot: ROOT,
    cacheDir: join(ROOT, 'cache'),
    serveLegacyFilter: async () => {},
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
    envInstaller: () => ({ get: () => null, start: () => ({ state: 'installing', log: [] }) }),
  });
  registerVtkExportRoutes(router, { jobs, cacheDir: join(ROOT, 'cache') });
  return router;
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      this.body = payload || '';
    },
  };
}

async function send(router, method, url) {
  const res = mockRes();
  const handled = await dispatch(router, { method, url, headers: {} }, res);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

/** A path a request can carry: params and wildcards filled in. */
const concrete = (path) => path.replace(/:[A-Za-z]+/g, 'x').replace(/\*\*[A-Za-z]*/g, 'x');

describe('underscore aliases', () => {
  const previous = process.env.MAGNUSIM_STRICT_SCOPE;
  afterEach(() => {
    if (previous === undefined) delete process.env.MAGNUSIM_STRICT_SCOPE;
    else process.env.MAGNUSIM_STRICT_SCOPE = previous;
  });

  it('every alias is scoped like its hyphenated route', async () => {
    const routes = (await appRouter()).list();
    const aliases = routes.filter((r) => r.alias);
    assert.ok(aliases.length > 20, 'the app registers aliases');
    for (const alias of aliases) {
      const own = routes.find((r) => !r.alias && r.path.replace(/-/g, '_') === alias.path);
      if (!own) continue;
      assert.equal(pathNeedsProject(concrete(alias.path)), pathNeedsProject(concrete(own.path)), alias.path);
    }
    for (const p of ['/api/simulation_control', '/api/result_controls', '/api/area_average', '/api/plugin_cases/status', '/api/plugin_files/list']) {
      assert.equal(pathNeedsProject(p), true, p);
    }
  });

  it('strict scope refuses an alias without project_id as it refuses the route', async () => {
    process.env.MAGNUSIM_STRICT_SCOPE = '1';
    // Handlers that check nothing themselves: the router's check alone.
    const router = new Router();
    const paths = ['/api/simulation-control', '/api/result-controls', '/api/area-average', '/api/plugin-cases/status'];
    for (const path of paths) router.get(path, (ctx) => ctx.sendJson(200, { ok: true }));
    for (const path of paths) {
      for (const p of [path, path.replace(/-/g, '_')]) {
        const r = await send(router, 'GET', p);
        assert.deepEqual([r.handled, r.status, r.body && r.body.error], [true, 400, 'project_id required'], p);
      }
    }
  });

  it('a wrapped handler answers its alias as it answers its route', async () => {
    const router = await appRouter();
    for (const path of ['/api/mesh-refinements', '/api/simulation-control', '/api/result-controls', '/api/area-average']) {
      const own = await send(router, 'GET', `${path}?project_id=pa`);
      const alias = await send(router, 'GET', `${path.replace(/-/g, '_')}?project_id=pa`);
      assert.equal(own.handled, true, path);
      assert.equal(alias.handled, true, `${path} alias falls through (404)`);
      assert.equal(alias.status, own.status, path);
      assert.deepEqual(alias.body, own.body, path);
    }
  });
});

describe('/api/materials', () => {
  it('has no DELETE: deletes go through POST {delete: true}', async () => {
    const router = await appRouter();
    const r = await send(router, 'DELETE', '/api/materials?project_id=pa');
    assert.equal(r.status, 405);
    assert.ok(!String(r.headers.Allow).includes('DELETE'), r.headers.Allow);
  });
});

describe('src/api/routes.gen.ts', () => {
  it('lists only routes the app registers, with their methods', async () => {
    const router = await appRouter();
    assert.ok(API_ROUTES.length > 50);
    for (const { method, path } of API_ROUTES) {
      assert.ok(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method), `${method} ${path}`);
      assert.match(path, /^\/[A-Za-z_]/, `${method} ${path} is no path`);
      // Test routes are registered only with their switch.
      if (path.startsWith('/api/test/')) continue;
      const found = router.match(method, concrete(path));
      assert.ok(found && 'route' in found, `${method} ${path} is not a registered route`);
    }
  });
});
