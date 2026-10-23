// The Assistant's terminal client, scripts/assistant-run.mjs (Foundation spec 9.4, 10.1):
// spawned against a test server (the real routes, the real local-server adapter, the
// fake provider). It prints the answer, tool calls and results; asks questions at the
// terminal (y/n); exits 0 for done, 1 otherwise and 2 when the app tab isn't connected,
// with the plain text; --json prints one event per line. A turn on a coding agent (--agent,
// --provider agent:<id>) sends the launch token from the connection file, only to an app that
// proved it holds it (POST /api/assistant/launch/check), reads it again once after a
// launch_proof refusal, and prints the agent lines and who pays.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  // One project the tab tests bind to (the app's project list is not served here).
  handle = routes.registerAssistantRoutes(router, {
    port: () => port,
    turns: { projects: async (id) => (id === 'p1' ? { id: 'p1', title: 'Counter project', created_at: '2026-10-01T10:00:00Z' } : null) },
  });
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
  // The local server says its model's context, so no turn notes an unknown one.
  fake.models([{ id: 'qwen3.8-27b', context: 32_768, type: 'vlm' }], 'compat');
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
    assert.match(none.stderr, /No Magnusim window is connected to the Assistant/);
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

  it('--image sends the picture with the prompt (checked by the app); a review round prints "review: round i of n"', async () => {
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const dir = mkdtempSync(join(ROOT, 'pics-'));
    const pic = join(dir, 'chip.png');
    writeFileSync(pic, Buffer.from(PNG_1x1, 'base64'));
    const none = { type: 'object', properties: {}, additionalProperties: false };
    handle.registry.setWorkspace('T1', 'L1', {
      plugin: 'ai-demo',
      pluginName: 'Workspace demo',
      workspace: 'Counter',
      projectId: 'p1',
      studyId: 's1',
      tools: [{ name: 'add', title: 'Add', description: 'Adds one.', inputSchema: none, risk: 'edit' }],
      review: { rounds: 2, prompt: 'Check the counter.' },
      invoke: async () => ({ ok: true, data: { n: 1 }, summary: 'Added 1' }),
    });
    try {
      fake.reply({ tools: [{ name: 'ai-demo__add', input: {} }] }, { text: 'Added.' }, { text: 'Review: no changes' });
      const before = fake.requests().filter((x) => x.kind === 'chat').length;
      const r = await cli(['--tab', 'T1', '--image', pic, 'Make it like this.']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /→ ai-demo__add \{\}\n✓ Added 1\nAdded\.\nreview: round 1 of 2\nReview: no changes\n$/);
      const sent = fake.requests().filter((x) => x.kind === 'chat').slice(before);
      assert.equal(sent.length, 3);
      for (const x of sent) assert.deepEqual(x.userImages, [{ media_type: 'image/png', data: PNG_1x1 }]);
    } finally {
      handle.registry.setWorkspace('T1', 'L1', null);
    }
    // The file's kind, and how many: refused here; what it holds: refused by the app.
    const gif = join(dir, 'chip.gif');
    writeFileSync(gif, 'GIF89a');
    let r = await cli(['--image', gif, 'x']);
    assert.deepEqual([r.code, r.stderr.trim()], [1, `${gif}: --image takes a .png, .jpg, .jpeg or .webp file.`]);
    r = await cli(['--image', pic, '--image', pic, '--image', pic, '--image', pic, '--image', pic, 'x']);
    assert.deepEqual([r.code, r.stderr.trim()], [1, 'At most 4 --image files go with a request.']);
    const fakePng = join(dir, 'text.png');
    writeFileSync(fakePng, 'not a picture');
    r = await cli(['--image', fakePng, 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Picture 1 of 1: Only PNG, JPEG and WebP images can be sent\./);
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

  it('--provider goes to the app as it is: the turn runs on it, and the app refuses one it does not know naming them all', async () => {
    let r = await cli(['--provider', 'bogus', 'Hello']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^"bogus" is not a provider\. Name one as Settings → Assistant does: .+; or leave it out for the default\.\n$/);
    // Another provider than the default: its own checks (no key saved for it here).
    r = await cli(['--provider', 'anthropic', 'Hello']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^No key is saved for this provider\./);
    fake.reply({ text: 'Named.' });
    r = await cli(['--json', '--provider', 'openai_compatible', 'Hello']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('"text":"Named."'));
    assert.equal((await cli(['--provider'])).code, 1, 'it needs a value');
    const help = await cli(['--help']);
    assert.match(help.stdout, /\n {2}--provider <id> {6}a provider as Settings → Assistant names it, or agent:<id>; without\n/);
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
    const KEY = 'c0ffee'.repeat(5).slice(0, 32);
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
        if (req.method === 'POST' && req.url === '/api/assistant/turns') return send(202, { ok: true, turn: 't1', conversation: 'c1', answer_key: KEY });
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
      // The answer carries the turn's answer key from the 202 (the route refuses one without it).
      assert.deepEqual(answers, [{ allow: false, answer_key: KEY }], 'the real question took the line typed after it, not the early "y"');
      assert.ok(!out.includes(KEY), 'the key is never printed');
    } finally {
      stub.closeAllConnections?.();
      await new Promise((r) => stub.close(r));
    }
  });

  it('a question for the Magnusim window only: shown, "Answer it in the Magnusim window.", no prompt and nothing sent; its answer there is printed', { timeout: 20_000 }, async () => {
    const ONLY = { id: 'g-only', title: 'Let the agent use its own tool (execute)?', copy: 'Nothing runs until you choose.', yes: 'Allow once', no: "Don't", link_only: true };
    const posted = [];
    let polls = 0;
    let shown;
    const printed = new Promise((r) => (shown = r));
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        const send = (code, j) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(j));
        if (req.method === 'POST' && req.url === '/api/assistant/turns') return send(202, { ok: true, turn: 't1', conversation: 'c1', answer_key: 'a'.repeat(32) });
        if (req.method === 'POST') {
          posted.push([req.url, body]);
          // An answer sent from here is the failure this test catches: the turn ends either way.
          shown();
          return send(200, { ok: true });
        }
        polls += 1;
        if (polls === 1) return send(200, { ok: true, next: 1, ended: false, events: [{ type: 'gate', gate: ONLY }] });
        // Answered in the window once the line was printed here. Bounded: a CLI that never prints
        // it fails the checks below instead of holding the run.
        let bound;
        await Promise.race([printed, new Promise((r) => (bound = setTimeout(r, 10_000)))]);
        clearTimeout(bound);
        return send(200, {
          ok: true,
          next: 3,
          ended: true,
          events: [
            { type: 'gate_closed', gate: ONLY.id, answer: 'allow', by: 'user' },
            { type: 'end', state: 'done', reason: 'end_turn', message: null },
          ],
        });
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const stdin = new PassThrough();
    let out = '';
    try {
      const code = await main(['--port', String(stub.address().port), 'Go.'], {
        stdin,
        stdout: {
          write: (text) => {
            out += text;
            if (out.includes('Answer it in the Magnusim window.')) shown();
            // A "y" typed now answers nothing: no question here takes a line.
            stdin.write('y\n');
            return true;
          },
        },
        stderr: { write: () => true },
      });
      assert.equal(code, 0, out);
      assert.equal(out, "? Let the agent use its own tool (execute)?\n  Nothing runs until you choose.\n  Answer it in the Magnusim window.\n(answered: allowed)\n");
      assert.deepEqual(posted, [], 'nothing answered from here');
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

// ------------------------------------------------------------------------------------------------
// Coding agents (phase 3 spec 4.15, 5.2, 5.5, 6.4)
// ------------------------------------------------------------------------------------------------

describe('assistant-run.mjs with a coding agent', () => {
  const INFO = join(process.env.MAGNUSIM_ASSISTANT_HOME, 'assistant', 'mcp.json');
  /** The app's connection file as the app writes it (the bridge's home rules find it). */
  const writeInfo = (token) => {
    mkdirSync(dirname(INFO), { recursive: true });
    writeFileSync(INFO, JSON.stringify({ version: 1, port: 1, token, pid: process.pid, started_at: new Date().toISOString() }));
  };

  /**
   * A stub app: `start(req, n)` answers the n-th POST /turns ({status, json}); the poll answers
   * `events` once, then ends with `summary`. Records each start's body and its launch header,
   * and each launch check. `holds`: the token it proves it holds at POST /launch/check (as the
   * app does: HMAC of "l<port>:<nonce>", `checkPort` in place of its own port to pass on another
   * app's answer); without it the check is 404, as anything but Magnusim answers.
   */
  async function stubApp({ start, events = [], summary = null, holds = null, checkPort = null }) {
    const starts = [];
    const checks = [];
    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const send = (code, j) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(j));
        if (req.method === 'POST' && req.url === '/api/assistant/launch/check') {
          const { nonce } = JSON.parse(body);
          checks.push({ nonce, launch: req.headers['x-magnusim-launch'] ?? null });
          if (!holds) return send(404, { ok: false });
          return send(200, { ok: true, proof: createHmac('sha256', holds).update(`l${checkPort ?? stub.address().port}:${nonce}`).digest('hex') });
        }
        if (req.method === 'POST' && req.url === '/api/assistant/turns') {
          starts.push({ body: JSON.parse(body), launch: req.headers['x-magnusim-launch'] ?? null });
          const a = start(starts.length);
          return send(a.status, a.json);
        }
        if (req.method === 'GET') return send(200, { ok: true, turn: summary, next: events.length, ended: true, events });
        return send(404, { ok: false });
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    return {
      starts,
      checks,
      port: stub.address().port,
      async close() {
        stub.closeAllConnections?.();
        await new Promise((r) => stub.close(r));
      },
    };
  }

  async function run(args, app) {
    let out = '';
    let errText = '';
    const code = await main(['--port', String(app.port), ...args], {
      stdin: new PassThrough(),
      stdout: { write: (t) => ((out += t), true) },
      stderr: { write: (t) => ((errText += t), true) },
    });
    return { code, out, err: errText };
  }

  const STARTED = { status: 202, json: { ok: true, turn: 't1', conversation: 'c1', answer_key: 'a'.repeat(32) } };
  const SUMMARY = { id: 't1', provider: 'agent:fake', billing: 'agent_account', agent: { id: 'fake', name: 'Fake Agent', version: '1.2.3' } };

  it('--agent <id> starts agent:<id> with the launch token from the connection file; prints the agent lines and who pays', async () => {
    writeInfo('tok-first');
    const events = [
      { seq: 1, type: 'agent', name: 'Fake Agent', version: '1.2.3', own_tools: 'off' },
      { seq: 2, type: 'plan', entries: [{ content: 'Read it', status: 'completed', priority: 'medium' }, { content: 'Add two', status: 'in_progress', priority: 'high' }, { content: 'Report', status: 'pending', priority: 'low' }] },
      { seq: 3, type: 'agent_mode', mode: 'default', label: 'Default' },
      { seq: 4, type: 'agent_model', model: 'm1', label: 'Model one' },
      { seq: 5, type: 'agent_permission', title: 'ai-demo__add', outcome: 'auto_allowed', by: 'magnusim' },
      { seq: 6, type: 'agent_tool', call: 'own-1', title: 'cat notes.txt', kind: 'read', status: 'completed' },
      { seq: 7, type: 'agent_permission', title: 'rm -rf build', outcome: 'declined', by: 'timeout' },
      { seq: 8, type: 'text', step: 1, text: 'Done.' },
      { seq: 9, type: 'end', state: 'done', reason: 'end_turn', message: null },
    ];
    const app = await stubApp({ start: () => STARTED, events, summary: SUMMARY, holds: 'tok-first' });
    try {
      const r = await run(['--agent', 'fake', 'Add two.'], app);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(app.starts, [{ body: { text: 'Add two.', provider: 'agent:fake' }, launch: 'tok-first' }]);
      assert.equal(app.checks.length, 1, 'the app proved it holds the token first');
      assert.match(app.checks[0].nonce, /^[0-9a-f]{32}$/);
      assert.equal(app.checks[0].launch, null, 'the check never carries the token');
      assert.equal(
        r.out,
        [
          'Fake Agent 1.2.3 is working (its own tools are off).',
          'plan:',
          '  [x] Read it',
          '  [~] Add two',
          '  [ ] Report',
          'mode: Default',
          'model: Model one',
          'auto-allowed: ai-demo__add',
          'agent: cat notes.txt (completed)',
          'agent asked: rm -rf build (not allowed, no answer in time)',
          'Done.',
          "Billed to your Fake Agent account (Magnusim can't see the cost).",
          '',
        ].join('\n'),
      );
      assert.ok(!r.out.includes('tok-first') && !r.err.includes('tok-first'), 'the token is never printed');
      // --provider agent:<id> is the same; an API-key provider sends no token.
      await run(['--provider', 'agent:fake', 'Again.'], app);
      assert.equal(app.starts[1].launch, 'tok-first');
      await run(['--provider', 'some_provider', 'Key.'], app);
      assert.equal(app.starts[2].launch, null);
    } finally {
      rmSync(INFO, { force: true });
      await app.close();
    }
  });

  it('refused for want of the proof (a default or conversation that is an agent, or an old token): the file is read again and the start sent once more', async () => {
    writeInfo('tok-new');
    const app = await stubApp({
      start: (n) => (n === 1 ? { status: 403, json: { ok: false, code: 'launch_proof', error: 'Start a coding agent from the Magnusim window or with assistant-run on this account.' } } : STARTED),
      events: [{ seq: 1, type: 'end', state: 'done', reason: 'end_turn', message: null }],
      summary: SUMMARY,
      holds: 'tok-new',
    });
    try {
      const r = await run(['Go.'], app);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(
        app.starts.map((s) => s.launch),
        [null, 'tok-new'],
      );
    } finally {
      rmSync(INFO, { force: true });
      await app.close();
    }
    // No connection file: the refusal stands, exit 1 with its text (one retry at most).
    const refused = await stubApp({ start: () => ({ status: 403, json: { ok: false, code: 'launch_proof', error: 'Start a coding agent from the Magnusim window or with assistant-run on this account.' } }) });
    try {
      const r = await run(['--agent', 'fake', 'Go.'], refused);
      assert.equal(r.code, 1);
      assert.equal(refused.starts.length, 1);
      assert.equal(r.err, 'Start a coding agent from the Magnusim window or with assistant-run on this account.\n');
    } finally {
      await refused.close();
    }
  });

  it('the token goes only to an app that proved it holds it: never to another program on the port, after its launch_proof refusal either, nor to one passing on an answer for another port or another token', async () => {
    writeInfo('tok-live');
    const LAUNCH_PROOF = { status: 403, json: { ok: false, code: 'launch_proof', error: 'Start a coding agent from the Magnusim window or with assistant-run on this account.' } };
    const UNPROVEN = (port) => `What answers on port ${port} didn't prove it is the Magnusim that wrote the connection file, so the launch token was not sent. Check --port.\n`;
    // Something else on the port (a wrong --port, a saved port the app hasn't restarted on): its check is 404.
    const squatter = await stubApp({ start: () => LAUNCH_PROOF });
    try {
      const agent = await run(['--agent', 'fake', 'Go.'], squatter);
      const plain = await run(['Go.'], squatter);
      assert.deepEqual(squatter.starts.map((s) => s.launch), [null, null], 'never the token, first or after launch_proof');
      assert.equal(squatter.checks.length, 3, 'the agent turn checks before each start; the plain turn after its refusal');
      assert.deepEqual([agent.code, plain.code], [1, 1]);
      for (const r of [agent, plain]) {
        assert.equal(r.err, `Start a coding agent from the Magnusim window or with assistant-run on this account.\n${UNPROVEN(squatter.port)}`);
        assert.ok(!r.out.includes('tok-live') && !r.err.includes('tok-live'));
      }
    } finally {
      await squatter.close();
    }
    // One that passes the check on to the app's real port gets an answer for that port; one with another token's answer.
    const real = await stubApp({ start: () => STARTED, holds: 'tok-live' });
    const relay = await stubApp({ start: () => LAUNCH_PROOF, holds: 'tok-live', checkPort: real.port });
    const other = await stubApp({ start: () => LAUNCH_PROOF, holds: 'tok-other' });
    try {
      for (const app of [relay, other]) {
        const r = await run(['--agent', 'fake', 'Go.'], app);
        assert.equal(r.code, 1);
        assert.deepEqual(app.starts.map((s) => s.launch), [null]);
        assert.ok(r.err.endsWith(UNPROVEN(app.port)), r.err);
      }
    } finally {
      rmSync(INFO, { force: true });
      await Promise.all([real.close(), relay.close(), other.close()]);
    }
  });

  it('an agent that is off: exit 1 with its text; a turn that needs a sign-in says how to go on', async () => {
    writeInfo('tok');
    const off = await stubApp({ start: () => ({ status: 400, json: { ok: false, code: 'agent_not_allowed', error: 'Fake Agent is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.' } }) });
    try {
      const r = await run(['--agent', 'fake', 'Go.'], off);
      assert.equal(r.code, 1);
      assert.equal(r.err, 'Fake Agent is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.\n');
    } finally {
      await off.close();
    }
    const signIn = await stubApp({
      start: () => STARTED,
      events: [{ seq: 1, type: 'end', state: 'failed', reason: 'agent_signin', message: "Fake Agent isn't signed in. Settings → Assistant shows how to sign in." }],
      summary: SUMMARY,
    });
    try {
      const r = await run(['--agent', 'fake', 'Go.'], signIn);
      assert.equal(r.code, 1);
      assert.equal(r.out, "[failed] Fake Agent isn't signed in. Settings → Assistant shows how to sign in.\nSign in, then run the same command again.\nBilled to your Fake Agent account (Magnusim can't see the cost).\n");
    } finally {
      rmSync(INFO, { force: true });
      await signIn.close();
    }
  });

  it('--help names --agent and agent:<id>, and no provider by name', async () => {
    const r = await cli(['--help'], '', { withPort: false });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--agent <id> {9}a coding agent Settings → Assistant lists \(= --provider agent:<id>\)/);
    assert.match(r.stdout, /--provider <id> {6}a provider as Settings → Assistant names it, or agent:<id>/);
    assert.deepEqual((await import(pathToFileURL(CLI).href)).parseArgs(['--agent', 'x', 'hi']).provider, 'agent:x');
  });
});
