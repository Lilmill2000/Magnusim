import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router, dispatch } from '../router.ts';

describe('Router', () => {
  it('matches params and prefers the first registered route', () => {
    const router = new Router();
    const hits = [];
    router.get('/api/project/hydrate', () => {
      hits.push('hydrate');
    });
    router.get('/api/project/:id', (ctx) => {
      hits.push(ctx.params.id);
    });
    const a = router.match('GET', '/api/project/hydrate');
    assert.ok(a && 'route' in a);
    const b = router.match('GET', '/api/project/abc');
    assert.equal(b.params.id, 'abc');
  });

  it('registers underscore aliases', () => {
    const router = new Router();
    router.get('/api/simulation-control', () => undefined);
    assert.ok(router.match('GET', '/api/simulation_control') && 'route' in router.match('GET', '/api/simulation_control'));
  });

  it('returns 405 vs 404', async () => {
    const router = new Router();
    router.get('/api/prefs', () => undefined);
    const notFound = router.match('GET', '/api/nope');
    assert.equal(notFound, null);
    const wrong = router.match('POST', '/api/prefs');
    assert.ok(wrong && 'allow' in wrong);
    assert.deepEqual(wrong.allow, ['GET', 'HEAD']);

    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end() {},
    };
    const handled405 = await dispatch(router, { method: 'POST', url: '/api/prefs' }, res);
    assert.equal(handled405, true);
    assert.equal(res.statusCode, 405);
    const handled404 = await dispatch(router, { method: 'GET', url: '/api/nope' }, res);
    assert.equal(handled404, false);
  });

  it('captures wildcard rest', () => {
    const router = new Router();
    router.get('/plugins/:key/ui/**rest', () => undefined);
    const m = router.match('GET', '/plugins/example/ui/index.js');
    assert.ok(m && 'params' in m);
    assert.equal(m.params.key, 'example');
    assert.equal(m.params.rest, 'index.js');
  });
});
