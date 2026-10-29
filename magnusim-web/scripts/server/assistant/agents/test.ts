/**
 * Settings' Test of a coding agent, its connect check and its sign-in (phase 3 spec 4.12, 4.13).
 *
 * POST /api/assistant/agents/test {id, message}: one at a time, 90 s at most, and the request
 * closing stops it.
 * 1. The agent starts (contained, as a turn's), `initialize`, `session/new` with a Test binding:
 *    its MCP list is only connection_check, answered by the MCP server's own Test path (never a
 *    tool of the person's). The modes and models it lists are kept for its row.
 * 2. With message:true, one prompt: call connection_check with word "ok", then reply "done";
 *    at most 60 s for its stop reason. `tools` says whether it called it.
 * 3. The agent ends (the tree kill).
 * The connect check (message:false) sends nothing. It may start a known agent's own verified
 * package with its switch off (the program the person installed, with Magnusim's lockdown);
 * anything whose own tools stay on needs its switch, for the check as for the Test
 * (discover.ts agentStartRefusal).
 *
 * POST /api/assistant/agents/sign-in {id, method}: an `agent`-type method from the agent's own
 * `initialize` (it signs in by itself, for example in a browser): a short-lived process gets
 * `initialize` then `authenticate` (10 minutes), and ends. Never started by Magnusim on its own.
 *
 * Each needs a proof of this account, as an agent turn's start does (TurnManager.launchProven:
 * this launch's token, or an app tab's live relay link, which Settings sends): a run starts a
 * program as the person, and any other account on this PC can reach these routes. Without it,
 * 403 `launch_proof` before anything is looked for or started.
 *
 * Both count toward the 2 agents at once (host.ts): a third is refused 409 `busy`. Each is
 * tagged with the server lifetime (TurnManager) whose route started it, so that lifetime's
 * shutdown stops it (host.ts endLifetime), and the checks run again when the agent's switch
 * went off while they read the settings (host.ts offEpoch).
 *
 * The sign-in block (SignInView) is built from what the agent sent: a terminal command is shown
 * (with Copy) only when it is safe to paste into a shell (acp.ts terminalSignIn), otherwise the
 * method says to sign in the agent's own way, with no command.
 */
import { randomBytes } from 'node:crypto';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { realClock } from '../gates.ts';
import { appVersion } from '../host-tools.ts';
import { alog } from '../log.ts';
import { mcpListenerStatus, mcpUnavailableText, startMcpListener } from '../mcp/listener.ts';
import { mintBinding } from '../mcp/sessions.ts';
import { CONNECTION_CHECK } from '../provider-test.ts';
import { cleanText } from '../sanitize.ts';
import { agentPrefs, isAgentOf, loadSettings, setAgentLockdownFailed, type AssistantSettings } from '../settings.ts';
import { OursMatcher, pickOption, REJECT_KINDS, terminalSignIn, type AuthMethodView, type ModelView, type ModeView } from './acp.ts';
import { agentRow, agentStartRefusal, ensureAgents, rememberAgentImages, rememberAgentLast, rememberAgentSignIn, rememberAgentWord, resolveAgentNow, type AgentEntry, type AgentRow } from './discover.ts';
import { agentHost, AGENTS_BUSY_TEXT, type Transient } from './host.ts';
import { knownAgent, policyOf } from './known.ts';
import { AGENT_TOOLS_MS, AgentRunError, AgentSession, agentErrorOf, type FoundAgent } from './session.ts';
import { agentNode } from './node.ts';

type Answer = { status: number; body: Record<string, unknown> };

/** The Test's own limit (the request closing stops it sooner). */
export const AGENT_TEST_MS = 90_000;
/** The Test message's wait for the agent's answer. */
export const AGENT_TEST_PROMPT_MS = 60_000;
/** A sign-in's limit (a browser sign-in). */
export const AGENT_SIGN_IN_MS = 600_000;

export const TEST_PROMPT = 'Call the connection_check tool of the magnusim server with word "ok", then reply with the single word done.';

// ---------------------------------------------------------------- the sign-in block

/** One way to sign in, as Settings shows it (spec 4.12, 5.7). */
export interface SignInMethod {
  /** As the agent sent it (POST /agents/sign-in takes it back). */
  id: string;
  name: string;
  description: string;
  type: 'terminal' | 'agent' | 'env_var';
  /**
   * terminal: exactly the line shown and copied, or null when it isn't safe to paste (then
   * "Sign in to <Name> the way its own documentation says.", with no command and no Copy).
   */
  command: string | null;
  /** env_var (and an agent method naming a key variable): the variables the person may set instead. */
  vars: string[];
}

/** A row's sign-in block (`sign_in`), from the last auth_required. */
export interface SignInView {
  methods: SignInMethod[];
  at: string;
}

/** The sign-in methods as Settings shows them; a terminal command only when it is safe. */
export function signInMethods(auth: readonly AuthMethodView[], agent: Pick<FoundAgent, 'argv' | 'script' | 'programName' | 'program' | 'lockdown' | 'allowed'> | null, platform: NodeJS.Platform = process.platform): SignInMethod[] {
  return auth.map((m) => {
    let command: string | null = null;
    if (m.type === 'terminal' && agent && agent.argv.length) {
      const nodeScript = agent.argv[0] === (agentNode() ?? process.execPath) && !!agent.script;
      const shown = (agent.programName ?? '').replace(platform === 'win32' ? /\.(exe|cmd|bat)$/i : /$^/, '');
      command =
        terminalSignIn(m, {
          // An agent that isn't allowed never gets a command to paste into a shell (D-B).
          allowed: agent.lockdown !== 'none' || agent.allowed,
          program: agent.argv[0],
          script: nodeScript ? agent.script : null,
          programName: shown,
          platform,
        })?.line ?? null;
    }
    return { id: m.id, name: m.name, description: m.description, type: m.type, command, vars: [...m.vars] };
  });
}

export function signInView(auth: readonly AuthMethodView[], agent: Parameters<typeof signInMethods>[1]): Record<string, unknown> {
  const view: SignInView = { methods: signInMethods(auth, agent), at: new Date().toISOString() };
  return view as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------- finding the agent

/** The agent's discovery entry and row now: the cache (refreshed when older than 5 minutes), a custom agent resolved again when its command changed. */
export async function findAgentNow(id: string, settings: AssistantSettings, mcp: { available: boolean; reason: string | null }): Promise<{ entry: AgentEntry; row: AgentRow } | null> {
  const d = await ensureAgents();
  let entry: AgentEntry | null = d.agents.find((a) => a.id === id) ?? null;
  const custom = settings.custom_agents.find((c) => c.id === id);
  if (!entry || (custom && (!entry.command || entry.command.length !== custom.argv.length || entry.command.some((p, i) => p !== custom.argv[i])))) {
    entry = await resolveAgentNow(id, settings);
  }
  if (!entry) return null;
  return { entry, row: agentRow(entry, { settings, mcp, appVersion: await appVersion() }) };
}

/** The agent as a session starts it, from its entry and its row. */
export function foundAgentOf(entry: AgentEntry, row: AgentRow): FoundAgent {
  return {
    id: entry.id,
    name: cleanText(row.name, 64) || entry.id,
    kind: entry.kind,
    argv: [...(entry.argv ?? [])],
    program: entry.program,
    programName: entry.programName,
    script: entry.script,
    version: entry.version,
    fingerprint: entry.fingerprint,
    lockdown: row.lockdown,
    ownTools: row.own_tools,
    allowed: row.allowed,
    signedIn: row.signed_in,
    env: { ...entry.env },
    defaultAgent: entry.defaultAgent,
  };
}

// ---------------------------------------------------------------- the runs

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { ok: false, code, error, ...extra } });

const TESTING = Symbol.for('magnusim.assistant.agentTesting');

/** One Test or connect at a time (process-wide). */
function testingSlot(): { running: boolean } {
  const g = globalThis as unknown as Record<symbol, { running: boolean } | undefined>;
  let s = g[TESTING];
  if (!s) {
    s = { running: false };
    g[TESTING] = s;
  }
  return s;
}

interface Prepared {
  settings: AssistantSettings;
  found: FoundAgent;
  row: AgentRow;
}

/** What a Test, connect or sign-in refused for want of the proof says (the page sends its tab's live link). */
export const WINDOW_PROOF_TEXT = "Magnusim couldn't confirm that this came from its own window. Reload the page and try again.";

/** The checks before a Test, connect or sign-in starts anything: the agent, the proof, its switch, the tool connection. */
async function prepare(id: unknown, purpose: 'test' | 'connect' | 'sign_in', o: RunOptions): Promise<Prepared | Answer> {
  const settings = await loadSettings();
  if (!isAgentOf(settings, id)) return refuse(404, 'agent_unknown', `No coding agent called ${cleanText(id, 40) || '(none)'}. Settings → Assistant lists them.`);
  // The tool connection a session needs (the Test's own list is served there too); its token is
  // the CLI's proof.
  await startMcpListener().catch(() => null);
  // A proof of this account before anything is looked for or started: the switch alone (the
  // allow route) can be sent by any program on this PC.
  if (!o.proven()) return refuse(403, 'launch_proof', WINDOW_PROOF_TEXT);
  const found = await findAgentNow(id, settings, await o.mcp());
  if (!found) return refuse(404, 'agent_unknown', `No coding agent called ${cleanText(id, 40)}. Settings → Assistant lists them.`);
  const refusal = agentStartRefusal(found.row, purpose);
  if (refusal) return refuse(409, refusal.code, refusal.error, { agent: found.row });
  if (purpose !== 'sign_in') {
    const l = mcpListenerStatus();
    if (!l.running) {
      return refuse(409, 'mcp_unavailable', mcpUnavailableText(l.reason, l.port ?? settings.mcp.port));
    }
  }
  return { settings, found: foundAgentOf(found.entry, found.row), row: found.row };
}

/** A signal that aborts after `ms`, when `gone` aborts, or when the server shuts the Assistant down. */
function bounded(ms: number, gone?: AbortSignal): { signal: AbortSignal; done(): void } {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new AgentRunError('agent_no_answer', `The test took longer than ${Math.round(ms / 1000)} s.`)), ms);
  timer.unref?.();
  const onGone = () => abort.abort(new AgentRunError('stopped', 'The test was stopped.'));
  if (gone?.aborted) onGone();
  else gone?.addEventListener('abort', onGone, { once: true });
  return {
    signal: abort.signal,
    done() {
      clearTimeout(timer);
      gone?.removeEventListener('abort', onGone);
    },
  };
}

function failure(err: unknown, name: string, found: FoundAgent, auth: AuthMethodView[]): Answer {
  const e = agentErrorOf(err, name, auth);
  if (e instanceof AgentRunError) {
    const body: Record<string, unknown> = { ok: false, code: e.code, error: e.message };
    if (e.code === 'agent_signin') {
      const view = signInView(e.auth ?? auth, found);
      rememberAgentSignIn(found.id, view);
      body.auth = view.methods;
    }
    return { status: 200, body };
  }
  return { status: 200, body: { ok: false, code: 'agent_error', error: `${name} could not be tested: ${cleanText(String((err as Error)?.message ?? err), 200)}` } };
}

/** The modes and models a session lists (its row keeps them). */
function choicesOf(s: AgentSession): { modes: ModeView[]; models: ModelView[] } {
  const modes: ModeView[] = s.modes?.available.length
    ? s.modes.available.map((m) => ({ ...m }))
    : (s.config.find((o) => o.category === 'mode' && o.type === 'select')?.options.map((o) => ({ id: o.value, name: o.name, description: '' })) ?? []);
  const option = s.config.find((o) => o.category === 'model' && o.type === 'select');
  const models: ModelView[] = option ? option.options.map((o) => ({ id: o.value, name: o.name, description: '' })) : (s.models?.available.map((m) => ({ ...m })) ?? []);
  return { modes, models };
}

/** How many times a run's checks run before an agent stopped every time is refused. */
const PREPARE_ATTEMPTS = 3;

/**
 * The checks, then the run's agent slot, in one step: when the agent was stopped (its switch
 * went off, it was removed) while the checks read the settings, they run again.
 */
async function prepareAndTake(id: unknown, purpose: 'test' | 'connect' | 'sign_in', o: RunOptions): Promise<{ p: Prepared; tr: Transient } | Answer> {
  const host = agentHost();
  for (let attempt = 1; ; attempt += 1) {
    const epoch = host.offEpoch();
    const p = await prepare(id, purpose, o);
    if ('status' in p) return p;
    // From here to the slot nothing awaits.
    const off = host.offSince(p.found.id, epoch);
    if (off) {
      if (attempt < PREPARE_ATTEMPTS) continue;
      return refuse(409, 'agent_not_allowed', off.text);
    }
    const tr = host.takeTransient(p.found.id, o.manager ?? null);
    if (!tr) return refuse(409, 'busy', AGENTS_BUSY_TEXT);
    return { p, tr };
  }
}

/** What a Test, connect or sign-in run is given by its route. */
export interface RunOptions {
  mcp: () => Promise<{ available: boolean; reason: string | null }>;
  /** Whether the request proves it comes from this account (TurnManager.launchProven), read once the tool connection runs. */
  proven: () => boolean;
  /** The request went away. */
  gone?: AbortSignal;
  /** The server lifetime (TurnManager) whose route started it: its shutdown stops the run. */
  manager?: object | null;
  boundMs?: number;
  promptMs?: number;
}

/**
 * POST /api/assistant/agents/test {id, message}: {ok:true, agent, version, ms, signed_in,
 * auth_status, own_tools, images, modes, models, tools, auth?} or {ok:false, code, error, auth?}
 * (spec 4.13). `signed_in` is the login file's, read again now; `auth_status` is what the agent
 * itself said in its `_auth/status_update` ('none', 'signed_in', or null when it said nothing),
 * and a connect it says 'none' to carries its ways to sign in (`auth`). A connect to an agent
 * that says it reports its login (its `initialize`) waits for that word, within its bound. The
 * agent's word is kept for its row (discover.ts rememberAgentWord): its readiness follows it.
 */
export async function agentTestRequest(body: Record<string, unknown>, o: RunOptions): Promise<Answer> {
  if (body.message !== undefined && typeof body.message !== 'boolean') return refuse(400, 'bad_request', 'message must be true or false.');
  const message = body.message === true;
  const slot = testingSlot();
  if (slot.running) return refuse(409, 'busy', 'A test of a coding agent is already running.');
  slot.running = true;
  try {
    const got = await prepareAndTake(body.id, message ? 'test' : 'connect', o);
    if ('status' in got) return got;
    return await runTest(got.p, got.tr, message, o);
  } finally {
    slot.running = false;
  }
}

async function runTest(p: Prepared, tr: Transient, message: boolean, o: RunOptions): Promise<Answer> {
  const { found, row, settings } = p;
  const host = agentHost();
  const t0 = Date.now();
  const bound = bounded(o.boundMs ?? AGENT_TEST_MS, o.gone);
  const signal = AbortSignal.any([bound.signal, tr.abort.signal]);
  let called = false;
  const binding = mintBinding({ conversation: `test-${randomBytes(4).toString('hex')}`, agent: found.id, test: true, onTestCall: () => (called = true) });
  const known = knownAgent(found.id);
  const prefs = agentPrefs(settings, found.id);
  const session = new AgentSession({
    conversation: binding.conversation,
    agent: found,
    known,
    binding,
    prefs: { model: prefs.model, mode: prefs.mode },
    version: await appVersion(),
    ...host.sessionPlacement(),
    // The lockdown tripwire (its own tool while it starts or between prompts), recorded as a turn's is.
    onOffence: (_s, off) => {
      if (off.code === 'agent_lockdown') void appVersion().then((v) => setAgentLockdownFailed(found.id, v)).catch(() => {});
    },
  });
  tr.session = session;
  try {
    await session.start(signal);
    const choices = choicesOf(session);
    rememberAgentLast(found.id, { ...choices, at: new Date().toISOString() });
    rememberAgentImages(found.id, found.fingerprint, session.info.images);
    let tools: 'works' | 'not_used' | null = null;
    if (message) {
      // Its MCP server may still be connecting (session/new can come first): the message waits
      // for its list (bounded), so a working agent isn't reported as not using Magnusim's tools.
      await session.waitForTools({ signal, clock: realClock, ms: AGENT_TOOLS_MS });
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const matcher = new OursMatcher(policyOf(known).ours, (name) => name === CONNECTION_CHECK.name);
      const blocks: ContentBlock[] = [{ type: 'text', text: TEST_PROMPT }];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), o.promptMs ?? AGENT_TEST_PROMPT_MS);
      });
      const aborted = new Promise<'aborted'>((resolve) => {
        if (signal.aborted) resolve('aborted');
        else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const prompt = session
        .prompt(blocks, {
          onUpdate: (u) => {
            if (u.kind === 'tool') matcher.tool(u);
          },
          // Nobody is asked during a Test: Magnusim's test tool goes on, anything else is declined.
          onPermission: async (v) => (matcher.permission(v) ? pickOption(v.options, ['allow_once']) : pickOption(v.options, REJECT_KINDS)),
        })
        .then(
          (r) => ({ r }),
          (e: unknown) => ({ e }),
        );
      const outcome = await Promise.race([prompt, timedOut, aborted]);
      clearTimeout(timer);
      if (outcome === 'timeout') return { status: 200, body: { ok: false, code: 'agent_no_answer', error: `${found.name} didn't answer the test message in ${Math.round((o.promptMs ?? AGENT_TEST_PROMPT_MS) / 1000)} s.` } };
      if (outcome === 'aborted') throw signal.reason ?? new Error('aborted');
      if ('e' in outcome) throw outcome.e;
      tools = called ? 'works' : 'not_used';
    }
    // A connect: the agent's word on its login may come after its session started (one adapter
    // reads it in the background from initialize, and nothing there waits for it), so a connect
    // to an agent that says it reports it waits for it, within its bound.
    if (!message) {
      await session.waitAuthStatus(signal);
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    }
    const ms = Date.now() - t0;
    // The agent's own word on its login, apart from its login file (`signed_in`). A connect that
    // got through to an agent saying it isn't signed in keeps its ways to sign in on its row; one
    // that answered the Test's message is signed in, whatever it said. The row keeps the word
    // (its readiness, the Default choice and the status follow it).
    const said = session.authStatus;
    const signIn = !message && said === 'none' ? signInView(session.info.auth, found) : null;
    rememberAgentSignIn(found.id, signIn);
    rememberAgentWord(found.id, message ? 'signed_in' : (said ?? 'silent'));
    // The login file as it is now ("I've signed in: connect again"): the cached row may be older.
    const now = await resolveAgentNow(found.id, settings).catch(() => null);
    const answer: Record<string, unknown> = {
      ok: true,
      agent: found.name,
      version: session.info.version ?? found.version,
      ms,
      signed_in: now?.signedIn ?? row.signed_in,
      auth_status: said,
      own_tools: row.own_tools,
      images: session.info.images,
      modes: choices.modes,
      models: choices.models,
      tools,
      ...(signIn ? { auth: signIn.methods } : {}),
    };
    alog('info', 'agent test', { agent: found.id, ok: true, message, tools, auth_status: said, ms });
    return { status: 200, body: answer };
  } catch (err) {
    const why = signal.aborted ? signal.reason : err;
    const a = failure(why, found.name, found, session.info.auth);
    alog('info', 'agent test', { agent: found.id, ok: false, code: a.body.code, message });
    return a;
  } finally {
    bound.done();
    await session.end('test_done').catch(() => {});
    host.dropTransient(tr);
  }
}

/** POST /api/assistant/agents/sign-in {id, method}: {ok:true, agent} or {ok:false, code, error}. */
export async function agentSignInRequest(body: Record<string, unknown>, o: RunOptions): Promise<Answer> {
  if (typeof body.method !== 'string' || !body.method || body.method.length > 128) return refuse(400, 'bad_method', 'Name the way to sign in (a method the agent listed).');
  const method = body.method;
  const got = await prepareAndTake(body.id, 'sign_in', o);
  if ('status' in got) return got;
  const { p, tr } = got;
  const { found, settings } = p;
  const host = agentHost();
  const bound = bounded(o.boundMs ?? AGENT_SIGN_IN_MS, o.gone);
  const signal = AbortSignal.any([bound.signal, tr.abort.signal]);
  const prefs = agentPrefs(settings, found.id);
  const session = new AgentSession({
    conversation: `sign-in-${randomBytes(4).toString('hex')}`,
    agent: found,
    known: knownAgent(found.id),
    binding: mintBinding({ conversation: 'sign-in', agent: found.id, test: true }),
    prefs: { model: prefs.model, mode: prefs.mode },
    version: await appVersion(),
    ...host.sessionPlacement(),
  });
  tr.session = session;
  try {
    await session.signIn(method, signal);
    // Signed in by its own sign-in: its login file decides again until the next check.
    rememberAgentSignIn(found.id, null);
    rememberAgentWord(found.id, null);
    // Its login file may be there now.
    const again = await resolveAgentNow(found.id, await loadSettings()).catch(() => null);
    alog('info', 'agent sign-in', { agent: found.id, ok: true });
    return { status: 200, body: { ok: true, ...(again ? { agent: agentRow(again, { settings: await loadSettings(), mcp: { available: mcpListenerStatus().running, reason: mcpListenerStatus().reason }, appVersion: await appVersion() }) } : {}) } };
  } catch (err) {
    const why = signal.aborted ? signal.reason : err;
    const e = agentErrorOf(why, found.name, session.info.auth);
    alog('info', 'agent sign-in', { agent: found.id, ok: false, code: e instanceof AgentRunError ? e.code : 'agent_error' });
    if (e instanceof AgentRunError) return { status: e.code === 'bad_method' ? 400 : 200, body: { ok: false, code: e.code === 'agent_signin' ? 'agent_signin' : e.code, error: e.message } };
    return { status: 200, body: { ok: false, code: 'agent_error', error: `${found.name} could not sign in: ${cleanText(String((err as Error)?.message ?? err), 200)}` } };
  } finally {
    bound.done();
    await session.end('sign_in_done').catch(() => {});
    host.dropTransient(tr);
  }
}

/** For the provider Test (POST /api/assistant/test {provider:'agent:<id>'}): the agent Test with a message. */
export function agentProviderTest(id: string, o: RunOptions): Promise<Answer> {
  return agentTestRequest({ id, message: true }, o);
}

