/**
 * One coding agent working for one conversation (phase 3 spec 4.6): its process, the agent
 * protocol on its pipes, and its session.
 *
 * Starting (start()):
 * 1. The program starts contained (process.ts: no shell, its own private working folder, the
 *    environment allowlist plus the catalogue's own variables; on Windows inside its job before
 *    it runs anything, on POSIX as its own process group).
 * 2. `initialize`: the agent must speak protocol version 1 (else `agent_protocol`).
 * 3. When the catalogue has a start-up sign-in step and `initialize` advertised one of its
 *    methods, `authenticate` with the first advertised one (30 s); its failure is
 *    `agent_signin`.
 * 4. `session/new` with Magnusim's MCP server (the bridge with this session's binding) and the
 *    agent's own `_meta` (its lockdown); `auth_required` is `agent_signin`, with the sign-in
 *    methods `initialize` listed.
 * 5. The person's saved model through the session's `model` config option (else the legacy
 *    session/set_model when the agent reported models); one it refuses or doesn't list leaves
 *    the agent's own default, with a note.
 * 6. The mode: the saved one when Magnusim may use it, else the first allowed one (so a mode the
 *    person saved in the agent's own settings never carries in), through session/set_mode or the
 *    `mode` config option. A session whose mode isn't allowed and can't be set ends with
 *    `agent_mode`. An agent that may run only in the mode it starts in gets nothing set.
 *
 * Prompting (prompt()): session/prompt with no timeout of its own (the turn's limits bound it);
 * the session's updates and permission requests go to the turn's handlers while it runs.
 * Between prompts every permission request is answered `cancelled` at once and updates are
 * dropped.
 *
 * cancel(): every open permission request is answered `cancelled` first, then session/cancel
 * goes out (ACP's order). end(): the tree kill, the working folder removed, the binding
 * dropped (its MCP connection closes, and a bridge with it is refused from then on).
 *
 * Every request the agent sends that Magnusim doesn't serve (the file system, the terminal,
 * elicitation, anything else) gets -32601 (rpc.ts).
 *
 * The start order and the permission-before-cancel rule follow SolidCraft's agent chat
 * (acp_client.rs, MIT/Apache-2.0); the code is our own.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { ensurePrivateDir } from '../files.ts';
import { alog } from '../log.ts';
import { BRIDGE_SCRIPT, mcpInfoPath } from '../mcp/listener.ts';
import { dropBinding, type AgentBinding } from '../mcp/sessions.ts';
import { redact } from '../redact.ts';
import { cleanText } from '../sanitize.ts';
import { removeTree } from '../../../remove-tree.js';
import {
  ACP,
  agentInfo,
  authenticateParams,
  authMethods,
  cancelParams,
  configCurrent,
  configOptions,
  initializeParams,
  loadsSessions,
  models as readModels,
  modes as readModes,
  permission as readPermission,
  permissionReply,
  promptParams,
  protocolVersionOf,
  PROTOCOL_VERSION,
  sessionIdOf,
  sessionNewParams,
  sessionUpdate,
  setConfigOptionParams,
  setModelParams,
  setModeParams,
  stopReasonOf,
  takesImages,
  type AgentUpdate,
  type AuthMethodView,
  type ConfigOptionView,
  type ModelsView,
  type ModesView,
  type PermissionView,
  type StopReasonView,
} from './acp.ts';
import { policyOf, type KnownAgent, type Lockdown } from './known.ts';
import { AgentStartError, startAgentProcess, WORKDIR_PREFIX, type AgentEnvSpec, type AgentProcess } from './process.ts';
import { RpcError, RpcExited, RpcPeer, RpcTimeout, type ExitInfo, type RpcId } from './rpc.ts';
import type { SignedIn } from './discover.ts';

/** A coding agent as a turn (or a Settings Test) starts it: what discovery found, as its row read it. */
export interface FoundAgent {
  id: string;
  /** The catalogue's name, or the person's name for a custom agent (cleaned). */
  name: string;
  kind: 'known' | 'custom';
  /** The launch command: program first (never through a shell). */
  argv: string[];
  program: string | null;
  /** Its name as found (the sign-in command shows it). */
  programName: string | null;
  script: string | null;
  version: string | null;
  fingerprint: string | null;
  /** Its class as resolved for this start (a fired lockdown tripwire makes it 'none'). */
  lockdown: Lockdown;
  ownTools: 'off' | 'on';
  /** Its allow switch is on for this very command. */
  allowed: boolean;
  signedIn: SignedIn;
  env: AgentEnvSpec;
  /** OpenCode: the person's default agent (its permissions are overridden too). */
  defaultAgent: string | null;
}

/** Why a start, a sign-in or a prompt failed, as the turn ends or the Test answers. */
export class AgentRunError extends Error {
  readonly code: string;
  /** agent_signin: the sign-in methods `initialize` listed. */
  readonly auth: AuthMethodView[] | null;
  constructor(code: string, message: string, auth: AuthMethodView[] | null = null) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
    this.auth = auth;
  }
}

export const SIGN_IN_TEXT = (name: string) => `${name} isn't signed in. Settings → Assistant shows how to sign in.`;
export const STOPPED_UNEXPECTEDLY_TEXT = (name: string) => `${name} stopped unexpectedly.`;
export const MODE_TEXT = (name: string) => `${name} switched itself to a mode that skips its questions, so Magnusim stopped it.`;

/** The agent's last stderr line, as a turn's end shows it (already redacted and cleaned by process.ts). */
export function lastWords(tail: readonly string[]): string | null {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = cleanText(redact(tail[i]), 200);
    if (line) return line;
  }
  return null;
}

/** "<Agent> stopped unexpectedly." plus its last words when it left any. */
export function exitedText(name: string, tail: readonly string[]): string {
  const words = lastWords(tail);
  return `${STOPPED_UNEXPECTEDLY_TEXT(name)}${words ? ` Its last words: '${words.replace(/'/g, '’')}'` : ''}`;
}

/** Any failure of the agent's pipes or answers, as an AgentRunError (an abort is passed on as it is). */
export function agentErrorOf(err: unknown, name: string, auth: AuthMethodView[] | null): unknown {
  if (err instanceof AgentRunError) return err;
  if (err instanceof RpcExited) return new AgentRunError('agent_exited', exitedText(name, err.tail));
  if (err instanceof RpcTimeout) return new AgentRunError('agent_no_answer', `${name} didn't answer ${err.method} in ${Math.round(err.ms / 1000)} s.`);
  if (err instanceof RpcError) {
    if (err.authRequired) return new AgentRunError('agent_signin', SIGN_IN_TEXT(name), auth);
    return new AgentRunError('agent_error', `${name} answered with an error: ${cleanText(redact(err.message), 200) || 'no reason given'}`);
  }
  if (err instanceof AgentStartError) {
    if (err.code === 'agent_missing') return new AgentRunError('agent_missing', `${name} isn't installed on this PC. Settings → Assistant shows how to install it.`);
    return new AgentRunError('agent_exited', `${name} could not be started: ${cleanText(redact(err.message), 200)}`);
  }
  return err;
}

/** The handlers of one prompt. */
export interface PromptHandlers {
  onUpdate(u: AgentUpdate): void;
  /** The option to pick (raw optionId), or null for cancelled. */
  onPermission(p: PermissionView): Promise<string | null>;
}

interface OpenPermission {
  id: RpcId;
  view: PermissionView;
  answered: boolean;
}

export interface AgentSessionOptions {
  conversation: string;
  agent: FoundAgent;
  known: KnownAgent | null;
  binding: AgentBinding;
  /** The person's saved choices for this agent. */
  prefs: { model: string | null; mode: string | null };
  /** Magnusim's version (clientInfo). */
  version: string;
  /** The environment the allowlist reads (tests: the test home's). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Where the working folder goes (tests: their own temp folder). */
  tmp?: string;
  graceMs?: number;
  /** The process ended (any way): the host forgets the session. */
  onExit?: (s: AgentSession, info: ExitInfo) => void;
  /** An adapter's `_auth/status_update` (display only). */
  onAuthStatus?: (kind: string) => void;
}

export type SessionState = 'starting' | 'ready' | 'prompting' | 'cancelling' | 'ended';

export class AgentSession {
  readonly conversation: string;
  readonly agent: FoundAgent;
  readonly binding: AgentBinding;
  state: SessionState = 'starting';
  info: { name: string; version: string | null; images: boolean; loadSession: boolean; auth: AuthMethodView[] } = {
    name: '',
    version: null,
    images: false,
    loadSession: false,
    auth: [],
  };
  sessionId: string | null = null;
  modes: ModesView | null = null;
  models: ModelsView | null = null;
  config: ConfigOptionView[] = [];
  /** The mode the session started in (an agent that may use only that one). */
  initialMode: string | null = null;
  /** The mode the session is in now, as far as Magnusim knows. */
  mode: string | null = null;
  model: string | null = null;
  /** What the start says to the turn (a model the agent didn't take). */
  readonly notes: string[] = [];
  /** The agent's `_auth/status_update` said it isn't signed in (display only). */
  authNone = false;
  proc: AgentProcess | null = null;
  private rpc: RpcPeer | null = null;
  private readonly o: AgentSessionOptions;
  private handlers: PromptHandlers | null = null;
  private readonly open = new Map<string, OpenPermission>();
  private ending: Promise<void> | null = null;
  private extraDir: string | null = null;
  private permSerial = 0;

  constructor(o: AgentSessionOptions) {
    this.o = o;
    this.conversation = o.conversation;
    this.agent = o.agent;
    this.binding = o.binding;
    this.info.name = o.agent.name;
    this.info.version = o.agent.version;
  }

  get alive(): boolean {
    return this.state !== 'ended' && !this.proc?.exitInfo && !this.rpc?.closed;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  // ------------------------------------------------------------ starting

  /** Spawns the agent and contains it, then initialize (and nothing more): the sign-in route's and start()'s first part. */
  private async spawnAndInit(signal: AbortSignal): Promise<unknown> {
    // A test home's own temp folder may not be there yet.
    if (this.o.tmp) await mkdir(this.o.tmp, { recursive: true }).catch(() => {});
    const env = await this.envSpec();
    let proc: AgentProcess;
    try {
      proc = await startAgentProcess({ argv: this.agent.argv, label: this.agent.id, env, baseEnv: this.o.baseEnv, tmp: this.o.tmp, graceMs: this.o.graceMs, signal });
    } catch (err) {
      throw agentErrorOf(err, this.agent.name, null);
    }
    this.proc = proc;
    if (this.state === 'ended') {
      // Ended while it started: it goes at once.
      await proc.stop('ended_while_starting');
      throw new AgentRunError('agent_exited', STOPPED_UNEXPECTEDLY_TEXT(this.agent.name));
    }
    void proc.exited.then((info) => this.onProcessExit(info));
    this.rpc = new RpcPeer({
      input: proc.stdout,
      output: proc.stdin,
      tail: () => proc.tail(),
      exited: proc.exited,
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onNotification: (method, params) => this.onNotification(method, params),
    });
    const init = await this.request(ACP.initialize, initializeParams(this.o.version), signal);
    const pv = protocolVersionOf(init);
    if (pv !== PROTOCOL_VERSION) {
      throw new AgentRunError('agent_protocol', `${this.agent.name} speaks another version of the agent protocol (${pv ?? 'none'}); Magnusim speaks ${PROTOCOL_VERSION}.`);
    }
    const ai = agentInfo(init);
    this.info = {
      name: this.agent.name,
      version: ai?.version ?? this.agent.version,
      images: takesImages(init),
      loadSession: loadsSessions(init),
      auth: authMethods(init),
    };
    return init;
  }

  /** Starts the agent and its session (see the header). Throws AgentRunError (or the signal's reason). */
  async start(signal: AbortSignal): Promise<void> {
    try {
      await this.spawnAndInit(signal);
      const policy = policyOf(this.o.known);
      // A start-up sign-in step (headless agents), with the first method initialize advertised.
      const startAuth = policy.startAuth;
      if (startAuth) {
        const method = this.info.auth.find((m) => startAuth.methods.includes(m.id));
        if (method) {
          try {
            await this.request(ACP.authenticate, authenticateParams(method.id, startAuth.meta ? { ...startAuth.meta } : null), signal, 30_000);
          } catch (err) {
            const e = agentErrorOf(err, this.agent.name, this.info.auth);
            if (e instanceof AgentRunError && e.code !== 'agent_exited') throw new AgentRunError('agent_signin', SIGN_IN_TEXT(this.agent.name), this.info.auth);
            throw e;
          }
        }
      }
      const params = sessionNewParams(
        (this.proc as AgentProcess).cwd,
        { command: process.execPath, script: BRIDGE_SCRIPT, binding: this.binding.id, info: mcpInfoPath() },
        { sessionMeta: policy.sessionMeta },
      );
      const s = await this.request(ACP.sessionNew, params, signal);
      this.sessionId = sessionIdOf(s);
      if (!this.sessionId) throw new AgentRunError('agent_error', `${this.agent.name} answered session/new without a session id.`);
      this.modes = readModes(s);
      this.config = configOptions(s);
      this.models = readModels(s);
      this.mode = this.modes?.current || configCurrent(this.config, 'mode')?.value || null;
      this.initialMode = this.mode;
      this.model = configCurrent(this.config, 'model')?.value ?? this.models?.current ?? null;
      await this.applyModel(signal);
      await this.applyMode(signal);
      if (this.state === 'starting') this.state = 'ready';
    } catch (err) {
      const e = signal.aborted ? (signal.reason ?? err) : agentErrorOf(err, this.agent.name, this.info.auth);
      void this.end('start_failed');
      throw e;
    }
  }

  /**
   * The sign-in route's run: spawn, initialize, then `authenticate` with that method (10 minutes:
   * a browser sign-in); the session ends after. The method must be one `initialize` listed as
   * the agent's own (`agent` type).
   */
  async signIn(methodId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.spawnAndInit(signal);
      const m = this.info.auth.find((x) => x.id === methodId);
      // Only a way the agent signs in by itself: a terminal command is the person's to run, a
      // variable theirs to set.
      if (!m || m.type !== 'agent') throw new AgentRunError('bad_method', `${this.agent.name} doesn't offer that way to sign in here.`);
      await this.request(ACP.authenticate, authenticateParams(m.id), signal, 600_000);
    } catch (err) {
      throw signal.aborted ? (signal.reason ?? err) : agentErrorOf(err, this.agent.name, this.info.auth);
    } finally {
      await this.end('sign_in_done');
    }
  }

  /** The person's saved model (step 5): a refused or unlisted one leaves the agent's own, with a note. */
  private async applyModel(signal: AbortSignal): Promise<void> {
    const want = this.o.prefs.model;
    if (!want || want === this.model) return;
    const option = this.config.find((o) => o.category === 'model' && o.type === 'select');
    const refused = (): void => {
      this.notes.push(`${this.agent.name} didn't take the model ${cleanText(want, 128)}; it uses its own default.`);
    };
    try {
      if (option) {
        if (!option.options.some((x) => x.value === want)) return refused();
        const r = await this.request(ACP.setConfigOption, setConfigOptionParams(this.sessionId as string, option.id, want), signal);
        const next = configOptions(r);
        if (next.length) this.config = next;
        this.model = want;
      } else if (this.models) {
        if (!this.models.available.some((x) => x.id === want)) return refused();
        await this.request(ACP.setModel, setModelParams(this.sessionId as string, want), signal);
        this.model = want;
      } else {
        refused();
      }
    } catch (err) {
      if (signal.aborted || err instanceof RpcExited) throw err;
      refused();
    }
  }

  /** The modes Magnusim may use with this agent ('initial': only the one it starts in). */
  allowedModes(): readonly string[] | 'initial' {
    return policyOf(this.o.known).allowedModes;
  }

  /** Whether `mode` is one Magnusim lets this session be in. */
  modeAllowed(mode: string | null): boolean {
    if (mode === null) return true;
    const allowed = this.allowedModes();
    if (allowed === 'initial') return mode === this.initialMode;
    return allowed.includes(mode);
  }

  /** The mode (step 6): the saved one when allowed, else the first allowed; set when the session lists it. */
  private async applyMode(signal: AbortSignal): Promise<void> {
    const allowed = this.allowedModes();
    if (allowed === 'initial') return;
    const want = this.o.prefs.mode && allowed.includes(this.o.prefs.mode) ? this.o.prefs.mode : allowed[0];
    const listed = !!this.modes?.available.some((m) => m.id === want);
    const option = this.config.find((o) => o.category === 'mode' && o.type === 'select' && o.options.some((x) => x.value === want));
    try {
      if (listed) {
        await this.request(ACP.setMode, setModeParams(this.sessionId as string, want), signal);
        this.mode = want;
      } else if (option) {
        const r = await this.request(ACP.setConfigOption, setConfigOptionParams(this.sessionId as string, option.id, want), signal);
        const next = configOptions(r);
        if (next.length) this.config = next;
        this.mode = want;
      }
    } catch (err) {
      if (signal.aborted || err instanceof RpcExited) throw err;
      /* checked below */
    }
    if (this.mode !== null && !allowed.includes(this.mode)) {
      throw new AgentRunError('agent_mode', `${this.agent.name} is in a mode Magnusim doesn't use (${cleanText(this.mode, 64)}), and it couldn't be changed.`);
    }
  }

  /** The variables Magnusim adds for this agent (the catalogue's env()), with Gemini's settings file written first. */
  private async envSpec(): Promise<AgentEnvSpec> {
    const k = this.o.known;
    let systemSettingsPath: string | null = null;
    if (k?.systemSettings) {
      // Private, beside the working folder (same prefix: a crashed run's leftover is swept).
      this.extraDir = await mkdtemp(join(this.o.tmp ?? tmpdir(), WORKDIR_PREFIX));
      await ensurePrivateDir(this.extraDir);
      systemSettingsPath = join(this.extraDir, 'system-settings.json');
      await writeFile(systemSettingsPath, k.systemSettings(), { mode: 0o600 });
    }
    const extra = k?.env?.({ defaultAgent: this.agent.defaultAgent, systemSettingsPath }) ?? {};
    return { ...this.agent.env, extra: { ...(this.agent.env.extra ?? {}), ...extra } };
  }

  private request(method: string, params: unknown, signal: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const rpc = this.rpc;
    if (!rpc) return Promise.reject(new AgentRunError('agent_exited', STOPPED_UNEXPECTEDLY_TEXT(this.agent.name)));
    return rpc.request(method, params, { signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  }

  // ------------------------------------------------------------ prompting

  /**
   * One prompt: resolves with its stop reason (null: one Magnusim doesn't know), rejects with
   * an RpcError / RpcExited (agentErrorOf maps it). Updates and permission requests go to `h`
   * while it runs.
   */
  async prompt(blocks: ContentBlock[], h: PromptHandlers): Promise<StopReasonView | null> {
    if (!this.alive || !this.sessionId || !this.rpc) throw new AgentRunError('agent_exited', STOPPED_UNEXPECTEDLY_TEXT(this.agent.name));
    this.handlers = h;
    this.state = 'prompting';
    try {
      const r = await this.rpc.request(ACP.prompt, promptParams(this.sessionId, blocks), { timeoutMs: 0 });
      return stopReasonOf(r);
    } finally {
      this.handlers = null;
      // Whatever was still open: the prompt is over, nothing is asked any more.
      this.cancelOpen();
      if (this.state === 'prompting' || this.state === 'cancelling') this.state = 'ready';
    }
  }

  /** Every open permission request answered `cancelled`, then session/cancel (ACP's order). */
  cancel(): void {
    if (this.state === 'ended' || !this.rpc || !this.sessionId) return;
    this.cancelOpen();
    if (this.state === 'prompting') this.state = 'cancelling';
    this.rpc.notify(ACP.cancel, cancelParams(this.sessionId));
  }

  /** The open permission requests answered `cancelled` (Stop, a limit, the prompt's end). */
  private cancelOpen(): void {
    for (const p of [...this.open.values()]) this.answer(p, null);
  }

  private answer(p: OpenPermission, optionId: string | null): void {
    if (p.answered) return;
    p.answered = true;
    for (const [k, v] of this.open) if (v === p) this.open.delete(k);
    this.rpc?.reply(p.id, permissionReply(optionId));
  }

  /** How many permission requests wait for an answer (tests). */
  get openPermissions(): number {
    return this.open.size;
  }

  private onRequest(method: string, params: unknown, id: RpcId): boolean {
    if (method !== ACP.requestPermission) return false;
    const view = readPermission(params);
    const p: OpenPermission = { id, view, answered: false };
    const h = this.handlers;
    // Between prompts, or for another session: cancelled at once. While a prompt runs (or is
    // being cancelled) the turn decides, and logs it.
    if (!h || (this.state !== 'prompting' && this.state !== 'cancelling') || (view.sessionId !== null && view.sessionId !== this.sessionId)) {
      this.rpc?.reply(id, permissionReply(null));
      return true;
    }
    this.open.set(`${(this.permSerial += 1)}`, p);
    let answer: Promise<string | null>;
    try {
      answer = h.onPermission(view);
    } catch {
      answer = Promise.resolve(null);
    }
    answer.then(
      (optionId) => this.answer(p, optionId),
      () => this.answer(p, null),
    );
    return true;
  }

  /**
   * Answers an open permission request now (a question's answer, heard synchronously, so it goes
   * before a session/cancel that follows in the same tick). False when it was already answered.
   */
  answerNow(view: PermissionView, optionId: string | null): boolean {
    for (const p of this.open.values()) {
      if (p.view === view && !p.answered) {
        this.answer(p, optionId);
        return true;
      }
    }
    return false;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === ACP.update) {
      const { sessionId, update } = sessionUpdate(params);
      if (!update || (sessionId !== null && sessionId !== this.sessionId)) return;
      // The session's own record, prompt or not (a mode it switched to between prompts counts).
      if (update.kind === 'mode') this.mode = update.mode;
      else if (update.kind === 'config') {
        if (update.options.length) this.config = update.options;
        if (update.mode !== null) this.mode = update.mode;
        if (update.model !== null) this.model = update.model;
      } else if (update.kind === 'model') this.model = update.model;
      const h = this.handlers;
      if (h && (this.state === 'prompting' || this.state === 'cancelling')) {
        try {
          h.onUpdate(update);
        } catch (err) {
          alog('warn', 'an agent update could not be handled', { agent: this.agent.id, error: cleanText(String((err as Error)?.message ?? err), 200) });
        }
      }
      return;
    }
    if (method === '_auth/status_update') {
      const kind = typeof (params as { kind?: unknown } | null)?.kind === 'string' ? String((params as { kind: string }).kind) : '';
      if (kind === 'none') this.authNone = true;
      try {
        this.o.onAuthStatus?.(kind);
      } catch {
        /* display only */
      }
    }
  }

  // ------------------------------------------------------------ ending

  private onProcessExit(info: ExitInfo): void {
    const unexpected = this.state !== 'ended';
    this.state = 'ended';
    this.cancelOpen();
    dropBinding(this.binding.id);
    if (unexpected) alog('info', 'agent ended by itself', { agent: this.agent.id, code: info.code, signal: info.signal });
    try {
      this.o.onExit?.(this, info);
    } catch {
      /* the host's bookkeeping never fails an exit */
    }
    void this.cleanExtra();
  }

  /** Ends the agent: its whole tree, its working folder, its binding. Idempotent; resolves when the tree is gone. */
  end(why: string): Promise<void> {
    if (!this.ending) {
      this.state = 'ended';
      this.cancelOpen();
      dropBinding(this.binding.id);
      const proc = this.proc;
      this.ending = (async () => {
        try {
          if (proc) await proc.stop(why);
        } finally {
          this.rpc?.exit(proc?.exitInfo ?? { code: null, signal: null });
          await this.cleanExtra();
        }
      })();
    }
    return this.ending;
  }

  private async cleanExtra(): Promise<void> {
    const dir = this.extraDir;
    this.extraDir = null;
    if (dir) await removeTree(dir).catch(() => {});
  }
}
