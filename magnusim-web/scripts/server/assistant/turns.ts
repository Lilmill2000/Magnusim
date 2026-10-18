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
 *
 * Turns, conversations and questions live in the Assistant's state on globalThis. When Vite
 * restarts the server in this process, the old server's relay ends the running turns its
 * manager started that are bound to an app tab (they reach their tab only through that
 * relay); turns with no tab go on, and the new server serves them.
 */
import { randomBytes } from 'node:crypto';
import { alog } from './log.ts';
import { redact } from './redact.ts';
import { runTurn, type EndState, type LoopDeps, type LoopTurn, type TurnSettings, type TurnState } from './loop.ts';
import { Conversations, FULL_TEXT, type Conversation } from './conversations.ts';
import { GateBroker, realClock, type Clock, type GateEvent, type GatePresenter, type GateView } from './gates.ts';
import { destinationHost, privacyDeniedText, type ProjectInfo } from './privacy.ts';
import type { Registry } from './registry.ts';
import { ToolRunner, type CallAbort, type RunnerEvent } from './runner.ts';
import { cleanText } from './sanitize.ts';
import type { AssistantSettings } from './settings.ts';
import type { SpendLedger } from './ledger.ts';
import { onAssistantShutdown, assistantState } from './state.ts';
import { isCloud } from './providers/index.ts';
import { ProviderError, type ProviderAdapter, type ProviderId, type Risk, type StreamEvent } from './types.ts';
import type { KeySlot, StorageStatus, KeyStatus } from './secrets/store.ts';

export type { TurnState } from './loop.ts';

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
 * on a local server. context_tokens and images: null while the app doesn't know them.
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
  /** What its tab's page shows changed (at most once a TURN_UPDATE_MS; never after its end). */
  onUpdated?: (t: Turn) => void;
}

export class Turn implements LoopTurn {
  readonly id: string;
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
  /** The local server's context for this turn's model, once its model row said (tokens; null until then, and for cloud models). */
  contextTokens: number | null = null;
  /** Whether this turn's model reads images: true for cloud models; a local one's once its row or its server said (null until then). */
  images: boolean | null = null;
  endedAt: number | null = null;
  endReason: string | null = null;
  message: string | null = null;
  /** The loop (and its last appends) has finished: the conversation is free again. */
  settled = false;
  /** The model's context in tokens, once the app knows it (setModelFacts); null until then. */
  contextTokens: number | null = null;
  /** Whether the model reads images, once the app knows it (setModelFacts); null until then. */
  images: boolean | null = null;

  private readonly clock: Clock;
  private readonly gates: GateBroker;
  private readonly onEnded?: (t: Turn) => void;
  private readonly onUpdated?: (t: Turn) => void;
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

  constructor(o: TurnInit) {
    this.id = o.id;
    this.prompt = o.prompt;
    this.conv = o.conv;
    this.tab = o.tab;
    this.projectId = o.projectId;
    this.simulationId = o.simulationId;
    this.settings = o.settings;
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
    if (this.ended || !this.onUpdated || this.updateTimer !== null) return;
    const wait = this.updatedAt + TURN_UPDATE_MS - this.clock.now();
    if (wait <= 0) this.updated();
    else this.updateTimer = this.clock.setTimeout(() => this.updated(), wait);
  }

  private updated(): void {
    this.updateTimer = null;
    if (this.ended) return;
    this.updatedAt = this.clock.now();
    this.onUpdated?.(this);
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
      this.minutes.up = true;
      this.call?.abort({ code: 'capped', text: this.minutes.text } satisfies CallAbort);
    }, Math.max(0, left));
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

  /** How a stopped call reads: the server stopping, or the person (Stop, a key change). */
  private stopAbort(): CallAbort {
    return { code: 'stopped', ...(this.stopAs?.reason === 'shutdown' ? { server: true } : {}) };
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
   * answering its calls "The server stopped…" in the conversation; nothing more is logged.
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
      used: { steps: this.calls, steps_cap: this.settings.caps.steps, usd: round6(this.usd), usd_cap: this.settings.caps.turn_usd },
      ...(ended ? { end: { state: this.state as EndState, reason: this.endReason ?? this.state } } : {}),
    };
  }
}

// ---------------------------------------------------------------- the manager

/** What the manager needs of the secret store. */
export interface TurnSecrets {
  load?(): Promise<void>;
  storage(): StorageStatus;
  status(): Record<KeySlot, KeyStatus>;
  onKeyChanged?(fn: (slot: KeySlot) => void): () => void;
}

export interface TurnManagerDeps {
  settings(): Promise<AssistantSettings>;
  secrets(): TurnSecrets;
  deps(): Promise<'ok' | 'missing'>;
  ledger(): Promise<SpendLedger>;
  createAdapter(s: TurnSettings, secrets: TurnSecrets): ProviderAdapter | Promise<ProviderAdapter>;
  registry: Registry;
  projects(id: string, o: { signal: AbortSignal; turn: string }): Promise<ProjectInfo | null>;
  remember(projectId: string, createdAt: string | null, destination: string): Promise<void>;
  presenter?: GatePresenter;
  clock?: Clock;
  gateTimeoutMs?: number;
  gateUnseenMs?: number;
  abortGraceMs?: number;
  resendDelayMs?: number;
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

  constructor(d: TurnManagerDeps) {
    this.d = d;
    this.registry = d.registry;
    this.clock = d.clock ?? realClock;
    this.gates = new GateBroker({ presenter: d.presenter, clock: this.clock, timeoutMs: d.gateTimeoutMs, unseenMs: d.gateUnseenMs });
    this.runner = new ToolRunner({ gates: this.gates, fenced: (s) => d.registry.fenced(s), clock: this.clock, abortGraceMs: d.abortGraceMs });
    this.conversations = new Conversations({ now: () => this.clock.now() });
    this.gates.subscribe((e) => this.onGate(e));
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

  /** POST /api/assistant/turns: checked, then started detached (202). */
  async start(body: Record<string, unknown>): Promise<Answer> {
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

    const settings = await this.d.settings();
    const provider = settings.provider;
    if (provider === 'off') return refuse(400, 'provider_off', 'The Assistant is off. Choose a provider in Settings → Assistant.');
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

    const cloud = isCloud(settings);
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
    const binding = { provider: provider as ProviderId, model, projectId };
    let conv: Conversation | null = null;
    if (convId) {
      conv = this.conversations.get(convId);
      if (!conv) return refuse(404, 'unknown_conversation', 'That conversation has ended (2 hours idle, or forgotten). Start a new one.');
      const field = conv.mismatch(binding);
      if (field) return refuse(409, 'conversation_changed', `This conversation is bound to another ${field}. Start a new one.`, { field });
      if (conv.running) return refuse(409, 'conversation_busy', 'A turn is already running in this conversation.');
      if (conv.fullReason(settings.base_url)) return refuse(409, 'conversation_full', FULL_TEXT);
    }
    if (boundTab && this.activeForTab(boundTab) > 0) return refuse(409, 'tab_busy', TAB_BUSY_TEXT);
    if (this.running().length >= TURN_LIMITS.running) {
      return refuse(429, 'too_many', `At most ${TURN_LIMITS.running} turns run at once. Wait for one to end.`);
    }
    if (!conv) conv = this.conversations.create(binding);
    const turnSettings: TurnSettings = {
      provider: provider as ProviderId,
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
    return { status: 202, body: { ok: true, conversation: conv.id, turn: id } };
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
    const deps = this.loopDeps(secrets);
    void runTurn(t, deps)
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

  /** POST /api/assistant/gates/:id {allow}. */
  answerGate(id: string, allow: unknown): Answer {
    if (typeof allow !== 'boolean') return refuse(400, 'bad_answer', 'allow must be true or false.');
    const r = this.gates.answer(id, allow);
    if (r === 'unknown') return refuse(404, 'unknown_gate', 'No such question.');
    if (r === 'already') return refuse(409, 'already', 'That question was already answered.', { already: true, ...(this.gates.closedAs(id) ?? {}) });
    return { status: 200, body: { ok: true } };
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
