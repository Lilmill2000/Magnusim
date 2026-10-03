/** Browser call into an allowlisted worker method. Node only forwards it. */
export async function workerRpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const r = await fetch('/api/worker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ method, params }),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; ok?: boolean; code?: unknown };
  if (!r.ok || j.ok === false) {
    // The status and the app's code go with it (a linked geometry's 409 and 503, API 1.5).
    throw Object.assign(new Error(j.error || `${method} failed`), {
      status: r.status,
      code: typeof j.code === 'string' ? j.code : '',
      retryAfter: Number(r.headers.get('Retry-After')) || 0,
    });
  }
  return j;
}
