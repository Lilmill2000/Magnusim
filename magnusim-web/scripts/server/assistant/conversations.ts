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
 * Limits: 20 conversations (the oldest idle one goes first), 2 hours idle, 300 messages,
 * 100 images and 20 MB each, and "full" at 80% of the model's context (a local server's
 * model: the context its server reported, else 128K tokens). Nothing is written to disk.
 * fullDetail() names the limit a conversation reached with its numbers (fullText words it for
 * the person), and room() how close it is to the nearest one.
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

/** Context windows, in tokens: a local model's when its server reports none, and a safe 200K for cloud models. */
export const CONTEXT_TOKENS = Object.freeze({ cloud: 200_000, local: 128_000 });

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

/** A limit as fullText words it: whose it is ('model': the model's own; 'app': Magnusim's), and the context's whole window. */
export interface FullDetail extends Room {
  of: 'model' | 'app';
  window?: number;
}

const grouped = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const megabytes = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? Math.floor(mb * 10) / 10 : Math.floor(mb)} MB`;
};

/** Why a conversation is full, with its numbers, as the person reads it (`label`: the model's name). */
export function fullText(d: FullDetail, label: string): string {
  let why: string;
  switch (d.reason) {
    case 'messages':
      why = `it has ${grouped(d.used)} messages, and one conversation holds at most ${grouped(d.limit)}`;
      break;
    case 'images':
      why = d.of === 'model'
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
  return `This conversation is full: ${why}. Start a new one.`;
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
  private readonly list: Message[] = [];
  private imageCount = 0;
  private byteCount = 0;

  constructor(id: string, b: Binding, now: number) {
    this.id = id;
    this.provider = b.provider;
    this.model = b.model;
    this.boundProject = b.projectId;
    this.createdAt = now;
    this.lastUsed = now;
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
    const window = local ? (context ?? CONTEXT_TOKENS.local) : CONTEXT_TOKENS.cloud;
    return [
      { reason: 'messages', used: this.list.length, limit: L.messages, of: 'app' },
      { reason: 'images', used: this.imageCount, limit: L.images, of: 'app' },
      { reason: 'bytes', used: this.byteCount, limit: L.bytes, of: 'app' },
      { reason: 'context', used: this.promptTokens, limit: Math.floor(L.fullFraction * window), of: local && context ? 'model' : 'app', window },
    ];
  }

  /** The first limit this conversation reached, with its numbers (null while more turns fit). */
  fullDetail(baseUrl?: string): FullDetail | null {
    return this.limits(baseUrl).find((l) => l.used >= l.limit) ?? null;
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
