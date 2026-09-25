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
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; ok?: boolean };
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || `${method} failed`);
  }
  return j;
}
