import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../jobs.ts';
import { Router, dispatch } from '../router.ts';

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

describe('gate:h0-jobs-scoped', () => {
  it('requires a project and does not stop another project job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'magnusim-h0-jobs-'));
    try {
      const jobs = new JobManager({ cacheDir: dir });
      assert.throws(() => jobs.create('mesh', {}), /project_id required/);
      assert.throws(() => jobs.create('mesh', { project_id: 'a' }), /simulation_id required/);
      assert.throws(() => jobs.create('cad_import', { project_id: 'a' }), /geometry_id required/);
      const job = jobs.create('solve', { project_id: 'a', simulation_id: 's1' }, 'a');
      assert.equal(jobs.stop(job.id, 'b'), null);
      assert.equal(jobs.get(job.id).status, 'queued');
      assert.equal(jobs.stop(job.id, 'a').status, 'stopped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gate:h0-scope-strict', () => {
  const previous = process.env.MAGNUSIM_STRICT_SCOPE;
  afterEach(() => {
    if (previous === undefined) delete process.env.MAGNUSIM_STRICT_SCOPE;
    else process.env.MAGNUSIM_STRICT_SCOPE = previous;
  });

  it('rejects a workbench route without project_id and a foreign case_dir', async () => {
    process.env.MAGNUSIM_STRICT_SCOPE = '1';
    const router = new Router();
    router.get('/api/mesh', (ctx) => ctx.sendJson(200, { ok: true }));
    router.get('/api/case', (ctx) => ctx.sendJson(200, { ok: true }));

    const missing = mockRes();
    const missingHit = await dispatch(
      router,
      { method: 'GET', url: '/api/mesh', headers: {} },
      missing,
    );
    assert.equal(missingHit, true);
    assert.equal(missing.statusCode, 400);

    const foreign = mockRes();
    const foreignHit = await dispatch(
      router,
      {
        method: 'GET',
        url: '/api/case?project_id=proj-a&simulation_id=study-a&case_dir=C%3A%5CWindows',
        headers: {},
      },
      foreign,
    );
    assert.equal(foreignHit, true);
    assert.equal(foreign.statusCode, 403);

    router.post('/api/mesh', (ctx) => ctx.sendJson(200, { ok: true }));
    const posted = mockRes();
    const postedHit = await dispatch(
      router,
      { method: 'POST', url: '/api/mesh', headers: {} },
      posted,
    );
    assert.equal(postedHit, true);
    assert.equal(posted.statusCode, 400);

    const { Readable } = await import('node:stream');
    const body = Buffer.from(JSON.stringify({
      project_id: 'proj-b',
      simulation_id: 'study-b',
      case_dir: 'C:\\Windows',
    }));
    const req = Readable.from([body]);
    req.method = 'POST';
    req.url = '/api/mesh';
    req.headers = { 'content-type': 'application/json' };
    const foreignBody = mockRes();
    const foreignBodyHit = await dispatch(router, req, foreignBody);
    assert.equal(foreignBodyHit, true);
    assert.equal(foreignBody.statusCode, 403);
  });
});
