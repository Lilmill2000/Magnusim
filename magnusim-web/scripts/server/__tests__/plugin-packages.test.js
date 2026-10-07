// Plugin packages (Settings > Plugins > Install plugin from zip): the upload is
// streamed to a file and checked by the worker before anything is installed; an
// install or a removal stops what runs from the plugin's folder first; only this
// PC may do either; an update's files are served from the plugins folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../jobs.ts';
import { Router, dispatch } from '../router.ts';
import { registerPhase3Routes } from '../routes.ts';
import { RpcError } from '../worker.ts';
import { saveUpload, UPLOAD_RE } from '../plugin-packages.ts';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function host(t, { answers = {} } = {}) {
  const saved = { b: process.env.MAGNUSIM_BUNDLED_DIR, p: process.env.MAGNUSIM_PLUGINS_DIR };
  delete process.env.MAGNUSIM_BUNDLED_DIR;
  delete process.env.MAGNUSIM_PLUGINS_DIR;
  const root = mkdtempSync(join(tmpdir(), 'magnusim-pkg-routes-'));
  const order = [];
  const worker = {
    async call(method, params) {
      order.push({ method, params });
      if (answers[method]) return answers[method](params);
      if (method === 'plugins.list') return { plugins: [] };
      return { ok: true, plugins: [] };
    },
  };
  const services = {
    reset(key, reason) {
      order.push({ method: 'services.reset', params: { key, reason } });
    },
    resetAll() {},
    forgetEnv() {},
  };
  const jobs = new JobManager({ cacheDir: join(root, 'cache-jobs') });
  const router = new Router();
  registerPhase3Routes(router, {
    worker,
    jobs,
    services,
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
  t.after(() => {
    server.close();
    for (const [k, v] of [['MAGNUSIM_BUNDLED_DIR', saved.b], ['MAGNUSIM_PLUGINS_DIR', saved.p]]) {
      if (v != null) process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, order, jobs, base: `http://127.0.0.1:${server.address().port}`, incoming: join(root, '.cache', 'plugin-incoming') };
}

const zipBytes = Buffer.from('PK\x03\x04 not really a zip, the worker is a fake');

test('the zip is saved as an upload and checked; nothing is installed until confirmed', async (t) => {
  const h = await host(t, {
    answers: {
      'plugins.package_inspect': ({ upload }) => ({ ok: true, package: { key: 'cad', name: 'CAD', version: '0.2.0', action: 'update', upload_seen: upload } }),
    },
  });
  const r = await fetch(`${h.base}/api/plugins/package/inspect`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipBytes });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.upload, UPLOAD_RE);
  assert.equal(body.package.upload_seen, body.upload);
  assert.deepEqual(readdirSync(h.incoming), [body.upload]);
  assert.deepEqual(h.order.map((c) => c.method), ['plugins.package_inspect']);
});

test('a refused zip says why in a word, and its upload is deleted', async (t) => {
  const h = await host(t, {
    answers: {
      'plugins.package_inspect': () => {
        throw new RpcError(-32602, 'CAD 0.1.0 is not newer than the copy that comes with Magnusim (0.1.0)', { code: 'not_newer' });
      },
    },
  });
  const r = await fetch(`${h.base}/api/plugins/package/inspect`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipBytes });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.reason, 'not_newer');
  assert.match(body.error, /not newer/);
  assert.deepEqual(readdirSync(h.incoming), []);
});

test('install stops the plugin (service, jobs, epoch) before the worker moves its folder', async (t) => {
  const h = await host(t, {
    answers: {
      'plugins.package_inspect': () => ({ ok: true, package: { key: 'cad', version: '0.2.0' } }),
      'plugins.package_install': () => ({ ok: true, plugins: [], installed: { key: 'cad' } }),
    },
  });
  const job = h.jobs.create('cad_thing', { project_id: 'p1' }, 'p1');
  h.jobs.get(job.id).plugin = 'cad';
  h.jobs.attachChild(job.id, { pid: null });
  const other = h.jobs.create('other_thing', { project_id: 'p1' }, 'p1');
  h.jobs.get(other.id).plugin = 'someone_else';
  h.jobs.attachChild(other.id, { pid: null });
  const upload = 'upload-0123456789abcdef.zip';
  mkdirSync(h.incoming, { recursive: true });
  writeFileSync(join(h.incoming, upload), zipBytes);
  const r = await fetch(`${h.base}/api/plugins/package/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload, key: 'cad' }),
  });
  assert.equal(r.status, 200);
  const methods = h.order.map((c) => c.method);
  assert.deepEqual(methods, ['plugins.package_inspect', 'services.reset', 'plugins.package_install']);
  assert.deepEqual(h.order.find((c) => c.method === 'plugins.package_install').params, { upload, key: 'cad' });
  assert.equal(h.jobs.get(job.id).status, 'stopped');
  assert.equal(h.jobs.get(other.id).status, 'running');
  assert.equal(existsSync(join(h.incoming, upload)), false);
});

test('a package that no longer checks out, or is another plugin, stops nothing', async (t) => {
  let answer = () => {
    throw new RpcError(-32004, 'the uploaded package is gone; choose the file again');
  };
  const h = await host(t, { answers: { 'plugins.package_inspect': () => answer() } });
  const send = () =>
    fetch(`${h.base}/api/plugins/package/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upload: 'upload-0123456789abcdef.zip', key: 'cad' }),
    });
  const gone = await send();
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /choose the file again/);
  answer = () => ({ ok: true, package: { key: 'airfoil', version: '9.0.0' } });
  const other = await send();
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /not the plugin that was confirmed/);
  assert.deepEqual(h.order.map((c) => c.method), ['plugins.package_inspect', 'plugins.package_inspect']);
});

test('bad upload names and keys never reach the worker', async (t) => {
  const h = await host(t);
  for (const body of [{ upload: '../../x.zip', key: 'cad' }, { upload: 'upload-0123456789abcdef.zip', key: '..' }, {}]) {
    const r = await fetch(`${h.base}/api/plugins/package/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await fetch(`${h.base}/api/plugins/a%20b/remove`, { method: 'POST' })).status, 400);
  assert.deepEqual(h.order, []);
});

test('only a browser on this PC may install or remove (the public tunnel may not)', async (t) => {
  const h = await host(t);
  const tunnel = { 'x-forwarded-for': '203.0.113.9' };
  const a = await fetch(`${h.base}/api/plugins/package/inspect`, { method: 'POST', headers: { ...tunnel, 'content-type': 'application/zip' }, body: zipBytes });
  const b = await fetch(`${h.base}/api/plugins/package/install`, {
    method: 'POST',
    headers: { ...tunnel, 'content-type': 'application/json' },
    body: JSON.stringify({ upload: 'upload-0123456789abcdef.zip', key: 'cad' }),
  });
  const c = await fetch(`${h.base}/api/plugins/cad/remove`, { method: 'POST', headers: tunnel });
  assert.deepEqual([a.status, b.status, c.status], [403, 403, 403]);
  assert.equal(existsSync(h.incoming) ? readdirSync(h.incoming).length : 0, 0);
  assert.deepEqual(h.order, []);
});

test('remove stops the plugin, then asks the worker', async (t) => {
  const h = await host(t, { answers: { 'plugins.remove_copies': () => ({ ok: true, plugins: [], removed: { key: 'cad', removed: ['cad'] } }) } });
  const r = await fetch(`${h.base}/api/plugins/cad/remove`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    h.order.map((c) => c.method),
    ['services.reset', 'plugins.remove_copies'],
  );
});

test("an update's UI is served from the plugins folder, the app's own copy from bundled-plugins", async (t) => {
  let copy = 'update';
  const h = await host(t, {
    answers: {
      'plugins.list': () => ({
        plugins: [{ key: 'cad', tier: 'bundled', root: copy === 'update' ? 'user' : 'bundled', dir: 'cad', ui: 'ui', status: 'enabled' }],
      }),
    },
  });
  for (const [where, text] of [['plugins', 'the update'], ['bundled-plugins', 'the app copy']]) {
    mkdirSync(join(h.root, where, 'cad', 'ui'), { recursive: true });
    writeFileSync(join(h.root, where, 'cad', 'ui', 'index.js'), `export const which = '${text}';\n`);
  }
  assert.match(await (await fetch(`${h.base}/plugins/cad/ui/index.js`)).text(), /the update/);
  copy = 'app';
  // The list is cached briefly; a removal drops it (as the route does).
  await fetch(`${h.base}/api/plugins/cad/remove`, { method: 'POST' });
  assert.match(await (await fetch(`${h.base}/plugins/cad/ui/index.js`)).text(), /the app copy/);
});

test('an upload over the limit is refused by its Content-Length, or as it arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magnusim-pkg-upload-'));
  try {
    const declared = new PassThrough();
    declared.headers = { 'content-length': '100' };
    await assert.rejects(saveUpload(declared, dir, 10), (err) => err.status === 413);
    const streamed = new PassThrough();
    streamed.headers = {};
    const saving = saveUpload(streamed, dir, 10);
    streamed.write(Buffer.alloc(8));
    streamed.end(Buffer.alloc(8));
    await assert.rejects(saving, (err) => err.status === 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(readdirSync(dir), []);
    const empty = new PassThrough();
    empty.headers = {};
    const none = saveUpload(empty, dir, 10);
    empty.end();
    await assert.rejects(none, (err) => err.status === 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what runs on a plugin is listed for the confirm card: its jobs, not another plugin's", async (t) => {
  const h = await host(t, {
    answers: { 'plugins.package_inspect': () => ({ ok: true, package: { key: 'cad', name: 'CAD', version: '0.2.0', action: 'update' } }) },
  });
  const job = h.jobs.create('cad_export', { project_id: 'p1' }, 'p1');
  h.jobs.get(job.id).plugin = 'cad';
  h.jobs.attachChild(job.id, { pid: null });
  const other = h.jobs.create('xfoil_run', { project_id: 'p1' }, 'p1');
  h.jobs.get(other.id).plugin = 'airfoil';
  h.jobs.attachChild(other.id, { pid: null });
  const work = await (await fetch(`${h.base}/api/plugins/cad/work`)).json();
  assert.deepEqual(work.work, { running: ['cad_export'], queued: [] });
  const inspected = await (
    await fetch(`${h.base}/api/plugins/package/inspect`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipBytes })
  ).json();
  assert.deepEqual(inspected.work, { running: ['cad_export'], queued: [] });
  assert.equal((await fetch(`${h.base}/api/plugins/a%20b/work`)).status, 400);
});
