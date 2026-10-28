import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { jsonBodyLimit, PLUGIN_DATA_BODY_LIMIT } from '../http.ts';
import { pluginSdkFile, pluginSdkInfo, SDK_FILES, SDK_IMPORTS } from '../plugin-sdk.ts';
import { dispatch, Router } from '../router.ts';
import { injectWorkspaceHead, isFrameAssetRequest, LOOK_SCRIPT, workspaceCsp } from '../workspace-files.ts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function directives(csp) {
  return Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

test('a workspace page may load the SDK and its own folder, fetch only its own folder, and embed nowhere else', () => {
  const d = directives(workspaceCsp('127.0.0.1:5173', 'ws-demo'));
  const own = 'http://127.0.0.1:5173/plugins/ws-demo/workspace/';
  const sdk = 'http://127.0.0.1:5173/plugin-sdk/';
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], [own]);
  assert.deepEqual(d['worker-src'], ['blob:']);
  assert.deepEqual(d['frame-ancestors'], ["'self'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['img-src'], [own, 'data:', 'blob:']);
  // Scripts: the SDK, its own files, blob workers, WASM, and the host's import map and pre-paint by
  // hash; no eval, no other inline script.
  const scripts = d['script-src'];
  assert.deepEqual(scripts.slice(0, 4), [sdk, own, 'blob:', "'wasm-unsafe-eval'"]);
  for (const hash of scripts.slice(4)) assert.match(hash, /^'sha256-[A-Za-z0-9+/]+=*'$/);
  assert.equal(scripts.length, 6);
  assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"));
  // Another plugin's folder, the app's API and the app's own scripts are none of these.
  const everything = Object.values(d).flat().join(' ');
  assert.doesNotMatch(everything, /\/api\//);
  assert.doesNotMatch(everything, /\/plugins\/(?!ws-demo\/workspace\/)/);
});

test("the host's pre-paint and import map go first in the head, and the CSP allows exactly them", () => {
  const html = injectWorkspaceHead('<!doctype html><html><head><title>Bench</title></head><body></body></html>');
  const m = html.match(
    /<head><script>(.*?)<\/script><script type="importmap">(.*?)<\/script><link rel="stylesheet" href="\/plugin-sdk\/theme.css"><link rel="stylesheet" href="\/plugin-sdk\/plugin-ui.css"><title>/,
  );
  assert.ok(m, html);
  assert.equal(m[1], LOOK_SCRIPT);
  assert.deepEqual(JSON.parse(m[2]), { imports: SDK_IMPORTS });
  for (const text of [m[1], m[2]]) {
    const hash = createHash('sha256').update(text).digest('base64');
    assert.ok(workspaceCsp('h:1', 'k').includes(`'sha256-${hash}'`));
  }
  // A page without a head still gets them, first, but after its doctype (standards mode kept).
  assert.match(injectWorkspaceHead('<p>x</p>'), /^<script>.*?<\/script><script type="importmap">/);
  assert.match(injectWorkspaceHead('<HEAD lang="en"><p>x</p>'), /^<HEAD lang="en"><script>.*?<\/script><script type="importmap">/);
  assert.match(injectWorkspaceHead('<!DOCTYPE html>\n<html><body><p>x</p>'), /^<!DOCTYPE html><script>.*?<\/script><script type="importmap">.*\n<html><body><p>x<\/p>$/s);
  assert.match(injectWorkspaceHead('<!doctype html><p>x</p>', { theme: 'dark', text_scale: 1, icon_scale: 1 }), /^<!doctype html><meta name="magnusim-look" content="[^"]*"><script>/);
});

test('only GET/HEAD of the SDK and workspace folders skip the same-origin check', () => {
  for (const url of ['/plugin-sdk/react.js', '/plugins/ws-demo/workspace/index.html', '/plugins/ws-demo/workspace/a/b.wasm?v=1']) {
    assert.equal(isFrameAssetRequest('GET', url), true, url);
    assert.equal(isFrameAssetRequest('HEAD', url), true, url);
    assert.equal(isFrameAssetRequest('POST', url), false, url);
    assert.equal(isFrameAssetRequest('PUT', url), false, url);
  }
  for (const url of [
    '/api/plugins',
    '/plugins/ws-demo/ui/index.js',
    '/plugins/ws-demo/workspace',
    '/plugin-sdk',
    // The router matches these as /api/... (dot segments resolved): the check applies.
    '/plugins/ws-demo/workspace/../../../api/plugins',
    '/plugins/ws-demo/workspace/%2e%2e/%2e%2e/%2e%2e/api/plugins',
    '/plugin-sdk/../api/plugins',
    '/plugin-sdk/%2E%2E/api/project/tree?project_id=x',
  ]) {
    assert.equal(isFrameAssetRequest('GET', url), false, url);
  }
  assert.equal(new URL('/plugins/ws-demo/workspace/%2e%2e/%2e%2e/%2e%2e/api/plugins', 'http://h').pathname, '/api/plugins');
});

test("a plugin data write carries the documented 8 MB; other JSON bodies keep 2 MB", async () => {
  const router = new Router();
  const seen = [];
  const handler = async (ctx) => {
    const body = await ctx.readJsonBody();
    seen.push([ctx.pathname, String(body.doc || '').length]);
    ctx.sendJson(200, { ok: true });
  };
  router.post('/api/plugin-data/write', handler);
  router.post('/api/plugin-studies/update', handler);
  const post = async (url, docBytes) => {
    const raw = Buffer.from(JSON.stringify({ project_id: 'p', plugin: 'k', rel: 'a.json', doc: 'x'.repeat(docBytes) }));
    const req = Object.assign(Readable.from([raw]), { method: 'POST', url, headers: { 'content-type': 'application/json' } });
    const res = { statusCode: 0, body: '', setHeader() {}, end(t) { this.body = String(t || ''); } };
    await dispatch(router, req, res);
    return res.statusCode;
  };
  const MB = 1024 * 1024;
  assert.equal(await post('/api/plugin-data/write', 8 * MB - 200), 200);
  assert.equal(await post('/api/plugin-data/write', 10 * MB), 413);
  assert.equal(await post('/api/plugin-studies/update', 3 * MB), 413);
  assert.equal(await post('/api/plugin-studies/update', MB), 200);
  assert.deepEqual(seen.map((s) => s[0]), ['/api/plugin-data/write', '/api/plugin-studies/update']);
  assert.equal(jsonBodyLimit('/api/plugin-data/write'), PLUGIN_DATA_BODY_LIMIT);
});

test('the SDK serves its files in both variants, and nothing else', async () => {
  for (const variant of ['dev', 'prod']) {
    const react = await pluginSdkFile(WEB, variant, 'react.js');
    assert.match(react, /^import \{ React as M \} from '\.\/react-all\.js';/);
    assert.match(react, /\buseState\b/);
    assert.match(await pluginSdkFile(WEB, variant, 'jsx-runtime.js'), /\bjsx\b/);
    const bridge = await pluginSdkFile(WEB, variant, 'workspace.js');
    assert.match(bridge, /hello/);
    assert.doesNotMatch(bridge, /^import\s/m);
    assert.match(await pluginSdkFile(WEB, variant, 'theme.css'), /--mg-primary:/);
    assert.match(await pluginSdkFile(WEB, variant, 'workspace.d.ts'), /declare module '@magnusim\/workspace'/);
    for (const name of ['../package.json', 'react-all.js.map', 'index.html', '', 'REACT.JS']) {
      assert.equal(await pluginSdkFile(WEB, variant, name), null, name);
    }
  }
  // Every name in the import map is a file the SDK serves.
  for (const path of Object.values(SDK_IMPORTS)) {
    assert.ok(SDK_FILES.includes(path.replace('/plugin-sdk/', '')), path);
  }
  const info = pluginSdkInfo(WEB);
  assert.match(info.sdk_version, /^1\.\d+\.\d+$/);
  assert.match(info.react_version, /^19\./);
});
