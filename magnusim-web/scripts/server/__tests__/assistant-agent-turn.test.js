// Assistant turns on a coding agent (phase 3 spec 4.6-4.15, 5.2, 6.1, 7.4, 7.7; A4): the turn's
// events (the agent, its text, our own tools' calls once, its own tools, its plan, the
// auto-allowed permission), every stop reason, the provider per turn beside an API-key turn,
// refusals at the start (agent_unknown, launch_proof, agent_not_allowed, agent_allow_changed,
// privacy, agents_busy), privacy for agent:<id> before the session, the change, call and minute
// limits, Stop (open permission requests cancelled before session/cancel; a stubborn agent
// tree-killed), a crash mid-tool, a mode outside the allowed ones, the lockdown tripwire, own-tool
// questions (link_only), the idle end and a restarted session's note, conversation drops, a
// server lifetime's end (a Vite restart) and the Settings Test, connect and sign-in routes; what
// the agent does between prompts (a mode, its own tool), a crash after Stop, Stop or the switch
// during the privacy question, and the switch going off while a start is checked.
// Also: the served list changing under a tools-off agent (never the tripwire), its own tool
// while it starts, a mode it reports with the set_mode answer, the prompt's wait for its MCP
// server's list (an agent that connects it after session/new), a call queued behind a stopped
// message's call, overlapping own-tool questions, unanswered questions in a row, the tripwire
// after a crashed turn and the adapter's nested _auth/status_update; a request for a Magnusim
// tool that left the list (answered no at once, never asked as the agent's own tool), and a kept
// agent that was never prompted (its next prompt is its first, with the notes).
//
// Every agent is the scripted fake (e2e/support/fake-acp-agent.mjs) through its controller,
// found by discovery only in this test's folders and home (the test switches), started in this
// test's own temp folder. No real agent, provider, home or temp folder is touched; every process
// the fakes started is checked gone at the end.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-agent-turn-'));
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOME = join(ROOT, 'home');
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith('MAGNUSIM_TEST_ASSISTANT')) delete process.env[k];
for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XDG_CONFIG_HOME']) {
  delete process.env[k];
}
process.env.MAGNUSIM_TEST_ASSISTANT = '1';
process.env.MAGNUSIM_TEST_ASSISTANT_PROTECTOR = 'file';
const AGENT_HOME = join(ROOT, 'agent-home');
const PATH_DIR = join(ROOT, 'path');
for (const d of [AGENT_HOME, PATH_DIR, join(AGENT_HOME, 'tmp')]) mkdirSync(d, { recursive: true });
process.env.MAGNUSIM_TEST_ASSISTANT_AGENT_HOME = AGENT_HOME;
process.env.MAGNUSIM_TEST_ASSISTANT_AGENT_PATHS = PATH_DIR;

const H = await import('./assistant-harness.js');
const M = await import('./assistant-mcp-harness.js');
const L = await import('../assistant/mcp/listener.ts');
const S = await import('../assistant/mcp/server.ts');
const B = await import('../assistant/mcp/sessions.ts');
const D = await import('../assistant/agents/discover.ts');
const SES = await import('../assistant/agents/session.ts');
const T = await import('../assistant/agents/test.ts');
const HOST = await import('../assistant/agents/host.ts');
const { resetAssistantState } = await import('../assistant/state.ts');
const { stopAllAgentProcesses } = await import('../assistant/agents/process.ts');
const { dropWarmKeeper } = await import('../assistant/agents/job-win.ts');
const { startFakeAcp } = await import('../../../e2e/support/fake-acp.mjs');
const { removeTree } = await import('../../remove-tree.js');
const { GUIDE_CHANGED_NOTE } = await import('../assistant/loop.ts');

const WIN = process.platform === 'win32';
const LIMIT = { timeout: 180_000 };
/** A wait for something that happens on its own (a process, a pipe): sized for a slow CI runner. */
const CEILING = 30_000;
const PROJECT = { id: 'p1', title: 'Secret Wing', created_at: '2026-10-01T00:00:00.000Z' };
const GUIDE = 'Use add to add.\nKeep it short.';

const host = HOST.agentHost();
const fakes = [];

after(async () => {
  host.endAll('test end');
  await stopAllAgentProcesses('test end');
  dropWarmKeeper();
  const pids = fakes.flatMap((f) => f.pids());
  for (const f of fakes) await f.stop();
  await L.resetMcpListenerForTests();
  B.resetBindingsForTests();
  resetAssistantState();
  // Nothing a fake started is left running. A pid the OS has given to another program since (the
  // full suite starts many) is not a fake's: only a process whose command line is one of this
  // file's fakes counts, and only those are ever signalled.
  const deadline = Date.now() + CEILING;
  let left = fakesOnly(pids.filter((p) => alive(p.pid)));
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    left = left.filter((p) => alive(p.pid));
  }
  left = fakesOnly(left);
  for (const p of left) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  try {
    await removeTree(ROOT);
  } catch {
    /* the OS temp cleaner takes it */
  }
  assert.deepEqual(left, [], 'no process a fake agent started is left running');
});

/** The command lines of the running `pids` (pid → text), or null when the OS can't say. */
function commandLines(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    if (process.platform === 'linux') {
      for (const pid of pids) {
        try {
          out.set(pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
        } catch {
          /* gone */
        }
      }
    } else if (WIN) {
      const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const filter = pids.map((pid) => `ProcessId=${Number(pid)}`).join(' OR ');
      const text = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }`], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: CEILING,
      });
      for (const line of text.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab > 0) out.set(Number(line.slice(0, tab)), line.slice(tab + 1));
      }
    } else {
      for (const pid of pids) {
        try {
          out.set(pid, execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    return null;
  }
  return out;
}

/** Of the processes the fakes reported, those that are still one of this file's fakes (all of them when the OS can't say). */
function fakesOnly(list) {
  const lines = commandLines(list.map((p) => p.pid));
  if (lines === null) return list;
  const norm = (t) => t.toLowerCase().replace(/\\/g, '/');
  // The agents' launchers and the bridges' --info sit under ROOT; a custom agent carries its
  // controller's address; a helper is the fake's own one-line script.
  const marks = [norm(ROOT), ...fakes.map((f) => norm(f.url)), 'setinterval(()=>{},1<<30)'];
  return list.filter((p) => {
    const line = lines.get(p.pid);
    return typeof line === 'string' && marks.some((m) => norm(line).includes(m));
  });
}

function alive(pid) {
  if (!pid) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// ------------------------------------------------------------------------------------------------
// The agents: the fake through discovery's own rules
// ------------------------------------------------------------------------------------------------

/** npm's cmd-shim for a script at `rel` (backslashes) under the shim's folder. */
const cmdShim = (rel) => `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

/**
 * The known agent `program` from npm package `pkg` in PATH_DIR, its bin the fake's launcher (with
 * `fake`'s controller): through its verified package, so its class is the catalogue's.
 */
function installKnown(fake, { pkg, program, version }) {
  const pkgDir = join(PATH_DIR, 'node_modules', ...pkg.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version, bin: { [program]: 'dist/index.js' } }));
  const script = join(pkgDir, 'dist', 'index.js');
  fake.writeLauncher(script, { version });
  if (WIN) writeFileSync(join(PATH_DIR, `${program}.cmd`), cmdShim(['node_modules', ...pkg.split('/'), 'dist', 'index.js'].join('\\')));
  else {
    chmodSync(script, 0o755);
    symlinkSync(script, join(PATH_DIR, program));
  }
  return script;
}

/** A fake controller, stopped at the end. */
async function fakeAgent(options) {
  const f = await startFakeAcp(options);
  fakes.push(f);
  return f;
}

let claude;
let codex;
let custom;
const CUSTOM_ID = 'custom-a1b2c3';

before(async () => {
  claude = await fakeAgent({ style: 'tool_name_meta', agentInfo: { name: 'fake-adapter', title: 'Fake', version: '0.85.1' } });
  installKnown(claude, { pkg: '@agentclientprotocol/claude-agent-acp', program: 'claude-agent-acp', version: '0.85.1' });
  codex = await fakeAgent({ style: 'mcp_call_flag', modes: { currentModeId: 'agent', availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'agent', name: 'Agent' }] }, configOptions: null });
  installKnown(codex, { pkg: '@agentclientprotocol/codex-acp', program: 'codex-acp', version: '2.1.1' });
  custom = await fakeAgent({ style: 'none' });
  // Signed in to the known agent: its login file (never read).
  mkdirSync(join(AGENT_HOME, '.claude'), { recursive: true });
  writeFileSync(join(AGENT_HOME, '.claude', '.credentials.json'), '{}');
});

// ------------------------------------------------------------------------------------------------
// A world: a TurnManager (fake clock), its MCP service on the real listener, a workspace in a tab
// ------------------------------------------------------------------------------------------------

/** A custom agent (the fake, with no adapter fields) for these settings. */
const customAgent = () => ({ id: CUSTOM_ID, name: 'Scripted', argv: [...custom.argv], keep_env: [] });

async function fingerprintOf(id, settings) {
  const e = await D.resolveAgentNow(id, settings);
  assert.ok(e?.fingerprint, `${id} resolves`);
  return e.fingerprint;
}

async function world(o = {}) {
  resetAssistantState();
  host.setTestOptions({ cancelMs: o.cancelMs ?? null, idleMs: o.idleMs ?? null, gateMs: o.gateMs ?? null });
  const m = H.makeManager({
    dir: ROOT,
    pluginEpoch: () => '1',
    hostTools: o.hostTools ?? [],
    projects: { p1: { ...PROJECT } },
    ...(o.adapters ? { adapters: o.adapters } : {}),
    settings: {
      provider: o.provider ?? 'agent:claude',
      privacy: o.privacy ?? 'allow',
      custom_agents: o.custom ? [customAgent()] : [],
      ...(o.settings ?? {}),
    },
  });
  if (o.allow) {
    for (const id of o.allow) {
      m.state.settings.agents = { ...m.state.settings.agents, [id]: { model: null, mode: null, allowed: { fingerprint: await fingerprintOf(id, m.state.settings), at: 'now' }, lockdown_failed: null } };
    }
  }
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
  const invoked = [];
  if (o.tab !== false) {
    m.registry.setWorkspace('tab-1', 'a'.repeat(24), {
      plugin: 'ai-demo',
      pluginName: 'Workspace demo',
      workspace: 'counter',
      workspaceName: 'Counter',
      projectId: 'p1',
      studyId: 's1',
      epoch: '1',
      tools: H.demoTools(),
      guide: o.guide ?? GUIDE,
      invoke: async (call) => {
        invoked.push({ tool: call.tool, input: call.input, turn: call.turn });
        if (o.invoke) return o.invoke(call);
        return { ok: true, data: { counter: 2 }, summary: 'ran' };
      },
    });
  }
  const token = () => M.readInfo(L.mcpInfoPath()).token;
  return {
    m,
    invoked,
    token,
    async turn(body, proof = { token: token() }) {
      const r = await m.manager.start(typeof body === 'string' ? { text: body } : body, proof);
      return { ...r, turn: r.body.turn ? m.manager.get(r.body.turn) : null };
    },
    async close() {
      host.endAll('test end');
      dispose();
    },
  };
}

const typesOf = (t) => H.eventsOf(t).map((e) => e.type);
const endOf = (t) => H.eventsOf(t).find((e) => e.type === 'end');
const settledTurn = (t) => H.settled(t, CEILING);
/** The fake's messages from Magnusim, by method. */
const methodsIn = (fake, pid) => fake.received(pid).filter((m) => m.method).map((m) => m.method);

describe('a turn on a coding agent', LIMIT, () => {
  it('runs in the open workspace: the agent, its text, our call once, its plan, the auto-allowed permission, done; billed to its account', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'Add two to the counter.', tab: 'tab-1', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(
        { say: 'Looking. ' },
        { plan: ['Read the counter', { content: 'Add two', status: 'in_progress', priority: 'high' }] },
        { askOurs: { tool: 'ai-demo__add' } },
        { call: { tool: 'ai-demo__add', args: { by: 2 } } },
        { say: 'Added. ' },
        // Its updates and its MCP calls come on two pipes: the next call waits until the text is logged.
        { hold: 'text-logged' },
        { call: { tool: 'ai-demo__get_count', args: {} } },
        { say: 'Done.' },
      );
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.match(r.body.answer_key, /^[0-9a-f]{32}$/);
      const t = r.turn;
      await H.until(() => H.eventsOf(t).some((e) => e.type === 'text' && e.text.includes('Added')), CEILING, 'the text after the first call');
      claude.release('text-logged');
      await settledTurn(t);
      const ev = H.eventsOf(t);
      assert.deepEqual(endOf(t), { ...endOf(t), state: 'done', reason: 'end_turn', message: null });
      const agent = ev.find((e) => e.type === 'agent');
      assert.deepEqual({ ...agent, seq: 0, at: 0 }, { type: 'agent', name: 'Claude Code', version: '0.85.1', own_tools: 'off', seq: 0, at: 0 });
      // Our tool calls: the runner's record once each, never an agent_tool for them.
      const calls = ev.filter((e) => e.type === 'tool_call');
      assert.deepEqual(
        calls.map((c) => [c.tool, c.step]),
        [
          ['ai-demo__add', 1],
          ['ai-demo__get_count', 2],
        ],
      );
      assert.equal(ev.filter((e) => e.type === 'tool_result').length, 2);
      assert.equal(ev.filter((e) => e.type === 'agent_tool').length, 0, 'our own tools are not logged as the agent’s');
      assert.deepEqual(w.invoked.map((c) => [c.tool, c.turn]), [
        ['add', t.id],
        ['get_count', t.id],
      ]);
      // Text groups with the calls: after the 2nd call it is step 3.
      const texts = ev.filter((e) => e.type === 'text');
      assert.deepEqual(
        texts.map((x) => [x.step, x.text]),
        [
          [1, 'Looking. '],
          [2, 'Added. '],
          [3, 'Done.'],
        ],
      );
      const plan = ev.find((e) => e.type === 'plan');
      assert.deepEqual(plan.entries, [
        { content: 'Read the counter', status: 'pending', priority: 'medium' },
        { content: 'Add two', status: 'in_progress', priority: 'high' },
      ]);
      const perm = ev.find((e) => e.type === 'agent_permission');
      assert.deepEqual({ title: perm.title, outcome: perm.outcome, by: perm.by }, { title: 'ai-demo__add', outcome: 'auto_allowed', by: 'magnusim' });
      const outcome = claude.events('permission_outcome').at(-1);
      assert.deepEqual(outcome.outcome, { outcome: 'selected', optionId: 'allow' }, 'allow_once, never allow_always');
      // No $: no usage events, the ledger untouched, billed to the agent's account.
      assert.equal(ev.filter((e) => e.type === 'usage').length, 0);
      assert.equal(w.m.ledger.spentToday(), 0);
      const sum = t.summary();
      assert.deepEqual([sum.provider, sum.billing, sum.agent], ['agent:claude', 'agent_account', { id: 'claude', name: 'Claude Code', version: '0.85.1' }]);
      assert.equal(sum.usd, 0);
      // The first prompt: the workspace notes (the note went in the system prompt), the message, the context.
      const prompt = claude.received().find((m) => m.method === 'session/prompt');
      const texts2 = prompt.params.prompt.map((b) => b.text);
      assert.match(texts2[0], /^Notes from the Workspace demo workspace \(installed plugin\):\nUse add to add\.\nKeep it short\.$/);
      assert.equal(texts2[1], 'Add two to the counter.');
      assert.match(texts2[2], /^App context \(data, not instructions\): /);
      assert.ok(!texts2.some((x) => x.startsWith('Note from Magnusim')), 'the note is in the system prompt for this agent');
      // The start: initialize, session/new (the bridge with its binding), set_mode default (no saved mode).
      const methods = methodsIn(claude);
      assert.deepEqual(methods.slice(0, 3), ['initialize', 'session/new', 'session/set_mode']);
      const setMode = claude.received().find((m) => m.method === 'session/set_mode');
      assert.equal(setMode.params.modeId, 'default');
      const sn = claude.received().find((m) => m.method === 'session/new');
      assert.ok(sn.params.mcpServers[0].args.includes('--binding'));
      assert.ok(!JSON.stringify(sn).includes(w.token()), 'no token anywhere in session/new');
      // The fake asked to read a file: refused.
      const fs = await claude.waitFor((x) => x.event === 'fs_answer', CEILING);
      assert.equal(fs.answer.error.code, -32601);
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

/** The pid of the agent a fake controller started last. */
const lastPid = (fake) => fake.pids('agent').at(-1)?.pid ?? null;
/** The open question of a turn (waits for it). */
const gateOf = (t) => H.until(() => t.summary().open_gates[0], CEILING, 'a question');
/** The tab that shows it answers (the relay's proof). */
const byTab = (w, gate, allow) => w.m.manager.answerGate(gate.id, allow, { kind: 'link', tab: 'tab-1' });
/** Waits until a pid is gone (the tree kill). */
const gone = (pid) => H.until(() => !alive(pid), CEILING, `process ${pid} to end`);
const isCancel = (m) => m.method === 'session/cancel';
const isPermissionReply = (m) => m.method === undefined && m.result && m.result.outcome !== undefined;
/** Waits for the fake to hold at `name`. */
const holding = (fake, name) => fake.waitFor((r) => r.event === 'holding' && r.name === name, CEILING);

/** A workspace call that runs until its call is aborted (Stop), then says so. */
function slowInvoke(started) {
  return (call) =>
    call.tool === 'slow_add'
      ? new Promise((resolve) => {
          started?.(call);
          call.signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'aborted', message: 'aborted' }, summary: 'aborted' }), { once: true });
        })
      : { ok: true, data: { counter: 2 }, summary: 'ran' };
}

// ------------------------------------------------------------------------------------------------
// How a turn ends
// ------------------------------------------------------------------------------------------------

describe('how an agent turn ends (spec 4.7 stop reasons)', LIMIT, () => {
  it('each stop reason, and an error answer, gives its end; the agent stays for the next message', async () => {
    const w = await world();
    try {
      const cases = [
        [{ stop: 'max_tokens' }, { state: 'capped', reason: 'max_tokens', message: 'The agent ran out of room mid-answer.' }],
        [{ stop: 'max_turn_requests' }, { state: 'capped', reason: 'agent_limit', message: 'The agent reached its own limit of requests for one message.' }],
        [{ stop: 'refusal' }, { state: 'failed', reason: 'refusal', message: 'The agent declined this request.' }],
        [{ stop: 'cancelled' }, { state: 'stopped', reason: 'agent', message: 'The agent stopped this message.' }],
        [{ stop: 'error' }, { state: 'failed', reason: 'agent_error', message: 'Claude Code stopped with an error.' }],
        [{ error: { code: -32603, message: 'boom sk-ant-api03-SECRETSECRETSECRETSECRET' } }, { state: 'failed', reason: 'agent_error', message: 'Claude Code answered with an error: boom [redacted]' }],
        [{ error: { code: -32000, message: 'Authentication required' } }, { state: 'failed', reason: 'agent_signin', message: "Claude Code isn't signed in. Settings → Assistant shows how to sign in." }],
        [{ say: 'fine' }, { state: 'done', reason: 'end_turn', message: null }],
      ];
      let conversation;
      let pid = null;
      for (const [step, end] of cases) {
        const r = await w.turn({ text: 'Go.', provider: 'agent:claude', ...(conversation ? { conversation } : {}) });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        claude.script(step);
        assert.equal(r.status, 202, JSON.stringify(r.body));
        conversation = r.body.conversation;
        await settledTurn(r.turn);
        const e = endOf(r.turn);
        assert.deepEqual({ state: e.state, reason: e.reason, message: e.message }, end, JSON.stringify(step));
        // One agent for the whole conversation: none of these ends it.
        pid ??= lastPid(claude);
        assert.equal(lastPid(claude), pid);
        assert.ok(alive(pid));
      }
    } finally {
      await w.close();
    }
  });

  it('a crash mid-tool: failed/agent_exited with its last words, the call answered as the agent stopping (not the person, not the server), and the next message starts it again with the note', async () => {
    // The tool says it is under way (the fake exits on that progress), then runs until aborted.
    const w = await world({
      invoke: (call) =>
        call.tool === 'slow_add'
          ? new Promise((resolve) => {
              call.signal.addEventListener('abort', () => resolve({ ok: false, error: { code: 'aborted', message: 'aborted' }, summary: 'aborted' }), { once: true });
              call.progress(0.5, 'Halfway');
            })
          : { ok: true, data: { counter: 2 }, summary: 'ran' },
    });
    try {
      const r = await w.turn({ text: 'Add.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script('exitDuringCall', { call: { tool: 'ai-demo__slow_add', args: { by: 1 } } }, { say: 'never' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await settledTurn(r.turn);
      const pid = lastPid(claude);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['failed', 'agent_exited']);
      assert.equal(e.message, "Claude Code stopped unexpectedly. Its last words: 'fake agent: exiting during a call'");
      // The call it was in: aborted by the agent going, whichever the server heard first (the
      // bridge's socket closing, the binding dropped at the exit, or the turn ending).
      const call = H.eventsOf(r.turn).find((x) => x.type === 'tool_call' && x.tool === 'ai-demo__slow_add');
      assert.ok(call, 'the slow call ran');
      const res = H.eventsOf(r.turn).find((x) => x.type === 'tool_result' && x.call === call.call);
      assert.deepEqual(
        res && { ok: res.ok, code: res.code, summary: res.summary },
        { ok: false, code: 'stopped', summary: 'Claude Code stopped unexpectedly while it ran; it may or may not have finished.' },
      );
      await gone(pid);
      // Its bridge went with it: nothing of the session is left.
      for (const p of claude.pids('mcp')) await gone(p.pid);
      const again = await w.turn({ text: 'Again.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(again.status, 202, JSON.stringify(again.body));
      claude.script({ say: 'back' });
      await settledTurn(again.turn);
      assert.equal(endOf(again.turn).state, 'done');
      assert.notEqual(lastPid(claude), pid, 'a new process');
      assert.ok(H.eventsOf(again.turn).some((x) => x.type === 'note' && x.text === "Claude Code was started again, so it doesn't remember this conversation's earlier messages."));
    } finally {
      await w.close();
    }
  });
});

describe('a call still open when the turn ends says why: never the person when it wasn\u2019t', () => {
  it('Stop, a key change or a switch turned off: the person; the server stopping: the server; the agent exiting: it stopped unexpectedly; any other end: the turn ended', async () => {
    const { Turn } = await import('../assistant/turns.ts');
    const { GateBroker, realClock } = await import('../assistant/gates.ts');
    const { callAbortOf, stoppedText } = await import('../assistant/runner.ts');
    const agent = { kind: 'agent', provider: 'agent:claude', model: '', agent: { id: 'claude', name: 'Claude Code', version: '1.0.0', ownTools: 'off' }, caps: {} };
    const model = { provider: 'anthropic', model: 'm', caps: {} };
    let n = 0;
    const openCall = (settings, end) => {
      const t = new Turn({ id: `t-why-${(n += 1)}`, prompt: 'x', conv: { id: 'c-why' }, tab: null, projectId: null, simulationId: null, settings, clock: realClock, gates: new GateBroker() });
      const signal = t.callSignal();
      end(t);
      assert.ok(signal.aborted);
      const why = callAbortOf(signal);
      if (!t.ended) t.end('stopped', 'test', null);
      return [stoppedText(true, why.server === true, why.cause), stoppedText(false, why.server === true, why.cause)];
    };
    const PERSON = ['Stopped by the user while it ran; it may or may not have finished.', 'Stopped by the user before this ran.'];
    assert.deepEqual(openCall(agent, (t) => t.stop()), PERSON);
    assert.deepEqual(openCall(model, (t) => t.stop('key_changed', 'The provider key was changed.')), PERSON);
    assert.deepEqual(openCall(agent, (t) => t.stop('agent_off', 'Turned off.', 'stopped')), PERSON);
    assert.deepEqual(openCall(agent, (t) => t.shutdown()), ['The server stopped while it ran; it may or may not have finished.', 'The server stopped before this ran.']);
    assert.deepEqual(openCall(agent, (t) => t.end('failed', 'agent_exited', 'Claude Code stopped unexpectedly.')), [
      'Claude Code stopped unexpectedly while it ran; it may or may not have finished.',
      'Claude Code stopped unexpectedly before this ran.',
    ]);
    assert.deepEqual(openCall(agent, (t) => t.end('failed', 'agent_lockdown', 'Locked.')), ['The turn ended while it ran; it may or may not have finished.', 'The turn ended before this ran.']);
  });
});

// ------------------------------------------------------------------------------------------------
// The start's refusals
// ------------------------------------------------------------------------------------------------

describe('starting a turn on a coding agent (spec 5.2, 5.3)', LIMIT, () => {
  it('an API-key turn and an agent turn run side by side; each conversation stays bound to its provider', async () => {
    const w = await world({ provider: 'anthropic' });
    try {
      w.m.provider.script({ text: 'Key answer.' });
      const agentTurn = await w.turn({ text: 'Agent.', provider: 'agent:claude' });
      assert.equal(agentTurn.status, 202, JSON.stringify(agentTurn.body));
      claude.script({ hold: 'side' }, { say: 'Agent answer.' });
      assert.equal(agentTurn.status, 202, JSON.stringify(agentTurn.body));
      await holding(claude, 'side');
      const keyTurn = await w.turn({ text: 'Key.' });
      assert.equal(keyTurn.status, 202);
      await settledTurn(keyTurn.turn);
      assert.equal(endOf(keyTurn.turn).state, 'done');
      assert.equal(keyTurn.turn.summary().billing, 'usd');
      claude.release('side');
      await settledTurn(agentTurn.turn);
      assert.equal(endOf(agentTurn.turn).state, 'done');
      // Bound: the agent's conversation refuses the key provider, and the other way round.
      const a = await w.turn({ text: 'x', provider: 'anthropic', conversation: agentTurn.body.conversation });
      assert.deepEqual([a.status, a.body.code, a.body.field], [409, 'conversation_changed', 'provider']);
      const b = await w.turn({ text: 'x', provider: 'agent:claude', conversation: keyTurn.body.conversation });
      assert.deepEqual([b.status, b.body.code, b.body.field], [409, 'conversation_changed', 'provider']);
      // The agent's conversation keeps no messages: the agent keeps them.
      assert.equal(agentTurn.turn.conv.messages.length, 0);
    } finally {
      await w.close();
    }
  });

  it('refused in order: agent_unknown (400), then launch_proof (403) without this launch’s token or an app tab’s live link', async () => {
    const w = await world();
    try {
      const unknown = await w.turn({ text: 'x', provider: 'agent:nope' }, {});
      assert.deepEqual([unknown.status, unknown.body.code, unknown.body.error], [400, 'agent_unknown', 'No coding agent called nope. Settings → Assistant lists them.']);
      assert.equal((await w.turn({ text: 'x', provider: 'agent:Not An Id' })).body.code, 'bad_provider');
      const before = claude.pids('agent').length;
      for (const proof of [{}, { token: 'x'.repeat(43) }, { token: '' }, { token: 42 }]) {
        const r = await w.turn({ text: 'x', provider: 'agent:claude' }, proof);
        assert.deepEqual([r.status, r.body.code, r.body.error], [403, 'launch_proof', 'Start a coding agent from the Magnusim window or with assistant-run on this account.'], JSON.stringify(proof));
      }
      // A default that is an agent needs the proof too.
      assert.equal((await w.turn({ text: 'x' }, {})).body.code, 'launch_proof');
      // An app tab's live link proves it (the page), whichever tab sends it; a link that is no tab's live one doesn't.
      w.m.manager.setLinkCheck((link) => link === 'f'.repeat(24));
      assert.equal((await w.turn({ text: 'x', provider: 'agent:claude', tab: 'tab-1', link: 'e'.repeat(24) }, {})).body.code, 'launch_proof');
      assert.equal((await w.turn({ text: 'x', provider: 'agent:claude', link: 42 }, {})).body.code, 'launch_proof');
      assert.equal(claude.pids('agent').length, before, 'nothing started');
      const ok = await w.turn({ text: 'x', provider: 'agent:claude', tab: 'tab-1', link: 'f'.repeat(24) }, {});
      assert.equal(ok.status, 202, JSON.stringify(ok.body));
      claude.script({ say: 'linked' });
      assert.equal(ok.status, 202, JSON.stringify(ok.body));
      await settledTurn(ok.turn);
      assert.equal(endOf(ok.turn).state, 'done');
    } finally {
      await w.close();
    }
  });

  it('a custom agent with its switch off is refused agent_not_allowed and never started; a changed command agent_allow_changed', async () => {
    const w = await world({ custom: true });
    try {
      const before = custom.records().length;
      const r = await w.turn({ text: 'x', provider: `agent:${CUSTOM_ID}` });
      assert.deepEqual([r.status, r.body.code], [400, 'agent_not_allowed']);
      assert.equal(r.body.error, 'Scripted is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.');
      assert.equal(custom.records().length, before, 'the fake recorded nothing: it never started');
      // Allowed for another command (its fingerprint changed since).
      w.m.state.settings.agents = { [CUSTOM_ID]: { model: null, mode: null, allowed: { fingerprint: 'd'.repeat(64), at: 'now' }, lockdown_failed: null } };
      const changed = await w.turn({ text: 'x', provider: `agent:${CUSTOM_ID}` });
      assert.deepEqual([changed.status, changed.body.code], [400, 'agent_allow_changed']);
      assert.equal(custom.records().length, before);
    } finally {
      await w.close();
    }
  });

  it('the tool connection unavailable: mcp_unavailable with the plain text', async () => {
    const w = await world();
    try {
      // With the connection down there is no launch token (listener.ts): the CLI's proof fails too.
      const noToken = { launchToken: () => false };
      w.m.deps.agents = { ...noToken, listener: async () => ({ running: false, reason: 'deps_missing', port: null }) };
      const r = await w.turn({ text: 'x', provider: 'agent:claude' });
      assert.deepEqual([r.status, r.body.code, r.body.error], [400, 'mcp_unavailable', "Magnusim's tool-connection package isn't installed. Run Setup.bat again."]);
      w.m.deps.agents = { ...noToken, listener: async () => ({ running: false, reason: 'bind_failed', port: 4321 }) };
      const b = await w.turn({ text: 'x', provider: 'agent:claude' });
      assert.equal(b.body.code, 'mcp_unavailable');
      assert.match(b.body.error, /^Magnusim couldn't open the connection its tools use \(bind_failed\)\. .* port 4321\.$/);
      // No port bound or saved yet: "its port", as Settings says it.
      assert.equal(w.m.state.settings.mcp.port, null);
      w.m.deps.agents = { ...noToken, listener: async () => ({ running: false, reason: 'file_failed', port: null }) };
      const c = await w.turn({ text: 'x', provider: 'agent:claude' });
      assert.deepEqual(
        [c.body.code, c.body.error],
        ['mcp_unavailable', "Magnusim couldn't open the connection its tools use (file_failed). Restart Magnusim; if it keeps happening, another program may hold its port."],
      );
    } finally {
      await w.close();
    }
  });

  it("the tool connection can't run: the agent Test refuses mcp_unavailable in the words every refusal uses, and starts nothing", async () => {
    const w = await world();
    const ST = await import('../assistant/settings.ts');
    const AT = await import('../assistant/agents/test.ts');
    await ST.addCustomAgent(customAgent());
    const info = L.mcpInfoPath();
    try {
      await ST.setAgentAllowed(CUSTOM_ID, { fingerprint: await fingerprintOf(CUSTOM_ID, await ST.loadSettings()) });
      // A folder holds the connection file's name: the listener can't write it, so it can't start.
      await L.resetMcpListenerForTests();
      mkdirSync(join(info, 'blocked'), { recursive: true });
      const before = custom.records().length;
      const r = await AT.agentTestRequest({ id: CUSTOM_ID, message: false }, { mcp: async () => ({ available: true, reason: null }) });
      assert.equal(L.mcpListenerStatus().reason, 'file_failed');
      const port = (await ST.loadSettings()).mcp.port;
      assert.deepEqual([r.status, r.body.code, r.body.error], [409, 'mcp_unavailable', L.mcpUnavailableText('file_failed', port)]);
      assert.match(r.body.error, /^Magnusim couldn't open the connection its tools use \(file_failed\)\. Restart Magnusim; if it keeps happening, another program may hold (port \d+|its port)\.$/);
      assert.equal(custom.records().length, before, 'never started');
    } finally {
      await removeTree(info);
      await L.resetMcpListenerForTests();
      await ST.removeCustomAgent(CUSTOM_ID);
      await w.close();
    }
  });

  it('the allow switch going off while a start is checked: its checks run again and it is refused; nothing starts', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    const AT = await import('../assistant/agents/test.ts');
    let release = () => {};
    try {
      let enter;
      const entered = new Promise((r) => (enter = r));
      const gate = new Promise((r) => (release = r));
      let finds = 0;
      w.m.deps.agents = {
        find: async (...args) => {
          finds += 1;
          if (finds === 1) {
            enter();
            await gate;
          }
          return AT.findAgentNow(...args);
        },
      };
      const before = custom.records().length;
      const pending = w.turn({ text: 'x', provider: `agent:${CUSTOM_ID}` });
      await entered;
      // What POST /agents/allow {allow:false} does: the switch saved off, then the agent stopped.
      w.m.state.settings.agents = { ...w.m.state.settings.agents, [CUSTOM_ID]: { ...w.m.state.settings.agents[CUSTOM_ID], allowed: null } };
      await host.stopAgent(CUSTOM_ID, 'Scripted was turned off in Settings.');
      release();
      const r = await pending;
      assert.deepEqual([r.status, r.body.code], [400, 'agent_not_allowed'], JSON.stringify(r.body));
      assert.equal(r.body.error, 'Scripted is off until you allow it in Settings → Assistant: its own tools can run commands and change files on this PC.');
      assert.equal(finds, 2, 'checked again with the settings read again');
      assert.equal(custom.records().length, before, 'never started');
      assert.equal(host.count(), 0);
    } finally {
      release();
      await w.close();
    }
  });

  it('the allow switch going off while a Test, connect or sign-in is checked: its checks run again and it is refused; nothing starts', async () => {
    const w = await world();
    const S = await import('../assistant/settings.ts');
    const AT = await import('../assistant/agents/test.ts');
    await S.addCustomAgent(customAgent());
    let release = () => {};
    try {
      const allow = async () => S.setAgentAllowed(CUSTOM_ID, { fingerprint: await fingerprintOf(CUSTOM_ID, await S.loadSettings()) });
      const before = custom.records().length;
      const runs = [
        ['test', (o) => AT.agentTestRequest({ id: CUSTOM_ID, message: true }, o)],
        ['connect', (o) => AT.agentTestRequest({ id: CUSTOM_ID, message: false }, o)],
        ['sign-in', (o) => AT.agentSignInRequest({ id: CUSTOM_ID, method: 'browser' }, o)],
      ];
      for (const [name, run] of runs) {
        await allow();
        let enter;
        const entered = new Promise((r) => (enter = r));
        const gate = new Promise((r) => (release = r));
        let checks = 0;
        const mcp = async () => {
          checks += 1;
          if (checks === 1) {
            enter();
            await gate;
          }
          return { available: true, reason: null };
        };
        const pending = run({ mcp, proven: () => true });
        await entered;
        await S.setAgentAllowed(CUSTOM_ID, null);
        await host.stopAgent(CUSTOM_ID, 'Scripted was turned off in Settings.');
        release();
        const r = await pending;
        assert.deepEqual([r.status, r.body.code], [409, 'agent_not_allowed'], `${name}: ${JSON.stringify(r.body)}`);
        assert.equal(checks, 2, `${name}: checked again`);
      }
      assert.equal(custom.records().length, before, 'never started');
      assert.equal(host.count(), 0);
    } finally {
      release();
      await S.removeCustomAgent(CUSTOM_ID);
      await w.close();
    }
  });

  it('two agents at once: a third is refused 429 agents_busy; an idle one makes room', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const a = await w.turn({ text: 'one', provider: 'agent:claude' });
      assert.equal(a.status, 202, JSON.stringify(a.body));
      claude.script({ hold: 'busy-1' });
      custom.script({ hold: 'busy-2' });
      const b = await w.turn({ text: 'two', provider: `agent:${CUSTOM_ID}` });
      assert.equal(a.status, 202);
      assert.equal(b.status, 202);
      await holding(claude, 'busy-1');
      await holding(custom, 'busy-2');
      const c = await w.turn({ text: 'three', provider: 'agent:claude' });
      assert.deepEqual([c.status, c.body.code, c.body.error], [429, 'agents_busy', 'Two coding agents are already working. Wait for one to finish, or stop one.']);
      claude.release('busy-1');
      await settledTurn(a.turn);
      // The first agent is idle now: a new conversation ends it and takes its slot.
      const idlePid = lastPid(claude);
      const d = await w.turn({ text: 'three', provider: 'agent:claude' });
      assert.equal(d.status, 202, JSON.stringify(d.body));
      claude.script({ say: 'third' });
      assert.equal(d.status, 202, JSON.stringify(d.body));
      await gone(idlePid);
      custom.release('busy-2');
      await settledTurn(d.turn);
      await settledTurn(b.turn);
      assert.equal(endOf(d.turn).state, 'done');
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Privacy
// ------------------------------------------------------------------------------------------------

describe('privacy for agent:<id> (spec 4.14)', LIMIT, () => {
  it('Never send: refused with a project; from Home only for an agent whose own tools are on', async () => {
    const w = await world({ privacy: 'deny', custom: true, allow: [CUSTOM_ID] });
    try {
      const withProject = await w.turn({ text: 'x', provider: 'agent:claude', tab: 'tab-1' });
      assert.deepEqual([withProject.status, withProject.body.code], [400, 'privacy_denied']);
      assert.equal(
        withProject.body.error,
        'Settings → Assistant is set to never send project data off this PC, and Claude Code sends what it reads to its own service. Ask from Home, use a local server, or change the setting.',
      );
      const ownTools = await w.turn({ text: 'x', provider: `agent:${CUSTOM_ID}` });
      assert.deepEqual([ownTools.status, ownTools.body.code], [400, 'privacy_denied']);
      assert.equal(ownTools.body.error, 'Scripted can read your project files with its own tools, and Settings → Assistant is set to never send project data off this PC.');
      const home = await w.turn({ text: 'x', provider: 'agent:claude' });
      assert.equal(home.status, 202, JSON.stringify(home.body));
      claude.script({ say: 'home' });
      assert.equal(home.status, 202, 'an agent whose own tools are off may work from Home');
      await settledTurn(home.turn);
    } finally {
      await w.close();
    }
  });

  it('Ask: one question before the session (no agent runs until it is answered), only the window answers it, and Send is remembered for agent:<id>', async () => {
    const w = await world({ privacy: 'ask' });
    try {
      const before = claude.pids('agent').length;
      const r = await w.turn({ text: 'Read.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ call: { tool: 'ai-demo__get_count', args: {} } });
      const g = await gateOf(r.turn);
      assert.deepEqual([g.kind, g.link_only, g.title], ['privacy', true, 'Send project "Secret Wing" to Claude Code?']);
      assert.equal(
        g.copy,
        "The Assistant's coding agent, Claude Code, is about to read this project's names, settings, results and pictures of the open workspace and send them to its own service under your account. Settings → Assistant can change this.",
      );
      assert.equal(r.turn.state, 'awaiting_consent');
      assert.equal(claude.pids('agent').length, before, 'no agent before the answer: it never lists the project’s tools without consent');
      // The answer key can't answer it (the agent, or another program, could hold it).
      const byKey = w.m.manager.answerGate(g.id, true, { kind: 'key', key: r.turn.answerKey });
      assert.deepEqual([byKey.status, byKey.body.code], [403, 'not_shown']);
      assert.equal(byTab(w, g, true).status, 200);
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      assert.deepEqual(w.m.consents, [{ projectId: 'p1', createdAt: PROJECT.created_at, destination: 'agent:claude' }]);
      // Remembered: the next turn asks nothing.
      const again = await w.turn({ text: 'Again.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(again.status, 202, JSON.stringify(again.body));
      claude.script({ say: 'again' });
      await settledTurn(again.turn);
      assert.ok(!typesOf(again.turn).includes('gate'));
    } finally {
      await w.close();
    }
  });

  it("Don't send: stopped, nothing sent, no agent started", async () => {
    const w = await world({ privacy: 'ask' });
    try {
      const before = claude.pids('agent').length;
      const r = await w.turn({ text: 'Read.', provider: 'agent:claude', tab: 'tab-1' });
      byTab(w, await gateOf(r.turn), false);
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['stopped', 'privacy', 'Nothing was sent.']);
      assert.equal(claude.pids('agent').length, before);
    } finally {
      await w.close();
    }
  });

  it('Stop while the privacy question is open: stopped as Stop says; the switch going off then: stopped with its text; no agent starts', async () => {
    const w = await world({ privacy: 'ask', custom: true, allow: [CUSTOM_ID] });
    try {
      const before = claude.pids('agent').length;
      const r = await w.turn({ text: 'Read.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await gateOf(r.turn);
      await w.m.manager.stop(r.turn.id, CEILING);
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['stopped', 'user', 'Stopped.']);
      assert.equal(claude.pids('agent').length, before, 'no agent started');
      const customBefore = custom.pids('agent').length;
      const r2 = await w.turn({ text: 'Read.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      await gateOf(r2.turn);
      // What POST /agents/allow {allow:false} does after saving the switch off.
      await host.stopAgent(CUSTOM_ID, 'Scripted was turned off in Settings.');
      await settledTurn(r2.turn);
      const e2 = endOf(r2.turn);
      assert.deepEqual([e2.state, e2.reason, e2.message], ['stopped', 'agent_off', 'Scripted was turned off in Settings.']);
      assert.equal(custom.pids('agent').length, customBefore, 'no agent started');
      assert.deepEqual(w.m.consents, []);
    } finally {
      await w.close();
    }
  });

  it('Ask, with a project but no app tab (a Home turn naming one): nobody could answer, so it ends at once, with no question and no agent', async () => {
    const w = await world({ privacy: 'ask' });
    try {
      const before = claude.pids('agent').length;
      const r = await w.turn({ text: 'Read.', provider: 'agent:claude', context: { project_id: 'p1' } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await H.until(() => r.turn.ended || r.turn.summary().open_gates.length > 0, CEILING, 'the turn to end or ask');
      assert.deepEqual(r.turn.summary().open_gates, [], 'no question that nobody can answer');
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['stopped', 'privacy']);
      assert.equal(e.message, "Sending this project to Claude Code needs your answer in the Magnusim window, so ask from the project's window. Nothing was sent.");
      assert.ok(!typesOf(r.turn).includes('gate'));
      assert.equal(claude.pids('agent').length, before, 'no agent started');
    } finally {
      await w.close();
    }
  });

  it('Always deny chosen mid-turn: the next project call is refused and the turn ends after it', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'Go.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ call: { tool: 'ai-demo__get_count', args: {} } }, { hold: 'deny-now' }, { call: { tool: 'ai-demo__add', args: { by: 1 } } }, { say: 'after' });
      await holding(claude, 'deny-now');
      w.m.state.settings.privacy = 'deny';
      claude.release('deny-now');
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['stopped', 'privacy', 'Nothing more was sent.']);
      assert.deepEqual(w.invoked.map((c) => c.tool), ['get_count'], 'the add never ran');
      const result = claude.events('mcp_result', lastPid(claude)).at(-1);
      assert.match(result.result.content[0].text, /"code":"privacy_denied"/);
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Limits
// ------------------------------------------------------------------------------------------------

describe('limits for agent turns (spec 4.10)', LIMIT, () => {
  it('changes: past the limit change calls answer capped, reads go on', async () => {
    const w = await world({ settings: { agent_caps: { changes: 2, calls: 400, turn_minutes: 60 } } });
    try {
      const add = { call: { tool: 'ai-demo__add', args: { by: 1 } } };
      const r = await w.turn({ text: 'Add thrice.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(add, add, add, { call: { tool: 'ai-demo__get_count', args: {} } });
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      assert.deepEqual(w.invoked.map((c) => c.tool), ['add', 'add', 'get_count']);
      const third = claude.events('mcp_result', lastPid(claude)).filter((x) => x.tool === 'ai-demo__add')[2];
      assert.equal(third.result.isError, true);
      assert.match(third.result.content[0].text, /"code":"capped".*This message reached its 2-change limit\. Stop and tell the person what is left/);
    } finally {
      await w.close();
    }
  });

  it('calls: past the limit every call answers capped, and 5 more end the turn capped/agent_calls with session/cancel', async () => {
    const w = await world({ settings: { agent_caps: { changes: 24, calls: 10, turn_minutes: 60 } } });
    try {
      const read = { call: { tool: 'ai-demo__get_count', args: {} } };
      const r = await w.turn({ text: 'Read a lot.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(...Array.from({ length: 20 }, () => read));
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['capped', 'agent_calls']);
      assert.equal(w.invoked.length, 10);
      const pid = lastPid(claude);
      assert.ok(methodsIn(claude, pid).includes('session/cancel'));
      const capped = claude.events('mcp_result', pid).filter((x) => x.result?.isError && /"code":"capped"/.test(x.result.content[0].text));
      assert.ok(capped.length >= 5);
    } finally {
      await w.close();
    }
  });

  it('minutes: an agent that only streams text (no call open) is cancelled and the turn ends capped/turn_minutes (fake clock)', async () => {
    const w = await world({ settings: { agent_caps: { changes: 24, calls: 400, turn_minutes: 1 } } });
    try {
      const r = await w.turn({ text: 'Think.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ say: 'Thinking out loud.' }, { hold: 'forever' });
      await holding(claude, 'forever');
      await H.until(() => typesOf(r.turn).includes('text'), CEILING, 'the text');
      w.m.clock.advance(60_000);
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['capped', 'turn_minutes', 'Stopped after 1 minute of work.']);
      assert.ok(methodsIn(claude, lastPid(claude)).includes('session/cancel'));
    } finally {
      claude.release('forever');
      await w.close();
    }
  });

  it('a waiting own-tool question does not count toward the minutes', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID], settings: { agent_caps: { changes: 24, calls: 400, turn_minutes: 1 } } });
    try {
      const r = await w.turn({ text: 'List.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ askOwn: { title: 'ls', kind: 'execute', rawInput: { command: 'ls' } } }, { say: 'listed' });
      const g = await gateOf(r.turn);
      w.m.clock.advance(3 * 60_000);
      assert.equal(r.turn.ended, false, 'three minutes waiting on the question: still running');
      byTab(w, g, true);
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Stop
// ------------------------------------------------------------------------------------------------

describe('Stop and the tree kill (spec 4.11, 7.7)', LIMIT, () => {
  it('Stop mid-tool: the call is aborted, session/cancel, the turn ends stopped, and the agent stays for the next message', async () => {
    let started;
    const inTool = new Promise((r) => (started = r));
    const w = await world({ invoke: slowInvoke(started) });
    try {
      const r = await w.turn({ text: 'Slowly.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ call: { tool: 'ai-demo__slow_add', args: { by: 1 } } }, { say: 'never' });
      await inTool;
      const stop = await w.m.manager.stop(r.turn.id, CEILING);
      assert.equal(stop.body.turn.state, 'stopped');
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['stopped', 'user', 'Stopped.']);
      const res = H.eventsOf(r.turn).find((x) => x.type === 'tool_result');
      assert.equal(res.code, 'stopped');
      const pid = lastPid(claude);
      assert.ok(methodsIn(claude, pid).includes('session/cancel'));
      await settledTurn(r.turn);
      const again = await w.turn({ text: 'Next.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(again.status, 202, JSON.stringify(again.body));
      claude.script({ say: 'next' });
      await settledTurn(again.turn);
      assert.equal(lastPid(claude), pid, 'the same agent');
      assert.ok(!H.eventsOf(again.turn).some((x) => x.type === 'note' && /started again/.test(x.text)));
    } finally {
      await w.close();
    }
  });

  it('Stop while a permission request is open: it is answered cancelled before session/cancel, and its question withdrawn', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'Clean.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ askOwn: { title: 'rm -rf build', kind: 'delete', rawInput: { path: 'build' } } }, { say: 'never' });
      const g = await gateOf(r.turn);
      await w.m.manager.stop(r.turn.id, CEILING);
      await settledTurn(r.turn);
      const pid = lastPid(custom);
      const got = custom.received(pid);
      const reply = got.findIndex(isPermissionReply);
      const cancel = got.findIndex(isCancel);
      assert.ok(reply >= 0 && cancel >= 0, 'both sent');
      assert.ok(reply < cancel, 'the permission answered before session/cancel');
      assert.deepEqual(got[reply].result.outcome, { outcome: 'cancelled' });
      const closed = H.eventsOf(r.turn).find((x) => x.type === 'gate_closed');
      assert.deepEqual([closed.gate, closed.by], [g.id, 'stop']);
      const perm = H.eventsOf(r.turn).find((x) => x.type === 'agent_permission');
      assert.deepEqual([perm.outcome, perm.by], ['cancelled', 'stop']);
    } finally {
      await w.close();
    }
  });

  it('Allow and Stop in the same tick: the first answer wins, allow_once goes before session/cancel', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'Touch.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ askOwn: { title: 'touch x', kind: 'edit' } }, { hold: 'after-allow' });
      const g = await gateOf(r.turn);
      byTab(w, g, true);
      const stopping = w.m.manager.stop(r.turn.id, CEILING);
      await stopping;
      await settledTurn(r.turn);
      const pid = lastPid(custom);
      const got = custom.received(pid);
      const reply = got.findIndex(isPermissionReply);
      assert.deepEqual(got[reply].result.outcome, { outcome: 'selected', optionId: 'allow' });
      assert.ok(reply < got.findIndex(isCancel));
    } finally {
      custom.release('after-allow');
      await w.close();
    }
  });

  it('a stubborn agent (it ignores the cancel): tree-killed after the cancel wait, the turn stopped; calls after Stop never run', async () => {
    const w = await world({ cancelMs: 3_000 });
    try {
      const r = await w.turn({ text: 'Ignore me.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script('ignoreCancel', { spawnHelpers: 2 }, { hold: 'stubborn' }, { call: { tool: 'ai-demo__add', args: { by: 1 } } });
      await holding(claude, 'stubborn');
      const pid = lastPid(claude);
      const helpers = claude.pids('helper').map((p) => p.pid);
      assert.equal(helpers.length, 2);
      const stop = w.m.manager.stop(r.turn.id, CEILING);
      await H.until(() => methodsIn(claude, pid).includes('session/cancel'), CEILING, 'session/cancel');
      // The call it makes after Stop is refused, and never reaches the workspace.
      claude.release('stubborn');
      await claude.waitFor((x) => x.event === 'mcp_result' && claude.of(pid)(x), CEILING);
      assert.match(claude.events('mcp_result').at(-1).result.content[0].text, /"code":"stopped".*Stopped by the user before this ran\./);
      assert.deepEqual(w.invoked, []);
      await stop;
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'stopped');
      // A second stubborn turn: no answer at all, the kill after the cancel wait (fake clock).
      const r2 = await w.turn({ text: 'Ignore me again.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script('ignoreCancel', { hold: 'stubborn-2' });
      await holding(claude, 'stubborn-2');
      const pid2 = lastPid(claude);
      const stop2 = w.m.manager.stop(r2.turn.id, CEILING);
      await H.until(() => methodsIn(claude, pid2).includes('session/cancel'), CEILING, 'session/cancel');
      assert.ok(alive(pid2), 'not killed before the wait');
      w.m.clock.advance(3_000);
      await stop2;
      await settledTurn(r2.turn);
      assert.deepEqual([endOf(r2.turn).state, endOf(r2.turn).reason], ['stopped', 'user']);
      await gone(pid2);
      for (const h of helpers) await gone(h);
    } finally {
      claude.release('stubborn-2');
      await w.close();
    }
  });

  it('a call the agent queued behind a running call of a message that was stopped never runs in the next message', async () => {
    let finish;
    const slowDone = new Promise((r) => (finish = r));
    let started;
    const inTool = new Promise((r) => (started = r));
    // The slow tool ignores its abort: it holds the connection's queue until the test lets it go.
    const w = await world({
      invoke: (call) => {
        if (call.tool === 'slow_add') {
          started();
          return slowDone;
        }
        return { ok: true, data: { counter: 2 }, summary: 'ran' };
      },
    });
    try {
      const r = await w.turn({ text: 'Two at once.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      // Both calls at once; it answers the cancel at once and never cancels them on the MCP server.
      claude.script({ calls: [{ tool: 'ai-demo__slow_add', args: { by: 1 } }, { tool: 'ai-demo__add', args: { by: 5 } }] });
      await inTool;
      // The second call has reached the server too (it waits behind the first).
      await H.until(() => L.mcpConnections().some((c) => c.kind === 'agent' && c.calls >= 2), CEILING, 'the queued call');
      const pid = lastPid(claude);
      const stop = await w.m.manager.stop(r.turn.id, CEILING);
      assert.equal(stop.body.turn.state, 'stopped');
      await settledTurn(r.turn);
      // The next message starts on the same agent while the slow call still holds the queue.
      const r2 = await w.turn({ text: 'Next.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ hold: 'f12-next' }, { say: 'next' });
      await holding(claude, 'f12-next');
      assert.equal(lastPid(claude), pid, 'the same agent');
      // The slow call ends: the call queued behind it (the stopped message's) answers stopped.
      finish({ ok: true, data: { counter: 1 }, summary: 'ran late' });
      const queued = await claude.waitFor((x) => x.event === 'mcp_result' && x.tool === 'ai-demo__add' && claude.of(pid)(x), CEILING);
      assert.match(queued.result.content[0].text, /"code":"stopped"/);
      assert.deepEqual(w.invoked.map((c) => [c.tool, c.turn]), [['slow_add', r.turn.id]], 'nothing ran in the next message');
      assert.ok(!H.eventsOf(r2.turn).some((x) => x.type === 'tool_call'), 'no call in the next message');
      claude.release('f12-next');
      await settledTurn(r2.turn);
      assert.equal(endOf(r2.turn).state, 'done');
    } finally {
      finish({ ok: false, error: { code: 'aborted', message: 'aborted' }, summary: 'aborted' });
      claude.release('f12-next');
      await w.close();
    }
  });

  it('Stop, then the agent crashes instead of answering the cancel: the turn ends stopped, and its whole tree goes (helpers, job, working folder)', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'Crash.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script('ignoreCancel', { spawnHelpers: 1 }, { hold: 'crash-after-stop' }, 'crash');
      await holding(claude, 'crash-after-stop');
      const pid = lastPid(claude);
      const helper = claude.pids('helper').at(-1).pid;
      const session = host.sessionOf(r.body.conversation);
      assert.ok(session?.proc, 'its session');
      const stop = w.m.manager.stop(r.turn.id, CEILING);
      await H.until(() => methodsIn(claude, pid).includes('session/cancel'), CEILING, 'session/cancel');
      claude.release('crash-after-stop');
      await stop;
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['stopped', 'user']);
      await gone(pid);
      await gone(helper);
      if (session.proc.keeper?.pid) await gone(session.proc.keeper.pid);
      await H.until(() => session.proc.stopped && !existsSync(session.proc.cwd), CEILING, 'the tree kill and its folder');
      assert.equal(host.sessionOf(r.body.conversation), null);
    } finally {
      claude.release('crash-after-stop');
      await w.close();
    }
  });

  it('a turn that crashes mid-prompt: session/cancel, then the tree kill after the cancel wait when the agent doesn’t answer', async () => {
    const w = await world({ cancelMs: 3_000 });
    try {
      const r = await w.turn({ text: 'Hold.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script('ignoreCancel', { hold: 'crash-hold' });
      await holding(claude, 'crash-hold');
      const pid = lastPid(claude);
      r.turn.crash(new Error('boom'));
      assert.deepEqual([endOf(r.turn).state, endOf(r.turn).reason], ['failed', 'internal']);
      await H.until(() => methodsIn(claude, pid).includes('session/cancel'), CEILING, 'session/cancel');
      assert.ok(alive(pid));
      w.m.clock.advance(3_000);
      await gone(pid);
    } finally {
      claude.release('crash-hold');
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Permissions, modes and the lockdown
// ------------------------------------------------------------------------------------------------

describe("the agent's own tools, its mode and the lockdown (spec 4.7, 4.8)", LIMIT, () => {
  it('a mode outside the allowed ones stops the turn (agent_mode) and ends the agent', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'Plan.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ switchMode: 'plan' }, { hold: 'never' });
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['failed', 'agent_mode', 'Claude Code switched itself to a mode that skips its questions, so Magnusim stopped it.']);
      await gone(lastPid(claude));
    } finally {
      claude.release('never');
      await w.close();
    }
  });

  it('a mode outside the allowed ones between messages: the agent ends at once, and the next message starts it again with a note why', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'One.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ say: 'one' }, { later: { hold: 'mode-later', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } } });
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      const pid = lastPid(claude);
      const session = host.sessionOf(r.body.conversation);
      assert.deepEqual([session.alive, session.mode], [true, 'default']);
      // After its answer, between prompts: it switches itself to plan.
      claude.release('mode-later');
      await H.until(() => !session.alive || session.mode === 'plan', CEILING, 'the mode update');
      const r2 = await w.turn({ text: 'Two.', provider: 'agent:claude', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ say: 'two' });
      await settledTurn(r2.turn);
      assert.equal(endOf(r2.turn).state, 'done');
      assert.notEqual(lastPid(claude), pid, 'a new agent: the one in plan is never prompted again');
      assert.equal(claude.received(pid).filter((m) => m.method === 'session/prompt').length, 1);
      const notes = H.eventsOf(r2.turn).filter((x) => x.type === 'note').map((x) => x.text);
      assert.ok(notes.includes("Claude Code was started again, so it doesn't remember this conversation's earlier messages."), JSON.stringify(notes));
      assert.ok(notes.includes('Claude Code switched itself to a mode that skips its questions, so Magnusim stopped it.'), JSON.stringify(notes));
      await gone(pid);
    } finally {
      claude.release('mode-later');
      await w.close();
    }
  });

  it('a mode outside the allowed ones after its start, before its first prompt: the turn ends agent_mode and the agent is never prompted', async () => {
    const w = await world();
    const real = w.m.deps.settings;
    let enter;
    const entered = new Promise((r) => (enter = r));
    let release;
    const gate = new Promise((r) => (release = r));
    // Holds the turn's settings read between its session's start and its prompt (its session ready).
    w.m.deps.settings = async () => {
      if (Object.values(host.snapshot()).some((x) => x.in_use && x.state === 'ready')) {
        enter();
        await gate;
      }
      return real();
    };
    try {
      const r = await w.turn({ text: 'Plan.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await entered;
      const session = host.sessionOf(r.body.conversation);
      const pid = lastPid(claude);
      // The agent's notification, as its pipe delivers it, while no prompt runs.
      session['onNotification']('session/update', { sessionId: session.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } });
      release();
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['failed', 'agent_mode', 'Claude Code switched itself to a mode that skips its questions, so Magnusim stopped it.']);
      assert.ok(!methodsIn(claude, pid).includes('session/prompt'), 'never prompted');
      await gone(pid);
    } finally {
      release();
      w.m.deps.settings = real;
      await w.close();
    }
  });

  it('between messages, its own tool (own tools off) trips the lockdown: ended at once and recorded; a late update of Magnusim’s own tool does not', async () => {
    const w = await world();
    const S = await import('../assistant/settings.ts');
    try {
      const r = await w.turn({ text: 'Add.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(
        { call: { tool: 'ai-demo__add', args: { by: 1 } } },
        // Its call's last update again, without the fields (the session remembers its id), then a marker.
        { later: { hold: 'ours-later', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' } } },
        { later: { update: { sessionUpdate: 'current_model_update', currentModelId: 'fake-small' } } },
      );
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      const pid = lastPid(claude);
      const session = host.sessionOf(r.body.conversation);
      claude.release('ours-later');
      await H.until(() => session.model === 'fake-small' || !session.alive, CEILING, 'the late updates');
      assert.equal(session.alive, true, 'a late update of our own tool is no tripwire');
      const r2 = await w.turn({ text: 'Again.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ say: 'again' }, { later: { hold: 'own-later', update: { sessionUpdate: 'tool_call', toolCallId: 'own-z', title: 'Bash rm -rf ~', kind: 'execute', status: 'pending' } } });
      await settledTurn(r2.turn);
      assert.equal(endOf(r2.turn).state, 'done');
      assert.equal(lastPid(claude), pid, 'the same agent');
      claude.release('own-later');
      await gone(pid);
      const saved = await H.until(() => {
        const doc = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
        return doc.agents?.claude?.lockdown_failed ? doc : null;
      }, CEILING, 'the tripwire record');
      const row = D.agentRow(await D.resolveAgentNow('claude', saved), { settings: saved, mcp: { available: true, reason: null }, appVersion: saved.agents.claude.lockdown_failed.version });
      assert.deepEqual([row.lockdown, row.needs_allow, row.reason], ['none', true, 'agent_not_allowed']);
      // The next message (these settings don't have the record) says why its agent was started again.
      const r3 = await w.turn({ text: 'Three.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r3.status, 202, JSON.stringify(r3.body));
      claude.script({ say: 'three' });
      await settledTurn(r3.turn);
      assert.ok(H.eventsOf(r3.turn).some((x) => x.type === 'note' && x.text === "Claude Code's own tools were not off as expected, so Magnusim stopped it. It now needs Allow this agent in Settings → Assistant."));
    } finally {
      claude.release('ours-later');
      claude.release('own-later');
      await S.setAgentLockdownFailed('claude', null);
      await w.close();
    }
  });

  it('the lockdown tripwire: a tools-off agent asking for a tool that isn’t ours is answered reject_once, the turn ends agent_lockdown, and it needs its switch from then on', async () => {
    const w = await world();
    const S = await import('../assistant/settings.ts');
    try {
      // A title (or input) that names one of our tools counts for nothing: only the adapter's fields do.
      const options = [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ];
      const r = await w.turn({ text: 'Run.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(
        { request: { method: 'session/request_permission', params: { toolCall: { toolCallId: 'own-1', title: 'mcp.magnusim.app_status', kind: 'execute', rawInput: { command: 'magnusim_app_status' } }, options } } },
        { say: 'never' },
      );
      await settledTurn(r.turn);
      const pid = lastPid(claude);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['failed', 'agent_lockdown']);
      assert.equal(e.message, "Claude Code's own tools were not off as expected, so Magnusim stopped it. It now needs Allow this agent in Settings → Assistant.");
      const answered = await claude.waitFor((x) => x.event === 'request_answer' && claude.of(pid)(x), CEILING);
      assert.deepEqual(answered.answer.result.outcome, { outcome: 'selected', optionId: 'reject' });
      await gone(pid);
      const saved = await H.until(() => {
        const doc = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
        return doc.agents?.claude?.lockdown_failed ? doc : null;
      }, CEILING, 'the tripwire record');
      const row = D.agentRow(await D.resolveAgentNow('claude', saved), { settings: saved, mcp: { available: true, reason: null }, appVersion: saved.agents.claude.lockdown_failed.version });
      assert.deepEqual([row.lockdown, row.needs_allow, row.reason], ['none', true, 'agent_not_allowed']);
      // An own tool's update trips it too.
      const r2 = await w.turn({ text: 'Run.', provider: 'agent:claude' });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ ownTool: { title: 'Bash ls', kind: 'execute', status: 'pending' } }, { hold: 'never' });
      await settledTurn(r2.turn);
      assert.deepEqual([endOf(r2.turn).state, endOf(r2.turn).reason], ['failed', 'agent_lockdown']);
      await gone(lastPid(claude));
    } finally {
      claude.release('never');
      await S.setAgentLockdownFailed('claude', null);
      await w.close();
    }
  });

  it('the list changes under a tools-off agent (its tab’s link drops): a call of a tool that left the list, its updates and its permission requests (in a prompt, between messages, while it starts) are Magnusim’s, never the tripwire; nothing is recorded and the agent stays', async () => {
    const w = await world();
    const ST = await import('../assistant/settings.ts');
    const T = await import('../assistant/agents/turn.ts');
    const LINK = 'a'.repeat(24);
    const ours = (tool) => ({ claudeCode: { toolName: `mcp__magnusim__${tool}`, mcpServer: { name: 'magnusim', source: 'config' } } });
    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ];
    /** A permission request for a tool of Magnusim's server, as the adapter sends it. */
    const askFor = (id, tool) => ({ method: 'session/request_permission', params: { toolCall: { toolCallId: id, title: `mcp__magnusim__${tool}`, kind: 'other', _meta: ours(tool) }, options } });
    const NOT_OFFERED = "Claude Code asked to use a Magnusim tool that doesn't match one offered to it now (they change when a window's link drops or a workspace closes), so Magnusim said no.";
    // Every question opened in this test (there must be none: these aren't the agent's own tools).
    const asked = [];
    const offAsked = w.m.manager.gates.subscribe((e) => {
      if (e.type === 'open') asked.push(e.view.title);
    });
    try {
      const r = await w.turn({ text: 'Count, then add.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script(
        { call: { tool: 'ai-demo__get_count', args: {} } },
        { hold: 'f4-link-drops' },
        // It lists again (as it does on list_changed): the workspace's tools are gone.
        { relist: true },
        // The model's call of a tool it had: its tool_call, the call (refused), its failed update.
        { call: { tool: 'ai-demo__add', args: { by: 1 } } },
        // Its permission requests for that tool: answered no at once, never asked as its own tool.
        { askOurs: { tool: 'ai-demo__add' } },
        { askOurs: { tool: 'ai-demo__add' } },
        { say: 'done' },
        // Between messages: a late update naming that tool, its permission request, then a marker.
        { later: { hold: 'f4-later', update: { sessionUpdate: 'tool_call_update', toolCallId: 'late-1', status: 'completed', _meta: ours('ai-demo__add') } } },
        { later: { request: askFor('late-2', 'ai-demo__add') } },
        { later: { update: { sessionUpdate: 'current_model_update', currentModelId: 'fake-small' } } },
      );
      await holding(claude, 'f4-link-drops');
      const pid = lastPid(claude);
      // The tab's relay link drops: its workspace's tools leave the list (list_changed).
      w.m.registry.setConnected('tab-1', LINK, false);
      claude.release('f4-link-drops');
      const relisted = await claude.waitFor((x) => x.event === 'mcp_tools' && x.relisted === true && claude.of(pid)(x), CEILING);
      assert.ok(!relisted.tools.includes('ai-demo__add'), JSON.stringify(relisted.tools));
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason], ['done', 'end_turn'], e.message);
      const refused = claude.events('mcp_result', pid).find((x) => x.tool === 'ai-demo__add');
      assert.match(refused.result.content[0].text, /"code":"no_tool"/);
      assert.deepEqual(w.invoked.map((c) => c.tool), ['get_count'], 'the tool that left the list never ran');
      assert.deepEqual(
        claude.events('permission_outcome', pid).map((x) => x.outcome),
        [
          { outcome: 'selected', optionId: 'reject' },
          { outcome: 'selected', optionId: 'reject' },
        ],
      );
      // Magnusim said no, and says why once; nothing asked the person about "its own tool".
      assert.deepEqual(asked, [], 'no question');
      const events = H.eventsOf(r.turn);
      assert.deepEqual(
        events.filter((x) => x.type === 'agent_permission').map((x) => [x.title, x.outcome, x.by]),
        [
          ['ai-demo__add', 'declined', 'magnusim'],
          ['ai-demo__add', 'declined', 'magnusim'],
        ],
      );
      assert.deepEqual(events.filter((x) => x.type === 'note').map((x) => x.text), [NOT_OFFERED]);
      assert.equal(T.NOT_OFFERED_NOTE('Claude Code'), NOT_OFFERED);
      // Between messages, the late update of that tool and its permission request are Magnusim's too.
      const session = host.sessionOf(r.body.conversation);
      claude.release('f4-later');
      await H.until(() => session.model === 'fake-small' || !session.alive, CEILING, 'the late updates');
      assert.equal(session.alive, true, 'no tripwire between messages either');
      assert.ok(alive(pid));
      const late = claude.events('request_answer', pid).find((x) => x.method === 'session/request_permission');
      assert.deepEqual(late?.answer?.result?.outcome, { outcome: 'cancelled' }, 'answered cancelled between messages');
      // Nothing recorded: the next message runs on the same agent, still with its own tools off.
      const recorded = () => (existsSync(join(HOME, 'assistant', 'settings.json')) ? JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8')) : {}).agents?.claude?.lockdown_failed ?? null;
      assert.equal(recorded(), null, 'no tripwire record');
      w.m.registry.setConnected('tab-1', LINK, true);
      const r2 = await w.turn({ text: 'Again.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ relist: true }, { call: { tool: 'ai-demo__get_count', args: {} } }, { say: 'again' });
      await settledTurn(r2.turn);
      assert.deepEqual([endOf(r2.turn).state, endOf(r2.turn).reason], ['done', 'end_turn']);
      assert.equal(lastPid(claude), pid, 'the same agent');
      // While it starts (a new conversation, from Home, whose list never had the workspace's
      // tools): a request for a tool of Magnusim's server it isn't offered isn't the tripwire
      // either; in its prompt the same request is answered no at once, without the Home note
      // about its own tools.
      claude.configure({ afterSessionNew: [{ request: askFor('start-1', 'ai-demo__add') }] });
      const r3 = await w.turn({ text: 'From Home.', provider: 'agent:claude' });
      assert.equal(r3.status, 202, JSON.stringify(r3.body));
      claude.script({ askOurs: { tool: 'ai-demo__add' } }, { say: 'home' });
      await settledTurn(r3.turn);
      assert.deepEqual([endOf(r3.turn).state, endOf(r3.turn).reason], ['done', 'end_turn'], endOf(r3.turn).message);
      const pid3 = lastPid(claude);
      assert.notEqual(pid3, pid);
      const started = claude.events('request_answer', pid3).find((x) => x.method === 'session/request_permission');
      assert.deepEqual(started?.answer?.result?.outcome, { outcome: 'cancelled' }, 'answered cancelled while it started');
      assert.deepEqual(claude.events('permission_outcome', pid3).map((x) => x.outcome), [{ outcome: 'selected', optionId: 'reject' }]);
      assert.deepEqual(H.eventsOf(r3.turn).filter((x) => x.type === 'note').map((x) => x.text), [NOT_OFFERED]);
      assert.deepEqual(asked, [], 'no question');
      assert.equal(host.sessionOf(r3.body.conversation)?.alive, true);
      assert.equal(recorded(), null, 'no tripwire record');
    } finally {
      offAsked();
      claude.configure({ afterSessionNew: null });
      claude.release('f4-link-drops');
      claude.release('f4-later');
      await ST.setAgentLockdownFailed('claude', null);
      await w.close();
    }
  });

  it('a tools-off agent that uses its own tool while it starts (a tool or a permission request before its first prompt): the start fails agent_lockdown, recorded, and it is never prompted', async () => {
    const ST = await import('../assistant/settings.ts');
    const record = () => H.until(() => {
      const doc = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
      return doc.agents?.claude?.lockdown_failed ? doc : null;
    }, CEILING, 'the tripwire record');
    const cases = [
      { update: { sessionUpdate: 'tool_call', toolCallId: 'own-start', title: 'Bash ls', kind: 'execute', status: 'completed' } },
      { request: { method: 'session/request_permission', params: { toolCall: { toolCallId: 'own-start-2', title: 'Bash rm -rf ~', kind: 'execute' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } } },
    ];
    for (const step of cases) {
      const w = await world();
      claude.configure({ afterSessionNew: [step] });
      try {
        const r = await w.turn({ text: 'Start.', provider: 'agent:claude' });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        await settledTurn(r.turn);
        const e = endOf(r.turn);
        assert.deepEqual([e.state, e.reason, e.message], ['failed', 'agent_lockdown', "Claude Code's own tools were not off as expected, so Magnusim stopped it. It now needs Allow this agent in Settings → Assistant."], JSON.stringify(step));
        const pid = lastPid(claude);
        assert.ok(!methodsIn(claude, pid).includes('session/prompt'), 'never prompted');
        await gone(pid);
        const saved = await record();
        const row = D.agentRow(await D.resolveAgentNow('claude', saved), { settings: saved, mcp: { available: true, reason: null }, appVersion: saved.agents.claude.lockdown_failed.version });
        assert.deepEqual([row.lockdown, row.needs_allow], ['none', true]);
        // The next message says nothing more about it (this turn said it).
        await ST.setAgentLockdownFailed('claude', null);
        claude.configure({ afterSessionNew: null });
        const r2 = await w.turn({ text: 'Again.', provider: 'agent:claude', conversation: r.body.conversation });
        assert.equal(r2.status, 202, JSON.stringify(r2.body));
        claude.script({ say: 'again' });
        await settledTurn(r2.turn);
        assert.equal(endOf(r2.turn).state, 'done');
        assert.ok(!H.eventsOf(r2.turn).some((x) => x.type === 'note' && /own tools were not off/.test(x.text)));
      } finally {
        claude.configure({ afterSessionNew: null });
        await ST.setAgentLockdownFailed('claude', null);
        await w.close();
      }
    }
    // A Settings Test of it records the tripwire as a turn does.
    const { srv } = await serverWorld();
    claude.configure({ afterSessionNew: [cases[0]] });
    try {
      const t = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([t.json.ok, t.json.code], [false, 'agent_lockdown'], JSON.stringify(t.json));
      await record();
    } finally {
      claude.configure({ afterSessionNew: null });
      await ST.setAgentLockdownFailed('claude', null);
      await srv.close();
    }
  });

  it('a mode outside the allowed ones reported with the answer to Magnusim setting its mode at start: never overwritten; the start fails agent_mode and it is never prompted', async () => {
    const w = await world();
    claude.configure({ setModeReport: 'plan' });
    try {
      const r = await w.turn({ text: 'Plan.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['failed', 'agent_mode', 'Claude Code switched itself to a mode that skips its questions, so Magnusim stopped it.']);
      const pid = lastPid(claude);
      const sent = claude.sent(pid);
      assert.ok(sent.some((m) => m.params?.update?.sessionUpdate === 'current_mode_update' && m.params.update.currentModeId === 'plan'), 'it reported plan');
      assert.ok(!methodsIn(claude, pid).includes('session/prompt'), 'never prompted');
      await gone(pid);
    } finally {
      claude.configure({ setModeReport: null });
      await w.close();
    }
  });

  it('a turn that ended with its prompt still out (it crashed): a tools-off agent’s own tool then still trips the lockdown, recorded, and the agent ends at once', async () => {
    const w = await world({ cancelMs: 3_000 });
    const ST = await import('../assistant/settings.ts');
    try {
      const r = await w.turn({ text: 'Hold.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script('ignoreCancel', { hold: 'f23-hold' }, { ownTool: { title: 'Bash rm -rf ~', kind: 'execute', status: 'completed' } }, { hold: 'f23-after' });
      await holding(claude, 'f23-hold');
      const pid = lastPid(claude);
      r.turn.crash(new Error('boom'));
      assert.equal(r.turn.ended, true);
      await H.until(() => methodsIn(claude, pid).includes('session/cancel'), CEILING, 'session/cancel');
      // Its own tool after the turn ended (the prompt still out): the fake clock never reaches the
      // cancel wait's kill, so only the tripwire ends it.
      claude.release('f23-hold');
      await H.until(() => {
        const doc = JSON.parse(readFileSync(join(HOME, 'assistant', 'settings.json'), 'utf8'));
        return doc.agents?.claude?.lockdown_failed ?? null;
      }, CEILING, 'the tripwire record');
      await gone(pid);
      assert.equal(host.sessionOf(r.body.conversation), null, 'not kept');
    } finally {
      claude.release('f23-hold');
      claude.release('f23-after');
      await ST.setAgentLockdownFailed('claude', null);
      await w.close();
    }
  });

  it('our tool without an allow_once option becomes a question (never allow_always)', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'Add.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ askOurs: { tool: 'ai-demo__add', options: ['allow_always', 'reject_once'] } }, { say: 'ok' });
      const g = await gateOf(r.turn);
      assert.equal(g.link_only, true);
      byTab(w, g, true);
      await settledTurn(r.turn);
      const outcome = claude.events('permission_outcome').at(-1);
      assert.notDeepEqual(outcome.outcome, { outcome: 'selected', optionId: 'allow-always' });
      assert.deepEqual(outcome.outcome, { outcome: 'cancelled' });
    } finally {
      await w.close();
    }
  });

  it('an own-tool question: link_only (the answer key is refused), its title and input redacted; its tools logged as agent_tool', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'Fetch.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script(
        { ownTool: { id: 'own-a', title: 'cat notes.txt', kind: 'read', status: 'in_progress' } },
        { ownTool: { id: 'own-a', title: 'cat notes.txt', kind: 'read', status: 'completed' } },
        { askOwn: { title: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" x', kind: 'fetch', rawInput: { key: 'sk-ant-api03-SECRETSECRETSECRETSECRET', url: 'https://example.com' } } },
        { say: 'done' },
      );
      const g = await gateOf(r.turn);
      assert.deepEqual([g.kind, g.risk, g.link_only, g.yes, g.no], ['confirm', 'destructive', true, 'Allow once', "Don't"]);
      assert.equal(g.title, 'Let Scripted use its own tool (fetch)?');
      assert.equal(g.source, 'Scripted (its own tool)');
      assert.ok(!g.copy.includes('SECRETSECRET') && !g.copy.includes('abcdefghijklmnopqrstuv'), g.copy);
      assert.match(g.copy, /^Scripted asks to use one of its own tools\. Magnusim can't see or check what it does on this PC\. As the agent describes it: .*\[redacted\].*What it sent: .*\[redacted\].*Nothing runs until you choose\.$/);
      const byKey = w.m.manager.answerGate(g.id, true, { kind: 'key', key: r.turn.answerKey });
      assert.deepEqual([byKey.status, byKey.body.code], [403, 'not_shown']);
      byTab(w, g, true);
      await settledTurn(r.turn);
      const outcome = custom.events('permission_outcome').at(-1);
      assert.deepEqual(outcome.outcome, { outcome: 'selected', optionId: 'allow' });
      const tools = H.eventsOf(r.turn).filter((x) => x.type === 'agent_tool');
      assert.deepEqual(
        tools.filter((x) => x.call === 'own-a').map((x) => [x.title, x.kind, x.status]),
        [
          ['cat notes.txt', 'read', 'in_progress'],
          ['cat notes.txt', 'read', 'completed'],
        ],
      );
      const perm = H.eventsOf(r.turn).find((x) => x.type === 'agent_permission');
      assert.deepEqual([perm.outcome, perm.by], ['allowed', 'user']);
    } finally {
      await w.close();
    }
  });

  it('two own-tool questions open at once: the turn awaits confirmation until the last one is answered, whichever goes first', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'List both.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ parallel: [{ askOwn: { title: 'ls a', kind: 'execute' } }, { askOwn: { title: 'ls b', kind: 'execute' } }] }, { hold: 'f13-after' }, { say: 'done' });
      await H.until(() => r.turn.summary().open_gates.length === 2, CEILING, 'two questions');
      const pid = lastPid(custom);
      assert.equal(r.turn.state, 'awaiting_confirmation');
      const gates = r.turn.summary().open_gates;
      const first = gates.find((g) => g.tool === 'ls a');
      const second = gates.find((g) => g.tool === 'ls b');
      assert.ok(first && second, JSON.stringify(gates));
      const outcomes = () => custom.events('permission_outcome', pid);
      // The first one asked is answered first: the other is still open.
      byTab(w, first, true);
      await H.until(() => outcomes().length === 1, CEILING, 'the first answer at the agent');
      assert.deepEqual([r.turn.summary().open_gates.length, r.turn.state], [1, 'awaiting_confirmation']);
      byTab(w, second, false);
      await holding(custom, 'f13-after');
      assert.equal(outcomes().length, 2);
      assert.deepEqual([r.turn.summary().open_gates.length, r.turn.state], [0, 'model'], 'nothing is asked: back to the model');
      custom.release('f13-after');
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
    } finally {
      custom.release('f13-after');
      await w.close();
    }
  });

  it('own-tool questions nobody answers: two in a row that time out end the turn capped/unanswered; an answer between starts the count again', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    const GATE = 240_000;
    try {
      const r = await w.turn({ text: 'List.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script(
        { askOwn: { title: 'ls 1', kind: 'execute' } },
        { askOwn: { title: 'ls 2', kind: 'execute' } },
        { askOwn: { title: 'ls 3', kind: 'execute' } },
        { askOwn: { title: 'ls 4', kind: 'execute' } },
        { askOwn: { title: 'ls 5', kind: 'execute' } },
        { say: 'never' },
      );
      const open = (title) => H.until(() => r.turn.summary().open_gates.find((g) => g.tool === title), CEILING, title);
      // 1: nobody answers (it times out).
      await open('ls 1');
      const at = lastPid(custom);
      w.m.clock.advance(GATE);
      // 2: the person answers Don't: the count starts again.
      byTab(w, await open('ls 2'), false);
      // 3: times out; still running (one in a row).
      await open('ls 3');
      w.m.clock.advance(GATE);
      await open('ls 4');
      assert.equal(r.turn.ended, false, 'one unanswered question in a row: it goes on');
      // 4: times out too: two in a row end it.
      w.m.clock.advance(GATE);
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.reason, e.message], ['capped', 'unanswered', "Nobody answered Scripted's last 2 questions, so Magnusim stopped this message. Send another message to carry on."]);
      assert.ok(methodsIn(custom, at).includes('session/cancel'));
      const perms = H.eventsOf(r.turn).filter((x) => x.type === 'agent_permission').map((x) => [x.title, x.outcome, x.by]);
      assert.deepEqual(perms.slice(0, 4), [
        ['ls 1', 'declined', 'timeout'],
        ['ls 2', 'declined', 'user'],
        ['ls 3', 'declined', 'timeout'],
        ['ls 4', 'declined', 'timeout'],
      ]);
      // The agent got Don't for the last one before the cancel.
      const got = custom.received(at);
      const replies = got.map((m, i) => [m, i]).filter(([m]) => isPermissionReply(m));
      assert.deepEqual(replies[3][0].result.outcome, { outcome: 'selected', optionId: 'reject' });
      assert.ok(replies[3][1] < got.findIndex(isCancel));
    } finally {
      await w.close();
    }
  });

  it('from Home an own-tool request is answered reject_once at once, with a note', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'List.', provider: `agent:${CUSTOM_ID}` });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ askOwn: { title: 'ls', kind: 'execute' } }, { say: 'ok' });
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      assert.deepEqual(custom.events('permission_outcome').at(-1).outcome, { outcome: 'selected', optionId: 'reject' });
      assert.ok(H.eventsOf(r.turn).some((x) => x.type === 'note' && x.text === "Scripted asked to use its own tool; answer such questions in a project's Magnusim window."));
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Sessions
// ------------------------------------------------------------------------------------------------

describe('the agent session (spec 4.6)', LIMIT, () => {
  it('an agent marking our tools by its call flag: auto-allowed when correlated; it starts read-only, and still gets the binding and its environment', async () => {
    const w = await world({ provider: 'agent:codex', allow: ['codex'] });
    codex.configure({ envReport: ['DISABLE_MCP_CONFIG_FILTERING', 'INITIAL_AGENT_MODE', 'OPENAI_API_KEY', 'MAGNUSIM_TEST_ASSISTANT'] });
    try {
      const r = await w.turn({ text: 'Add.', provider: 'agent:codex', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      codex.script({ askOursCorrelated: { tool: 'ai-demo__add' } }, { call: { tool: 'ai-demo__add', args: { by: 1 } } }, { say: 'ok' });
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done', JSON.stringify(endOf(r.turn)));
      const pid = lastPid(codex);
      assert.deepEqual(codex.events('permission_outcome').at(-1).outcome, { outcome: 'selected', optionId: 'allow' });
      const env = codex.events('env').at(-1);
      assert.deepEqual(env.present.sort(), ['DISABLE_MCP_CONFIG_FILTERING', 'INITIAL_AGENT_MODE']);
      const sn = codex.received(pid).find((m) => m.method === 'session/new');
      assert.deepEqual(sn.params.mcpServers.map((s) => s.args.includes('--binding')), [true]);
      assert.equal(codex.received(pid).find((m) => m.method === 'session/set_mode').params.modeId, 'read-only');
      assert.deepEqual(H.eventsOf(r.turn).find((x) => x.type === 'agent').own_tools, 'on');
    } finally {
      codex.configure({ envReport: undefined });
      await w.close();
    }
  });

  it('the saved model is set through the session’s model option; one it doesn’t list leaves its own, with a note', async () => {
    const w = await world({ settings: { agents: { claude: { model: 'fake-small', mode: null, allowed: null, lockdown_failed: null } } } });
    try {
      const r = await w.turn({ text: 'Hi.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ say: 'small' });
      await settledTurn(r.turn);
      const set = claude.received(lastPid(claude)).find((m) => m.method === 'session/set_config_option');
      assert.deepEqual([set.params.configId, set.params.value], ['model', 'fake-small']);
      w.m.state.settings.agents = { claude: { model: 'fake-huge', mode: null, allowed: null, lockdown_failed: null } };
      const r2 = await w.turn({ text: 'Hi.', provider: 'agent:claude' });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ say: 'huge' });
      await settledTurn(r2.turn);
      assert.ok(H.eventsOf(r2.turn).some((x) => x.type === 'note' && x.text === "Claude Code didn't take the model fake-huge; it uses its own default."));
    } finally {
      await w.close();
    }
  });

  it('a later prompt carries no notes again, and a changed workspace guide adds the note once', async () => {
    const w = await world();
    try {
      const r = await w.turn({ text: 'One.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ say: 'one' });
      await settledTurn(r.turn);
      w.m.registry.setWorkspace('tab-1', 'b'.repeat(24), {
        plugin: 'ai-demo',
        pluginName: 'Workspace demo',
        workspace: 'counter',
        projectId: 'p1',
        studyId: 's1',
        epoch: '1',
        tools: H.demoTools(),
        guide: 'A newer guide.',
        invoke: async () => ({ ok: true, data: {}, summary: 'ran' }),
      });
      const r2 = await w.turn({ text: 'Two.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ say: 'two' });
      await settledTurn(r2.turn);
      const r3 = await w.turn({ text: 'Three.', provider: 'agent:claude', tab: 'tab-1', conversation: r.body.conversation });
      assert.equal(r3.status, 202, JSON.stringify(r3.body));
      claude.script({ say: 'three' });
      await settledTurn(r3.turn);
      const prompts = claude.received(lastPid(claude)).filter((m) => m.method === 'session/prompt');
      assert.equal(prompts.length, 3);
      assert.deepEqual(prompts[1].params.prompt.map((b) => b.text.slice(0, 4)), ['Two.', 'App ']);
      assert.equal(H.eventsOf(r2.turn).filter((x) => x.type === 'note' && x.text === GUIDE_CHANGED_NOTE).length, 1);
      assert.equal(H.eventsOf(r3.turn).filter((x) => x.type === 'note' && x.text === GUIDE_CHANGED_NOTE).length, 0);
    } finally {
      await w.close();
    }
  });

  it('an agent that answers session/new before its MCP server is up: the first prompt waits until Magnusim’s tools were listed to it', async () => {
    const w = await world();
    claude.configure({ mcpLate: 'f5-mcp-late' });
    try {
      const r = await w.turn({ text: 'Count.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ call: { tool: 'ai-demo__get_count', args: {} } }, { say: 'done' });
      // Its session is up, its MCP server isn't (held).
      await holding(claude, 'f5-mcp-late');
      const pid = lastPid(claude);
      const prompted = claude
        .waitFor((x) => x.dir === 'in' && x.msg?.method === 'session/prompt' && claude.of(pid)(x), CEILING)
        .then(() => 'prompted', () => 'no prompt');
      const waiting = H.until(() => host.sessionOf(r.body.conversation)?.awaitingTools === true, CEILING, 'the wait for its tools').then(() => 'waiting', () => 'no wait');
      assert.equal(await Promise.race([prompted, waiting]), 'waiting', 'no prompt before its MCP server listed the tools');
      claude.release('f5-mcp-late');
      await settledTurn(r.turn);
      assert.deepEqual([endOf(r.turn).state, endOf(r.turn).reason], ['done', 'end_turn']);
      const tools = claude.events('prompt_tools', pid).at(-1);
      assert.ok(tools?.tools?.includes('ai-demo__get_count'), JSON.stringify(tools));
      assert.deepEqual(w.invoked.map((c) => c.tool), ['get_count']);
    } finally {
      claude.configure({ mcpLate: null });
      claude.release('f5-mcp-late');
      await w.close();
    }
  });

  it('an agent whose MCP server never lists the tools: the turn ends failed/agent_no_tools after the wait (fake clock), and it is never prompted', async () => {
    const w = await world();
    const SESSION = await import('../assistant/agents/session.ts');
    claude.configure({ mcpLate: 'f5-never' });
    try {
      const r = await w.turn({ text: 'Count.', provider: 'agent:claude', tab: 'tab-1' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await holding(claude, 'f5-never');
      const pid = lastPid(claude);
      await H.until(() => host.sessionOf(r.body.conversation)?.awaitingTools === true, CEILING, 'the wait for its tools');
      w.m.clock.advance(SESSION.AGENT_TOOLS_MS);
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual(
        [e.state, e.reason, e.message],
        ['failed', 'agent_no_tools', "Claude Code didn't connect to Magnusim's tools within 15 s, so this message wasn't sent to it. Send it again; if this keeps happening, run its Test in Settings → Assistant."],
      );
      assert.ok(!methodsIn(claude, pid).includes('session/prompt'), 'never prompted');
    } finally {
      claude.configure({ mcpLate: null });
      await w.close();
      claude.release('f5-never');
    }
  });

  it('a kept agent never prompted (its first message ended waiting for its tools, or was stopped then): the next message is its first prompt, with the agent note and the workspace notes', async () => {
    const SESSION = await import('../assistant/agents/session.ts');
    const { NOTE_PREFIX } = await import('../assistant/agents/acp.ts');
    const { guideBlock } = await import('../assistant/prompt.ts');
    for (const how of ['no_tools', 'stop']) {
      const w = await world({ custom: true, allow: [CUSTOM_ID] });
      const hold = `f5-first-${how}`;
      custom.configure({ mcpLate: hold });
      try {
        const r = await w.turn({ text: 'One.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1' });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        await holding(custom, hold);
        const pid = lastPid(custom);
        await H.until(() => host.sessionOf(r.body.conversation)?.awaitingTools === true, CEILING, 'the wait for its tools');
        if (how === 'no_tools') w.m.clock.advance(SESSION.AGENT_TOOLS_MS);
        else await w.m.manager.stop(r.turn.id, CEILING);
        await settledTurn(r.turn);
        assert.deepEqual([how, endOf(r.turn).state], [how, how === 'no_tools' ? 'failed' : 'stopped'], endOf(r.turn).message);
        assert.ok(!methodsIn(custom, pid).includes('session/prompt'), 'never prompted');
        // Its MCP server connects meanwhile; the next message goes to the same agent.
        custom.release(hold);
        await custom.waitFor((x) => x.event === 'mcp_tools' && custom.of(pid)(x), CEILING);
        const r2 = await w.turn({ text: 'Two.', provider: `agent:${CUSTOM_ID}`, tab: 'tab-1', conversation: r.body.conversation });
        assert.equal(r2.status, 202, JSON.stringify(r2.body));
        custom.script({ say: 'two' });
        await settledTurn(r2.turn);
        assert.deepEqual([endOf(r2.turn).state, endOf(r2.turn).reason], ['done', 'end_turn'], how);
        assert.equal(lastPid(custom), pid, `${how}: the same agent`);
        const prompts = custom.received(pid).filter((m) => m.method === 'session/prompt');
        assert.equal(prompts.length, 1, how);
        const texts = prompts[0].params.prompt.map((b) => b.text);
        assert.ok(texts[0].startsWith(`${NOTE_PREFIX} `), `${how}: the agent note first: ${texts[0].slice(0, 60)}`);
        assert.equal(texts[1], guideBlock(GUIDE, 'Workspace demo'), `${how}: the workspace notes`);
        assert.equal(texts[2], 'Two.');
        assert.ok(!H.eventsOf(r2.turn).some((x) => x.type === 'note' && x.text === GUIDE_CHANGED_NOTE), `${how}: no note that the workspace notes changed`);
      } finally {
        custom.configure({ mcpLate: null });
        custom.release(hold);
        await w.close();
      }
    }
  });

  it('idle for its idle time (fake clock): the agent ends; the next message starts it again with the note', async () => {
    const w = await world({ idleMs: 15 * 60_000 });
    try {
      const r = await w.turn({ text: 'One.', provider: 'agent:claude' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      claude.script({ say: 'one' });
      await settledTurn(r.turn);
      const pid = lastPid(claude);
      w.m.clock.advance(15 * 60_000 - 1);
      assert.ok(alive(pid));
      w.m.clock.advance(1);
      await gone(pid);
      const r2 = await w.turn({ text: 'Two.', provider: 'agent:claude', conversation: r.body.conversation });
      assert.equal(r2.status, 202, JSON.stringify(r2.body));
      claude.script({ say: 'two' });
      await settledTurn(r2.turn);
      assert.notEqual(lastPid(claude), pid);
      assert.ok(H.eventsOf(r2.turn).some((x) => x.type === 'note' && /was started again/.test(x.text)));
    } finally {
      await w.close();
    }
  });

  it('a conversation forgotten, expired or evicted ends its agent and frees its slot', async () => {
    const w = await world();
    try {
      const conv = async () => {
        const r = await w.turn({ text: 'Hi.', provider: 'agent:claude' });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        claude.script({ say: 'hi' });
        await settledTurn(r.turn);
        return { id: r.body.conversation, pid: lastPid(claude) };
      };
      // Forgotten.
      let c = await conv();
      assert.equal(host.count(), 1);
      assert.equal(w.m.manager.forget(c.id).body.forgotten, true);
      await gone(c.pid);
      assert.equal(host.count(), 0);
      // Expired (2 hours idle).
      c = await conv();
      w.m.clock.t += 2 * 60 * 60_000 + 1;
      w.m.manager.conversations.sweep();
      await gone(c.pid);
      assert.equal(host.count(), 0);
      // Evicted past 20 conversations (it is the oldest idle one).
      c = await conv();
      for (let i = 0; i < 20; i += 1) w.m.manager.conversations.create({ provider: 'anthropic', model: 'm', projectId: null });
      await gone(c.pid);
      assert.equal(host.count(), 0);
    } finally {
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The routes and the server's lifetime
// ------------------------------------------------------------------------------------------------

/** A server as index.ts wires the Assistant (H.relayServer) on a fresh manager; its turns are its own manager's. */
async function serverWorld(o = {}) {
  resetAssistantState();
  host.setTestOptions({ cancelMs: o.cancelMs ?? null });
  const m = H.makeManager({ dir: ROOT, pluginEpoch: () => '1', projects: { p1: { ...PROJECT } }, settings: { provider: 'agent:claude', privacy: 'allow' } });
  const srv = await H.relayServer(m);
  const status = await L.startMcpListener();
  assert.equal(status.running, true);
  const token = () => M.readInfo(L.mcpInfoPath()).token;
  return { m, srv, token };
}

/** The terminal client's proof of this account for the agent routes: this launch's token (the listener is process-wide). */
const proof = () => ({ 'x-magnusim-launch': M.readInfo(L.mcpInfoPath()).token });

describe('the agent routes, the turn route and the server lifetime (spec 4.12, 4.13, 5.3, 7.7)', LIMIT, () => {
  it('POST /launch/check: the app proves it holds this launch’s token for the port it was reached on (the terminal client sends the token only then)', async () => {
    const { srv, token } = await serverWorld();
    try {
      const { appHoldsToken } = await import(pathToFileURL(join(WEB, 'scripts', 'assistant-run.mjs')).href);
      const port = Number(new URL(srv.base).port);
      const nonce = 'ab'.repeat(16);
      const r = await srv.post('/api/assistant/launch/check', { nonce });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.proof, createHmac('sha256', token()).update(`l${port}:${nonce}`).digest('hex'));
      assert.ok(!JSON.stringify(r.json).includes(token()), 'never the token');
      assert.equal(L.mcpLaunchCheck(port + 1, nonce) === r.json.proof, false, 'bound to the port');
      assert.equal(L.mcpLaunchCheck(port, 'zz'), null);
      for (const bad of [undefined, '', 'AB'.repeat(16), 'ab'.repeat(15), 42]) {
        assert.deepEqual([(await srv.post('/api/assistant/launch/check', { nonce: bad })).status], [400], String(bad));
      }
      assert.equal(await appHoldsToken(port, token()), true);
      assert.equal(await appHoldsToken(port, 'x'.repeat(43)), false, 'another token');
    } finally {
      await srv.close();
    }
  });

  it('POST /turns takes the launch token from x-magnusim-launch (never from the body)', async () => {
    const { srv, token } = await serverWorld();
    try {
      const without = await srv.post('/api/assistant/turns', { text: 'x', provider: 'agent:claude', token: token() });
      assert.deepEqual([without.status, without.json.code], [403, 'launch_proof']);
      claude.script({ say: 'routed' });
      const ok = await srv.post('/api/assistant/turns', { text: 'x', provider: 'agent:claude' }, { 'x-magnusim-launch': token() });
      assert.equal(ok.status, 202, JSON.stringify(ok.json));
      const t = srv.handle.turns.get(ok.json.turn);
      await settledTurn(t);
      const polled = await srv.get(`/api/assistant/turns/${ok.json.turn}?since=0`);
      assert.deepEqual([polled.json.turn.provider, polled.json.turn.billing, polled.json.turn.agent?.id], ['agent:claude', 'agent_account', 'claude']);
      assert.ok(polled.json.events.some((e) => e.type === 'agent'));
      const state = await srv.get('/api/test/assistant/state');
      assert.equal(typeof state.json.agents, 'object');
    } finally {
      await srv.close();
    }
  });

  it('POST /agents/test: a short message and Magnusim’s test tool (works); connect sends none; the modes and models are kept for the row', async () => {
    const { srv } = await serverWorld();
    try {
      claude.script({ call: { tool: 'connection_check', args: { word: 'ok' } } }, { say: 'done' });
      const t = await srv.post('/api/assistant/agents/test', { id: 'claude', message: true }, proof());
      assert.equal(t.status, 200, JSON.stringify(t.json));
      const pid = lastPid(claude);
      assert.deepEqual(
        { ok: t.json.ok, agent: t.json.agent, version: t.json.version, signed_in: t.json.signed_in, own_tools: t.json.own_tools, images: t.json.images, tools: t.json.tools },
        { ok: true, agent: 'Claude Code', version: '0.85.1', signed_in: 'yes', own_tools: 'off', images: false, tools: 'works' },
      );
      assert.ok(Number.isInteger(t.json.ms) && t.json.ms >= 0);
      assert.deepEqual(t.json.modes.map((x) => x.id), ['default', 'plan']);
      assert.deepEqual(t.json.models.map((x) => x.id), ['fake-large', 'fake-small']);
      const tools = claude.events('mcp_tools', pid).at(-1);
      assert.deepEqual(tools.tools, ['connection_check'], 'a Test binding lists only the test tool');
      const prompt = claude.received(pid).find((x) => x.method === 'session/prompt');
      assert.equal(prompt.params.prompt[0].text, 'Call the connection_check tool of the magnusim server with word "ok", then reply with the single word done.');
      await gone(pid);
      const rows = await srv.get('/api/assistant/agents');
      const row = rows.json.agents.find((a) => a.id === 'claude');
      assert.deepEqual(row.last.modes.map((x) => x.id), ['default', 'plan']);
      // Connect: no message.
      const c = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([c.json.ok, c.json.tools], [true, null]);
      assert.ok(!methodsIn(claude, lastPid(claude)).includes('session/prompt'));
      // The provider Test of an agent is its Test with a message.
      claude.script({ call: { tool: 'connection_check', args: { word: 'ok' } } });
      const p = await srv.post('/api/assistant/test', { provider: 'agent:claude' }, proof());
      assert.deepEqual([p.status, p.json.ok, p.json.tools], [200, true, 'works']);
      // Not calling it: not_used.
      claude.script({ say: 'done' });
      const n = await srv.post('/api/assistant/agents/test', { id: 'claude', message: true }, proof());
      assert.deepEqual([n.json.ok, n.json.tools], [true, 'not_used']);
      assert.equal((await srv.post('/api/assistant/agents/test', { id: 'nope', message: true }, proof())).status, 404);
      assert.equal((await srv.post('/api/assistant/agents/test', { id: 'claude', message: 'yes' }, proof())).status, 400);
    } finally {
      await srv.close();
    }
  });

  it('Test, connect, sign-in and the provider Test of an agent need the proof of this account (the token or an app tab’s live link, Settings’ with no workspace): without it 403 launch_proof and nothing starts', async () => {
    const { srv } = await serverWorld();
    let page = null;
    try {
      const before = claude.pids('agent').length;
      const runs = [
        ['/api/assistant/agents/test', { id: 'claude', message: true }],
        ['/api/assistant/agents/test', { id: 'claude', message: false }],
        ['/api/assistant/agents/sign-in', { id: 'claude', method: 'browser' }],
        ['/api/assistant/test', { provider: 'agent:claude' }],
      ];
      for (const [path, body] of runs) {
        for (const [what, extra, headers] of [
          ['nothing', {}, {}],
          ['a wrong token', {}, { 'x-magnusim-launch': 'x'.repeat(43) }],
          ['a link that is no tab’s', { link: 'c'.repeat(24) }, {}],
          ['the token in the body', { token: proof()['x-magnusim-launch'] }, {}],
        ]) {
          const r = await srv.post(path, { ...body, ...extra }, headers);
          assert.deepEqual([r.status, r.json.code, r.json.error], [403, 'launch_proof', "Magnusim couldn't confirm that this came from its own window. Reload the page and try again."], `${path} ${JSON.stringify(body)} with ${what}`);
        }
      }
      // The provider Test with no provider named tests the default: an agent's needs the proof too.
      assert.equal((await srv.post('/api/assistant/settings', { provider: 'agent:claude' })).status, 200);
      assert.equal((await srv.post('/api/assistant/test', {})).json.code, 'launch_proof');
      assert.equal(claude.pids('agent').length, before, 'nothing started');
      // The Settings page's live link (a tab with no workspace) proves it.
      page = await srv.page();
      const link = await page.open();
      const c = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false, link });
      assert.equal(c.json.ok, true, JSON.stringify(c.json));
      await gone(lastPid(claude));
    } finally {
      page?.close();
      await srv.post('/api/assistant/settings', { provider: 'off' });
      await srv.close();
    }
  });

  it('the Test of an agent whose MCP server connects after session/new: its message waits for the list, so the tool works', async () => {
    const { srv } = await serverWorld();
    claude.configure({ mcpLate: 'f5-test-late' });
    try {
      claude.script({ call: { tool: 'connection_check', args: { word: 'ok' } } }, { say: 'done' });
      const testing = srv.post('/api/assistant/agents/test', { id: 'claude', message: true }, proof());
      await holding(claude, 'f5-test-late');
      const pid = lastPid(claude);
      const prompted = claude
        .waitFor((x) => x.dir === 'in' && x.msg?.method === 'session/prompt' && claude.of(pid)(x), CEILING)
        .then(() => 'prompted', () => 'no prompt');
      const waiting = H.until(() => [...host['transients']].some((tr) => tr.session?.awaitingTools === true), CEILING, 'the wait for its tools').then(() => 'waiting', () => 'no wait');
      assert.equal(await Promise.race([prompted, waiting]), 'waiting', 'no message before its MCP server listed the tools');
      claude.release('f5-test-late');
      const t = await testing;
      assert.deepEqual([t.status, t.json.ok, t.json.tools], [200, true, 'works'], JSON.stringify(t.json));
      assert.deepEqual(claude.events('prompt_tools', pid).at(-1)?.tools, ['connection_check']);
    } finally {
      claude.configure({ mcpLate: null });
      claude.release('f5-test-late');
      await srv.close();
    }
  });

  it('connect again to an agent that says it isn’t signed in (its _auth/status_update, nested as the adapter sends it): signed_in no', async () => {
    const { srv } = await serverWorld();
    claude.configure({ authStatus: { kind: 'none', label: 'Not logged in' } });
    try {
      const c = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([c.status, c.json.ok, c.json.signed_in], [200, true, 'no'], JSON.stringify(c.json));
      const sent = claude.sent(lastPid(claude)).find((m) => m.method === '_auth/status_update');
      assert.deepEqual(sent.params, { authStatus: { kind: 'none', label: 'Not logged in' } });
      // Without it, the login file decides.
      claude.configure({ authStatus: null });
      const again = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([again.json.ok, again.json.signed_in], [true, 'yes']);
    } finally {
      claude.configure({ authStatus: null });
      await srv.close();
    }
  });

  it('one Test at a time (409 busy); a custom agent with its switch off is refused for the Test and the connect check, nothing started', async () => {
    const { srv } = await serverWorld();
    const S = await import('../assistant/settings.ts');
    await S.addCustomAgent(customAgent());
    try {
      claude.script({ hold: 'test-hold' });
      const first = srv.post('/api/assistant/agents/test', { id: 'claude', message: true }, proof());
      await holding(claude, 'test-hold');
      const second = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([second.status, second.json.code], [409, 'busy']);
      claude.release('test-hold');
      assert.equal((await first).json.ok, true);
      const before = custom.records().length;
      for (const message of [true, false]) {
        const r = await srv.post('/api/assistant/agents/test', { id: CUSTOM_ID, message }, proof());
        assert.deepEqual([r.status, r.json.code], [409, 'agent_not_allowed'], `message ${message}`);
        const s = await srv.post('/api/assistant/agents/sign-in', { id: CUSTOM_ID, method: 'browser' }, proof());
        assert.deepEqual([s.status, s.json.code], [409, 'agent_not_allowed']);
      }
      assert.equal(custom.records().length, before, 'nothing started');
    } finally {
      await S.removeCustomAgent(CUSTOM_ID);
      await srv.close();
    }
  });

  it('the Test stops when its request goes away (a reload, Settings left): the agent ends, and the next Test may start', async () => {
    const { srv } = await serverWorld();
    try {
      claude.script({ hold: 'test-gone' });
      const url = new URL(`${srv.base}/api/assistant/agents/test`);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...proof() }, agent: false });
      req.on('error', () => {});
      req.end(JSON.stringify({ id: 'claude', message: true }));
      await holding(claude, 'test-gone');
      const pid = lastPid(claude);
      req.destroy();
      await gone(pid);
      const next = await H.until(async () => {
        const r = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
        return r.json.code === 'busy' ? null : r;
      }, CEILING, 'the Test slot to free');
      assert.equal(next.json.ok, true, JSON.stringify(next.json));
    } finally {
      claude.release('test-gone');
      await srv.close();
    }
  });

  it('sign-in: auth_required gives agent_signin with the safe terminal command; the agent’s own sign-in, then connect again works', async () => {
    const { srv } = await serverWorld();
    const script = join(PATH_DIR, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
    claude.signOut();
    claude.configure({
      requireSignIn: true,
      authMethods: [
        { id: 'console-login', name: 'Log in', type: 'terminal', args: ['--login'], _meta: { 'terminal-auth': { command: process.execPath, args: [script, '--cli', 'auth', 'login'], label: 'Log in' } } },
        { id: 'unsafe', name: 'Unsafe', type: 'terminal', args: ['a;rm', '-rf'] },
        { id: 'browser', name: 'Sign in with the browser', type: 'agent' },
      ],
    });
    try {
      const c = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.deepEqual([c.status, c.json.ok, c.json.code], [200, false, 'agent_signin']);
      assert.equal(c.json.error, "Claude Code isn't signed in. Settings → Assistant shows how to sign in.");
      const byId = Object.fromEntries(c.json.auth.map((m) => [m.id, m]));
      assert.equal(byId['console-login'].command, 'claude-agent-acp --cli auth login');
      assert.equal(byId.unsafe.command, null, 'never a command that is not safe to paste');
      assert.deepEqual([byId.browser.type, byId.browser.command], ['agent', null]);
      const rows = await srv.get('/api/assistant/agents');
      assert.deepEqual(rows.json.agents.find((a) => a.id === 'claude').sign_in.methods.map((m) => m.id), ['console-login', 'unsafe', 'browser']);
      assert.equal((await srv.post('/api/assistant/agents/sign-in', { id: 'claude', method: 'console-login' }, proof())).json.code, 'bad_method');
      assert.equal((await srv.post('/api/assistant/agents/sign-in', { id: 'claude' }, proof())).status, 400);
      const s = await srv.post('/api/assistant/agents/sign-in', { id: 'claude', method: 'browser' }, proof());
      assert.deepEqual([s.status, s.json.ok], [200, true], JSON.stringify(s.json));
      const auth = claude.received(lastPid(claude)).find((m) => m.method === 'authenticate');
      assert.equal(auth.params.methodId, 'browser');
      await gone(lastPid(claude));
      const again = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false }, proof());
      assert.equal(again.json.ok, true, JSON.stringify(again.json));
      const after = await srv.get('/api/assistant/agents');
      assert.equal(after.json.agents.find((a) => a.id === 'claude').sign_in, null, 'the block goes once it works');
    } finally {
      claude.configure({ requireSignIn: false, authMethods: [] });
      claude.signIn();
      await srv.close();
    }
  });

  it("connect: the agent's own word on its login (_auth/status_update {authStatus}) comes in its own field, apart from the login file; 'none' keeps the sign-in block with its ways, any other kind or a Test it answered clears it; the row's readiness and the status follow its word over the file", async () => {
    const { unlinkSync } = await import('node:fs');
    const cred = join(AGENT_HOME, '.claude', '.credentials.json');
    const script = join(PATH_DIR, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
    // No login file: the row says it isn't signed in (signed_in 'no').
    unlinkSync(cred);
    const { srv } = await serverWorld();
    claude.configure({
      authStatus: 'none',
      authMethods: [{ id: 'console-login', name: 'Log in', type: 'terminal', args: ['--login'], _meta: { 'terminal-auth': { command: process.execPath, args: [script, '--cli', 'auth', 'login'], label: 'Log in' } } }],
    });
    const signInIds = async () => (await srv.get('/api/assistant/agents')).json.agents.find((a) => a.id === 'claude').sign_in?.methods.map((m) => m.id) ?? null;
    // The row (its dot), the Default choice's line and the status (claude the default) agree.
    assert.equal((await srv.post('/api/assistant/settings', { provider: 'agent:claude' })).status, 200);
    const readiness = async () => {
      const r = (await srv.get('/api/assistant/agents')).json.agents.find((a) => a.id === 'claude');
      const st = (await srv.get('/api/assistant/status')).json;
      const p = st.providers_ready['agent:claude'];
      return { word: r.auth_word, ready: r.ready, reason: r.reason, status: [st.ready, st.ready_reason], line: [p.ready, p.reason, p.detail] };
    };
    try {
      assert.equal((await srv.get('/api/assistant/agents?refresh=1')).json.agents.find((a) => a.id === 'claude').signed_in, 'no');
      // The session starts (as the adapter's does), and it says it isn't signed in.
      const c = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.deepEqual([c.json.ok, c.json.tools, c.json.signed_in, c.json.auth_status], [true, null, 'no', 'none']);
      assert.deepEqual(c.json.auth.map((m) => [m.id, m.command]), [['console-login', 'claude-agent-acp --cli auth login']]);
      assert.ok(!methodsIn(claude, lastPid(claude)).includes('session/prompt'), 'a connect sends no message');
      // Its row keeps the ways to sign in, so Settings opened again shows the block.
      assert.deepEqual(await signInIds(), ['console-login']);
      const out = { word: 'none', ready: false, reason: 'agent_signed_out', status: [false, 'agent_signed_out'], line: [false, 'agent_signed_out', 'Not signed in'] };
      assert.deepEqual(await readiness(), out);
      // Signed in since (its login file there now, the cached row older): the check reads the file
      // again, and the agent's word still comes through in its own field.
      writeFileSync(cred, '{}');
      const f = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.deepEqual([f.json.ok, f.json.signed_in, f.json.auth_status], [true, 'yes', 'none']);
      // Its word wins over the login file (a stale file, a logout the file outlived): not ready, everywhere.
      assert.deepEqual(await readiness(), out);
      // Signed in by its own word (any other kind), with no login file: the block goes, and it is ready everywhere.
      unlinkSync(cred);
      claude.configure({ authStatus: 'account' });
      const s = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.deepEqual([s.json.ok, s.json.signed_in, s.json.auth_status, s.json.auth], [true, 'no', 'signed_in', undefined]);
      assert.equal(await signInIds(), null);
      assert.deepEqual(await readiness(), { word: 'signed_in', ready: true, reason: null, status: [true, null], line: [true, null, 'Signed in · 0.85.1'] });
      // Nothing said (an agent that doesn't report its login), no login file: it starts, signed in or not isn't known (ready, as unknown is).
      claude.configure({ authStatus: null });
      assert.equal((await srv.post('/api/assistant/agents/test', { id: 'claude', message: false })).json.auth_status, null);
      assert.deepEqual(await readiness(), { word: 'silent', ready: true, reason: null, status: [true, null], line: [true, null, 'Sign-in not known · 0.85.1'] });
      // A Test the agent answered: signed in, whatever it said (no block kept).
      claude.configure({ authStatus: 'none' });
      await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.deepEqual(await signInIds(), ['console-login']);
      claude.script({ say: 'done' });
      const t = await srv.post('/api/assistant/agents/test', { id: 'claude', message: true });
      assert.deepEqual([t.json.ok, t.json.tools, t.json.auth], [true, 'not_used', undefined]);
      assert.equal(await signInIds(), null);
      assert.deepEqual((await readiness()).ready, true);
      // A connect that hears auth_required (session/new refused): its word is 'none' again.
      claude.configure({ requireSignIn: true });
      claude.signOut();
      const refused = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.equal(refused.json.code, 'agent_signin');
      assert.deepEqual(await readiness(), out);
    } finally {
      claude.configure({ authStatus: null, authMethods: [], requireSignIn: false });
      writeFileSync(cred, '{}');
      await srv.post('/api/assistant/settings', { provider: 'off' });
      await srv.close();
    }
  });

  it("connect: an agent that says it reports its login (initialize's _meta.authStatus) is waited for when its word comes after its session started (as one adapter's background read does), and one that never says anything is waited for only within the bound", async () => {
    const cred = join(AGENT_HOME, '.claude', '.credentials.json');
    const { srv } = await serverWorld();
    const hold = `late-login-${Date.now()}`;
    // A login file there (a stale one): only the agent's late word tells it isn't signed in.
    writeFileSync(cred, '{}');
    claude.configure({ authStatus: 'none', authStatusHold: hold, authMethods: [{ id: 'console-login', name: 'Log in', type: 'terminal', args: ['--login'] }] });
    try {
      let settled = false;
      const pending = srv.post('/api/assistant/agents/test', { id: 'claude', message: false }).finally(() => (settled = true));
      // Its session started and answered; its word is held back.
      const held = await claude.waitFor((r) => r.event === 'holding' && r.name === hold, 30_000);
      assert.ok(claude.sent(held.pid).some((m) => m.result && typeof m.result.sessionId === 'string'), 'session/new answered before its word');
      assert.equal(settled, false, 'the connect waits for its word');
      claude.release(hold);
      const c = await pending;
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.deepEqual([c.json.ok, c.json.signed_in, c.json.auth_status, c.json.auth?.map((m) => m.id)], [true, 'yes', 'none', ['console-login']]);
      const row = (await srv.get('/api/assistant/agents')).json.agents.find((a) => a.id === 'claude');
      assert.deepEqual([row.auth_word, row.ready, row.reason], ['none', false, 'agent_signed_out']);
      // It says it reports its login and never does: the connect answers within the bound, its word not known.
      claude.configure({ authStatus: 'silent', authStatusHold: null });
      const t0 = Date.now();
      const s = await srv.post('/api/assistant/agents/test', { id: 'claude', message: false });
      assert.deepEqual([s.json.ok, s.json.auth_status], [true, null]);
      const took = Date.now() - t0;
      assert.ok(took >= SES.AUTH_STATUS_WAIT_MS - 1_000 && took < T.AGENT_TEST_MS, `waited ${took} ms`);
      // Its login file decides (there): ready.
      const after = (await srv.get('/api/assistant/agents')).json.agents.find((a) => a.id === 'claude');
      assert.deepEqual([after.auth_word, after.ready, after.sign_in], ['silent', true, null]);
    } finally {
      claude.configure({ authStatus: null, authStatusHold: null, authMethods: [] });
      claude.release(hold);
      writeFileSync(cred, '{}');
      await srv.close();
    }
  });

  it('a Vite restart with a live agent: the old lifetime’s shutdown kills the agent and ends its turn failed/shutdown; the listener, port and token stay', async () => {
    const { m, srv, token } = await serverWorld();
    let srv2 = null;
    try {
      const port = L.mcpListenerStatus().port;
      const tok = token();
      claude.script({ hold: 'restart' });
      const r = await srv.post('/api/assistant/turns', { text: 'Hold.', provider: 'agent:claude' }, { 'x-magnusim-launch': tok });
      assert.equal(r.status, 202);
      await holding(claude, 'restart');
      const pid = lastPid(claude);
      const t = srv.handle.turns.get(r.json.turn);
      // The new server first, then the old one's close (its lifetime is superseded by then).
      srv2 = await H.relayServer(m);
      srv.handle.shutdown();
      assert.deepEqual([t.state, endOf(t).reason], ['failed', 'shutdown']);
      await gone(pid);
      assert.deepEqual([L.mcpListenerStatus().running, L.mcpListenerStatus().port, token()], [true, port, tok]);
    } finally {
      claude.release('restart');
      await srv.close();
      await srv2?.close();
    }
  });

  it('a Vite restart while a Settings Test runs: the old lifetime’s shutdown stops the Test and its agent', async () => {
    const { m, srv } = await serverWorld();
    let srv2 = null;
    try {
      claude.script({ hold: 'test-restart' });
      const test = srv.post('/api/assistant/agents/test', { id: 'claude', message: true }, proof());
      await holding(claude, 'test-restart');
      const pid = lastPid(claude);
      assert.equal(host.running('claude'), true);
      srv2 = await H.relayServer(m);
      srv.handle.shutdown();
      await gone(pid);
      const a = await test;
      assert.deepEqual([a.status, a.json.ok], [200, false], JSON.stringify(a.json));
      await H.until(() => !host.running('claude'), CEILING, 'the Test slot to free');
    } finally {
      claude.release('test-restart');
      await srv.close();
      await srv2?.close();
    }
  });

  it('the allow switch going off mid-turn stops that agent’s turn and ends its process before the route answers', async () => {
    const w = await world({ custom: true, allow: [CUSTOM_ID] });
    try {
      const r = await w.turn({ text: 'Hold.', provider: `agent:${CUSTOM_ID}` });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      custom.script({ hold: 'switch-off' });
      await holding(custom, 'switch-off');
      const pid = lastPid(custom);
      assert.equal(host.running(CUSTOM_ID), true);
      await host.stopAgent(CUSTOM_ID, 'Scripted was turned off in Settings.');
      assert.equal(alive(pid), false, 'gone when the stop resolves');
      await settledTurn(r.turn);
      const e = endOf(r.turn);
      assert.deepEqual([e.state, e.message], ['stopped', 'Scripted was turned off in Settings.']);
    } finally {
      custom.release('switch-off');
      await w.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// More of the start: a start-up sign-in step, a hidden tab, the page's live link, the default
// ------------------------------------------------------------------------------------------------

describe('more of an agent turn’s start (spec 4.6, 5.1, 5.2, 7.1)', LIMIT, () => {
  it('an agent with a start-up sign-in step gets authenticate (its first advertised method, with the catalogue’s _meta) before session/new', async () => {
    const grok = await fakeAgent({ style: 'none', authMethods: [{ id: 'cached_token', name: 'Cached token', type: 'agent' }, { id: 'other', name: 'Other', type: 'agent' }] });
    installKnown(grok, { pkg: '@xai-official/grok', program: 'grok', version: '1.0.49' });
    const w = await world({ provider: 'agent:grok', allow: ['grok'] });
    try {
      const r = await w.turn({ text: 'Hi.', provider: 'agent:grok' });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      grok.script({ say: 'hello' });
      await settledTurn(r.turn);
      assert.equal(endOf(r.turn).state, 'done');
      const pid = lastPid(grok);
      assert.deepEqual(methodsIn(grok, pid).slice(0, 3), ['initialize', 'authenticate', 'session/new']);
      const auth = grok.received(pid).find((m) => m.method === 'authenticate');
      assert.deepEqual(auth.params, { methodId: 'cached_token', _meta: { headless: true } });
      // A custom-like agent with no system-prompt hook gets the note as its first prompt's first block.
      const prompt = grok.received(pid).find((m) => m.method === 'session/prompt');
      assert.match(prompt.params.prompt[0].text, /^Note from Magnusim \(not from the person\): You are working inside Magnusim/);
      // It may run only in the mode it starts in: nothing set.
      assert.ok(!methodsIn(grok, pid).includes('session/set_mode'));
    } finally {
      await w.close();
    }
  });

  it('a tab whose window is hidden: refused tab_hidden after the launch proof; with no proof, launch_proof first', async () => {
    const w = await world();
    try {
      w.m.registry.setConnected('tab-1', 'a'.repeat(24), false);
      const r = await w.turn({ text: 'x', provider: 'agent:claude', tab: 'tab-1' });
      assert.deepEqual([r.status, r.body.code], [409, 'tab_hidden']);
      assert.equal((await w.turn({ text: 'x', provider: 'agent:claude', tab: 'tab-1' }, {})).body.code, 'launch_proof');
    } finally {
      await w.close();
    }
  });

  it('the page proves it with an app tab’s live relay link, whichever tab sends it: a turn on its tab, on another, or on none from Home (a tab with no workspace); a link that is no tab’s, or one its tab had before, doesn’t', async () => {
    const { srv } = await serverWorld();
    let a = null;
    let b = null;
    let home = null;
    try {
      a = await srv.page();
      b = await srv.page();
      home = await srv.page();
      const linkA = await a.open();
      const linkB = await b.open();
      for (const link of [linkA, linkB]) {
        const reg = await srv.register(link, 1);
        assert.equal(reg.status, 200, JSON.stringify(reg.json));
      }
      // Home (or Settings) offers no tools: its channel is opened for the proof alone, nothing registered.
      const linkHome = await home.open();
      assert.equal((await srv.tabs()).some((x) => x.tab === home.tab), false, 'Home has no workspace');
      const before = claude.pids('agent').length;
      const turn = (tab, link) => srv.post('/api/assistant/turns', { text: 'x', provider: 'agent:claude', ...(tab ? { tab } : {}), link });
      // A link that is no tab's live one: refused, with a tab or without.
      for (const tab of [a.tab, null]) {
        const r = await turn(tab, 'c'.repeat(24));
        assert.deepEqual([r.status, r.json.code], [403, 'launch_proof'], `tab ${tab}`);
      }
      assert.equal(claude.pids('agent').length, before, 'nothing started');
      // Any tab's live link proves it: its own tab, another's, and Home's for a turn on no tab (phase 4's dock).
      for (const [tab, link, say] of [
        [a.tab, linkA, 'by its own link'],
        [b.tab, linkA, 'by another tab’s link'],
        [null, linkHome, 'from Home'],
      ]) {
        claude.script({ say });
        const ok = await turn(tab, link);
        assert.equal(ok.status, 202, `${say}: ${JSON.stringify(ok.json)}`);
        const t = srv.handle.turns.get(ok.json.turn);
        await settledTurn(t);
        assert.deepEqual([endOf(t).state, t.tab], ['done', tab], say);
      }
      // Tab A gets a new link (its tools registered again under it): the one it had before proves nothing.
      await a.unsubscribe();
      const linkA2 = await a.open('assistant:2');
      const again = await srv.register(linkA2, 2);
      assert.equal(again.status, 200, JSON.stringify(again.json));
      await H.until(() => !srv.relay.isLiveLinkOf(a.tab, linkA) && srv.relay.isLiveLinkOf(a.tab, linkA2), CEILING, 'the new link');
      const started = claude.pids('agent').length;
      const late = await turn(a.tab, linkA);
      assert.deepEqual([late.status, late.json.code], [403, 'launch_proof'], JSON.stringify(late.json));
      assert.equal(claude.pids('agent').length, started, 'nothing started');
      const fresh = await turn(a.tab, linkA2);
      assert.equal(fresh.status, 202, JSON.stringify(fresh.json));
      claude.script({ say: 'by the new link' });
      await settledTurn(srv.handle.turns.get(fresh.json.turn));
    } finally {
      a?.close();
      b?.close();
      home?.close();
      await srv.close();
    }
  });

  it('a coding agent as the default (spec 5.1): saved, its readiness in the status from the last discovery; a bare model is refused', async () => {
    const S = await import('../assistant/settings.ts');
    const base = S.defaultSettings();
    assert.equal(S.validatePatch(base, { provider: 'agent:claude' }).settings.provider, 'agent:claude');
    const unknown = S.validatePatch(base, { provider: 'agent:nope' });
    assert.deepEqual([unknown.ok, unknown.field], [false, 'provider']);
    const withCustom = { ...base, custom_agents: [customAgent()] };
    assert.equal(S.validatePatch(withCustom, { provider: `agent:${CUSTOM_ID}` }).settings.provider, `agent:${CUSTOM_ID}`);
    const bare = S.validatePatch({ ...base, provider: 'agent:claude' }, { model: 'm-1' });
    assert.deepEqual([bare.ok, bare.field], [false, 'model']);
    assert.equal(S.normalizeSettings({ provider: 'agent:claude' }).provider, 'agent:claude');
    assert.equal(S.normalizeSettings({ provider: `agent:${CUSTOM_ID}`, custom_agents: [customAgent()] }).provider, `agent:${CUSTOM_ID}`);
    assert.equal(S.normalizeSettings({ provider: 'agent:custom-ffffff' }).provider, 'off', 'a custom agent that went is no default');
    const { srv } = await serverWorld();
    try {
      const saved = await srv.post('/api/assistant/settings', { provider: 'agent:claude' });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      assert.deepEqual([saved.json.provider, saved.json.default_provider], ['agent:claude', 'agent:claude']);
      assert.equal(saved.json.price, null, 'no price for an agent');
      await srv.get('/api/assistant/agents');
      const status = (await srv.get('/api/assistant/status')).json;
      assert.deepEqual([status.ready, status.ready_reason], [true, null]);
      assert.equal(status.providers_ready['agent:claude'].billing, 'agent_account');
      assert.equal((await srv.post('/api/assistant/settings', { model: 'x-1' })).json.field, 'model');
    } finally {
      await srv.post('/api/assistant/settings', { provider: 'off' });
      await srv.close();
    }
  });

  it('the timing switches are honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home', () => {
    const env = { MAGNUSIM_TEST_ASSISTANT_AGENT_IDLE_MS: '500', MAGNUSIM_TEST_ASSISTANT_AGENT_CANCEL_MS: '200', MAGNUSIM_TEST_ASSISTANT_AGENT_GATE_MS: '300' };
    const on = HOST.agentTimingSwitches({ ...env, MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_ASSISTANT_HOME: HOME });
    assert.deepEqual([on.idleMs, on.cancelMs, on.gateMs, on.ignored], [500, 200, 300, []]);
    const off = HOST.agentTimingSwitches({ ...env, MAGNUSIM_ASSISTANT_HOME: HOME });
    assert.deepEqual([off.idleMs, off.cancelMs, off.gateMs], [null, null, null]);
    assert.equal(off.ignored.length, 3);
    const realHome = HOST.agentTimingSwitches({ ...env, MAGNUSIM_TEST_ASSISTANT: '1' });
    assert.deepEqual([realHome.idleMs, realHome.ignored.length], [null, 3]);
    const bad = HOST.agentTimingSwitches({ MAGNUSIM_TEST_ASSISTANT_AGENT_IDLE_MS: '0', MAGNUSIM_TEST_ASSISTANT: '1', MAGNUSIM_ASSISTANT_HOME: HOME });
    assert.deepEqual([bad.idleMs, bad.ignored.length], [null, 1]);
  });
});

// ------------------------------------------------------------------------------------------------
// The scripted agent's own records (test support)
// ------------------------------------------------------------------------------------------------

describe('the scripted agent’s records (test support)', LIMIT, () => {
  it('a reused pid: received(), events() and of() follow the last fake that reported it, not an earlier one', async () => {
    // Not in `fakes`: the pid below is made up, and the end's sweep must never signal it.
    const f = await startFakeAcp({ style: 'none' });
    try {
      const post = async (path, body) => {
        const r = await fetch(`${f.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
      };
      const pid = 424242;
      // An earlier fake with this pid: its permission reply and its event.
      await post('/pids', { role: 'agent', pids: [pid], pid, instance: 'earlier' });
      await post('/record', { seq: 1, pid, instance: 'earlier', dir: 'in', msg: { jsonrpc: '2.0', id: 'fake-1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } } });
      await post('/record', { seq: 2, pid, instance: 'earlier', event: 'permission_outcome', outcome: { outcome: 'selected', optionId: 'allow' } });
      // The OS gave the same pid to a later one.
      await post('/pids', { role: 'agent', pids: [pid], pid, instance: 'later' });
      await post('/record', { seq: 1, pid, instance: 'later', dir: 'in', msg: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } } });
      assert.deepEqual(f.received(pid).map((m) => m.method ?? 'a reply'), ['session/cancel']);
      assert.deepEqual(f.events('permission_outcome', pid), []);
      assert.equal(f.records().filter(f.of(pid)).filter((r) => r.dir === 'in').length, 1);
      assert.equal(f.received().length, 2, 'all fakes when no pid is given');
    } finally {
      await f.stop();
    }
  });
});
