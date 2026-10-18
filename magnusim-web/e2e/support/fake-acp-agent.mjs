// A scripted coding agent for tests (phase 3 spec 7.2). Plain Node, no dependencies, and it
// names no real agent. It speaks the agent protocol (ACP v1: newline JSON-RPC 2.0) on stdin and
// stdout and logs only to stderr. Started as:
//
//   node fake-acp-agent.mjs --control <url> [--helpers-at-start <n>] [--fake-version <v>]
//   node fake-acp-agent.mjs --version        prints "fake-acp-agent <v>" (default 1.0.0), exits 0
//
// --helpers-at-start spawns n helper processes at its very first instruction, before it reads
// anything (a program that starts children before its parent could put it in a job).
// Without --control (and without --version) it exits 2. A start that can't pass --control, as
// agent discovery starts a package's bin ([node, <script>, ...args], with no MAGNUSIM_
// variable), goes through a launcher: the controller's writeLauncher(file) writes one with
// the controller's address in it.
//
// The controller (fake-acp.mjs, in the test process) serves its settings at GET <url>/config
// and each prompt's steps at POST <url>/prompt. The fake POSTs a record of every message it
// receives and sends (in order, numbered) to <url>/record, the pids it starts to <url>/pids, and
// waits for releases at GET <url>/hold?name=. So tests can assert on clientCapabilities, _meta,
// mcpServers, and the order of permission replies against session/cancel.
//
// Settings (startFakeAcp(options) / configure()):
//   style: 'tool_name_meta' | 'mcp_call_flag' | 'none'
//     tool_name_meta: tool calls and permission requests for MCP tools carry
//       _meta.claudeCode = {toolName: 'mcp__<server>__<tool>', mcpServer: {name, source}};
//       a stdio MCP server given with a `type` key is ignored, as that adapter does;
//     mcp_call_flag: MCP tool calls are titled 'mcp.<server>.<tool>' with
//       _meta.is_mcp_tool_call, and approvals carry _meta.is_mcp_tool_approval on the request
//       with the tool call's id;
//     none: neither (a custom command).
//   protocolVersion (1), agentInfo, images, loadSession, authMethods (terminal or agent only),
//   requireSignIn (session/new answers -32000 while the controller's sign-in marker is
//   missing), authSignsIn (authenticate writes the marker; default true), modes,
//   configOptions, models (pre-v1, off by default), stubborn (ignores the end of its input and
//   SIGTERM), stderrAtStart, envReport (variable names whose presence it reports).
//
// Steps of a prompt (strings or one-key objects):
//   {say: text} {think: text} {plan: [entry | {content, status, priority}]}
//   {call: {tool, args?, title?}}            tool_call, then tools/call through the MCP server
//                                            it was given, then tool_call_update
//   {askOurs: {tool, options?}}              a permission request for one of our tools in the
//                                            style (options: the kinds to offer)
//   {askOursCorrelated: {tool, toolCallId?, announce?}}  the flagged-approval shape: a tool_call
//                                            (unless announce: false) and an approval with its id
//   {askOwn: {title, kind?, rawInput?, toolName?, options?}}  a permission request for its own tool
//   {ownTool: {id?, title, kind?, status}}   its own tool's tool_call / tool_call_update
//   {hold: name}                             waits until release(name) (or a cancel)
//   'crash' | {crash: text}                  writes text to stderr and exits 1
//   'exitDuringCall'                         the next call exits 1 once the MCP server reports
//                                            progress on it (or answers it)
//   'ignoreCancel'                           session/cancel no longer ends this prompt
//   {spawnHelpers: n}                        n helpers that outlive it on purpose (detached on
//                                            Windows; on POSIX they stay in its process group)
//   {spawnHelpers: {count, onTerm: file}}    helpers that end on SIGTERM after a short cleanup,
//                                            which writes <file>.<i>; reported once each listens
//                                            for SIGTERM (POSIX: the stop's grace)
//   {switchMode: id}                         current_mode_update (and the mode config option)
//   {stop: reason}                           ends the prompt (end_turn, ..., 'error')
//   {error: {code, message}}                 session/prompt answers with this error
//   {update: {...}}                          a raw session/update
//   {later: {update, hold?}}                 a raw session/update sent after this prompt's answer
//                                            (between prompts), once release(hold) when given
//   {request: {method, params}}              a raw request to the client; its answer is recorded
// Without a {stop} the prompt ends end_turn after its last step; session/cancel ends it
// cancelled. Unknown requests get -32601, and it sends fs/read_text_file once per session to
// check that the client refuses it.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CONTROL = argOf('--control');
const HELPER_CODE =
  "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1<<30);";
// A helper that ends on SIGTERM after a short cleanup, which writes the file it was given. It
// says so on stdout once it listens for SIGTERM.
const TIDY_HELPER_CODE =
  "process.on('SIGTERM',()=>setTimeout(()=>{require('fs').writeFileSync(process.argv[1],'cleaned up');process.exit(0);},100));process.on('SIGHUP',()=>{});process.stdout.write('ready');setInterval(()=>{},1<<30);";
const WIN = process.platform === 'win32';

/** Helpers that outlive their parent on purpose. */
function spawnHelpers(n) {
  const pids = [];
  for (let i = 0; i < n; i += 1) {
    const child = spawn(process.execPath, ['-e', HELPER_CODE], { stdio: 'ignore', detached: WIN, windowsHide: true });
    child.unref();
    if (child.pid) pids.push(child.pid);
  }
  return pids;
}

/** Tidy helpers (they end on SIGTERM, writing <onTerm>.<i>), each once it listens for SIGTERM. */
async function spawnTidyHelpers(n, onTerm) {
  const pids = [];
  for (let i = 0; i < n; i += 1) {
    const child = spawn(process.execPath, ['-e', TIDY_HELPER_CODE, `${onTerm}.${i}`], { stdio: ['ignore', 'pipe', 'ignore'], detached: WIN, windowsHide: true });
    await new Promise((resolve) => {
      child.stdout.once('data', resolve);
      child.once('error', resolve);
      child.once('exit', resolve);
    });
    child.stdout.destroy();
    child.unref();
    if (child.pid) pids.push(child.pid);
  }
  return pids;
}

// The version probe (as agent discovery runs it: stdin ignored, no controller needed).
if (argv.includes('--version')) {
  process.stdout.write(`fake-acp-agent ${argOf('--fake-version') || '1.0.0'}\n`);
  process.exit(0);
}

// First instruction: helpers before anything else (no await before this line).
const atStart = Number(argOf('--helpers-at-start') || 0);
const startHelpers = atStart > 0 ? spawnHelpers(atStart) : [];

const log = (...a) => process.stderr.write(`[fake-acp-agent] ${a.join(' ')}\n`);
if (!CONTROL) {
  log('needs --control <url>');
  process.exit(2);
}

// ---- the control channel -----------------------------------------------------------------

// node:http with no keep-alive, not fetch: an exit while fetch's pooled sockets are open can
// abort Node on Windows (a libuv assertion), which would turn a scripted exit code into a crash.
const controlUrl = new URL(CONTROL);
/** One request to the controller; its JSON answer (null when empty). */
function control(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: controlUrl.hostname,
        port: controlUrl.port,
        path,
        method,
        agent: false,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

let seq = 0;
let posting = Promise.resolve();
// This process's own id on every record: the OS reuses pids, so a pid alone can merge two fakes'
// records.
const INSTANCE = randomBytes(8).toString('hex');
/** POSTs in order, one at a time. */
function post(path, body) {
  const payload = { ...body, pid: process.pid, instance: INSTANCE };
  posting = posting.then(() => control('POST', path, payload)).catch(() => {});
  return posting;
}
const record = (rec) => post('/record', { seq: (seq += 1), ...rec });
const getJson = (path) => control('GET', path);

// ---- the agent protocol on stdin / stdout --------------------------------------------------

let nextId = 1;
const waiting = new Map();
function send(msg) {
  const full = { jsonrpc: '2.0', ...msg };
  record({ dir: 'out', msg: full });
  const line = `${JSON.stringify(full)}\n`;
  // After the records: a test that sees the answer finds every record before it at the controller.
  posting = posting.then(() => {
    process.stdout.write(line);
  });
}
const reply = (id, result) => send({ id, result });
const replyError = (id, code, message) => send({ id, error: { code, message } });
const notifyClient = (method, params) => send({ method, params });
function requestClient(method, params) {
  const id = `fake-${nextId++}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}
const sessionUpdate = (sessionId, update) => notifyClient('session/update', { sessionId, update });

let config = null;
const sessions = new Map();
let current = null; // the running prompt
let exitDuringCall = false;
let toolSeq = 0;
let lastToolCallId = null;

const DEFAULT_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
function optionsOf(kinds) {
  if (!Array.isArray(kinds)) return DEFAULT_OPTIONS;
  const all = [...DEFAULT_OPTIONS, { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' }];
  return kinds.map((k) => all.find((o) => o.kind === k)).filter(Boolean);
}

async function exitNow(code, words) {
  if (words) process.stderr.write(`${words}\n`);
  for (const s of sessions.values()) s.mcp?.close();
  await record({ event: 'exit', code });
  await posting;
  process.exit(code);
}

// ---- the MCP server the session was given (the real bridge, or a test's stand-in) ----------

function startMcp(server, session) {
  const env = { ...process.env };
  for (const e of server.env || []) env[e.name] = e.value;
  let child;
  try {
    child = spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  } catch (err) {
    record({ event: 'mcp_error', error: String(err?.message || err) });
    return null;
  }
  const mcp = { child, pending: new Map(), next: 1, tools: [], dead: false, onProgress: null };
  child.on('error', (err) => {
    mcp.dead = true;
    record({ event: 'mcp_error', error: String(err?.message || err) });
  });
  child.on('exit', (code) => {
    mcp.dead = true;
    for (const resolve of mcp.pending.values()) resolve({ error: { code: -1, message: `the MCP server exited (${code})` } });
    mcp.pending.clear();
    record({ event: 'mcp_exit', code });
  });
  child.stdin.on('error', () => {});
  if (child.pid) post('/pids', { role: 'mcp', pids: [child.pid], session });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === 'notifications/progress') mcp.onProgress?.(msg.params);
      else if (msg.id != null && mcp.pending.has(msg.id)) {
        const resolve = mcp.pending.get(msg.id);
        mcp.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) record({ event: 'mcp_message', method: msg.method });
    }
  });
  mcp.request = (method, params) =>
    new Promise((resolve) => {
      if (mcp.dead) return resolve({ error: { code: -1, message: 'the MCP server is not running' } });
      const id = mcp.next++;
      mcp.pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  mcp.notify = (method, params) => {
    if (!mcp.dead) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  };
  mcp.close = () => {
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
  };
  mcp.ready = (async () => {
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fake-acp-agent', version: '1.0.0' },
    });
    if (init.error) {
      record({ event: 'mcp_error', error: init.error.message });
      return;
    }
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list', {});
    mcp.tools = (list.result?.tools || []).map((t) => t.name);
    record({ event: 'mcp_tools', tools: mcp.tools, instructions: init.result?.instructions ?? null });
  })();
  return mcp;
}

// ---- the session ----------------------------------------------------------------------------

const STYLE = () => config.style || 'none';

function ourToolCall(tool, title, status) {
  const id = `call-${(toolSeq += 1)}`;
  lastToolCallId = id;
  const u = { sessionUpdate: 'tool_call', toolCallId: id, status, kind: 'other', title: title || tool };
  if (STYLE() === 'tool_name_meta') {
    u._meta = { claudeCode: { toolName: `mcp__magnusim__${tool}`, mcpServer: { name: 'magnusim', source: 'config' } } };
  } else if (STYLE() === 'mcp_call_flag') {
    u.kind = 'execute';
    u.title = `mcp.magnusim.${tool}`;
    u._meta = { is_mcp_tool_call: true };
  }
  return u;
}

function cancelPromise(p) {
  return new Promise((resolve) => p.cancelWaiters.push(resolve));
}

/** Waits for `promise` unless the prompt is cancelled first (and cancels count). */
async function orCancel(p, promise) {
  if (p.cancelled && !p.ignoreCancel) return { cancelled: true };
  const r = await Promise.race([promise.then((value) => ({ value })), cancelPromise(p).then(() => ({ cancelled: true }))]);
  if (r.cancelled && p.ignoreCancel) return { value: await promise };
  return r;
}

async function askPermission(p, toolCall, options, meta) {
  const params = { sessionId: p.sessionId, toolCall, options };
  if (meta) params._meta = meta;
  const answer = await requestClient('session/request_permission', params);
  const outcome = answer?.result?.outcome ?? null;
  record({ event: 'permission_outcome', toolCallId: toolCall.toolCallId, outcome });
  return outcome;
}

async function runCall(p, step) {
  const s = sessions.get(p.sessionId);
  const u = ourToolCall(step.tool, step.title, 'pending');
  sessionUpdate(p.sessionId, u);
  sessionUpdate(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId, status: 'in_progress' });
  if (!s?.mcp) {
    record({ event: 'mcp_result', tool: step.tool, error: 'no MCP server' });
    sessionUpdate(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId, status: 'failed' });
    return;
  }
  await s.mcp.ready;
  const exiting = exitDuringCall;
  exitDuringCall = false;
  const token = `p-${u.toolCallId}`;
  if (exiting) s.mcp.onProgress = (pr) => pr?.progressToken === token && exitNow(1, 'fake agent: exiting during a call');
  const result = await s.mcp.request('tools/call', { name: step.tool, arguments: step.args || {}, _meta: { progressToken: token } });
  s.mcp.onProgress = null;
  if (exiting) await exitNow(1, 'fake agent: exiting during a call');
  record({ event: 'mcp_result', tool: step.tool, result: result.result ?? null, error: result.error ?? null });
  const failed = !!result.error || result.result?.isError === true;
  sessionUpdate(p.sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: u.toolCallId,
    status: failed ? 'failed' : 'completed',
    ...(u._meta ? { _meta: u._meta } : {}),
  });
}

async function runStep(p, raw) {
  const step = typeof raw === 'string' ? { [raw]: true } : raw;
  const [name] = Object.keys(step);
  const v = step[name];
  switch (name) {
    case 'say':
      sessionUpdate(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(v) } });
      return;
    case 'think':
      sessionUpdate(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(v) } });
      return;
    case 'plan':
      sessionUpdate(p.sessionId, {
        sessionUpdate: 'plan',
        entries: v.map((e) => (typeof e === 'string' ? { content: e, priority: 'medium', status: 'pending' } : { priority: 'medium', status: 'pending', ...e })),
      });
      return;
    case 'call':
      await runCall(p, v);
      return;
    case 'askOurs': {
      if (STYLE() === 'mcp_call_flag') return runStep(p, { askOursCorrelated: { tool: v.tool } });
      const toolCall = { toolCallId: `call-${(toolSeq += 1)}`, title: v.title || v.tool, kind: 'other', status: 'pending' };
      if (STYLE() === 'tool_name_meta') {
        toolCall._meta = { claudeCode: { toolName: `mcp__magnusim__${v.tool}`, mcpServer: { name: 'magnusim', source: 'config' } } };
      }
      await orCancel(p, askPermission(p, toolCall, optionsOf(v.options)));
      return;
    }
    case 'askOursCorrelated': {
      let id = v.toolCallId;
      if (v.announce !== false) {
        const u = ourToolCall(v.tool, null, 'pending');
        sessionUpdate(p.sessionId, u);
        id = id || u.toolCallId;
      }
      id = id || lastToolCallId || 'call-unknown';
      const toolCall = { toolCallId: id, kind: 'execute', status: 'pending' };
      await orCancel(p, askPermission(p, toolCall, optionsOf(v.options), { is_mcp_tool_approval: true }));
      return;
    }
    case 'askOwn': {
      const toolCall = { toolCallId: `own-${(toolSeq += 1)}`, title: v.title, kind: v.kind || 'execute', status: 'pending' };
      if (v.rawInput !== undefined) toolCall.rawInput = v.rawInput;
      if (v.toolName && STYLE() === 'tool_name_meta') toolCall._meta = { claudeCode: { toolName: v.toolName } };
      sessionUpdate(p.sessionId, { sessionUpdate: 'tool_call', ...toolCall });
      await orCancel(p, askPermission(p, toolCall, optionsOf(v.options)));
      return;
    }
    case 'ownTool': {
      const id = v.id || `own-${(toolSeq += 1)}`;
      const isNew = !p.ownSeen.has(id);
      p.ownSeen.add(id);
      sessionUpdate(p.sessionId, {
        sessionUpdate: isNew ? 'tool_call' : 'tool_call_update',
        toolCallId: id,
        title: v.title,
        kind: v.kind || 'execute',
        status: v.status || 'pending',
      });
      return;
    }
    case 'hold': {
      await record({ event: 'holding', name: v });
      await orCancel(p, getJson(`/hold?name=${encodeURIComponent(v)}`));
      return;
    }
    case 'crash':
      await exitNow(1, typeof v === 'string' ? v : 'fake agent: crashed on purpose');
      return;
    case 'exitDuringCall':
      exitDuringCall = true;
      return;
    case 'ignoreCancel':
      p.ignoreCancel = true;
      return;
    case 'spawnHelpers': {
      const o = v && typeof v === 'object' ? v : { count: v };
      const n = Number(o.count) || 1;
      const pids = typeof o.onTerm === 'string' ? await spawnTidyHelpers(n, o.onTerm) : spawnHelpers(n);
      await post('/pids', { role: 'helper', pids });
      return;
    }
    case 'switchMode': {
      const s = sessions.get(p.sessionId);
      if (s) s.mode = v;
      sessionUpdate(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: v });
      if (s?.configOptions?.some((o) => o.category === 'mode')) {
        for (const o of s.configOptions) if (o.category === 'mode') o.currentValue = v;
        sessionUpdate(p.sessionId, { sessionUpdate: 'config_option_update', configOptions: s.configOptions });
      }
      return;
    }
    case 'stop':
      p.stopReason = v;
      return;
    case 'error':
      p.error = v;
      return;
    case 'update':
      sessionUpdate(p.sessionId, v);
      return;
    case 'later':
      p.later.push(v);
      return;
    case 'request': {
      const answer = await requestClient(v.method, v.params ?? {});
      record({ event: 'request_answer', method: v.method, answer });
      return;
    }
    default:
      log(`unknown step ${name}`);
  }
}

async function runPrompt(id, params) {
  const sessionId = params?.sessionId;
  if (!sessions.has(sessionId)) return replyError(id, -32602, `unknown session ${sessionId}`);
  if (current) return replyError(id, -32603, 'a prompt is already running');
  const p = { id, sessionId, cancelled: false, ignoreCancel: false, cancelWaiters: [], stopReason: null, error: null, ownSeen: new Set(), later: [] };
  current = p;
  try {
    const { steps } = await postJson('/prompt', { sessionId, prompt: params.prompt });
    for (const step of steps || []) {
      if (p.cancelled && !p.ignoreCancel) break;
      if (p.stopReason || p.error) break;
      await runStep(p, step);
    }
  } catch (err) {
    log(`prompt failed: ${err?.message || err}`);
  }
  current = null;
  if (p.error) replyError(id, p.error.code ?? -32603, p.error.message ?? 'error');
  else if (p.cancelled && !p.ignoreCancel) reply(id, { stopReason: 'cancelled' });
  else reply(id, { stopReason: p.stopReason || 'end_turn' });
  // Between prompts: what it sends after its answer.
  for (const l of p.later) {
    if (l.hold) {
      await record({ event: 'holding', name: l.hold });
      await getJson(`/hold?name=${encodeURIComponent(l.hold)}`);
    }
    sessionUpdate(sessionId, l.update);
  }
}

async function postJson(path, body) {
  await posting;
  return control('POST', path, { ...body, pid: process.pid, instance: INSTANCE });
}

function sessionModes() {
  return config.modes === null
    ? undefined
    : config.modes || { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] };
}

function defaultConfigOptions(mode) {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'fake-large',
      options: [
        { value: 'fake-large', name: 'Fake large' },
        { value: 'fake-small', name: 'Fake small' },
      ],
    },
  ];
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const result = {
        protocolVersion: config.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: !!config.loadSession,
          promptCapabilities: { image: !!config.images, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: config.authMethods || [],
        agentInfo: config.agentInfo || { name: 'fake-acp-agent', title: 'Fake agent', version: '1.2.3' },
      };
      return reply(id, result);
    }
    case 'authenticate': {
      if (config.authSignsIn !== false && config.marker) writeFileSync(config.marker, 'signed in');
      return reply(id, {});
    }
    case 'session/new': {
      if (config.requireSignIn && !(config.marker && existsSync(config.marker))) {
        return replyError(id, -32000, 'Authentication required');
      }
      const sessionId = `fake-session-${sessions.size + 1}`;
      const modesState = sessionModes();
      const s = {
        id: sessionId,
        mode: modesState?.currentModeId ?? 'default',
        configOptions: config.configOptions === null ? null : config.configOptions || defaultConfigOptions(modesState?.currentModeId ?? 'default'),
        mcp: null,
      };
      sessions.set(sessionId, s);
      const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
      const stdio = servers.filter((sv) => sv && typeof sv.command === 'string' && (STYLE() !== 'tool_name_meta' || !('type' in sv)));
      if (servers.length && !stdio.length) record({ event: 'mcp_skipped', reason: 'no stdio server without a type key' });
      if (stdio[0]) {
        s.mcp = startMcp(stdio[0], sessionId);
        if (s.mcp) await s.mcp.ready;
      }
      const result = { sessionId };
      if (modesState) result.modes = modesState;
      if (s.configOptions) result.configOptions = s.configOptions;
      if (config.models) result.models = config.models;
      reply(id, result);
      // Once per session: a file read the client must refuse.
      requestClient('fs/read_text_file', { sessionId, path: join(String(params?.cwd || '.'), 'notes.txt') }).then((answer) =>
        record({ event: 'fs_answer', answer }),
      );
      return undefined;
    }
    case 'session/prompt':
      return runPrompt(id, params);
    case 'session/set_mode': {
      const s = sessions.get(params?.sessionId);
      const known = sessionModes()?.availableModes?.some((m) => m.id === params?.modeId);
      if (!s || !known) return replyError(id, -32602, `unknown mode ${params?.modeId}`);
      s.mode = params.modeId;
      return reply(id, {});
    }
    case 'session/set_config_option': {
      const s = sessions.get(params?.sessionId);
      const opt = s?.configOptions?.find((o) => o.id === params?.configId);
      if (!opt || !opt.options.some((o) => o.value === params?.value)) return replyError(id, -32602, `unknown value ${params?.value}`);
      opt.currentValue = params.value;
      if (opt.category === 'mode') s.mode = params.value;
      return reply(id, { configOptions: s.configOptions });
    }
    case 'session/set_model': {
      if (!config.models) return replyError(id, -32601, 'Method not found: session/set_model');
      if (!config.models.availableModels?.some((m) => m.modelId === params?.modelId)) return replyError(id, -32602, 'unknown model');
      config.models.currentModelId = params.modelId;
      return reply(id, {});
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function handleNotification(msg) {
  if (msg.method === 'session/cancel' && current && current.sessionId === msg.params?.sessionId) {
    current.cancelled = true;
    for (const w of current.cancelWaiters.splice(0)) w();
  }
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('not JSON:', line.slice(0, 80));
    return;
  }
  record({ dir: 'in', msg });
  if (msg.method && msg.id != null) {
    Promise.resolve(handleRequest(msg)).catch((err) => {
      log(`request failed: ${err?.message || err}`);
      replyError(msg.id, -32603, String(err?.message || err));
    });
  } else if (msg.method) handleNotification(msg);
  else if (msg.id != null && waiting.has(msg.id)) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve(msg);
  }
}

// ---- start ----------------------------------------------------------------------------------

config = await getJson('/config');
if (config.stderrAtStart) process.stderr.write(`${config.stderrAtStart}\n`);
if (config.stubborn) {
  process.on('SIGTERM', () => log('ignoring SIGTERM'));
  process.on('SIGHUP', () => {});
}
await post('/pids', { role: 'agent', pids: [process.pid] });
if (startHelpers.length) await post('/pids', { role: 'helper', pids: startHelpers, atStart: true });
if (Array.isArray(config.envReport)) {
  await record({ event: 'env', present: config.envReport.filter((k) => process.env[k] !== undefined), cwd: process.cwd() });
}

let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inbuf += d;
  let nl;
  while ((nl = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, nl).replace(/\r$/, '');
    inbuf = inbuf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});
process.stdin.on('end', () => {
  if (config.stubborn) {
    log('input ended; staying (stubborn)');
    setInterval(() => {}, 1 << 30);
    return;
  }
  exitNow(0);
});
