// The coding-agent protocol (phase 3 spec 4.5, 4.7, 4.12, 7.2): the newline JSON-RPC peer
// (rpc.ts), the builders and readers (acp.ts), which tool calls count as Magnusim's (only from
// fields the adapter sets), the sign-in command shown with Copy only when it is safe, and the
// scripted fake agent the later tests drive. Every message our builders make and every message
// the fake sends is checked against the agent protocol's own JSON Schema (Ajv 2020).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-acp-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];

const rpc = await import('../assistant/agents/rpc.ts');
const acp = await import('../assistant/agents/acp.ts');
const { FakeClock } = await import('./assistant-harness.js');
const { startFakeAcp, FAKE_ACP_AGENT } = await import('../../../e2e/support/fake-acp.mjs');
const { default: Ajv2020 } = await import('ajv/dist/2020.js');

const require = createRequire(import.meta.url);
const SCHEMA = require('@agentclientprotocol/sdk/schema/schema.json');
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(SCHEMA, 'acp');

/** Valid against the schema's `#/$defs/<def>`, or the first errors. */
function conforms(def, data) {
  const v = ajv.getSchema(`acp#/$defs/${def}`);
  assert.ok(v, `the schema has ${def}`);
  const ok = v(data);
  assert.ok(ok, `${def}: ${JSON.stringify((v.errors || []).slice(0, 3))}\n${JSON.stringify(data).slice(0, 600)}`);
}

const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

/** A peer over in-memory pipes: `toPeer` is what the agent writes, `written` what the peer wrote. */
function memPeer(o = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      written.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const peer = new rpc.RpcPeer({ input, output, ...o });
  return { peer, input, output, written };
}

const flush = () => new Promise((r) => setImmediate(r));

// --------------------------------------------------------------------------------------------
// A ceiling, so a test that would hang fails instead.
const LIMIT = { timeout: 60_000 };

describe('rpc.ts: newline JSON-RPC over the agent pipes', LIMIT, () => {
  it('reads lines split across chunks, ends CR LF lines, skips an oversized line and drops non-JSON', async () => {
    const notes = [];
    const { peer, input } = memPeer({ maxLineBytes: 64, onNotification: (m, p) => notes.push([m, p]) });
    const a = Buffer.from('{"jsonrpc":"2.0","method":"a","params":{"t":"é"}}\n');
    // Split inside the two-byte é: the line is decoded whole.
    const cut = a.indexOf(0xc3) + 1;
    input.write(a.subarray(0, cut));
    input.write(a.subarray(cut));
    input.write('{"jsonrpc":"2.0","method":"b"}\r\n');
    input.write(`{"jsonrpc":"2.0","method":"too-long","params":"${'x'.repeat(100)}"}\n`);
    input.write('{"jsonrpc":"2.0","method":"c"}\nnot json at all\n[1,2]\n\n');
    // An oversized line that arrives in pieces is skipped to its end too.
    input.write(`{"jsonrpc":"2.0","method":"long2","params":"${'y'.repeat(40)}`);
    input.write(`${'y'.repeat(40)}"}\n{"jsonrpc":"2.0","method":"d"}\n`);
    await flush();
    assert.deepEqual(
      notes.map(([m]) => m),
      ['a', 'b', 'c', 'd'],
    );
    assert.deepEqual(notes[0][1], { t: 'é' });
    assert.equal(peer.stats.oversized, 2);
    assert.equal(peer.stats.nonJson, 2);
  });

  it('answers -32601 for every request it does not serve, and lets the handler serve the rest', async () => {
    const seen = [];
    const { peer, input, written } = memPeer({
      onRequest: (method, params, id) => {
        seen.push(method);
        if (method !== 'session/request_permission') return false;
        peer.reply(id, { outcome: { outcome: 'cancelled' } });
        return true;
      },
    });
    input.write('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":"x","method":"terminal/create","params":{}}\n');
    input.write('{"jsonrpc":"2.0","id":8,"method":"session/request_permission","params":{}}\n');
    await flush();
    await flush();
    assert.deepEqual(seen, ['fs/read_text_file', 'terminal/create', 'session/request_permission']);
    assert.deepEqual(written, [
      { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Magnusim does not serve fs/read_text_file' } },
      { jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'Magnusim does not serve terminal/create' } },
      { jsonrpc: '2.0', id: 8, result: { outcome: { outcome: 'cancelled' } } },
    ]);
    // With no handler at all, everything is refused.
    const bare = memPeer();
    bare.input.write('{"jsonrpc":"2.0","id":1,"method":"elicitation/create","params":{}}\n');
    await flush();
    await flush();
    assert.equal(bare.written[0].error.code, -32601);
  });

  it('numbers requests 1, 2, 3, settles each by id, drops unknown ids, and reads errors (auth required)', async () => {
    const { peer, input, written } = memPeer();
    const a = peer.request('initialize', { protocolVersion: 1 });
    const b = peer.request('session/new', { cwd: '/x', mcpServers: [] });
    const c = peer.request('session/prompt', { sessionId: 's', prompt: [] });
    await flush();
    assert.deepEqual(
      written.map((m) => [m.id, m.method]),
      [
        [1, 'initialize'],
        [2, 'session/new'],
        [3, 'session/prompt'],
      ],
    );
    input.write('{"jsonrpc":"2.0","id":99,"result":{}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n');
    input.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n');
    input.write('{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Please auth first"}}\n');
    assert.deepEqual(await a, { protocolVersion: 1 });
    const eb = await b.then(() => null, (e) => e);
    assert.ok(eb instanceof rpc.RpcError);
    assert.equal(eb.code, -32000);
    assert.equal(eb.authRequired, true);
    const ec = await c.then(() => null, (e) => e);
    assert.equal(ec.code, -32603);
    assert.equal(ec.authRequired, true, 'a message that mentions auth counts');
    assert.equal(new rpc.RpcError(-32603, 'Internal error').authRequired, false);
    // A sign-in problem the agent says passes is not a sign-out (seen live with Claude Code).
    const passing =
      'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again';
    assert.equal(new rpc.RpcError(-32000, passing).authRequired, false);
    assert.equal(new rpc.RpcError(-32603, passing).authRequired, false);
    assert.equal(peer.stats.unmatched, 1);
    assert.equal(peer.pendingCount, 0);
  });

  it('times requests out per method (fake clock); session/prompt has no timeout of its own', async () => {
    const clock = new FakeClock();
    const { peer } = memPeer({ clock });
    const init = peer.request('initialize', {});
    const newS = peer.request('session/new', {});
    const auth = peer.request('authenticate', {});
    const mode = peer.request('session/set_mode', {});
    const prompt = peer.request('session/prompt', {});
    const own = peer.request('session/prompt', {}, { timeoutMs: 5_000 });
    const states = new Map();
    for (const [name, p] of Object.entries({ init, newS, auth, mode, prompt, own })) {
      p.then(
        () => states.set(name, 'ok'),
        (e) => states.set(name, e),
      );
    }
    clock.advance(4_999);
    await flush();
    assert.equal(states.size, 0);
    clock.advance(1);
    await flush();
    assert.ok(states.get('own') instanceof rpc.RpcTimeout);
    clock.advance(10_000); // 15 s
    await flush();
    assert.ok(states.get('mode') instanceof rpc.RpcTimeout);
    assert.ok(!states.has('init'));
    clock.advance(15_000); // 30 s
    await flush();
    assert.ok(states.get('init') instanceof rpc.RpcTimeout);
    assert.equal(states.get('init').method, 'initialize');
    clock.advance(30_000); // 60 s
    await flush();
    assert.ok(states.get('newS') instanceof rpc.RpcTimeout);
    clock.advance(540_000); // 10 minutes
    await flush();
    assert.ok(states.get('auth') instanceof rpc.RpcTimeout);
    clock.advance(24 * 3600_000);
    await flush();
    assert.ok(!states.has('prompt'), 'session/prompt waits as long as it takes');
    assert.equal(peer.pendingCount, 1);
    peer.exit({ code: 0, signal: null });
    await flush();
    assert.ok(states.get('prompt') instanceof rpc.RpcExited);
  });

  it('an abort signal ends one request', async () => {
    const { peer } = memPeer();
    const ac = new AbortController();
    const p = peer.request('session/new', {}, { signal: ac.signal });
    ac.abort(new Error('stopped'));
    await assert.rejects(p, /stopped/);
    assert.equal(peer.pendingCount, 0);
  });

  it('when the agent exits, every pending request rejects with its exit code and last words, and later calls at once', async () => {
    const tail = ['first line', 'the last words'];
    const child = spawn(process.execPath, ['-e', "process.stdin.once('data',()=>{process.stderr.write('bye\\n');process.exit(3)})"], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const peer = new rpc.RpcPeer({ input: child.stdout, output: child.stdin, tail: () => tail, exited });
    const a = peer.request('initialize', {});
    const b = peer.request('session/prompt', {});
    const [ea, eb] = await Promise.all([a.then(() => null, (e) => e), b.then(() => null, (e) => e)]);
    for (const e of [ea, eb]) {
      assert.ok(e instanceof rpc.RpcExited, String(e));
      assert.equal(e.code, 3);
      assert.deepEqual(e.tail, tail);
    }
    assert.equal(peer.closed, true);
    await assert.rejects(peer.request('session/new', {}), rpc.RpcExited);
    peer.notify('session/cancel', { sessionId: 's' }); // dropped, no throw
  });

  it('the end of the agent output alone fails pending requests (code unknown)', async () => {
    const { peer, input } = memPeer();
    const p = peer.request('initialize', {});
    input.end();
    const e = await p.then(() => null, (x) => x);
    assert.ok(e instanceof rpc.RpcExited);
    assert.equal(e.code, null);
  });

  it('queues writes behind a full pipe and keeps their order', async () => {
    const chunks = [];
    let release;
    const slow = new Writable({
      highWaterMark: 16,
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        if (chunks.length === 1) release = cb;
        else cb();
      },
    });
    const peer = new rpc.RpcPeer({ input: new PassThrough(), output: slow });
    for (let i = 0; i < 20; i += 1) peer.notify('n', { i });
    assert.equal(chunks.length, 1, 'the first write is still in the pipe');
    // The rest wait in the peer's own queue, not piled into the pipe's buffer.
    assert.ok(slow.writableLength < 100, String(slow.writableLength));
    release();
    await flush();
    await flush();
    const order = chunks.join('').trim().split('\n').map((l) => JSON.parse(l).params.i);
    assert.deepEqual(order, [...Array(20).keys()]);
  });
});

// --------------------------------------------------------------------------------------------
describe('acp.ts builders', () => {
  const BRIDGE = { command: process.execPath, script: join(ROOT, 'web', 'scripts', 'assistant-mcp.mjs'), binding: 'b-0123456789abcdef01234567', info: join(ROOT, 'home', 'assistant', 'mcp.json') };

  it('initialize says: no file system, no terminal, terminal sign-in, compaction updates (spec 4.5, exactly)', () => {
    const p = acp.initializeParams('0.3.0');
    assert.deepEqual(p, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true }, session: { compaction: {} }, _meta: { 'terminal-auth': true } },
      clientInfo: { name: 'magnusim', title: 'Magnusim', version: '0.3.0' },
    });
    assert.ok(!('elicitation' in p.clientCapabilities));
    conforms('InitializeRequest', p);
    // The Claude Code adapter's own check (0.89.0 context-compaction.js clientSupportsCompactionUpdates): a non-null object, not an array.
    const compaction = p.clientCapabilities.session?.compaction;
    assert.ok(typeof compaction === 'object' && compaction !== null && !Array.isArray(compaction));
  });

  it('session/new hands over the bridge with --binding and --info, no environment, no type key, no token', () => {
    // The token lives in the owner-only file the bridge reads (--info): only its path goes.
    const token = 'tok_' + 'Z'.repeat(40);
    mkdirSync(dirname(BRIDGE.info), { recursive: true });
    writeFileSync(BRIDGE.info, JSON.stringify({ version: 1, port: 1, token }));
    try {
      const p = acp.sessionNewParams(join(ROOT, 'work'), BRIDGE, {});
      assert.deepEqual(p.mcpServers, [{ name: 'magnusim', command: process.execPath, args: [BRIDGE.script, '--binding', BRIDGE.binding, '--info', BRIDGE.info], env: [] }]);
      assert.ok(!('type' in p.mcpServers[0]), 'an adapter keeps a stdio server only without a type key');
      assert.ok(!('_meta' in p), 'an agent without a hook gets no _meta');
      const text = JSON.stringify(p);
      assert.ok(!text.includes('MAGNUSIM_'), 'no Magnusim variable');
      assert.ok(!text.includes(token), 'no token');
      assert.ok(!text.includes('claudeCode'));
      conforms('NewSessionRequest', p);
      const withMeta = acp.sessionNewParams(join(ROOT, 'work'), BRIDGE, { sessionMeta: acp.CLAUDE_CODE_SESSION });
      const t2 = JSON.stringify(withMeta);
      assert.ok(!t2.includes('MAGNUSIM_') && !t2.includes(token));
      conforms('NewSessionRequest', withMeta);
    } finally {
      rmSync(BRIDGE.info, { force: true });
    }
  });

  it('the first agent hook turns its own tools off and appends the note (spec 4.9)', async () => {
    const p = acp.sessionNewParams('/w', BRIDGE, { sessionMeta: acp.CLAUDE_CODE_SESSION });
    const m = p._meta;
    // RH1: in Magnusim the CFD guide follows the note.
    const { cfdGuideText } = await import('../assistant/cfdGuide.ts');
    assert.deepEqual(m.systemPrompt, { append: `${acp.AGENT_NOTE}\n\n${cfdGuideText()}` }, 'an object appends; a string would replace');
    assert.equal(m.disableBuiltInTools, true);
    const o = m.claudeCode.options;
    assert.deepEqual(o.tools, []);
    const SEVENTEEN = ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'ToolSearch'];
    for (const t of SEVENTEEN) assert.ok(o.disallowedTools.includes(t), t);
    assert.equal(o.allowDangerouslySkipPermissions, false);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.persistSession, false);
    assert.ok(!('permissionMode' in o), 'modes go through set_mode');
    assert.equal(acp.noteInSystemPrompt({ sessionMeta: acp.CLAUDE_CODE_SESSION }), true);
    assert.equal(acp.noteInSystemPrompt({}), false);
  });

  it('the note block, prompt, cancel, mode, config, authenticate and permission replies conform', () => {
    const note = acp.noteBlock();
    assert.equal(note.type, 'text');
    assert.ok(note.text.startsWith('Note from Magnusim (not from the person): You are working inside Magnusim'));
    conforms('PromptRequest', acp.promptParams('s-1', [note, { type: 'text', text: 'hello' }]));
    conforms('CancelNotification', acp.cancelParams('s-1'));
    conforms('SetSessionModeRequest', acp.setModeParams('s-1', 'default'));
    conforms('SetSessionConfigOptionRequest', acp.setConfigOptionParams('s-1', 'model', 'fake-small'));
    conforms('AuthenticateRequest', acp.authenticateParams('cached_token', { headless: true }));
    conforms('AuthenticateRequest', acp.authenticateParams('agent'));
    assert.deepEqual(acp.permissionReply('allow'), { outcome: { outcome: 'selected', optionId: 'allow' } });
    assert.deepEqual(acp.permissionReply(null), { outcome: { outcome: 'cancelled' } });
    conforms('RequestPermissionResponse', acp.permissionReply('allow'));
    conforms('RequestPermissionResponse', acp.permissionReply(null));
    // Pre-v1, so not in the schema: only its shape.
    assert.deepEqual(acp.setModelParams('s-1', 'm'), { sessionId: 's-1', modelId: 'm' });
  });
});

// --------------------------------------------------------------------------------------------
describe('acp.ts readers', () => {
  it('auth methods: terminal with args, env and _meta["terminal-auth"]; agent; the tolerated pre-v1 shapes', () => {
    const init = {
      protocolVersion: 1,
      authMethods: [
        {
          type: 'terminal',
          id: 'login',
          name: 'Log in',
          description: 'Opens a browser',
          args: ['--cli', 'auth', 'login'],
          env: { AGENT_MODE: 'login' },
          _meta: { 'terminal-auth': { command: '/usr/bin/node', args: ['/x/index.js', '--cli', 'auth', 'login'], label: 'Login' } },
        },
        { id: 'browser', name: 'In the browser' },
        { id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'acme' } } },
        { type: 'env_var', id: 'key', name: 'Key', varName: 'ACME_KEY' },
        { type: 'env_var', id: 'keys', name: 'Keys', vars: [{ name: 'A_KEY' }, { name: 'bad name' }] },
        { type: 'terminal', id: 'old', name: 'Old env', env: [{ name: 'X', value: 'y' }] },
        { name: 'no id' },
        'junk',
      ],
    };
    const m = acp.authMethods(init);
    assert.deepEqual(
      m.map((x) => [x.id, x.type]),
      [
        ['login', 'terminal'],
        ['browser', 'agent'],
        ['api-key', 'env_var'],
        ['key', 'env_var'],
        ['keys', 'env_var'],
        ['old', 'terminal'],
      ],
    );
    assert.deepEqual(m[0].args, ['--cli', 'auth', 'login']);
    assert.deepEqual(m[0].env, [{ name: 'AGENT_MODE', value: 'login' }]);
    assert.deepEqual(m[0].terminalAuth, { command: '/usr/bin/node', args: ['/x/index.js', '--cli', 'auth', 'login'], label: 'Login' });
    assert.deepEqual(m[2].vars, ['ACME_API_KEY']);
    assert.deepEqual(m[3].vars, ['ACME_KEY']);
    assert.deepEqual(m[4].vars, ['A_KEY']);
    assert.deepEqual(m[5].env, [{ name: 'X', value: 'y' }]);
    assert.deepEqual(acp.authMethods({}), []);
  });

  it('agent info, images, protocol version, modes, config options (grouped too) and legacy models', () => {
    const init = { protocolVersion: 1, agentInfo: { name: 'agent\u0007x', title: 'Agent X', version: '2.1.1' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } };
    assert.deepEqual(acp.agentInfo(init), { name: 'agent x', title: 'Agent X', version: '2.1.1' });
    assert.equal(acp.takesImages(init), true);
    assert.equal(acp.takesImages({}), false);
    assert.equal(acp.loadsSessions(init), true);
    assert.equal(acp.protocolVersionOf(init), 1);
    assert.equal(acp.protocolVersionOf({ protocolVersion: '1' }), null);
    const session = {
      sessionId: 'abc',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Plans first' }, { name: 'no id' }] },
      configOptions: [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'b', options: [{ group: 'g', name: 'Group', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: true },
      ],
      models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'One' }, { modelId: 'm2' }] },
    };
    assert.equal(acp.sessionIdOf(session), 'abc');
    assert.deepEqual(acp.modes(session), {
      current: 'default',
      available: [
        { id: 'default', name: 'Default', description: '' },
        { id: 'plan', name: 'Plan', description: 'Plans first' },
      ],
    });
    const opts = acp.configOptions(session);
    assert.deepEqual(
      opts.map((o) => [o.id, o.category, o.type, o.current]),
      [
        ['mode', 'mode', 'select', 'default'],
        ['model', 'model', 'select', 'b'],
        ['fast', null, 'boolean', true],
      ],
    );
    assert.deepEqual(opts[1].options, [
      { value: 'a', name: 'A' },
      { value: 'b', name: 'B' },
    ]);
    assert.deepEqual(acp.configCurrent(opts, 'model'), { id: 'model', value: 'b' });
    assert.deepEqual(acp.models(session), {
      current: 'm1',
      available: [
        { id: 'm1', name: 'One', description: '' },
        { id: 'm2', name: 'm2', description: '' },
      ],
    });
    assert.equal(acp.models({}), null);
    assert.equal(acp.modes({}), null);
  });

  it('ids and values are raw but capped: a long choice is dropped, a long current value is cut and still seen', () => {
    const long = (c) => c.repeat(200);
    const ESC = String.fromCharCode(27);
    const m = acp.modes({ modes: { currentModeId: `default${long('x')}`, availableModes: [{ id: long('y'), name: 'Too long' }, { id: `plan${ESC}[2J`, name: `Plan${ESC}[2J` }, { id: 'default', name: 'Default' }] } });
    assert.deepEqual(
      m.available.map((x) => x.id),
      [`plan${ESC}[2J`, 'default'],
      'ids raw, a long one dropped',
    );
    assert.equal(m.available[0].name, 'Plan [2J', 'names cleaned');
    assert.equal(m.current.length, acp.ID_MAX);
    assert.notEqual(m.current, 'default');
    assert.deepEqual(acp.update({ sessionUpdate: 'current_mode_update', currentModeId: long('b') }), { kind: 'mode', mode: 'b'.repeat(acp.ID_MAX) }, 'a long mode is still reported');
    assert.equal(acp.update({ sessionUpdate: 'current_model_update', currentModelId: long('m') }).model.length, acp.ID_MAX);
    const cfg = acp.update({
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: long('i'), name: 'Mode', category: 'mode', type: 'select', currentValue: long('v'), options: [{ value: long('o'), name: 'Long' }, { value: 'plan', name: 'Plan' }] }],
    });
    assert.equal(cfg.options[0].id.length, acp.ID_MAX, 'an option with a long id stays, so its mode is seen');
    assert.equal(cfg.mode, 'v'.repeat(acp.ID_MAX));
    assert.deepEqual(cfg.options[0].options, [{ value: 'plan', name: 'Plan' }]);
    assert.equal(acp.configOptions([{ id: 'x', category: long('k'), type: 'select' }])[0].category.length, 64);
    const models = acp.models({ models: { currentModelId: long('c'), availableModels: [{ modelId: long('d') }, { modelId: 'm1' }] } });
    assert.deepEqual(
      models.available.map((x) => x.id),
      ['m1'],
    );
    assert.equal(models.current.length, acp.ID_MAX);
    assert.deepEqual(
      acp.authMethods({ authMethods: [{ id: long('a'), name: 'A' }, { id: 'ok', name: 'OK' }] }).map((x) => x.id),
      ['ok'],
    );
    const p = acp.permission({ toolCall: { toolCallId: 't', kind: long('k') }, options: [{ optionId: long('o'), name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }] });
    assert.equal(p.kind.length, 64);
    assert.deepEqual(
      p.options.map((o) => o.optionId),
      ['r'],
      'an option with a long id is dropped (so never auto-allowed)',
    );
    assert.equal(acp.update({ sessionUpdate: 'tool_call', toolCallId: 't', kind: long('k') }).toolKind.length, 64);
  });

  it('maps each session update (spec 4.7), ignoring the rest', () => {
    const u = acp.update;
    assert.deepEqual(u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }), { kind: 'text', text: 'Hi' });
    assert.deepEqual(u({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } }), { kind: 'content', type: 'image' });
    assert.deepEqual(u({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }), { kind: 'thought', text: 'hmm' });
    assert.deepEqual(u({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'mcp.magnusim.add', kind: 'execute', status: 'pending', _meta: { is_mcp_tool_call: true } }), {
      kind: 'tool',
      isNew: true,
      id: 't1',
      title: 'mcp.magnusim.add',
      toolKind: 'execute',
      status: 'pending',
      meta: { is_mcp_tool_call: true },
    });
    assert.equal(u({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'weird' }).status, null);
    const plan = u({ sessionUpdate: 'plan', entries: Array.from({ length: 40 }, (_, i) => ({ content: `step ${i}\n`, status: i ? 'completed' : 'odd', priority: 'high' })) });
    assert.equal(plan.entries.length, 32);
    assert.deepEqual(plan.entries[0], { content: 'step 0', status: 'pending', priority: 'high' });
    assert.deepEqual(u({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }), { kind: 'mode', mode: 'plan' });
    assert.deepEqual(u({ sessionUpdate: 'current_model_update', currentModelId: 'm2' }), { kind: 'model', model: 'm2' });
    const cfg = u({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'plan', options: [] }] });
    assert.equal(cfg.kind, 'config');
    assert.equal(cfg.mode, 'plan');
    assert.equal(cfg.model, null);
    assert.deepEqual(u({ sessionUpdate: 'usage_update', used: 10, size: 100 }), { kind: 'usage', used: 10, size: 100 });
    // Compaction (unstable): its updates, by id; its summary's chunks are ignored.
    assert.deepEqual(u({ sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'in_progress' }), { kind: 'compaction', id: 'cmp-1', status: 'in_progress', error: null });
    assert.deepEqual(u({ sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed', summary: [{ type: 'text', text: 'kept' }] }), { kind: 'compaction', id: 'cmp-1', status: 'completed', error: null });
    assert.deepEqual(u({ sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'failed', error: 'x'.repeat(3000) }).error.length, 2000);
    assert.equal(u({ sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'paused' }).status, null);
    assert.equal(u({ sessionUpdate: 'compaction_update', compactionId: 'c'.repeat(257), status: 'completed' }), null);
    assert.equal(u({ sessionUpdate: 'compaction_update', status: 'completed' }), null);
    assert.equal(u({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'kept' } }), null);
    conforms('SessionNotification', { sessionId: 's', update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed' } });
    for (const ignored of ['available_commands_update', 'session_info_update', 'user_message_chunk', 'notice']) {
      assert.equal(u({ sessionUpdate: ignored }), null, ignored);
    }
    assert.equal(u(null), null);
    assert.deepEqual(acp.sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } }), {
      sessionId: 's',
      update: { kind: 'text', text: 'x' },
    });
  });

  it('reads a permission request (at most 8 options), stop reasons and picks options', () => {
    const p = acp.permission({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'rm -rf /', kind: 'execute', rawInput: { command: 'rm' }, _meta: { claudeCode: { toolName: 'Bash' } } },
      options: Array.from({ length: 10 }, (_, i) => ({ optionId: `o${i}`, name: `O${i}`, kind: i === 3 ? 'reject_once' : i === 5 ? 'allow_once' : 'allow_always' })),
      _meta: { x: 1 },
    });
    assert.equal(p.toolCallId, 't');
    assert.equal(p.title, 'rm -rf /');
    assert.equal(p.kind, 'execute');
    assert.deepEqual(p.rawInput, { command: 'rm' });
    assert.equal(p.metaToolName, 'Bash');
    assert.deepEqual(p.meta, { x: 1 });
    assert.equal(p.options.length, 8);
    assert.equal(acp.pickOption(p.options, acp.ALLOW_KINDS), 'o5');
    assert.equal(acp.pickOption(p.options, acp.REJECT_KINDS), 'o3');
    assert.equal(acp.pickOption([{ optionId: 'a', name: 'A', kind: 'allow_always' }], acp.ALLOW_KINDS), null, 'never allow_always');
    for (const r of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error']) assert.equal(acp.stopReasonOf({ stopReason: r }), r);
    assert.equal(acp.stopReasonOf({ stopReason: 'other' }), null);
  });

  it('splits a command like a shell, without one (SolidCraft acp.rs cases)', () => {
    assert.deepEqual(acp.splitCommand('gemini --acp'), ['gemini', '--acp']);
    assert.deepEqual(acp.splitCommand(String.raw`  "C:\Program Files\x\agent.exe"  --flag 'a b' `), [String.raw`C:\Program Files\x\agent.exe`, '--flag', 'a b']);
    assert.deepEqual(acp.splitCommand('a "" b'), ['a', '', 'b']);
    assert.deepEqual(acp.splitCommand('   '), []);
    assert.deepEqual(acp.splitCommand(String.raw`say \"hi\" 'it\'s'`), ['say', '"hi"', "it's"]);
    assert.deepEqual(acp.splitCommand('a;b && c | d'), ['a;b', '&&', 'c', '|', 'd'], 'no operator means anything');
  });
});

// --------------------------------------------------------------------------------------------
describe('which tool calls are Magnusim tools: only adapter-set fields count', () => {
  const served = (name) => ['app_status', 'add', 'ai-demo__add'].includes(name);
  const tool = (o) => acp.update({ sessionUpdate: 'tool_call', status: 'pending', ...o });
  const toolUpd = (o) => acp.update({ sessionUpdate: 'tool_call_update', ...o });
  const perm = (toolCall, meta) => acp.permission({ sessionId: 's', toolCall, options: [], ...(meta ? { _meta: meta } : {}) });
  const META = (toolName, server = 'magnusim') => ({ claudeCode: { toolName, ...(server ? { mcpServer: { name: server, source: 'config' } } : {}) } });

  it('tool name in _meta: mcp__magnusim__<served tool>, remembered by id', () => {
    const m = new acp.OursMatcher('tool_name_meta', served);
    assert.equal(m.tool(tool({ toolCallId: 'a', title: 'anything', _meta: META('mcp__magnusim__add') })), 'add');
    assert.equal(m.tool(toolUpd({ toolCallId: 'a', status: 'completed' })), 'add', 'its later updates');
    assert.equal(m.permission(perm({ toolCallId: 'a', _meta: META('mcp__magnusim__add') })), 'add', 'a permission that names it');
    assert.equal(m.permission(perm({ toolCallId: 'a', title: 'rm -rf ~', kind: 'execute' })), null, 'never by a remembered id alone');
    assert.equal(m.permission(perm({ toolCallId: 'b', title: 'x', _meta: META('mcp__magnusim__app_status') })), 'app_status');
    assert.equal(m.tool(tool({ toolCallId: 'c', _meta: META('mcp__magnusim__ai-demo__add', null) })), 'ai-demo__add', 'no mcpServer field: the name decides');
    // Refused:
    assert.equal(m.tool(tool({ toolCallId: 'd', _meta: META('magnusim_app_status') })), null, 'a bare name');
    assert.equal(m.tool(tool({ toolCallId: 'e', _meta: META('mcp__magnusim-evil__add') })), null, 'a lookalike server');
    assert.equal(m.tool(tool({ toolCallId: 'g', _meta: META('mcp__magnusim__add', 'other') })), null, 'another server');
    assert.equal(m.permission(perm({ toolCallId: 'h', title: 'magnusim_app_status', kind: 'execute' })), null, 'an own request titled like ours');
    assert.equal(m.ourRequest(perm({ toolCallId: 'h', title: 'magnusim_app_status', kind: 'execute' })), false);
    assert.equal(m.permission(perm({ toolCallId: 'i', title: 'mcp__magnusim__app_status', kind: 'execute' })), null, 'the title is never read');
    assert.equal(m.ourRequest(perm({ toolCallId: 'i', title: 'mcp__magnusim__app_status', kind: 'execute' })), false);
    assert.equal(m.tool(tool({ toolCallId: 'j', title: 'mcp__magnusim__add' })), null);
    assert.equal(m.tool(toolUpd({ toolCallId: 'a', _meta: META('Bash', null) })), null, 'an update naming another tool is not ours');
    assert.equal(m.permission(perm({ toolCallId: 'k', _meta: META('Bash', null) })), null);
    assert.equal(m.ourRequest(perm({ toolCallId: 'k', _meta: META('Bash', null) })), false);
    assert.equal(m.ourRequest(perm({ toolCallId: 'e2', _meta: META('mcp__magnusim-evil__add') })), false, 'a lookalike server asks as the agent’s own');
  });

  it('a tool of Magnusim’s server that isn’t served (the list changed under the agent): still ours, never the agent’s own, but asked, never allowed without asking', () => {
    let list = ['app_status', 'ai-demo__add', 'ai-demo__get_count'];
    const m = new acp.OursMatcher('tool_name_meta', (name) => list.includes(name));
    assert.equal(m.tool(tool({ toolCallId: 'a', _meta: META('mcp__magnusim__ai-demo__add') })), 'ai-demo__add');
    assert.equal(m.permission(perm({ toolCallId: 'a', _meta: META('mcp__magnusim__ai-demo__add') })), 'ai-demo__add', 'served: allowed without asking');
    // The tab's link drops: its workspace's tools leave the list.
    list = ['app_status'];
    assert.equal(m.tool(toolUpd({ toolCallId: 'a', status: 'failed', _meta: META('mcp__magnusim__ai-demo__add') })), 'ai-demo__add', 'its result update stays ours');
    assert.equal(m.tool(tool({ toolCallId: 'b', _meta: META('mcp__magnusim__ai-demo__get_count') })), 'ai-demo__get_count', 'a call of a dropped tool is ours');
    const dropped = perm({ toolCallId: 'b', _meta: META('mcp__magnusim__ai-demo__get_count') });
    assert.equal(m.permission(dropped), null, 'not served: never allowed without asking');
    assert.equal(m.ourRequest(dropped), true, 'but never the agent’s own tool');
    assert.equal(m.tool(tool({ toolCallId: 'f', _meta: META('mcp__magnusim__rm_rf') })), 'rm_rf', 'any name of its server');
    // A request without the fields (an adapter that leaves them off an MCP tool's request): ours by
    // the tool call's own fields, never allowed by that alone.
    assert.equal(m.ourRequest(perm({ toolCallId: 'b', title: 'x' })), true);
    assert.equal(m.permission(perm({ toolCallId: 'b', title: 'x' })), null);
    assert.equal(m.ourRequest(perm({ toolCallId: 'zz', title: 'x' })), false, 'an id never classed ours');

    let flagList = ['add'];
    const f = new acp.OursMatcher('mcp_call_flag', (name) => flagList.includes(name));
    assert.equal(f.tool(tool({ toolCallId: 'd', title: 'mcp.magnusim.add', _meta: { is_mcp_tool_call: true } })), 'add');
    flagList = [];
    assert.equal(f.tool(toolUpd({ toolCallId: 'd', status: 'completed', title: 'mcp.magnusim.add', _meta: { is_mcp_tool_call: true } })), 'add');
    const approval = perm({ toolCallId: 'd', kind: 'execute' }, { is_mcp_tool_approval: true });
    assert.equal(f.permission(approval), null, 'not served: asked');
    assert.equal(f.ourRequest(approval), true);
    assert.equal(f.ourRequest(perm({ toolCallId: 'd', kind: 'execute' })), false, 'no approval flag');
  });

  it('flagged MCP call: mcp.magnusim.<served tool> with the flag; an approval only for a tool call already ours', () => {
    const m = new acp.OursMatcher('mcp_call_flag', served);
    assert.equal(m.tool(tool({ toolCallId: 'a', kind: 'execute', title: 'mcp.magnusim.add', _meta: { is_mcp_tool_call: true } })), 'add');
    assert.equal(m.tool(toolUpd({ toolCallId: 'a', status: 'in_progress', _meta: { is_mcp_tool_call: true } })), 'add', 'an update without its title');
    assert.equal(m.permission(perm({ toolCallId: 'a', kind: 'execute', title: 'MCP tool call approval' }, { is_mcp_tool_approval: true })), 'add');
    // Refused:
    assert.equal(m.permission(perm({ toolCallId: 'zzz', kind: 'execute' }, { is_mcp_tool_approval: true })), null, 'an approval for no tool call of ours');
    assert.equal(m.permission(perm({ toolCallId: 'a', kind: 'execute' })), null, 'no approval flag');
    assert.equal(m.tool(tool({ toolCallId: 'b', kind: 'execute', title: 'mcp.magnusim.app_status' })), null, 'the title without the flag');
    assert.equal(m.permission(perm({ toolCallId: 'b', title: 'mcp.magnusim.app_status', kind: 'execute' })), null, 'an own request titled like ours');
    assert.equal(m.tool(tool({ toolCallId: 'c', title: 'mcp.magnusim-evil.add', _meta: { is_mcp_tool_call: true } })), null);
    assert.equal(m.tool(tool({ toolCallId: 'e', title: 'mcp.other.add', _meta: { is_mcp_tool_call: true } })), null);
    assert.equal(m.permission(perm({ toolCallId: 'c' }, { is_mcp_tool_approval: true })), null);
    assert.equal(m.ourRequest(perm({ toolCallId: 'c' }, { is_mcp_tool_approval: true })), false, 'a lookalike server’s approval is the agent’s own');
    // A name of its server that isn't served: ours, but its approval is asked.
    assert.equal(m.tool(tool({ toolCallId: 'd', title: 'mcp.magnusim.rm_rf', _meta: { is_mcp_tool_call: true } })), 'rm_rf');
    assert.equal(m.permission(perm({ toolCallId: 'd', kind: 'execute' }, { is_mcp_tool_approval: true })), null, 'not served: asked');
  });

  it('an id stops being ours once an update or request for it names something else', () => {
    const m = new acp.OursMatcher('tool_name_meta', served);
    assert.equal(m.tool(tool({ toolCallId: 'x', _meta: META('mcp__magnusim__add') })), 'add');
    assert.equal(m.tool(toolUpd({ toolCallId: 'x', _meta: META('Bash', null) })), null);
    assert.equal(m.tool(toolUpd({ toolCallId: 'x', status: 'completed' })), null, 'its later updates without fields are not ours either');
    assert.equal(m.has('x'), false);
    assert.equal(m.tool(tool({ toolCallId: 'y', _meta: META('mcp__magnusim__add') })), 'add');
    assert.equal(m.permission(perm({ toolCallId: 'y', _meta: META('Bash', null) })), null);
    assert.equal(m.tool(toolUpd({ toolCallId: 'y', status: 'completed' })), null);

    const f = new acp.OursMatcher('mcp_call_flag', served);
    assert.equal(f.tool(tool({ toolCallId: 'z', title: 'mcp.magnusim.add', _meta: { is_mcp_tool_call: true } })), 'add');
    assert.equal(f.tool(toolUpd({ toolCallId: 'z', title: 'mcp.other.exec', _meta: { is_mcp_tool_call: true } })), null);
    assert.equal(f.permission(perm({ toolCallId: 'z', kind: 'execute' }, { is_mcp_tool_approval: true })), null, 'its approval is a question for the person');
  });

  it('an agent with no known field (a custom command) never has a tool of ours', () => {
    const m = new acp.OursMatcher(null, served);
    assert.equal(m.tool(tool({ toolCallId: 'a', title: 'mcp.magnusim.add', _meta: { is_mcp_tool_call: true, ...META('mcp__magnusim__add') } })), null);
    assert.equal(m.permission(perm({ toolCallId: 'a', _meta: META('mcp__magnusim__add') }, { is_mcp_tool_approval: true })), null);
  });

  it("the older compaction form (a client without session.compaction) is read only from the adapter's fields; a tool call that only looks like it is not one", () => {
    // Exactly as claude-agent-acp 0.89.0 builds it (tool-calls/reporters/compaction.js: started, inProgress, finished).
    const FIELDS = { claudeCode: { toolName: 'compact' } };
    const started = tool({ toolCallId: 'cmp-1', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: FIELDS });
    const going = toolUpd({ toolCallId: 'cmp-1', status: 'in_progress', _meta: FIELDS });
    const done = toolUpd({ toolCallId: 'cmp-1', status: 'completed', rawOutput: { trigger: 'automatic', preTokens: 180000 }, _meta: FIELDS });
    const failed = toolUpd({ toolCallId: 'cmp-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Compaction failed: x' } }], _meta: FIELDS });
    const firstAndLast = tool({ toolCallId: 'cmp-2', title: 'Compact conversation', kind: 'think', status: 'completed', _meta: FIELDS });
    const R = 'tool_name_meta';
    assert.deepEqual(acp.legacyCompaction(started, R), { kind: 'compaction', id: 'cmp-1', status: 'in_progress', error: null });
    assert.equal(acp.legacyCompaction(going, R).status, 'in_progress');
    assert.equal(acp.legacyCompaction(done, R).status, 'completed');
    assert.equal(acp.legacyCompaction(failed, R).status, 'failed');
    assert.equal(acp.legacyCompaction(firstAndLast, R).status, 'completed');
    // The same title, or the same kind, with another tool or no fields: the agent's own tool.
    assert.equal(acp.legacyCompaction(tool({ toolCallId: 'x', title: 'Compact conversation', kind: 'think', status: 'pending' }), R), null);
    assert.equal(acp.legacyCompaction(tool({ toolCallId: 'x', title: 'Compact conversation', kind: 'think', _meta: META('Bash', null) }), R), null);
    assert.equal(acp.legacyCompaction(tool({ toolCallId: 'x', title: 'Compact conversation', kind: 'think', _meta: META('compact') }), R), null, 'a server named: not the adapter’s own');
    assert.equal(acp.legacyCompaction(tool({ toolCallId: 'x', title: 'Compact conversation', kind: 'execute', _meta: FIELDS }), R), null);
    assert.equal(acp.legacyCompaction(tool({ toolCallId: 'x', title: 'mcp.magnusim.compact', kind: 'think', _meta: { is_mcp_tool_call: true, ...FIELDS } }), 'mcp_call_flag'), null, 'only the adapter that sets those fields');
    assert.equal(acp.legacyCompaction(started, null), null);
    // It is not one of Magnusim's tools either (the matcher's answer stays the agent's own).
    assert.equal(new acp.OursMatcher(R, served).tool(started), null);
  });
});

// --------------------------------------------------------------------------------------------
describe('the sign-in command: shown with Copy only when safe to paste', () => {
  const NODE = '/opt/node/bin/node';
  const SCRIPT = '/home/u/.npm-global/lib/node_modules/@x/agent-acp/dist/index.js';
  const ctx = (o = {}) => ({ allowed: true, program: NODE, script: SCRIPT, programName: 'agent-acp', nodePath: NODE, platform: 'linux', ...o });
  const term = (o = {}) => ({ id: 'login', name: 'Log in', description: '', type: 'terminal', args: [], env: [], terminalAuth: null, vars: [], meta: null, ...o });

  it("Magnusim's Node plus the agent's own script shows as the program name", () => {
    const m = term({ terminalAuth: { command: NODE, args: [SCRIPT, '--cli', 'auth', 'login', '--claudeai'], label: 'Login' } });
    const c = acp.terminalSignIn(m, ctx());
    assert.equal(c.line, 'agent-acp --cli auth login --claudeai');
    assert.deepEqual(c.args, ['--cli', 'auth', 'login', '--claudeai']);
  });

  it("the agent's own program (resolved, or its bare name), or the program plus the method's args", () => {
    const own = ctx({ program: '/usr/local/bin/agent', script: null, programName: 'agent' });
    assert.equal(acp.terminalSignIn(term({ terminalAuth: { command: '/usr/local/bin/agent', args: ['auth', 'login'], label: '' } }), own).line, 'agent auth login');
    assert.equal(acp.terminalSignIn(term({ terminalAuth: { command: 'agent', args: ['auth', 'login'], label: '' } }), own).line, 'agent auth login');
    assert.equal(acp.terminalSignIn(term({ args: ['login'] }), own).line, 'agent login');
    const win = { allowed: true, program: 'C:\\Users\\u\\AppData\\Roaming\\npm\\agent.exe', script: null, programName: 'agent', platform: 'win32', nodePath: 'C:\\node\\node.exe' };
    assert.equal(acp.terminalSignIn(term({ terminalAuth: { command: 'c:\\users\\U\\appdata\\roaming\\npm\\AGENT.EXE', args: ['login'], label: '' } }), win).line, 'agent login');
    assert.equal(acp.terminalSignIn(term({ terminalAuth: { command: 'agent.exe', args: ['login'], label: '' } }), win).line, 'agent login');
  });

  it('env is shown as a prefix: PowerShell on Windows, NAME=value elsewhere', () => {
    const m = term({ args: ['login'], env: [{ name: 'AGENT_MODE', value: 'browser' }] });
    assert.equal(acp.terminalSignIn(m, ctx({ script: null, program: '/bin/agent-acp' })).line, 'AGENT_MODE=browser agent-acp login');
    assert.equal(
      acp.terminalSignIn(m, ctx({ script: null, program: 'C:\\x\\agent-acp.exe', platform: 'win32' })).line,
      "$env:AGENT_MODE='browser'; agent-acp login",
    );
    const spaced = ctx({ script: null, program: 'C:\\Program Files\\A\\my agent.exe', programName: 'C:\\Program Files\\A\\my agent.exe', platform: 'win32' });
    assert.equal(acp.terminalSignIn(term({ args: ['login'] }), spaced).line, '& "C:\\Program Files\\A\\my agent.exe" login');
  });

  it('no command and no Copy: unsafe args, a foreign command, too many args, bad env, or an agent not allowed', () => {
    const unsafe = ['a&b', 'a|b', 'a b', 'a;b', '"q"', "'q'", '$(x)', 'x'.repeat(65), ''];
    for (const a of unsafe) {
      assert.equal(acp.terminalSignIn(term({ args: ['login', a] }), ctx({ script: null })), null, JSON.stringify(a));
    }
    const foreign = [
      { command: '/bin/sh', args: ['-c', 'curl'] },
      { command: NODE, args: ['/tmp/other.js', 'login'] },
      { command: NODE, args: ['-e', 'x'] },
      { command: 'powershell', args: ['login'] },
      { command: 'agent-acp-evil', args: ['login'] },
    ];
    for (const t of foreign) assert.equal(acp.terminalSignIn(term({ terminalAuth: { ...t, label: '' } }), ctx()), null, JSON.stringify(t));
    assert.equal(acp.terminalSignIn(term({ args: Array(9).fill('x') }), ctx({ script: null })), null);
    assert.equal(acp.terminalSignIn(term({ args: ['login'], env: [{ name: 'lower', value: 'x' }] }), ctx({ script: null })), null);
    assert.equal(acp.terminalSignIn(term({ args: ['login'], env: [{ name: 'X', value: 'a b' }] }), ctx({ script: null })), null);
    assert.equal(acp.terminalSignIn(term({ args: ['login'] }), ctx({ allowed: false, script: null })), null, 'not allowed: never a command');
    assert.equal(acp.terminalSignIn(term({ args: ['login'] }), ctx({ script: null, programName: 'agent;rm' })), null);
    assert.equal(acp.terminalSignIn({ ...term(), type: 'agent' }, ctx()), null);
  });
});

// --------------------------------------------------------------------------------------------
describe('the scripted fake agent', LIMIT, () => {
  // A stand-in for the MCP bridge: the legacy initialize, a tool list and canned results.
  const MCP_STANDIN = join(ROOT, 'mcp-standin.mjs');
  writeFileSync(
    MCP_STANDIN,
    [
      "let buf='';process.stdin.setEncoding('utf8');",
      "const out=(o)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...o})+'\\n');",
      "process.stdin.on('data',(d)=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);",
      "if(m.method==='initialize')out({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stand-in',version:'1'},instructions:'rule 1'}});",
      "else if(m.method==='tools/list')out({id:m.id,result:{tools:[{name:'app_status',inputSchema:{type:'object'}},{name:'add',inputSchema:{type:'object'}}]}});",
      "else if(m.method==='tools/call'){out({method:'notifications/progress',params:{progressToken:m.params._meta.progressToken,progress:1}});out({id:m.id,result:{content:[{type:'text',text:JSON.stringify({tool:m.params.name,args:m.params.arguments})}]}});}",
      "else if(m.id!=null)out({id:m.id,error:{code:-32601,message:'no'}});}});",
      "process.stdin.on('end',()=>process.exit(0));",
    ].join('\n'),
  );
  const BRIDGE = { command: process.execPath, script: MCP_STANDIN, binding: 'b-000000000000000000000001', info: join(ROOT, 'home', 'assistant', 'mcp.json') };

  /**
   * Starts the fake with a client of ours on rpc.ts that answers permissions as `answer` says
   * (an option id or null), or, when `answer` returns undefined, leaves the reply to the test.
   */
  async function runFake(fake, answer = () => null, o = {}) {
    const argv = o.argv ?? fake.argv;
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(o.env ? { env: o.env } : {}) });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr += d));
    const updates = [];
    const permissions = [];
    const peer = new rpc.RpcPeer({
      input: child.stdout,
      output: child.stdin,
      exited,
      onRequest: (method, params, id) => {
        if (method !== 'session/request_permission') return false;
        const view = acp.permission(params);
        permissions.push({ ...view, rpcId: id });
        const pick = answer(view, id);
        if (pick !== undefined) peer.reply(id, acp.permissionReply(pick));
        return true;
      },
      onNotification: (method, params) => {
        if (method === 'session/update') updates.push(params);
      },
    });
    const stop = async () => {
      child.stdin.end();
      const t = setTimeout(() => child.kill(), 10_000);
      await exited;
      clearTimeout(t);
    };
    cleanups.push(stop);
    return { child, peer, updates, permissions, exited, stop, stderr: () => stderr };
  }

  async function newSession(peer, agent = {}) {
    const init = await peer.request('initialize', acp.initializeParams('0.3.0'));
    const s = await peer.request('session/new', acp.sessionNewParams(ROOT, BRIDGE, agent));
    return { init, s, sessionId: acp.sessionIdOf(s) };
  }

  /** Every message the fake sent, checked against the schema by method. */
  function validateFakeTraffic(fake) {
    const fromClient = new Map(fake.received().filter((m) => m.method && m.id !== undefined).map((m) => [m.id, m.method]));
    const fromFake = new Map(fake.sent().filter((m) => m.method && m.id !== undefined).map((m) => [m.id, m.method]));
    const RESULT = {
      initialize: 'InitializeResponse',
      authenticate: 'AuthenticateResponse',
      'session/new': 'NewSessionResponse',
      'session/prompt': 'PromptResponse',
      'session/set_mode': 'SetSessionModeResponse',
      'session/set_config_option': 'SetSessionConfigOptionResponse',
    };
    const REQUEST = { 'session/request_permission': 'RequestPermissionRequest', 'fs/read_text_file': 'ReadTextFileRequest' };
    let checked = 0;
    for (const m of fake.sent()) {
      if (m.method === 'session/update') conforms('SessionNotification', m.params);
      else if (m.method && m.id !== undefined) conforms(REQUEST[m.method], m.params);
      else if (m.result !== undefined) {
        const method = fromClient.get(m.id);
        // The unstable `error` stop reason isn't in v1's PromptResponse.
        if (method === 'session/prompt' && m.result.stopReason === 'error') continue;
        conforms(RESULT[method], m.result);
      } else continue;
      checked += 1;
    }
    for (const m of fake.received()) {
      if (m.method === 'initialize') conforms('InitializeRequest', m.params);
      else if (m.method === 'session/new') conforms('NewSessionRequest', m.params);
      else if (m.method === 'session/prompt') conforms('PromptRequest', m.params);
      else if (m.method === 'session/cancel') conforms('CancelNotification', m.params);
      else if (m.method === 'session/set_mode') conforms('SetSessionModeRequest', m.params);
      else if (m.method === 'session/set_config_option') conforms('SetSessionConfigOptionRequest', m.params);
      else if (m.result !== undefined && fromFake.get(m.id) === 'session/request_permission') conforms('RequestPermissionResponse', m.result);
      else continue;
      checked += 1;
    }
    return checked;
  }

  it('imports nothing but node: modules, and the controller neither', () => {
    for (const f of [FAKE_ACP_AGENT, join(FAKE_ACP_AGENT, '..', 'fake-acp.mjs')]) {
      const src = readFileSync(f, 'utf8');
      const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      assert.ok(specs.length > 0);
      assert.deepEqual(
        specs.filter((s) => !s.startsWith('node:') && s !== './fake-acp-agent.mjs'),
        [],
        f,
      );
    }
  });

  it('a whole session in each adapter style: every message conforms; our client refuses fs/read_text_file with -32601', async () => {
    for (const style of ['tool_name_meta', 'mcp_call_flag', 'none']) {
      const fake = await startFakeAcp({ style, authMethods: [{ type: 'terminal', id: 'login', name: 'Log in', args: ['login'], env: { FAKE_MODE: 'x' }, _meta: { 'terminal-auth': { command: process.execPath, args: [FAKE_ACP_AGENT, 'login'], label: 'Login' } } }, { id: 'browser', name: 'Browser' }] });
      cleanups.push(() => fake.stop());
      const f = await runFake(fake, (v) => acp.pickOption(v.options, acp.ALLOW_KINDS));
      const { init, s, sessionId } = await newSession(f.peer);
      assert.equal(acp.protocolVersionOf(init), 1);
      for (const m of acp.authMethods(init)) assert.ok(['terminal', 'agent'].includes(m.type), 'the fake offers only the two v1 types');
      assert.ok(acp.modes(s) && acp.configOptions(s).length === 2);
      const tools = await fake.waitFor((r) => r.event === 'mcp_tools');
      assert.deepEqual(tools.tools, ['app_status', 'add']);
      const fs = await fake.waitFor((r) => r.event === 'fs_answer');
      assert.equal(fs.answer.error.code, -32601);
      assert.equal(fs.answer.error.message, 'Magnusim does not serve fs/read_text_file');
      await f.peer.request('session/set_mode', acp.setModeParams(sessionId, 'default'));
      await f.peer.request('session/set_config_option', acp.setConfigOptionParams(sessionId, 'model', 'fake-small'));
      fake.script(
        { say: 'Hello' },
        { think: 'pondering' },
        { plan: ['look', { content: 'add', status: 'in_progress', priority: 'high' }] },
        { call: { tool: 'add', args: { n: 2 } } },
        { askOurs: { tool: 'app_status' } },
        { askOwn: { title: 'magnusim_app_status', kind: 'execute', rawInput: { command: 'ls' } } },
        { ownTool: { id: 'own-x', title: 'Read file', kind: 'read', status: 'in_progress' } },
        { ownTool: { id: 'own-x', title: 'Read file', status: 'completed' } },
        { switchMode: 'plan' },
      );
      const r = await f.peer.request('session/prompt', acp.promptParams(sessionId, [acp.noteBlock(), { type: 'text', text: 'go' }]));
      assert.equal(acp.stopReasonOf(r), 'end_turn');
      const result = fake.events('mcp_result')[0];
      assert.equal(JSON.parse(result.result.content[0].text).args.n, 2);

      // The fake's shapes are the ones the matcher reads: ours by fields, its own tool never.
      const matcher = new acp.OursMatcher(style === 'none' ? null : style, (n) => ['app_status', 'add'].includes(n));
      const toolNames = f.updates.map((p) => acp.update(p.update)).filter((u) => u?.kind === 'tool').map((u) => matcher.tool(u));
      const permNames = f.permissions.map((p) => matcher.permission(p));
      if (style === 'none') {
        assert.ok(toolNames.every((n) => n === null) && permNames.every((n) => n === null));
      } else {
        assert.ok(toolNames.includes('add'), style);
        assert.deepEqual(permNames, ['app_status', null], style);
      }
      const kinds = f.updates.map((p) => acp.update(p.update)?.kind);
      for (const k of ['text', 'thought', 'plan', 'tool', 'mode']) assert.ok(kinds.includes(k), `${style}: ${k}`);
      assert.ok(validateFakeTraffic(fake) > 10);
      await f.stop();
      assert.equal((await f.exited).code, 0, 'a polite agent ends at the end of its input');
    }
  });

  it('cancel: permissions answered cancelled come before session/cancel, and the prompt ends cancelled', async () => {
    const fake = await startFakeAcp({ style: 'tool_name_meta' });
    cleanups.push(() => fake.stop());
    let release;
    const answered = new Promise((r) => (release = r));
    // Answer the permission ourselves, in order: cancelled, then session/cancel.
    const f = await runFake(fake, (_view, id) => {
      release(id);
      return undefined;
    });
    const { sessionId } = await newSession(f.peer);
    fake.script({ askOwn: { title: 'rm -rf build', kind: 'execute' } }, { hold: 'forever' }, { say: 'never' });
    const prompt = f.peer.request('session/prompt', acp.promptParams(sessionId, [{ type: 'text', text: 'go' }]));
    const id = await answered;
    f.peer.reply(id, acp.permissionReply(null));
    f.peer.notify('session/cancel', acp.cancelParams(sessionId));
    assert.equal(acp.stopReasonOf(await prompt), 'cancelled');
    const order = fake.received().filter((m) => (m.result && m.id === id) || m.method === 'session/cancel');
    assert.deepEqual(
      order.map((m) => m.method ?? 'permission reply'),
      ['permission reply', 'session/cancel'],
    );
    assert.deepEqual(order[0].result, { outcome: { outcome: 'cancelled' } });
    assert.ok(!fake.sent().some((m) => m.params?.update?.content?.text === 'never'));
    validateFakeTraffic(fake);
  });

  it('hold, sign-in (-32000 until the marker), the error stop, an error answer and a crash with last words', async () => {
    const fake = await startFakeAcp({ requireSignIn: true, authMethods: [{ id: 'browser', name: 'Browser' }] });
    cleanups.push(() => fake.stop());
    const f = await runFake(fake);
    await f.peer.request('initialize', acp.initializeParams('0.3.0'));
    const refused = await f.peer.request('session/new', acp.sessionNewParams(ROOT, BRIDGE)).then(() => null, (e) => e);
    assert.ok(refused instanceof rpc.RpcError && refused.authRequired);
    await f.peer.request('authenticate', acp.authenticateParams('browser'));
    const s = await f.peer.request('session/new', acp.sessionNewParams(ROOT, BRIDGE));
    const sessionId = acp.sessionIdOf(s);
    fake.script({ hold: 'h1' }, { say: 'after the hold' });
    const held = f.peer.request('session/prompt', acp.promptParams(sessionId, [{ type: 'text', text: 'a' }]));
    await fake.waitFor((r) => r.event === 'holding' && r.name === 'h1');
    let done = false;
    held.then(() => (done = true));
    await flush();
    assert.equal(done, false, 'still held');
    fake.release('h1');
    assert.equal(acp.stopReasonOf(await held), 'end_turn');
    fake.script({ stop: 'error' });
    assert.equal(acp.stopReasonOf(await f.peer.request('session/prompt', acp.promptParams(sessionId, []))), 'error');
    fake.script({ error: { code: -32000, message: 'Authentication required' } });
    const e = await f.peer.request('session/prompt', acp.promptParams(sessionId, [])).then(() => null, (x) => x);
    assert.ok(e.authRequired);
    validateFakeTraffic(fake);
    fake.script({ crash: 'the agent fell over' });
    const crashed = await f.peer.request('session/prompt', acp.promptParams(sessionId, [])).then(() => null, (x) => x);
    assert.ok(crashed instanceof rpc.RpcExited);
    assert.equal((await f.exited).code, 1);
    assert.match(f.stderr(), /the agent fell over/);
  });

  it('ignoreCancel keeps a prompt going after session/cancel; exitDuringCall ends the agent once its call is under way', async () => {
    const fake = await startFakeAcp({ style: 'mcp_call_flag' });
    cleanups.push(() => fake.stop());
    const f = await runFake(fake);
    const { sessionId } = await newSession(f.peer);
    fake.script('ignoreCancel', { hold: 'stubborn' }, { say: 'still here' });
    const p = f.peer.request('session/prompt', acp.promptParams(sessionId, [{ type: 'text', text: 'a' }]));
    await fake.waitFor((r) => r.event === 'holding' && r.name === 'stubborn');
    f.peer.notify('session/cancel', acp.cancelParams(sessionId));
    await fake.waitFor((r) => r.dir === 'in' && r.msg.method === 'session/cancel');
    fake.release('stubborn');
    assert.equal(acp.stopReasonOf(await p), 'end_turn', 'the cancel did not end it');
    assert.ok(f.updates.some((u) => u.update.content?.text === 'still here'));

    fake.script('exitDuringCall', { call: { tool: 'add', args: { n: 1 } } }, { say: 'never' });
    const e = await f.peer.request('session/prompt', acp.promptParams(sessionId, [])).then(() => null, (x) => x);
    assert.ok(e instanceof rpc.RpcExited);
    assert.equal((await f.exited).code, 1);
    assert.match(f.stderr(), /exiting during a call/);
    assert.ok(fake.received().some((m) => m.method === 'session/prompt'));
    assert.ok(!fake.sent().some((m) => m.params?.update?.content?.text === 'never'));
    assert.equal(fake.events('mcp_result').length, 0, 'it never reported the call done');
    // Its MCP server ended with it (its input closed), within a ceiling.
    const [mcp] = fake.pids('mcp');
    const end = Date.now() + 10_000;
    const running = () => {
      try {
        process.kill(mcp.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (running() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(running(), false);
  });

  it('a stdio server with a type key is dropped by the tool-name style, as that adapter does', async () => {
    const fake = await startFakeAcp({ style: 'tool_name_meta' });
    cleanups.push(() => fake.stop());
    const f = await runFake(fake);
    await f.peer.request('initialize', acp.initializeParams('0.3.0'));
    const params = acp.sessionNewParams(ROOT, BRIDGE);
    params.mcpServers[0] = { type: 'stdio', ...params.mcpServers[0] };
    await f.peer.request('session/new', params);
    const skipped = await fake.waitFor((r) => r.event === 'mcp_skipped' || r.event === 'mcp_tools');
    assert.equal(skipped.event, 'mcp_skipped');
  });

  it("starts as agent discovery starts a package's bin: a launcher, no --control, none of Magnusim's variables", async () => {
    const fake = await startFakeAcp({ style: 'tool_name_meta' });
    cleanups.push(() => fake.stop());
    const pkg = join(ROOT, 'prefix', 'node_modules', '@x', 'agent-acp');
    const bin = fake.writeLauncher(join(pkg, 'dist', 'index.js'), { version: '9.8.7' });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@x/agent-acp', version: '9.8.7', bin: { 'agent-acp': 'dist/index.js' } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^MAGNUSIM_/i.test(k)));
    // The version probe: stdin ignored, no controller needed.
    const probe = spawn(process.execPath, [bin, '--version'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let version = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (d) => (version += d));
    assert.equal(await new Promise((r) => probe.on('close', r)), 0);
    assert.match(version, /^fake-acp-agent 9\.8\.7\b/);
    // A session, driven by this controller.
    const f = await runFake(fake, () => null, { argv: [process.execPath, bin], env });
    const { init, sessionId } = await newSession(f.peer);
    assert.equal(acp.protocolVersionOf(init), 1);
    fake.script({ say: 'through the launcher' });
    assert.equal(acp.stopReasonOf(await f.peer.request('session/prompt', acp.promptParams(sessionId, [{ type: 'text', text: 'go' }]))), 'end_turn');
    assert.ok(fake.pids('agent').some((p) => p.pid === f.child.pid), 'the launcher is the agent process itself');
    assert.ok(fake.received(f.child.pid).some((m) => m.method === 'initialize'));
    await f.stop();
    assert.equal((await f.exited).code, 0);
  });
});
