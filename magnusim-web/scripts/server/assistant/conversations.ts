/**
 * The Assistant's conversations (Foundation spec 6.9), in memory only.
 *
 * A conversation is bound, at its first turn, to a provider, a model and a project (or
 * none); a turn that would change any of them is refused (409 conversation_changed). It
 * also freezes the first workspace guide it meets. One turn runs in it at a time.
 *
 * Its messages are append-only: they are never edited, reordered or trimmed (requests
 * merge consecutive user messages when they are built, providers/common.ts). Every tool
 * call of an appended answer gets exactly one result in the next user message; repair()
 * answers any call a crashed or stopped turn left open, before anything else is added.
 *
 * Limits: 20 conversations (the oldest idle one goes first), 2 hours idle, 300 messages and
 * 20 MB each, and "full" at 80% of the model's context, fixed when it is made (prices.ts
 * contextWindow: what the provider's models list said, else the model's row, else 200K; a
 * local server's model: the context its server reported, else 128K tokens). Pictures, by what
 * the provider takes in one request (imageLimit): Anthropic counts every picture the
 * conversation holds (each request sends them all; its context editing clears them only after
 * the upload) against 600 for a model of more than 200K tokens of context, else 100; OpenAI
 * and a local server count only the pictures a request sends (its oldest results go without
 * theirs, providers/common.ts) against 100. A priced model's context is full sooner when one
 * turn's money (Settings → Assistant, $ per turn: `turnUsd`) can't resend that much once the
 * cache has expired (prices.ts coldLine): the next turn's first request would be capped before
 * it is sent, so the conversation is full at that line, which says so with the money (`usd`).
 * Nothing of it is written to disk (each request's end is, as the chat history keeps it:
 * history.ts).
 * fullDetail() names the limit a conversation reached with its numbers (fullText words it for
 * the person), and room() how close it is to the nearest one. nearlyFull() says when the next
 * step could reach one (the loop then asks the model to sum up, and closes the conversation:
 * a closed one is full from then on).
 *
 * It also lists its turns (their ids, at most 200, oldest first) and takes its first turn's
 * title as its own (phase 4 spec 9.3): the turn manager keeps its newest 50 turns while it
 * lives (turns.ts sweep), so a window that reloads replays it.
 *
 * What a new conversation carries from it (Continue in a new chat, turns.ts carry_from; a coding
 * agent's too): the person's prompts, newest CARRY_LIMITS.prompts within promptBytes (each cut to
 * promptMax), its last answer's text (the end of it, within answerBytes) and how its last turn
 * ended. carried() takes them as they are then; carriedFromSaved() the same from a saved chat
 * (history.ts) once the conversation is gone. Its turns' lines are saved there as they end.
 *
 * A conversation on a coding agent (provider `agent:<id>`, phase 3 spec 4.7) keeps no
 * messages: the agent keeps the history (and shortens it itself when it fills: it is never
 * full here; agentContext says how much of its context it uses), so its list stays empty and
 * repair() has nothing to do. Whatever drops a conversation (forget, the 2-hour expiry, the eviction past 20) tells
 * onDrop's listeners, so the agent working for it ends with it.
 */
import { randomBytes } from 'node:crypto';
import { coldLine, contextWindow, fallbackTargetsOf } from './prices.ts';
import { clearedResults, sentMessages } from './providers/common.ts';
import { capResult } from './sanitize.ts';
import { assistantState } from './state.ts';
import type { AgentProviderId } from './agents/known.ts';
import type { Message, ProviderId, ToolCallPart, ToolResultPart } from './types.ts';

export const CONVERSATION_LIMITS = Object.freeze({
  count: 20,
  idleMs: 2 * 60 * 60_000,
  messages: 300,
  images: 100,
  bytes: 20 * 1024 * 1024,
  fullFraction: 0.8,
  /** Turn ids it lists (the oldest go first past it, counted in turnsDropped). */
  turns: 200,
});

/** What a new conversation carries from one (carried()): its newest prompts within their bytes (each cut to promptMax), and its last answer's end. */
export const CARRY_LIMITS = Object.freeze({ prompts: 40, promptBytes: 16 * 1024, promptMax: 4 * 1024, answerBytes: 4 * 1024 });

/** How a conversation's last turn ended. */
export interface LastEnd {
  state: string;
  reason: string;
  message: string | null;
}

/** What a new conversation carries from an earlier one (Continue in a new chat): taken when it starts. */
export interface Carried {
  /** The earlier conversation's id. */
  from: string;
  /** The person's prompts there, oldest first. */
  prompts: string[];
  /** Its earlier prompts not carried (past CARRY_LIMITS). */
  promptsLeftOut: number;
  /** Its last answer's text ('' when none); cut at the start past answerBytes. */
  lastAnswer: string;
  lastEnd: LastEnd | null;
  /** Why it was full, in the person's words (fullText), or null. */
  full: string | null;
}

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/** Adds `prompt` (cut to promptMax) to `prompts`, oldest first, within CARRY_LIMITS: answers how many old ones went. */
function keepPrompt(prompts: string[], prompt: string): number {
  const L = CARRY_LIMITS;
  prompts.push(cutBytes(prompt, L.promptMax));
  let bytes = prompts.reduce((n, p) => n + utf8(p), 0);
  let dropped = 0;
  while (prompts.length > L.prompts || (bytes > L.promptBytes && prompts.length > 1)) {
    bytes -= utf8(prompts.shift() as string);
    dropped += 1;
  }
  return dropped;
}

/**
 * What a new conversation carries from a saved chat (history.ts) whose conversation is gone (a
 * restart, the 2-hour expiry, Forget): as carried() would have, from its saved requests, oldest
 * first (the end of their last answer: everything the model said in it).
 */
export function carriedFromSaved(from: string, saved: ReadonlyArray<{ prompt: string; answer: string; end: LastEnd; full: string | null }>): Carried {
  const prompts: string[] = [];
  let dropped = 0;
  let lastAnswer = '';
  for (const s of saved) {
    dropped += keepPrompt(prompts, s.prompt);
    const text = s.answer.trim();
    if (text) lastAnswer = cutBytes(text, CARRY_LIMITS.answerBytes, true);
  }
  const last = saved.length ? saved[saved.length - 1] : null;
  return {
    from,
    prompts,
    promptsLeftOut: dropped,
    lastAnswer,
    lastEnd: last ? { state: last.end.state, reason: last.end.reason, message: last.end.message } : null,
    full: last?.full ?? null,
  };
}

/** `s` cut to at most `max` UTF-8 bytes, never splitting a character: its start, or (`fromEnd`) its end. */
export function cutBytes(s: string, max: number, fromEnd = false): string {
  if (utf8(s) <= max) return s;
  const chars = [...s];
  if (fromEnd) chars.reverse();
  const out: string[] = [];
  let n = 0;
  for (const c of chars) {
    n += utf8(c);
    if (n > max) break;
    out.push(c);
  }
  if (fromEnd) out.reverse();
  return out.join('');
}

/** Context windows, in tokens: a local model's when its server reports none, and a safe 200K for cloud models (prices.ts contextWindow). */
export const CONTEXT_TOKENS = Object.freeze({ cloud: 200_000, local: 128_000 });

/**
 * The pictures one request may carry (https://platform.claude.com/docs/en/build-with-claude/vision,
 * "Request limits", read 2026-10-29: 100 for a model with a 200K-token context, 600 for the
 * others; every image block counts, earlier turns' and those inside tool results too). Anthropic
 * by its model's window; OpenAI and a local server Magnusim's own 100.
 */
export function imageLimit(provider: ProviderId | AgentProviderId, window: number): number {
  if (provider !== 'anthropic') return CONVERSATION_LIMITS.images;
  return window > CONTEXT_TOKENS.cloud ? 600 : 100;
}

export type FullReason = 'messages' | 'images' | 'bytes' | 'context';

/**
 * One of a conversation's limits with its numbers: `used` of `limit` (full at `used >= limit`).
 * For the context, `used` is the last request's prompt tokens and `limit` 80% of `window`, or
 * what one turn's `usd` can resend with nothing cached when that is less.
 */
export interface Room {
  reason: FullReason;
  used: number;
  limit: number;
  /** The context's limit is what this much money per turn can resend (prices.ts coldLine). */
  usd?: number;
}

/**
 * A limit as fullText words it: whose it is ('model': the model's own; 'app': Magnusim's), the
 * context's whole window, and `near` when not reached yet but within the next step (nearlyFull).
 */
export interface FullDetail extends Room {
  of: 'model' | 'app';
  window?: number;
  near?: boolean;
  /** Pictures counted as each request sends them (OpenAI, a local server), not all it holds. */
  sent?: boolean;
  /** With `usd`: the refusal-fallback models whose re-run that money counts too. */
  retries?: number;
}

/** What one step added, or the most any step of a conversation added (nearlyFull's margin). */
export interface Growth {
  messages: number;
  images: number;
  bytes: number;
}

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (n: number) => `$${n.toFixed(2)}`;
const megabytes = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? Math.floor(mb * 10) / 10 : Math.floor(mb)} MB`;
};

/** A limit's numbers in the person's words ("pictures 72 of 100"), as the note asking the model to sum up says them. */
export function roomNumbers(r: Room): string {
  switch (r.reason) {
    case 'messages':
      return `messages ${grouped(r.used)} of ${grouped(r.limit)}`;
    case 'images':
      return `pictures ${grouped(r.used)} of ${grouped(r.limit)}`;
    case 'bytes':
      return `results and pictures ${megabytes(r.used).replace(' MB', '')} of ${megabytes(r.limit)}`;
    case 'context':
      return r.usd === undefined
        ? `context ${grouped(r.used)} of ${grouped(r.limit)} tokens`
        : `context ${grouped(r.used)} of the ${grouped(r.limit)} tokens ${money(r.usd)} per turn can resend`;
  }
}

/** Why a conversation is full, with its numbers, as the person reads it (`label`: the model's name). */
export function fullText(d: FullDetail, label: string): string {
  let why: string;
  switch (d.reason) {
    case 'messages':
      why = `it has ${grouped(d.used)} messages, and one conversation holds at most ${grouped(d.limit)}`;
      break;
    case 'images':
      why = d.sent
        ? `each request sends ${grouped(d.used)} pictures, and Magnusim sends at most ${grouped(d.limit)} in one request`
        : d.of === 'model'
          ? `it holds ${grouped(d.used)} pictures, and ${label} takes at most ${grouped(d.limit)} in one request`
          : `it holds ${grouped(d.used)} pictures, and Magnusim keeps at most ${grouped(d.limit)} in one conversation`;
      break;
    case 'bytes':
      why = `it holds ${megabytes(d.used)} of results and pictures, and Magnusim keeps at most ${megabytes(d.limit)} for one conversation`;
      break;
    case 'context': {
      const window = d.window ?? Math.round(d.limit / CONVERSATION_LIMITS.fullFraction);
      if (d.usd !== undefined) {
        const retried = d.retries ? `, with a re-run on ${d.retries === 1 ? 'its refusal-fallback model' : `each of its ${d.retries} refusal-fallback models`} counted,` : '';
        why = `its last request sent ${grouped(d.used)} tokens, and once its cache expires, sending that again${retried} could cost more than the ${money(d.usd)} per turn set in Settings → Assistant`;
        break;
      }
      why = d.of === 'model'
        ? `the last request used ${grouped(d.used)} of ${label}'s ${grouped(window)}-token context, and a conversation is full at ${Math.round(CONVERSATION_LIMITS.fullFraction * 100)}%`
        : `the last request used ${grouped(d.used)} of the ${grouped(window)} tokens Magnusim counts for ${label}, and a conversation is full at ${Math.round(CONVERSATION_LIMITS.fullFraction * 100)}%`;
      break;
    }
  }
  return `This conversation is full: ${why}${d.near ? ' (its next step could pass that)' : ''}. Start a new one.`;
}

export interface FrozenGuide {
  text: string;
  pluginName: string;
}

export interface Binding {
  provider: ProviderId | AgentProviderId;
  model: string;
  projectId: string | null;
}

export class Conversation {
  readonly id: string;
  readonly provider: ProviderId | AgentProviderId;
  readonly model: string;
  /** Its project (null: Home). It moves only with its turn's tab (moveTo). */
  private boundProject: string | null;
  readonly createdAt: number;
  lastUsed: number;
  /** The first workspace guide this conversation met, frozen. */
  guide: FrozenGuide | null = null;
  /** Guides that differed from the frozen one, each sent once in a later user message. */
  readonly guidesNoted = new Set<string>();
  /** The adapter's strict notes (its tools reduced or unchecked by the provider) shown in it once. */
  readonly notesShown = new Set<string>();
  /** The turn running in it (until its loop has fully ended). */
  running: string | null = null;
  /** The last request's prompt tokens (for "full"). */
  promptTokens = 0;
  /**
   * The last request sent in it (the loop's): its prompt tokens, when it started, whether it used
   * the cache, the messages it carried, the old tool results it left out, and `key` (its system,
   * tools and effort): the next turn's first estimate goes on from it (a read while that key holds
   * and the cache is fresh).
   */
  lastRequest: { promptTokens: number; startedAt: number; cacheUsed: boolean; messages: number; cleared: number; key: string } | null = null;
  /** The local server's context for this conversation's model, once its model row said (tokens). */
  contextTokens: number | null = null;
  /** The base URL of the server that said contextTokens (another server's model may differ). */
  contextBaseUrl: string | null = null;
  /** Its turns' ids, oldest first (at most CONVERSATION_LIMITS.turns). */
  readonly turns: string[] = [];
  /** Turn ids that went past CONVERSATION_LIMITS.turns. */
  turnsDropped = 0;
  /** Its first turn's title ('' before any). */
  title = '';
  /** A cloud model's context window, fixed when it was made (prices.ts contextWindow); null for a local server or a coding agent. */
  readonly window: { tokens: number; known: boolean } | null;
  /** Set when a turn ended it nearly full (after the model summed up): it is full from then on. */
  closedBy: FullDetail | null = null;
  /**
   * What it carries from the conversation it continues (Continue in a new chat), taken when it
   * was made; its first message sends it (a first turn that ended before that leaves it to the next).
   */
  carry: Carried | null = null;
  /** How its last turn ended (null before any did). */
  lastEnd: LastEnd | null = null;
  /**
   * A coding agent's: the context its session uses, of its size (tokens), as its last usage_update
   * said (agents/turn.ts); null before any, and for a new session of it (it remembers nothing yet).
   */
  agentContext: { used: number; size: number } | null = null;
  /** Its last answer's text ('' before any; a turn that said nothing keeps the one before). */
  lastAnswer = '';
  /** The person's prompts, oldest first, within CARRY_LIMITS (notePrompt). */
  private readonly prompts: string[] = [];
  private promptsDropped = 0;
  private readonly list: Message[] = [];
  private imageCount = 0;
  private byteCount = 0;
  /** The most one step added (its answer and its results; a review prompt, a sum-up note): nearlyFull's margin. */
  private largest: Growth = { messages: 0, images: 0, bytes: 0 };

  constructor(id: string, b: Binding, now: number) {
    this.id = id;
    this.provider = b.provider;
    this.model = b.model;
    this.boundProject = b.projectId;
    this.createdAt = now;
    this.lastUsed = now;
    this.window = b.provider === 'anthropic' || b.provider === 'openai' ? contextWindow(b.provider, b.model) : null;
  }

  get projectId(): string | null {
    return this.boundProject;
  }

  /** The conversation it continues (Continue in a new chat), or null. */
  get carriedFrom(): string | null {
    return this.carry?.from ?? null;
  }

  /**
   * Its turn's tab opened another project, or went Home (core host tools spec C5, §9.4): the
   * conversation moves with it, so the window's next message there continues it (mismatch agrees).
   */
  moveTo(projectId: string | null): void {
    this.boundProject = projectId;
  }

  get messages(): readonly Message[] {
    return this.list;
  }

  get images(): number {
    return this.imageCount;
  }

  get bytes(): number {
    return this.byteCount;
  }

  /** A turn started in it: listed, and its title is the conversation's when it is the first. */
  addTurn(id: string, title: string): void {
    this.turns.push(id);
    if (!this.title) this.title = title;
    while (this.turns.length > CONVERSATION_LIMITS.turns) {
      this.turns.shift();
      this.turnsDropped += 1;
    }
  }

  /** A turn started with the person's `prompt`: kept for a conversation that continues this one (carried()). */
  notePrompt(prompt: string): void {
    this.promptsDropped += keepPrompt(this.prompts, prompt);
  }

  /** Its turn ended so, its last words `answer` ('' keeps the answer before). */
  noteEnd(end: LastEnd, answer: string): void {
    this.lastEnd = { ...end };
    const text = answer.trim();
    if (text) this.lastAnswer = cutBytes(text, CARRY_LIMITS.answerBytes, true);
  }

  /** What a conversation that continues this one carries (`full`: why this one is full, in the person's words). */
  carried(full: string | null): Carried {
    return {
      from: this.id,
      prompts: [...this.prompts],
      promptsLeftOut: this.promptsDropped,
      lastAnswer: this.lastAnswer,
      lastEnd: this.lastEnd ? { ...this.lastEnd } : null,
      full,
    };
  }

  /** Adds a message at the end (the only way messages change). Frozen, so nothing edits it later. */
  append(m: Message): void {
    const frozen = deepFreeze(structuredClone(m));
    this.list.push(frozen);
    this.byteCount += Buffer.byteLength(JSON.stringify(frozen), 'utf8');
    if (frozen.role === 'user') {
      for (const p of frozen.parts) {
        if (p.type === 'image') this.imageCount += 1;
        if (p.type === 'tool_result') this.imageCount += p.images.length;
      }
    }
  }

  /** The tool calls of the last answer that have no result yet. */
  unanswered(): ToolCallPart[] {
    let at = -1;
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      if (this.list[i].role === 'assistant') {
        at = i;
        break;
      }
    }
    if (at < 0) return [];
    const m = this.list[at];
    if (m.role !== 'assistant') return [];
    const calls = m.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    if (!calls.length) return [];
    const answered = new Set<string>();
    for (const later of this.list.slice(at + 1)) {
      if (later.role !== 'user') continue;
      for (const p of later.parts) if (p.type === 'tool_result') answered.add(p.callId);
    }
    return calls.filter((c) => !answered.has(c.callId));
  }

  /** Answers calls a turn left open ("stopped"), so the next request is complete. */
  repair(): number {
    const open = this.unanswered();
    if (!open.length) return 0;
    const parts: ToolResultPart[] = open.map((c) =>
      capResult(c.callId, c.name, { ok: false, error: { code: 'stopped', message: 'Stopped before this ran.' } }),
    );
    this.append({ role: 'user', parts });
    return open.length;
  }

  /** The context the server at `baseUrl` reported for this conversation's model (null when none did, or another server). */
  contextAt(baseUrl: string): number | null {
    return this.contextBaseUrl === baseUrl ? this.contextTokens : null;
  }

  /**
   * Each limit with its numbers, in the order they are checked; with `baseUrl`, a context only that
   * server reported counts; with `turnUsd` (the money one turn may spend), a priced model's context
   * is full where that money could no longer resend it with nothing cached, if that comes first.
   */
  limits(baseUrl?: string, turnUsd?: number): FullDetail[] {
    const L = CONVERSATION_LIMITS;
    const context = baseUrl === undefined ? this.contextTokens : this.contextAt(baseUrl);
    const local = this.provider === 'openai_compatible';
    const window = local ? (context ?? CONTEXT_TOKENS.local) : (this.window?.tokens ?? CONTEXT_TOKENS.cloud);
    const known = local ? !!context : !!this.window?.known;
    const sent = this.provider !== 'anthropic';
    const share = Math.floor(L.fullFraction * window);
    const retries = fallbackTargetsOf(this.provider, this.model);
    const line = turnUsd === undefined ? null : coldLine(this.provider, this.model, retries, turnUsd);
    const contextLimit: FullDetail =
      line !== null && line < share
        ? { reason: 'context', used: this.promptTokens, limit: line, of: 'app', window, usd: turnUsd, ...(retries.length ? { retries: retries.length } : {}) }
        : { reason: 'context', used: this.promptTokens, limit: share, of: known ? 'model' : 'app', window };
    return [
      { reason: 'messages', used: this.list.length, limit: L.messages, of: 'app' },
      {
        reason: 'images',
        used: this.pictures(),
        limit: imageLimit(this.provider, window),
        of: this.provider === 'anthropic' && known ? 'model' : 'app',
        ...(sent ? { sent: true } : {}),
      },
      { reason: 'bytes', used: this.byteCount, limit: L.bytes, of: 'app' },
      contextLimit,
    ];
  }

  /**
   * The pictures its limit counts: every one it holds on Anthropic (each request uploads them
   * all), else those its next request sends (the person's, and those of the results not left out).
   */
  pictures(): number {
    if (this.provider === 'anthropic') return this.imageCount;
    let n = 0;
    for (const m of sentMessages(this.list, clearedResults(this.list))) {
      if (m.role !== 'user') continue;
      for (const p of m.parts) n += p.type === 'image' ? 1 : p.type === 'tool_result' ? p.images.length : 0;
    }
    return n;
  }

  /** The first limit this conversation reached, with its numbers (null while more turns fit); a closed one's, else. */
  fullDetail(baseUrl?: string, turnUsd?: number): FullDetail | null {
    return this.limits(baseUrl, turnUsd).find((l) => l.used >= l.limit) ?? this.closedBy;
  }

  /** Its counts now (messages, pictures, bytes), for what a step adds (noteStep). */
  counts(): Growth {
    return { messages: this.list.length, images: this.pictures(), bytes: this.byteCount };
  }

  /** A step ended: what it added since `before` (counts() then) widens the margin nearlyFull keeps. */
  noteStep(before: Growth): void {
    const now = this.counts();
    this.largest = {
      messages: Math.max(this.largest.messages, now.messages - before.messages),
      images: Math.max(this.largest.images, now.images - before.images),
      bytes: Math.max(this.largest.bytes, now.bytes - before.bytes),
    };
  }

  /** The most one step of it added so far. */
  get largestStep(): Growth {
    return { ...this.largest };
  }

  /**
   * Whether the next step could reach a limit, and which (with its numbers, `near`): the next
   * request's prompt (`next.promptTokens`: the last request's and what was added since) at the
   * context's limit, or pictures, bytes or messages within the largest step it made so far (and
   * 2 more messages: the note that asks for a sum-up, and the answer). Null while there is room.
   */
  nearlyFull(next: { promptTokens: number }, baseUrl?: string, turnUsd?: number): FullDetail | null {
    const margin: Growth = { ...this.largest, messages: this.largest.messages + 2 };
    for (const l of this.limits(baseUrl, turnUsd)) {
      const reached = l.reason === 'context' ? next.promptTokens >= l.limit : l.used + margin[l.reason] >= l.limit;
      if (reached) return { ...l, near: true };
    }
    return null;
  }

  /** Why no more turns fit (null while they do); with `baseUrl`, a context only that server reported counts. */
  fullReason(baseUrl?: string, turnUsd?: number): FullReason | null {
    return this.fullDetail(baseUrl, turnUsd)?.reason ?? null;
  }

  /** The limit it is closest to (the largest share of one), with its numbers; null for a conversation that keeps no messages. */
  room(baseUrl?: string, turnUsd?: number): Room | null {
    if (String(this.provider).startsWith('agent:')) return null;
    let best: FullDetail | null = null;
    for (const l of this.limits(baseUrl, turnUsd)) if (l.limit > 0 && (!best || l.used / l.limit > best.used / best.limit)) best = l;
    return best ? { reason: best.reason, used: best.used, limit: best.limit, ...(best.usd !== undefined ? { usd: best.usd } : {}) } : null;
  }

  /** The field a turn would change, or null when it fits this conversation. */
  mismatch(b: Binding): 'provider' | 'model' | 'project' | null {
    if (b.provider !== this.provider) return 'provider';
    if (b.model !== this.model) return 'model';
    if ((b.projectId ?? null) !== this.projectId) return 'project';
    return null;
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

export function newConversationId(now: number): string {
  return `c-${Math.max(0, Math.floor(now)).toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** The conversations of this server (on the Assistant's state). */
export class Conversations {
  private readonly now: () => number;
  private readonly dropListeners = new Set<(id: string) => void>();

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** Hears each conversation dropped (forgotten, expired or evicted), by id. */
  onDrop(fn: (id: string) => void): () => void {
    this.dropListeners.add(fn);
    return () => {
      this.dropListeners.delete(fn);
    };
  }

  private dropped(id: string): void {
    for (const fn of [...this.dropListeners]) {
      try {
        fn(id);
      } catch {
        /* a listener never stops a drop */
      }
    }
  }

  private map(): Map<string, Conversation> {
    return assistantState().conversations as Map<string, Conversation>;
  }

  get(id: string): Conversation | null {
    this.sweep();
    return this.map().get(String(id)) ?? null;
  }

  /** A new conversation; past the count, the oldest idle one goes first. */
  create(b: Binding): Conversation {
    this.sweep();
    const map = this.map();
    while (map.size >= CONVERSATION_LIMITS.count) {
      const idle = [...map.values()].filter((c) => !c.running).sort((a, b2) => a.lastUsed - b2.lastUsed)[0];
      if (!idle) break;
      map.delete(idle.id);
      this.dropped(idle.id);
    }
    const now = this.now();
    let id = newConversationId(now);
    while (map.has(id)) id = newConversationId(now);
    const c = new Conversation(id, b, now);
    map.set(id, c);
    return c;
  }

  /** Forgets a conversation (not while a turn runs in it). */
  forget(id: string): 'ok' | 'busy' | 'unknown' {
    const map = this.map();
    const c = map.get(String(id));
    if (!c) return 'unknown';
    if (c.running) return 'busy';
    map.delete(c.id);
    this.dropped(c.id);
    return 'ok';
  }

  /** Drops conversations idle for 2 hours. */
  sweep(): void {
    const now = this.now();
    for (const [id, c] of this.map()) {
      if (!c.running && now - c.lastUsed > CONVERSATION_LIMITS.idleMs) {
        this.map().delete(id);
        this.dropped(id);
      }
    }
  }

  size(): number {
    return this.map().size;
  }

  /** Every conversation now (those idle for 2 hours dropped first). */
  all(): Conversation[] {
    this.sweep();
    return [...this.map().values()];
  }
}
