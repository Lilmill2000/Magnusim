/**
 * The Assistant's in-memory state, on globalThis so a Vite re-import of these modules
 * shares one copy (as link-gate.js keeps its gates). It is made at its first use, never
 * when a module loads.
 *
 * Each server that registers the Assistant's routes starts a lifetime, and its close ends
 * only that lifetime. Vite restarts a server inside the same process, and builds the new
 * server before it closes the old one, so the old one's close finds its lifetime
 * superseded and leaves the state (turns, hooks, the master key) to the new server; only
 * its relay's close ends the turns it started that are bound to an app tab (turns.ts).
 *
 * A page's links and its workspace's registrations are not here: they belong to the server
 * that made them (relay.ts, registry.ts), and a test reset leaves them.
 */
import { randomBytes } from 'node:crypto';
import type { SpendLedger } from './ledger.ts';
import type { AssistantSettings } from './settings.ts';

const KEY = Symbol.for('magnusim.assistant');
/** The current server lifetime's number, apart from the state: a test reset forgets the state, never the running server. */
const LIFETIME = Symbol.for('magnusim.assistant.lifetime');

export interface AssistantState {
  /** Changes at every server start (and every test reset). */
  bootId: string;
  // Filled by the turn, conversation and gate modules.
  turns: Map<string, unknown>;
  conversations: Map<string, unknown>;
  gates: Map<string, unknown>;
  secrets: {
    /** The unwrapped 32-byte master key, once a key was saved or used. */
    master: Buffer | null;
    /** Its master_id, beside it. */
    masterId: string | null;
    /** The one unwrap in flight (single-flight: one helper run however many callers wait). */
    unwrap: Promise<Buffer> | null;
    /** The secret store (secrets/store.ts), made at its first use. */
    store: unknown;
  };
  settings: {
    /** settings.json, fixed at the first use. */
    path: string | null;
    /** The last settings read or written (Node is the only writer of settings.json). */
    cache: AssistantSettings | null;
    /** One write queue: each save applies on top of the one before. */
    queue: Promise<unknown>;
  };
  ledger: SpendLedger | null;
  /** Chain grants and the jobs each turn started (grants.ts), made at their first use. */
  grants: unknown;
  /** Settings' connection test while one runs (one at a time). */
  test: { abort: AbortController } | null;
  /** Secret values every log line and error text is scrubbed of (redact.ts): each secret's forms, oldest first. */
  redactions: string[][];
  shutdownHooks: Set<() => void>;
  /** The current server lifetime has been shut down (a server registering clears it). */
  shutDown: boolean;
}

const newBootId = () => randomBytes(8).toString('hex');

function fresh(): AssistantState {
  return {
    bootId: newBootId(),
    turns: new Map(),
    conversations: new Map(),
    gates: new Map(),
    secrets: { master: null, masterId: null, unwrap: null, store: null },
    settings: { path: null, cache: null, queue: Promise.resolve() },
    ledger: null,
    grants: null,
    test: null,
    redactions: [],
    shutdownHooks: new Set(),
    shutDown: false,
  };
}

export function assistantState(): AssistantState {
  const g = globalThis as unknown as Record<symbol, AssistantState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = fresh();
    g[KEY] = s;
  }
  return s;
}

/** Runs `fn` when the server shuts the Assistant down (or a test resets it). */
export function onAssistantShutdown(fn: () => void): () => void {
  const hooks = assistantState().shutdownHooks;
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

function lifetime(): { current: number } {
  const g = globalThis as unknown as Record<symbol, { current: number } | undefined>;
  let l = g[LIFETIME];
  if (!l) {
    l = { current: 0 };
    g[LIFETIME] = l;
  }
  return l;
}

/**
 * A server registered the Assistant's routes: its lifetime begins, with a new boot id and
 * not shut down. Returns the lifetime's number, for that server's shutdownAssistant().
 */
export function beginAssistantLifetime(): number {
  const l = lifetime();
  l.current += 1;
  const s = (globalThis as unknown as Record<symbol, AssistantState | undefined>)[KEY];
  if (s) {
    s.bootId = newBootId();
    s.shutDown = false;
  }
  return l.current;
}

/**
 * The server is closing: stop what runs (turns, timers) and drop the master key. With the
 * server's lifetime number, a lifetime a newer server has superseded does nothing. Each
 * call runs the hooks added since the last one, so a later server's close still runs its own.
 */
export function shutdownAssistant(lifetimeNumber?: number): void {
  if (lifetimeNumber !== undefined && lifetimeNumber !== lifetime().current) return;
  const g = globalThis as unknown as Record<symbol, AssistantState | undefined>;
  const s = g[KEY];
  if (!s) return;
  s.shutDown = true;
  for (const fn of [...s.shutdownHooks]) {
    try {
      fn();
    } catch {
      /* one hook's failure never stops the others */
    }
  }
  s.shutdownHooks.clear();
  if (s.secrets.master) s.secrets.master.fill(0);
  s.secrets.master = null;
  s.secrets.masterId = null;
}

/** Tests only: shut down and forget everything, so the next use starts afresh. */
export function resetAssistantState(): void {
  shutdownAssistant();
  const g = globalThis as unknown as Record<symbol, AssistantState | undefined>;
  delete g[KEY];
}
