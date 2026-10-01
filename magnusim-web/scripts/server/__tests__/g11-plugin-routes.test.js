// G11: a plugin that is off (an optional bundled one that ships off among them)
// is never run: its UI and workspace files are not served, and turning a plugin
// on or off takes a plugin key only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../jobs.ts';
import { Router, dispatch } from '../router.ts';
import { registerPhase3Routes } from '../routes.ts';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('an off plugin serves no UI or workspace files; enable and disable take a plugin key', async () => {
  const saved = process.env.MAGNUSIM_BUNDLED_DIR;
  delete process.env.MAGNUSIM_BUNDLED_DIR;
  const root = mkdtempSync(join(tmpdir(), 'magnusim-g11-routes-'));
  const folder = join(root, 'bundled-plugins', 'opt-demo');
  mkdirSync(join(folder, 'ui'), { recursive: true });
  mkdirSync(join(folder, 'workspace'), { recursive: true });
  writeFileSync(join(folder, 'ui', 'index.js'), 'export function register() {}\n');
  writeFileSync(join(folder, 'workspace', 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>');
  let status = 'disabled';
  const calls = [];
  const worker = {
    async call(method, params) {
      calls.push(method);
      if (method === 'plugins.list') {
        return { plugins: [{ key: 'opt-demo', tier: 'bundled', dir: 'opt-demo', ui: 'ui', status }] };
      }
      if (method === 'plugins.enable' || method === 'plugins.disable') return { ok: true, plugins: [] };
      return {};
    },
  };
  const router = new Router();
  registerPhase3Routes(router, {
    worker,
    jobs: new JobManager({ cacheDir: join(root, 'cache-jobs') }),
    webRoot: root,
    cacheDir: join(root, 'cache'),
    serveLegacyFilter: async () => {},
    startMeshJob() {},
    startSolveJob() {},
    startCadImportJob() {},
    caseSnapshot: () => ({}),
    attachCaseDir: () => ({ ok: true, status: 200, body: {} }),
    resetCaseIdle() {},
  });
  const server = await listen((req, res) => dispatch(router, req, res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/plugins/opt-demo/ui/index.js`)).status, 404);
    assert.equal((await fetch(`${base}/plugins/opt-demo/workspace/index.html`)).status, 404);
    // Turned on (through the route, which also drops the cached list).
    status = 'enabled';
    const on = await fetch(`${base}/api/plugins/opt-demo/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(on.status, 200);
    assert.equal((await fetch(`${base}/plugins/opt-demo/ui/index.js`)).status, 200);
    assert.equal((await fetch(`${base}/plugins/opt-demo/workspace/index.html`)).status, 200);
    // Only a plugin that is on: one that needs setup gets no UI, nor does a key the app does not list.
    status = 'needs setup';
    await fetch(`${base}/api/plugins/opt-demo/disable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await fetch(`${base}/plugins/opt-demo/ui/index.js`)).status, 404);
    assert.equal((await fetch(`${base}/plugins/not-listed/ui/index.js`)).status, 404);
    status = 'enabled';
    await fetch(`${base}/api/plugins/opt-demo/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    // A key that is not a plugin key never reaches the worker. (fetch resolves a bare
    // "%2E%2E" segment itself, so only keys that survive the URL reach the route.)
    const before = calls.filter((m) => m === 'plugins.enable' || m === 'plugins.disable').length;
    for (const bad of ['..%2F..%2Fx', 'a%20b', 'x.', '-lead', 'a%5Cb']) {
      const r = await fetch(`${base}/api/plugins/${bad}/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 400, bad);
      const d = await fetch(`${base}/api/plugins/${bad}/disable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(d.status, 400, bad);
    }
    assert.equal(calls.filter((m) => m === 'plugins.enable' || m === 'plugins.disable').length, before);
  } finally {
    server.close();
    if (saved != null) process.env.MAGNUSIM_BUNDLED_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
