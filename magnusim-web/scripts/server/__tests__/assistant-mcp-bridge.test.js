// The stdio bridge other apps start (scripts/assistant-mcp.mjs; phase 3 spec 3.1, 7.3):
// its home rules equal home.ts's; the Settings snippet always carries --info and the key
// magnusim-apps; the SDK's own client through the real bridge to the real listener, in
// both protocol eras; Magnusim not running (no file, a dead process, nothing listening);
// a refused proof read again once (Magnusim restarted); something else on the port; the
// ends of stdin and of the socket; and the token on no argv, stdout or stderr.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-mcp-bridge-'));
const HOME = join(ROOT, 'home');
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
for (const level of ['info', 'warn']) console[level] = () => {};

const H = await import('./assistant-harness.js');
const M = await import('./assistant-mcp-harness.js');
const L = await import('../assistant/mcp/listener.ts');
const S = await import('../assistant/mcp/server.ts');
const home = await import('../assistant/home.ts');
const bridge = await import('../../assistant-mcp.mjs');
const { resetAssistantState } = await import('../assistant/state.ts');

/** Every bridge process a test started, ended in after() whatever happened. */
const children = new Set();

after(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await L.resetMcpListenerForTests();
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

/** The bridge as a child: {child, out(), err(), exited: Promise<code>}. */
function runBridge(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [M.BRIDGE, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
  children.add(child);
  const out = [];
  const err = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => err.push(d));
  child.stdin.on('error', () => {});
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { child, args, out: () => Buffer.concat(out).toString('utf8'), err: () => Buffer.concat(err).toString('utf8'), exited };
}

/** Waits for a bridge's exit, at most `ms` (a ceiling: it kills it and fails past that). */
async function exitOf(b, ms = 20_000) {
  let timer;
  const code = await Promise.race([b.exited, new Promise((r) => (timer = setTimeout(() => r('timeout'), ms)))]);
  clearTimeout(timer);
  if (code === 'timeout') b.child.kill('SIGKILL');
  assert.notEqual(code, 'timeout', 'the bridge exits by itself');
  return code;
}

/** A pid that has ended. */
async function deadPid() {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => c.once('exit', r));
  return c.pid;
}

/** A loopback port nothing listens on (just closed). */
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

let world;

before(async () => {
  const m = H.makeManager({ dir: ROOT, hostTools: [H.hostTool('app_info')], settings: { mcp: { clients: true, port: null, ask_in_client: false } } });
  const svc = S.createMcpService({ registry: m.registry, runner: m.manager.runner, resolveTab: (t) => m.manager.resolveTab(t), settings: m.deps.settings, clock: m.clock });
  const dispose = L.setMcpHandler(svc.handler);
  assert.equal((await L.startMcpListener()).running, true);
  world = { m, svc, dispose, info: L.mcpInfoPath(), file: M.readInfo(L.mcpInfoPath()) };
});

describe("the bridge's home and the Settings snippet", () => {
  it('finds mcp.json by the same rules as home.ts', () => {
    const cases = [
      { env: { MAGNUSIM_ASSISTANT_HOME: join(ROOT, 'h1') }, platform: 'win32' },
      { env: { CFDDESK_ASSISTANT_HOME: join(ROOT, 'h2') }, platform: 'linux' },
      { env: { MAGNUSIM_ASSISTANT_HOME: '  ', MAGNUSIM_LOCAL_JSON: join(ROOT, 'dev', 'local.json') }, platform: 'linux' },
      { env: { CFDDESK_LOCAL_JSON: join(ROOT, 'dev', 'Local.JSON') }, platform: 'win32' },
      { env: { APPDATA: join(ROOT, 'roaming') }, platform: 'win32', home: join(ROOT, 'user') },
      { env: {}, platform: 'win32', home: join(ROOT, 'user') },
      { env: {}, platform: 'darwin', home: join(ROOT, 'user') },
      { env: { XDG_CONFIG_HOME: join(ROOT, 'xdg') }, platform: 'linux', home: join(ROOT, 'user') },
      { env: {}, platform: 'linux', home: join(ROOT, 'user') },
      { env: { XDG_CONFIG_HOME: '' }, platform: 'freebsd', home: join(ROOT, 'user') },
    ];
    for (const o of cases) {
      assert.equal(bridge.bridgeHome(o), home.assistantHome(o), JSON.stringify(o));
      assert.equal(bridge.bridgeInfoPath(null, o), join(home.assistantDataDir(o), 'mcp.json'), JSON.stringify(o));
    }
    // With no option at all, both read this process.
    assert.equal(bridge.bridgeInfoPath(null), L.mcpInfoPath());
    // --info wins.
    assert.equal(bridge.bridgeInfoPath('elsewhere/mcp.json', cases[0]), resolve('elsewhere/mcp.json'));
  });

  it('the snippet always passes --info with the absolute path of this mcp.json, under the key magnusim-apps, and holds no token', () => {
    const cfg = L.mcpClientConfig();
    assert.equal(cfg.command, process.execPath);
    assert.deepEqual(cfg.args, [resolve(M.BRIDGE), '--info', world.info]);
    assert.deepEqual(JSON.parse(cfg.snippet), { mcpServers: { 'magnusim-apps': { command: process.execPath, args: cfg.args } } });
    assert.ok(!cfg.snippet.includes(world.file.token));
    assert.deepEqual(bridge.parseArgs(cfg.args.slice(1)), { info: world.info, binding: null });
    assert.deepEqual(bridge.parseArgs(['--binding', 'b-1']).error !== undefined, true);
    assert.equal(bridge.parseArgs(['--token', 'x']).error !== undefined, true, 'no other argument');
  });
});

describe('the SDK client through the real bridge', () => {
  for (const era of ['legacy', 'modern']) {
    it(`${era}: lists and calls Magnusim's tools`, async () => {
      const b = await M.bridgeClient({ info: world.info, era, name: `Bridge App ${era}` });
      try {
        assert.equal(b.client.getProtocolEra(), era);
        assert.equal(b.client.getServerVersion()?.name, 'magnusim');
        assert.ok(b.client.getInstructions().startsWith("These are Magnusim's tools."));
        assert.deepEqual((await b.client.listTools()).tools.map((t) => t.name), ['app_info']);
        const r = await b.client.callTool({ name: 'app_info', arguments: {} });
        assert.deepEqual(M.resultJson(r), { tool: 'app_info', ok: true, data: { tool: 'app_info' } });
        assert.deepEqual(
          L.mcpConnections().map((c) => [c.kind, c.name, c.calls]),
          [['external', `Bridge App ${era}`, 1]],
        );
        assert.equal(b.stderr(), '');
      } finally {
        await b.close();
      }
      await H.until(() => L.mcpListenerStatus().connected === 0, 10_000, 'the bridge connection to close');
    });
  }
});

describe('when Magnusim is not there', () => {
  it('no file, a dead process, or nothing listening: exit 1 with the not-running text, nothing on stdout', async () => {
    const dead = join(ROOT, 'dead.json');
    writeFileSync(dead, JSON.stringify({ version: 1, port: world.file.port, token: world.file.token, pid: await deadPid(), started_at: 'x' }));
    const refused = join(ROOT, 'refused.json');
    writeFileSync(refused, JSON.stringify({ version: 1, port: await freePort(), token: 'x', pid: process.pid, started_at: 'x' }));
    for (const info of [join(ROOT, 'missing.json'), dead, refused]) {
      const b = runBridge(['--info', info]);
      assert.equal(await exitOf(b), 1, info);
      assert.equal(b.err(), `${bridge.NOT_RUNNING_TEXT}\n`);
      assert.match(bridge.NOT_RUNNING_TEXT, /Settings → Assistant → Other apps \(MCP\)/, 'it names the switch');
      assert.equal(b.out(), '');
    }
  });
});

/**
 * A program on a port that speaks the greeting its own way: `answer(greeting, n1)` gives the
 * line it answers with (or null: it closes). It records what reaches it after the greeting.
 */
async function fakeServer(answer, { hello = (n1) => `${JSON.stringify({ magnusim_mcp: 1, nonce: n1 })}\n` } = {}) {
  const seen = { connections: 0, after: [] };
  const server = net.createServer((sock) => {
    seen.connections += 1;
    sock.on('error', () => {});
    const n1 = randomBytes(16).toString('hex');
    sock.write(hello(n1));
    let buf = Buffer.alloc(0);
    let greeted = false;
    sock.on('data', async (chunk) => {
      if (greeted) {
        seen.after.push(chunk.toString('utf8'));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      greeted = true;
      const rest = buf.subarray(nl + 1);
      if (rest.length) seen.after.push(rest.toString('utf8'));
      const reply = await answer(JSON.parse(buf.subarray(0, nl).toString('utf8')), n1);
      if (reply === null) sock.destroy();
      else sock.write(`${reply}\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

describe('a refused proof, and something else on the port', () => {
  it('a refused proof: the file is read once more (Magnusim restarted) and the bridge connects', async () => {
    const info = join(ROOT, 'rotated.json');
    // The program at the old port is "the Magnusim that stopped": it refuses, after the new one wrote its file.
    const old = await fakeServer(async () => {
      writeFileSync(info, JSON.stringify(world.file));
      return JSON.stringify({ ok: false, code: 'token', error: 'old token' });
    });
    try {
      writeFileSync(info, JSON.stringify({ ...world.file, port: old.port, token: 'the-old-token' }));
      const b = await M.bridgeClient({ info, name: 'Rotated App' });
      try {
        assert.deepEqual((await b.client.listTools()).tools.map((t) => t.name), ['app_info']);
        assert.equal(old.seen.connections, 1);
        assert.equal(b.stderr(), '');
      } finally {
        await b.close();
      }
    } finally {
      await old.close();
    }
  });

  it('refused again after the second read: exit 1 with its error', async () => {
    const fake = await fakeServer(async () => JSON.stringify({ ok: false, code: 'token', error: 'Wrong\nproof\u001b[31m.' }));
    try {
      const info = join(ROOT, 'refusing.json');
      writeFileSync(info, JSON.stringify({ version: 1, port: fake.port, token: 'some-token', pid: process.pid, started_at: 'x' }));
      const b = runBridge(['--info', info]);
      assert.equal(await exitOf(b), 1);
      assert.equal(b.err(), 'Magnusim refused the connection: Wrong proof [31m.\n');
      assert.equal(fake.seen.connections, 2, 'one retry');
      assert.equal(b.out(), '');
      // Another refusal is final at once.
      const busy = await fakeServer(async () => JSON.stringify({ ok: false, code: 'clients_off', error: 'Turn it on.' }));
      writeFileSync(info, JSON.stringify({ version: 1, port: busy.port, token: 'some-token', pid: process.pid, started_at: 'x' }));
      const b2 = runBridge(['--info', info]);
      assert.equal(await exitOf(b2), 1);
      assert.equal(b2.err(), 'Magnusim refused the connection: Turn it on.\n');
      assert.equal(busy.seen.connections, 1);
      await busy.close();
    } finally {
      await fake.close();
    }
  });

  it('a server whose proof is wrong, or no greeting at all: exit 1 before anything is piped', async () => {
    const token = 'the-real-token';
    const cases = [
      // It accepts, but can't prove it holds the token.
      [(g) => JSON.stringify({ ok: true, proof: createHmac('sha256', 'another').update(`s${g.nonce}`).digest('hex') }), undefined],
      [() => JSON.stringify({ ok: true }), undefined],
      // Not Magnusim's greeting at all.
      [() => null, () => 'HTTP/1.1 400 Bad Request\r\n\r\n'],
      [() => null, () => `${JSON.stringify({ magnusim_mcp: 1, nonce: 'short' })}\n`],
    ];
    for (const [answer, hello] of cases) {
      const fake = await fakeServer(answer, hello ? { hello } : {});
      try {
        const info = join(ROOT, 'squatter.json');
        writeFileSync(info, JSON.stringify({ version: 1, port: fake.port, token, pid: process.pid, started_at: 'x' }));
        const b = runBridge(['--info', info]);
        // The client speaks first: none of it may reach the squatter.
        b.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { secret: 'client-data' } })}\n`);
        assert.equal(await exitOf(b), 1);
        assert.equal(b.err(), `${bridge.NOT_MAGNUSIM_TEXT}\n`);
        assert.equal(b.out(), '');
        assert.ok(!fake.seen.after.join('').includes('client-data'), 'nothing piped');
      } finally {
        await fake.close();
      }
    }
  });
});

describe('the ends, and the token', () => {
  it("stdin's end closes the socket and exits 0; Magnusim closing the connection exits 0 too; the token is on no argv, stdout or stderr", async () => {
    const token = world.file.token;
    // stdin ends: the connection closes on the server, and the bridge exits 0.
    const b = runBridge(['--info', world.info]);
    assert.ok(!b.args.join(' ').includes(token));
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    b.child.stdin.write(`${JSON.stringify(init)}\n`);
    await H.until(() => b.out().includes('"id":1'), 10_000, 'the initialize answer');
    b.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await H.until(() => b.out().includes('"id":2'), 10_000, 'the tools/list answer');
    assert.equal(L.mcpListenerStatus().connected, 1);
    const ended = Date.now();
    let connectedAtExit = null;
    b.child.once('exit', () => (connectedAtExit = L.mcpListenerStatus().connected));
    b.child.stdin.end();
    assert.equal(await exitOf(b), 0);
    // It closed its side, so the server ended the connection before the bridge saw the end
    // (not its fallback: destroying the socket after END_MS).
    assert.equal(connectedAtExit, 0, 'the server had ended the connection');
    assert.ok(Date.now() - ended < bridge.END_MS - 2_000, 'well before the fallback');
    const lines = b.out().trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.id),
      [1, 2],
      'stdout holds the server messages only',
    );
    assert.ok(!b.out().includes(token) && !b.err().includes(token));
    assert.equal(b.err(), '');

    // Magnusim closes it (its server lifetime ends): the bridge exits 0 and the client sees the end.
    const b2 = runBridge(['--info', world.info]);
    b2.child.stdin.write(`${JSON.stringify(init)}\n`);
    await H.until(() => b2.out().includes('"id":1'), 10_000, 'the initialize answer');
    world.dispose();
    assert.equal(await exitOf(b2), 0);
    assert.ok(!b2.out().includes(token) && !b2.err().includes(token));
    world.dispose = L.setMcpHandler(world.svc.handler);
  });
});
