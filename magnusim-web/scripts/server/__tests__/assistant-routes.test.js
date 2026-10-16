// The Assistant's routes (Foundation spec 9.1, 9.2, 10.1): only on this PC (every route,
// every method, each forwarding header, the tunnel host and the path variants the router
// folds, refused before anything is read or written), JSON only, never from the
// Assistant's own tool calls, errors redacted, no answer ever holding a key; status,
// settings and keys; per-path body limits; and the test routes only behind their switch.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-routes-'));
const HOME = join(ROOT, 'home');
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
// The test routes, and the file protector (no helper runs; the switch shows in status).
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { Router, dispatch } = await import('../router.ts');
const { assertSameOrigin, HttpError, jsonBodyLimit, sendJson } = await import('../http.ts');
const { assistantGuard, isAssistantPath, REMOTE_BODY } = await import('../assistant/access.ts');
const routes = await import('../assistant-routes.ts');
const { assistantState, onAssistantShutdown, resetAssistantState } = await import('../assistant/state.ts');
const { registerSecretForRedaction } = await import('../assistant/redact.ts');
const home = await import('../assistant/home.ts');

const CANARY = 'sk-ant-api03-CANARY-route-canary-0123456789-XyZ9';

// Every console line this file's server prints, to check none holds the key.
const logged = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(String).join(' '));
    orig(...args);
  };
}

/** The app's middleware for /api/ (scripts/server/index.ts), over a router with the Assistant's routes. */
function serve(router) {
  const server = http.createServer(async (req, res) => {
    try {
      assertSameOrigin(req);
      if (assistantGuard(req, res)) return;
      const handled = await dispatch(router, req, res);
      if (!handled) sendJson(res, 404, { error: 'route not found' });
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 500, { error: String(err?.message || err) });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let port;
let router;
let handle;
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

before(async () => {
  router = new Router();
  handle = routes.registerAssistantRoutes(router, { port: () => port });
  server = await serve(router);
  port = server.address().port;
});

after(async () => {
  handle?.shutdown();
  agent.destroy();
  await new Promise((r) => server.close(r));
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

/** A raw request: the path is sent as written (fetch would fold `.` and `..`). */
function request(method, path, { headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload !== undefined && !('content-type' in headers) ? { 'content-type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const get = (path, o) => request('GET', path, o);
const post = (path, body, o = {}) => request('POST', path, { ...o, body });

/** Every file in the Assistant home (none until something is saved). */
function homeFiles(d = HOME) {
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? homeFiles(join(d, n)) : [join(d, n)]));
}

const TUNNEL = 'simulation.lilmill2000.com';
const REMOTE_VARIANTS = [
  ['x-forwarded-for', { 'x-forwarded-for': '203.0.113.9' }],
  ['x-forwarded-host', { 'x-forwarded-host': TUNNEL }],
  ['x-forwarded-proto', { 'x-forwarded-proto': 'https' }],
  ['forwarded', { forwarded: 'for=203.0.113.9;proto=https' }],
  ['cf-connecting-ip', { 'cf-connecting-ip': '203.0.113.9' }],
  ['cf-ray', { 'cf-ray': '8a1b2c3d4e5f-AMS' }],
  ['the tunnel host', { host: TUNNEL }],
  ['another host', { host: 'magnusim.example.com:8082' }],
];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'];

describe('only on this PC: the remote census', () => {
  it('every Assistant route, every method, every forwarding variant and the tunnel host: 403 remote, nothing read or written', async () => {
    const paths = [...new Set(router.list().map((r) => r.path))].filter((p) => p.startsWith('/api/assistant') || p.startsWith('/api/test/assistant'));
    assert.deepEqual(paths.sort(), ['/api/assistant/key', '/api/assistant/key/remove', '/api/assistant/settings', '/api/assistant/status', '/api/test/assistant/reset', '/api/test/assistant/state']);
    let n = 0;
    for (const route of paths) {
      const path = route.replace(/:[A-Za-z]+/g, 'x').replace(/\*\*[A-Za-z]*/g, 'x');
      for (const method of METHODS) {
        for (const [name, headers] of REMOTE_VARIANTS) {
          const body = method === 'GET' || method === 'HEAD' ? undefined : { provider: 'anthropic', key: CANARY, files: true, caps: { steps: 5 } };
          const r = await request(method, path, { headers, body });
          assert.equal(r.status, 403, `${method} ${path} (${name})`);
          if (method !== 'HEAD') assert.deepEqual(r.json, REMOTE_BODY, `${method} ${path} (${name})`);
          n += 1;
        }
      }
    }
    assert.equal(n, paths.length * METHODS.length * REMOTE_VARIANTS.length);
    assert.deepEqual(homeFiles(), [], 'nothing written');
    assert.equal(assistantState().secrets.store, null, 'the key store was never even opened');
    assert.ok(!logged.some((l) => l.includes(CANARY)));
  });

  it('the path variants the router folds are caught too: raw through the guard and over HTTP', async () => {
    const variants = [
      '/api/assistant/key',
      '/api//assistant/key',
      '/api/./assistant/key',
      '/api/x/../assistant/key',
      '/api/%2e%2e/api/assistant/key',
      '/api/%2E%2E/api/assistant/key',
      '/api/assistant//key',
      '/api/assistant/key/',
      '/plugins/../api/assistant/key',
      '/api/test//assistant/state',
      '/api/test/./assistant/reset',
      '/api/assistant/status?x=1',
    ];
    for (const url of variants) {
      assert.equal(isAssistantPath(url), true, url);
      // Raw: as index.ts sees it.
      let status = 0;
      let text = '';
      const res = {
        statusCode: 0,
        setHeader() {},
        end(t) {
          status = this.statusCode;
          text = t;
        },
      };
      const remote = { url, method: 'POST', headers: { host: TUNNEL }, socket: { remoteAddress: '127.0.0.1' } };
      assert.equal(assistantGuard(remote, res), true, url);
      assert.equal(status, 403, url);
      assert.equal(JSON.parse(text).reason, 'remote');
      const localReq = { url, method: 'POST', headers: { host: '127.0.0.1:8082' }, socket: { remoteAddress: '127.0.0.1' } };
      assert.equal(assistantGuard(localReq, res), false, `${url} from this PC passes on`);
      // Over HTTP, from a proxy.
      const r = await post(url, { provider: 'anthropic', key: CANARY }, { headers: { 'x-forwarded-for': '203.0.113.9' } });
      assert.equal(r.status, 403, url);
      assert.equal(r.json.reason, 'remote', url);
    }
    for (const url of ['/api/assistance', '/api/projects', '/api/test/event-hub', '/plugins/x/ui/assistant.js']) {
      assert.equal(isAssistantPath(url), false, url);
    }
    assert.deepEqual(homeFiles(), []);
    // From this PC the router does match a folded path: the guard had to catch it.
    const folded = await get('/api//assistant/status');
    assert.equal(folded.status, 200);
    assert.equal(folded.json.available, true);
  });

  it('each route also refuses on its own (local()), with no prefix guard in front', async () => {
    const bare = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
    });
    await new Promise((r) => bare.listen(0, '127.0.0.1', r));
    try {
      for (const r of router.list()) {
        for (const method of r.methods) {
          const res = await fetch(`http://127.0.0.1:${bare.address().port}${r.path}`, {
            method,
            headers: { 'x-forwarded-for': '203.0.113.9', 'content-type': 'application/json' },
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify({ provider: 'anthropic', key: CANARY, files: true }) }),
          });
          assert.equal(res.status, 403, `${method} ${r.path}`);
          if (method !== 'HEAD') assert.equal((await res.json()).reason, 'remote');
        }
      }
    } finally {
      await new Promise((r) => bare.close(r));
    }
    assert.deepEqual(homeFiles(), []);
  });

  it('index.ts runs the guard right after the same-origin check and before dispatch, and registers and shuts down the routes', () => {
    const src = readFileSync(join(WEB, 'scripts', 'server', 'index.ts'), 'utf8');
    const origin = src.indexOf('assertSameOrigin(req);');
    const guard = src.indexOf('if (assistantGuard(req, res)) return;');
    const settle = src.indexOf('if (!registrySettled)');
    const dispatchAt = src.indexOf('await dispatch(router, req, res)');
    assert.ok(origin > 0 && guard > origin && settle > guard && dispatchAt > guard, 'origin check, then the guard, then the boot wait and dispatch');
    assert.match(src, /const assistant = registerAssistantRoutes\(router, \{ worker, services, port: \(\) => boundPortFromListen\(server\) \}\);/);
    assert.match(src, /const stop = \(\) => \{[\s\S]*?assistant\.shutdown\(\);[\s\S]*?\};\s*if \(server\.httpServer\) \{\s*server\.httpServer\.on\('close', stop\);/);
  });
});

describe('local(): JSON only, never from a tool call, errors redacted', () => {
  it('415 for a non-GET that is not JSON; 403 with the tool-call header', async () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const headers = ct ? { 'content-type': ct } : { 'content-type': '' };
      const r = await request('POST', '/api/assistant/settings', { headers, body: 'privacy=deny' });
      assert.equal(r.status, 415, String(ct));
      assert.equal(r.json.code, 'json_only');
    }
    // The media type decides, not a parameter naming JSON: a simple type needs no preflight.
    for (const ct of ['text/plain;x=application/json', 'text/plain; charset=application/json', 'application/jsonx', 'application/json-patch+json']) {
      const r = await request('POST', '/api/assistant/settings', { headers: { 'content-type': ct }, body: '{"privacy":"allow"}' });
      assert.equal(r.status, 415, ct);
      assert.equal(r.json.code, 'json_only', ct);
    }
    // JSON with parameters or in capitals passes the check (and is refused here as a setting, so nothing is written).
    for (const ct of ['application/json; charset=utf-8', 'Application/JSON', 'application/json ;charset=UTF-8']) {
      const r = await request('POST', '/api/assistant/settings', { headers: { 'content-type': ct }, body: '{"privacy":"sometimes"}' });
      assert.equal(r.status, 400, ct);
      assert.equal(r.json.field, 'privacy', ct);
    }
    const t = await get('/api/assistant/status', { headers: { [routes.TURN_HEADER]: 't-1' } });
    assert.equal(t.status, 403);
    assert.equal(t.json.code, 'recursion');
    const p = await post('/api/assistant/key', { provider: 'anthropic', key: CANARY }, { headers: { [routes.TURN_HEADER]: '' } });
    assert.equal(p.status, 403);
    assert.deepEqual(homeFiles(), []);
  });

  it('an error inside a handler answers {ok:false, error, code} with the text redacted, and is logged redacted', async () => {
    registerSecretForRedaction('plain-secret-token-55');
    const r = new Router();
    r.get('/api/assistant/boom', routes.local(() => {
      throw new Error(`upstream said 401 for plain-secret-token-55 and ${CANARY} (Bearer abcdefghijklmnopqrstu)`);
    }));
    r.get('/api/assistant/bad', routes.local(() => {
      throw new HttpError(400, 'bad thing');
    }));
    const s = await serve(r);
    const p = s.address().port;
    try {
      const at = logged.length;
      const res = await fetch(`http://127.0.0.1:${p}/api/assistant/boom`);
      const body = await res.json();
      assert.equal(res.status, 500);
      assert.equal(body.ok, false);
      assert.equal(body.code, 'internal');
      assert.equal(body.error, 'upstream said 401 for [redacted] and [redacted] (Bearer [redacted]');
      const lines = logged.slice(at).join('\n');
      assert.match(lines, /\[assistant\] request failed/);
      assert.ok(!lines.includes('plain-secret-token-55') && !lines.includes(CANARY), lines);
      const bad = await fetch(`http://127.0.0.1:${p}/api/assistant/bad`);
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { ok: false, error: 'bad thing', code: 'bad_request' });
    } finally {
      await new Promise((done) => s.close(done));
    }
  });
});

describe('status, settings and keys', () => {
  const bodies = [];
  const keep = (r) => {
    bodies.push(r.text);
    return r;
  };

  it('status: what exists, with no helper run and nothing written', async () => {
    const r = keep(await get('/api/assistant/status'));
    assert.equal(r.status, 200);
    const s = r.json;
    assert.equal(s.ok, true);
    assert.equal(s.available, true);
    assert.equal(s.provider, 'off');
    assert.deepEqual(s.models, { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: '' });
    assert.equal(s.base_url, 'http://127.0.0.1:1234/v1');
    assert.equal(s.base_url_is_local, true);
    assert.equal(s.effort, 'default');
    assert.equal(s.privacy, 'ask');
    assert.equal(s.consents, 0);
    assert.deepEqual(s.caps, { turn_usd: 3, day_usd: 15, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 });
    for (const slot of ['anthropic', 'openai', 'openai_compatible']) assert.deepEqual(s.keys[slot], { set: false, last4: null, set_at: null, state: 'none' });
    assert.equal(s.storage.kind, 'file');
    assert.equal(s.keys_notice, null);
    assert.equal(s.spent_today_usd, 0);
    assert.equal(s.test_protector, 'file');
    assert.deepEqual(homeFiles(), []);
    const head = await request('HEAD', '/api/assistant/status');
    assert.equal(head.status, 200);
  });

  it('settings: saved at once, answered with the status; 400 with the field; 409 to confirm a server outside this PC', async () => {
    let r = keep(await post('/api/assistant/settings', { provider: 'openai_compatible', model: 'qwen3:32b', caps: { steps: 12 } }));
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, 'openai_compatible');
    assert.equal(r.json.models.openai_compatible, 'qwen3:32b');
    assert.equal(r.json.caps.steps, 12);
    r = keep(await post('/api/assistant/settings', { caps: { steps: 0 } }));
    assert.equal(r.status, 400);
    assert.deepEqual([r.json.ok, r.json.field, r.json.code], [false, 'caps.steps', 'invalid']);
    r = keep(await post('/api/assistant/settings', { secret: 1 }));
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'secret');
    r = keep(await post('/api/assistant/settings', { base_url: 'http://192.168.1.20:1234/v1' }));
    assert.equal(r.status, 409);
    assert.equal(r.json.needs_confirm, 'base_url');
    r = keep(await post('/api/assistant/settings', { base_url: 'http://192.168.1.20:1234/v1', confirm_remote: true }));
    assert.equal(r.status, 200);
    assert.equal(r.json.base_url_is_local, false);
    r = keep(await post('/api/assistant/settings', { base_url: 'http://localhost:11434/v1' }));
    assert.equal(r.json.base_url_is_local, true);
    const file = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
    assert.equal(file.base_url, 'http://localhost:11434/v1');
    // A body is JSON: a broken one is refused by the router before the handler.
    r = await post('/api/assistant/settings', '{"provider":');
    assert.equal(r.status, 400);
  });

  it('a key: saved and shown by its last 4 only; never in any answer, file or log line; removed', async () => {
    let r = keep(await post('/api/assistant/key', { provider: 'anthropic', key: CANARY }));
    assert.equal(r.status, 200);
    assert.equal(r.json.keys.anthropic.set, true);
    assert.equal(r.json.keys.anthropic.last4, 'XyZ9');
    assert.equal(r.json.keys.anthropic.state, 'ok');
    assert.equal(r.json.warning, undefined);
    r = keep(await post('/api/assistant/key', { provider: 'openai', key: 'not-the-usual-shape-0001' }));
    assert.equal(r.status, 200);
    assert.match(r.json.warning, /sk-/);
    r = keep(await post('/api/assistant/key', { provider: 'anthropic', key: 'bad key with spaces' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_key');
    assert.ok(!r.text.includes('bad key with spaces'));
    r = keep(await post('/api/assistant/key', { provider: 'mystery', key: CANARY }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'bad_provider');
    r = keep(await get('/api/assistant/status'));
    assert.equal(r.json.keys.anthropic.last4, 'XyZ9');
    r = keep(await get('/api/test/assistant/state'));
    assert.equal(r.status, 200);
    for (const text of bodies) assert.ok(!text.includes(CANARY), text.slice(0, 200));
    for (const f of [...homeFiles(), process.env.MAGNUSIM_LOCAL_JSON].filter((f) => existsSync(f))) {
      assert.ok(!readFileSync(f, 'latin1').includes(CANARY), f);
    }
    assert.ok(!logged.some((l) => l.includes(CANARY)), 'no log line');
    assert.ok(!Object.values(process.env).some((v) => String(v).includes(CANARY)), 'not in process.env');
    r = keep(await post('/api/assistant/key/remove', { provider: 'anthropic' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.keys.anthropic.set, false);
    assert.equal(r.json.keys.openai.set, true);
    r = await post('/api/assistant/key/remove', { provider: '../x' });
    assert.equal(r.status, 400);
  });

  it('keys that cannot be stored: 409 storage_unavailable with the reason, nothing written', async () => {
    process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'blocked';
    try {
      assert.equal((await post('/api/test/assistant/reset', { files: true })).status, 200);
      let r = await get('/api/assistant/status');
      assert.equal(r.json.storage.kind, 'unavailable');
      assert.equal(r.json.storage.reason, 'blocked');
      assert.equal(r.json.test_protector, 'blocked');
      r = await post('/api/assistant/key', { provider: 'anthropic', key: CANARY });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'storage_unavailable');
      assert.equal(r.json.storage.reason, 'blocked');
      assert.ok(!r.text.includes(CANARY));
      assert.deepEqual(homeFiles(), []);
    } finally {
      process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
      await post('/api/test/assistant/reset', { files: true });
    }
  });

  it('per-path body limits, read on the path the router matches', async () => {
    const big = (n) => ({ provider: 'anthropic', key: 'k'.repeat(n) });
    for (const path of ['/api/assistant/key', '/api//assistant/key', '/api/x/../assistant/key']) {
      assert.equal((await post(path, big(17 * 1024))).status, 413, path);
    }
    assert.equal((await post('/api/assistant/key', big(15 * 1024))).status, 400, 'under the limit: refused as a key, not for size');
    assert.equal((await post('/api/assistant/settings', { pad: 'x'.repeat(65 * 1024) })).status, 413);
    assert.equal((await post('/api/assistant/settings', { pad: 'x'.repeat(60 * 1024) })).status, 400);
    assert.equal(jsonBodyLimit('/api/assistant/relay/result'), 10 * 1024 * 1024);
    assert.equal(jsonBodyLimit('/api//assistant/relay/tools'), 512 * 1024);
    assert.equal(jsonBodyLimit('/api/assistant/key'), 16 * 1024);
    assert.equal(jsonBodyLimit('/api/assistant/turns'), 64 * 1024);
    assert.equal(jsonBodyLimit('/api/test/assistant/reset'), 64 * 1024);
    assert.equal(jsonBodyLimit('/api/plugin-data/write'), 9 * 1024 * 1024);
    assert.equal(jsonBodyLimit('/api//plugin-data/write'), 9 * 1024 * 1024);
    assert.equal(jsonBodyLimit('/api/assistance'), 2 * 1024 * 1024);
    assert.equal(jsonBodyLimit('/api/projects'), 2 * 1024 * 1024);
  });

  it('shutdown drops the master key; the test reset starts afresh', async () => {
    await post('/api/assistant/key', { provider: 'openai', key: 'sk-proj-shutdown-key-0001' });
    assert.ok(assistantState().secrets.master, 'cached after a save');
    const boot = assistantState().bootId;
    handle.shutdown();
    assert.equal(assistantState().secrets.master, null);
    const r = await post('/api/test/assistant/reset', {});
    assert.equal(r.status, 200);
    assert.notEqual(r.json.boot, boot);
    const s = await get('/api/assistant/status');
    assert.equal(s.json.keys.openai.set, true, 'a reset without files keeps them');
  });
});

describe('the test routes need their switch', () => {
  it('without MAGNUSIM_TEST_ASSISTANT=1 they are not there (404)', async () => {
    const saved = process.env.MAGNUSIM_TEST_ASSISTANT;
    for (const value of [undefined, '0', 'true']) {
      if (value === undefined) delete process.env.MAGNUSIM_TEST_ASSISTANT;
      else process.env.MAGNUSIM_TEST_ASSISTANT = value;
      const r = new Router();
      routes.registerAssistantRoutes(r);
      assert.deepEqual(r.list().filter((x) => x.path.startsWith('/api/test/')), [], String(value));
      const s = await serve(r);
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/api/test/assistant/state`);
        assert.equal(res.status, 404, String(value));
        const reset = await fetch(`http://127.0.0.1:${s.address().port}/api/test/assistant/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"files":true}' });
        assert.equal(reset.status, 404);
      } finally {
        await new Promise((done) => s.close(done));
      }
    }
    process.env.MAGNUSIM_TEST_ASSISTANT = saved;
  });

  it('a reset removes files only from a test home (the real folder, here a stand-in, keeps its files)', async () => {
    const OVERRIDES = ['MAGNUSIM_ASSISTANT_HOME', 'CFDDESK_ASSISTANT_HOME', 'MAGNUSIM_LOCAL_JSON', 'CFDDESK_LOCAL_JSON'];
    const FOLDERS = ['APPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME'];
    const saved = Object.fromEntries([...OVERRIDES, ...FOLDERS].map((n) => [n, process.env[n]]));
    // Every folder the real home is found from points into a temp stand-in first, so even a
    // broken check (or one broken on purpose) reaches only the stand-in, never this PC's keys.
    const user = join(ROOT, 'real-user');
    process.env.APPDATA = join(user, 'AppData', 'Roaming');
    process.env.USERPROFILE = user;
    process.env.HOME = user;
    process.env.XDG_CONFIG_HOME = join(user, '.config');
    for (const n of OVERRIDES) delete process.env[n];
    try {
      assert.equal(home.assistantHomeIsOverridden(), false);
      const real = home.assistantHome();
      assert.ok(real.startsWith(user + sep), `the real home resolves into the stand-in: ${real}`);
      const files = ['settings.json', 'spend.json'].map((n) => join(home.assistantDataDir(), n))
        .concat(['keys.json', 'master.json'].map((n) => join(home.secretsDir(), n)));
      for (const f of files) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, '{"kept":true}\n');
      }
      const r = await post('/api/test/assistant/reset', { files: true });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'real_home');
      for (const f of files) assert.equal(readFileSync(f, 'utf8'), '{"kept":true}\n', f);
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it('run.bat and the setup scripts never set an Assistant test switch', () => {
    const files = [join(WEB, 'run.bat'), ...readdirSync(join(WEB, 'setup')).filter((n) => /\.(ps1|bat|cmd)$/i.test(n)).map((n) => join(WEB, 'setup', n))];
    assert.ok(files.length >= 3, files.join());
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /MAGNUSIM_TEST_/, f);
  });
});

// Vite restarts the server inside this process: the state stays on globalThis, and the
// routes are registered again. Each close must end its own server's lifetime only.
describe('a server restarted in the same process', () => {
  const saveKey = async () => {
    const r = await post('/api/assistant/key', { provider: 'openai', key: 'sk-proj-restart-key-0001' });
    assert.equal(r.status, 200);
    assert.ok(assistantState().secrets.master, 'the master is cached after a save');
  };

  it("Vite's order (the new server registers, then the old one closes): the old close ends nothing, the new one's runs its hooks", async () => {
    const old = routes.registerAssistantRoutes(new Router());
    await saveKey();
    const boot = assistantState().bootId;
    let ran = 0;
    const next = routes.registerAssistantRoutes(new Router());
    assert.notEqual(assistantState().bootId, boot, 'a new server lifetime has a new boot id');
    onAssistantShutdown(() => (ran += 1));
    old.shutdown();
    assert.equal(ran, 0, "the old server's close leaves the new server's hooks");
    assert.ok(assistantState().secrets.master, '... and its master key');
    assert.equal(assistantState().shutDown, false);
    next.shutdown();
    assert.equal(ran, 1, "the new server's close runs them");
    assert.equal(assistantState().secrets.master, null);
    assert.equal(assistantState().shutDown, true);
  });

  it('closed, then registered again: the second close runs the hooks added since and drops the master key', async () => {
    const first = routes.registerAssistantRoutes(new Router());
    await saveKey();
    first.shutdown();
    assert.equal(assistantState().secrets.master, null);
    const second = routes.registerAssistantRoutes(new Router());
    assert.equal(assistantState().shutDown, false, 'a new server is not shut down');
    let ran = 0;
    onAssistantShutdown(() => (ran += 1));
    await saveKey();
    second.shutdown();
    assert.equal(ran, 1);
    assert.equal(assistantState().secrets.master, null);
  });

  it('a test reset forgets the state, not the running server: its close still drops the master key', async () => {
    const h = routes.registerAssistantRoutes(new Router());
    assert.equal((await post('/api/test/assistant/reset', {})).status, 200);
    let ran = 0;
    onAssistantShutdown(() => (ran += 1));
    await saveKey();
    h.shutdown();
    assert.equal(ran, 1);
    assert.equal(assistantState().secrets.master, null);
  });
});
