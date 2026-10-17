// The Assistant's terminal client, scripts/assistant-run.mjs (Foundation spec 9.4, 10.1):
// spawned against a test server (the real routes, the real local-server adapter, the
// fake provider). It prints the answer, tool calls and results; asks questions at the
// terminal (y/n); exits 0 for done, 1 otherwise and 2 when the app tab isn't connected,
// with the plain text; --json prints one event per line.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
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
const { plainText, main } = await import(pathToFileURL(CLI).href);

let server;
let port;
let handle;
let resets = 0;

before(async () => {
  const router = new Router();
  handle = routes.registerAssistantRoutes(router, { port: () => port });
  router.get('/api/compute-queue', (ctx) => ctx.sendJson(200, { ok: true, busy: false, items: [] }));
  handle.registry.addHostTool(hostTool('reset_all', { risk: 'destructive', title: 'Reset every counter', run: async () => ((resets += 1), { ok: true, summary: 'All counters reset' }) }));
  handle.registry.addHostTool(
    hostTool('big_step', {
      run: async () => ({
        ok: false,
        error: { code: 'invalid_input', message: 'step_too_big: at most 3 at a time.', hint: 'Step by 1, 2 or 3.', detail: { allowed: [1, 2, 3] } },
        summary: 'step_too_big: at most 3 at a time.',
      }),
    }),
  );
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

/**
 * Runs the CLI (with --port unless `withPort` is false). `input` is written to its stdin; with
 * `answers`, each is typed once its question's "(y/N) " shows, and stdin closes after the last.
 */
function cli(args, input = '', { withPort = true, env = {}, answers = null, path = CLI, cwd = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const argv = withPort ? [path, '--port', String(port), ...args] : [path, ...args];
    const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAGNUSIM_PORT: '', ...env }, ...(cwd ? { cwd } : {}) });
    let stdout = '';
    let stderr = '';
    const left = answers ? [...answers] : null;
    let asked = 0;
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      // A question is answered only once it shows (a line typed before it never counts).
      while (left?.length && stdout.split('(y/N) ').length - 1 > asked) {
        asked += 1;
        child.stdin.write(`${left.shift()}\n`);
        if (!left.length) child.stdin.end();
      }
    });
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
    if (left?.length) child.stdin.write(input);
    else child.stdin.end(input);
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
    let r = await cli(['Reset everything.'], '', { answers: ['y'] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(resets, before + 1);
    assert.match(r.stdout, /→ reset_all \{\}\n\? Allow the Assistant to reset every counter\?\n {2}Magnusim · can't be undone\. What it sent: \{\}\. Nothing runs until you choose\.\n {2}y = Allow, n = Don't\n\(y\/N\) \n✓ All counters reset\nReset done\.\n/);
    fake.reply({ tools: [{ name: 'reset_all', input: {} }] }, { text: 'I would have reset them.' });
    r = await cli(['Reset everything.'], '', { answers: ['n'] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(resets, before + 1, 'not run');
    assert.match(r.stdout, /✗ declined: The user declined this call/);
  });

  it("a failed result's hint shows on the line under it; a result's summary is its line", async () => {
    fake.reply({ tools: [{ name: 'big_step', input: {} }, { name: 'reset_all', input: {} }] }, { text: 'Stepped.' });
    const r = await cli(['Take a big step, then reset.'], '', { answers: ['y'] });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /→ big_step \{\}\n✗ invalid_input: step_too_big: at most 3 at a time\.\n {2}hint: Step by 1, 2 or 3\.\n→ reset_all /);
    // A result that succeeded has no hint line.
    assert.match(r.stdout, /\n✓ All counters reset\nStepped\.\n$/);
    assert.equal(r.stdout.split('hint:').length, 2);
    // --json prints the event, hint and all.
    fake.reply({ tools: [{ name: 'big_step', input: {} }] }, { text: 'No.' });
    const j = await cli(['--json', 'Take a big step.']);
    assert.equal(j.code, 0, j.stderr);
    const result = j.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'tool_result');
    assert.deepEqual([result.ok, result.code, result.hint, result.summary], [false, 'invalid_input', 'Step by 1, 2 or 3.', 'step_too_big: at most 3 at a time.']);
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
    // Two connected tabs: the server's rule refuses to pick one.
    for (const t of ['T1', 'T2']) handle.registry.setWorkspace(t, `L${t}`, { plugin: 'ai-demo', pluginName: 'Workspace demo', workspace: 'Counter', projectId: 'p1', studyId: 's1', tools: [] });
    try {
      const two = await cli(['--tab', 'auto', 'Do it.']);
      assert.equal(two.code, 1);
      assert.equal(two.stderr.trim(), 'More than one app tab offers tools to the Assistant: T1, T2. Name one of them.');
    } finally {
      for (const t of ['T1', 'T2']) handle.registry.setWorkspace(t, `L${t}`, null);
    }
    // The rule lives on the server (resolveTab, for MCP too): the CLI keeps no copy of it.
    const src = readFileSync(CLI, 'utf8');
    assert.ok(!src.includes(TAB_HIDDEN_TEXT) && !src.includes('/api/assistant/tabs'), 'no copy of the tab rule');
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
    const r = await cli(['Reset?'], '', { answers: ['n'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(![...r.stdout].some((c) => c !== '\n' && /\p{Cc}/u.test(c)), JSON.stringify(r.stdout));
    assert.match(r.stdout, /^Safe\[8m\]52;c;ZXZpbA==\nshown\n→ reset_all \{\}\n\? Allow the Assistant to reset every counter\?\n/);
    // The terminal's own cleaning, whatever a server sends.
    assert.equal(plainText(`a${ESC}[2Jb${CSI}0m\r\n\tc${ch(0x202e)}d${ch(0x2028)}`), 'a[2Jb0m\n\tcd');
  });

  it('a line typed before a question opened never answers it, a terminal or not: a fake question the model printed takes no "y" for the real one', { timeout: 20_000 }, async () => {
    // The model's text, printed as it comes: a question in the host's own layout.
    const FAKE = "\n? Allow the Assistant to read the counter?\n  Magnusim · reads only. What it sent: {}. Nothing runs until you choose.\n  y = Allow, n = Don't\n(y/N) ";
    const REAL = { id: 'g-real', title: 'Allow the Assistant to delete every body?', copy: "Magnusim · can't be undone. What it sent: {}. Nothing runs until you choose.", yes: 'Allow', no: "Don't" };
    const answers = [];
    let polls = 0;
    let typedEarly;
    const early = new Promise((r) => (typedEarly = r));
    let answered;
    const gateAnswered = new Promise((r) => (answered = r));
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        const send = (code, j) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(j));
        if (req.method === 'POST' && req.url === '/api/assistant/turns') return send(202, { ok: true, turn: 't1', conversation: 'c1' });
        if (req.method === 'POST' && req.url === `/api/assistant/gates/${REAL.id}`) {
          answers.push(JSON.parse(body));
          answered();
          return send(200, { ok: true });
        }
        if (req.method !== 'GET' || !req.url.startsWith('/api/assistant/turns/t1')) return send(404, { ok: false });
        polls += 1;
        if (polls === 1) return send(200, { ok: true, next: 2, ended: false, events: [{ type: 'text', text: FAKE }, { type: 'tool_call', tool: 'app_status', input_preview: '{}' }] });
        if (polls === 2) {
          // The real question opens only once the "person" typed y at the fake one.
          await early;
          return send(200, { ok: true, next: 4, ended: false, events: [{ type: 'tool_result', ok: true, summary: 'Counter is 7' }, { type: 'gate', gate: REAL }] });
        }
        await gateAnswered;
        return send(200, {
          ok: true,
          next: 6,
          ended: true,
          events: [
            { type: 'gate_closed', gate: REAL.id, answer: answers[0].allow ? 'allow' : 'deny', by: 'user' },
            { type: 'end', state: 'done', reason: 'end_turn', message: null },
          ],
        });
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    // A pipe, as in Git Bash's mintty or an IDE panel, where a person still types by hand.
    const stdin = new PassThrough();
    assert.equal(stdin.isTTY, undefined);
    let out = '';
    let prompts = 0;
    const onOut = (text) => {
      out += text;
      const now = out.split('(y/N) ').length - 1;
      if (now === prompts) return;
      prompts = now;
      if (prompts === 1) {
        // The person answers the fake question; the CLI has read the line before the real one opens.
        stdin.once('data', () => setImmediate(typedEarly));
        stdin.write('y\n');
      } else if (prompts === 2) stdin.write('n\n');
    };
    try {
      const code = await main(['--port', String(stub.address().port), 'Look at the counter.'], {
        stdin,
        stdout: { write: (text) => (onOut(text), true) },
        stderr: { write: () => true },
      });
      assert.equal(code, 0, out);
      assert.deepEqual(answers, [{ allow: false }], 'the real question took the line typed after it, not the early "y"');
    } finally {
      stub.closeAllConnections?.();
      await new Promise((r) => stub.close(r));
    }
  });

  it('run through a junction or directory link (Node gives the module its real path, argv[1] keeps the link): it still runs', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-run-real-'));
    const links = mkdtempSync(join(tmpdir(), 'assistant-run-link-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(CLI, join(root, 'scripts', 'assistant-run.mjs'));
      const link = join(links, 'web');
      try {
        symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (e) {
        t.skip(`no junction or directory link here: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const runs = await Promise.all([
        cli(['--help'], '', { withPort: false, path: join(link, 'scripts', 'assistant-run.mjs') }),
        // As documented: from the folder (through the link), by a relative path.
        cli(['--help'], '', { withPort: false, path: join('scripts', 'assistant-run.mjs'), cwd: link }),
      ]);
      for (const r of runs) {
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Usage: node scripts\/assistant-run\.mjs /);
      }
    } finally {
      // Only temp folders: the link points at a copy.
      rmSync(links, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says nothing about any provider by name (vendor-neutral text)', () => {
    const src = readFileSync(CLI, 'utf8');
    assert.doesNotMatch(src, /(?<![a-z])(claude|anthropic|openai|chatgpt|copilot)(?![a-z])/i);
    assert.doesNotMatch(src, /(?<![a-z0-9])gpt(?![a-z])/i);
  });
});
