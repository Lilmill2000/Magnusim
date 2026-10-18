/**
 * The Assistant's turns (Foundation spec 6.1, 6.7, 9.2): starting them, their event log,
 * the long-poll, Stop, the questions they ask, and how many may run.
 *
 * - A turn runs detached from the request that started it (`runTurn(t, d)` in loop.ts),
 *   and a crash inside it ends it `failed` through t.crash(), logged redacted, never
 *   rethrown. It keeps a log of events numbered by `seq` (≤ 4000; notes go first when
 *   it is full, and text_so_far keeps the text), read with GET …/turns/:id?since=N.
 *   Ended turns are kept for an hour.
 * - At most one turn runs in a conversation (409), one in an app tab (409 tab_busy) and
 *   three in all (429), checked and set in one synchronous step.
 * - Stop (and a changed or removed key, and the server stopping) aborts the provider
 *   request and the running tool, withdraws open questions, drops a partial answer and
 *   answers the remaining calls; the turn ends `stopped` (`failed` "server stopped" when
 *   the server goes).
 * - The minutes cap counts active time only: questions waiting for an answer don't count.
 * - A turn runs on the provider its start names, else its conversation's own, else the
 *   default; every check of the start is about that provider.
 * - A turn's questions are answered only by the program that started it (the answer key
 *   of its 202) or by the app tab that shows them (its live relay link); see answerGate.
 * - A turn on a coding agent (provider `agent:<id>`, phase 3 spec 4.7, 5.2, 6.1) runs on
 *   agents/turn.ts instead of the loop, in the same log, gates, relay and limits on how many
 *   run. Its start needs a proof of this account (launchProven): the per-launch token (the CLI
 *   reads it from the owner-only mcp.json) or a live relay link of an app tab, whichever tab
 *   sends it (the page: a workspace, Settings, or phase 4's dock on Home; src/assistant/relay.ts
 *   opens the tab's channel for it). It is refused, in order:
 *   agent_unknown (400), its tool connection unavailable (400 mcp_unavailable: there is no
 *   launch token then), launch_proof (403), the agent missing, not allowed or changed since it
 *   was allowed, privacy (400), and past 2 agents agents_busy (429). Its switch going off while
 *   these are checked makes them run again. Its conversation is bound to it and keeps no
 *   messages (the agent keeps them).
 *
 * Turns, conversations and questions live in the Assistant's state on globalThis. When Vite
 * restarts the server in this process, the old server's relay ends the running turns its
 * manager started that are bound to an app tab (they reach their tab only through that
 * relay); turns with no tab go on, and the new server serves them.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { alog } from './log.ts';
import { redact } from './redact.ts';
import { runTurn, type EndState, type LoopDeps, type LoopTurn, type ModelTurnSettings, type TurnState } from './loop.ts';
import { Conversations, FULL_TEXT, type Conversation } from './conversations.ts';
import { GateBroker, realClock, tabOf, type Clock, type GateEvent, type GateOwner, type GatePresenter, type GateView } from './gates.ts';
import { agentOwnToolsDeniedText, agentPrivacyDeniedText, destinationHost, privacyDeniedText, type ProjectInfo } from './privacy.ts';
import type { Registry } from './registry.ts';
import { ToolRunner, type CallAbort, type RunnerEvent } from './runner.ts';
import { cleanText } from './sanitize.ts';
import { agentPrefs, isAgentOf, PROVIDER_IDS, setAgentLockdownFailed, type AssistantSettings } from './settings.ts';
import type { SpendLedger } from './ledger.ts';
import { onAssistantShutdown, assistantState } from './state.ts';
import { isCloud } from './providers/index.ts';
import { ProviderError, type ProviderAdapter, type ProviderId, type Risk, type StreamEvent } from './types.ts';
import type { KeySlot, StorageStatus, KeyStatus } from './secrets/store.ts';
import { AGENT_ID_RE, agentIdOf, knownAgent, type AgentProviderId } from './agents/known.ts';
import { runAgentTurn, type AgentEvent, type AgentRunTurn, type AgentTurnDeps, type AgentTurnSettings } from './agents/turn.ts';
import { agentHost, AGENTS_BUSY_TEXT } from './agents/host.ts';
import type { FoundAgent } from './agents/session.ts';
import { agentStartRefusal, rememberAgentSignIn, type AgentEntry, type AgentRow } from './agents/discover.ts';
import { findAgentNow, foundAgentOf, signInView } from './agents/test.ts';
import { appVersion } from './host-tools.ts';
import { mcpLaunchTokenMatches, mcpUnavailableText, startMcpListener } from './mcp/listener.ts';

export type { TurnState, ModelTurnSettings } from './loop.ts';

/**
 * What a turn fixed when it started: a model provider's (loop.ts runs it) or a coding agent's
 * (`kind: 'agent'`, agents/turn.ts runs it).
 */
export type TurnSettings = ModelTurnSettings | AgentTurnSettings;
export type { AgentTurnSettings } from './agents/turn.ts';

/** A model provider's settings (`kind` absent or 'model'): loop.ts runs the turn. */
export function isModelSettings(s: TurnSettings): s is ModelTurnSettings {
  return s.kind === undefined || s.kind === 'model';
}

/** A coding agent's settings: agents/turn.ts runs the turn. */
export function isAgentSettings(s: TurnSettings): s is AgentTurnSettings {
  return s.kind === 'agent';
}

export type TurnEvent = { seq: number; at: number } & (
  | { type: 'state'; state: TurnState }
  | { type: 'text'; step: number; text: string }
  | { type: 'discard'; step: number }
  | { type: 'note'; text: string }
  | { type: 'fallback'; step: number; from: string; to: string }
  | { type: 'tool_call'; step: number; call: string; tool: string; title: string; risk: Risk; source: string; input_preview: string }
  | { type: 'tool_progress'; call: string; fraction: number | null; label: string }
  | { type: 'tool_result'; call: string; ok: boolean; code?: string; hint?: string; summary: string; ms: number }
  | { type: 'gate'; gate: GateView }
  | { type: 'gate_closed'; gate: string; answer: 'allow' | 'deny'; by: 'user' | 'timeout' | 'stop' }
  | { type: 'usage'; usd: number; estimated: boolean; turn_usd: number; day_usd: number; tokens: number }
  | { type: 'end'; state: EndState; reason: string; message: string | null }
  // A coding agent's turn (phase 3 spec 5.5): the agent once ready, its plan, its own tools,
  // its permission requests, its mode and model.
  | AgentEvent
);
// Reserved for later phases (never emitted in Foundation): 'job', 'ui_sync'.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TurnEventBody = DistributiveOmit<TurnEvent, 'seq' | 'at'>;

export interface TurnSummary {
  id: string;
  conversation: string;
  state: TurnState;
  step: number;
  started_at: string;
  ended_at: string | null;
  usd: number;
  estimated: boolean;
  end_reason: string | null;
  message: string | null;
  open_gates: GateView[];
  text_so_far: string;
  tab: string | null;
  project_id: string | null;
  served_by: string | null;
  /** The turn's provider: an API-key provider's id, or `agent:<id>`. */
  provider: string;
  /** How it is paid for: counted by the $ meter, not priced (a local server), or billed to the person's own agent account. */
  billing: 'usd' | 'free' | 'agent_account';
  /** The coding agent it runs on (null for an API-key provider). */
  agent: { id: string; name: string; version: string | null } | null;
}

export const TURN_LIMITS = Object.freeze({
  /** Running turns in all (429 past it). */
  running: 3,
  events: 4000,
  /** Ended turns are kept this long. */
  keepMs: 60 * 60_000,
  /** The longest long-poll wait. */
  waitMs: 25_000,
  /** Stop answers once the turn ended, or after this long with {stopping:true}. */
  stopMs: 5_000,
  /** The person's prompt, in characters. */
  textMax: 20_000,
});

/** A turn's changes (each call's result, a fact of its model) are heard at most this often (TurnChange 'updated'). */
export const TURN_UPDATE_MS = 1000;
/** A turn's title for its tab's page: the first line of the person's request, cleaned, at most this long. */
export const TURN_TITLE_MAX = 60;

/**
 * A turn as the page of its tab hears it (the relay's `turn` frame, CAD tools spec H3): running
 * from its start, ended once. `steps` counts its tool calls (the steps cap's count); local: it runs
 * on a local server. context_tokens and images: null while the app doesn't know them. A turn on a
 * coding agent counts its MCP calls against its tool-call cap, and no dollars (usd and usd_cap 0:
 * its agent bills the person's own account).
 */
export interface TurnPageView {
  id: string;
  state: 'running' | 'ended';
  title: string;
  local: boolean;
  context_tokens: number | null;
  images: boolean | null;
  used: { steps: number; steps_cap: number; usd: number; usd_cap: number };
  end?: { state: EndState; reason: string };
}

const STOPPED_TEXT = 'Stopped.';
const TERMINAL: ReadonlySet<TurnState> = new Set(['done', 'stopped', 'failed', 'capped']);
/** The stop reasons that are the person's doing: Stop, a key change, an agent's switch turned off. */
const BY_THE_PERSON: ReadonlySet<string> = new Set(['user', 'key_changed', 'agent_off']);

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Controls, line and paragraph separators and bidi controls: the model's text keeps only \n and \t. */
const STREAM_CONTROLS = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu;

/**
 * The model's text as clients show it: no escape sequences (a terminal acts on them, and
 * they could hide or fake a question printed after them), carriage returns or bidi controls.
 * Per character, so a sequence split across stream chunks goes too. The stored message is
 * unchanged.
 */
export function plainModelText(text: string): string {
  return text.replace(STREAM_CONTROLS, (c) => (c === '\n' || c === '\t' ? c : ''));
}

export function newTurnId(now: number): string {
  return `t-${Math.max(0, Math.floor(now)).toString(36)}-${randomBytes(4).toString('hex')}`;
}

interface TurnInit {
  id: string;
  prompt: string;
  conv: Conversation;
  tab: string | null;
  projectId: string | null;
  simulationId: string | null;
  settings: TurnSettings;
  clock: Clock;
  gates: GateBroker;
  onEnded?: (t: Turn) => void;
  /**
   * What its tab's page shows changed (at most once a TURN_UPDATE_MS; never after its end).
   * Required: every start path builds its Turn with it (and after TurnManager.admitRefusal in
   * the same synchronous step), or its tab's page never hears its calls and facts.
   */
  onUpdated: (t: Turn) => void;
}

/** A Turn as any runner sees it: the loop's view, with settings of any kind. */
type AnyTurn = Omit<LoopTurn, 'settings'> & { readonly settings: TurnSettings };

export class Turn implements AnyTurn {
  readonly id: string;
  /**
   * Proves its holder started this turn: it answers the turn's questions (POST /gates/:id).
   * Given once, in the start's 202; never in summary() or the log.
   */
  readonly answerKey: string = randomBytes(16).toString('hex');
  readonly prompt: string;
  readonly conv: Conversation;
  readonly tab: string | null;
  readonly projectId: string | null;
  readonly simulationId: string | null;
  readonly settings: TurnSettings;
  readonly startedAt: number;
  state: TurnState = 'starting';
  step = 0;
  calls = 0;
  tokens = 0;
  usd = 0;
  estimated = false;
  servedBy: string | null = null;
  endedAt: number | null = null;
  endReason: string | null = null;
  message: string | null = null;
  /** The loop (and its last appends) has finished: the conversation is free again. */
  settled = false;
  /** The local server's context for this turn's model, once its model row said (tokens; set by setModelFacts; null until then, and for cloud models). */
  contextTokens: number | null = null;
  /** Whether this turn's model reads images: true for cloud models; a local one's once its row or its server said (set by setModelFacts; null until then). */
  images: boolean | null = null;

  private readonly clock: Clock;
  private readonly gates: GateBroker;
  private readonly onEnded?: (t: Turn) => void;
  private readonly onUpdated: (t: Turn) => void;
  private updatedAt = Number.NEGATIVE_INFINITY;
  private updateTimer: unknown = null;
  private readonly abort = new AbortController();
  private stopAs: { state: EndState; reason: string; message: string | null } | null = null;
  private readonly log: TurnEvent[] = [];
  /** The `end` event is logged: the log is complete. */
  private closed = false;
  private seq = 0;
  /** The highest seq a reader (a poll or a listener) has been given: text is merged only into events no one read yet. */
  private delivered = 0;
  private readonly stepText = new Map<number, string>();
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private call: AbortController | null = null;
  private minutes: { limitMs: number; text: string; timer: unknown; up: boolean } = { limitMs: Number.POSITIVE_INFINITY, text: '', timer: null, up: false };
  private pausedAt: number | null = null;
  private pausedMs = 0;
  private pauseDepth = 0;
  private offShutdown: (() => void) | null = null;
  private readonly minutesListeners = new Set<() => void>();
  /** Who hears the turn end before `end` is logged (onEnding): an agent's calls still open. */
  private readonly endingListeners = new Set<(why: CallAbort) => void>();
  /** The agent's version once its session is ready (an agent turn's summary). */
  agentVersion: string | null = null;

  constructor(o: TurnInit) {
    this.id = o.id;
    this.prompt = o.prompt;
    this.conv = o.conv;
    this.tab = o.tab;
    this.projectId = o.projectId;
    this.simulationId = o.simulationId;
    this.settings = o.settings;
    // A cloud model reads images: its tab's page hears that with the turn's start, not as a change.
    if (o.settings.provider !== 'openai_compatible') this.images = true;
    this.clock = o.clock;
    this.gates = o.gates;
    this.onEnded = o.onEnded;
    this.onUpdated = o.onUpdated;
    this.startedAt = o.clock.now();
    this.abort.signal.addEventListener('abort', () => this.call?.abort(this.stopAbort()), { once: true });
    this.offShutdown = onAssistantShutdown(() => this.shutdown());
    this.push({ type: 'state', state: 'starting' });
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get ended(): boolean {
    return TERMINAL.has(this.state);
  }

  // ------------------------------------------------------------ the log

  /** Logs an event; nothing is logged after `end` (the shutdown's loop still unwinds after it). */
  private push(body: TurnEventBody): void {
    if (this.closed) return;
    const e = { ...body, seq: ++this.seq, at: this.clock.now() } as TurnEvent;
    this.log.push(e);
    if (this.log.length > TURN_LIMITS.events) this.dropOne();
    this.wake(e);
  }

  /** The log is full: a note goes first, then the oldest text or progress (text_so_far keeps the text). */
  private dropOne(): void {
    for (const type of ['note', 'text', 'tool_progress', 'usage', 'state'] as const) {
      const i = this.log.findIndex((e) => e.type === type);
      if (i >= 0) {
        this.log.splice(i, 1);
        return;
      }
    }
    this.log.splice(0, 1);
  }

  private wake(e: TurnEvent | null): void {
    for (const w of [...this.waiters]) w();
    if (!e || !this.listeners.size) return;
    // A listener has it now: later text starts a new event rather than changing this one.
    this.delivered = Math.max(this.delivered, e.seq);
    for (const fn of [...this.listeners]) {
      try {
        fn({ ...e });
      } catch {
        /* a listener never breaks the turn */
      }
    }
  }

  /** Every event as it is logged, a copy (tests and, later, the dock's channel); streamed text arrives chunk by chunk. */
  subscribe(fn: (e: TurnEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(e: RunnerEvent | TurnEventBody): void {
    if (e.type === 'agent') this.agentVersion = e.version;
    this.push(e as TurnEventBody);
    // A call's result: the steps and money its tab's page shows moved on.
    if (e.type === 'tool_result') this.changed();
  }

  /**
   * What the app learned of the turn's model (its context, whether it reads images): kept for
   * its tab's page, which hears of a change (as `updated`).
   */
  setModelFacts(f: { contextTokens?: number | null; images?: boolean | null }): void {
    let moved = false;
    if (f.contextTokens !== undefined && f.contextTokens !== this.contextTokens) {
      this.contextTokens = f.contextTokens;
      moved = true;
    }
    if (f.images !== undefined && f.images !== this.images) {
      this.images = f.images;
      moved = true;
    }
    if (moved) this.changed();
  }

  /** Something its tab's page shows changed: onUpdated now, or once TURN_UPDATE_MS has passed since the last. */
  private changed(): void {
    if (this.ended || this.updateTimer !== null) return;
    const wait = this.updatedAt + TURN_UPDATE_MS - this.clock.now();
    if (wait <= 0) this.updated();
    else this.updateTimer = this.clock.setTimeout(() => this.updated(), wait);
  }

  private updated(): void {
    this.updateTimer = null;
    if (this.ended) return;
    this.updatedAt = this.clock.now();
    this.onUpdated(this);
  }

  note(text: string): void {
    this.push({ type: 'note', text: cleanText(text, 500) });
  }

  setState(s: TurnState): void {
    if (this.ended || this.state === s) return;
    this.state = s;
    this.push({ type: 'state', state: s });
  }

  onStream(step: number, e: StreamEvent): void {
    if (this.ended) return;
    if (e.kind === 'text') {
      const text = plainModelText(e.text ?? '');
      if (!text) return;
      this.stepText.set(step, (this.stepText.get(step) ?? '') + text);
      const last = this.log[this.log.length - 1];
      if (last && last.type === 'text' && last.step === step && last.seq > this.delivered) {
        last.text += text;
        this.wake(null);
      } else {
        this.push({ type: 'text', step, text });
      }
    } else if (e.kind === 'fallback') {
      this.push({ type: 'fallback', step, from: cleanText(e.from, 128), to: cleanText(e.to, 128) });
    }
  }

  discard(step: number): void {
    if (!this.stepText.has(step)) return;
    this.stepText.delete(step);
    this.push({ type: 'discard', step });
  }

  usage(u: { usd: number; estimated: boolean; dayUsd: number }): void {
    this.push({ type: 'usage', usd: round6(u.usd), estimated: u.estimated, turn_usd: round6(this.usd), day_usd: round6(u.dayUsd), tokens: this.tokens });
  }

  textSoFar(): string {
    return [...this.stepText.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  /** Events after `since` (marks them read). */
  eventsSince(since: number): TurnEvent[] {
    const out = this.log.filter((e) => e.seq > since);
    if (out.length) this.delivered = Math.max(this.delivered, out[out.length - 1].seq);
    return out.map((e) => ({ ...e }));
  }

  lastSeq(): number {
    return this.seq;
  }

  /** Waits until an event after `since` is logged, the turn ends, `ms` passes or `signal` aborts. */
  waitFor(since: number, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.seq > since || this.ended || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // ------------------------------------------------------------ time and calls

  activeMs(): number {
    const now = this.clock.now();
    const paused = this.pausedMs + (this.pausedAt !== null ? now - this.pausedAt : 0);
    return Math.max(0, now - this.startedAt - paused);
  }

  pause(): void {
    this.pauseDepth += 1;
    if (this.pauseDepth > 1) return;
    this.pausedAt = this.clock.now();
    this.clock.clearTimeout(this.minutes.timer);
    this.minutes.timer = null;
  }

  resume(): void {
    if (this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth > 0) return;
    if (this.pausedAt !== null) this.pausedMs += this.clock.now() - this.pausedAt;
    this.pausedAt = null;
    this.scheduleMinutes();
  }

  armMinutes(limitMs: number, text: string): void {
    this.minutes.limitMs = limitMs;
    this.minutes.text = text;
    this.scheduleMinutes();
  }

  private scheduleMinutes(): void {
    this.clock.clearTimeout(this.minutes.timer);
    this.minutes.timer = null;
    if (this.ended || this.pausedAt !== null || !Number.isFinite(this.minutes.limitMs)) return;
    const left = this.minutes.limitMs - this.activeMs();
    this.minutes.timer = this.clock.setTimeout(() => {
      this.minutes.timer = null;
      if (this.ended || this.pausedAt !== null) return;
      if (this.activeMs() < this.minutes.limitMs) {
        this.scheduleMinutes();
        return;
      }
      const first = !this.minutes.up;
      this.minutes.up = true;
      this.call?.abort({ code: 'capped', text: this.minutes.text } satisfies CallAbort);
      // Whether or not a call is open (an agent turn is one long prompt with no timeout of its own).
      if (first) {
        for (const fn of [...this.minutesListeners]) {
          try {
            fn();
          } catch {
            /* a listener never breaks the timer */
          }
        }
      }
    }, Math.max(0, left));
  }

  /**
   * Hears the turn end, inside end(): after its open call was aborted and before `end` is logged,
   * with how a call of it now reads (stopAbort). An agent turn's MCP call runs beside the turn's
   * own flow, so one still open logs its result here: nothing is logged after `end`.
   */
  onEnding(fn: (why: CallAbort) => void): () => void {
    this.endingListeners.add(fn);
    return () => {
      this.endingListeners.delete(fn);
    };
  }

  /** Hears the minutes cap fire, whether or not a call is open (spec 6.1: agent turns stop on it). */
  onMinutesUp(fn: () => void): () => void {
    this.minutesListeners.add(fn);
    return () => {
      this.minutesListeners.delete(fn);
    };
  }

  callSignal(): AbortSignal {
    const c = new AbortController();
    this.call = c;
    if (this.abort.signal.aborted) c.abort(this.stopAbort());
    else if (this.minutes.up || this.activeMs() >= this.minutes.limitMs) c.abort({ code: 'capped', text: this.minutes.text } satisfies CallAbort);
    return c.signal;
  }

  callDone(): void {
    this.call = null;
  }

  /**
   * The turn is to end for `reason` once its agent answered the cancel or was killed (an agent
   * turn's halt): a call still open stops now, as that end reads. Never as the kill closing the
   * call's MCP connection, which reads "The server stopped…".
   */
  abortCallFor(reason: string): void {
    this.call?.abort(this.abortFor(reason));
  }

  private stopAbort(): CallAbort {
    return this.abortFor(this.stopAs?.reason ?? 'user');
  }

  /**
   * How a call stopped by an end for `reason` reads: the server stopping; the person (Stop, a
   * key change, an agent's switch turned off); the agent that ran it exiting; or, for any other
   * end, the turn ending.
   */
  private abortFor(reason: string): CallAbort {
    if (reason === 'shutdown') return { code: 'stopped', server: true };
    if (BY_THE_PERSON.has(reason)) return { code: 'stopped' };
    if (reason === 'agent_exited' && isAgentSettings(this.settings)) return { code: 'stopped', cause: `${this.settings.agent.name} stopped unexpectedly` };
    return { code: 'stopped', cause: 'The turn ended' };
  }

  // ------------------------------------------------------------ ending

  stopEnd(): { state: EndState; reason: string; message: string | null } {
    return this.stopAs ?? { state: 'stopped', reason: 'user', message: STOPPED_TEXT };
  }

  /** Stop: the provider request and the running tool are aborted, questions withdrawn. */
  stop(reason = 'user', message: string | null = STOPPED_TEXT, state: EndState = 'stopped'): void {
    if (this.ended || this.abort.signal.aborted) return;
    this.stopAs = { state, reason, message };
    this.abort.abort(new ProviderError('aborted', 'Stopped.'));
  }

  /**
   * The server is stopping: the turn ends now (failed), and its loop unwinds after,
   * answering its calls "The server stopped…" in the conversation; nothing more is logged (an
   * agent's call still open logged that result before the end: onEnding).
   */
  shutdown(): void {
    if (this.ended) return;
    this.stop('shutdown', 'The server stopped.', 'failed');
    this.end('failed', 'shutdown', 'The server stopped.');
  }

  end(state: EndState, reason: string, message: string | null): void {
    if (this.ended) return;
    this.state = state;
    this.endedAt = this.clock.now();
    this.endReason = cleanText(reason, 80) || state;
    this.message = message === null ? null : cleanText(message, 2000);
    this.clock.clearTimeout(this.minutes.timer);
    this.minutes.timer = null;
    // Its end says what it used: no update follows it.
    this.clock.clearTimeout(this.updateTimer);
    this.updateTimer = null;
    this.offShutdown?.();
    this.offShutdown = null;
    // Nothing of this turn runs on: questions still open are withdrawn.
    if (!this.abort.signal.aborted) {
      this.stopAs = { state, reason, message };
      this.abort.abort(new ProviderError('aborted', 'The turn ended.'));
    }
    // A call still open (an agent's, which its MCP connection runs) logs its result first.
    const why = this.stopAbort();
    for (const fn of [...this.endingListeners]) {
      try {
        fn(why);
      } catch {
        /* a listener never stops the end */
      }
    }
    this.endingListeners.clear();
    this.push({ type: 'state', state });
    this.push({ type: 'end', state, reason: this.endReason, message: this.message });
    this.closed = true;
    alog('info', 'turn ended', {
      id: this.id,
      provider: this.settings.provider,
      model: this.settings.model,
      served_by: this.servedBy,
      steps: this.calls,
      usd: round6(this.usd),
      state,
      reason: this.endReason,
    });
    this.onEnded?.(this);
  }

  /** An error inside runTurn: logged (redacted), the turn ends failed. Never rethrown. */
  crash(err: unknown): void {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    alog('error', 'a turn failed unexpectedly', { id: this.id, error: redact(text).slice(0, 500) });
    this.end('failed', 'internal', 'The Assistant hit an unexpected error, so this turn stopped.');
  }

  summary(): TurnSummary {
    return {
      id: this.id,
      conversation: this.conv.id,
      state: this.state,
      step: this.step,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: this.endedAt === null ? null : new Date(this.endedAt).toISOString(),
      usd: round6(this.usd),
      estimated: this.estimated,
      end_reason: this.endReason,
      message: this.message,
      open_gates: this.gates.forTurn(this.id),
      text_so_far: this.textSoFar(),
      tab: this.tab,
      project_id: this.projectId,
      served_by: this.servedBy,
      provider: this.settings.provider,
      billing: isAgentSettings(this.settings) ? 'agent_account' : this.settings.provider === 'openai_compatible' ? 'free' : 'usd',
      agent: isAgentSettings(this.settings) ? { id: this.settings.agent.id, name: this.settings.agent.name, version: this.agentVersion ?? this.settings.agent.version } : null,
    };
  }

  /** The turn as its tab's page hears it (the relay's `turn` frame). */
  pageView(): TurnPageView {
    const ended = this.ended;
    return {
      id: this.id,
      state: ended ? 'ended' : 'running',
      title: cleanText(this.prompt.split(/\r\n?|\n/)[0], TURN_TITLE_MAX),
      local: this.settings.provider === 'openai_compatible',
      context_tokens: this.contextTokens,
      images: this.images,
      used: isAgentSettings(this.settings)
        ? { steps: this.calls, steps_cap: this.settings.caps.calls, usd: 0, usd_cap: 0 }
        : { steps: this.calls, steps_cap: this.settings.caps.steps, usd: round6(this.usd), usd_cap: this.settings.caps.turn_usd },
      ...(ended ? { end: { state: this.state as EndState, reason: this.endReason ?? this.state } } : {}),
    };
  }
}

/**
 * The turn as loop.ts drives it, or null when its settings are not a model provider's. Narrowed
 * once here: a guard inside runTurn would not narrow `t.settings` in the loop's helpers.
 */
export function modelTurn(t: Turn): LoopTurn | null {
  return isModelSettings(t.settings) ? (t as LoopTurn) : null;
}

/** The turn as agents/turn.ts drives it, or null when its settings are not a coding agent's. */
export function agentTurn(t: Turn): AgentRunTurn | null {
  return isAgentSettings(t.settings) ? (t as unknown as AgentRunTurn) : null;
}

// ---------------------------------------------------------------- the manager

/** What the manager needs of the secret store. */
export interface TurnSecrets {
  load?(): Promise<void>;
  storage(): StorageStatus;
  status(): Record<KeySlot, KeyStatus>;
  onKeyChanged?(fn: (slot: KeySlot) => void): () => void;
}

/** What an agent turn's start and run need besides the manager's own (tests replace parts). */
export interface AgentStartDeps {
  /** Starts the tool connection agents use (the MCP listener) and says whether it runs. */
  listener(): Promise<{ running: boolean; reason: string | null; port: number | null }>;
  /** Whether `sent` is this launch's token (x-magnusim-launch), compared in constant time. */
  launchToken(sent: unknown): boolean;
  /** The agent's discovery entry and row now (discovery is run again when older than 5 minutes). */
  find(id: string, settings: AssistantSettings, mcp: { available: boolean; reason: string | null }): Promise<{ entry: AgentEntry; row: AgentRow } | null>;
  /** Magnusim's version. */
  version(): Promise<string>;
  /** The lockdown tripwire fired: that agent needs its switch until Magnusim's next update. */
  lockdownFailed(id: string, version: string): Promise<unknown>;
}

/** The default AgentStartDeps: the real listener, discovery and settings. */
export const REAL_AGENT_START: AgentStartDeps = Object.freeze({
  async listener() {
    const l = await startMcpListener();
    return { running: l.running, reason: l.reason, port: l.port };
  },
  launchToken: (sent: unknown) => mcpLaunchTokenMatches(sent),
  find: findAgentNow,
  version: appVersion,
  lockdownFailed: (id: string, version: string) => setAgentLockdownFailed(id, version),
});

/** What proves that a request comes from this account: the per-launch token (x-magnusim-launch), or an app tab's live relay link. */
export interface LaunchProof {
  token?: unknown;
  link?: unknown;
}

export const LAUNCH_PROOF_TEXT = 'Start a coding agent from the Magnusim window or with assistant-run on this account.';

export interface TurnManagerDeps {
  settings(): Promise<AssistantSettings>;
  secrets(): TurnSecrets;
  deps(): Promise<'ok' | 'missing'>;
  ledger(): Promise<SpendLedger>;
  createAdapter(s: ModelTurnSettings, secrets: TurnSecrets): ProviderAdapter | Promise<ProviderAdapter>;
  registry: Registry;
  projects(id: string, o: { signal: AbortSignal; turn: string }): Promise<ProjectInfo | null>;
  remember(projectId: string, createdAt: string | null, destination: string): Promise<void>;
  presenter?: GatePresenter;
  clock?: Clock;
  gateTimeoutMs?: number;
  gateUnseenMs?: number;
  abortGraceMs?: number;
  resendDelayMs?: number;
  /** Tests: parts of an agent turn's start replaced (the real listener, discovery and settings otherwise). */
  agents?: Partial<AgentStartDeps>;
}

export type Answer = { status: number; body: Record<string, unknown> };

/** A turn of the manager started, changed (a call's result, a fact of its model: at most once a second) or ended. */
export type TurnChange = 'started' | 'updated' | 'ended';

/** What the relay knows of a tab beyond its registration (ms since 1970, or null). */
export interface TabInfo {
  since: number | null;
  hold_until: number | null;
}

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  body: { ok: false, code, error, ...extra },
});

export const TAB_HIDDEN_TEXT =
  "That tab isn't connected to the Assistant: its window is in the background or covered, or it was closed. Show the Magnusim window and try again.";
export const BAD_TAB_TEXT = 'That app tab offers no tools to the Assistant (it is unknown, or no workspace in it registered any).';
export const NO_TAB_TEXT = 'No app tab offers tools to the Assistant. Open a workspace in Magnusim, or start the turn without a tab.';
/** A second turn bound to a tab while one works there: one watched build and one undo group per page. */
export const TAB_BUSY_TEXT = 'A turn is already working in that tab: wait for it or stop it.';
const ambiguousTabText = (tabs: string[]) => `More than one app tab offers tools to the Assistant: ${tabs.join(', ')}. Name one of them.`;

/** The app tab a turn binds to (resolveTab), with the project and study its workspace registered. */
export interface TabTarget {
  tab: string;
  projectId: string;
  studyId: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const optionalId = (v: unknown): string | null | false => {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && ID_RE.test(v) ? v : false;
};

/**
 * The provider a turn's start names: a provider id, `agent:<id>` (a well-formed agent id: whether
 * it is one is checked against the settings), 'off', null when it names none (absent, null or
 * ''), or false when it is no provider. Settings → Assistant names them.
 */
function namedProvider(v: unknown): ProviderId | AgentProviderId | 'off' | null | false {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'off') return 'off';
  if (typeof v === 'string' && v.startsWith('agent:')) return AGENT_ID_RE.test(v.slice('agent:'.length)) ? (v as AgentProviderId) : false;
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v) ? (v as ProviderId) : false;
}

const badProviderText = (v: unknown) =>
  `${typeof v === 'string' ? `"${cleanText(v, 64)}" is not a provider` : 'provider must be text'}. Name one as Settings → Assistant does: ${PROVIDER_IDS.join(', ')}; or leave it out for the default.`;

/** A provider choice that names a coding agent (`agent:…`; whether it is one is checked after). */
const isAgentChoice = (p: unknown): p is AgentProviderId => typeof p === 'string' && p.startsWith('agent:');

export const agentUnknownText = (id: string) => `No coding agent called ${cleanText(id, 40) || '(none)'}. Settings → Assistant lists them.`;

export const PROVIDER_OFF_TEXT = 'The Assistant is off. Choose a provider in Settings → Assistant.';

/** How many times a start is checked before an agent stopped every time is refused. */
const START_ATTEMPTS = 3;

/**
 * What answers a question: the turn's answer key, as its starter sent it (`key`), or the app
 * tab whose live relay link the relay found showing it (`link`; only the relay makes one).
 */
export type GateProof = { kind: 'key'; key: unknown } | { kind: 'link'; tab: string };

export const ANSWER_KEY_TEXT =
  'Only the program that started this turn (with its answer key) or the Magnusim window that shows this question can answer it.';
export const ANSWER_IN_WINDOW_TEXT = 'Answer it in the Magnusim window.';
export const NOT_SHOWN_TEXT = "That question isn't shown in this tab.";

/** The answer key sent, compared in constant time with the turn's. */
function keyMatches(sent: unknown, key: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(key, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Secret stores whose key changes stop turns: one listener per store in this process, however many managers. */
const KEY_WATCH = Symbol.for('magnusim.assistant.keyWatch');

function keyWatched(): WeakSet<object> {
  const g = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
  let w = g[KEY_WATCH];
  if (!w) {
    w = new WeakSet();
    g[KEY_WATCH] = w;
  }
  return w;
}

/** A key saved or removed: the running turns using that provider stop, whichever server started them. */
function stopTurnsForSlot(slot: KeySlot): void {
  for (const t of (assistantState().turns as Map<string, Turn>).values()) {
    if (!t.settled && t.settings.provider === slot) t.stop('key_changed', 'The provider key was changed or removed, so this turn stopped.');
  }
}

export class TurnManager {
  readonly gates: GateBroker;
  readonly runner: ToolRunner;
  readonly conversations: Conversations;
  readonly registry: Registry;
  readonly clock: Clock;
  private readonly d: TurnManagerDeps;
  /** The turns this manager started (its server's relay reaches their tabs). */
  private readonly started = new WeakSet<Turn>();
  private readonly turnListeners = new Set<(t: Turn, change: TurnChange) => void>();
  private tabInfo: ((tab: string) => TabInfo | null) | null = null;
  private linkCheck: ((link: unknown) => boolean) | null = null;

  constructor(d: TurnManagerDeps) {
    this.d = d;
    this.registry = d.registry;
    this.clock = d.clock ?? realClock;
    this.gates = new GateBroker({ presenter: d.presenter, clock: this.clock, timeoutMs: d.gateTimeoutMs, unseenMs: d.gateUnseenMs });
    this.runner = new ToolRunner({ gates: this.gates, fenced: (s) => d.registry.fenced(s), clock: this.clock, abortGraceMs: d.abortGraceMs });
    this.conversations = new Conversations({ now: () => this.clock.now() });
    this.gates.subscribe((e) => this.onGate(e));
    // A conversation dropped (forgotten, expired, evicted): the coding agent working for it ends.
    this.conversations.onDrop((id) => agentHost().endConversation(id, 'conversation_dropped'));
  }

  /** The relay says whether a link is an app tab's live link now (the page's launch proof). */
  setLinkCheck(fn: ((link: unknown) => boolean) | null): void {
    this.linkCheck = fn;
  }

  /**
   * Whether a request proves it comes from this account (phase 3 spec 5.2): this launch's token
   * (x-magnusim-launch: the CLI reads it from the owner-only mcp.json) or the live relay link of an
   * app tab, whichever tab sends it and whatever the request is for (the page that sends it:
   * Settings, a workspace, phase 4's dock on Home). Any other account on this PC can reach the
   * routes, and what this guards starts programs as the person: an agent turn's start, and a
   * coding agent's Test, connect check and sign-in (assistant-routes.ts, which also takes the link
   * alone for adding a custom agent and turning an allow switch on). A link proves less than the
   * token: any program on this PC that opens an app tab's event stream gets one (SECURITY.md).
   */
  launchProven(p: LaunchProof): boolean {
    return this.agentStart().launchToken(p.token) || this.linkCheck?.(p.link) === true;
  }

  private agentStart(): AgentStartDeps {
    return { ...REAL_AGENT_START, ...(this.d.agents ?? {}) };
  }

  private turns(): Map<string, Turn> {
    return assistantState().turns as Map<string, Turn>;
  }

  /**
   * Hears each turn this manager starts, as it starts, as it changes and as it ends (the relay
   * counts a tab's bound turns, and tells the tab's page of them).
   */
  onTurnChange(fn: (t: Turn, change: TurnChange) => void): () => void {
    this.turnListeners.add(fn);
    return () => {
      this.turnListeners.delete(fn);
    };
  }

  private turnChanged(t: Turn, change: TurnChange): void {
    for (const fn of [...this.turnListeners]) {
      try {
        fn(t, change);
      } catch (err) {
        alog('warn', 'a turn listener failed', { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    }
  }

  /** What /tabs adds to a tab's registration (the relay: since when, and its hold). */
  setTabInfo(fn: ((tab: string) => TabInfo | null) | null): void {
    this.tabInfo = fn;
  }

  private onGate(e: GateEvent): void {
    if (e.owner.kind !== 'turn') return;
    const t = this.turns().get(e.owner.id);
    if (!t) return;
    if (e.type === 'open') t.emit({ type: 'gate', gate: e.view });
    else if (e.type === 'closed') t.emit({ type: 'gate_closed', gate: e.view.id, answer: e.answer, by: e.by });
    else t.note(e.text);
  }

  get(id: string): Turn | null {
    this.sweep();
    return this.turns().get(String(id)) ?? null;
  }

  /** Turns whose loop is still running. */
  running(): Turn[] {
    return [...this.turns().values()].filter((t) => !t.settled);
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [id, t] of this.turns()) {
      if (t.settled && t.endedAt !== null && now - t.endedAt > TURN_LIMITS.keepMs) this.turns().delete(id);
    }
  }

  /** Running turns bound to a tab. */
  activeForTab(tab: string): number {
    return this.runningForTab(tab).length;
  }

  /** The running turns bound to a tab, oldest first. */
  runningForTab(tab: string): Turn[] {
    return this.running().filter((t) => t.tab === tab && !t.ended);
  }

  /**
   * The app tab a turn (and, later, an MCP call) binds to: `target` is a tab id, or 'auto' for
   * the only connected one (as /tabs lists them). Refused: none (400 no_tab), only dormant ones
   * (409 tab_hidden) or more than one connected (409 ambiguous_tab) for 'auto'; for the tab, an
   * unknown one or one with no project (400 bad_tab), or a dormant one (409 tab_hidden).
   */
  resolveTab(target: string): TabTarget | Answer {
    const reg = this.d.registry;
    let tab = target;
    if (target === 'auto') {
      const listed = reg.tabIds().flatMap((id) => {
        // The relay first, as for /tabs: a registration whose plugin went is gone before it counts.
        this.tabInfo?.(id);
        const w = reg.workspaceOf(id);
        return w ? [{ id, connected: w.connected }] : [];
      });
      const connected = listed.filter((x) => x.connected).map((x) => x.id);
      if (connected.length > 1) return refuse(409, 'ambiguous_tab', ambiguousTabText(connected));
      if (!connected.length) return listed.length ? refuse(409, 'tab_hidden', TAB_HIDDEN_TEXT) : refuse(400, 'no_tab', NO_TAB_TEXT);
      tab = connected[0];
    }
    const ws = reg.workspaceOf(tab);
    if (!ws) return refuse(400, 'bad_tab', BAD_TAB_TEXT);
    if (!ws.connected) return refuse(409, 'tab_hidden', TAB_HIDDEN_TEXT);
    // Workspace tools are project data: a registration names its project, or it offers nothing.
    if (!ws.reg.projectId) return refuse(400, 'bad_tab', BAD_TAB_TEXT);
    return { tab, projectId: ws.reg.projectId, studyId: ws.reg.studyId };
  }

  /**
   * The last checks before a turn starts: one turn per app tab (409 tab_busy) and three in all
   * (429 too_many). Every start path calls it in the synchronous step that starts its turn.
   */
  private admitRefusal(boundTab: string | null): Answer | null {
    if (boundTab && this.activeForTab(boundTab) > 0) return refuse(409, 'tab_busy', TAB_BUSY_TEXT);
    if (this.running().length >= TURN_LIMITS.running) {
      return refuse(429, 'too_many', `At most ${TURN_LIMITS.running} turns run at once. Wait for one to end.`);
    }
    return null;
  }

  /** POST /api/assistant/turns: checked, then started detached (202). `launch`: the request's proof of this account (agent turns). */
  start(body: Record<string, unknown>, launch: LaunchProof = {}): Promise<Answer> {
    // No extra await around it: the 202 answers in the same step as the turn's launch.
    return this.startOnce(body, launch, 1);
  }

  /** One pass of start()'s checks; an agent whose switch went off while they ran is checked again. */
  private async startOnce(body: Record<string, unknown>, launch: LaunchProof, attempt: number): Promise<Answer> {
    // Before the first await (the settings read): see agentHost().offSince().
    const offEpoch = agentHost().offEpoch();
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return refuse(400, 'bad_text', 'Write what the Assistant should do.');
    if (text.length > TURN_LIMITS.textMax) return refuse(400, 'bad_text', `A prompt is at most ${TURN_LIMITS.textMax.toLocaleString('en-US')} characters.`);
    const convId = optionalId(body.conversation);
    const tab = optionalId(body.tab);
    if (convId === false) return refuse(400, 'bad_conversation', 'That is not a conversation id.');
    if (tab === false) return refuse(400, 'bad_tab', BAD_TAB_TEXT);
    if (body.context !== undefined && body.context !== null && !isRecord(body.context)) return refuse(400, 'bad_context', 'context must be an object.');
    const context = isRecord(body.context) ? body.context : {};
    const ctxProject = optionalId(context.project_id);
    const ctxStudy = optionalId(context.simulation_id);
    if (ctxProject === false || ctxStudy === false) return refuse(400, 'bad_context', 'context.project_id and context.simulation_id are ids.');

    const named = namedProvider(body.provider);
    if (named === false) return refuse(400, 'bad_provider', badProviderText(body.provider));

    const settings = await this.d.settings();
    // The turn's provider: the one its start names, else its conversation's own (a conversation
    // stays bound to its provider), else the default. Every check below is about this one.
    const provider = named ?? (convId ? this.conversations.get(convId)?.provider : undefined) ?? settings.provider;
    if (provider === 'off') return refuse(400, 'provider_off', PROVIDER_OFF_TEXT);
    if (isAgentChoice(provider)) {
      const agentId = agentIdOf(provider);
      if (agentId === null) return refuse(400, 'agent_unknown', agentUnknownText(provider.slice('agent:'.length)));
      return this.startAgent({
        text,
        convId,
        tab,
        ctxProject,
        ctxStudy,
        link: body.link,
        provider,
        agentId,
        settings,
        launch,
        offEpoch,
        again: attempt < START_ATTEMPTS ? () => this.startOnce(body, launch, attempt + 1) : null,
      });
    }
    if ((await this.d.deps()) === 'missing') return refuse(400, 'deps_missing', "The Assistant's packages aren't installed. Run Setup.bat again.");
    const model = settings.models[provider];
    if (!model) return refuse(400, 'no_model', 'Choose a model in Settings → Assistant first.');
    const secrets = this.d.secrets();
    await secrets.load?.();
    this.watch(secrets);
    const key = secrets.status()[provider];
    if (provider !== 'openai_compatible') {
      const storage = secrets.storage();
      if (storage.kind === 'unavailable') return refuse(400, 'storage_unavailable', storage.note);
      if (!key?.set) return refuse(400, 'no_key', 'No key is saved for this provider. Add one in Settings → Assistant.');
    }
    if (key?.set && key.state === 'unreadable') return refuse(400, 'no_key', "The saved key can't be decrypted on this account. Enter it again in Settings → Assistant.");

    // The tab ('auto': the only connected one): only a registered, connected one; its project is the turn's.
    let boundTab: string | null = null;
    let projectId = ctxProject;
    let simulationId = ctxStudy;
    if (tab) {
      const target = this.resolveTab(tab);
      if ('status' in target) return target;
      if (ctxProject && ctxProject !== target.projectId) return refuse(400, 'project_mismatch', "The context's project is not the tab's project.");
      boundTab = target.tab;
      projectId = target.projectId || null;
      simulationId = ctxStudy ?? (target.studyId || null);
    }

    const cloud = isCloud({ provider, base_url: settings.base_url });
    if (cloud && projectId && settings.privacy === 'deny') {
      return refuse(400, 'privacy_denied', privacyDeniedText(provider, destinationHost(provider, settings.base_url)));
    }
    if (provider !== 'openai_compatible') {
      const ledger = await this.d.ledger();
      if (ledger.spentToday() + ledger.reservedToday() >= settings.caps.day_usd - 1e-9) {
        return refuse(400, 'cap_day', `Today's $${settings.caps.day_usd.toFixed(2)} limit is reached; it resets at midnight.`);
      }
    }

    // From here to the turn's start nothing awaits: the checks and the start are one step.
    const binding = { provider, model, projectId };
    let conv: Conversation | null = null;
    if (convId) {
      conv = this.conversations.get(convId);
      if (!conv) return refuse(404, 'unknown_conversation', 'That conversation has ended (2 hours idle, or forgotten). Start a new one.');
      const field = conv.mismatch(binding);
      if (field) return refuse(409, 'conversation_changed', `This conversation is bound to another ${field}. Start a new one.`, { field });
      if (conv.running) return refuse(409, 'conversation_busy', 'A turn is already running in this conversation.');
      if (conv.fullReason(settings.base_url)) return refuse(409, 'conversation_full', FULL_TEXT);
    }
    const refused = this.admitRefusal(boundTab);
    if (refused) return refused;
    if (!conv) conv = this.conversations.create(binding);
    const turnSettings: TurnSettings = {
      kind: 'model',
      provider,
      model,
      base_url: settings.base_url,
      effort: settings.effort,
      caps: { ...settings.caps },
    };
    const id = newTurnId(this.clock.now());
    const t = new Turn({
      id,
      prompt: text,
      conv,
      tab: boundTab,
      projectId: projectId || null,
      simulationId: simulationId || null,
      settings: turnSettings,
      clock: this.clock,
      gates: this.gates,
      onEnded: (ended) => this.turnChanged(ended, 'ended'),
      onUpdated: (changed) => this.turnChanged(changed, 'updated'),
    });
    conv.running = id;
    conv.lastUsed = this.clock.now();
    this.turns().set(id, t);
    this.started.add(t);
    this.turnChanged(t, 'started');
    this.launch(t, secrets);
    // The answer key goes only to whoever started the turn: it answers the turn's questions.
    return { status: 202, body: { ok: true, conversation: conv.id, turn: id, answer_key: t.answerKey } };
  }

  /** An agent turn's start (spec 5.2, 5.3, 6.1): its checks in order, then started detached (202). */
  private async startAgent(a: {
    text: string;
    convId: string | null;
    tab: string | null;
    ctxProject: string | null;
    ctxStudy: string | null;
    link: unknown;
    provider: AgentProviderId;
    agentId: string;
    settings: AssistantSettings;
    launch: LaunchProof;
    /** agentHost().offEpoch() before the settings were read. */
    offEpoch: number;
    /** The start checked again (null: an agent stopped meanwhile is refused). */
    again: (() => Promise<Answer>) | null;
  }): Promise<Answer> {
    const { settings, agentId: id, provider } = a;
    if (!isAgentOf(settings, id)) return refuse(400, 'agent_unknown', agentUnknownText(id));
    const ad = this.agentStart();
    // The tool connection first: a CLI that found no connection file (or a stale one) reads it
    // again after the launch_proof refusal. Without it there is no launch token to prove anything
    // with (and no agent can run), so it is refused before the proof; /status says as much to
    // any local caller anyway.
    const listener = await ad.listener();
    if (!listener.running) return refuse(400, 'mcp_unavailable', mcpUnavailableText(listener.reason, listener.port ?? settings.mcp.port));
    let target: TabTarget | null = null;
    let tabRefusal: Answer | null = null;
    if (a.tab) {
      const r = this.resolveTab(a.tab);
      if ('status' in r) tabRefusal = r;
      else target = r;
    }
    // A proof of this account: an allowed agent can run commands as the person, and any other
    // account on this PC can reach this route. A link proves it from any tab, a turn bound to
    // another tab or to none (Home) too: it says who asks, not where the turn works.
    if (!this.launchProven({ token: a.launch.token, link: a.link })) return refuse(403, 'launch_proof', LAUNCH_PROOF_TEXT);
    const found = await ad.find(id, settings, { available: listener.running, reason: listener.reason });
    if (!found) return refuse(400, 'agent_unknown', agentUnknownText(id));
    const { entry, row } = found;
    const refused = agentStartRefusal(row, 'turn');
    if (refused) return refuse(400, refused.code, refused.error);
    if (tabRefusal) return tabRefusal;
    let boundTab: string | null = null;
    let projectId = a.ctxProject;
    let simulationId = a.ctxStudy;
    if (target) {
      if (a.ctxProject && a.ctxProject !== target.projectId) return refuse(400, 'project_mismatch', "The context's project is not the tab's project.");
      boundTab = target.tab;
      projectId = target.projectId || null;
      simulationId = a.ctxStudy ?? (target.studyId || null);
    }
    const name = cleanText(row.name, 64) || id;
    if (settings.privacy === 'deny') {
      if (projectId) return refuse(400, 'privacy_denied', agentPrivacyDeniedText(name));
      // Its own tools could read the projects folder whatever Magnusim sends: "never" wouldn't hold.
      if (row.own_tools === 'on') return refuse(400, 'privacy_denied', agentOwnToolsDeniedText(name));
    }

    // From here to the turn's start nothing awaits: the checks and the start are one step.
    // Its switch went off (or it was removed) since the settings above were read: they are read
    // again (the allow route saves first, then stops the agent; a turn admitted after this step
    // is one that stop finds and ends).
    const off = agentHost().offSince(id, a.offEpoch);
    if (off) return a.again ? a.again() : refuse(400, 'agent_not_allowed', off.text);
    const model = agentPrefs(settings, id).model ?? '';
    const binding = { provider, model, projectId };
    let conv: Conversation | null = null;
    if (a.convId) {
      conv = this.conversations.get(a.convId);
      if (!conv) return refuse(404, 'unknown_conversation', 'That conversation has ended (2 hours idle, or forgotten). Start a new one.');
      const field = conv.mismatch(binding);
      if (field) return refuse(409, 'conversation_changed', `This conversation is bound to another ${field}. Start a new one.`, { field });
      if (conv.running) return refuse(409, 'conversation_busy', 'A turn is already running in this conversation.');
    }
    if (this.running().length >= TURN_LIMITS.running) {
      return refuse(429, 'too_many', `At most ${TURN_LIMITS.running} turns run at once. Wait for one to end.`);
    }
    const host = agentHost();
    if (!host.fits(conv?.id ?? null)) return refuse(429, 'agents_busy', AGENTS_BUSY_TEXT);
    if (!conv) conv = this.conversations.create(binding);
    host.reserve(conv.id, id, this, this.clock);
    const agent: FoundAgent = { ...foundAgentOf(entry, row), name };
    const turnSettings: AgentTurnSettings = { kind: 'agent', provider, agent, caps: { ...settings.agent_caps }, model, gateTimeoutMs: host.timings().gateMs };
    const tid = newTurnId(this.clock.now());
    const t = new Turn({
      id: tid,
      prompt: a.text,
      conv,
      tab: boundTab,
      projectId: projectId || null,
      simulationId: simulationId || null,
      settings: turnSettings,
      clock: this.clock,
      gates: this.gates,
      onEnded: (ended) => this.turnChanged(ended, 'ended'),
      onUpdated: (changed) => this.turnChanged(changed, 'updated'),
    });
    conv.running = tid;
    conv.lastUsed = this.clock.now();
    this.turns().set(tid, t);
    this.started.add(t);
    this.turnChanged(t, 'started');
    this.launch(t, this.d.secrets());
    return { status: 202, body: { ok: true, conversation: conv.id, turn: tid, answer_key: t.answerKey } };
  }

  /** What an agent turn's runner needs. */
  private agentTurnDeps(t: Turn): AgentTurnDeps {
    const d = this.d;
    const ad = this.agentStart();
    const agent = isAgentSettings(t.settings) ? t.settings.agent : null;
    return {
      host: agentHost(),
      manager: this,
      known: knownAgent(agent?.id ?? ''),
      registry: d.registry,
      runner: this.runner,
      gates: this.gates,
      settings: d.settings,
      projects: d.projects,
      remember: d.remember,
      clock: this.clock,
      version: ad.version,
      lockdownFailed: ad.lockdownFailed,
      rememberSignIn: (agentId, session, err) => rememberAgentSignIn(agentId, signInView(err.auth ?? session?.info.auth ?? [], agent)),
    };
  }

  private loopDeps(secrets: TurnSecrets): LoopDeps {
    const d = this.d;
    return {
      createAdapter: (s) => d.createAdapter(s, secrets),
      settings: d.settings,
      ledger: d.ledger,
      registry: d.registry,
      runner: this.runner,
      gates: this.gates,
      projects: d.projects,
      remember: d.remember,
      clock: this.clock,
      resendDelayMs: d.resendDelayMs,
    };
  }

  private launch(t: Turn, secrets: TurnSecrets): void {
    const loopTurn = modelTurn(t);
    const agent = loopTurn ? null : agentTurn(t);
    const run = loopTurn
      ? runTurn(loopTurn, this.loopDeps(secrets))
      : agent
        ? runAgentTurn(agent, this.agentTurnDeps(t))
        : Promise.reject(new Error('no runner for this kind of turn'));
    void run
      .catch((err: unknown) => t.crash(err))
      .catch(() => {})
      .finally(() => {
        if (!t.ended) t.end('failed', 'internal', 'The turn ended without an answer.');
        // Any call it left open is answered before the conversation takes another turn.
        try {
          t.conv.repair();
        } catch {
          /* a frozen conversation that can't be repaired still frees */
        }
        t.settled = true;
        if (t.conv.running === t.id) t.conv.running = null;
        t.conv.lastUsed = this.clock.now();
      });
  }

  /**
   * Key saved or removed: the turns using that provider stop. One listener per store for the
   * process (it holds no manager), so a server Vite restarts leaves none behind.
   */
  private watch(secrets: TurnSecrets): void {
    const watched = keyWatched();
    if (!secrets.onKeyChanged || watched.has(secrets)) return;
    watched.add(secrets);
    secrets.onKeyChanged(stopTurnsForSlot);
  }

  stopForSlot(slot: KeySlot): void {
    stopTurnsForSlot(slot);
  }

  /** GET /api/assistant/turns/:id?since&wait_ms (long-poll). */
  async poll(id: string, since: number, waitMs: number, closed?: AbortSignal): Promise<Answer> {
    const t = this.get(id);
    if (!t) return refuse(404, 'unknown_turn', 'No such turn (ended turns are kept for an hour).');
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const wait = Number.isFinite(waitMs) ? Math.min(TURN_LIMITS.waitMs, Math.max(0, Math.floor(waitMs))) : 0;
    await t.waitFor(from, wait, closed);
    const events = t.eventsSince(from);
    const next = events.length ? events[events.length - 1].seq : from;
    return { status: 200, body: { ok: true, turn: t.summary(), events, next, ended: t.ended && next >= t.lastSeq() } };
  }

  /** POST …/turns/:id/stop: answers once the turn ended (≤ 5 s), else {stopping:true}. */
  async stop(id: string, boundMs: number = TURN_LIMITS.stopMs): Promise<Answer> {
    const t = this.get(id);
    if (!t) return refuse(404, 'unknown_turn', 'No such turn.');
    t.stop();
    const until = Date.now() + boundMs;
    while (!t.ended && Date.now() < until) await t.waitFor(t.lastSeq(), Math.max(1, until - Date.now()));
    if (t.ended) return { status: 200, body: { ok: true, turn: t.summary() } };
    return { status: 200, body: { ok: true, stopping: true, turn: t.summary() } };
  }

  /**
   * A question's answer, from whoever may give it (P2): the program that started its turn,
   * with the turn's answer key (POST /api/assistant/gates/:id {allow, answer_key}), or the
   * app tab that shows it, its live relay link vouched for by the relay (POST
   * /api/assistant/relay/gate). A `link_only` question, or one with no turn (MCP), takes only
   * the tab. Checked in order: 400 bad_answer, 404, 403 answer_key / not_shown, 409 already.
   */
  answerGate(id: string, allow: unknown, proof: GateProof): Answer {
    if (typeof allow !== 'boolean') return refuse(400, 'bad_answer', 'allow must be true or false.');
    const g = this.gates.lookup(id);
    if (!g) return refuse(404, 'unknown_gate', 'No such question.');
    const refused = this.proofRefusal(g.owner, g.view, proof);
    if (refused) return refused;
    const r = this.gates.answer(id, allow);
    if (r === 'unknown') return refuse(404, 'unknown_gate', 'No such question.');
    if (r === 'already') return refuse(409, 'already', 'That question was already answered.', { already: true, ...(this.gates.closedAs(id) ?? {}) });
    return { status: 200, body: { ok: true } };
  }

  /** Why `proof` may not answer this question (null: it may). */
  private proofRefusal(owner: GateOwner, view: GateView, proof: GateProof): Answer | null {
    if (proof.kind === 'link') {
      const tab = tabOf(owner);
      return tab !== null && tab === proof.tab ? null : refuse(403, 'not_shown', NOT_SHOWN_TEXT);
    }
    if (view.link_only) return refuse(403, 'not_shown', ANSWER_IN_WINDOW_TEXT);
    if (owner.kind === 'turn') {
      const t = this.turns().get(owner.id);
      if (t && keyMatches(proof.key, t.answerKey)) return null;
    }
    return refuse(403, 'answer_key', ANSWER_KEY_TEXT);
  }

  /** POST /api/assistant/conversations/:id/forget. */
  forget(id: string): Answer {
    const r = this.conversations.forget(id);
    if (r === 'busy') return refuse(409, 'conversation_busy', 'A turn is running in this conversation. Stop it first.');
    return { status: 200, body: { ok: true, forgotten: r === 'ok' } };
  }

  /**
   * GET /api/assistant/tabs: what each app tab registered, connected or dormant (its link
   * gone, kept for the hold time), since when (ms since 1970, or null), its running bound
   * turns and its hold (ms since 1970, or null).
   */
  tabs(): Answer {
    const reg = this.d.registry;
    const tabs = reg.tabIds().flatMap((tab) => {
      // The relay first: a registration it finds its plugin no longer has goes before it is listed.
      const info = this.tabInfo?.(tab) ?? null;
      const w = reg.workspaceOf(tab);
      if (!w) return [];
      return {
        tab,
        connected: !!w?.connected,
        since: info?.since ?? null,
        workspace: w
          ? { project_id: w.reg.projectId, plugin: w.reg.plugin, plugin_name: w.reg.pluginName, workspace: w.reg.workspace, study_id: w.reg.studyId }
          : null,
        tools: w?.tools ?? [],
        refused: w?.refused ?? [],
        active_turns: this.activeForTab(tab),
        hold_until: info?.hold_until ?? null,
      };
    });
    return { status: 200, body: { ok: true, tabs } };
  }

  /** The server is stopping: every running turn ends failed now. */
  shutdown(): void {
    for (const t of this.running()) t.shutdown();
  }

  /**
   * This server's relay is closing (a Vite restart closes the old server after the new one is
   * up): the running turns this manager started that are bound to an app tab end now, as at a
   * server stop. Their tab, its tools and their questions are reachable only through that
   * relay. Turns with no tab go on; the new server serves them.
   */
  shutdownTabTurns(): void {
    for (const t of this.running()) if (t.tab && this.started.has(t)) t.shutdown();
  }
}

export function createTurnManager(d: TurnManagerDeps): TurnManager {
  return new TurnManager(d);
}
