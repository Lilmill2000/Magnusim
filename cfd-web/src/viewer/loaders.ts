const cache = new Map<string, ArrayBuffer>();

export async function fetchVtp(url: string): Promise<ArrayBuffer> {
  const hit = cache.get(url);
  if (hit) return hit;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`fetch ${url} ${r.status}`);
  const buf = await r.arrayBuffer();
  cache.set(url, buf);
  return buf;
}

export function clearVtpCache(url?: string): void {
  if (url) cache.delete(url);
  else cache.clear();
}
