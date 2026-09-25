import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Router, dispatch } from '../router.ts';
import { caseDetachAllowed, PROJECTS_ROOT } from '../../project-isolation.js';

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

function postJson(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = url;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

describe('case detach scope', () => {
  const previous = process.env.MAGNUSIM_STRICT_SCOPE;
  afterEach(() => {
    if (previous === undefined) delete process.env.MAGNUSIM_STRICT_SCOPE;
    else process.env.MAGNUSIM_STRICT_SCOPE = previous;
  });

  it('only detaches a case that belongs to the requesting project', () => {
    const caseA = join(PROJECTS_ROOT, 'proj-a', 'geometries', 'g', 'simulations', 's', 'meshes', 'm', 'case');
    assert.equal(caseDetachAllowed(null, 'proj-a'), true);
    assert.equal(caseDetachAllowed(caseA, 'proj-a'), true);
    assert.equal(caseDetachAllowed(caseA, 'proj-b'), false);
    assert.equal(caseDetachAllowed(caseA, ''), false);
  });

  it('needs project_id under strict scope and passes it to the handler', async () => {
    process.env.MAGNUSIM_STRICT_SCOPE = '1';
    const router = new Router();
    const seen = [];
    router.post('/api/case/detach', (ctx) => {
      seen.push(ctx.scope.projectId);
      ctx.sendJson(200, { ok: true });
    });

    const bare = mockRes();
    await dispatch(router, postJson('/api/case/detach', {}), bare);
    assert.equal(bare.statusCode, 400);

    const scoped = mockRes();
    await dispatch(router, postJson('/api/case/detach', { project_id: 'proj-a' }), scoped);
    assert.equal(scoped.statusCode, 200);
    assert.deepEqual(seen, ['proj-a']);
  });
});
