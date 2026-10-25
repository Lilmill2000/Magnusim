/**
 * A newline JSON-RPC 2.0 peer over a coding agent's pipes (phase 3 spec 4.5): one message per
 * line, both ways, as the agent protocol (ACP v1) and MCP's stdio framing use it.
 *
 * Outgoing: request(method, params) with ids 1, 2, 3, ...; notify(); reply(); replyError().
 * Writes are queued behind the pipe's own buffer and wait for 'drain', so a slow agent never
 * blocks the event loop, and nothing is written once the agent has ended.
 *
 * Incoming:
 * - a response settles its pending request (an unknown id is dropped);
 * - a request goes to onRequest(method, params, id). When it returns false (or there is no
 *   handler), the agent gets -32601 "Magnusim does not serve <method>": the file system,
 *   terminal and elicitation methods and anything else we don't serve;
 * - a notification goes to onNotification.
 * Lines up to 8 MB (bytes); a longer one is skipped to its end. CR LF ends a line too. Lines
 * that aren't a JSON-RPC object are counted and dropped.
 *
 * Errors: an error answer becomes RpcError {code, message}; code -32000, or a message that
 * mentions auth, means the agent wants a sign-in (authRequired). When the agent exits (or its
 * output ends), every pending request rejects with RpcExited {code, signal, tail}, and later
 * requests reject at once.
 *
 * Timeouts: per method (REQUEST_TIMEOUTS_MS; a request's own timeoutMs wins). session/prompt
 * has none: the turn's caps bound it.
 *
 * The idea of failing every pending request on exit and of the -32601 answer comes from
 * SolidCraft's agent chat (MIT/Apache-2.0, crates/ui-egui/src/agent_chat); the code is our own.
 */
import type { Readable, Writable } from 'node:stream';

export type RpcId = number | string;

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
/** The code ACP agents answer with when they need a sign-in. */
export const AUTH_REQUIRED = -32000;

/** How long the end of the agent's output waits for its exit code. */
export const EXIT_WAIT_MS = 2_000;

/** The longest line read from the agent (bytes); a longer one is skipped to its end. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** How long each request may wait for its answer (ms). Methods not listed wait as long as it takes. */
export const REQUEST_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({
  initialize: 30_000,
  // An adapter starts the program it wraps here.
  'session/new': 60_000,
  // A browser sign-in.
  authenticate: 600_000,
  'session/set_mode': 15_000,
  'session/set_config_option': 15_000,
  'session/set_model': 15_000,
});

/**
 * An agent's word that a sign-in problem passes on its own ("This is usually transient; retry
 * in a minute"): not a sign-out. Seen live: Claude Code's "Failed to refresh OAuth token:
 * another Claude Code process is refreshing it" (another window of it refreshing the shared
 * login) marked it signed out until a Test.
 */
const PASSING = /\btransient\b|\bretry\b|\btry again\b/i;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  /** The agent wants a sign-in (ACP's -32000, or a message that mentions auth), unless it says the problem passes. */
  get authRequired(): boolean {
    return (this.code === AUTH_REQUIRED || /auth/i.test(this.message)) && !PASSING.test(this.message);
  }
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export class RpcExited extends Error {
  readonly code: number | null;
  readonly signal: string | null;
  /** The agent's last stderr lines, as the process layer kept them (already redacted). */
  readonly tail: string[];
  constructor(info: ExitInfo, tail: string[]) {
    super(info.code != null ? `the agent ended (exit code ${info.code})` : info.signal ? `the agent ended (${info.signal})` : 'the agent ended');
    this.name = 'RpcExited';
    this.code = info.code;
    this.signal = info.signal;
    this.tail = tail;
  }
}

export class RpcTimeout extends Error {
  readonly method: string;
  readonly ms: number;
  constructor(method: string, ms: number) {
    super(`${method}: no answer in ${Math.round(ms / 1000)} s`);
    this.name = 'RpcTimeout';
    this.method = method;
    this.ms = ms;
  }
}

/** Timers, so a test can move time itself. */
export interface RpcClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: RpcClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface RpcPeerOptions {
  /** The agent's stdout. */
  input: Readable;
  /** The agent's stdin. */
  output: Writable;
  /** A request from the agent; return true when it is served (the handler then replies). */
  onRequest?: (method: string, params: unknown, id: RpcId) => boolean;
  onNotification?: (method: string, params: unknown) => void;
  /** The agent's last stderr lines, for RpcExited. */
  tail?: () => string[];
  /**
   * The agent process's exit (the process layer's). With it, the end of the agent's output
   * waits up to EXIT_WAIT_MS for the exit code before failing what is pending; without it, the
   * end of the output fails it at once.
   */
  exited?: Promise<ExitInfo>;
  /** Per-method timeouts (REQUEST_TIMEOUTS_MS by default). */
  timeouts?: Readonly<Record<string, number>>;
  maxLineBytes?: number;
  clock?: RpcClock;
}

export interface RequestOptions {
  /** Overrides the method's timeout; 0 waits as long as it takes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: unknown;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

export interface RpcStats {
  /** Lines that weren't a JSON-RPC object. */
  nonJson: number;
  /** Lines over the size limit, skipped. */
  oversized: number;
  /** Responses to no request of ours (an unknown or timed-out id). */
  unmatched: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is RpcId => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';

export class RpcPeer {
  readonly stats: RpcStats = { nonJson: 0, oversized: 0, unmatched: 0 };
  private readonly o: RpcPeerOptions;
  private readonly clock: RpcClock;
  private readonly maxLine: number;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private parts: Buffer[] = [];
  private partBytes = 0;
  private skipping = false;
  private ended: RpcExited | null = null;
  private outputEnded = false;
  private endTimer: unknown = null;
  private queue: string[] = [];
  private waitingDrain = false;
  private writable = true;

  constructor(o: RpcPeerOptions) {
    this.o = o;
    this.clock = o.clock ?? REAL_CLOCK;
    this.maxLine = o.maxLineBytes ?? MAX_LINE_BYTES;
    o.input.on('data', (chunk: Buffer | string) => this.feed(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    o.exited?.then(
      (info) => this.exit(info),
      () => this.exit({ code: null, signal: null }),
    );
    // The agent's output ended: it can't answer any more. Its exit code follows soon after.
    const closed = () => {
      if (this.ended || this.outputEnded) return;
      this.outputEnded = true;
      if (!o.exited) {
        this.exit({ code: null, signal: null });
        return;
      }
      this.endTimer = this.clock.setTimeout(() => {
        this.endTimer = null;
        this.exit({ code: null, signal: null });
      }, EXIT_WAIT_MS);
    };
    o.input.on('end', closed);
    o.input.on('close', closed);
    o.input.on('error', closed);
    o.output.on('error', () => {
      // EPIPE and the like: the agent is gone; its exit fails what is pending.
      this.writable = false;
      this.queue = [];
    });
    o.output.on('drain', () => this.flush());
  }

  /** Whether the agent has ended (as far as this peer knows). */
  get closed(): boolean {
    return !!this.ended;
  }

  /** How many requests wait for an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  request(method: string, params?: unknown, ro: RequestOptions = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    if (ro.signal?.aborted) return Promise.reject(ro.signal.reason ?? new Error('aborted'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const p: Pending = { method, resolve, reject, timer: null, signal: ro.signal ?? null, onAbort: null };
      const timeoutMs = ro.timeoutMs ?? this.o.timeouts?.[method] ?? REQUEST_TIMEOUTS_MS[method] ?? 0;
      if (timeoutMs > 0) {
        p.timer = this.clock.setTimeout(() => this.settle(id, new RpcTimeout(method, timeoutMs), true), timeoutMs);
      }
      if (ro.signal) {
        const signal = ro.signal;
        p.onAbort = () => this.settle(id, signal.reason ?? new Error('aborted'), true);
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      this.pending.set(id, p);
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  reply(id: RpcId, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
  }

  replyError(id: RpcId, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  /**
   * The agent ended: every pending request rejects with RpcExited, and later ones at once.
   * The process layer calls it with the exit code; the end of the agent's output calls it too.
   * The first call wins.
   */
  exit(info: ExitInfo): void {
    if (this.ended) return;
    if (this.endTimer != null) {
      this.clock.clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    this.ended = new RpcExited(info, this.o.tail?.() ?? []);
    this.writable = false;
    this.queue = [];
    for (const id of [...this.pending.keys()]) this.settle(id, this.ended, true);
  }

  private settle(id: number, value: unknown, failed: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer != null) this.clock.clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    if (failed) p.reject(value);
    else p.resolve(value);
  }

  private send(msg: unknown): void {
    if (!this.writable || this.ended) return;
    this.queue.push(`${JSON.stringify(msg)}\n`);
    if (!this.waitingDrain) this.flush();
  }

  private flush(): void {
    this.waitingDrain = false;
    while (this.queue.length && this.writable) {
      const line = this.queue.shift() as string;
      let more: boolean;
      try {
        more = this.o.output.write(line);
      } catch {
        this.writable = false;
        this.queue = [];
        return;
      }
      if (!more) {
        this.waitingDrain = true;
        return;
      }
    }
  }

  private feed(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl < 0 ? chunk.length : nl;
      if (!this.skipping) {
        const piece = chunk.subarray(start, end);
        if (this.partBytes + piece.length > this.maxLine) {
          // Too long: drop what we have and skip to the end of this line.
          this.parts = [];
          this.partBytes = 0;
          this.skipping = true;
          this.stats.oversized += 1;
        } else if (piece.length) {
          this.parts.push(piece);
          this.partBytes += piece.length;
        }
      }
      if (nl < 0) return;
      if (this.skipping) this.skipping = false;
      else this.line(Buffer.concat(this.parts, this.partBytes));
      this.parts = [];
      this.partBytes = 0;
      start = nl + 1;
    }
  }

  private line(buf: Buffer): void {
    // A CR before the LF is JSON whitespace: JSON.parse takes it as it is.
    const text = buf.toString('utf8');
    if (!text.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.stats.nonJson += 1;
      return;
    }
    if (!isObject(msg)) {
      this.stats.nonJson += 1;
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : null;
    const hasId = isId(msg.id);
    if (method && hasId) this.incomingRequest(method, msg.params, msg.id as RpcId);
    else if (method && msg.id === undefined) this.o.onNotification?.(method, msg.params);
    else if (!method && hasId && ('result' in msg || 'error' in msg)) this.response(msg);
    else this.stats.nonJson += 1;
  }

  private incomingRequest(method: string, params: unknown, id: RpcId): void {
    let served = false;
    try {
      served = !!this.o.onRequest?.(method, params, id);
    } catch {
      this.replyError(id, INTERNAL_ERROR, `Magnusim could not answer ${method}`);
      return;
    }
    if (!served) this.replyError(id, METHOD_NOT_FOUND, `Magnusim does not serve ${method}`);
  }

  private response(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id !== 'number' || !this.pending.has(id)) {
      this.stats.unmatched += 1;
      return;
    }
    if ('error' in msg && msg.error != null) {
      const e = isObject(msg.error) ? msg.error : {};
      const code = typeof e.code === 'number' ? e.code : INTERNAL_ERROR;
      const message = typeof e.message === 'string' && e.message ? e.message : 'error';
      this.settle(id, new RpcError(code, message, e.data), true);
      return;
    }
    this.settle(id, msg.result, false);
  }
}
