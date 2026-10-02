import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('gate:h0-leak', () => {
  const previousRoot = process.env.MAGNUSIM_PROJECTS_ROOT;
  const previousStrict = process.env.MAGNUSIM_STRICT_SCOPE;
  let root = '';

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.MAGNUSIM_PROJECTS_ROOT;
    else process.env.MAGNUSIM_PROJECTS_ROOT = previousRoot;
    if (previousStrict === undefined) delete process.env.MAGNUSIM_STRICT_SCOPE;
    else process.env.MAGNUSIM_STRICT_SCOPE = previousStrict;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('keeps study meshes apart and rejects another project case_dir', async () => {
    root = mkdtempSync(join(tmpdir(), 'magnusim-h0-leak-'));
    process.env.MAGNUSIM_PROJECTS_ROOT = root;
    process.env.MAGNUSIM_STRICT_SCOPE = '1';
    writeFileSync(join(root, 'active.json'), JSON.stringify({ project_id: 'proj-a' }));

    const layout = await import('../../project-layout.js');
    const a = join(root, 'proj-a');
    const b = join(root, 'proj-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    layout.createGeometryFolder(a, { id: 'ga', name: 'A', original_filename: 'a.step' });
    layout.createGeometryFolder(b, { id: 'gb', name: 'B', original_filename: 'b.step' });
    layout.createStudyFolder(a, 'ga', { id: 'sa', name: 'Study A' });
    layout.createStudyFolder(b, 'gb', { id: 'sb', name: 'Study B' });
    const mesh = layout.createMeshFolder(a, 'sa', { id: 'mesh-a', name: 'Mesh A' });
    assert.deepEqual(layout.walkMeshes(a, 'sa').map((m) => m.id), ['mesh-a']);
    assert.deepEqual(layout.walkMeshes(b, 'sb').map((m) => m.id), []);
    assert.deepEqual(layout.walkMeshes(a, 'sb'), []);

    const { Router, dispatch } = await import('../router.ts');
    const { getBcs } = await import('../../w19-boundary-conditions.js');
    assert.throws(() => getBcs(), /project_id required/);
    const looked = getBcs('proj-b');
    assert.equal(looked.body.project_id, 'proj-b');

    const router = new Router();
    router.get('/api/mesh/generate', (ctx) => ctx.sendJson(200, { ok: true }));
    router.get('/api/filter/:key', (ctx) => ctx.sendJson(200, { ok: true }));
    const caseDir = encodeURIComponent(mesh.case_dir);
    const foreign = mockRes();
    const hit = await dispatch(
      router,
      {
        method: 'GET',
        url: `/api/mesh/generate?project_id=proj-b&simulation_id=sb&case_dir=${caseDir}`,
        headers: {},
      },
      foreign,
    );
    assert.equal(hit, true);
    assert.equal(foreign.statusCode, 403);

    const filter = mockRes();
    const filterHit = await dispatch(
      router,
      {
        method: 'GET',
        url: `/api/filter/cut_plane?project_id=proj-b&simulation_id=sb&case_dir=${caseDir}`,
        headers: {},
      },
      filter,
    );
    assert.equal(filterHit, true);
    assert.equal(filter.statusCode, 403);

    const { scopedCacheDir, getCaseFieldApi } = await import('../../vite-plugin-case-fields.js');
    const cacheA = scopedCacheDir(join(root, 'cache'), 'C:/data/projects/proj-a/meshes/case');
    const cacheB = scopedCacheDir(join(root, 'cache'), 'C:/data/projects/proj-b/meshes/case');
    assert.match(cacheA, /proj-a/);
    assert.match(cacheB, /proj-b/);
    assert.notEqual(cacheA, cacheB);

    // H15: a plugin study's case attaches only with its plugin and study; the
    // `case` and `path` aliases are gone; the core study rule applies only where
    // the case really is (under geometries/ or simulations/ of the project).
    const { Readable } = await import('node:stream');
    const pluginStudy = (sid) => join(a, 'plugins', 'foam-demo', 'studies', sid);
    for (const sid of ['st1', 'st2']) {
      mkdirSync(join(pluginStudy(sid), 'cases', 'c1'), { recursive: true });
      writeFileSync(join(pluginStudy(sid), 'study.json'), JSON.stringify({ id: sid }));
    }
    mkdirSync(join(pluginStudy('st1'), 'simulations', 'aoa-5'), { recursive: true });
    const ownCase = join(pluginStudy('st1'), 'cases', 'c1');
    const otherStudyCase = join(pluginStudy('st2'), 'cases', 'c1');
    const aoa = join(pluginStudy('st1'), 'simulations', 'aoa-5');
    const scoped = new Router();
    scoped.get('/api/case/probe', (ctx) => ctx.sendJson(200, { ok: true }));
    const probe = async (fields) => {
      const res = mockRes();
      await dispatch(scoped, { method: 'GET', url: `/api/case/probe?${new URLSearchParams(fields)}`, headers: {} }, res);
      return res.statusCode;
    };
    const st1 = { plugin: 'foam-demo', plugin_study_id: 'st1' };
    assert.equal(await probe({ project_id: 'proj-a', case_dir: ownCase, ...st1 }), 200, 'own plugin study');
    assert.equal(await probe({ project_id: 'proj-a', case_dir: otherStudyCase, ...st1 }), 403, 'another study');
    assert.equal(await probe({ project_id: 'proj-b', case_dir: ownCase, ...st1 }), 403, 'another project');
    assert.equal(await probe({ project_id: 'proj-a', case_dir: ownCase, plugin: 'foam-demo' }), 400, 'plugin without its study');
    assert.equal(await probe({ project_id: 'proj-a', case_dir: ownCase }), 403, 'no plugin fields');
    assert.equal(await probe({ project_id: 'proj-a', case_dir: aoa, ...st1 }), 200, 'a plugin case under simulations/');

    const { registerLiveRoutes } = await import('../live-routes.js');
    const liveRouter = new Router();
    registerLiveRoutes(liveRouter, { worker: { on() {}, call: async () => ({}) }, jobs: null, services: null });
    const attach = async (body) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method: 'POST', url: '/api/case/attach', headers: { 'content-type': 'application/json' } });
      const res = mockRes();
      await dispatch(liveRouter, req, res);
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    for (const alias of ['path', 'case']) {
      const r = await attach({ project_id: 'proj-a', [alias]: ownCase });
      assert.deepEqual([r.status, r.body.error], [400, 'use case_dir'], alias);
    }
    assert.equal((await attach({ project_id: 'proj-a', case_dir: ownCase, ...st1 })).status, 200);
    assert.equal((await attach({ project_id: 'proj-a', case_dir: aoa, ...st1 })).status, 200, 'no simulation_id needed there');
    assert.equal((await attach({ project_id: 'proj-a', case_dir: otherStudyCase, ...st1 })).status, 403);
    assert.equal((await attach({ project_id: 'proj-a', case_dir: ownCase })).status, 403);
    const direct = getCaseFieldApi().attachCaseDir(otherStudyCase, 'proj-a', '', { plugin: 'foam-demo', studyId: 'st1' });
    assert.deepEqual([direct.status, direct.body.error], [403, 'case_dir is not in this plugin study']);
    const noScope = getCaseFieldApi().attachCaseDir(ownCase, 'proj-a', '', null);
    assert.equal(noScope.status, 403);

    // Only the real folder counts: a junction inside st1 that leads to st2's case is not st1's.
    if (process.platform === 'win32') {
      const link = join(pluginStudy('st1'), 'cases', 'link');
      symlinkSync(otherStudyCase, link, 'junction');
      assert.equal(await probe({ project_id: 'proj-a', case_dir: link, ...st1 }), 403, 'a junction out of the study');
      assert.equal((await attach({ project_id: 'proj-a', case_dir: link, ...st1 })).status, 403);
      unlinkSync(link);
    }
    // A study folder with no study.json (a deleted study) is no study.
    const st3Case = join(pluginStudy('st3'), 'cases', 'c1');
    mkdirSync(st3Case, { recursive: true });
    const st3 = { plugin: 'foam-demo', plugin_study_id: 'st3' };
    assert.equal(await probe({ project_id: 'proj-a', case_dir: st3Case, ...st3 }), 403, 'no study.json');
    assert.equal((await attach({ project_id: 'proj-a', case_dir: st3Case, ...st3 })).status, 403);
  });
});
