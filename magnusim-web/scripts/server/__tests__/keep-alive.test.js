// SPDX-License-Identifier: GPL-3.0-or-later
// The app server keeps idle keep-alive connections open (scripts/server/keep-alive.ts), so a
// client that reuses one after a few seconds' gap is answered. With Node's defaults the
// server closes an idle connection 6 s after its last response; a request that arrived while
// the server was busy across that moment was closed unread and the client got ECONNRESET
// ("apiRequestContext.post: read ECONNRESET" in the CAD e2e runs, 2026-10-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, keepIdleConnectionsOpen } from '../keep-alive.ts';

const SERVER = fileURLToPath(new URL('./keep-alive-server.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('keepIdleConnectionsOpen: idle connections are kept 2 minutes; headersTimeout and requestTimeout stay above', () => {
  const s = http.createServer();
  keepIdleConnectionsOpen(s);
  assert.equal(s.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(KEEP_ALIVE_TIMEOUT_MS >= 65_000, 'above the idle limit of common clients and proxies');
  assert.equal(s.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.ok(s.headersTimeout > s.keepAliveTimeout);
  assert.ok(s.requestTimeout === 0 || s.requestTimeout > s.headersTimeout);
  const short = http.createServer({ requestTimeout: 90_000 });
  keepIdleConnectionsOpen(short);
  assert.ok(short.requestTimeout > short.headersTimeout);
  // No server (Vite's middleware mode): nothing to do.
  keepIdleConnectionsOpen(null);
  keepIdleConnectionsOpen(undefined);
});

/** One request; resolves with its status or its error code, and whether it reused a connection. */
function call(port, method, path, agent) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket, keepAlive: res.headers['keep-alive'] }));
    });
    req.on('error', (e) => resolve({ error: /** @type {NodeJS.ErrnoException} */ (e).code || String(e), reused: req.reusedSocket }));
    req.end(method === 'POST' ? '{"x":1}' : undefined);
  });
}

async function startServer(mode) {
  const child = fork(SERVER, [mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`keep-alive-server ${mode} exited (${code})`)));
  });
  return { child, port };
}

test('a request on an idle connection that reaches a busy server across Node\'s 6 s close is answered, not reset', async () => {
  const modes = ['node', 'app'];
  const servers = {};
  // Each server's client keeps idle connections with no limit, as Playwright's request context does.
  const agents = { node: new http.Agent({ keepAlive: true }), app: new http.Agent({ keepAlive: true }) };
  try {
    for (const m of modes) servers[m] = await startServer(m);
    const first = {};
    for (const m of modes) first[m] = await call(servers[m].port, 'GET', '/a', agents[m]);
    assert.equal(first.node.keepAlive, 'timeout=5');
    assert.equal(first.app.keepAlive, `timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
    // Each server busy from 4 s to 7 s after that response (Node's close is due at 6 s); the
    // next request goes out at 4.5 s on the idle connection and waits in the socket unread.
    await sleep(4_000);
    const busy = modes.map((m) => call(servers[m].port, 'GET', '/busy?ms=3000', false));
    await sleep(500);
    const [node, app] = await Promise.all(modes.map((m) => call(servers[m].port, 'POST', '/b', agents[m])));
    await Promise.all(busy);
    // Node's defaults: the server's next turn closes the connection before reading the request.
    // This control shows the test forces the timing of the e2e failures.
    assert.deepEqual(node, { error: 'ECONNRESET', reused: true });
    // The app's timeouts: the same request on the same connection is answered.
    assert.equal(app.reused, true);
    assert.equal(app.status, 200, JSON.stringify(app));
  } finally {
    for (const a of Object.values(agents)) a.destroy();
    for (const s of Object.values(servers)) s.child.kill();
  }
});
