// The Assistant's routes (Foundation spec 9.1, 9.2, 10.1): only on this PC (every route,
// every method, each forwarding header, the tunnel host and the path variants the router
// folds, refused before anything is read or written), JSON only, never from the
// Assistant's own tool calls, errors redacted, no answer ever holding a key; status,
// settings and keys; per-path body limits; and the test routes only behind their switch.
// One turn per app tab (CAD tools spec H4): two starts held together, then let go; the tab
// free once its turn ended, while that turn's loop is still held.
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
// Turns run the real adapters against the fake provider (never a real one).
const { startFakeLlm } = await import('../../../e2e/support/fake-llm.mjs');
const fake = await startFakeLlm();
process.env.MAGNUSIM_TEST_ASSISTANT_PROVIDER_URL = fake.base;

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { Router, dispatch } = await import('../router.ts');
const { assertSameOrigin, HttpError, jsonBodyLimit, sendJson } = await import('../http.ts');
const { assistantGuard, isAssistantPath, REMOTE_BODY } = await import('../assistant/access.ts');
const routes = await import('../assistant-routes.ts');
const { assistantState, onAssistantShutdown, resetAssistantState } = await import('../assistant/state.ts');
const { registerSecretForRedaction } = await import('../assistant/redact.ts');
const home = await import('../assistant/home.ts');
const { TAB_BUSY_TEXT } = await import('../assistant/turns.ts');

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
  await fake.stop();
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
    assert.deepEqual(paths.sort(), [
      '/api/assistant/agents',
      '/api/assistant/agents/allow',
      '/api/assistant/agents/custom',
      '/api/assistant/agents/custom/remove',
      '/api/assistant/agents/sign-in',
      // The router's underscore alias of a hyphenated path (router.ts underscoreAlias).
      '/api/assistant/agents/sign_in',
      '/api/assistant/agents/test',
      '/api/assistant/conversations/:id/forget',
      '/api/assistant/gates/:id',
      '/api/assistant/key',
      '/api/assistant/key/remove',
      '/api/assistant/launch/check',
      '/api/assistant/mcp',
      '/api/assistant/models',
      '/api/assistant/relay/gate',
      '/api/assistant/relay/progress',
      '/api/assistant/relay/result',
      '/api/assistant/relay/tools',
      '/api/assistant/settings',
      '/api/assistant/status',
      '/api/assistant/tabs',
      '/api/assistant/test',
      '/api/assistant/turns',
      '/api/assistant/turns/:id',
      '/api/assistant/turns/:id/stop',
      '/api/test/assistant/reset',
      '/api/test/assistant/state',
    ]);
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
    assert.equal(assistantState().turns.size, 0, 'no turn started');
    assert.equal(fake.requests().length, 0, 'no provider request');
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
    assert.deepEqual(s.caps, { turn_usd: 8, day_usd: 15, steps: 120, turn_minutes: 60, turn_tokens: 10_000_000 });
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

  it('every test reset ends the coding agents, not only the first (their hook went with the old state)', async () => {
    const { agentHost } = await import('../assistant/agents/host.ts');
    const { realClock } = await import('../assistant/gates.ts');
    const host = agentHost();
    for (const n of [1, 2, 3]) {
      assert.equal(host.reserve(`conv-reset-${n}`, 'claude', {}, realClock), true);
      assert.deepEqual(Object.keys(host.snapshot()), [`conv-reset-${n}`]);
      assert.equal((await post('/api/test/assistant/reset', {})).status, 200);
      assert.deepEqual(host.snapshot(), {}, `reset ${n} ended the agent's slot`);
    }
  });
});

// The turn routes over HTTP, with the real adapters against the fake provider.
describe('turns', () => {
  const PROJECTS = { ok: true, projects: [{ id: 'p1', title: 'Wing', created_at: '2026-10-01T10:00:00Z' }], projects_root: 'C:\\x' };
  const TURN_KEY = 'sk-ant-api03-ROUTES-turn-key-0123456789-Ab1';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }

  before(() => {
    // What the host tools and the project lookup read, over loopback (the app's own routes in the app).
    router.get('/api/projects', (ctx) => ctx.sendJson(200, PROJECTS));
    router.get('/api/compute-queue', (ctx) => ctx.sendJson(200, { ok: true, busy: false, items: [] }));
  });

  /** Polls a turn until it ended; returns every event and the last summary. */
  async function follow(turn, onEvent = async () => {}) {
    const events = [];
    let since = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = await get(`/api/assistant/turns/${turn}?since=${since}&wait_ms=2000`);
      assert.equal(r.status, 200, r.text);
      for (const e of r.json.events) {
        events.push(e);
        await onEvent(e);
      }
      since = r.json.next;
      if (r.json.ended) return { events, turn: r.json.turn };
    }
    throw new Error('the turn never ended');
  }

  const localServer = () => post('/api/assistant/settings', { provider: 'openai_compatible', base_url: fake.compatBase, model: 'qwen3.8-27b', privacy: 'ask' });

  it('a local-server turn: 202, the long-poll, a host tool through the app, then done; 404 for an unknown turn', async () => {
    assert.equal((await localServer()).status, 200);
    const before = fake.requests().length;
    fake.reply({ text: 'Checking.', tools: [{ name: 'app_status', input: {} }] }, { text: 'All good.' });
    const r = await post('/api/assistant/turns', { text: 'How is the app?' });
    assert.equal(r.status, 202, r.text);
    assert.match(r.json.turn, /^t-[0-9a-z]+-[0-9a-f]{8}$/);
    assert.match(r.json.conversation, /^c-[0-9a-z]+-[0-9a-f]{8}$/);
    const { events, turn } = await follow(r.json.turn);
    assert.equal(turn.state, 'done', JSON.stringify(events.slice(-3)));
    assert.equal(turn.text_so_far, 'Checking.\n\nAll good.');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, JSON.stringify(results[0]));
    assert.match(results[0].summary, /^Magnusim .*, \d+ plugins, compute idle, 0 queued$/);
    const sent = fake.requests().slice(before).filter((x) => x.dialect === 'compat' && x.kind === 'chat');
    assert.equal(sent.length, 2);
    assert.ok(sent[0].body.tools.some((t) => t.function.name === 'app_status'));
    assert.ok(!sent[0].body.tools.some((t) => t.function.name === 'connection_check'));
    assert.deepEqual(Object.keys(turn).sort(), [
      'agent', 'billing', 'conversation', 'end_reason', 'ended_at', 'estimated', 'id', 'message', 'open_gates', 'project_id', 'prompt', 'provider', 'served_by', 'started_at', 'started_by', 'state', 'step', 'tab', 'text_so_far', 'title', 'usd', 'used',
    ]);
    // Who pays (phase 3 spec 4.15): a local server is not priced, and no coding agent runs it.
    assert.deepEqual([turn.provider, turn.billing, turn.agent], ['openai_compatible', 'free', null]);
    assert.equal((await get('/api/assistant/turns/t-nope')).status, 404);
    assert.equal((await post('/api/assistant/turns/t-nope/stop', {})).status, 404);
    const tabs = await get('/api/assistant/tabs');
    assert.deepEqual(tabs.json, { ok: true, tabs: [] }, 'no page registers tools before the relay');
    const state = await get('/api/test/assistant/state');
    assert.deepEqual([state.json.running, state.json.gates], [0, 0]);
  });

  it('Stop while the provider streams: the socket closes, no further request, the turn ends stopped', async () => {
    assert.equal((await localServer()).status, 200);
    fake.reply({ text: 'partial answer', hold: 'stop-1' });
    const chats = () => fake.requests().filter((x) => x.kind === 'chat').length;
    const before = chats();
    const disconnects = fake.disconnects();
    const r = await post('/api/assistant/turns', { text: 'Go slowly.' });
    assert.equal(r.status, 202);
    await until(async () => (await get(`/api/assistant/turns/${r.json.turn}`)).json.turn.text_so_far.length > 0, 5000, 'the first chunk');
    const busy = await post(`/api/assistant/conversations/${r.json.conversation}/forget`, {});
    assert.deepEqual([busy.status, busy.json.code], [409, 'conversation_busy']);
    const stopped = await post(`/api/assistant/turns/${r.json.turn}/stop`, {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.turn.state, 'stopped');
    assert.equal(stopped.json.turn.text_so_far, '', 'the partial answer is dropped');
    await until(() => fake.disconnects() === disconnects + 1, 5000, 'the fake to see the socket close');
    fake.release('stop-1');
    await sleep(300);
    assert.equal(chats(), before + 1, 'no request after Stop');
    await until(async () => (await post(`/api/assistant/conversations/${r.json.conversation}/forget`, {})).json.forgotten === true, 5000, 'the forget');
  });

  it("a local server that reports its model's context: too small ends the turn failed (context) with nothing sent; loaded again with room, the next turn of that conversation (within the row's 60 s) is read afresh and its answers may run to 8192 tokens (CAD tools spec H5)", async () => {
    const chats = () => fake.requests().filter((x) => x.kind === 'chat' && x.dialect === 'compat');
    const rowReads = () => fake.requests().filter((x) => x.kind === 'model_row');
    // A reset forgets the rows kept from earlier tests (a row is kept 60 s).
    assert.equal((await post('/api/test/assistant/reset', {})).status, 200);
    assert.equal((await localServer()).status, 200);
    fake.models([{ id: 'qwen3.8-27b', context: 2048, type: 'llm' }], 'compat');
    try {
      const chatsBefore = chats().length;
      const rowsBefore = rowReads().length;
      let r = await post('/api/assistant/turns', { text: 'Hello?' });
      assert.equal(r.status, 202, r.text);
      let { turn } = await follow(r.json.turn);
      assert.deepEqual(
        [turn.state, turn.end_reason, turn.message],
        ['failed', 'context', "The local model's context (2,048 tokens) is too small for this conversation: load it with a longer context in the local server, or start a new conversation."],
      );
      assert.equal(chats().length, chatsBefore, 'nothing sent');
      assert.deepEqual(rowReads().slice(rowsBefore).map((x) => [x.method, x.path]), [['GET', '/compat/api/v0/models/qwen3.8-27b']]);
      // The person loads the model again with a longer context and tries again at once, in the
      // same conversation: the failed turn dropped the kept row, so the server is asked again.
      fake.models([{ id: 'qwen3.8-27b', context: 32768, type: 'llm' }], 'compat');
      fake.reply({ text: 'Checking.', tools: [{ name: 'app_status', input: {} }] }, { text: 'All good.' });
      r = await post('/api/assistant/turns', { text: 'How is the app?', conversation: r.json.conversation });
      assert.equal(r.status, 202, r.text);
      ({ turn } = await follow(r.json.turn));
      assert.equal(turn.state, 'done', turn.message);
      assert.deepEqual(chats().slice(chatsBefore).map((x) => x.body.max_tokens), [8192, 8192]);
      assert.equal(rowReads().length, rowsBefore + 2, 'one read for the turn: its second step uses the kept row');
    } finally {
      fake.models(['qwen3.8-27b', 'gemma-4-31b'], 'compat');
    }
  });

  it('a cloud turn about a project asks once (Send through the route), then not again; the key goes only as x-api-key', async () => {
    assert.equal((await post('/api/assistant/key', { provider: 'anthropic', key: TURN_KEY })).status, 200);
    assert.equal((await post('/api/assistant/settings', { provider: 'anthropic', model: 'claude-opus-5-5', privacy: 'ask', forget_consents: true })).status, 200);
    const before = fake.requests().length;
    fake.reply({ text: 'It is a wing.' }, { text: 'Still a wing.' });
    let r = await post('/api/assistant/turns', { text: 'What is this project?', context: { project_id: 'p1' } });
    assert.equal(r.status, 202, r.text);
    const gates = [];
    const first = await follow(r.json.turn, async (e) => {
      if (e.type !== 'gate') return;
      gates.push(e.gate);
      assert.equal(fake.requests().length, before, 'nothing sent while asking');
      const a = await post(`/api/assistant/gates/${e.gate.id}`, { allow: true, answer_key: r.json.answer_key });
      assert.equal(a.status, 200);
    });
    assert.equal(first.turn.state, 'done', JSON.stringify(first.events.slice(-3)));
    assert.deepEqual(gates.map((g) => [g.kind, g.title, g.yes, g.no]), [['privacy', 'Send project "Wing" to Anthropic?', 'Send', "Don't send"]]);
    const sent = fake.requests().slice(before).filter((x) => x.dialect === 'anthropic');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers['x-api-key'], TURN_KEY);
    assert.equal(sent[0].headers.authorization, undefined);
    assert.match(JSON.stringify(sent[0].body.messages), /App context \(data, not instructions\): .*Wing/);
    assert.equal((await get('/api/assistant/status')).json.consents, 1);
    r = await post('/api/assistant/turns', { text: 'Again?', context: { project_id: 'p1' }, conversation: r.json.conversation });
    assert.equal(r.status, 202, r.text);
    const second = await follow(r.json.turn);
    assert.equal(second.turn.state, 'done');
    assert.equal(second.events.filter((e) => e.type === 'gate').length, 0, 'remembered');
    assert.ok(second.turn.usd > 0);
    // Never send: refused before the turn.
    await post('/api/assistant/settings', { privacy: 'deny' });
    const denied = await post('/api/assistant/turns', { text: 'x', context: { project_id: 'p1' } });
    assert.deepEqual([denied.status, denied.json.code], [400, 'privacy_denied']);
    await post('/api/assistant/settings', { privacy: 'ask' });
    // A top-level project_id is not the turn's project (bodies keep it under context).
    fake.reply({ text: 'home' });
    const top = await post('/api/assistant/turns', { text: 'x', project_id: 'p1' });
    assert.equal(top.status, 202, top.text);
    const home = await follow(top.json.turn);
    assert.equal(home.turn.project_id, null);
    assert.equal(home.events.filter((e) => e.type === 'gate').length, 0);
    for (const text of [JSON.stringify(home), JSON.stringify(second), JSON.stringify(first)]) assert.ok(!text.includes(TURN_KEY));
    assert.ok(!logged.some((l) => l.includes(TURN_KEY)));
  });

  it('both cloud dialects replay a two-step turn’s stored answer (thinking, reasoning items) as the fake requires', async () => {
    const keys = { anthropic: TURN_KEY, openai: 'sk-proj-ROUTES-turn-key-0123456789-Cd2' };
    const models = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' };
    for (const provider of ['anthropic', 'openai']) {
      assert.equal((await post('/api/assistant/key', { provider, key: keys[provider] })).status, 200);
      assert.equal((await post('/api/assistant/settings', { provider, model: models[provider], privacy: 'allow' })).status, 200);
      const before = fake.requests().length;
      fake.reply({ thinking: 'Let me look.', text: 'Looking.', tools: [{ name: 'app_status', input: {} }] }, { text: 'Fine.' });
      const r = await post('/api/assistant/turns', { text: 'Status?' });
      assert.equal(r.status, 202, r.text);
      const { turn, events } = await follow(r.json.turn);
      assert.equal(turn.state, 'done', `${provider}: ${JSON.stringify(events.slice(-3))}`);
      const sent = fake.requests().slice(before).filter((x) => x.dialect === provider);
      assert.equal(sent.length, 2, provider);
      assert.ok(sent.every((x) => !x.refused), `${provider}: ${sent.map((x) => x.refused).join()}`);
      const replay = JSON.stringify(provider === 'openai' ? sent[1].body.input : sent[1].body.messages);
      assert.match(replay, provider === 'openai' ? /"encrypted_content":"enc-\d+"/ : /"signature":"sig-\d+"/, `${provider}: the opaque part went back`);
    }
  });

  it('a turn names any provider, whatever the default: that provider is asked, and app_status reports it', async () => {
    assert.equal((await post('/api/assistant/key', { provider: 'anthropic', key: TURN_KEY })).status, 200);
    assert.equal((await localServer()).status, 200);
    assert.equal((await post('/api/assistant/settings', { models: { anthropic: 'claude-sonnet-5-5' }, privacy: 'allow' })).status, 200);
    const before = fake.requests().length;
    fake.reply({ text: 'Looking.', tools: [{ name: 'app_status', input: {} }] }, { text: 'Fine.' });
    const r = await post('/api/assistant/turns', { text: 'Status?', provider: 'anthropic' });
    assert.equal(r.status, 202, r.text);
    const { turn, events } = await follow(r.json.turn);
    assert.equal(turn.state, 'done', JSON.stringify(events.slice(-3)));
    const sent = fake.requests().slice(before);
    assert.deepEqual([...new Set(sent.filter((x) => x.kind === 'chat').map((x) => x.dialect))], ['anthropic'], 'not the default local server');
    assert.equal(sent.find((x) => x.dialect === 'anthropic').body.model, 'claude-sonnet-5-5', "the provider's own model");
    const result = JSON.stringify(sent.at(-1).body.messages);
    assert.match(result, /\\"assistant\\":\{\\"provider\\":\\"anthropic\\",\\"model\\":\\"claude-sonnet-5-5\\"\}/, "app_status names the turn's provider, not the default");
    const bad = await post('/api/assistant/turns', { text: 'x', provider: 'bogus' });
    assert.deepEqual([bad.status, bad.json.code], [400, 'bad_provider']);
    assert.match(bad.json.error, /anthropic, openai, openai_compatible/);
  });

  it('one turn per app tab: two POSTs that both passed the checks before either started give one 202 and one 409 tab_busy; another tab still starts, and the tab is free once its turn ended', async () => {
    assert.equal((await localServer()).status, 200);
    // A server whose package check waits until the test lets it go: both POSTs wait there,
    // past the settings read, then race through the checks left to the start.
    let reached = 0;
    let letGo = () => undefined;
    const gate = new Promise((done) => (letGo = done));
    const r2 = new Router();
    const h2 = routes.registerAssistantRoutes(r2, {
      port: () => port,
      turns: {
        deps: async () => {
          reached += 1;
          await gate;
          return 'ok';
        },
      },
    });
    const s2 = await serve(r2);
    const base = `http://127.0.0.1:${s2.address().port}`;
    const start = async (body) => {
      const r = await fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const ws = { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: [] };
    const turnsNow = [];
    try {
      h2.registry.setWorkspace('tab-one', 'L1', ws);
      fake.reply({ text: 'Working on it.', hold: 'tab-busy' });
      const both = Promise.all([start({ text: 'First.', tab: 'tab-one' }), start({ text: 'Second.', tab: 'tab-one' })]);
      await until(() => reached === 2, 5000, 'both POSTs held at the package check');
      letGo();
      const answers = await both;
      assert.deepEqual(answers.map((a) => a.status).sort(), [202, 409], JSON.stringify(answers));
      const refused = answers.find((a) => a.status === 409);
      assert.deepEqual(refused.json, { ok: false, code: 'tab_busy', error: TAB_BUSY_TEXT });
      const first = h2.turns.get(answers.find((a) => a.status === 202).json.turn);
      turnsNow.push(first);
      assert.equal(first.tab, 'tab-one');
      await until(() => first.textSoFar().length > 0, 5000, 'the first chunk');
      assert.equal(h2.turns.running().length, 1, 'the refused one never started');
      // 'auto' resolves to the same tab; the running turn's own conversation is named as that.
      assert.deepEqual(await start({ text: 'Third.', tab: 'auto' }), { status: 409, json: { ok: false, code: 'tab_busy', error: TAB_BUSY_TEXT } });
      const same = await start({ text: 'Again.', tab: 'tab-one', conversation: first.conv.id });
      assert.deepEqual([same.status, same.json.code], [409, 'conversation_busy']);
      // Another tab is not this one's: it starts and ends while the first still works.
      h2.registry.setWorkspace('tab-two', 'L2', ws);
      fake.reply({ text: 'Other tab.' });
      const other = await start({ text: 'Other.', tab: 'tab-two' });
      assert.equal(other.status, 202, JSON.stringify(other.json));
      const t2 = h2.turns.get(other.json.turn);
      turnsNow.push(t2);
      await until(() => t2.settled, 5000, 'the other tab’s turn');
      assert.deepEqual([t2.state, first.ended], ['done', false]);
      // Stopped, the first turn frees its tab at once: the next one starts.
      const stopped = await fetch(`${base}/api/assistant/turns/${first.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
      assert.equal(stopped.turn.state, 'stopped');
      fake.release('tab-busy');
      fake.reply({ text: 'Free again.' });
      const next = await start({ text: 'Next.', tab: 'tab-one' });
      assert.equal(next.status, 202, JSON.stringify(next.json));
      const t3 = h2.turns.get(next.json.turn);
      turnsNow.push(t3);
      await until(() => t3.settled, 5000, 'the next turn');
      assert.equal(t3.state, 'done');
    } finally {
      letGo();
      fake.release('tab-busy');
      for (const t of turnsNow) await until(() => t.settled, 5000, `turn ${t.id} to settle`);
      h2.shutdown();
      await new Promise((done) => s2.close(done));
    }
  });

  it('one turn per app tab: the tab is free as soon as its turn has ended, while that turn is still unwinding (a restart: the old server’s relay closed during its project read)', async () => {
    assert.equal((await localServer()).status, 200);
    // The old server: its project read ignores the turn's abort until the test lets it go,
    // so the turn's loop is still there after the turn has ended.
    let reads = 0;
    let letGo = () => undefined;
    const gate = new Promise((done) => (letGo = done));
    const rOld = new Router();
    const hOld = routes.registerAssistantRoutes(rOld, {
      port: () => port,
      turns: {
        projects: async (id) => {
          reads += 1;
          await gate;
          return { id, title: 'Wing', created_at: null };
        },
      },
    });
    const sOld = await serve(rOld);
    let hNew = null;
    let sNew = null;
    const start = async (s, body) => {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const ws = { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: [] };
    const turnsNow = [];
    try {
      hOld.registry.setWorkspace('tab-one', 'L1', ws);
      const a = await start(sOld, { text: 'First.', tab: 'tab-one' });
      assert.equal(a.status, 202, JSON.stringify(a.json));
      const first = hOld.turns.get(a.json.turn);
      turnsNow.push(first);
      await until(() => reads === 1, 5000, 'the first turn’s project read');
      // The new server is up and the page registered there: the tab is still busy.
      const rNew = new Router();
      hNew = routes.registerAssistantRoutes(rNew, { port: () => port });
      sNew = await serve(rNew);
      hNew.registry.setWorkspace('tab-one', 'L2', ws);
      assert.deepEqual(await start(sNew, { text: 'Too soon.', tab: 'tab-one' }), { status: 409, json: { ok: false, code: 'tab_busy', error: TAB_BUSY_TEXT } });
      // The old relay closes: its tab's turn ends now, and its loop still waits in the read.
      hOld.relay.shutdown();
      assert.deepEqual([first.ended, first.settled, first.state, first.endReason], [true, false, 'failed', 'shutdown']);
      fake.reply({ text: 'Free again.' });
      const b = await start(sNew, { text: 'Next.', tab: 'tab-one' });
      assert.equal(b.status, 202, JSON.stringify(b.json));
      assert.equal(first.settled, false, 'the first turn was still unwinding when the next one started');
      const next = hNew.turns.get(b.json.turn);
      turnsNow.push(next);
      letGo();
      await until(() => first.settled && next.settled, 5000, 'both turns');
      assert.deepEqual([first.state, next.state, reads], ['failed', 'done', 1]);
    } finally {
      letGo();
      for (const t of turnsNow) await until(() => t.settled, 5000, `turn ${t.id} to settle`);
      hOld.shutdown();
      hNew?.shutdown();
      await new Promise((done) => sOld.close(done));
      if (sNew) await new Promise((done) => sNew.close(done));
    }
  });

  it('an error thrown inside a detached turn reaches only the log, redacted; the turn ends failed', async () => {
    assert.equal((await localServer()).status, 200);
    const r2 = new Router();
    const h2 = routes.registerAssistantRoutes(r2, {
      port: () => port,
      turns: {
        createAdapter: () => {
          throw new Error(`the adapter exploded holding ${CANARY}`);
        },
      },
    });
    const s2 = await serve(r2);
    try {
      const at = logged.length;
      const errors = [];
      const orig = console.error;
      console.error = (...args) => {
        errors.push(args.map(String).join(' '));
        orig(...args);
      };
      try {
        const base = `http://127.0.0.1:${s2.address().port}`;
        const started = await fetch(`${base}/api/assistant/turns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) }).then((x) => x.json());
        const t = h2.turns.get(started.turn);
        await until(() => t.settled, 5000, 'the turn to end');
        assert.deepEqual([t.state, t.endReason], ['failed', 'internal']);
        const polled = await fetch(`${base}/api/assistant/turns/${t.id}`).then((x) => x.json());
        assert.ok(!JSON.stringify(polled).includes(CANARY));
        assert.ok(!JSON.stringify(polled).includes('exploded'), 'the error text stays in the log');
      } finally {
        console.error = orig;
      }
      assert.ok(errors.some((l) => l.includes('[assistant] a turn failed unexpectedly') && l.includes('[redacted]')), errors.join('\n'));
      assert.ok(!errors.some((l) => l.includes(CANARY)));
      assert.ok(!logged.slice(at).some((l) => l.includes(CANARY)));
    } finally {
      h2.shutdown();
      await new Promise((done) => s2.close(done));
    }
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

  it('the shared state holds no links or registrations: those are each server’s own (the relay’s and the registry’s), and nothing reads them from it', () => {
    const st = assistantState();
    assert.ok(st.turns instanceof Map && st.conversations instanceof Map && st.gates instanceof Map);
    assert.deepEqual(['links', 'registrations'].filter((k) => k in st), [], 'no field that is always empty');
    assert.equal(routes.addStatusPart, undefined, 'every status part is in the list; nothing adds one');
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
