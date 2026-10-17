// Other apps on this PC reach Magnusim's tools (phase 3 spec 3.1-3.4, 3.7-3.10, 5.1, 5.3;
// M2): the loopback listener (127.0.0.1 only, the per-launch token in a 0600 mcp.json, the
// saved port, the challenge handshake both ways, connection limits), MCP sessions (external
// apps with host tools, agent bindings, the Settings Test binding), the list (names of at
// most 46 characters, hints, instructions, registration text withheld), calls (only what was
// served, one at a time per connection, rates, project data refused for now), logging, and
// the server's lifetime (the start rule, a Vite restart, the MCP package missing).
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

/** A host tool that waits until the test releases it (or its call aborts): {def, calls}. */
function holdTool(name, { risk = 'read' } = {}) {
  const calls = [];
  const def = H.hostTool(name, {
    risk,
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
async function world({ hostTools = [], clients = true } = {}) {
  const m = H.makeManager({ dir: ROOT, hostTools, pluginEpoch: () => '1', settings: { mcp: { clients, port: null, ask_in_client: false } } });
  const svc = S.createMcpService({ registry: m.registry, runner: m.manager.runner, resolveTab: (t) => m.manager.resolveTab(t), settings: m.deps.settings, clock: m.clock });
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

  it('a stale mcp.json whose process is gone is removed before anything binds; the saved port is bound again; a taken one gives a new port, saved', async () => {
    const path = L.mcpInfoPath();
    const first = M.readInfo(path).port;
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

describe('tools/list', () => {
  const SLUG = 'abcdefghijklmnopqrstuvwx'; // 24 characters: kept as the slug
  const LONG1 = `k${'a'.repeat(31)}`; // 32 characters: a 58-character tool name
  const LONG2 = `k${'a'.repeat(14)}${'b'.repeat(17)}`;
  const full2 = `${SLUG}__${LONG2}`;
  // A tool whose own name is LONG2's served name: the two collide, and the later one goes.
  const TAKER = N.mcpName(full2).slice(SLUG.length + 2);

  for (const era of ['legacy', 'modern']) {
    it(`${era}: toolsFor's list under names of at most 46 characters (a collision dropped), with hints and instructions; registration text withheld from external apps`, async () => {
      const w = await world({ hostTools: [H.hostTool('app_info'), H.hostTool('wipe_all', { risk: 'destructive' }), H.hostTool('project_read', { projectData: true, available: (ctx) => (ctx.projectId ? true : 'No project.') })] });
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
        assert.equal(mapped1.length, 46);
        assert.equal(mapped1.slice(0, 41), `${SLUG}__${LONG1}`.slice(0, 41));
        assert.deepEqual(names, ['app_info', 'project_read', 'wipe_all', `${SLUG}__${TAKER}`, mapped1, `${SLUG}__pick`]);
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
        assert.ok(!JSON.stringify(listed).includes('Secret Wing'));
        // The instructions: rule 1 first, then the workspace's guide, marked as the installed plugin's.
        const text = c.client.getInstructions();
        assert.ok(text.includes(RULE_1), 'rule 1');
        assert.ok(text.indexOf(RULE_1) < text.indexOf('Guide line one.'));
        assert.ok(text.includes('Notes from the Workspace demo workspace (installed plugin):\nGuide line one.\nGuide line two.'));
        assert.ok(!text.includes('You are the Magnusim Assistant'));
      } finally {
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
      assert.match(body.error.hint, /More than one app tab/, 'the plain reason');
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

  it("tools that read project data don't run for external apps yet: project_data_off, and the page is never reached", async () => {
    const reads = H.hostTool('project_read', { projectData: true, available: (ctx) => (ctx.projectId ? true : 'No project.') });
    const w = await world({ hostTools: [reads] });
    try {
      const tab = H.newTabId();
      const demo = registerDemo(w.m, tab);
      const c = await w.client();
      const names = (await c.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('ai-demo__add') && names.includes('project_read'));
      for (const name of ['ai-demo__add', 'ai-demo__get_count', 'project_read']) {
        const r = await c.client.callTool({ name, arguments: name === 'ai-demo__add' ? { by: 1 } : {} });
        assert.equal(r.isError, true);
        assert.deepEqual(M.resultJson(r).error, { code: 'project_data_off', message: S.PROJECT_DATA_OFF_TEXT });
      }
      assert.deepEqual(demo.invoked, []);
    } finally {
      await w.close();
    }
  });

  it("tools that ask first don't run for external apps yet (no tab shows their question): questions_off at once; edits and reads run", async () => {
    const ran = [];
    const tool = (name, risk) => H.hostTool(name, { risk, run: async () => (ran.push(name), { ok: true, data: {}, summary: name }) });
    const w = await world({ hostTools: [tool('wipe_all', 'destructive'), tool('crunch', 'compute'), tool('odd', 'unknown'), tool('tweak', 'edit'), tool('look', 'read')] });
    try {
      const c = await w.client();
      for (const name of ['wipe_all', 'crunch', 'odd']) {
        const r = await c.client.callTool({ name, arguments: {} });
        assert.deepEqual(M.resultJson(r).error, { code: 'questions_off', message: S.QUESTIONS_OFF_TEXT }, name);
      }
      for (const name of ['tweak', 'look']) assert.ok(!(await c.client.callTool({ name, arguments: {} })).isError, name);
      assert.deepEqual(ran, ['tweak', 'look']);
      assert.equal(w.m.manager.gates.openCount(), 0, 'no question was opened');
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

  it('a connection that closes aborts its running call and its queued ones never run', async () => {
    const hold = holdTool('hold');
    const w = await world({ hostTools: [hold.def] });
    try {
      const c = await w.client();
      const calls = [0, 1, 2].map((n) => c.client.callTool({ name: 'hold', arguments: { n } }).catch((e) => e));
      await H.until(() => hold.calls.length === 1, 5000, 'the first call');
      c.sock.destroy();
      await H.until(() => hold.calls[0].aborted, 5000, 'the running call aborted');
      assert.equal(hold.calls[0].aborted.code, 'stopped');
      assert.equal(hold.calls[0].aborted.server, undefined, 'the app went, not the server');
      await Promise.all(calls);
      await noConnections();
      assert.equal(hold.calls.length, 1, 'the queued calls never ran');
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
      const test = await app.get('/api/test/assistant/state');
      assert.deepEqual(test.json.mcp, { connections: 1, port: info.port });
      for (const answer of [r, status, test, on]) assert.ok(!answer.text.includes(info.token), 'never the token');
      await c.close();
    } finally {
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
