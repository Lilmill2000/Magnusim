// The Assistant's terminal client, scripts/assistant-run.mjs (Foundation spec 9.4, 10.1):
// spawned against a test server (the real routes, the real local-server adapter, the
// fake provider). It prints the answer, tool calls and results; asks questions at the
// terminal (y/n); exits 0 for done, 1 otherwise and 2 when the app tab isn't connected,
// with the plain text; --json prints one event per line.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-cli-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(WEB, 'scripts', 'assistant-run.mjs');
const { startFakeLlm } = await import('../../../e2e/support/fake-llm.mjs');
const fake = await startFakeLlm();
const { Router, dispatch } = await import('../router.ts');
const { assertSameOrigin, sendJson } = await import('../http.ts');
const { assistantGuard } = await import('../assistant/access.ts');
const routes = await import('../assistant-routes.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const { TAB_HIDDEN_TEXT } = await import('../assistant/turns.ts');
const { hostTool } = await import('./assistant-harness.js');
const { plainText } = await import(pathToFileURL(CLI).href);

let server;
let port;
let handle;
let resets = 0;

before(async () => {
  const router = new Router();
  handle = routes.registerAssistantRoutes(router, { port: () => port });
  router.get('/api/compute-queue', (ctx) => ctx.sendJson(200, { ok: true, busy: false, items: [] }));
  handle.registry.addHostTool(hostTool('reset_all', { risk: 'destructive', title: 'Reset every counter', run: async () => ((resets += 1), { ok: true, summary: 'All counters reset' }) }));
  server = http.createServer(async (req, res) => {
    assertSameOrigin(req);
    if (assistantGuard(req, res)) return;
    if (!(await dispatch(router, req, res))) sendJson(res, 404, { error: 'route not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/assistant/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai_compatible', base_url: fake.compatBase, model: 'qwen3.8-27b' }),
  });
  assert.equal(r.status, 200);
});

after(async () => {
  handle?.shutdown();
  await fake.stop();
  await new Promise((r) => server.close(r));
  resetAssistantState();
  rmSync(ROOT, { recursive: true, force: true });
});

/** Runs the CLI (with --port unless `withPort` is false); `input` is written to its stdin, which then closes. */
function cli(args, input = '', { withPort = true, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const argv = withPort ? [CLI, '--port', String(port), ...args] : [CLI, ...args];
    const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAGNUSIM_PORT: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the CLI did not finish: ${stdout}\n${stderr}`));
    }, 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe('assistant-run.mjs', () => {
  it('prints the answer, each tool call (→) and its result (✓); exit 0; the conversation id on stderr', async () => {
    fake.reply({ text: 'Checking.', tools: [{ name: 'app_status', input: {} }] }, { text: 'All good.' });
    const r = await cli(['How is the app?']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Checking\.\n→ app_status \{\}\n✓ Magnusim .*, compute idle, 0 queued\nAll good\.\n$/);
    assert.match(r.stderr, /\(conversation c-[0-9a-z]+-[0-9a-f]+; continue it with --conversation c-/);
  });

  it('a question asked at the terminal: y allows (the tool runs), n declines (it does not); both turns end done', async () => {
    const before = resets;
    fake.reply({ tools: [{ name: 'reset_all', input: {} }] }, { text: 'Reset done.' });
    let r = await cli(['Reset everything.'], 'y\n');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(resets, before + 1);
    assert.match(r.stdout, /→ reset_all \{\}\n\? Allow the Assistant to reset every counter\?\n {2}Magnusim · can't be undone\. What it sent: \{\}\. Nothing runs until you choose\.\n {2}y = Allow, n = Don't\n\(y\/N\) \n✓ All counters reset\nReset done\.\n/);
    fake.reply({ tools: [{ name: 'reset_all', input: {} }] }, { text: 'I would have reset them.' });
    r = await cli(['Reset everything.'], 'n\n');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(resets, before + 1, 'not run');
    assert.match(r.stdout, /✗ declined: The user declined this call/);
  });

  it('a turn that fails exits 1 with its message; a turn refused before it starts exits 1 with the reason', async () => {
    fake.failNext({ status: 500, body: { error: { message: 'boom', type: 'server_error' } }, dialect: 'compat' });
    let r = await cli(['Fail please.']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /\[failed\] /);
    r = await cli(['x', '--conversation', 'c-gone-0000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /That conversation has ended/);
  });

  it('a tab that is not connected: exit 2 with the plain text, by id and with --tab auto', async () => {
    handle.registry.setWorkspace('T1', 'L1', { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: [] });
    handle.registry.setConnected('T1', 'L1', false);
    try {
      let r = await cli(['--tab', 'T1', 'Do it.']);
      assert.equal(r.code, 2);
      assert.equal(r.stderr.trim(), TAB_HIDDEN_TEXT);
      r = await cli(['--tab', 'auto', 'Do it.']);
      assert.equal(r.code, 2);
      assert.equal(r.stderr.trim(), TAB_HIDDEN_TEXT);
    } finally {
      handle.registry.setWorkspace('T1', 'L1', null);
    }
    const none = await cli(['--tab', 'auto', 'Do it.']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No app tab offers tools/);
  });

  it('--json prints one event per line; --help names the hold; bad options exit 1', async () => {
    fake.reply({ text: 'Fine.' });
    const r = await cli(['--json', 'Hello']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'started');
    assert.ok(lines.some((e) => e.type === 'text' && e.text === 'Fine.'));
    assert.deepEqual(lines.at(-1).type, 'end');
    assert.equal(lines.at(-1).state, 'done');
    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Keep the Magnusim window visible when you start a turn\. It may then be covered for up to 10 minutes between turns\./);
    assert.equal((await cli(['--nope', 'x'])).code, 1);
    assert.equal((await cli([])).code, 1);
  });

  it('without --port it dials the port the app listens on: the saved one before MAGNUSIM_PORT, as the app picks it', async () => {
    const prefs = process.env.MAGNUSIM_LOCAL_JSON;
    const before = existsSync(prefs) ? readFileSync(prefs, 'utf8') : null;
    // A port nothing listens on, for the environment.
    const spare = http.createServer();
    await new Promise((r) => spare.listen(0, '127.0.0.1', r));
    const dead = spare.address().port;
    await new Promise((r) => spare.close(r));
    writeFileSync(prefs, JSON.stringify({ ...(before ? JSON.parse(before) : {}), port }));
    try {
      fake.reply({ text: 'Port found.' });
      const r = await cli(['Hello'], '', { withPort: false, env: { MAGNUSIM_PORT: String(dead) } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'Port found.\n');
    } finally {
      if (before === null) rmSync(prefs, { force: true });
      else writeFileSync(prefs, before);
    }
  });

  it('model text prints with no terminal controls: nothing can hide or fake the question after it', async () => {
    const ch = (n) => String.fromCharCode(n);
    const [ESC, BEL, CSI] = [ch(0x1b), ch(0x07), ch(0x9b)];
    fake.reply({ text: `Safe${ESC}[8m${ESC}]52;c;ZXZpbA==${BEL}\r\nshown`, tools: [{ name: 'reset_all', input: {} }] }, { text: 'Not reset.' });
    const r = await cli(['Reset?'], 'n\n');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(![...r.stdout].some((c) => c !== '\n' && /\p{Cc}/u.test(c)), JSON.stringify(r.stdout));
    assert.match(r.stdout, /^Safe\[8m\]52;c;ZXZpbA==\nshown\n→ reset_all \{\}\n\? Allow the Assistant to reset every counter\?\n/);
    // The terminal's own cleaning, whatever a server sends.
    assert.equal(plainText(`a${ESC}[2Jb${CSI}0m\r\n\tc${ch(0x202e)}d${ch(0x2028)}`), 'a[2Jb0m\n\tcd');
  });

  it('says nothing about any provider by name (vendor-neutral text)', () => {
    const src = readFileSync(CLI, 'utf8');
    assert.doesNotMatch(src, /(?<![a-z])(claude|anthropic|openai|chatgpt|copilot)(?![a-z])/i);
    assert.doesNotMatch(src, /(?<![a-z0-9])gpt(?![a-z])/i);
  });
});
