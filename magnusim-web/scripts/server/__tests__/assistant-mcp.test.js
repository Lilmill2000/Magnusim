// Other apps on this PC reach Magnusim's tools (phase 3 spec 3.1-3.4, 3.7-3.10, 5.1, 5.3;
// M2): the loopback listener (127.0.0.1 only, the per-launch token in a 0600 mcp.json, the
// saved port, the challenge handshake both ways, connection limits), MCP sessions (external
// apps with host tools, agent bindings, the Settings Test binding), the list (names of at
// most 44 characters, hints, instructions, registration text withheld), calls (only what was
// served, one at a time per connection, rates, project data under the privacy rules), the
// open workspace (questions, privacy, progress, list changes), logging, and the server's
// lifetime (the start rule, a Vite restart, the MCP package missing).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-mcp-'));
const HOME = join(ROOT, 'home');
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
// The test routes, and the file protector (no key helper runs for the status).
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';

// Every console line, to check what the log holds.
const logged = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(String).join(' '));
    if (process.env.MCP_TEST_VERBOSE) orig(...args);
  };
}

const H = await import('./assistant-harness.js');
const M = await import('./assistant-mcp-harness.js');
const L = await import('../assistant/mcp/listener.ts');
const S = await import('../assistant/mcp/server.ts');
const B = await import('../assistant/mcp/sessions.ts');
const N = await import('../assistant/mcp/names.ts');
const routes = await import('../assistant-routes.ts');
const { Router, dispatch } = await import('../router.ts');
const { sendJson } = await import('../http.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const sdk = await import('../assistant/providers/load-sdk.ts');
const { SYSTEM_PROMPT } = await import('../assistant/prompt.ts');
const P = await import('../assistant/privacy.ts');
const G = await import('../assistant/gates.ts');

after(async () => {
  await L.resetMcpListenerForTests();
  B.resetBindingsForTests();
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const N_SCHEMA = Object.freeze({ type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 1000 } }, additionalProperties: false });
const RULE_1 = SYSTEM_PROMPT.split('\n')[1];
/** The demo workspace's notes, as appWorld's page registers them. */
const GUIDE = 'The counter starts at 0. Read it with get_count.';

/** A host tool that waits until the test releases it (or its call aborts): {def, calls}. */
function holdTool(name, { risk = 'read', projectData = false } = {}) {
  const calls = [];
  const def = H.hostTool(name, {
    risk,
    projectData,
    schema: N_SCHEMA,
    run: (input, rt) =>
      new Promise((resolve) => {
        const c = { input, rt, aborted: null };
        c.release = (out) => resolve(out ?? { ok: true, data: { n: input.n ?? null }, summary: 'released' });
        rt.signal.addEventListener(
          'abort',
          () => {
            c.aborted = rt.signal.reason ?? true;
            resolve({ ok: false, error: { code: 'aborted', message: 'aborted' }, summary: 'aborted' });
          },
          { once: true },
        );
        calls.push(c);
      }),
  });
  return { def, calls };
}

/** The demo workspace registered in `tab` straight in the registry (no page): its invoke counts calls. */
function registerDemo(m, tab, { tools, guide = 'Use add to add.\nKeep it short.', link = 'a'.repeat(24), plugin = 'ai-demo' } = {}) {
  const invoked = [];
  const r = m.registry.setWorkspace(tab, link, {
    plugin,
    pluginName: 'Workspace demo',
    workspace: 'counter',
    workspaceName: 'Counter',
    projectId: 'p1',
    studyId: 's1',
    epoch: '1',
    tools: tools ?? H.demoTools(),
    guide,
    invoke: async (call) => {
      invoked.push(call.tool);
      return { ok: true, data: { counter: 2 }, summary: 'ran' };
    },
  });
  return { invoked, r };
}

/**
 * A server lifetime's MCP service on a makeManager() (fake clock), its handler installed, and
 * the listener started. Other apps on unless `clients:false`.
 */
async function world({ hostTools = [], clients = true, privacy, presenter, gateTimeoutMs } = {}) {
  const m = H.makeManager({
    dir: ROOT,
    hostTools,
    pluginEpoch: () => '1',
    projects: { p1: { id: 'p1', title: 'Secret Wing', created_at: '2026-10-01T00:00:00.000Z' } },
    ...(presenter ? { presenter } : {}),
    ...(gateTimeoutMs ? { gateTimeoutMs } : {}),
    settings: { mcp: { clients, port: null, ask_in_client: false }, ...(privacy ? { privacy } : {}) },
  });
  const svc = S.createMcpService({
    registry: m.registry,
    runner: m.manager.runner,
    gates: m.manager.gates,
    resolveTab: (t) => m.manager.resolveTab(t),
    settings: m.deps.settings,
    projects: m.deps.projects,
    remember: m.deps.remember,
    clock: m.clock,
  });
  const dispose = L.setMcpHandler(svc.handler);
  const status = await L.startMcpListener();
  assert.equal(status.running, true, `the listener runs (${status.reason})`);
  const info = M.readInfo(L.mcpInfoPath());
  const open = [];
  return {
    m,
    svc,
    info,
    port: info.port,
    token: info.token,
    /** The SDK client over a raw socket. */
    async client(o = {}) {
      const c = await M.socketClient(info.port, info.token, o);
      open.push(c);
      return c;
    },
    async close() {
      for (const c of open) await c.close();
      dispose();
    },
  };
}

const concat = (bufs) => Buffer.concat(bufs).toString('utf8');
/** The socket's close; a test that waits past the ceiling fails rather than hangs. */
function closed(sock, ms = 10_000) {
  if (sock.destroyed && sock.readyState === 'closed') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`the socket was not closed within ${ms} ms`));
    }, ms);
    sock.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
/** Every connection's close has landed on the server (closes are seen asynchronously). */
const noConnections = () => H.until(() => L.mcpListenerStatus().connected === 0, 5000, 'the connections to close');

describe('the listener', () => {
  before(async () => {
    await L.resetMcpListenerForTests();
  });

  it('binds 127.0.0.1 only and writes mcp.json (0600) holding only version, port, token, pid and started_at; the port is saved', async () => {
    const w = await world();
    try {
      const addr = L.mcpServerForTests().address();
      assert.equal(addr.address, '127.0.0.1');
      assert.equal(addr.port, w.port);
      const path = L.mcpInfoPath();
      assert.equal(path, join(HOME, 'assistant', 'mcp.json'));
      const doc = M.readInfo(path);
      assert.deepEqual(Object.keys(doc).sort(), ['pid', 'port', 'started_at', 'token', 'version']);
      assert.equal(doc.version, 1);
      assert.equal(doc.pid, process.pid);
      assert.match(doc.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
      const saved = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
      assert.equal(saved.mcp.port, w.port);
      // Only loopback reaches it: the same port on another address of this PC refuses.
      const other = Object.values((await import('node:os')).networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal);
      if (other) {
        await assert.rejects(
          new Promise((resolve, reject) => net.connect(w.port, other.address).once('connect', resolve).once('error', reject)),
          /ECONNREFUSED|EADDRNOTAVAIL|ETIMEDOUT/,
        );
      }
    } finally {
      await w.close();
    }
  });

  it('a socket from any address but 127.0.0.1 (or ::ffff:127.0.0.1) is destroyed before a word is said', async (t) => {
    const w = await world();
    try {
      const before = L.mcpHandshakingForTests();
      // A real connection from another loopback address reaches the 127.0.0.1 listener, and is cut off.
      const sock = net.connect({ port: w.port, host: '127.0.0.1', localAddress: '127.0.0.2' });
      const got = [];
      let failed = null;
      sock.on('data', (d) => got.push(d));
      sock.on('error', (err) => (failed ??= err));
      const opened = await new Promise((resolve) => {
        sock.once('connect', () => resolve(true));
        sock.once('close', () => resolve(false));
      });
      if (!opened && ['EADDRNOTAVAIL', 'EINVAL'].includes(failed?.code)) {
        t.diagnostic(`127.0.0.2 can't be a source address here (${failed.code}); the socket pairs below still check the rule`);
      } else {
        assert.equal(opened, true, `connected from 127.0.0.2 (${failed?.code ?? 'no error'})`);
        await closed(sock);
        assert.equal(Buffer.concat(got).length, 0, 'no greeting from 127.0.0.2');
      }
      // The listener's own check on a socket pair whose remote address is set.
      const pair = async (remote) => {
        const side = net.createServer();
        await new Promise((r) => side.listen(0, '127.0.0.1', r));
        const accepted = new Promise((r) => side.once('connection', r));
        const client = net.connect(side.address().port, '127.0.0.1');
        const bytes = [];
        client.on('error', () => {});
        client.on('data', (d) => bytes.push(d));
        const server = await accepted;
        side.close();
        Object.defineProperty(server, 'remoteAddress', { get: () => remote });
        L.mcpServerForTests().emit('connection', server);
        return { client, server, bytes };
      };
      const far = await pair('192.168.1.5');
      assert.equal(far.server.destroyed, true, 'destroyed at once');
      assert.equal(L.mcpHandshakingForTests(), before, 'never a handshake');
      await closed(far.client);
      assert.equal(Buffer.concat(far.bytes).length, 0, 'no greeting');
      const mapped = await pair('::ffff:127.0.0.1');
      assert.equal(mapped.server.destroyed, false);
      assert.equal(L.mcpHandshakingForTests(), before + 1);
      await H.until(() => Buffer.concat(mapped.bytes).includes(10), 5000, 'the greeting');
      assert.equal(M.lines(Buffer.concat(mapped.bytes))[0].magnusim_mcp, 1);
      mapped.client.destroy();
      await H.until(() => L.mcpHandshakingForTests() === before, 5000, 'the waiting socket to close');
    } finally {
      await w.close();
    }
  });

  it('a stale mcp.json whose process is gone is removed before anything binds; the saved port is bound again; a taken one gives a new port, saved', async () => {
    const path = L.mcpInfoPath();
    // Its own start first (one an earlier test left running is kept): the port it binds is saved.
    const started = await world();
    const first = started.port;
    assert.equal(M.readInfo(path).port, first);
    await started.close();
    // A process that has ended: its pid is dead.
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const dead = child.pid;
    await new Promise((r) => child.once('exit', r));
    await L.resetMcpListenerForTests();
    writeFileSync(path, JSON.stringify({ version: 1, port: 1, token: 'stale-token', pid: dead, started_at: 'then' }));
    // With the MCP package missing nothing binds, and the stale file is gone all the same.
    sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, '@magnusim-test/no-such-mcp-package');
    try {
      const s = await L.startMcpListener();
      assert.deepEqual(s, { running: false, reason: 'deps_missing', port: null, connected: 0 });
      assert.equal(existsSync(path), false, 'the stale file was removed');
    } finally {
      sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, null);
    }
    // A failed start is tried again: the saved port is bound again.
    let w = await world();
    assert.equal(w.port, first, 'the saved port');
    await w.close();
    // Taken by someone else: a new port, saved.
    await L.resetMcpListenerForTests();
    const squatter = net.createServer();
    await new Promise((r) => squatter.listen(first, '127.0.0.1', r));
    try {
      w = await world();
      assert.notEqual(w.port, first);
      assert.equal(JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8')).mcp.port, w.port);
      await w.close();
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});

describe('the handshake', () => {
  let w;
  before(async () => {
    w = await world({ hostTools: [H.hostTool('app_info')] });
  });
  after(() => w.close());

  it('proves the token both ways, and the token never crosses the socket', async () => {
    const c = await w.client();
    assert.equal(c.hs.hello.magnusim_mcp, 1);
    assert.match(c.hs.hello.nonce, /^[0-9a-f]{32}$/);
    assert.deepEqual(c.hs.answer, { ok: true, proof: M.hmac(w.token, `s${c.hs.n2}`) });
    // Some traffic after it too.
    assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name), ['app_info']);
    assert.ok(!(await c.client.callTool({ name: 'app_info', arguments: {} })).isError);
    const both = concat(c.hs.sent) + concat(c.hs.received);
    assert.ok(both.length > 200);
    assert.ok(!both.includes(w.token), 'not in any byte, either way');
    assert.ok(!both.includes(Buffer.from(w.token, 'base64url').toString('hex')));
    await c.close();
    await noConnections();
  });

  it('no proof, a wrong one, or a broken greeting: refused with its code, then closed; nothing else said', async () => {
    const cases = [
      [{ proof: undefined, greeting: `${JSON.stringify({ magnusim_mcp: 1, nonce: 'a'.repeat(32), binding: null, client: 'b'.repeat(16) })}\n` }, 'token'],
      [{ proof: 'f'.repeat(64) }, 'token'],
      [{ proof: (n1) => M.hmac('another-token', `c${n1}`) }, 'token'],
      [{ proof: (n1) => M.hmac(w.token, `s${n1}`) }, 'token'],
      [{ client: 'not hex' }, 'bad_hello'],
      [{ binding: 'b-short' }, 'bad_hello'],
    ];
    for (const [o, code] of cases) {
      const hs = await M.handshake(w.port, w.token, o);
      await closed(hs.sock);
      assert.equal(hs.answer?.ok, false, JSON.stringify(o));
      assert.equal(hs.answer.code, code, JSON.stringify(o));
      assert.equal(typeof hs.answer.error, 'string');
      assert.equal(M.lines(Buffer.from(concat(hs.received))).length, 2, 'the greeting and the refusal only');
      assert.ok(!concat(hs.received).includes(w.token));
    }
  });

  it('an HTTP request, a line that is not JSON, and a greeting over 4 KB are closed with no answer, at once', async () => {
    // Far past the ceiling below: only the greeting's own checks can close these in time.
    L.setMcpListenerTimingsForTests({ handshakeMs: 120_000 });
    const raw = async (payload) => {
      const sock = net.connect(w.port, '127.0.0.1');
      const got = [];
      sock.on('data', (d) => got.push(d));
      sock.on('error', () => {});
      await new Promise((r) => sock.once('connect', r));
      sock.write(payload);
      await closed(sock);
      return M.lines(Buffer.concat(got));
    };
    try {
      for (const payload of [
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${w.port}\r\nOrigin: http://evil.example\r\n\r\n`,
        'not json at all\n',
        `${JSON.stringify({ magnusim_mcp: 2, nonce: 'a'.repeat(32) })}\n`,
        'x'.repeat(5000),
        `${JSON.stringify({ magnusim_mcp: 1, pad: 'x'.repeat(5000) })}\n`,
      ]) {
        const answered = await raw(payload);
        assert.equal(answered.length, 1, `${payload.slice(0, 30)}: only the server's greeting`);
        assert.equal(answered[0].magnusim_mcp, 1);
      }
    } finally {
      L.setMcpListenerTimingsForTests({ handshakeMs: null });
    }
  });

  it('after the handshake, a line over 8 MB closes the connection', async () => {
    await noConnections();
    const hs = await M.handshake(w.port, w.token);
    assert.equal(hs.answer.ok, true);
    await H.until(() => L.mcpListenerStatus().connected === 1, 5000, 'the connection');
    hs.sock.on('error', () => {});
    hs.sock.write(Buffer.alloc(S.MCP_LINE_MAX + 64 * 1024, 0x78));
    await closed(hs.sock);
    await noConnections();
  });

  it('silence past the deadline closes the socket', async () => {
    L.setMcpListenerTimingsForTests({ handshakeMs: 150 });
    try {
      const hs = await M.handshake(w.port, w.token, { wait: true });
      const t0 = Date.now();
      await closed(hs.sock);
      assert.ok(Date.now() - t0 < 10_000);
      assert.equal(M.lines(Buffer.from(concat(hs.received))).length, 1);
    } finally {
      L.setMcpListenerTimingsForTests({ handshakeMs: null });
    }
  });

  it('16 sockets may wait in their handshake, the 17th is destroyed, and waiting sockets take no connection slot', async () => {
    const waiting = [];
    await noConnections();
    try {
      for (let i = 0; i < 12; i += 1) waiting.push(await M.handshake(w.port, w.token, { wait: true }));
      // Four external apps connect while twelve sockets wait.
      const apps = [];
      for (let i = 0; i < 4; i += 1) apps.push(await w.client());
      for (let i = 0; i < 4; i += 1) waiting.push(await M.handshake(w.port, w.token, { wait: true }));
      assert.ok(waiting.every((h) => h.hello && !h.closed));
      const extra = await M.handshake(w.port, w.token, { wait: true });
      assert.equal(extra.hello, null, 'no greeting');
      assert.equal(extra.closed, true);
      for (const a of apps) await a.close();
    } finally {
      for (const h of waiting) h.sock.destroy();
      await H.until(() => L.mcpHandshakingForTests() === 0, 5000, 'the waiting sockets to close');
      await noConnections();
    }
  });
});

describe('who may connect', () => {
  it('an external app while Other apps is off: clients_off with the Settings text', async () => {
    const w = await world({ clients: false });
    try {
      await assert.rejects(w.client(), (err) => err.code === 'clients_off');
      const hs = await M.handshake(w.port, w.token);
      assert.deepEqual(hs.answer, { ok: false, code: 'clients_off', error: L.CLIENTS_OFF_TEXT });
      assert.match(L.CLIENTS_OFF_TEXT, /Settings → Assistant → Other apps \(MCP\)/);
    } finally {
      await w.close();
    }
  });

  it('Other apps turned off with an app connected (even outside Settings): its waiting call never runs, and its next list and call are refused clients_off', async () => {
    const hold = holdTool('hold');
    const ran = [];
    const look = H.hostTool('look', { run: async () => (ran.push('look'), { ok: true, data: {}, summary: 'looked' }) });
    const w = await world({ hostTools: [hold.def, look] });
    try {
      const c = await w.client();
      const first = c.client.callTool({ name: 'hold', arguments: { n: 1 } });
      const second = c.client.callTool({ name: 'look', arguments: {} });
      await H.until(() => hold.calls.length === 1 && w.svc.sessions()[0]?.queue.pending === 2, 5000, 'one call running, one waiting');
      w.m.state.settings.mcp.clients = false;
      hold.calls[0].release();
      assert.ok(!(await first).isError, 'the call already running ends as it would');
      assert.deepEqual(M.resultJson(await second).error, { code: 'clients_off', message: L.CLIENTS_OFF_TEXT });
      assert.deepEqual(ran, [], 'the waiting call never ran');
      await assert.rejects(c.client.listTools(), (err) => String(err.message).includes(L.CLIENTS_OFF_TEXT));
      assert.equal(M.resultJson(await c.client.callTool({ name: 'look', arguments: {} })).error.code, 'clients_off');
      assert.deepEqual(ran, []);
    } finally {
      await w.close();
    }
  });

  it('a handshake admitted while Other apps is being turned off is refused clients_off, never served', async () => {
    const w = await world();
    let reached;
    const atAdmit = new Promise((r) => (reached = r));
    let release;
    const held = new Promise((r) => (release = r));
    const seen = { served: 0, abandoned: 0 };
    // The switch was on when this handshake was admitted; it goes off before the answer.
    const disposeHeld = L.setMcpHandler({
      async admit() {
        reached();
        await held;
        return { ok: true, serve: (conn) => ((seen.served += 1), conn.close()), abandon: () => (seen.abandoned += 1) };
      },
    });
    try {
      const pending = M.handshake(w.port, w.token);
      await atAdmit;
      assert.equal(L.closeExternalMcpConnections(), 0);
      release();
      const hs = await pending;
      assert.deepEqual(hs.answer, { ok: false, code: 'clients_off', error: L.CLIENTS_OFF_TEXT });
      assert.deepEqual(seen, { served: 0, abandoned: 1 });
      await closed(hs.sock);
      assert.equal(L.mcpListenerStatus().connected, 0);
    } finally {
      release();
      disposeHeld();
      await w.close();
    }
  });

  it('bindings: an unknown one is refused, a live one is in use, and the binding takes a new connection once it closes', async () => {
    const w = await world({ clients: false });
    try {
      await assert.rejects(w.client({ binding: `b-${'0'.repeat(24)}` }), (err) => err.code === 'binding');
      const b = B.mintBinding({ conversation: 'c-1', agent: 'fake', test: true });
      // Agents connect whatever the switch says.
      const first = await w.client({ binding: b.id });
      await assert.rejects(w.client({ binding: b.id }), (err) => err.code === 'binding_in_use');
      await first.close();
      await closed(first.sock);
      await noConnections();
      const again = await w.client({ binding: b.id });
      assert.deepEqual((await again.client.listTools()).tools.map((t) => t.name), ['connection_check']);
      // The session ended: its connection closes, and the binding is refused from now on.
      B.dropBinding(b.id);
      await closed(again.sock);
      await assert.rejects(w.client({ binding: b.id }), (err) => err.code === 'binding');
    } finally {
      await w.close();
    }
  });

  it('8 connections at most, 4 of them external apps: the rest are kept for coding agents', async () => {
    await noConnections();
    const w = await world();
    try {
      for (let i = 0; i < 4; i += 1) await w.client();
      await assert.rejects(w.client(), (err) => err.code === 'busy');
      const agents = [];
      for (let i = 0; i < 4; i += 1) agents.push(await w.client({ binding: B.mintBinding({ conversation: `c-${i}`, agent: 'fake' }).id }));
      await assert.rejects(w.client({ binding: B.mintBinding({ conversation: 'c-9', agent: 'fake' }).id }), (err) => err.code === 'busy');
      assert.equal(L.mcpListenerStatus().connected, 8);
    } finally {
      await w.close();
    }
    await noConnections();
  });
});

describe('names', () => {
  it("every served name fits the providers' 64 characters under either server name a client puts before it: the agents' magnusim and the snippet's magnusim-apps", async () => {
    const A = await import('../assistant/agents/acp.ts');
    const servers = [A.MCP_SERVER_NAME, ...Object.keys(JSON.parse(L.mcpClientConfig().snippet).mcpServers)];
    assert.deepEqual(servers, ['magnusim', 'magnusim-apps']);
    assert.equal(N.MCP_SERVER_KEY, 'magnusim-apps');
    // 64 less the longer prefix: `mcp__magnusim-apps__`, 20 characters.
    assert.equal(N.clientPrefix('magnusim-apps'), 'mcp__magnusim-apps__');
    assert.equal(N.MCP_NAME_MAX, N.PROVIDER_NAME_MAX - 'mcp__magnusim-apps__'.length);
    assert.equal(N.MCP_NAME_MAX, 44);
    // Every length a tool name can have (registry.ts: up to 58).
    for (let n = 1; n <= 58; n += 1) {
      const name = `k${'a'.repeat(n - 1)}`;
      const served = N.mcpName(name);
      assert.equal(served === name, n <= N.MCP_NAME_MAX, `${n}: kept only up to the cap`);
      for (const s of servers) assert.match(`${N.clientPrefix(s)}${served}`, /^[A-Za-z0-9_-]{1,64}$/, `${s}, a ${n}-character name`);
    }
    // A longer name: its first 39 characters, `_` and 4 hex of its SHA-256.
    const long = `abcdefghijklmnopqrstuvwx__k${'a'.repeat(31)}`;
    assert.match(N.mcpName(long), new RegExp(`^${long.slice(0, 39)}_[0-9a-f]{4}$`));
  });
});

describe("why the tool connection can't run", () => {
  it('one text for every refusal (a turn, the agent Test), worded as Settings words it (AssistantStepMcp mcpReasonText): the package, or the reason and the port, "its port" with none', () => {
    assert.equal(L.mcpUnavailableText('deps_missing', 4321), "Magnusim's tool-connection package isn't installed. Run Setup.bat again.");
    assert.equal(L.mcpUnavailableText('deps_missing', 4321), sdk.MCP_DEPS_MISSING_TEXT);
    assert.equal(
      L.mcpUnavailableText('bind_failed', 49152),
      "Magnusim couldn't open the connection its tools use (bind_failed). Restart Magnusim; if it keeps happening, another program may hold port 49152.",
    );
    assert.equal(
      L.mcpUnavailableText('file_failed', null),
      "Magnusim couldn't open the connection its tools use (file_failed). Restart Magnusim; if it keeps happening, another program may hold its port.",
    );
    assert.equal(
      L.mcpUnavailableText(null, null),
      "Magnusim couldn't open the connection its tools use (not running). Restart Magnusim; if it keeps happening, another program may hold its port.",
    );
  });
});

describe('tools/list', () => {
  const SLUG = 'abcdefghijklmnopqrstuvwx'; // 24 characters: kept as the slug
  const LONG1 = `k${'a'.repeat(31)}`; // 32 characters: a 58-character tool name
  const LONG2 = `k${'a'.repeat(14)}${'b'.repeat(17)}`;
  const full2 = `${SLUG}__${LONG2}`;
  // A tool whose own name is LONG2's served name: the two collide, and the later one goes.
  const TAKER = N.mcpName(full2).slice(SLUG.length + 2);

  for (const era of ['legacy', 'modern']) {
    it(`${era}: toolsFor's list under names of at most 44 characters (a collision dropped), with hints and instructions; registration text (the guide too) withheld from external apps, not from agents`, async () => {
      const w = await world({ hostTools: [H.hostTool('app_info'), H.hostTool('wipe_all', { risk: 'destructive' }), H.hostTool('project_read', { projectData: true, available: (ctx) => (ctx.projectId ? true : 'No project.') })] });
      // Another plugin's tool that reads no project data: its registration text is withheld all the same.
      const sourced = {
        ...H.hostTool('src_pick', {
          title: 'Pick on Secret Wing',
          schema: { type: 'object', properties: { face: { type: 'string', enum: ['Secret Wing root'], description: 'A Secret Wing face.' } }, additionalProperties: false },
        }),
        description: 'Picks a face of Secret Wing.',
        projectData: false,
        source: { kind: 'plugin', plugin: 'demo', method: 'pick', epoch: '1' },
      };
      const off = w.m.registry.registerToolSource(() => [sourced]);
      try {
        const tab = H.newTabId();
        const tools = [
          { name: LONG1, title: 'Long one', description: 'The project "Secret Wing" tool.', inputSchema: N_SCHEMA, risk: 'read' },
          { name: LONG2, title: 'Long two', description: 'Dropped.', inputSchema: N_SCHEMA, risk: 'read' },
          { name: TAKER, title: 'Taker', description: 'Takes the name.', inputSchema: N_SCHEMA, risk: 'edit' },
          {
            name: 'pick',
            title: 'Pick "Secret Wing"',
            description: 'Picks a face of Secret Wing.',
            inputSchema: { type: 'object', properties: { face: { type: 'string', enum: ['wing_root', 'wing_tip'], description: 'Secret Wing face.' } }, required: ['face'], additionalProperties: false },
            risk: 'destructive',
          },
        ];
        registerDemo(w.m, tab, { tools, plugin: SLUG, guide: 'Guide line one.\nGuide line two.' });
        const c = await w.client({ era });
        assert.equal(c.client.getProtocolEra(), era);
        const listed = (await c.client.listTools()).tools;
        const names = listed.map((t) => t.name);
        assert.ok(names.every((n) => n.length <= N.MCP_NAME_MAX && /^[A-Za-z0-9_-]{1,64}$/.test(n)), names.join(','));
        const mapped1 = N.mcpName(`${SLUG}__${LONG1}`);
        assert.equal(`${SLUG}__${LONG1}`.length, 58);
        assert.equal(mapped1.length, 44);
        assert.equal(mapped1.slice(0, 39), `${SLUG}__${LONG1}`.slice(0, 39));
        // In a workspace its tools come first, then the host's (core host tools spec §12.4).
        assert.deepEqual(names, [`${SLUG}__${TAKER}`, mapped1, `${SLUG}__pick`, 'src_pick', 'app_info', 'project_read', 'wipe_all']);
        assert.ok(!names.includes('connection_check'));
        assert.ok(logged.some((l) => l.includes('mcp tool name taken') && l.includes(full2.slice(0, 40))), 'the collision is logged');
        const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
        // Host tools in full, with their hints.
        assert.equal(byName.app_info.description, 'Test tool app_info.');
        assert.deepEqual(byName.app_info.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, title: 'Run app_info' });
        assert.equal(byName.wipe_all.annotations.destructiveHint, true);
        assert.equal(byName.wipe_all.annotations.readOnlyHint, false);
        // Workspace tools: none of the registration's words or values.
        const pick = byName[`${SLUG}__pick`];
        assert.equal(pick.description, "A tool of the Workspace demo workspace; its details show once you allow this project's data.");
        assert.equal(pick.title, undefined);
        assert.deepEqual(pick.inputSchema, { type: 'object', properties: { face: { type: 'string' } }, required: ['face'], additionalProperties: false });
        assert.equal(pick.annotations.destructiveHint, true);
        assert.deepEqual(byName.src_pick, {
          name: 'src_pick',
          description: "A tool of the demo workspace; its details show once you allow this project's data.",
          inputSchema: { type: 'object', properties: { face: { type: 'string' } }, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        });
        assert.ok(!JSON.stringify(listed).includes('Secret Wing'));
        // The instructions: rule 1, and no workspace guide (registration text) for an external app.
        const text = c.client.getInstructions();
        assert.ok(text.includes(RULE_1), 'rule 1');
        assert.ok(!text.includes('Guide line'), 'no guide before the privacy rules allow the project');
        assert.ok(!text.includes('You are the Magnusim Assistant'));
        // A coding agent's session (its privacy is settled before it starts): the guide after
        // rule 1, marked as the installed plugin's, and every tool in full.
        const ctx = { tab, projectId: 'p1', simulationId: 's1', cloud: true, local: false };
        const b = B.mintBinding({ conversation: `c-guide-${era}`, agent: 'fake', dispatch: { ctx: () => ctx, run: async () => assert.fail('no call here') } });
        const a = await w.client({ era, binding: b.id });
        const agentText = a.client.getInstructions();
        assert.ok(agentText.indexOf(RULE_1) >= 0 && agentText.indexOf(RULE_1) < agentText.indexOf('Guide line one.'));
        assert.ok(agentText.includes('Notes from the Workspace demo workspace (installed plugin):\nGuide line one.\nGuide line two.'));
        const agentListed = Object.fromEntries((await a.client.listTools()).tools.map((t) => [t.name, t]));
        assert.equal(agentListed[`${SLUG}__pick`].description, 'Picks a face of Secret Wing.');
        assert.equal(agentListed.src_pick.description, 'Picks a face of Secret Wing.');
        assert.deepEqual(agentListed.src_pick.inputSchema.properties.face.enum, ['Secret Wing root']);
        B.dropBinding(b.id);
      } finally {
        off();
        await w.close();
      }
    });
  }

  it('with no app tab (or more than one), the list is tab-less: host tools that need no project', async () => {
    const w = await world({ hostTools: [H.hostTool('app_info'), H.hostTool('project_read', { projectData: true, available: (ctx) => (ctx.projectId ? true : 'No project.') })] });
    try {
      const c = await w.client();
      assert.deepEqual((await c.client.listTools()).tools.map((t) => t.name), ['app_info']);
      assert.ok(!c.client.getInstructions().includes('Notes from'));
      registerDemo(w.m, H.newTabId());
      registerDemo(w.m, H.newTabId());
      const r = await c.client.callTool({ name: 'project_read', arguments: {} });
      assert.equal(r.isError, true);
      const body = M.resultJson(r);
      assert.equal(body.error.code, 'no_tool');
      // The plain reason, worded for another app (never a turn's "name one of them").
      assert.equal(body.error.hint, S.MANY_APP_TABS_TEXT);
      assert.match(body.error.hint, /More than one app tab/);
    } finally {
      await w.close();
    }
  });
});

describe('the Settings Test binding', () => {
  it('is served exactly connection_check: the canned answer without ToolRunner, another word refused by its schema', async () => {
    const w = await world({ clients: false, hostTools: [H.hostTool('app_info')] });
    const ran = [];
    const run = w.m.manager.runner.run.bind(w.m.manager.runner);
    w.m.manager.runner.run = (...args) => {
      ran.push(args[0].name);
      return run(...args);
    };
    try {
      registerDemo(w.m, H.newTabId());
      let called = 0;
      const b = B.mintBinding({ conversation: 'c-test', agent: 'fake', test: true, onTestCall: () => (called += 1) });
      for (const era of ['legacy', 'modern']) {
        const c = await w.client({ binding: b.id, era });
        const listed = (await c.client.listTools()).tools;
        assert.equal(listed.length, 1);
        assert.equal(listed[0].name, 'connection_check');
        assert.deepEqual(listed[0].inputSchema, { type: 'object', properties: { word: { type: 'string', enum: ['ok'], description: 'Always "ok".' } }, required: ['word'], additionalProperties: false });
        const ok = await c.client.callTool({ name: 'connection_check', arguments: { word: 'ok' } });
        assert.ok(!ok.isError);
        assert.equal(ok.content[0].text, '{"tool":"connection_check","ok":true,"data":{"word":"ok"}}');
        const no = await c.client.callTool({ name: 'connection_check', arguments: { word: 'no' } });
        assert.equal(no.isError, true);
        assert.equal(M.resultJson(no).error.code, 'invalid_input');
        const other = await c.client.callTool({ name: 'app_info', arguments: {} });
        assert.equal(M.resultJson(other).error.code, 'no_tool');
        await c.close();
        await closed(c.sock);
        await noConnections();
      }
      assert.equal(called, 2, 'the Test heard each call');
      assert.deepEqual(ran, [], 'ToolRunner never ran');
    } finally {
      await w.close();
    }
  });

  it('an agent binding with no running turn runs nothing: stopped', async () => {
    const hold = holdTool('app_info');
    const w = await world({ clients: false, hostTools: [hold.def] });
    try {
      const b = B.mintBinding({ conversation: 'c-agent', agent: 'fake' });
      const c = await w.client({ binding: b.id });
      const r = await c.client.callTool({ name: 'app_info', arguments: {} });
      assert.equal(M.resultJson(r).error.code, 'stopped');
      assert.equal(M.resultJson(r).error.message, S.NOTHING_RUNS_TEXT);
      assert.equal(hold.calls.length, 0);
    } finally {
      await w.close();
    }
  });

  it("an agent binding's call gets progress as an app's does: while its turn's question waits (the dispatch says which questions are its own), and the tool's own", async () => {
    // Half way, then it waits for the test (a result sent with its progress could overtake it).
    let finish = null;
    const halves = H.hostTool('halves', {
      run: (_input, rt) =>
        new Promise((resolve) => {
          rt.progress(0.5, 'Half way');
          finish = () => resolve({ ok: true, data: {}, summary: 'done' });
        }),
    });
    const w = await world({ clients: false, hostTools: [H.hostTool('wipe_all', { risk: 'destructive' }), halves] });
    try {
      const ctx = { tab: null, projectId: null, simulationId: null, cloud: true, local: false };
      const owner = { kind: 'turn', id: 't-agent', tab: null };
      const dispatch = {
        ctx: () => ctx,
        // As the agent turn runs a call: its owner, its own wait, the progress passed on.
        run: (call, o) => w.m.manager.runner.run(call, { owner, ctx, signal: o.signal, offered: o.offered, gateTimeoutMs: 240_000, onProgress: o.onProgress }),
        owns: (gateOwner) => gateOwner.kind === 'turn' && gateOwner.id === 't-agent',
      };
      const b = B.mintBinding({ conversation: 'c-agent-progress', agent: 'fake', dispatch });
      const c = await w.client({ binding: b.id });
      const got = [];
      const call = c.client.callTool({ name: 'wipe_all', arguments: {} }, { onprogress: (p) => got.push(p) });
      await H.until(() => got.length === 1, 5000, 'the wait progress');
      assert.deepEqual(got[0], { progress: 1, message: S.WAITING_TEXT });
      const [view] = w.m.manager.gates.forTurn('t-agent');
      assert.equal(view.title, 'Allow the Assistant to run wipe_all?', "the turn's own wording");
      w.m.clock.advance(S.WAIT_PROGRESS_MS);
      await H.until(() => got.length === 2, 5000, 'the wait progress after 15 s');
      assert.equal(w.m.manager.gates.answer(view.id, true), 'ok');
      assert.ok(!(await call).isError);
      const prog = [];
      const halfway = c.client.callTool({ name: 'halves', arguments: {} }, { onprogress: (p) => prog.push(p) });
      await H.until(() => prog.length === 1, 5000, "the tool's progress");
      finish();
      assert.ok(!(await halfway).isError);
      assert.deepEqual(prog, [{ progress: 50, total: 100, message: 'Half way' }]);
      B.dropBinding(b.id);
    } finally {
      await w.close();
    }
  });
});

describe('an agent session’s binding (A4)', () => {
  it('its dispatch is the turn running now: between turns nothing runs and the last list stays; each list served is noted for the turn’s permission matcher', async () => {
    const { SessionDispatch } = await import('../assistant/agents/host.ts');
    const hold = holdTool('app_info');
    const w = await world({ clients: false, hostTools: [hold.def, H.hostTool('app_more')] });
    try {
      const sd = new SessionDispatch();
      const b = B.mintBinding({ conversation: 'c-session', agent: 'fake', dispatch: sd });
      const c = await w.client({ binding: b.id });
      assert.equal(B.bindingServes(b.id, 'app_info'), false, 'nothing listed yet');
      const listed = (await c.client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(listed, ['app_info', 'app_more']);
      assert.equal(B.bindingServes(b.id, 'app_info'), true);
      assert.equal(B.bindingServes(b.id, 'app_unknown'), false);
      // Between turns: nothing runs.
      let r = await c.client.callTool({ name: 'app_info', arguments: {} });
      assert.deepEqual([M.resultJson(r).error.code, M.resultJson(r).error.message], ['stopped', S.NOTHING_RUNS_TEXT]);
      assert.equal(hold.calls.length, 0);
      // A turn on it: its calls run in the turn's context.
      const ctx = { tab: null, projectId: null, simulationId: null, cloud: true, local: false, assistant: { provider: 'agent:fake', model: '' } };
      const seen = [];
      const turn = {
        ctx: () => ctx,
        run: (call, o) => {
          seen.push(call.name);
          return w.m.manager.runner.run(call, { owner: { kind: 'turn', id: 't-session', tab: null }, ctx, signal: o.signal, offered: o.offered });
        },
        owns: (owner) => owner.kind === 'turn' && owner.id === 't-session',
      };
      sd.setCurrent(turn);
      const running = c.client.callTool({ name: 'app_info', arguments: {} });
      await H.until(() => hold.calls.length === 1, 5000, 'the call to run');
      assert.deepEqual(hold.calls[0].rt.ctx.assistant, { provider: 'agent:fake', model: '' });
      hold.calls[0].release();
      assert.ok(!(await running).isError);
      assert.deepEqual(seen, ['app_info']);
      assert.equal(sd.owns({ kind: 'turn', id: 't-session', tab: null }), true);
      // The turn ended: nothing runs again, and the context stays the last turn's.
      sd.setCurrent(null);
      assert.equal(sd.owns({ kind: 'turn', id: 't-session', tab: null }), false);
      assert.deepEqual(sd.ctx(), ctx);
      r = await c.client.callTool({ name: 'app_info', arguments: {} });
      assert.equal(M.resultJson(r).error.code, 'stopped');
      assert.equal(hold.calls.length, 1);
      B.dropBinding(b.id);
      assert.equal(B.bindingServes(b.id, 'app_info'), false, 'a dropped binding serves nothing');
    } finally {
      await w.close();
    }
  });
});

describe('tools/call', () => {
  it('runs through ToolRunner and answers the cleaned JSON text plus images; an image over the caps fails the call', async () => {
    const pics = H.hostTool('pics', { run: async () => ({ ok: true, data: { a: 1 }, images: [{ type: 'image', mediaType: 'image/png', base64: PNG }], summary: 'pics' }) });
    const many = H.hostTool('many_pics', { run: async () => ({ ok: true, data: {}, images: Array.from({ length: 5 }, () => ({ base64: PNG })), summary: 'many' }) });
    const fails = H.hostTool('fails', { run: async () => ({ ok: false, error: { code: 'not_found', message: 'Nothing there.', hint: 'Look elsewhere.' }, summary: 'no' }) });
    const w = await world({ hostTools: [pics, many, fails] });
    try {
      for (const era of ['legacy', 'modern']) {
        const c = await w.client({ era });
        const r = await c.client.callTool({ name: 'pics', arguments: {} });
        assert.ok(!r.isError);
        assert.deepEqual(M.resultJson(r), { tool: 'pics', ok: true, data: { a: 1 } });
        assert.deepEqual(r.content[1], { type: 'image', data: PNG, mimeType: 'image/png' });
        const big = await c.client.callTool({ name: 'many_pics', arguments: {} });
        assert.equal(big.isError, true);
        assert.equal(M.resultJson(big).error.code, 'too_large');
        assert.equal(big.content.length, 1);
        const f = await c.client.callTool({ name: 'fails', arguments: {} });
        assert.equal(f.isError, true);
        assert.deepEqual(M.resultJson(f), { tool: 'fails', ok: false, error: { code: 'not_found', message: 'Nothing there.', hint: 'Look elsewhere.' } });
        const bad = await c.client.callTool({ name: 'pics', arguments: { extra: 1 } });
        assert.equal(M.resultJson(bad).error.code, 'invalid_input');
      }
    } finally {
      await w.close();
    }
  });

  it("a page's error reaches the app with its hint and detail, as the Assistant's model gets them; a result's summary is the log's line only and never reaches the app (CAD tools spec H2)", async () => {
    const w = await appWorld();
    try {
      const c = await w.client();
      const failing = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 2 } });
      await w.answer(0, { ok: false, error: { code: 'invalid_input', message: 'The counter is locked.', hint: 'Unlock it first, then add.', detail: { locked: true, allowed: [] } } });
      const f = await failing;
      assert.equal(f.isError, true);
      assert.deepEqual(M.resultJson(f), {
        tool: 'ai-demo__add',
        ok: false,
        error: { code: 'invalid_input', message: 'The counter is locked.', hint: 'Unlock it first, then add.', detail: { locked: true, allowed: [] } },
      });
      const ok = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 2 } });
      await w.answer(1, { ok: true, result: { data: { count: 2 }, summary: 'Added 2: the counter is 2' } });
      const r = await ok;
      assert.deepEqual(M.resultJson(r), { tool: 'ai-demo__add', ok: true, data: { count: 2 } });
      assert.ok(!JSON.stringify(r).includes('Added 2: the counter is 2'), 'the summary stays the log line');
    } finally {
      await w.close();
    }
  });

  it('a call resolves only in the list served on its connection: a name not served is no_tool; a tool of an earlier list is unavailable with the hint', async () => {
    let version = 1;
    const make = (v) =>
      H.hostTool('from_source', { available: () => (version === v ? true : 'It changed since it was listed.') });
    const defs = new Map([[1, { ...make(1), source: { kind: 'plugin', plugin: 'demo', method: 'x', epoch: '1' } }]]);
    const w = await world({ hostTools: [H.hostTool('app_info')] });
    const off = w.m.registry.registerToolSource(() => [defs.get(version)]);
    try {
      const c = await w.client();
      // Before any tools/list, the current list counts as served.
      assert.ok(!(await c.client.callTool({ name: 'from_source', arguments: {} })).isError);
      const listed = (await c.client.listTools()).tools.map((t) => t.name);
      assert.deepEqual(listed, ['app_info', 'from_source']);
      // A tool added since the list was served is not callable until it is listed.
      const late = H.hostTool('late_tool');
      w.m.registry.addHostTool(late);
      assert.equal(M.resultJson(await c.client.callTool({ name: 'late_tool', arguments: {} })).error.code, 'no_tool');
      assert.equal(M.resultJson(await c.client.callTool({ name: 'nowhere', arguments: {} })).error.code, 'no_tool');
      // The source re-registers: the served tool is of the earlier list.
      version = 2;
      defs.set(2, { ...make(2), source: { kind: 'plugin', plugin: 'demo', method: 'x', epoch: '1' } });
      const r = await c.client.callTool({ name: 'from_source', arguments: {} });
      assert.equal(r.isError, true);
      assert.deepEqual(M.resultJson(r).error, { code: 'unavailable', message: 'It changed since it was listed.', hint: S.TOOLS_CHANGED_HINT });
      await c.client.listTools();
      assert.ok(!(await c.client.callTool({ name: 'from_source', arguments: {} })).isError, 'listed again, it runs');
      assert.ok(!(await c.client.callTool({ name: 'late_tool', arguments: {} })).isError);
    } finally {
      off();
      await w.close();
    }
  });

  it("before privacy allows the project, no answer gives away a tool's withheld values: a tool of a list that went (its tab hidden, its workspace closed) is unavailable before its input is read, under Ask and Never send; a bad value for a tool listed without its words is refused without them", async () => {
    const SECRET = { type: 'object', properties: { body: { type: 'string', enum: ['Secret_Wing_Spar', 'Secret_Flap'] } }, required: ['body'], additionalProperties: false };
    for (const privacy of ['ask', 'deny']) {
      for (const how of ['hidden', 'closed']) {
        const w = await world({ privacy });
        try {
          const tab = H.newTabId();
          const link = 'a'.repeat(24);
          registerDemo(w.m, tab, { link, tools: [{ name: 'pick', title: 'Pick', description: 'Picks a body.', inputSchema: SECRET, risk: 'edit' }] });
          const c = await w.client();
          const listed = (await c.client.listTools()).tools.find((t) => t.name === 'ai-demo__pick');
          assert.deepEqual(listed.inputSchema.properties.body, { type: 'string' });
          if (how === 'hidden') w.m.registry.setConnected(tab, link, false);
          else w.m.registry.setWorkspace(tab, link, null);
          const r = await c.client.callTool({ name: 'ai-demo__pick', arguments: { body: 'x' } });
          assert.ok(!r.content[0].text.includes('Secret'), `${privacy}, ${how}: ${r.content[0].text}`);
          assert.deepEqual([M.resultJson(r).error.code, M.resultJson(r).error.hint], ['unavailable', S.TOOLS_CHANGED_HINT], `${privacy}, ${how}`);
          assert.equal(w.m.manager.gates.openCount(), 0);
        } finally {
          await w.close();
        }
      }
    }
    // Another plugin's tool that runs with no tab (and reads no project data): listed without its words.
    const w = await world({ privacy: 'ask' });
    const sourced = { ...H.hostTool('src_pick', { schema: SECRET }), description: 'Picks a body.', projectData: false, source: { kind: 'plugin', plugin: 'demo', method: 'pick', epoch: '1' } };
    const off = w.m.registry.registerToolSource(() => [sourced]);
    try {
      const c = await w.client();
      assert.deepEqual((await c.client.listTools()).tools.find((t) => t.name === 'src_pick').inputSchema.properties.body, { type: 'string' });
      const bad = await c.client.callTool({ name: 'src_pick', arguments: { body: 'x' } });
      assert.deepEqual(M.resultJson(bad).error, { code: 'invalid_input', message: S.WITHHELD_INPUT_TEXT });
      // What the listed schema shows is said as ever.
      const missing = M.resultJson(await c.client.callTool({ name: 'src_pick', arguments: {} })).error;
      assert.equal(missing.code, 'invalid_input');
      assert.notEqual(missing.message, S.WITHHELD_INPUT_TEXT);
      assert.match(missing.message, /body/);
      assert.ok(!JSON.stringify(missing).includes('Secret'));
      // Once privacy allows it, the answer is the tool's own.
      w.m.state.settings.privacy = 'allow';
      assert.match(M.resultJson(await c.client.callTool({ name: 'src_pick', arguments: { body: 'x' } })).error.message, /Secret_Wing_Spar/);
    } finally {
      off();
      await w.close();
    }
  });

  it('privacy is read again right before the tool runs and before its result goes: Never send chosen while its question waits leaves it unrun; chosen while it runs keeps its result back (privacy_denied)', async () => {
    const ran = [];
    const crunch = H.hostTool('crunch', { risk: 'compute', projectData: true, run: async () => (ran.push('crunch'), { ok: true, data: { secret: 'Secret Wing results' }, summary: 'crunched' }) });
    const hold = holdTool('peek_project', { projectData: true });
    const shown = [];
    const presenter = { present: (view, owner) => (shown.push({ view, owner }), true), withdraw: () => {} };
    const w = await world({ hostTools: [crunch, hold.def], privacy: 'allow', presenter });
    try {
      const tab = H.newTabId();
      registerDemo(w.m, tab);
      const c = await w.client();
      const asked = c.client.callTool({ name: 'crunch', arguments: {} });
      await H.until(() => shown.length === 1, 5000, 'the question');
      w.m.state.settings.privacy = 'deny';
      assert.equal(w.m.manager.answerGate(shown[0].view.id, true, { kind: 'link', tab }).status, 200);
      const r = await asked;
      assert.deepEqual(M.resultJson(r).error, { code: 'privacy_denied', message: P.MCP_PRIVACY_DENIED_TEXT });
      assert.deepEqual(ran, [], 'it never ran');
      // Chosen while it runs: it ran, and its result stays here.
      w.m.state.settings.privacy = 'allow';
      const reading = c.client.callTool({ name: 'peek_project', arguments: { n: 7 } });
      await H.until(() => hold.calls.length === 1, 5000, 'the call to run');
      w.m.state.settings.privacy = 'deny';
      hold.calls[0].release({ ok: true, data: { secret: 'Secret Wing data' }, images: [{ base64: PNG }], summary: 'read' });
      const kept = await reading;
      assert.equal(kept.isError, true);
      assert.deepEqual(M.resultJson(kept).error, { code: 'privacy_denied', message: S.RESULT_KEPT_TEXT });
      assert.equal(kept.content.length, 1, 'no picture either');
      assert.ok(!kept.content[0].text.includes('Secret'));
    } finally {
      await w.close();
    }
  });

  it('project data, read live per call (destination mcp): Always allow runs the tools; Never send refuses them (privacy_denied) and never reaches the page; tools that read none run whatever the mode', async () => {
    const reads = H.hostTool('project_read', { projectData: true, available: (ctx) => (ctx.projectId ? true : 'No project.') });
    const w = await world({ hostTools: [reads, H.hostTool('app_info')], privacy: 'allow' });
    try {
      const tab = H.newTabId();
      const demo = registerDemo(w.m, tab);
      const c = await w.client();
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('ai-demo__add') && names.includes('project_read'));
      for (const name of ['ai-demo__add', 'project_read']) {
        assert.ok(!(await c.client.callTool({ name, arguments: name === 'ai-demo__add' ? { by: 1 } : {} })).isError, name);
      }
      assert.deepEqual(demo.invoked, ['add']);
      assert.equal(w.m.manager.gates.openCount(), 0, 'Always allow asks nothing');
      // Never send, chosen while connected: the next call reads it.
      w.m.state.settings.privacy = 'deny';
      for (const name of ['ai-demo__add', 'ai-demo__get_count', 'project_read']) {
        const r = await c.client.callTool({ name, arguments: name === 'ai-demo__add' ? { by: 1 } : {} });
        assert.equal(r.isError, true);
        assert.deepEqual(M.resultJson(r).error, { code: 'privacy_denied', message: P.MCP_PRIVACY_DENIED_TEXT }, name);
      }
      assert.deepEqual(demo.invoked, ['add'], 'the page was never reached again');
      assert.ok(!(await c.client.callTool({ name: 'app_info', arguments: {} })).isError, 'a tool that reads no project data runs');
      assert.equal(w.m.manager.gates.openCount(), 0);
      assert.deepEqual(w.m.consents, [], 'nothing remembered');
    } finally {
      await w.close();
    }
  });

  it('a tool that asks first opens its question in the tab the call runs in (owner mcp with that tab), answered only through that tab; with no tab to show it, refused no_window at once; edits and reads run', async () => {
    const ran = [];
    const tool = (name, risk) => H.hostTool(name, { risk, run: async () => (ran.push(name), { ok: true, data: {}, summary: name }) });
    const shown = [];
    const presenter = { present: (view, owner) => (shown.push({ view, owner }), true), withdraw: () => {} };
    const w = await world({ hostTools: [tool('wipe_all', 'destructive'), tool('crunch', 'compute'), tool('odd', 'unknown'), tool('tweak', 'edit'), tool('look', 'read')], presenter, gateTimeoutMs: 60_000 });
    try {
      const c = await w.client();
      // No app tab: nobody could see the question.
      for (const name of ['wipe_all', 'crunch', 'odd']) {
        const r = await c.client.callTool({ name, arguments: {} });
        assert.deepEqual(M.resultJson(r).error, { code: 'no_window', message: S.NO_WINDOW_TEXT, hint: S.NO_APP_TAB_TEXT }, name);
      }
      for (const name of ['tweak', 'look']) assert.ok(!(await c.client.callTool({ name, arguments: {} })).isError, name);
      assert.deepEqual(ran, ['tweak', 'look']);
      assert.equal(w.m.manager.gates.openCount(), 0, 'no question was opened');
      // One app tab: the question is shown there, owned by this connection's session.
      const tab = H.newTabId();
      registerDemo(w.m, tab);
      const session = w.svc.sessions()[0].id;
      const asked = c.client.callTool({ name: 'wipe_all', arguments: {} });
      await H.until(() => shown.length === 1, 5000, 'the question shown');
      const { view, owner } = shown[0];
      assert.deepEqual(owner, { kind: 'mcp', session, tab });
      assert.deepEqual([view.kind, view.turn, view.risk, view.tool], ['confirm', null, 'destructive', 'wipe_all']);
      // Another app asks, not the Assistant: the question says so.
      assert.equal(view.title, 'Allow an app on this PC to run wipe_all?');
      assert.equal(view.copy, "An app on this PC using Magnusim's tools (\"socket-client\", as it calls itself) asks for this. Magnusim · can't be undone. What it sent: {}. Nothing runs until you choose.");
      // Ten minutes for an external app's question, whatever the broker's own wait (a minute here).
      assert.equal(S.MCP_GATE_TIMEOUT_MS, 10 * 60_000);
      assert.equal(view.expires_at, new Date(Date.parse(view.opened_at) + S.MCP_GATE_TIMEOUT_MS).toISOString(), 'ten minutes');
      // Nothing but the tab answers it: no answer key (an MCP client has none), not another tab.
      assert.equal(w.m.manager.answerGate(view.id, true, { kind: 'key', key: 'f'.repeat(32) }).body.code, 'answer_key');
      assert.equal(w.m.manager.answerGate(view.id, true, { kind: 'key', key: undefined }).body.code, 'answer_key');
      assert.equal(w.m.manager.answerGate(view.id, true, { kind: 'link', tab: H.newTabId() }).body.code, 'not_shown');
      assert.deepEqual(ran, ['tweak', 'look'], 'still waiting');
      assert.equal(w.m.manager.answerGate(view.id, true, { kind: 'link', tab }).status, 200);
      assert.ok(!(await asked).isError);
      assert.deepEqual(ran, ['tweak', 'look', 'wipe_all']);
    } finally {
      await w.close();
    }
  });

  it('one call at a time per connection, in order; a 17th waiting call is busy; cancelling one aborts it', async () => {
    const hold = holdTool('hold');
    const w = await world({ hostTools: [hold.def] });
    try {
      const c = await w.client();
      const pending = Array.from({ length: 16 }, (_, n) => c.client.callTool({ name: 'hold', arguments: { n } }));
      await H.until(() => hold.calls.length === 1, 5000, 'the first call');
      await H.until(() => w.svc.sessions()[0]?.queue.pending === 16, 5000, 'all 16 in the queue');
      const busy = await c.client.callTool({ name: 'hold', arguments: { n: 99 } });
      assert.equal(M.resultJson(busy).error.code, 'busy');
      assert.equal(hold.calls.length, 1, 'only one runs');
      for (let i = 0; i < 16; i += 1) {
        await H.until(() => hold.calls.length === i + 1, 5000, `call ${i}`);
        await H.tick();
        assert.equal(hold.calls.length, i + 1, 'the next waits for the one before');
        assert.equal(hold.calls[i].input.n, i, 'in order');
        hold.calls[i].release();
      }
      const results = await Promise.all(pending);
      assert.deepEqual(
        results.map((r) => M.resultJson(r).data.n),
        Array.from({ length: 16 }, (_, n) => n),
      );
      // A cancelled call (notifications/cancelled) is aborted as Stop aborts it.
      const ac = new AbortController();
      const cancelled = c.client.callTool({ name: 'hold', arguments: { n: 7 } }, { signal: ac.signal });
      await H.until(() => hold.calls.length === 17, 5000, 'the cancellable call');
      ac.abort('changed my mind');
      await assert.rejects(cancelled);
      await H.until(() => hold.calls[16].aborted, 5000, 'the abort to reach the tool');
      assert.equal(hold.calls[16].aborted.code, 'stopped');
    } finally {
      await w.close();
    }
  });

  it('cancelling a call that waits in the queue removes it at once: it never runs, and the call behind it runs after the one ahead', async () => {
    const hold = holdTool('hold');
    const w = await world({ hostTools: [hold.def] });
    try {
      const c = await w.client();
      const one = c.client.callTool({ name: 'hold', arguments: { n: 1 } });
      const ac = new AbortController();
      const two = c.client.callTool({ name: 'hold', arguments: { n: 2 } }, { signal: ac.signal });
      two.catch(() => {});
      const three = c.client.callTool({ name: 'hold', arguments: { n: 3 } });
      const queue = () => w.svc.sessions()[0]?.queue;
      await H.until(() => hold.calls.length === 1 && queue()?.pending === 3, 5000, 'one call running, two waiting');
      ac.abort('not this one');
      await assert.rejects(two);
      await H.until(() => queue().pending === 2, 5000, 'the cancelled call to leave the queue');
      assert.equal(hold.calls.length, 1, 'the call ahead still holds');
      hold.calls[0].release();
      await H.until(() => hold.calls.length === 2, 5000, 'the call behind');
      assert.equal(hold.calls[1].input.n, 3, 'the cancelled call never ran');
      hold.calls[1].release();
      assert.equal(M.resultJson(await one).data.n, 1);
      assert.equal(M.resultJson(await three).data.n, 3);
      assert.equal(hold.calls.length, 2);
    } finally {
      await w.close();
    }
  });

  it('a connection that closes aborts its running call and its queued ones never run', async () => {
    const hold = holdTool('hold');
    const w = await world({ hostTools: [hold.def] });
    try {
      const c = await w.client();
      const calls = [0, 1, 2].map((n) => c.client.callTool({ name: 'hold', arguments: { n } }).catch((e) => e));
      await H.until(() => hold.calls.length === 1, 5000, 'the first call');
      c.sock.destroy();
      await H.until(() => hold.calls[0].aborted, 5000, 'the running call aborted');
      assert.deepEqual(hold.calls[0].aborted, { code: 'stopped', cause: 'socket-client disconnected' }, 'the app went: not the server, not a Stop');
      await Promise.all(calls);
      await noConnections();
      assert.equal(hold.calls.length, 1, 'the queued calls never ran');
    } finally {
      await w.close();
    }
  });

  it("an agent binding's running call says who went, never the person: the agent's side closing, its binding dropped at its exit; Magnusim dropping it is the server", async () => {
    const hold = holdTool('hold');
    const w = await world({ clients: false, hostTools: [hold.def] });
    try {
      const ctx = { tab: null, projectId: null, simulationId: null, cloud: true, local: false };
      const owner = { kind: 'turn', id: 't-gone', tab: null };
      const results = [];
      const dispatch = {
        ctx: () => ctx,
        run: async (call, o) => {
          const r = await w.m.manager.runner.run(call, { owner, ctx, signal: o.signal, offered: o.offered });
          results.push(r.summary);
          return r;
        },
      };
      const ends = [
        // The bridge's socket closes (the agent exited; the bridge is its child).
        ['the socket', (b, c) => c.sock.destroy(), 'Fake Agent stopped unexpectedly while it ran; it may or may not have finished.'],
        // The agent's exit seen first: its binding is dropped with that cause.
        ['its exit', (b) => B.dropBinding(b.id, { cause: 'Fake Agent stopped unexpectedly' }), 'Fake Agent stopped unexpectedly while it ran; it may or may not have finished.'],
        // Magnusim ended the agent: the server.
        ['Magnusim', (b) => B.dropBinding(b.id), 'The server stopped while it ran; it may or may not have finished.'],
      ];
      for (const [i, [label, end, text]] of ends.entries()) {
        const b = B.mintBinding({ conversation: `c-gone-${i}`, agent: 'fake', name: 'Fake Agent', dispatch });
        const c = await w.client({ binding: b.id });
        const call = c.client.callTool({ name: 'hold', arguments: { n: i } }).catch((e) => e);
        await H.until(() => hold.calls.length === i + 1, 5000, `the call (${label})`);
        end(b, c);
        await H.until(() => results.length === i + 1, 5000, `its result (${label})`);
        assert.equal(results[i], text, label);
        await call;
        B.dropBinding(b.id);
        await closed(c.sock);
      }
    } finally {
      await w.close();
    }
  });

  it('external apps share 120 changes and 1200 calls an hour, process-wide: a reconnect resets nothing; an hour later they run again', async () => {
    S.resetMcpRatesForTests();
    const w = await world({ hostTools: [H.hostTool('bump', { risk: 'edit' }), H.hostTool('peek')] });
    try {
      let c = await w.client();
      for (let i = 0; i < 120; i += 1) {
        if (i === 60) {
          await c.close();
          c = await w.client();
        }
        assert.ok(!(await c.client.callTool({ name: 'bump', arguments: {} })).isError, `change ${i}`);
      }
      await c.close();
      c = await w.client();
      const limited = await c.client.callTool({ name: 'bump', arguments: {} });
      assert.deepEqual(M.resultJson(limited).error, { code: 'rate_limited', message: "Other apps reached Magnusim's limit of 120 changes an hour. Try again in 60 minutes." });
      assert.ok(!(await c.client.callTool({ name: 'peek', arguments: {} })).isError, 'reads go on');
      w.m.clock.advance(30 * 60_000);
      assert.match(M.resultJson(await c.client.callTool({ name: 'bump', arguments: {} })).error.message, /Try again in 30 minutes\./);
      w.m.clock.advance(30 * 60_000);
      assert.ok(!(await c.client.callTool({ name: 'bump', arguments: {} })).isError, 'an hour later');
      // 1200 calls of any kind (pipelined: up to 16 wait on the connection at once).
      S.resetMcpRatesForTests();
      let left = 1200;
      while (left > 0) {
        const batch = Math.min(16, left);
        const rs = await Promise.all(Array.from({ length: batch }, () => c.client.callTool({ name: 'peek', arguments: {} })));
        assert.ok(rs.every((r) => !r.isError));
        left -= batch;
      }
      assert.match(M.resultJson(await c.client.callTool({ name: 'peek', arguments: {} })).error.message, /limit of 1200 tool calls an hour/);
    } finally {
      S.resetMcpRatesForTests();
      await w.close();
    }
  });

  it('the log: a line per connection and per call, with no inputs, results, arguments or the token', async () => {
    const IN = 'canary-input-7f3a';
    const OUT = 'canary-result-9b2c';
    const echo = H.hostTool('echo', {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      run: async () => ({ ok: true, data: { text: OUT }, summary: `echoed ${OUT}` }),
    });
    const w = await world({ hostTools: [echo] });
    const from = logged.length;
    try {
      const c = await w.client({ name: 'Logging App' });
      const r = await c.client.callTool({ name: 'echo', arguments: { text: IN } });
      assert.equal(M.resultJson(r).data.text, OUT);
      await c.client.callTool({ name: 'echo', arguments: { text: 5 } });
      await c.close();
      await H.until(() => logged.slice(from).some((l) => l.includes('mcp connection closed')), 5000, 'the close line');
      const lines = logged.slice(from).filter((l) => l.includes('[assistant] mcp'));
      const opened = lines.filter((l) => l.includes('mcp connection opened'));
      const callLines = lines.filter((l) => l.includes('mcp call'));
      const closedLines = lines.filter((l) => l.includes('mcp connection closed'));
      assert.equal(opened.length, 1);
      assert.equal(callLines.length, 2);
      assert.equal(closedLines.length, 1);
      const call = JSON.parse(callLines[0].slice(callLines[0].indexOf('{')));
      assert.deepEqual(Object.keys(call).sort(), ['code', 'ms', 'ok', 'risk', 'session', 'tool']);
      assert.deepEqual({ tool: call.tool, risk: call.risk, ok: call.ok, code: call.code }, { tool: 'echo', risk: 'read', ok: true, code: null });
      assert.equal(JSON.parse(callLines[1].slice(callLines[1].indexOf('{'))).code, 'invalid_input');
      const close = JSON.parse(closedLines[0].slice(closedLines[0].indexOf('{')));
      assert.deepEqual(
        { kind: close.kind, client_name: close.client_name, calls: close.calls, binding: close.binding },
        { kind: 'external', client_name: 'Logging App', calls: 2, binding: undefined },
      );
      for (const l of logged.slice(from)) {
        assert.ok(!l.includes(IN) && !l.includes(OUT) && !l.includes(w.token), l);
      }
    } finally {
      await w.close();
    }
  });
});

/**
 * The open workspace as the server sees it: a server wired as index.ts wires one (its relay,
 * its gates and its MCP service installed on the listener), a page whose demo workspace
 * registered its tools in its tab (project p1), and SDK clients over the listener. Privacy
 * Always allow unless `privacy`.
 */
async function appWorld({ privacy = 'allow', hostTools = [] } = {}) {
  await L.startMcpListener();
  const m = H.makeManager({
    dir: ROOT,
    hostTools,
    projects: { p1: { id: 'p1', title: 'Secret Wing', created_at: '2026-10-01T00:00:00.000Z' } },
    settings: { privacy, mcp: { clients: true, port: null, ask_in_client: false } },
  });
  const s = await H.relayServer(m);
  const page = await s.page();
  const link = await page.open();
  assert.equal((await s.register(link, 1, H.demoTools(), { guide: GUIDE })).status, 200);
  const info = M.readInfo(L.mcpInfoPath());
  const open = [];
  return {
    m,
    s,
    page,
    link,
    info,
    async client(o = {}) {
      const c = await M.socketClient(info.port, info.token, o);
      open.push(c);
      return c;
    },
    /** The page answers its n-th invoke (0-based): acknowledged, then `result`. */
    async answer(n, result = { ok: true, result: { text: 'Done.', data: { count: 2 } } }) {
      const inv = await page.frame('invoke', n);
      await s.progress(link, inv.call, { ack: true });
      await s.result(link, inv.call, result);
      return inv;
    },
    async close() {
      for (const c of open) await c.close();
      await s.close();
      await noConnections();
    },
  };
}

/** How many progress notifications reached a socket client, as bytes on the wire (the SDK drops those of a request it has done with). */
const progressOnWire = (c) => Buffer.concat(c.hs.received).toString('utf8').split('notifications/progress').length - 1;

/** A client's list_changed notifications, counted (no refresh: the test lists when it means to). */
function listChanges() {
  const seen = { n: 0 };
  seen.option = { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => (seen.n += 1) } };
  return seen;
}

describe('in the open workspace: questions, privacy, progress and list changes', { timeout: 60_000 }, () => {
  it("a destructive workspace tool asks as the app's own question in the tab the call runs in; wait progress at once and every 15 s; no answer key or other tab answers it, the tab's link does, and the tool runs", async () => {
    const w = await appWorld();
    try {
      const c = await w.client({ name: 'Desk App' });
      const got = [];
      const call = c.client.callTool({ name: 'ai-demo__reset', arguments: {} }, { onprogress: (p) => got.push(p) });
      const gate = (await w.page.frame('gate')).gate;
      assert.deepEqual([gate.kind, gate.turn, gate.tool, gate.risk, gate.yes, gate.no], ['confirm', null, 'ai-demo__reset', 'destructive', 'Allow', "Don't"]);
      // Asked for another app, not the Assistant: the question says so, naming it as it calls itself.
      assert.equal(gate.title, 'Allow an app on this PC to reset the counter?');
      assert.equal(
        gate.copy,
        "An app on this PC using Magnusim's tools (\"Desk App\", as it calls itself) asks for this. Workspace demo (Counter) · can't be undone. What it sent: {}. Nothing runs until you choose.",
      );
      assert.equal(gate.expires_at, new Date(Date.parse(gate.opened_at) + 10 * 60_000).toISOString(), 'ten minutes');
      assert.equal(G.tabOf({ kind: 'mcp', session: 'm-x', tab: w.page.tab }), w.page.tab);
      await H.until(() => got.length === 1, 5000, 'the first wait progress');
      assert.deepEqual(got[0], { progress: 1, message: S.WAITING_TEXT });
      w.m.clock.advance(S.WAIT_PROGRESS_MS - 1);
      await H.tick();
      assert.equal(got.length, 1, 'not before 15 s');
      w.m.clock.advance(1);
      await H.until(() => got.length === 2, 5000, 'the wait progress after 15 s');
      assert.deepEqual(got[1], { progress: 2, message: S.WAITING_TEXT });
      // An answer key (the client has none; a turn's is not this question's) or another tab's link: refused, still open.
      let r = await w.s.post(`/api/assistant/gates/${gate.id}`, { allow: true, answer_key: 'f'.repeat(32) });
      assert.deepEqual([r.status, r.json.code], [403, 'answer_key']);
      const other = await w.s.page();
      const otherLink = await other.open();
      r = await w.s.post('/api/assistant/relay/gate', { link: otherLink, gate: gate.id, allow: true });
      assert.deepEqual([r.status, r.json.code], [403, 'not_shown']);
      assert.deepEqual(w.page.of('invoke'), [], 'nothing ran');
      assert.equal(w.s.handle.turns.gates.openCount(), 1);
      // The tab that shows it answers it: the page runs the tool.
      r = await w.s.post('/api/assistant/relay/gate', { link: w.link, gate: gate.id, allow: true });
      assert.deepEqual([r.status, r.json], [200, { ok: true }]);
      const inv = await w.answer(0, { ok: true, result: { text: 'The counter is 0.', data: { count: 0 } } });
      // Its question has no turn; the tool is told the app's connection as its turn.
      assert.deepEqual([inv.tool, inv.turn], ['reset', `mcp:${L.mcpConnections().find((row) => row.name === 'Desk App').id}`]);
      const result = await call;
      assert.ok(!result.isError);
      assert.deepEqual(M.resultJson(result), { tool: 'ai-demo__reset', ok: true, data: { count: 0 }, text: 'The counter is 0.' });
      assert.deepEqual(await w.page.frame('gate_closed'), { gate: gate.id, answer: 'allow', by: 'user' });
      // Answered: no more wait progress (a round trip after the clock moved shows none was sent).
      const sent = progressOnWire(c);
      assert.equal(sent, 2);
      w.m.clock.advance(S.WAIT_PROGRESS_MS * 2);
      await c.client.listTools();
      assert.equal(progressOnWire(c), sent);
      other.close();
    } finally {
      await w.close();
    }
  });

  it('its tab hidden while the question waits: the wait progress says so once the tab has had no live link for 15 s; ten minutes decline it, and the tool never ran', async () => {
    const w = await appWorld();
    try {
      const c = await w.client();
      const got = [];
      const call = c.client.callTool({ name: 'ai-demo__reset', arguments: {} }, { onprogress: (p) => got.push(p) });
      const gate = (await w.page.frame('gate')).gate;
      await H.until(() => got.length === 1, 5000, 'the first wait progress');
      // The tab's link goes (its window hidden long enough, or closed).
      await w.page.unsubscribe();
      await H.until(() => !w.s.relay.snapshot()[w.page.tab]?.connected, 5000, 'the link to go');
      w.m.clock.advance(S.WAIT_PROGRESS_MS);
      await H.until(() => got.length === 2, 5000, 'the progress at 15 s');
      w.m.clock.advance(S.WAIT_PROGRESS_MS);
      await H.until(() => got.length === 3, 5000, 'the progress at 30 s');
      assert.deepEqual(
        got.map((p) => p.message),
        [S.WAITING_TEXT, S.WAITING_TEXT, S.WAITING_HIDDEN_TEXT],
      );
      assert.equal(w.s.handle.turns.gates.unseen(gate.id), true);
      // Nobody answers: ten minutes after it opened, it is declined.
      w.m.clock.advance(10 * 60_000 - 2 * S.WAIT_PROGRESS_MS - 1);
      await H.tick();
      assert.equal(w.s.handle.turns.gates.openCount(), 1, 'not before ten minutes');
      w.m.clock.advance(1);
      const r = await call;
      assert.equal(r.isError, true);
      assert.equal(M.resultJson(r).error.code, 'declined');
      assert.equal(w.s.handle.turns.gates.closedAs(gate.id).by, 'timeout');
      assert.deepEqual(w.page.of('invoke'), [], 'it never ran');
    } finally {
      await w.close();
    }
  });

  it('the client cancels while a question waits: the question closes (stop) in the tab, the tool never runs, the progress stops, and the next call runs', async () => {
    const w = await appWorld();
    try {
      const c = await w.client();
      const got = [];
      const ac = new AbortController();
      const call = c.client.callTool({ name: 'ai-demo__reset', arguments: {} }, { signal: ac.signal, onprogress: (p) => got.push(p) });
      call.catch(() => {});
      const gate = (await w.page.frame('gate')).gate;
      await H.until(() => got.length === 1, 5000, 'the first wait progress');
      ac.abort('changed my mind');
      await assert.rejects(call);
      assert.deepEqual(await w.page.frame('gate_closed'), { gate: gate.id, answer: 'deny', by: 'stop' });
      await H.until(() => w.s.handle.turns.gates.openCount() === 0, 5000, 'the question to close');
      const sent = progressOnWire(c);
      assert.equal(sent, 1);
      w.m.clock.advance(S.WAIT_PROGRESS_MS * 2);
      await c.client.listTools();
      assert.equal(progressOnWire(c), sent, 'no progress after the cancel');
      // The connection's queue is free: the next call runs.
      const next = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 2 } });
      const inv = await w.answer(0);
      assert.equal(inv.tool, 'add', 'the reset never reached the page');
      assert.ok(!(await next).isError);
    } finally {
      await w.close();
    }
  });

  it("a tool's own progress reaches the client as notifications/progress: round(fraction*100) of 100 with its label, then counts", async () => {
    const w = await appWorld();
    try {
      const c = await w.client();
      const got = [];
      const call = c.client.callTool({ name: 'ai-demo__slow_add', arguments: { by: 1 } }, { onprogress: (p) => got.push(p) });
      const inv = await w.page.frame('invoke', 0);
      await w.s.progress(w.link, inv.call, { ack: true });
      await w.s.progress(w.link, inv.call, { fraction: 0.25, label: 'Adding 1: step 1' });
      await H.until(() => got.length === 1, 5000, 'the progress');
      await w.s.progress(w.link, inv.call, { label: 'Adding 1: still going' });
      await H.until(() => got.length === 2, 5000, 'the second progress');
      await w.s.result(w.link, inv.call, { ok: true, result: { data: { count: 1 } } });
      assert.ok(!(await call).isError);
      assert.deepEqual(got, [
        { progress: 25, total: 100, message: 'Adding 1: step 1' },
        { progress: 26, message: 'Adding 1: still going' },
      ]);
    } finally {
      await w.close();
    }
  });

  it("another app's call is told the turn mcp:<its connection's id> (AssistantCall.turn): the same for each call on one connection, another app's differs, and a host tool is told it too", async () => {
    const told = [];
    const probe = H.hostTool('turn_probe', { run: async (_input, rt) => (told.push(rt.turn), { ok: true, data: {}, summary: 'probed' }) });
    const w = await appWorld({ hostTools: [probe] });
    try {
      const a = await w.client({ name: 'App A' });
      const b = await w.client({ name: 'App B' });
      const add = async (c, n) => {
        const call = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
        const inv = await w.answer(n);
        assert.ok(!(await call).isError);
        return inv.turn;
      };
      const turns = [await add(a, 0), await add(a, 1), await add(b, 2)];
      for (const c of [a, b]) assert.ok(!(await c.client.callTool({ name: 'turn_probe', arguments: {} })).isError);
      const id = Object.fromEntries(L.mcpConnections().map((row) => [row.name, row.id]));
      assert.match(id['App A'], /^m-[0-9a-z]+-[0-9a-f]{8}$/);
      assert.notEqual(id['App A'], id['App B']);
      assert.deepEqual(turns, [`mcp:${id['App A']}`, `mcp:${id['App A']}`, `mcp:${id['App B']}`]);
      assert.deepEqual(told, [`mcp:${id['App A']}`, `mcp:${id['App B']}`]);
    } finally {
      await w.close();
    }
  });

  it('privacy Ask: a project-data tool asks "Let other apps read project …?" in the tab (the app\'s name in it; one answer for every app); Don\'t allow leaves it unrun and holds for every app a while (no question until then); Allow is remembered for mcp, every app\'s list then shows the tools in full (list_changed once, at an app that made no call too), a new connection gets the guide, and nothing asks again', async () => {
    const w = await appWorld({ privacy: 'ask' });
    try {
      const changes = listChanges();
      const c = await w.client({ name: 'Desk "App"‮', listChanged: changes.option });
      // Another app that lists, and makes no call once the project is allowed.
      const quiet = listChanges();
      const watcher = await w.client({ name: 'Watcher', listChanged: quiet.option });
      const WITHHELD = "A tool of the Workspace demo workspace; its details show once you allow this project's data.";
      assert.equal((await watcher.client.listTools()).tools.find((t) => t.name === 'ai-demo__get_count').description, WITHHELD);
      let listed = Object.fromEntries((await c.client.listTools()).tools.map((t) => [t.name, t]));
      assert.equal(listed['ai-demo__get_count'].description, WITHHELD);
      assert.ok(!c.client.getInstructions().includes('Notes from'), 'no guide before the project is allowed');
      // Don't allow: nothing read.
      const first = c.client.callTool({ name: 'ai-demo__get_count', arguments: {} });
      const gate = (await w.page.frame('gate')).gate;
      assert.deepEqual(
        { kind: gate.kind, turn: gate.turn, title: gate.title, yes: gate.yes, no: gate.no, project: gate.project },
        { kind: 'privacy', turn: null, title: 'Let other apps read project "Secret Wing"?', yes: 'Allow', no: "Don't allow", project: { id: 'p1', title: 'Secret Wing' } },
      );
      assert.equal(
        gate.copy,
        "An app on this PC using Magnusim's tools (\"Desk 'App'\", as it calls itself) is about to read this project's names, settings, results and pictures of the open workspace. It may send them to its own AI service. This answer covers every app using Magnusim's tools. Settings → Assistant can change this.",
      );
      let r = await w.s.post('/api/assistant/relay/gate', { link: w.link, gate: gate.id, allow: false });
      assert.equal(r.status, 200);
      const declined = await first;
      assert.deepEqual(M.resultJson(declined).error, { code: 'declined', message: S.PRIVACY_DECLINED_TEXT });
      assert.deepEqual(w.page.of('invoke'), [], 'nothing was read');
      assert.deepEqual(w.m.consents, []);
      assert.equal(changes.n, 0);
      // The answer holds for every app a while: no question again until then.
      const soon = await watcher.client.callTool({ name: 'ai-demo__get_count', arguments: {} });
      assert.deepEqual(M.resultJson(soon).error, { code: 'declined', message: S.privacyHeldText(S.PRIVACY_DECLINE_HOLD_MS) });
      w.m.clock.advance(S.PRIVACY_DECLINE_HOLD_MS - 60_000);
      assert.match(M.resultJson(await c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } })).error.message, /asks again in 1 minute\.$/);
      assert.equal(w.page.of('gate').length, 1, 'not asked again');
      assert.deepEqual(w.page.of('invoke'), [], 'nothing was read');
      w.m.clock.advance(60_000);
      // Asked again; Allow: it runs and is remembered for other apps.
      const second = c.client.callTool({ name: 'ai-demo__get_count', arguments: {} });
      const again = (await w.page.frame('gate', 1)).gate;
      assert.equal(again.kind, 'privacy');
      r = await w.s.post('/api/assistant/relay/gate', { link: w.link, gate: again.id, allow: true });
      assert.equal(r.status, 200);
      await w.answer(0, { ok: true, result: { data: { count: 0 } } });
      assert.ok(!(await second).isError);
      assert.deepEqual(w.m.consents, [{ projectId: 'p1', createdAt: '2026-10-01T00:00:00.000Z', destination: 'mcp' }]);
      // The list is the same tools with their own words now: announced once, to the app that
      // made no call since too.
      await H.until(() => changes.n === 1, 5000, 'list_changed');
      await H.until(() => quiet.n === 1, 5000, 'list_changed at the app that made no call');
      assert.equal((await watcher.client.listTools()).tools.find((t) => t.name === 'ai-demo__get_count').description, 'Reads the counter.');
      listed = Object.fromEntries((await c.client.listTools()).tools.map((t) => [t.name, t]));
      assert.equal(listed['ai-demo__get_count'].description, 'Reads the counter.');
      assert.equal(listed['ai-demo__add'].title, 'Add to the counter');
      // A connection made now gets the workspace guide; this one keeps its first instructions.
      const late = await w.client();
      assert.ok(late.client.getInstructions().includes('Notes from the Workspace demo workspace (installed plugin):'));
      assert.ok(!c.client.getInstructions().includes('Notes from'));
      // Remembered: no question for any app.
      const third = late.client.callTool({ name: 'ai-demo__get_count', arguments: {} });
      await w.answer(1, { ok: true, result: { data: { count: 0 } } });
      assert.ok(!(await third).isError);
      assert.equal(w.page.of('gate').length, 2, 'asked twice in all');
      await H.tick();
      assert.equal(changes.n, 1, 'once');
      assert.equal(quiet.n, 1, 'once');
    } finally {
      await w.close();
    }
  });

  it('privacy Ask, apps at once: one question for all of them (one answer covers every app); it closes when every call waiting on it has gone, and stays while one waits; Allow runs each and is remembered once', async () => {
    const w = await appWorld({ privacy: 'ask' });
    const stopped = () => logged.filter((l) => l.includes('mcp call') && l.includes('"code":"stopped"')).length;
    try {
      const a = await w.client({ name: 'App A' });
      const b = await w.client({ name: 'App B' });
      // Alone, A cancels: the question closes (stop), and nothing holds.
      let ac = new AbortController();
      const alone = a.client.callTool({ name: 'ai-demo__get_count', arguments: {} }, { signal: ac.signal });
      alone.catch(() => {});
      const first = (await w.page.frame('gate')).gate;
      ac.abort('not now');
      await assert.rejects(alone);
      assert.deepEqual(await w.page.frame('gate_closed'), { gate: first.id, answer: 'deny', by: 'stop' });
      // Both at once: B joins A's question (and hears that it waits).
      const before = stopped();
      ac = new AbortController();
      const fromA = a.client.callTool({ name: 'ai-demo__get_count', arguments: {} }, { signal: ac.signal });
      fromA.catch(() => {});
      const gate = (await w.page.frame('gate', 1)).gate;
      const gotB = [];
      const fromB = b.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } }, { onprogress: (p) => gotB.push(p) });
      await H.until(() => gotB.length === 1, 5000, "B's wait progress");
      assert.deepEqual(gotB[0], { progress: 1, message: S.WAITING_TEXT });
      assert.equal(w.page.of('gate').length, 2, 'one question for both');
      // A goes: the question stays for B.
      ac.abort('not now');
      await assert.rejects(fromA);
      await H.until(() => stopped() === before + 1, 5000, "A's call to end");
      assert.equal(w.s.handle.turns.gates.openCount(), 1, 'still open for B');
      assert.equal(w.page.of('gate_closed').length, 1);
      // Allow: B's call runs, and the answer is remembered once.
      assert.equal((await w.s.post('/api/assistant/relay/gate', { link: w.link, gate: gate.id, allow: true })).status, 200);
      assert.equal((await w.answer(0)).tool, 'add');
      assert.ok(!(await fromB).isError);
      assert.deepEqual(w.m.consents, [{ projectId: 'p1', createdAt: '2026-10-01T00:00:00.000Z', destination: 'mcp' }]);
      assert.equal(w.page.of('gate').length, 2);
    } finally {
      await w.close();
    }
  });

  it('privacy, read live: Never send chosen while its question is open wins over its Allow (privacy_denied, nothing remembered); Never send refuses at once with no question', async () => {
    const w = await appWorld({ privacy: 'ask' });
    try {
      const c = await w.client();
      const call = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
      const gate = (await w.page.frame('gate')).gate;
      w.m.state.settings.privacy = 'deny';
      assert.equal((await w.s.post('/api/assistant/relay/gate', { link: w.link, gate: gate.id, allow: true })).status, 200);
      assert.deepEqual(M.resultJson(await call).error, { code: 'privacy_denied', message: P.MCP_PRIVACY_DENIED_TEXT });
      assert.deepEqual(w.m.consents, []);
      const r = await c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
      assert.deepEqual(M.resultJson(r).error, { code: 'privacy_denied', message: P.MCP_PRIVACY_DENIED_TEXT });
      assert.equal(w.page.of('gate').length, 1, 'no second question');
      assert.deepEqual(w.page.of('invoke'), []);
    } finally {
      await w.close();
    }
  });

  for (const era of ['legacy', 'modern']) {
    it(`${era}: the workspace closing gives list_changed once; the old name then gives unavailable with the hint; a source that changes is noticed around a call`, async () => {
      let version = 1;
      // A call that changes what a source offers (as a CAD edit may).
      const flip = H.hostTool('flip', { risk: 'edit', run: async () => ((version = 3), { ok: true, data: {}, summary: 'flipped' }) });
      const w = await appWorld({ hostTools: [flip] });
      try {
        const changes = listChanges();
        const c = await w.client({ era, listChanged: changes.option });
        assert.equal(c.client.getProtocolEra(), era);
        assert.ok((await c.client.listTools()).tools.some((t) => t.name === 'ai-demo__add'));
        // The workspace closes (the page withdraws its tools).
        assert.equal((await w.s.post('/api/assistant/relay/tools', { link: w.link, rev: 2, tools: [] })).status, 200);
        await H.until(() => changes.n === 1, 5000, 'list_changed');
        const r = await c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
        assert.equal(r.isError, true);
        assert.deepEqual(M.resultJson(r).error, { code: 'unavailable', message: 'Counter is no longer open.', hint: S.TOOLS_CHANGED_HINT });
        // A tool that asks first, of the old list: the same answer (never no_window, whose advice can't work for it).
        const stale = await c.client.callTool({ name: 'ai-demo__reset', arguments: {} });
        assert.deepEqual(M.resultJson(stale).error, { code: 'unavailable', message: 'Counter is no longer open.', hint: S.TOOLS_CHANGED_HINT });
        assert.equal(w.page.of('gate').length, 0, 'no question');
        // A source whose list changes with no registry event: the check around the next call sees it.
        const sourced = (name) => ({ ...H.hostTool(name), source: { kind: 'plugin', plugin: 'demo', method: name, epoch: w.m.registry.currentEpoch('demo') }, projectData: false });
        const off = w.m.registry.registerToolSource(() => (version === 1 ? [] : version === 2 ? [sourced('src_tool')] : [sourced('src_tool'), sourced('src_more')]));
        try {
          await H.tick();
          assert.equal(changes.n, 1, 'the same list: nothing to announce');
          version = 2;
          await H.tick();
          assert.equal(changes.n, 1, 'not heard yet');
          await c.client.callTool({ name: 'nowhere', arguments: {} });
          await H.until(() => changes.n === 2, 5000, 'list_changed after the call');
          assert.ok((await c.client.listTools()).tools.some((t) => t.name === 'src_tool'));
          // The source builds its tool afresh at each call: the same tool, nothing more to announce.
          await c.client.callTool({ name: 'nowhere', arguments: {} });
          await c.client.callTool({ name: 'nowhere', arguments: {} });
          await H.tick();
          assert.equal(changes.n, 2, 'once');
          // Changed by the call itself: heard after it, with no call after.
          assert.ok(!(await c.client.callTool({ name: 'flip', arguments: {} })).isError);
          await H.until(() => changes.n === 3, 5000, 'list_changed after the call that changed it');
          assert.ok((await c.client.listTools()).tools.some((t) => t.name === 'src_more'));
        } finally {
          off();
        }
        assert.deepEqual(w.page.of('invoke'), [], 'the old name never reached the page');
      } finally {
        await w.close();
      }
    });
  }

  it("registry.onChange hears each change of what may be offered: a tab's registration set or dropped, connected or dormant (its tab), a host tool or a source added or removed ('*'); never a change that isn't one", () => {
    const reg = (H.makeManager({ dir: ROOT })).registry;
    const heard = [];
    const off = reg.onChange((tab) => heard.push(tab));
    // A listener that throws stops nobody.
    const offBad = reg.onChange(() => {
      throw new Error('a bad listener');
    });
    const tab = H.newTabId();
    const link = 'b'.repeat(24);
    const ws = { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'counter', projectId: 'p1', studyId: 's1', epoch: '1', tools: H.demoTools() };
    reg.setWorkspace(tab, link, ws);
    reg.setConnected(tab, link, false);
    reg.setConnected(tab, link, false);
    reg.setConnected(tab, 'c'.repeat(24), true);
    reg.setConnected(tab, link, true);
    reg.setWorkspace(tab, link, null);
    reg.setWorkspace(tab, link, null);
    const offSource = reg.registerToolSource(() => []);
    offSource();
    offSource();
    reg.addHostTool(H.hostTool('late_tool'));
    assert.deepEqual(heard, [tab, tab, tab, tab, '*', '*', '*']);
    off();
    offBad();
    reg.setWorkspace(tab, link, ws);
    assert.equal(heard.length, 7, 'not after its off');
  });

  it('the workspace registers again between tools/list and tools/call: list_changed, and the listed tool is unavailable with the hint (never sent to the page); listed again, it runs', async () => {
    const w = await appWorld();
    try {
      const changes = listChanges();
      const c = await w.client({ listChanged: changes.option });
      assert.ok((await c.client.listTools()).tools.some((t) => t.name === 'ai-demo__add'));
      // The same tools again (a reload, a new frame): a new registration.
      assert.equal((await w.s.register(w.link, 2, H.demoTools(), { guide: GUIDE })).status, 200);
      await H.until(() => changes.n === 1, 5000, 'list_changed');
      const r = await c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
      assert.equal(r.isError, true);
      assert.equal(M.resultJson(r).error.code, 'unavailable');
      assert.equal(M.resultJson(r).error.hint, S.TOOLS_CHANGED_HINT);
      assert.deepEqual(w.page.of('invoke'), []);
      await c.client.listTools();
      const again = c.client.callTool({ name: 'ai-demo__add', arguments: { by: 1 } });
      assert.equal((await w.answer(0)).tool, 'add');
      assert.ok(!(await again).isError);
      assert.equal(changes.n, 1, 'once');
    } finally {
      await w.close();
    }
  });

  it("a question's own wait (RunOptions.gateTimeoutMs) sets its expires_at and timeout; without one, the broker's ten minutes", async () => {
    const shown = [];
    const m = H.makeManager({ dir: ROOT, presenter: { present: (view) => (shown.push(view), false), withdraw: () => {} } });
    const def = H.hostTool('wipe_all', { risk: 'destructive' });
    const offered = new Map([['wipe_all', def]]);
    const ctx = { tab: 'tab-x', projectId: null, simulationId: null, cloud: true, local: false };
    const owner = { kind: 'mcp', session: 'm-own', tab: 'tab-x' };
    const run = (callId, o = {}) => m.manager.runner.run({ type: 'tool_call', callId, name: 'wipe_all', input: {} }, { owner, ctx, signal: new AbortController().signal, offered, ...o });
    const short = run('c-1', { gateTimeoutMs: 240_000 });
    await H.until(() => shown.length === 1, 5000, 'the question');
    assert.equal(shown[0].expires_at, new Date(m.clock.now() + 240_000).toISOString());
    // Not shown (no live link): unseen once the wait passed.
    assert.equal(m.manager.gates.unseen(shown[0].id), false);
    m.clock.advance(G.GATE_UNSEEN_MS);
    assert.equal(m.manager.gates.unseen(shown[0].id), true);
    m.clock.advance(240_000 - G.GATE_UNSEEN_MS - 1);
    assert.equal(m.manager.gates.openCount(), 1);
    m.clock.advance(1);
    assert.equal((await short).code, 'declined');
    assert.equal(m.manager.gates.closedAs(shown[0].id).by, 'timeout');
    const long = run('c-2');
    await H.until(() => shown.length === 2, 5000, 'the second question');
    assert.equal(shown[1].expires_at, new Date(m.clock.now() + G.GATE_TIMEOUT_MS).toISOString());
    m.clock.advance(G.GATE_TIMEOUT_MS);
    assert.equal((await long).code, 'declined');
  });
});

describe('another app beside the Assistant’s turns in one tab (CAD tools spec H4)', { timeout: 60_000 }, () => {
  it('an app’s call is no turn: while it runs in the tab a turn starts there, a second turn there is still tab_busy, and the app’s call ends as it would, told its connection as its turn', async () => {
    const w = await appWorld();
    try {
      const c = await w.client({ name: 'Desk App' });
      const call = c.client.callTool({ name: 'ai-demo__get_count', arguments: {} });
      // The app's call reached the page, which has not answered it yet.
      const inv = await w.page.frame('invoke', 0);
      assert.deepEqual([inv.tool, inv.turn], ['get_count', `mcp:${L.mcpConnections().find((row) => row.name === 'Desk App').id}`]);
      assert.equal(w.s.handle.turns.activeForTab(w.page.tab), 0, 'no turn works in the tab');
      w.m.provider.script({ text: 'Hello.', hold: 'beside-app' });
      const first = await w.s.post('/api/assistant/turns', { text: 'First.', tab: w.page.tab });
      assert.equal(first.status, 202, JSON.stringify(first.json));
      await w.m.provider.reached('beside-app');
      const second = await w.s.post('/api/assistant/turns', { text: 'Second.', tab: w.page.tab });
      assert.deepEqual([second.status, second.json.code], [409, 'tab_busy']);
      // The app's call still ends as it would.
      await w.s.progress(w.link, inv.call, { ack: true });
      await w.s.result(w.link, inv.call, { ok: true, result: { data: { count: 3 } } });
      assert.deepEqual(M.resultJson(await call), { tool: 'ai-demo__get_count', ok: true, data: { count: 3 } });
      w.m.provider.release('beside-app');
      const t = w.s.handle.turns.get(first.json.turn);
      await H.settled(t);
      assert.equal(t.state, 'done');
      // Ended: the tab takes the next turn, with the app still connected.
      w.m.provider.script({ text: 'Again.' });
      const next = await w.s.post('/api/assistant/turns', { text: 'Next.', tab: w.page.tab });
      assert.equal(next.status, 202, JSON.stringify(next.json));
      await H.settled(w.s.handle.turns.get(next.json.turn));
    } finally {
      w.m.provider.release('beside-app');
      await w.close();
    }
  });
});

describe('the call queue', () => {
  it('a waiting call whose signal aborts leaves at once (removed before the call ahead ends); the call behind still waits its turn', async () => {
    const q = new B.CallQueue(4);
    const ran = [];
    const never = new AbortController().signal;
    let release1;
    const p1 = q.run(never, () => new Promise((r) => (release1 = () => (ran.push(1), r(1)))), () => 'removed 1');
    const ac = new AbortController();
    const p2 = q.run(ac.signal, async () => (ran.push(2), 2), () => 'removed 2');
    const p3 = q.run(never, async () => (ran.push(3), 3), () => 'removed 3');
    assert.equal(q.pending, 3);
    let settled2 = false;
    void p2.then(() => (settled2 = true));
    await H.tick();
    ac.abort();
    await H.tick();
    assert.equal(settled2, true, 'removed while the call ahead still runs');
    assert.equal(await p2, 'removed 2');
    assert.equal(q.pending, 2);
    assert.deepEqual(ran, [], 'nothing else ran');
    release1();
    assert.equal(await p1, 1);
    assert.equal(await p3, 3);
    assert.deepEqual(ran, [1, 3]);
    assert.equal(q.pending, 0);
  });
});

describe('the server', () => {
  /** A server with the Assistant's routes (this PC only): {base, get, post, close}. */
  async function serve(router) {
    const server = http.createServer(async (req, res) => {
      if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, text, json: JSON.parse(text) };
    };
    return {
      get: (path) => call('GET', path),
      post: (path, body) => call('POST', path, body),
      close: () => new Promise((r) => server.close(r)),
    };
  }

  it('the listener starts with the server only when the settings file exists (no folder made otherwise)', async () => {
    await L.resetMcpListenerForTests();
    const home = join(ROOT, 'fresh-home');
    process.env.MAGNUSIM_ASSISTANT_HOME = home;
    resetAssistantState();
    try {
      const m = H.makeManager({ dir: ROOT });
      const h1 = routes.registerAssistantRoutes(new Router(), { turns: m.deps });
      await h1.mcpStart;
      assert.equal(L.mcpListenerStatus().running, false);
      assert.equal(existsSync(home), false, 'no assistant folder');
      h1.shutdown();
      mkdirSync(join(home, 'assistant'), { recursive: true });
      writeFileSync(join(home, 'assistant', 'settings.json'), '{"version":1}');
      resetAssistantState();
      const h2 = routes.registerAssistantRoutes(new Router(), { turns: m.deps });
      await h2.mcpStart;
      assert.equal(L.mcpListenerStatus().running, true);
      assert.equal(M.readInfo(join(home, 'assistant', 'mcp.json')).pid, process.pid);
      // Other apps is off: an external app is told so, not "not running".
      const info = M.readInfo(join(home, 'assistant', 'mcp.json'));
      assert.equal((await M.handshake(info.port, info.token)).answer.code, 'clients_off');
      h2.shutdown();
    } finally {
      await L.resetMcpListenerForTests();
      process.env.MAGNUSIM_ASSISTANT_HOME = HOME;
      resetAssistantState();
    }
  });

  it('routes: Other apps turned on starts it; GET /mcp gives the config (key magnusim-apps, always --info) and the connections, never the token; status and the test state say it too', async () => {
    await L.resetMcpListenerForTests();
    // Its own settings file (Other apps off, no port saved yet), whatever an earlier test saved.
    mkdirSync(join(HOME, 'assistant'), { recursive: true });
    writeFileSync(join(HOME, 'assistant', 'settings.json'), '{"version":1}');
    resetAssistantState();
    const router = new Router();
    const m = H.makeManager({ dir: ROOT, hostTools: [H.hostTool('app_info')] });
    // The real settings file decides the switch here.
    const turnDeps = { ...m.deps };
    delete turnDeps.settings;
    const handle = routes.registerAssistantRoutes(router, { turns: turnDeps });
    const app = await serve(router);
    try {
      // The settings file exists here: the listener started with the server.
      await handle.mcpStart;
      assert.equal(L.mcpListenerStatus().running, true);
      // Not running, the switch off: Other apps turned on starts it.
      await L.resetMcpListenerForTests();
      let status = await app.get('/api/assistant/status');
      assert.deepEqual(status.json.mcp, { clients: false, running: false, reason: null, port: status.json.mcp.port, connected: 0 });
      assert.ok(Number.isInteger(status.json.mcp.port), 'the saved port while it is not running');
      const on = await app.post('/api/assistant/settings', { mcp: { clients: true } });
      assert.equal(on.status, 200);
      assert.equal(on.json.mcp.clients, true);
      assert.equal(on.json.mcp.running, true, 'turned on: it runs');
      const info = M.readInfo(L.mcpInfoPath());
      assert.equal(on.json.mcp.port, info.port);
      const c = await M.socketClient(info.port, info.token, { name: 'Desk App' });
      await c.client.callTool({ name: 'app_info', arguments: {} });
      const r = await app.get('/api/assistant/mcp');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.clients, true);
      assert.equal(r.json.running, true);
      assert.equal(r.json.port, info.port);
      assert.deepEqual(r.json.bridge, { command: process.execPath, args: [M.BRIDGE, '--info', L.mcpInfoPath()] });
      assert.deepEqual(JSON.parse(r.json.snippet), { mcpServers: { 'magnusim-apps': r.json.bridge } });
      assert.equal(r.json.connections.length, 1);
      assert.deepEqual(
        { kind: r.json.connections[0].kind, name: r.json.connections[0].name, calls: r.json.connections[0].calls },
        { kind: 'external', name: 'Desk App', calls: 1 },
      );
      assert.match(r.json.connections[0].id, /^m-[0-9a-z]+-[0-9a-f]{8}$/);
      assert.ok(!Number.isNaN(Date.parse(r.json.connections[0].since)));
      status = await app.get('/api/assistant/status');
      assert.deepEqual(status.json.mcp, { clients: true, running: true, reason: null, port: info.port, connected: 1 });
      // The page has a type for every field of the status, mcp's too (src/assistant/wire.ts).
      const wire = readFileSync(new URL('../../../src/assistant/wire.ts', import.meta.url), 'utf8');
      const members = (name) => {
        const start = wire.indexOf(`export interface ${name} {`);
        assert.ok(start >= 0, `wire.ts has ${name}`);
        return [...wire.slice(start, wire.indexOf('\n}', start)).matchAll(/^ {2}([a-z_]+)\??:/gm)].map((x) => x[1]);
      };
      const typed = members('AssistantStatus');
      // (Test switches the status reports only with MAGNUSIM_TEST_ASSISTANT=1 aside.)
      assert.deepEqual(Object.keys(status.json).filter((k) => !typed.includes(k) && !k.startsWith('test_')), [], 'every status field is in AssistantStatus');
      assert.deepEqual(members('McpStatus').sort(), Object.keys(status.json.mcp).sort());
      const test = await app.get('/api/test/assistant/state');
      assert.deepEqual(test.json.mcp, { connections: 1, port: info.port });
      for (const answer of [r, status, test, on]) assert.ok(!answer.text.includes(info.token), 'never the token');
      await c.close();
    } finally {
      handle.shutdown();
      await app.close();
    }
  });

  it('Other apps turned off in Settings cuts off the apps connected now (their running call ends "server stopped", a waiting one never runs); coding agents stay connected', async () => {
    await L.resetMcpListenerForTests();
    resetAssistantState();
    const router = new Router();
    const hold = holdTool('hold');
    const m = H.makeManager({ dir: ROOT, hostTools: [hold.def] });
    // The real settings file decides the switch here.
    const turnDeps = { ...m.deps };
    delete turnDeps.settings;
    const handle = routes.registerAssistantRoutes(router, { turns: turnDeps });
    const app = await serve(router);
    const open = [];
    try {
      await handle.mcpStart;
      assert.equal((await app.post('/api/assistant/settings', { mcp: { clients: true } })).json.mcp.running, true);
      const info = M.readInfo(L.mcpInfoPath());
      const agent = await M.socketClient(info.port, info.token, { binding: B.mintBinding({ conversation: 'c-stays', agent: 'fake' }).id });
      const c = await M.socketClient(info.port, info.token, { name: 'Desk App' });
      open.push(agent, c);
      const calls = [1, 2].map((n) => c.client.callTool({ name: 'hold', arguments: { n } }).catch((e) => e));
      await H.until(() => hold.calls.length === 1 && L.mcpConnections().find((x) => x.kind === 'external')?.calls === 2, 5000, 'one call running, one waiting');
      const off = await app.post('/api/assistant/settings', { mcp: { clients: false } });
      assert.equal(off.status, 200);
      assert.equal(off.json.mcp.clients, false);
      assert.equal(off.json.mcp.connected, 1, 'only the coding agent');
      await closed(c.sock);
      await H.until(() => hold.calls[0].aborted, 5000, 'the running call aborted');
      assert.deepEqual(hold.calls[0].aborted, { code: 'stopped', server: true });
      await Promise.all(calls);
      assert.equal(hold.calls.length, 1, 'the waiting call never ran');
      const r = await app.get('/api/assistant/mcp');
      assert.equal(r.json.running, true, 'the listener runs on (coding agents use it)');
      assert.deepEqual(r.json.connections.map((x) => x.kind), ['agent']);
      assert.equal(agent.sock.destroyed, false);
      assert.equal((await M.handshake(info.port, info.token)).answer.code, 'clients_off');
    } finally {
      for (const x of open) await x.close();
      handle.shutdown();
      await app.close();
    }
  });

  it('a Vite restart keeps the port and the token; the old lifetime closes its connections through the explicit call (its calls end "server stopped")', async () => {
    resetAssistantState();
    const hold = holdTool('hold');
    const m = H.makeManager({ dir: ROOT, hostTools: [hold.def], settings: { mcp: { clients: true, port: null, ask_in_client: false } } });
    const old = routes.registerAssistantRoutes(new Router(), { turns: m.deps });
    await L.startMcpListener();
    const before = M.readInfo(L.mcpInfoPath());
    const c1 = await M.socketClient(before.port, before.token);
    const running = c1.client.callTool({ name: 'hold', arguments: { n: 1 } }).catch((e) => e);
    await H.until(() => hold.calls.length === 1, 5000, 'the old connection call');
    // The new server is built first, then the old one closes.
    const fresh = routes.registerAssistantRoutes(new Router(), { turns: m.deps });
    try {
      old.shutdown();
      await H.until(() => hold.calls[0].aborted, 5000, 'the old call aborted');
      assert.deepEqual(hold.calls[0].aborted, { code: 'stopped', server: true });
      await closed(c1.sock);
      await running;
      const afterInfo = M.readInfo(L.mcpInfoPath());
      assert.deepEqual({ port: afterInfo.port, token: afterInfo.token, pid: afterInfo.pid }, { port: before.port, token: before.token, pid: process.pid });
      assert.equal(L.mcpServerForTests().address().port, before.port);
      // The new lifetime serves new connections.
      const c2 = await M.socketClient(before.port, before.token);
      const r = c2.client.callTool({ name: 'hold', arguments: { n: 2 } });
      await H.until(() => hold.calls.length === 2, 5000, 'the new call');
      hold.calls[1].release();
      assert.equal(M.resultJson(await r).data.n, 2);
      await c2.close();
    } finally {
      fresh.shutdown();
    }
  });

  it('the MCP package missing: status says deps_missing, nothing listens, and the providers\' deps status is unchanged', async () => {
    await L.resetMcpListenerForTests();
    resetAssistantState();
    const depsBefore = await sdk.depsStatus();
    sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, '@magnusim-test/no-such-mcp-package');
    try {
      // Not started yet (no settings file when the server started): the status says why all the same.
      const before = await routes.assistantStatus();
      assert.deepEqual([before.mcp.running, before.mcp.reason], [false, 'deps_missing']);
      const st = await L.startMcpListener();
      assert.deepEqual(st, { running: false, reason: 'deps_missing', port: null, connected: 0 });
      const status = await routes.assistantStatus();
      assert.equal(status.mcp.running, false);
      assert.equal(status.mcp.reason, 'deps_missing');
      assert.equal(status.deps, depsBefore.state);
      assert.deepEqual(await sdk.depsStatus(), depsBefore);
      assert.equal(existsSync(L.mcpInfoPath()), false);
    } finally {
      sdk.setSdkSpecifierForTests(sdk.MCP_SDK_NAME, null);
    }
  });
});
