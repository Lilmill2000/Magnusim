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
 * 100 images and 20 MB each, and "full" at 80% of the model's context (128K tokens for a
 * model Magnusim doesn't know). Nothing is written to disk.
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
});

/** Context windows, in tokens: the spec names only the local default; cloud models get a safe 200K. */
export const CONTEXT_TOKENS = Object.freeze({ cloud: 200_000, local: 128_000 });

export const FULL_TEXT = 'This conversation is full. Start a new one.';

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
  readonly projectId: string | null;
  readonly createdAt: number;
  lastUsed: number;
  /** The first workspace guide this conversation met, frozen. */
  guide: FrozenGuide | null = null;
  /** Guides that differed from the frozen one and were noted once. */
  readonly guidesNoted = new Set<string>();
  /** The turn running in it (until its loop has fully ended). */
  running: string | null = null;
  /** The last request's prompt tokens (for "full"). */
  promptTokens = 0;
  private readonly list: Message[] = [];
  private imageCount = 0;
  private byteCount = 0;

  constructor(id: string, b: Binding, now: number) {
    this.id = id;
    this.provider = b.provider;
    this.model = b.model;
    this.projectId = b.projectId;
    this.createdAt = now;
    this.lastUsed = now;
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

  /** Why no more turns fit (null while they do). */
  fullReason(): string | null {
    const L = CONVERSATION_LIMITS;
    if (this.list.length >= L.messages) return 'messages';
    if (this.imageCount >= L.images) return 'images';
    if (this.byteCount >= L.bytes) return 'bytes';
    const window = this.provider === 'openai_compatible' ? CONTEXT_TOKENS.local : CONTEXT_TOKENS.cloud;
    if (this.promptTokens >= L.fullFraction * window) return 'context';
    return null;
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
}
