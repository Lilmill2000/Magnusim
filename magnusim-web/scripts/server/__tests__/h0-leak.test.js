import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

    const { scopedCacheDir } = await import('../../vite-plugin-case-fields.js');
    const cacheA = scopedCacheDir(join(root, 'cache'), 'C:/data/projects/proj-a/meshes/case');
    const cacheB = scopedCacheDir(join(root, 'cache'), 'C:/data/projects/proj-b/meshes/case');
    assert.match(cacheA, /proj-a/);
    assert.match(cacheB, /proj-b/);
    assert.notEqual(cacheA, cacheB);
  });
});
