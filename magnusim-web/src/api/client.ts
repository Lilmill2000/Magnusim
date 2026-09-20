export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function apiGet<T = Record<string, unknown>>(
  path: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
  }
  const r = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T;
  if (!r.ok) throw new ApiError(r.status, j, (j as { error?: string }).error);
  return j;
}

export async function apiPost<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T;
  if (!r.ok) throw new ApiError(r.status, j, (j as { error?: string }).error);
  return j;
}

export function subscribeJobEvents(
  jobId: string,
  onEvent: (ev: MessageEvent) => void,
): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  es.onmessage = onEvent;
  es.addEventListener('snapshot', onEvent);
  es.addEventListener('event', onEvent);
  es.addEventListener('end', (ev) => { onEvent(ev as MessageEvent); es.close(); });
  es.addEventListener('progress', onEvent);
  es.addEventListener('log', onEvent);
  es.addEventListener('result', onEvent);
  es.addEventListener('residual', onEvent);
  es.addEventListener('error', onEvent);
  return () => es.close();
}
