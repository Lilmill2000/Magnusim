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
 * theirs, providers/common.ts) against 100. Nothing is written to disk.
 * fullDetail() names the limit a conversation reached with its numbers (fullText words it for
 * the person), and room() how close it is to the nearest one. nearlyFull() says when the next
 * step could reach one (the loop then asks the model to sum up, and closes the conversation:
 * a closed one is full from then on).
 *
 * It also lists its turns (their ids, at most 200, oldest first) and takes its first turn's
 * title as its own (phase 4 spec 9.3): the turn manager keeps its newest 50 turns while it
 * lives (turns.ts sweep), so a window that reloads replays it.
 *
 * A conversation on a coding agent (provider `agent:<id>`, phase 3 spec 4.7) keeps no
 * messages: the agent keeps the history, so its list stays empty and repair() has nothing to
 * do. Whatever drops a conversation (forget, the 2-hour expiry, the eviction past 20) tells
 * onDrop's listeners, so the agent working for it ends with it.
 */
import { randomBytes } from 'node:crypto';
import { contextWindow } from './prices.ts';
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
 * For the context, `used` is the last request's prompt tokens and `limit` 80% of `window`.
 */
export interface Room {
  reason: FullReason;
  used: number;
  limit: number;
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
}

/** What one step added, or the most any step of a conversation added (nearlyFull's margin). */
export interface Growth {
  messages: number;
  images: number;
  bytes: number;
}

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
      return `context ${grouped(r.used)} of ${grouped(r.limit)} tokens`;
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

  /** Each limit with its numbers, in the order they are checked; with `baseUrl`, a context only that server reported counts. */
  limits(baseUrl?: string): FullDetail[] {
    const L = CONVERSATION_LIMITS;
    const context = baseUrl === undefined ? this.contextTokens : this.contextAt(baseUrl);
    const local = this.provider === 'openai_compatible';
    const window = local ? (context ?? CONTEXT_TOKENS.local) : (this.window?.tokens ?? CONTEXT_TOKENS.cloud);
    const known = local ? !!context : !!this.window?.known;
    const sent = this.provider !== 'anthropic';
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
      { reason: 'context', used: this.promptTokens, limit: Math.floor(L.fullFraction * window), of: known ? 'model' : 'app', window },
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
  fullDetail(baseUrl?: string): FullDetail | null {
    return this.limits(baseUrl).find((l) => l.used >= l.limit) ?? this.closedBy;
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
  nearlyFull(next: { promptTokens: number }, baseUrl?: string): FullDetail | null {
    const margin: Growth = { ...this.largest, messages: this.largest.messages + 2 };
    for (const l of this.limits(baseUrl)) {
      const reached = l.reason === 'context' ? next.promptTokens >= l.limit : l.used + margin[l.reason] >= l.limit;
      if (reached) return { ...l, near: true };
    }
    return null;
  }

  /** Why no more turns fit (null while they do); with `baseUrl`, a context only that server reported counts. */
  fullReason(baseUrl?: string): FullReason | null {
    return this.fullDetail(baseUrl)?.reason ?? null;
  }

  /** The limit it is closest to (the largest share of one), with its numbers; null for a conversation that keeps no messages. */
  room(baseUrl?: string): Room | null {
    if (String(this.provider).startsWith('agent:')) return null;
    let best: FullDetail | null = null;
    for (const l of this.limits(baseUrl)) if (l.limit > 0 && (!best || l.used / l.limit > best.used / best.limit)) best = l;
    return best ? { reason: best.reason, used: best.used, limit: best.limit } : null;
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
