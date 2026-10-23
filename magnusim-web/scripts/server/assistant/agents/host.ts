/**
 * The coding agents running now (phase 3 spec 4.4, 4.11), on globalThis so a Vite re-import of
 * these modules shares them.
 *
 * - One agent session per conversation, kept between that conversation's messages and ended
 *   after 15 minutes idle (AGENT_IDLE_MS). Each is tagged with the TurnManager (the server
 *   lifetime) whose turn started it.
 * - At most 2 agent processes at once (AGENT_MAX), Settings Test, connect and sign-in runs
 *   included. A start past that ends the oldest idle session; with none idle it is refused
 *   (turns: 429 agents_busy; a Test or sign-in: 409 busy). A turn's slot is reserved in the
 *   same synchronous step as its other start checks (reserve()).
 * - An agent is always tree-killed when its conversation is forgotten, expires or is evicted
 *   (Conversations.onDrop), after 15 minutes idle, when its allow switch goes off or a custom
 *   agent is removed (the discovery hooks: stopAgent), when its session crashed (the moment its
 *   process exits, a turn on it or not: its helpers and job go too) or a start failed, when it
 *   switched itself to a mode outside the allowed ones or (own tools off) used its own tool
 *   between prompts (AgentSession onOffence: at once; the tripwire is recorded), and when the
 *   server lifetime that started it shuts down (AssistantHandle.shutdown() calls
 *   endLifetime(manager) explicitly, superseded lifetime or not: its turns end failed/shutdown,
 *   its Test and sign-in runs stop) or the process stops (endAll, from an onAssistantShutdown
 *   hook).
 * - A conversation whose earlier agent ended (idle, a crash) gets a new session at its next
 *   turn, with a note that the agent doesn't remember the earlier messages (and why, when it
 *   was an offence between prompts).
 * - The allow switch going off (stopAgent) marks that agent at once (offEpoch / offSince): a
 *   turn, Test or sign-in whose checks read the settings before it re-checks before it takes
 *   its slot, so none starts on a switch that went off meanwhile.
 *
 * Test switches (honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home, else ignored with
 * a log line): MAGNUSIM_TEST_ASSISTANT_AGENT_IDLE_MS, _AGENT_CANCEL_MS and _AGENT_GATE_MS (whole
 * milliseconds, 1 to 3600000): the idle end, Stop's wait for the agent's answer before the tree
 * kill, and how long an agent turn's questions wait.
 */
import { join } from 'node:path';
import type { Clock } from '../gates.ts';
import { assistantHomeIsOverridden } from '../home.ts';
import { alog } from '../log.ts';
import { mintBinding, setBindingDispatch, type AgentDispatch } from '../mcp/sessions.ts';
import type { ToolCtx } from '../registry.ts';
import { errorResult, type RunResult } from '../runner.ts';
import { assistantState } from '../state.ts';
import type { KnownAgent } from './known.ts';
import { agentTestSwitches, testHomeEnv } from './discover.ts';
import { AgentSession, type AgentOffence, type FoundAgent } from './session.ts';

export const AGENT_MAX = 2;
export const AGENT_IDLE_MS = 15 * 60_000;
/** Stop's wait for the agent to answer session/cancel before the tree kill. */
export const AGENT_CANCEL_MS = 3_000;
/** How long an agent turn's questions wait (the brief: "declined after 4 min"). */
export const AGENT_GATE_MS = 240_000;

export const NOTHING_RUNS_TEXT = "Nothing runs between messages: the person hasn't sent one, or stopped it.";
export const AGENTS_BUSY_TEXT = 'Two coding agents are already working. Wait for one to finish, or stop one.';
export const RESTARTED_TEXT = (name: string) => `${name} was started again, so it doesn't remember this conversation's earlier messages.`;

const TABLESS: ToolCtx = Object.freeze({ tab: null, projectId: null, simulationId: null, cloud: true, local: false, place: 'home', budgetTokens: null, prompt: null });

export interface AgentTimings {
  idleMs: number;
  cancelMs: number;
  gateMs: number;
}

const SWITCH_MAX_MS = 3_600_000;

/** The test switches of the timings (null each when not set or not honoured), and why one is ignored. */
export function agentTimingSwitches(env: NodeJS.ProcessEnv = process.env): { idleMs: number | null; cancelMs: number | null; gateMs: number | null; ignored: string[] } {
  const out = { idleMs: null as number | null, cancelMs: null as number | null, gateMs: null as number | null, ignored: [] as string[] };
  const names: Array<[string, 'idleMs' | 'cancelMs' | 'gateMs']> = [
    ['MAGNUSIM_TEST_ASSISTANT_AGENT_IDLE_MS', 'idleMs'],
    ['MAGNUSIM_TEST_ASSISTANT_AGENT_CANCEL_MS', 'cancelMs'],
    ['MAGNUSIM_TEST_ASSISTANT_AGENT_GATE_MS', 'gateMs'],
  ];
  for (const [name, key] of names) {
    const raw = String(env[name] ?? '').trim();
    if (!raw) continue;
    if (env.MAGNUSIM_TEST_ASSISTANT !== '1') {
      out.ignored.push(`${name} is ignored without MAGNUSIM_TEST_ASSISTANT=1`);
      continue;
    }
    if (!assistantHomeIsOverridden({ env })) {
      out.ignored.push(`${name} is ignored outside a test home (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON)`);
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > SWITCH_MAX_MS) {
      out.ignored.push(`${name} must be whole milliseconds from 1 to ${SWITCH_MAX_MS}; it is ignored`);
      continue;
    }
    out[key] = n;
  }
  return out;
}

/** A per-session dispatch: the binding's calls go to the turn running on it now, else nothing runs. */
export class SessionDispatch implements AgentDispatch {
  current: AgentDispatch | null = null;
  private last: ToolCtx | null = null;

  setCurrent(d: AgentDispatch | null): void {
    if (d) this.last = d.ctx();
    this.current = d;
  }

  ctx(): ToolCtx {
    const d = this.current;
    if (d) {
      this.last = d.ctx();
      return this.last;
    }
    return this.last ?? TABLESS;
  }

  run(call: Parameters<AgentDispatch['run']>[0], o: Parameters<AgentDispatch['run']>[1]): Promise<RunResult> {
    const d = this.current;
    if (!d) return Promise.resolve(errorResult(call, 'stopped', NOTHING_RUNS_TEXT));
    return d.run(call, o);
  }

  owns(owner: Parameters<NonNullable<AgentDispatch['owns']>>[0]): boolean {
    return this.current?.owns?.(owner) === true;
  }
}

interface Entry {
  conversation: string;
  agentId: string;
  /** The TurnManager (server lifetime) whose turn started it. */
  manager: object;
  clock: Clock;
  session: AgentSession | null;
  dispatch: SessionDispatch;
  /** A turn runs on it (or was given its slot). */
  inUse: boolean;
  idleTimer: unknown;
  since: number;
  /** Records the lockdown tripwire for this agent (the turns' own recorder). */
  onLockdownFailed: (() => void) | null;
}

export interface Transient {
  agentId: string;
  manager: object | null;
  session: AgentSession | null;
  abort: AbortController;
}

/** What a session start needs besides the agent (the host makes the binding and the session). */
export interface SessionStart {
  conversation: string;
  agent: FoundAgent;
  known: KnownAgent | null;
  prefs: { model: string | null; mode: string | null };
  version: string;
  manager: object;
  clock: Clock;
  /** The turn's dispatch: set before session/new, so the agent's first list is the turn's tools. */
  dispatch: AgentDispatch;
  signal: AbortSignal;
  /** Records the lockdown tripwire for this agent when it fires between prompts. */
  onLockdownFailed?: () => void;
}

export interface Acquired {
  session: AgentSession;
  /** An earlier agent of this conversation ended: this one doesn't remember its messages. */
  restarted: boolean;
  /** A new process was started for this turn. */
  fresh: boolean;
  /** The earlier agent was ended for an offence between prompts no turn reported (a note says so). */
  offence: AgentOffence['code'] | null;
}

/** What tests set (their own temp folder, shorter timings); null each: the default. */
export interface AgentHostTestOptions {
  idleMs?: number | null;
  cancelMs?: number | null;
  gateMs?: number | null;
  tmp?: string | null;
  graceMs?: number | null;
}

export class AgentHost {
  private readonly entries = new Map<string, Entry>();
  private readonly transients = new Set<Transient>();
  /** Conversations that had an agent: a new one says it doesn't remember. */
  private readonly hadAgent = new Set<string>();
  /** Conversations whose agent was ended for an offence between prompts no turn reported. */
  private readonly offended = new Map<string, AgentOffence['code']>();
  /** Bumped (synchronously) by every stopAgent: see offEpoch(). */
  private offCount = 0;
  private readonly offAt = new Map<string, { epoch: number; text: string }>();
  private test: AgentHostTestOptions = {};
  private reported = new Set<string>();

  // ------------------------------------------------------------ timings and environment

  timings(): AgentTimings {
    const sw = agentTimingSwitches();
    for (const text of sw.ignored) {
      if (this.reported.has(text)) continue;
      this.reported.add(text);
      alog('warn', text);
    }
    return {
      idleMs: this.test.idleMs ?? sw.idleMs ?? AGENT_IDLE_MS,
      cancelMs: this.test.cancelMs ?? sw.cancelMs ?? AGENT_CANCEL_MS,
      gateMs: this.test.gateMs ?? sw.gateMs ?? AGENT_GATE_MS,
    };
  }

  /** Where agents' working folders go and the environment they read: a test home's own, else this PC's. */
  private placement(): { tmp: string | undefined; baseEnv: NodeJS.ProcessEnv | undefined } {
    const sw = agentTestSwitches();
    if (sw.home) {
      return { tmp: this.test.tmp ?? join(sw.home, 'tmp'), baseEnv: { ...testHomeEnv(process.env), HOME: sw.home, USERPROFILE: sw.home } };
    }
    return { tmp: this.test.tmp ?? undefined, baseEnv: undefined };
  }

  setTestOptions(o: AgentHostTestOptions | null): void {
    this.test = o ? { ...o } : {};
  }

  // ------------------------------------------------------------ slots

  /** Agent processes (or their slots) in use now. */
  count(): number {
    return this.entries.size + this.transients.size;
  }

  private oldestIdle(): Entry | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) if (!e.inUse && (!best || e.since < best.since)) best = e;
    return best;
  }

  /** Whether a turn of `conversation` could take an agent now (its own session, a free slot, or an idle one to end). */
  fits(conversation: string | null): boolean {
    if (conversation && this.entries.has(conversation)) return true;
    return this.count() < AGENT_MAX || this.oldestIdle() !== null;
  }

  /**
   * A turn of `conversation` takes its slot, synchronously (with the start's other checks): its
   * own session, a free slot, or the oldest idle session's (which ends). False: agents_busy.
   */
  reserve(conversation: string, agentId: string, manager: object, clock: Clock): boolean {
    const e = this.entries.get(conversation);
    if (e) {
      if (e.agentId !== agentId) this.endEntry(e, 'agent_changed');
      else {
        e.inUse = true;
        e.manager = manager;
        e.clock.clearTimeout(e.idleTimer);
        e.idleTimer = null;
        return true;
      }
    }
    if (this.count() >= AGENT_MAX) {
      const idle = this.oldestIdle();
      if (!idle) return false;
      this.endEntry(idle, 'evicted');
    }
    this.entries.set(conversation, {
      conversation,
      agentId,
      manager,
      clock,
      session: null,
      dispatch: new SessionDispatch(),
      inUse: true,
      idleTimer: null,
      since: clock.now(),
      onLockdownFailed: null,
    });
    return true;
  }

  /** The conversation's session for its turn: the one kept (same command), else a new one, started. */
  async acquire(o: SessionStart): Promise<Acquired> {
    // A turn stopped while it got here starts nothing.
    if (o.signal.aborted) throw o.signal.reason ?? new Error('aborted');
    let e = this.entries.get(o.conversation);
    if (!e) {
      // Its slot went meanwhile (a drop or a lifetime's end): take one again, or none.
      if (!this.reserve(o.conversation, o.agent.id, o.manager, o.clock)) throw Object.assign(new Error(AGENTS_BUSY_TEXT), { code: 'agents_busy' });
      e = this.entries.get(o.conversation) as Entry;
    }
    e.dispatch.setCurrent(o.dispatch);
    e.onLockdownFailed = o.onLockdownFailed ?? null;
    const kept = e.session;
    // Kept only when it is ready for a message (one still answering a cancel, or starting, is
    // replaced) and did nothing between prompts that ends it (a mode it isn't allowed in).
    if (kept && kept.alive && kept.agent.fingerprint === o.agent.fingerprint && kept.state === 'ready' && !kept.offence && kept.modeAllowed(kept.mode)) {
      return { session: kept, restarted: false, fresh: false, offence: null };
    }
    if (kept) {
      if (kept.alive && !kept.offence && !kept.modeAllowed(kept.mode)) this.offended.set(o.conversation, 'agent_mode');
      else if (kept.offence && !kept.offenceTold) this.offended.set(o.conversation, kept.offence.code);
      void kept.end(kept.alive ? 'command_changed' : 'ended');
    }
    const restarted = this.hadAgent.has(o.conversation);
    this.hadAgent.add(o.conversation);
    const offence = this.offended.get(o.conversation) ?? null;
    this.offended.delete(o.conversation);
    const binding = mintBinding({ conversation: o.conversation, agent: o.agent.id, name: o.agent.name, dispatch: e.dispatch });
    setBindingDispatch(binding.id, e.dispatch);
    const where = this.placement();
    const session = new AgentSession({
      conversation: o.conversation,
      agent: o.agent,
      known: o.known,
      binding,
      prefs: o.prefs,
      version: o.version,
      ...(where.baseEnv ? { baseEnv: where.baseEnv } : {}),
      ...(where.tmp ? { tmp: where.tmp } : {}),
      ...(this.test.graceMs ? { graceMs: this.test.graceMs } : {}),
      onExit: (s) => this.sessionExited(s),
      onOffence: (s, off) => this.sessionOffended(s, off),
    });
    e.session = session;
    await session.start(o.signal);
    return { session, restarted, fresh: true, offence };
  }

  /** The turn on `conversation` ended: its session stays for the next message, until the idle end. */
  release(conversation: string, dispatch: AgentDispatch | null): void {
    const e = this.entries.get(conversation);
    if (!e) return;
    if (dispatch && e.dispatch.current === dispatch) e.dispatch.setCurrent(null);
    e.inUse = false;
    e.since = e.clock.now();
    const s = e.session;
    if (!s || !s.alive || s.offence) {
      this.entries.delete(conversation);
      if (s) {
        if (s.offence && !s.offenceTold) this.offended.set(conversation, s.offence.code);
        // Ended or not, the tree kill (idempotent): an agent that exited by itself leaves its
        // helpers, its job and its working folder otherwise.
        void s.end(s.offence ? s.offence.code : 'exited');
      }
      return;
    }
    e.clock.clearTimeout(e.idleTimer);
    const idleMs = this.timings().idleMs;
    e.idleTimer = e.clock.setTimeout(() => {
      e.idleTimer = null;
      if (this.entries.get(conversation) === e && !e.inUse) this.endEntry(e, 'idle');
    }, idleMs);
  }

  private sessionExited(s: AgentSession): void {
    for (const e of [...this.entries.values()]) {
      if (e.session !== s) continue;
      // While a turn runs on it, the turn ends (agent_exited) and frees the slot.
      if (!e.inUse) void this.endEntry(e, 'exited');
    }
    // The tree kill whatever runs on it: its helpers and job (POSIX: its group), its folder.
    void s.end('exited');
  }

  /**
   * The agent did something between prompts that ends it (session.ts AgentOffence): the tree
   * kill at once, and the tripwire recorded. A turn holding it ends with it before its prompt;
   * otherwise the conversation's next turn says why its agent was started again.
   */
  private sessionOffended(s: AgentSession, off: AgentOffence): void {
    for (const e of [...this.entries.values()]) {
      if (e.session !== s) continue;
      if (off.code === 'agent_lockdown') {
        try {
          e.onLockdownFailed?.();
        } catch {
          /* recorded best effort; the agent still ends */
        }
      }
      if (e.inUse) continue;
      this.offended.set(e.conversation, off.code);
      void this.endEntry(e, off.code);
    }
    void s.end(off.code);
  }

  private endEntry(e: Entry, why: string): Promise<void> {
    if (this.entries.get(e.conversation) === e) this.entries.delete(e.conversation);
    e.clock.clearTimeout(e.idleTimer);
    e.idleTimer = null;
    e.dispatch.setCurrent(null);
    const s = e.session;
    e.session = null;
    return s ? s.end(why) : Promise.resolve();
  }

  /** A turn's session must go now (a crash, its mode, the tripwire, a stubborn agent): the tree kill. */
  endSession(conversation: string, session: AgentSession, why: string): Promise<void> {
    const e = this.entries.get(conversation);
    if (e && e.session === session) e.session = null;
    return session.end(why);
  }

  /** The conversation was forgotten, expired or evicted: its agent ends. */
  endConversation(conversation: string, why: string): void {
    this.hadAgent.delete(conversation);
    this.offended.delete(conversation);
    const e = this.entries.get(conversation);
    if (e) void this.endEntry(e, why);
  }

  // ------------------------------------------------------------ Settings Test, connect, sign-in

  /** A slot for a Test, connect or sign-in run (ends the oldest idle session past the limit), or null: busy. */
  takeTransient(agentId: string, manager: object | null): Transient | null {
    if (this.count() >= AGENT_MAX) {
      const idle = this.oldestIdle();
      if (!idle) return null;
      void this.endEntry(idle, 'evicted');
    }
    const t: Transient = { agentId, manager, session: null, abort: new AbortController() };
    this.transients.add(t);
    return t;
  }

  dropTransient(t: Transient): void {
    this.transients.delete(t);
  }

  /** What a Test's own session needs from the host (where it runs). */
  sessionPlacement(): { tmp?: string; baseEnv?: NodeJS.ProcessEnv; graceMs?: number } {
    const where = this.placement();
    return { ...(where.tmp ? { tmp: where.tmp } : {}), ...(where.baseEnv ? { baseEnv: where.baseEnv } : {}), ...(this.test.graceMs ? { graceMs: this.test.graceMs } : {}) };
  }

  // ------------------------------------------------------------ the allow switch, lifetimes, the process

  /** Whether any turn, Test, connect or sign-in of that agent runs now. */
  running(agentId: string): boolean {
    for (const e of this.entries.values()) if (e.agentId === agentId && e.inUse) return true;
    for (const t of this.transients) if (t.agentId === agentId) return true;
    return false;
  }

  /**
   * A mark taken before a start's first await (a turn's settings read, a Test's prepare): with
   * offSince(), whether that agent was stopped (its switch went off, it was removed) since, so a
   * start whose checks read the old settings re-checks before it takes its slot.
   */
  offEpoch(): number {
    return this.offCount;
  }

  /** Whether stopAgent ran for `agentId` after `epoch` (its text), or null. */
  offSince(agentId: string, epoch: number): { text: string } | null {
    const o = this.offAt.get(agentId);
    return o && o.epoch > epoch ? { text: o.text } : null;
  }

  /**
   * That agent's running turns stop (`stopped`, with `text`), its Test or sign-in runs end, and
   * every process of it is tree-killed, kept sessions included; resolves once they are gone.
   */
  async stopAgent(agentId: string, text: string): Promise<void> {
    // Synchronously, before anything awaits: a start between its checks and its slot sees it.
    this.offCount += 1;
    this.offAt.set(agentId, { epoch: this.offCount, text });
    const stops: Array<Promise<void>> = [];
    for (const t of runningTurns()) if (t.agentId === agentId) t.turn.stop('agent_off', text, 'stopped');
    for (const tr of [...this.transients]) {
      if (tr.agentId !== agentId) continue;
      tr.abort.abort(new Error(text));
      if (tr.session) stops.push(tr.session.end('agent_off'));
    }
    for (const e of [...this.entries.values()]) if (e.agentId === agentId) stops.push(this.endEntry(e, 'agent_off'));
    await Promise.all(stops.map((p) => p.catch(() => {})));
  }

  /**
   * A server lifetime is shutting down (AssistantHandle.shutdown(), superseded or not): the
   * sessions its turns started end now (each tree kill starts synchronously), their turns end
   * failed/shutdown, and its Test or sign-in runs stop.
   */
  endLifetime(manager: object): void {
    for (const e of [...this.entries.values()]) {
      if (e.manager !== manager) continue;
      for (const t of runningTurns()) if (t.conversation === e.conversation) t.turn.shutdown();
      void this.endEntry(e, 'shutdown');
    }
    for (const tr of [...this.transients]) {
      if (tr.manager !== manager) continue;
      tr.abort.abort(new Error('The server stopped.'));
      if (tr.session) void tr.session.end('shutdown');
    }
  }

  /** The process is stopping (or a test reset): every agent ends. */
  endAll(why: string): void {
    for (const e of [...this.entries.values()]) void this.endEntry(e, why);
    for (const tr of [...this.transients]) {
      tr.abort.abort(new Error('The server stopped.'));
      if (tr.session) void tr.session.end(why);
    }
    this.hadAgent.clear();
    this.offended.clear();
  }

  /** The test state route: each conversation's agent (pid, state, how its tree is stopped). */
  snapshot(): Record<string, { agent: string; pid: number | null; state: string; tree_kill: string | null; in_use: boolean }> {
    const out: Record<string, { agent: string; pid: number | null; state: string; tree_kill: string | null; in_use: boolean }> = {};
    for (const e of this.entries.values()) {
      Object.defineProperty(out, e.conversation, {
        value: { agent: e.agentId, pid: e.session?.pid ?? null, state: e.session?.state ?? 'reserved', tree_kill: e.session?.proc?.treeKill ?? null, in_use: e.inUse },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }

  /** The conversation's live session (tests). */
  sessionOf(conversation: string): AgentSession | null {
    return this.entries.get(conversation)?.session ?? null;
  }
}

/** The running turns on coding agents (the Assistant's state), with their conversation and agent. */
function runningTurns(): Array<{ turn: { stop(reason?: string, message?: string | null, state?: 'stopped'): void; shutdown(): void }; conversation: string; agentId: string }> {
  const out: Array<{ turn: { stop(reason?: string, message?: string | null, state?: 'stopped'): void; shutdown(): void }; conversation: string; agentId: string }> = [];
  for (const raw of assistantState().turns.values()) {
    const t = raw as { settled?: boolean; ended?: boolean; conv?: { id?: string }; settings?: { kind?: string; agent?: { id?: string } }; stop?: unknown; shutdown?: unknown };
    if (t.settled || t.settings?.kind !== 'agent' || typeof t.stop !== 'function' || typeof t.shutdown !== 'function') continue;
    out.push({ turn: t as never, conversation: String(t.conv?.id ?? ''), agentId: String(t.settings.agent?.id ?? '') });
  }
  return out;
}

const KEY = Symbol.for('magnusim.assistant.agentHost');

/** The process-wide agent host. */
export function agentHost(): AgentHost {
  const g = globalThis as unknown as Record<symbol, AgentHost | undefined>;
  let h = g[KEY];
  if (!h) {
    h = new AgentHost();
    g[KEY] = h;
  }
  return h;
}
