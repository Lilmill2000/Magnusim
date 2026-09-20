import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFilterKey, LEGACY_FILTER_PATHS } from '../legacy-aliases.ts';
import { Router } from '../router.ts';
import { registerPhase3Routes } from '../routes.ts';

describe('legacy filter aliases', () => {
  it('maps hyphen and underscore keys', () => {
    assert.equal(canonicalFilterKey('cut-plane'), 'cut_plane');
    assert.equal(canonicalFilterKey('particle-trace'), 'particle_trace');
    assert.equal(canonicalFilterKey('mesh/section'), 'mesh/section');
    assert.equal(canonicalFilterKey('iso_volume'), 'iso_volume');
  });

  it('routes /api/cut-plane and /api/filter/cut_plane to the same key', async () => {
    const keys = [];
    const worker = {
      async call(method) {
        if (method === 'filter.validate') return { ok: true };
        return {};
      },
    };
    const router = new Router();
    registerPhase3Routes(router, {
      worker,
      jobs: { create() {}, get() { return null; }, list() { return []; }, stop() { return null; }, onEvents() { return { on() {}, off() {} }; } },
      webRoot: '.',
      cacheDir: '.',
      serveLegacyFilter: async (_ctx, key) => {
        keys.push(key);
      },
      startMeshJob() {},
      startSolveJob() {},
      startCadImportJob() {},
      caseSnapshot: () => ({}),
      attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
      resetCaseIdle() {},
    });
    const fake = () => ({
      req: { method: 'GET', headers: {}, url: '/api/cut-plane', on() {} },
      res: { statusCode: 200, setHeader() {}, end() {} },
      url: new URL('http://127.0.0.1/api/cut-plane'),
      method: 'GET',
      params: {},
      pathname: '/api/cut-plane',
      sendJson() {},
      readJsonBody: async () => ({}),
    });
    const cut = router.match('GET', '/api/cut-plane');
    assert.ok(cut && 'route' in cut);
    await cut.route.handler({ ...fake(), params: cut.params, pathname: '/api/cut-plane' });
    const filt = router.match('GET', '/api/filter/cut_plane');
    assert.ok(filt && 'route' in filt);
    await filt.route.handler({
      ...fake(),
      params: filt.params,
      pathname: '/api/filter/cut_plane',
      url: new URL('http://127.0.0.1/api/filter/cut_plane'),
    });
    assert.deepEqual(keys, ['cut_plane', 'cut_plane']);
    assert.ok(LEGACY_FILTER_PATHS.some((a) => a.path === '/api/cut-plane' && a.key === 'cut_plane'));
  });
});
