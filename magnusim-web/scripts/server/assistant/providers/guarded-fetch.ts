/**
 * The only fetch the provider SDKs get (Foundation spec 5.3).
 *
 * - Origin lock: a request to any origin but the adapter's own fails with
 *   `blocked_origin` (and a log line), whatever the SDK, a profile or the environment
 *   tried to send it to.
 * - `redirect: 'error'`: a provider that answers with a redirect gets nothing sent on.
 * - Headers: only the adapter's allowlist leaves this PC, and the headers that carry the
 *   key and the betas are pinned to exactly what the adapter chose (`pin`; null removes),
 *   so nothing the SDK picked up elsewhere replaces them.
 * - Watchdog: the first byte must come within `firstByteMs`, and the stream must not go
 *   quiet for `idleMs`; on expiry the watchdog's signal aborts the request, and the
 *   adapter reports `timeout` (the SDK sees an abort, so it never retries a stall).
 */
import { alog } from '../log.ts';
import { ProviderError } from '../types.ts';

export type HeaderRule = string | RegExp;

export interface WatchdogOptions {
  firstByteMs: number;
  idleMs: number;
}

/** Aborts its signal when a request waits too long for its first byte, or a stream goes quiet. */
export class Watchdog {
  readonly firstByteMs: number;
  readonly idleMs: number;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Which wait ran out, once one did. */
  fired: 'first_byte' | 'idle' | null = null;

  constructor(o: WatchdogOptions) {
    this.firstByteMs = o.firstByteMs;
    this.idleMs = o.idleMs;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Seconds the expired wait lasted (for the message). */
  get waitedS(): number {
    return Math.round((this.fired === 'idle' ? this.idleMs : this.firstByteMs) / 1000);
  }

  private arm(ms: number, kind: 'first_byte' | 'idle'): void {
    this.clear();
    if (this.fired) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = kind;
      this.controller.abort(new ProviderError('timeout', 'The provider stopped answering.'));
    }, ms);
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A request went out (each SDK retry too). */
  request(): void {
    this.arm(this.firstByteMs, 'first_byte');
  }

  /** Bytes arrived (the answer's head, or a chunk of its body). */
  bytes(): void {
    this.arm(this.idleMs, 'idle');
  }

  /** The answer's body ended: nothing to wait for until the next request. */
  ended(): void {
    this.clear();
  }

  /** The adapter is done with it. */
  done(): void {
    this.clear();
  }
}

export interface GuardOptions {
  /** The one origin requests may go to (`https://api.example.com`). */
  origin: string;
  /** Header names that may leave (case-insensitive strings, or patterns). */
  allowHeaders: readonly HeaderRule[];
  /** Headers set to exactly this value (null: removed), after the allowlist. */
  pin?: Readonly<Record<string, string | null>>;
  watchdog?: Watchdog;
  /** For the log line. */
  label: string;
}

const allowed = (rules: readonly HeaderRule[], name: string) =>
  rules.some((r) => (typeof r === 'string' ? r.toLowerCase() === name : r.test(name)));

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  return String(input);
}

/** The headers that may leave: the allowlist, then the pins. */
export function filterHeaders(source: HeadersInit | undefined, o: Pick<GuardOptions, 'allowHeaders' | 'pin'>): Headers {
  const out = new Headers();
  new Headers(source ?? {}).forEach((value, name) => {
    const n = name.toLowerCase();
    if (allowed(o.allowHeaders, n)) out.set(n, value);
  });
  for (const [name, value] of Object.entries(o.pin ?? {})) {
    if (value === null) out.delete(name);
    else out.set(name, value);
  }
  return out;
}

/** A fetch for one adapter request; see the header. */
export function guardedFetch(o: GuardOptions): typeof fetch {
  const origin = new URL(o.origin).origin;
  const wd = o.watchdog;
  const guarded = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = urlOf(input);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ProviderError('blocked_origin', "Blocked a request to an address other than the provider's.");
    }
    if (target.origin !== origin) {
      alog('warn', 'blocked a provider request to another address', { provider: o.label, origin: target.origin });
      throw new ProviderError('blocked_origin', "Blocked a request to an address other than the provider's.");
    }
    const headers = filterHeaders(init.headers ?? (input instanceof Request ? input.headers : undefined), o);
    wd?.request();
    const res = await fetch(target.href, { ...init, headers, redirect: 'error' });
    if (!wd) return res;
    wd.bytes();
    if (!res.body) {
      wd.ended();
      return res;
    }
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          wd.bytes();
          ctl.enqueue(chunk);
        },
        flush() {
          wd.ended();
        },
      }),
    );
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return guarded as typeof fetch;
}

/**
 * The header names an SDK would take from one of its "custom headers" environment
 * variables (`Name: value` lines), each mapped to null: passed as the client's default
 * headers, they remove what the environment added.
 */
export function envHeaderNulls(env: NodeJS.ProcessEnv, variable: string): Record<string, null> {
  const out: Record<string, null> = {};
  const raw = String(env[variable] ?? '').trim();
  if (!raw) return out;
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name) out[name] = null;
  }
  return out;
}
