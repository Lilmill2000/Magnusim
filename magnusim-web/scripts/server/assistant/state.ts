/**
 * The Assistant's in-memory state, on globalThis so a Vite re-import of these modules
 * shares one copy (as link-gate.js keeps its gates). It is made at its first use, never
 * when a module loads.
 */
import { randomBytes } from 'node:crypto';
import type { SpendLedger } from './ledger.ts';
import type { AssistantSettings } from './settings.ts';

const KEY = Symbol.for('magnusim.assistant');

export interface AssistantState {
  /** Changes at every server start (and every test reset). */
  bootId: string;
  // Filled by the turn, relay and gate modules.
  turns: Map<string, unknown>;
  conversations: Map<string, unknown>;
  links: Map<string, unknown>;
  registrations: Map<string, unknown>;
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
  /** Secret values every log line and error text is scrubbed of (redact.ts). */
  redactions: string[];
  shutdownHooks: Set<() => void>;
  shutDown: boolean;
}

function fresh(): AssistantState {
  return {
    bootId: randomBytes(8).toString('hex'),
    turns: new Map(),
    conversations: new Map(),
    links: new Map(),
    registrations: new Map(),
    gates: new Map(),
    secrets: { master: null, masterId: null, unwrap: null, store: null },
    settings: { path: null, cache: null, queue: Promise.resolve() },
    ledger: null,
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

/** The server is closing: stop what runs (turns, timers) and drop the master key. */
export function shutdownAssistant(): void {
  const g = globalThis as unknown as Record<symbol, AssistantState | undefined>;
  const s = g[KEY];
  if (!s || s.shutDown) return;
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
