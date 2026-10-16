/**
 * The page's calls to the Assistant's routes. Every route is for this PC only: over remote
 * access each answers 403 `{reason:'remote'}`, which becomes a RemoteError here so the
 * callers can show the one remote sentence. Any other refusal is an AssistantApiError with
 * the server's status, code, field and text (never the key: the key routes don't echo it).
 */
import type { RefusalBody } from './wire';

/** What Settings says over remote access (the server's REMOTE_MESSAGE). */
export const REMOTE_TEXT =
  'The Assistant and its API keys can only be set up and used on the PC running Magnusim. Over remote access it is off.';

export class AssistantApiError extends Error {
  /** HTTP status; 0 when the server didn't answer. */
  status: number;
  code: string;
  field: string | null;
  body: RefusalBody | Record<string, unknown>;
  constructor(status: number, body: RefusalBody | Record<string, unknown>, message: string) {
    super(message);
    this.status = status;
    const b = body as RefusalBody;
    this.code = typeof b.code === 'string' ? b.code : status ? `http_${status}` : 'network';
    this.field = typeof b.field === 'string' ? b.field : null;
    this.body = body;
  }
}

/** A 403 `{reason:'remote'}`: this page is not on the PC running Magnusim. */
export class RemoteError extends AssistantApiError {}

async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      cache: 'no-store',
      signal,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new AssistantApiError(0, {}, "Magnusim's server didn't answer.");
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 403 && j.reason === 'remote') throw new RemoteError(403, j, REMOTE_TEXT);
  if (!r.ok) {
    const text = typeof j.error === 'string' && j.error ? j.error : `HTTP ${r.status}`;
    throw new AssistantApiError(r.status, j, text);
  }
  return j as T;
}

export function assistantGet<T = Record<string, unknown>>(
  path: string,
  query?: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') params.set(k, v);
  const qs = params.toString();
  return call<T>('GET', qs ? `${path}?${qs}` : path, undefined, signal);
}

export function assistantPost<T = Record<string, unknown>>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return call<T>('POST', path, body, signal);
}
