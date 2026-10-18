/**
 * MCP sessions and agent bindings (phase 3 spec 3.3, 3.8).
 *
 * - A session is one authenticated connection: an external app (no binding) or a coding
 *   agent's bridge (`--binding b-…`). Its `served` map is the list last served on it: a
 *   call resolves only there.
 * - A binding is minted by the agent host for each agent session and passed on the
 *   bridge's command line. It grants nothing without the token (only the bridge reads it).
 *   One live connection per binding: a second handshake with a binding that has one is
 *   refused `binding_in_use`, so a second bridge started with the same argv can't join a
 *   running turn, and two calls of one turn never run at once on two connections. When
 *   the connection closes, the binding takes a new one again.
 * - A binding with `test: true` is a Settings Test's: its connection is served only
 *   `connection_check`, by its own path in server.ts.
 * - Bindings live on globalThis (a Vite re-import of these modules shares them, as the
 *   agent host that mints them does).
 */
import { randomBytes } from 'node:crypto';
import type { GateOwner } from '../gates.ts';
import type { ToolCtx, ToolDef } from '../registry.ts';
import type { RunResult } from '../runner.ts';
import type { ToolCallPart } from '../types.ts';

export interface AgentBinding {
  /** b-<24 hex> */
  id: string;
  conversation: string;
  agent: string;
  /** A Settings Test binding (served only connection_check). */
  test: boolean;
}

/**
 * How an agent binding's calls reach its running turn (the agent runner sets it, A4).
 * Without one, the binding's list is the tab-less host list and every call is refused
 * `stopped` (nothing runs between messages).
 */
export interface AgentDispatch {
  /** The context the binding's tools are listed and run in: its turn's tab and project. */
  ctx(): ToolCtx;
  /**
   * Runs one call inside the running turn (the turn's owner, caps, log and signal).
   * `onProgress` (present when the request carried a progressToken) hears the tool's own
   * progress: pass it on as RunOptions.onProgress.
   */
  run(
    call: ToolCallPart,
    o: { offered: ReadonlyMap<string, ToolDef>; signal: AbortSignal; onProgress?: (fraction: number | null, label: string) => void },
  ): Promise<RunResult>;
  /**
   * Whether an open question is one this binding's call waits on (its turn's): while one
   * is open, a request with a progressToken hears that it waits. Left out: none is.
   */
  owns?(owner: GateOwner): boolean;
}

interface BindingEntry {
  binding: AgentBinding;
  /** The session id of its live connection (or a handshake that claimed it). */
  live: string | null;
  /** Closes the live connection (set by the server while one is live). */
  closeLive: (() => void) | null;
  dispatch: AgentDispatch | null;
  /** A Test binding's call of connection_check (the Test records "called"). */
  onTestCall: (() => void) | null;
  /**
   * The MCP names last listed on its connection (server.ts notes them at each tools/list), null
   * before any: the agent runner's permission matcher counts only those as Magnusim's (spec 4.7).
   */
  served: ReadonlySet<string> | null;
}

const KEY = Symbol.for('magnusim.assistant.mcpBindings');

function table(): Map<string, BindingEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, BindingEntry> | undefined>;
  let t = g[KEY];
  if (!t) {
    t = new Map();
    g[KEY] = t;
  }
  return t;
}

export const BINDING_RE = /^b-[0-9a-f]{24}$/;

/** A new binding for an agent session (or a Settings Test). */
export function mintBinding(o: { conversation: string; agent: string; test?: boolean; dispatch?: AgentDispatch | null; onTestCall?: () => void }): AgentBinding {
  const binding: AgentBinding = { id: `b-${randomBytes(12).toString('hex')}`, conversation: o.conversation, agent: o.agent, test: o.test === true };
  table().set(binding.id, { binding, live: null, closeLive: null, dispatch: o.dispatch ?? null, onTestCall: o.onTestCall ?? null, served: null });
  return binding;
}

/** The binding's turn dispatch from now on (null: no turn runs on it). */
export function setBindingDispatch(id: string, dispatch: AgentDispatch | null): void {
  const e = table().get(id);
  if (e) e.dispatch = dispatch;
}

/** The MCP names a binding's connection was last listed (server.ts, at each tools/list). */
export function noteBindingServed(id: string, names: Iterable<string>): void {
  const e = table().get(id);
  if (e) e.served = new Set(names);
}

/** Whether `name` was in the list last served on the binding's connection (false before any list). */
export function bindingServes(id: string, name: string): boolean {
  return table().get(id)?.served?.has(name) === true;
}

/** The session ended: its binding is refused from now on, and its live connection closes. */
export function dropBinding(id: string): void {
  const e = table().get(id);
  if (!e) return;
  table().delete(id);
  const close = e.closeLive;
  e.closeLive = null;
  close?.();
}

export type BindingClaim =
  | { ok: true; entry: Readonly<BindingEntry>; attach(close: () => void): void; release(): void }
  | { ok: false; code: 'binding' | 'binding_in_use' };

/**
 * The connection `sessionId` asks for binding `id` at its handshake: unknown (or ended)
 * gives `binding`, one with a live connection `binding_in_use`. Claimed synchronously, so
 * two handshakes racing for it never both win; attach() gives the binding the way to close
 * the connection (dropBinding), release() frees it (the connection closed, or the
 * handshake failed after the claim).
 */
export function claimBinding(id: string, sessionId: string): BindingClaim {
  const e = table().get(id);
  if (!e) return { ok: false, code: 'binding' };
  if (e.live !== null) return { ok: false, code: 'binding_in_use' };
  e.live = sessionId;
  return {
    ok: true,
    entry: e,
    attach(close) {
      if (e.live === sessionId) e.closeLive = close;
    },
    release() {
      if (e.live !== sessionId) return;
      e.live = null;
      e.closeLive = null;
    },
  };
}

/** The binding's entry now (its dispatch and Test hook), or null once dropped. */
export function bindingEntry(id: string): Readonly<BindingEntry> | null {
  return table().get(id) ?? null;
}

/** Tests only: forget every binding. */
export function resetBindingsForTests(): void {
  table().clear();
}

// ---------------------------------------------------------------- sessions

export interface McpClientInfo {
  /** The bridge's random id ([0-9a-f]{16}). */
  bridge: string;
  /** As the client calls itself (cleaned, ≤ 64): self-declared, for display only. */
  name: string;
  version: string;
}

export interface McpSession {
  /** m-<base36 time>-<hex>, one per connection. */
  id: string;
  kind: 'external' | 'agent';
  client: McpClientInfo;
  binding: AgentBinding | null;
  /** MCP name -> tool: the list last served on this connection (null before any tools/list). */
  served: Map<string, ToolDef> | null;
  queue: CallQueue;
  /** ms since 1970. */
  opened: number;
  /** Calls answered on it (each tools/call, refused ones included). */
  calls: number;
}

export function newSessionId(now: number): string {
  return `m-${Math.max(0, Math.floor(now)).toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** Calls one connection may have at once, running and waiting (spec 3.8). */
export const QUEUE_MAX = 16;

/**
 * One call at a time, in arrival order, at most `max` at once (the one running included).
 * A waiting call whose signal aborts leaves the queue at once; the calls behind it still
 * wait for the ones before it.
 */
export class CallQueue {
  readonly max: number;
  private tail: Promise<void> = Promise.resolve();
  private count = 0;

  constructor(max: number = QUEUE_MAX) {
    this.max = max;
  }

  /** Calls running or waiting. */
  get pending(): number {
    return this.count;
  }

  /**
   * `fn` once every call before it ended; `removed()` instead when `signal` aborts while it
   * waits. Null when the queue is full (nothing is queued).
   */
  run<T>(signal: AbortSignal, fn: () => Promise<T>, removed: () => T): Promise<T> | null {
    if (this.count >= this.max) return null;
    this.count += 1;
    const before = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((r) => {
      done = r;
    });
    return (async () => {
      let ran = false;
      try {
        const aborted = await new Promise<boolean>((resolve) => {
          if (signal.aborted) {
            resolve(true);
            return;
          }
          const onAbort = () => resolve(true);
          signal.addEventListener('abort', onAbort, { once: true });
          void before.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(false);
          });
        });
        if (aborted) {
          // Its place in the order goes once the calls before it end.
          void before.then(done);
          return removed();
        }
        ran = true;
        return await fn();
      } finally {
        this.count -= 1;
        if (ran) done();
      }
    })();
  }
}
